// interact_page's batch runner: drive a page the way a user would (click,
// type, pick an option, press a key, scroll a little) so a requirement about
// behaviour has evidence. Pure over its deps; a host supplies trusted input
// and the isolated-world reads (the page-side scripts below are what it runs).
//
// One runner for every session kind, behind a **document policy**: the
// session decides which documents may take input and how a refusal reads
// (a composition build requires a document its turn loaded; another session
// supplies its own identity). A session may also narrow what may be
// targeted (`locate` refuses), re-check each dispatch boundary
// (`boundaryCheck`), stop on the user's own input (`interrupted`) and stream
// each step (`onStep`). Everything else is shared.
//
// Invariants:
//   - Input only ever reaches a document the policy accepts: each action
//     pins the document it located its target in, and re-checks the page
//     still shows that document, and that the policy still accepts it,
//     right before every command. A navigation, a stop, a page-away guard
//     answer, a refused document, a failed boundary check or the user's own
//     input ends the batch; the rest is reported as not run.
//   - A selector must match exactly one visible, enabled, uncovered element —
//     nothing is clicked by guess.
//   - The report is facts the host observed (DOM changes, console errors,
//     calls the page made, links it tried to open), never the page's own
//     account. Calls a host does not observe are reported as not observed
//     (`calls: null`), never as none. Steps that completed stay in the
//     report when a later one fails.

import type { PageInputCommand } from './page-host';

export const MAX_ACTIONS = 10;
export const MAX_TEXT = 2000;
export const DEFAULT_SETTLE_MS = 300;
export const MAX_SETTLE_MS = 3000;
/** The largest scroll one action sends, in CSS px either way; a larger request is capped. */
export const MAX_SCROLL_PX = 1500;
/**
 * How long a scroll step waits, at most, for the page to finish moving
 * before it reads the result. A wheel scroll is applied asynchronously (and
 * animated where smooth scrolling is on), so the step polls until the offset
 * has moved and then held still, and the next action never starts on a page
 * still in motion.
 */
export const SCROLL_SETTLE_MS = 3000;
const SCROLL_POLL_MS = 100;

/**
 * Keys `press` accepts, with the CDP key-event fields each needs. `key` is
 * the DOM KeyboardEvent.key value when it differs from the action name (a
 * real spacebar sends " ", not "Space").
 */
export const KEYS: Readonly<Record<string, { code: string; keyCode: number; text?: string; key?: string }>> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
};

export type InteractAction =
  | { click: string }
  | { type: string; text: string; clear: boolean }
  | { select: string; value: string }
  | { press: string }
  | { scroll: { by: number } };

/** Which action kinds a session accepts beyond click / type / select / press. */
export interface InteractParseOptions {
  /** `{ "scroll": { "by": px } }`: a small relative scroll of the viewport. */
  scroll?: boolean;
}

/** What locating a selector found (the isolated world's answer). */
export type LocateResult =
  | { error: string }
  | {
    count: number; x?: number; y?: number; visible?: boolean; covered?: string | null; disabled?: boolean; tag?: string; editable?: boolean;
    /** The session refuses this target, and why (`<code>: <detail>`). */
    refused?: string;
  };

/** One CDP input command (Input.dispatchMouseEvent / dispatchKeyEvent / insertText). */
export type CdpCommand = PageInputCommand;

/** A document's identity as the host reports it; compared with `===`. */
export type InteractDocument = number | string;

/**
 * Which documents may take input, and how the refusals read. A composition
 * build accepts only documents its turn loaded.
 */
export interface InteractDocumentPolicy {
  /** True when `doc` may take input. */
  accepts(doc: InteractDocument | null): boolean;
  /** The answer when the page's document is refused before any action. */
  refused: { error: string; detail: string };
  /** A step's error when the document stops being accepted mid-batch. */
  lost: string;
  /** A step's error when the batch is aborted. */
  stopped: string;
  /** `interaction-unavailable`'s detail. */
  unavailable: string;
}

/**
 * The checks a dispatch runs before every command: `now()` (synchronous:
 * same document, not stopped, no user input) and `before(i)` (`now()` plus
 * the session's boundary check for command `i`). When either answers false,
 * `reason()` says why.
 */
export interface InteractPin {
  now(): boolean;
  before(index: number): Promise<boolean>;
  reason(): string | null;
}

/** How a dispatch ended: every command sent (true), or stopped before one (false, or why). */
export type DispatchResult = boolean | { stopped: string };

/** One step as it starts and as it ends, for a live activity line. */
export interface InteractStepEvent {
  index: number;
  action: string;
  phase: 'start' | 'done';
  ok?: boolean;
  error?: string;
}

export interface InteractDeps {
  /** A page-away (or missing page) error, or null when the page may be used. */
  guard(): { error: string; detail?: string } | null;
  currentDocument(): InteractDocument | null;
  /** Refreshes what `currentDocument` reads, when the host's identity needs an async read. Awaited before each action and after each settle. */
  syncDocument?(): Promise<void>;
  policy: InteractDocumentPolicy;
  aborted(): boolean;
  /** The user's own input on the page during the batch: once true, the batch stops. */
  interrupted?(): boolean;
  locate(selector: string, action: InteractAction): Promise<LocateResult>;
  /**
   * Sets a <select>'s value and fires input + change (a native popup can't
   * be driven by synthetic mouse input).
   */
  selectValue(selector: string, value: string): Promise<{ ok: true } | { error: string }>;
  /**
   * Sends trusted input, awaiting `pin.before(i)` before EACH command and
   * stopping the moment it answers false — a mousedown or focus handler can
   * navigate, move focus or cover the target mid-action. Throws when the
   * input channel is unavailable.
   */
  dispatch(commands: CdpCommand[], pin: InteractPin): Promise<DispatchResult>;
  /**
   * The session's own check right before `command` goes out (the hit test
   * before a press, focus before typing): null to proceed, else why not.
   */
  boundaryCheck?(command: CdpCommand, action: InteractAction): Promise<string | null>;
  /**
   * The viewport's size and scroll offset (CSS px), for a scroll step, and
   * how many wheel units one CSS px takes (the page zoom where a host's wheel
   * deltas are in device-independent px; default 1). Absent: scroll is refused.
   */
  viewport?(): Promise<{ width: number; height: number; scrollY: number; wheelScale?: number } | null>;
  wait(ms: number): Promise<void>;
  /** DOM change counting in the current document, from the batch's start. */
  startObserving(): Promise<void>;
  readObserved(): Promise<number | null>;
  consoleErrorsSince(ts: number): string[];
  /**
   * The call trace's length now (a cursor), and the calls recorded after one.
   * Absent: the host does not observe the page's requests, and the report
   * says so (`calls: null`, `traffic: "not observed"`).
   */
  callCursor?(): number;
  callsSince?(cursor: number): string[];
  linkCursor(): number;
  linksSince(cursor: number): string[];
  /** Request-burst / rate-limit warnings that hold right now. Absent: none are reported. */
  requestWarnings?(): string[];
  /** Each step's start and end, for a live activity line. */
  onStep?(event: InteractStepEvent): void;
  /** What a target may be, reported on the result: this shim's own output, or the whole page. */
  scope?: 'shim-dom' | 'page';
  now(): number;
  /** Select-all is Meta+A on macOS, Ctrl+A elsewhere. */
  mac: boolean;
}

export interface InteractStepReport {
  action: string;
  ok: boolean;
  error?: string;
  navigated?: true;
  /** A <select> is set through the DOM, not by trusted input. */
  trusted?: false;
  /** A scroll step: what was asked, what was sent (capped), how far the page actually moved. */
  scrolled?: { requested: number; sent: number; observed: number | null };
}

export interface InteractReport {
  steps: InteractStepReport[];
  notRun: number;
  domChanges: number | null;
  consoleErrors: string[];
  /** The calls the page made, or null when the host does not observe them (see `traffic`). */
  calls: string[] | null;
  /** Present when `calls` is null: the page's requests are not observed, so nothing is claimed about them. */
  traffic?: 'not observed';
  linksNotOpened: string[];
  /** Too many requests to one site, or answers that look like a rate limit. */
  requestWarnings?: string[];
  /** What a target may be: this shim's own output, or the whole page. */
  scope?: 'shim-dom' | 'page';
  /** The user's own input on the page stopped the batch. */
  interrupted?: 'user';
  note?: string;
}

export function parseInteractInput(input: unknown, options: InteractParseOptions = {}): { actions: InteractAction[]; settleMs: number } | { error: string } {
  const rec = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const raw = rec.actions;
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'actions must be a non-empty array' };
  if (raw.length > MAX_ACTIONS) return { error: `at most ${MAX_ACTIONS} actions per call` };
  const kindNames = options.scroll ? ['click', 'type', 'select', 'press', 'scroll'] : ['click', 'type', 'select', 'press'];
  const actions: InteractAction[] = [];
  for (const [i, a] of raw.entries()) {
    const r = typeof a === 'object' && a !== null ? a as Record<string, unknown> : {};
    const kinds = kindNames.filter((k) => k in r);
    if (kinds.length !== 1) return { error: `action ${i + 1}: give exactly one of ${kindNames.join(', ')}` };
    const str = (k: string): string | null => (typeof r[k] === 'string' && (r[k] as string).length > 0 ? r[k] as string : null);
    if ('click' in r) {
      const sel = str('click');
      if (!sel) return { error: `action ${i + 1}: click needs a selector` };
      actions.push({ click: sel });
    } else if ('type' in r) {
      const sel = str('type');
      if (!sel || typeof r.text !== 'string') return { error: `action ${i + 1}: type needs a selector and text` };
      if (r.text.length > MAX_TEXT) return { error: `action ${i + 1}: text is over ${MAX_TEXT} characters` };
      actions.push({ type: sel, text: r.text, clear: r.clear === true });
    } else if ('select' in r) {
      const sel = str('select');
      if (!sel || typeof r.value !== 'string') return { error: `action ${i + 1}: select needs a selector and value` };
      actions.push({ select: sel, value: r.value });
    } else if ('scroll' in r) {
      const s = typeof r.scroll === 'object' && r.scroll !== null ? r.scroll as Record<string, unknown> : {};
      if (typeof s.by !== 'number' || !Number.isFinite(s.by) || Math.round(s.by) === 0) {
        return { error: `action ${i + 1}: scroll takes { "by": px } — a non-zero number, positive down, negative up` };
      }
      actions.push({ scroll: { by: Math.round(s.by) } });
    } else {
      const key = str('press');
      if (!key || !(key in KEYS)) return { error: `action ${i + 1}: press takes one of ${Object.keys(KEYS).join(', ')}` };
      actions.push({ press: key });
    }
  }
  const settle = typeof rec.settleMs === 'number' && Number.isFinite(rec.settleMs) ? Math.round(rec.settleMs) : DEFAULT_SETTLE_MS;
  return { actions, settleMs: Math.min(Math.max(settle, 0), MAX_SETTLE_MS) };
}

export function describeAction(a: InteractAction): string {
  if ('click' in a) return `click ${a.click}`;
  if ('type' in a) return `type into ${a.type}`;
  if ('select' in a) return `select "${a.value}" in ${a.select}`;
  if ('scroll' in a) return `scroll ${a.scroll.by > 0 ? 'down' : 'up'} ${Math.abs(a.scroll.by)}px`;
  return `press ${a.press}`;
}

/** The activity line for a batch ("clicked .note-icon, typed into textarea"). */
export function interactActivity(input: unknown, options: InteractParseOptions = {}): string | null {
  const parsed = parseInteractInput(input, options);
  if ('error' in parsed) return null;
  return parsed.actions.map((a) => {
    if ('click' in a) return `clicked ${a.click}`;
    if ('type' in a) return `typed into ${a.type}`;
    if ('select' in a) return `picked ${a.value}`;
    if ('scroll' in a) return `scrolled ${a.scroll.by > 0 ? 'down' : 'up'}`;
    return `pressed ${a.press}`;
  }).join(', ');
}

/** A trusted left click at viewport (x, y): move, press, release. */
export function clickCommands(x: number, y: number): CdpCommand[] {
  const base = { x, y, button: 'left', clickCount: 1 };
  return [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', ...base } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', ...base } },
  ];
}

/** A trusted press of one of KEYS (down, up). */
export function keyCommands(key: string): CdpCommand[] {
  const k = KEYS[key];
  if (!k) return [];
  // A key that types a character goes down as 'keyDown' with its text (so
  // Enter submits a form); the rest as 'rawKeyDown'.
  const domKey = k.key ?? key;
  const down: Record<string, unknown> = { type: k.text ? 'keyDown' : 'rawKeyDown', key: domKey, code: k.code, windowsVirtualKeyCode: k.keyCode };
  if (k.text) down.text = k.text;
  return [
    { method: 'Input.dispatchKeyEvent', params: down },
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: domKey, code: k.code, windowsVirtualKeyCode: k.keyCode } },
  ];
}

/**
 * Select-all in the focused field. The editing command is named outright: a
 * Meta/Ctrl+A key event alone doesn't select over CDP on macOS.
 */
export function selectAllCommands(mac: boolean): CdpCommand[] {
  const modifiers = mac ? 4 : 2;
  return [
    { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers, commands: ['selectAll'] } },
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers } },
  ];
}

/** A trusted wheel at viewport (x, y), `deltaY` CSS px (positive scrolls down). */
export function wheelCommand(x: number, y: number, deltaY: number): CdpCommand {
  return { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x, y, deltaX: 0, deltaY } };
}

// Why a located target can't take input, or null when it can. Typing needs a
// field a user could type into. A session's refusal comes first: what may be
// targeted at all is decided before whether it can take input.
function targetProblem(loc: LocateResult, selector: string, typing = false): string | null {
  if ('error' in loc) return loc.error;
  if (loc.count === 0) return `no element matches ${selector}`;
  if (loc.count > 1) return `${loc.count} elements match ${selector} — make the selector unique`;
  if (loc.refused) return loc.refused;
  if (loc.visible !== true || typeof loc.x !== 'number' || typeof loc.y !== 'number') return `${selector} is not visible`;
  if (loc.disabled === true) return `${selector} is disabled`;
  if (loc.covered) return `${selector} is covered by ${loc.covered} — close or scroll it out of the way first`;
  if (typing && loc.editable !== true) return `${selector} is not a field you can type into (a ${loc.tag ?? 'element'} that is not an enabled, writable text input, textarea or contenteditable)`;
  return null;
}

export async function runInteract(
  input: unknown,
  deps: InteractDeps,
  options: InteractParseOptions = {},
): Promise<InteractReport | { error: string; detail?: string }> {
  const parsed = parseInteractInput(input, options);
  if ('error' in parsed) return parsed;
  const { policy } = deps;
  const away = deps.guard();
  if (away) return away;
  await deps.syncDocument?.();
  // The batch's document: every action runs against it, and any change —
  // even one between two actions — ends the batch.
  const pinned = deps.currentDocument();
  if (!policy.accepts(pinned)) return { ...policy.refused };
  const startedAt = deps.now();
  const linkCursor = deps.linkCursor();
  const callCursor = deps.callCursor?.() ?? null;
  try { await deps.startObserving(); } catch { /* counting is best-effort */ }

  const steps: InteractStepReport[] = [];
  let stopped = false;
  let interrupted = false;
  const USER_INPUT = 'stopped: the user used the page (their own keyboard or mouse input) — the rest was not sent';
  for (const [index, action] of parsed.actions.entries()) {
    if (stopped) break;
    const label = describeAction(action);
    const finish = (step: InteractStepReport): void => {
      steps.push(step);
      deps.onStep?.({ index, action: label, phase: 'done', ok: step.ok, ...(step.error ? { error: step.error } : {}) });
    };
    const fail = (error: string): void => { finish({ action: label, ok: false, error }); stopped = true; };
    if (deps.aborted()) { fail(policy.stopped); break; }
    if (deps.interrupted?.()) { interrupted = true; fail(USER_INPUT); break; }
    const away2 = deps.guard();
    if (away2) { fail(away2.detail ?? away2.error); break; }
    await deps.syncDocument?.();
    if (deps.currentDocument() !== pinned) {
      // The page moved on between actions: the last one navigated (or, before
      // the first, the document was lost). Nothing more runs.
      const last = steps[steps.length - 1];
      if (last) { last.navigated = true; break; }
      fail(policy.lost);
      break;
    }
    if (!policy.accepts(pinned)) { fail(policy.lost); break; }
    deps.onStep?.({ index, action: label, phase: 'start' });

    // Checked immediately before every command: same document, still
    // accepted, not stopped, no user input — and the session's own boundary
    // check for that command.
    let reason: string | null = null;
    const pinNow = (): boolean => {
      if (deps.aborted()) { reason = policy.stopped; return false; }
      if (deps.interrupted?.()) { interrupted = true; reason = USER_INPUT; return false; }
      if (deps.currentDocument() !== pinned || !policy.accepts(pinned)) { reason = null; return false; }
      return true;
    };
    const pinFor = (commands: CdpCommand[]): InteractPin => ({
      now: pinNow,
      async before(i) {
        if (!pinNow()) return false;
        const command = commands[i];
        if (command && deps.boundaryCheck) {
          const problem = await deps.boundaryCheck(command, action);
          if (problem) { reason = problem; return false; }
          if (!pinNow()) return false;
        }
        return true;
      },
      reason: () => reason,
    });
    const stopReason = (result: DispatchResult, fallback: string): string | null => {
      if (result === true) return null;
      if (typeof result === 'object') return result.stopped;
      return reason ?? fallback;
    };
    try {
      if ('select' in action) {
        const loc = await deps.locate(action.select, action);
        const problem = targetProblem(loc, action.select);
        if (problem) { fail(problem); break; }
        if (!pinNow()) { fail(reason ?? 'the page changed before the action ran'); break; }
        const set = await deps.selectValue(action.select, action.value);
        if ('error' in set) { fail(set.error); break; }
        finish({ action: label, ok: true, trusted: false });
      } else if ('press' in action) {
        if (!pinNow()) { fail(reason ?? 'the page changed before the action ran'); break; }
        const commands = keyCommands(action.press);
        const why = stopReason(await deps.dispatch(commands, pinFor(commands)), 'the page changed during the action');
        if (why) { fail(why); break; }
        finish({ action: label, ok: true });
      } else if ('scroll' in action) {
        if (!deps.viewport) { fail('scrolling is not available here'); break; }
        const before = await deps.viewport();
        if (!before) { fail('the page\'s viewport could not be read'); break; }
        if (!pinNow()) { fail(reason ?? 'the page changed before the action ran'); break; }
        const sent = Math.max(-MAX_SCROLL_PX, Math.min(MAX_SCROLL_PX, action.scroll.by));
        const scale = typeof before.wheelScale === 'number' && before.wheelScale > 0 ? before.wheelScale : 1;
        const commands = [wheelCommand(Math.round(before.width / 2), Math.round(before.height / 2), Math.round(sent * scale))];
        const why = stopReason(await deps.dispatch(commands, pinFor(commands)), 'the page changed during the action');
        if (why) { fail(why); break; }
        // Poll: moved, then held still for one interval (or the deadline).
        let after: { scrollY: number } | null = null;
        let last: number | null = null;
        for (let waited = 0; waited < SCROLL_SETTLE_MS; waited += SCROLL_POLL_MS) {
          await deps.wait(SCROLL_POLL_MS);
          if (deps.currentDocument() !== pinned) { after = null; break; }
          after = await deps.viewport();
          if (!after) break;
          if (after.scrollY !== before.scrollY && last === after.scrollY) break;
          last = after.scrollY;
        }
        finish({ action: label, ok: true, scrolled: { requested: action.scroll.by, sent, observed: after ? Math.round(after.scrollY - before.scrollY) : null } });
      } else {
        const selector = 'click' in action ? action.click : action.type;
        const loc = await deps.locate(selector, action);
        const problem = targetProblem(loc, selector, 'type' in action);
        if (problem || 'error' in loc) { fail(problem ?? 'unavailable'); break; }
        if (!pinNow()) { fail(reason ?? 'the page changed before the action ran'); break; }
        const commands = clickCommands(loc.x as number, loc.y as number);
        if ('type' in action) {
          if (action.clear) commands.push(...selectAllCommands(deps.mac), ...keyCommands('Backspace'));
          if (action.text) commands.push({ method: 'Input.insertText', params: { text: action.text } });
        }
        const why = stopReason(await deps.dispatch(commands, pinFor(commands)), 'the page changed during the action — the rest of its input was not sent');
        if (why) { fail(why); break; }
        finish({ action: label, ok: true });
      }
    } catch {
      // Nothing completed yet: the call itself failed. Otherwise the steps
      // that did run stay in the report, and this one says why it stopped.
      if (steps.length === 0) return { error: 'interaction-unavailable', detail: policy.unavailable };
      fail(`interaction-unavailable: ${policy.unavailable}`);
      break;
    }
    await deps.wait(parsed.settleMs);
    await deps.syncDocument?.();
    if (deps.currentDocument() !== pinned) {
      const last = steps[steps.length - 1];
      if (last) last.navigated = true;
      stopped = true;
    }
  }

  const calls = callCursor !== null && deps.callsSince ? deps.callsSince(callCursor).slice(0, 10) : null;
  const report: InteractReport = {
    steps,
    notRun: parsed.actions.length - steps.length,
    domChanges: await deps.readObserved().catch(() => null),
    consoleErrors: deps.consoleErrorsSince(startedAt).slice(0, 5),
    calls,
    ...(calls === null ? { traffic: 'not observed' as const } : {}),
    linksNotOpened: deps.linksSince(linkCursor),
  };
  const warnings = deps.requestWarnings?.() ?? [];
  if (warnings.length > 0) report.requestWarnings = warnings;
  if (deps.scope) report.scope = deps.scope;
  if (interrupted) report.interrupted = 'user';
  if (report.steps.some((s) => s.navigated)) report.note = 'the page navigated; later actions did not run — the DOM change count restarted with the new document';
  return report;
}

// --- page-side scripts --------------------------------------------------------
//
// What a host runs in its isolated world (the DOM shared, the page's own
// globals unreachable) to serve `locate`, `selectValue` and DOM change
// counting. Each is a self-contained expression.

/**
 * Finds `selector`'s one element, scrolls it to the centre and measures its
 * centre in CSS pixels (what Input.dispatchMouseEvent takes), and whether
 * the hit test there lands on anything but the element or one of its own
 * descendants — an ancestor counts as covering it (the element doesn't take
 * pointer events, so a click there would go to that ancestor).
 */
export function locateScript(selector: string): string {
  return `(() => {
    let els;
    try { els = document.querySelectorAll(${JSON.stringify(selector)}); } catch (e) { return { error: 'invalid selector: ' + ${JSON.stringify(selector)} }; }
    if (els.length !== 1) return { count: els.length };
    const el = els[0];
    // 'instant': a smooth-scrolling page would still be mid-scroll when the
    // box and hit test below are measured.
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = visible ? document.elementFromPoint(x, y) : null;
    const covered = visible && (!top || !(top === el || el.contains(top)))
      ? (top ? top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') : 'nothing hit-testable') : null;
    // :disabled is the effective state — it covers a <fieldset disabled>
    // ancestor, which leaves the control's own .disabled false.
    const disabled = el.matches(':disabled');
    const TEXT_TYPES = ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'];
    const editable = el.isContentEditable === true
      || (el.tagName === 'TEXTAREA' && !el.readOnly && !disabled)
      || (el.tagName === 'INPUT' && !el.readOnly && !disabled && TEXT_TYPES.includes((el.getAttribute('type') || '').toLowerCase()));
    return { count: 1, x, y, visible, covered, disabled, tag: el.tagName.toLowerCase(), editable };
  })()`;
}

/** Sets a <select>'s value to the option matching `value` (by value or text) and fires input + change. */
export function selectScript(selector: string, value: string): string {
  return `(() => {
    let els;
    try { els = document.querySelectorAll(${JSON.stringify(selector)}); } catch (e) { return { error: 'invalid selector' }; }
    if (els.length !== 1) return { error: els.length + ' elements match ' + ${JSON.stringify(selector)} };
    const el = els[0];
    if (el.tagName !== 'SELECT') return { error: ${JSON.stringify(selector)} + ' is not a <select> — use click' };
    const want = ${JSON.stringify(value)};
    const opt = Array.from(el.options).find((o) => o.value === want || o.text.trim() === want);
    if (!opt) return { error: 'no option ' + JSON.stringify(want) + ' in ' + ${JSON.stringify(selector)} };
    if (el.matches(':disabled') || opt.matches(':disabled')) {
      return { error: 'option ' + JSON.stringify(want) + ' is disabled — a user could not pick it' };
    }
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`;
}

/** Starts (or restarts) counting DOM mutation records in the current document. */
export const OBSERVE_START_SCRIPT = `(() => {
  if (window.__shimInteract) window.__shimInteract.obs.disconnect();
  const state = { n: 0, obs: new MutationObserver((records) => { state.n += records.length; }) };
  state.obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  window.__shimInteract = state;
  return true;
})()`;
/** The mutation record count since OBSERVE_START_SCRIPT, or null when it never ran in this document. */
export const OBSERVE_READ_SCRIPT = '(() => (window.__shimInteract ? window.__shimInteract.n : null))()';
