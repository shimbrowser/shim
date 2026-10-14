#!/usr/bin/env node
// shim-mcp — the stdio entry point Claude Code starts (via the plugin's
// .mcp.json). The server bootstrap lives in mcp-main.ts, which `shim mcp`
// (shim-cli.ts) runs too.
//
//   shim-mcp               auto: a Shim tab attaches; a url opens a headless
//                          session while no Shim browser is reachable
//   shim-mcp --attach      attach mode only: drive the running Shim browser
//   shim-mcp --headless    headless mode only (shim-core design D9, D15): each
//                          session opens its own Playwright Chromium
//                          (`--visible` shows its window). Also
//                          SHIM_MCP_MODE=auto|attach|headless and
//                          SHIM_HEADLESS_VISIBLE=1.

import { runMcpServer } from './mcp-main';

export { cliMode, type CliMode } from './mcp-main';

export async function main(): Promise<void> {
  await runMcpServer(process.argv.slice(2));
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error('[shim-mcp] failed to start:', e);
    process.exit(1);
  });
}
