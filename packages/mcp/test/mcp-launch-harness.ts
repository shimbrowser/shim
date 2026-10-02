// Harness for shim_launch's decisions and the discovery file
// (packages/mcp/src/launch.ts, control-client.ts): where control.json is per
// platform and override; which command starts Shim per platform and env;
// attach when the file names a live pid that answers; launch otherwise and
// wait for a fresh, live, answering endpoint (a stale file is never taken
// for an answer); timeout, no launcher, and a spawn that throws.
//
//   node out/packages/mcp/test/mcp-launch-harness.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { attachOrLaunch, launchCommand, pidAlive, CONTROL_ENDPOINT_FLAG, type LaunchCommand, type LaunchDeps } from '../src/launch';
import { discoveryFilePath, readControlInfo, userDataDir, type ControlInfo } from '../src/control-client';

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
      },
      sleep: async (ms) => { now += ms; polls += 1; },
      now: () => now,
    },
  };
}

async function main(): Promise<void> {
  console.log('discovery file:');
  check('macOS userData', userDataDir({ platform: 'darwin', env: {}, homedir: '/Users/j' }) === '/Users/j/Library/Application Support/shim');
  check('Linux userData honors XDG_CONFIG_HOME', userDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x' }, homedir: '/h' }) === '/x/shim');
  check('Linux userData default', userDataDir({ platform: 'linux', env: {}, homedir: '/h' }) === '/h/.config/shim');
  check('Windows userData under APPDATA', userDataDir({ platform: 'win32', env: { APPDATA: 'C:\\A' }, homedir: 'C:\\h' }).endsWith('shim'));
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
    const s = sim({ env: { SHIM_DEV_CHECKOUT: '/code' }, file: () => null, alive: () => false, answers: () => false });
    const start = s.deps.now();
    const r = await attachOrLaunch(s.deps);
    check('a dev checkout gets the longer wait', !r.ok && s.deps.now() - start >= 180_000);
  }
}

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
