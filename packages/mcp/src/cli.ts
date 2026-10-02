#!/usr/bin/env node
// shim-mcp — the stdio entry point Claude Code starts (via the plugin's
// .mcp.json). Wires the server to the real discovery file, socket, launcher
// and clock. Logs go to stderr: stdout is the MCP channel.
//
//   shim-mcp               attach mode: drive the running Shim browser
//   shim-mcp --headless    headless mode (shim-core design D9, D15): no Shim
//                          browser; each session opens its own Playwright
//                          Chromium (`--visible` shows its window). Also
//                          SHIM_MCP_MODE=headless / SHIM_HEADLESS_VISIBLE=1.

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createShimMcpServer } from './server';
import { defaultEnv, discoveryFilePath, readControlInfo, socketClient, type ControlInfo } from './control-client';
import { attachOrLaunch, pidAlive, type LaunchCommand } from './launch';
import { maxOutputTokens } from './results';
import { createHeadlessControl } from './headless-control';
import { loadPlaywright, openHeadlessPage } from './playwright-launch';

// Replaced at bundle time (scripts/build.js); the package version otherwise.
declare const SHIM_MCP_VERSION: string | undefined;
const VERSION = typeof SHIM_MCP_VERSION === 'string' ? SHIM_MCP_VERSION : '0.7.0-dev';

async function ping(info: ControlInfo): Promise<boolean> {
  try {
    const reply = await socketClient(info).request('GET', '/status', undefined, { timeoutMs: 3_000 });
    return reply.body.ok === true;
  } catch {
    return false;
  }
}

function spawnDetached(cmd: LaunchCommand): void {
  const child = spawn(cmd.command, cmd.args, {
    cwd: cmd.cwd,
    detached: true,
    stdio: 'ignore',
    // npm on Windows is a .cmd shim.
    shell: process.platform === 'win32',
  });
  child.on('error', (e) => console.error(`[shim-mcp] ${cmd.command} failed: ${e.message}`));
  child.unref();
}

export interface CliMode {
  headless: boolean;
  visible: boolean;
}

/** The mode the command line and environment ask for. */
export function cliMode(argv: readonly string[], env: Record<string, string | undefined>): CliMode {
  const headless = argv.includes('--headless') || env.SHIM_MCP_MODE === 'headless';
  const visible = argv.includes('--visible') || env.SHIM_HEADLESS_VISIBLE === '1';
  return { headless, visible };
}

function playwrightAvailable(): boolean {
  try {
    loadPlaywright();
    return true;
  } catch {
    return false;
  }
}

async function mainHeadless(mode: CliMode, env: Record<string, string | undefined>): Promise<void> {
  const control = createHeadlessControl({
    version: VERSION,
    playwrightAvailable,
    // A fresh Chromium per session, never a persistent profile: headless
    // never reads the Shim browser's persist:user (invariant 10).
    async openPage(url, storage) {
      const opened = await openHeadlessPage({ visible: mode.visible, storage });
      const loaded = opened.host.waitForLoad({ timeoutMs: 30_000 });
      opened.host.reload(url);
      const outcome = await loaded;
      if (outcome.kind !== 'finished') {
        await opened.close();
        const why = outcome.kind === 'failed' ? outcome.description : outcome.kind;
        throw new Error(`${url} did not load (${why})`);
      }
      return { host: opened.host, close: () => opened.close() };
    },
  });
  const server = createShimMcpServer({
    version: VERSION,
    mode: 'headless',
    controlFile: '(headless mode: no Shim control endpoint)',
    connect: () => control,
    launch: async () => ({ ok: false, error: 'launch-unavailable', detail: 'headless mode has no Shim to launch' }),
    newCommitId: randomUUID,
    maxOutputTokens: maxOutputTokens(env),
    ...(env.SHIM_AGENT_NAME ? { agentName: env.SHIM_AGENT_NAME } : {}),
  });
  const shutdown = (): void => {
    void control.closeAll().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', shutdown);
  await server.connect(new StdioServerTransport());
}

export async function main(): Promise<void> {
  const pathEnv = defaultEnv();
  const mode = cliMode(process.argv.slice(2), pathEnv.env);
  if (mode.headless) {
    await mainHeadless(mode, pathEnv.env);
    return;
  }
  const controlFile = discoveryFilePath(pathEnv);
  const server = createShimMcpServer({
    version: VERSION,
    controlFile,
    connect: () => {
      const info = readControlInfo(controlFile);
      return info ? socketClient(info) : null;
    },
    launch: (opts) => attachOrLaunch({
      platform: pathEnv.platform,
      env: pathEnv.env,
      readInfo: () => readControlInfo(controlFile),
      isAlive: pidAlive,
      ping,
      spawn: spawnDetached,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: Date.now,
    }, opts),
    newCommitId: randomUUID,
    maxOutputTokens: maxOutputTokens(pathEnv.env),
    ...(pathEnv.env.SHIM_AGENT_NAME ? { agentName: pathEnv.env.SHIM_AGENT_NAME } : {}),
  });
  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error('[shim-mcp] failed to start:', e);
    process.exit(1);
  });
}
