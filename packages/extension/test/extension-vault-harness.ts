// The secrets vault end to end in the built extension, in a real Chromium
// with user scripts allowed (the vault is on; the worker's test flag turns
// it off for the first check): a shim declaring two placed secrets
// installs; the settings page sets up the vault, approves a grant and
// seals a value; the shim's handler reads presence only and its api.fetch
// reaches an HTTPS service with the value placed exactly as declared, the
// echo redacted; lock (the popup) refuses, a wrong passphrase changes
// nothing, unlock (the popup) brings it back; a session on the tab refuses
// every secret while it holds the tab and for the document it touched,
// until a fresh load; a session holding the vault shim's rule keeps it held
// across the worker dropping its ports (idling) and the runtime
// re-authenticating; a stopped and woken worker still answers with the vault
// unlocked; revoking rotates the token; and a browser restart keeps the
// restored tab's vault world (no rotation on start) with the vault locked.
// Vault messages from a site or another extension page are refused.
//
//   npx playwright install chromium   (full Chromium: extensions need it)
//   node out/packages/extension/test/extension-vault-harness.js

import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';
import type { BrowserContext, Page, Worker } from 'playwright';
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

const API_HOST = 'api.vault-fixture.test';
const PASS = 'tavor-mikel-dusan-pobit-zelur';
const SECRET = 'sk-live-VAULT-1234567890';

/** An HTTPS service that echoes what it received (url, authorization) and records every request. */
async function apiServer(work: string): Promise<{ port: number; spki: string; seen: Array<{ url: string; auth: string | undefined }>; close(): void }> {
  const key = path.join(work, 'api-key.pem');
  const cert = path.join(work, 'api-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
    '-subj', `/CN=${API_HOST}`, '-addext', `subjectAltName=DNS:${API_HOST}`], { stdio: 'ignore' });
  const pem = fs.readFileSync(cert);
  const spki = crypto.createHash('sha256').update(new crypto.X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const s = https.createServer({ key: fs.readFileSync(key), cert: pem }, (req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'text/plain', 'x-echo': String(req.headers.authorization ?? '') });
    res.end(`you sent ${req.headers.authorization ?? 'nothing'} to ${req.url ?? ''}`);
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  return { port: (s.address() as AddressInfo).port, spki, seen, close: () => s.close() };
}

function vaultHandler(origin: string): string {
  return `module.exports = async function vault({ anchor, api }) {
  const box = document.createElement('div');
  box.className = 'vx';
  box.dataset.set = String(await api.settings.get('apiKey'));
  box.dataset.all = JSON.stringify(await api.settings.getAll());
  const go = document.createElement('button');
  go.className = 'vx-go';
  go.textContent = 'go';
  go.addEventListener('click', async () => {
    box.dataset.result = '';
    const r = await api.fetch(${JSON.stringify(origin)} + '/echo?x=1#frag', { secrets: ['apiKey'] });
    box.dataset.result = JSON.stringify(r.ok ? { ok: true, text: r.text, url: r.url, echo: r.headers['x-echo'] } : { ok: false, error: r.error });
  });
  box.appendChild(go);
  anchor.appendChild(box);
  return box;
};`;
}

interface Result { ok: boolean; text?: string; url?: string; echo?: string; error?: string }

async function main(): Promise<void> {
  console.log('\n=== extension vault harness ===\n');
  const work = workDir('shim-extension-vault-e2e-');
  const api = await apiServer(work);
  const ORIGIN = `https://${API_HOST}:${api.port}`;
  const ext = extensionCopy(work, ['*://127.0.0.1/*', `https://${API_HOST}/*`]);
  const { origin, close: closeServer } = await fixtureServer();
  const shimFile = shimWriter(work)('vx', 'Vault service', [
    { id: 'svc', anchor: css('#cfg'), mutations: [{ kind: 'script', handler: 'vault' }] },
  ], {
    settings: [
      { key: 'apiKey', type: 'secret', label: 'Service key', help: 'From your account page.', use: { origin: ORIGIN, header: 'Authorization', format: 'Bearer {}' } },
      { key: 'mapsKey', type: 'secret', label: 'Maps key', use: { origin: ORIGIN, query: 'key', format: '{}' } },
    ],
  }, { vault: vaultHandler(ORIGIN) });

  const profile = path.join(work, 'profile');
  const extra = { hosts: [API_HOST], args: [`--ignore-certificate-errors-spki-list=${api.spki}`] };
  let ctx: BrowserContext = await launch(ext, profile, extra);
  let { worker, extId } = await workerOf(ctx);
  check('allowing user scripts answers ok', (await configureExtension(ctx, extId, { userScriptsAccess: true })) === 'ok');
  await ctx.close();
  ctx = await launch(ext, profile, extra);
  ({ worker, extId } = await workerOf(ctx));

  const hostsOf = (w: Worker) => <T>(fn: string, ...args: unknown[]): Promise<T> => w.evaluate(([f, a]) => {
    const h = (globalThis as unknown as { shimPageHosts: Record<string, (...x: unknown[]) => unknown> }).shimPageHosts;
    return h[f as string]?.(...(a as unknown[])) as Promise<unknown>;
  }, [fn, args] as const) as Promise<T>;
  let hosts = hostsOf(worker);
  const ask = async <T>(msg: unknown, page = 'popup.html'): Promise<T> => {
    const p = await ctx.newPage();
    try {
      await p.goto(`chrome-extension://${extId}/${page}`);
      return await p.evaluate((m) => chrome.runtime.sendMessage(m), msg) as T;
    } finally { await p.close(); }
  };

  console.log('turned off (as a build that must stop vault operations ships):');
  await hosts('setVaultForTests', false);
  {
    const { install } = installer(ctx, extId);
    const { page, heading } = await install(shimFile);
    check('with the vault off, a shim declaring secrets is refused at install', !heading.startsWith('ready to install'), heading);
    await page.close();
    const popup = await popupOf(ctx, extId);
    check('and the popup shows no vault', await popup.locator('#vault').isHidden());
    await popup.close();
  }

  await hosts('setVaultForTests', true);
  const { installAll } = installer(ctx, extId);
  await installAll(shimFile);
  const shims = (await ask<{ shims: Array<{ id: string; name: string; needsSetup: boolean; vault?: unknown }> }>({ type: 'shims.list' })).shims;
  const ID = shims.find((s) => s.name === 'Vault service')?.id ?? '';
  check('with the vault on, it installs as a vault shim', ID !== '' && shims[0]?.vault !== undefined, shims);

  console.log('trusted pages only:');
  {
    const fromInstall = await ask<{ ok: boolean; error?: string }>({ type: 'vault.status' }, 'install.html');
    check('the install page is refused a vault message', fromInstall.ok === false, fromInstall);
    const malformed = await ask<{ ok: boolean; error?: string }>({ type: 'vault.unlock', passphrase: PASS, extra: 1 });
    check('a vault message with an extra field is refused', malformed.ok === false && (malformed.error ?? '').includes('exactly'), malformed);
    const site = await ctx.newPage();
    await site.goto(`${origin}/settings-fixture`);
    const tabId = await worker.evaluate((u) => chrome.tabs.query({}).then((t) => t.filter((x) => x.url === u).map((x) => x.id).at(-1) ?? -1), site.url());
    const fromSite = await worker.evaluate(async (id) => {
      const out = await chrome.userScripts.execute({ target: { tabId: id }, js: [{ code: 'chrome.runtime.sendMessage({ type: "vault.status" })' }] } as chrome.userScripts.UserScriptInjection);
      return out.map((r) => r.result)[0];
    }, tabId) as { ok?: boolean };
    check('a site\'s user-script world is refused a vault message', fromSite?.ok === false, fromSite);
    await site.close();
  }

  console.log('setup, approve, enter (the settings page):');
  const settings = await ctx.newPage();
  await settings.goto(`chrome-extension://${extId}/settings.html?shim=${encodeURIComponent(ID)}`);
  await settings.waitForSelector('#vault .vault-form');
  check('the page offers setup first', (await settings.locator('#vault').textContent() ?? '').includes('passphrase only you know'));
  check('a secret field says the vault is locked/none: no value input yet', (await settings.locator('.trusted').first().textContent() ?? '').includes('unlock the vault'));
  const inputs = settings.locator('#vault input[type=password]');
  await inputs.nth(0).fill('password1234');
  await inputs.nth(1).fill('password1234');
  await settings.click('#vault button.primary');
  await settings.waitForSelector('#vault .status.error');
  check('a common password is refused', (await settings.locator('#vault .status.error').textContent() ?? '').includes('common'));
  await inputs.nth(0).fill(PASS);
  await inputs.nth(1).fill(PASS);
  await settings.click('#vault button.primary');
  await settings.waitForFunction(() => (document.querySelector('#vault')?.textContent ?? '').includes('Unlocked until'));
  check('setup leaves the vault unlocked', true);
  const status1 = (await ask<{ vault: { state: string; expiresAt: number } }>({ type: 'vault.status' })).vault;
  check('expiring at most 12 hours on', status1.state === 'unlocked' && status1.expiresAt - Date.now() <= 12 * 3600_000 + 5000, status1);
  const trusted = settings.locator('.trusted').first();
  check('Shim for Chrome says where the value goes, apart from the shim\'s own words',
    (await trusted.textContent() ?? '').includes(`sends this value to ${ORIGIN} in the Authorization header`), await trusted.textContent());
  const mapsBox = settings.locator('.trusted').nth(1);
  check('the query placement names the logging risk', (await mapsBox.textContent() ?? '').includes('logs'));
  await trusted.locator('input[type=password]').fill(SECRET);
  await trusted.locator('button', { hasText: 'save' }).click();
  type Grants = { grants: Array<{ key: string; state: string; isSet: boolean }> };
  const grantOf = async (): Promise<{ state: string; isSet: boolean } | undefined> => (await ask<Grants>({ type: 'grants.list', id: ID }, 'settings.html')).grants.find((g) => g.key === 'apiKey');
  check('the value is saved', (await settle(grantOf, (g) => g?.isSet === true))?.isSet === true);
  await settings.waitForFunction(() => (document.querySelector('.trusted')?.textContent ?? '').includes('clear'));
  await settings.locator('.trusted').first().locator('button', { hasText: 'approve' }).click();
  check('the grant is approved', (await settle(grantOf, (g) => g?.state === 'granted'))?.state === 'granted');
  const stored = await worker.evaluate(() => new Promise<string>((resolve) => {
    const open = indexedDB.open('shim-for-chrome-vault');
    open.onsuccess = () => {
      const tx = open.result.transaction(['secrets', 'meta'], 'readonly');
      const a = tx.objectStore('secrets').getAll();
      const b = tx.objectStore('meta').getAll();
      tx.oncomplete = () => resolve(JSON.stringify([a.result, b.result]));
    };
  }));
  check('the vault database holds ciphertext only', stored.length > 50 && !stored.includes(SECRET) && !stored.includes(PASS));

  console.log('the shim uses it:');
  const page = await ctx.newPage();
  await page.goto(`${origin}/settings-fixture`);
  const box = page.locator('.vx');
  await box.waitFor({ timeout: 10000 });
  check('the handler reads presence only: true', (await box.getAttribute('data-set')) === 'true');
  check('getAll answers presence too, never the value', !((await box.getAttribute('data-all')) ?? '').includes(SECRET) && ((await box.getAttribute('data-all')) ?? '').includes('"apiKey":true'));
  const go = async (p: Page): Promise<Result> => {
    await p.locator('.vx-go').click();
    const raw = await settle(() => p.locator('.vx').getAttribute('data-result'), (v) => typeof v === 'string' && v !== '', 10000);
    return JSON.parse(raw || '{"ok":false,"error":"no answer"}') as Result;
  };
  {
    const r = await go(page);
    const last = api.seen.at(-1);
    check('the request reached the service', r.ok === true, r);
    check('with the header placed exactly as declared', last?.auth === `Bearer ${SECRET}`, last);
    check('the fragment dropped', last?.url === '/echo?x=1');
    check('the echoed value is redacted in the body', !(r.text ?? '').includes(SECRET) && (r.text ?? '').includes('[redacted]'), r.text);
    check('and in a header', !(r.echo ?? '').includes(SECRET));
    check('the answer carries the handler\'s own url', r.url === `${ORIGIN}/echo?x=1`);
    check('nothing in the page holds the value', !(await page.content()).includes(SECRET));
  }

  console.log('lock and unlock (the popup):');
  {
    const popup = await popupOf(ctx, extId);
    await popup.waitForSelector('#vault:not([hidden])');
    check('the popup shows the vault unlocked', (await popup.locator('#vault').textContent() ?? '').includes('unlocked until'));
    await popup.locator('#vault button', { hasText: 'lock' }).click();
    await popup.waitForSelector('#vault input[type=password]');
    check('locking shows the unlock form, listing what unlocking enables',
      (await popup.locator('#vault').textContent() ?? '').includes('Vault service: Service key'), await popup.locator('#vault').textContent());
    const r = await go(page);
    check('locked: the request is refused, nothing sent', r.ok === false && (r.error ?? '').includes('locked'), r);
    const seenBefore = api.seen.length;
    await popup.fill('#vault input[type=password]', 'wrong-passphrase-entirely');
    await popup.locator('#vault button', { hasText: 'unlock' }).click();
    await popup.waitForSelector('#vault .status.error');
    check('a wrong passphrase is refused', (await popup.locator('#vault .status.error').textContent() ?? '').includes('does not unlock'));
    check('and changes nothing', (await ask<{ vault: { state: string } }>({ type: 'vault.status' })).vault.state === 'locked' && api.seen.length === seenBefore);
    await popup.fill('#vault input[type=password]', PASS);
    await popup.locator('#vault button', { hasText: 'unlock' }).click();
    await popup.waitForFunction(() => (document.querySelector('#vault')?.textContent ?? '').includes('unlocked until'));
    check('the right one unlocks', true);
    await popup.close();
    check('and the shim sends again', (await go(page)).ok === true);
  }

  console.log('a session on the tab:');
  const tabOf = async (p: Page): Promise<number> => worker.evaluate((u) => chrome.tabs.query({}).then((t) => t.filter((x) => x.url === u).map((x) => x.id).at(-1) ?? -1), p.url());
  {
    const tabId = await tabOf(page);
    const hostId = await hosts<string>('open', tabId);
    const r = await go(page);
    check('while a session holds the tab, a secret is refused', r.ok === false && r.error === 'secrets-not-available-in-session', r);
    await hosts('close', hostId);
    const after = await go(page);
    check('after it ends, the document it touched stays refused', after.ok === false && after.error === 'secrets-not-available-in-session', after);
    await page.reload();
    await page.locator('.vx').waitFor();
    check('a fresh load is allowed again', (await go(page)).ok === true);
  }

  console.log('a session holding the vault shim\'s rule while the worker idles:');
  {
    const tabId = await tabOf(page);
    const hostId = await hosts<string>('open', tabId);
    const host = proxyHost(worker, hostId);
    const preview: PreviewRule = {
      patchId: ID, ruleKey: 'preview:vx:svc',
      rule: { id: 'svc', anchor: css('#cfg'), mutations: [{ kind: 'script', handler: 'p' }], handlers: { p: 'function p({ anchor }) { const e = document.createElement("i"); e.className = "vx-preview"; anchor.appendChild(e); return e; }' } },
    };
    host.applyPreview(preview);
    const up = await settle(async () => ({ p: await page.locator('.vx-preview').count(), c: await page.locator('.vx').count() }), (v) => v.p === 1 && v.c === 0);
    check('the hold reaches the vault world: the committed rule is down under the preview', up.p === 1 && up.c === 0, up);
    const dropped = await hosts<number>('dropRuntimePorts', tabId);
    check('the worker drops the tab\'s ports (as when it idles out)', dropped >= 1, dropped);
    await sleep(2500);
    const still = { p: await page.locator('.vx-preview').count(), c: await page.locator('.vx').count() };
    check('after the vault runtime reconnects (re-authenticating), the rule stays held', still.p === 1 && still.c === 0, still);
    host.removePreview('preview:vx:svc');
    const back = await settle(() => page.locator('.vx').count(), (n) => n === 1);
    check('removing the preview brings the committed rule back', back === 1);
    await host.stop();
    await hosts('close', hostId);
    await page.reload();
    await page.locator('.vx').waitFor();
  }

  console.log('a stopped worker wakes with the vault still unlocked:');
  {
    await worker.evaluate(() => { (globalThis as { __beforeStop?: boolean }).__beforeStop = true; });
    const cdp = await ctx.newCDPSession(page);
    let stopped = false;
    try {
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      stopped = true;
    } catch (e) {
      console.log(`  (could not stop the worker over CDP: ${e instanceof Error ? e.message : String(e)})`);
    }
    await sleep(1000);
    const r = await go(page);
    check('the woken worker answers the vault world (persisted token) and sends', r.ok === true, { r, stopped });
    ({ worker } = await workerOf(ctx));
    hosts = hostsOf(worker);
    const fresh = await worker.evaluate(() => (globalThis as { __beforeStop?: boolean }).__beforeStop !== true).catch(() => null);
    check('it really was a new worker instance', stopped && fresh === true, { stopped, fresh });
  }

  console.log('revoke rotates the token:');
  {
    const before = (await hosts<{ generations: Record<string, number> }>('vaultState')).generations[ID] ?? 0;
    await settings.reload();
    await settings.locator('.trusted').first().locator('button', { hasText: 'revoke' }).click();
    await settle(grantOf, (g) => g?.state === 'none');
    const after = (await hosts<{ generations: Record<string, number> }>('vaultState')).generations[ID] ?? 0;
    check('a grant change gives the shim a new generation', after === before + 1, { before, after });
    const torn = await settle(() => page.locator('.vx').count(), (n) => n === 0);
    check('the open document\'s vault world tears down (its token is stale)', torn === 0);
    await page.reload();
    await page.locator('.vx').waitFor();
    const r = await go(page);
    check('after a reload, the unapproved secret is refused', r.ok === false && (r.error ?? '').includes('approve'), r);
    await settings.locator('.trusted').first().locator('button', { hasText: 'approve' }).click();
    await settle(grantOf, (g) => g?.state === 'granted');
    await page.reload();
    await page.locator('.vx').waitFor();
    check('approved again, it sends', (await go(page)).ok === true);
  }

  console.log('a browser start (simulated: the session storage gone, a new worker, onStartup):');
  {
    // A relaunch under Playwright loads the extension from the command line,
    // which Chrome treats as an install at every launch (onInstalled
    // 'install', checked below), so a real browser start is simulated here:
    // what a start changes for the extension is a new worker with
    // chrome.storage.session empty, and the documents (restored tabs) still
    // holding the vault worlds the persisted registrations created.
    const genBefore = (await hosts<{ generations: Record<string, number> }>('vaultState')).generations[ID] ?? 0;
    const ep = await ctx.newPage();
    await ep.goto(`chrome-extension://${extId}/popup.html`);
    await ep.evaluate(() => chrome.storage.session.clear());
    await ep.close();
    await worker.evaluate(() => { (globalThis as { __beforeStop?: boolean }).__beforeStop = true; });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await sleep(1000);
    // Something wakes the worker (the restored tab's runtime reconnecting does).
    ({ worker } = await workerOf(ctx));
    hosts = hostsOf(worker);
    await settle(() => worker.evaluate(() => (globalThis as { __beforeStop?: boolean }).__beforeStop !== true).catch(() => false), (v) => v === true);
    check('the vault is locked (its key lived in session storage)', (await ask<{ vault: { state: string } }>({ type: 'vault.status' })).vault.state === 'locked');
    const genAfter = (await hosts<{ generations: Record<string, number> }>('vaultState')).generations[ID] ?? 0;
    check('no token rotated', genAfter === genBefore, { genBefore, genAfter });
    await sleep(1500);
    check('the open document keeps its vault world', (await page.locator('.vx').count()) === 1);
    const locked = await go(page);
    check('locked, it is refused', locked.ok === false && (locked.error ?? '').includes('locked'), locked);
    await ask({ type: 'vault.unlock', passphrase: PASS });
    check('unlocked, the same document sends again, no reload', (await go(page)).ok === true);
  }

  console.log('a relaunch (Playwright: the extension reinstalls from the command line):');
  {
    const url = page.url();
    await sleep(1500);
    await ctx.close();
    ctx = await launch(ext, profile, { ...extra, args: [...extra.args, '--restore-last-session'] });
    ({ worker, extId } = await workerOf(ctx));
    hosts = hostsOf(worker);
    const events = await settle(() => hosts<string[]>('installEvents'), (e) => e.length > 0, 5000);
    check('Chrome reports it as an install (why the start above is simulated)', events.includes('install'), events);
    const restored = await settle(async () => ctx.pages().find((p) => p.url() === url) ?? null, (p) => p !== null, 10000);
    check('the tab is restored', restored !== null, ctx.pages().map((p) => p.url()));
    check('the vault starts locked', (await ask<{ vault: { state: string } }>({ type: 'vault.status' })).vault.state === 'locked');
    check('the shims, the vault and its secrets survive', (await ask<{ grants: Array<{ isSet: boolean; state: string }> }>({ type: 'grants.list', id: ID }, 'settings.html')).grants[0]?.isSet === true);
    if (restored) {
      await ask({ type: 'vault.unlock', passphrase: PASS });
      await restored.reload();
      await restored.locator('.vx').waitFor({ timeout: 10000 });
      check('after an install, a reload brings the vault shim back and it sends', (await go(restored)).ok === true);
    }
  }

  await ctx.close();
  api.close();
  closeServer();
  fs.rmSync(work, { recursive: true, force: true });
  console.log('');
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log(`all extension vault checks passed (${passes})`);
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
