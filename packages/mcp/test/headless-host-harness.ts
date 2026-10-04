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
import {
  HEADLESS_CAPABILITIES, REQUIRES_SHIM_BROWSER, memoryStorage, netErrorCode, readEngineBundle, remoteObjectValue,
} from '../src/playwright-page-host';
import { pageRuntimeSource } from '../src/headless-page-runtime';
import {
  PLAYWRIGHT_INSTALL_COMMAND, PLAYWRIGHT_MISSING, HeadlessUnavailableError, chromiumInstallCommand, globalPrefixDirs,
  headlessReadiness, launchFailure, loadPlaywright, locatePlaywright, playwrightSearchDirs, systemDepsInstallCommand, type RequireFrom,
} from '../src/playwright-launch';

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
