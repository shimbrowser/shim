// The PageHost: everything an authoring session
// needs from a page, and nothing else. The page tools (page-host-tools.ts)
// and preview apply run against this interface, so the same tool code drives
// the Shim browser's tabs (its Electron driver, private) and a headless
// Playwright page (the public driver).
//
// A host is one page. It never decides *which* page or *whether* a call may
// touch it: the page-away guard, reload budgets and allowed reload
// destinations belong to the session that holds the host.
//
// Pure types, two constants and the input loop drivers share. No Node, no
// Electron: the shapes below are what any Chromium driver can produce.

import type { Rule } from './types';

/**
 * Where a script runs.
 *
 * - `main`: the page's own world, with the page's globals.
 * - `engine`: the host's isolated world. It shares the DOM but not the page's
 *   main-world globals, so the page cannot shape what a script there reports.
 *   On a page the engine runs on, it is the engine's world (D9).
 */
export type PageWorld = 'main' | 'engine';

/** A viewport rectangle in CSS px. */
export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotOptions {
  /** Capture only this viewport rectangle, at the page's native device resolution. */
  clip?: PageRect;
  /** Downscale a full-viewport shot wider than this, keeping its aspect. Ignored with a clip. */
  maxWidth?: number;
}

export interface PageScreenshot {
  mediaType: 'image/png';
  dataBase64: string;
  sizeBytes: number;
  width: number;
  height: number;
}

/** A screenshot, or why the host could not take one. Never a throw. */
export type ScreenshotResult = PageScreenshot | { error: string };

/** A rule applied to the page as a live preview. */
export interface PreviewRule {
  /**
   * The shim the rule previews for. While the preview runs, a committed rule
   * of that shim with the same rule id is suppressed, so the two never run
   * side by side; removing the preview restores it.
   */
  patchId: string;
  /**
   * The rule. Its handler source (`rule.handlers`) is compiled by the host,
   * in the engine's world, under `ruleKey`, and the engine receives the
   * compiled functions (D4): a throw is attributed to the preview.
   */
  rule: Rule;
  /**
   * The preview's identity. Applying a key again replaces that preview;
   * removing it tears it down. Every runtime event the preview causes carries
   * it as `specId`.
   */
  ruleKey: string;
  /**
   * The deploy baseline the rule was committed under (the spec's
   * `bundleHash`). When set, the preview runs behind the same
   * deploy gate a committed rule does: against a page whose deploy identity
   * differs, the rebase ladder (refresh, promote, witness recovery,
   * quarantine) reports through runtime events, as it would for the
   * committed shim. Absent, a preview never sees a deploy. A rebase reported
   * for a preview is evidence only; nothing is persisted.
   */
  bundleHash?: string;
  /**
   * The spec's `autoRepair`, read only with `bundleHash`. `false` keeps the
   * preview's rebase ladder to what an opted-out committed shim does on a
   * deploy: the baseline refresh still runs, but nothing promotes a fallback
   * or witness-recovers a dead primary (no `rule-rebase` that changes the
   * anchor); the rule reports no-match or quarantine instead. Absent or
   * `true`, auto-repair is on, as for a spec that never set it.
   */
  autoRepair?: boolean;
  /**
   * An opaque tag for this version of the preview. A host that supports it
   * stamps it as `applyId` on every runtime event the preview reports, so a
   * consumer can tell a late event from a replaced version of the same
   * `ruleKey` from one the current version caused. Optional both ways: a
   * host may ignore it, and a consumer must accept events without it.
   */
  applyId?: string;
}

/**
 * One event the engine reports from the page: `rule-status`, `rule-witness`,
 * `handler-error`, `rule-no-match`, `rule-quarantined` and so on. The fields
 * vary by `kind`; consumers narrow.
 */
export interface PageRuntimeEvent {
  kind?: string;
  specId?: string;
  ruleId?: string;
  readonly [field: string]: unknown;
}

export interface PageConsoleMessage {
  /** `debug`, `info`, `warning` or `error`; a host may report others, read as `info`. */
  level: string;
  message: string;
  /** The script URL (or a handler's sourceURL) that logged it; may be ''. */
  source: string;
  /**
   * The host of the sub-frame that logged it (an embedded iframe), or its URL
   * when it has no host; absent for the page's top frame. A host that can't
   * tell frames apart leaves it out.
   */
  frame?: string;
  /**
   * True when its source looks like the host's own in-page code (its
   * preload, engine files or runtime internals). A page can forge a source
   * (`//# sourceURL=`), so this is a hint for labelling, never proof.
   */
  hostLike?: boolean;
  /**
   * True only when the host itself proves the line was logged in the
   * engine's isolated world — the execution context the host created for
   * the engine, which page script can't run in (e.g. CDP's
   * `executionContextId`). Never derived from the message, its source or
   * anything else the page can write. The only signal that makes a line
   * read as Shim's own; a host that can't prove it leaves it out.
   */
  engineWorld?: boolean;
}

/** Stops a subscription. Calling it again does nothing. */
export type Unsubscribe = () => void;

/** How a load wait ended. */
export type PageLoadOutcome =
  | { kind: 'finished' }
  | { kind: 'failed'; code: number; description: string }
  | { kind: 'timed-out' }
  | { kind: 'aborted' }
  | { kind: 'destroyed' };

export interface LoadWaitOptions {
  signal?: AbortSignal | null;
  timeoutMs: number;
  /**
   * Which load failures end the wait. `main-frame` (the default): only the
   * document's own, so a broken iframe never reads as a failed load.
   * `any-frame`: the first failure of any frame, reported as `failed`.
   */
  failures?: 'main-frame' | 'any-frame';
}

/**
 * Chromium's net error for a navigation cancelled before it finished. A main
 * frame load that ends this way was usually superseded by another navigation
 * (a page script or an installed shim calling `location.replace` while the
 * page loads, the way a redirect does): `waitForLoad` then follows the
 * superseding load and reports how that one ends. Only an abort no other
 * navigation took over (a stopped load) ends the wait as `failed`.
 */
export const NET_ERR_ABORTED = -3;

/**
 * How long a wait gives an aborted main-frame load to show the navigation
 * that superseded it before it reports the abort as a failure.
 */
export const SUPERSEDED_LOAD_GRACE_MS = 500;

/** query_page / inspect_element answers. Errors are values, never throws. */
export interface PageToolError { error: string; detail?: string }
export type QueryPageResult = { candidates: unknown[] } | PageToolError;
export type InspectElementResult = { element: unknown } | PageToolError;

/**
 * Page inspection served by the engine's own code in the page: query_page's
 * ranking and inspect_element's reader. A host without it answers both tools
 * with the self-contained reads in page-host-tools.ts.
 */
export interface PageInspection {
  query(description: string, timeoutMs: number): Promise<QueryPageResult>;
  element(selector: string, timeoutMs: number): Promise<InspectElementResult>;
}

/**
 * Handler api members beyond the core set (`storage`, `cleanup`) that a host
 * may provide. D15: a member a host lacks fails in its own shape at runtime.
 */
export const PAGE_HOST_API_MEMBERS = [
  'db', 'ai', 'settings', 'fetch', 'storage.pack', 'storage.global', 'shared', 'modules',
] as const;
export type PageHostApiMember = (typeof PAGE_HOST_API_MEMBERS)[number];

/** What a host supports (D15). A session preflights a spec against it. */
export interface PageHostCapabilities {
  /** Mutation kinds a rule may use on this host. */
  mutationKinds: readonly string[];
  /** Rules targeting a child frame (`anchor.iframe`). */
  iframeRules: boolean;
  /** The spec-level `css` block (the engine's whole-patch stylesheet) is installed with the shim. */
  specCss: boolean;
  /** Handler api members beyond the core set. */
  apiMembers: readonly PageHostApiMember[];
  /** Component identity in a witness is captured, verified and used for recovery. */
  componentIdentity: boolean;
  /** `inspection` is present (the engine serves query_page / inspect_element). */
  engineInspection: boolean;
  /** `input` is present: trusted mouse, keyboard and text input, as a user's. */
  trustedInput: boolean;
}

/**
 * One trusted input command, in the Chrome DevTools Protocol's `Input`
 * domain shape (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`,
 * `Input.insertText`). Coordinates are viewport CSS px.
 */
export interface PageInputCommand {
  method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.insertText';
  params: Record<string, unknown>;
}

/**
 * How an input batch ended. `sent` counts the commands the page took, in
 * order, so a caller can report exactly what happened before a stop or a
 * failure. Never a throw.
 */
export type PageInputResult =
  | { sent: number; outcome: 'done' }
  /** `stillPinned` answered false (or threw) before command `sent`; nothing after it went out. */
  | { sent: number; outcome: 'stopped' }
  /** Command `sent` could not be delivered (the page closed, the input channel failed); nothing after it went out. */
  | { sent: number; outcome: 'failed'; error: string };

export interface PageHost {
  readonly capabilities: PageHostCapabilities;

  /** The page's current URL ('' when it has none or is closed). */
  url(): string;
  /** The page is gone; every later call is a no-op or an error. */
  isClosed(): boolean;

  /**
   * Run `code` (a script whose completion value is the result; a promise is
   * awaited) in `world`. Resolves the value as the page serialized it;
   * rejects when the script throws or the page cannot run it.
   */
  evaluate(code: string, world: PageWorld): Promise<unknown>;

  /** Capture the viewport, or `clip` of it. */
  screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>;

  /** Apply (or replace, by `ruleKey`) a preview rule. Fire and forget: outcomes arrive as runtime events. */
  applyPreview(preview: PreviewRule): void;
  /** Tear a preview down. Unknown keys are a no-op. */
  removePreview(ruleKey: string): void;

  /** Every runtime event the page reports from now on. */
  onRuntimeEvent(listener: (event: PageRuntimeEvent) => void): Unsubscribe;
  /** Every console message the page logs from now on. */
  onConsole(listener: (message: PageConsoleMessage) => void): Unsubscribe;

  /**
   * Start a reload in place, or a load of `url`. The caller decides which
   * destinations are allowed; nothing model-supplied should reach `url`.
   * Call `waitForLoad` in the same tick to observe the load it starts.
   */
  reload(url?: string): void;
  /**
   * Resolves on the first of: the load finishing or failing, the page
   * closing, `signal` aborting, the timeout. A main-frame load another
   * navigation superseded (`NET_ERR_ABORTED`) is not a failure: the wait
   * follows the navigation that replaced it.
   */
  waitForLoad(options: LoadWaitOptions): Promise<PageLoadOutcome>;

  /** Engine-served page inspection; present exactly when `capabilities.engineInspection`. */
  readonly inspection?: PageInspection;

  /**
   * Trusted input (the page sees `isTrusted` events, as from a user);
   * present exactly when `capabilities.trustedInput`. Sends `commands` in
   * order, awaiting `stillPinned(i)` right before command `i` and stopping
   * the moment it answers false — a handler of an earlier command can
   * navigate, move focus or cover the target. Batches on one page never
   * interleave. Whoever calls it decides what may be clicked.
   */
  input?(commands: readonly PageInputCommand[], stillPinned: (index: number) => boolean | Promise<boolean>): Promise<PageInputResult>;

  /**
   * An opaque identity of the page's current document: a new one for every
   * new document (a load, a reload, a navigation), the same across
   * same-document URL changes (pushState, fragments). Null when the page has
   * no document the host can read (closed, mid-load).
   */
  documentToken(): Promise<string | null>;

  /**
   * A count of the page's main-frame navigations, advanced as each one is
   * requested or started (before it commits) and for same-document ones
   * (pushState, fragments). Synchronous, for a caller that must stop the
   * moment the page starts to move. Optional: a host without it leaves the
   * caller to the document token and URL.
   */
  navigationCount?(): number;

  /**
   * While at least one listener is subscribed, every popup or new window the
   * page opens is closed as soon as it is created and reported with the URL
   * it was opened at. Optional: a host that blocks opens elsewhere (the Shim
   * browser denies them at creation) has no need of it.
   */
  onPopup?(listener: (url: string) => void): Unsubscribe;
}

/**
 * The script a host may evaluate in its engine world to serve
 * `documentToken`: a random token minted once per document, kept in that
 * world (the page's own scripts can neither read nor reset it).
 */
export const DOCUMENT_TOKEN_SCRIPT = `(() => {
  const key = '__shimDocumentToken';
  if (typeof globalThis[key] !== 'string') {
    globalThis[key] = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  return globalThis[key];
})()`;

/**
 * Sends `commands` through `send` with the PageHost.input contract (a
 * driver's shared loop): `stillPinned` before each command, the first
 * failure ends the batch, nothing ever throws.
 */
export async function sendInputCommands(
  commands: readonly PageInputCommand[],
  stillPinned: (index: number) => boolean | Promise<boolean>,
  send: (command: PageInputCommand) => Promise<void>,
): Promise<PageInputResult> {
  for (let i = 0; i < commands.length; i++) {
    let pinned: boolean;
    try { pinned = await stillPinned(i); } catch { pinned = false; }
    if (!pinned) return { sent: i, outcome: 'stopped' };
    const command = commands[i];
    if (!command) return { sent: i, outcome: 'failed', error: 'missing command' };
    try {
      await send(command);
    } catch (err) {
      return { sent: i, outcome: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { sent: commands.length, outcome: 'done' };
}
