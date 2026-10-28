// The built extension in a real Chromium with user scripts allowed: full
// mode. The real-browser gate for what EXTENSION_CAPABILITIES advertises
// until the extension has a PageHost and runs the shared conformance
// suite. The user-scripts toggle is flipped the way a user flips it (the
// chrome://extensions WebUI's own call) and the profile relaunched, since
// the toggle reloads the extension and Playwright loses the worker across
// an in-place reload.
//
// Covers: the mode read from the API, the registrations as user scripts
// (none as content scripts), a `script` handler compiled in the user-script
// world under a strict page CSP, `api.storage` and `api.cleanup` from a
// handler, `replace-root`, a declarative shim beside it, live changes on an
// open page over the runtime's port (disable, enable) and by injection into
// a page with no runtime, site access withheld and granted back, a handler
// that does not parse refused at install (the sandboxed check), and the
// toggle flipped off and on again with shims installed: the one that needs
// full mode stops and says so, the declarative one keeps running, and both
// return with the toggle. Then settings and fetch from a handler: a secret
// setting refused at install, a handler reading its defaults, api.fetch
// through the worker without the site's cookie and refusing a private
// address, the popup's "needs setup" and settings page, a value set there
// reaching the open page (the shim reboots), and a reset to the default.
//
//   npx playwright install chromium   (full Chromium: extensions need it)
//   node out/packages/extension/test/extension-full-mode-harness.js

import fs from 'fs';
import path from 'path';
import type { BrowserContext, Page, Worker } from 'playwright';
import {
  workDir, extensionCopy, fixtureServer, shimWriter, css, launch, workerOf, installer, configureExtension, setExtensionEnabled, popupOf,
  settle, sleep, FIXTURE_ALIAS,
} from './smoke-helpers';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { passes++; console.log(`  ✓ ${label}`); return; }
  failures++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
}

interface StrictView { ad: string; badge: string | null; cleanups: number; outline: string }
interface CfgView { greeting: unknown; limit: unknown; keys: string[]; status: number; data: { answer?: number; sawCookie?: boolean } | string; blocked: boolean }
interface ApplyView { ad: string; root: number; original: string | null }

const BADGE = `module.exports = async function badge({ anchor, api }) {
  const visits = Number(await api.storage.get('visits')) || 0;
  await api.storage.set('visits', visits + 1);
  const el = document.createElement('span');
  el.className = 'fm-badge';
  el.textContent = 'visits:' + (visits + 1);
  anchor.appendChild(el);
  api.cleanup(() => {
    const html = document.documentElement;
    html.setAttribute('data-fm-cleanups', String(Number(html.getAttribute('data-fm-cleanups') || 0) + 1));
  });
  return el;
};`;
const ROOT = `module.exports = function root({ anchor }) {
  const el = document.createElement('p');
  el.className = 'fm-root';
  el.textContent = 'replaced';
  anchor.appendChild(el);
  return el;
};`;
const BROKEN = 'module.exports = function ( { return 1; };';
// api.fetch reaches the fixture by a public-looking name (it refuses the
// page's own loopback host, which is the refusal checked here).
const CFG = `module.exports = async function cfg({ anchor, api }) {
  const all = await api.settings.getAll();
  const greeting = await api.settings.get('greeting');
  const r = await api.fetch('http://${FIXTURE_ALIAS}:' + location.port + '/fixture-data.json');
  const loopback = await api.fetch(location.origin + '/fixture-data.json');
  const meta = await api.fetch('http://169.254.169.254/latest/meta-data');
  const el = document.createElement('span');
  el.className = 'fm-cfg';
  el.textContent = JSON.stringify({
    greeting, limit: all.limit === undefined ? null : all.limit, keys: Object.keys(all),
    status: r.status, data: r.ok ? JSON.parse(r.text) : r.error,
    blocked: !loopback.ok && String(loopback.error).includes('private') && !meta.ok && String(meta.error).includes('private'),
  });
  anchor.appendChild(el);
  return el;
};`;

async function main(): Promise<void> {
  console.log('\n=== extension full-mode harness ===\n');
  const work = workDir('shim-extension-full-');
  const ext = extensionCopy(work, ['*://127.0.0.1/*']);
  const { origin, close: closeServer } = await fixtureServer();
  const shimFile = shimWriter(work);

  const scripted = shimFile('scripted', 'Scripted fixture', [
    { id: 'hide-strict-ad', anchor: css('#strict-ad'), mutations: [{ kind: 'hide' }] },
    { id: 'badge', anchor: css('#strict-target'), mutations: [{ kind: 'script', handler: 'badge' }] },
    { id: 'root', anchor: css('#root-target'), mutations: [{ kind: 'replace-root', handler: 'root' }] },
  ], { css: '#strict-target { outline: 2px solid rgb(0, 128, 0) }' }, { badge: BADGE, root: ROOT });
  const tidy = shimFile('tidy', 'Tidy fixture', [
    { id: 'hide-ad', anchor: css('#ad'), mutations: [{ kind: 'hide' }] },
  ]);
  const broken = shimFile('broken', 'Broken fixture', [
    { id: 'bad', anchor: css('body'), mutations: [{ kind: 'script', handler: 'bad' }] },
  ], {}, { bad: BROKEN });

  const profile = path.join(work, 'profile');
  let ctx: BrowserContext = await launch(ext, profile);
  const errors: string[] = [];
  const watch = (c: BrowserContext): void => { c.on('weberror', (e) => errors.push(String(e.error()))); };
  watch(ctx);
  let { worker, extId } = await workerOf(ctx);

  const userScriptsState = (w: Worker): Promise<string> => w.evaluate(() => {
    try { return typeof (chrome as { userScripts?: unknown }).userScripts; } catch { return 'throws'; }
  });
  const userScripts = (): Promise<{ id: string; world?: string; js?: unknown; matches?: string[] }[]> => worker.evaluate(() => chrome.userScripts.getScripts());
  const contentScripts = (): Promise<unknown[]> => worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  const strictView = (page: Page): Promise<StrictView> => page.evaluate(() => ({
    ad: getComputedStyle(document.getElementById('strict-ad') as Element).display,
    badge: document.querySelector('.fm-badge')?.textContent ?? null,
    cleanups: Number(document.documentElement.getAttribute('data-fm-cleanups') || 0),
    outline: getComputedStyle(document.getElementById('strict-target') as Element).outlineColor,
  }));
  const applyView = (page: Page): Promise<ApplyView> => page.evaluate(() => ({
    ad: getComputedStyle(document.getElementById('ad') as Element).display,
    root: document.querySelectorAll('#root-target .fm-root').length,
    original: (() => { const o = document.querySelector('#root-target .original'); return o ? getComputedStyle(o).display : null; })(),
  }));

  console.log('the toggle:');
  {
    check('a fresh profile boots without user scripts (declarative mode)', (await userScriptsState(worker)) !== 'object');
    const popup = await popupOf(ctx, extId);
    check('the popup says so and offers the way to turn them on', ((await popup.textContent('#mode')) ?? '').startsWith('declarative mode') && (await popup.$('#mode button.link')) !== null);
    await popup.close();
    check('allowing user scripts answers ok', (await configureExtension(ctx, extId, { userScriptsAccess: true })) === 'ok');
    await ctx.close();
    ctx = await launch(ext, profile);
    watch(ctx);
    ({ worker, extId } = await workerOf(ctx));
    check('after a relaunch the worker has the API', (await userScriptsState(worker)) === 'object');
    const popup2 = await popupOf(ctx, extId);
    check('and the popup names full mode', ((await popup2.textContent('#mode')) ?? '').startsWith('user scripts on'));
    await popup2.close();
  }

  const { install, installAll } = installer(ctx, extId);
  let declarativePage: Page;

  console.log('a shim with handlers installs and runs:');
  {
    const { page, heading } = await install(scripted);
    check('the review is ready (the sandboxed check parsed the handlers)', heading.startsWith('ready to install'), heading);
    const facts = await page.$$eval('#review dl dd', (dd) => dd.map((d) => d.textContent));
    check('and names the kinds', (facts[2] ?? '').startsWith('3 (hide, script, replace-root)'), facts);
    await page.click('#review button.primary');
    await page.waitForSelector('#result:not([hidden]) h2', { timeout: 15000 });
    await page.close();
    const regs = await userScripts();
    check('one user script, for the shim\'s host, engine then runtime, in the user-script world',
      regs.length === 1 && (regs[0]?.id ?? '').startsWith('shim:') && JSON.stringify(regs[0]?.matches) === '["*://127.0.0.1/*"]'
        && JSON.stringify(regs[0]?.js) === '[{"file":"shim-core.page.js"},{"file":"content.js"}]' && regs[0]?.world === 'USER_SCRIPT', regs);
    check('and no content script', (await contentScripts()).length === 0);
  }

  const strict = await ctx.newPage();
  const strictSettled = (want: (v: StrictView) => boolean) => settle(() => strictView(strict), want);
  console.log('on the strict-CSP page:');
  {
    await strict.goto(`${origin}/strict`);
    const v = await strictSettled((v) => v.ad === 'none' && v.badge !== null);
    check('the declarative rule applies', v.ad === 'none', v);
    check('the script handler compiled in the user-script world and ran under script-src \'self\'', v.badge === 'visits:1', v);
    await strict.reload();
    const v2 = await strictSettled((v) => v.badge === 'visits:2');
    check('api.storage persisted through the worker: the next load counts the visit', v2.badge === 'visits:2', v2);
  }

  console.log('a second runtime from the other world on the same page:');
  {
    // The user-script runtime holds /strict. An isolated-world runtime
    // injected beside it (a handover and a reconnect crossing) connects,
    // and the worker retires the one that does not fit the mode: here the
    // newcomer. The page keeps one runtime, its rules and its stylesheet.
    const tabs = await worker.evaluate(() => chrome.tabs.query({ url: '*://127.0.0.1/strict' }).then((t) => t.map((x) => x.id)));
    const tabId = tabs[0];
    check('the strict page is open', typeof tabId === 'number');
    if (typeof tabId === 'number') {
      const before = await strictView(strict);
      await worker.evaluate(async (id) => { await chrome.scripting.executeScript({ target: { tabId: id }, files: ['shim-core.page.js', 'content.js'] }); }, tabId);
      await sleep(1500);
      const v = await strictView(strict);
      check('the page keeps the handler shim, the hide and the spec stylesheet', v.badge !== null && v.ad === 'none' && v.outline === 'rgb(0, 128, 0)', v);
      check('and the holder was not rebooted for a newcomer that never ran (no extra cleanup, no extra visit)', v.cleanups === before.cleanups && v.badge === before.badge, { before, v });
      const sheets = await strict.evaluate(() => document.querySelectorAll('style[data-shim^="patch-"]').length);
      check('one spec stylesheet', sheets === 1, sheets);
      const isolated = await worker.evaluate(async (id) => {
        const r = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => typeof (globalThis as { __shimForChrome?: unknown }).__shimForChrome });
        return r.map((x) => x.result);
      }, tabId);
      check('the isolated-world newcomer was retired (no runtime flag there)', isolated[0] === 'undefined', isolated);
    }
  }

  const apply = await ctx.newPage();
  const applySettled = (want: (v: ApplyView) => boolean) => settle(() => applyView(apply), want);
  console.log('replace-root on /apply:');
  {
    await apply.goto(`${origin}/apply`);
    const v = await applySettled((v) => v.root === 1 && v.original === 'none');
    check('the handler\'s root is mounted', v.root === 1, v);
    check('and the anchor\'s original children are hidden', v.original === 'none', v);
  }

  console.log('live changes over the runtime\'s port:');
  {
    const popup = await popupOf(ctx, extId);
    await popup.waitForSelector('#list .card input[type=checkbox]:checked');
    await popup.click('#list .card:nth-child(1) input[type=checkbox]');
    const off = await strictSettled((v) => v.badge === null && v.ad !== 'none');
    check('disabling tears the shim down on the open page: badge gone, hide gone', off.badge === null && off.ad !== 'none', off);
    check('and the handler\'s api.cleanup ran once', off.cleanups === 1, off);
    const offApply = await applySettled((v) => v.root === 0 && v.original !== 'none');
    check('replace-root is undone on the other open page', offApply.root === 0 && offApply.original !== 'none', offApply);
    check('nothing registered while it is off', (await userScripts()).length === 0);
    await popup.waitForSelector('#list .card:nth-child(1) input[type=checkbox]:not(:checked)');
    await popup.click('#list .card:nth-child(1) input[type=checkbox]');
    const on = await strictSettled((v) => v.badge !== null && v.ad === 'none');
    check('re-enabling starts it again on the open page, the handler compiled again', on.badge === 'visits:3' && on.ad === 'none', on);
    check('registered again', (await userScripts()).length === 1);
    await popup.close();
  }

  console.log('injection into a page with no runtime (userScripts.execute):');
  {
    const popup = await popupOf(ctx, extId);
    await popup.click('#list .card:nth-child(1) input[type=checkbox]');
    await popup.waitForSelector('#list .card:nth-child(1) input[type=checkbox]:not(:checked)');
    check('nothing registered', (await userScripts()).length === 0);
    const fresh = await ctx.newPage();
    await fresh.goto(`${origin}/strict`);
    await sleep(300);
    const before = await strictView(fresh);
    check('a fresh page loads with no runtime', before.badge === null && before.ad !== 'none', before);
    await popup.click('#list .card:nth-child(1) input[type=checkbox]');
    const after = await settle(() => strictView(fresh), (v) => v.badge !== null && v.ad === 'none');
    check('enabling injects the engine and the runtime into it, no reload', after.badge !== null && after.ad === 'none', after);
    await popup.click('#list .card:nth-child(1) input[type=checkbox]');
    await settle(() => strictView(fresh), (v) => v.badge === null);
    await popup.click('#list .card:nth-child(1) input[type=checkbox]');
    const again = await settle(() => strictView(fresh), (v) => v.badge !== null);
    check('a second cycle reuses the first runtime (one engine per document)', again.badge !== null && again.cleanups === 1, again);
    await fresh.close();
    await popup.close();
  }

  console.log('a declarative shim beside it, and site access withheld and granted back:');
  {
    await installAll(tidy);
    await apply.goto(`${origin}/apply`);
    const v = await applySettled((v) => v.ad === 'none' && v.root === 1);
    check('both shims apply on the open page', v.ad === 'none' && v.root === 1, v);
    check('two user scripts', (await userScripts()).length === 2);
    check('withholding site access answers ok', (await configureExtension(ctx, extId, { hostAccess: 'ON_CLICK' })) === 'ok');
    const gone = await applySettled((v) => v.ad !== 'none' && v.root === 0);
    check('access gone: the open page is torn down over the port', gone.ad !== 'none' && gone.root === 0, gone);
    const dGone = Date.now() + 5000;
    while (Date.now() < dGone && (await userScripts()).length !== 0) await sleep(100);
    check('access gone: nothing registered', (await userScripts()).length === 0);
    check('granting access back answers ok', (await configureExtension(ctx, extId, { hostAccess: 'ON_ALL_SITES' })) === 'ok');
    const back = await applySettled((v) => v.ad === 'none' && v.root === 1);
    check('access back: the open page applies again without a reload', back.ad === 'none' && back.root === 1, back);
    const dBack = Date.now() + 5000;
    while (Date.now() < dBack && (await userScripts()).length !== 2) await sleep(100);
    check('access back: both registered again', (await userScripts()).length === 2);
  }

  console.log('a port connection is answered with a sync:');
  {
    // The port a runtime holds dies with the worker and reconnects a second
    // later. A change in that gap (access revoked, say, which boots a fresh
    // worker with no port to nudge) must still reach the page, so every
    // connection starts with a sync: a new port from the user-script world
    // hears one before it says anything. (The worker cannot be made to die
    // on cue under Playwright, whose session keeps it alive, so the
    // mechanism is pinned here rather than the gap itself.)
    const tabs = await worker.evaluate(() => chrome.tabs.query({ url: '*://127.0.0.1/*' }).then((t) => t.map((x) => x.id)));
    const tabId = tabs[0];
    check('a fixture tab is open', typeof tabId === 'number');
    if (typeof tabId === 'number') {
      const heard = await worker.evaluate(async (id) => {
        const res = await chrome.userScripts.execute({
          target: { tabId: id },
          js: [{
            code: `new Promise((resolve) => {
              const port = chrome.runtime.connect({ name: 'shim-runtime' });
              const timer = setTimeout(() => { resolve('nothing'); port.disconnect(); }, 3000);
              port.onMessage.addListener((m) => { clearTimeout(timer); resolve(JSON.stringify(m)); port.disconnect(); });
            })`,
          }],
        });
        return res.map((x) => x.result);
      }, tabId);
      check('a new port from the user-script world is greeted with a sync', heard[0] === '{"type":"sync"}', heard);
    }
  }

  console.log('the extension disabled and enabled again under open pages:');
  {
    // Disabling (as a reload or an update does) invalidates every open
    // document's runtime: no nudge reaches it again, so it tears its shims
    // down on its own. The next instance's first boot gives those pages
    // its runtime.
    const v0 = await applyView(apply);
    const s0 = await strictView(strict);
    check('both pages carry the shims', v0.ad === 'none' && v0.root === 1 && s0.badge !== null, { v0, s0 });
    const fresh = ctx.waitForEvent('serviceworker', { timeout: 15000 });
    check('disabling answers ok', (await setExtensionEnabled(ctx, extId, false)) === 'ok');
    const gone = await applySettled((v) => v.ad !== 'none' && v.root === 0);
    check('the orphaned runtime tears everything down: hide gone, root gone', gone.ad !== 'none' && gone.root === 0, gone);
    const sGone = await strictSettled((v) => v.badge === null && v.ad !== 'none');
    check('on the other page too, and the handler\'s api.cleanup ran', sGone.badge === null && sGone.cleanups === s0.cleanups + 1, { sGone, before: s0.cleanups });
    check('enabling answers ok', (await setExtensionEnabled(ctx, extId, true)) === 'ok');
    worker = await fresh;
    const back = await applySettled((v) => v.ad === 'none' && v.root === 1);
    check('the new instance takes the open page over without a reload', back.ad === 'none' && back.root === 1, back);
    const sBack = await strictSettled((v) => v.badge !== null && v.ad === 'none');
    check('and the other page, the handler compiled again', sBack.badge !== null && sBack.ad === 'none', sBack);
    check('both registered as user scripts in the new instance', (await userScripts()).length === 2 && (await contentScripts()).length === 0);

    // Back to back, so the old teardown and the new injection overlap.
    const fresh2 = ctx.waitForEvent('serviceworker', { timeout: 15000 });
    await setExtensionEnabled(ctx, extId, false);
    check('enabling again at once answers ok', (await setExtensionEnabled(ctx, extId, true)) === 'ok');
    worker = await fresh2;
    const again = await strictSettled((v) => v.badge !== null && v.ad === 'none');
    await sleep(1500);
    const kept = await strictView(strict);
    check('after a prompt re-enable the handler ran, the hide holds and the spec stylesheet survived the old teardown',
      again.badge !== null && kept.badge !== null && kept.ad === 'none' && kept.outline === 'rgb(0, 128, 0)', { again, kept });
    const sheets = await strict.evaluate(() => document.querySelectorAll('style[data-shim^="patch-"]').length);
    check('one spec stylesheet in the document', sheets === 1, sheets);
  }

  console.log('a handler that does not parse:');
  {
    const { page, heading } = await install(broken);
    check('is refused at install', heading.startsWith('cannot install'), heading);
    const problems = await page.$$eval('#review ul.problems li', (li) => li.map((x) => x.textContent ?? ''));
    check('by the syntax check, naming the handler file', problems.some((t) => t.includes('handlers/bad.js') && t.includes('does not parse as JavaScript')), problems);
    await page.close();
  }

  console.log('the toggle flipped off, live (no restart), with shims installed and pages open:');
  {
    // The toggle fires no event and reloads nothing: the running worker
    // keeps a chrome.userScripts whose calls throw, user scripts go inert,
    // and nothing is registered for declarative mode until the worker
    // measures again, which it does on the next navigation or message.
    const v0 = await applyView(apply);
    const s0 = await strictView(strict);
    check('both pages carry the shims', v0.ad === 'none' && v0.root === 1 && s0.badge !== null, { v0, s0 });
    check('disallowing user scripts answers ok', (await configureExtension(ctx, extId, { userScriptsAccess: false })) === 'ok');
    check('the worker was not reloaded', (await worker.evaluate(() => 'alive').catch(() => 'gone')) === 'alive');
    const page = await ctx.newPage();
    await page.goto(`${origin}/apply?declarative`);
    const v1 = await settle(() => applyView(page), (v) => v.ad === 'none');
    check('a page loaded after the flip runs the declarative shim (the navigation made the worker measure again)', v1.ad === 'none', v1);
    check('and not the shim with handlers', v1.root === 0 && v1.original !== 'none', v1);
    const dReg = Date.now() + 5000;
    while (Date.now() < dReg && (await contentScripts()).length !== 1) await sleep(100);
    check('one content script is registered, for the declarative shim', (await contentScripts()).length === 1);
    await page.reload();
    const v2 = await settle(() => applyView(page), (v) => v.ad === 'none');
    check('a reload runs it as a content script', v2.ad === 'none' && v2.root === 0, v2);
    const popup = await popupOf(ctx, extId);
    check('the popup names declarative mode', ((await popup.textContent('#mode')) ?? '').startsWith('declarative mode'));
    const pills = await popup.$$eval('#list .card', (cards) => cards.map((c) => ({ name: c.querySelector('.name')?.textContent, pill: c.querySelector('.pill')?.textContent ?? null })));
    check('and the shim with handlers shows "needs user scripts"', pills.some((p) => p.name === 'Scripted fixture' && p.pill === 'needs user scripts'), pills);
    await popup.close();
    const open = await applySettled((v) => v.root === 0);
    check('a page open from full mode drops its handler shim on the nudge and keeps the declarative one', open.root === 0 && open.original !== 'none' && open.ad === 'none', open);
    const sOpen = await strictSettled((v) => v.badge === null);
    check('on the other open page too, with the handler\'s api.cleanup run', sOpen.badge === null && sOpen.cleanups === s0.cleanups + 1, { sOpen, before: s0.cleanups });
    declarativePage = page;
  }

  console.log('the toggle flipped on again, live:');
  {
    check('allowing user scripts answers ok', (await configureExtension(ctx, extId, { userScriptsAccess: true })) === 'ok');
    // The handover with a bundle request in flight: the isolated-world
    // runtime's own request is what makes the worker measure the mode
    // again, retire it and inject its successor, and its answer arrives
    // only after. Its bundle answers are held in its world for a while,
    // then it is nudged: the retired runtime must boot nothing from the
    // late answer, or the successor's rules would be duplicated and the
    // old copy deaf to every later change.
    const declTab = (await worker.evaluate(() => chrome.tabs.query({ url: '*://127.0.0.1/apply?declarative' }).then((t) => t.map((x) => x.id))))[0];
    check('the declarative-mode page is open', typeof declTab === 'number');
    if (typeof declTab === 'number') {
      const wrapped = await worker.evaluate(async (tabId) => {
        const r = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const real = chrome.runtime.sendMessage.bind(chrome.runtime);
            (chrome.runtime as { sendMessage: unknown }).sendMessage = (msg: { type?: string }) => {
              const p = real(msg);
              return msg?.type === 'bundle' ? p.then((a: unknown) => new Promise((r) => setTimeout(() => r(a), 1500))) : p;
            };
            return 'wrapped';
          },
        });
        return r.map((x) => x.result);
      }, declTab);
      check('its bundle answers are held in its world', wrapped[0] === 'wrapped', wrapped);
      await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'sync' }), declTab);
      await sleep(3500);
      const after = await declarativePage.evaluate(() => ({
        sheets: document.querySelectorAll('style[data-shim^="patch-"]').length,
        marks: document.documentElement.getAttribute('data-shim-runtime') !== null,
        ad: getComputedStyle(document.getElementById('ad') as Element).display,
        root: document.querySelectorAll('#root-target .fm-root').length,
      }));
      check('after the late answer: one runtime holds the document, the handler shim runs, nothing is duplicated', after.marks && after.root === 1 && after.ad === 'none' && after.sheets === 1, after);
      const popup = await popupOf(ctx, extId);
      const tidyIndex = await popup.$$eval('#list .card .name', (n) => n.findIndex((x) => x.textContent === 'Tidy fixture'));
      await popup.click(`#list .card:nth-child(${tidyIndex + 1}) input[type=checkbox]`);
      const tidyOff = await settle(() => applyView(declarativePage), (v) => v.ad !== 'none');
      check('disabling the declarative shim removes its output there (the retired runtime kept nothing)', tidyOff.ad !== 'none' && tidyOff.root === 1, tidyOff);
      await popup.waitForSelector('#list .card input[type=checkbox]:not(:checked)');
      await popup.click(`#list .card:nth-child(${tidyIndex + 1}) input[type=checkbox]`);
      await settle(() => applyView(declarativePage), (v) => v.ad === 'none');
      await popup.close();
    }
    const page = await ctx.newPage();
    await page.goto(`${origin}/apply`);
    const v = await settle(() => applyView(page), (v) => v.ad === 'none' && v.root === 1);
    check('a page loaded after the flip runs both shims (in the user-script world, on the navigation)', v.ad === 'none' && v.root === 1, v);
    const dReg = Date.now() + 5000;
    while (Date.now() < dReg && (await userScripts()).length !== 2) await sleep(100);
    check('both are user scripts again and no content script is left', (await userScripts()).length === 2 && (await contentScripts()).length === 0);
    await page.reload();
    const v2 = await settle(() => applyView(page), (v) => v.ad === 'none' && v.root === 1);
    check('a reload runs them as user scripts', v2.ad === 'none' && v2.root === 1, v2);
    await page.close();
    const back = await applySettled((v) => v.root === 1 && v.ad === 'none');
    check('the page still open from full mode, nudged over its port, runs the handler shim again', back.root === 1 && back.ad === 'none', back);
    // The page loaded while user scripts were off ran an isolated-world
    // runtime, which can never compile a handler: full mode retires it and
    // the user-script runtime takes the page over, so the handler shim
    // runs there too, and a shim enabled from the popup reaches it.
    const handed = await settle(() => applyView(declarativePage), (v) => v.root === 1 && v.ad === 'none');
    check('the page open from declarative mode is handed to a user-script runtime: the handler shim runs there without a reload', handed.root === 1 && handed.ad === 'none', handed);
    const sheets = await declarativePage.evaluate(() => ({ marks: document.documentElement.getAttribute('data-shim-runtime') !== null, hide: document.querySelectorAll('style[data-shim]').length }));
    check('one runtime holds the document', sheets.marks, sheets);
    const popup = await popupOf(ctx, extId);
    const toggleScripted = async (): Promise<void> => {
      const index = await popup.$$eval('#list .card .name', (n) => n.findIndex((x) => x.textContent === 'Scripted fixture'));
      await popup.click(`#list .card:nth-child(${index + 1}) input[type=checkbox]`);
    };
    await toggleScripted();
    const off = await settle(() => applyView(declarativePage), (v) => v.root === 0);
    check('disabling the handler shim from the popup reaches that page', off.root === 0 && off.ad === 'none', off);
    await popup.waitForSelector('#list .card input[type=checkbox]:not(:checked)');
    await toggleScripted();
    const on = await settle(() => applyView(declarativePage), (v) => v.root === 1);
    check('and enabling it again starts it there', on.root === 1 && on.ad === 'none', on);
    await popup.close();
    await declarativePage.close();
  }

  console.log('the toggle flipped off, then the browser restarted:');
  {
    check('disallowing user scripts answers ok', (await configureExtension(ctx, extId, { userScriptsAccess: false })) === 'ok');
    await ctx.close();
    ctx = await launch(ext, profile);
    watch(ctx);
    ({ worker, extId } = await workerOf(ctx));
    check('after a relaunch the worker runs declarative', (await userScriptsState(worker)) !== 'object');
    const popup = await popupOf(ctx, extId);
    check('the popup names declarative mode', ((await popup.textContent('#mode')) ?? '').startsWith('declarative mode'));
    const pills = await popup.$$eval('#list .card', (cards) => cards.map((c) => ({ name: c.querySelector('.name')?.textContent, pill: c.querySelector('.pill')?.textContent ?? null, toggle: c.querySelector('input[type=checkbox]') !== null })));
    check('the shim with handlers shows "needs user scripts" and no toggle', pills.some((p) => p.name === 'Scripted fixture' && p.pill === 'needs user scripts' && !p.toggle), pills);
    check('the declarative shim keeps its toggle', pills.some((p) => p.name === 'Tidy fixture' && p.pill === null && p.toggle), pills);
    await popup.close();
    const d = Date.now() + 5000;
    while (Date.now() < d && (await contentScripts()).length !== 1) await sleep(100);
    const content = await contentScripts() as { id?: string; world?: string }[];
    check('one content script, for the declarative shim', content.length === 1 && content[0]?.world === 'ISOLATED', content);
    const page = await ctx.newPage();
    await page.goto(`${origin}/apply`);
    const v = await settle(() => applyView(page), (v) => v.ad === 'none');
    check('the declarative shim runs', v.ad === 'none', v);
    check('the shim with handlers does not', v.root === 0 && v.original !== 'none', v);
    await page.close();

    check('allowing user scripts again answers ok', (await configureExtension(ctx, extId, { userScriptsAccess: true })) === 'ok');
    await ctx.close();
    ctx = await launch(ext, profile);
    watch(ctx);
    ({ worker } = await workerOf(ctx));
    const d2 = Date.now() + 5000;
    while (Date.now() < d2 && (await userScripts()).length !== 2) await sleep(100);
    check('toggle back on: both shims are user scripts again', (await userScripts()).length === 2 && (await contentScripts()).length === 0);
    const page2 = await ctx.newPage();
    await page2.goto(`${origin}/apply`);
    const v2 = await settle(() => applyView(page2), (v) => v.ad === 'none' && v.root === 1);
    check('and both run', v2.ad === 'none' && v2.root === 1, v2);
    await page2.close();
  }

  console.log('settings and fetch from a handler:');
  {
    const inst = installer(ctx, extId);
    const secretive = shimFile('secretive', 'Secret fixture', [
      { id: 'hide-ad', anchor: css('#ad'), mutations: [{ kind: 'hide' }] },
    ], { settings: [{ key: 'token', type: 'secret' }] });
    const refused = await inst.install(secretive);
    const problems = await refused.page.$$eval('#review ul.problems li', (li) => li.map((x) => x.textContent ?? ''));
    check('a shim with a secret setting is refused at install, naming the field', refused.heading.startsWith('cannot install')
      && problems.some((p) => p.includes('"token"') && p.includes('cannot store encrypted')), { heading: refused.heading, problems });
    await refused.page.close();

    const configured = shimFile('configured', 'Configured fixture', [
      { id: 'cfg', anchor: css('#cfg'), mutations: [{ kind: 'script', handler: 'cfg' }] },
    ], { settings: [{ key: 'greeting', type: 'text', default: 'hello' }, { key: 'limit', type: 'number', required: true }] }, { cfg: CFG });
    await inst.installAll(configured);
    // A cookie on the host api.fetch reaches: it must not be sent.
    await ctx.addCookies([{ name: 'sid', value: 'signed-in', url: `http://${FIXTURE_ALIAS}:${new URL(origin).port}` }]);
    const page = await ctx.newPage();
    await page.goto(`${origin}/settings-fixture`);
    const read = (): Promise<CfgView | null> => page.evaluate(() => {
      const t = document.querySelector('.fm-cfg')?.textContent;
      return t ? JSON.parse(t) as CfgView : null;
    });
    const first = await settle(read, (v) => v !== null, 15000);
    check('a handler reads its settings: the default, and undefined for an unset field', first?.greeting === 'hello' && first.limit === null
      && JSON.stringify(first.keys) === '["greeting","limit"]', first);
    check('api.fetch reads a site the extension has no access to (it allows cross-origin reads), without its cookie', first?.status === 200
      && typeof first.data === 'object' && first.data.answer === 42 && first.data.sawCookie === false, first);
    check('and refuses the page\'s own loopback host and the metadata endpoint', first?.blocked === true, first);

    const popup = await popupOf(ctx, extId);
    const card = popup.locator('#list .card', { has: popup.locator('.name', { hasText: 'Configured fixture' }) });
    check('the popup says the shim needs setup (a required setting has no value)', (await card.locator('.pill.warn').textContent()) === 'needs setup');
    const [settingsPage] = await Promise.all([ctx.waitForEvent('page'), card.locator('button', { hasText: 'settings' }).click()]);
    await settingsPage.waitForSelector('#field-limit');
    check('the settings page names the shim', ((await settingsPage.textContent('#title')) ?? '').startsWith('Configured fixture'));
    await settingsPage.fill('#field-limit', '7');
    await settingsPage.locator('#field-limit').dispatchEvent('change');
    await settingsPage.fill('#field-greeting', 'hi there');
    await settingsPage.locator('#field-greeting').dispatchEvent('change');
    const saved = await settle(() => settingsPage.$$eval('.status.ok', (s) => s.length), (n) => n === 2);
    check('each value is saved as it changes', saved === 2, saved);
    const after = await settle(read, (v) => v?.greeting === 'hi there' && v.limit === 7, 15000);
    check('the open page picks them up: the shim reboots and its handler reads the new values', after?.greeting === 'hi there' && after.limit === 7, after);
    await page.reload();
    const reloaded = await settle(read, (v) => v?.limit === 7, 15000);
    check('and they persist across a reload', reloaded?.greeting === 'hi there' && reloaded.limit === 7, reloaded);
    await popup.reload();
    await popup.waitForSelector('#mode:not(:empty)');
    const pillAfter = await popup.locator('#list .card', { has: popup.locator('.name', { hasText: 'Configured fixture' }) }).locator('.pill.warn').count();
    check('with the required value set, "needs setup" is gone', pillAfter === 0, pillAfter);
    await settingsPage.locator('.field', { has: settingsPage.locator('#field-greeting') }).locator('button', { hasText: 'reset to default' }).click();
    const reset = await settle(read, (v) => v?.greeting === 'hello', 15000);
    check('reset to default: the field reads its default again on the open page', reset?.greeting === 'hello' && reset.limit === 7, reset);
    await settingsPage.close();
    await popup.close();
    await page.close();
  }

  check('no page errors in the extension', errors.length === 0, errors);
  await ctx.close();
  closeServer();
  fs.rmSync(work, { recursive: true, force: true });

  console.log('');
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log(`all extension full-mode checks passed (${passes})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
