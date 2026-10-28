// The page tools' page-side work, over a PageHost
// (the implementations of every tool that needs only a page are public):
// view_page's crop and capture, evaluate_in_page's wrapper, and the
// self-contained query_page / inspect_element reads a host without engine
// inspection answers with.
//
// Each function takes one host and the world its scripts run in. What a
// session layers on top — which page, the page-away guard, reload budgets,
// the console buffer — stays with the session (the Shim browser's
// preview tools). Every result is a value, never a
// throw: an error is `{ error, detail? }`.

import { computeCropRect, CROP_PAD } from './view-crop';
import type { CropMeasurement, CropRect } from './view-crop';
import type { PageHost, PageWorld, QueryPageResult, InspectElementResult, PageToolError, ScreenshotOptions, ScreenshotResult } from './page-host';
import { errMessage } from './error';
import { syntaxProbe } from './syntax-probe';
import type { CompileProbe } from './rewrite-response';

export const QUERY_TIMEOUT_MS = 8000;
export const INSPECT_TIMEOUT_MS = 5000;
export const EVALUATE_TIMEOUT_MS = 3000;
/** evaluate_in_page's input cap, in characters. */
export const MAX_EXPRESSION = 5000;
/** evaluate_in_page's serialized result cap, in characters; longer is truncated. */
export const MAX_RESULT = 8000;
/**
 * Full-viewport shots downscale to keep payloads sane; crops stay at native
 * capture resolution (retina 2x where present) — the zoom is the point.
 */
export const MAX_SHOT_WIDTH = 1280;

export type EvaluateResult = { result: string } | PageToolError;

export interface ViewPageResult {
  error?: string;
  // Present on the typed 'page-away' error (the session's guard): the
  // recovery instruction pointing the model at reload_page.
  detail?: string;
  dataBase64?: string;
  mediaType?: string;
  url?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  // Present when the model asked for an element-scoped crop: the selector
  // it cropped to and that element's measured CSS box (viewport px).
  croppedTo?: string;
  elementBox?: { w: number; h: number };
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// --- query_page / inspect_element (self-contained reads) --------------------
//
// A self-contained DOM read — deliberately simpler than the shim engine's
// ranking (PageHost.inspection, where a host has it).

export async function queryPageByScript(host: PageHost, description: string, timeoutMs: number, world: PageWorld): Promise<QueryPageResult> {
  try {
    const hits = await withTimeout(host.evaluate(
      `(async () => {
        ${WAIT_FOR_LEASE}
        const words = ${JSON.stringify(description)}.toLowerCase().split(/\\s+/).filter(Boolean);
        function cssPath(el) {
          const parts = [];
          let n = el;
          for (let depth = 0; n && n.nodeType === 1 && depth < 6; depth++) {
            let part = n.tagName.toLowerCase();
            if (n.id) { part += '#' + n.id; parts.unshift(part); break; }
            const parent = n.parentElement;
            if (parent) {
              const idx = Array.prototype.indexOf.call(parent.children, n) + 1;
              part += ':nth-child(' + idx + ')';
            }
            parts.unshift(part);
            n = n.parentElement;
          }
          return parts.join(' > ');
        }
        const all = Array.from(document.querySelectorAll('body, body *'));
        const scored = [];
        for (const el of all) {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const text = (el.textContent || '').trim().slice(0, 200);
          const hay = [
            el.tagName, el.id, el.className && typeof el.className === 'string' ? el.className : '',
            el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || '',
            el.getAttribute('alt') || '', text,
          ].join(' ').toLowerCase();
          let score = 0;
          for (const w of words) if (hay.includes(w)) score++;
          if (score === 0) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          scored.push({ score, el, text, r });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 25).map(({ el, text, r }) => ({
          selector: cssPath(el),
          tag: el.tagName.toLowerCase(),
          text,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        }));
      })()`,
      world,
    ), timeoutMs, 'queryPage timeout');
    return { candidates: Array.isArray(hits) ? hits : [] };
  } catch (err) {
    return { error: `query failed: ${errMessage(err)}` };
  }
}

export async function inspectElementByScript(host: PageHost, selector: string, timeoutMs: number, world: PageWorld): Promise<InspectElementResult> {
  if (!selector) return { element: { found: false } };
  try {
    const element = await withTimeout(host.evaluate(
      `(async () => {
        ${WAIT_FOR_LEASE}
        const sel = ${JSON.stringify(selector)};
        const matches = document.querySelectorAll(sel);
        const el = matches[0];
        if (!el) return { found: false, matchCount: 0 };
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const attrs = {};
        for (const a of el.attributes) attrs[a.name] = a.value;
        const ancestry = [];
        let n = el.parentElement;
        for (let depth = 0; n && depth < 8; depth++) {
          ancestry.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : ''));
          n = n.parentElement;
        }
        return {
          found: true,
          tag: el.tagName.toLowerCase(),
          attrs,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          computedStyle: {
            display: style.display, position: style.position, color: style.color,
            backgroundColor: style.backgroundColor, fontSize: style.fontSize,
            width: style.width, height: style.height,
          },
          ancestry,
          childCount: el.children.length,
          matchCount: matches.length,
        };
      })()`,
      world,
    ), timeoutMs, 'inspectElement timeout');
    return { element: element ?? { found: false } };
  } catch (err) {
    return { error: `inspect failed: ${errMessage(err)}` };
  }
}

// --- view_page ---------------------------------------------------------------

// Element-scoped crop: a full-viewport shot is the weakest input for fine
// visual judgment; the element plus context margin is legible and ~10x fewer
// image tokens. getBoundingClientRect's viewport CSS px is the space a
// screenshot clip takes; the geometry itself is view-crop.ts (pure).
//
// A screenshot sees only the viewport, so a target cut off by the viewport
// or by a scrolling ancestor (partly below the fold, or scrolled out
// entirely) is scrolled into view for the shot — centered when it fits with
// its margin, top-aligned when it doesn't — and every scroll position that
// moved is put back right after the capture. Restoring, rather than leaving
// the page where the crop put it, keeps the page what the agent (and, on an
// attached tab, the user) last saw: a later full-viewport shot or a rect from
// query_page / inspect_element stays in the same frame. Scrolling only when
// the target is cut off leaves a crop of an already-visible element exactly
// as before. The cost: the page sees the scroll (scroll listeners, lazy
// loading) — the price of a whole element, since the Shim browser's capture
// sees only the viewport (no capture beyond it, as a CDP clip could).
//
// Concurrent callers (parallel tool calls, parallel workers on one tab) must
// not interleave a crop's scroll, capture and restore with each other or
// with a full-viewport shot, so every view_page holds a lease in the page
// from its first script to its last: one per document and tool world, kept
// on that world's global, so it spans every caller whatever PageHost object
// they hold. A lease names its token, so only its holder restores and
// releases it, and it expires (VIEW_LEASE_MS) so a caller that died never
// wedges the page: whoever takes an expired lease first puts back the scroll
// it saved. A live holder never loses its lease mid-capture: it renews it
// every VIEW_LEASE_RENEW_MS while the capture runs (a capture can take
// seconds — a hidden window's first frames), so only a holder that stopped
// renewing ever expires. The
// self-contained query_page / inspect_element reads,
// which report viewport rects, wait for it too.

// The lease's slot on the tool world's global.
const VIEW_LEASE_SLOT = 'shim.viewPage.lease';
/** How long a view_page lease holds before another caller may take it. */
export const VIEW_LEASE_MS = 10_000;
/** How often a view_page holding the lease renews it while its capture runs. */
export const VIEW_LEASE_RENEW_MS = 2_000;
// Bound on the release script (it only restores scroll positions).
const RELEASE_TIMEOUT_MS = 5_000;
/**
 * How long a view_page waits in the page for the lease (room for a couple of
 * queued holders). The deadline is the page's own, so a waiter that gives up
 * never takes the lease afterwards; it answers busy instead.
 */
export const VIEW_WAIT_MS = 20_000;
const BUSY_ERROR = 'view_page: another view_page held the page for too long — try again';
// Bound on the wait for a frame after scrolling (a hidden view never paints;
// its capture produces the frame).
const SCROLL_PAINT_WAIT_MS = 300;

// Page-side (inside an async function): waits until no live lease is held; defines `__leaseKey`.
const WAIT_FOR_LEASE = `const __leaseKey = Symbol.for(${JSON.stringify(VIEW_LEASE_SLOT)});
    const __leaseFree = () => { const l = globalThis[__leaseKey]; return !l || l.expires <= Date.now(); };
    while (!__leaseFree()) await new Promise((r) => setTimeout(r, 16));`;

// Page-side (inside an async function): waits, until VIEW_WAIT_MS, for the
// lease — answering { busy: true } without taking it at the deadline — then
// takes it, first putting back what an expired holder scrolled, and leaves
// its token in `__token`.
const acquireLease = (waitMs: number): string => `const __leaseKey = Symbol.for(${JSON.stringify(VIEW_LEASE_SLOT)});
    const __leaseFree = () => { const l = globalThis[__leaseKey]; return !l || l.expires <= Date.now(); };
    const __deadline = Date.now() + ${waitMs};
    while (!__leaseFree()) {
      if (Date.now() >= __deadline) return { busy: true };
      await new Promise((r) => setTimeout(r, 16));
    }
    const __expired = globalThis[__leaseKey];
    if (__expired && Array.isArray(__expired.saved)) {
      for (const [n, left, top] of __expired.saved) n.scrollTo({ left, top, behavior: 'instant' });
    }
    const __token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    globalThis[__leaseKey] = { token: __token, expires: Date.now() + ${VIEW_LEASE_MS}, saved: [] };`;

/** The script that takes the view lease for a full-viewport shot; resolves to its token, or { busy: true }. */
export function viewLeaseAcquireSource(waitMs: number = VIEW_WAIT_MS): string {
  return `(async () => {
    ${acquireLease(waitMs)}
    return __token;
  })()`;
}

/**
 * The script that takes the view lease and measures `selector` for a crop,
 * scrolling it into view first when the viewport or a scrolling ancestor cuts
 * it off. The crop target is the first match with a non-empty box that is
 * not display:none or visibility:hidden. Resolves to null (nothing matched;
 * no lease held), { noneVisible, count } (matches, none rendered; no lease
 * held) or the measurement plus the lease token.
 */
export function cropMeasureSource(selector: string, waitMs: number = VIEW_WAIT_MS): string {
  return `(async () => {
    if (!document.querySelector(${JSON.stringify(selector)})) return null;
    ${acquireLease(waitMs)}
    try {
      // The first match that renders: a site often keeps a hidden copy (a
      // display:none template, a 0x0 placeholder) ahead of the one on screen,
      // and a crop of that is a junk corner of the page.
      const all = document.querySelectorAll(${JSON.stringify(selector)});
      if (all.length === 0) { delete globalThis[__leaseKey]; return null; }
      const rendered = (n) => {
        const r = n.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return false;
        const cs = getComputedStyle(n);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
      };
      const el = Array.prototype.find.call(all, rendered);
      if (!el) { delete globalThis[__leaseKey]; return { noneVisible: true, count: all.length }; }
      const measure = () => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
      };
      // What of the page the element can show through: the viewport, cut
      // down by every ancestor that clips its overflow.
      const visibleBox = () => {
        let x0 = 0, y0 = 0, x1 = window.innerWidth, y1 = window.innerHeight;
        for (let n = el.parentElement; n && n !== document.documentElement && n !== document.body; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
          const b = n.getBoundingClientRect();
          const left = b.left + n.clientLeft, top = b.top + n.clientTop;
          x0 = Math.max(x0, left); y0 = Math.max(y0, top);
          x1 = Math.min(x1, left + n.clientWidth); y1 = Math.min(y1, top + n.clientHeight);
        }
        return { x0, y0, x1, y1 };
      };
      const m = measure();
      const v = visibleBox();
      const cutOff = m.x < v.x0 || m.y < v.y0 || m.x + m.w > v.x1 || m.y + m.h > v.y1;
      if (!cutOff || (m.w === 0 && m.h === 0)) return Object.assign(m, { token: __token });
      const scroller = document.scrollingElement || document.documentElement;
      const before = [];
      for (let n = el.parentElement; n; n = n.parentElement) before.push([n, n.scrollLeft, n.scrollTop]);
      if (scroller && !before.some((s) => s[0] === scroller)) before.push([scroller, scroller.scrollLeft, scroller.scrollTop]);
      const pad = ${CROP_PAD};
      el.scrollIntoView({
        behavior: 'instant',
        block: m.h + 2 * pad <= m.vh ? 'center' : 'start',
        inline: m.w + 2 * pad <= m.vw ? 'center' : 'start',
      });
      globalThis[__leaseKey].saved = before.filter((s) => s[0].scrollLeft !== s[1] || s[0].scrollTop !== s[2]);
      if (globalThis[__leaseKey].saved.length === 0) return Object.assign(m, { token: __token });
      await Promise.race([
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        new Promise((r) => setTimeout(r, ${SCROLL_PAINT_WAIT_MS})),
      ]);
      return Object.assign(measure(), { token: __token, scrolled: true });
    } catch (err) {
      const l = globalThis[__leaseKey];
      if (l && l.token === __token) {
        for (const [n, left, top] of l.saved) n.scrollTo({ left, top, behavior: 'instant' });
        delete globalThis[__leaseKey];
      }
      throw err;
    }
  })()`;
}

/** The script that puts back what the lease `token` scrolled and releases it; another holder's lease is left alone. */
export function viewLeaseReleaseSource(token: string): string {
  return `(() => {
    const key = Symbol.for(${JSON.stringify(VIEW_LEASE_SLOT)});
    const l = globalThis[key];
    if (!l || l.token !== ${JSON.stringify(token)}) return false;
    for (const [n, left, top] of l.saved) n.scrollTo({ left, top, behavior: 'instant' });
    delete globalThis[key];
    return true;
  })()`;
}

type Measured = CropMeasurement & { token?: unknown; scrolled?: boolean; busy?: boolean; noneVisible?: boolean; count?: unknown };
type CropMeasured = { rect: CropRect; elementBox: { w: number; h: number }; token: string | null };

async function measureCropRect(host: PageHost, selector: string, world: PageWorld, waitMs: number): Promise<CropMeasured | { error: string; token: string | null }> {
  let m: Measured | null;
  try {
    m = await host.evaluate(cropMeasureSource(selector, waitMs), world) as Measured | null;
  } catch (err) {
    // The script restores and releases on its own throw.
    return { error: 'crop measurement failed: ' + errMessage(err), token: null };
  }
  if (!m) {
    return { error: `crop selector matched nothing: ${selector} — check the selector, or call view_page without a selector for the full viewport`, token: null };
  }
  if (m.busy === true) return { error: BUSY_ERROR, token: null };
  if (m.noneVisible === true) {
    const n = typeof m.count === 'number' ? m.count : 0;
    return { error: `crop selector matched ${n} element${n === 1 ? '' : 's'}, none visible (each has no size, or is display:none / visibility:hidden): ${selector} — narrow the selector to the element on screen, or call view_page without a selector`, token: null };
  }
  const token = typeof m.token === 'string' ? m.token : null;
  const rect = computeCropRect(m);
  if (!rect) {
    return { error: 'crop target is outside the viewport and scrolling did not bring it in (it may be positioned off-screen or have no size) — call view_page without a selector', token };
  }
  return { rect, elementBox: { w: Math.round(m.w), h: Math.round(m.h) }, token };
}

// A full shot's lease: its token; 'busy' when the page answered busy (or never
// answered — a token that arrives after that is released at once, never
// used); 'unleased' when the page can't run the script (or answered nothing
// usable), which still gets its shot.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

async function acquireViewLease(host: PageHost, world: PageWorld, waitMs: number): Promise<string | 'busy' | 'unleased'> {
  const pending = host.evaluate(viewLeaseAcquireSource(waitMs), world);
  let gaveUp = false;
  const outcome = await withTimeout(
    pending.then(
      (v): string => (typeof v === 'string' ? v : isRecord(v) && v.busy === true ? 'busy' : 'unleased'),
      (): 'unleased' => 'unleased',
    ),
    waitMs + 2000,
    'view lease timeout',
  ).catch((): 'busy' => { gaveUp = true; return 'busy'; });
  if (gaveUp) {
    void pending.then((late) => (typeof late === 'string' ? releaseViewLease(host, late, world) : undefined), () => undefined);
  }
  return outcome;
}

async function releaseViewLease(host: PageHost, token: string | null, world: PageWorld): Promise<void> {
  if (token === null) return;
  await withTimeout(host.evaluate(viewLeaseReleaseSource(token), world), RELEASE_TIMEOUT_MS, 'release timeout').catch(() => undefined);
}

/** The script that extends the lease `token` holds; another holder's lease is left alone. */
export function viewLeaseRenewSource(token: string): string {
  return `(() => {
    const l = globalThis[Symbol.for(${JSON.stringify(VIEW_LEASE_SLOT)})];
    if (!l || l.token !== ${JSON.stringify(token)}) return false;
    l.expires = Date.now() + ${VIEW_LEASE_MS};
    return true;
  })()`;
}

// Runs `work` while renewing the lease `token` every `everyMs`.
async function whileRenewing<T>(host: PageHost, token: string | null, world: PageWorld, everyMs: number, work: () => Promise<T>): Promise<T> {
  if (token === null) return work();
  const timer = setInterval(() => { host.evaluate(viewLeaseRenewSource(token), world).catch(() => undefined); }, everyMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** view_page: the viewport (downscaled to MAX_SHOT_WIDTH), or a crop around `input.selector` at native resolution. */
export async function viewPageOnHost(
  host: PageHost,
  input: { selector?: string } | undefined,
  world: PageWorld,
  options: { leaseWaitMs?: number; leaseRenewMs?: number } = {},
): Promise<ViewPageResult> {
  const waitMs = options.leaseWaitMs ?? VIEW_WAIT_MS;
  const renewMs = options.leaseRenewMs ?? VIEW_LEASE_RENEW_MS;
  const capture = (token: string | null, opts: ScreenshotOptions): Promise<ScreenshotResult> =>
    whileRenewing(host, token, world, renewMs, () => host.screenshot(opts));
  const selector = typeof input?.selector === 'string' ? input.selector.trim() : '';
  if (!selector) {
    const lease = await acquireViewLease(host, world, waitMs);
    if (lease === 'busy') return { error: BUSY_ERROR };
    const token = lease === 'unleased' ? null : lease;
    try {
      return shotResult(host, await capture(token, { maxWidth: MAX_SHOT_WIDTH }), '');
    } finally {
      await releaseViewLease(host, token, world);
    }
  }
  const measured = await measureCropRect(host, selector, world, waitMs);
  try {
    if ('error' in measured) return { error: measured.error };
    return shotResult(host, await capture(measured.token, { clip: measured.rect }), selector, measured.elementBox);
  } finally {
    await releaseViewLease(host, measured.token, world);
  }
}

function shotResult(host: PageHost, shot: ScreenshotResult, selector: string, elementBox?: { w: number; h: number }): ViewPageResult {
  if ('error' in shot) return { error: shot.error };
  return {
    dataBase64: shot.dataBase64,
    mediaType: shot.mediaType,
    url: host.url(),
    sizeBytes: shot.sizeBytes,
    width: shot.width,
    height: shot.height,
    ...(selector ? { croppedTo: selector, elementBox } : {}),
  };
}

// --- evaluate_in_page --------------------------------------------------------

/** evaluate_in_page's input check: null when `expression` may run. */
export function expressionProblem(expression: unknown): string | null {
  if (typeof expression !== 'string' || !expression.trim()) return 'empty expression';
  if (expression.length > MAX_EXPRESSION) return `expression too long (${MAX_EXPRESSION} char max)`;
  return null;
}

// evaluate_in_page takes either a single expression (`document.title`) or a
// statement body that returns its value (`const n = 1; return n`). Which one
// is decided by compiling, never by running, and HOST-SIDE: the host's own
// parser (syntaxProbe) reads the input as each form without running any of
// it. Compiling in the page instead left every statement body's failed
// expression probe in the page console as `Uncaught SyntaxError`, which the
// session then reported as the site's error. Every valid expression is also a
// valid statement body (one whose value is dropped), so the expression form is
// tried first; input that compiles as neither is answered here, never sent.
// Only a host that can't parse (no eval) falls back to the in-page probe: the
// input as an expression inside a function that is never called.
const PROBE_OK = 'shim-evaluate-expression';

/** The script that resolves when `expression` compiles as an expression; it never runs it. */
export function expressionProbeSource(expression: string): string {
  return `(function () {
    return ${JSON.stringify(PROBE_OK)};
    function __shimNeverCalled() { return async () => (${expression}
    ); }
  })()`;
}

/** The wrapper that runs `code` (an expression, or a statement body) awaited and serializes the outcome in the page. */
export function evaluateWrapperSource(expression: string, form: 'expression' | 'body'): string {
  // A newline before each closer, so a trailing // comment in the input
  // can't swallow it.
  const run = form === 'expression'
    ? `await (${expression}
      )`
    : `await (async () => {
${expression}
      })()`;
  return `(async () => {
    function __ss(v) {
      try { return JSON.stringify(v); }
      catch (_) { try { return JSON.stringify(String(v)); } catch (__) { return '"<unserializable>"'; } }
    }
    try {
      const __r = ${run};
      return __ss({ result: __r === undefined ? null : __r });
    } catch (err) {
      return __ss({ error: (err && (err.message || err.toString())) || String(err) });
    }
  })()`;
}

/**
 * evaluate_in_page: runs `expression` — a single expression, or a statement
 * body that `return`s its value — inside an async wrapper that awaits it and
 * serializes the value (or the throw) in the page, so every host returns the
 * same JSON. The result is capped at MAX_RESULT characters.
 */
/** Which form `expression` compiles as, read by the host's parser; null when that parser is unavailable. */
export function evaluateForm(expression: string, probe: CompileProbe = syntaxProbe): { form: 'expression' | 'body' } | { error: string } | null {
  const asExpression = probe(`(async () => (${expression}\n));`);
  if (asExpression.ok) return { form: 'expression' };
  if (/^syntax check unavailable/.test(asExpression.error ?? '')) return null;
  const asBody = probe(`(async () => {\n${expression}\n});`);
  if (asBody.ok) return { form: 'body' };
  return { error: `SyntaxError: ${asBody.error ?? 'the input compiles as neither an expression nor a statement body'}` };
}

export async function evaluateOnHost(host: PageHost, expression: string, timeoutMs: number, world: PageWorld, probe: CompileProbe = syntaxProbe): Promise<EvaluateResult> {
  const decided = evaluateForm(expression, probe);
  if (decided && 'error' in decided) return { error: decided.error };
  let settled = false;
  const run = async (): Promise<string> => {
    // Decided host-side when the host can parse; otherwise the in-page probe
    // (a failure to compile rejects, and the input then runs as a body).
    const isExpression = decided
      ? decided.form === 'expression'
      : await host.evaluate(expressionProbeSource(expression), world).then(() => true, () => false);
    // A probe that outlived the timeout must not start the run after the
    // caller was told it timed out.
    if (settled) throw new Error('evaluateInPage timeout');
    return await host.evaluate(evaluateWrapperSource(expression, isExpression ? 'expression' : 'body'), world) as string;
  };

  let raw: string;
  try {
    raw = await withTimeout(run(), timeoutMs, 'evaluateInPage timeout');
  } catch (err) {
    return { error: errMessage(err) };
  } finally {
    settled = true;
  }
  let parsed: { error?: string; result?: unknown };
  try { parsed = JSON.parse(raw); } catch (_) {
    return { error: 'page returned non-JSON: ' + String(raw).slice(0, 200) };
  }
  if (parsed && typeof parsed === 'object' && parsed.error !== undefined) {
    return { error: parsed.error };
  }
  let serialized = JSON.stringify(parsed?.result ?? null);
  if (serialized.length > MAX_RESULT) {
    serialized = serialized.slice(0, MAX_RESULT) + '\n... (truncated)';
  }
  return { result: serialized };
}
