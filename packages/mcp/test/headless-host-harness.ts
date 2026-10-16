// Harness for the headless PageHost's browser-free parts
// (packages/mcp/src/playwright-page-host.ts, headless-page-runtime.ts,
// playwright-launch.ts):
//
//   - HEADLESS_CAPABILITIES is exactly D15's headless set, and every kind it
//     advertises is a real mutation kind covered by a conformance case (a
//     capability is "yes" for headless only while its cases exist and pass);
//   - the page runtime serializes to a self-contained script (it is injected
//     with Function.prototype.toString, so a reference outside its body or a
//     bundler helper would only fail inside the page);
//   - memoryStorage keeps the browser's api.storage semantics, per shim and
//     origin;
//   - the page runtime rejects an api call the driver's store failed;
//   - the page runtime refuses arguments structured clone would (functions,
//     symbols, cycles, BigInts) without reaching the store;
//   - over a scripted CDP session: detach does not wait out queued previews
//     when no engine world exists, and a failing store rejects the page's
//     call instead of answering undefined;
//   - load failures map to Chromium's net error codes;
//   - the engine bundle the driver injects is the built page bundle;
//   - Playwright is found from the caller's install (SHIM_PLAYWRIGHT_DIR,
//     the working directory, CLAUDE_PROJECT_DIR, a global install, then
//     `npm root -g`), not only beside the bundle; a miss is
//     playwright-missing with the exact install command, a never-downloaded
//     Chromium is chromium-missing with the command for the Playwright found,
//     and missing Linux libraries are system-deps-missing (install-deps).
//
// The driver itself runs against a real Chromium in
// playwright-conformance-harness.ts (its own CI job).
//
//   node out/packages/mcp/test/headless-host-harness.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import vm from 'vm';
import { BUILTIN_KINDS } from '@shimbrowser/core/spec-lint';
import { coveredCapabilities } from '@shimbrowser/core/page-host-conformance';
import type { Page } from 'playwright';
import {
  HEADLESS_CAPABILITIES, REQUIRES_SHIM_BROWSER, attachPlaywrightPageHost, memoryStorage, netErrorCode, readEngineBundle, remoteObjectValue,
} from '../src/playwright-page-host';
import type { HeadlessStorage } from '../src/playwright-page-host';
import { pageRuntimeSource } from '../src/headless-page-runtime';
import type { PageRuntimeControl } from '../src/headless-page-runtime';
import {
  PLAYWRIGHT_INSTALL_COMMAND, PLAYWRIGHT_MISSING, HeadlessUnavailableError, chromiumInstallCommand, globalPrefixDirs,
  headlessReadiness, launchFailure, loadPlaywright, locatePlaywright, playwrightSearchDirs, systemDepsInstallCommand, type RequireFrom,
} from '../src/playwright-launch';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}


// A scripted Page + CDP session: enough of each for attachPlaywrightPageHost
// to attach, queue previews, answer api calls and detach, with every CDP
// send recorded. `world: false` makes the engine world never appear.
interface FakeCdp {
  sends: Array<{ method: string; params: Record<string, unknown> }>;
  emit(event: string, payload: unknown): void;
}
function fakePage(world: boolean): { page: Page; cdp: FakeCdp } {
  const listeners = new Map<string, Array<(p: unknown) => void>>();
  const sends: FakeCdp['sends'] = [];
  const session = {
    on(event: string, fn: (p: unknown) => void) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      sends.push({ method, params });
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'main' } } });
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return Promise.resolve({ identifier: 's1' });
      if (method === 'Page.createIsolatedWorld') {
        return world ? Promise.resolve({ executionContextId: 7 }) : Promise.reject(new Error('no world'));
      }
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { type: 'undefined' } });
      return Promise.resolve({});
    },
    detach: () => Promise.resolve(),
  };
  const page = {
    context: () => ({ newCDPSession: () => Promise.resolve(session) }),
    isClosed: () => false,
    url: () => 'https://x.test/',
    on() { /* no page events */ },
    off() { /* no page events */ },
  };
  return {
    page: page as unknown as Page,
    cdp: {
      sends,
      emit(event, payload) { for (const fn of listeners.get(event) ?? []) fn(payload); },
    },
  };
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The page runtime over a stand-in engine: just enough ShimCore to boot, with
// the api a preview gets captured from run(). `send` is the binding.
interface PreviewApi {
  storage: { set(k: string, v: unknown): Promise<unknown>; get(k: string): Promise<unknown> };
  reportEvent(kind: string, payload?: Record<string, unknown>): void;
  db?: unknown;
}
function bootRuntime(send: (payload: string) => void): { control: PageRuntimeControl | undefined; captured: { api: PreviewApi | null } } {
  const captured: { api: PreviewApi | null } = { api: null };
  const sandbox: Record<string, unknown> = {
    location: { origin: 'https://x.test', pathname: '/', hostname: 'x.test', href: 'https://x.test/' },
    document: { readyState: 'complete', addEventListener() { /* unused */ } },
    addEventListener() { /* unused */ },
    fetch: () => Promise.resolve(null),
    console,
    b: send,
    ShimCore: {
      run: (_spec: unknown, api: PreviewApi) => {
        captured.api = api;
        return { applyExtraRule() { /* no-op */ }, teardownAll() { /* no-op */ } };
      },
      createFetchBudget: () => ({ take: () => ({ delayMs: 0, throttled: false }) }),
      deployIdForDocument: () => null,
      sameRegistrableDomain: () => true,
    },
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(pageRuntimeSource({ binding: 'b', globalName: 'g', unsupportedError: REQUIRES_SHIM_BROWSER }), sandbox);
  return { control: sandbox.g as PageRuntimeControl | undefined, captured };
}

async function main(): Promise<void> {
  console.log('capabilities (D15)');
  {
    const kinds = [...HEADLESS_CAPABILITIES.mutationKinds].sort();
    const d15 = ['hide', 'restyle', 'reorder', 'reshape', 'script', 'inject-element', 'inject-html', 'remove', 'replace-root'].sort();
    check('mutation kinds are D15\'s headless set', JSON.stringify(kinds) === JSON.stringify(d15), kinds.join(','));
    for (const k of ['mount-route', 'redirect', 'rewrite-response', 'intercept']) {
      check(`${k} is not advertised`, !HEADLESS_CAPABILITIES.mutationKinds.includes(k));
    }
    const builtin = new Set<string>(BUILTIN_KINDS);
    check('every advertised kind is a built-in kind', HEADLESS_CAPABILITIES.mutationKinds.every((k) => builtin.has(k)));
    check('no iframe rules, no spec css, no host api members, no component identity, no engine inspection',
      !HEADLESS_CAPABILITIES.iframeRules && !HEADLESS_CAPABILITIES.specCss && HEADLESS_CAPABILITIES.apiMembers.length === 0
      && !HEADLESS_CAPABILITIES.componentIdentity && !HEADLESS_CAPABILITIES.engineInspection);
    check('the capability object is frozen', Object.isFrozen(HEADLESS_CAPABILITIES) && Object.isFrozen(HEADLESS_CAPABILITIES.mutationKinds));
    const covered = coveredCapabilities() as Set<string>;
    const uncovered = HEADLESS_CAPABILITIES.mutationKinds.filter((k) => !covered.has(k));
    check('every advertised kind has a conformance case', uncovered.length === 0, uncovered.join(','));
    for (const cap of ['mount:portal', 'mount:overlay', 'mount:shadow', 'self-healing', 'witness:capture', 'witness:verify',
      'rebase:refresh', 'rebase:promote', 'rebase:recover', 'api.storage', 'api.cleanup']) {
      check(`D15 "yes" row ${cap} has a conformance case`, covered.has(cap));
    }
    check('the unsupported refusal names the browser', REQUIRES_SHIM_BROWSER === 'requires-shim-browser');
  }

  console.log('page runtime');
  {
    const src = pageRuntimeSource({ binding: 'b', globalName: 'g', unsupportedError: REQUIRES_SHIM_BROWSER });
    let parsed = true;
    try { new vm.Script(src); } catch { parsed = false; }
    check('serializes to a script that parses', parsed);
    check('carries no module or bundler references', !/\brequire\(|\bimport\(|__toESM|__name\(|exports\./.test(src), src.slice(0, 200));
    // Run it where it must refuse to boot: no engine bundle in scope. It
    // must touch nothing outside its own body (a stray outer reference would
    // throw a ReferenceError here).
    const sandbox: Record<string, unknown> = {};
    sandbox.window = sandbox;
    sandbox.top = sandbox;
    sandbox.globalThis = sandbox;
    let threw: unknown = null;
    try { vm.runInNewContext(src, sandbox); } catch (e) { threw = e; }
    check('without the engine in scope it does nothing and throws nothing', threw === null && sandbox.g === undefined, String(threw));
  }

  console.log('memoryStorage');
  {
    const s = memoryStorage();
    const a = { patchId: 'shim-a', origin: 'https://x.test' };
    const b = { patchId: 'shim-b', origin: 'https://x.test' };
    const otherOrigin = { patchId: 'shim-a', origin: 'https://y.test' };
    check('a missing key reads null', (await s.get(a, 'k')) === null);
    const value = { n: 1, list: [1, 'two'] };
    check('set answers the value', (await s.set(a, 'k', value)) === value);
    check('get reads a copy of it', JSON.stringify(await s.get(a, 'k')) === JSON.stringify(value) && (await s.get(a, 'k')) !== value);
    check('another shim on the origin does not see it', (await s.get(b, 'k')) === null);
    check('the same shim on another origin does not see it', (await s.get(otherOrigin, 'k')) === null);
    await s.set(a, 'k2', 'v2');
    check('list returns the bucket', JSON.stringify(await s.list(a)) === JSON.stringify({ k: value, k2: 'v2' }));
    check('delete answers true for a row', (await s.delete(a, 'k')) === true);
    check('delete answers false when nothing was there', (await s.delete(a, 'k')) === false);
    check('undefined stores as null', (await s.set(a, 'u', undefined)) === undefined && (await s.get(a, 'u')) === null);
  }

  console.log('page runtime api calls');
  {
    const posted: Array<Record<string, unknown>> = [];
    const { control, captured } = bootRuntime((payload) => { posted.push(JSON.parse(payload) as Record<string, unknown>); });
    check('the runtime boots over a stand-in engine', control !== undefined);
    if (control) {
      control.apply('shim-a', { id: 'r', anchor: { primary: { kind: 'css', value: 'x' } }, mutations: [{ kind: 'hide' }] }, 'rk', null);
      const api = captured.api;
      check('a preview gets an api', api !== null);
      if (api) {
        const write = api.storage.set('k', 1);
        const writeCall = posted.find((m) => m.type === 'call' && m.method === 'storage.set');
        check('a storage write posts a call to the driver', typeof writeCall?.id === 'number');
        control.reject(Number(writeCall?.id), 'storage.set failed: disk full');
        let rejected: unknown = null;
        try { await write; } catch (e) { rejected = e; }
        check('a call the driver rejects rejects the handler\'s promise with its message',
          rejected !== null && (rejected as { message?: unknown }).message === 'storage.set failed: disk full', String(rejected));
        const read = api.storage.get('k');
        const readCall = posted.find((m) => m.type === 'call' && m.method === 'storage.get');
        control.resolve(Number(readCall?.id), 'v');
        check('a call the driver resolves still resolves with its value', (await read) === 'v');
        check('a settled call cannot be settled again', !control.reject(Number(readCall?.id), 'late'));
        // Arguments JSON cannot carry: the call rejects at once and leaves
        // nothing pending, rather than hanging the handler forever.
        const settles = async (p: Promise<unknown>): Promise<unknown> => {
          const timeout = Symbol('timeout');
          const out = await Promise.race([p.then(() => 'resolved', (e: unknown) => e), tick(200).then(() => timeout)]);
          return out === timeout ? 'pending' : out;
        };
        // The error comes from the runtime's realm: match on its message.
        const failedWith = (e: unknown): boolean => typeof e === 'object' && e !== null
          && /^storage\.set failed: /.test(String((e as { message?: unknown }).message));
        const before = posted.length;
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const cyc = await settles(api.storage.set('k', cyclic));
        check('a circular value rejects the call', failedWith(cyc), String(cyc));
        const big = await settles(api.storage.set('k', 10n));
        check('a BigInt value rejects the call', failedWith(big), String(big));
        check('…and neither reached the driver', posted.length === before);
        // The two refused calls took the next two ids after the read.
        const refusedIds = [Number(readCall?.id) + 1, Number(readCall?.id) + 2];
        check('…nor left a pending entry behind', refusedIds.every((id) => !control.resolve(id, 'late')));
      }
      // A preview's events carry the version tag it was applied with, so the
      // session can drop a late one from a version it replaced.
      const eventsOf = (key: string): Array<Record<string, unknown>> => {
        const out: Array<Record<string, unknown>> = [];
        for (const m of posted) {
          if (m.type !== 'event' || typeof m.payload !== 'object' || m.payload === null) continue;
          const event: Record<string, unknown> = { ...(m.payload as Record<string, unknown>), kind: m.kind };
          if (event.specId === key) out.push(event);
        }
        return out;
      };
      const untaggedApi = captured.api;
      control.apply('shim-a', { id: 'r', anchor: { primary: { kind: 'css', value: 'x' } }, mutations: [{ kind: 'hide' }] }, 'rk2', null, 'sess:7');
      const tagged = captured.api;
      tagged?.reportEvent('rule-witness', { specId: 'rk2', ruleId: 'r', witness: { v: 1 } });
      void tagged?.db;
      const stamped = eventsOf('rk2');
      check('an engine event and an unsupported-api event both carry the preview\'s applyId', stamped.length === 2
        && stamped.every((e) => e.applyId === 'sess:7') && stamped.some((e) => e.kind === 'unsupported-api'), JSON.stringify(stamped));
      untaggedApi?.reportEvent('rule-status', { specId: 'rk' });
      const untagged = eventsOf('rk');
      check('…and a preview applied without one carries none', untagged.length > 0 && untagged.every((e) => !('applyId' in e)), JSON.stringify(untagged));
    }
  }

  console.log('page runtime refuses what structured clone would');
  {
    // The binding answers from a real store, the way the driver does, so a
    // refused write can be seen to leave the stored value alone.
    const store = memoryStorage();
    const scope = { patchId: 'shim-a', origin: 'https://x.test' };
    let reached = 0;
    const box: { control: PageRuntimeControl | undefined } = { control: undefined };
    const booted = bootRuntime((payload) => {
      const msg = JSON.parse(payload) as { type?: unknown; id?: unknown; method?: unknown; args?: unknown };
      if (msg.type !== 'call' || typeof msg.id !== 'number' || !Array.isArray(msg.args)) return;
      reached++;
      const id = msg.id;
      const [key, value] = msg.args as [string, unknown];
      const answer = msg.method === 'storage.set' ? store.set(scope, key, value) : store.get(scope, key);
      void answer.then((v) => box.control?.resolve(id, v));
    });
    box.control = booted.control;
    booted.control?.apply('shim-a', { id: 'r', anchor: { primary: { kind: 'css', value: 'x' } }, mutations: [{ kind: 'hide' }] }, 'rk', null);
    const api = booted.captured.api;
    check('a preview gets an api', api !== null);
    if (api) {
      await api.storage.set('k', 'old');
      const writes = reached;
      const symbolValue: unknown = Symbol('s');
      const cases: Array<[string, unknown]> = [
        ['a top-level function', () => 1],
        ['a nested function', { n: 1, deep: { fn: () => 1 } }],
        ['a function in a list', [1, () => 1]],
        ['a symbol', symbolValue],
        ['a nested symbol', { s: symbolValue }],
      ];
      for (const [label, value] of cases) {
        let rejected: unknown = null;
        try { await api.storage.set('k', value); } catch (e) { rejected = e; }
        check(`${label} rejects the write`, typeof rejected === 'object' && rejected !== null
          && /^storage\.set failed: .*could not be cloned/.test(String((rejected as { message?: unknown }).message)), String(rejected));
      }
      check('…none of them reached the store', reached === writes, `${reached - writes} reached`);
      check('…and the stored value is unchanged', (await api.storage.get('k')) === 'old');
      const cyclic: Record<string, unknown> = { ok: true };
      cyclic.self = cyclic;
      let cyc: unknown = null;
      try { await api.storage.set('k', cyclic); } catch (e) { cyc = e; }
      check('a cycle still rejects (and the walk terminates)', cyc !== null);
      await api.storage.set('k', { plain: [1, 'two', { three: null }] });
      check('a plain value still writes', JSON.stringify(await api.storage.get('k')) === '{"plain":[1,"two",{"three":null}]}');
    }
  }

  console.log('driver over a scripted CDP session');
  {
    const { page, cdp } = fakePage(true);
    const host = await attachPlaywrightPageHost(page, { engineBundle: '' });
    host.applyPreview({ patchId: 'p', ruleKey: 'preview:p:r', applyId: 'sess:3', rule: { id: 'r', anchor: { primary: { kind: 'css', value: 'x' } }, mutations: [{ kind: 'hide' }] } });
    await tick();
    const applyExpr = cdp.sends.map((x) => String(x.params.expression ?? '')).find((e) => e.includes('.apply("p"')) ?? '';
    check('the driver hands the preview\'s applyId to the page runtime', applyExpr.endsWith(', null, "sess:3")'), applyExpr);
    await host.detach();
  }
  {
    // Previews queued while no engine world exists: detach must not wait out
    // each one's world wait in turn.
    const { page } = fakePage(false);
    const host = await attachPlaywrightPageHost(page, { engineBundle: '', worldWaitMs: 1500 });
    for (const n of [1, 2, 3]) {
      host.applyPreview({ patchId: 'p', ruleKey: `preview:p:${n}`, rule: { id: `r${n}`, anchor: { primary: { kind: 'css', value: 'x' } }, mutations: [{ kind: 'hide' }] } });
    }
    await tick();
    const started = Date.now();
    await host.detach();
    const took = Date.now() - started;
    check('detach with queued previews and no world returns at once', took < 500, `${took}ms`);
  }
  {
    const failing: HeadlessStorage = {
      get: () => Promise.resolve('stored'),
      set: () => Promise.reject(new Error('disk full')),
      delete: () => Promise.resolve(false),
      list: () => Promise.resolve({}),
    };
    const { page, cdp } = fakePage(true);
    const host = await attachPlaywrightPageHost(page, { engineBundle: '', storage: failing });
    const call = (id: number, method: string, args: unknown[]): void => {
      cdp.emit('Runtime.bindingCalled', {
        name: '__shimCoreHost',
        executionContextId: 7,
        payload: JSON.stringify({ type: 'call', id, method, patchId: 'p', origin: 'https://x.test', args }),
      });
    };
    call(1, 'storage.set', ['k', 1]);
    call(2, 'storage.get', ['k']);
    await tick();
    const answers = cdp.sends
      .filter((s) => s.method === 'Runtime.evaluate' && s.params.contextId === 7)
      .map((s) => String(s.params.expression));
    const answer1 = answers.find((e) => /\.(resolve|reject)\(1,/.test(e)) ?? '';
    const answer2 = answers.find((e) => /\.(resolve|reject)\(2,/.test(e)) ?? '';
    check('a store that fails rejects the page\'s call, naming the failure', answer1.includes('.reject(1,') && answer1.includes('disk full'), answer1);
    check('a store that answers resolves it with the value', answer2.includes('.resolve(2, JSON.parse("\\"stored\\""))'), answer2);
    await host.detach();
  }
  {
    // A reply is exact JSON in the page: an own `__proto__` key stays an own
    // key (an object literal would make it a prototype setter), at the top
    // level, nested, and inside a list reply.
    const tricky = '{"__proto__":{"flag":true},"nested":{"__proto__":{"deep":1}}}';
    const store: HeadlessStorage = {
      get: () => Promise.resolve(JSON.parse(tricky) as unknown),
      set: (_s, _k, v) => Promise.resolve(v),
      delete: () => Promise.resolve(false),
      list: () => Promise.resolve({ row: JSON.parse(tricky) as unknown }),
    };
    const { page, cdp } = fakePage(true);
    const host = await attachPlaywrightPageHost(page, { engineBundle: '', storage: store });
    const call = (id: number, method: string, args: unknown[]): void => {
      cdp.emit('Runtime.bindingCalled', {
        name: '__shimCoreHost',
        executionContextId: 7,
        payload: JSON.stringify({ type: 'call', id, method, patchId: 'p', origin: 'https://x.test', args }),
      });
    };
    call(11, 'storage.get', ['k']);
    call(12, 'storage.list', []);
    call(13, 'storage.set', ['k', JSON.parse(tricky) as unknown]);
    await tick();
    // Run each answer the driver sent in a context standing in for the
    // engine world, capturing what the page's promise would resolve with.
    const settled = new Map<number, unknown>();
    const world: Record<string, unknown> = {};
    world.globalThis = world;
    world.__shimCoreRuntime = {
      resolve: (id: number, value: unknown) => { settled.set(id, value); return true; },
      reject: () => false,
    };
    for (const s of cdp.sends) {
      if (s.method !== 'Runtime.evaluate' || s.params.contextId !== 7) continue;
      const expr = String(s.params.expression);
      if (/\.resolve\(1[123],/.test(expr)) vm.runInNewContext(expr, world);
    }
    // Exact: `__proto__` is an own data key, nothing is inherited from it,
    // and the prototype is still the realm's Object.prototype (whose own
    // prototype is null).
    const ownProtoKey = (v: unknown): v is Record<string, unknown> => {
      if (typeof v !== 'object' || v === null) return false;
      const proto: unknown = Object.getPrototypeOf(v);
      return Object.prototype.hasOwnProperty.call(v, '__proto__')
        && typeof proto === 'object' && proto !== null && Object.getPrototypeOf(proto) === null;
    };
    const isExact = (v: unknown): boolean => ownProtoKey(v) && !('flag' in v)
      && ownProtoKey(v.nested) && !('deep' in v.nested);
    check('a get reply keeps an own __proto__ key and its prototype', isExact(settled.get(11)), JSON.stringify(settled.get(11)));
    const listed = settled.get(12) as Record<string, unknown> | undefined;
    check('…so does a list reply', isExact(listed?.row), JSON.stringify(listed));
    check('…and a set reply', isExact(settled.get(13)), JSON.stringify(settled.get(13)));
    await host.detach();
  }

  console.log('net errors');
  check('refused', netErrorCode('net::ERR_CONNECTION_REFUSED') === -102);
  console.log('evaluate results CDP cannot put in JSON');
  check('a plain value passes through', remoteObjectValue({ value: { a: 1 } }) !== undefined && remoteObjectValue({ value: 3 }) === 3);
  check('NaN', Number.isNaN(remoteObjectValue({ unserializableValue: 'NaN' })));
  check('±Infinity', remoteObjectValue({ unserializableValue: 'Infinity' }) === Infinity && remoteObjectValue({ unserializableValue: '-Infinity' }) === -Infinity);
  check('-0', Object.is(remoteObjectValue({ unserializableValue: '-0' }), -0));
  check('a bigint', remoteObjectValue({ unserializableValue: '12345678901234567890n' }) === 12345678901234567890n);
  check('aborted', netErrorCode('net::ERR_ABORTED') === -3);
  check('name not resolved', netErrorCode('net::ERR_NAME_NOT_RESOLVED') === -105);
  check('unknown reads as ERR_FAILED', netErrorCode('net::ERR_SOMETHING_NEW') === -2 && netErrorCode('') === -2);

  console.log('engine bundle');
  {
    let bundle = '';
    try { bundle = readEngineBundle(); } catch (e) { check('the page bundle is built', false, String(e)); }
    check('the driver injects the ShimCore page bundle', bundle.includes('ShimCore'));
    check('…which exports the deploy identity the runtime gates rebase on', bundle.includes('deployIdForDocument'));
  }

  console.log('launch');
  check('a missing Playwright install has an actionable message', PLAYWRIGHT_MISSING.includes(PLAYWRIGHT_INSTALL_COMMAND)
    && /npm install -D playwright/.test(PLAYWRIGHT_MISSING) && /does not bundle/.test(PLAYWRIGHT_MISSING));
  check('the install command is global, then its own Chromium', PLAYWRIGHT_INSTALL_COMMAND === 'npm install -g playwright && playwright install chromium');
  {
    const missing = launchFailure(new Error("browserType.launch: Executable doesn't exist at /x/chrome-headless-shell\nLooks like Playwright was just installed"), '/pw/node_modules/playwright');
    check('a never-downloaded Chromium is chromium-missing', missing instanceof HeadlessUnavailableError && missing.code === 'chromium-missing', missing.message);
    check('…with the found Playwright\'s own CLI (versions match)', missing instanceof HeadlessUnavailableError
      && missing.install === `node "${path.join('/pw/node_modules/playwright', 'cli.js')}" install chromium` && missing.message.includes(missing.install));
    const depsMessage = 'browserType.launch: \n' +
      '╔══════════════════════════════════════════════════════╗\n' +
      '║ Host system is missing dependencies to run browsers. ║\n' +
      '║ Please install them with the following command:      ║\n' +
      '║     sudo npx playwright install-deps                 ║\n' +
      '║ Alternatively, use apt:                              ║\n' +
      '║     sudo apt-get install libnss3 libatk1.0-0         ║\n' +
      '╚══════════════════════════════════════════════════════╝';
    const deps = launchFailure(new Error(depsMessage), '/pw/node_modules/playwright');
    check('missing Linux libraries are system-deps-missing, not chromium-missing', deps instanceof HeadlessUnavailableError && deps.code === 'system-deps-missing', deps.message);
    check('…with install-deps from the found Playwright\'s CLI', deps instanceof HeadlessUnavailableError
      && deps.install === `node "${path.join('/pw/node_modules/playwright', 'cli.js')}" install-deps chromium` && deps.message.includes(deps.install));
    check('…and npx install-deps without a package folder', systemDepsInstallCommand(null) === 'npx playwright install-deps chromium');
    const download = launchFailure(new Error("browserType.launch: Executable doesn't exist at /x\nPlease run the following command to download new browsers:\n    npx playwright install"), null);
    check('a download hint alone still reads as chromium-missing', download instanceof HeadlessUnavailableError && download.code === 'chromium-missing', download.message);
    const other = launchFailure(new Error('spawn EACCES'), null);
    check('any other launch failure stays an error, never a misleading install hint', !(other instanceof HeadlessUnavailableError) && /spawn EACCES/.test(other.message));
    check('without a package folder the command is npx', chromiumInstallCommand(null) === 'npx playwright install chromium');
    const real = path.dirname(require.resolve('playwright/package.json'));
    check('Playwright ships cli.js at its package root (what chromiumInstallCommand runs)', fs.existsSync(path.join(real, 'cli.js')));
  }

  console.log('finding Playwright');
  {
    const dirs = playwrightSearchDirs({ SHIM_PLAYWRIGHT_DIR: '/pw', CLAUDE_PROJECT_DIR: '/proj' }, '/cwd');
    check('the search order is explicit dir, own resolution, cwd, project dir', JSON.stringify(dirs) === '["/pw",null,"/cwd","/proj"]', JSON.stringify(dirs));
    check('duplicates are searched once', JSON.stringify(playwrightSearchDirs({ CLAUDE_PROJECT_DIR: '/cwd/' }, '/cwd')) === '[null,"/cwd"]');
    check('a global install is searched after the project', JSON.stringify(playwrightSearchDirs({ CLAUDE_PROJECT_DIR: '/proj' }, '/cwd', ['/g/lib']))
      === '[null,"/cwd","/proj","/g/lib"]');
    check('global prefix on POSIX: <node prefix>/lib', JSON.stringify(globalPrefixDirs({}, '/home/u/.nvm/versions/node/v22/bin/node', 'linux'))
      === '["/home/u/.nvm/versions/node/v22/lib"]');
    check('npm\'s configured prefix first', JSON.stringify(globalPrefixDirs({ npm_config_prefix: '/opt/npm' }, '/usr/bin/node', 'darwin'))
      === '["/opt/npm/lib","/usr/lib"]');
    check('global prefix on Windows: the node folder itself', JSON.stringify(globalPrefixDirs({}, 'C:\\Program Files\\nodejs\\node.exe', 'win32'))
      === JSON.stringify(['C:\\Program Files\\nodejs']));
    // The plugin case: the bundle's own require can't see the project.
    const tried: Array<string | null> = [];
    const fake: RequireFrom = (dir) => (id) => {
      tried.push(dir);
      if (dir === '/proj' && id === 'playwright') return { chromium: 'from-project' };
      throw new Error(`Cannot find module '${id}'`);
    };
    let npmAsked = 0;
    const npmRoot = (): string | null => { npmAsked += 1; return null; };
    const found = loadPlaywright({ env: { CLAUDE_PROJECT_DIR: '/proj' }, cwd: '/cwd', requireFrom: fake, globalDirs: [], npmGlobalDir: npmRoot }) as unknown as { chromium: string };
    check('an install only the project has is found', found.chromium === 'from-project' && JSON.stringify(tried) === '[null,"/cwd","/proj"]', JSON.stringify(tried));
    check('npm is not asked when a cheaper place has it', npmAsked === 0);
    let missing: unknown = null;
    try { loadPlaywright({ env: {}, cwd: '/cwd', requireFrom: fake, globalDirs: ['/g/lib'], npmGlobalDir: npmRoot }); } catch (e) { missing = e; }
    check('nowhere at all is PLAYWRIGHT_MISSING, as playwright-missing with the install command', missing instanceof HeadlessUnavailableError
      && missing.message === PLAYWRIGHT_MISSING && missing.code === 'playwright-missing' && missing.install === PLAYWRIGHT_INSTALL_COMMAND);
    check('…after asking npm once, last', npmAsked === 1);
    tried.length = 0;
    const globalFake: RequireFrom = (dir) => (id) => {
      tried.push(dir);
      if (dir === '/npm/global' && id === 'playwright') return { chromium: 'from-npm-root' };
      throw new Error(`Cannot find module '${id}'`);
    };
    const fromNpm = loadPlaywright({ env: {}, cwd: '/cwd', requireFrom: globalFake, globalDirs: ['/g/lib'], npmGlobalDir: () => '/npm/global' }) as unknown as { chromium: string };
    check('`npm root -g` finds a global install the prefix guess missed', fromNpm.chromium === 'from-npm-root' && JSON.stringify(tried) === '[null,"/cwd","/g/lib","/npm/global"]', JSON.stringify(tried));
    const notReady = headlessReadiness(() => { throw new HeadlessUnavailableError('playwright-missing', PLAYWRIGHT_MISSING, PLAYWRIGHT_INSTALL_COMMAND); });
    check('readiness without Playwright: unavailable, why, and the command', !notReady.available && notReady.error === 'playwright-missing'
      && notReady.install === PLAYWRIGHT_INSTALL_COMMAND && notReady.reason === PLAYWRIGHT_MISSING);
    const ready = headlessReadiness(() => ({ module: {} as never, packageDir: '/pw' }));
    check('readiness with Playwright names where it was found', ready.available && ready.playwright === '/pw');
    // The real resolver, from a folder outside this repo.
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-pw-'));
    try {
      const pkg = path.join(proj, 'node_modules', 'playwright');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"playwright","main":"index.js"}');
      fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = { stub: true };');
      const real = locatePlaywright({ env: { SHIM_PLAYWRIGHT_DIR: proj }, cwd: proj });
      check('SHIM_PLAYWRIGHT_DIR resolves from that folder\'s node_modules', (real.module as unknown as { stub?: boolean }).stub === true);
      check('…and says where the package is', real.packageDir !== null && fs.realpathSync(real.packageDir) === fs.realpathSync(pkg), String(real.packageDir));
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  }

  if (failures) {
    console.error(`\n✗ headless-host: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ headless-host: all checks passed');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
