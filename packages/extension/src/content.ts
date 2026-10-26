// The page runtime, registered per shim after the engine (`shim-core.page.js`,
// global ShimCore) at document_start in the isolated world. It asks the
// worker which shims run on this host and port and runs each through the
// engine with the handler api this host gives: the core members and
// `api.storage` over the worker; every other member failing in its own
// shape with an `unsupported-api` event (D15).
//
// A document keeps one control per running shim and reconciles against the
// worker's answer whenever it is asked again: the worker re-injects this
// file into open documents after an install, a toggle or a removal, and
// the second copy finds the first's `sync` and calls it. So a shim turned
// off in the popup is torn down on every open page at once (its rules, its
// stylesheet, its observers), and one turned on starts there.
//
// Declarative mode: no handler compiles here (a content script cannot eval),
// and the worker sends only shims that fit the mode, so no rule needs one.
// Full mode registers this same runtime in the user-script world, where the
// handlers compile (compile.ts) before the engine runs the shim. That world
// has no onMessage, so the runtime is nudged over the port it holds to the
// worker in both worlds; a dropped port (the worker idled out) is
// reconnected, and one that cannot be (the extension instance is gone)
// tears every shim down.

import type * as Core from '@shimbrowser/core';
import { isToRuntime, RUNTIME_PORT, type ToWorker, type WorkerAnswer, type BundleAnswer, type BundledShim } from './messages';
import { reconcileShims } from './reconcile';
import { compileHandlers } from './compile';

const BOOT_FLAG = '__shimForChrome';
const UNSUPPORTED_ERROR = 'not-available-in-shim-for-chrome';

type PatchControl = ReturnType<typeof Core.run>;

interface Runtime {
  sync(): void;
}

(() => {
  // One runtime per document: several shims on one host register the same
  // files several times, and a re-injection after a change only asks the
  // first copy to look again.
  const host = globalThis as unknown as Record<string, unknown>;
  const existing = host[BOOT_FLAG] as Runtime | undefined;
  if (existing) {
    existing.sync();
    return;
  }
  const ShimCore = host.ShimCore as typeof Core | undefined;
  if (!ShimCore || typeof ShimCore.run !== 'function') return;

  const ask = (msg: ToWorker): Promise<WorkerAnswer> => chrome.runtime.sendMessage(msg);
  const tell = (msg: ToWorker): void => {
    chrome.runtime.sendMessage(msg).catch(() => { /* the worker went away; an event is fire-and-forget */ });
  };
  const emit = (shimId: string, kind: string, payload: Record<string, unknown>): void => {
    tell({ type: 'event', shimId, kind, payload });
  };

  const onReady = (fn: () => void): void => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };

  const makeApi = (patchId: string): Core.CoreApi & Record<string, unknown> => {
    const unsupported = (member: string): void => {
      emit(patchId, 'unsupported-api', { specId: patchId, member, path: location.pathname });
    };
    const refusal = (member: string) => (): Promise<{ ok: false; error: string }> => {
      unsupported(member);
      return Promise.resolve({ ok: false, error: UNSUPPORTED_ERROR });
    };
    const absent = (target: object, prop: string, member: string): void => {
      Object.defineProperty(target, prop, {
        configurable: true,
        enumerable: false,
        get() { unsupported(member); return undefined; },
      });
    };
    const call = async (method: 'get' | 'set' | 'delete' | 'list', key?: string, value?: unknown): Promise<unknown> => {
      const answer = await ask({ type: 'storage', method, shimId: patchId, key, value });
      if (!answer.ok) throw new Error(`storage.${method} failed: ${answer.error}`);
      return 'value' in answer ? answer.value : undefined;
    };
    const storage: Record<string, unknown> = {
      get: (key: string) => call('get', key),
      set: (key: string, value: unknown) => call('set', key, value),
      delete: (key: string) => call('delete', key),
      list: () => call('list'),
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
        emit(patchId, kind, { ...(payload || {}), path: location.pathname });
      },
      onReady,
    };
    absent(api, 'db', 'db');
    absent(api, 'shared', 'shared');
    return api;
  };

  const deployId = (): string | null => ShimCore.deployIdForDocument(document);
  // Each running shim's control and the priority it booted with: a shim
  // whose priority moved boots again (reconcile.ts).
  const controls = new Map<string, { control: PatchControl; priority: number }>();

  const boot = (shim: BundledShim, mode: BundleAnswer['mode']): void => {
    try {
      // Only full mode sends handler source, and only there does it compile.
      const { handlers, problems } = mode === 'full' ? compileHandlers(shim.handlers, shim.id) : { handlers: {}, problems: [] };
      for (const problem of problems) {
        console.error(`[shim] handler "${problem.name}" of ${shim.id} did not compile: ${problem.error}`);
        emit(shim.id, 'handler-compile-failed', { specId: shim.id, handler: problem.name, error: problem.error, path: location.pathname });
      }
      const control = ShimCore.run({ spec: shim.spec, handlers, priority: shim.priority, bundleHash: deployId }, makeApi(shim.id));
      controls.set(shim.id, { control, priority: shim.priority });
    } catch (err) {
      console.error('[shim] boot failed', shim.id, err);
    }
  };
  const stop = (id: string): void => {
    const running = controls.get(id);
    controls.delete(id);
    if (!running) return;
    try {
      running.control.teardownAll();
    } catch (err) {
      console.error('[shim] teardown failed', id, err);
    }
  };

  // Syncs run one after another: two re-injections in a row must not boot
  // one shim twice.
  const resync = async (): Promise<void> => {
    let answer: WorkerAnswer;
    try {
      answer = await ask({ type: 'bundle' });
    } catch {
      return; // no worker: nothing changes
    }
    if (!answer.ok || !('shims' in answer)) return;
    const bundle = answer as BundleAnswer;
    const priorities = new Map([...controls].map(([id, r]) => [id, r.priority]));
    const { stop: gone, start } = reconcileShims(priorities, bundle.shims);
    for (const id of gone) stop(id);
    for (const shim of start) boot(shim, bundle.mode);
  };
  let chain: Promise<void> = Promise.resolve();
  const sync = (): void => {
    chain = chain.then(resync, resync);
  };

  host[BOOT_FLAG] = { sync } satisfies Runtime;
  // The worker's own nudge: a sync without a fresh injection, which reaches
  // this document even once the extension lost access to its site (site
  // access revoked), so the shims that no longer run here are torn down.
  // The isolated world (declarative mode) listens for it; the user-script
  // world (full mode) has no onMessage and is nudged over the port below.
  const onMessage = (chrome.runtime as { onMessage?: typeof chrome.runtime.onMessage }).onMessage;
  if (onMessage) {
    onMessage.addListener((msg: unknown, sender, sendResponse: (answer: { ok: true }) => void) => {
      if (sender.id !== chrome.runtime.id || !isToRuntime(msg)) return false;
      sync();
      sendResponse({ ok: true });
      return false;
    });
  }

  // This runtime belongs to one extension instance. When that instance goes
  // (the extension reloaded: the user-scripts toggle flipped, an update, a
  // removal), the document keeps running with an invalidated chrome.runtime:
  // no message and no nudge reaches it again, and whatever it applied would
  // stay until the page reloads. So every shim is torn down then, and the
  // boot flag dropped, so an injection from the next instance boots fresh.
  const invalidated = (): void => {
    for (const id of [...controls.keys()]) stop(id);
    delete host[BOOT_FLAG];
  };

  // A port to the worker, in both worlds: the worker nudges it (the one
  // way to reach the user-script world), greets every connection with a
  // sync, and its loss tells the two cases apart. The worker idling out
  // drops the port and the reconnect succeeds, waking the worker; the
  // extension instance going makes the reconnect throw.
  const RECONNECT_MS = 1000;
  const connect = (): void => {
    let port: chrome.runtime.Port;
    try {
      if (!chrome.runtime.id) throw new Error('extension context invalidated');
      port = chrome.runtime.connect({ name: RUNTIME_PORT });
    } catch {
      invalidated();
      return;
    }
    port.onMessage.addListener((msg: unknown) => { if (isToRuntime(msg)) sync(); });
    port.onDisconnect.addListener(() => { setTimeout(connect, RECONNECT_MS); });
  };
  connect();
  sync();
})();
