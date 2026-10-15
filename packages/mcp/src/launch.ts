// shim_launch (shim-core design D6): attach to the running Shim when the
// discovery file names a live process that answers, otherwise start Shim
// with its control endpoint on for this run, and wait for it to answer.
//
// Launching never grants anything: the endpoint flag only makes Shim
// listen, and every session still pends on the attach card in Shim.
//
// How Shim is started, in order:
//   SHIM_DEV_CHECKOUT=<repo>   `npm start -- --enable-control-endpoint` there
//   SHIM_APP=<app or binary>   macOS: `open -n -a <app> --args <flag>`;
//                              elsewhere: run it with the flag
//   macOS                      `open -n -a Shim --args <flag>`
//   Linux                      `shim-browser <flag>` (the packaged binary)
// `open -n` always starts a new process, so a Shim already running without
// its endpoint receives the flag through its single-instance lock (the new
// process hands its argv over and exits) instead of macOS just focusing it.
//
// Pure decisions over injected effects, so a harness covers every branch.

import type { ControlInfo } from './control-client';

export const CONTROL_ENDPOINT_FLAG = '--enable-control-endpoint';
export const LAUNCH_TIMEOUT_MS = 60_000;
// A dev checkout builds before it starts.
export const DEV_LAUNCH_TIMEOUT_MS = 180_000;
const POLL_MS = 500;

export interface LaunchCommand {
  command: string;
  args: string[];
  cwd?: string;
  // What the agent is told was started.
  describe: string;
  dev: boolean;
}

export function launchCommand(platform: string, env: Record<string, string | undefined>): LaunchCommand | null {
  const dev = env.SHIM_DEV_CHECKOUT;
  if (dev) {
    return {
      command: platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['start', '--', CONTROL_ENDPOINT_FLAG],
      cwd: dev,
      describe: `the Shim dev checkout at ${dev}`,
      dev: true,
    };
  }
  const app = env.SHIM_APP;
  if (platform === 'darwin') {
    const name = app || 'Shim';
    return { command: 'open', args: ['-n', '-a', name, '--args', CONTROL_ENDPOINT_FLAG], describe: name, dev: false };
  }
  if (app) return { command: app, args: [CONTROL_ENDPOINT_FLAG], describe: app, dev: false };
  if (platform === 'linux') return { command: 'shim-browser', args: [CONTROL_ENDPOINT_FLAG], describe: 'shim-browser', dev: false };
  return null;
}

// How the launcher process ended, once it has: `open` exits 0 as soon as it
// has started the app; `npm start` and a packaged binary run until Shim quits.
export interface LaunchExit {
  code: number | null;
  signal: string | null;
  // The process could not be started at all (ENOENT, EACCES).
  error?: string;
}

export interface Launched {
  // Null while the launcher is still running.
  exit(): LaunchExit | null;
}

export interface LaunchDeps {
  platform: string;
  env: Record<string, string | undefined>;
  readInfo(): ControlInfo | null;
  isAlive(pid: number): boolean;
  // Whether the endpoint the info names answers GET /status.
  ping(info: ControlInfo): Promise<boolean>;
  spawn(cmd: LaunchCommand): Launched;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type LaunchOutcome =
  | { ok: true; how: 'attached' | 'launched'; info: ControlInfo; detail: string }
  | { ok: false; error: 'launch-unavailable' | 'launch-failed' | 'launch-timeout'; detail: string };

/** The running Shim's endpoint, if the discovery file names one that answers. */
export async function findRunning(deps: Pick<LaunchDeps, 'readInfo' | 'isAlive' | 'ping'>): Promise<ControlInfo | null> {
  const info = deps.readInfo();
  if (!info || !deps.isAlive(info.pid)) return null;
  return (await deps.ping(info)) ? info : null;
}

export async function attachOrLaunch(deps: LaunchDeps, opts: { timeoutMs?: number } = {}): Promise<LaunchOutcome> {
  const running = await findRunning(deps);
  if (running) {
    return { ok: true, how: 'attached', info: running, detail: `Shim ${running.appVersion} is running (pid ${running.pid})` };
  }
  const cmd = launchCommand(deps.platform, deps.env);
  if (!cmd) {
    return {
      ok: false,
      error: 'launch-unavailable',
      detail: 'no way to start Shim on this platform: start it yourself with the control endpoint on (Settings), or set SHIM_APP to its executable',
    };
  }
  const before = deps.readInfo();
  let launched: Launched;
  try {
    launched = deps.spawn(cmd);
  } catch (e) {
    return { ok: false, error: 'launch-failed', detail: `could not start ${cmd.describe}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const timeoutMs = opts.timeoutMs ?? (cmd.dev ? DEV_LAUNCH_TIMEOUT_MS : LAUNCH_TIMEOUT_MS);
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_MS);
    // A launcher that failed (no such app, a dev build that broke) will
    // never bring an endpoint up: say so now rather than at the deadline.
    const exit = launched.exit();
    if (exit && (exit.error !== undefined || exit.code !== 0)) {
      const why = exit.error ?? (exit.code !== null ? `exited with code ${exit.code}` : `was killed (${exit.signal ?? 'signal'})`);
      return {
        ok: false,
        error: 'launch-failed',
        detail: `could not start ${cmd.describe}: ${cmd.command} ${why}. Is Shim installed? Set SHIM_APP to its app or executable, or start it yourself with the control endpoint on.`,
      };
    }
    const info = deps.readInfo();
    // A file left by a run that died is not an answer; a new token or a live
    // pid that answers is.
    if (!info || (before && info.token === before.token && !deps.isAlive(info.pid))) continue;
    if (!deps.isAlive(info.pid)) continue;
    if (await deps.ping(info)) {
      return { ok: true, how: 'launched', info, detail: `started ${cmd.describe}; Shim ${info.appVersion} is listening (pid ${info.pid})` };
    }
  }
  return {
    ok: false,
    error: 'launch-timeout',
    detail: `started ${cmd.describe}, but its control endpoint did not answer within ${Math.round(timeoutMs / 1000)}s`,
  };
}

/** process.kill(pid, 0): true while a process with that pid exists. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it just isn't ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Whether a launch needs a shell: only npm's Windows launcher, a .cmd shim
// that can't be spawned directly. A native executable (SHIM_APP, possibly
// under `C:\Program Files\…`) is spawned directly, because a shell would
// split its path at the space.
export function launchNeedsShell(command: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && (command === 'npm' || /\.cmd$/i.test(command));
}
