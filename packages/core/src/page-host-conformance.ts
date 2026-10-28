// The PageHost conformance suite.
//
// One set of fixture pages and specs, run against any PageHost through the
// interface alone: the Shim browser's Electron host and the headless
// Playwright host run exactly these cases, with exactly these expectations.
// A capability is "yes" for headless only while its cases pass on both
// hosts; `CONFORMANCE_CASES[].covers` names what each case vouches for, so a
// host's advertised capabilities can be checked against what is covered.
//
// Cases (D15): apply (every supported kind and mount strategy), re-render
// survival, SPA navigation, anchor recovery after a simulated deploy,
// teardown, a throwing handler, plus api.storage, the page tools, a page
// with a strict CSP (the real-browser spike's compile path (D12), through the
// real driver), shared handler modules, a dead anchor's preview evidence,
// trusted input with its document token, and a superseded load.
//
// The suite owns its site: `conformanceFixture(path, state)` answers every
// request, and the runner serves it (any HTTP server; the case only needs the
// origin). `setDeploy` flips the site to its next build, which renames the
// entry script — a deploy — and changes the markup the rebase cases target.
//
// Pure: no Node, no host code. Runners live with each host
// (packages/mcp/test/playwright-conformance-harness.ts,
// and the Shim browser's Electron runner).

import type { PageHost, PageRuntimeEvent, PageConsoleMessage, Unsubscribe } from './page-host';
import type { AnchorSpec, Rule, Witness, SetWitness } from './types';
import { computeDeployId } from './deploy-id';
import { viewPageOnHost, evaluateOnHost, MAX_SHOT_WIDTH } from './page-host-tools';
import { errMessage } from './error';
import { moduleToExpression } from './handler-source';
import { previewNoMatch, type NoMatchEntry, type RuleStatusEvent } from './preview-evidence';
import { verificationLevel } from './capability-preflight';
import { clickCommands, keyCommands, locateScript, selectScript, type LocateResult } from './interact';

// --- the fixture site -------------------------------------------------------

export type FixtureDeploy = 1 | 2;

export interface FixtureState {
  deploy: FixtureDeploy;
}

export interface FixtureResponse {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: string;
}

// The site's policy on every page: no eval, no inline script — handler
// compile must not depend on either (D12). Inline <style> stays allowed so
// tier-1 CSS can be judged on its own; /strict tightens style-src too.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:";

const SITE_CSS = `
body { font: 16px/1.4 sans-serif; margin: 16px; }
#list, .rows { display: flex; gap: 8px; list-style: none; padding: 0; }
#lead { color: rgb(0, 0, 0); }
.box { padding: 8px; border: 1px solid #999; margin: 4px 0; min-height: 20px; }
#fold-pane { height: 120px; overflow: auto; }
#fold-pane-spacer { height: 400px; }
#fold-spacer { height: calc(100vh - 200px); }
#fold-target { height: 200px; box-sizing: border-box; background: rgb(200, 30, 160); }
#fold-tail { height: 1500px; }
`;

// The page's own app: a client-rendered #app (re-render and SPA routing are
// the page's behavior, driven from the main world through window.__fixture).
// The same file serves every deploy; only its URL changes.
const APP_JS = `
(function () {
  // The page's own probe of its policy: under script-src 'self' its eval must
  // throw. (Code a host runs through its driver is not the page's own and
  // proves nothing about the page's CSP.)
  var probe;
  try { eval('1'); probe = 'allowed'; } catch (e) { probe = (e && e.name) || 'threw'; }
  document.documentElement.setAttribute('data-eval-probe', probe);
  var rows = ['One', 'Two'];
  var views = {
    '/app': function () {
      return '<div class="view-a"><h1 class="target">Tracks</h1><ul class="rows">'
        + rows.map(function (r) { return '<li class="row"><span class="title">' + r + '</span></li>'; }).join('')
        + '</ul><div class="promo">promo</div></div>';
    },
    '/app/other': function () { return '<div class="view-b"><h1 class="target">Other</h1></div>'; },
  };
  function render() {
    var app = document.getElementById('app');
    var view = views[location.pathname];
    if (app && view) app.innerHTML = view();
  }
  window.__fixture = {
    rerender: function () { render(); return document.querySelectorAll('#app .row').length; },
    addRow: function (title) { rows.push(title); render(); return rows.length; },
    navigate: function (path) { history.pushState({}, '', path); render(); return location.pathname; },
  };
  window.addEventListener('popstate', render);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
`;

function page(title: string, body: string, deploy: FixtureDeploy, extraScript?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/app.v${deploy}.js"></script>
${extraScript ? `<script src="${extraScript}"></script>\n` : ''}</head><body>${body}</body></html>`;
}

// The input page: controls that record, as DOM attributes any world can
// read, whether each event they saw was trusted. #in-steal moves focus away
// on mousedown and #in-hover raises an overlay over itself on mouseover —
// the two ways a page can change what the next input command reaches.
const INPUT_BODY = `
<button id="in-btn" class="box">press me</button>
<input id="in-field" type="text">
<input id="in-ro" type="text" readonly value="fixed">
<button id="in-disabled" class="box" disabled>off</button>
<select id="in-select"><option value="a">A</option><option value="b">B</option></select>
<input id="in-steal" type="text" placeholder="steals focus">
<input id="in-other" type="text">
<button id="in-hover" class="box">hover me</button>
<div id="in-overlay" style="display:none;position:fixed;background:#fc0;z-index:10">overlay</div>
<div style="height:3000px">tall</div>
`;

const INPUT_JS = `
(function () {
  function $(id) { return document.getElementById(id); }
  function mark(el, name, ev) { el.setAttribute('data-' + name, ev.isTrusted ? 'trusted' : 'untrusted'); }
  function count(el, name) { el.setAttribute('data-' + name, String(Number(el.getAttribute('data-' + name) || 0) + 1)); }
  function wire() {
    $('in-btn').addEventListener('click', function (e) { count($('in-btn'), 'clicks'); mark($('in-btn'), 'click', e); });
    $('in-field').addEventListener('input', function (e) { mark($('in-field'), 'input', e); });
    $('in-field').addEventListener('keydown', function (e) { $('in-field').setAttribute('data-last-key', e.key); mark($('in-field'), 'key', e); });
    $('in-disabled').addEventListener('click', function () { count($('in-disabled'), 'clicks'); });
    $('in-select').addEventListener('change', function (e) { mark($('in-select'), 'change', e); });
    $('in-steal').addEventListener('mousedown', function (e) { e.preventDefault(); $('in-other').focus(); });
    $('in-hover').addEventListener('mouseover', function () {
      var r = $('in-hover').getBoundingClientRect(), o = $('in-overlay');
      o.style.left = (r.left - 4) + 'px'; o.style.top = (r.top - 4) + 'px';
      o.style.width = (r.width + 8) + 'px'; o.style.height = (r.height + 8) + 'px';
      o.style.display = 'block';
    });
    $('in-hover').addEventListener('click', function () { count($('in-hover'), 'clicks'); });
    $('in-overlay').addEventListener('click', function () { count($('in-overlay'), 'clicks'); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
`;

const APPLY_BODY = `
<div id="ad" class="box ad">buy now</div>
<p id="lead">lead paragraph</p>
<ul id="list"><li id="a">A</li><li id="b">B</li><li id="c">C</li></ul>
<div id="grid" class="box"><span>1</span><span>2</span></div>
<div id="note-target" class="box">notes</div>
<div id="inject-target" class="box">inject here</div>
<div id="html-target" class="box">html here</div>
<div id="remove-me" class="box">remove me</div>
<section id="root-target" class="box"><p class="original">original content</p></section>
<div id="portal-target" class="box">portal anchor</div>
<div id="overlay-target" class="box">overlay anchor</div>
<div id="shadow-target" class="box">shadow anchor</div>
<div id="cleanup-target" class="box">cleanup anchor</div>
<div id="storage-target" class="box">storage anchor</div>
`;

// The rebase page. Build 2 renames the buy button's class (its other
// signals survive: a witness can re-find it), drops the legacy link
// entirely (nothing to recover), and turns `.price` into a different
// element (a selector that resolves to the wrong thing).
function deployBody(deploy: FixtureDeploy): string {
  const buyClass = deploy === 1 ? 'buy-v1' : 'buy-v2';
  return `
<div id="stable" class="box">stable</div>
<div class="box"><button class="${buyClass}" data-sku="42" aria-label="Buy the record">Buy the record</button></div>
${deploy === 1 ? '<p class="box"><a class="legacy-link" data-ref="legacy" href="#legacy">Legacy catalogue</a></p>' : ''}
${deploy === 1
    ? '<p class="box"><span class="price" data-kind="price">Twelve dollars per month</span></p>'
    : '<p class="box"><em class="price">Free shipping on everything</em></p>'}
`;
}

// The crop page: #fold-target starts a few px above the bottom of the
// viewport (the pane above it is 120px plus margins, the spacer fills the
// rest), so the viewport cuts most of it off; #fold-far starts a viewport
// and a half below; #fold-pane-target is below the fold of its own
// scrolling pane.
const FOLD_BODY = `
<div id="fold-pane"><div id="fold-pane-spacer"></div><div id="fold-pane-target" class="box">in the pane</div></div>
<div id="fold-spacer"></div>
<div id="fold-target" class="box">below the fold</div>
<div id="fold-tail"></div>
<div id="fold-far" class="box">far below</div>
`;

// A list whose rows share a site data-* value, plus a same-class impostor
// elsewhere (another tag's child shape, another parent) — the set-witness case.
const LIST_BODY = `
<ul id="rows">
  <li class="row" data-kind="row" data-i="1"><span class="t">Row one</span><b>1</b></li>
  <li class="row" data-kind="row" data-i="2"><span class="t">Row two</span><b>2</b></li>
  <li class="row" data-kind="row" data-i="3"><span class="t">Row three</span><b>3</b></li>
</ul>
<ol id="other"><li class="row"><em>not a row</em></li></ol>
<div id="mixed"><p class="mix">p</p><span class="mix">span</span></div>
<div id="slots"><div class="slot" data-kind="slot"></div><div class="slot" data-kind="slot"></div></div>
<div id="lone-slot" data-kind="lone"></div>
<p id="done-wrap"><button>Apply</button></p>
`;

const STRICT_BODY = `
<style>#strict-ad { color: rgb(1, 2, 3); }</style>
<div id="strict-ad" class="box">strict ad</div>
<div id="strict-target" class="box">strict target</div>
`;

/** Answer one request for the fixture site. Unknown paths are 404. */
export function conformanceFixture(pathname: string, state: FixtureState): FixtureResponse {
  const html = (body: string, csp = CSP): FixtureResponse => ({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    headers: { 'Content-Security-Policy': csp, 'Cache-Control': 'no-store' },
    body,
  });
  const asset = (contentType: string, body: string): FixtureResponse => ({
    status: 200, contentType, headers: { 'Cache-Control': 'no-store' }, body,
  });
  switch (pathname) {
    case '/apply': return html(page('apply', APPLY_BODY, state.deploy));
    case '/app':
    case '/app/other': return html(page('app', '<div id="app"></div>', state.deploy));
    case '/deploy': return html(page('deploy', deployBody(state.deploy), state.deploy));
    case '/fold': return html(page('fold', FOLD_BODY, state.deploy));
    case '/list': return html(page('list', LIST_BODY, state.deploy));
    case '/strict': return html(page('strict', STRICT_BODY, state.deploy), STRICT_CSP);
    case '/input': return html(page('input', INPUT_BODY, state.deploy, '/assets/input.js'));
    case '/assets/input.js': return asset('text/javascript; charset=utf-8', INPUT_JS);
    case '/assets/site.css': return asset('text/css; charset=utf-8', SITE_CSS);
    case '/assets/app.v1.js':
    case '/assets/app.v2.js': return asset('text/javascript; charset=utf-8', APP_JS);
    default: return { status: 404, contentType: 'text/plain; charset=utf-8', headers: {}, body: 'not found' };
  }
}

/** The deploy identity of a fixture build, as the engine computes it on the page. */
export function fixtureDeployId(origin: string, deploy: FixtureDeploy): string | null {
  const url = new URL(origin);
  return computeDeployId({ scriptUrls: [`${origin}/assets/app.v${deploy}.js`], styleUrls: [`${origin}/assets/site.css`], pageHost: url.hostname });
}

// --- the case kit -----------------------------------------------------------

export interface ConformanceContext {
  host: PageHost;
  /** The fixture site's origin, e.g. http://127.0.0.1:41234. */
  origin: string;
  /** Switch the fixture site to a build; the next page load serves it. */
  setDeploy(deploy: FixtureDeploy): void;
}

/** What a case vouches for. Mutation kinds use their spec names. */
export const CONFORMANCE_CAPABILITIES = [
  'hide', 'restyle', 'reorder', 'reshape',
  'script', 'inject-element', 'inject-html', 'remove', 'replace-root',
  'mount:inline', 'mount:portal', 'mount:overlay', 'mount:shadow', 'self-healing',
  'witness:capture', 'witness:verify', 'witness:set', 'rebase:refresh', 'rebase:promote', 'rebase:recover', 'rebase:quarantine',
  'api.storage', 'api.cleanup', 'handler-errors', 'console', 'spa-navigation', 'teardown', 'page-tools', 'strict-csp',
  'no-match', 'trusted-input', 'superseded-load', 'api.onAnchorChange',
] as const;
export type ConformanceCapability = (typeof CONFORMANCE_CAPABILITIES)[number];

export interface CaseKit {
  readonly host: PageHost;
  readonly origin: string;
  setDeploy(deploy: FixtureDeploy): void;
  /** Record a check. */
  check(label: string, ok: boolean, detail?: unknown): void;
  /** Load a fixture path and wait until the engine answers. False when it never did. */
  load(path: string): Promise<boolean>;
  /** Apply `rule` as a preview of the suite's shim; returns its ruleKey. */
  apply(rule: Rule, options?: { bundleHash?: string; autoRepair?: boolean }): string;
  remove(ruleKey: string): void;
  /** Evaluate in the page's main world; a throw reads as undefined. */
  read(code: string): Promise<unknown>;
  /** Poll until `probe` returns a non-null value, or null at the timeout. */
  until<T>(probe: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs?: number): Promise<T | null>;
  /** Every runtime event since the case started. */
  readonly events: readonly PageRuntimeEvent[];
  /** Wait for a runtime event matching `pred` (one already seen counts). */
  event(pred: (e: PageRuntimeEvent) => boolean, timeoutMs?: number): Promise<PageRuntimeEvent | null>;
  /** Every console message since the case started. */
  readonly console: readonly PageConsoleMessage[];
  sleep(ms: number): Promise<void>;
}

export interface ConformanceCase {
  id: string;
  title: string;
  covers: readonly ConformanceCapability[];
  run(kit: CaseKit): Promise<void>;
}

export interface ConformanceCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ConformanceCaseResult {
  id: string;
  title: string;
  covers: readonly ConformanceCapability[];
  checks: ConformanceCheck[];
  passed: boolean;
}

const PATCH_ID = 'conformance';
export const conformanceRuleKey = (ruleId: string): string => `preview:${PATCH_ID}:${ruleId}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function describe(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function makeKit(ctx: ConformanceContext, checks: ConformanceCheck[], applied: Set<string>): CaseKit & { dispose(): void } {
  const events: PageRuntimeEvent[] = [];
  const consoleMessages: PageConsoleMessage[] = [];
  const subs: Unsubscribe[] = [
    ctx.host.onRuntimeEvent((e) => { events.push(e); }),
    ctx.host.onConsole((m) => { consoleMessages.push(m); }),
  ];
  const until = async <T>(probe: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs = 6000): Promise<T | null> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let v: T | null | undefined;
      try { v = await probe(); } catch { v = null; }
      if (v !== null && v !== undefined) return v;
      if (Date.now() > deadline) return null;
      await sleep(50);
    }
  };
  const apply = (rule: Rule, options?: { bundleHash?: string; autoRepair?: boolean }): string => {
    const ruleKey = conformanceRuleKey(rule.id);
    applied.add(ruleKey);
    ctx.host.applyPreview({
      patchId: PATCH_ID,
      rule,
      ruleKey,
      ...(options?.bundleHash !== undefined ? { bundleHash: options.bundleHash } : {}),
      ...(options?.autoRepair !== undefined ? { autoRepair: options.autoRepair } : {}),
    });
    return ruleKey;
  };
  const remove = (ruleKey: string): void => {
    applied.delete(ruleKey);
    ctx.host.removePreview(ruleKey);
  };
  const event = (pred: (e: PageRuntimeEvent) => boolean, timeoutMs = 6000): Promise<PageRuntimeEvent | null> =>
    until(() => events.find(pred) ?? null, timeoutMs);

  // The engine is ready once a probe preview reports a match. The browser's
  // page-preload subscribes to previews only after its boot IPC resolves, so
  // a preview sent on the load event alone could be lost; the probe makes
  // "ready" an observation on every host instead of a guess.
  let probeSeq = 0;
  const engineReady = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const ruleId = `__ready-${++probeSeq}`;
      const ruleKey = conformanceRuleKey(ruleId);
      ctx.host.applyPreview({ patchId: PATCH_ID, ruleKey, rule: { id: ruleId, anchor: { primary: { kind: 'css', value: 'html' } }, mutations: [{ kind: 'restyle', properties: {} }] } });
      const seen = await until(() => events.find((e) => e.kind === 'rule-status' && e.specId === ruleKey && e.matched === 1) ?? null, 500);
      ctx.host.removePreview(ruleKey);
      if (seen) return true;
    }
    return false;
  };
  const load = async (path: string): Promise<boolean> => {
    const wait = ctx.host.waitForLoad({ timeoutMs: 15000 });
    ctx.host.reload(`${ctx.origin}${path}`);
    const outcome = await wait;
    if (outcome.kind !== 'finished') {
      checks.push({ label: `load ${path}`, ok: false, detail: describe(outcome) });
      return false;
    }
    const ready = await engineReady();
    if (!ready) checks.push({ label: `engine answered on ${path}`, ok: false, detail: 'no rule-status for a probe preview' });
    return ready;
  };
  return {
    host: ctx.host,
    origin: ctx.origin,
    setDeploy: ctx.setDeploy,
    check(label, ok, detail) {
      checks.push(ok ? { label, ok } : { label, ok, detail: detail === undefined ? undefined : describe(detail) });
    },
    load,
    apply,
    remove,
    async read(code) {
      try { return await ctx.host.evaluate(code, 'main'); } catch { return undefined; }
    },
    until,
    events,
    event,
    console: consoleMessages,
    sleep,
    dispose() { for (const off of subs) off(); },
  };
}

// --- shared bits for the cases ---------------------------------------------

const css = (value: string): Rule['anchor'] => ({ primary: { kind: 'css', value } });
// Every anchor kind the engine resolves; a recovered anchor of any
// other kind is a failed recovery.
const ANCHOR_KINDS: ReadonlySet<string> = new Set<AnchorSpec['kind']>(['css', 'data-attr', 'aria', 'text']);

// Handler source, authored as a shim would author it.
const H = {
  markDone: `function markDone({ anchor }) {
  anchor.textContent = 'Done';
}`,
  rowTag: `function rowTag({ anchor }) {
  const s = document.createElement('i');
  s.className = 'conf-row-tag';
  s.textContent = 'tagged';
  anchor.appendChild(s);
  return s;
}`,
  note: `function note({ anchor }) {
  const s = document.createElement('span');
  s.className = 'conf-note';
  s.textContent = ' noted';
  anchor.appendChild(s);
  return s;
} // a trailing comment: the host's compile must not let it swallow the close`,
  badge: `function badge({ anchor }) {
  const s = document.createElement('span');
  s.className = 'conf-badge';
  s.textContent = ' *';
  anchor.appendChild(s);
  return s;
}`,
  replacement: `function replacement({ anchor }) {
  const d = document.createElement('div');
  d.className = 'conf-replacement';
  d.textContent = 'replaced';
  anchor.appendChild(d);
  return d;
}`,
  portalOut: `function portalOut() {
  const d = document.createElement('div');
  d.className = 'conf-portal';
  d.textContent = 'floating';
  return d;
}`,
  overlayOut: `function overlayOut() {
  const d = document.createElement('div');
  d.className = 'conf-overlay';
  d.textContent = 'covering';
  return d;
}`,
  shadowOut: `function shadowOut() {
  const s = document.createElement('span');
  s.className = 'conf-shadow';
  s.textContent = 'in the shadow';
  return s;
}`,
  withCleanup: `function withCleanup({ anchor, api }) {
  const s = document.createElement('span');
  s.className = 'conf-cleanup';
  s.textContent = ' live';
  anchor.appendChild(s);
  const timer = setInterval(() => {}, 1000);
  api.cleanup(() => {
    clearInterval(timer);
    document.documentElement.setAttribute('data-conf-cleaned', 'yes');
  });
  return s;
}`,
  storageRoundTrip: `async function storageRoundTrip({ anchor, api }) {
  const out = {};
  out.set = await api.storage.set('conf-key', { n: 1, s: 'two' });
  out.got = await api.storage.get('conf-key');
  out.list = await api.storage.list();
  out.deleted = await api.storage.delete('conf-key');
  out.after = await api.storage.get('conf-key');
  anchor.setAttribute('data-conf-storage', JSON.stringify(out));
}`,
  boom: `function boom() {
  throw new Error('conf-boom');
}`,
  slowMount: `function slowMount({ anchor }) {
  return new Promise(function (resolve) {
    setTimeout(function () {
      const s = document.createElement('i');
      s.className = 'conf-slow';
      anchor.appendChild(s);
      resolve(s);
    }, 800);
  });
}`,
  lateBoom: `function lateBoom({ anchor }) {
  setTimeout(function later() {
    throw new Error('conf-late-boom');
  }, 0);
  const s = document.createElement('span');
  s.className = 'conf-late';
  anchor.appendChild(s);
  return s;
}`,
  rejectLater: `function rejectLater() {
  setTimeout(() => {
    Promise.reject(new Error('conf-unhandled'));
  }, 0);
}`,
  warn: `function warn() {
  console.warn('conf-warn-message');
}`,
  broken: 'function broken( { return 1; }',
  // api.onAnchorChange: counts deliveries on the anchor, and on each one writes
  // a site-like (unowned) node into its own anchor synchronously — a write
  // that must never be reported back to it.
  watchList: `function watchList({ anchor, api }) {
  let n = 0;
  api.onAnchorChange(() => {
    n += 1;
    anchor.setAttribute('data-conf-changes', String(n));
    const old = anchor.querySelector('.conf-echo');
    if (old) old.remove();
    const echo = document.createElement('li');
    echo.className = 'conf-echo';
    anchor.appendChild(echo);
  });
  anchor.setAttribute('data-conf-changes', '0');
}`,
  watchListB: `function watchListB({ anchor, api }) {
  let n = 0;
  api.onAnchorChange(() => { n += 1; anchor.setAttribute('data-conf-changes-b', String(n)); });
}`,
  watchThrows: `function watchThrows({ anchor, api }) {
  api.onAnchorChange(() => { throw new Error('conf-change-boom'); });
  anchor.setAttribute('data-conf-watch-throws', 'ready');
}`,
  watchAsyncMount: `function watchAsyncMount({ anchor, api }) {
  let n = 0;
  api.onAnchorChange(() => { n += 1; anchor.setAttribute('data-conf-async-changes', String(n)); });
  anchor.setAttribute('data-conf-async', 'waiting');
  return new Promise((resolve) => setTimeout(() => { anchor.setAttribute('data-conf-async', 'landed'); resolve(); }, 700));
}`,
  // Returns a node it never inserts (the stackoverflow probe's bug): counts
  // its mounts and its api.onAnchorChange deliveries on the anchor.
  orphanSync: `function orphanSync({ anchor, api }) {
  anchor.setAttribute('data-conf-mounts', String(Number(anchor.getAttribute('data-conf-mounts') || '0') + 1));
  api.onAnchorChange(() => {
    anchor.setAttribute('data-conf-orphan-changes', String(Number(anchor.getAttribute('data-conf-orphan-changes') || '0') + 1));
  });
  const d = document.createElement('div');
  d.className = 'conf-orphan';
  return d;
}`,
  orphanAsync: `function orphanAsync({ anchor }) {
  anchor.setAttribute('data-conf-mounts', String(Number(anchor.getAttribute('data-conf-mounts') || '0') + 1));
  return new Promise((resolve) => setTimeout(() => {
    const d = document.createElement('div');
    d.className = 'conf-orphan';
    resolve(d);
  }, 50));
}`,
  // Inserts its root, which is removed (on the first mount only) before the
  // handler settles: a root that was on the page, so it must still self-heal.
  flashAsync: `function flashAsync({ anchor }) {
  const n = Number(anchor.getAttribute('data-conf-mounts') || '0') + 1;
  anchor.setAttribute('data-conf-mounts', String(n));
  const s = document.createElement('span');
  s.className = 'conf-flash';
  anchor.appendChild(s);
  if (n === 1) setTimeout(() => s.remove(), 20);
  return new Promise((resolve) => setTimeout(() => resolve(s), 150));
}`,
  flashSync: `function flashSync({ anchor }) {
  anchor.setAttribute('data-conf-mounts', String(Number(anchor.getAttribute('data-conf-mounts') || '0') + 1));
  const s = document.createElement('span');
  s.className = 'conf-flash';
  anchor.appendChild(s);
  return s;
}`,
  countedNote: `function countedNote({ anchor }) {
  anchor.setAttribute('data-conf-mounts', String(Number(anchor.getAttribute('data-conf-mounts') || '0') + 1));
  const s = document.createElement('span');
  s.className = 'conf-counted';
  anchor.appendChild(s);
  return s;
}`,
  strictNote: `function strictNote({ anchor }) {
  const s = document.createElement('span');
  s.className = 'conf-strict';
  s.textContent = ' compiled';
  anchor.appendChild(s);
  return s;
}`,
};

// --- the cases --------------------------------------------------------------

const applyCase: ConformanceCase = {
  id: 'apply',
  title: 'every supported kind and mount strategy applies',
  covers: ['hide', 'restyle', 'reorder', 'reshape', 'script', 'inject-element', 'inject-html', 'remove', 'replace-root',
    'mount:inline', 'mount:portal', 'mount:overlay', 'mount:shadow', 'witness:capture'],
  async run(kit) {
    if (!(await kit.load('/apply'))) return;
    const rules: Rule[] = [
      { id: 'hide-ad', anchor: css('#ad'), mutations: [{ kind: 'hide' }] },
      { id: 'restyle-lead', anchor: css('#lead'), mutations: [{ kind: 'restyle', properties: { color: 'rgb(255, 0, 0)' } }] },
      { id: 'reorder-a', anchor: css('#a'), mutations: [{ kind: 'reorder', position: 'last' }] },
      { id: 'reshape-grid', anchor: css('#grid'), mutations: [{ kind: 'reshape', layout: 'grid', columns: 2 }] },
      { id: 'note', anchor: css('#note-target'), mutations: [{ kind: 'script', handler: 'note' }], handlers: { note: H.note } },
      { id: 'inject-el', anchor: css('#inject-target'), mutations: [{ kind: 'inject-element', placement: 'append', element: { tag: 'span', attrs: { class: 'conf-injected' }, text: 'injected' } }] },
      { id: 'inject-html', anchor: css('#html-target'), mutations: [{ kind: 'inject-html', placement: 'append', html: '<em class="conf-html">static</em><script>window.__confRan = 1</script>' }] },
      { id: 'remove-it', anchor: css('#remove-me'), mutations: [{ kind: 'remove' }] },
      { id: 'replace', anchor: css('#root-target'), mutations: [{ kind: 'replace-root', handler: 'replacement' }], handlers: { replacement: H.replacement } },
      { id: 'portal', anchor: css('#portal-target'), mutations: [{ kind: 'script', handler: 'portalOut', mount: { strategy: 'portal' } }], handlers: { portalOut: H.portalOut } },
      { id: 'overlay', anchor: css('#overlay-target'), mutations: [{ kind: 'script', handler: 'overlayOut', mount: { strategy: 'overlay' } }], handlers: { overlayOut: H.overlayOut } },
      { id: 'shadow', anchor: css('#shadow-target'), mutations: [{ kind: 'script', handler: 'shadowOut', mount: { strategy: 'shadow' } }], handlers: { shadowOut: H.shadowOut } },
    ];
    for (const rule of rules) kit.apply(rule);

    const statuses = await kit.until(() => {
      const missing = rules.filter((r) => r.id !== 'remove-it' && !kit.events.some((e) => e.kind === 'rule-status' && e.specId === conformanceRuleKey(r.id) && typeof e.matched === 'number' && e.matched > 0));
      return missing.length === 0 ? true : null;
    });
    kit.check('every rule reported rule-status with a match', statuses === true,
      rules.filter((r) => !kit.events.some((e) => e.kind === 'rule-status' && e.specId === conformanceRuleKey(r.id))).map((r) => r.id));

    const state = await kit.until(async () => {
      const s = await kit.read(`(() => {
        const q = (sel) => document.querySelector(sel);
        const cs = (sel) => { const el = q(sel); return el ? getComputedStyle(el) : null; };
        const shadowHost = q('#shadow-target > [data-shim="shadow-host"]');
        const overlay = q('.conf-overlay');
        const overlayAnchor = q('#overlay-target');
        return {
          adDisplay: cs('#ad') && cs('#ad').display,
          leadColor: cs('#lead') && cs('#lead').color,
          aOrder: cs('#a') && cs('#a').order,
          gridDisplay: cs('#grid') && cs('#grid').display,
          note: q('#note-target > .conf-note') ? q('#note-target > .conf-note').textContent : null,
          injected: q('#inject-target > .conf-injected') ? q('#inject-target > .conf-injected').textContent : null,
          html: q('#html-target > .conf-html') ? q('#html-target > .conf-html').textContent : null,
          htmlScript: !!q('#html-target script') || window.__confRan === 1,
          removed: !q('#remove-me'),
          replacement: !!q('#root-target > .conf-replacement'),
          originalDisplay: cs('#root-target > .original') && cs('#root-target > .original').display,
          replacementDisplay: cs('#root-target > .conf-replacement') && cs('#root-target > .conf-replacement').display,
          portalInRoot: !!q('[data-shim="portal-root"] .conf-portal'),
          portalPosition: cs('.conf-portal') && cs('.conf-portal').position,
          overlayWidthDelta: overlay && overlayAnchor ? Math.abs(overlay.getBoundingClientRect().width - overlayAnchor.getBoundingClientRect().width) : null,
          shadowText: shadowHost && shadowHost.shadowRoot && shadowHost.shadowRoot.querySelector('.conf-shadow') ? shadowHost.shadowRoot.querySelector('.conf-shadow').textContent : null,
        };
      })()`);
      return isRecord(s) && s.note !== null && s.shadowText !== null && s.portalInRoot === true && s.replacement === true ? s : null;
    });
    const s: Record<string, unknown> = state ?? {};
    kit.check('hide: the ad is display:none', s.adDisplay === 'none', s.adDisplay);
    kit.check('restyle: the lead is red', s.leadColor === 'rgb(255, 0, 0)', s.leadColor);
    kit.check('reorder: #a is ordered last', s.aOrder === '9999', s.aOrder);
    kit.check('reshape: #grid is a grid', s.gridDisplay === 'grid', s.gridDisplay);
    kit.check('script (inline): the handler mounted its note', s.note === ' noted', s.note);
    kit.check('inject-element: the element was appended', s.injected === 'injected', s.injected);
    kit.check('inject-html: the static markup was appended', s.html === 'static', s.html);
    kit.check('inject-html: the script was stripped and never ran', s.htmlScript === false, s.htmlScript);
    kit.check('remove: the element is gone', s.removed === true, s.removed);
    kit.check('replace-root: the handler output is mounted and visible', s.replacement === true && s.replacementDisplay !== 'none', s);
    kit.check('replace-root: the original children are hidden', s.originalDisplay === 'none', s.originalDisplay);
    kit.check('mount portal: output parked in the portal root, fixed', s.portalInRoot === true && s.portalPosition === 'fixed', s);
    kit.check('mount overlay: output sized to its anchor', typeof s.overlayWidthDelta === 'number' && s.overlayWidthDelta < 2, s.overlayWidthDelta);
    kit.check('mount shadow: output inside an open shadow host on the anchor', s.shadowText === 'in the shadow', s.shadowText);

    const witness = await kit.event((e) => e.kind === 'rule-witness' && e.specId === conformanceRuleKey('note'));
    const w = isRecord(witness?.witness) ? witness.witness : null;
    kit.check('witness: a single-match rule captured a fingerprint', w !== null && w.tag === 'div' && isRecord(w.attrs) && w.attrs.id === 'note-target', witness);
    kit.check('witness: no component identity is captured on a page without a framework', w !== null && w.component === undefined, w);
    const box = kit.events.find((e) => e.kind === 'rule-status' && e.specId === conformanceRuleKey('note') && isRecord(e.box))?.box;
    kit.check('rule-status carries the first match\'s measured box', isRecord(box) && typeof box.w === 'number' && box.w > 0, box);
    const pathed = kit.events.find((e) => e.kind === 'rule-status' && e.specId === conformanceRuleKey('hide-ad'));
    kit.check('engine events carry the page path', pathed?.path === '/apply', pathed);
  },
};

const teardownCase: ConformanceCase = {
  id: 'teardown',
  title: 'removing a preview restores the page and runs api.cleanup',
  covers: ['teardown', 'api.cleanup', 'hide', 'restyle', 'inject-element', 'replace-root', 'mount:portal', 'mount:shadow'],
  async run(kit) {
    if (!(await kit.load('/apply'))) return;
    const rules: Rule[] = [
      { id: 'td-hide', anchor: css('#ad'), mutations: [{ kind: 'hide' }] },
      { id: 'td-restyle', anchor: css('#lead'), mutations: [{ kind: 'restyle', properties: { color: 'rgb(0, 128, 0)' } }] },
      { id: 'td-inject', anchor: css('#inject-target'), mutations: [{ kind: 'inject-element', placement: 'append', element: { tag: 'b', attrs: { class: 'conf-td-injected' }, text: 'x' } }] },
      { id: 'td-cleanup', anchor: css('#cleanup-target'), mutations: [{ kind: 'script', handler: 'withCleanup' }], handlers: { withCleanup: H.withCleanup } },
      { id: 'td-replace', anchor: css('#root-target'), mutations: [{ kind: 'replace-root', handler: 'replacement' }], handlers: { replacement: H.replacement } },
      { id: 'td-portal', anchor: css('#portal-target'), mutations: [{ kind: 'script', handler: 'portalOut', mount: { strategy: 'portal' } }], handlers: { portalOut: H.portalOut } },
      { id: 'td-shadow', anchor: css('#shadow-target'), mutations: [{ kind: 'script', handler: 'shadowOut', mount: { strategy: 'shadow' } }], handlers: { shadowOut: H.shadowOut } },
    ];
    const keys = rules.map((r) => kit.apply(r));
    const applied = await kit.until(async () => (await kit.read(`!!(document.querySelector('.conf-cleanup') && document.querySelector('.conf-td-injected')
      && document.querySelector('.conf-replacement') && document.querySelector('.conf-portal')
      && document.querySelector('#shadow-target > [data-shim="shadow-host"]')
      && getComputedStyle(document.querySelector('#ad')).display === 'none')`)) === true ? true : null);
    kit.check('all previews applied before teardown', applied === true);

    // Re-applying a key replaces its preview rather than stacking a second one.
    kit.apply(rules[3] as Rule);
    await kit.sleep(400);
    const cleanupCount = await kit.until(async () => {
      const n = await kit.read(`document.querySelectorAll('.conf-cleanup').length`);
      return n === 1 ? n : null;
    }, 3000);
    kit.check('re-applying a ruleKey replaces the preview (one output, not two)', cleanupCount === 1, cleanupCount);
    kit.check('replacing a preview ran the old mount\'s api.cleanup', (await kit.read(`document.documentElement.getAttribute('data-conf-cleaned')`)) === 'yes');
    await kit.read(`document.documentElement.removeAttribute('data-conf-cleaned')`);

    for (const key of keys) kit.remove(key);
    const restored = await kit.until(async () => {
      const s = await kit.read(`(() => ({
        adDisplay: getComputedStyle(document.querySelector('#ad')).display,
        leadColor: getComputedStyle(document.querySelector('#lead')).color,
        injected: document.querySelectorAll('.conf-td-injected').length,
        cleanupOutputs: document.querySelectorAll('.conf-cleanup').length,
        cleaned: document.documentElement.getAttribute('data-conf-cleaned'),
        replacement: document.querySelectorAll('.conf-replacement').length,
        originalDisplay: getComputedStyle(document.querySelector('#root-target > .original')).display,
        portal: document.querySelectorAll('.conf-portal').length,
        shadowHosts: document.querySelectorAll('[data-shim="shadow-host"]').length,
        stamped: Array.from(document.querySelectorAll('[data-shim-css], [data-shim-replace-root]')).map((e) => e.id || e.tagName),
      }))()`);
      return isRecord(s) && s.cleaned === 'yes' && s.portal === 0 && s.adDisplay !== 'none' ? s : null;
    });
    const s: Record<string, unknown> = restored ?? {};
    kit.check('hide undone', s.adDisplay === 'block', s.adDisplay);
    kit.check('restyle undone', s.leadColor === 'rgb(0, 0, 0)', s.leadColor);
    kit.check('injected element removed', s.injected === 0, s.injected);
    kit.check('script output removed', s.cleanupOutputs === 0, s.cleanupOutputs);
    kit.check('api.cleanup ran on teardown', s.cleaned === 'yes', s.cleaned);
    kit.check('replace-root output removed and the original shown again', s.replacement === 0 && s.originalDisplay !== 'none', s);
    kit.check('portal output removed', s.portal === 0, s.portal);
    kit.check('shadow host removed', s.shadowHosts === 0, s.shadowHosts);
    kit.check('no engine stamps left on site elements', Array.isArray(s.stamped) && s.stamped.length === 0, s.stamped);
  },
};

const rerenderCase: ConformanceCase = {
  id: 're-render',
  title: 'outputs survive the page re-rendering its own DOM',
  covers: ['self-healing', 'hide', 'script', 'mount:inline'],
  async run(kit) {
    if (!(await kit.load('/app'))) return;
    kit.apply({ id: 'rr-promo', anchor: css('#app .promo'), mutations: [{ kind: 'hide' }] });
    kit.apply({ id: 'rr-badge', anchor: css('#app .row .title'), mutations: [{ kind: 'script', handler: 'badge' }], handlers: { badge: H.badge } });

    const snapshot = `(() => ({
      badges: document.querySelectorAll('#app .row .title > .conf-badge').length,
      rows: document.querySelectorAll('#app .row').length,
      promo: document.querySelector('#app .promo') ? getComputedStyle(document.querySelector('#app .promo')).display : null,
    }))()`;
    const settled = (want: number) => kit.until(async () => {
      const s = await kit.read(snapshot);
      return isRecord(s) && s.badges === want && s.rows === want && s.promo === 'none' ? s : null;
    });
    kit.check('applied on the first render', (await settled(2)) !== null, await kit.read(snapshot));

    await kit.read('window.__fixture.rerender()');
    kit.check('re-mounted after the page replaced its DOM', (await settled(2)) !== null, await kit.read(snapshot));

    await kit.read(`window.__fixture.addRow('Three')`);
    kit.check('mounted on a row the page added later', (await settled(3)) !== null, await kit.read(snapshot));

    await kit.read(`document.querySelector('#app .conf-badge').remove()`);
    kit.check('self-healed an output removed from under its anchor', (await settled(3)) !== null, await kit.read(snapshot));
  },
};

const spaCase: ConformanceCase = {
  id: 'spa-navigation',
  title: 'previews follow client-side navigation without a reload',
  covers: ['spa-navigation', 'script', 'hide'],
  async run(kit) {
    if (!(await kit.load('/app'))) return;
    await kit.read(`window.__confToken = 'same-document'`);
    const aKey = kit.apply({ id: 'spa-a', anchor: css('.view-a .target'), mutations: [{ kind: 'script', handler: 'note' }], handlers: { note: H.note } });
    const bKey = kit.apply({ id: 'spa-b', anchor: css('.view-b .target'), mutations: [{ kind: 'hide' }] });
    const mounted = await kit.until(async () => (await kit.read(`!!document.querySelector('.view-a .target > .conf-note')`)) === true ? true : null);
    kit.check('mounted on the first view', mounted === true);

    await kit.read(`window.__fixture.navigate('/app/other')`);
    const onB = await kit.until(async () => (await kit.read(`(() => { const t = document.querySelector('.view-b .target'); return t ? getComputedStyle(t).display : null; })()`)) === 'none' ? true : null);
    kit.check('a rule for the second view applied after pushState', onB === true);
    kit.check('the host reports the new URL', kit.host.url().endsWith('/app/other'), kit.host.url());
    kit.check('no document load happened (same document)', (await kit.read('window.__confToken')) === 'same-document');
    const bStatus = await kit.event((e) => e.kind === 'rule-status' && e.specId === bKey && e.matched === 1);
    kit.check('rule-status for the second view carries the new path', bStatus?.path === '/app/other', bStatus);
    const aGone = await kit.event((e) => e.kind === 'rule-status' && e.specId === aKey && e.matched === 0);
    kit.check('the first view\'s rule reported zero matches after leaving it', aGone !== null);

    await kit.read(`window.__fixture.navigate('/app')`);
    const back = await kit.until(async () => (await kit.read(`!!document.querySelector('.view-a .target > .conf-note')`)) === true ? true : null);
    kit.check('re-mounted on returning to the first view', back === true);
  },
};

const storageCase: ConformanceCase = {
  id: 'storage',
  title: 'api.storage round-trips through the host',
  covers: ['api.storage', 'script'],
  async run(kit) {
    if (!(await kit.load('/apply'))) return;
    kit.apply({ id: 'storage', anchor: css('#storage-target'), mutations: [{ kind: 'script', handler: 'storageRoundTrip' }], handlers: { storageRoundTrip: H.storageRoundTrip } });
    const raw = await kit.until(async () => {
      const v = await kit.read(`document.querySelector('#storage-target').getAttribute('data-conf-storage')`);
      return typeof v === 'string' ? v : null;
    });
    let out: unknown;
    try { out = raw ? JSON.parse(raw) : null; } catch { out = raw; }
    const o: Record<string, unknown> = isRecord(out) ? out : {};
    const expected = { n: 1, s: 'two' };
    kit.check('set answers the value', describe(o.set) === describe(expected), o.set);
    kit.check('get reads it back', describe(o.got) === describe(expected), o.got);
    kit.check('list includes it', isRecord(o.list) && describe(o.list['conf-key']) === describe(expected), o.list);
    kit.check('delete answers true', o.deleted === true, o.deleted);
    kit.check('get after delete reads null', o.after === null, o.after);
  },
};

const throwingCase: ConformanceCase = {
  id: 'throwing-handler',
  title: 'handler errors are reported with stacks; the page keeps running',
  covers: ['handler-errors', 'console', 'script'],
  async run(kit) {
    if (!(await kit.load('/apply'))) return;
    const syncKey = kit.apply({ id: 'throw-sync', anchor: css('#note-target'), mutations: [{ kind: 'script', handler: 'boom' }], handlers: { boom: H.boom } });
    const lateKey = kit.apply({ id: 'throw-late', anchor: css('#inject-target'), mutations: [{ kind: 'script', handler: 'lateBoom' }], handlers: { lateBoom: H.lateBoom } });
    const rejectKey = kit.apply({ id: 'throw-reject', anchor: css('#html-target'), mutations: [{ kind: 'script', handler: 'rejectLater' }], handlers: { rejectLater: H.rejectLater } });
    const brokenKey = kit.apply({ id: 'throw-syntax', anchor: css('#portal-target'), mutations: [{ kind: 'script', handler: 'broken' }], handlers: { broken: H.broken } });
    kit.apply({ id: 'throw-warn', anchor: css('#overlay-target'), mutations: [{ kind: 'script', handler: 'warn' }], handlers: { warn: H.warn } });
    kit.apply({ id: 'throw-healthy', anchor: css('#shadow-target'), mutations: [{ kind: 'script', handler: 'note' }], handlers: { note: H.note } });

    const sync = await kit.event((e) => e.kind === 'handler-error' && e.specId === syncKey);
    const syncStack = typeof sync?.stack === 'string' ? sync.stack : '';
    kit.check('a synchronous throw reports handler-error', sync?.handlerName === 'boom' && sync.ruleId === 'throw-sync', sync);
    kit.check('…with the thrown message', sync?.message === 'conf-boom', sync?.message);
    kit.check('…and a stack at the handler\'s sourceURL, line 2', new RegExp(`shim://patches/${syncKey}/handlers/boom\\.js:2:\\d+`).test(syncStack), syncStack);

    const late = await kit.event((e) => e.kind === 'handler-error' && e.specId === lateKey);
    kit.check('a throw from a timer the handler set is attributed to it', late?.handlerName === 'lateBoom' && late.message === 'conf-late-boom', late);

    const rejected = await kit.event((e) => e.kind === 'handler-error' && e.specId === rejectKey);
    kit.check('an unhandled rejection from the handler is attributed to it', rejected?.handlerName === 'rejectLater' && rejected.message === 'conf-unhandled', rejected);

    const broken = await kit.event((e) => e.kind === 'handler-error' && e.specId === brokenKey);
    kit.check('a handler that fails to compile reports as an unknown handler', typeof broken?.message === 'string' && broken.message.includes('unknown handler "broken"'), broken);
    const compileLog = await kit.until(() => kit.console.find((m) => m.level === 'error' && m.message.includes('failed to compile inline handler "broken"')) ?? null, 3000);
    kit.check('…and the compile failure is logged to the console', compileLog !== null, kit.console.filter((m) => m.level === 'error').map((m) => m.message));

    const warned = await kit.until(() => kit.console.find((m) => m.level === 'warning' && m.message.includes('conf-warn-message')) ?? null, 3000);
    kit.check('a handler\'s console.warn reaches the console feed as a warning', warned !== null, kit.console.slice(0, 20));

    // Provenance: page script can log a handler URL, or run under a forged
    // `//# sourceURL=` naming one. Neither is the engine world, so neither
    // line may carry engineWorld (the only signal that tags a line [shim …]).
    const forgedUrl = `shim://patches/${syncKey}/handlers/boom.js`;
    // (Main-world script under the page's CSP can't run an inline <script>,
    // so the forged pragma rides a main-world evaluate: same world, same
    // reach as any page script with eval.)
    await kit.read(`console.warn('conf-forged-text ' + ${JSON.stringify(forgedUrl)})`);
    await kit.read(`console.warn('conf-forged-pragma')\n//# sourceURL=${forgedUrl}`);
    const forgedText = await kit.until(() => kit.console.find((m) => m.message.includes('conf-forged-text')) ?? null, 3000);
    const forgedPragma = await kit.until(() => kit.console.find((m) => m.message.includes('conf-forged-pragma')) ?? null, 3000);
    kit.check('a page line naming a handler URL in its text arrives, never as the engine world\'s',
      forgedText !== null && forgedText.engineWorld !== true, forgedText);
    kit.check('a page line under a forged handler sourceURL arrives with that source, never as the engine world\'s',
      forgedPragma !== null && forgedPragma.source === forgedUrl && forgedPragma.engineWorld !== true, forgedPragma);

    const healthy = await kit.until(async () => (await kit.read(`!!document.querySelector('#shadow-target > .conf-note')`)) === true ? true : null);
    kit.check('a healthy rule on the same page still mounted', healthy === true);
    kit.check('the page still runs its own code', (await kit.read('typeof window.__fixture.rerender')) === 'function');
  },
};

const deployCase: ConformanceCase = {
  id: 'deploy-recovery',
  title: 'anchors recover after a simulated deploy; nothing mis-attaches',
  covers: ['witness:capture', 'witness:verify', 'rebase:refresh', 'rebase:promote', 'rebase:recover', 'rebase:quarantine'],
  async run(kit) {
    kit.setDeploy(1);
    try {
      if (!(await kit.load('/deploy'))) return;
      // Build 1: let the host capture witnesses the way authoring does.
      const capture: Array<[string, string]> = [['w-buy', 'button.buy-v1'], ['w-legacy', 'a.legacy-link'], ['w-price', 'span.price']];
      for (const [id, sel] of capture) kit.apply({ id, anchor: css(sel), mutations: [{ kind: 'restyle', properties: {} }] });
      const witnesses: Record<string, Witness> = {};
      for (const [id] of capture) {
        const e = await kit.event((ev) => ev.kind === 'rule-witness' && ev.specId === conformanceRuleKey(id));
        if (isRecord(e?.witness)) witnesses[id] = e.witness as unknown as Witness;
        kit.remove(conformanceRuleKey(id));
      }
      kit.check('witnesses captured on build 1', Object.keys(witnesses).length === 3, Object.keys(witnesses));
      const [wBuy, wLegacy, wPrice] = [witnesses['w-buy'], witnesses['w-legacy'], witnesses['w-price']];
      if (!wBuy || !wLegacy || !wPrice) return;

      const b1 = fixtureDeployId(kit.origin, 1);
      const b2 = fixtureDeployId(kit.origin, 2);
      if (!b1 || !b2) {
        kit.check('fixture deploy ids computed', false, { b1, b2 });
        return;
      }

      // Build 2: the site deploys.
      kit.setDeploy(2);
      if (!(await kit.load('/deploy'))) return;
      const refresh = kit.apply({ id: 'refresh', anchor: css('#stable'), mutations: [{ kind: 'restyle', properties: { outline: '1px solid red' } }] }, { bundleHash: b1 });
      const promote = kit.apply({
        id: 'promote',
        anchor: { primary: { kind: 'css', value: 'button.buy-v1' }, fallbacks: [{ kind: 'css', value: 'button[data-sku="42"]' }] },
        mutations: [{ kind: 'restyle', properties: { outline: '2px solid blue' } }],
      }, { bundleHash: b1 });
      const recover = kit.apply({ id: 'recover', anchor: { primary: { kind: 'css', value: 'button.buy-v1' }, witness: wBuy }, mutations: [{ kind: 'hide' }] }, { bundleHash: b1 });
      const gone = kit.apply({ id: 'gone', anchor: { primary: { kind: 'css', value: 'a.legacy-link' }, witness: wLegacy }, mutations: [{ kind: 'hide' }] }, { bundleHash: b1 });
      const wrong = kit.apply({ id: 'wrong', anchor: { primary: { kind: 'css', value: '.price' }, witness: wPrice }, mutations: [{ kind: 'hide' }] }, { bundleHash: b1 });
      // Same dead anchor, but the baseline IS the current build: no deploy,
      // so no rebase — a transient no-match.
      const steady = kit.apply({ id: 'steady', anchor: { primary: { kind: 'css', value: 'button.buy-v1' }, witness: wBuy }, mutations: [{ kind: 'hide' }] }, { bundleHash: b2 });
      // The same deploy for a shim that opted out of auto-repair: the
      // baseline still refreshes, but no anchor is re-pointed. A dead primary
      // with a working fallback keeps applying through the fallback; a dead
      // witnessed primary quarantines instead of recovering.
      const offRefresh = kit.apply({ id: 'off-refresh', anchor: css('#stable'), mutations: [{ kind: 'restyle', properties: { scrollMarginRight: '2.5px' } }] }, { bundleHash: b1, autoRepair: false });
      const offPromote = kit.apply({
        id: 'off-promote',
        anchor: { primary: { kind: 'css', value: 'button.buy-v1' }, fallbacks: [{ kind: 'css', value: 'button[data-sku="42"]' }] },
        mutations: [{ kind: 'restyle', properties: { scrollMarginLeft: '3.5px' } }],
      }, { bundleHash: b1, autoRepair: false });
      const offRecover = kit.apply({ id: 'off-recover', anchor: { primary: { kind: 'css', value: 'button.buy-v1' }, witness: wBuy }, mutations: [{ kind: 'hide' }] }, { bundleHash: b1, autoRepair: false });

      const refreshed = await kit.event((e) => e.kind === 'spec-bundle-update' && e.specId === refresh, 8000);
      kit.check('rebase 1 (refresh): a rule still resolving reports the new baseline', refreshed?.bundleHash === b2, { refreshed, b2 });

      const promoted = await kit.event((e) => e.kind === 'rule-rebase' && e.specId === promote, 8000);
      const pAnchor = isRecord(promoted?.anchor) ? promoted.anchor : {};
      kit.check('rebase 2 (promote): the working fallback becomes the primary', promoted?.strategy === 'promote'
        && isRecord(pAnchor.primary) && pAnchor.primary.value === 'button[data-sku="42"]', promoted);

      const recovered = await kit.event((e) => e.kind === 'rule-rebase' && e.specId === recover, 8000);
      kit.check('rebase 3 (recover): the witness re-finds the renamed element', recovered?.strategy === 'recover' && recovered.via === 'witness', recovered);
      // The recovered anchor must be one the engine can resolve, and the rule
      // carrying it must land on the renamed button alone. The engine only
      // reports the rebase (the host commits it), so the case applies the
      // rebased rule as a host would on the new build: its hide, plus a
      // marker restyle no other rule sets so the resolved set can be counted.
      // Resolution is the engine's own, so every anchor kind is judged by
      // core's resolver on every host.
      const rRecord = isRecord(recovered?.anchor) ? recovered.anchor : null;
      const rPrimary = rRecord && isRecord(rRecord.primary) ? rRecord.primary : null;
      const rAnchor = rRecord && rPrimary && typeof rPrimary.kind === 'string' && ANCHOR_KINDS.has(rPrimary.kind)
        ? rRecord as unknown as Rule['anchor'] : null;
      kit.check('…with a recovered primary anchor of a supported kind', rAnchor !== null, recovered?.anchor);
      if (rAnchor) {
        const rebased = kit.apply({ id: 'recover-rebased', anchor: rAnchor, mutations: [{ kind: 'hide' }, { kind: 'restyle', properties: { scrollMarginTop: '7.5px' } }] }, { bundleHash: b2 });
        const status = await kit.event((e) => e.kind === 'rule-status' && e.specId === rebased && typeof e.matched === 'number' && e.matched > 0, 8000);
        const marked = await kit.until(async () => {
          const r = await kit.read(`(() => {
            const els = Array.from(document.querySelectorAll('body *')).filter((e) => getComputedStyle(e).scrollMarginTop === '7.5px');
            return els.length ? { count: els.length, buy: els.length === 1 && els[0].matches('button.buy-v2') } : null;
          })()`);
          return isRecord(r) ? r : null;
        }, 8000);
        kit.check('…and the recovered anchor resolves to that element only', status?.matched === 1 && marked?.count === 1 && marked.buy === true,
          { rAnchor, matched: status?.matched, marked });
        const display = await kit.read(`(() => { const b = document.querySelector('button.buy-v2'); return b ? getComputedStyle(b).display : null; })()`);
        kit.check('…and the rebased rule\'s hide applies (the buy button is hidden)', display === 'none', display);
        kit.check('…without quarantining', !kit.events.some((e) => e.kind === 'rule-quarantined' && e.specId === rebased));
        kit.remove(rebased);
      }

      const quarantined = await kit.event((e) => e.kind === 'rule-quarantined' && e.specId === gone, 10000);
      kit.check('rebase 4 (quarantine): an element gone beyond recognition quarantines', quarantined !== null, quarantined);

      const rejected = await kit.event((e) => e.kind === 'rule-quarantined' && e.specId === wrong, 10000);
      kit.check('witness verify: a selector resolving to a different element quarantines', rejected !== null
        && Array.isArray(rejected.seen) && rejected.seen.length > 0, rejected);
      const priceDisplay = await kit.read(`getComputedStyle(document.querySelector('.price')).display`);
      kit.check('…and never mis-attaches (the impostor is not hidden)', priceDisplay !== 'none', priceDisplay);

      const steadyMiss = await kit.event((e) => e.kind === 'rule-no-match' && e.specId === steady, 8000);
      kit.check('without a deploy, a dead anchor is a transient no-match', steadyMiss !== null);
      kit.check('…and is never rebased', !kit.events.some((e) => (e.kind === 'rule-rebase' || e.kind === 'rule-quarantined') && e.specId === steady));

      const offRefreshed = await kit.event((e) => e.kind === 'spec-bundle-update' && e.specId === offRefresh, 8000);
      kit.check('auto-repair off: a rule still resolving still reports the new baseline', offRefreshed?.bundleHash === b2, offRefreshed);
      const offQuarantined = await kit.event((e) => e.kind === 'rule-quarantined' && e.specId === offRecover, 10000);
      kit.check('auto-repair off: a dead witnessed primary quarantines', offQuarantined !== null, offQuarantined);
      const offStatus = await kit.event((e) => e.kind === 'rule-status' && e.specId === offPromote && typeof e.matched === 'number' && e.matched > 0, 8000);
      const offMargin = await kit.read(`(() => { const b = document.querySelector('button[data-sku="42"]'); return b ? getComputedStyle(b).scrollMarginLeft : null; })()`);
      kit.check('auto-repair off: a dead primary still applies through its working fallback', offStatus !== null && offMargin === '3.5px', { offStatus, offMargin });
      const offRebases = kit.events.filter((e) => e.kind === 'rule-rebase' && (e.specId === offPromote || e.specId === offRecover || e.specId === offRefresh));
      kit.check('auto-repair off: nothing is promoted or recovered (no rule-rebase)', offRebases.length === 0, offRebases);
    } finally {
      kit.setDeploy(1);
    }
  },
};

const pageToolsCase: ConformanceCase = {
  id: 'page-tools',
  title: 'view_page and evaluate_in_page answer the same on every host',
  covers: ['page-tools'],
  async run(kit) {
    if (!(await kit.load('/apply'))) return;
    const full = await viewPageOnHost(kit.host, undefined, 'main');
    kit.check('view_page: a PNG of the viewport', full.error === undefined && full.mediaType === 'image/png'
      && typeof full.dataBase64 === 'string' && full.dataBase64.length > 100, { ...full, dataBase64: full.dataBase64?.length });
    kit.check(`view_page: no wider than ${MAX_SHOT_WIDTH}px`, typeof full.width === 'number' && full.width > 0 && full.width <= MAX_SHOT_WIDTH, full.width);
    kit.check('view_page: reports the page URL', full.url === `${kit.origin}/apply`, full.url);
    const crop = await viewPageOnHost(kit.host, { selector: '#lead' }, 'main');
    kit.check('view_page with a selector: a crop around the element', crop.error === undefined && crop.croppedTo === '#lead'
      && isRecord(crop.elementBox) && crop.elementBox.w > 0, { ...crop, dataBase64: crop.dataBase64?.length });
    const missing = await viewPageOnHost(kit.host, { selector: '#no-such-element' }, 'main');
    kit.check('view_page with a dead selector: an error, not a throw', typeof missing.error === 'string' && missing.error.includes('matched nothing'), missing.error);

    const title = await evaluateOnHost(kit.host, 'document.title', 3000, 'main');
    kit.check('evaluate (main world) reads the page', 'result' in title && title.result === '"apply"', title);
    const isolated = await evaluateOnHost(kit.host, 'typeof window.__fixture', 3000, 'engine');
    kit.check('evaluate (engine world) shares the DOM but not the page\'s globals', 'result' in isolated && isolated.result === '"undefined"', isolated);
    const domFromEngine = await evaluateOnHost(kit.host, `document.querySelector('#lead').textContent`, 3000, 'engine');
    kit.check('evaluate (engine world) reads the DOM', 'result' in domFromEngine && domFromEngine.result === '"lead paragraph"', domFromEngine);
    const thrown = await evaluateOnHost(kit.host, `(() => { throw new Error('conf-eval'); })()`, 3000, 'main');
    kit.check('evaluate: a throw comes back as an error value', 'error' in thrown && thrown.error.includes('conf-eval'), thrown);
    const body = await evaluateOnHost(kit.host, `const el = document.querySelector('#lead');\nconst t = await Promise.resolve(el.textContent);\nreturn t.toUpperCase();`, 3000, 'main');
    kit.check('evaluate: a statement body runs and returns its value', 'result' in body && body.result === '"LEAD PARAGRAPH"', body);
    const engineBody = await evaluateOnHost(kit.host, `const n = document.querySelectorAll('#list li').length; return n`, 3000, 'engine');
    kit.check('evaluate (engine world): a statement body runs too', 'result' in engineBody && engineBody.result === '3', engineBody);
    await kit.read('window.__confEvalRuns = 0');
    await evaluateOnHost(kit.host, 'window.__confEvalRuns += 1', 3000, 'main');
    await evaluateOnHost(kit.host, 'window.__confEvalRuns += 1; return 1', 3000, 'main');
    const runs = await kit.read('window.__confEvalRuns');
    kit.check('evaluate: choosing the form never runs the input twice', runs === 2, runs);
    const broken = await evaluateOnHost(kit.host, 'const = ;', 3000, 'main');
    kit.check('evaluate: input that is neither an expression nor a body is an error value', 'error' in broken && broken.error.length > 0, broken);
  },
};

const cropScrollCase: ConformanceCase = {
  id: 'view-crop-scroll',
  title: 'a view_page crop of an element the viewport cuts off captures all of it and leaves the scroll where it was',
  covers: ['page-tools'],
  async run(kit) {
    if (!(await kit.load('/fold'))) return;
    const dpr = await kit.read('window.devicePixelRatio');
    const ratio = typeof dpr === 'number' && dpr > 0 ? dpr : 1;
    const geometry = await kit.read(`(() => {
      const r = document.querySelector('#fold-target').getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
    })()`);
    kit.check('the fixture: the viewport cuts #fold-target off', isRecord(geometry) && typeof geometry.top === 'number'
      && typeof geometry.vh === 'number' && typeof geometry.bottom === 'number' && geometry.top < geometry.vh && geometry.bottom > geometry.vh, geometry);
    const scrollState = (): Promise<unknown> => kit.read(`[window.scrollX, window.scrollY, document.querySelector('#fold-pane').scrollTop].join(',')`);
    await kit.read(`(window.scrollTo({ left: 0, top: 7, behavior: 'instant' }), document.querySelector('#fold-pane').scrollTop = 5, 0)`);
    const before = await scrollState();

    // A host that, at every capture, asks the page which of the fold
    // targets the clip shows: its center inside the clip, and the topmost
    // element there (so not hidden under its pane's fold).
    const targets = ['#fold-target', '#fold-far', '#fold-pane-target'];
    const exposed: string[][] = [];
    let captures = 0;
    const watched: PageHost = Object.assign(Object.create(kit.host) as PageHost, {
      async screenshot(opts?: Parameters<PageHost['screenshot']>[0]) {
        captures++;
        const clip = opts?.clip;
        if (clip) {
          const seen = await kit.read(`${JSON.stringify(targets)}.filter((sel) => {
            const el = document.querySelector(sel);
            const r = el.getBoundingClientRect();
            const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
            const c = ${JSON.stringify(clip)};
            if (cx < c.x || cx > c.x + c.width || cy < c.y || cy > c.y + c.height) return false;
            const hit = document.elementFromPoint(cx, cy);
            return !!hit && el.contains(hit);
          })`);
          exposed.push(Array.isArray(seen) ? seen.filter((x): x is string => typeof x === 'string') : []);
        }
        return kit.host.screenshot(opts);
      },
    });
    const shown = (sel: string): boolean => exposed.some((list) => list.includes(sel));

    // The crop holds the whole element: its height in CSS px is at least the
    // element's (the margin is the rest).
    const fullyCaptured = (shot: { error?: string; height?: number; elementBox?: { w: number; h: number } }): boolean =>
      shot.error === undefined && typeof shot.height === 'number' && isRecord(shot.elementBox)
      && shot.elementBox.h > 0 && shot.height / ratio >= shot.elementBox.h;
    const strip = (shot: { dataBase64?: string }): unknown => ({ ...shot, dataBase64: shot.dataBase64?.length });

    const partly = await viewPageOnHost(watched, { selector: '#fold-target' }, 'main');
    kit.check('view_page crop of an element partly below the fold: all of it, in view', fullyCaptured(partly) && shown('#fold-target'), { shot: strip(partly), exposed });
    kit.check('…and the page\'s scroll is put back', (await scrollState()) === before, { before, after: await scrollState() });

    exposed.length = 0;
    const far = await viewPageOnHost(watched, { selector: '#fold-far' }, 'engine');
    kit.check('view_page crop of an element scrolled out entirely: a capture of it, not an error', fullyCaptured(far) && shown('#fold-far'), { shot: strip(far), exposed });
    kit.check('…and the page\'s scroll is put back', (await scrollState()) === before, { before, after: await scrollState() });

    exposed.length = 0;
    const pane = await viewPageOnHost(watched, { selector: '#fold-pane-target' }, 'main');
    kit.check('view_page crop of an element below its pane\'s fold: the pane is scrolled to show it', fullyCaptured(pane) && shown('#fold-pane-target'), { shot: strip(pane), exposed });
    kit.check('…and the pane\'s scroll is put back too', (await scrollState()) === before, { before, after: await scrollState() });

    const visible = await viewPageOnHost(kit.host, { selector: '#fold-pane' }, 'main');
    kit.check('view_page crop of a fully visible element still works', visible.error === undefined && visible.croppedTo === '#fold-pane', strip(visible));
    kit.check('…and never scrolls', (await scrollState()) === before, { before, after: await scrollState() });

    // A holder that died mid-crop left an expired lease with the scroll it
    // saved: the next view_page puts that scroll back before taking over.
    await kit.read(`(() => {
      const s = document.scrollingElement;
      const saved = [[s, s.scrollLeft, s.scrollTop]];
      s.scrollTo({ left: 0, top: 600, behavior: 'instant' });
      globalThis[Symbol.for('shim.viewPage.lease')] = { token: 'dead', expires: Date.now() - 1, saved };
      return true;
    })()`);
    const afterDead = await viewPageOnHost(kit.host, { selector: '#fold-target' }, 'main');
    kit.check('an expired lease\'s scroll is put back by the next view_page', afterDead.error === undefined && (await scrollState()) === before, { before, after: await scrollState() });

    // A view_page that can't get the lease inside its wait answers busy: no
    // capture without the lease, and its page-side wait never takes the
    // lease after it gave up.
    await kit.read(`(globalThis[Symbol.for('shim.viewPage.lease')] = { token: 'held', expires: Date.now() + 5000, saved: [] }, true)`);
    const capturesBefore = captures;
    const busyFull = await viewPageOnHost(watched, undefined, 'main', { leaseWaitMs: 200 });
    const busyCrop = await viewPageOnHost(watched, { selector: '#fold-far' }, 'main', { leaseWaitMs: 200 });
    await kit.sleep(400);
    const holder = await kit.read(`(globalThis[Symbol.for('shim.viewPage.lease')] || {}).token`);
    await kit.read(`(delete globalThis[Symbol.for('shim.viewPage.lease')], true)`);
    kit.check('a view_page that can\'t get the lease answers busy, with no capture', typeof busyFull.error === 'string' && typeof busyCrop.error === 'string'
      && /too long/.test(busyFull.error) && /too long/.test(busyCrop.error) && captures === capturesBefore, { busyFull: busyFull.error, busyCrop: busyCrop.error, captures: captures - capturesBefore });
    kit.check('…and never takes the lease after it gave up', holder === 'held', holder);
    kit.check('…and leaves the scroll alone', (await scrollState()) === before, { before, after: await scrollState() });

    // Overlapping calls (parallel tool calls, parallel workers): each crop
    // still captures its own target, and the page ends where it started.
    exposed.length = 0;
    const [c1, c2, c3, whole] = await Promise.all([
      viewPageOnHost(watched, { selector: '#fold-target' }, 'main'),
      viewPageOnHost(watched, { selector: '#fold-far' }, 'main'),
      viewPageOnHost(watched, { selector: '#fold-pane-target' }, 'main'),
      viewPageOnHost(watched, undefined, 'main'),
    ]);
    kit.check('overlapping crops each capture their own target', [c1, c2, c3].every(fullyCaptured)
      && exposed.length === 3 && exposed.every((list) => list.length === 1) && targets.every(shown), { exposed });
    kit.check('…beside an overlapping full-viewport shot', whole.error === undefined && whole.croppedTo === undefined, strip(whole));
    kit.check('…and the page and pane scroll end where they started', (await scrollState()) === before, { before, after: await scrollState() });
  },
};

const strictCspCase: ConformanceCase = {
  id: 'strict-csp',
  title: 'handlers compile and run on a page whose CSP forbids eval and inline style',
  // `strict-csp` vouches for handler compile and mount under the policy, and
  // for tier-1 CSS landing under it on every host.
  covers: ['strict-csp', 'script'],
  async run(kit) {
    if (!(await kit.load('/strict'))) return;
    const probe = await kit.read(`document.documentElement.getAttribute('data-eval-probe')`);
    kit.check('the page\'s own eval is refused (script-src is live)', probe === 'EvalError', probe);
    const inlineStyle = await kit.read(`getComputedStyle(document.querySelector('#strict-ad')).color`);
    kit.check('the page\'s own inline <style> is refused (style-src is live)', inlineStyle !== 'rgb(1, 2, 3)', inlineStyle);
    kit.apply({ id: 'strict-note', anchor: css('#strict-target'), mutations: [{ kind: 'script', handler: 'strictNote' }], handlers: { strictNote: H.strictNote } });
    const mounted = await kit.until(async () => (await kit.read(`!!document.querySelector('#strict-target > .conf-strict')`)) === true ? true : null);
    kit.check('a script handler compiled from source and mounted', mounted === true);
    kit.apply({ id: 'strict-hide', anchor: css('#strict-ad'), mutations: [{ kind: 'hide' }] });
    const matched = await kit.event((e) => e.kind === 'rule-status' && e.specId === conformanceRuleKey('strict-hide') && e.matched === 1);
    kit.check('a tier-1 rule resolved its anchor', matched !== null);
    await kit.sleep(300);
    // The engine's tier-1 <style> element is refused by a style-src without
    // 'unsafe-inline' (even inserted from an isolated world), and the style
    // mirror (style-mirror.ts) re-adopts its text as a constructable sheet,
    // which style-src doesn't govern: the rule's CSS lands on every host.
    const display = await kit.read(`getComputedStyle(document.querySelector('#strict-ad')).display`);
    kit.check('tier-1 CSS under a strict style-src lands on every host (the style mirror)', display === 'none', display);
  },
};

// A stored module two rules name (an imported shim's, hydrated to its wrapper
// form): one instance per shim in the document, as a committed shim boots —
// its top-level code runs once and its state is shared.
const SHARED_MODULE = 'document.documentElement.setAttribute("data-conf-inits", String(Number(document.documentElement.getAttribute("data-conf-inits") || 0) + 1));\n'
  + 'let count = 0;\n'
  + 'module.exports = function counted({ anchor }) { anchor.setAttribute("data-conf-count", String(++count)); };\n';

const SHARED_IIFE_MODULE = 'module.exports = (() => { let tally = 0; return function tallied({ anchor }) { anchor.setAttribute("data-conf-tally", String(++tally)); }; })();\n';

const sharedModuleCase: ConformanceCase = {
  id: 'shared-module',
  title: 'rules naming one stored module share one instance of it',
  covers: ['script'],
  async run(kit) {
    if (!(await kit.load('/apply'))) return;
    const counted = moduleToExpression(SHARED_MODULE, 'isolated');
    kit.apply({ id: 'shared-a', anchor: css('#lead'), mutations: [{ kind: 'script', handler: 'counted' }], handlers: { counted } });
    kit.apply({ id: 'shared-b', anchor: css('#a'), mutations: [{ kind: 'script', handler: 'counted' }], handlers: { counted } });
    const state = await kit.until(async () => {
      const s = await kit.read(`({ lead: document.querySelector('#lead').getAttribute('data-conf-count'), a: document.querySelector('#a').getAttribute('data-conf-count'), inits: document.documentElement.getAttribute('data-conf-inits') })`);
      return isRecord(s) && s.lead !== null && s.a !== null ? s : null;
    });
    const s: Record<string, unknown> = state ?? {};
    kit.check('the two rules count on one shared counter (1 and 2)', [s.lead, s.a].sort().join(',') === '1,2', s);
    kit.check('the module\'s top-level code ran once', s.inits === '1', s.inits);

    // The same module as one `module.exports = (IIFE)()` assignment converts
    // to the bare IIFE, not a wrapper; it is still one instance.
    const iife = moduleToExpression(SHARED_IIFE_MODULE, 'isolated');
    kit.apply({ id: 'shared-c', anchor: css('#grid'), mutations: [{ kind: 'script', handler: 'tallied' }], handlers: { tallied: iife } });
    kit.apply({ id: 'shared-d', anchor: css('#ad'), mutations: [{ kind: 'script', handler: 'tallied' }], handlers: { tallied: iife } });
    const bare = await kit.until(async () => {
      const b = await kit.read(`({ grid: document.querySelector('#grid').getAttribute('data-conf-tally'), ad: document.querySelector('#ad').getAttribute('data-conf-tally') })`);
      return isRecord(b) && b.grid !== null && b.ad !== null ? b : null;
    });
    const b: Record<string, unknown> = bare ?? {};
    kit.check('a single-assignment IIFE module is one instance too (1 and 2)', iife.startsWith('(() =>') && [b.grid, b.ad].sort().join(',') === '1,2', b);
  },
};

// Both hosts collect a preview's evidence 2 s after applying it. The engine's
// own rule-no-match runs on a page timer 1.5 s after setup, which a page in a
// background window fires late, so the evidence must not hang on it: a dead
// anchor's status (matched 0) arrives as the rule is set up, and noMatch[] is
// read from it.
const PREVIEW_SETTLE_MS = 2000;

const noMatchCase: ConformanceCase = {
  id: 'dead-anchor',
  title: 'a dead anchor reaches the preview evidence within the settle window',
  covers: ['no-match'],
  async run(kit) {
    if (!(await kit.load('/apply'))) return;
    const dead = { id: 'dead', anchor: css('#conf-does-not-exist'), mutations: [{ kind: 'hide' }] } satisfies Rule;
    const live = { id: 'live', anchor: css('#ad'), mutations: [{ kind: 'hide' }] } satisfies Rule;
    const deadKey = kit.apply(dead);
    const liveKey = kit.apply(live);
    await kit.sleep(PREVIEW_SETTLE_MS);
    const seen = kit.events.slice();
    const last = (key: string): RuleStatusEvent | undefined => {
      const all = seen.filter((e) => e.kind === 'rule-status' && e.specId === key);
      return all.at(-1) as RuleStatusEvent | undefined;
    };
    const previewed = [{ rule: dead, status: last(deadKey), peakMatched: 0 }, { rule: live, status: last(liveKey), peakMatched: 1 }];
    kit.check('the dead rule\'s status (matched 0) arrived within the window', last(deadKey)?.matched === 0, last(deadKey));
    kit.check('the live rule\'s status shows its match', last(liveKey)?.matched === 1, last(liveKey));

    const ids = (list: NoMatchEntry[]): string => list.map((n) => `${n.ruleId}:${n.selector}`).join(',');
    const fromStatus = previewNoMatch([], previewed);
    kit.check('noMatch lists the dead rule even with no rule-no-match event yet', ids(fromStatus) === 'dead:#conf-does-not-exist', fromStatus);
    const reported = seen
      .filter((e) => e.kind === 'rule-no-match' && (e.specId === deadKey || e.specId === liveKey))
      .map((e) => ({ ruleId: e.ruleId, selector: typeof e.selector === 'string' ? e.selector : undefined }));
    const both = previewNoMatch(reported, previewed);
    kit.check('…and once when the engine\'s event did arrive', ids(both) === 'dead:#conf-does-not-exist', { reported, both });
    kit.check('a dead rule\'s verification is none, not full',
      verificationLevel(undefined, kit.host.capabilities, false, true) === 'none'
      && verificationLevel(undefined, kit.host.capabilities, false, false) !== 'none');

    const late = await kit.event((e) => e.kind === 'rule-no-match' && e.specId === deadKey, 8000);
    kit.check('the engine still reports the dead anchor itself', late?.ruleId === 'dead', late);
    kit.check('…and never the live one', !kit.events.some((e) => e.kind === 'rule-no-match' && e.specId === liveKey));

    // A preview replaced while its handler is still mounting: the old
    // version's mount must not land, nor report a match under the key the
    // replacement (a dead anchor) now owns.
    const slowRule = { id: 'slow', anchor: css('#lead'), mutations: [{ kind: 'script', handler: 'slowMount' }], handlers: { slowMount: H.slowMount } } satisfies Rule;
    const slowKey = kit.apply(slowRule);
    await kit.sleep(100);
    const replacedAt = kit.events.length;
    kit.apply({ ...slowRule, anchor: css('#conf-also-missing') });
    await kit.sleep(PREVIEW_SETTLE_MS);
    const after = kit.events.slice(replacedAt).filter((e) => e.kind === 'rule-status' && e.specId === slowKey);
    kit.check('a replaced version\'s late mount reports no match under the replacement\'s key',
      after.length > 0 && after.every((e) => e.matched === 0), after);
    kit.check('…and leaves nothing on the page', (await kit.read(`document.querySelectorAll('.conf-slow').length`)) === 0);
    kit.remove(slowKey);
  },
};

// A load another navigation supersedes before it finishes (Chromium aborts
// it, ERR_ABORTED) is not a failed load: the wait follows the navigation that
// took over, as a redirect is followed — what an installed shim's
// `location.replace` during the load looks like to a navigate. A load that
// genuinely fails still ends the wait as failed.
const supersededLoadCase: ConformanceCase = {
  id: 'superseded-load',
  title: 'a superseded load is followed to where the page lands; a real failure still fails',
  covers: ['superseded-load'],
  async run(kit) {
    if (!(await kit.load('/apply'))) return;
    const wait = kit.host.waitForLoad({ timeoutMs: 15000 });
    kit.host.reload(`${kit.origin}/apply?first=1`);
    kit.host.reload(`${kit.origin}/apply?second=1`);
    const outcome = await wait;
    kit.check('the wait reports the superseding load as finished', outcome.kind === 'finished', outcome);
    kit.check('…and the page is where that load went', kit.host.url().endsWith('/apply?second=1'), kit.host.url());

    // Nothing listens on port 1: the connection is refused.
    const failing = kit.host.waitForLoad({ timeoutMs: 15000 });
    kit.host.reload('http://127.0.0.1:1/');
    const failed = await failing;
    kit.check('a load that cannot connect still ends the wait as failed', failed.kind === 'failed' && failed.code !== -3, failed);
  },
};

// Set witnesses: a multi-match rule's preview captures what every row shares
// (re-emitted as rows are added, withdrawn for mixed tags), and a rule
// carrying it applies only to members, never to a same-selector impostor.
const setWitnessCase: ConformanceCase = {
  id: 'set-witness',
  title: 'a multi-match rule captures a set witness and vetoes non-members',
  covers: ['witness:set'],
  async run(kit) {
    if (!(await kit.load('/list'))) return;
    const rowsKey = kit.apply({ id: 'rows', anchor: css('#rows > li.row'), mutations: [{ kind: 'restyle', properties: { scrollMarginTop: '1.5px' } }] });
    const first = await kit.event((e) => e.kind === 'rule-witness' && e.specId === rowsKey && isRecord(e.setWitness));
    const sw = isRecord(first?.setWitness) ? first.setWitness : null;
    kit.check('three rows at once → a set witness (no element witness)', sw !== null && sw.tag === 'li' && sw.count === 3 && first?.witness === null, first);
    kit.check('…carrying the rows\' constant data-* and their identity predicate', isRecord(sw?.attrs) && sw.attrs['data-kind'] === 'row'
      && sw.identity === 'li[data-kind="row"]', sw);
    kit.check('…bound to its document, anchor and revision', typeof first?.documentId === 'string' && typeof first?.anchorDigest === 'string' && typeof first?.rev === 'number', first);
    await kit.read(`(() => { const li = document.createElement('li'); li.className = 'row'; li.setAttribute('data-kind', 'row'); li.innerHTML = '<span class="t">Row four</span><b>4</b>'; document.querySelector('#rows').append(li); return true; })()`);
    const grown = await kit.event((e) => e.kind === 'rule-witness' && e.specId === rowsKey && isRecord(e.setWitness) && e.setWitness.count === 4);
    kit.check('a row added later re-emits the aggregate at a higher revision', !!grown && typeof grown.rev === 'number' && typeof first?.rev === 'number' && grown.rev > first.rev, grown);

    const mixedKey = kit.apply({ id: 'mixed', anchor: css('#mixed .mix'), mutations: [{ kind: 'restyle', properties: {} }] });
    const mixed = await kit.event((e) => e.kind === 'rule-witness' && e.specId === mixedKey);
    kit.check('mixed tags → no fingerprint, with the reason', mixed?.witness === null && mixed?.setWitness === null && mixed?.captureNote === 'mixed-tags', mixed);

    if (!sw) return;
    const vetoKey = kit.apply({ id: 'veto', anchor: { primary: { kind: 'css', value: 'li.row' }, setWitness: sw as unknown as SetWitness }, mutations: [{ kind: 'restyle', properties: { scrollMarginLeft: '2.5px' } }] });
    const marked = await kit.until(async () => {
      const r = await kit.read(`(() => {
        const rows = Array.from(document.querySelectorAll('#rows > li.row')).filter((e) => getComputedStyle(e).scrollMarginLeft === '2.5px').length;
        const impostor = getComputedStyle(document.querySelector('#other > li')).scrollMarginLeft;
        return rows >= 4 ? { rows, impostor } : null;
      })()`);
      return isRecord(r) ? r : null;
    }, 8000);
    kit.check('a set-witnessed rule applies to every member', marked?.rows === 4, marked);
    kit.check('…and never to the impostor its selector also matches', marked?.impostor !== '2.5px', marked);
    kit.check('…without capturing again', !kit.events.some((e) => e.kind === 'rule-witness' && e.specId === vetoKey));

    // A mounted member that stops verifying: a script rule's stays (its own
    // handler may be what changed it) and is reported unverified; the
    // restyle rule's mount is torn down and its token stripped.
    const tagKey = kit.apply({ id: 'tag', anchor: { primary: { kind: 'css', value: 'li.row' }, setWitness: sw as unknown as SetWitness }, mutations: [{ kind: 'script', handler: 'rowTag' }], handlers: { rowTag: H.rowTag } });
    const tagged = await kit.until(async () => ((await kit.read(`document.querySelectorAll('#rows .conf-row-tag').length`)) === 4 ? true : null), 8000);
    kit.check('the script rule mounted on every member', tagged === true);
    await kit.read(`(() => {
      const row = document.querySelector('#rows > li.row');
      row.removeAttribute('data-kind');
      row.setAttribute('aria-hidden', 'true');
      for (const c of Array.from(row.children)) if (!c.classList.contains('conf-row-tag')) c.remove();
      row.prepend(document.createElement('u'));
      document.body.appendChild(document.createElement('div'));
      return true;
    })()`);
    const revoked = await kit.until(async () => {
      const r = await kit.read(`(() => {
        const row = document.querySelector('#rows > li.row');
        return { margin: getComputedStyle(row).scrollMarginLeft, css: row.getAttribute('data-shim-css') || '', tag: !!row.querySelector('.conf-row-tag') };
      })()`);
      return isRecord(r) && r.margin !== '2.5px' ? r : null;
    }, 8000);
    kit.check('a restyle member that stops verifying is torn down (token stripped)', revoked !== null && !String(revoked.css).includes('veto'), revoked);
    kit.check('…while the script rule keeps its mount on it', revoked?.tag === true, revoked);
    const unverified = await kit.event((e) => e.kind === 'rule-status' && e.specId === tagKey && e.unverified === 1, 8000);
    kit.check('…and reports it unverified', unverified !== null, kit.events.filter((e) => e.kind === 'rule-status' && e.specId === tagKey).at(-1));

    // A rule whose own output makes its selector stop matching (an injection
    // filling `.slot:empty`) keeps its mounts: a member is judged by its
    // fingerprint (own DOM excluded), never by the selector alone.
    const slotCapKey = kit.apply({ id: 'slot-cap', anchor: css('#slots > .slot:empty'), mutations: [{ kind: 'restyle', properties: {} }] });
    const slotCap = await kit.event((e) => e.kind === 'rule-witness' && e.specId === slotCapKey && isRecord(e.setWitness));
    kit.remove(slotCapKey);
    const slotSw = isRecord(slotCap?.setWitness) ? slotCap.setWitness : null;
    kit.check('the empty slots captured a set witness', slotSw !== null && slotSw.count === 2, slotCap);
    let slotKey = '';
    if (slotSw) {
      // Behind a stale deploy baseline, so the reconciler would escalate a
      // rule it judged unresolved.
      const stale = fixtureDeployId(kit.origin, 2);
      slotKey = kit.apply({ id: 'slot-fill', anchor: { primary: { kind: 'css', value: '#slots > .slot:empty' }, setWitness: slotSw as unknown as SetWitness },
        mutations: [{ kind: 'inject-element', placement: 'append', element: { tag: 'span', attrs: { class: 'conf-slot-fill' }, text: 'filled' } }] },
        stale ? { bundleHash: stale } : {});
      const filled = await kit.until(async () => ((await kit.read(`document.querySelectorAll('#slots .conf-slot-fill').length`)) === 2 ? true : null), 8000);
      kit.check('the injection filled both slots', filled === true);
      await kit.read(`(() => { for (const f of document.querySelectorAll('#slots .conf-slot-fill')) f.setAttribute('data-conf-first', '1'); return true; })()`);
      for (let i = 0; i < 3; i++) {
        await kit.read(`(() => { document.body.appendChild(document.createElement('div')); return true; })()`);
        await kit.sleep(250);
      }
      const stable = await kit.read(`(() => { const f = document.querySelectorAll('#slots .conf-slot-fill'); return { count: f.length, first: Array.from(f).every((x) => x.getAttribute('data-conf-first') === '1') }; })()`);
      kit.check('…and keeps the same outputs across later scans (no revoke / re-inject cycle)', isRecord(stable) && stable.count === 2 && stable.first === true, stable);
      await kit.sleep(5000); // settle (1.5 s) + the deploy retry (2.5 s) + margin
      const key = slotKey;
      kit.check('…and the reconciler counts its retained members healthy (no quarantine, no no-match)',
        !kit.events.some((e) => (e.kind === 'rule-quarantined' || e.kind === 'rule-no-match') && e.specId === key),
        kit.events.filter((e) => e.specId === key).map((e) => e.kind));
    }

    // A conflicted rule (an element witness beside the set one) is judged by
    // its element witness: once that rejects its mounted member, the set
    // witness never keeps it alive, and the rule quarantines.
    const conflictedKey = kit.apply({ id: 'conflicted', anchor: { primary: { kind: 'css', value: '#rows > li.row' }, witness: { v: 1, tag: 'li', attrs: { 'data-i': '2' } }, setWitness: sw as unknown as SetWitness },
      mutations: [{ kind: 'restyle', properties: { scrollMarginBottom: '3.5px' } }] });
    const one = await kit.event((e) => e.kind === 'rule-status' && e.specId === conflictedKey && e.matched === 1, 8000);
    kit.check('a conflicted rule resolves through its element witness (one row)', one !== null, kit.events.filter((e) => e.specId === conflictedKey).at(-1));
    await kit.read(`(() => { const r = document.querySelector('#rows > li.row[data-i="2"]'); r.setAttribute('data-i', '9'); r.appendChild(document.createElement('s')); return true; })()`);
    const q = await kit.event((e) => e.kind === 'rule-quarantined' && e.specId === conflictedKey, 9000);
    kit.check('…and quarantines once that rejects its member, whatever the set witness says', q?.fingerprint === 'conflicted', q);

    // The single-element counterpart: an element-witnessed injection filling
    // `#lone-slot:empty` stays a success after its own output takes it out of
    // the selector's result — behind a stale baseline with auto-repair off,
    // where a judged-unresolved rule would quarantine.
    const loneCapKey = kit.apply({ id: 'lone-cap', anchor: css('#lone-slot:empty'), mutations: [{ kind: 'restyle', properties: {} }] });
    const loneCap = await kit.event((e) => e.kind === 'rule-witness' && e.specId === loneCapKey && isRecord(e.witness));
    kit.remove(loneCapKey);
    const loneW = isRecord(loneCap?.witness) ? loneCap.witness : null;
    kit.check('the lone slot captured an element witness', loneW !== null && loneW.tag === 'div', loneCap);
    let loneKey = '';
    const staleLone = fixtureDeployId(kit.origin, 2);
    if (loneW && staleLone) {
      loneKey = kit.apply({ id: 'lone-fill', anchor: { primary: { kind: 'css', value: '#lone-slot:empty' }, witness: loneW as unknown as Witness },
        mutations: [{ kind: 'inject-element', placement: 'append', element: { tag: 'span', attrs: { class: 'conf-lone-fill' }, text: 'filled' } }] },
        { bundleHash: staleLone, autoRepair: false });
      const filled = await kit.until(async () => ((await kit.read(`document.querySelectorAll('#lone-slot .conf-lone-fill').length`)) === 1 ? true : null), 8000);
      kit.check('the injection filled the lone slot', filled === true);
      for (let i = 0; i < 3; i++) {
        await kit.read(`(() => { document.body.appendChild(document.createElement('div')); return true; })()`);
        await kit.sleep(250);
      }
      await kit.sleep(5000);
      const key = loneKey;
      kit.check('…and stays a success through the reconciler (no no-match, no quarantine)',
        !kit.events.some((e) => (e.kind === 'rule-quarantined' || e.kind === 'rule-no-match') && e.specId === key)
        && (await kit.read(`document.querySelectorAll('#lone-slot .conf-lone-fill').length`)) === 1,
        kit.events.filter((e) => e.specId === key).map((e) => e.kind));
    }

    // A text-anchored script that rewrites its own target's text: the
    // selector stops matching and the element witness would no longer pass,
    // but the mount is a success, so no no-match or quarantine follows.
    let doneKey = '';
    const staleDone = fixtureDeployId(kit.origin, 2);
    const doneCapKey = kit.apply({ id: 'done-cap', anchor: { primary: { kind: 'text', value: 'Apply' } }, mutations: [{ kind: 'restyle', properties: {} }] });
    const doneCap = await kit.event((e) => e.kind === 'rule-witness' && e.specId === doneCapKey && isRecord(e.witness));
    kit.remove(doneCapKey);
    const doneW = isRecord(doneCap?.witness) ? doneCap.witness : null;
    kit.check('the Apply button captured an element witness', doneW !== null && doneW.tag === 'button', doneCap);
    if (doneW && staleDone) {
      doneKey = kit.apply({ id: 'done', anchor: { primary: { kind: 'text', value: 'Apply' }, witness: doneW as unknown as Witness },
        mutations: [{ kind: 'script', handler: 'markDone' }], handlers: { markDone: H.markDone } }, { bundleHash: staleDone });
      const done = await kit.until(async () => ((await kit.read(`document.querySelector('#done-wrap button').textContent`)) === 'Done' ? true : null), 8000);
      kit.check('the script rewrote its own target', done === true);
      await kit.read(`(() => { document.body.appendChild(document.createElement('div')); return true; })()`);
      await kit.sleep(5000);
      const key = doneKey;
      kit.check('…and stays a success through the reconciler (no no-match, no quarantine)',
        !kit.events.some((e) => (e.kind === 'rule-quarantined' || e.kind === 'rule-no-match') && e.specId === key),
        kit.events.filter((e) => e.specId === key).map((e) => e.kind));
    }
    for (const key of [rowsKey, mixedKey, vetoKey, tagKey, conflictedKey, ...(slotKey ? [slotKey] : []), ...(loneKey ? [loneKey] : []), ...(doneKey ? [doneKey] : [])]) kit.remove(key);
  },
};

// Trusted input (PageHost.input) and the document token: the events reach
// the page as a user's, `stillPinned` runs before every command (and its
// answer stops the rest), a page that moves focus or covers the target
// between commands is observable at that point, a failed command ends the
// batch with an exact count, and the channel works again afterwards.
const inputCase: ConformanceCase = {
  id: 'trusted-input',
  title: 'trusted input: click, type, keys, wheel, pinning, focus theft, overlay, failure; document token',
  covers: ['trusted-input'],
  async run(kit) {
    const { host } = kit;
    const input = host.input?.bind(host);
    kit.check('input is present exactly when trustedInput is advertised', (input !== undefined) === host.capabilities.trustedInput);
    if (!input) return;
    if (!(await kit.load('/input'))) return;
    const attr = async (id: string, name: string): Promise<unknown> => kit.read(`document.getElementById(${JSON.stringify(id)}).getAttribute(${JSON.stringify('data-' + name)})`);
    const locate = async (selector: string): Promise<{ x: number; y: number } | null> => {
      let loc: unknown;
      try { loc = await host.evaluate(locateScript(selector), 'engine'); } catch { return null; }
      const l = loc as LocateResult;
      return !('error' in l) && l.count === 1 && typeof l.x === 'number' && typeof l.y === 'number' ? { x: l.x, y: l.y } : null;
    };
    const always = (): boolean => true;

    // Document token: stable within a document, new with a new one.
    const token1 = await host.documentToken();
    await kit.read(`history.pushState({}, '', '/input#moved'); location.hash`);
    const token2 = await host.documentToken();
    kit.check('the document token is stable across a same-document URL change', typeof token1 === 'string' && token1.length > 0 && token1 === token2, { token1, token2 });

    // A trusted click.
    const btn = await locate('#in-btn');
    kit.check('the engine world locates the button', btn !== null);
    if (!btn) return;
    const seen: number[] = [];
    const click = await input(clickCommands(btn.x, btn.y), (i) => { seen.push(i); return true; });
    kit.check('a click batch reports every command sent', click.outcome === 'done' && click.sent === 3, click);
    kit.check('stillPinned ran before each command, in order', seen.join() === '0,1,2', seen);
    kit.check('the page saw one trusted click', (await kit.until(async () => ((await attr('in-btn', 'clicks')) === '1' ? true : null), 2000)) === true
      && (await attr('in-btn', 'click')) === 'trusted', { clicks: await attr('in-btn', 'clicks'), click: await attr('in-btn', 'click') });

    // Typing and a key.
    const field = await locate('#in-field');
    if (field) {
      const typed = await input([...clickCommands(field.x, field.y), { method: 'Input.insertText', params: { text: 'hello' } }, ...keyCommands('ArrowLeft')], always);
      kit.check('a typing batch completes', typed.outcome === 'done', typed);
      kit.check('the text arrived as trusted input', (await kit.read(`document.getElementById('in-field').value`)) === 'hello' && (await attr('in-field', 'input')) === 'trusted');
      kit.check('the key arrived as a trusted keydown', (await attr('in-field', 'last-key')) === 'ArrowLeft' && (await attr('in-field', 'key')) === 'trusted');
    } else kit.check('the engine world locates the field', false);

    // Disabled / read-only, as the locate script reports them, and a trusted
    // click on a disabled control does nothing.
    const ro = await host.evaluate(locateScript('#in-ro'), 'engine').catch(() => null) as LocateResult | null;
    const off = await host.evaluate(locateScript('#in-disabled'), 'engine').catch(() => null) as LocateResult | null;
    kit.check('a read-only field is not editable', ro !== null && !('error' in ro) && ro.editable === false, ro);
    kit.check('a disabled control reads disabled', off !== null && !('error' in off) && off.disabled === true, off);
    if (off && !('error' in off) && typeof off.x === 'number' && typeof off.y === 'number') {
      await input(clickCommands(off.x, off.y), always);
      await kit.sleep(100);
      kit.check('a trusted click on a disabled control fires nothing', (await attr('in-disabled', 'clicks')) === null);
    }

    // <select> is set through the DOM: its events are untrusted, and say so.
    const set = await host.evaluate(selectScript('#in-select', 'b'), 'engine').catch((e: unknown) => ({ error: errMessage(e) }));
    kit.check('select sets the value through the DOM, untrusted', isRecord(set) && set.ok === true
      && (await kit.read(`document.getElementById('in-select').value`)) === 'b' && (await attr('in-select', 'change')) === 'untrusted', set);

    // Pinning: a false answer stops the batch before the command it guards.
    const clicksBefore = await attr('in-btn', 'clicks');
    const btn2 = await locate('#in-btn');
    if (btn2) {
      const pinned = await input(clickCommands(btn2.x, btn2.y), (i) => i < 1);
      kit.check('a pin change stops the batch with an exact count', pinned.outcome === 'stopped' && pinned.sent === 1, pinned);
      const abort = new AbortController();
      const aborted = await input(clickCommands(btn2.x, btn2.y), async (i) => {
        if (i === 1) abort.abort();
        await new Promise((r) => setTimeout(r, 10));
        return !abort.signal.aborted;
      });
      kit.check('an asynchronous stillPinned is awaited: an abort mid-batch stops it', aborted.outcome === 'stopped' && aborted.sent === 1, aborted);
      const threw = await input(clickCommands(btn2.x, btn2.y), (i) => { if (i === 1) throw new Error('boom'); return true; });
      kit.check('a throwing stillPinned stops the batch', threw.outcome === 'stopped' && threw.sent === 1, threw);
      await kit.sleep(100);
      kit.check('…and no stopped batch clicked', (await attr('in-btn', 'clicks')) === clicksBefore);
    }

    // Focus theft: the page moves focus on mousedown; a focus check before
    // the text goes out sees it, and the text never reaches the other field.
    const steal = await locate('#in-steal');
    if (steal) {
      const deepFocus = async (): Promise<unknown> => host.evaluate(`(() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a ? a.id : null; })()`, 'engine').catch(() => null);
      const commands = [...clickCommands(steal.x, steal.y), { method: 'Input.insertText', params: { text: 'leak' } } as const];
      const stolen = await input(commands, async (i) => (i < 3 ? true : (await deepFocus()) === 'in-steal'));
      kit.check('focus moved by the page between commands is seen before the text goes out', stolen.outcome === 'stopped' && stolen.sent === 3, { stolen, focus: await deepFocus() });
      kit.check('…and the text reached no field', (await kit.read(`document.getElementById('in-other').value + document.getElementById('in-steal').value`)) === '');
    } else kit.check('the engine world locates the focus thief', false);

    // An overlay raised by mouseover: a hit test before the press sees it.
    const hover = await locate('#in-hover');
    if (hover) {
      const hit = (): Promise<boolean> => host.evaluate(`(() => { const t = document.getElementById('in-hover'); const h = document.elementFromPoint(${hover.x}, ${hover.y}); return !!h && (h === t || t.contains(h)); })()`, 'engine').then((v) => v === true, () => false);
      const covered = await input(clickCommands(hover.x, hover.y), async (i) => (i === 0 ? true : hit()));
      kit.check('an overlay raised by the first command is seen before the press', covered.outcome === 'stopped' && covered.sent === 1, covered);
      await kit.sleep(100);
      kit.check('…and neither the target nor the overlay was clicked', (await attr('in-hover', 'clicks')) === null && (await attr('in-overlay', 'clicks')) === null);
    } else kit.check('the engine world locates the hover target', false);

    // Wheel: a trusted wheel at the viewport's centre scrolls the page.
    await kit.read('window.scrollTo(0, 0); window.scrollY');
    const vp = await kit.read('({ w: window.innerWidth, h: window.innerHeight })');
    if (isRecord(vp) && typeof vp.w === 'number' && typeof vp.h === 'number') {
      const wheel = await input([{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: Math.round(vp.w / 2), y: Math.round(vp.h / 2), deltaX: 0, deltaY: 400 } }], always);
      const moved = await kit.until(async () => { const y = await kit.read('window.scrollY'); return typeof y === 'number' && y > 0 ? y : null; }, 3000);
      kit.check('a trusted wheel scrolls the page', wheel.outcome === 'done' && moved !== null, { wheel, moved });
    } else kit.check('the viewport is measurable', false, vp);

    // A command the channel rejects ends the batch with the count before it,
    // and the channel works again for the next batch.
    const btn3 = await locate('#in-btn');
    if (btn3) {
      const clicks = await attr('in-btn', 'clicks');
      const failed = await input([
        { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: btn3.x, y: btn3.y } },
        { method: 'Input.dispatchMouseEvent', params: { type: 'not-a-mouse-event', x: btn3.x, y: btn3.y } },
        { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: btn3.x, y: btn3.y, button: 'left', clickCount: 1 } },
      ], always);
      kit.check('a rejected command fails the batch with the count before it', failed.outcome === 'failed' && failed.sent === 1 && typeof failed.error === 'string', failed);
      const again = await input(clickCommands(btn3.x, btn3.y), always);
      const after = await kit.until(async () => { const c = await attr('in-btn', 'clicks'); return c !== clicks ? c : null; }, 2000);
      kit.check('the channel works again after a failure', again.outcome === 'done' && after === String(Number(clicks) + 1), { again, clicks, after });
    }

    kit.check('an empty batch is done with nothing sent', JSON.stringify(await input([], always)) === JSON.stringify({ sent: 0, outcome: 'done' }));

    if (!(await kit.load('/input'))) return;
    const token3 = await host.documentToken();
    kit.check('a new document has a new token', typeof token3 === 'string' && token3 !== token1, { token1, token3 });
  },
};

const anchorChangeCase: ConformanceCase = {
  id: 'anchor-change',
  title: 'api.onAnchorChange fires for childList changes inside its anchor, and nothing else',
  covers: ['api.onAnchorChange', 'script', 'handler-errors'],
  async run(kit) {
    if (!(await kit.load('/apply'))) return;
    const count = (attr = 'data-conf-changes', sel = '#list') =>
      kit.read(`document.querySelector(${JSON.stringify(sel)}).getAttribute(${JSON.stringify(attr)})`);
    const watchKey = kit.apply({ id: 'watch-list', anchor: css('#list'), mutations: [{ kind: 'script', handler: 'watchList' }], handlers: { watchList: H.watchList } });
    kit.check('the handler mounted', (await kit.until(async () => (await count()) === '0' ? true : null)) === true, await count());

    await kit.read(`document.querySelector('#a').setAttribute('title', 'changed')`);
    await kit.sleep(400);
    kit.check('an attribute change inside the anchor is not delivered', (await count()) === '0', await count());
    await kit.read(`document.querySelector('#grid').appendChild(document.createElement('span'))`);
    await kit.sleep(400);
    kit.check('a childList change outside the anchor is not delivered', (await count()) === '0', await count());

    await kit.read(`document.querySelector('#b').appendChild(document.createElement('b'))`);
    kit.check('a childList change deep inside the anchor is delivered', (await kit.until(async () => (await count()) === '1' ? true : null)) === true, await count());
    await kit.sleep(600);
    kit.check('the hook\'s own synchronous write into its anchor is never delivered back', (await count()) === '1', await count());
    kit.check('…and that write landed', (await kit.read(`document.querySelectorAll('#list > .conf-echo').length`)) === 1);
    await kit.read(`document.querySelector('#c').textContent = 'C2'`);
    kit.check('a second site change is delivered again', (await kit.until(async () => (await count()) === '2' ? true : null)) === true, await count());

    // Same-key replacement: only the new application's hook runs.
    kit.apply({ id: 'watch-list', anchor: css('#list'), mutations: [{ kind: 'script', handler: 'watchListB' }], handlers: { watchListB: H.watchListB } });
    await kit.sleep(300);
    await kit.read(`document.querySelector('#a').appendChild(document.createElement('i'))`);
    kit.check('after a same-key replacement the new hook fires', (await kit.until(async () => (await count('data-conf-changes-b')) === '1' ? true : null)) === true, await count('data-conf-changes-b'));
    kit.check('…and the replaced one never does', (await count()) === '2', await count());
    kit.remove(watchKey);
    await kit.sleep(200);
    await kit.read(`document.querySelector('#a').appendChild(document.createElement('i'))`);
    await kit.sleep(400);
    kit.check('after teardown no hook fires', (await count('data-conf-changes-b')) === '1', await count('data-conf-changes-b'));

    // A throwing hook is reported on the handler-error channel and stays registered.
    const throwKey = kit.apply({ id: 'watch-throws', anchor: css('#note-target'), mutations: [{ kind: 'script', handler: 'watchThrows' }], handlers: { watchThrows: H.watchThrows } });
    await kit.until(async () => (await count('data-conf-watch-throws', '#note-target')) === 'ready' ? true : null);
    await kit.read(`document.querySelector('#note-target').appendChild(document.createElement('i'))`);
    const err = await kit.event((e) => e.kind === 'handler-error' && e.specId === throwKey);
    kit.check('a throwing hook reports handler-error with its handler name and an onAnchorChange message',
      err?.handlerName === 'watchThrows' && err.ruleId === 'watch-throws' && typeof err.message === 'string' && err.message === 'onAnchorChange: conf-change-boom', err);
    kit.remove(throwKey);

    // A change while the initial (async) mount is still awaiting is delivered once, after it lands.
    const asyncKey = kit.apply({ id: 'watch-async', anchor: css('#lead'), mutations: [{ kind: 'script', handler: 'watchAsyncMount' }], handlers: { watchAsyncMount: H.watchAsyncMount } });
    await kit.until(async () => (await count('data-conf-async', '#lead')) === 'waiting' ? true : null);
    await kit.read(`document.querySelector('#lead').appendChild(document.createTextNode(' more'))`);
    await kit.sleep(200);
    kit.check('nothing is delivered while the mount is in flight', (await count('data-conf-async-changes', '#lead')) === null, await count('data-conf-async-changes', '#lead'));
    kit.check('a change during the in-flight mount is delivered once after it lands',
      (await kit.until(async () => (await count('data-conf-async-changes', '#lead')) === '1' ? true : null, 3000)) === true, await count('data-conf-async-changes', '#lead'));
    kit.remove(asyncKey);

    // Torn down while the mount is still in flight: never delivers.
    const doomedKey = kit.apply({ id: 'watch-doomed', anchor: css('#ad'), mutations: [{ kind: 'script', handler: 'watchAsyncMount' }], handlers: { watchAsyncMount: H.watchAsyncMount } });
    await kit.until(async () => (await count('data-conf-async', '#ad')) === 'waiting' ? true : null);
    kit.remove(doomedKey);
    await kit.read(`document.querySelector('#ad').appendChild(document.createElement('i'))`);
    await kit.sleep(1200);
    kit.check('a mount torn down in flight never delivers', (await count('data-conf-async-changes', '#ad')) === null, await count('data-conf-async-changes', '#ad'));
  },
};

const unattachedOutputCase: ConformanceCase = {
  id: 'unattached-inline-output',
  title: 'a returned inline root the handler never inserted is reported, never re-mounted on every page change',
  covers: ['self-healing', 'script', 'mount:inline', 'api.onAnchorChange'],
  async run(kit) {
    if (!(await kit.load('/apply'))) return;
    const mounts = (sel: string) => kit.read(`document.querySelector(${JSON.stringify(sel)}).getAttribute('data-conf-mounts')`);
    const syncKey = kit.apply({ id: 'orphan-sync', anchor: css('#lead'), mutations: [{ kind: 'script', handler: 'orphanSync' }], handlers: { orphanSync: H.orphanSync } });
    const asyncKey = kit.apply({ id: 'orphan-async', anchor: css('#ad'), mutations: [{ kind: 'script', handler: 'orphanAsync' }], handlers: { orphanAsync: H.orphanAsync } });
    kit.apply({ id: 'counted-note', anchor: css('#cleanup-target'), mutations: [{ kind: 'script', handler: 'countedNote' }], handlers: { countedNote: H.countedNote } });
    const mountedOnce = await kit.until(async () => (await mounts('#lead')) === '1' && (await mounts('#ad')) === '1' && (await mounts('#cleanup-target')) === '1' ? true : null);
    kit.check('every handler mounted once', mountedOnce === true, [await mounts('#lead'), await mounts('#ad'), await mounts('#cleanup-target')]);
    await kit.sleep(300);

    // Many page mutations, each in its own frame: the old engine re-ran the
    // orphaning handlers on every one.
    for (let i = 0; i < 20; i++) {
      await kit.read(`document.querySelector('#grid').appendChild(document.createElement('span'))`);
      await kit.sleep(40);
    }
    await kit.sleep(400);
    kit.check('a sync handler\'s never-inserted root is not re-mounted across 20 page mutations', (await mounts('#lead')) === '1', await mounts('#lead'));
    kit.check('…nor an async handler\'s', (await mounts('#ad')) === '1', await mounts('#ad'));
    kit.check('…and the returned node stays off the page', (await kit.read(`document.querySelectorAll('.conf-orphan').length`)) === 0);

    await kit.read(`document.querySelector('#lead').appendChild(document.createElement('b'))`);
    const delivered = await kit.until(async () => (await kit.read(`document.querySelector('#lead').getAttribute('data-conf-orphan-changes')`)) === '1' ? true : null, 3000);
    kit.check('the handler\'s api.onAnchorChange registration survives and fires', delivered === true,
      await kit.read(`document.querySelector('#lead').getAttribute('data-conf-orphan-changes')`));

    const noted = (key: string) => kit.event((e) => e.kind === 'rule-status' && e.specId === key && typeof e.note === 'string' && e.note.includes('never put on the page'));
    const syncNote = await noted(syncKey);
    kit.check('rule-status carries a note naming the never-inserted node', syncNote !== null && typeof syncNote.note === 'string' && syncNote.note.includes('returned 1 node(s)'),
      kit.events.filter((e) => e.kind === 'rule-status' && e.specId === syncKey).at(-1));
    kit.check('…for the async handler too', (await noted(asyncKey)) !== null, kit.events.filter((e) => e.kind === 'rule-status' && e.specId === asyncKey).at(-1));
    const warned = await kit.until(() => kit.console.find((m) => m.level === 'warning' && m.message.includes('never put on the page')) ?? null, 3000);
    kit.check('the engine warns on the console, naming the handler', warned !== null && warned.message.includes('orphanSync'), kit.console.filter((m) => m.level === 'warning').map((m) => m.message));

    // A root that was on the page and was removed still self-heals, once.
    await kit.read(`document.querySelector('#cleanup-target > .conf-counted').remove()`);
    const healed = await kit.until(async () => (await mounts('#cleanup-target')) === '2'
      && (await kit.read(`document.querySelectorAll('#cleanup-target > .conf-counted').length`)) === 1 ? true : null);
    kit.check('a returned root the site removed is re-mounted', healed === true, await mounts('#cleanup-target'));
    await kit.sleep(400);
    kit.check('…exactly once', (await mounts('#cleanup-target')) === '2', await mounts('#cleanup-target'));

    // Inserted, then removed before the handler settled: it was on the page,
    // so it is re-mounted (not reported as never inserted).
    const flashKey = kit.apply({ id: 'flash-async', anchor: css('#inject-target'), mutations: [{ kind: 'script', handler: 'flashAsync' }], handlers: { flashAsync: H.flashAsync } });
    const flashHealed = await kit.until(async () => (await mounts('#inject-target')) === '2'
      && (await kit.read(`document.querySelectorAll('#inject-target > .conf-flash').length`)) === 1 ? true : null, 4000);
    kit.check('a root removed before its async handler settled is re-mounted', flashHealed === true, await mounts('#inject-target'));
    // A site observer removes the first one the moment it lands (sync handler).
    await kit.read(`(() => {
      const t = document.querySelector('#html-target');
      const o = new MutationObserver(() => { const f = t.querySelector('.conf-flash'); if (f) { f.remove(); o.disconnect(); } });
      o.observe(t, { childList: true });
    })()`);
    const siteKey = kit.apply({ id: 'flash-sync', anchor: css('#html-target'), mutations: [{ kind: 'script', handler: 'flashSync' }], handlers: { flashSync: H.flashSync } });
    const siteHealed = await kit.until(async () => (await mounts('#html-target')) === '2'
      && (await kit.read(`document.querySelectorAll('#html-target > .conf-flash').length`)) === 1 ? true : null, 4000);
    kit.check('a root a site observer removed as it landed is re-mounted', siteHealed === true, await mounts('#html-target'));
    await kit.sleep(400);
    const neverNoted = (key: string) => !kit.events.some((e) => e.kind === 'rule-status' && e.specId === key && typeof e.note === 'string' && e.note.includes('never put on the page'));
    kit.check('…neither is reported as never put on the page', neverNoted(flashKey) && neverNoted(siteKey));
  },
};

export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
  applyCase, setWitnessCase, teardownCase, rerenderCase, spaCase, storageCase, throwingCase, deployCase, pageToolsCase, cropScrollCase, strictCspCase, sharedModuleCase, noMatchCase,
  inputCase, supersededLoadCase, anchorChangeCase, unattachedOutputCase,
];

/** Every capability some case vouches for. */
export function coveredCapabilities(cases: readonly ConformanceCase[] = CONFORMANCE_CASES): Set<ConformanceCapability> {
  const out = new Set<ConformanceCapability>();
  for (const c of cases) for (const cap of c.covers) out.add(cap);
  return out;
}

export interface RunConformanceOptions {
  /** Run only these case ids. */
  only?: readonly string[];
  /** Called as each case finishes. */
  onCase?(result: ConformanceCaseResult): void;
}

/** Run the suite against one host. Never throws: a case that throws fails with the error. */
export async function runConformance(ctx: ConformanceContext, options: RunConformanceOptions = {}): Promise<ConformanceCaseResult[]> {
  const results: ConformanceCaseResult[] = [];
  const cases = options.only ? CONFORMANCE_CASES.filter((c) => options.only?.includes(c.id)) : CONFORMANCE_CASES;
  for (const c of cases) {
    const checks: ConformanceCheck[] = [];
    const applied = new Set<string>();
    const kit = makeKit(ctx, checks, applied);
    try {
      await c.run(kit);
    } catch (err) {
      checks.push({ label: 'case ran to completion', ok: false, detail: errMessage(err) });
    } finally {
      for (const key of applied) ctx.host.removePreview(key);
      kit.dispose();
    }
    if (checks.length === 0) checks.push({ label: 'case made at least one check', ok: false });
    const result: ConformanceCaseResult = { id: c.id, title: c.title, covers: c.covers, checks, passed: checks.every((k) => k.ok) };
    results.push(result);
    options.onCase?.(result);
  }
  return results;
}

/** A run's report as text lines, and how many checks failed. */
export function formatConformanceResults(hostName: string, results: readonly ConformanceCaseResult[]): { lines: string[]; failed: number } {
  const lines: string[] = [];
  let failed = 0;
  for (const r of results) {
    lines.push('', `── ${r.id}: ${r.title} [${r.covers.join(', ')}]`);
    for (const c of r.checks) {
      lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.ok || c.detail === undefined ? '' : `  — ${c.detail}`}`);
      if (!c.ok) failed++;
    }
  }
  const casesFailed = results.filter((r) => !r.passed).map((r) => r.id);
  lines.push('', `${hostName}: ${results.length - casesFailed.length}/${results.length} cases passed${casesFailed.length ? ` (failed: ${casesFailed.join(', ')})` : ''}`);
  return { lines, failed };
}
