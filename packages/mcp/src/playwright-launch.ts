// Opening a page for the headless PageHost (shim-core design D9). Playwright
// is an OPTIONAL peer dependency of @shimbrowser/mcp: attach mode (driving the
// Shim browser) never loads it, so it is required lazily here, only when a
// headless page is asked for, and a missing install is a readable error.
//
// Chromium only: the driver depends on CDP isolated worlds.

import type { Browser, BrowserContext, Page } from 'playwright';
import { attachPlaywrightPageHost } from './playwright-page-host';
import type { PlaywrightPageHost, PlaywrightPageHostOptions } from './playwright-page-host';
import type { PageLoadOutcome } from '@shimbrowser/core/page-host';

export const PLAYWRIGHT_MISSING =
  'Headless mode needs Playwright with Chromium: run `npm install playwright` and `npx playwright install chromium`.';

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

/** Load Playwright, or throw PLAYWRIGHT_MISSING. */
export function loadPlaywright(): PlaywrightModule {
  try {
    return require('playwright') as PlaywrightModule;
  } catch (err) {
    throw new Error(PLAYWRIGHT_MISSING, { cause: err });
  }
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
