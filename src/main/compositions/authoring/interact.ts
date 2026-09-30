// src/main/compositions/authoring/interact.ts — interact_page: the build
// worker drives its own preview the way a user would (click, type, pick an
// option, press a key), so a requirement about behaviour has evidence. Pure
// over its deps; the Electron half (interact-electron.ts) supplies trusted
// CDP input and the isolated-world reads.
//
// Invariants:
//   - Input only ever reaches a turn-bound document of the bound preview tab
//     (turn-loads.ts): each action pins the load it located its target in,
//     and re-checks the tab still shows that load, and that it is still an
//     open turn-bound one, right before dispatching. A navigation, a stop, a
//     page-away preview or a non-turn document ends the batch; the rest is
//     reported as not run.
//   - A selector must match exactly one visible, enabled, uncovered element —
//     nothing is clicked by guess.
//   - The report is facts the main process observed (DOM changes, console
//     errors, calls the page made, links it tried to open), never the page's
//     own account.

export const MAX_ACTIONS = 10;
export const MAX_TEXT = 2000;
export const DEFAULT_SETTLE_MS = 300;
export const MAX_SETTLE_MS = 3000;

// Keys `press` accepts, with the CDP key-event fields each needs.
export const KEYS: Readonly<Record<string, { code: string; keyCode: number; text?: string }>> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
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

// What locating a selector found (the isolated world's answer).
export type LocateResult =
  | { error: string }
  | { count: number; x?: number; y?: number; visible?: boolean; covered?: string | null; disabled?: boolean; tag?: string; editable?: boolean };

// One CDP command (Input.dispatchMouseEvent / dispatchKeyEvent / insertText).
export interface CdpCommand { method: string; params: Record<string, unknown> }

export interface InteractDeps {
  // A page-away (or missing tab) error, or null when the preview is on the composition.
  guard(): { error: string; detail?: string } | null;
  currentLoad(): number | null;
  // True when `loadId` is an open turn-bound load of this turn.
  isTurnDocument(loadId: number | null): boolean;
  aborted(): boolean;
  locate(selector: string): Promise<LocateResult>;
  // Sets a <select>'s value and fires input + change (a native popup can't
  // be driven by synthetic mouse input).
  selectValue(selector: string, value: string): Promise<{ ok: true } | { error: string }>;
  // Sends trusted input, calling `stillPinned` before EACH command and
  // stopping (false) the moment it answers false — a mousedown or focus
  // handler can navigate mid-action. Throws when the input channel is
  // unavailable.
  dispatch(commands: CdpCommand[], stillPinned: () => boolean): Promise<boolean>;
  wait(ms: number): Promise<void>;
  // DOM change counting in the current document, from the batch's start.
  startObserving(): Promise<void>;
  readObserved(): Promise<number | null>;
  consoleErrorsSince(ts: number): string[];
  // The call trace's length now (a cursor), and the calls recorded after one.
  callCursor(): number;
  callsSince(cursor: number): string[];
  linkCursor(): number;
  linksSince(cursor: number): string[];
  now(): number;
  // Select-all is Meta+A on macOS, Ctrl+A elsewhere.
  mac: boolean;
}

export interface InteractStepReport {
  action: string;
  ok: boolean;
  error?: string;
  navigated?: true;
  // A <select> is set through the DOM, not by trusted input.
  trusted?: false;
}

export interface InteractReport {
  steps: InteractStepReport[];
  notRun: number;
  domChanges: number | null;
  consoleErrors: string[];
  calls: string[];
  linksNotOpened: string[];
  note?: string;
}

// The calls a batch reports: trace entries after `cursor` made by one of the
// turn's own documents (the trace is composition-wide; another tab of the
// composition may be calling meanwhile).
export function turnCallsSince(
  entries: ReadonlyArray<{ loadId?: number; method: string; host: string; pathTemplate: string; operationName: string | null; status: number; ok: boolean }>,
  cursor: number,
  isTurnLoad: (loadId: number) => boolean,
): string[] {
  return entries.slice(cursor)
    .filter((e) => e.loadId !== undefined && isTurnLoad(e.loadId))
    .map((e) => `${e.method} ${e.host}${e.pathTemplate}${e.operationName ? ` (${e.operationName})` : ''} → ${e.status}${e.ok ? '' : ' (failed)'}`);
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

// The activity line for a batch ("clicked .note-icon, typed into textarea").
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
  const down: Record<string, unknown> = { type: k.text ? 'keyDown' : 'rawKeyDown', key, code: k.code, windowsVirtualKeyCode: k.keyCode };
  if (k.text) down.text = k.text;
  return [
    { method: 'Input.dispatchKeyEvent', params: down },
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.keyCode } },
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
  const away = deps.guard();
  if (away) return away;
  if (!deps.isTurnDocument(deps.currentLoad())) {
    return { error: 'not-a-turn-document', detail: 'the preview is not showing a document loaded during this build — reload_page first' };
  }
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
    if (deps.aborted()) { fail('the turn was stopped'); break; }
    const away2 = deps.guard();
    if (away2) { fail(away2.detail ?? away2.error); break; }
    const pinned = deps.currentLoad();
    if (!deps.isTurnDocument(pinned)) { fail('the preview is no longer showing this build\'s document'); break; }

    // Checked immediately before input goes out: same document, still ours.
    const stillPinned = (): boolean => !deps.aborted() && deps.currentLoad() === pinned && deps.isTurnDocument(pinned);
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
      return { error: 'interaction-unavailable', detail: 'input could not be sent to the preview' };
    }
    await deps.wait(parsed.settleMs);
    if (deps.currentLoad() !== pinned) {
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
  if (report.steps.some((s) => s.navigated)) report.note = 'the page navigated; later actions did not run — the DOM change count restarted with the new document';
  return report;
}
