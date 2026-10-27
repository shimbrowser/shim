// bridge-harness — the bridge process in-process (packages/mcp/src/bridge.ts):
// its stdio as two streams, its socket on a temp path. Covers: the owner
// lock (a second bridge is busy, a dead owner's lock is taken over), the
// discovery file an MCP client reads, a request on the socket becoming one
// framed message on stdout and the framed reply on stdin becoming the HTTP
// response (status and body as the extension said), a large request going
// out in chunks, a client that goes away sending an abort, the greeting
// logged, and the port closing (stdin ending) answering every pending
// request, removing the socket and the file, dropping the lock, and
// resolving `closed`.
//
//   node out/packages/mcp/test/bridge-harness.js

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { startBridge, OWNER_LOCK_NAME } from '../src/bridge';
import { FrameReader, encodeFrame, RequestAssembler, isAbort } from '../src/bridge-frames';
import { readControlInfo, socketClient } from '../src/control-client';
import { lockFileFor } from '../src/file-lock';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await sleep(10);
  }
}

// The extension's end of the port: reads what the bridge writes, answers
// what the test says.
function extensionEnd(): { stdin: PassThrough; stdout: PassThrough; received: unknown[]; reply(message: unknown): void; close(): void } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const reader = new FrameReader();
  const received: unknown[] = [];
  stdout.on('data', (chunk: Buffer) => { received.push(...reader.feed(chunk)); });
  return {
    stdin, stdout, received,
    reply: (message) => { stdin.write(encodeFrame(message)); },
    close: () => { stdin.end(); },
  };
}

async function main(): Promise<void> {
  if (process.platform === 'win32') { console.log('bridge: named pipes are not checked here'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-bridge-'));
  const userData = path.join(dir, 'ud');
  const socketPath = path.join(userData, 'bridge', 'chrome.sock');
  const discoveryPath = path.join(userData, 'control-chrome.json');
  const logs: string[] = [];
  const ext = extensionEnd();
  const started = await startBridge({ stdin: ext.stdin, stdout: ext.stdout, log: (l) => logs.push(l), userData, socketPath, discoveryPath, pid: process.pid, appVersion: 'test', chunkBytes: 2000 });
  check('the bridge starts', started.ok, started.ok ? '' : started.detail);
  if (!started.ok) process.exit(1);
  const bridge = started.bridge;

  console.log('ownership and discovery:');
  check('the owner lock is held', fs.existsSync(lockFileFor(path.join(userData, 'bridge', OWNER_LOCK_NAME))));
  const second = extensionEnd();
  const again = await startBridge({ stdin: second.stdin, stdout: second.stdout, log: () => undefined, userData, socketPath, discoveryPath, pid: process.pid + 1, appVersion: 'test' });
  check('a second bridge is busy and touches nothing', !again.ok && again.error === 'bridge-busy' && fs.existsSync(socketPath) && readControlInfo(discoveryPath) !== null, again.ok ? '' : again.detail);
  const info = readControlInfo(discoveryPath);
  check('the discovery file names the chrome host and this socket', info?.host === 'chrome-extension' && info.socketPath === socketPath && info.pid === process.pid);
  if (!info) process.exit(1);
  const client = socketClient(info);

  console.log('relay:');
  ext.reply({ hello: true, version: '0.7.0' });
  await until(() => logs.some((l) => /connected to Shim for Chrome 0\.7\.0/.test(l)), 'greeting');
  check('the greeting is logged, not answered', ext.received.length === 0);
  const pending = client.request('POST', '/sessions', { kind: 'shim', intent: 'x' }, { timeoutMs: 5000 });
  await until(() => ext.received.length === 1, 'the request on stdout');
  const asm = new RequestAssembler();
  const got = asm.take(ext.received[0]);
  check('the request is one framed message with method, url and body', got !== null && got.method === 'POST' && got.url === '/sessions' && JSON.stringify(got.body) === '{"kind":"shim","intent":"x"}', JSON.stringify(ext.received[0]));
  ext.reply({ id: got?.id, status: 409, body: { ok: false, error: 'artifact-busy', detail: 'held' } });
  const reply = await pending;
  check('the reply on stdin becomes the HTTP response, status and body', reply.status === 409 && reply.body.error === 'artifact-busy' && reply.body.detail === 'held', JSON.stringify(reply));
  ext.received.length = 0;
  const bigBody = { workingCopy: 'x'.repeat(6000) };
  const bigPending = client.request('POST', '/sessions/1/preview', bigBody, { timeoutMs: 5000 });
  await until(() => ext.received.length >= 2 && ext.received.every((m) => typeof (m as { chunk?: unknown }).chunk === 'number') && (ext.received[0] as { of: number }).of === ext.received.length, 'the chunks');
  let whole = null as ReturnType<RequestAssembler['take']>;
  for (const m of ext.received) { const w = asm.take(m); if (w) whole = w; }
  check('a large request goes out in ordered chunks that reassemble', whole !== null && JSON.stringify(whole.body) === JSON.stringify(bigBody), String(ext.received.length));
  ext.reply({ id: whole?.id, status: 200, body: { ok: true, revision: 1 } });
  check('…and its reply comes back', (await bigPending).body.revision === 1);

  console.log('a client that goes away:');
  ext.received.length = 0;
  const req = http.request({ socketPath, method: 'GET', path: '/sessions/1/checkout', headers: { authorization: `Bearer ${info.token}` } });
  req.on('error', () => undefined);
  req.end();
  await until(() => ext.received.length === 1, 'the checkout request');
  const checkoutId = (ext.received[0] as { id: string }).id;
  req.destroy();
  await until(() => ext.received.some((m) => isAbort(m)), 'the abort');
  check('the extension is told the id was abandoned', ext.received.some((m) => isAbort(m) && m.id === checkoutId));

  console.log('the port closing:');
  const late = client.request('GET', '/status', undefined, { timeoutMs: 5000 });
  await until(() => ext.received.some((m) => (m as { url?: string }).url === '/status'), 'the status request');
  ext.close();
  const lateReply = await late;
  check('a pending request is answered as the bridge closing', lateReply.status === 503 && lateReply.body.error === 'bridge-closing', JSON.stringify(lateReply));
  await bridge.closed;
  check('the socket and the discovery file are gone', !fs.existsSync(socketPath) && !fs.existsSync(discoveryPath));
  check('the owner lock is dropped', !fs.existsSync(lockFileFor(path.join(userData, 'bridge', OWNER_LOCK_NAME))));
  const third = extensionEnd();
  const after = await startBridge({ stdin: third.stdin, stdout: third.stdout, log: () => undefined, userData, socketPath, discoveryPath, pid: process.pid, appVersion: 'test' });
  check('a new bridge can start afterwards', after.ok);
  if (after.ok) { third.close(); await after.bridge.closed; }

  console.log('a dead owner:');
  fs.mkdirSync(path.join(userData, 'bridge'), { recursive: true });
  fs.writeFileSync(lockFileFor(path.join(userData, 'bridge', OWNER_LOCK_NAME)), `${JSON.stringify({ format: 'shim-mcp-lock/1', pid: 999999, hostname: os.hostname(), token: 'dead', at: 1 })}\n`);
  const fourth = extensionEnd();
  const taken = await startBridge({ stdin: fourth.stdin, stdout: fourth.stdout, log: () => undefined, userData, socketPath, discoveryPath, pid: process.pid, appVersion: 'test' });
  check('a lock whose holder is gone is taken over', taken.ok, taken.ok ? '' : taken.detail);
  if (taken.ok) { fourth.close(); await taken.bridge.closed; }

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) {
    console.error(`\nbridge: ${failures} failed, ${passes} passed`);
    process.exit(1);
  }
  console.log(`bridge: all ${passes} checks passed`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
