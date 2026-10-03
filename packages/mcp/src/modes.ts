// Which mode the MCP server runs in, and whether each mode can be used right
// now (shim-core design D9, D15; C5). Pure: the probes take their reads as
// arguments, so a harness drives them without a Shim or a Playwright.
//
//   auto (default)  one server for both: a session on a Shim tab (tabId)
//                   attaches; a session on a url runs headless while no Shim
//                   browser is reachable. Never switches silently: a url
//                   while Shim IS reachable is refused unless the call asks
//                   for headless, and every open answer names its mode.
//   attach          only the running Shim browser (--attach, or
//                   SHIM_MCP_MODE=attach): the pre-C5 default.
//   headless        only a Playwright Chromium per session (--headless, or
//                   SHIM_MCP_MODE=headless).

import type { ControlInfo } from './control-client';

export type ServerMode = 'auto' | 'attach' | 'headless';
export type SessionMode = 'attach' | 'headless';

export interface CliMode {
  mode: ServerMode;
  /** Headless sessions show their Chromium window. */
  visible: boolean;
}

export class ModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModeError';
  }
}

/** The mode the command line and environment ask for. A flag beats the environment; two mode flags are an error. */
export function cliMode(argv: readonly string[], env: Record<string, string | undefined>): CliMode {
  const visible = argv.includes('--visible') || env.SHIM_HEADLESS_VISIBLE === '1';
  const attachFlag = argv.includes('--attach');
  const headlessFlag = argv.includes('--headless');
  if (attachFlag && headlessFlag) throw new ModeError('--attach and --headless are exclusive: pass one, or neither for auto');
  if (attachFlag) return { mode: 'attach', visible };
  if (headlessFlag) return { mode: 'headless', visible };
  const fromEnv = (env.SHIM_MCP_MODE ?? '').trim().toLowerCase();
  if (fromEnv === '' || fromEnv === 'auto') return { mode: 'auto', visible };
  if (fromEnv === 'attach' || fromEnv === 'headless') return { mode: fromEnv, visible };
  throw new ModeError(`SHIM_MCP_MODE must be auto, attach or headless (got "${env.SHIM_MCP_MODE ?? ''}")`);
}

/** Whether a Shim browser is there to attach to: the discovery file names a live process. */
export type AttachProbe =
  | { reachable: true; info: ControlInfo }
  | { reachable: false; reason: string };

export function probeAttach(
  controlFile: string,
  readInfo: (file: string) => ControlInfo | null,
  isAlive: (pid: number) => boolean,
): AttachProbe {
  const info = readInfo(controlFile);
  if (!info) {
    return { reachable: false, reason: `no Shim browser is running with its control endpoint on (no discovery file at ${controlFile})` };
  }
  if (!isAlive(info.pid)) {
    return { reachable: false, reason: `the discovery file ${controlFile} names process ${info.pid}, which is not running (Shim quit without cleaning up)` };
  }
  return { reachable: true, info };
}
