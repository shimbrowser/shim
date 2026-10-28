// A headless authoring session on a shim: @shimbrowser/core's shim session
// (shim-session.ts, the page-side half every host shares) over a Playwright
// Chromium page and a `.shim` file. What is headless here: the committed
// rules run as previews (there is no installed shim), commits write the
// file, a handler's syntax is checked by core's probe (Node allows eval),
// and interact_page drives the whole page (the agent's own browser, no
// logins, a page it named) — the one part of a session whose policy differs
// per host, kept here with its scripts.
//
// Nothing here reads the Shim browser's profile (invariant 10): the page is
// the caller's, `api.storage` is the caller's file.

import * as fs from 'fs';
import * as path from 'path';
import type { SessionBackend } from '@shimbrowser/core/session-registry';
import type { RuleState, SetWitnessState } from '@shimbrowser/core/shim-folder';
import {
  createShimSessionBackend, pageAway, unsupportedEvidence as sessionUnsupportedEvidence,
  type ShimSessionSource, type ShimSessionTarget, type ShimSessionHandle, type ShimSessionPage,
} from '@shimbrowser/core/shim-session';
import type { UnsupportedFeature } from '@shimbrowser/core/capability-preflight';
import { REQUIRES_SHIM_BROWSER } from './playwright-page-host';
import {
  runInteract, locateScript, OBSERVE_START_SCRIPT, OBSERVE_READ_SCRIPT, type InteractDeps,
} from '@shimbrowser/core/interact';

export {
  SESSION_SETTLE_MS as HEADLESS_SETTLE_MS, MAX_RELOADS_PER_SESSION, BROWSER_ONLY_PAGE_TOOLS, hostPatternMatches, newShimSpec, newShimId,
  offMatchWarning, withOffMatch,
} from '@shimbrowser/core/shim-session';

/** One page a session works on, and how to let go of it. */
export type HeadlessSessionPage = ShimSessionPage;

/** What a headless session starts from: the shim as committed, and the file commits write. */
export interface HeadlessShimSource extends ShimSessionSource {
  /** Absolute path of the `.shim` file commits write. */
  shimFile: string;
}

/** The registry's `target` for a headless session. */
export type HeadlessTarget = ShimSessionTarget<HeadlessShimSource>;

export type HeadlessHandle = ShimSessionHandle<HeadlessShimSource>;

export interface HeadlessBackendOptions {
  settleMs?: number;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** Where commits are written (default: fs, atomically). */
  writeShimFile?(file: string, content: string): void;
  /** See ShimSessionDeps.seedWitnesses. */
  seedWitnesses?: Record<string, RuleState>;
  /** See ShimSessionDeps.seedAnchors. */
  seedAnchors?: Record<string, string>;
  /** See ShimSessionDeps.seedSetWitnesses. */
  seedSetWitnesses?: Record<string, SetWitnessState>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

const UNSUPPORTED_DETAIL = 'headless mode supports a subset of shim features (hide, restyle, reorder, reshape, script, ' +
  'inject-element, inject-html, remove, replace-root; api.storage and api.cleanup). Nothing was applied. ' +
  'Remove what is listed, or author this shim in the Shim browser.';

/**
 * What headless says about a bot wall: it can't get past one, and does not
 * try (no disguised user agent, no hidden automation flag, no solved
 * challenge). The Shim browser is a browser the site may let in.
 */
export const HEADLESS_BOT_WALL_ADVICE = 'Headless Chromium says it is automated and the site refused it; Shim does not disguise it. ' +
  'Author this shim in an attach session in the Shim browser instead.';

/** The evidence for a preflight refusal. */
export function unsupportedEvidence(unsupported: UnsupportedFeature[]): Record<string, unknown> {
  return sessionUnsupportedEvidence(unsupported, UNSUPPORTED_DETAIL);
}

export function createHeadlessShimBackend(options: HeadlessBackendOptions = {}): SessionBackend<HeadlessHandle> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const writeShimFile = options.writeShimFile ?? writeAtomic;
  return createShimSessionBackend<HeadlessShimSource>({
    ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
    now,
    sleep,
    ...(options.seedWitnesses ? { seedWitnesses: options.seedWitnesses } : {}),
    ...(options.seedAnchors ? { seedAnchors: options.seedAnchors } : {}),
    ...(options.seedSetWitnesses ? { seedSetWitnesses: options.seedSetWitnesses } : {}),
    unsupportedError: REQUIRES_SHIM_BROWSER,
    unsupportedDetail: UNSUPPORTED_DETAIL,
    unsupportedNote: (ruleId, member) => `rule "${ruleId}" used api.${member}, which headless mode does not provide (${REQUIRES_SHIM_BROWSER}) — its result is partial`,
    botWallAdvice: HEADLESS_BOT_WALL_ADVICE,
    // Headless has no installed shims: the committed rules run as previews.
    previewCommittedAtBegin: true,
    // match.hosts is editable here: headless has no Shim to ask, so it writes
    // the widened file and says plainly that nobody approved the new sites.
    matchEditable: true,
    previewWidenNote: (widened) => `match.hosts now also covers ${widened.join(', ')}. Nobody approved that here: headless has no Shim to ask. ` +
      'Shim shows every site a .shim runs on when it is imported, and the person decides there',
    commitWidenNote: (widened) => `this commit runs the shim on new sites: ${widened.join(', ')}. Nobody approved them here — ` +
      'tell the user; Shim lists every site when they import the file',
    interact: (handle, input, signal) => interactPage(handle, input, signal, { now, sleep }),
    async writeCommit(handle, prepared) {
      try {
        writeShimFile(handle.source.shimFile, `${JSON.stringify(prepared.file, null, 2)}\n`);
      } catch (e) {
        return { ok: false, error: 'commit-failed', detail: `could not write ${handle.source.shimFile}: ${errMessage(e)}` };
      }
      return { ok: true, versionId: prepared.version };
    },
  });
}

// Frame tags interact_page never sends input into (top frame only).
const FRAME_TAGS = new Set(['iframe', 'frame', 'object', 'embed']);
// Both follow open shadow roots down to the element that really takes the
// input: a frame inside a web component is still a frame. (A closed shadow
// root can't be looked into — an accepted residual.)
const frameAtPointScript = (x: number, y: number): string => `(() => {
  const X = ${JSON.stringify(x)}, Y = ${JSON.stringify(y)};
  let h = document.elementFromPoint(X, Y);
  for (let i = 0; h && h.shadowRoot && i < 32; i++) { const inner = h.shadowRoot.elementFromPoint(X, Y); if (!inner || inner === h) break; h = inner; }
  return !!h && ['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(h.tagName);
})()`;
// true when the remembered target is still connected, enabled and what
// the point hits (it or a descendant); else what the point hits instead.
const targetAtPointScript = (x: number, y: number): string => `(() => {
  const t = globalThis.__shimHeadlessTarget;
  if (!t || !t.isConnected) return 'nothing (the target left the page)';
  if (t.matches(':disabled')) return 'a disabled target';
  const h = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
  if (h && (h === t || t.contains(h))) return true;
  return h ? h.tagName.toLowerCase() + (h.id ? '#' + h.id : '') : 'nothing hit-testable';
})()`;
// true when the deep focused element is the remembered target or inside it.
const FOCUS_ON_TARGET_SCRIPT = `(() => {
  const t = globalThis.__shimHeadlessTarget;
  let a = document.activeElement;
  for (let i = 0; a && a.shadowRoot && a.shadowRoot.activeElement && i < 32; i++) a = a.shadowRoot.activeElement;
  return !!t && t.isConnected && !!a && (a === t || t.contains(a));
})()`;
// Sets the remembered <select> (connected, still visible) to `value` and
// fires input + change.
const rememberedSelectScript = (value: string): string => `(() => {
  const el = globalThis.__shimHeadlessTarget;
  if (!el || !el.isConnected) return { error: 'the <select> left the page before the option was set' };
  if (el.tagName !== 'SELECT') return { error: 'the target is not a <select> — use click' };
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  if (!(r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none')) return { error: 'the <select> is no longer visible' };
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!top || !(top === el || el.contains(top))) return { error: 'the <select> is covered by ' + (top ? top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') : 'nothing hit-testable') + ' — nothing was set' };
  const want = ${JSON.stringify(value)};
  const opt = Array.from(el.options).find((o) => o.value === want || o.text.trim() === want);
  if (!opt) return { error: 'no option ' + JSON.stringify(want) };
  if (el.matches(':disabled') || opt.matches(':disabled')) return { error: 'option ' + JSON.stringify(want) + ' is disabled — a user could not pick it' };
  el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()`;
const FOCUS_IN_FRAME_SCRIPT = `(() => {
  let a = document.activeElement;
  for (let i = 0; a && a.shadowRoot && a.shadowRoot.activeElement && i < 32; i++) a = a.shadowRoot.activeElement;
  return !!a && ['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(a.tagName);
})()`;

// interact_page, headless: the whole page (scope "page"), top frame only —
// the agent's own browser, no logins, a page it named. Trusted input
// through the host; a popup the batch causes is closed on creation and
// reported (a weaker guarantee than the browser's deny at creation). The
// page's requests are not observed, and the report says so.
async function interactPage(handle: HeadlessHandle, input: unknown, signal: AbortSignal, clock: { now(): number; sleep(ms: number): Promise<void> }): Promise<unknown> {
  const host = handle.host;
  const send = host.input?.bind(host);
  if (!send) return { error: 'interaction-unavailable', detail: 'this page cannot take trusted input' };
  let token: string | null = null;
  let point: { x: number; y: number } | null = null;
  const popups: string[] = [];
  const offPopup = host.onPopup?.((url) => { popups.push(url || 'a new window'); }) ?? (() => {});
  const engine = async (code: string): Promise<unknown> => host.evaluate(code, 'engine');
  const deps: InteractDeps = {
    guard: () => pageAway(handle),
    // A new document (its token) or a same-document URL change ends the batch.
    // The token and URL, plus the host's navigation count when it has one:
    // a navigation that has started but not committed yet (a slow page)
    // already moves it, and so does one away and back during a settle.
    currentDocument: () => (token === null ? null : `${token} ${host.url()} ${host.navigationCount?.() ?? ''}`),
    async syncDocument() { token = await host.documentToken(); },
    policy: {
      accepts: (doc) => doc !== null,
      refused: { error: 'no-document', detail: 'the page has no document to drive yet — try again once it has loaded' },
      lost: 'the page navigated',
      stopped: 'the session ended',
      unavailable: 'trusted input could not be sent to the page',
    },
    aborted: () => signal.aborted || host.isClosed(),
    async locate(selector) {
      point = null;
      try {
        // Located and remembered in one synchronous script (the press is
        // later checked against THIS element, never a fresh match).
        const raw = await engine(`(() => { const r = ${locateScript(selector)}; globalThis.__shimHeadlessTarget = r && r.count === 1 ? document.querySelector(${JSON.stringify(selector)}) : null; return r; })()`);
        if (!isRecord(raw)) return { error: 'the page could not be read' };
        const loc = raw as unknown as Awaited<ReturnType<InteractDeps['locate']>>;
        if ('error' in loc || loc.count !== 1 || typeof loc.x !== 'number' || typeof loc.y !== 'number') return loc;
        // Top frame only: a frame (or a frame inside the selected element,
        // where the press would land) is refused before any input.
        const frame = await engine(frameAtPointScript(loc.x, loc.y));
        if (FRAME_TAGS.has(String(loc.tag)) || frame === true) {
          return { ...loc, refused: `frame-unsupported: ${selector} is (or puts the press on) a frame; interact_page reaches only the top frame` };
        }
        point = { x: loc.x, y: loc.y };
        return loc;
      } catch (e) {
        return { error: e instanceof Error ? e.message : 'the page could not be read' };
      }
    },
    // Re-checked at the press, the release and every key: input never goes
    // into a child frame (a frame that moved under the point, or a frame
    // holding the focus).
    async boundaryCheck(command, action) {
      const kind = String(command.params.type ?? '');
      // A wheel goes to whatever is under its own point: a frame there
      // would take the scroll.
      if (command.method === 'Input.dispatchMouseEvent' && kind === 'mouseWheel') {
        const x = Number(command.params.x), y = Number(command.params.y);
        if ((await engine(frameAtPointScript(x, y)).catch(() => true)) === true) {
          return 'frame-unsupported: the scroll would land on a frame — the rest was not sent';
        }
        return null;
      }
      if (command.method === 'Input.dispatchMouseEvent' && (kind === 'mousePressed' || kind === 'mouseReleased')) {
        if (!point) return null;
        if ((await engine(frameAtPointScript(point.x, point.y)).catch(() => true)) === true) {
          return 'frame-unsupported: the press would land on a frame — the rest was not sent';
        }
        // Still the located element under the point: a hover menu or a
        // layout shift since locating must not take the click.
        const hit = await engine(targetAtPointScript(point.x, point.y)).catch(() => null);
        return hit === true ? null : `the press would land on ${typeof hit === 'string' ? hit : 'something else'}, not the target (an overlay or a layout shift moved in) — the rest was not sent`;
      }
      if (command.method === 'Input.dispatchKeyEvent' || command.method === 'Input.insertText') {
        if ((await engine(FOCUS_IN_FRAME_SCRIPT).catch(() => true)) === true) {
          return 'frame-unsupported: the focus is inside a frame — keys and text reach only the top frame';
        }
        // Typing (its clear and its text) goes to the located field and
        // nowhere else: a focus handler that moved focus stops it.
        if ('type' in action && (await engine(FOCUS_ON_TARGET_SCRIPT).catch(() => false)) !== true) {
          return 'the focus moved off the target before the text went out — the rest was not sent';
        }
      }
      return null;
    },
    async selectValue(_selector, value) {
      try {
        // The element located (and checked visible, uncovered) for this
        // action, never a fresh match; one that left the page — replaced,
        // or gone with a reload — is refused.
        const pinnedToken = token;
        token = await host.documentToken();
        if (token !== pinnedToken) return { error: 'the page changed before the option was set' };
        const out = await engine(rememberedSelectScript(value));
        if (isRecord(out) && out.ok === true) return { ok: true };
        return { error: isRecord(out) && typeof out.error === 'string' ? out.error : 'the option could not be set' };
      } catch (e) {
        return { error: e instanceof Error ? e.message : 'the option could not be set' };
      }
    },
    async dispatch(commands, pin) {
      // The document is read afresh before every command: a reload to the
      // same URL between two commands changes only the token, and the
      // rest of the action must not reach the new document.
      const result = await send(commands, async (i) => {
        token = await host.documentToken();
        return pin.before(i);
      });
      if (result.outcome === 'done') return true;
      if (result.outcome === 'stopped') {
        const why = pin.reason();
        return why ? { stopped: why } : false;
      }
      if (result.sent === 0) throw new Error(result.error);
      return { stopped: `interaction-unavailable: ${result.error} — the rest of the action's input was not sent` };
    },
    async viewport() {
      const raw = await engine('({ width: window.innerWidth, height: window.innerHeight, scrollY: window.scrollY })').catch(() => null);
      if (!isRecord(raw) || typeof raw.width !== 'number' || typeof raw.height !== 'number' || typeof raw.scrollY !== 'number') return null;
      return { width: raw.width, height: raw.height, scrollY: raw.scrollY };
    },
    wait: (ms) => clock.sleep(ms),
    async startObserving() { await engine(OBSERVE_START_SCRIPT); },
    async readObserved() {
      const n = await engine(OBSERVE_READ_SCRIPT);
      return typeof n === 'number' ? n : null;
    },
    consoleErrorsSince: (ts) => handle.console.ring()
      .filter((e) => e.ts >= ts && e.level === 'error')
      .map((e) => e.message.slice(0, 300)),
    linkCursor: () => popups.length,
    linksSince: (cursor) => popups.slice(cursor),
    scope: 'page',
    now: () => clock.now(),
    mac: process.platform === 'darwin',
  };
  try {
    return await runInteract(input, deps, { scroll: true });
  } finally {
    offPopup();
  }
}

