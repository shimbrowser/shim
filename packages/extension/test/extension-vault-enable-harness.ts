// The vault as it ships (on), end to end in the built extension in a real
// Chromium with user scripts allowed. The service a secret goes to is NOT
// in the manifest: its access comes only from approving.
//
//   - the install review lists each placed secret (origin, header or
//     parameter, format; the query one with the logs and report-collector
//     disclosure), and approving one there asks Chrome for the service's
//     access in the install click, with the shim's own sites;
//   - the settings page approves the other the same way; a denied prompt
//     leaves it unapproved, and a direct approval without the access is
//     refused;
//   - the handler reads presence only; the header and the query secret reach
//     the service placed exactly, and the page never holds a value;
//   - another shim's plain fetch to the service is not refused as held: it
//     reads an answer that allows cross-origin reads, an answer that does not
//     is refused unread, a request CORS would preflight is refused;
//   - locked refuses; a session on the tab advertises declared secrets,
//     previews read the secret as unset and refuse `secrets`, and the
//     installed shim's use is suspended;
//   - revoking the last approval gives the service's access back; removing
//     the shim gives back the access its grants owned; the user withdrawing
//     it on chrome://extensions drops the grant.
//
// Chrome's permission prompt cannot be clicked here. The first yes is given
// on chrome://extensions (developerPrivate, as the user would), so the real
// request in the install click answers without a prompt; Chrome then
// answers a request for access the extension itself gave back without one
// too, so the later real clicks run as they would. A denial is the page's
// request answered no (stubbed). Once the user has withdrawn access on
// chrome://extensions a request shows a real prompt, so that comes last.
//
//   npx playwright install chromium   (full Chromium: extensions need it)
//   node out/packages/extension/test/extension-vault-enable-harness.js

import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';
import type { BrowserContext, Page } from 'playwright';
import type { PreviewRule } from '@shimbrowser/core/page-host';
import { workDir, extensionCopy, fixtureServer, shimWriter, css, launch, workerOf, installer, configureExtension, settle, sleep } from './smoke-helpers';
import { proxyHost } from './host-proxy';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { passes++; console.log(`  ✓ ${label}`); return; }
  failures++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
}

const API_HOST = 'api.vault-enable.test';
const ACCESS = `https://${API_HOST}/*`;
const PASS = 'morvi-tasel-ondur-kifap-ralen';
const SECRET = 'sk-live-ENABLE-1234567890';
const MAPS = 'maps-ENABLE-0987654321';

interface Seen { method: string; url: string; auth: string | undefined }

/** An HTTPS service: /echo echoes, /public allows cross-origin reads, /private does not. */
async function apiServer(work: string): Promise<{ port: number; spki: string; seen: Seen[]; close(): void }> {
  const key = path.join(work, 'api-key.pem');
  const cert = path.join(work, 'api-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
    '-subj', `/CN=${API_HOST}`, '-addext', `subjectAltName=DNS:${API_HOST}`], { stdio: 'ignore' });
  const pem = fs.readFileSync(cert);
  const spki = crypto.createHash('sha256').update(new crypto.X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const seen: Seen[] = [];
  const s = https.createServer({ key: fs.readFileSync(key), cert: pem }, (req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
    const p = new URL(req.url ?? '/', 'https://x').pathname;
    if (p === '/public') {
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'x-hidden': 'h' });
      res.end('public answer');
      return;
    }
    if (p === '/private') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('private answer');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`got ${req.url ?? ''}`);
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  return { port: (s.address() as AddressInfo).port, spki, seen, close: () => s.close() };
}

function vaultHandler(origin: string): string {
  return `module.exports = async function vault({ anchor, api }) {
  const box = document.createElement('div');
  box.className = 'vx';
  box.dataset.set = String(await api.settings.get('apiKey'));
  const run = async (name, opts) => {
    const r = await api.fetch(${JSON.stringify(origin)} + '/echo?x=1', opts);
    box.dataset[name] = JSON.stringify(r.ok ? { ok: true, text: r.text, url: r.url } : { ok: false, error: r.error });
  };
  for (const [cls, name, key] of [['vx-h', 'header', 'apiKey'], ['vx-q', 'query', 'mapsKey']]) {
    const b = document.createElement('button');
    b.className = cls;
    b.addEventListener('click', () => { box.dataset[name] = ''; void run(name, { secrets: [key] }); });
    box.appendChild(b);
  }
  anchor.appendChild(box);
  return box;
};`;
}

function otherHandler(origin: string): string {
  return `module.exports = async function other({ anchor, api }) {
  const box = document.createElement('div');
  box.className = 'ox';
  const run = async (name, url, opts) => {
    const r = await api.fetch(url, opts);
    box.dataset[name] = JSON.stringify(r.ok ? { ok: true, text: r.text, headers: r.headers } : { ok: false, error: r.error });
  };
  const jobs = {
    pub: () => run('pub', ${JSON.stringify(origin)} + '/public'),
    priv: () => run('priv', ${JSON.stringify(origin)} + '/private'),
    post: () => run('post', ${JSON.stringify(origin)} + '/public', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  };
  for (const [name, job] of Object.entries(jobs)) {
    const b = document.createElement('button');
    b.className = 'ox-' + name;
    b.addEventListener('click', () => { box.dataset[name] = ''; void job(); });
    box.appendChild(b);
  }
  anchor.appendChild(box);
  return box;
};`;
}

interface Result { ok: boolean; text?: string; url?: string; error?: string; headers?: Record<string, string> }

async function main(): Promise<void> {
  console.log('\n=== extension vault enable harness ===\n');
  const work = workDir('shim-extension-vault-enable-');
  const api = await apiServer(work);
  const ORIGIN = `https://${API_HOST}:${api.port}`;
  const ext = extensionCopy(work, ['*://127.0.0.1/*']);
  const { origin, close: closeServer } = await fixtureServer();
  const write = shimWriter(work);
  const vaultFile = write('vx', 'Vault service', [
    { id: 'svc', anchor: css('#cfg'), mutations: [{ kind: 'script', handler: 'vault' }] },
  ], {
    settings: [
      { key: 'apiKey', type: 'secret', label: 'Service key', use: { origin: ORIGIN, header: 'Authorization', format: 'Bearer {}' } },
      { key: 'mapsKey', type: 'secret', label: 'Maps key', use: { origin: ORIGIN, query: 'key', format: '{}' } },
    ],
  }, { vault: vaultHandler(ORIGIN) });
  const otherFile = write('ox', 'Other shim', [
    { id: 'o', anchor: css('#cfg'), mutations: [{ kind: 'script', handler: 'other' }] },
  ], {}, { other: otherHandler(ORIGIN) });

  const profile = path.join(work, 'profile');
  const extra = { hosts: [API_HOST], args: [`--ignore-certificate-errors-spki-list=${api.spki}`] };
  let ctx: BrowserContext = await launch(ext, profile, extra);
  let { worker, extId } = await workerOf(ctx);
  check('allowing user scripts answers ok', (await configureExtension(ctx, extId, { userScriptsAccess: true })) === 'ok');
  await ctx.close();
  ctx = await launch(ext, profile, extra);
  ({ worker, extId } = await workerOf(ctx));

  const hosts = <T>(fn: string, ...args: unknown[]): Promise<T> => worker.evaluate(([f, a]) => {
    const h = (globalThis as unknown as { shimPageHosts: Record<string, (...x: unknown[]) => unknown> }).shimPageHosts;
    return h[f as string]?.(...(a as unknown[])) as Promise<unknown>;
  }, [fn, args] as const) as Promise<T>;
  const ask = async <T>(msg: unknown, page = 'settings.html'): Promise<T> => {
    const p = await ctx.newPage();
    try {
      await p.goto(`chrome-extension://${extId}/${page}`);
      return await p.evaluate((m) => chrome.runtime.sendMessage(m), msg) as T;
    } finally { await p.close(); }
  };
  const held = (): Promise<boolean> => worker.evaluate((o) => chrome.permissions.contains({ origins: [o] }), ACCESS);
  /** The chrome://extensions site-access controls (developerPrivate), as the user would use them. */
  const siteAccess = async (op: 'add' | 'remove'): Promise<string> => {
    const p = await ctx.newPage();
    try {
      await p.goto(`chrome://extensions/?id=${extId}`);
      return await p.evaluate(([id, host, which]) => new Promise<string>((resolve) => {
        type Dev = Record<'addHostPermission' | 'removeHostPermission', (id: string, host: string, cb: () => void) => void>;
        const c = (globalThis as { chrome?: { developerPrivate?: Dev; runtime?: { lastError?: { message: string } } } }).chrome;
        if (!c?.developerPrivate) { resolve('no developerPrivate'); return; }
        c.developerPrivate[which === 'add' ? 'addHostPermission' : 'removeHostPermission'](id, host, () => resolve(c.runtime?.lastError ? `err: ${c.runtime.lastError.message}` : 'ok'));
      }), [extId, ACCESS, op] as const);
    } finally { await p.close(); }
  };
  /** Records each chrome.permissions.request on a page, answering `answer` (or Chrome's real answer when null). */
  const recordRequests = async (p: Page, answer: boolean | null): Promise<void> => {
    await p.addInitScript((a) => {
      const w = window as unknown as { __asked: unknown[] };
      w.__asked = [];
      const real = chrome.permissions.request.bind(chrome.permissions);
      chrome.permissions.request = ((perms: chrome.permissions.Permissions) => {
        w.__asked.push(perms);
        return a === null ? real(perms) : Promise.resolve(a);
      }) as typeof chrome.permissions.request;
    }, answer);
  };
  const asked = (p: Page): Promise<Array<{ origins?: string[] }>> => p.evaluate(() => (window as unknown as { __asked: Array<{ origins?: string[] }> }).__asked);

  check('the service is not held before anything is approved', !(await held()));
  check('the build advertises the vault on', (await ask<{ vault?: boolean }>({ type: 'mode' }, 'popup.html')).vault === true);

  console.log('the install review:');
  let ID = '';
  {
    // Standing in for the user's yes to Chrome's prompt: the service granted
    // on chrome://extensions, so the install click's real request answers
    // without one.
    check('granting the service on chrome://extensions answers ok', (await siteAccess('add')) === 'ok');
    const page = await ctx.newPage();
    await recordRequests(page, null);
    await page.goto(`chrome-extension://${extId}/install.html`);
    await page.setInputFiles('#file', vaultFile);
    await page.waitForSelector('#review:not([hidden]) h2');
    const text = await page.locator('.secrets').textContent() ?? '';
    check('it lists the header secret: origin, header and format', text.includes(`${ORIGIN} in the Authorization header`) && text.includes('"Bearer {}"'), text);
    check('it lists the query secret with the logs and report-collector disclosure', text.includes('web address as "key"') && text.includes('logs') && text.includes('error-report collector'), text);
    check('the shim\'s own words are marked as its own', text.includes('the shim calls it: Service key'));
    await page.locator('.secret input[type=checkbox]').nth(0).check();
    await page.click('#review button.primary');
    await page.waitForSelector('#result:not([hidden]) h2', { timeout: 15000 });
    const req = await asked(page);
    check('one request, in the install click, for the shim\'s sites and the approved service', req.length === 1 && (req[0]?.origins ?? []).includes(ACCESS) && (req[0]?.origins ?? []).includes('*://127.0.0.1/*'), req);
    await page.close();
    const shims = (await ask<{ shims: Array<{ id: string; name: string }> }>({ type: 'shims.list' }, 'popup.html')).shims;
    ID = shims.find((s) => s.name === 'Vault service')?.id ?? '';
    const grants = (await ask<{ grants: Array<{ key: string; state: string; access: string }> }>({ type: 'grants.list', id: ID })).grants;
    check('the approved secret is granted at install, the other not', grants.find((g) => g.key === 'apiKey')?.state === 'granted' && grants.find((g) => g.key === 'mapsKey')?.state === 'none', grants);
    check('each grant names the access it owns', grants.every((g) => g.access === ACCESS), grants);
  }
  const { installAll } = installer(ctx, extId);
  await installAll(otherFile);

  console.log('setup, enter, approve (the settings page):');
  const settings = await ctx.newPage();
  await recordRequests(settings, null);
  await settings.goto(`chrome-extension://${extId}/settings.html?shim=${encodeURIComponent(ID)}`);
  await settings.waitForSelector('#vault .vault-form');
  const inputs = settings.locator('#vault input[type=password]');
  await inputs.nth(0).fill(PASS);
  await inputs.nth(1).fill(PASS);
  await settings.click('#vault button.primary');
  await settings.waitForFunction(() => (document.querySelector('#vault')?.textContent ?? '').includes('Unlocked until'));
  type Grants = { grants: Array<{ key: string; state: string; isSet: boolean; review: string }> };
  const grantOf = async (key: string) => (await ask<Grants>({ type: 'grants.list', id: ID })).grants.find((g) => g.key === key);
  for (const [i, value] of [[0, SECRET], [1, MAPS]] as const) {
    await settings.locator('.trusted').nth(i).locator('input[type=password]').fill(value);
    await settings.locator('.trusted').nth(i).locator('button', { hasText: 'save' }).click();
    await settle(() => grantOf(i === 0 ? 'apiKey' : 'mapsKey'), (g) => g?.isSet === true);
    await settings.waitForFunction((n) => (document.querySelectorAll('.trusted')[n]?.textContent ?? '').includes('clear'), i);
  }
  check('both values are saved', (await grantOf('apiKey'))?.isSet === true && (await grantOf('mapsKey'))?.isSet === true);
  const mapsBox = settings.locator('.trusted').nth(1);
  check('the settings page says approving asks for the service\'s access', (await mapsBox.textContent() ?? '').includes(`access to ${ORIGIN}`));
  await mapsBox.locator('button', { hasText: 'approve' }).click();
  check('the query secret is approved', (await settle(() => grantOf('mapsKey'), (g) => g?.state === 'granted'))?.state === 'granted');
  const reqs = await asked(settings);
  check('approving asked Chrome for exactly the service', reqs.length === 1 && JSON.stringify(reqs[0]?.origins) === JSON.stringify([ACCESS]), reqs);

  console.log('the shims use it:');
  const page = await ctx.newPage();
  await page.goto(`${origin}/settings-fixture`);
  await page.locator('.vx').waitFor({ timeout: 10000 });
  await page.locator('.ox').waitFor({ timeout: 10000 });
  const vx = async (cls: string, attr: string): Promise<Result> => {
    await page.locator(`.vx .${cls}`).click();
    const raw = await settle(() => page.locator('.vx').getAttribute(`data-${attr}`), (v) => typeof v === 'string' && v !== '', 10000);
    return JSON.parse(raw || '{"ok":false,"error":"no answer"}') as Result;
  };
  const ox = async (name: string): Promise<Result> => {
    await page.locator(`.ox .ox-${name}`).click();
    const raw = await settle(() => page.locator('.ox').getAttribute(`data-${name}`), (v) => typeof v === 'string' && v !== '', 10000);
    return JSON.parse(raw || '{"ok":false,"error":"no answer"}') as Result;
  };
  check('the handler reads presence only', (await page.locator('.vx').getAttribute('data-set')) === 'true');
  {
    const r = await vx('vx-h', 'header');
    const last = api.seen.at(-1);
    check('the header secret reaches the service, placed exactly', r.ok === true && last?.auth === `Bearer ${SECRET}` && last.url === '/echo?x=1', { r, last });
    const q = await vx('vx-q', 'query');
    const lastQ = api.seen.at(-1);
    check('the query secret reaches the service as the declared parameter', q.ok === true && lastQ?.url === `/echo?x=1&key=${MAPS}` && lastQ.auth === undefined, { q, lastQ });
    check('the handler is answered the public url, never the key', q.url === `${ORIGIN}/echo?x=1` && !(q.text ?? '').includes(MAPS), q);
    check('nothing in the page holds a value', !(await page.content()).includes(SECRET) && !(await page.content()).includes(MAPS));
  }

  console.log('another shim\'s plain fetch to the service:');
  {
    const pub = await ox('pub');
    check('is not refused as held for another shim: an answer that allows cross-origin reads is read', pub.ok === true && pub.text === 'public answer', pub);
    check('with only the headers CORS exposes', pub.headers?.['x-hidden'] === undefined && pub.headers?.['content-type'] === 'text/plain', pub.headers);
    const before = api.seen.length;
    const priv = await ox('priv');
    check('an answer that does not allow cross-origin reads is refused unread', priv.ok === false && (priv.error ?? '').includes('cross-origin') && !JSON.stringify(priv).includes('private answer'), priv);
    check('(the request itself went out, as under CORS)', api.seen.length === before + 1);
    const n = api.seen.length;
    const post = await ox('post');
    check('a request CORS would preflight is refused before it is sent', post.ok === false && (post.error ?? '').includes('simple requests') && api.seen.length === n, post);
    check('no plain fetch carried a secret', api.seen.filter((s) => s.url.startsWith('/public') || s.url.startsWith('/private')).every((s) => s.auth === undefined && !s.url.includes(MAPS)));
  }

  console.log('locked:');
  {
    await ask({ type: 'vault.lock' }, 'popup.html');
    const r = await vx('vx-h', 'header');
    check('locking refuses', r.ok === false && (r.error ?? '').includes('locked'), r);
    await ask({ type: 'vault.unlock', passphrase: PASS }, 'popup.html');
    check('unlocking sends again', (await vx('vx-h', 'header')).ok === true);
  }

  console.log('a session on the tab:');
  const tabOf = async (p: Page): Promise<number> => worker.evaluate((u) => chrome.tabs.query({}).then((t) => t.filter((x) => x.url === u).map((x) => x.id).at(-1) ?? -1), p.url());
  {
    const tabId = await tabOf(page);
    const hostId = await hosts<string>('open', tabId);
    const caps = await hosts<{ secretSettings?: string }>('call', hostId, 'capabilities', []);
    check('the session advertises declared secrets', caps.secretSettings === 'declared', caps);
    const host = proxyHost(worker, hostId);
    const preview: PreviewRule = {
      patchId: ID, ruleKey: 'preview:vx:p',
      rule: {
        id: 'p', anchor: css('#cfg'), mutations: [{ kind: 'script', handler: 'p' }],
        handlers: {
          p: `async function p({ anchor, api }) {
  const e = document.createElement('i');
  e.className = 'vx-preview';
  anchor.appendChild(e);
  e.dataset.set = String(await api.settings.get('apiKey'));
  const r = await api.fetch(${JSON.stringify(ORIGIN)} + '/echo?p=1', { secrets: ['apiKey'] });
  e.dataset.fetch = JSON.stringify(r.ok ? { ok: true } : { ok: false, error: r.error });
  return e;
}`,
        },
      },
    };
    const seenBefore = api.seen.length;
    host.applyPreview(preview);
    const fetched = await settle(() => page.locator('.vx-preview').getAttribute('data-fetch').catch(() => null), (v) => typeof v === 'string' && v !== '', 10000);
    check('a preview reads the secret as unset', (await page.locator('.vx-preview').getAttribute('data-set')) !== 'true');
    check('and a preview\'s fetch naming secrets is refused, nothing sent', (fetched ?? '').includes('secrets-not-available-in-session') && api.seen.length === seenBefore, fetched);
    host.removePreview('preview:vx:p');
    await settle(() => page.locator('.vx').count(), (n) => n === 1);
    const r = await vx('vx-h', 'header');
    check('while the session holds the tab, the installed shim\'s secret is refused', r.ok === false && r.error === 'secrets-not-available-in-session', r);
    await host.stop();
    await hosts('close', hostId);
    await page.reload();
    await page.locator('.vx').waitFor();
    check('a fresh load after the session sends again', (await vx('vx-h', 'header')).ok === true);
  }

  console.log('revoke, deny, withdraw, remove:');
  {
    await settings.reload();
    await settings.locator('.trusted').nth(0).locator('button', { hasText: 'revoke' }).click();
    await settle(() => grantOf('apiKey'), (g) => g?.state === 'none');
    check('revoking one approval keeps the access the other still needs', await held());
    await settings.locator('.trusted').nth(1).locator('button', { hasText: 'revoke' }).click();
    await settle(() => grantOf('mapsKey'), (g) => g?.state === 'none');
    check('revoking the last approval gives the service\'s access back', !(await settle(held, (v) => v === false)));
    // The revoke re-registers the vault shim (a new token): let it settle before the load.
    await sleep(1500);
    await page.reload();
    await page.locator('.ox').waitFor();
    check('the other shim still reads the public answer (Chrome\'s own CORS now)', (await ox('pub')).ok === true);

    const denied = await ctx.newPage();
    await recordRequests(denied, false);
    await denied.goto(`chrome-extension://${extId}/settings.html?shim=${encodeURIComponent(ID)}`);
    await denied.waitForSelector('.trusted button.primary');
    await denied.locator('.trusted').nth(0).locator('button', { hasText: 'approve' }).click();
    await denied.waitForSelector('.trusted .status.error');
    check('a denied prompt says so', (await denied.locator('.trusted .status.error').first().textContent() ?? '').includes('was not granted'));
    check('and leaves the secret unapproved', (await grantOf('apiKey'))?.state === 'none');
    await denied.close();
    const review = (await grantOf('apiKey'))?.review ?? '';
    const direct = await ask<{ ok: boolean; error?: string }>({ type: 'grants.approve', id: ID, key: 'apiKey', review });
    check('an approval without the access is refused by the worker', direct.ok === false && (direct.error ?? '').includes('not granted'), direct);

    // Chrome's own prompt (answered by the automation profile) on a real click.
    const approveByClick = async (): Promise<Array<{ origins?: string[] }>> => {
      const p = await ctx.newPage();
      await recordRequests(p, null);
      await p.goto(`chrome-extension://${extId}/settings.html?shim=${encodeURIComponent(ID)}`);
      await p.waitForSelector('.trusted button.primary');
      await p.locator('.trusted').nth(0).locator('button', { hasText: 'approve' }).click();
      await settle(() => grantOf('apiKey'), (g) => g?.state === 'granted');
      const req = await asked(p);
      await p.close();
      return req;
    };
    const req = await approveByClick();
    check('approving by a click asks Chrome again and, granted, approves', (await grantOf('apiKey'))?.state === 'granted' && await held(), req);
    const removed = await ask<{ ok: boolean }>({ type: 'shims.uninstall', id: ID }, 'popup.html');
    check('removing the shim', removed.ok === true);
    check('gives back the access its grants owned', !(await settle(held, (v) => v === false)));
    check('the other shim\'s own sites stay held', await worker.evaluate(() => chrome.permissions.contains({ origins: ['*://127.0.0.1/*'] })));

    // Installed again, approved in the install click: then the user takes the access away.
    const inst = await ctx.newPage();
    await inst.goto(`chrome-extension://${extId}/install.html`);
    await inst.setInputFiles('#file', vaultFile);
    await inst.waitForSelector('#review:not([hidden]) h2');
    await inst.locator('.secret input[type=checkbox]').nth(0).check();
    await inst.click('#review button.primary');
    await inst.waitForSelector('#result:not([hidden]) h2', { timeout: 15000 });
    await inst.close();
    const ID2 = (await ask<{ shims: Array<{ id: string; name: string }> }>({ type: 'shims.list' }, 'popup.html')).shims.find((x) => x.name === 'Vault service')?.id ?? '';
    const grant2 = async () => (await ask<Grants>({ type: 'grants.list', id: ID2 })).grants.find((g) => g.key === 'apiKey');
    check('installed again with the approval', (await grant2())?.state === 'granted' && await held());
    check('the user withdrawing the access on chrome://extensions answers ok', (await siteAccess('remove')) === 'ok');
    check('drops the grant', (await settle(grant2, (g) => g?.state === 'none'))?.state === 'none');
    await sleep(1500);
    await page.reload();
    await page.locator('.vx').waitFor();
    const r = await vx('vx-h', 'header');
    check('and the shim\'s keyed request is refused', r.ok === false && (r.error ?? '').includes('approve'), r);
  }

  await ctx.close();
  api.close();
  closeServer();
  fs.rmSync(work, { recursive: true, force: true });
  console.log('');
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log(`all extension vault enable checks passed (${passes})`);
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
