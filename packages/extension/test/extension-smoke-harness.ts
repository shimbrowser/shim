// The built extension (packages/extension/dist) in a real Chromium, through
// the real worker and content-script path: install a .shim through the
// install page, the registration, the declarative rules and the spec
// stylesheet on the conformance fixture (apply and strict-CSP pages),
// cross-shim priority, live changes on open pages (install, disable, enable,
// remove without a reload), site access withheld and granted back from
// chrome://extensions with the page open, removal of everything, and a
// refusal. It is the real-browser gate for what
// EXTENSION_DECLARATIVE_CAPABILITIES advertises until the extension has a
// PageHost and runs the shared conformance suite; full mode has its own
// harness (extension-full-mode-harness.ts) on the same helpers.
//
// Chrome's optional-host-permission prompt is browser UI a script cannot
// click, so the extension is loaded from a copy of dist/ whose manifest
// grants the fixture host up front; everything else is the shipped code.
// Site access is then withheld and granted back the way a user does it on
// chrome://extensions (the WebUI's own developerPrivate API), which fires
// the same permissions.onRemoved / onAdded the extension listens to.
//
//   npx playwright install chromium   (full Chromium: extensions need it)
//   node out/packages/extension/test/extension-smoke-harness.js

import fs from 'fs';
import path from 'path';
import type { BrowserContext } from 'playwright';
import {
  workDir, extensionCopy, fixtureServer, shimWriter, css, launch, workerOf, installer, configureExtension, setExtensionEnabled, sleep,
} from './smoke-helpers';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { passes++; console.log(`  ✓ ${label}`); return; }
  failures++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
}

interface Styles { ad: string; lead: string; injected: number; grid: string; html: string }
interface StrictStyles { ad: string; target: string }

async function main(): Promise<void> {
  console.log('\n=== extension smoke harness ===\n');
  const work = workDir('shim-extension-smoke-');
  const ext = extensionCopy(work, ['*://127.0.0.1/*']);
  const { origin, close: closeServer } = await fixtureServer();
  const shimFile = shimWriter(work);

  const tidy = shimFile('tidy', 'Tidy fixture', [
    { id: 'hide-ad', anchor: css('#ad'), mutations: [{ kind: 'hide' }] },
    { id: 'red-lead', anchor: css('#lead'), mutations: [{ kind: 'restyle', properties: { color: 'rgb(255, 0, 0)' } }] },
    { id: 'inject', anchor: css('#inject-target'), mutations: [{ kind: 'inject-html', placement: 'after', html: '<span class="smoke-injected">injected</span>' }] },
  ], { css: '#grid { outline: 3px solid rgb(0, 128, 0) }' });
  const second = shimFile('second', 'Second fixture', [
    { id: 'blue-lead', anchor: css('#lead'), mutations: [{ kind: 'restyle', properties: { color: 'rgb(0, 0, 255)' } }] },
    { id: 'hide-html', anchor: css('#html-target'), mutations: [{ kind: 'hide' }] },
  ]);
  const strict = shimFile('strict', 'Strict fixture', [
    { id: 'hide-strict-ad', anchor: css('#strict-ad'), mutations: [{ kind: 'hide' }] },
    { id: 'red-strict', anchor: css('#strict-target'), mutations: [{ kind: 'restyle', properties: { color: 'rgb(255, 0, 0)' } }] },
  ]);
  const scripted = shimFile('scripted', 'Scripted', [
    { id: 'badge', anchor: css('body'), mutations: [{ kind: 'script', handler: 'badge' }] },
  ], {}, { badge: 'module.exports = function badge() { return null; };' });

  const profile = path.join(work, 'profile');
  const ctx: BrowserContext = await launch(ext, profile);
  const errors: string[] = [];
  ctx.on('weberror', (e) => errors.push(String(e.error())));
  // `worker` is reassigned when the extension is disabled and enabled again (a fresh instance, a fresh handle).
  let { worker } = await workerOf(ctx);
  const { extId } = await workerOf(ctx);
  const registered = () => worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  const { install, installAll } = installer(ctx, extId);

  const fixture = await ctx.newPage();
  const styles = (): Promise<Styles> => fixture.evaluate(() => {
    const el = (id: string) => document.getElementById(id);
    return {
      ad: getComputedStyle(el('ad') as Element).display,
      lead: getComputedStyle(el('lead') as Element).color,
      injected: document.querySelectorAll('.smoke-injected').length,
      grid: getComputedStyle(el('grid') as Element).outlineColor,
      html: getComputedStyle(el('html-target') as Element).display,
    };
  });
  const settled = async (want: (s: Styles) => boolean): Promise<Styles> => {
    const deadline = Date.now() + 8000;
    let s = await styles();
    while (Date.now() < deadline && !want(s)) { await sleep(150); s = await styles(); }
    return s;
  };

  console.log('install through the page:');
  {
    const { page, heading } = await install(tidy);
    check('the review is ready', heading.startsWith('ready to install'), heading);
    const facts = await page.$$eval('#review dl dd', (dd) => dd.map((d) => d.textContent));
    check('and names the shim, its site and its rules', facts[0] === 'Tidy fixture' && facts[1] === '127.0.0.1' && (facts[2] ?? '').startsWith('3 (hide, restyle, inject-html)'), facts);
    await page.click('#review button.primary');
    await page.waitForSelector('#result:not([hidden]) h2', { timeout: 15000 });
    check('installed', (await page.textContent('#result h2')) === 'Tidy fixture is installed');
    await page.close();
    const regs = await registered();
    check('one content script, for the shim\'s host, engine then runtime at document_start',
      regs.length === 1 && (regs[0]?.id ?? '').startsWith('shim:') && JSON.stringify(regs[0]?.matches) === '["*://127.0.0.1/*"]'
        && JSON.stringify(regs[0]?.js) === '["shim-core.page.js","content.js"]' && regs[0]?.runAt === 'document_start', regs);
  }

  console.log('the install page with its own script delayed past the sandbox:');
  {
    // The sandboxed check frame can finish before install.js runs and its
    // one unsolicited readiness message be lost; the page then asks.
    const page = await ctx.newPage();
    await page.route('**/install.js', async (route) => { await sleep(1500); await route.continue(); });
    await page.goto(`chrome-extension://${extId}/install.html`);
    await page.setInputFiles('#file', second);
    await page.waitForSelector('#review:not([hidden]) h2', { timeout: 15000 });
    const heading = (await page.textContent('#review h2')) ?? '';
    check('the review still arrives (readiness asked for, not waited on)', heading.startsWith('ready to install'), heading);
    await page.close();
  }

  console.log('the declarative kinds and the spec stylesheet on /apply:');
  {
    await fixture.goto(`${origin}/apply`);
    const s = await settled((s) => s.ad === 'none' && s.lead === 'rgb(255, 0, 0)' && s.injected === 1 && s.grid === 'rgb(0, 128, 0)');
    check('hide', s.ad === 'none', s);
    check('restyle', s.lead === 'rgb(255, 0, 0)', s);
    check('inject-html', s.injected === 1, s);
    check('spec.css', s.grid === 'rgb(0, 128, 0)', s);
    check('an element no rule names is untouched', s.html !== 'none', s);
  }

  console.log('a strict style-src CSP on /strict:');
  {
    await installAll(strict);
    const strictPage = await ctx.newPage();
    await strictPage.goto(`${origin}/strict`);
    const read = (): Promise<StrictStyles> => strictPage.evaluate(() => ({
      ad: getComputedStyle(document.getElementById('strict-ad') as Element).display,
      target: getComputedStyle(document.getElementById('strict-target') as Element).color,
    }));
    const deadline = Date.now() + 8000;
    let s = await read();
    while (Date.now() < deadline && !(s.ad === 'none' && s.target === 'rgb(255, 0, 0)')) { await sleep(150); s = await read(); }
    check('hide applies under style-src \'self\'', s.ad === 'none', s);
    check('restyle applies under style-src \'self\'', s.target === 'rgb(255, 0, 0)', s);
    await strictPage.close();
  }

  console.log('live changes on an open page:');
  {
    await fixture.goto(`${origin}/apply`);
    await settled((s) => s.ad === 'none');
    await installAll(second);
    const s1 = await settled((s) => s.html === 'none');
    check('a shim installed while the page is open applies without a reload', s1.html === 'none', s1);
    check('cross-shim priority: the earlier install wins the lead colour', s1.lead === 'rgb(255, 0, 0)', s1);
    check('three registrations', (await registered()).length === 3);

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#list .card .name');
    const names = await popup.$$eval('#list .card .name', (n) => n.map((x) => x.textContent));
    check('the popup lists the shims in install order', names.join('|') === 'Tidy fixture|Strict fixture|Second fixture', names);
    check('and names declarative mode', ((await popup.textContent('#mode')) ?? '').startsWith('declarative mode'));

    const toggle = (index: number) => popup.click(`#list .card:nth-child(${index + 1}) input[type=checkbox]`);
    await toggle(0);
    const s2 = await settled((s) => s.ad !== 'none' && s.lead === 'rgb(0, 0, 255)');
    check('disabling tears the shim down on the open page: hide gone', s2.ad !== 'none', s2);
    check('its stylesheet gone', s2.grid !== 'rgb(0, 128, 0)', s2);
    check('its injected node gone', s2.injected === 0, s2);
    check('and the other shim\'s restyle now shows', s2.lead === 'rgb(0, 0, 255)', s2);
    check('the registration is gone too', (await registered()).length === 2);

    await popup.waitForSelector('#list .card:nth-child(1) input[type=checkbox]:not(:checked)');
    await toggle(0);
    const s3 = await settled((s) => s.ad === 'none' && s.lead === 'rgb(255, 0, 0)');
    check('re-enabling starts it again on the open page', s3.ad === 'none' && s3.injected === 1 && s3.grid === 'rgb(0, 128, 0)', s3);
    check('with its priority over the later shim intact', s3.lead === 'rgb(255, 0, 0)', s3);
    check('registered again', (await registered()).length === 3);

    const remove = async (index: number) => {
      const selector = `#list .card:nth-child(${index + 1}) button.danger`;
      await popup.click(selector);
      check('remove asks once', (await popup.textContent(selector)) === 'really remove?');
      await popup.click(selector);
    };
    await remove(2);
    await popup.waitForFunction(() => document.querySelectorAll('#list .card').length === 2);
    const s4 = await settled((s) => s.html !== 'none');
    check('removing tears the shim down on the open page', s4.html !== 'none' && s4.ad === 'none', s4);
    await remove(0);
    await popup.waitForFunction(() => document.querySelectorAll('#list .card').length === 1);
    await remove(0);
    await popup.waitForSelector('#empty:not([hidden])');
    const s5 = await settled((s) => s.ad !== 'none' && s.injected === 0);
    check('the page is untouched once every shim is gone', s5.ad !== 'none' && s5.lead !== 'rgb(255, 0, 0)' && s5.injected === 0 && s5.grid !== 'rgb(0, 128, 0)', s5);
    check('nothing registered', (await registered()).length === 0);
    const stored = await worker.evaluate(() => new Promise<{ shims: number; userData: number }>((resolve, reject) => {
      const open = indexedDB.open('shim-for-chrome');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction(['shims', 'user_data'], 'readonly');
        const a = tx.objectStore('shims').count();
        const b = tx.objectStore('user_data').count();
        tx.oncomplete = () => resolve({ shims: a.result, userData: b.result });
      };
    }));
    check('the store is empty', stored.shims === 0 && stored.userData === 0, stored);
    await popup.close();
  }

  console.log('cross-shim priority on an open page, two installs without a reload between them:');
  {
    await fixture.goto(`${origin}/apply`);
    await installAll(tidy);
    const a = await settled((s) => s.lead === 'rgb(255, 0, 0)');
    check('the first install applies live', a.lead === 'rgb(255, 0, 0)', a);
    await installAll(second);
    const b = await settled((s) => s.html === 'none');
    check('the second applies live', b.html === 'none', b);
    check('and the earlier install still wins the conflict (its priority did not move)', b.lead === 'rgb(255, 0, 0)', b);
    await fixture.reload();
    const c = await settled((s) => s.html === 'none' && s.lead === 'rgb(255, 0, 0)');
    check('after a reload the same shim wins', c.lead === 'rgb(255, 0, 0)' && c.html === 'none', c);
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#list .card');
    for (let left = 2; left > 0; left--) {
      await popup.click('#list .card:first-child button.danger');
      await popup.click('#list .card:first-child button.danger');
      await popup.waitForFunction((n) => document.querySelectorAll('#list .card').length === n, left - 1);
    }
    await popup.close();
    check('both removed again', (await registered()).length === 0);
  }

  console.log('site access revoked and restored (chrome://extensions), with the page open:');
  {
    // The user's own route: the extension's site access set to "on click"
    // withholds every host (permissions.onRemoved), "on all sites" grants
    // them back (permissions.onAdded). The WebUI's developerPrivate API is
    // what the chrome://extensions page itself calls.
    const hostAccess = (value: string) => configureExtension(ctx, extId, { hostAccess: value });
    const granted = () => worker.evaluate(() => chrome.permissions.contains({ origins: ['*://127.0.0.1/*'] }));

    await fixture.goto(`${origin}/apply`);
    await installAll(tidy);
    const s0 = await settled((s) => s.ad === 'none');
    check('the shim applies', s0.ad === 'none', s0);
    check('withholding site access answers ok', (await hostAccess('ON_CLICK')) === 'ok');
    const s1 = await settled((s) => s.ad !== 'none' && s.injected === 0);
    check('access gone: the extension no longer holds the host', (await granted()) === false);
    check('access gone: the open page is torn down without a reload', s1.ad !== 'none' && s1.injected === 0 && s1.grid !== 'rgb(0, 128, 0)', s1);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await registered()).length !== 0) await sleep(100);
    check('access gone: nothing registered', (await registered()).length === 0);

    // Access back with the shim enabled throughout and the same worker alive:
    // the registration and the open page's rules return from the grant alone.
    check('granting access back (shim still enabled) answers ok', (await hostAccess('ON_ALL_SITES')) === 'ok');
    const dBack = Date.now() + 5000;
    while (Date.now() < dBack && (await registered()).length !== 1) await sleep(100);
    check('access back: the registration returns from the grant alone', (await registered()).length === 1);
    const sBack = await settled((s) => s.ad === 'none' && s.injected === 1);
    check('access back: the open page applies again without a reload, from the grant alone', sBack.ad === 'none' && sBack.injected === 1 && sBack.grid === 'rgb(0, 128, 0)', sBack);
    await fixture.goto(`${origin}/apply`);
    const sFresh = await settled((s) => s.ad === 'none' && s.injected === 1);
    check('access back: a fresh load applies', sFresh.ad === 'none' && sFresh.injected === 1, sFresh);

    // Withheld again, for the disabled-shim case.
    check('withholding again answers ok', (await hostAccess('ON_CLICK')) === 'ok');
    await settled((s) => s.ad !== 'none' && s.injected === 0);
    const dGone = Date.now() + 5000;
    while (Date.now() < dGone && (await registered()).length !== 0) await sleep(100);
    check('withheld again: torn down and unregistered', (await registered()).length === 0 && (await styles()).ad !== 'none');
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#list .card input[type=checkbox]:checked');
    check('the shim stays installed and enabled', (await popup.$$eval('#list .card .name', (n) => n.length)) === 1);
    await popup.click('#list .card input[type=checkbox]');
    await popup.waitForSelector('#list .card input[type=checkbox]:not(:checked)');
    check('it can still be disabled while access is withheld', true);
    check('granting access back answers ok', (await hostAccess('ON_ALL_SITES')) === 'ok');
    const d2 = Date.now() + 5000;
    while (Date.now() < d2 && !(await granted())) await sleep(100);
    check('access back: the extension holds the host again', (await granted()) === true);
    await sleep(500);
    const s2 = await styles();
    check('access back, still disabled: the page stays untouched and nothing is registered', s2.ad !== 'none' && (await registered()).length === 0, s2);
    await popup.click('#list .card input[type=checkbox]');
    const s3 = await settled((s) => s.ad === 'none' && s.injected === 1);
    check('enabled again: the open page applies without a reload', s3.ad === 'none' && s3.injected === 1 && s3.grid === 'rgb(0, 128, 0)', s3);
    check('and the registration is back', (await registered()).length === 1);
    await hostAccess('ON_CLICK');
    await settled((s) => s.ad !== 'none');
    await popup.click('#list .card button.danger');
    await popup.click('#list .card button.danger');
    await popup.waitForSelector('#empty:not([hidden])');
    check('removing while access is withheld works', (await registered()).length === 0);
    await hostAccess('ON_ALL_SITES');
    await popup.close();
  }

  console.log('the extension disabled and enabled again under an open page:');
  {
    await fixture.goto(`${origin}/apply`);
    await installAll(tidy);
    const s0 = await settled((s) => s.ad === 'none' && s.injected === 1);
    check('the shim applies', s0.ad === 'none' && s0.injected === 1, s0);
    const fresh = ctx.waitForEvent('serviceworker', { timeout: 15000 });
    check('disabling answers ok', (await setExtensionEnabled(ctx, extId, false)) === 'ok');
    const s1 = await settled((s) => s.ad !== 'none' && s.injected === 0);
    check('the orphaned runtime tears the shim down: hide, injected node and stylesheet gone', s1.ad !== 'none' && s1.injected === 0 && s1.grid !== 'rgb(0, 128, 0)', s1);
    check('enabling answers ok', (await setExtensionEnabled(ctx, extId, true)) === 'ok');
    worker = await fresh;
    const s2 = await settled((s) => s.ad === 'none' && s.injected === 1);
    check('the new instance takes the open page over without a reload', s2.ad === 'none' && s2.injected === 1 && s2.grid === 'rgb(0, 128, 0)', s2);
    check('one registration in the new instance', (await registered()).length === 1);

    // Disabled and enabled back to back: the old runtime's teardown and the
    // new instance's injection overlap in time, and the new engine must end
    // up with its own stylesheet, not one the old teardown removes.
    const fresh2 = ctx.waitForEvent('serviceworker', { timeout: 15000 });
    await setExtensionEnabled(ctx, extId, false);
    check('enabling again at once answers ok', (await setExtensionEnabled(ctx, extId, true)) === 'ok');
    worker = await fresh2;
    const s3 = await settled((s) => s.ad === 'none' && s.injected === 1 && s.grid === 'rgb(0, 128, 0)');
    await sleep(1500);
    const s4 = await styles();
    check('after a prompt re-enable the page carries the shim and its stylesheet, and keeps them', s3.grid === 'rgb(0, 128, 0)' && s4.ad === 'none' && s4.injected === 1 && s4.grid === 'rgb(0, 128, 0)', { s3, s4 });
    const sheets = await fixture.evaluate(() => document.querySelectorAll('style[data-shim^="patch-"]').length);
    check('one spec stylesheet in the document', sheets === 1, sheets);
    const marks = await fixture.evaluate(() => document.documentElement.getAttribute('data-shim-runtime'));
    check('the document carries the live runtime\'s mark', typeof marks === 'string' && marks.length > 0, marks);

    // A predecessor still tearing down holds the document: a runtime that
    // is new to the document waits for its mark to go before it boots. The
    // page is loaded with nothing registered, so enabling the shim injects
    // a fresh runtime into it (an existing one would only sync again).
    const popup0 = await ctx.newPage();
    await popup0.goto(`chrome-extension://${extId}/popup.html`);
    await popup0.waitForSelector('#list .card input[type=checkbox]:checked');
    await popup0.click('#list .card input[type=checkbox]');
    await popup0.waitForSelector('#list .card input[type=checkbox]:not(:checked)');
    const dOff = Date.now() + 5000;
    while (Date.now() < dOff && (await registered()).length !== 0) await sleep(100);
    await fixture.goto(`${origin}/apply`);
    await sleep(300);
    check('a page loaded with nothing registered has no runtime', (await styles()).ad !== 'none' && (await fixture.evaluate(() => document.documentElement.getAttribute('data-shim-runtime'))) === null);
    await fixture.evaluate(() => document.documentElement.setAttribute('data-shim-runtime', 'lingering-predecessor'));
    await popup0.click('#list .card input[type=checkbox]');
    await sleep(700);
    const held = await styles();
    check('while a predecessor\'s mark is on the document, the runtime waits', held.ad !== 'none', held);
    await fixture.evaluate(() => document.documentElement.removeAttribute('data-shim-runtime'));
    const released = await settled((s) => s.ad === 'none' && s.injected === 1);
    check('and boots once the mark is gone', released.ad === 'none' && released.injected === 1, released);
    await popup0.close();
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#list .card button.danger');
    await popup.click('#list .card button.danger');
    await popup.click('#list .card button.danger');
    await popup.waitForSelector('#empty:not([hidden])');
    await popup.close();
    await settled((s) => s.ad !== 'none');
  }

  console.log('a refusal:');
  {
    const { page, heading } = await install(scripted);
    check('a script rule is refused in declarative mode', heading.startsWith('cannot install'), heading);
    const problems = await page.$$eval('#review ul.problems li', (li) => li.map((x) => x.textContent ?? ''));
    check('naming the rule and user scripts', problems.some((t) => t.includes('"script"')) && problems.some((t) => t.includes('user scripts')), problems);
    await page.close();
  }

  check('no page errors in the extension', errors.length === 0, errors);
  await ctx.close();
  closeServer();
  fs.rmSync(work, { recursive: true, force: true });

  console.log('');
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log(`all extension smoke checks passed (${passes})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
