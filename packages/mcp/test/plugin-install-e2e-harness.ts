// plugin-install-e2e-harness — the Claude Code plugin as someone WITHOUT Shim
// gets it (D7, D9, D10, D11, D15): the built plugin is copied
// to a temp folder outside the repository (no workspace node_modules above
// it), its .mcp.json entry is started exactly as Claude Code starts it, over
// stdio, with no Shim browser and only Playwright reachable (through
// NODE_PATH, the way a global install or a CI install step would be), and a
// real MCP client runs the loop:
//
//   shim_status (auto: attach unavailable and why, headless available)
//   → open a headless session on a local fixture page (the answer names the
//     mode and why) → checkout → preview a hide rule (matched, full) →
//   view_page returns an image → commit writes the .shim → end
//
// plus: nothing but Playwright resolves from the copy (the core page bundle
// and the MCP SDK are inlined in the bundle, never looked up at runtime); with
// a live Shim's discovery file present, a bare url goes to Shim, not headless
// instead of silently going headless; and the CLI bundle in the same copy
// previews a folder too.
//
// Needs a downloaded Chromium, so it is excluded from `npm test` and runs in
// its own CI job (plugin-headless-e2e) under plain Node:
//
//   npx playwright install chromium
//   npm run build && node out/packages/mcp/test/plugin-install-e2e-harness.js

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  const d = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !d ? '' : `  — ${d.slice(0, 1500)}`}`);
  if (!ok) failures++;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// The package's source folder, found from wherever this compiled file runs.
function packageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'packages', 'mcp');
    if (fs.existsSync(path.join(candidate, '.claude-plugin', 'plugin.json'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('packages/mcp not found above ' + __dirname);
}

// Every folder from `dir` up to the root that has a node_modules.
function nodeModulesAbove(dir: string): string[] {
  const found: string[] = [];
  let d = dir;
  for (;;) {
    if (fs.existsSync(path.join(d, 'node_modules'))) found.push(path.join(d, 'node_modules'));
    const up = path.dirname(d);
    if (up === d) return found;
    d = up;
  }
}

const PAGE = `<!doctype html><html><head><title>Tracks</title></head><body>
<div class="promo">Buy the premium plan</div>
<ul class="tracks"><li class="track">Alpha</li><li class="track">Beta</li></ul>
</body></html>`;

interface ToolResult { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }

async function main(): Promise<void> {
  const root = packageRoot();
  const build = require(path.join(root, 'scripts', 'build.js')) as { buildMcp(): Promise<string> };
  await build.buildMcp();

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shim-plugin-e2e-')));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  const url = `http://127.0.0.1:${port}/`;
  let client: Client | null = null;
  let stderr = '';

  try {
    // --- install the plugin outside the repo ----------------------------------
    check('the temp folder has no node_modules above it', nodeModulesAbove(tmp).length === 0, nodeModulesAbove(tmp));
    const plugin = path.join(tmp, 'plugin');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { files: string[] };
    for (const entry of pkg.files) fs.cpSync(path.join(root, entry), path.join(plugin, entry), { recursive: true });
    check('the copy is what the package ships', fs.existsSync(path.join(plugin, 'dist', 'shim-mcp.js'))
      && fs.existsSync(path.join(plugin, '.claude-plugin', 'plugin.json')) && fs.existsSync(path.join(plugin, 'skills', 'shim-authoring', 'SKILL.md'))
      && !fs.existsSync(path.join(plugin, 'node_modules')));

    // Playwright, and only Playwright, made reachable the way NODE_PATH (or a
    // global install) makes it: a folder holding a link to the real package.
    const pwDir = path.dirname(require.resolve('playwright/package.json'));
    const nodePath = path.join(tmp, 'pw', 'node_modules');
    fs.mkdirSync(nodePath, { recursive: true });
    fs.symlinkSync(pwDir, path.join(nodePath, 'playwright'), 'junction');

    // A clean environment: no SHIM_* or CLAUDE_* from this shell, and a
    // discovery file path where no Shim is (never the developer's own Shim).
    const controlFile = path.join(tmp, 'shim-user-data', 'control.json');
    const env: Record<string, string> = { NODE_PATH: nodePath, SHIM_CONTROL_FILE: controlFile };
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH', 'LOCALAPPDATA', 'APPDATA', 'XDG_CACHE_HOME']) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    const project = path.join(tmp, 'project');
    fs.mkdirSync(project);

    const probe = spawnSync(process.execPath, ['-e', `
      const out = {};
      for (const id of ['playwright', '@shimbrowser/core/page', '@shimbrowser/core', '@modelcontextprotocol/sdk/server/index.js']) {
        try { require.resolve(id); out[id] = true; } catch { out[id] = false; }
      }
      process.stdout.write(JSON.stringify(out));
    `], { cwd: path.join(plugin, 'dist'), env, encoding: 'utf8' });
    const resolvable = JSON.parse(probe.stdout || '{}') as Record<string, boolean>;
    check('from the copy, Playwright resolves (NODE_PATH)', resolvable.playwright === true, resolvable);
    check('…and nothing the bundle inlines does: core, its page bundle, the MCP SDK', resolvable['@shimbrowser/core/page'] === false
      && resolvable['@shimbrowser/core'] === false && resolvable['@modelcontextprotocol/sdk/server/index.js'] === false, resolvable);

    // --- start it as Claude Code does -----------------------------------------
    const mcpJson = JSON.parse(fs.readFileSync(path.join(plugin, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    const entry = mcpJson.mcpServers.shim;
    check('.mcp.json runs node on the bundle, with no mode flag (auto)', entry?.command === 'node' && entry.args.length === 1, entry);
    const args = (entry?.args ?? []).map((a) => a.replace('${CLAUDE_PLUGIN_ROOT}', plugin));
    const transport = new StdioClientTransport({ command: process.execPath, args, env, cwd: project, stderr: 'pipe' });
    transport.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    client = new Client({ name: 'claude-code', version: '1.0.0' });
    await client.connect(transport);
    const c = client;
    const call = async (name: string, a: Record<string, unknown> = {}): Promise<ToolResult> =>
      (await c.callTool({ name, arguments: a }, undefined, { timeout: 120_000 })) as unknown as ToolResult;
    const json = (r: ToolResult): Record<string, unknown> => {
      const t = r.content.find((x) => x.type === 'text')?.text ?? '{}';
      try {
        const v: unknown = JSON.parse(t);
        return isRecord(v) ? v : {};
      } catch {
        return { raw: t };
      }
    };

    const { tools } = await c.listTools();
    check('it lists the session and page tools', tools.some((t) => t.name === 'shim_open_session') && tools.some((t) => t.name === 'view_page'));

    const status = json(await call('shim_status'));
    const attach = isRecord(status.attach) ? status.attach : {};
    const headless = isRecord(status.headless) ? status.headless : {};
    check('shim_status: auto mode', status.mode === 'auto', status);
    check('…attach unavailable, and why', attach.available === false && String(attach.reason).includes(controlFile), attach);
    check('…headless available, with the Playwright it found', headless.available === true && /playwright/.test(String(headless.playwright)), headless);

    // --- the loop ------------------------------------------------------------
    const dir = path.join(project, 'tracks');
    const opened = await call('shim_open_session', { url, intent: 'Hide the promo', newShimName: 'Tracks', dir });
    const o = json(opened);
    check('a url opens a headless session', !opened.isError && typeof o.sessionId === 'string' && o.mode === 'headless', o);
    check('…and the answer says why it is headless', /no attach host is reachable/.test(String(o.modeReason)) && /runs headless/.test(String(o.modeReason)), o.modeReason);
    check('the checkout wrote shim.json', fs.existsSync(path.join(dir, 'shim.json')), o.checkout);

    const spec = JSON.parse(fs.readFileSync(path.join(dir, 'shim.json'), 'utf8')) as Record<string, unknown>;
    const hidePromo = { id: 'hide-promo', anchor: { primary: { kind: 'css', value: '.promo' } }, mutations: [{ kind: 'hide' }] };
    fs.writeFileSync(path.join(dir, 'shim.json'), `${JSON.stringify({ ...spec, rules: [hidePromo] }, null, 2)}\n`);
    const preview = json(await call('shim_preview'));
    const evidence = isRecord(preview.evidence) ? preview.evidence : {};
    const rules = Array.isArray(evidence.rules) ? evidence.rules.filter(isRecord) : [];
    check('preview applies the hide rule: matched, verified full', preview.applied === true && rules.length === 1
      && /^matched/.test(String(rules[0]?.status)) && rules[0]?.verification === 'full', preview);
    const display = json(await call('evaluate_in_page', { expression: `getComputedStyle(document.querySelector('.promo')).display` }));
    check('the promo is hidden on the live page', display.result === '"none"', display);

    const shot = await call('view_page');
    const image = shot.content.find((x) => x.type === 'image');
    check('view_page returns an image', !shot.isError && !!image && /^image\//.test(String(image.mimeType)) && (image.data?.length ?? 0) > 100, shot.content.map((x) => x.type));

    const committed = json(await call('shim_commit', { summary: 'Hid the promo.' }));
    const shimFile = `${dir}.shim`;
    check('commit writes the .shim', committed.committed === true && committed.writtenTo === shimFile && fs.existsSync(shimFile), committed);
    const file = fs.existsSync(shimFile) ? JSON.parse(fs.readFileSync(shimFile, 'utf8')) as Record<string, unknown> : {};
    const fspec = isRecord(file.spec) ? file.spec : {};
    check('…a shim/1 file holding the rule', file.format === 'shim/1' && Array.isArray(fspec.rules)
      && fspec.rules.some((r) => isRecord(r) && r.id === 'hide-promo'), { format: file.format });
    const ended = json(await call('shim_end_session'));
    check('the session ends', ended.ended === true, ended);

    // --- no silent switch -----------------------------------------------------
    // A live Shim's discovery file (this process's pid): a bare url goes to
    // Shim (a new tab the user allows) instead of quietly going headless.
    fs.mkdirSync(path.dirname(controlFile), { recursive: true });
    fs.writeFileSync(controlFile, JSON.stringify({ format: 'shim-control/1', socketPath: path.join(tmp, 'no.sock'), token: 't', pid: process.pid, appVersion: 'x' }));
    const refused = await call('shim_open_session', { url, intent: 'x', newShimName: 'Other', dir: path.join(project, 'other') });
    check('with Shim reachable, a bare url goes to Shim (here unreachable: an error), never headless',
      refused.isError === true && !fs.existsSync(path.join(project, 'other.shim')), refused.content[0]?.text);
    fs.rmSync(controlFile);

    await c.close();
    client = null;

    // --- the CLI bundle from the same copy ------------------------------------
    const cli = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(plugin, 'dist', 'shim.js'), 'preview', dir, '--url', url, '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
      child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
      const timer = setTimeout(() => child.kill(), 90_000);
      child.once('exit', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
    });
    check('shim preview runs from the copy too', cli.code === 0 && /hide-promo/.test(cli.stdout), cli);
  } finally {
    if (client) await client.close().catch(() => undefined);
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures) {
    if (stderr) console.error(`\nserver stderr:\n${stderr.slice(-4000)}`);
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nplugin install e2e: all checks passed');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
