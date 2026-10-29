// A PageHost in the test process, proxied over the worker's own handle on
// the real one (`shimPageHosts` on the worker's global): one member call at
// a time through worker.evaluate, and what the page reported (runtime
// events, console lines, popups, the URL, whether the host closed) drained
// by polling, in order. Shared by the conformance and the session harness.

import type { Worker } from 'playwright';
import type {
  PageHost, PageRuntimeEvent, PageConsoleMessage, PageLoadOutcome, PageInputCommand, PageInputResult, ScreenshotResult,
} from '@shimbrowser/core/page-host';
import { sleep } from './smoke-helpers';
import { sessionCapabilities } from '../src/capabilities';

export async function until<T>(probe: () => Promise<T | null | undefined> | T | null | undefined, timeoutMs = 6000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface Drained { url: string; closed: boolean; events: PageRuntimeEvent[]; console: PageConsoleMessage[]; popups: string[] }

/** A PageHost in this process over the worker's handle on the real one. */
export function proxyHost(worker: Worker, id: string): PageHost & { stop(): Promise<void> } {
  const call = (method: string, args: unknown[] = []): Promise<unknown> =>
    worker.evaluate(([hostId, m, a]) => (globalThis as unknown as { shimPageHosts: { call(id: string, m: string, a: unknown[]): Promise<unknown> } }).shimPageHosts.call(hostId, m, a), [id, method, args] as const);
  const runtimeListeners = new Set<(e: PageRuntimeEvent) => void>();
  const consoleListeners = new Set<(m: PageConsoleMessage) => void>();
  const popupListeners = new Set<(url: string) => void>();
  let draining = true;
  let urlCache = '';
  let closedCache = false;
  const drain = async (): Promise<void> => {
    while (draining) {
      let got: Drained | null;
      try {
        got = await worker.evaluate((hostId) => (globalThis as unknown as { shimPageHosts: { drain(id: string): Drained | null } }).shimPageHosts.drain(hostId), id);
      } catch {
        // A poll that failed (the worker busy, a transient evaluate error) is
        // tried again; only stop() ends the loop.
        await sleep(200);
        continue;
      }
      if (got) {
        urlCache = got.url;
        closedCache = got.closed;
        for (const e of got.events) for (const l of [...runtimeListeners]) l(e);
        for (const m of got.console) for (const l of [...consoleListeners]) l(m);
        for (const u of got.popups) for (const l of [...popupListeners]) l(u);
      }
      await sleep(40);
    }
  };
  const draining_ = drain();
  const subscribe = <T>(set: Set<(v: T) => void>, listener: (v: T) => void): (() => void) => {
    set.add(listener);
    return () => { set.delete(listener); };
  };
  return {
    capabilities: sessionCapabilities(),
    url: () => urlCache,
    isClosed: () => closedCache,
    async evaluate(code, world) {
      const v = await call('evaluate', [code, world]);
      try { urlCache = String(await call('url')); } catch { /* the next drain refreshes it */ }
      return v;
    },
    screenshot: (opts) => call('screenshot', [opts]) as Promise<ScreenshotResult>,
    applyPreview(preview) { void call('applyPreview', [preview]); },
    removePreview(ruleKey) { void call('removePreview', [ruleKey]); },
    onRuntimeEvent: (l) => subscribe(runtimeListeners, l),
    onConsole: (l) => subscribe(consoleListeners, l),
    reload(url) { void call('reload', [url]); },
    async waitForLoad(options) {
      const outcome = await call('waitForLoad', [{ timeoutMs: options.timeoutMs, failures: options.failures }]) as PageLoadOutcome;
      try { urlCache = String(await call('url')); } catch { /* the next drain refreshes it */ }
      return outcome;
    },
    async input(commands: readonly PageInputCommand[], stillPinned): Promise<PageInputResult> {
      // One command at a time, so stillPinned runs here before each, as the contract says.
      let sent = 0;
      for (let i = 0; i < commands.length; i++) {
        let pinned: boolean;
        try { pinned = await stillPinned(i); } catch { pinned = false; }
        if (!pinned) return { sent, outcome: 'stopped' };
        const r = await call('input', [[commands[i]]]) as PageInputResult;
        if (r.outcome === 'failed') return { sent, outcome: 'failed', error: r.error };
        sent++;
      }
      return { sent, outcome: 'done' };
    },
    documentToken: () => call('documentToken') as Promise<string | null>,
    navigationCount: () => 0,
    onPopup(listener) {
      const off = subscribe(popupListeners, listener);
      void worker.evaluate(([hostId]) => (globalThis as unknown as { shimPageHosts: { watchPopups(id: string, on: boolean): boolean } }).shimPageHosts.watchPopups(hostId, true), [id] as const);
      return () => {
        off();
        if (popupListeners.size === 0) void worker.evaluate(([hostId]) => (globalThis as unknown as { shimPageHosts: { watchPopups(id: string, on: boolean): boolean } }).shimPageHosts.watchPopups(hostId, false), [id] as const);
      };
    },
    async stop() {
      draining = false;
      await draining_;
    },
  };
}

