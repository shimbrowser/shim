// The extension as a PageHost (@shimbrowser/core/page-host): what an
// authoring session needs from one tab, over the Chrome DevTools Protocol
// through chrome.debugger. The same shape as the headless Playwright host,
// which is a CDP host too: the host creates an isolated world of its own in
// the page, evaluates the engine's page bundle and the shared page runtime
// (@shimbrowser/core/page-runtime) there, compiles each preview's handlers
// in that world (the protocol's evaluate is not subject to the page's CSP,
// nor to the user-scripts toggle, so a session does not depend on the
// mode), applies previews through the runtime's control object, and reads
// events and api calls back over a binding. Console lines are vouched for
// as the engine's only by the protocol's execution context, never by their
// text. Screenshots and trusted input are the protocol's own.
//
// A committed shim keeps running in its own world while a session previews
// one of its rules; the committed rule is held meanwhile (the worker
// nudges the page's runtime with the set of rules the session holds, and
// waits for the ack) and given back when the preview goes: a preview is
// applied only once its twin is down, and the twin comes back only once
// the preview is gone. The holds die with the document, as the previews do.
//
// Attaching the debugger shows Chrome's own bar on the tab for as long as
// the session lasts: a session is a visible thing, never a silent one. The
// user can end it from that bar; then the page's runtime, told so, drops
// the session's previews (a DOM event into the session's world, the one
// way to reach it) before it releases the holds, and a page with no
// runtime drops them itself when the host stops answering its pings.

import type {
  PageHost, PageWorld, PreviewRule, PageRuntimeEvent, PageConsoleMessage, Unsubscribe, ScreenshotOptions, ScreenshotResult,
  LoadWaitOptions, PageLoadOutcome, PageInputCommand, PageInputResult, PageHostCapabilities,
} from '@shimbrowser/core/page-host';
import { DOCUMENT_TOKEN_SCRIPT, NET_ERR_ABORTED, SUPERSEDED_LOAD_GRACE_MS, sendInputCommands } from '@shimbrowser/core/page-host';
import { pageRuntimeSource } from '@shimbrowser/core/page-runtime';
import { remoteObjectValue, netErrorCode, consoleLevel, formatConsoleArg, handlerSource, type RemoteValue } from '@shimbrowser/core/cdp-host';
import { SESSION_CAPABILITIES, UNSUPPORTED_ERROR } from './capabilities';
import { SESSION_CLOSE_EVENT, type ToRuntime } from './messages';
import type { SettingsTransport } from './settings';

/**
 * The world the host creates for the engine in a session's page: this
 * prefix and a number of its own. A world outlives its session in the
 * document it was made in (a session ended and another begun on the same
 * page), and a world reused by name would hand the new session the old
 * session's runtime, bound to a driver that is gone.
 */
export const SESSION_ENGINE_WORLD = 'shim-core';
// Only a fallback: a session names its world by its own id (PageHostOptions.worldId),
// which is unique across worker generations; a counter starts over with each worker.
let worldSeq = 0;
const BINDING = '__shimCoreHost';
const RUNTIME_GLOBAL = '__shimCoreRuntime';
const PONG_GLOBAL = '__shimCoreHostPong';
const PROTOCOL_VERSION = '1.3';
/** How often the session's world asks the host whether it is still there (a detached binding still calls, into nothing). */
export const HOST_PING_MS = 5000;

/**
 * What the host adds to its world beside the engine and the page runtime:
 * the way its previews go when the host cannot reach the world any more.
 * The page's runtime says so with a DOM event (the session was ended from
 * Chrome's bar while a committed shim ran here); with no runtime on the
 * page, the world notices on its own when a ping goes unanswered.
 */
export function worldCloseSource(): string {
  return `(() => {
  const g = globalThis;
  const runtime = () => g[${JSON.stringify(RUNTIME_GLOBAL)}];
  const drop = () => { const r = runtime(); if (r) for (const k of r.previewKeys()) r.remove(k); };
  document.addEventListener(${JSON.stringify(SESSION_CLOSE_EVENT)}, drop);
  let nonce = 0;
  const timer = setInterval(() => {
    const send = g[${JSON.stringify(BINDING)}];
    if (!runtime() || typeof send !== 'function') return;
    if (nonce > 0 && g[${JSON.stringify(PONG_GLOBAL)}] !== nonce) {
      clearInterval(timer);
      drop();
      return;
    }
    nonce++;
    try { send(JSON.stringify({ type: 'ping', nonce })); } catch (_) { /* the next tick finds no pong */ }
  }, ${HOST_PING_MS});
})();`;
}

/** Which bucket an `api.storage` call reads: the preview's shim, on the page's origin. */
export interface SessionStorageScope {
  patchId: string;
  origin: string;
}

/** Backs previews' `api.storage`: the installed shim's rows, or a session's own bucket. */
export interface SessionStorage {
  get(scope: SessionStorageScope, key: string): Promise<unknown>;
  set(scope: SessionStorageScope, key: string, value: unknown): Promise<unknown>;
  delete(scope: SessionStorageScope, key: string): Promise<boolean>;
  list(scope: SessionStorageScope): Promise<Record<string, unknown>>;
}

/**
 * Backs previews' `api.settings` and `api.fetch`. Settings resolve the
 * session's working declaration against the installed shim's values; fetch
 * is the broker an installed shim's handlers use.
 */
export interface SessionHandlerApi {
  /** Every declared key of the preview's shim, resolved, as getAll crosses the binding (`get` reads one of these). */
  settings(scope: SessionStorageScope): Promise<SettingsTransport>;
  /** A preview's `api.fetch(url, opts)`: never throws, answers `{ ok: false, error }` on failure. */
  fetch(scope: SessionStorageScope, url: unknown, opts: unknown): Promise<unknown>;
}

export type NudgeOutcome = 'acked' | 'no-runtime' | 'timed-out';

export interface PageHostOptions {
  /**
   * What names the host's world: the session's id, unique across worker
   * generations, so a document that outlived a dead worker never hands a
   * new host the old world's runtime and binding. Without it, a per-worker
   * counter (the conformance runner's hosts).
   */
  worldId?: string;
}

export interface PageHostDeps {
  /** The engine's page bundle source (dist/shim-core.page.js). */
  engineBundle(): Promise<string>;
  storage: SessionStorage;
  /** Previews' `api.settings` and `api.fetch`. Absent: both fail in their own shape (the conformance runner's hosts). */
  handlerApi?: SessionHandlerApi;
  /** A nudge to the page's committed runtime (the rules a session holds, or its end): acked by a runtime, none there, or not answered in time. */
  nudge(tabId: number, msg: Extract<ToRuntime, { seq?: number }>): Promise<NudgeOutcome>;
  /** How long a preview apply or an engine-world evaluate waits for the world. Default 5000. */
  worldWaitMs?: number;
  /** What the host advertises (SESSION_CAPABILITIES, or the vault's while it is on). Default SESSION_CAPABILITIES. */
  capabilities?: PageHostCapabilities;
}

export interface ExtensionPageHost extends PageHost {
  readonly tabId: number;
  /** The committed rules of `patchId` this host holds on the current document: its previews' twins and its holds without a preview. */
  heldFor(patchId: string): string[];
  /** Every hold on the current document, by shim. */
  heldAll(): Record<string, string[]>;
  /**
   * Hold a committed rule down with no preview to show (a rule the session
   * removed): kept through navigation, disable and enable, until released.
   * Answers whether the page's runtime confirmed it.
   */
  holdOnly(patchId: string, ruleId: string): Promise<NudgeOutcome>;
  /** Release a hold taken by holdOnly. */
  releaseOnly(patchId: string, ruleId: string): Promise<NudgeOutcome>;
  /**
   * A commit's handoff, first step: take every preview of `patchId` off the
   * page while keeping its twins held, so the committed form that boots
   * next never runs beside a preview, and nothing comes back early.
   */
  retainHolds(patchId: string): Promise<void>;
  /** A commit's handoff, last step: let every hold on `patchId` go. */
  releaseHolds(patchId: string): Promise<NudgeOutcome>;
  /** Told once when the host is over, whichever way: closed, lost from Chrome's bar, the tab gone. */
  onClosed(listener: () => void): Unsubscribe;
  /** Stop driving the tab: remove every preview, give back held rules, detach the debugger. Leaves the tab open. */
  close(): Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A PNG's pixel size from its header (IHDR width and height), or zeros. */
export function pngSize(base64: string): { width: number; height: number } {
  try {
    const head = atob(base64.slice(0, 44));
    const b = (i: number): number => head.charCodeAt(i) & 0xff;
    if (b(0) !== 0x89 || b(1) !== 0x50 || b(2) !== 0x4e || b(3) !== 0x47) return { width: 0, height: 0 };
    const u32 = (i: number): number => ((b(i) << 24) >>> 0) + (b(i + 1) << 16) + (b(i + 2) << 8) + b(i + 3);
    return { width: u32(16), height: u32(20) };
  } catch {
    return { width: 0, height: 0 };
  }
}

interface ExceptionDetails {
  text: string;
  url?: string;
  executionContextId?: number;
  exception?: { description?: string };
}

interface EvaluateResult {
  result: RemoteValue & { objectId?: string };
  exceptionDetails?: ExceptionDetails;
}

export async function openPageHost(tabId: number, deps: PageHostDeps, options: PageHostOptions = {}): Promise<ExtensionPageHost> {
  const target = { tabId };
  const worldWaitMs = deps.worldWaitMs ?? 5000;
  const worldName = `${SESSION_ENGINE_WORLD}:${options.worldId ?? String(++worldSeq)}`;
  await chrome.debugger.attach(target, PROTOCOL_VERSION);
  // A command refused because the debugger is no longer attached is the
  // session's end seen from inside (Chrome fires no onDetach for a detach
  // the extension itself made elsewhere): the same teardown as from the bar.
  const send = async <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> => {
    try {
      return await (chrome.debugger.sendCommand(target, method, params) as Promise<T>);
    } catch (err) {
      if (!closed && /not attached|detached|no tab with/i.test(errText(err))) lost();
      throw err;
    }
  };

  const runtimeListeners = new Set<(event: PageRuntimeEvent) => void>();
  const consoleListeners = new Set<(message: PageConsoleMessage) => void>();
  const popupListeners = new Set<(url: string) => void>();
  let mainFrameId = '';
  let currentUrl = '';
  let worldContextId: number | null = null;
  let worldWaiters: Array<(id: number | null) => void> = [];
  let closed = false;
  let navigations = 0;
  // Which shim each preview key belongs to, and which committed rule it
  // twins: the rules held of each shim, and the only shims a storage call
  // may name. The page runtime passes the preview's own id, but handler
  // code runs in the same world as the binding, so the host, not the
  // payload, decides whose rows a call reaches.
  const previewed = new Map<string, { patchId: string; ruleId: string }>();
  // Holds with no preview behind them: a rule the session removed, or a
  // preview taken down for a commit's handoff. Unlike previews they survive
  // a navigation (the next document's runtime boots with them suppressed).
  const holdsOnly = new Map<string, Set<string>>();
  const heldFor = (patchId: string): string[] => [...new Set([
    ...[...previewed.values()].filter((p) => p.patchId === patchId).map((p) => p.ruleId),
    ...(holdsOnly.get(patchId) ?? []),
  ])];
  const heldAll = (): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    const define = (patchId: string): void => {
      if (!(patchId in out)) Object.defineProperty(out, patchId, { value: heldFor(patchId), enumerable: true, writable: true, configurable: true });
    };
    for (const { patchId } of previewed.values()) define(patchId);
    for (const patchId of holdsOnly.keys()) define(patchId);
    return out;
  };
  const closedListeners = new Set<() => void>();
  const holdNudge = (patchId: string): Promise<NudgeOutcome> => deps.nudge(tabId, { type: 'hold', patchId, ruleIds: heldFor(patchId) });
  const removeInWorld = async (ruleKey: string): Promise<void> => {
    if (worldContextId === null || closed) return;
    await send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(RUNTIME_GLOBAL)}].remove(${JSON.stringify(ruleKey)})`,
      contextId: worldContextId,
    }).catch(() => { /* the document went away, and the preview with it */ });
  };
  const loadWaits = new Set<(outcome: PageLoadOutcome) => void>();
  let queue: Promise<void> = Promise.resolve();

  try {
    const tab = await chrome.tabs.get(tabId);
    currentUrl = tab.url ?? tab.pendingUrl ?? '';
  } catch { /* the tab is gone already; isClosed says so once the debugger says so */ }

  const setWorld = (id: number | null): void => {
    worldContextId = id;
    if (id === null) return;
    const waiters = worldWaiters;
    worldWaiters = [];
    for (const w of waiters) w(id);
  };
  const waitForWorld = (ms: number): Promise<number | null> => {
    if (closed) return Promise.resolve(null);
    if (worldContextId !== null) return Promise.resolve(worldContextId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        worldWaiters = worldWaiters.filter((w) => w !== settle);
        resolve(null);
      }, ms);
      const settle = (id: number | null): void => {
        clearTimeout(timer);
        resolve(id);
      };
      worldWaiters.push(settle);
    });
  };
  const emitRuntime = (event: PageRuntimeEvent): void => {
    for (const l of [...runtimeListeners]) {
      try { l(event); } catch { /* a listener's throw is its own */ }
    }
  };
  const emitConsole = (message: PageConsoleMessage): void => {
    for (const l of [...consoleListeners]) {
      try { l(message); } catch { /* a listener's throw is its own */ }
    }
  };
  const inEngineWorld = (contextId: number | undefined): boolean =>
    contextId !== undefined && worldContextId !== null && contextId === worldContextId;

  // --- the api's answering leg ---
  async function answerCall(contextId: number, id: number, method: string, patchId: unknown, origin: unknown, rawArgs: unknown): Promise<void> {
    const args = Array.isArray(rawArgs) ? rawArgs : [];
    const key = typeof args[0] === 'string' ? args[0] : String(args[0]);
    let expression: string;
    try {
      // The origin is the host's own view of the page, never the payload's;
      // the shim is one this host is previewing.
      const pageOrigin = ((): string => { try { return new URL(currentUrl).origin; } catch { return ''; } })();
      if (typeof patchId !== 'string' || ![...previewed.values()].some((p) => p.patchId === patchId)) throw new Error('not a previewed shim');
      if (!pageOrigin || pageOrigin === 'null' || (typeof origin === 'string' && origin !== pageOrigin)) throw new Error('no page origin');
      const scope: SessionStorageScope = { patchId, origin: pageOrigin };
      let value: unknown;
      if (method === 'storage.get') value = await deps.storage.get(scope, key);
      else if (method === 'storage.set') value = await deps.storage.set(scope, key, args[1]);
      else if (method === 'storage.delete') value = await deps.storage.delete(scope, key);
      else if (method === 'storage.list') value = await deps.storage.list(scope);
      else if (deps.handlerApi && method === 'settings.getAll') value = await deps.handlerApi.settings(scope);
      else if (deps.handlerApi && method === 'settings.get') {
        const { values } = await deps.handlerApi.settings(scope);
        value = Object.hasOwn(values, key) ? values[key] : undefined;
      } else if (deps.handlerApi && method === 'fetch') value = await deps.handlerApi.fetch(scope, args[0], args[1]);
      else value = undefined;
      // Crosses as a quoted JSON string parsed page-side, never as an object
      // literal: a literal would turn an own `__proto__` key into a
      // prototype setter.
      const json: string | undefined = value === undefined ? undefined : JSON.stringify(value);
      const literal = json === undefined ? 'undefined' : `JSON.parse(${JSON.stringify(json)})`;
      expression = `globalThis[${JSON.stringify(RUNTIME_GLOBAL)}].resolve(${id}, ${literal})`;
    } catch (err) {
      expression = `globalThis[${JSON.stringify(RUNTIME_GLOBAL)}].reject(${id}, ${JSON.stringify(`${method} failed: ${errText(err)}`)})`;
    }
    await send('Runtime.evaluate', { expression, contextId }).catch(() => { /* the document went away */ });
  }

  // --- protocol events ---
  const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: unknown): void => {
    if (source.tabId !== tabId || !isRecord(params)) return;
    switch (method) {
      case 'Runtime.executionContextCreated': {
        const context = params.context;
        if (!isRecord(context)) return;
        const aux = context.auxData;
        if (context.name === worldName && isRecord(aux) && aux.frameId === mainFrameId && typeof context.id === 'number') setWorld(context.id);
        return;
      }
      case 'Runtime.executionContextDestroyed':
        if (params.executionContextId === worldContextId) setWorld(null);
        return;
      case 'Runtime.executionContextsCleared':
        setWorld(null);
        return;
      case 'Page.frameNavigated': {
        const frame = params.frame;
        if (isRecord(frame) && !frame.parentId && typeof frame.id === 'string') {
          mainFrameId = frame.id;
          navigations++;
          if (typeof frame.url === 'string') currentUrl = frame.url;
          // A new document: its world starts with no previews, so the holds
          // are over too (the new document's runtime boots with the worker's
          // current list, which this empties).
          previewed.clear();
        }
        return;
      }
      case 'Page.frameRequestedNavigation':
      case 'Page.frameStartedNavigating':
        if (params.frameId === mainFrameId) navigations++;
        return;
      case 'Page.navigatedWithinDocument':
        if (params.frameId === mainFrameId) {
          navigations++;
          if (typeof params.url === 'string') currentUrl = params.url;
        }
        return;
      case 'Runtime.bindingCalled': {
        if (params.name !== BINDING || params.executionContextId !== worldContextId) return;
        let msg: unknown;
        try { msg = JSON.parse(String(params.payload)); } catch { return; }
        if (!isRecord(msg)) return;
        if (msg.type === 'event' && typeof msg.kind === 'string') {
          emitRuntime({ ...(isRecord(msg.payload) ? msg.payload : {}), kind: msg.kind });
        } else if (msg.type === 'ping' && typeof msg.nonce === 'number' && typeof params.executionContextId === 'number') {
          void send('Runtime.evaluate', { expression: `globalThis[${JSON.stringify(PONG_GLOBAL)}] = ${msg.nonce}`, contextId: params.executionContextId }).catch(() => undefined);
        } else if (msg.type === 'call' && typeof msg.id === 'number' && typeof msg.method === 'string' && typeof params.executionContextId === 'number') {
          void answerCall(params.executionContextId, msg.id, msg.method, msg.patchId, msg.origin, msg.args);
        }
        return;
      }
      case 'Runtime.consoleAPICalled': {
        const args = Array.isArray(params.args) ? params.args as RemoteValue[] : [];
        const stack = isRecord(params.stackTrace) && Array.isArray(params.stackTrace.callFrames) ? params.stackTrace.callFrames[0] : undefined;
        const url = isRecord(stack) && typeof stack.url === 'string' ? stack.url : '';
        const contextId = typeof params.executionContextId === 'number' ? params.executionContextId : undefined;
        emitConsole({
          level: consoleLevel(String(params.type)),
          message: args.map((a) => formatConsoleArg(a)).join(' '),
          source: url,
          ...(inEngineWorld(contextId) ? { engineWorld: true } : {}),
        });
        return;
      }
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails;
        if (!isRecord(details)) return;
        const exception = isRecord(details.exception) ? details.exception : undefined;
        const description = typeof exception?.description === 'string' ? exception.description : String(details.text ?? '');
        const firstLine = description.split('\n')[0] ?? description;
        const contextId = typeof details.executionContextId === 'number' ? details.executionContextId : undefined;
        emitConsole({
          level: 'error',
          message: firstLine.startsWith('Uncaught') ? firstLine : `Uncaught ${firstLine}`,
          source: typeof details.url === 'string' ? details.url : '',
          ...(inEngineWorld(contextId) ? { engineWorld: true } : {}),
        });
        return;
      }
      default:
        return;
    }
  };
  chrome.debugger.onEvent.addListener(onEvent);
  // Not this host's own detach (teardown drops this listener first): the
  // user ended the session from Chrome's bar, or Chrome did. Nothing in
  // the world can be reached now; the page's runtime, if any, drops the
  // previews and releases the holds.
  const onDetach = (source: chrome.debugger.Debuggee): void => {
    if (source.tabId === tabId) lost();
  };
  function lost(): void {
    if (closed) return;
    teardown();
    void deps.nudge(tabId, { type: 'session-closed' });
  }
  // The host's own heartbeat: a command the tab refuses is the session's
  // end (see `send`), found within one interval even when no event or
  // call would have made the host send anything.
  const heartbeat = setInterval(() => {
    if (closed) return;
    void send('Runtime.evaluate', { expression: '0', returnByValue: true }).catch(() => undefined);
  }, HOST_PING_MS);
  chrome.debugger.onDetach.addListener(onDetach);

  // --- loads, over the navigation events (the tab's, not the protocol's) ---
  let navSeq = 0;
  let lastNavigationUrl = '';
  const onBeforeNavigate = (details: chrome.webNavigation.WebNavigationBaseCallbackDetails): void => {
    if (details.tabId !== tabId || details.frameId !== 0) return;
    navSeq++;
    lastNavigationUrl = details.url;
  };
  const onCommitted = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void => {
    if (details.tabId !== tabId || details.frameId !== 0) return;
    currentUrl = details.url;
  };
  chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
  chrome.webNavigation.onCommitted.addListener(onCommitted);

  const onTabRemoved = (removedId: number): void => {
    if (removedId === tabId) teardown();
  };
  chrome.tabs.onRemoved.addListener(onTabRemoved);

  // Popups while someone listens (an interact_page batch): closed on
  // creation and reported with the URL they opened at.
  const onTabCreated = (tab: chrome.tabs.Tab): void => {
    if (tab.openerTabId !== tabId || popupListeners.size === 0 || tab.id === undefined) return;
    const url = tab.pendingUrl ?? tab.url ?? '';
    void chrome.tabs.remove(tab.id).catch(() => undefined);
    for (const l of [...popupListeners]) {
      try { l(url); } catch { /* a listener's throw is its own */ }
    }
  };
  chrome.tabs.onCreated.addListener(onTabCreated);

  // Over, whichever way: every waiter settled, every listener gone, the
  // holds forgotten (the document's runtime releases its own). Idempotent.
  function teardown(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    previewed.clear();
    holdsOnly.clear();
    runtimeListeners.clear();
    consoleListeners.clear();
    popupListeners.clear();
    for (const settle of [...loadWaits]) settle({ kind: 'destroyed' });
    for (const w of worldWaiters) w(null);
    worldWaiters = [];
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    chrome.webNavigation.onBeforeNavigate.removeListener(onBeforeNavigate);
    chrome.webNavigation.onCommitted.removeListener(onCommitted);
    chrome.tabs.onRemoved.removeListener(onTabRemoved);
    chrome.tabs.onCreated.removeListener(onTabCreated);
    const told = [...closedListeners];
    closedListeners.clear();
    for (const l of told) {
      try { l(); } catch { /* a listener's throw is its own */ }
    }
  }

  // --- setup ---
  await send('Runtime.enable');
  await send('Page.enable');
  const { frameTree } = await send<{ frameTree: { frame: { id: string; url?: string } } }>('Page.getFrameTree');
  mainFrameId = frameTree.frame.id;
  if (typeof frameTree.frame.url === 'string' && frameTree.frame.url) currentUrl = frameTree.frame.url;
  await send('Runtime.addBinding', { name: BINDING, executionContextName: worldName });
  const worldScript = `${await deps.engineBundle()}\n${pageRuntimeSource({
    binding: BINDING, globalName: RUNTIME_GLOBAL, unsupportedError: UNSUPPORTED_ERROR, ...(deps.handlerApi ? { serves: ['settings', 'fetch'] as const } : {}),
  })}\n${worldCloseSource()}`;
  const { identifier: scriptId } = await send<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', { source: worldScript, worldName });
  // The document already loaded never saw the script: give it the world now.
  if (worldContextId === null) {
    try {
      const { executionContextId } = await send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: mainFrameId, worldName, grantUniveralAccess: false });
      const res = await send<EvaluateResult>('Runtime.evaluate', { expression: worldScript, contextId: executionContextId });
      if (!res.exceptionDetails) setWorld(executionContextId);
    } catch {
      /* a navigation raced the attach; its new document runs the script itself */
    }
  }

  // --- the members ---
  async function evaluateIn(code: string, contextId: number | undefined): Promise<unknown> {
    const res = await send<EvaluateResult>('Runtime.evaluate', {
      expression: code,
      ...(contextId !== undefined ? { contextId } : {}),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails;
      throw new Error(ex.exception?.description ?? ex.text);
    }
    return remoteObjectValue(res.result);
  }
  async function evaluate(code: string, world: PageWorld): Promise<unknown> {
    if (closed) throw new Error('page is closed');
    if (world === 'main') return evaluateIn(code, undefined);
    const contextId = await waitForWorld(worldWaitMs);
    if (contextId === null) throw new Error('the engine world is not available on this page');
    return evaluateIn(code, contextId);
  }

  async function compileHandler(contextId: number, patchId: string, ruleKey: string, name: string, source: string): Promise<void> {
    const objectGroup = `shim-compile-${ruleKey}`;
    const rt = `globalThis[${JSON.stringify(RUNTIME_GLOBAL)}]`;
    const shareKey = `${patchId}\u0000${name}\u0000${source}`;
    const reused = await send<EvaluateResult>('Runtime.evaluate', {
      expression: `${rt}.defineShared(${JSON.stringify(ruleKey)}, ${JSON.stringify(name)}, ${JSON.stringify(shareKey)})`,
      contextId,
      returnByValue: true,
    });
    if (reused.result.value === true) return;
    try {
      const res = await send<EvaluateResult>('Runtime.evaluate', { expression: handlerSource(source, ruleKey, name), contextId, objectGroup });
      if (res.exceptionDetails) {
        const ex = res.exceptionDetails;
        const detail = ex.exception?.description ?? ex.text;
        await send('Runtime.evaluate', {
          expression: `console.error(${JSON.stringify(`[shim] failed to compile inline handler "${name}"`)}, ${JSON.stringify(detail)})`,
          contextId,
        });
        return;
      }
      const fnId = res.result.objectId;
      if (fnId) {
        await send('Runtime.callFunctionOn', {
          functionDeclaration: `function (fn, key) { ${rt}.shareHandler(key, fn); return ${rt}.defineHandler(${JSON.stringify(ruleKey)}, ${JSON.stringify(name)}, fn); }`,
          executionContextId: contextId,
          arguments: [{ objectId: fnId }, { value: shareKey }],
          returnByValue: true,
        });
      } else {
        await send('Runtime.callFunctionOn', {
          functionDeclaration: `function (v) { return ${rt}.defineHandler(${JSON.stringify(ruleKey)}, ${JSON.stringify(name)}, v); }`,
          executionContextId: contextId,
          arguments: [res.result.unserializableValue !== undefined ? { unserializableValue: res.result.unserializableValue } : { value: res.result.value }],
          returnByValue: true,
        });
      }
    } finally {
      await send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
    }
  }

  async function applyPreviewNow(preview: PreviewRule): Promise<void> {
    const contextId = await waitForWorld(worldWaitMs);
    if (contextId === null || closed) return;
    const { patchId, rule, ruleKey, bundleHash, applyId, autoRepair } = preview;
    // The committed twin of this preview is held, and the page's runtime
    // has said so, before the preview goes up. A key that moves to another
    // shim or rule first takes its old preview down, then releases what it
    // held: the old twin comes back only once its preview is gone.
    const before = previewed.get(ruleKey);
    const moved = before !== undefined && (before.patchId !== patchId || before.ruleId !== rule.id);
    if (moved) {
      await removeInWorld(ruleKey);
      previewed.delete(ruleKey);
      if (before.patchId !== patchId) await holdNudge(before.patchId);
    }
    if (!before || moved) {
      previewed.set(ruleKey, { patchId, ruleId: rule.id });
      const outcome = await holdNudge(patchId);
      if (closed) return;
      if (outcome === 'timed-out') {
        // A runtime may be there and may not have taken the hold: the
        // preview does not go up beside a twin that may still run. The
        // claim is withdrawn (the late hold, if it lands, is undone by this
        // newer one) and the session is told in its console.
        previewed.delete(ruleKey);
        void holdNudge(patchId);
        emitConsole({ level: 'error', message: `[shim] preview ${ruleKey} not applied: the page's runtime did not confirm the hold on rule "${rule.id}" of ${patchId} in time`, source: '' });
        return;
      }
    }
    for (const [name, source] of Object.entries(rule.handlers ?? {})) {
      if (typeof source !== 'string') continue;
      await compileHandler(contextId, patchId, ruleKey, name, source);
    }
    await send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(RUNTIME_GLOBAL)}].apply(${JSON.stringify(patchId)}, ${JSON.stringify(rule)}, ${JSON.stringify(ruleKey)}, ${JSON.stringify(bundleHash ?? null)}, ${JSON.stringify(applyId ?? null)}, ${JSON.stringify(autoRepair ?? null)})`,
      contextId,
    });
  }
  async function removePreviewNow(ruleKey: string): Promise<void> {
    const was = previewed.get(ruleKey);
    if (!was) return;
    // The preview goes first; its committed twin comes back once it is gone.
    await removeInWorld(ruleKey);
    previewed.delete(ruleKey);
    if (!closed) await holdNudge(was.patchId);
  }
  // Queued with the previews, so a hold and a preview on the same rule
  // never cross. Each answers what the runtime said of the hold set.
  const queued = <T>(work: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    enqueue(async () => {
      try { resolve(await work()); } catch (err) { reject(err instanceof Error ? err : new Error(String(err))); }
    });
  });
  async function holdOnlyNow(patchId: string, ruleId: string): Promise<NudgeOutcome> {
    if (closed) return 'no-runtime';
    const set = holdsOnly.get(patchId) ?? new Set<string>();
    if (set.has(ruleId)) return 'acked';
    set.add(ruleId);
    holdsOnly.set(patchId, set);
    const outcome = await holdNudge(patchId);
    if (outcome === 'timed-out' && !closed) {
      // Not confirmed: not held. The session learns so and decides.
      set.delete(ruleId);
      if (!set.size) holdsOnly.delete(patchId);
      void holdNudge(patchId);
    }
    return outcome;
  }
  async function releaseOnlyNow(patchId: string, ruleId: string): Promise<NudgeOutcome> {
    if (closed) return 'no-runtime';
    const set = holdsOnly.get(patchId);
    if (!set?.delete(ruleId)) return 'acked';
    if (!set.size) holdsOnly.delete(patchId);
    return holdNudge(patchId);
  }
  async function retainHoldsNow(patchId: string): Promise<void> {
    if (closed) return;
    const set = holdsOnly.get(patchId) ?? new Set<string>();
    for (const [key, p] of [...previewed]) {
      if (p.patchId !== patchId) continue;
      await removeInWorld(key);
      previewed.delete(key);
      set.add(p.ruleId);
    }
    if (set.size) holdsOnly.set(patchId, set);
    // The held set is unchanged: nothing to tell the runtime.
  }
  async function releaseHoldsNow(patchId: string): Promise<NudgeOutcome> {
    if (closed) return 'no-runtime';
    holdsOnly.delete(patchId);
    for (const [key, p] of [...previewed]) {
      if (p.patchId !== patchId) continue;
      await removeInWorld(key);
      previewed.delete(key);
    }
    return holdNudge(patchId);
  }
  const enqueue = (work: () => Promise<void>): void => {
    queue = queue.then(work).catch((err: unknown) => {
      // The document went away mid-step, or the session did; the next step
      // finds out for itself.
      if (!closed) console.error('[shim] preview step failed', errText(err));
    });
  };

  async function screenshot(opts: ScreenshotOptions | undefined): Promise<ScreenshotResult> {
    if (closed) return { error: 'page is closed' };
    try {
      const vp = await evaluateIn('({ w: window.innerWidth, h: window.innerHeight, x: window.scrollX, y: window.scrollY })', undefined);
      const view = isRecord(vp) ? vp : {};
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const capture = async (clip: { x: number; y: number; width: number; height: number; scale: number } | undefined): Promise<string> => {
        const shot = await send<{ data: string }>('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}), captureBeyondViewport: false });
        return shot.data;
      };
      let data: string;
      const clip = opts?.clip;
      if (clip) {
        // A viewport rectangle; the protocol's clip is in document coordinates.
        data = await capture({ x: clip.x + num(view.x), y: clip.y + num(view.y), width: clip.width, height: clip.height, scale: 1 });
      } else {
        data = await capture(undefined);
        const maxWidth = opts?.maxWidth;
        const size = pngSize(data);
        if (maxWidth !== undefined && size.width > maxWidth && num(view.w) > 0) {
          // Downscale at capture, one corrective pass if the first lands off target.
          const frame = { x: num(view.x), y: num(view.y), width: num(view.w), height: num(view.h) };
          let scale = maxWidth / size.width;
          let scaled = await capture({ ...frame, scale });
          const got = pngSize(scaled).width;
          if (got > 0 && Math.abs(got - maxWidth) > 1) {
            scale *= maxWidth / got;
            scaled = await capture({ ...frame, scale });
          }
          data = scaled;
        }
      }
      if (!data.length) return { error: 'screenshot returned an empty image' };
      const size = pngSize(data);
      return { mediaType: 'image/png', dataBase64: data, sizeBytes: Math.floor(data.length * 3 / 4), width: size.width, height: size.height };
    } catch (err) {
      return { error: 'screenshot failed: ' + errText(err) };
    }
  }

  function waitForLoad({ signal, timeoutMs, failures = 'main-frame' }: LoadWaitOptions): Promise<PageLoadOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let abortGrace: ReturnType<typeof setTimeout> | null = null;
      const settle = (outcome: PageLoadOutcome): void => {
        if (settled) return;
        settled = true;
        loadWaits.delete(settle);
        clearTimeout(timer);
        if (abortGrace) clearTimeout(abortGrace);
        chrome.webNavigation.onCompleted.removeListener(onCompleted);
        chrome.webNavigation.onErrorOccurred.removeListener(onError);
        if (signal) {
          try { signal.removeEventListener('abort', onAbort); } catch { /* no-op */ }
        }
        resolve(outcome);
      };
      const onCompleted = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails): void => {
        if (details.tabId === tabId && details.frameId === 0) settle({ kind: 'finished' });
      };
      const onError = (details: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails): void => {
        if (details.tabId !== tabId) return;
        const mainFrame = details.frameId === 0;
        if (!mainFrame && failures !== 'any-frame') return;
        const text = details.error || 'net::ERR_FAILED';
        const failed: PageLoadOutcome = { kind: 'failed', code: netErrorCode(text), description: text.replace(/^net::/, '') };
        if (mainFrame && failed.code === NET_ERR_ABORTED) {
          // Superseded: a newer main-frame navigation is on its way, or
          // arrives within the grace.
          if (lastNavigationUrl !== details.url) return;
          const seq = navSeq;
          if (abortGrace) clearTimeout(abortGrace);
          abortGrace = setTimeout(() => {
            abortGrace = null;
            if (navSeq === seq) settle(failed);
          }, SUPERSEDED_LOAD_GRACE_MS);
          return;
        }
        settle(failed);
      };
      const onAbort = (): void => settle({ kind: 'aborted' });
      const timer = setTimeout(() => settle({ kind: 'timed-out' }), timeoutMs);
      if (closed) { settle({ kind: 'destroyed' }); return; }
      loadWaits.add(settle);
      chrome.webNavigation.onCompleted.addListener(onCompleted);
      chrome.webNavigation.onErrorOccurred.addListener(onError);
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  let inputQueue: Promise<unknown> = Promise.resolve();
  function input(commands: readonly PageInputCommand[], stillPinned: (index: number) => boolean | Promise<boolean>): Promise<PageInputResult> {
    const run = inputQueue.then(async (): Promise<PageInputResult> => {
      if (closed) return { sent: 0, outcome: 'failed', error: 'page is closed' };
      return sendInputCommands(commands, stillPinned, async (c) => {
        if (closed) throw new Error('page is closed');
        await send(c.method, c.params);
      });
    });
    inputQueue = run.catch(() => undefined);
    return run;
  }

  async function documentToken(): Promise<string | null> {
    if (closed) return null;
    try {
      const token = await evaluate(DOCUMENT_TOKEN_SCRIPT, 'engine');
      return typeof token === 'string' ? token : null;
    } catch {
      return null;
    }
  }

  const subscribe = <T>(set: Set<(v: T) => void>, listener: (v: T) => void): Unsubscribe => {
    set.add(listener);
    return () => { set.delete(listener); };
  };

  return {
    tabId,
    capabilities: deps.capabilities ?? SESSION_CAPABILITIES,
    url: () => (closed ? '' : currentUrl),
    isClosed: () => closed,
    evaluate,
    screenshot,
    applyPreview(preview) {
      if (closed) return;
      enqueue(() => applyPreviewNow(preview));
    },
    removePreview(ruleKey) {
      if (closed) return;
      enqueue(() => removePreviewNow(ruleKey));
    },
    onRuntimeEvent: (listener) => subscribe(runtimeListeners, listener),
    onConsole: (listener) => subscribe(consoleListeners, listener),
    reload(url) {
      if (closed) return;
      if (url === undefined) void chrome.tabs.reload(tabId).catch(() => undefined);
      else void chrome.tabs.update(tabId, { url }).catch(() => undefined);
    },
    waitForLoad,
    input,
    documentToken,
    onPopup: (listener) => subscribe(popupListeners, listener),
    navigationCount: () => navigations,
    heldFor,
    heldAll,
    holdOnly: (patchId, ruleId) => queued(() => holdOnlyNow(patchId, ruleId)),
    releaseOnly: (patchId, ruleId) => queued(() => releaseOnlyNow(patchId, ruleId)),
    retainHolds: (patchId) => queued(() => retainHoldsNow(patchId)),
    releaseHolds: (patchId) => queued(() => releaseHoldsNow(patchId)),
    onClosed(listener) {
      if (closed) { try { listener(); } catch { /* its own */ } return () => undefined; }
      closedListeners.add(listener);
      return () => { closedListeners.delete(listener); };
    },
    async close() {
      if (closed) return;
      runtimeListeners.clear();
      consoleListeners.clear();
      popupListeners.clear();
      await queue;
      if (closed) return;
      // The previews go, then the held rules come back, then the connection.
      if (worldContextId !== null) {
        await send('Runtime.evaluate', {
          expression: `(() => { const c = globalThis[${JSON.stringify(RUNTIME_GLOBAL)}]; if (c) for (const k of c.previewKeys()) c.remove(k); })()`,
          contextId: worldContextId,
        }).catch(() => undefined);
      }
      const heldShims = new Set([...[...previewed.values()].map((p) => p.patchId), ...holdsOnly.keys()]);
      previewed.clear();
      holdsOnly.clear();
      for (const patchId of heldShims) await deps.nudge(tabId, { type: 'hold', patchId, ruleIds: [] });
      if (closed) return;
      await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }).catch(() => undefined);
      teardown();
      await chrome.debugger.detach(target).catch(() => undefined);
    },
  };
}
