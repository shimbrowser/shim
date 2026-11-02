// Pins the attach card's window (src/attach-window.ts), above all across a
// worker's death: its id survives in session storage, so the next worker can
// reuse the window or close the one left stranded. A real worker restart can't
// be driven under Playwright; here a second createAttachWindow over the same
// storage is the next worker.

import { CARD_CLOSE_GRACE_MS, createAttachWindow, type AttachWindow } from '../src/attach-window';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

/** What outlives a worker: Chrome's windows and session storage. */
interface Chrome {
  windows: Set<number>;
  stored: unknown;
  opened: number;
  closed: number[];
  failOpen: boolean;
}
const chromeNow = (): Chrome => ({ windows: new Set(), stored: undefined, opened: 0, closed: [], failOpen: false });

interface Worker {
  card: AttachWindow;
  fireTimer(): void;
  timers: Map<number, { fn: () => void; ms: number }>;
  setWaiting(n: number): void;
}

function worker(c: Chrome): Worker {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  let waiting = 0;
  const card = createAttachWindow({
    open: () => {
      if (c.failOpen) return Promise.reject(new Error('no window'));
      const id = 100 + ++c.opened;
      c.windows.add(id);
      return Promise.resolve(id);
    },
    check: (id) => (c.windows.has(id) ? Promise.resolve() : Promise.reject(new Error('gone'))),
    close: (id) => { c.closed.push(id); return c.windows.delete(id) ? Promise.resolve() : Promise.reject(new Error('gone')); },
    load: () => Promise.resolve(c.stored),
    save: (id) => { c.stored = id === null ? undefined : id; return Promise.resolve(); },
    waiting: () => waiting,
    log: () => undefined,
    setTimeout: (fn, ms) => { timers.set(++next, { fn, ms }); return next; },
    clearTimeout: (h) => { timers.delete(h as number); },
  });
  return {
    card, timers,
    fireTimer: () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } },
    setWaiting: (n) => { waiting = n; },
  };
}

/** A worker with one request waiting and its card open. */
async function withCard(c: Chrome): Promise<Worker> {
  const w = worker(c);
  w.setWaiting(1);
  w.card.sync(1);
  await w.card.idle();
  return w;
}

/** A worker that boots with nothing waiting, the way sw.ts boots, through its close. */
async function bootAndClose(c: Chrome): Promise<Worker> {
  const w = worker(c);
  w.card.sync(0);
  await w.card.idle();
  w.fireTimer();
  await w.card.idle();
  return w;
}

async function main(): Promise<void> {
  console.log('\n=== attach window harness ===\n');

  {
    const c = chromeNow();
    const w = worker(c);
    w.setWaiting(1);
    w.card.sync(1);
    w.card.sync(2);
    await w.card.idle();
    check('two rapid changes open one window', c.opened === 1 && c.windows.size === 1);
    check('its id is kept for the next worker', c.stored === 101, String(c.stored));
    w.setWaiting(0);
    w.card.sync(0);
    await w.card.idle();
    check('nothing closes before the grace', c.closed.length === 0 && [...w.timers.values()][0]?.ms === CARD_CLOSE_GRACE_MS);
    w.fireTimer();
    await w.card.idle();
    check('closed after it, and the id goes with it', c.windows.size === 0 && c.stored === undefined);
  }

  {
    const c = chromeNow();
    const w = await withCard(c);
    w.setWaiting(0);
    w.card.sync(0);
    await w.card.idle();
    w.setWaiting(1);
    w.card.sync(1);
    await w.card.idle();
    check('a request inside the grace keeps the window', w.timers.size === 0 && c.windows.size === 1 && c.opened === 1);
  }

  console.log('a worker that died with the card open:');
  {
    const c = chromeNow();
    await withCard(c);
    await bootAndClose(c);
    check('the next worker closes the stranded card', c.windows.size === 0 && c.closed[0] === 101 && c.stored === undefined);
  }
  {
    const c = chromeNow();
    await withCard(c);
    const next = await withCard(c);
    check('with a new request it reuses the window', c.opened === 1 && c.windows.size === 1 && next.timers.size === 0);
  }
  {
    const c = chromeNow();
    const first = await withCard(c);
    first.setWaiting(0);
    first.card.sync(0);
    await first.card.idle(); // Dies inside the grace: its timer never fires.
    await bootAndClose(c);
    check('a worker that died inside the grace is covered too', c.windows.size === 0);
  }
  {
    const c = chromeNow();
    c.stored = 555; // The user closed it while no worker ran.
    await withCard(c);
    check('a stored window that has gone is replaced', c.opened === 1 && c.stored === 101);
  }
  {
    const c = chromeNow();
    c.stored = 555;
    await bootAndClose(c);
    check('closing a stored window that has gone clears it quietly', c.stored === undefined);
  }
  {
    const c = chromeNow();
    c.stored = 'not an id';
    const w = worker(c);
    w.card.sync(0);
    await w.card.idle();
    check('a stored value that is no window id is ignored', w.timers.size === 0 && c.closed.length === 0);
  }

  {
    const c = chromeNow();
    const w = await withCard(c);
    c.windows.delete(101);
    w.card.removed(101);
    await w.card.idle();
    check('a window the user closed is forgotten', c.stored === undefined);
    w.card.sync(1);
    await w.card.idle();
    check('and the next request opens a fresh one', c.opened === 2 && c.stored === 102);
    w.card.removed(999);
    await w.card.idle();
    check('another window closing changes nothing', c.stored === 102);
  }

  {
    const c = chromeNow();
    c.failOpen = true;
    const w = await withCard(c);
    c.failOpen = false;
    w.card.sync(1);
    await w.card.idle();
    check('a failed open does not stop the next', c.opened === 1 && c.stored === 101);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

void main();
