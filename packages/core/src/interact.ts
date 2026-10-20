// interact_page's batch runner: drive a page the way a user would (click,
// type, pick an option, press a key) so a requirement about behaviour has
// evidence. Pure over its deps; a host supplies trusted input and the
// isolated-world reads (the page-side scripts below are what it runs).
//
// One runner for every session kind, behind a **document policy**: the
// session decides which documents may take input and how a refusal reads
// (a composition build requires a document its turn loaded; another session
// supplies its own identity). Everything else is shared.
//
// Invariants:
//   - Input only ever reaches a document the policy accepts: each action
//     pins the document it located its target in, and re-checks the page
//     still shows that document, and that the policy still accepts it,
//     right before dispatching. A navigation, a stop, a page-away guard
//     answer or a refused document ends the batch; the rest is reported as
//     not run.
//   - A selector must match exactly one visible, enabled, uncovered element —
//     nothing is clicked by guess.
//   - The report is facts the host observed (DOM changes, console errors,
//     calls the page made, links it tried to open), never the page's own
//     account.

export const MAX_ACTIONS = 10;
export const MAX_TEXT = 2000;
export const DEFAULT_SETTLE_MS = 300;
export const MAX_SETTLE_MS = 3000;

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
  | { press: string };

/** What locating a selector found (the isolated world's answer). */
export type LocateResult =
  | { error: string }
  | { count: number; x?: number; y?: number; visible?: boolean; covered?: string | null; disabled?: boolean; tag?: string; editable?: boolean };

/** One CDP input command (Input.dispatchMouseEvent / dispatchKeyEvent / insertText). */
export interface CdpCommand { method: string; params: Record<string, unknown> }

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

export interface InteractDeps {
  /** A page-away (or missing page) error, or null when the page may be used. */
  guard(): { error: string; detail?: string } | null;
  currentDocument(): InteractDocument | null;
  policy: InteractDocumentPolicy;
  aborted(): boolean;
  locate(selector: string): Promise<LocateResult>;
  /**
   * Sets a <select>'s value and fires input + change (a native popup can't
   * be driven by synthetic mouse input).
   */
  selectValue(selector: string, value: string): Promise<{ ok: true } | { error: string }>;
  /**
   * Sends trusted input, calling `stillPinned` before EACH command and
   * stopping (false) the moment it answers false — a mousedown or focus
   * handler can navigate mid-action. Throws when the input channel is
   * unavailable.
   */
  dispatch(commands: CdpCommand[], stillPinned: () => boolean): Promise<boolean>;
  wait(ms: number): Promise<void>;
  /** DOM change counting in the current document, from the batch's start. */
  startObserving(): Promise<void>;
  readObserved(): Promise<number | null>;
  consoleErrorsSince(ts: number): string[];
  /** The call trace's length now (a cursor), and the calls recorded after one. */
  callCursor(): number;
  callsSince(cursor: number): string[];
  linkCursor(): number;
  linksSince(cursor: number): string[];
  /** Request-burst / rate-limit warnings that hold right now. Absent: none are reported. */
  requestWarnings?(): string[];
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
}

export interface InteractReport {
  steps: InteractStepReport[];
  notRun: number;
  domChanges: number | null;
  consoleErrors: string[];
  calls: string[];
  linksNotOpened: string[];
  /** Too many requests to one site, or answers that look like a rate limit. */
  requestWarnings?: string[];
  note?: string;
}

export function parseInteractInput(input: unknown): { actions: InteractAction[]; settleMs: number } | { error: string } {
  const rec = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const raw = rec.actions;
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'actions must be a non-empty array' };
  if (raw.length > MAX_ACTIONS) return { error: `at most ${MAX_ACTIONS} actions per call` };
  const actions: InteractAction[] = [];
  for (const [i, a] of raw.entries()) {
    const r = typeof a === 'object' && a !== null ? a as Record<string, unknown> : {};
    const kinds = ['click', 'type', 'select', 'press'].filter((k) => k in r);
    if (kinds.length !== 1) return { error: `action ${i + 1}: give exactly one of click, type, select, press` };
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
  return `press ${a.press}`;
}

/** The activity line for a batch ("clicked .note-icon, typed into textarea"). */
export function interactActivity(input: unknown): string | null {
  const parsed = parseInteractInput(input);
  if ('error' in parsed) return null;
  return parsed.actions.map((a) => {
    if ('click' in a) return `clicked ${a.click}`;
    if ('type' in a) return `typed into ${a.type}`;
    if ('select' in a) return `picked ${a.value}`;
    return `pressed ${a.press}`;
  }).join(', ');
}

function clickCommands(x: number, y: number): CdpCommand[] {
  const base = { x, y, button: 'left', clickCount: 1 };
  return [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', ...base } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', ...base } },
  ];
}

function keyCommands(key: string): CdpCommand[] {
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

// Select-all in the focused field. The editing command is named outright: a
// Meta/Ctrl+A key event alone doesn't select over CDP on macOS.
function selectAllCommands(mac: boolean): CdpCommand[] {
  const modifiers = mac ? 4 : 2;
  return [
    { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers, commands: ['selectAll'] } },
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers } },
  ];
}

// Why a located target can't take input, or null when it can. Typing needs a
// field a user could type into.
function targetProblem(loc: LocateResult, selector: string, typing = false): string | null {
  if ('error' in loc) return loc.error;
  if (loc.count === 0) return `no element matches ${selector}`;
  if (loc.count > 1) return `${loc.count} elements match ${selector} — make the selector unique`;
  if (loc.visible !== true || typeof loc.x !== 'number' || typeof loc.y !== 'number') return `${selector} is not visible`;
  if (loc.disabled === true) return `${selector} is disabled`;
  if (loc.covered) return `${selector} is covered by ${loc.covered} — close or scroll it out of the way first`;
  if (typing && loc.editable !== true) return `${selector} is not a field you can type into (a ${loc.tag ?? 'element'} that is not an enabled, writable text input, textarea or contenteditable)`;
  return null;
}

export async function runInteract(input: unknown, deps: InteractDeps): Promise<InteractReport | { error: string; detail?: string }> {
  const parsed = parseInteractInput(input);
  if ('error' in parsed) return parsed;
  const { policy } = deps;
  const away = deps.guard();
  if (away) return away;
  if (!policy.accepts(deps.currentDocument())) return { ...policy.refused };
  const startedAt = deps.now();
  const linkCursor = deps.linkCursor();
  const callCursor = deps.callCursor();
  try { await deps.startObserving(); } catch { /* counting is best-effort */ }

  const steps: InteractStepReport[] = [];
  let stopped = false;
  for (const action of parsed.actions) {
    if (stopped) break;
    const label = describeAction(action);
    const fail = (error: string): void => { steps.push({ action: label, ok: false, error }); stopped = true; };
    if (deps.aborted()) { fail(policy.stopped); break; }
    const away2 = deps.guard();
    if (away2) { fail(away2.detail ?? away2.error); break; }
    const pinned = deps.currentDocument();
    if (!policy.accepts(pinned)) { fail(policy.lost); break; }

    // Checked immediately before input goes out: same document, still accepted.
    const stillPinned = (): boolean => !deps.aborted() && deps.currentDocument() === pinned && policy.accepts(pinned);
    try {
      if ('select' in action) {
        const loc = await deps.locate(action.select);
        const problem = targetProblem(loc, action.select);
        if (problem) { fail(problem); break; }
        if (!stillPinned()) { fail('the page changed before the action ran'); break; }
        const set = await deps.selectValue(action.select, action.value);
        if ('error' in set) { fail(set.error); break; }
        steps.push({ action: label, ok: true, trusted: false });
      } else if ('press' in action) {
        if (!stillPinned()) { fail('the page changed before the action ran'); break; }
        if (!(await deps.dispatch(keyCommands(action.press), stillPinned))) { fail('the page changed during the action'); break; }
        steps.push({ action: label, ok: true });
      } else {
        const selector = 'click' in action ? action.click : action.type;
        const loc = await deps.locate(selector);
        const problem = targetProblem(loc, selector, 'type' in action);
        if (problem || 'error' in loc) { fail(problem ?? 'unavailable'); break; }
        if (!stillPinned()) { fail('the page changed before the action ran'); break; }
        const commands = clickCommands(loc.x as number, loc.y as number);
        if ('type' in action) {
          if (action.clear) commands.push(...selectAllCommands(deps.mac), ...keyCommands('Backspace'));
          if (action.text) commands.push({ method: 'Input.insertText', params: { text: action.text } });
        }
        if (!(await deps.dispatch(commands, stillPinned))) { fail('the page changed during the action — the rest of its input was not sent'); break; }
        steps.push({ action: label, ok: true });
      }
    } catch {
      return { error: 'interaction-unavailable', detail: policy.unavailable };
    }
    await deps.wait(parsed.settleMs);
    if (deps.currentDocument() !== pinned) {
      const last = steps[steps.length - 1];
      if (last) last.navigated = true;
      stopped = true;
    }
  }

  const report: InteractReport = {
    steps,
    notRun: parsed.actions.length - steps.length,
    domChanges: await deps.readObserved().catch(() => null),
    consoleErrors: deps.consoleErrorsSince(startedAt).slice(0, 5),
    calls: deps.callsSince(callCursor).slice(0, 10),
    linksNotOpened: deps.linksSince(linkCursor),
  };
  const warnings = deps.requestWarnings?.() ?? [];
  if (warnings.length > 0) report.requestWarnings = warnings;
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
