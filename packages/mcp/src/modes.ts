// Which mode the MCP server runs in, and whether each mode can be used right
// now. Pure: the probes take their reads as
// arguments, so a harness drives them without a Shim or a Playwright.
//
//   auto (default)  one server for both: a session on a Shim tab (tabId)
//                   attaches; a session on a url runs headless while no Shim
//                   browser is reachable. Never switches silently: a url
//                   while Shim IS reachable is refused unless the call asks
//                   for headless, and every open answer names its mode.
//   attach          only the running Shim browser (--attach, or
//                   SHIM_MCP_MODE=attach): the earlier default.
//   headless        only a Playwright Chromium per session (--headless, or
//                   SHIM_MCP_MODE=headless).

import type { ControlInfo } from './control-client';

export type ServerMode = 'auto' | 'attach' | 'headless';
export type SessionMode = 'attach' | 'headless';
/**
 * The two hosts an attach session can run against: the Shim browser
 * (control.json) and Shim for Chrome's bridge (control-chrome.json). Their
 * tab numbers are separate spaces, so a session is pinned to the host that
 * opened it and never falls through to the other.
 */
export type AttachHost = 'shim' | 'chrome';

export interface CliMode {
  mode: ServerMode;
  /** Headless sessions show their Chromium window. */
  visible: boolean;
  /** `--target shim|chrome` (SHIM_MCP_TARGET): the attach host every open goes to unless the call names one. */
  target?: AttachHost;
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
  const target = cliTarget(argv, env);
  const withTarget = (mode: ServerMode): CliMode => ({ mode, visible, ...(target !== undefined ? { target } : {}) });
  if (attachFlag) return withTarget('attach');
  if (headlessFlag) return withTarget('headless');
  const fromEnv = (env.SHIM_MCP_MODE ?? '').trim().toLowerCase();
  if (fromEnv === '' || fromEnv === 'auto') return withTarget('auto');
  if (fromEnv === 'attach' || fromEnv === 'headless') return withTarget(fromEnv);
  throw new ModeError(`SHIM_MCP_MODE must be auto, attach or headless (got "${env.SHIM_MCP_MODE ?? ''}")`);
}

function cliTarget(argv: readonly string[], env: Record<string, string | undefined>): AttachHost | undefined {
  const i = argv.indexOf('--target');
  const raw = i >= 0 ? argv[i + 1] : env.SHIM_MCP_TARGET;
  if (raw === undefined || raw === '') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'shim' || v === 'chrome') return v;
  throw new ModeError(`--target (SHIM_MCP_TARGET) must be shim or chrome (got "${raw}")`);
}

/** Which attach host a new session goes to, or why none can be chosen. Pure. */
export type HostChoice = { ok: true; host: AttachHost; why: string } | { ok: false; error: string; detail: string };

export function pickAttachHost(args: {
  /** The open's own `target`. */
  requested?: AttachHost;
  /** The server's `--target`. */
  defaultTarget?: AttachHost;
  /** Which hosts are reachable now. */
  reachable: Record<AttachHost, boolean>;
  /** The hosts whose last tab listing carried the open's tab number; empty for a url, a composition, or a number nobody listed. */
  listedBy: readonly AttachHost[];
  /** A url target: both reachable is a refusal, never a silent choice. */
  url: boolean;
  /** A composition: only the Shim browser runs them. */
  composition: boolean;
}): HostChoice {
  const names: Record<AttachHost, string> = { shim: 'the Shim browser', chrome: 'Shim for Chrome' };
  const pinned = args.requested ?? args.defaultTarget;
  if (args.composition) {
    if (pinned === 'chrome') return { ok: false, error: 'requires-shim-browser', detail: 'compositions run only in the Shim browser: pass target "shim", or leave it out' };
    return { ok: true, host: 'shim', why: 'the Shim browser, where compositions run' };
  }
  if (pinned !== undefined) {
    if (!args.reachable[pinned]) return { ok: false, error: 'shim-not-running', detail: `${names[pinned]} is not reachable (target "${pinned}")` };
    return { ok: true, host: pinned, why: `${names[pinned]}, as the ${args.requested !== undefined ? 'call' : 'server'} asked (target "${pinned}")` };
  }
  const up = (['shim', 'chrome'] as const).filter((h) => args.reachable[h]);
  if (up.length === 0) return { ok: false, error: 'shim-not-running', detail: 'neither the Shim browser nor Shim for Chrome is reachable' };
  if (up.length === 1) {
    const host = up[0] as AttachHost;
    return { ok: true, host, why: `${names[host]}, the one host reachable` };
  }
  if (args.url) {
    return { ok: false, error: 'multiple-targets', detail: 'both the Shim browser and Shim for Chrome are reachable: pass target "shim" or "chrome" to say which opens the url' };
  }
  const listed = [...new Set(args.listedBy)];
  if (listed.length === 1) {
    const host = listed[0] as AttachHost;
    return { ok: true, host, why: `${names[host]}, whose tab list carried this tabId` };
  }
  return {
    ok: false,
    error: 'ambiguous-target',
    detail: listed.length === 0
      ? 'both the Shim browser and Shim for Chrome are reachable and neither listed this tabId: call shim_list_tabs, then pass target "shim" or "chrome"'
      : 'both the Shim browser and Shim for Chrome list a tab with this number: pass target "shim" or "chrome"',
  };
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
