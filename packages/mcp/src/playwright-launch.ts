// Opening a page for the headless PageHost (shim-core design D9). Playwright
// is an OPTIONAL peer dependency of @shimbrowser/mcp: attach mode (driving the
// Shim browser) never loads it, so it is required lazily here, only when a
// headless page is asked for, and a missing install is a readable error.
//
// Chromium only: the driver depends on CDP isolated worlds.

import { createRequire } from 'module';
import * as path from 'path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { attachPlaywrightPageHost } from './playwright-page-host';
import type { PlaywrightPageHost, PlaywrightPageHostOptions } from './playwright-page-host';
import type { PageLoadOutcome } from '@shimbrowser/core/page-host';

export const PLAYWRIGHT_MISSING =
  'Headless mode needs Playwright with Chromium: run `npm install playwright` and `npx playwright install chromium` ' +
  'in your project (or point SHIM_PLAYWRIGHT_DIR at the folder whose node_modules has it).';

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

/** A `require` that resolves from `dir`, or `null` for this module's own. */
export type RequireFrom = (dir: string | null) => (id: string) => unknown;

const defaultRequireFrom: RequireFrom = (dir) => (dir === null ? require : createRequire(path.join(path.resolve(dir), 'package.json')));

/**
 * Where Playwright is looked for, in order. The Claude Code plugin runs the
 * bundle from the plugin cache, where a plain `require` walks the cache's
 * ancestors, never the user's project, so the caller's install is searched
 * too: SHIM_PLAYWRIGHT_DIR first (explicit), then this module's own
 * resolution (a normal npm install of the package), then the working
 * directory and CLAUDE_PROJECT_DIR (the project Claude Code runs in).
 */
export function playwrightSearchDirs(env: Record<string, string | undefined>, cwd: string): Array<string | null> {
  const dirs: Array<string | null> = [];
  const add = (d: string | null): void => {
    if (d === null ? !dirs.includes(null) : !dirs.some((x) => x !== null && path.resolve(x) === path.resolve(d))) dirs.push(d);
  };
  if (env.SHIM_PLAYWRIGHT_DIR) add(env.SHIM_PLAYWRIGHT_DIR);
  add(null);
  add(cwd);
  if (env.CLAUDE_PROJECT_DIR) add(env.CLAUDE_PROJECT_DIR);
  return dirs;
}

/** Load Playwright from the first place that has it, or throw PLAYWRIGHT_MISSING. */
export function loadPlaywright(
  options: { env?: Record<string, string | undefined>; cwd?: string; requireFrom?: RequireFrom } = {},
): PlaywrightModule {
  const requireFrom = options.requireFrom ?? defaultRequireFrom;
  const dirs = playwrightSearchDirs(options.env ?? process.env, options.cwd ?? process.cwd());
  const errors: unknown[] = [];
  for (const dir of dirs) {
    try {
      return requireFrom(dir)('playwright') as PlaywrightModule;
    } catch (err) {
      errors.push(err);
    }
  }
  throw new Error(PLAYWRIGHT_MISSING, { cause: new AggregateError(errors, 'playwright was not found') });
}

/** Launch Chromium, open one page, attach the headless PageHost to it. */
export async function openHeadlessPage(options: HeadlessLaunchOptions = {}): Promise<HeadlessPage> {
  const { chromium } = loadPlaywright();
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: options.visible !== true });
  } catch (err) {
    throw new Error(`${PLAYWRIGHT_MISSING} (${err instanceof Error ? err.message : String(err)})`, { cause: err });
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
export async function openLoadedHeadlessPage(url: string, options: Omit<HeadlessLaunchOptions, 'url'> = {}): Promise<HeadlessPage> {
  const opened = await openHeadlessPage(options);
  const loaded = opened.host.waitForLoad({ timeoutMs: 30_000 });
  opened.host.reload(url);
  const outcome = await loaded;
  if (outcome.kind !== 'finished') {
    await opened.close();
    const why = outcome.kind === 'failed' ? outcome.description : outcome.kind;
    throw new Error(`${url} did not load (${why})`);
  }
  return opened;
}
