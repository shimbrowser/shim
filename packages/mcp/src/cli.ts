#!/usr/bin/env node
// shim-mcp — the stdio entry point Claude Code starts (via the plugin's
// .mcp.json). Wires the server to the real discovery file, socket, launcher
// and clock. Logs go to stderr: stdout is the MCP channel.

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createShimMcpServer } from './server';
import { defaultEnv, discoveryFilePath, readControlInfo, socketClient, type ControlInfo } from './control-client';
import { attachOrLaunch, pidAlive, type LaunchCommand } from './launch';
import { maxOutputTokens } from './results';

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

export async function main(): Promise<void> {
  const pathEnv = defaultEnv();
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
