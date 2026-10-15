#!/usr/bin/env node
// shim — the command line for Shim shims: the
// folder ↔ .shim conversions, lint, a headless preview with a screenshot,
// launching the Shim browser, and the MCP server. The commands themselves
// are cli-commands.ts; this file parses the command line and wires them to
// the real filesystem, Playwright and launcher.
//
// Exit codes: 0 done; 1 the command ran and found a problem (lint errors, a
// preview that applied nothing or reported errors, a failed launch); 2 a
// usage error or a file it couldn't read or write.

import { parseArgs } from 'util';
import * as path from 'path';
import {
  CliError, packFolder, unpackFile, lintTarget, previewFolder, formatLint, formatPreview, type PreviewDeps,
} from './cli-commands';
import type { LaunchOutcome } from './launch';
import { VERSION } from './version';

export const USAGE = `shim — author Shim shims from the command line

Usage:
  shim pack <folder> [--out <file.shim>]
      Pack a shim folder (shim.json + handlers/) into a .shim file.
      Default: <folder>.shim. Fails on spec-lint errors.

  shim unpack <file.shim> [--out <folder>]
      Unpack a .shim file into a shim folder. Default: the file's path
      without .shim. Writes only into an empty folder or an earlier shim folder.

  shim lint <folder | file.shim> [--headless] [--json]
      spec-lint a shim folder or file. --headless also reports what headless
      mode can't run.

  shim preview <folder> --url <url> [--screenshot <file.png>] [--selector <css>]
               [--full-page] [--visible] [--storage <file.json>] [--json]
      Apply a shim folder to a page in a fresh headless Chromium and print the
      evidence: per-rule matches, handler errors, console. Needs Playwright
      (once: npm install -g playwright && playwright install chromium).

  shim launch [--timeout <seconds>] [--json]
      Attach to the running Shim browser, or start it with its control
      endpoint on.

  shim mcp [--attach | --headless] [--visible]
      Start the MCP server on stdio (what the Claude Code plugin runs). By
      default a Shim tab attaches and a url opens headless while no Shim
      browser is reachable; --attach / --headless allow one mode only.

  shim help | --help      shim version | --version
`;

/** What the commands reach outside the filesystem; a harness passes fakes. */
export interface ShimCliContext {
  out(text: string): void;
  err(text: string): void;
  launch(opts: { timeoutMs?: number }): Promise<LaunchOutcome>;
  openPreviewPage: PreviewDeps['openPage'];
  runMcp(argv: string[]): Promise<void>;
  /** The preview's settle window; default the session's. */
  previewSettleMs?: number;
}

export const EXIT_OK = 0;
export const EXIT_PROBLEM = 1;
export const EXIT_USAGE = 2;

class UsageError extends Error {}

type OptionSpec = Record<string, { type: 'string' | 'boolean'; short?: string }>;

function parse(args: string[], options: OptionSpec, positionals: { min: number; max: number; names: string }): {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
} {
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  if (parsed.positionals.length < positionals.min || parsed.positionals.length > positionals.max) {
    throw new UsageError(`expected ${positionals.names}`);
  }
  const values: Record<string, string | boolean | undefined> = {};
  for (const [k, v] of Object.entries(parsed.values)) {
    if (typeof v === 'string' || typeof v === 'boolean') values[k] = v;
  }
  return { values, positionals: parsed.positionals };
}

function str(values: Record<string, string | boolean | undefined>, key: string): string | undefined {
  const v = values[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function relative(p: string): string {
  const rel = path.relative(process.cwd(), p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}

async function run(argv: string[], ctx: ShimCliContext): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      ctx.out(USAGE);
      return command === undefined ? EXIT_USAGE : EXIT_OK;
    case 'version':
    case '--version':
    case '-v':
      ctx.out(VERSION);
      return EXIT_OK;

    case 'pack': {
      const { values, positionals } = parse(rest, { out: { type: 'string', short: 'o' } }, { min: 1, max: 1, names: 'a shim folder' });
      const dir = positionals[0] as string;
      const result = packFolder(dir, str(values, 'out'));
      const rules = result.shim.spec.rules?.length ?? 0;
      ctx.out(`packed ${relative(path.resolve(dir))} → ${relative(result.file)} (${rules} rule${rules === 1 ? '' : 's'}, ${Object.keys(result.shim.handlers).length} handler${Object.keys(result.shim.handlers).length === 1 ? '' : 's'})`);
      return EXIT_OK;
    }

    case 'unpack': {
      const { values, positionals } = parse(rest, { out: { type: 'string', short: 'o' } }, { min: 1, max: 1, names: 'a .shim file' });
      const result = unpackFile(positionals[0] as string, str(values, 'out'));
      ctx.out(`unpacked ${relative(path.resolve(positionals[0] as string))} → ${relative(result.dir)} (${result.written.length} file${result.written.length === 1 ? '' : 's'} written${result.removed.length ? `, ${result.removed.length} removed` : ''})`);
      return EXIT_OK;
    }

    case 'lint': {
      const { values, positionals } = parse(rest, { headless: { type: 'boolean' }, json: { type: 'boolean' } }, { min: 1, max: 1, names: 'a shim folder or .shim file' });
      const report = lintTarget(positionals[0] as string, { headless: values.headless === true });
      ctx.out(values.json === true ? json(report) : formatLint(report));
      return report.errors.length ? EXIT_PROBLEM : EXIT_OK;
    }

    case 'preview': {
      const { values, positionals } = parse(rest, {
        url: { type: 'string', short: 'u' },
        screenshot: { type: 'string', short: 's' },
        selector: { type: 'string' },
        'full-page': { type: 'boolean' },
        visible: { type: 'boolean' },
        storage: { type: 'string' },
        json: { type: 'boolean' },
      }, { min: 1, max: 1, names: 'a shim folder' });
      const url = str(values, 'url');
      if (!url) throw new UsageError('--url is required: the page to preview the folder on');
      const selector = str(values, 'selector');
      const screenshot = str(values, 'screenshot');
      const storage = str(values, 'storage');
      if (selector && !screenshot) throw new UsageError('--selector narrows the screenshot: pass --screenshot too');
      const outcome = await previewFolder({
        dir: positionals[0] as string,
        url,
        ...(screenshot ? { screenshot } : {}),
        ...(selector ? { selector } : {}),
        ...(values['full-page'] === true ? { fullPage: true } : {}),
        ...(values.visible === true ? { visible: true } : {}),
        ...(storage ? { storageFile: storage } : {}),
      }, {
        version: VERSION,
        openPage: ctx.openPreviewPage,
        ...(ctx.previewSettleMs !== undefined ? { settleMs: ctx.previewSettleMs } : {}),
      });
      ctx.out(values.json === true ? json(outcome) : formatPreview(outcome));
      return outcome.ok ? EXIT_OK : EXIT_PROBLEM;
    }

    case 'launch': {
      const { values } = parse(rest, { timeout: { type: 'string', short: 't' }, json: { type: 'boolean' } }, { min: 0, max: 0, names: 'no arguments' });
      const raw = str(values, 'timeout');
      let timeoutMs: number | undefined;
      if (raw !== undefined) {
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError('--timeout is a number of seconds');
        timeoutMs = Math.round(seconds * 1000);
      }
      const outcome = await ctx.launch(timeoutMs !== undefined ? { timeoutMs } : {});
      if (values.json === true) {
        // The token stays out: it is the endpoint's credential.
        const shown = outcome.ok
          ? { ok: true, how: outcome.how, detail: outcome.detail, pid: outcome.info.pid, appVersion: outcome.info.appVersion, socketPath: outcome.info.socketPath }
          : outcome;
        ctx.out(json(shown));
      } else if (outcome.ok) {
        ctx.out(`${outcome.how}: ${outcome.detail}`);
      } else {
        ctx.err(`${outcome.error}: ${outcome.detail}`);
      }
      return outcome.ok ? EXIT_OK : EXIT_PROBLEM;
    }

    case 'mcp':
      // The server's own flags (--attach, --headless, --visible), read by cliMode.
      for (const arg of rest) {
        if (arg !== '--attach' && arg !== '--headless' && arg !== '--visible') {
          throw new UsageError(`shim mcp takes --attach, --headless and --visible only (got ${arg})`);
        }
      }
      if (rest.includes('--attach') && rest.includes('--headless')) throw new UsageError('shim mcp: --attach and --headless are exclusive');
      await ctx.runMcp(rest);
      return EXIT_OK;

    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

/** Run one `shim` command line; resolves the exit code. */
export async function runShimCli(argv: string[], ctx: ShimCliContext): Promise<number> {
  try {
    return await run(argv, ctx);
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.err(`shim: ${e.message}\nRun \`shim help\` for usage.`);
      return EXIT_USAGE;
    }
    if (e instanceof CliError) {
      const problems = e.problems.map((p) => `\n  - ${p}`).join('');
      ctx.err(`shim: ${e.code}: ${e.message}${problems}`);
      return e.code === 'spec-lint' || e.code === 'malformed-shim-folder' || e.code === 'malformed-shim-file' || e.code === 'malformed-shim-state'
        ? EXIT_PROBLEM
        : EXIT_USAGE;
    }
    throw e;
  }
}

async function realContext(): Promise<ShimCliContext> {
  // Required lazily: the MCP SDK and the launcher load only for the commands
  // that use them.
  const { launchShim, runMcpServer } = await import('./mcp-main');
  const { defaultEnv } = await import('./control-client');
  const { openLoadedHeadlessPage } = await import('./playwright-launch');
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    launch: (opts) => launchShim(defaultEnv(), opts),
    async openPreviewPage(url, storage, { visible }) {
      const opened = await openLoadedHeadlessPage(url, { visible, storage });
      return {
        host: opened.host,
        close: () => opened.close(),
        async screenshot(file, { selector, fullPage }) {
          if (selector) await opened.page.locator(selector).first().screenshot({ path: file });
          else await opened.page.screenshot({ path: file, ...(fullPage ? { fullPage: true } : {}) });
        },
      };
    },
    runMcp: (argv) => runMcpServer(argv),
  };
}

if (require.main === module) {
  realContext()
    .then((ctx) => runShimCli(process.argv.slice(2), ctx))
    .then((code) => {
      process.exitCode = code;
    }, (e: unknown) => {
      console.error('shim: failed:', e);
      process.exitCode = EXIT_PROBLEM;
    });
}
