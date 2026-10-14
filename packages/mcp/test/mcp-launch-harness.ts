// Harness for shim_launch's decisions and the discovery file
// (packages/mcp/src/launch.ts, control-client.ts): where control.json is per
// platform and override; which command starts Shim per platform and env;
// attach when the file names a live pid that answers; launch otherwise and
// wait for a fresh, live, answering endpoint (a stale file is never taken
// for an answer); timeout, no launcher, a spawn that throws, and a launcher
// that exits non-zero (failed now, not at the deadline) or zero (open: wait on).
//
//   node out/packages/mcp/test/mcp-launch-harness.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { attachOrLaunch, launchCommand, launchNeedsShell, pidAlive, CONTROL_ENDPOINT_FLAG, type LaunchCommand, type LaunchDeps, type LaunchExit } from '../src/launch';
import { APP_DIR_NAME, discoveryFilePath, readControlInfo, userDataDir, type ControlInfo } from '../src/control-client';

// The Shim app's package.json (the repo root), found from wherever this compiled file runs.
function appPackageJson(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate) && fs.existsSync(path.join(dir, 'packages', 'mcp'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('the app package.json was not found above ' + __dirname);
}

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

function info(token: string, pid: number): ControlInfo {
  return { socketPath: '/s', token, pid, appVersion: '0.7.0', startedAt: 1 };
}

interface Sim {
  deps: LaunchDeps;
  spawned: LaunchCommand[];
}

// A clock that advances on sleep; `script` decides what the file says at each poll.
function sim(opts: {
  platform?: string;
  env?: Record<string, string | undefined>;
  file: (polls: number, spawned: boolean) => ControlInfo | null;
  alive: (pid: number) => boolean;
  answers: (info: ControlInfo) => boolean;
  spawnThrows?: boolean;
  // What the launcher's exit reads as at each poll (default: still running).
  exit?: (polls: number) => LaunchExit | null;
}): Sim {
  let now = 0;
  let polls = 0;
  const spawned: LaunchCommand[] = [];
  return {
    spawned,
    deps: {
      platform: opts.platform ?? 'darwin',
      env: opts.env ?? {},
      readInfo: () => opts.file(polls, spawned.length > 0),
      isAlive: opts.alive,
      ping: async (i) => opts.answers(i),
      spawn: (cmd) => {
        if (opts.spawnThrows) throw new Error('ENOENT');
        spawned.push(cmd);
        return { exit: () => opts.exit?.(polls) ?? null };
      },
      sleep: async (ms) => { now += ms; polls += 1; },
      now: () => now,
    },
  };
}

async function main(): Promise<void> {
  console.log('discovery file:');
  // Electron names userData after productName (before name): pin the folder to the app's.
  const appPkg = JSON.parse(fs.readFileSync(appPackageJson(), 'utf8')) as { name?: string; productName?: string };
  check('the userData folder is the app\'s productName', APP_DIR_NAME === (appPkg.productName ?? appPkg.name), `${APP_DIR_NAME} vs ${String(appPkg.productName)}`);
  check('macOS userData', userDataDir({ platform: 'darwin', env: {}, homedir: '/Users/j' }) === '/Users/j/Library/Application Support/Shim');
  check('Linux userData honors XDG_CONFIG_HOME', userDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x' }, homedir: '/h' }) === '/x/Shim');
  check('Linux userData default (case-sensitive: Shim)', userDataDir({ platform: 'linux', env: {}, homedir: '/h' }) === '/h/.config/Shim');
  check('Windows userData under APPDATA', userDataDir({ platform: 'win32', env: { APPDATA: 'C:\\A' }, homedir: 'C:\\h' }).endsWith('Shim'));
  check('SHIM_USER_DATA overrides', discoveryFilePath({ platform: 'darwin', env: { SHIM_USER_DATA: '/dev-profile' }, homedir: '/h' }) === path.join('/dev-profile', 'control.json'));
  check('SHIM_CONTROL_FILE overrides everything', discoveryFilePath({ platform: 'darwin', env: { SHIM_CONTROL_FILE: '/c.json', SHIM_USER_DATA: '/d' }, homedir: '/h' }) === '/c.json');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-launch-'));
  const file = path.join(dir, 'control.json');
  check('a missing file reads as null', readControlInfo(file) === null);
  fs.writeFileSync(file, JSON.stringify({ format: 'shim-control/1', socketPath: '/s', token: 'tok', pid: 9, appVersion: '1', startedAt: 2 }));
  check('a well-formed file reads', readControlInfo(file)?.token === 'tok');
  fs.writeFileSync(file, JSON.stringify({ format: 'other', socketPath: '/s', token: 'tok', pid: 9 }));
  check('a foreign format reads as null', readControlInfo(file) === null);
  fs.writeFileSync(file, '{ not json');
  check('a torn file reads as null', readControlInfo(file) === null);

  console.log('launch commands:');
  const mac = launchCommand('darwin', {});
  check('macOS: open -n -a Shim with the flag', mac?.command === 'open' && JSON.stringify(mac.args) === JSON.stringify(['-n', '-a', 'Shim', '--args', CONTROL_ENDPOINT_FLAG]));
  check('macOS: SHIM_APP names the app', launchCommand('darwin', { SHIM_APP: '/Applications/Shim Dev.app' })?.args[2] === '/Applications/Shim Dev.app');
  const dev = launchCommand('darwin', { SHIM_DEV_CHECKOUT: '/code/shim' });
  check('a dev checkout runs npm start with the flag there', dev?.command === 'npm' && dev.cwd === '/code/shim' && dev.dev
    && JSON.stringify(dev.args) === JSON.stringify(['start', '--', CONTROL_ENDPOINT_FLAG]));
  check('Linux: the packaged binary', launchCommand('linux', {})?.command === 'shim-browser');
  check('Windows without SHIM_APP: no launcher', launchCommand('win32', {}) === null);
  check('Windows with SHIM_APP: run it with the flag', launchCommand('win32', { SHIM_APP: 'C:\\Shim.exe' })?.args[0] === CONTROL_ENDPOINT_FLAG);
  check('pidAlive: this process', pidAlive(process.pid));
  check('pidAlive: nonsense pids', !pidAlive(0) && !pidAlive(-5) && !pidAlive(2 ** 31 - 2));

  console.log('attach or launch:');
  {
    const s = sim({ file: () => info('a', 10), alive: () => true, answers: () => true });
    const r = await attachOrLaunch(s.deps);
    check('a live pid that answers: attached, nothing spawned', r.ok && r.how === 'attached' && s.spawned.length === 0);
  }
  {
    // The file is stale (dead pid) until the launched Shim writes its own.
    const s = sim({
      file: (polls, spawned) => (spawned && polls >= 3 ? info('b', 20) : info('a', 10)),
      alive: (pid) => pid === 20,
      answers: (i) => i.token === 'b',
    });
    const r = await attachOrLaunch(s.deps);
    check('a dead pid: launches and waits for the new endpoint', r.ok && r.how === 'launched' && r.info.token === 'b' && s.spawned.length === 1, JSON.stringify(r));
  }
  {
    // Alive pid (reused by something else) that doesn't answer: launch.
    let answering = false;
    const s = sim({
      file: (polls) => { if (polls >= 2) answering = true; return info('a', 10); },
      alive: () => true,
      answers: () => answering,
    });
    const r = await attachOrLaunch(s.deps);
    check('a live pid that doesn\'t answer: launches, attaches once it answers', r.ok && r.how === 'launched' && s.spawned.length === 1);
  }
  {
    const s = sim({ file: () => null, alive: () => false, answers: () => false });
    const r = await attachOrLaunch(s.deps, { timeoutMs: 3_000 });
    check('nothing ever answers: launch-timeout', !r.ok && r.error === 'launch-timeout' && /3s/.test(r.detail));
  }
  {
    const s = sim({ file: () => info('a', 10), alive: () => false, answers: () => true });
    const r = await attachOrLaunch(s.deps, { timeoutMs: 2_000 });
    check('the old file with its dead pid is never taken for an answer', !r.ok && r.error === 'launch-timeout');
  }
  {
    const s = sim({ platform: 'win32', file: () => null, alive: () => false, answers: () => false });
    const r = await attachOrLaunch(s.deps);
    check('no launcher: launch-unavailable, nothing spawned', !r.ok && r.error === 'launch-unavailable' && s.spawned.length === 0);
  }
  {
    const s = sim({ file: () => null, alive: () => false, answers: () => false, spawnThrows: true });
    const r = await attachOrLaunch(s.deps);
    check('a spawn that throws: launch-failed', !r.ok && r.error === 'launch-failed' && /ENOENT/.test(r.detail));
  }
  {
    // `open -a Shim` with no such app exits 1 at once.
    const s = sim({ file: () => null, alive: () => false, answers: () => false, exit: (polls) => (polls >= 2 ? { code: 1, signal: null } : null) });
    const r = await attachOrLaunch(s.deps);
    check('a launcher that exits non-zero: launch-failed at once, not at the deadline',
      !r.ok && r.error === 'launch-failed' && /exited with code 1/.test(r.detail) && s.deps.now() < 5_000, JSON.stringify(r));
  }
  {
    const s = sim({ file: () => null, alive: () => false, answers: () => false, exit: () => ({ code: null, signal: null, error: 'spawn npm ENOENT' }) });
    const r = await attachOrLaunch(s.deps);
    check('a launcher that could not start: launch-failed with the reason', !r.ok && r.error === 'launch-failed' && /ENOENT/.test(r.detail));
  }
  {
    // `open` exits 0 once the app is started; the wait goes on.
    const s = sim({
      file: (polls) => (polls >= 4 ? info('c', 30) : null),
      alive: (pid) => pid === 30,
      answers: () => true,
      exit: (polls) => (polls >= 1 ? { code: 0, signal: null } : null),
    });
    const r = await attachOrLaunch(s.deps);
    check('a launcher that exits 0 (open): keeps waiting for the endpoint', r.ok && r.how === 'launched' && r.info.token === 'c', JSON.stringify(r));
  }
  {
    const s = sim({ env: { SHIM_DEV_CHECKOUT: '/code' }, file: () => null, alive: () => false, answers: () => false });
    const start = s.deps.now();
    const r = await attachOrLaunch(s.deps);
    check('a dev checkout gets the longer wait', !r.ok && s.deps.now() - start >= 180_000);
  }
}

console.log('which launches go through a shell:');
check('a Windows app path with a space is spawned directly (a shell would split it)', !launchNeedsShell('C:\\Program Files\\Shim\\Shim.exe', 'win32'));
check('…and so is any native Windows executable', !launchNeedsShell('C:\\Shim\\Shim.exe', 'win32'));
check('npm\'s Windows .cmd launcher needs the shell', launchNeedsShell('npm.cmd', 'win32') && launchNeedsShell('npm', 'win32'));
check('nothing needs it elsewhere', !launchNeedsShell('npm', 'darwin') && !launchNeedsShell('open', 'darwin') && !launchNeedsShell('shim-browser', 'linux'));

main().then(() => {
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}, (e: unknown) => {
  console.error(e);
  process.exit(1);
});
