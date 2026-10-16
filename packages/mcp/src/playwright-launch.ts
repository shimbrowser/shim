// Opening a page for the headless PageHost. Playwright
// is an OPTIONAL peer dependency of @shimbrowser/mcp: attach mode (driving the
// Shim browser) never loads it, so it is required lazily here, only when a
// headless page is asked for, and a missing install is a readable error.
//
// Chromium only: the driver depends on CDP isolated worlds.

import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import * as path from 'path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { attachPlaywrightPageHost } from './playwright-page-host';
import type { PlaywrightPageHost, PlaywrightPageHostOptions } from './playwright-page-host';
import type { PageLoadOutcome } from '@shimbrowser/core/page-host';

/** The one-time install that makes headless mode work anywhere (a global install is searched, see playwrightSearchDirs). */
export const PLAYWRIGHT_INSTALL_COMMAND = 'npm install -g playwright && playwright install chromium';
/** The same, local to a project (found through the working directory or CLAUDE_PROJECT_DIR). */
export const PLAYWRIGHT_PROJECT_INSTALL_COMMAND = 'npm install -D playwright && npx playwright install chromium';

export const PLAYWRIGHT_MISSING =
  'Headless mode needs Playwright, which downloads its own Chromium (Shim does not bundle one), and it was not found. ' +
  `Install it once: \`${PLAYWRIGHT_INSTALL_COMMAND}\`. Or in your project: \`${PLAYWRIGHT_PROJECT_INSTALL_COMMAND}\`. ` +
  'Or point SHIM_PLAYWRIGHT_DIR at a folder whose node_modules has it.';

/** Why headless mode can't open a page right now, with the command that fixes it. */
export type HeadlessProblem = 'playwright-missing' | 'chromium-missing' | 'system-deps-missing';

export class HeadlessUnavailableError extends Error {
  readonly code: HeadlessProblem;
  /** The exact command that fixes it. */
  readonly install: string;
  constructor(code: HeadlessProblem, message: string, install: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HeadlessUnavailableError';
    this.code = code;
    this.install = install;
  }
}

export interface HeadlessLaunchOptions extends PlaywrightPageHostOptions {
  /** Show the browser window (the default is headless). */
  visible?: boolean;
  /** The page's viewport in CSS px. Default 1280×800. */
  viewport?: { width: number; height: number };
  /** Navigate here once the host is attached; a load that does not finish rejects (and closes the browser). */
  url?: string;
}

export interface HeadlessPage {
  host: PlaywrightPageHost;
  page: Page;
  /** Detach the host and close the browser. */
  close(): Promise<void>;
}

type PlaywrightModule = typeof import('playwright');

const INITIAL_LOAD_TIMEOUT_MS = 30_000;

/** A non-finished load outcome as a reason a person can act on. */
export function describeLoadFailure(outcome: Exclude<PageLoadOutcome, { kind: 'finished' }>): string {
  switch (outcome.kind) {
    case 'failed': return `${outcome.description || 'load failed'} (${outcome.code})`;
    case 'timed-out': return `timed out after ${INITIAL_LOAD_TIMEOUT_MS / 1000}s`;
    case 'aborted': return 'the load was aborted';
    case 'destroyed': return 'the page closed while loading';
  }
}

/** A `require` bound to one folder: loads a module, and (a real one) says where it is. */
export interface ModuleLoader {
  (id: string): unknown;
  resolve?(id: string): string;
}

/** A `require` that resolves from `dir`, or `null` for this module's own. */
export type RequireFrom = (dir: string | null) => ModuleLoader;

const defaultRequireFrom: RequireFrom = (dir) => (dir === null ? require : createRequire(path.join(path.resolve(dir), 'package.json')));

/**
 * Folders whose `node_modules` a global npm install lands in, derived without
 * running anything: npm's configured prefix, then the prefix of the node that
 * runs this (nvm, the official installers, most package managers put global
 * packages beside their node). `<prefix>/lib/node_modules` on POSIX,
 * `<prefix>/node_modules` on Windows.
 */
export function globalPrefixDirs(env: Record<string, string | undefined>, execPath: string, platform: string): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const forPrefix = (prefix: string): string => (platform === 'win32' ? prefix : p.join(prefix, 'lib'));
  const out: string[] = [];
  const prefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX;
  if (prefix) out.push(forPrefix(prefix));
  const nodePrefix = platform === 'win32' ? p.dirname(execPath) : p.dirname(p.dirname(execPath));
  const derived = forPrefix(nodePrefix);
  if (!out.includes(derived)) out.push(derived);
  return out;
}

/**
 * Where Playwright is looked for, in order. The Claude Code plugin runs the
 * bundle from the plugin cache, where a plain `require` walks the cache's
 * ancestors (the plugin's own folder included), never the user's project, so
 * the caller's installs are searched too: SHIM_PLAYWRIGHT_DIR first
 * (explicit), then this module's own resolution (a normal npm install of the
 * package, the plugin folder, and NODE_PATH), then the working directory and
 * CLAUDE_PROJECT_DIR (the project Claude Code runs in), then a global install
 * (globalPrefixDirs). `npm root -g` is asked last, by loadPlaywright, only
 * when all of these miss.
 */
export function playwrightSearchDirs(
  env: Record<string, string | undefined>,
  cwd: string,
  global: readonly string[] = [],
): Array<string | null> {
  const dirs: Array<string | null> = [];
  const add = (d: string | null): void => {
    if (d === null ? !dirs.includes(null) : !dirs.some((x) => x !== null && path.resolve(x) === path.resolve(d))) dirs.push(d);
  };
  if (env.SHIM_PLAYWRIGHT_DIR) add(env.SHIM_PLAYWRIGHT_DIR);
  add(null);
  add(cwd);
  if (env.CLAUDE_PROJECT_DIR) add(env.CLAUDE_PROJECT_DIR);
  for (const g of global) add(g);
  return dirs;
}

let npmRootCache: { value: string | null } | null = null;

/** `npm root -g`'s parent (the folder whose node_modules it is), asked once per process; null when npm can't say. */
export function npmGlobalDir(): string | null {
  if (npmRootCache) return npmRootCache.value;
  let value: string | null = null;
  try {
    const out = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 10_000, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
    const root = out.status === 0 ? out.stdout.trim() : '';
    if (root) value = path.dirname(root);
  } catch {
    value = null;
  }
  npmRootCache = { value };
  return value;
}

export interface LoadPlaywrightOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  requireFrom?: RequireFrom;
  /** The global install folders searched after the project (default: globalPrefixDirs for this node). */
  globalDirs?: readonly string[];
  /** Asked when every other place misses (default: npmGlobalDir). */
  npmGlobalDir?: () => string | null;
}

export interface FoundPlaywright {
  module: PlaywrightModule;
  /** The playwright package folder, when the loader could say. */
  packageDir: string | null;
}

/** The command that downloads the Chromium the Playwright found at `packageDir` drives (its own CLI, so the versions match). */
export function chromiumInstallCommand(packageDir: string | null): string {
  return packageDir ? `node "${path.join(packageDir, 'cli.js')}" install chromium` : 'npx playwright install chromium';
}

/** The command that installs the system libraries Chromium needs (Linux), from the same Playwright CLI. */
export function systemDepsInstallCommand(packageDir: string | null): string {
  return packageDir ? `node "${path.join(packageDir, 'cli.js')}" install-deps chromium` : 'npx playwright install-deps chromium';
}

/** Find Playwright in the first place that has it, or throw a HeadlessUnavailableError (playwright-missing). */
export function locatePlaywright(options: LoadPlaywrightOptions = {}): FoundPlaywright {
  const requireFrom = options.requireFrom ?? defaultRequireFrom;
  const env = options.env ?? process.env;
  const globalDirs = options.globalDirs ?? globalPrefixDirs(env, process.execPath, process.platform);
  const dirs = playwrightSearchDirs(env, options.cwd ?? process.cwd(), globalDirs);
  const errors: unknown[] = [];
  const tryDir = (dir: string | null): FoundPlaywright | null => {
    try {
      const loader = requireFrom(dir);
      const module = loader('playwright') as PlaywrightModule;
      let packageDir: string | null = null;
      try {
        packageDir = loader.resolve ? path.dirname(loader.resolve('playwright/package.json')) : null;
      } catch {
        packageDir = null;
      }
      return { module, packageDir };
    } catch (err) {
      errors.push(err);
      return null;
    }
  };
  for (const dir of dirs) {
    const found = tryDir(dir);
    if (found) return found;
  }
  const npmDir = (options.npmGlobalDir ?? npmGlobalDir)();
  if (npmDir !== null && !dirs.some((d) => d !== null && path.resolve(d) === path.resolve(npmDir))) {
    const found = tryDir(npmDir);
    if (found) return found;
  }
  throw new HeadlessUnavailableError('playwright-missing', PLAYWRIGHT_MISSING, PLAYWRIGHT_INSTALL_COMMAND, {
    cause: new AggregateError(errors, 'playwright was not found'),
  });
}

let found: FoundPlaywright | null = null;

/** Load Playwright from the first place that has it, or throw PLAYWRIGHT_MISSING (a HeadlessUnavailableError). */
export function loadPlaywright(options: LoadPlaywrightOptions = {}): PlaywrightModule {
  return locatePlaywright(options).module;
}

/** This process's Playwright, found once (a miss is looked for again next time: the user may have installed it since). */
function processPlaywright(): FoundPlaywright {
  found ??= locatePlaywright();
  return found;
}

/** Whether headless mode can open a page, and if not, the command that fixes it. Chromium itself is checked when a page opens. */
export type HeadlessReadiness =
  | { available: true; playwright: string }
  | { available: false; error: HeadlessProblem; reason: string; install: string };

export function headlessReadiness(locate: () => FoundPlaywright = processPlaywright): HeadlessReadiness {
  try {
    const pw = locate();
    return { available: true, playwright: pw.packageDir ?? 'found' };
  } catch (err) {
    if (err instanceof HeadlessUnavailableError) return { available: false, error: err.code, reason: err.message, install: err.install };
    throw err;
  }
}

// Playwright's own wording for a downloaded browser whose host libraries are
// missing (Linux). Checked first: its message also says `playwright install-deps`,
// which the download pattern below must not claim.
const MISSING_SYSTEM_DEPS = /Host system is missing dependencies|playwright install-deps/i;
// Playwright's own wording for a browser that was never downloaded.
const MISSING_BROWSER = /Executable doesn't exist|playwright install(?!-deps)|browserType\.launch: .*not found/i;

/**
 * A launch failure as what to do about it: missing host libraries are
 * system-deps-missing and a missing download chromium-missing, each with the
 * command that fixes it; anything else stays an error.
 */
export function launchFailure(err: unknown, packageDir: string | null): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (MISSING_SYSTEM_DEPS.test(message)) {
    const install = systemDepsInstallCommand(packageDir);
    return new HeadlessUnavailableError(
      'system-deps-missing',
      `Chromium is downloaded but this system is missing libraries it needs: run \`${install}\` (it may need sudo).`,
      install,
      { cause: err },
    );
  }
  if (MISSING_BROWSER.test(message)) {
    const install = chromiumInstallCommand(packageDir);
    return new HeadlessUnavailableError(
      'chromium-missing',
      `Playwright is installed${packageDir ? ` (${packageDir})` : ''} but the Chromium it drives is not downloaded: run \`${install}\`. ` +
      'Shim does not bundle Chromium.',
      install,
      { cause: err },
    );
  }
  return new Error(`Chromium failed to launch: ${message.split('\n')[0] ?? message}`, { cause: err });
}

/** Launch Chromium, open one page, attach the headless PageHost to it. */
export async function openHeadlessPage(options: HeadlessLaunchOptions = {}): Promise<HeadlessPage> {
  const pw = processPlaywright();
  let browser: Browser;
  try {
    browser = await pw.module.chromium.launch({ headless: options.visible !== true });
  } catch (err) {
    throw launchFailure(err, pw.packageDir);
  }
  try {
    const context: BrowserContext = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 800 } });
    const page = await context.newPage();
    const host = await attachPlaywrightPageHost(page, options);
    if (options.url) {
      const loaded = host.waitForLoad({ timeoutMs: INITIAL_LOAD_TIMEOUT_MS });
      host.reload(options.url);
      const outcome = await loaded;
      // A page that never loaded is not ready: authoring against Chromium's
      // error document, or a navigation still in flight, gives misleading
      // inspection and preview results.
      if (outcome.kind !== 'finished') throw new Error(`${options.url} did not load: ${describeLoadFailure(outcome)}`);
    }
    return {
      host,
      page,
      async close() {
        await host.detach();
        await browser.close().catch(() => undefined);
      },
    };
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}

/**
 * A fresh page that has loaded `url`, or a throw saying why it didn't. What
 * a headless session (and `shim preview`) opens: a new Chromium each time,
 * never a persistent profile (invariant 10).
 */
export function openLoadedHeadlessPage(url: string, options: Omit<HeadlessLaunchOptions, 'url'> = {}): Promise<HeadlessPage> {
  return openHeadlessPage({ ...options, url });
}
