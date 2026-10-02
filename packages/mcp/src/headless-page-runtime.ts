// The headless driver's in-page half (shim-core design D9): the code that runs
// in the Playwright page's CDP isolated world, right after the
// @shimbrowser/core page bundle (global `ShimCore`). It is the counterpart of
// the Shim browser's page-preload for authoring previews, and nothing else:
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
//   - the handler-fetch budget (CLAUDE.md §13), pacing same-site fetches.
//
// Handlers are NOT compiled here. The driver compiles each one with
// Runtime.evaluate in this world (the path the A5 spike proved under a strict
// CSP) and hands the function in through `defineHandler` (D4).
//
// `installPageRuntime` is serialized with Function.prototype.toString and
// evaluated in the page, so it must stay self-contained: no imports at
// runtime, no reference to anything outside its own body. Types only.

import type * as Core from '@shimbrowser/core';
import type { Rule } from '@shimbrowser/core';

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
  apply(patchId: string, rule: Rule, ruleKey: string, bundleHash: string | null): boolean;
  remove(ruleKey: string): boolean;
  resolve(id: number, value: unknown): boolean;
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

  const post = (msg: Record<string, unknown>): void => {
    try { send(JSON.stringify(msg)); } catch (_) { /* driver gone or unserializable — drop */ }
  };
  const emit = (kind: string, payload: Record<string, unknown>): void => {
    post({ type: 'event', kind, payload });
  };

  // --- api calls answered by the driver -------------------------------------
  const pending = new Map<number, (value: unknown) => void>();
  let seq = 0;
  const call = (method: string, patchId: string, args: unknown[]): Promise<unknown> => {
    const id = ++seq;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      post({ type: 'call', id, method, patchId, origin: location.origin, args });
    });
  };

  // --- the handler api ---------------------------------------------------------
  const onReady = (fn: () => void): void => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };
  const makeApi = (patchId: string, ruleKey: string): Core.CoreApi & Record<string, unknown> => {
    // D15: every unsupported member records an event, including a read of
    // an absent one, so the session can mark the rule `partial`.
    const unsupported = (member: string): void => {
      emit('unsupported-api', { specId: ruleKey, member, path: location.pathname });
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
        emit(kind, { ...(payload || {}), path: location.pathname });
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
    apply(patchId, rule, ruleKey, bundleHash) {
      remove(ruleKey);
      const handlers = compiled.get(ruleKey);
      compiled.delete(ruleKey);
      try {
        // One stub control per preview (the browser runs every preview on one
        // stub): its api is per preview, so storage keys by the preview's
        // shim and an unsupported-api event names the preview.
        const previewControl = ShimCore.run({ spec: { id: ruleKey, rules: [] } }, makeApi(patchId, ruleKey));
        previews.set(ruleKey, previewControl);
        const deploy = typeof bundleHash === 'string' ? { bundleHash, current: deployId } : undefined;
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
      if (settle) settle(value);
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

  // --- handler-fetch budget (CLAUDE.md §13) --------------------------------------
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
