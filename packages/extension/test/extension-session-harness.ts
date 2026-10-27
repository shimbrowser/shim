// A session beside an installed shim: the built extension's PageHost
// (src/page-host.ts) previewing rules of a shim that runs committed on the
// same page. The two forms of one rule never run side by side: the
// committed one is held before its preview goes up and comes back only
// once the preview is gone, through a reboot of the shim (disabled and
// enabled again under the preview), a hold that arrives before the shim
// boots, and a committed rule the ladder had already swapped for a rebased
// form. The session ended from outside (Chrome's bar, the tab closed) is
// cleaned up: previews dropped, held rules back, the host closed. Full
// mode, so the committed rules can be script rules with observers, the
// case a twin pair makes a page hang.
//
//   npx playwright install chromium
//   node out/packages/extension/test/extension-session-harness.js

import fs from 'fs';
import path from 'path';
import type { BrowserContext, Page } from 'playwright';
import type { PreviewRule } from '@shimbrowser/core/page-host';
import { workDir, extensionCopy, fixtureServer, shimWriter, css, launch, workerOf, installer, configureExtension, popupOf, settle, sleep } from './smoke-helpers';
import { proxyHost } from './host-proxy';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  const d = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !d ? '' : `  — ${d}`}`);
  if (!ok) failures++;
}

// The committed handler and the preview's: each stamps how often it ran,
// mounts its own span, and watches the anchor for the other's span: a twin
// seen at any moment, at mount or by the observer, is recorded on <html>.
const twin = (mine: string, other: string): string => `function ${mine}({ anchor, api }) {
  const html = document.documentElement;
  const runs = 'data-${mine}-runs';
  html.setAttribute(runs, String(Number(html.getAttribute(runs) || 0) + 1));
  const el = document.createElement('span');
  el.className = '${mine}';
  el.textContent = '${mine}';
  anchor.appendChild(el);
  const seen = () => { if (anchor.querySelector('.${other}')) html.setAttribute('data-twin-seen', '${mine}'); };
  seen();
  const mo = new MutationObserver(seen);
  mo.observe(anchor, { childList: true, subtree: true });
  api.cleanup(() => mo.disconnect());
  return el;
}`;
// The installed one is a module (the .shim file's handler form); a preview's inline handler is the expression itself.
const COMMITTED = `module.exports = ${twin('committed', 'preview')}`;
const PREVIEW = twin('preview', 'committed');

interface View { committed: number; preview: number; committedRuns: number; previewRuns: number; twinSeen: string | null }

async function main(): Promise<void> {
  console.log('\n=== extension session harness ===\n');
  const work = workDir('shim-extension-session-');
  const ext = extensionCopy(work, ['*://127.0.0.1/*']);
  const { origin, setDeploy, close: closeServer } = await fixtureServer();
  const shimFile = shimWriter(work);
  const SHIM_NAME = 'Session fixture';
  // The installed shim's id is minted at install; resolved once it is.
  let SHIM_ID = '';
  const fixture = shimFile('session-fixture', SHIM_NAME, [
    { id: 'badge', anchor: css('#note-target'), mutations: [{ kind: 'script', handler: 'committed' }] },
    { id: 'stable', anchor: css('#stable'), mutations: [{ kind: 'restyle', properties: { outline: '1px solid rgb(255, 0, 0)' } }] },
    { id: 'promote', anchor: { primary: { kind: 'css', value: 'button.buy-v1' }, fallbacks: [{ kind: 'css', value: 'button[data-sku="42"]' }] }, mutations: [{ kind: 'restyle', properties: { outline: '2px solid rgb(0, 0, 255)' } }] },
  ], {}, { committed: COMMITTED });

  const profile = path.join(work, 'profile');
  let ctx: BrowserContext = await launch(ext, profile);
  let { worker, extId } = await workerOf(ctx);
  if ((await configureExtension(ctx, extId, { userScriptsAccess: true })) !== 'ok') throw new Error('could not allow user scripts');
  await ctx.close();
  ctx = await launch(ext, profile);
  ({ worker, extId } = await workerOf(ctx));
  worker.on('console', (m) => { if (m.type() === 'error') console.error('  [worker]', m.text()); });
  check('full mode (user scripts allowed, relaunched)', await worker.evaluate(() => typeof chrome.userScripts === 'object'));

  const tabIdOf = async (page: Page): Promise<number> => {
    const url = page.url();
    const id = (await worker.evaluate((u) => chrome.tabs.query({ url: u }).then((t) => t[0]?.id ?? null), url));
    if (typeof id !== 'number') throw new Error(`no tab for ${url}`);
    return id;
  };
  const openHost = (tabId: number): Promise<string> => worker.evaluate((id) => (globalThis as unknown as { shimPageHosts: { open(tabId: number): Promise<string> } }).shimPageHosts.open(id), tabId);
  const closeHost = (hostId: string): Promise<boolean> => worker.evaluate((id) => (globalThis as unknown as { shimPageHosts: { close(id: string): Promise<boolean> } }).shimPageHosts.close(id), hostId);
  const detachForeign = (tabId: number): Promise<string> => worker.evaluate((id) => chrome.debugger.detach({ tabId: id }).then(() => 'ok', (e: unknown) => String(e)), tabId);
  const view = (page: Page): Promise<View> => page.evaluate(() => ({
    committed: document.querySelectorAll('#note-target .committed').length,
    preview: document.querySelectorAll('#note-target .preview').length,
    committedRuns: Number(document.documentElement.getAttribute('data-committed-runs') || 0),
    previewRuns: Number(document.documentElement.getAttribute('data-preview-runs') || 0),
    twinSeen: document.documentElement.getAttribute('data-twin-seen'),
  }));
  const previewOfBadge = (key = 'preview:session:badge'): PreviewRule => ({
    patchId: SHIM_ID, ruleKey: key,
    rule: { id: 'badge', anchor: { primary: { kind: 'css', value: '#note-target' } }, mutations: [{ kind: 'script', handler: 'preview' }], handlers: { preview: PREVIEW } },
  });
  const setEnabled = async (enabled: boolean): Promise<void> => {
    const popup = await popupOf(ctx, extId);
    await popup.evaluate(([id, on]) => chrome.runtime.sendMessage({ type: 'shims.setEnabled', id, enabled: on }), [SHIM_ID, enabled] as const);
    await popup.close();
  };
  const exported = async (): Promise<{ spec: { version?: number; bundleHash?: string } }> => {
    const popup = await popupOf(ctx, extId);
    const answer = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'shims.export', id }), SHIM_ID) as { file?: string };
    await popup.close();
    if (!answer.file) throw new Error('no export');
    return JSON.parse(answer.file) as { spec: { version?: number; bundleHash?: string } };
  };

  try {
    console.log('a session on a page with no runtime, ended from outside:');
    {
      const page = await ctx.newPage();
      await page.goto(`${origin}/apply`);
      const tabId = await tabIdOf(page);
      const hostId = await openHost(tabId);
      const host = proxyHost(worker, hostId);
      host.applyPreview({ patchId: 'session-probe', ruleKey: 'preview:probe:ad', rule: { id: 'ad', anchor: css('#ad'), mutations: [{ kind: 'hide' }] } });
      const hidden = await settle(() => page.evaluate(() => getComputedStyle(document.getElementById('ad') as Element).display), (d) => d === 'none');
      check('a preview applies with no shim installed', hidden === 'none');
      check('a second host on the same tab is refused', await openHost(tabId).then(() => false, () => true));
      check('detaching the debugger from outside the host answers ok', (await detachForeign(tabId)) === 'ok');
      const closed = await settle(() => Promise.resolve(host.isClosed()), (c) => c);
      check('the host reports closed', closed);
      const shown = await settle(() => page.evaluate(() => getComputedStyle(document.getElementById('ad') as Element).display), (d) => d !== 'none', 15000);
      check('the preview is dropped by the page itself once the host stops answering (no runtime to tell it)', shown !== 'none', shown);
      check('a call on the closed host fails in its own shape', await host.evaluate('1', 'main').then(() => false, (e: unknown) => e instanceof Error && e.message.includes('closed')));
      await host.stop();
      check('closing the closed host answers true', (await closeHost(hostId)) === true);
      await page.close();
    }

    const { installAll } = installer(ctx, extId);
    await installAll(fixture);
    {
      const popup = await popupOf(ctx, extId);
      const list = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'shims.list' })) as { shims: { id: string; name: string }[] };
      await popup.close();
      SHIM_ID = list.shims.find((s) => s.name === SHIM_NAME)?.id ?? '';
      check('the installed shim has its minted id', SHIM_ID.startsWith('shim-'), SHIM_ID);
    }

    console.log('the committed twin is held before the preview and back after it, never beside it:');
    const page = await ctx.newPage();
    await page.goto(`${origin}/apply`);
    const tabId = await tabIdOf(page);
    let hostId = await openHost(tabId);
    let host = proxyHost(worker, hostId);
    const heldFor = (): Promise<unknown> => worker.evaluate(([id, shim]) => (globalThis as unknown as { shimPageHosts: { call(id: string, m: string, a: unknown[]): Promise<unknown> } }).shimPageHosts.call(id, 'heldFor', [shim]), [hostId, SHIM_ID] as const);
    const pageLog: string[] = [];
    host.onConsole((m) => { pageLog.push(`${m.level}${m.engineWorld ? ' (engine)' : ''}: ${m.message}`); });
    host.onRuntimeEvent((e) => { pageLog.push(`event ${e.kind} ${JSON.stringify(e)}`); });
    {
      check('the session has its engine world beside the committed runtime', (await host.evaluate('typeof ShimCore.run', 'engine').catch((e: unknown) => String(e))) === 'function');
      const v0 = await settle(() => view(page), (v) => v.committed === 1);
      check('the committed rule runs before the session touches it', v0.committed === 1 && v0.committedRuns === 1 && v0.preview === 0, v0);
      for (let round = 1; round <= 3; round++) {
        host.applyPreview(previewOfBadge());
        const up = await settle(() => view(page), (v) => v.preview === 1 && v.committed === 0);
        check(`round ${round}: the preview is up and the committed twin is down`, up.preview === 1 && up.committed === 0 && up.previewRuns === round, up);
        if (up.preview !== 1) console.log(pageLog.join('\n'));
        host.removePreview('preview:session:badge');
        const back = await settle(() => view(page), (v) => v.committed === 1 && v.preview === 0);
        check(`round ${round}: the preview is gone and the committed twin is back`, back.committed === 1 && back.preview === 0 && back.committedRuns === round + 1, back);
      }
      const after = await view(page);
      check('neither twin ever saw the other (at mount or by observer)', after.twinSeen === null, after);
      check('the host lists the held rules by shim (none now)', JSON.stringify(await heldFor()) === '[]');
    }

    console.log('the hold survives the shim disabled and enabled again under the preview:');
    {
      host.applyPreview(previewOfBadge());
      await settle(() => view(page), (v) => v.preview === 1 && v.committed === 0);
      check('the held rule is listed', JSON.stringify(await heldFor()) === '["badge"]');
      const runsBefore = (await view(page)).committedRuns;
      await setEnabled(false);
      await sleep(600);
      const off = await view(page);
      check('disabled: the preview stays, the committed stays down', off.preview === 1 && off.committed === 0, off);
      await setEnabled(true);
      await sleep(1200);
      const on = await view(page);
      check('enabled again: the shim boots with the hold, the committed twin stays down', on.preview === 1 && on.committed === 0 && on.committedRuns === runsBefore && on.twinSeen === null, on);
      host.removePreview('preview:session:badge');
      const back = await settle(() => view(page), (v) => v.committed === 1 && v.preview === 0);
      check('released: the committed twin is back once', back.committed === 1 && back.committedRuns === runsBefore + 1 && back.twinSeen === null, back);
    }

    console.log('a hold that arrives before the shim boots on the document:');
    {
      await setEnabled(false);
      await settle(() => view(page), (v) => v.committed === 0);
      const loaded = host.waitForLoad({ timeoutMs: 10000 });
      host.reload(`${origin}/apply`);
      check('reloaded with the shim disabled', (await loaded).kind === 'finished');
      host.applyPreview(previewOfBadge());
      const up = await settle(() => view(page), (v) => v.preview === 1);
      check('the preview is up on the fresh document, nothing committed', up.preview === 1 && up.committed === 0 && up.committedRuns === 0, up);
      await setEnabled(true);
      await sleep(1500);
      const booted = await view(page);
      check('the shim, booting under the hold, never ran its held rule', booted.preview === 1 && booted.committed === 0 && booted.committedRuns === 0 && booted.twinSeen === null, booted);
      host.removePreview('preview:session:badge');
      const back = await settle(() => view(page), (v) => v.committed === 1 && v.preview === 0);
      check('released: the committed rule runs for the first time on this document', back.committedRuns === 1 && back.twinSeen === null, back);
    }

    console.log('a committed rule the ladder already swapped for its rebased form:');
    {
      setDeploy(1);
      const loaded = host.waitForLoad({ timeoutMs: 10000 });
      host.reload(`${origin}/deploy`);
      check('build 1 of /deploy loaded', (await loaded).kind === 'finished');
      const buyOutline = (): Promise<string> => page.evaluate(() => { const b = document.querySelector('button[data-sku="42"]'); return b ? getComputedStyle(b).outlineColor : 'none'; });
      check('build 1: the committed rule applies', (await settle(buyOutline, (c) => c === 'rgb(0, 0, 255)')) === 'rgb(0, 0, 255)');
      await settle(exported, (f) => typeof f.spec.bundleHash === 'string', 10000);
      setDeploy(2);
      const loaded2 = host.waitForLoad({ timeoutMs: 10000 });
      host.reload(`${origin}/deploy`);
      check('build 2 loaded', (await loaded2).kind === 'finished');
      const healed = await settle(exported, (f) => (f.spec.version ?? 1) >= 2, 15000);
      check('the ladder promoted the fallback: a new version', (healed.spec.version ?? 1) >= 2, healed.spec.version);
      await sleep(800);
      check('the rebased form runs on the page (swapped in as an extra)', (await settle(buyOutline, (c) => c === 'rgb(0, 0, 255)')) === 'rgb(0, 0, 255)');
      host.applyPreview({
        patchId: SHIM_ID, ruleKey: 'preview:session:promote',
        rule: { id: 'promote', anchor: { primary: { kind: 'css', value: 'button[data-sku="42"]' } }, mutations: [{ kind: 'restyle', properties: { outline: '3px solid rgb(0, 128, 0)' } }] },
      });
      const previewed = await settle(buyOutline, (c) => c === 'rgb(0, 128, 0)');
      check('previewing that rule takes the rebased extra down and shows the preview', previewed === 'rgb(0, 128, 0)', previewed);
      host.removePreview('preview:session:promote');
      const restored = await settle(buyOutline, (c) => c === 'rgb(0, 0, 255)');
      check('releasing it brings the rebased form back, not the stale declaration', restored === 'rgb(0, 0, 255)', restored);
    }

    console.log('the session ended from outside with a hold in place:');
    {
      const loaded = host.waitForLoad({ timeoutMs: 10000 });
      host.reload(`${origin}/apply`);
      await loaded;
      await settle(() => view(page), (v) => v.committed === 1);
      host.applyPreview(previewOfBadge());
      await settle(() => view(page), (v) => v.preview === 1 && v.committed === 0);
      check('detached from outside', (await detachForeign(tabId)) === 'ok');
      const back = await settle(() => view(page), (v) => v.committed === 1 && v.preview === 0, 15000);
      check('the preview is dropped and the committed twin is back, in that order', back.committed === 1 && back.preview === 0 && back.twinSeen === null, back);
      check('the host reports closed', await settle(() => Promise.resolve(host.isClosed()), (c) => c));
      await host.stop();
      check('closing it answers true', (await closeHost(hostId)) === true);
      const reopened = await openHost(tabId);
      check('a new session can take the tab', typeof reopened === 'string');
      hostId = reopened;
      host = proxyHost(worker, hostId);
      host.applyPreview(previewOfBadge());
      const again = await settle(() => view(page), (v) => v.preview === 1 && v.committed === 0);
      check('and hold the rule again', again.preview === 1 && again.committed === 0 && again.twinSeen === null, again);
      await host.stop();
      check('a normal close gives the rule back', (await closeHost(hostId)) === true && (await settle(() => view(page), (v) => v.committed === 1 && v.preview === 0)).twinSeen === null);
    }

    console.log('the tab closed under a session:');
    {
      const other = await ctx.newPage();
      await other.goto(`${origin}/apply`);
      const otherTab = await tabIdOf(other);
      const id = await openHost(otherTab);
      const h = proxyHost(worker, id);
      h.applyPreview(previewOfBadge());
      await settle(() => view(other), (v) => v.preview === 1);
      // Closed the way a user closes it (Playwright's page.close leaves a tab
      // with a debugger attached in place).
      await worker.evaluate((t) => chrome.tabs.remove(t), otherTab);
      const closedCall = (): Promise<unknown> => worker.evaluate((hid) => (globalThis as unknown as { shimPageHosts: { call(id: string, m: string, a: unknown[]): Promise<unknown> } }).shimPageHosts.call(hid, 'isClosed', []), id);
      const gone = await settle(closedCall, (c) => c === true, 12000).catch(() => false);
      check('the host reports closed once the tab is gone', gone === true, { direct: gone, proxied: h.isClosed(), tab: await worker.evaluate((t) => chrome.tabs.get(t).then(() => 'still there', () => 'gone'), otherTab) });
      await h.stop();
      check('closing it answers true', (await closeHost(id)) === true);
    }
    await page.close();
  } finally {
    await ctx.close();
    closeServer();
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log('');
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log('all extension session checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
