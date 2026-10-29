// Vault shims in their own worlds (vault.ts, vault-sync.ts, the worker's
// principals), in the built extension in a real Chromium with user scripts
// allowed. No secret is installable on Chrome yet, so shims are
// given worlds through the worker's harness flag, which still preflights them.
//
// Covers: the registrations (the default world's leave vault shims out; each
// vault shim gets `shimv:` in its own world), JS isolation between the default
// world and two vault worlds, a malicious default-world script that cannot
// read or forge a vault shim's storage, settings, fetch, events, bundle or
// port, a vault token that answers only for its own shim, a forged token and
// a silent port refused, fresh-document-only boot (a vault world is never
// injected into an open page; it comes with the next load), token rotation
// (the old document's world torn down, the old token refused, the next load
// back), disable and enable, admission refusing the 9th overlapping vault
// shim (named in the popup), and an interrupted reconcile recovered fail
// closed (no vault shim runs while the accounting is unknown).
//
//   npx playwright install chromium   (full Chromium: extensions need it)
//   node out/packages/extension/test/extension-vault-worlds-harness.js

import path from 'path';
import type { BrowserContext, Page } from 'playwright';
import type { PreviewRule } from '@shimbrowser/core/page-host';
import { workDir, extensionCopy, fixtureServer, shimWriter, css, launch, workerOf, installer, configureExtension, popupOf, settle, sleep } from './smoke-helpers';
import { proxyHost } from './host-proxy';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { passes++; console.log(`  ✓ ${label}`); return; }
  failures++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
}

/** A handler that stores its tag, plants a world global, and mounts a badge saying what it read back. */
function badgeHandler(tag: string): string {
  return `module.exports = async function badge({ anchor, api }) {
  globalThis.__vaultMark = ${JSON.stringify(tag)};
  await api.storage.set('k', ${JSON.stringify(tag)});
  const read = await api.storage.get('k');
  const el = document.createElement('span');
  el.className = 'vw-badge vw-' + ${JSON.stringify(tag)};
  el.textContent = ${JSON.stringify(tag)} + ':' + String(read);
  anchor.appendChild(el);
  return el;
};`;
}

interface Summary { id: string; name: string; vault?: { overlapping: string[] | null } }

async function main(): Promise<void> {
  console.log('\n=== extension vault worlds harness ===\n');
  const work = workDir('shim-extension-vault-');
  const ext = extensionCopy(work, ['*://127.0.0.1/*']);
  const { origin, close: closeServer } = await fixtureServer();
  const shimFile = shimWriter(work);
  const fileFor = (tag: string): string => shimFile(`vw-${tag}`, `Vault ${tag}`, [
    { id: 'badge', anchor: css('#cfg'), mutations: [{ kind: 'script', handler: 'badge' }] },
  ], {}, { badge: badgeHandler(tag) });

  const profile = path.join(work, 'profile');
  let ctx: BrowserContext = await launch(ext, profile);
  let { worker, extId } = await workerOf(ctx);
  check('allowing user scripts answers ok', (await configureExtension(ctx, extId, { userScriptsAccess: true })) === 'ok');
  await ctx.close();
  ctx = await launch(ext, profile);
  ({ worker, extId } = await workerOf(ctx));
  const errors: string[] = [];
  ctx.on('weberror', (e) => errors.push(String(e.error())));

  const { installAll } = installer(ctx, extId);
  for (const tag of ['A', 'B', 'plain']) await installAll(fileFor(tag));

  const ask = async <T>(msg: unknown): Promise<T> => {
    const popup = await popupOf(ctx, extId);
    try { return await popup.evaluate((m) => chrome.runtime.sendMessage(m), msg) as T; } finally { await popup.close(); }
  };
  const list = async (): Promise<Summary[]> => (await ask<{ shims: Summary[] }>({ type: 'shims.list' })).shims;
  const idOf = async (name: string): Promise<string> => (await list()).find((s) => s.name === name)?.id ?? '';
  const A = await idOf('Vault A');
  const B = await idOf('Vault B');
  const PLAIN = await idOf('Vault plain');
  check('three shims installed', A !== '' && B !== '' && PLAIN !== '', { A, B, PLAIN });

  const hosts = <T>(fn: string, ...args: unknown[]): Promise<T> => worker.evaluate(([f, a]) => {
    const h = (globalThis as unknown as { shimPageHosts: Record<string, (...x: unknown[]) => unknown> }).shimPageHosts;
    return h[f as string]?.(...(a as unknown[])) as Promise<unknown>;
  }, [fn, args] as const) as Promise<T>;
  type VState = { phase: string; generations: Record<string, number>; refused: Record<string, string[]>; scripts: string[] };
  const vstate = (): Promise<VState> => hosts<VState>('vaultState');
  const userScripts = (): Promise<{ id: string; worldId?: string; js?: { file?: string; code?: string }[] }[]> => worker.evaluate(() => chrome.userScripts.getScripts());
  const badges = (page: Page): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('.vw-badge')].map((e) => e.textContent ?? ''));
  const tabIdOf = async (page: Page): Promise<number> => {
    const url = page.url();
    const ids = await worker.evaluate((u) => chrome.tabs.query({}).then((t) => t.filter((x) => x.url === u).map((x) => x.id)), url);
    return ids[ids.length - 1] ?? -1;
  };
  /** Code run in a world of the page: the default user-script world, or a named one. */
  const inWorld = async <T>(page: Page, code: string, worldId?: string): Promise<T> => {
    const tabId = await tabIdOf(page);
    const res = await worker.evaluate(async ([id, c, w]) => {
      const out = await chrome.userScripts.execute({ target: { tabId: id }, js: [{ code: c }], ...(w ? { worldId: w } : {}) } as chrome.userScripts.UserScriptInjection);
      return out.map((r) => r.result);
    }, [tabId, code, worldId ?? ''] as const);
    return res[0] as T;
  };
  const tokenOf = async (shimId: string): Promise<string> => {
    const scripts = await userScripts();
    const code = scripts.find((s) => s.id === `shimv:${shimId}`)?.js?.[0]?.code ?? '';
    return /"token":"([A-Za-z0-9_-]+)"/.exec(code)?.[1] ?? '';
  };
  const send = (page: Page, msg: Record<string, unknown>): Promise<{ ok: boolean; error?: string; shims?: { id: string }[]; value?: unknown }> =>
    inWorld(page, `chrome.runtime.sendMessage(${JSON.stringify(msg)})`);

  const p1 = await ctx.newPage();
  await p1.goto(`${origin}/settings-fixture`);
  console.log('before any vault world:');
  {
    const b = await settle(() => badges(p1), (x) => x.length === 3);
    check('all three shims run in the default world', b.length === 3, b);
  }

  console.log('two shims given worlds of their own:');
  await hosts('setVaultTestWorlds', [A, B]);
  {
    const s = await vstate();
    check('each has a registration at generation 1, idle', s.phase === 'idle' && s.generations[A] === 1 && s.generations[B] === 1, s);
    const regs = await userScripts();
    const vaultA = regs.find((r) => r.id === `shimv:${A}`);
    check('a vault registration runs in the shim\'s own world: one code entry (the engine, then the runtime)', vaultA?.worldId === `v-${A}` && vaultA.js?.length === 1 && typeof vaultA.js[0]?.code === 'string', vaultA?.worldId);
    check('the default world\'s registrations leave the vault shims out', regs.filter((r) => r.id.startsWith('shim:')).map((r) => r.id).join() === `shim:${PLAIN}`, regs.map((r) => r.id));
    const b = await settle(() => badges(p1), (x) => x.length === 1);
    check('on the page already open, the vault shims stop and are not injected (no world into an open document)', b.join() === 'plain:plain', b);
    const popup = await popupOf(ctx, extId);
    const note = (await popup.textContent('body')) ?? '';
    await popup.close();
    check('the popup says a vault shim\'s changes apply on reload', note.includes('Changes apply when you reload the page.'));
  }

  const p2 = await ctx.newPage();
  await p2.goto(`${origin}/settings-fixture`);
  console.log('a fresh document:');
  {
    const b = await settle(() => badges(p2), (x) => x.length === 3);
    check('all three run: the vault shims each in its own world', [...b].sort().join() === 'A:A,B:B,plain:plain', b);
    check('the default world sees neither vault world\'s globals', (await inWorld<string>(p2, 'String(globalThis.__vaultMark)')) === 'plain');
    check('vault A\'s world holds its own', (await inWorld<string>(p2, 'String(globalThis.__vaultMark)', `v-${A}`)) === 'A');
    check('vault B\'s world holds its own', (await inWorld<string>(p2, 'String(globalThis.__vaultMark)', `v-${B}`)) === 'B');
    check('a vault world\'s runtime takes no runtime mark (the default runtime keeps it)', (await p2.evaluate(() => document.documentElement.hasAttribute('data-shim-runtime'))));
  }

  console.log('a malicious default-world script:');
  {
    const storageA = await send(p2, { type: 'storage', method: 'get', shimId: A, key: 'k' });
    check('cannot read a vault shim\'s storage', storageA.ok === false && storageA.error === 'not a shim of this page', storageA);
    const setA = await send(p2, { type: 'storage', method: 'set', shimId: A, key: 'k', value: 'forged' });
    check('nor write it', setA.ok === false, setA);
    const settingsA = await send(p2, { type: 'settings', method: 'getAll', shimId: A });
    check('nor read its settings', settingsA.ok === false, settingsA);
    const fetchA = await send(p2, { type: 'fetch', shimId: A, url: `${origin}/fixture-data.json` });
    check('nor fetch as it', fetchA.ok === false, fetchA);
    const eventA = await send(p2, { type: 'event', shimId: A, kind: 'rule-status', payload: { ruleId: 'badge', matched: 1, path: '/' } });
    check('nor report its events', eventA.ok === false, eventA);
    const bundle = await send(p2, { type: 'bundle' });
    check('its bundle lists no vault shim (and so no vault handler source)', bundle.ok === true && (bundle.shims ?? []).map((x) => x.id).join() === PLAIN, bundle.shims?.map((x) => x.id));
    const plain = await send(p2, { type: 'storage', method: 'get', shimId: PLAIN, key: 'k' });
    check('control: the default world still reaches a default-world shim', plain.ok === true && plain.value === 'plain', plain);
    const forged = await send(p2, { type: 'storage', method: 'get', shimId: A, key: 'k', auth: 'x'.repeat(43) });
    check('a forged token is refused as stale, never read as the default world', forged.ok === false && forged.error === 'stale-token', forged);
    const forgedPlain = await send(p2, { type: 'storage', method: 'get', shimId: PLAIN, key: 'k', auth: 'x'.repeat(43) });
    check('even for a default-world shim', forgedPlain.ok === false && forgedPlain.error === 'stale-token', forgedPlain);
    const portForged = await inWorld<string>(p2, `new Promise((resolve) => {
      const port = chrome.runtime.connect({ name: 'shim-runtime' });
      const timer = setTimeout(() => resolve('open'), 2500);
      port.onMessage.addListener((m) => { clearTimeout(timer); resolve('heard:' + JSON.stringify(m)); });
      port.onDisconnect.addListener(() => { clearTimeout(timer); resolve('closed'); });
      port.postMessage({ type: 'auth', token: ${JSON.stringify('y'.repeat(43))} });
    })`);
    check('a port that offers a forged token is closed unanswered', portForged === 'closed', portForged);
    const portSilent = await inWorld<string>(p2, `new Promise((resolve) => {
      const port = chrome.runtime.connect({ name: 'shim-runtime' });
      port.onMessage.addListener((m) => resolve('heard:' + JSON.stringify(m)));
      port.onDisconnect.addListener(() => resolve('closed'));
      setTimeout(() => resolve('silent'), 4500);
    })`);
    check('a port that says nothing hears nothing and is closed', portSilent === 'closed', portSilent);
  }

  console.log('a vault token answers for its own shim only:');
  const tokenA1 = await tokenOf(A);
  {
    check('the token is in the registration (where only the extension reads it), 256 bits', tokenA1.length === 43);
    const own = await send(p2, { type: 'storage', method: 'get', shimId: A, key: 'k', auth: tokenA1 });
    check('A\'s token reads A\'s storage (a bearer token: it is the principal)', own.ok === true && own.value === 'A', own);
    const crossVault = await send(p2, { type: 'storage', method: 'get', shimId: B, key: 'k', auth: tokenA1 });
    check('but not B\'s', crossVault.ok === false, crossVault);
    const crossDefault = await send(p2, { type: 'storage', method: 'get', shimId: PLAIN, key: 'k', auth: tokenA1 });
    check('nor a default-world shim\'s', crossDefault.ok === false, crossDefault);
    const bundleA = await send(p2, { type: 'bundle', auth: tokenA1 });
    check('and its bundle is A alone', bundleA.ok === true && (bundleA.shims ?? []).map((x) => x.id).join() === A, bundleA.shims?.map((x) => x.id));
    const page = await send(p2, { type: 'shims.list', auth: tokenA1 });
    check('a vault token sends no page message', page.ok === false, page);
  }

  console.log('a session previewing a vault shim:');
  {
    // The preview's inline handler reads the shim's storage, then mounts what it read.
    const peek = `async function peek({ anchor, api }) {
  const read = await api.storage.get('k');
  await api.storage.set('k', 'session');
  const el = document.createElement('span');
  el.className = 'vw-peek';
  el.textContent = 'peek:' + String(read);
  anchor.appendChild(el);
  return el;
}`;
    const previewFor = (patchId: string, key: string): PreviewRule => ({
      patchId, ruleKey: key, rule: { id: 'badge', anchor: css('#cfg'), mutations: [{ kind: 'script', handler: 'peek' }], handlers: { peek } },
    });
    const tabId = await tabIdOf(p2);
    const hostId = await hosts<string>('open', tabId);
    const host = proxyHost(worker, hostId);
    const peeks = (): Promise<string[]> => p2.evaluate(() => [...document.querySelectorAll('.vw-peek')].map((e) => e.textContent ?? ''));
    host.applyPreview(previewFor(A, 'preview:vault:badge'));
    const up = await settle(async () => ({ peeks: await peeks(), badges: await badges(p2) }), (v) => v.peeks.length === 1 && !v.badges.includes('A:A'));
    check('the hold reaches the vault shim\'s own world: its committed rule goes down under the preview', up.peeks.length === 1 && !up.badges.includes('A:A') && up.badges.includes('B:B'), up);
    check('the preview reads the session\'s scratch storage, never the vault shim\'s saved rows', up.peeks[0] === 'peek:null', up.peeks);
    host.removePreview('preview:vault:badge');
    const down = await settle(() => badges(p2), (b) => b.includes('A:A'));
    check('removing the preview brings the committed rule back in its world', down.includes('A:A'), down);
    const own = await send(p2, { type: 'storage', method: 'get', shimId: A, key: 'k', auth: tokenA1 });
    check('and the vault shim\'s saved value is untouched by the preview\'s write', own.ok === true && own.value === 'A', own);
    host.applyPreview(previewFor(PLAIN, 'preview:plain:badge'));
    const plainUp = await settle(peeks, (v) => v.length === 1);
    check('control: a default-world shim\'s preview reads its saved rows', plainUp[0] === 'peek:plain', plainUp);
    host.removePreview('preview:plain:badge');
    await settle(() => badges(p2), (b) => b.includes('plain:plain'));
    await host.stop();
    await hosts('close', hostId);
  }

  console.log('rotation:');
  {
    await hosts('rotateVault', [A]);
    const s = await vstate();
    check('A moves to generation 2, B stays at 1', s.generations[A] === 2 && s.generations[B] === 1, s.generations);
    const b = await settle(() => badges(p2), (x) => !x.includes('A:A'));
    check('the open document\'s A world tears down (its token is stale); B and plain keep running', [...b].sort().join() === 'B:B,plain:plain', b);
    const old = await send(p2, { type: 'storage', method: 'get', shimId: A, key: 'k', auth: tokenA1 });
    check('the old token is refused as stale', old.ok === false && old.error === 'stale-token', old);
    const tokenA2 = await tokenOf(A);
    check('the new registration carries a new token', tokenA2.length === 43 && tokenA2 !== tokenA1);
    await p2.reload();
    const back = await settle(() => badges(p2), (x) => x.length === 3);
    check('the next load runs A again, with the new token', [...back].sort().join() === 'A:A,B:B,plain:plain', back);
  }

  console.log('disable and enable a vault shim:');
  {
    await ask({ type: 'shims.setEnabled', id: A, enabled: false });
    const off = await settle(() => badges(p2), (x) => !x.includes('A:A'));
    check('disabling tears it down on the open page', !off.includes('A:A'), off);
    check('and unregisters its world', !(await vstate()).scripts.includes(`shimv:${A}`));
    await ask({ type: 'shims.setEnabled', id: A, enabled: true });
    await sleep(1500);
    const still = await badges(p2);
    check('enabling does not inject it into the open page', !still.includes('A:A'), still);
    check('it is registered again under a new generation', ((await vstate()).generations[A] ?? 0) >= 3);
    await p2.reload();
    const back = await settle(() => badges(p2), (x) => x.includes('A:A'));
    check('the next load runs it', back.includes('A:A'), back);
  }

  console.log('admission at the per-page cap:');
  {
    const extra = ['C', 'D', 'E', 'F', 'G', 'H', 'I'];
    for (const tag of extra) await installAll(fileFor(tag));
    const ids: string[] = [A, B];
    for (const tag of extra) ids.push(await idOf(`Vault ${tag}`));
    await hosts('setVaultTestWorlds', ids);
    const s = await vstate();
    const last = ids[ids.length - 1] ?? '';
    check('8 vault shims on one host are registered', s.scripts.length === 8 && !s.scripts.includes(`shimv:${last}`), s.scripts.length);
    check('the 9th is refused, naming the 8 it overlaps', (s.refused[last] ?? []).length === 8 && (s.refused[last] ?? [])[0] === 'Vault A', s.refused);
    const summary = (await list()).find((x) => x.id === last);
    check('the popup is told why', summary?.vault?.overlapping?.length === 8, summary?.vault);
    const p3 = await ctx.newPage();
    await p3.goto(`${origin}/settings-fixture`);
    const b = await settle(() => badges(p3), (x) => x.length === 9);
    check('a page runs the 8 admitted vault shims and the default-world one, not the 9th', b.length === 9 && !b.includes('I:I'), b);
    await p3.close();
    await hosts('setVaultTestWorlds', [A, B]);
    for (const tag of extra) await ask({ type: 'shims.uninstall', id: await idOf(`Vault ${tag}`) });
    check('back to two vault registrations', (await vstate()).scripts.length === 2);
  }

  console.log('an interrupted reconcile:');
  {
    await p2.reload();
    await settle(() => badges(p2), (x) => x.length === 3);
    const tokenB = await tokenOf(B);
    const before = await vstate();
    await hosts('interruptVault');
    const live = await send(p2, { type: 'storage', method: 'get', shimId: B, key: 'k', auth: tokenB });
    check('while the accounting is unknown, no vault token is honored', live.ok === false && live.error === 'stale-token', live);
    const p4 = await ctx.newPage();
    await p4.goto(`${origin}/settings-fixture`);
    const during = await settle(() => badges(p4), (x) => x.includes('plain:plain'));
    await sleep(1000);
    const after = await badges(p4);
    check('a page loaded meanwhile runs no vault shim (fail closed), the default-world one still', during.includes('plain:plain') && !after.includes('A:A') && !after.includes('B:B'), after);
    await p4.close();
    await hosts('recoverVault');
    const s = await vstate();
    check('the next sync recovers: idle, every vault shim at a new generation', s.phase === 'idle' && (s.generations[A] ?? 0) > (before.generations[A] ?? 0) && (s.generations[B] ?? 0) > (before.generations[B] ?? 0), { before: before.generations, after: s.generations });
    const old = await send(p2, { type: 'storage', method: 'get', shimId: B, key: 'k', auth: tokenB });
    check('no token from before the interruption is honored', old.ok === false && old.error === 'stale-token', old);
    const torn = await settle(() => badges(p2), (x) => !x.includes('B:B'));
    check('the open document\'s vault worlds are torn down', !torn.includes('A:A') && !torn.includes('B:B'), torn);
    await p2.reload();
    const back = await settle(() => badges(p2), (x) => x.length === 3);
    check('the next load runs them again', [...back].sort().join() === 'A:A,B:B,plain:plain', back);
  }

  check('no page error along the way', errors.length === 0, errors);
  await ctx.close();
  closeServer();
}

main().then(() => {
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log(`\nall extension vault worlds checks passed (${passes})`);
}).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
