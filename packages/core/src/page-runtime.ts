// A CDP host's in-page half: the code a host that drives a page over the
// Chrome DevTools Protocol (the headless Playwright driver, Shim for
// Chrome's session host) evaluates in the isolated world it creates, right
// after the page bundle (global `ShimCore`). It is the counterpart of the
// Shim browser's page-preload for authoring previews, and nothing else:
//
//   - one engine control per preview, applied through the same
//     `applyExtraRule` path the browser's stub engine uses, so a preview runs
//     under its ruleKey exactly as it does in Shim;
//   - the handler api a preview receives: the core members, `api.storage`
//     answered by the driver over the binding, and every member the headless
//     host lacks failing in its own shape (D15) with an `unsupported-api`
//     event;
//   - the runtime error reporter (window error / unhandledrejection, attributed
//     by the handler's sourceURL), the same filter the browser's preload uses;
//   - the handler-fetch budget, pacing same-site fetches.
//
// Handlers are NOT compiled here. The driver compiles each one with
// Runtime.evaluate in this world (the path the real-browser spike (D12) proved under a strict
// CSP) and hands the function in through `defineHandler` (D4).
//
// `installPageRuntime` is serialized with Function.prototype.toString and
// evaluated in the page, so it must stay self-contained: no imports at
// runtime, no reference to anything outside its own body. Types only.

import type * as Core from './index';
import type { Rule } from './types';

export interface PageRuntimeConfig {
  /** The Runtime.addBinding name: page → driver messages. */
  binding: string;
  /** Where the runtime parks its control object on the world's globalThis. */
  globalName: string;
  /** The `error` an unsupported never-throw member resolves with (D15). */
  unsupportedError: string;
}

/** The control object the driver calls into, by Runtime.evaluate / callFunctionOn. */
export interface PageRuntimeControl {
  defineHandler(ruleKey: string, name: string, fn: unknown): string;
  /** Keeps a compiled handler as this document's one instance under `key`. */
  shareHandler(key: string, fn: unknown): void;
  /** Defines a rule's handler from the instance kept under `key`; false when there is none yet. */
  defineShared(ruleKey: string, name: string, key: string): boolean;
  /** `autoRepair` rides only with `bundleHash` (PreviewRule.autoRepair): false keeps the anchor-changing rebases off. */
  apply(patchId: string, rule: Rule, ruleKey: string, bundleHash: string | null, applyId?: string | null, autoRepair?: boolean | null): boolean;
  remove(ruleKey: string): boolean;
  resolve(id: number, value: unknown): boolean;
  /** Rejects a pending api call: the driver's store failed. */
  reject(id: number, message: string): boolean;
  previewKeys(): string[];
}

type PatchControl = ReturnType<typeof Core.run>;
type HandlerMap = NonNullable<Parameters<PatchControl['applyExtraRule']>[3]>;
type HandlerFn = HandlerMap[string];

export function installPageRuntime(config: PageRuntimeConfig): void {
  // Top frame only: the headless host does not run rules in child frames
  // (D15: `anchor.iframe` is unsupported), and a frame's binding messages
  // would otherwise be indistinguishable from the page's.
  if (window.top !== window) return;
  const host = globalThis as unknown as Record<string, unknown>;
  if (host[config.globalName]) return;
  const ShimCore = host.ShimCore as typeof Core | undefined;
  const send = host[config.binding] as ((payload: string) => void) | undefined;
  if (!ShimCore || typeof ShimCore.run !== 'function' || typeof send !== 'function') return;

  // Events are fire-and-forget: one that cannot be serialized, or a driver
  // that went away, drops it. An api call goes through `call`, which rejects
  // instead (see below).
  const post = (msg: Record<string, unknown>): void => {
    try { send(JSON.stringify(msg)); } catch (_) { /* driver gone or unserializable — drop */ }
  };
  const emit = (kind: string, payload: Record<string, unknown>): void => {
    post({ type: 'event', kind, payload });
  };

  // --- api calls answered by the driver -------------------------------------
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  let seq = 0;
  // A call whose request never reaches the driver (arguments JSON cannot
  // carry — a cycle, a BigInt — or a binding that went away) rejects at once,
  // as the browser's IPC invoke does, instead of leaving the handler awaiting
  // an answer that will never come.
  //
  // JSON alone is not enough: it turns a function or symbol into null, or
  // drops it from an object, so the store would quietly write a different
  // value. The browser's structured-clone IPC refuses those, keeping what was
  // stored; `unclonable` finds them first so this host refuses them too.
  const unclonable = (value: unknown, seen: Set<object>): string | null => {
    if (typeof value === 'function') return 'a function';
    if (typeof value === 'symbol') return 'a symbol';
    if (typeof value !== 'object' || value === null || seen.has(value)) return null;
    seen.add(value);
    // Own enumerable string keys: the ones both JSON and structured clone
    // carry (each ignores symbol keys alike).
    for (const key of Object.keys(value)) {
      const found = unclonable((value as Record<string, unknown>)[key], seen);
      if (found) return found;
    }
    return null;
  };
  const call = (method: string, patchId: string, args: unknown[]): Promise<unknown> => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const bad = unclonable(args, new Set());
      if (bad) {
        reject(new Error(`${method} failed: ${bad} could not be cloned`));
        return;
      }
      let payload: string;
      try {
        payload = JSON.stringify({ type: 'call', id, method, patchId, origin: location.origin, args });
      } catch (err) {
        reject(new Error(`${method} failed: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      pending.set(id, { resolve, reject });
      try {
        send(payload);
      } catch (err) {
        pending.delete(id);
        reject(new Error(`${method} failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  };

  // --- the handler api ---------------------------------------------------------
  const onReady = (fn: () => void): void => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };
  const makeApi = (patchId: string, ruleKey: string, applyId: string | null): Core.CoreApi & Record<string, unknown> => {
    // Every event the preview reports carries the version tag it was applied
    // with (PreviewRule.applyId), so the session can drop a late one from a
    // version it has since replaced.
    const tag = applyId ? { applyId } : {};
    // D15: every unsupported member records an event, including a read of
    // an absent one, so the session can mark the rule `partial`.
    const unsupported = (member: string): void => {
      emit('unsupported-api', { specId: ruleKey, member, path: location.pathname, ...tag });
    };
    const refusal = (member: string) => (): Promise<{ ok: false; error: string }> => {
      unsupported(member);
      return Promise.resolve({ ok: false, error: config.unsupportedError });
    };
    const absent = (target: object, prop: string, member: string): void => {
      Object.defineProperty(target, prop, {
        configurable: true,
        enumerable: false,
        get() { unsupported(member); return undefined; },
      });
    };
    const storage: Record<string, unknown> = {
      get: (key: string) => call('storage.get', patchId, [key]),
      set: (key: string, value: unknown) => call('storage.set', patchId, [key, value]),
      delete: (key: string) => call('storage.delete', patchId, [key]),
      list: () => call('storage.list', patchId, []),
    };
    absent(storage, 'pack', 'storage.pack');
    absent(storage, 'global', 'storage.global');
    const api: Core.CoreApi & Record<string, unknown> = {
      origin: location.origin,
      host: location.hostname,
      patchId,
      bridge: {
        forwardRule() { unsupported('bridge.forwardRule'); },
      },
      // No framework-component bridge headless: the same answers the browser
      // gives on a non-React page, so the engine treats the signal as absent.
      componentId: {
        verify: () => Promise.resolve(null),
        find: () => Promise.resolve([]),
        symbols: () => Promise.resolve(null),
      },
      storage,
      settings: {
        get: () => { unsupported('settings.get'); return Promise.resolve(undefined); },
        getAll: () => { unsupported('settings.getAll'); return Promise.resolve({}); },
      },
      fetch: refusal('fetch'),
      ai: { complete: refusal('ai.complete') },
      modules: { invoke: refusal('modules.invoke') },
      reportEvent(kind: string, payload?: Record<string, unknown>) {
        // Every engine event carries the page's path, as the browser's
        // page-preload stamps it.
        emit(kind, { ...(payload || {}), path: location.pathname, ...tag });
      },
      onReady,
    };
    absent(api, 'db', 'db');
    absent(api, 'shared', 'shared');
    return api;
  };

  // --- previews ----------------------------------------------------------------
  const compiled = new Map<string, HandlerMap>();
  const previews = new Map<string, PatchControl>();
  // Handlers compiled once per shim, name and source for this document, as
  // the Shim browser keeps one instance per stored module.
  const sharedHandlers = new Map<string, unknown>();
  const deployId = (): string | null => ShimCore.deployIdForDocument(document);

  const remove = (ruleKey: string): boolean => {
    const control = previews.get(ruleKey);
    if (!control) return false;
    previews.delete(ruleKey);
    try {
      control.teardownAll();
    } catch (err) {
      console.error('[shim] preview teardown failed', err);
    }
    return true;
  };

  const control: PageRuntimeControl = {
    defineHandler(ruleKey, name, fn) {
      let handlers = compiled.get(ruleKey);
      if (!handlers) {
        handlers = {};
        compiled.set(ruleKey, handlers);
      }
      handlers[name] = fn as HandlerFn;
      return name;
    },
    shareHandler(key, fn) {
      sharedHandlers.set(key, fn);
    },
    defineShared(ruleKey, name, key) {
      if (!sharedHandlers.has(key)) return false;
      control.defineHandler(ruleKey, name, sharedHandlers.get(key));
      return true;
    },
    apply(patchId, rule, ruleKey, bundleHash, applyId, autoRepair) {
      remove(ruleKey);
      const handlers = compiled.get(ruleKey);
      compiled.delete(ruleKey);
      try {
        // One stub control per preview (the browser runs every preview on one
        // stub): its api is per preview, so storage keys by the preview's
        // shim and an unsupported-api event names the preview.
        const previewControl = ShimCore.run({ spec: { id: ruleKey, rules: [] } }, makeApi(patchId, ruleKey, typeof applyId === 'string' && applyId ? applyId : null));
        previews.set(ruleKey, previewControl);
        const deploy = typeof bundleHash === 'string'
          ? { bundleHash, current: deployId, ...(autoRepair === false ? { autoRepair: false } : {}) }
          : undefined;
        previewControl.applyExtraRule(rule, ruleKey, ruleKey, handlers, deploy);
        return true;
      } catch (err) {
        console.error('[shim] preview apply failed', err);
        return false;
      }
    },
    remove,
    resolve(id, value) {
      const settle = pending.get(id);
      pending.delete(id);
      if (settle) settle.resolve(value);
      return Boolean(settle);
    },
    reject(id, message) {
      const settle = pending.get(id);
      pending.delete(id);
      if (settle) settle.reject(new Error(message));
      return Boolean(settle);
    },
    previewKeys: () => [...previews.keys()],
  };
  Object.defineProperty(host, config.globalName, { value: control, configurable: false, enumerable: false, writable: false });

  // --- runtime error reporter (handler throws that escape the engine) ----------
  // Same attribution as the browser's page-preload-error-reporter: only throws
  // whose stack or source names a handler's sourceURL are reported.
  const HANDLER_URL_RE = /shim:\/\/patches\/([^/\s]+)\/handlers\/([^/.\s]+)/;
  const trimStack = (stack: string): string => (stack ? stack.split('\n').slice(0, 8).join('\n') : '');
  const attribute = (stack: string, message: string): { specId: string; handlerName: string } | null => {
    const m = `${stack || ''}\n${message || ''}`.match(HANDLER_URL_RE);
    if (!m || !m[1] || !m[2]) return null;
    return { specId: m[1], handlerName: m[2] };
  };
  window.addEventListener('error', (event: ErrorEvent) => {
    const err: unknown = event.error;
    const stack = err instanceof Error ? (err.stack || '') : '';
    const attr = attribute(stack, event.filename);
    if (!attr) return;
    emit('handler-error', {
      specId: attr.specId,
      handlerName: attr.handlerName,
      message: (err instanceof Error ? err.message : undefined) || event.message || 'unknown error',
      stack: trimStack(stack),
    });
  });
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    const stack = reason instanceof Error ? (reason.stack || '') : '';
    const message = reason instanceof Error ? reason.message : (typeof reason === 'string' ? reason : String(reason));
    const attr = attribute(stack, message);
    if (!attr) return;
    emit('handler-error', { specId: attr.specId, handlerName: attr.handlerName, message, stack: trimStack(stack) });
  });

  // --- handler-fetch budget --------------------------------------
  // Wraps this world's fetch only (the page's own is another realm). Same-site
  // requests over budget are delayed, never rejected.
  {
    const budget = ShimCore.createFetchBudget();
    const nativeFetch = globalThis.fetch.bind(globalThis);
    let announced = false;
    const paced: typeof fetch = async (input, init) => {
      let sameSite = false;
      try {
        const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
        const u = new URL(raw, location.href);
        sameSite = (u.protocol === 'http:' || u.protocol === 'https:')
          && ShimCore.sameRegistrableDomain(u.hostname, location.hostname);
      } catch (_) { /* unparseable → unmetered */ }
      if (!sameSite) return nativeFetch(input, init);
      const { delayMs, throttled } = budget.take(Date.now());
      if (throttled && !announced) {
        announced = true;
        console.warn('[shim] handler fetch burst exceeded the same-site budget — further requests are being paced. '
          + 'Fetch less: use fields already in list responses, cache per-item data in api.storage, fetch lazily.');
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return nativeFetch(input, init);
    };
    globalThis.fetch = paced;
  }

  post({ type: 'ready' });
}

/** The script the driver injects after the page bundle: the runtime, invoked with `config`. */
export function pageRuntimeSource(config: PageRuntimeConfig): string {
  return `;(${installPageRuntime.toString()})(${JSON.stringify(config)});\n`;
}
