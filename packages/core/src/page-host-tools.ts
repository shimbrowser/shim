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

import { computeCropRect } from './view-crop';
import type { CropMeasurement, CropRect } from './view-crop';
import type { PageHost, PageWorld, QueryPageResult, InspectElementResult, PageToolError } from './page-host';
import { errMessage } from './error';

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
      `(() => {
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
      `(() => {
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
async function measureCropRect(host: PageHost, selector: string, world: PageWorld): Promise<
  { rect: CropRect; elementBox: { w: number; h: number } } | { error: string }
> {
  let m: CropMeasurement | null;
  try {
    m = await host.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
      })()`,
      world,
    ) as CropMeasurement | null;
  } catch (err) {
    return { error: 'crop measurement failed: ' + errMessage(err) };
  }
  if (!m) {
    return { error: `crop selector matched nothing: ${selector} — check the selector, or call view_page without a selector for the full viewport` };
  }
  const rect = computeCropRect(m);
  if (!rect) {
    return { error: 'crop target is outside the visible viewport — ask the user to scroll it into view, or call view_page without a selector' };
  }
  return { rect, elementBox: { w: Math.round(m.w), h: Math.round(m.h) } };
}

/** view_page: the viewport (downscaled to MAX_SHOT_WIDTH), or a crop around `input.selector` at native resolution. */
export async function viewPageOnHost(host: PageHost, input: { selector?: string } | undefined, world: PageWorld): Promise<ViewPageResult> {
  const selector = typeof input?.selector === 'string' ? input.selector.trim() : '';
  let clip: CropRect | undefined;
  let elementBox: { w: number; h: number } | undefined;
  if (selector) {
    const measured = await measureCropRect(host, selector, world);
    if ('error' in measured) return { error: measured.error };
    clip = measured.rect;
    elementBox = measured.elementBox;
  }
  const shot = await host.screenshot(clip ? { clip } : { maxWidth: MAX_SHOT_WIDTH });
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

/**
 * evaluate_in_page: runs `expression` inside an async wrapper that awaits it
 * and serializes the value (or the throw) in the page, so every host returns
 * the same JSON. The result is capped at MAX_RESULT characters.
 */
export async function evaluateOnHost(host: PageHost, expression: string, timeoutMs: number, world: PageWorld): Promise<EvaluateResult> {
  const wrapped = `(async () => {
    function __ss(v) {
      try { return JSON.stringify(v); }
      catch (_) { try { return JSON.stringify(String(v)); } catch (__) { return '"<unserializable>"'; } }
    }
    try {
      const __r = await (${expression});
      return __ss({ result: __r === undefined ? null : __r });
    } catch (err) {
      return __ss({ error: (err && (err.message || err.toString())) || String(err) });
    }
  })()`;

  let raw: string;
  try {
    raw = await withTimeout(host.evaluate(wrapped, world) as Promise<string>, timeoutMs, 'evaluateInPage timeout');
  } catch (err) {
    return { error: errMessage(err) };
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
