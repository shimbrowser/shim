// bridge-server-harness — the bridge's socket transport
// (packages/mcp/src/bridge-server.ts) for real, on a temp socket: the
// private directory and the socket's mode, the discovery file (0600, the
// chrome host, read back by the MCP client's reader), a request without the
// token refused before its body is read, a wrong token refused, the body
// cap, invalid JSON, a handler's answer passed through with its status, a
// client that goes away aborting the request's signal, close removing the
// socket and the file (only while the file still names this token), the
// socket path rules, and the token comparison.
//
//   node out/packages/mcp/test/bridge-server-harness.js

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
  startBridgeServer, bridgeSocketPath, tokenMatches, newBridgeToken, readDiscoveryFile, writeDiscoveryFile, removeDiscoveryFile, isNamedPipe,
  MAX_SOCKET_PATH_BYTES, type BridgeServerRequest,
} from '../src/bridge-server';
import { readControlInfo, CHROME_HOST, DISCOVERY_FORMAT } from '../src/control-client';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

interface Reply { status: number; body: Record<string, unknown> }

function request(socketPath: string, method: string, urlPath: string, opts: { token?: string | null; body?: unknown; raw?: string; auth?: string } = {}): { promise: Promise<Reply>; req: http.ClientRequest } {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  else if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const payload = opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  let req!: http.ClientRequest;
  const promise = new Promise<Reply>((resolve, reject) => {
    req = http.request({ socketPath, method, path: urlPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown>;
        try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text }; }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  return { promise, req };
}

const mode = (p: string): number => fs.statSync(p).mode & 0o777;

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    console.log('bridge-server: named pipes are not checked here');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-bridge-'));
  const userData = path.join(dir, 'ud');
  fs.mkdirSync(userData);
  const socketPath = bridgeSocketPath({ platform: process.platform, userData, tmpdir: dir, uid: process.getuid?.() ?? null });
  const discoveryPath = path.join(userData, 'control-chrome.json');
  const token = newBridgeToken();
  const seen: BridgeServerRequest[] = [];
  let hold: { resolve(): void; aborted: boolean } | null = null;
  const server = await startBridgeServer({
    socketPath, discoveryPath, token, pid: process.pid, appVersion: 'test', maxBodyBytes: 2000,
    async handle(req) {
      seen.push(req);
      if (req.url === '/slow') {
        await new Promise<void>((resolve) => {
          hold = { resolve, aborted: false };
          req.signal.addEventListener('abort', () => { if (hold) hold.aborted = true; resolve(); });
        });
        return { status: 200, body: { ok: true, aborted: req.signal.aborted } };
      }
      if (req.url === '/refuse') return { status: 409, body: { ok: false, error: 'artifact-busy' } };
      return { status: 200, body: { ok: true, echo: req.body ?? null, method: req.method, url: req.url } };
    },
  });

  console.log('files:');
  check('the socket directory is 0700', mode(path.dirname(socketPath)) === 0o700, mode(path.dirname(socketPath)).toString(8));
  check('the socket is 0600', mode(socketPath) === 0o600, mode(socketPath).toString(8));
  check('the discovery file is 0600', mode(discoveryPath) === 0o600);
  const info = readDiscoveryFile(discoveryPath);
  check('it names the chrome host, the socket and the token', info?.host === CHROME_HOST && info.socketPath === socketPath && info.token === token && info.format === DISCOVERY_FORMAT);
  const asClient = readControlInfo(discoveryPath);
  check('the MCP client\'s reader accepts it and sees the host', asClient?.host === CHROME_HOST && asClient.pid === process.pid);

  console.log('requests:');
  const noToken = await request(socketPath, 'POST', '/x', { body: { a: 1 } }).promise;
  check('no token is 401 before the handler runs', noToken.status === 401 && noToken.body.error === 'unauthorized' && seen.length === 0);
  const wrong = await request(socketPath, 'GET', '/x', { token: 'nope' }).promise;
  check('a wrong token is 401', wrong.status === 401);
  const ok = await request(socketPath, 'POST', '/sessions/1/preview', { token, body: { k: 'v' } }).promise;
  check('a request reaches the handler with its body and comes back with the answer', ok.status === 200 && JSON.stringify(ok.body.echo) === '{"k":"v"}' && ok.body.method === 'POST' && ok.body.url === '/sessions/1/preview');
  const refused = await request(socketPath, 'GET', '/refuse', { token }).promise;
  check('the handler\'s status is the response status', refused.status === 409 && refused.body.error === 'artifact-busy');
  const empty = await request(socketPath, 'GET', '/status', { token }).promise;
  check('no body is undefined, not an error', empty.status === 200 && empty.body.echo === null);
  const bad = await request(socketPath, 'POST', '/x', { token, raw: '{not json' }).promise;
  check('invalid JSON is 400', bad.status === 400 && bad.body.error === 'invalid-json');
  const big = await request(socketPath, 'POST', '/x', { token, raw: JSON.stringify({ pad: 'x'.repeat(3000) }) }).promise;
  check('a body over the cap is 413', big.status === 413 && big.body.error === 'payload-too-large');

  console.log('a client that goes away:');
  const slow = request(socketPath, 'GET', '/slow', { token });
  await new Promise((r) => setTimeout(r, 50));
  slow.req.destroy();
  await slow.promise.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 50));
  check('its request\'s signal aborted', hold !== null && (hold as { aborted: boolean }).aborted);

  console.log('closing:');
  await server.close();
  check('the socket is gone', !fs.existsSync(socketPath));
  check('the discovery file is gone', !fs.existsSync(discoveryPath));
  await server.close();
  writeDiscoveryFile(discoveryPath, { format: DISCOVERY_FORMAT, host: CHROME_HOST, socketPath, token: 'other', pid: 1, appVersion: 'x', startedAt: 0 });
  removeDiscoveryFile(discoveryPath, token);
  check('removing with another run\'s token leaves the file', fs.existsSync(discoveryPath));
  removeDiscoveryFile(discoveryPath, 'other');
  check('…and with its own removes it', !fs.existsSync(discoveryPath));

  console.log('paths and tokens:');
  const p = bridgeSocketPath({ platform: 'darwin', userData: '/Users/u/Library/Application Support/Shim', tmpdir: '/tmp', uid: 501 });
  check('the socket lives under userData/bridge', p === '/Users/u/Library/Application Support/Shim/bridge/chrome.sock', p);
  const long = bridgeSocketPath({ platform: 'darwin', userData: `/Users/${'u'.repeat(120)}/Shim`, tmpdir: '/tmp', uid: 501 });
  check('a too-long userData falls back to a per-user temp dir', long.startsWith('/tmp/shim-chrome-501-') && Buffer.byteLength(long) <= MAX_SOCKET_PATH_BYTES, long);
  const pipe = bridgeSocketPath({ platform: 'win32', userData: 'C:\\u\\Shim', tmpdir: 'C:\\t', uid: null });
  check('Windows gets a named pipe', isNamedPipe(pipe) && pipe.startsWith('\\\\.\\pipe\\shim-chrome-'));
  check('Bearer <token> matches', tokenMatches('Bearer abc', 'abc') && tokenMatches('bearer abc', 'abc'));
  check('wrong / missing / malformed do not', !tokenMatches('Bearer abd', 'abc') && !tokenMatches(undefined, 'abc') && !tokenMatches('abc', 'abc') && !tokenMatches('Bearer ', 'abc'));
  check('an empty token never matches', !tokenMatches('Bearer ', ''));

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) {
    console.error(`\nbridge-server: ${failures} failed, ${passes} passed`);
    process.exit(1);
  }
  console.log(`bridge-server: all ${passes} checks passed`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
