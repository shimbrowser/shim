// headless-session-e2e-harness — the full loop on a supported shim with no
// Shim browser (shim-core design C3; D9, D10, D11, D14, D15): a real MCP
// client talks to the real @shimbrowser/mcp server in headless mode, which
// drives a real Playwright Chromium against a local fixture site.
//
//   open a new shim on a url → check out → edit → preview (evidence) → look
//   (view_page, evaluate_in_page) → commit (the .shim file: version, witness,
//   history, deploy baseline; api.storage in its file) → end → reopen the
//   committed .shim (its rules run again, witnesses stay out of shim.json)
//
// plus D15: a preview declaring an unsupported kind or declaration applies
// nothing and answers `unsupported`; a handler using an unsupported member
// fails in its own shape and its rule is `partial`; a source-scan warning;
// browser-only tools answer requires-shim-browser; a .shim that declares an
// unsupported kind can't be opened; and each session gets a fresh profile
// (a cookie set in one is not in the next — never the Shim browser's
// persist:user).
//
// Needs a downloaded Chromium, so it is excluded from `npm test` and runs in
// the playwright-conformance CI job under plain Node:
//
//   npx playwright install chromium
//   npm run build && node out/packages/mcp/test/headless-session-e2e-harness.js
//
// SHIM_HEADED=1 shows the windows.

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createShimMcpServer } from '../src/server';
import { createHeadlessControl } from '../src/headless-control';
import { openHeadlessPage } from '../src/playwright-launch';
import type { HeadlessSessionPage } from '../src/headless-session';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  const d = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !d ? '' : `  — ${d}`}`);
  if (!ok) failures++;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface ToolResult { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }

const PAGE = `<!doctype html><html><head><title>Tracks</title><script src="/app.js?v=1"></script></head><body>
<div class="promo">Buy the premium plan</div>
<ul class="tracks"><li class="track" data-id="t1">Alpha</li><li class="track" data-id="t2">Beta</li></ul>
</body></html>`;

async function main(): Promise<void> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (pathname === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end('window.__app = 1;');
      return;
    }
    if (pathname === '/set-cookie') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'probe=1; Path=/' });
      res.end(PAGE);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  const origin = `http://127.0.0.1:${port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-headless-e2e-'));
  const visible = process.env.SHIM_HEADED === '1';
  const pages: Array<{ cookies(): Promise<unknown[]> }> = [];

  const control = createHeadlessControl({
    version: 'test',
    playwrightAvailable: () => true,
    async openPage(url, storage): Promise<HeadlessSessionPage> {
      const opened = await openHeadlessPage({ visible, storage });
      pages.push({ cookies: () => opened.page.context().cookies() });
      const loaded = opened.host.waitForLoad({ timeoutMs: 15_000 });
      opened.host.reload(url);
      await loaded;
      return { host: opened.host, close: () => opened.close() };
    },
  });
  const mcp = createShimMcpServer({
    version: 'test',
    mode: 'headless',
    controlFile: '(headless)',
    connect: () => control,
    launch: async () => ({ ok: false, error: 'launch-unavailable', detail: 'headless' }),
    newCommitId: (() => { let n = 0; return () => `c${++n}`; })(),
    maxOutputTokens: 25_000,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverT);
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(clientT);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  const json = (r: ToolResult): Record<string, unknown> => {
    const t = r.content.find((c) => c.type === 'text')?.text ?? '{}';
    try {
      const v: unknown = JSON.parse(t);
      return isRecord(v) ? v : {};
    } catch {
      return { raw: t };
    }
  };
  const evalInPage = async (expression: string): Promise<unknown> => {
    const r = json(await call('evaluate_in_page', { expression }));
    return typeof r.result === 'string' ? JSON.parse(r.result) as unknown : r;
  };

  try {
    // --- status, browser-only tools ---------------------------------------
    const status = json(await call('shim_status'));
    check('shim_status reports headless mode', status.running === true && status.mode === 'headless', status);
    const tabs = await call('shim_list_tabs');
    check('shim_list_tabs answers requires-shim-browser', tabs.isError === true && (tabs.content[0]?.text ?? '').startsWith('requires-shim-browser'));
    const launch = await call('shim_launch');
    check('shim_launch answers requires-shim-browser', launch.isError === true && (launch.content[0]?.text ?? '').startsWith('requires-shim-browser'));

    // --- open a new shim, check it out --------------------------------------
    const dir = path.join(tmp, 'tracks');
    const opened = await call('shim_open_session', { url: `${origin}/`, intent: 'Hide the promo and mark tracks', newShimName: 'Tracks', dir });
    const o = json(opened);
    check('a session opens on a url with a new shim', !opened.isError && typeof o.sessionId === 'string' && o.mode === 'headless', o);
    const shimFile = `${dir}.shim`;
    check('the .shim file defaults to <dir>.shim', o.shimFile === shimFile, o.shimFile);
    const spec = JSON.parse(fs.readFileSync(path.join(dir, 'shim.json'), 'utf8')) as Record<string, unknown>;
    check('the checkout holds the new spec, matching the page host', isRecord(spec.match) && JSON.stringify(spec.match.hosts) === JSON.stringify([`127.0.0.1:${port}`]), spec);

    // --- preview: hide + a script using api.storage -------------------------
    const write = (s: Record<string, unknown>, handlers: Record<string, string> = {}): void => {
      fs.writeFileSync(path.join(dir, 'shim.json'), `${JSON.stringify(s, null, 2)}\n`);
      fs.rmSync(path.join(dir, 'handlers'), { recursive: true, force: true });
      if (Object.keys(handlers).length) fs.mkdirSync(path.join(dir, 'handlers'));
      for (const [name, src] of Object.entries(handlers)) fs.writeFileSync(path.join(dir, 'handlers', `${name}.js`), src);
    };
    const hidePromo = { id: 'hide-promo', anchor: { primary: { kind: 'css', value: '.promo' } }, mutations: [{ kind: 'hide' }] };
    const markTracks = { id: 'mark-tracks', anchor: { primary: { kind: 'css', value: '.track' } }, mutations: [{ kind: 'script', handler: 'markTrack' }] };
    const markSrc = `module.exports = async function markTrack({ anchor, api }) {
  const id = anchor.getAttribute('data-id');
  await api.storage.set('seen:' + id, true);
  const back = await api.storage.get('seen:' + id);
  anchor.setAttribute('data-shim-seen', String(back));
};
`;
    write({ ...spec, rules: [hidePromo, markTracks] }, { markTrack: markSrc });
    const p1 = await call('shim_preview', {});
    const e1 = json(p1);
    const ev1 = isRecord(e1.evidence) ? e1.evidence : {};
    const rules1 = Array.isArray(ev1.rules) ? ev1.rules.filter(isRecord) : [];
    check('the preview applies and gets revision 1', e1.applied === true && e1.revision === 1, e1);
    check('every rule reports a match and full verification', rules1.length === 2
      && rules1.every((r) => typeof r.status === 'string' && r.status.startsWith('matched') && r.verification === 'full'), rules1);
    check('the evidence names the changes', JSON.stringify(ev1.changes) === JSON.stringify(['add-rule hide-promo', 'add-rule mark-tracks']), ev1.changes);
    check('no handler errors', Array.isArray(ev1.errors) && ev1.errors.length === 0, ev1.errors);
    check('the promo is hidden on the live page', await evalInPage(`getComputedStyle(document.querySelector('.promo')).display`) === 'none');
    check('the handler round-tripped api.storage', await evalInPage(`[...document.querySelectorAll('.track')].map(e => e.getAttribute('data-shim-seen')).join()`) === 'true,true');

    // --- D15 preflight: atomic refusal ---------------------------------------
    write({ ...spec, rules: [hidePromo, markTracks, { id: 'go', anchor: { primary: { kind: 'css', value: 'body' } }, mutations: [{ kind: 'redirect', from: '/a', to: '/b' }] }] }, { markTrack: markSrc });
    const p2 = json(await call('shim_preview', {}));
    const ev2 = isRecord(p2.evidence) ? p2.evidence : {};
    check('a redirect rule is refused as unsupported, nothing applied', p2.applied === false && ev2.error === 'unsupported' && p2.revision === 1
      && Array.isArray(ev2.unsupported) && String(ev2.unsupported[0]).includes('redirect'), p2);
    write({ ...spec, settings: [{ key: 'color', type: 'string', label: 'Color' }], rules: [hidePromo, markTracks] }, { markTrack: markSrc });
    const p3 = json(await call('shim_preview', {}));
    check('a settings declaration is refused as unsupported', p3.applied === false && isRecord(p3.evidence) && p3.evidence.error === 'unsupported', p3);

    // --- an unsupported member at runtime: its shape, partial, the scan ------
    const probe = { id: 'probe', anchor: { primary: { kind: 'css', value: '.tracks' } }, mutations: [{ kind: 'script', handler: 'probeFetch' }] };
    const probeSrc = `module.exports = async function probeFetch({ anchor, api }) {
  const r = await api.fetch('https://example.com/');
  const s = await api.settings.get('enabled');
  anchor.setAttribute('data-probe', JSON.stringify({ r, s: s === undefined ? 'undefined' : s, db: api.db === undefined }));
};
`;
    write({ ...spec, rules: [hidePromo, markTracks, probe] }, { markTrack: markSrc, probeFetch: probeSrc });
    const p4 = json(await call('shim_preview', {}));
    const ev4 = isRecord(p4.evidence) ? p4.evidence : {};
    const probeRule = (Array.isArray(ev4.rules) ? ev4.rules.filter(isRecord) : []).find((r) => r.ruleId === 'probe');
    check('a rule whose handler used an unsupported member is partial', p4.applied === true && probeRule?.verification === 'partial', ev4.rules);
    check('the evidence lists the unsupported uses', Array.isArray(ev4.unsupportedApi) && ev4.unsupportedApi.length >= 2, ev4.unsupportedApi);
    check('the source scan warned about the handler', Array.isArray(ev4.warnings) && ev4.warnings.some((w) => String(w).includes('probeFetch') && String(w).includes('api.fetch')), ev4.warnings);
    const probed = await evalInPage(`document.querySelector('.tracks').getAttribute('data-probe')`);
    const probedValue = typeof probed === 'string' ? JSON.parse(probed) as Record<string, unknown> : {};
    check('each member failed in its own shape', isRecord(probedValue.r) && probedValue.r.ok === false && probedValue.r.error === 'requires-shim-browser'
      && probedValue.s === 'undefined' && probedValue.db === true, probedValue);

    // Back to the supported pair for the commit.
    write({ ...spec, rules: [hidePromo, markTracks] }, { markTrack: markSrc });
    const p5 = json(await call('shim_preview', {}));
    check('removing the probe applies as revision 3', p5.applied === true && p5.revision === 3, p5);

    // --- look ------------------------------------------------------------------
    const shot = await call('view_page', { selector: '.tracks' });
    check('view_page returns a caption and an image', shot.content.some((c) => c.type === 'image' && c.mimeType === 'image/png')
      && (shot.content[0]?.text ?? '').startsWith('Cropped screenshot around `.tracks`'), shot.content.map((c) => c.type));
    const verify = await call('verify_across_pages', {});
    check('verify_across_pages answers requires-shim-browser', verify.isError === true && (verify.content[0]?.text ?? '').startsWith('requires-shim-browser'));
    const q = json(await call('query_page', { description: 'track list' }));
    check('query_page answers candidates', Array.isArray(q.candidates), q);

    // --- commit ------------------------------------------------------------------
    const c1 = json(await call('shim_commit', { summary: 'Hid the promo and marked tracks.' }));
    check('the commit writes the .shim file', c1.committed === true && c1.versionId === 2 && c1.writtenTo === shimFile, c1);
    const file = JSON.parse(fs.readFileSync(shimFile, 'utf8')) as Record<string, unknown>;
    const fspec = isRecord(file.spec) ? file.spec : {};
    const frules = Array.isArray(fspec.rules) ? fspec.rules.filter(isRecord) : [];
    const promoRule = frules.find((r) => r.id === 'hide-promo');
    check('the file is shim/1 with the new version and a deploy baseline', file.format === 'shim/1' && fspec.version === 2 && typeof fspec.bundleHash === 'string', { format: file.format, version: fspec.version, bundleHash: fspec.bundleHash });
    check('the captured witness is committed', isRecord(promoRule?.anchor) && isRecord(promoRule.anchor.witness), promoRule);
    check('handlers ride as modules', isRecord(file.handlers) && typeof file.handlers.markTrack === 'string');
    const history = Array.isArray(file.authoringHistory) ? file.authoringHistory.filter(isRecord) : [];
    check('the session\'s exchange is in the history, stamped', history.length === 2 && history[0]?.external === true
      && history[1]?.content === 'Hid the promo and marked tracks.' && history[1]?.versionId === 2, history);
    const storageFile = `${shimFile}.storage.json`;
    const stored = fs.existsSync(storageFile) ? JSON.parse(fs.readFileSync(storageFile, 'utf8')) as Record<string, unknown> : {};
    check('api.storage persisted to its file', JSON.stringify(stored).includes('seen:t1'), stored);
    const again = json(await call('shim_commit', { summary: 'again', revision: 1 }));
    check('committing an old revision is stale', JSON.stringify(again).includes('stale-revision') || (again.raw ?? '').toString().startsWith('stale-revision'), again);

    // A cookie the site sets in this session's page...
    await call('evaluate_in_page', { expression: `document.cookie = 'probe=1; path=/'` });
    const ended = json(await call('shim_end_session', {}));
    check('the session ends', ended.ended === true, ended);

    // --- reopen the committed .shim ----------------------------------------------
    const dir2 = path.join(tmp, 'again');
    const re = json(await call('shim_open_session', { url: `${origin}/`, intent: 'Keep going', shimFile, dir: dir2 }));
    check('the committed .shim reopens', typeof re.sessionId === 'string' && re.shimId === fspec.id, re);
    // No wait: opening settles after applying the committed rules.
    check('its rules run on the page right away', await evalInPage(`getComputedStyle(document.querySelector('.promo')).display`) === 'none');
    const spec2 = fs.readFileSync(path.join(dir2, 'shim.json'), 'utf8');
    check('the checkout carries no witness, version or bundleHash', !spec2.includes('witness') && !spec2.includes('bundleHash') && !spec2.includes('"version"'));
    const cookies = await pages[pages.length - 1]?.cookies();
    check('the new session starts from a fresh profile (no cookie from the last)', Array.isArray(cookies) && cookies.length === 0, cookies);
    await call('shim_end_session', {});

    // --- a .shim declaring an unsupported kind can't open --------------------------
    const bad = { ...file, spec: { ...fspec, rules: [...frules, { id: 'icpt', anchor: { primary: { kind: 'css', value: 'body' } }, mutations: [{ kind: 'intercept', module: 'm', wrap: 'w' }] }] } };
    const badFile = path.join(tmp, 'bad.shim');
    fs.writeFileSync(badFile, JSON.stringify(bad));
    const refusedOpen = await call('shim_open_session', { url: `${origin}/`, intent: 'x', shimFile: badFile });
    check('a .shim with an intercept rule is refused at open', refusedOpen.isError === true && (refusedOpen.content[0]?.text ?? '').startsWith('unsupported'), refusedOpen.content[0]?.text);
    check('no page was left open', (await control.request('GET', '/status')).body.sessions instanceof Array
      && ((await control.request('GET', '/status')).body.sessions as unknown[]).length === 0);
  } finally {
    await control.closeAll();
    await client.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(() => {
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nheadless session e2e: all checks passed');
}, (e: unknown) => {
  console.error(e);
  process.exit(1);
});
