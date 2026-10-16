// shim-cli-e2e-harness — the `shim` command line as it ships: builds @shimbrowser/mcp's bundles and runs
// dist/shim.js as a child process against a local fixture site in a real
// Playwright Chromium.
//
//   unpack → pack round trip through the real entry point
//   preview: every rule applied and verified, a handler's DOM visible to a
//     selector screenshot (the change is on the page when it is taken), a
//     full-page PNG written, a throwing handler exiting 1 with its stack
//   mcp --headless: answers an MCP initialize + tools/list on stdio, exits
//     when stdin closes
//
// Needs a downloaded Chromium, so it is excluded from `npm test` and runs in
// the playwright-conformance CI job under plain Node:
//
//   npx playwright install chromium
//   npm run build && node out/packages/mcp/test/shim-cli-e2e-harness.js

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type { AddressInfo } from 'net';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  const d = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !d ? '' : `  — ${d}`}`);
  if (!ok) failures++;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// The package's source folder, found from wherever this compiled file runs.
function packageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'packages', 'mcp');
    if (fs.existsSync(path.join(candidate, 'scripts', 'build.js'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('packages/mcp not found above ' + __dirname);
}

const PAGE = `<!doctype html><html><head><title>Tracks</title></head><body>
<div class="promo">Buy the premium plan</div>
<ul class="tracks"><li class="track">Alpha</li><li class="track">Beta</li></ul>
</body></html>`;

const MARK = `module.exports = function markTracks({ anchor }) {
  const note = document.createElement('div');
  note.className = 'shim-note';
  note.textContent = 'shimmed';
  note.style.cssText = 'padding: 8px; background: #fde68a;';
  anchor.after(note);
  return note;
};
`;
const THROW = 'module.exports = function explode() {\n  throw new Error("kaboom");\n};\n';

interface Run { code: number | null; stdout: string; stderr: string }

async function main(): Promise<void> {
  const root = packageRoot();
  const build = require(path.join(root, 'scripts', 'build.js')) as { buildMcp(): Promise<string>; CLI_OUT_FILE: string };
  await build.buildMcp();
  const bin = build.CLI_OUT_FILE;
  check('the build writes dist/shim.js', fs.existsSync(bin));
  // Asynchronous on purpose: the fixture server runs in this process, so a
  // spawnSync would block it from answering the child's page load.
  const run = (...args: string[]): Promise<Run> => new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 90_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  const parse = (r: Run): Record<string, unknown> => {
    try {
      const v: unknown = JSON.parse(r.stdout);
      return isRecord(v) ? v : {};
    } catch {
      return { raw: r.stdout, stderr: r.stderr };
    }
  };

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  const url = `http://127.0.0.1:${port}/`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-cli-e2e-'));

  try {
    const dir = path.join(tmp, 'tracks');
    fs.mkdirSync(path.join(dir, 'handlers'), { recursive: true });
    const spec = {
      id: 'tracks',
      match: { hosts: [`127.0.0.1:${port}`] },
      rules: [
        { id: 'hide-promo', anchor: { primary: { kind: 'css', value: '.promo' } }, mutations: [{ kind: 'hide' }] },
        { id: 'mark', anchor: { primary: { kind: 'css', value: '.tracks' } }, mutations: [{ kind: 'script', handler: 'markTracks' }] },
      ],
    };
    fs.writeFileSync(path.join(dir, 'shim.json'), `${JSON.stringify(spec, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'handlers', 'markTracks.js'), MARK);

    // --- pack / unpack through the real entry ---------------------------------
    const packed = await run('pack', dir);
    check('pack exits 0', packed.code === 0, packed);
    const unpacked = await run('unpack', `${dir}.shim`, '--out', path.join(tmp, 'copy'));
    check('unpack exits 0', unpacked.code === 0, unpacked);
    check('the copy lints clean', (await run('lint', path.join(tmp, 'copy'))).code === 0);

    // --- preview -------------------------------------------------------------
    const shot = path.join(tmp, 'page.png');
    const p = await run('preview', dir, '--url', url, '--screenshot', shot, '--full-page', '--json');
    const o = parse(p);
    check('preview exits 0', p.code === 0, p);
    const ev = isRecord(o.evidence) ? o.evidence : {};
    const rules = Array.isArray(ev.rules) ? ev.rules.filter(isRecord) : [];
    check('every rule matched and verified full', rules.length === 2
      && rules.every((r) => r.verification === 'full' && /matched 1 element/.test(String(r.status))), rules);
    const png = fs.existsSync(shot) ? fs.readFileSync(shot) : Buffer.alloc(0);
    check('a PNG screenshot was written', png.length > 100 && png.subarray(1, 4).toString() === 'PNG');

    const el = path.join(tmp, 'note.png');
    const sel = await run('preview', dir, '--url', url, '--screenshot', el, '--selector', '.shim-note');
    check('a selector screenshot of the handler\'s element succeeds (the change is on the page)', sel.code === 0 && fs.existsSync(el), sel);
    check('the text report names both rules', /hide-promo \[full\]/.test(sel.stdout) && /mark \[full\]/.test(sel.stdout), sel.stdout);

    fs.writeFileSync(path.join(dir, 'handlers', 'explode.js'), THROW);
    fs.writeFileSync(path.join(dir, 'shim.json'), `${JSON.stringify({
      ...spec,
      rules: [...spec.rules, { id: 'boom', anchor: { primary: { kind: 'css', value: '.track' } }, mutations: [{ kind: 'script', handler: 'explode' }] }],
    }, null, 2)}\n`);
    const bad = await run('preview', dir, '--url', url, '--json');
    const b = parse(bad);
    const errors = isRecord(b.evidence) && Array.isArray(b.evidence.errors) ? b.evidence.errors.filter(isRecord) : [];
    check('a throwing handler exits 1', bad.code === 1, bad);
    check('its error comes back with a stack', errors.some((e) => e.ruleId === 'boom' && /kaboom/.test(String(e.message)) && typeof e.stack === 'string'), errors);

    // --- mcp --headless on stdio ----------------------------------------------
    const child = spawn(process.execPath, [bin, 'mcp', '--headless'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    const send = (msg: Record<string, unknown>): void => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`); };
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list', params: {} });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !out.includes('"id":2')) await new Promise((r) => setTimeout(r, 100));
    const lines = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } });
    const list = lines.find((l) => l.id === 2);
    const tools = isRecord(list?.result) && Array.isArray(list.result.tools) ? list.result.tools.filter(isRecord).map((t) => t.name) : [];
    check('shim mcp --headless answers tools/list', tools.includes('shim_open_session') && tools.includes('view_page'), out.slice(0, 400));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 10_000))]);
    check('it exits when stdin closes', code === 0, code);
    if (code === 'hung') child.kill();
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall shim CLI end-to-end checks passed');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
