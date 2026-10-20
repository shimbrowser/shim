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
// real driver), shared handler modules, and a dead anchor's preview evidence.
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
import type { AnchorSpec, Rule, Witness } from './types';
import { computeDeployId } from './deploy-id';
import { viewPageOnHost, evaluateOnHost, MAX_SHOT_WIDTH } from './page-host-tools';
import { errMessage } from './error';
import { moduleToExpression } from './handler-source';
import { previewNoMatch, type NoMatchEntry, type RuleStatusEvent } from './preview-evidence';
import { verificationLevel } from './capability-preflight';

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

function page(title: string, body: string, deploy: FixtureDeploy): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/app.v${deploy}.js"></script>
</head><body>${body}</body></html>`;
}

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
    case '/strict': return html(page('strict', STRICT_BODY, state.deploy), STRICT_CSP);
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
  'witness:capture', 'witness:verify', 'rebase:refresh', 'rebase:promote', 'rebase:recover', 'rebase:quarantine',
  'api.storage', 'api.cleanup', 'handler-errors', 'console', 'spa-navigation', 'teardown', 'page-tools', 'strict-csp',
  'no-match',
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

export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
  applyCase, teardownCase, rerenderCase, spaCase, storageCase, throwingCase, deployCase, pageToolsCase, strictCspCase, sharedModuleCase, noMatchCase,
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
