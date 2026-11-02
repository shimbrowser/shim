// Pins the bridge port's life (src/bridge-port.ts) where a real worker can't
// be driven: a setTimeout backoff lost with the worker, and the backstop that
// reconnects anyway. Chrome's port, the timers and the alarm are injected.

import fs from 'fs';
import path from 'path';
import { BACKSTOP_MINUTES, createBridgePort, type BridgePort, type PortLike } from '../src/bridge-port';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

interface FakePort extends PortLike { drop(): void }

function fakePort(): FakePort {
  const drops: Array<() => void> = [];
  return {
    postMessage: () => undefined,
    disconnect: () => undefined,
    onMessage: { addListener: () => undefined },
    onDisconnect: { addListener: (cb) => { drops.push(cb); } },
    drop: () => { for (const cb of drops) cb(); },
  };
}

interface Rig {
  bridge: BridgePort;
  ports: FakePort[];
  timers: Map<number, () => void>;
  backstop: { running: boolean; starts: number; stops: number };
  finishShutdown(): void;
}

function rig(opts: { holdShutdown?: boolean } = {}): Rig {
  const ports: FakePort[] = [];
  const timers = new Map<number, () => void>();
  const backstop = { running: false, starts: 0, stops: 0 };
  let timerId = 0;
  let finish: () => void = () => undefined;
  const bridge = createBridgePort({
    connect: () => { const p = fakePort(); ports.push(p); return p; },
    handle: () => Promise.resolve({ status: 200, body: {} }),
    shutdown: () => (opts.holdShutdown ? new Promise<void>((r) => { finish = r; }) : Promise.resolve()),
    version: '0',
    log: () => undefined,
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (h) => { timers.delete(h as number); },
    backstop: {
      start: () => { backstop.running = true; backstop.starts++; },
      stop: () => { backstop.running = false; backstop.stops++; },
    },
  });
  return { bridge, ports, timers, backstop, finishShutdown: () => { finish(); } };
}

const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function main(): Promise<void> {
  console.log('\n=== bridge port harness ===\n');

  {
    const r = rig();
    r.bridge.enable();
    check('turning on connects and starts the backstop', r.bridge.connected() && r.backstop.running);
    r.bridge.retry();
    check('a tick with the port up does nothing', r.ports.length === 1);
    r.ports[0]?.drop();
    await turn();
    check('a drop leaves a backoff timer and the backstop running', !r.bridge.connected() && r.timers.size === 1 && r.backstop.running);
    const [fire] = [...r.timers.values()];
    fire?.();
    check('the backoff timer reconnects while the worker lives', r.bridge.connected() && r.ports.length === 2);
    r.timers.clear();
  }

  {
    const r = rig();
    r.bridge.enable();
    r.ports[0]?.drop();
    await turn();
    r.timers.clear(); // A worker gone with its timer: nothing will fire it.
    r.bridge.retry();
    check('the tick reconnects with the timer lost', r.bridge.connected() && r.ports.length === 2);
    r.bridge.retry();
    check('and only once', r.ports.length === 2);
  }

  {
    const r = rig();
    r.bridge.enable();
    r.ports[0]?.drop();
    await turn();
    r.bridge.retry();
    check('a tick takes over a pending timer, so no second connection follows', r.bridge.connected() && r.timers.size === 0 && r.ports.length === 2);
  }

  {
    const r = rig({ holdShutdown: true });
    r.bridge.enable();
    r.ports[0]?.drop();
    r.bridge.retry();
    check('a tick waits for the old connection\'s shutdown', !r.bridge.connected() && r.ports.length === 1);
    r.finishShutdown();
    await turn();
    r.bridge.retry();
    check('and connects after it', r.bridge.connected() && r.ports.length === 2);
  }

  {
    const r = rig();
    r.bridge.enable();
    await r.bridge.disable();
    check('turning off stops the backstop', !r.backstop.running);
    r.bridge.retry();
    check('a late tick does not reconnect', !r.bridge.connected() && r.ports.length === 1);
  }

  {
    const r = rig();
    r.backstop.running = true; // Left by the last worker; this one never enabled.
    await r.bridge.disable();
    check('turning off in a fresh worker stops the backstop it inherited', !r.backstop.running);
    r.bridge.retry();
    check('a tick before the worker has enabled connects nothing', r.ports.length === 0);
  }

  console.log('the worker\'s half:');
  const root = path.resolve(__dirname, '..', '..', '..', '..', 'packages', 'extension');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'static', 'manifest.json'), 'utf8')) as { permissions: string[] };
  check('the manifest holds the alarms permission', manifest.permissions.includes('alarms'));
  check('the backstop is no shorter than Chrome allows', BACKSTOP_MINUTES >= 0.5);
  const worker = fs.readFileSync(path.join(root, 'src', 'sw.ts'), 'utf8');
  check('the worker wires the backstop to an alarm', /chrome\.alarms\.create\(BRIDGE_ALARM, \{ periodInMinutes: BACKSTOP_MINUTES \}\)/.test(worker));
  check('the alarm reaches the port', worker.includes('bridgePort.retry()'));

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

void main();
