// The Chrome facts Shim for Chrome's secret vault stands on, measured in a
// real Chromium with a probe extension (generated here, not the shipped one)
// whose user scripts are allowed the way a user allows them. A vault shim gets
// its own user-script world and proves who it is with a token planted in that
// world, because Chrome tells the worker nothing about which world a message
// came from. Each fact below is load-bearing; a change in any of them blocks
// a release until the design is reviewed again:
//
//   - worlds with different ids share the DOM but not JS globals;
//   - a message's sender names no user-script world (if Chrome ever adds one,
//     this fails loudly: migrating identity to it needs a review);
//   - a user-script world reaches only messaging: no chrome.storage, nothing
//     else on `chrome` or `chrome.runtime` beyond what is listed here;
//   - a document holds at most 10 user-script worlds, the default included,
//     counted over its lifetime (a same-document navigation clears nothing;
//     re-entering a used world reuses its realm), and one past the cap runs
//     silently in the default world, at load and by injection alike; a new
//     document starts the count again;
//   - storage access levels: storage.session is closed to content scripts by
//     default, storage.local is open until restricted, and
//     setAccessLevel('TRUSTED_CONTEXTS') closes it;
//   - Network Error Logging: a fetch the extension's worker makes to an
//     origin whose policy an earlier worker fetch installed is reported with
//     its full URL, query included, to the endpoint the origin names; a policy
//     a page installed does not cover the worker. A key placed in a URL's
//     query reaches that report endpoint, so both are pinned
//     (WORKER_FETCH_NEL, NEL_PAGE_POLICY_COVERS_WORKER) for the vault to
//     disclose or close. A page load reporting is the control that NEL works here at
//     all. The site is served over HTTPS with a generated certificate the
//     browser is told to trust by its key (`openssl` must be installed).
//
//   npx playwright install chromium   (full Chromium: extensions need it)
//   node out/packages/extension/test/extension-chrome-facts-harness.js

import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';
import type { BrowserContext, Page, Worker } from 'playwright';
import { workDir, launch, workerOf, configureExtension, settle, sleep } from './smoke-helpers';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { passes++; console.log(`  ✓ ${label}`); return; }
  failures++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
}

/** Chrome's cap on user-script worlds per document, the default world included. */
const WORLD_CAP = 10;
/** The oldest Chrome the vault supports (worldId on registrations: 133; userScripts.execute: 135). */
const MIN_CHROME = 135;

/**
 * What a user-script world may see on `chrome` and `chrome.runtime`. Anything
 * new is a widening of what a shim's world can reach: review it before
 * extending these lists.
 */
const CHROME_KEYS_ALLOWED = new Set(['runtime', 'csi', 'loadTimes']);
const RUNTIME_KEYS_ALLOWED = new Set([
  'id', 'dynamicId', 'connect', 'sendMessage', 'onConnect', 'onMessage',
  'ContextType', 'OnInstalledReason', 'OnRestartRequiredReason', 'PlatformArch', 'PlatformNaclArch', 'PlatformOs', 'RequestUpdateCheckStatus',
]);

/** The NEL fixture's host (resolved to loopback in the browser). */
const NEL_HOST = 'shim-nel.test';
/**
 * The pinned answer: does a worker-initiated fetch produce a NEL report whose
 * URL carries the request's query? Measured on Chromium 156: yes. Once any
 * earlier worker fetch to the origin installed a policy, later ones are
 * reported, successes, HTTP errors and network errors alike, to whatever
 * endpoint the origin's Report-To names, full URL and query included. So a
 * query-placed key reaches the service's chosen report collector. A change
 * either way is a fact the vault's disclosure (or its mitigation) must follow.
 */
const WORKER_FETCH_NEL = true;
/** Whether a NEL policy installed by a page load on the origin also covers the worker's fetches there (no: policies are partitioned). */
const NEL_PAGE_POLICY_COVERS_WORKER = false;
/** How long a NEL observation lasts (reports are queued within 100ms under --short-reporting-delay). */
const NEL_WINDOW_MS = 6000;

const MANIFEST = {
  manifest_version: 3,
  name: 'shim world facts probe',
  version: '1',
  permissions: ['userScripts', 'scripting', 'storage'],
  host_permissions: ['http://127.0.0.1/*', `https://${NEL_HOST}/*`],
  background: { service_worker: 'sw.js' },
};

// The probe's worker. Every helper is called from the test through
// worker.evaluate. `mark(w)` is the code each world runs: it plants a global
// named for itself, marks the shared DOM, and reports which planted globals it
// can see (its own alone, when it is isolated).
const SW = `
self.senders = [];
self.getSenders = () => self.senders;
chrome.runtime.onUserScriptMessage.addListener((msg, sender, reply) => {
  self.senders.push({ msg, keys: Object.keys(sender) });
  reply({ ok: true });
});
self.mark = (w) => \`(() => {
  globalThis['own_\${w}'] = 1;
  const sees = Object.keys(globalThis).filter((k) => k.startsWith('own_')).sort();
  document.documentElement.setAttribute('data-w-\${w}', sees.join('+'));
  return sees;
})()\`;
self.report = (w) => \`setTimeout(() => chrome.runtime.sendMessage({
  w: '\${w}',
  sees: Object.keys(globalThis).filter((k) => k.startsWith('own_')).sort(),
  storage: typeof chrome.storage,
  chromeKeys: Object.keys(chrome).sort(),
  runtimeKeys: Object.keys(chrome.runtime).sort(),
}), 100);\`;
self.reset = async () => {
  await chrome.userScripts.unregister();
  for (const c of await chrome.userScripts.getWorldConfigurations()) if (c.worldId) await chrome.userScripts.resetWorldConfiguration(c.worldId);
  await chrome.userScripts.configureWorld({ messaging: true });
  self.senders = [];
};
// Registrations: one per world id (null is the default world), all at document_start.
self.registerWorlds = async (ids, withReport) => {
  await self.reset();
  for (const w of ids) if (w) await chrome.userScripts.configureWorld({ worldId: w, messaging: true });
  await chrome.userScripts.register(ids.map((w, i) => ({
    id: 'r' + i, matches: ['http://127.0.0.1/*'], runAt: 'document_start', ...(w ? { worldId: w } : {}),
    js: [{ code: self.mark(w || 'default') + ';' + (withReport ? self.report(w || 'default') : '') }],
  })));
  return (await chrome.userScripts.getScripts()).length;
};
self.tabOf = async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id;
// One injection into an open document: the world's answer, or the error.
self.inject = async (tabId, w) => {
  const [r] = await chrome.userScripts.execute({ target: { tabId }, ...(w ? { worldId: w } : {}), js: [{ code: self.mark(w || 'default') }] });
  return r && 'result' in r ? r.result : { error: String(r && r.error) };
};
// Arbitrary code in one world of an open document (no mark): its answer.
self.injectCode = async (tabId, w, code) => {
  const [r] = await chrome.userScripts.execute({ target: { tabId }, worldId: w, js: [{ code }] });
  return r && 'result' in r ? r.result : { error: String(r && r.error) };
};
// A content script (the isolated world, not a user-script world) reading both storage areas.
self.contentStorage = async (tabId) => {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
    const read = async (area) => { try { await chrome.storage[area].get(null); return 'readable'; } catch (e) { return 'refused'; } };
    return { local: await read('local'), session: await read('session') };
  } });
  return r.result;
};
// A fetch the worker itself makes (the vault's broker fetches this way).
self.workerFetch = async (url) => {
  try { return (await fetch(url, { cache: 'no-store', credentials: 'omit' })).status; } catch { return 'network-error'; }
};
self.restrictLocal = () => chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
self.workerStorage = async () => {
  await chrome.storage.local.set({ probe: 1 });
  await chrome.storage.session.set({ probe: 1 });
  return { local: (await chrome.storage.local.get('probe')).probe, session: (await chrome.storage.session.get('probe')).probe };
};
`;

interface Report { w: string; sees: string[]; storage: string; chromeKeys: string[]; runtimeKeys: string[] }
interface Sender { msg: Report; keys: string[] }

async function server(): Promise<{ origin: string; close(): void }> {
  const s = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>facts</title><p>facts</p>');
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  return { origin: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
}

/** The `data-w-<world>` marks on the page: world → the planted globals it saw. */
async function marks(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => Object.fromEntries([...document.documentElement.attributes]
    .filter((a) => a.name.startsWith('data-w-')).map((a) => [a.name.slice('data-w-'.length), a.value])));
}

/**
 * An HTTPS site whose every answer installs a NEL policy (success and failure
 * fractions 1.0) reporting to its own /reports, which records each report body.
 * /fail answers 500; /reset drops the connection. The certificate is generated
 * here for NEL_HOST; `spki` is its key hash for --ignore-certificate-errors-spki-list
 * (NEL ignores connections with certificate errors, so it must verify cleanly).
 */
async function nelServer(work: string): Promise<{ port: number; spki: string; reports: string[]; close(): void }> {
  const key = path.join(work, 'nel-key.pem');
  const cert = path.join(work, 'nel-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
    '-subj', `/CN=${NEL_HOST}`, '-addext', `subjectAltName=DNS:${NEL_HOST}`], { stdio: 'ignore' });
  const pem = fs.readFileSync(cert);
  const spki = crypto.createHash('sha256').update(new crypto.X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const reports: string[] = [];
  let port = 0;
  const s = https.createServer({ key: fs.readFileSync(key), cert: pem }, (req, res) => {
    const pathname = new URL(req.url ?? '/', 'https://x').pathname;
    if (pathname === '/reports') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => { reports.push(body); res.writeHead(204); res.end(); });
      return;
    }
    if (pathname === '/reset') { req.socket.destroy(); return; }
    res.writeHead(pathname === '/fail' ? 500 : 200, {
      'content-type': 'text/html',
      'report-to': JSON.stringify({ group: 'nel', max_age: 86400, endpoints: [{ url: `https://${NEL_HOST}:${port}/reports` }] }),
      nel: JSON.stringify({ report_to: 'nel', max_age: 86400, success_fraction: 1.0, failure_fraction: 1.0 }),
    });
    res.end('<!doctype html><title>nel</title>');
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  port = (s.address() as AddressInfo).port;
  return { port, spki, reports, close: () => s.close() };
}

const named = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const alone = (w: string, sees: unknown): boolean => Array.isArray(sees) && sees.length === 1 && sees[0] === `own_${w}`;

async function main(): Promise<void> {
  const work = workDir('shim-chrome-facts-');
  const ext = path.join(work, 'ext');
  fs.mkdirSync(ext);
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(ext, 'sw.js'), SW);
  const profile = path.join(work, 'profile');
  const { origin, close } = await server();
  const nel = await nelServer(work);
  const nelArgs = { hosts: [NEL_HOST], args: [`--ignore-certificate-errors-spki-list=${nel.spki}`, '--short-reporting-delay'] };

  // Allow user scripts the way a user does, then relaunch (the toggle reloads the extension).
  let ctx: BrowserContext = await launch(ext, profile, nelArgs);
  const { extId } = await workerOf(ctx);
  check('allowing user scripts answers ok', (await configureExtension(ctx, extId, { userScriptsAccess: true })) === 'ok');
  await ctx.close();
  ctx = await launch(ext, profile, nelArgs);
  const sw: Worker = (await workerOf(ctx)).worker;
  const call = <T>(fn: string, ...args: unknown[]): Promise<T> =>
    sw.evaluate(([f, a]) => (self as unknown as Record<string, ((...x: unknown[]) => unknown) | undefined>)[f]?.(...a), [fn, args] as const) as Promise<T>;

  const version = ctx.browser()?.version() ?? '';
  const major = Number(version.split('.')[0]);
  console.log(`chromium ${version}`);
  check(`the browser is at least Chrome ${MIN_CHROME}`, major >= MIN_CHROME, version);

  const open = async (pathname: string): Promise<{ page: Page; tabId: number }> => {
    const page = await ctx.newPage();
    await page.goto(`${origin}${pathname}`);
    const tabId = await settle(() => call<number | undefined>('tabOf', page.url()), (id) => typeof id === 'number');
    if (typeof tabId !== 'number') throw new Error(`no tab for ${page.url()}`);
    return { page, tabId };
  };

  try {
    console.log('isolation');
    {
      await call('registerWorlds', [null, 'wa', 'wb'], true);
      const { page } = await open('/isolation');
      const reports = await settle(() => call<Sender[]>('getSenders'), (s) => s.length >= 3);
      const byWorld = Object.fromEntries(reports.map((r) => [r.msg.w, r.msg]));
      check('each world sees only the globals it planted', ['default', 'wa', 'wb'].every((w) => alone(w, byWorld[w]?.sees)), byWorld);
      const m = await marks(page);
      check('and all of them share one DOM', ['default', 'wa', 'wb'].every((w) => w in m), m);

      console.log('sender');
      console.log(`    sender keys: ${[...new Set(reports.flatMap((r) => r.keys))].sort().join(', ')}`);
      const worldKeys = [...new Set(reports.flatMap((r) => r.keys))].filter((k) => /world/i.test(k));
      if (worldKeys.length) {
        console.error(`\n  !! Chrome's MessageSender now carries ${worldKeys.join(', ')}. Shim for Chrome identifies a vault shim's\n  !! world by a planted token because Chrome named no world; an authenticated world id needs a migration\n  !! review of the vault's identity design before anything else changes.\n`);
      }
      check('a message from a user-script world names no world (identity stays a planted token)', worldKeys.length === 0, worldKeys);
      check('nor does it differ between worlds', new Set(reports.map((r) => r.keys.sort().join(','))).size === 1, reports.map((r) => r.keys));

      console.log('reach');
      console.log(`    chrome: ${[...new Set(reports.flatMap((r) => r.msg.chromeKeys))].join(', ')}; chrome.runtime: ${[...new Set(reports.flatMap((r) => r.msg.runtimeKeys))].join(', ')}`);
      check('chrome.storage is undefined in a user-script world', reports.every((r) => r.msg.storage === 'undefined'), reports.map((r) => r.msg.storage));
      const extraChrome = [...new Set(reports.flatMap((r) => r.msg.chromeKeys))].filter((k) => !CHROME_KEYS_ALLOWED.has(k));
      check('nothing on chrome beyond runtime', extraChrome.length === 0, extraChrome);
      const extraRuntime = [...new Set(reports.flatMap((r) => r.msg.runtimeKeys))].filter((k) => !RUNTIME_KEYS_ALLOWED.has(k));
      check('and nothing on chrome.runtime beyond messaging', extraRuntime.length === 0, extraRuntime);
      check('messaging itself is reachable', reports.every((r) => r.msg.runtimeKeys.includes('sendMessage')), reports.map((r) => r.msg.runtimeKeys));
      await page.close();
    }

    console.log('the cap, at load');
    {
      const atCap = named('c', WORLD_CAP - 1);
      check(`${WORLD_CAP - 1} named worlds and the default register`, (await call<number>('registerWorlds', [null, ...atCap], false)) === WORLD_CAP);
      const { page } = await open('/at-cap');
      const m = await settle(() => marks(page), (x) => Object.keys(x).length >= WORLD_CAP);
      check(`at ${WORLD_CAP} worlds, every named world is isolated`, atCap.every((w) => m[w] === `own_${w}`), m);
      await page.close();

      const over = named('o', WORLD_CAP);
      await call('registerWorlds', [null, ...over], false);
      const { page: p2 } = await open('/over-cap');
      const m2 = await settle(() => marks(p2), (x) => Object.keys(x).length >= WORLD_CAP + 1);
      const merged = over.filter((w) => m2[w] !== `own_${w}`);
      check('one world past the cap is not isolated', merged.length === 1, m2);
      const [overflow] = merged;
      check('it runs silently in the default world', merged.length === 1 && overflow !== undefined && (m2[overflow] ?? '').split('+').includes('own_default'), m2);
      await p2.close();
    }

    console.log('the cap, over a document\'s lifetime');
    {
      await call('reset');
      const { page, tabId } = await open('/lifetime');
      check('the default world takes an injection', alone('default', await call('inject', tabId, null)));
      const first = named('l', WORLD_CAP - 1);
      const answers: unknown[] = [];
      for (const w of first) answers.push(await call('inject', tabId, w));
      check(`${WORLD_CAP - 1} named worlds injected one by one are each isolated`, first.every((w, i) => alone(w, answers[i])), answers);
      const sentinelWorld = first[3] ?? 'l3';
      await call('injectCode', tabId, sentinelWorld, `globalThis.shim_sentinel = 'kept-${sentinelWorld}'; true`);
      await page.evaluate(() => history.pushState(null, '', '/lifetime/elsewhere'));
      const late = await call<unknown>('inject', tabId, 'late');
      check('after a same-document navigation, one more world is not isolated (the count is per document lifetime)', !alone('late', late), late);
      check('it runs in the default world', Array.isArray(late) && late.includes('own_default'), late);
      const reused = first[3] ?? 'l3';
      const again = await call<unknown>('injectCode', tabId, reused, `[globalThis.shim_sentinel ?? null, Object.keys(globalThis).filter((k) => k.startsWith('own_')).sort()]`);
      check('re-entering a used world reuses its realm (a value planted before is still there, read without planting)',
        JSON.stringify(again) === JSON.stringify(['kept-' + reused, [`own_${reused}`]]), again);

      await page.goto(`${origin}/lifetime/new-document`);
      const fresh = await settle(() => call<number | undefined>('tabOf', page.url()), (id) => id === tabId);
      check('a full navigation keeps the tab', fresh === tabId);
      await call('inject', tabId, null);
      const reborn = await call<unknown>('inject', tabId, 'late');
      check('a new document starts the count again: the same world id is isolated there', alone('late', reborn), reborn);
      await page.close();
    }

    console.log('storage access levels');
    {
      await call('reset');
      const { page, tabId } = await open('/storage');
      check('the worker reads both areas', JSON.stringify(await call('workerStorage')) === JSON.stringify({ local: 1, session: 1 }));
      const before = await call<{ local: string; session: string }>('contentStorage', tabId);
      check('a content script cannot read storage.session by default', before.session === 'refused', before);
      check('but can read storage.local until it is restricted', before.local === 'readable', before);
      await call('restrictLocal');
      const after = await call<{ local: string; session: string }>('contentStorage', tabId);
      check('setAccessLevel(TRUSTED_CONTEXTS) closes storage.local to content scripts', after.local === 'refused' && after.session === 'refused', after);
      check('and the worker still reads both', JSON.stringify(await call('workerStorage')) === JSON.stringify({ local: 1, session: 1 }));
      await page.close();
    }

    console.log('network error logging');
    {
      const nelOrigin = `https://${NEL_HOST}:${nel.port}`;
      const page = await ctx.newPage();
      await page.goto(`${nelOrigin}/control`);
      const control = await settle(async () => nel.reports.join('\n'), (r) => r.includes('/control'), 15000);
      check('control: a page load on the NEL site is reported (NEL works in this browser)', control.includes('/control'), nel.reports);
      await page.close();

      // Only the page's policy exists: a worker fetch to /reset (which sends no
      // headers of its own), then a fixed window, not ended early by anything.
      const pageOnly = await call('workerFetch', `${nelOrigin}/reset?key=SECRET-PAGE-POLICY`);
      check('the worker reaches the NEL site (a dropped connection)', pageOnly === 'network-error', pageOnly);
      await sleep(NEL_WINDOW_MS);
      const pageCovered = nel.reports.join('\n').includes('SECRET-PAGE-POLICY');

      // Then a policy installed by the worker's own request, and requests under it.
      const statuses = [
        await call('workerFetch', `${nelOrigin}/install`),
        await call('workerFetch', `${nelOrigin}/api?key=SECRET-OK`),
        await call('workerFetch', `${nelOrigin}/fail?key=SECRET-HTTP-ERROR`),
        await call('workerFetch', `${nelOrigin}/reset?key=SECRET-NETWORK-ERROR`),
      ];
      check('and answers under the worker\'s policy (200, 200, 500, a dropped connection)', JSON.stringify(statuses) === JSON.stringify([200, 200, 500, 'network-error']), statuses);
      const own = ['SECRET-OK', 'SECRET-HTTP-ERROR', 'SECRET-NETWORK-ERROR'];
      const want = WORKER_FETCH_NEL ? (r: string): boolean => own.every((k) => r.includes(k)) : (): boolean => false;
      // Positive evidence ends the wait; expecting none, the whole window passes.
      const all = await settle(async () => nel.reports.join('\n'), want, NEL_WINDOW_MS);
      const leaked = own.filter((k) => all.includes(k));
      console.log(`    worker fetches reported with their query: ${leaked.length ? leaked.join(', ') : 'none'}${pageCovered ? ' (and SECRET-PAGE-POLICY)' : ''}`);
      if (process.env.SHIM_FACTS_DUMP) console.log(all);
      check(`a worker-initiated fetch ${WORKER_FETCH_NEL ? 'is' : 'is not'} reported by NEL with its full URL, query included, success, HTTP error and network error alike (pinned: WORKER_FETCH_NEL)`,
        WORKER_FETCH_NEL ? leaked.length === own.length : leaked.length === 0, leaked);
      check(`a policy a page installed ${NEL_PAGE_POLICY_COVERS_WORKER ? 'covers' : 'does not cover'} the worker's fetches (pinned: NEL_PAGE_POLICY_COVERS_WORKER)`,
        (pageCovered || nel.reports.join('\n').includes('SECRET-PAGE-POLICY')) === NEL_PAGE_POLICY_COVERS_WORKER, nel.reports);
    }
  } finally {
    await ctx.close();
    close();
    nel.close();
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log('');
  if (failures) {
    console.error(`${failures} Chrome fact(s) changed. Shim for Chrome's secret vault depends on each one: review the vault design before releasing.`);
    process.exit(1);
  }
  console.log(`all Chrome facts hold (${passes})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
