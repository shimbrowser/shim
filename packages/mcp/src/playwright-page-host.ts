// The headless PageHost: one Playwright
// Chromium page, driven the way the real-browser spike (D12) proved works under a strict CSP.
//
//   Page.addScriptToEvaluateOnNewDocument { worldName }   the @shimbrowser/core
//       page bundle + the page runtime (headless-page-runtime.ts) in a CDP
//       isolated world, at document start, on every document;
//   Runtime.addBinding { executionContextName }           page → driver: engine
//       events and api calls;
//   Runtime.evaluate { contextId }                        driver → page: handler
//       compile (D4: the host compiles, the engine gets functions), preview
//       apply / remove, api answers;
//   page.screenshot                                       view_page.
//
// Chromium only (D9). Playwright is an optional peer dependency of
// @shimbrowser/mcp: this module imports its types only, and the caller hands
// in a Page (playwright-launch.ts opens one).
//
// What the host supports is HEADLESS_CAPABILITIES (D15). The engine is the
// same code the Shim browser runs; the conformance suite
// (@shimbrowser/core/page-host-conformance) runs the same cases against both
// hosts, and a capability stays "yes" here only while its cases pass on both.

import fs from 'fs';
import type { CDPSession, Page, Request } from 'playwright';
import type {
  PageHost, PageHostCapabilities, PageWorld, ScreenshotOptions, ScreenshotResult, PreviewRule,
  PageRuntimeEvent, PageConsoleMessage, PageLoadOutcome, LoadWaitOptions, Unsubscribe,
  PageInputCommand, PageInputResult,
} from '@shimbrowser/core/page-host';
import { DOCUMENT_TOKEN_SCRIPT, NET_ERR_ABORTED, SUPERSEDED_LOAD_GRACE_MS, sendInputCommands } from '@shimbrowser/core/page-host';
import { remoteObjectValue, netErrorCode, consoleLevel, formatConsoleArg, handlerSource } from '@shimbrowser/core/cdp-host';
import { pageRuntimeSource } from './headless-page-runtime';
import { imageSize } from './results';

/** The world the engine runs in. */
export const HEADLESS_ENGINE_WORLD = 'shim-core';
const BINDING = '__shimCoreHost';
const RUNTIME_GLOBAL = '__shimCoreRuntime';
/** What a never-throw member the headless host lacks resolves with (D15). */
export const REQUIRES_SHIM_BROWSER = 'requires-shim-browser';

/**
 * The headless v1 capability set (D15): tiers 1–4 minus the routing kind, no
 * iframe rules, no host api members beyond `storage` / `cleanup`, and no
 * component identity. Preflight rejects a spec that declares anything
 * outside it; an undeclared use fails in its own shape at runtime.
 */
export const HEADLESS_CAPABILITIES: PageHostCapabilities = Object.freeze({
  mutationKinds: Object.freeze([
    'hide', 'restyle', 'reorder', 'reshape',
    'script', 'inject-element', 'inject-html', 'remove', 'replace-root',
  ]),
  iframeRules: false,
  // Previews are per rule (applyExtraRule on a stub spec): nothing installs
  // the spec-level stylesheet, so a shim that has one is refused (D15).
  specCss: false,
  apiMembers: Object.freeze([]),
  componentIdentity: false,
  engineInspection: false,
  // CDP Input.* on the host's own session: the same trusted events the Shim
  // browser sends.
  trustedInput: true,
});

// --- api.storage ---------------------------------------------------------------

/** Which bucket an `api.storage` call reads: the preview's shim, on the page's origin. */
export interface StorageScope {
  patchId: string;
  origin: string;
}

/**
 * The backing store for handlers' `api.storage`. Values are JSON; a missing
 * key reads as null, `set` answers the value, `delete` whether a row went
 * away — the browser's semantics.
 */
export interface HeadlessStorage {
  get(scope: StorageScope, key: string): Promise<unknown>;
  set(scope: StorageScope, key: string, value: unknown): Promise<unknown>;
  delete(scope: StorageScope, key: string): Promise<boolean>;
  list(scope: StorageScope): Promise<Record<string, unknown>>;
}

/** An in-memory HeadlessStorage (the default; a headless session swaps in a file-backed one). */
export function memoryStorage(): HeadlessStorage {
  const buckets = new Map<string, Map<string, string>>();
  const bucket = (scope: StorageScope): Map<string, string> => {
    const id = `${scope.origin}\n${scope.patchId}`;
    let b = buckets.get(id);
    if (!b) {
      b = new Map();
      buckets.set(id, b);
    }
    return b;
  };
  return {
    get: async (scope, key) => {
      const raw = bucket(scope).get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    set: async (scope, key, value) => {
      bucket(scope).set(key, JSON.stringify(value) ?? 'null');
      return value;
    },
    delete: async (scope, key) => bucket(scope).delete(key),
    list: async (scope) => {
      const out: Record<string, unknown> = {};
      for (const [k, raw] of bucket(scope)) out[k] = JSON.parse(raw);
      return out;
    },
  };
}

// --- options -------------------------------------------------------------------

export interface PlaywrightPageHostOptions {
  /** The @shimbrowser/core page bundle's source. Default: read from `@shimbrowser/core/page`. */
  engineBundle?: string;
  /** Backs handlers' `api.storage`. Default: memoryStorage(). */
  storage?: HeadlessStorage;
  /** How long a preview apply or an engine-world evaluate waits for the world to exist. Default 5000. */
  worldWaitMs?: number;
}

/** A PageHost over a Playwright page, plus the one thing only a driver needs: letting go of the page. */
export interface PlaywrightPageHost extends PageHost {
  /** Stop driving the page: remove every preview, unsubscribe, detach the CDP session. Leaves the page open. */
  detach(): Promise<void>;
}

// Embedded by the one-file plugin build (scripts/build.js); undefined when
// this module runs from the workspace or an npm install.
declare const SHIM_CORE_PAGE_BUNDLE: string | undefined;

/** The @shimbrowser/core browser bundle: the one embedded in the plugin build, else `@shimbrowser/core/page`. */
export function readEngineBundle(): string {
  if (typeof SHIM_CORE_PAGE_BUNDLE === 'string') return SHIM_CORE_PAGE_BUNDLE;
  return fs.readFileSync(require.resolve('@shimbrowser/core/page'), 'utf8');
}

// --- small helpers ---------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A captured PNG's pixel size, read from its header.
function pngSize(buf: Buffer): { width: number; height: number } {
  return imageSize(buf.subarray(0, 32).toString('base64')) ?? { width: 0, height: 0 };
}

// The CDP helpers (a RemoteObject's value, net error codes, console levels
// and arguments, the handler source) live in core, shared with Shim for
// Chrome's session host; the two the harness reads are re-exported here.
export { remoteObjectValue, netErrorCode };

// --- the host ----------------------------------------------------------------

export async function attachPlaywrightPageHost(page: Page, options: PlaywrightPageHostOptions = {}): Promise<PlaywrightPageHost> {
  const bundle = options.engineBundle ?? readEngineBundle();
  const storage = options.storage ?? memoryStorage();
  const worldWaitMs = options.worldWaitMs ?? 5000;
  const cdp: CDPSession = await page.context().newCDPSession(page);

  const runtimeListeners = new Set<(event: PageRuntimeEvent) => void>();
  const consoleListeners = new Set<(message: PageConsoleMessage) => void>();
  let mainFrameId = '';
  let worldContextId: number | null = null;
  let worldWaiters: Array<(id: number | null) => void> = [];
  let detached = false;
  let navigations = 0;
  // Pending load waits, so detach can settle them and drop their listeners
  // at once rather than leaving them watching a page it no longer drives.
  const loadWaits = new Set<(outcome: PageLoadOutcome) => void>();
  // Preview work runs in order, one step at a time, so an apply and a remove
  // sent back to back land in that order — as IPC sends do in the browser.
  let queue: Promise<void> = Promise.resolve();

  const setWorld = (id: number | null): void => {
    worldContextId = id;
    if (id === null) return;
    const waiters = worldWaiters;
    worldWaiters = [];
    for (const w of waiters) w(id);
  };
  const waitForWorld = (ms: number): Promise<number | null> => {
    // A detached host has no world to wait for: a queued step that starts
    // after detach gives up at once instead of holding detach's `await queue`.
    if (detached) return Promise.resolve(null);
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

  // --- CDP events ---
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    const aux: unknown = context.auxData;
    if (context.name === HEADLESS_ENGINE_WORLD && isRecord(aux) && aux.frameId === mainFrameId) setWorld(context.id);
  });
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    if (executionContextId === worldContextId) setWorld(null);
  });
  cdp.on('Runtime.executionContextsCleared', () => setWorld(null));
  cdp.on('Page.frameNavigated', ({ frame }) => {
    if (!frame.parentId) { mainFrameId = frame.id; navigations++; }
  });
  // Every main-frame navigation advances the count as soon as it is asked
  // for or starts, and same-document ones too (navigationCount).
  cdp.on('Page.frameRequestedNavigation', ({ frameId }) => { if (frameId === mainFrameId) navigations++; });
  cdp.on('Page.frameStartedNavigating', ({ frameId }) => { if (frameId === mainFrameId) navigations++; });
  cdp.on('Page.navigatedWithinDocument', ({ frameId }) => { if (frameId === mainFrameId) navigations++; });
  cdp.on('Runtime.bindingCalled', ({ name, payload, executionContextId }) => {
    if (name !== BINDING || executionContextId !== worldContextId) return;
    let msg: unknown;
    try { msg = JSON.parse(payload); } catch { return; }
    if (!isRecord(msg)) return;
    if (msg.type === 'event' && typeof msg.kind === 'string') {
      emitRuntime({ ...(isRecord(msg.payload) ? msg.payload : {}), kind: msg.kind });
    } else if (msg.type === 'call' && typeof msg.id === 'number' && typeof msg.method === 'string') {
      void answerCall(executionContextId, msg.id, msg.method, msg.patchId, msg.origin, msg.args);
    }
  });
  // A line vouches for the engine only when CDP says it ran in the engine's
  // world: the context this host created, which page script can't run in.
  // The text and the source (a `//# sourceURL=` pragma) are the page's to forge.
  const inEngineWorld = (contextId: number | undefined): boolean =>
    contextId !== undefined && worldContextId !== null && contextId === worldContextId;
  cdp.on('Runtime.consoleAPICalled', ({ type, args, stackTrace, executionContextId }) => {
    const frame = stackTrace?.callFrames[0];
    emitConsole({
      level: consoleLevel(type),
      message: args.map((a) => formatConsoleArg(a)).join(' '),
      source: frame?.url ?? '',
      ...(inEngineWorld(executionContextId) ? { engineWorld: true } : {}),
    });
  });
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    const description = exceptionDetails.exception?.description ?? exceptionDetails.text;
    const firstLine = description.split('\n')[0] ?? description;
    emitConsole({
      level: 'error',
      message: firstLine.startsWith('Uncaught') ? firstLine : `Uncaught ${firstLine}`,
      source: exceptionDetails.url ?? '',
      ...(inEngineWorld(exceptionDetails.executionContextId) ? { engineWorld: true } : {}),
    });
  });

  // The api's answering leg: run the store call, settle the page's promise
  // in the context that asked. A store that fails rejects it, as the
  // browser's IPC invoke does, so a handler never reads a failed write as
  // done. A context that went away drops the answer.
  async function answerCall(contextId: number, id: number, method: string, patchId: unknown, origin: unknown, rawArgs: unknown): Promise<void> {
    const args = Array.isArray(rawArgs) ? rawArgs : [];
    const scope: StorageScope = { patchId: typeof patchId === 'string' ? patchId : '', origin: typeof origin === 'string' ? origin : '' };
    const key = typeof args[0] === 'string' ? args[0] : String(args[0]);
    let expression: string;
    try {
      let value: unknown;
      if (method === 'storage.get') value = await storage.get(scope, key);
      else if (method === 'storage.set') value = await storage.set(scope, key, args[1]);
      else if (method === 'storage.delete') value = await storage.delete(scope, key);
      else if (method === 'storage.list') value = await storage.list(scope);
      else value = undefined;
      // The reply crosses as a quoted JSON string parsed page-side, never as
      // an object literal: a literal would turn an own `__proto__` key into a
      // prototype setter, so the handler would read a different object than
      // the store holds.
      const json: string | undefined = value === undefined ? undefined : JSON.stringify(value);
      const literal = json === undefined ? 'undefined' : `JSON.parse(${JSON.stringify(json)})`;
      expression = `globalThis[${JSON.stringify(RUNTIME_GLOBAL)}].resolve(${id}, ${literal})`;
    } catch (err) {
      expression = `globalThis[${JSON.stringify(RUNTIME_GLOBAL)}].reject(${id}, ${JSON.stringify(`${method} failed: ${errText(err)}`)})`;
    }
    await cdp.send('Runtime.evaluate', { expression, contextId }).catch(() => { /* the document went away */ });
  }

  // --- setup ---
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const { frameTree } = await cdp.send('Page.getFrameTree');
  mainFrameId = frameTree.frame.id;
  await cdp.send('Runtime.addBinding', { name: BINDING, executionContextName: HEADLESS_ENGINE_WORLD });
  const worldScript = `${bundle}\n${pageRuntimeSource({ binding: BINDING, globalName: RUNTIME_GLOBAL, unsupportedError: REQUIRES_SHIM_BROWSER })}`;
  const { identifier: scriptId } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: worldScript,
    worldName: HEADLESS_ENGINE_WORLD,
  });
  // The document already loaded when we attached never saw the script: give
  // it the world now, so a host attached to an open page works without a
  // reload.
  if (worldContextId === null) {
    try {
      const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
        frameId: mainFrameId,
        worldName: HEADLESS_ENGINE_WORLD,
        grantUniveralAccess: false,
      });
      const res = await cdp.send('Runtime.evaluate', { expression: worldScript, contextId: executionContextId });
      if (!res.exceptionDetails) setWorld(executionContextId);
    } catch {
      /* a navigation raced the attach; its new document runs the script itself */
    }
  }

  // --- the PageHost members ---

  async function evaluateIn(code: string, contextId: number | undefined): Promise<unknown> {
    const res = await cdp.send('Runtime.evaluate', {
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
    if (detached || page.isClosed()) throw new Error('page is closed');
    if (world === 'main') return evaluateIn(code, undefined);
    const contextId = await waitForWorld(worldWaitMs);
    if (contextId === null) throw new Error('the engine world is not available on this page');
    return evaluateIn(code, contextId);
  }

  async function compileHandler(contextId: number, patchId: string, ruleKey: string, name: string, source: string): Promise<void> {
    const objectGroup = `shim-compile-${ruleKey}`;
    const rt = `globalThis[${JSON.stringify(RUNTIME_GLOBAL)}]`;
    // One instance per shim, name and source in the document, as the Shim
    // browser keeps it: reuse it rather than evaluating the source (and a
    // stored module's top-level code) again. A shared instance keeps the
    // sourceURL of the rule that compiled it, so an async throw from it names
    // that rule; the engine attributes a throw from the call itself by rule.
    const shareKey = `${patchId}\u0000${name}\u0000${source}`;
    const reused = await cdp.send('Runtime.evaluate', {
      expression: `${rt}.defineShared(${JSON.stringify(ruleKey)}, ${JSON.stringify(name)}, ${JSON.stringify(shareKey)})`,
      contextId,
      returnByValue: true,
    });
    if (reused.result.value === true) return;
    try {
      const res = await cdp.send('Runtime.evaluate', { expression: handlerSource(source, ruleKey, name), contextId, objectGroup });
      if (res.exceptionDetails) {
        const ex = res.exceptionDetails;
        const detail = ex.exception?.description ?? ex.text;
        // As the browser's preload does: the failure is logged in the page and
        // the handler is skipped, so the engine reports it as unknown.
        await cdp.send('Runtime.evaluate', {
          expression: `console.error(${JSON.stringify(`[shim] failed to compile inline handler "${name}"`)}, ${JSON.stringify(detail)})`,
          contextId,
        });
        return;
      }
      const fnId = res.result.objectId;
      if (fnId) {
        await cdp.send('Runtime.callFunctionOn', {
          functionDeclaration: `function (fn, key) { ${rt}.shareHandler(key, fn); return ${rt}.defineHandler(${JSON.stringify(ruleKey)}, ${JSON.stringify(name)}, fn); }`,
          executionContextId: contextId,
          arguments: [{ objectId: fnId }, { value: shareKey }],
          returnByValue: true,
        });
      } else {
        // A primitive (not a function): hand it over as-is, as the browser
        // does; the engine reports the call failing.
        await cdp.send('Runtime.callFunctionOn', {
          functionDeclaration: `function (v) { return globalThis[${JSON.stringify(RUNTIME_GLOBAL)}].defineHandler(${JSON.stringify(ruleKey)}, ${JSON.stringify(name)}, v); }`,
          executionContextId: contextId,
          arguments: [res.result.unserializableValue !== undefined
            ? { unserializableValue: res.result.unserializableValue }
            : { value: res.result.value }],
          returnByValue: true,
        });
      }
    } finally {
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
    }
  }

  async function applyPreviewNow(preview: PreviewRule): Promise<void> {
    const contextId = await waitForWorld(worldWaitMs);
    if (contextId === null || detached) return;
    const { patchId, rule, ruleKey, bundleHash, applyId, autoRepair } = preview;
    for (const [name, source] of Object.entries(rule.handlers ?? {})) {
      if (typeof source !== 'string') continue;
      await compileHandler(contextId, patchId, ruleKey, name, source);
    }
    await cdp.send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(RUNTIME_GLOBAL)}].apply(${JSON.stringify(patchId)}, ${JSON.stringify(rule)}, ${JSON.stringify(ruleKey)}, ${JSON.stringify(bundleHash ?? null)}, ${JSON.stringify(applyId ?? null)}, ${JSON.stringify(autoRepair ?? null)})`,
      contextId,
    });
  }

  async function removePreviewNow(ruleKey: string): Promise<void> {
    if (worldContextId === null || detached) return;
    await cdp.send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(RUNTIME_GLOBAL)}].remove(${JSON.stringify(ruleKey)})`,
      contextId: worldContextId,
    });
  }

  const enqueue = (work: () => Promise<void>): void => {
    queue = queue.then(work).catch(() => { /* the document went away mid-step */ });
  };

  async function screenshot(opts: ScreenshotOptions | undefined): Promise<ScreenshotResult> {
    if (detached || page.isClosed()) return { error: 'page is closed' };
    const clip = opts?.clip;
    try {
      let buf: Buffer = clip
        ? await page.screenshot({ type: 'png', clip })
        : await page.screenshot({ type: 'png' });
      let size = pngSize(buf);
      const maxWidth = opts?.maxWidth;
      if (!clip && maxWidth !== undefined && size.width > maxWidth) {
        // Downscale at capture: Page.captureScreenshot's clip scale renders the
        // viewport straight to the target width (the browser resizes the image
        // after capture; the result is the same picture at the same size). The
        // capture is clip × scale × the compositor's scale, which a visible
        // window on a high-DPI screen keeps even when the page's own ratio is
        // emulated to 1 — so one corrective pass if the first lands off target.
        // The CDP clip is in document coordinates: offset by the scroll so the
        // shot is the viewport, as without a downscale.
        const vp = await evaluateIn('({ w: window.innerWidth, h: window.innerHeight, x: window.scrollX, y: window.scrollY })', undefined);
        if (isRecord(vp) && typeof vp.w === 'number' && typeof vp.h === 'number' && vp.w > 0) {
          const capture = async (scale: number): Promise<Buffer> => {
            const shot = await cdp.send('Page.captureScreenshot', {
              format: 'png',
              clip: { x: Number(vp.x) || 0, y: Number(vp.y) || 0, width: Number(vp.w), height: Number(vp.h), scale },
              captureBeyondViewport: false,
            });
            return Buffer.from(shot.data, 'base64');
          };
          let scale = maxWidth / size.width;
          let scaled = await capture(scale);
          const got = pngSize(scaled).width;
          if (got > 0 && Math.abs(got - maxWidth) > 1) {
            scale *= maxWidth / got;
            scaled = await capture(scale);
          }
          buf = scaled;
          size = pngSize(buf);
        }
      }
      if (!buf.length) return { error: 'screenshot returned an empty image' };
      return { mediaType: 'image/png', dataBase64: buf.toString('base64'), sizeBytes: buf.length, width: size.width, height: size.height };
    } catch (err) {
      return { error: 'screenshot failed: ' + errText(err) };
    }
  }

  // A main-frame ERR_ABORTED is a load another navigation superseded (a
  // page script's `location.replace` during the load), not a failure: the
  // wait follows the navigation request that took over, already sent or sent
  // within the grace window. Only an abort nothing took over ends it as failed.
  function waitForLoad({ signal, timeoutMs, failures = 'main-frame' }: LoadWaitOptions): Promise<PageLoadOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let abortGrace: ReturnType<typeof setTimeout> | null = null;
      let lastNavigation: Request | null = null;
      const settle = (outcome: PageLoadOutcome): void => {
        if (settled) return;
        settled = true;
        loadWaits.delete(settle);
        clearTimeout(timer);
        if (abortGrace) clearTimeout(abortGrace);
        page.off('load', onLoad);
        page.off('request', onRequest);
        page.off('requestfailed', onFailed);
        page.off('close', onClose);
        if (signal) {
          try { signal.removeEventListener('abort', onAbort); } catch { /* no-op */ }
        }
        resolve(outcome);
      };
      const isMainNavigation = (req: Request): boolean | null => {
        try {
          if (!req.isNavigationRequest()) return null;
          return req.frame() === page.mainFrame();
        } catch {
          return null;
        }
      };
      const onLoad = (): void => settle({ kind: 'finished' });
      const onRequest = (req: Request): void => {
        if (isMainNavigation(req) === true) lastNavigation = req;
      };
      const onFailed = (req: Request): void => {
        const mainFrame = isMainNavigation(req);
        if (mainFrame === null) return;
        if (!mainFrame && failures !== 'any-frame') return;
        const text = req.failure()?.errorText ?? 'net::ERR_FAILED';
        const failed: PageLoadOutcome = { kind: 'failed', code: netErrorCode(text), description: text.replace(/^net::/, '') };
        if (mainFrame && failed.code === NET_ERR_ABORTED) {
          // Superseded: a newer main-frame navigation is already on its way.
          if (lastNavigation !== null && lastNavigation !== req) return;
          if (abortGrace) clearTimeout(abortGrace);
          abortGrace = setTimeout(() => {
            abortGrace = null;
            if (lastNavigation === null || lastNavigation === req) settle(failed);
          }, SUPERSEDED_LOAD_GRACE_MS);
          return;
        }
        settle(failed);
      };
      const onClose = (): void => settle({ kind: 'destroyed' });
      const onAbort = (): void => settle({ kind: 'aborted' });
      const timer = setTimeout(() => settle({ kind: 'timed-out' }), timeoutMs);
      if (detached || page.isClosed()) { settle({ kind: 'destroyed' }); return; }
      loadWaits.add(settle);
      page.on('load', onLoad);
      page.on('request', onRequest);
      page.on('requestfailed', onFailed);
      page.on('close', onClose);
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  // Trusted input: CDP Input.* on the host's session, one batch at a time.
  let inputQueue: Promise<unknown> = Promise.resolve();
  const sendCdp = cdp.send.bind(cdp) as unknown as (method: string, params: Record<string, unknown>) => Promise<unknown>;
  function input(commands: readonly PageInputCommand[], stillPinned: (index: number) => boolean | Promise<boolean>): Promise<PageInputResult> {
    const run = inputQueue.then(async (): Promise<PageInputResult> => {
      if (detached || page.isClosed()) return { sent: 0, outcome: 'failed', error: 'page is closed' };
      return sendInputCommands(commands, stillPinned, async (c) => {
        if (detached || page.isClosed()) throw new Error('page is closed');
        await sendCdp(c.method, c.params);
      });
    });
    inputQueue = run.catch(() => undefined);
    return run;
  }

  async function documentToken(): Promise<string | null> {
    if (detached || page.isClosed()) return null;
    try {
      const token = await evaluate(DOCUMENT_TOKEN_SCRIPT, 'engine');
      return typeof token === 'string' ? token : null;
    } catch {
      return null;
    }
  }

  // Popups while someone listens (an interact_page batch): closed on
  // creation and reported. A weaker guarantee than the browser's deny at
  // creation: the popup exists for a moment before it closes.
  const popupListeners = new Set<(url: string) => void>();
  page.on('popup', (popup) => {
    if (popupListeners.size === 0) return;
    let url = '';
    try { url = popup.url(); } catch { /* closing already */ }
    void popup.close().catch(() => undefined);
    for (const l of [...popupListeners]) {
      try { l(url); } catch { /* a listener's throw is its own */ }
    }
  });

  const subscribe = <T>(set: Set<(v: T) => void>, listener: (v: T) => void): Unsubscribe => {
    set.add(listener);
    return () => { set.delete(listener); };
  };

  return {
    capabilities: HEADLESS_CAPABILITIES,
    // Detached reads as closed (isClosed), so no URL either: the page itself
    // stays open, but this host no longer answers for it.
    url: () => (detached || page.isClosed() ? '' : page.url()),
    isClosed: () => detached || page.isClosed(),
    evaluate,
    screenshot,
    applyPreview(preview) {
      if (detached) return;
      enqueue(() => applyPreviewNow(preview));
    },
    removePreview(ruleKey) {
      if (detached) return;
      enqueue(() => removePreviewNow(ruleKey));
    },
    onRuntimeEvent: (listener) => subscribe(runtimeListeners, listener),
    onConsole: (listener) => subscribe(consoleListeners, listener),
    reload(url) {
      if (detached || page.isClosed()) return;
      // Navigation errors settle waitForLoad (requestfailed); the promise is
      // only the Playwright call's own bookkeeping.
      if (url === undefined) void page.reload({ waitUntil: 'commit' }).catch(() => undefined);
      else void page.goto(url, { waitUntil: 'commit' }).catch(() => undefined);
    },
    waitForLoad,
    input,
    documentToken,
    onPopup: (listener) => subscribe(popupListeners, listener),
    navigationCount: () => navigations,
    async detach() {
      if (detached) return;
      detached = true;
      runtimeListeners.clear();
      consoleListeners.clear();
      popupListeners.clear();
      // A detached host reads as closed, so a pending load wait ends the way
      // it would on close — now, with its timer and page listeners removed.
      for (const settle of [...loadWaits]) settle({ kind: 'destroyed' });
      // Let queued preview work settle first (a step still waiting for the
      // world gives up now), then tear down every preview the runtime holds:
      // the page stays open, and a caller reusing it gets it back unmodified.
      for (const w of worldWaiters) w(null);
      worldWaiters = [];
      await queue;
      if (worldContextId !== null && !page.isClosed()) {
        await cdp.send('Runtime.evaluate', {
          expression: `(() => { const c = globalThis[${JSON.stringify(RUNTIME_GLOBAL)}]; if (c) for (const k of c.previewKeys()) c.remove(k); })()`,
          contextId: worldContextId,
        }).catch(() => undefined);
      }
      setWorld(null);
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    },
  };
}
