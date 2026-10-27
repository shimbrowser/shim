// The built extension's PageHost (src/page-host.ts, over chrome.debugger)
// under the shared conformance suite (@shimbrowser/core/page-host-conformance),
// the way the Electron and Playwright hosts run it: a third runner for the
// same cases, so a capability the extension advertises for a session stays
// "yes" only while its cases pass here. The host lives in the worker and
// is driven from this process through the worker's own handle on it (the
// `shimPageHosts` global), one member call at a time, with what the page
// reported drained by polling; events keep their order.
//
// A session needs no user-scripts toggle: the host creates the engine's
// world over the protocol, so this runs on a fresh profile.
//
//   npx playwright install chromium   (full Chromium: extensions need it)
//   node out/packages/extension/test/extension-conformance-harness.js

import fs from 'fs';
import path from 'path';
import type { Worker } from 'playwright';
import {
  runConformance, formatConformanceResults, coveredCapabilities, CONFORMANCE_CASES,
} from '@shimbrowser/core/page-host-conformance';
import type {
  PageHost, PageRuntimeEvent, PageConsoleMessage, PageLoadOutcome, PageInputCommand, PageInputResult, ScreenshotResult, PageHostCapabilities,
} from '@shimbrowser/core/page-host';
import { workDir, extensionCopy, fixtureServer, launch, workerOf, sleep } from './smoke-helpers';
import { SESSION_CAPABILITIES, UNSUPPORTED_ERROR } from '../src/capabilities';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  const d = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !d ? '' : `  — ${d}`}`);
  if (!ok) failures++;
}

async function until<T>(probe: () => Promise<T | null | undefined> | T | null | undefined, timeoutMs = 6000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Drained { url: string; events: PageRuntimeEvent[]; console: PageConsoleMessage[]; popups: string[] }

/** A PageHost in this process over the worker's handle on the real one. */
function proxyHost(worker: Worker, id: string): PageHost & { stop(): Promise<void> } {
  const call = (method: string, args: unknown[] = []): Promise<unknown> =>
    worker.evaluate(([hostId, m, a]) => (globalThis as unknown as { shimPageHosts: { call(id: string, m: string, a: unknown[]): Promise<unknown> } }).shimPageHosts.call(hostId, m, a), [id, method, args] as const);
  const runtimeListeners = new Set<(e: PageRuntimeEvent) => void>();
  const consoleListeners = new Set<(m: PageConsoleMessage) => void>();
  const popupListeners = new Set<(url: string) => void>();
  let draining = true;
  let urlCache = '';
  const drain = async (): Promise<void> => {
    while (draining) {
      let got: Drained | null;
      try {
        got = await worker.evaluate((hostId) => (globalThis as unknown as { shimPageHosts: { drain(id: string): Drained | null } }).shimPageHosts.drain(hostId), id);
      } catch {
        break;
      }
      if (got) {
        urlCache = got.url;
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
    capabilities: SESSION_CAPABILITIES,
    url: () => urlCache,
    isClosed: () => false,
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

const PROBE_UNSUPPORTED = `async function probeUnsupported({ anchor, api }) {
  const out = {};
  out.fetch = await api.fetch('https://example.com/');
  out.ai = await api.ai.complete({ prompt: 'hi' });
  out.modules = await api.modules.invoke('m', 'p', []);
  out.settingsGet = await api.settings.get('enabled');
  out.settingsGetAll = await api.settings.getAll();
  out.db = api.db === undefined ? 'absent' : 'present';
  out.pack = api.storage.pack === undefined ? 'absent' : 'present';
  out.global = api.storage.global === undefined ? 'absent' : 'present';
  out.shared = api.shared === undefined ? 'absent' : 'present';
  anchor.setAttribute('data-conf-unsupported', JSON.stringify(out));
}`;

async function main(): Promise<void> {
  console.log('\n=== extension conformance harness ===\n');
  const work = workDir('shim-extension-conformance-');
  const ext = extensionCopy(work, ['*://127.0.0.1/*']);
  const { origin, setDeploy, close: closeServer } = await fixtureServer();
  const ctx = await launch(ext, path.join(work, 'profile'));
  const { worker } = await workerOf(ctx);
  const page = await ctx.newPage();
  await page.goto(`${origin}/apply`);
  const tabId = (await worker.evaluate(() => chrome.tabs.query({ url: '*://127.0.0.1/*' }).then((t) => t.map((x) => x.id))))[0];
  if (typeof tabId !== 'number') throw new Error('no fixture tab');
  const hostId = await worker.evaluate((id) => (globalThis as unknown as { shimPageHosts: { open(tabId: number): Promise<string> } }).shimPageHosts.open(id), tabId);
  check('a PageHost opened on the tab', typeof hostId === 'string');
  const host = proxyHost(worker, hostId);
  const caps = await worker.evaluate(([id]) => (globalThis as unknown as { shimPageHosts: { call(id: string, m: string, a: unknown[]): Promise<unknown> } }).shimPageHosts.call(id, 'capabilities', []), [hostId] as const) as PageHostCapabilities;
  check('the host advertises the session capabilities', JSON.stringify(caps) === JSON.stringify(SESSION_CAPABILITIES), caps);

  try {
    const only = process.env.SHIM_CONFORMANCE_ONLY ? process.env.SHIM_CONFORMANCE_ONLY.split(',') : undefined;
    const results = await runConformance({ host, origin, setDeploy }, { only });
    const report = formatConformanceResults('extension host', results);
    console.log(report.lines.join('\n'));
    failures += report.failed;
    if (!only) check('ran every shared case', results.length === CONFORMANCE_CASES.length, `${results.length}/${CONFORMANCE_CASES.length}`);

    console.log('\n── extension-only checks');
    const covered = coveredCapabilities();
    const uncovered = SESSION_CAPABILITIES.mutationKinds.filter((k) => !(covered as Set<string>).has(k));
    check('every mutation kind the session host advertises has a conformance case', uncovered.length === 0, uncovered);

    // Console provenance: the engine world's lines are proven by the
    // protocol's execution context.
    {
      const lines: PageConsoleMessage[] = [];
      const offConsole = host.onConsole((m) => { lines.push(m); });
      const loaded = host.waitForLoad({ timeoutMs: 10000 });
      host.reload(`${origin}/apply`);
      check('reload to /apply finished (console provenance)', (await loaded).kind === 'finished');
      const ruleKey = 'preview:conformance:provenance';
      const url = `shim://patches/${ruleKey}/handlers/say.js`;
      host.applyPreview({
        patchId: 'conformance', ruleKey,
        rule: { id: 'provenance', anchor: { primary: { kind: 'css', value: '#note-target' } }, mutations: [{ kind: 'script', handler: 'say' }], handlers: { say: "function say() { console.warn('conf-engine-line'); }" } },
      });
      const mine = await until(() => lines.find((m) => m.message.includes('conf-engine-line')) ?? null);
      check('a handler\'s own line carries engineWorld', mine?.engineWorld === true && mine.source === url, mine);
      await host.evaluate(`console.warn('conf-page-line')\n//# sourceURL=${url}`, 'main');
      const forged = await until(() => lines.find((m) => m.message.includes('conf-page-line')) ?? null);
      check('a page line under the same handler sourceURL never does', forged !== null && forged.source === url && forged.engineWorld !== true, forged);
      host.removePreview(ruleKey);
      offConsole();
    }

    // D15: unsupported members fail in their own shape.
    const events: PageRuntimeEvent[] = [];
    const off = host.onRuntimeEvent((e) => { events.push(e); });
    {
      const loaded = host.waitForLoad({ timeoutMs: 10000 });
      host.reload(`${origin}/apply`);
      check('reload to /apply finished', (await loaded).kind === 'finished');
      const ruleKey = 'preview:conformance:unsupported';
      host.applyPreview({
        patchId: 'conformance', ruleKey,
        rule: { id: 'unsupported', anchor: { primary: { kind: 'css', value: '#storage-target' } }, mutations: [{ kind: 'script', handler: 'probeUnsupported' }], handlers: { probeUnsupported: PROBE_UNSUPPORTED } },
      });
      const raw = await until(async () => {
        const v = await host.evaluate(`document.querySelector('#storage-target').getAttribute('data-conf-unsupported')`, 'main');
        return typeof v === 'string' ? v : null;
      });
      const out: unknown = raw ? JSON.parse(raw) : null;
      const o: Record<string, unknown> = isRecord(out) ? out : {};
      const refusal = JSON.stringify({ ok: false, error: UNSUPPORTED_ERROR });
      check('api.fetch resolves { ok: false, error: not-available-in-shim-for-chrome }', JSON.stringify(o.fetch) === refusal, o.fetch);
      check('api.ai.complete and api.modules.invoke resolve the same refusal', JSON.stringify(o.ai) === refusal && JSON.stringify(o.modules) === refusal, { ai: o.ai, modules: o.modules });
      check('api.settings reads as unconfigured', !('settingsGet' in o) && JSON.stringify(o.settingsGetAll) === '{}', o);
      check('api.db, storage.pack, storage.global and shared read as absent', o.db === 'absent' && o.pack === 'absent' && o.global === 'absent' && o.shared === 'absent', o);
      const want = ['fetch', 'ai.complete', 'modules.invoke', 'settings.get', 'settings.getAll', 'db', 'storage.pack', 'storage.global', 'shared'];
      const seen = new Set(events.filter((e) => e.kind === 'unsupported-api' && e.specId === ruleKey).map((e) => String(e.member)));
      const missing = want.filter((m) => !seen.has(m));
      check('every unsupported member recorded an unsupported-api event naming the preview', missing.length === 0, { missing, seen: [...seen] });
      host.removePreview(ruleKey);
    }
    off();

    // Isolation: the engine is invisible to the page.
    check('ShimCore is not visible in the page\'s main world', (await host.evaluate('typeof window.ShimCore', 'main')) === 'undefined');
    check('the engine world has the engine', (await host.evaluate('typeof ShimCore.run', 'engine')) === 'function');
    check('the engine world evaluates with eval, whatever the page\'s CSP', (await host.evaluate('eval("6 * 7")', 'engine')) === 42);
    check('a throw in evaluated code rejects', await host.evaluate('throw new Error("boom")', 'main').then(() => false, (e: unknown) => e instanceof Error && e.message.includes('boom')));
    check('a value JSON cannot carry comes back (NaN)', Number.isNaN(await host.evaluate('NaN', 'main')));
    check('the document token is stable across a same-document change and new after a load', await (async () => {
      const a = await host.documentToken();
      await host.evaluate('history.pushState({}, "", "#t")', 'main');
      const b = await host.documentToken();
      const loaded = host.waitForLoad({ timeoutMs: 10000 });
      host.reload(`${origin}/apply`);
      await loaded;
      const c = await host.documentToken();
      return typeof a === 'string' && a === b && typeof c === 'string' && c !== a;
    })());
  } finally {
    await host.stop();
    const closed = await worker.evaluate((id) => (globalThis as unknown as { shimPageHosts: { close(id: string): Promise<boolean> } }).shimPageHosts.close(id), hostId);
    check('the host closed (the debugger detached, previews removed)', closed === true);
    await ctx.close();
    closeServer();
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log('');
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log('all extension conformance checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
