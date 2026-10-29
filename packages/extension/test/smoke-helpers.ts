// What the real-browser harnesses share (extension-smoke-harness.ts,
// extension-full-mode-harness.ts): the built extension copied with the
// fixture host granted up front (Chrome's permission prompt is browser UI
// a script cannot click; everything else is the shipped code), the
// conformance fixture site on a loopback port, `.shim` files, a persistent
// Chromium profile with the extension loaded, its worker, the install page
// driven the way a user drives it, and the chrome://extensions WebUI's own
// configuration call (site access, user scripts), which fires the same
// events a user's click does.

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { conformanceFixture, type FixtureDeploy } from '@shimbrowser/core/page-host-conformance';

export const REPO = path.resolve(__dirname, '..', '..', '..', '..');
export const DIST = path.join(REPO, 'packages', 'extension', 'dist');

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function workDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** dist/ copied into `work`, with `hostPermissions` granted in the manifest. Throws when nothing is built. */
export function extensionCopy(work: string, hostPermissions: string[]): string {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) throw new Error(`no built extension at ${DIST} (npm run build)`);
  const ext = path.join(work, 'ext');
  fs.cpSync(DIST, ext, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  manifest.host_permissions = hostPermissions;
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return ext;
}

/**
 * The conformance fixture site: /apply (style-src allows inline), /strict
 * (style-src 'self'), /deploy (its markup moves with `setDeploy`). Plus two
 * pages the settings and fetch checks use: /settings-fixture (a `#cfg`
 * target) and /fixture-data.json (JSON that says whether a cookie came with
 * the request, so a check can see api.fetch is cookie-less). The data allows
 * cross-origin reads: api.fetch refuses the loopback host, so a check reaches
 * it as FIXTURE_ALIAS (see launch), a host the extension holds no access to,
 * where CORS decides.
 */
export async function fixtureServer(): Promise<{ origin: string; setDeploy(deploy: FixtureDeploy): void; close(): void }> {
  const state = { deploy: 1 as FixtureDeploy };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    if (pathname === '/fixture-data.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ answer: 42, sawCookie: typeof req.headers.cookie === 'string' && req.headers.cookie !== '' }));
      return;
    }
    if (pathname === '/fixture-private.json') {
      // No cross-origin headers: readable only where the extension skips CORS.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ private: true }));
      return;
    }
    if (pathname === '/settings-fixture') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>settings fixture</title><div id="cfg"></div>');
      return;
    }
    const r = conformanceFixture(pathname, state);
    res.writeHead(r.status, { 'content-type': r.contentType, ...r.headers });
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    setDeploy: (deploy) => { state.deploy = deploy; },
    close: () => server.close(),
  };
}

export type ShimFileWriter = (id: string, name: string, rules: unknown[], extra?: Record<string, unknown>, handlers?: Record<string, string>) => string;

/** A `.shim` file for the fixture host, written into `work`. */
export function shimWriter(work: string): ShimFileWriter {
  return (id, name, rules, extra = {}, handlers = {}) => {
    const file = path.join(work, `${id}.shim`);
    fs.writeFileSync(file, JSON.stringify({ format: 'shim/1', name, spec: { id, version: 1, match: { hosts: ['127.0.0.1'] }, rules, ...extra }, handlers }));
    return file;
  };
}

export const css = (selector: string): { primary: { kind: 'css'; value: string } } => ({ primary: { kind: 'css', value: selector } });

/**
 * A name that resolves to the fixture server inside the launched browser:
 * a public-looking host for api.fetch to reach (it refuses loopback), and
 * one the extension holds no access to.
 */
export const FIXTURE_ALIAS = 'shim-fixture.test';
/** A shim's own site for the fetch-reach check (grant it with extensionCopy). */
export const FIXTURE_OWN = 'shim-own.test';
/** A site the extension holds for another shim (grant it with extensionCopy). */
export const FIXTURE_HELD = 'shim-held.test';

/**
 * A persistent profile with the extension loaded: the toggle on chrome://extensions and the store survive a relaunch of it.
 * `extra.hosts` resolve to loopback beside the fixture names; `extra.args` are more Chromium switches.
 */
export function launch(ext: string, profile: string, extra: { hosts?: string[]; args?: string[] } = {}): Promise<BrowserContext> {
  const executablePath = process.env.SHIM_CHROME_EXECUTABLE;
  return chromium.launchPersistentContext(profile, {
    headless: true,
    // SHIM_CHROME_EXECUTABLE runs a harness on another build (CI's minimum-Chrome job: Chrome for
    // Testing at the manifest's minimum_chrome_version); otherwise Playwright's own Chromium.
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
      `--host-resolver-rules=${[FIXTURE_ALIAS, FIXTURE_OWN, FIXTURE_HELD, ...(extra.hosts ?? [])].map((h) => `MAP ${h} 127.0.0.1`).join(',')}`,
      ...(extra.args ?? [])],
  });
}

export async function workerOf(ctx: BrowserContext): Promise<{ worker: Worker; extId: string }> {
  let sw: Worker | undefined = ctx.serviceWorkers()[0];
  sw ??= await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  return { worker: sw, extId: new URL(sw.url()).host };
}

export interface Installer {
  /** Open the install page, give it `file`, and answer the review heading. The page stays open. */
  install(file: string): Promise<{ page: Page; heading: string }>;
  /** Install `file` to the end, through the page's own button. */
  installAll(file: string): Promise<void>;
}

export function installer(ctx: BrowserContext, extId: string): Installer {
  const install = async (file: string): Promise<{ page: Page; heading: string }> => {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/install.html`);
    await page.setInputFiles('#file', file);
    await page.waitForSelector('#review:not([hidden]) h2');
    const heading = (await page.textContent('#review h2')) ?? '';
    return { page, heading };
  };
  const installAll = async (file: string): Promise<void> => {
    const { page, heading } = await install(file);
    if (!heading.startsWith('ready to install')) throw new Error(`not ready: ${heading}`);
    await page.click('#review button.primary');
    await page.waitForSelector('#result:not([hidden]) h2', { timeout: 15000 });
    await page.close();
  };
  return { install, installAll };
}

/**
 * One call on the chrome://extensions WebUI's own API, the one its toggles
 * make: `{ hostAccess: 'ON_CLICK' | 'ON_ALL_SITES' }` withholds or grants
 * every host (permissions.onRemoved / onAdded), `{ userScriptsAccess }` is
 * the "Allow user scripts" toggle (it persists; a relaunch of the profile
 * applies it). Answers 'ok' or the error.
 */
export async function configureExtension(ctx: BrowserContext, extId: string, config: Record<string, unknown>): Promise<string> {
  const settings = await ctx.newPage();
  try {
    await settings.goto(`chrome://extensions/?id=${extId}`);
    return await settings.evaluate(([id, cfg]) => new Promise<string>((resolve) => {
      type Dev = {
        updateExtensionConfiguration(cfg: object, cb: () => void): void;
        updateProfileConfiguration(cfg: object, cb: () => void): void;
      };
      const api = (globalThis as { chrome?: { developerPrivate?: Dev; runtime?: { lastError?: { message: string } } } }).chrome;
      if (!api?.developerPrivate) { resolve('no developerPrivate'); return; }
      const dev = api.developerPrivate;
      const answer = (): void => resolve(api.runtime?.lastError ? `err: ${api.runtime.lastError.message}` : 'ok');
      // Before Chrome 138 user scripts follow Developer mode, not a per-extension toggle.
      const major = Number(/Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? '0');
      if (major > 0 && major < 138 && 'userScriptsAccess' in cfg) {
        const { userScriptsAccess, ...rest } = cfg as { userScriptsAccess: unknown };
        dev.updateProfileConfiguration({ inDeveloperMode: userScriptsAccess === true }, () => {
          if (api.runtime?.lastError || Object.keys(rest).length === 0) { answer(); return; }
          dev.updateExtensionConfiguration({ extensionId: id, ...rest }, answer);
        });
        return;
      }
      dev.updateExtensionConfiguration({ extensionId: id, ...cfg }, answer);
    }), [extId, config] as const);
  } finally {
    await settings.close();
  }
}

/**
 * Disable or enable the extension the way the chrome://extensions toggle
 * does (chrome.management from that page). Disabling orphans every open
 * document's runtime (its chrome.runtime is invalidated, as after a reload
 * or an update); enabling boots a fresh instance.
 */
export async function setExtensionEnabled(ctx: BrowserContext, extId: string, enabled: boolean): Promise<string> {
  const settings = await ctx.newPage();
  try {
    await settings.goto('chrome://extensions/');
    return await settings.evaluate(([id, on]) => new Promise<string>((resolve) => {
      const api = (globalThis as { chrome?: { management?: { setEnabled(id: string, on: boolean, cb: () => void): void }; runtime?: { lastError?: { message: string } } } }).chrome;
      if (!api?.management) { resolve('no management'); return; }
      api.management.setEnabled(id, on, () => resolve(api.runtime?.lastError ? `err: ${api.runtime.lastError.message}` : 'ok'));
    }), [extId, enabled] as const);
  } finally {
    await settings.close();
  }
}

export async function popupOf(ctx: BrowserContext, extId: string): Promise<Page> {
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('#mode:not(:empty)');
  return popup;
}

/** Poll `read` until `want` holds or the deadline passes; answers the last reading. */
export async function settle<T>(read: () => Promise<T>, want: (value: T) => boolean, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (Date.now() < deadline && !want(value)) { await sleep(150); value = await read(); }
  return value;
}
