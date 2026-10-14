// Starting the MCP server on stdio, in any mode — what `shim-mcp` (cli.ts,
// the plugin's .mcp.json entry) and `shim mcp` (shim-cli.ts) both run. Wires
// the server to the real discovery file, socket, launcher, Playwright and
// clock. Logs go to stderr: stdout is the MCP channel.
//
//   (no flag)      auto (modes.ts): a Shim tab attaches; a url opens a
//                  headless session while no Shim browser is reachable. What
//                  the plugin runs, so one entry serves people with Shim and
//                  people without it.
//   --attach       attach mode only: drive the running Shim browser
//   --headless     headless mode only (shim-core design D9, D15): each
//                  session opens its own Playwright Chromium
//   --visible      headless sessions show their window
//   Also SHIM_MCP_MODE=auto|attach|headless and SHIM_HEADLESS_VISIBLE=1.
//
// No entry-point guard lives here: both bundles import this module, and each
// keeps its own `require.main === module` check.

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createShimMcpServer } from './server';
import { defaultEnv, discoveryFilePath, readControlInfo, socketClient, type ControlInfo, type PathEnv } from './control-client';
import { attachOrLaunch, pidAlive, launchNeedsShell, type LaunchCommand, type LaunchExit, type LaunchOutcome, type Launched } from './launch';
import { maxOutputTokens } from './results';
import { createHeadlessControl, type HeadlessControl } from './headless-control';
import { headlessReadiness, openLoadedHeadlessPage } from './playwright-launch';
import { cliMode, probeAttach, type CliMode } from './modes';
import { VERSION } from './version';

export { cliMode, type CliMode } from './modes';

async function ping(info: ControlInfo): Promise<boolean> {
  try {
    const reply = await socketClient(info).request('GET', '/status', undefined, { timeoutMs: 3_000 });
    return reply.body.ok === true;
  } catch {
    return false;
  }
}

function spawnDetached(cmd: LaunchCommand): Launched {
  const child = spawn(cmd.command, cmd.args, {
    cwd: cmd.cwd,
    detached: true,
    stdio: 'ignore',
    shell: launchNeedsShell(cmd.command, process.platform),
  });
  let exit: LaunchExit | null = null;
  child.on('error', (e) => {
    console.error(`[shim-mcp] ${cmd.command} failed: ${e.message}`);
    exit ??= { code: null, signal: null, error: e.message };
  });
  child.on('exit', (code, signal) => { exit ??= { code, signal }; });
  child.unref();
  return { exit: () => exit };
}

/** Attach to the running Shim, or start it with its control endpoint on (launch.ts), for real. */
export function launchShim(pathEnv: PathEnv, opts: { timeoutMs?: number } = {}): Promise<LaunchOutcome> {
  const controlFile = discoveryFilePath(pathEnv);
  return attachOrLaunch({
    platform: pathEnv.platform,
    env: pathEnv.env,
    readInfo: () => readControlInfo(controlFile),
    isAlive: pidAlive,
    ping,
    spawn: spawnDetached,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
  }, opts);
}

function headlessControl(mode: CliMode): HeadlessControl {
  return createHeadlessControl({
    version: VERSION,
    playwrightAvailable: () => headlessReadiness().available,
    // A fresh Chromium per session, never a persistent profile: headless
    // never reads the Shim browser's persist:user (invariant 10).
    async openPage(url, storage) {
      const opened = await openLoadedHeadlessPage(url, { visible: mode.visible, storage });
      return { host: opened.host, close: () => opened.close() };
    },
  });
}

// Headless sessions are this process's own browsers: close them when the
// client goes away.
function closeOnExit(control: HeadlessControl): void {
  const shutdown = (): void => {
    void control.closeAll().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', shutdown);
}

async function serveHeadless(mode: CliMode, env: Record<string, string | undefined>): Promise<void> {
  const control = headlessControl(mode);
  const server = createShimMcpServer({
    version: VERSION,
    mode: 'headless',
    controlFile: '(headless mode: no Shim control endpoint)',
    connect: () => control,
    launch: async () => ({ ok: false, error: 'launch-unavailable', detail: 'headless mode has no Shim to launch' }),
    newCommitId: randomUUID,
    maxOutputTokens: maxOutputTokens(env),
    ...(env.SHIM_AGENT_NAME ? { agentName: env.SHIM_AGENT_NAME } : {}),
    headlessReadiness: () => headlessReadiness(),
  });
  closeOnExit(control);
  await server.connect(new StdioServerTransport());
}

async function serveAuto(mode: CliMode, pathEnv: PathEnv): Promise<void> {
  const controlFile = discoveryFilePath(pathEnv);
  const control = headlessControl(mode);
  const server = createShimMcpServer({
    version: VERSION,
    mode: 'auto',
    controlFile,
    // Attach only to a Shim that is there: a discovery file naming a dead
    // process (Shim crashed) is no endpoint.
    connect: () => {
      const info = readControlInfo(controlFile);
      return info && pidAlive(info.pid) ? socketClient(info) : null;
    },
    headlessControl: control,
    probeAttach: () => probeAttach(controlFile, readControlInfo, pidAlive),
    headlessReadiness: () => headlessReadiness(),
    launch: (opts) => launchShim(pathEnv, opts),
    newCommitId: randomUUID,
    maxOutputTokens: maxOutputTokens(pathEnv.env),
    ...(pathEnv.env.SHIM_AGENT_NAME ? { agentName: pathEnv.env.SHIM_AGENT_NAME } : {}),
  });
  closeOnExit(control);
  await server.connect(new StdioServerTransport());
}

/** Start the MCP server on stdio. Resolves once it is connected; it then runs until stdin closes. */
export async function runMcpServer(argv: readonly string[]): Promise<void> {
  const pathEnv = defaultEnv();
  const mode = cliMode(argv, pathEnv.env);
  if (mode.mode === 'headless') {
    await serveHeadless(mode, pathEnv.env);
    return;
  }
  if (mode.mode === 'auto') {
    await serveAuto(mode, pathEnv);
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
    launch: (opts) => launchShim(pathEnv, opts),
    newCommitId: randomUUID,
    maxOutputTokens: maxOutputTokens(pathEnv.env),
    ...(pathEnv.env.SHIM_AGENT_NAME ? { agentName: pathEnv.env.SHIM_AGENT_NAME } : {}),
  });
  await server.connect(new StdioServerTransport());
}
