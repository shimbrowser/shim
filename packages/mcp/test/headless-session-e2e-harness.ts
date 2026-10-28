// headless-session-e2e-harness — the full loop on a supported shim with no
// Shim browser: a real MCP
// client talks to the real @shimbrowser/mcp server in headless mode, which
// drives a real Playwright Chromium against a local fixture site.
//
//   open a new shim on a url → check out → edit → preview (evidence) → look
//   (view_page, evaluate_in_page) → drive the page (interact_page: the whole
//   page headless, trusted, popups closed, traffic not observed) and move it
//   (navigate: the start origin only, previews re-applied, an off-site
//   redirect contained) → commit (the .shim file: version, witness,
//   history, deploy baseline; api.storage in its file) → end → reopen the
//   committed .shim (its rules run again, witnesses stay out of shim.json)
//   then `shim preview` of an unpacked folder on a new deploy: witness-less
//   rules whose anchor is unchanged refresh the baseline / promote a working
//   fallback; a re-anchored one sees no deploy
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
import { openHeadlessPage, openLoadedHeadlessPage } from '../src/playwright-launch';
import { previewFolder, unpackFile } from '../src/cli-commands';
import type { PageRuntimeEvent } from '@shimbrowser/core/page-host';
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
<button id="site-btn" onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1); this.dataset.trusted = String(event.isTrusted)">site button</button>
<button id="hover-btn" onmouseover="var o = document.getElementById('hover-cover'), r = this.getBoundingClientRect(); o.style.cssText = 'position: fixed; z-index: 9; background: #fc0; left: ' + (r.left - 4) + 'px; top: ' + (r.top - 4) + 'px; width: ' + (r.width + 8) + 'px; height: ' + (r.height + 8) + 'px'" onclick="this.dataset.clicks = '1'">hover me</button>
<button id="hover-cover" style="display: none" onclick="document.body.dataset.coverClicked = '1'">cover</button>
<input id="field-a" type="text" onfocus="document.getElementById('field-b').focus()">
<input id="field-b" type="text" value="keep me">
<select id="sel-ok" onchange="this.dataset.changed = this.value"><option value="a">a</option><option value="b">b</option></select>
<button id="slow-btn" onmousedown="location.href = '/slow'" onmouseup="sessionStorage.setItem('slowUp', '1')">slow</button>
<button id="pop-btn" onclick="window.open('/popup', 'pop', 'width=300,height=200')">open a popup</button>
<div id="frame-wrap" style="display: inline-block"><iframe id="frame" style="width: 200px; height: 80px; border: 0" srcdoc="<button style='width:100%;height:100%' onclick='parent.document.body.dataset.framed = 1'>in frame</button>"></iframe></div>
<frame-box id="fbox" style="display: inline-block"></frame-box>
<script>
customElements.define('frame-box', class extends HTMLElement {
  constructor() {
    super();
    const f = document.createElement('iframe');
    f.style.cssText = 'width: 200px; height: 80px; border: 0';
    f.srcdoc = '<input id="i" style="width: 100%; height: 70px" onkeydown="parent.document.body.dataset.framedKey = 1">';
    this.attachShadow({ mode: 'open' }).appendChild(f);
  }
});
</script>
<div style="height: 3000px">tall</div>
</body></html>`;

// Bot walls (served in place of the site) and a page that only talks about one.
const WALLS: Record<string, string> = {
  '/wall/cf-block': `<!DOCTYPE html><html lang="en-US"><head><title>Attention Required! | Cloudflare</title></head>
<body><div id="cf-wrapper"><div id="cf-error-details" class="cf-error-details-wrapper"><div class="cf-header">
<h1>Sorry, you have been blocked</h1><h2><span>You are unable to access</span> 127.0.0.1</h2></div>
<p>This website is using a security service to protect itself from online attacks.</p>
<div class="cf-error-footer"><p><span class="cf-footer-item">Cloudflare Ray ID: <strong>8d2f1a2b3c4d5e6f</strong></span>
<span class="cf-footer-item">Performance &amp; security by Cloudflare</span></p></div></div></div></body></html>`,
  '/wall/cf-challenge': `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body>
<h1>127.0.0.1</h1><div id="challenge-stage"></div><div id="challenge-running">Verifying you are human. This may take a few seconds.</div>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=8d2f"></script></body></html>`,
  '/wall/akamai': `<HTML><HEAD>
<TITLE>Access Denied</TITLE>
</HEAD><BODY>
<H1>Access Denied</H1>
You don't have permission to access "http&#58;&#47;&#47;127&#46;0&#46;0&#46;1&#47;" on this server.<P>
Reference&#32;&#35;18&#46;4f3c1702&#46;1730000000&#46;1a2b3c4d
</BODY>
</HTML>`,
  '/wall/datadome': `<html lang="en"><head><title>127.0.0.1</title></head><body style="margin:0">
<script type="text/plain" src="https://ct.captcha-delivery.com/c.js"></script>
<iframe srcdoc="<p>Access is temporarily restricted</p>" src="https://geo.captcha-delivery.com/captcha/?initialCid=x" title="DataDome Device Check" width="100%" height="100%" frameborder="0"></iframe></body></html>`,
  '/wall/article': `<!doctype html><html><head><title>Attention Required! | Cloudflare — what it means</title></head><body><article>
<h1>Sorry, you have been blocked</h1><p>Cloudflare's block page shows a Ray ID and says you are unable to access the site.
Akamai's says Access Denied: You don't have permission to access "/" on this server. Reference #18.4f3c1702.1730000000.1a2b3c4d.</p>
<p>${'The article goes on about the services and how they decide. '.repeat(10)}</p></article></body></html>`,
};
// A challenge that clears by itself a second after it loads (the site then shows).
const CLEARING_CHALLENGE = WALLS['/wall/cf-challenge']?.replace('</body>', `<script>setTimeout(() => { location.href = '/'; }, 1000);</script></body>`) ?? '';

async function main(): Promise<void> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const wall = WALLS[pathname];
    if (wall !== undefined || pathname === '/wall/cf-clears') {
      // A wall answers with the status the services use.
      res.writeHead(pathname === '/wall/article' ? 200 : 403, { 'Content-Type': 'text/html' });
      res.end(wall ?? CLEARING_CHALLENGE);
      return;
    }
    if (pathname.startsWith('/cdn-cgi/')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end('');
      return;
    }
    if (pathname === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end('window.__app = 1;');
      return;
    }
    if (pathname === '/away') {
      // The site's own redirect off its origin (another host name for the
      // same server): navigate's containment case.
      res.writeHead(302, { Location: `http://localhost:${(server.address() as AddressInfo).port}/` });
      res.end();
      return;
    }
    if (pathname === '/late') {
      // A page that leaves the site two seconds after it loads.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(PAGE.replace('</body>', `<script>setTimeout(() => { location.href = 'http://localhost:${(server.address() as AddressInfo).port}/'; }, 2000);</script></body>`));
      return;
    }
    if (pathname === '/slow') {
      // A navigation held pending: the page starts to move long before it commits.
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); }, 3000);
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
  // A hook run once right after interact_page's next locate (the race
  // between locating an element and acting on it, made deterministic).
  let afterLocate: ((host: HeadlessSessionPage['host']) => Promise<void>) | null = null;

  const control = createHeadlessControl({
    version: 'test',
    playwrightAvailable: () => true,
    // A challenge gets this long to clear at open (the clearing fixture takes one second).
    botWallSettleMs: 4000,
    async openPage(url, storage): Promise<HeadlessSessionPage> {
      const opened = await openHeadlessPage({ visible, storage });
      pages.push({ cookies: () => opened.page.context().cookies() });
      const loaded = opened.host.waitForLoad({ timeoutMs: 15_000 });
      opened.host.reload(url);
      await loaded;
      const host: HeadlessSessionPage['host'] = {
        ...opened.host,
        async evaluate(code, world) {
          const r = await opened.host.evaluate(code, world);
          if (afterLocate && code.includes('__shimHeadlessTarget = r')) {
            const hook = afterLocate;
            afterLocate = null;
            await hook(opened.host);
          }
          return r;
        },
      };
      return { host, close: () => opened.close() };
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

    // --- drive and move the page (interact_page, navigate) --------------------
    // Headless is unrestricted: the site's own controls take trusted input.
    const i1 = json(await call('interact_page', { actions: [{ click: '#site-btn' }, { scroll: { by: 300 } }] }));
    const steps1 = Array.isArray(i1.steps) ? i1.steps.filter(isRecord) : [];
    check('interact_page drives the whole page headless (scope page)', i1.scope === 'page' && steps1.length === 2 && steps1.every((st) => st.ok === true), i1);
    check('…the site saw one trusted click', await evalInPage(`document.querySelector('#site-btn').dataset.clicks + '/' + document.querySelector('#site-btn').dataset.trusted`) === '1/true');
    const scrolled = isRecord(steps1[1]?.scrolled) ? steps1[1].scrolled : {};
    check('…the scroll reports requested and observed movement', scrolled.requested === 300 && typeof scrolled.observed === 'number' && scrolled.observed > 0, scrolled);
    check('…and site traffic is reported as not observed, never as none', i1.calls === null && i1.traffic === 'not observed', i1);
    await evalInPage(`(() => { const f = document.createElement('iframe'); f.id = 'wheel-cover'; f.srcdoc = '<div style="height:4000px">x</div>'; f.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:99999'; document.body.append(f); return true; })()`);
    await new Promise((r) => setTimeout(r, 300));
    const wf = json(await call('interact_page', { actions: [{ scroll: { by: 200 } }] }));
    const wst = Array.isArray(wf.steps) ? wf.steps.filter(isRecord)[0] : undefined;
    const wfY = await evalInPage(`document.querySelector('#wheel-cover').contentWindow.scrollY`);
    await evalInPage(`(document.querySelector('#wheel-cover').remove(), true)`);
    check('a scroll over a frame is refused frame-unsupported, and the frame did not scroll', wst?.ok === false && String(wst.error).startsWith('frame-unsupported') && wfY === 0, { wf, wfY });
    for (const sel of ['#frame', '#frame-wrap']) {
      const fr = json(await call('interact_page', { actions: [{ click: sel }] }));
      const st = Array.isArray(fr.steps) ? fr.steps.filter(isRecord)[0] : undefined;
      check(`a click on ${sel} (into a frame) is refused frame-unsupported`, st?.ok === false && String(st.error).startsWith('frame-unsupported'), fr);
    }
    check('…and the frame got no input', await evalInPage(`document.body.dataset.framed === undefined`) === true);
    const shadowFrame = json(await call('interact_page', { actions: [{ click: '#fbox' }] }));
    const sf = Array.isArray(shadowFrame.steps) ? shadowFrame.steps.filter(isRecord)[0] : undefined;
    check('a frame inside a web component\'s shadow root is refused too', sf?.ok === false && String(sf.error).startsWith('frame-unsupported'), shadowFrame);
    await evalInPage(`(document.querySelector('#fbox').shadowRoot.querySelector('iframe').contentDocument.querySelector('#i').focus(), true)`);
    const shadowKey = json(await call('interact_page', { actions: [{ press: 'Enter' }] }));
    const sk = Array.isArray(shadowKey.steps) ? shadowKey.steps.filter(isRecord)[0] : undefined;
    check('…and a key while that frame holds the focus', sk?.ok === false && String(sk.error).startsWith('frame-unsupported')
      && await evalInPage(`document.body.dataset.framedKey === undefined`) === true, shadowKey);
    const covered = json(await call('interact_page', { actions: [{ click: '#hover-btn' }] }));
    const cv = Array.isArray(covered.steps) ? covered.steps.filter(isRecord)[0] : undefined;
    check('an overlay raised by the move stops the press headless too', cv?.ok === false && /would land on button#hover-cover/.test(String(cv.error)), covered);
    check('…and neither the target nor the overlay was clicked', await evalInPage(`document.body.dataset.coverClicked === undefined && document.querySelector('#hover-btn').dataset.clicks === undefined`) === true);
    const redirected = json(await call('interact_page', { actions: [{ type: '#field-a', text: 'replacement', clear: true }, { click: '#site-btn' }] }));
    const rd = Array.isArray(redirected.steps) ? redirected.steps.filter(isRecord)[0] : undefined;
    check('typing stops when a focus handler moves focus off the field, the rest not run', rd?.ok === false && /focus moved off the target/.test(String(rd.error)) && redirected.notRun === 1, redirected);
    check('…and the other field is untouched', await evalInPage(`document.querySelector('#field-b').value + '|' + document.querySelector('#field-a').value`) === 'keep me|');
    const okSel = json(await call('interact_page', { actions: [{ select: '#sel-ok', value: 'b' }] }));
    check('headless select sets the located <select>', Array.isArray(okSel.steps) && isRecord(okSel.steps[0]) && okSel.steps[0].ok === true
      && await evalInPage(`document.querySelector('#sel-ok').dataset.changed`) === 'b', okSel);
    // The page replaces the <select> right after it was located (a visible
    // replacement under the same id): the replacement is never set.
    afterLocate = async (h) => { await h.evaluate(`(() => { const o = document.querySelector('#sel-ok'); const n = o.cloneNode(true); n.removeAttribute('onchange'); n.dataset.changed = ''; n.addEventListener('change', () => { document.body.dataset.replacedChanged = '1'; }); o.replaceWith(n); return true; })()`, 'main'); };
    const replacedSel = json(await call('interact_page', { actions: [{ select: '#sel-ok', value: 'b' }] }));
    const rs = Array.isArray(replacedSel.steps) ? replacedSel.steps.filter(isRecord)[0] : undefined;
    check('a <select> replaced between locating and setting is refused, the replacement untouched', rs?.ok === false && /left the page/.test(String(rs.error))
      && await evalInPage(`document.body.dataset.replacedChanged === undefined && document.querySelector('#sel-ok').value === 'a'`) === true, replacedSel);
    // An overlay over it at that boundary: not set either.
    afterLocate = async (h) => { await h.evaluate(`(() => { const s = document.querySelector('#sel-ok').getBoundingClientRect(); const o = document.createElement('div'); o.id = 'sel-cover'; o.style.cssText = 'position: fixed; z-index: 9; background: red; left: ' + (s.left - 2) + 'px; top: ' + (s.top - 2) + 'px; width: ' + (s.width + 4) + 'px; height: ' + (s.height + 4) + 'px'; document.body.appendChild(o); return true; })()`, 'main'); };
    const coveredSel = json(await call('interact_page', { actions: [{ select: '#sel-ok', value: 'b' }] }));
    const cs = Array.isArray(coveredSel.steps) ? coveredSel.steps.filter(isRecord)[0] : undefined;
    check('a <select> covered between locating and setting is refused, its value and handler untouched', cs?.ok === false && /covered by div#sel-cover/.test(String(cs.error))
      && await evalInPage(`document.querySelector('#sel-ok').value === 'a' && document.body.dataset.replacedChanged === undefined`) === true, coveredSel);
    await evalInPage(`(document.querySelector('#sel-cover').remove(), true)`);
    // A reload to the same URL at that boundary: nothing is set on the new page.
    afterLocate = async (h) => { const w = h.waitForLoad({ timeoutMs: 15_000 }); h.reload(); await w; };
    const reloadedSel = json(await call('interact_page', { actions: [{ select: '#sel-ok', value: 'b' }] }));
    const rl = Array.isArray(reloadedSel.steps) ? reloadedSel.steps.filter(isRecord)[0] : undefined;
    check('a same-URL reload between locating and setting is refused', rl?.ok === false, reloadedSel);
    check('…and the fresh page\'s <select> was not set', await evalInPage(`document.querySelector('#sel-ok').value === 'a' && document.querySelector('#sel-ok').dataset.changed === undefined`) === true);
    const i2 = json(await call('interact_page', { actions: [{ click: '#pop-btn' }], settleMs: 500 }));
    check('a popup the batch causes is closed and reported', Array.isArray(i2.linksNotOpened) && i2.linksNotOpened.length === 1, i2);
    const slow = json(await call('interact_page', { actions: [{ click: '#slow-btn' }, { click: '#site-btn' }] }));
    // The page has moved on by now; sessionStorage outlives the navigation.
    const slowAfter = await evalInPage(`sessionStorage.getItem('slowUp') === null`);
    check('a navigation that has started (not yet committed) stops the batch: no release, nothing after', Number(slow.notRun) >= 1
      && Array.isArray(slow.steps) && slow.steps.length === 1 && slowAfter === true, { slow, slowAfter });
    const nav1 = json(await call('navigate', { url: '/next' }));
    check('navigate loads a page on the start origin and re-applies the previews', nav1.ok === true && nav1.onSite === true && String(nav1.url).endsWith('/next')
      && nav1.reapplied === 2 && nav1.navigationsLeft === 19, nav1);
    check('…the previews run on the new page', await evalInPage(`getComputedStyle(document.querySelector('.promo')).display`) === 'none');
    // A full load the page makes itself, then straight to a fragment of the
    // new page: the previews were never on it, so the fragment move puts
    // them back.
    await call('evaluate_in_page', { expression: `location.href = '/other'` });
    await new Promise((r) => setTimeout(r, 1500));
    const navAfterLoad = json(await call('navigate', { url: '/other#top' }));
    check('a fragment move right after a full load re-applies the previews', navAfterLoad.ok === true && navAfterLoad.sameDocument === true && navAfterLoad.reapplied === 2, navAfterLoad);
    check('…and they run there', await evalInPage(`getComputedStyle(document.querySelector('.promo')).display`) === 'none');
    // The same, on a page that leaves the site while the restore settles:
    // the final state is what's reported.
    await call('evaluate_in_page', { expression: `location.href = '/late'` });
    await new Promise((r) => setTimeout(r, 800));
    const navLate = json(await call('navigate', { url: '/late#x' }));
    check('a fragment move whose restore settles into an off-site redirect reports the final state', navLate.ok === true && navLate.onSite === false && String(navLate.url).startsWith('http://localhost:'), navLate);
    await call('navigate', { url: `${origin}/next` });
    const navFrag = json(await call('navigate', { url: '/next#more' }));
    check('a fragment navigate keeps the document and its previews', navFrag.ok === true && navFrag.sameDocument === true && String(navFrag.url).endsWith('/next#more'), navFrag);
    const navTop = json(await call('navigate', { url: '/next#' }));
    check('an empty fragment is a same-document move too', navTop.ok === true && navTop.sameDocument === true, navTop);
    const nav2 = json(await call('navigate', { url: 'https://example.com/' }));
    check('navigate refuses another origin before loading', nav2.error === 'off-origin' && nav2.navigationsLeft === undefined, nav2);
    const nav3 = json(await call('navigate', { url: '/away' }));
    check('a redirect off the site is contained and reported', nav3.ok === true && nav3.onSite === false && nav3.redirected === true && typeof nav3.note === 'string', nav3);
    const offSite = json(await call('query_page', { description: 'track list' }));
    check('…the page tools refuse until it is back', offSite.error === 'page-away', offSite);
    const nav4 = json(await call('navigate', { url: `${origin}/` }));
    check('navigate brings it back to the site', nav4.ok === true && nav4.onSite === true, nav4);

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

    // --- bot walls: refused at open, reported on every page tool --------------------
    for (const [where, vendor] of [['/wall/cf-block', 'cloudflare'], ['/wall/cf-challenge', 'cloudflare'], ['/wall/akamai', 'akamai'], ['/wall/datadome', 'datadome']] as const) {
      const walled = await call('shim_open_session', { url: `${origin}${where}`, intent: 'x', newShimName: 'Walled', dir: path.join(tmp, 'walled') });
      const text = walled.content[0]?.text ?? '';
      check(`a ${where.slice(6)} page refuses the open with blocked-by-bot-wall`, walled.isError === true && text.startsWith('blocked-by-bot-wall')
        && text.toLowerCase().includes(vendor) && text.includes('Shim browser'), text);
    }
    check('…and leaves no session or file behind', ((await control.request('GET', '/status')).body.sessions as unknown[]).length === 0
      && !fs.existsSync(path.join(tmp, 'walled.shim')));
    const clears = json(await call('shim_open_session', { url: `${origin}/wall/cf-clears`, intent: 'x', newShimName: 'Clears', dir: path.join(tmp, 'clears') }));
    check('a challenge that clears by itself opens on the site', typeof clears.sessionId === 'string' && String(clears.url).endsWith('/'), clears);
    await call('shim_end_session', {});
    const article = json(await call('shim_open_session', { url: `${origin}/wall/article`, intent: 'x', newShimName: 'Article', dir: path.join(tmp, 'article') }));
    check('an article quoting the walls\' wording opens normally', typeof article.sessionId === 'string', article);
    await call('shim_end_session', {});

    const wallDir = path.join(tmp, 'wall-session');
    const ws = json(await call('shim_open_session', { url: `${origin}/`, intent: 'Outline headings', newShimName: 'Headings', dir: wallDir }));
    check('a session opens on the site', typeof ws.sessionId === 'string', ws);
    const wallSpec = JSON.parse(fs.readFileSync(path.join(wallDir, 'shim.json'), 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(path.join(wallDir, 'shim.json'), JSON.stringify({ ...wallSpec, rules: [{ id: 'outline', anchor: { primary: { kind: 'css', value: 'h1' } }, mutations: [{ kind: 'restyle', properties: { outline: '2px solid red' } }] }] }, null, 2));
    const navWall = json(await call('navigate', { url: '/wall/cf-block' }));
    const navNote = isRecord(navWall.botWall) ? navWall.botWall : {};
    check('navigate onto a block page carries botWall', navWall.ok === true && navNote.code === 'bot-wall' && navNote.vendor === 'cloudflare' && navNote.kind === 'block', navWall);
    const pw = json(await call('shim_preview', {}));
    const pwEv = isRecord(pw.evidence) ? pw.evidence : {};
    const pwRules = Array.isArray(pwEv.rules) ? pwEv.rules.filter(isRecord) : [];
    check('a preview on the wall carries botWall and a warning', isRecord(pwEv.botWall) && Array.isArray(pwEv.warnings)
      && pwEv.warnings.some((w) => typeof w === 'string' && w.includes('Cloudflare block page')), pwEv);
    check('…and a rule that matched the wall\'s own heading is no better than partial', pwRules.length === 1
      && String(pwRules[0]?.status).startsWith('matched') && pwRules[0]?.verification === 'partial', pwRules);
    const qWall = json(await call('query_page', { description: 'the heading' }));
    check('query_page on the wall carries botWall', isRecord(qWall.botWall), qWall);
    const vWall = await call('view_page', {});
    check('view_page on the wall carries botWall', vWall.content.some((c) => c.type === 'text' && (c.text ?? '').includes('"botWall"')), vWall.content.map((c) => c.type));
    const navBack = json(await call('navigate', { url: '/' }));
    check('back on the site, navigate carries no botWall', navBack.ok === true && navBack.botWall === undefined, navBack);
    const pBack = json(await call('shim_preview', {}));
    const pBackEv = isRecord(pBack.evidence) ? pBack.evidence : {};
    check('…nor does a preview there', pBackEv.botWall === undefined, pBackEv);
    await call('shim_end_session', {});

    // --- a .shim declaring an unsupported kind can't open --------------------------
    const bad = { ...file, spec: { ...fspec, rules: [...frules, { id: 'icpt', anchor: { primary: { kind: 'css', value: 'body' } }, mutations: [{ kind: 'intercept', module: { loader: 'amd', id: 'm' }, wrap: 'w' }], handlers: { w: 'function w(mod) { return mod; }' } }] } };
    const badFile = path.join(tmp, 'bad.shim');
    fs.writeFileSync(badFile, JSON.stringify(bad));
    const refusedOpen = await call('shim_open_session', { url: `${origin}/`, intent: 'x', shimFile: badFile });
    check('a .shim with an intercept rule is refused at open', refusedOpen.isError === true && (refusedOpen.content[0]?.text ?? '').startsWith('unsupported'), refusedOpen.content[0]?.text);
    check('no page was left open', (await control.request('GET', '/status')).body.sessions instanceof Array
      && ((await control.request('GET', '/status')).body.sessions as unknown[]).length === 0);

    // --- shim preview of an unpacked folder on a new deploy -----------------
    // Witness-less multi-match rules (two tracks), committed under a deploy
    // baseline the page no longer has: .shim-state.json's anchors say which
    // are unchanged, so those run behind the baseline as in Shim.
    const trackRestyle = [{ kind: 'restyle', properties: { outlineOffset: '3px' } }];
    const deployFile = path.join(tmp, 'deploy.shim');
    fs.writeFileSync(deployFile, JSON.stringify({
      format: 'shim/1',
      name: 'Deploy',
      spec: {
        id: 'deploy-shim',
        version: 3,
        bundleHash: 'an-older-deploy',
        match: { hosts: [`127.0.0.1:${port}`] },
        rules: [
          { id: 'refresh', anchor: { primary: { kind: 'css', value: '.track' } }, mutations: trackRestyle },
          { id: 'promote', anchor: { primary: { kind: 'css', value: '.track-v1' }, fallbacks: [{ kind: 'css', value: 'li[data-id]' }] }, mutations: trackRestyle },
          { id: 'edited', anchor: { primary: { kind: 'css', value: '.row-v1' }, fallbacks: [{ kind: 'css', value: 'ul.tracks > li' }] }, mutations: trackRestyle },
        ],
      },
      handlers: {},
    }));
    const deployDir = path.join(tmp, 'deploy');
    unpackFile(deployFile, deployDir);
    const deploySpec = JSON.parse(fs.readFileSync(path.join(deployDir, 'shim.json'), 'utf8')) as { rules: Array<{ id: string; anchor: Record<string, unknown> }> };
    const editedRule = deploySpec.rules.find((x) => x.id === 'edited');
    if (editedRule) editedRule.anchor = { ...editedRule.anchor, primary: { kind: 'css', value: '.row-v2' } };
    fs.writeFileSync(path.join(deployDir, 'shim.json'), JSON.stringify(deploySpec, null, 2));
    const seen: PageRuntimeEvent[] = [];
    const folderOutcome = await previewFolder({ dir: deployDir, url: `${origin}/` }, {
      version: 'test',
      async openPage(url, storage, opts) {
        const opened = await openLoadedHeadlessPage(url, { visible: opts.visible, storage });
        opened.host.onRuntimeEvent((e) => { seen.push(e); });
        return {
          host: opened.host,
          close: () => opened.close(),
          async screenshot() { /* not asked for */ },
        };
      },
    });
    // A baseline refresh names the preview (specId), not the rule.
    const forRule = (id: string, kind: string): PageRuntimeEvent[] => seen.filter((e) => e.kind === kind && (e.ruleId === id || e.specId === `preview:deploy-shim:${id}`));
    check('the folder preview applied', folderOutcome.applied === true, folderOutcome);
    const refreshed = forRule('refresh', 'spec-bundle-update')[0];
    check('an unchanged witness-less rule on a new deploy refreshes the baseline', typeof refreshed?.bundleHash === 'string'
      && refreshed.bundleHash !== 'an-older-deploy', forRule('refresh', 'rule-status'));
    const promotedEv = forRule('promote', 'rule-rebase')[0];
    const promotedAnchor = isRecord(promotedEv?.anchor) && isRecord(promotedEv.anchor.primary) ? promotedEv.anchor.primary : {};
    check('an unchanged witness-less rule with a dead primary promotes its working fallback', promotedEv?.strategy === 'promote'
      && promotedAnchor.value === 'li[data-id]', seen.filter((e) => e.ruleId === 'promote'));
    check('a re-anchored witness-less rule sees no deploy: no refresh, no promote',
      forRule('edited', 'spec-bundle-update').length === 0 && forRule('edited', 'rule-rebase').length === 0, seen.filter((e) => e.ruleId === 'edited'));
    check('…and still applies through its fallback', forRule('edited', 'rule-status').some((e) => typeof e.matched === 'number' && e.matched === 2),
      seen.filter((e) => e.ruleId === 'edited'));
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
