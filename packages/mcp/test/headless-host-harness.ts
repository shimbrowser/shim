// Harness for the headless PageHost's browser-free parts
// (packages/mcp/src/playwright-page-host.ts, headless-page-runtime.ts,
// playwright-launch.ts; shim-core design D9 / D15):
//
//   - HEADLESS_CAPABILITIES is exactly D15's headless set, and every kind it
//     advertises is a real mutation kind covered by a conformance case (a
//     capability is "yes" for headless only while its cases exist and pass);
//   - the page runtime serializes to a self-contained script (it is injected
//     with Function.prototype.toString, so a reference outside its body or a
//     bundler helper would only fail inside the page);
//   - memoryStorage keeps the browser's api.storage semantics, per shim and
//     origin;
//   - load failures map to Chromium's net error codes;
//   - the engine bundle the driver injects is the built page bundle.
//
// The driver itself runs against a real Chromium in
// playwright-conformance-harness.ts (its own CI job).
//
//   node out/packages/mcp/test/headless-host-harness.js

import vm from 'vm';
import { BUILTIN_KINDS } from '@shimbrowser/core/spec-lint';
import { coveredCapabilities } from '@shimbrowser/core/page-host-conformance';
import {
  HEADLESS_CAPABILITIES, REQUIRES_SHIM_BROWSER, memoryStorage, netErrorCode, readEngineBundle,
} from '../src/playwright-page-host';
import { pageRuntimeSource } from '../src/headless-page-runtime';
import { PLAYWRIGHT_MISSING } from '../src/playwright-launch';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
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
    check('no iframe rules, no host api members, no component identity, no engine inspection',
      !HEADLESS_CAPABILITIES.iframeRules && HEADLESS_CAPABILITIES.apiMembers.length === 0
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

  console.log('net errors');
  check('refused', netErrorCode('net::ERR_CONNECTION_REFUSED') === -102);
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
  check('a missing Playwright install has an actionable message', /npm install playwright/.test(PLAYWRIGHT_MISSING) && /playwright install chromium/.test(PLAYWRIGHT_MISSING));

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
