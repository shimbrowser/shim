// next-frame-harness — pins nextFrame (packages/core/src/next-frame.ts): a
// callback runs once, on the next animation frame or the fallback timer,
// whichever comes first, and cancel stops both. Bare node — the frame and
// timer globals are stubbed so each case controls which one fires.
//
// The bug this pins: the engine's observer re-scan waited on an animation
// frame alone, and a page Chromium doesn't paint (hidden, behind another
// window) gets none, so a page that replaced its DOM there was never
// re-shimmed. The source scan at the end keeps the engine's observer paths on
// nextFrame.
//
//   node out/packages/core/test/next-frame-harness.js

import * as fs from 'fs';
import * as path from 'path';
import { nextFrame, FRAME_FALLBACK_MS } from '../src/next-frame';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  failures += 1;
  console.error(`  ✗ ${label}${detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}

// A controllable clock: frames and timers queue until the case fires them.
interface Pending { id: number; fn: () => void; ms?: number }
const frames: Pending[] = [];
const timers: Pending[] = [];
let nextId = 1;
const g = globalThis as unknown as Record<string, unknown>;
g.requestAnimationFrame = (fn: () => void): number => { const id = nextId++; frames.push({ id, fn }); return id; };
g.cancelAnimationFrame = (id: number): void => { const i = frames.findIndex((f) => f.id === id); if (i >= 0) frames.splice(i, 1); };
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
g.setTimeout = (fn: () => void, ms?: number): number => { const id = nextId++; timers.push({ id, fn, ms }); return id; };
g.clearTimeout = (id: number): void => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };

function fireFrames(): void { for (const f of frames.splice(0)) f.fn(); }
function fireTimers(): void { for (const t of timers.splice(0)) t.fn(); }
function reset(): void { frames.length = 0; timers.length = 0; }

console.log('next-frame');

{
  reset();
  let runs = 0;
  nextFrame(() => { runs += 1; });
  check('arms both a frame and a fallback timer', frames.length === 1 && timers.length === 1, { frames: frames.length, timers: timers.length });
  check(`the fallback is ${FRAME_FALLBACK_MS} ms`, timers[0]?.ms === FRAME_FALLBACK_MS, timers[0]?.ms);
  fireFrames();
  check('a frame runs the callback', runs === 1, runs);
  check('…and cancels the fallback timer', timers.length === 0, timers.length);
}

{
  reset();
  let runs = 0;
  nextFrame(() => { runs += 1; });
  // A page that gets no frames: only the timer ever fires.
  fireTimers();
  check('with no frame, the fallback timer runs the callback', runs === 1, runs);
  check('…and cancels the pending frame', frames.length === 0, frames.length);
}

{
  reset();
  let runs = 0;
  // A stale handle firing after its sibling (a stub, or a browser racing the
  // cancel): the callback still runs once.
  const savedFrames = frames;
  nextFrame(() => { runs += 1; });
  const frame = savedFrames[0];
  const timer = timers[0];
  timer?.fn();
  frame?.fn();
  check('runs at most once even if both fire', runs === 1, runs);
}

{
  reset();
  let runs = 0;
  const cancel = nextFrame(() => { runs += 1; });
  cancel();
  check('cancel clears the frame and the timer', frames.length === 0 && timers.length === 0, { frames: frames.length, timers: timers.length });
  fireFrames();
  fireTimers();
  check('a cancelled callback never runs', runs === 0, runs);
  cancel();
  check('cancelling twice is harmless', runs === 0, runs);
}

{
  reset();
  let runs = 0;
  const cancel = nextFrame(() => { runs += 1; }, 250);
  check('a custom fallback delay is used', timers[0]?.ms === 250, timers[0]?.ms);
  fireFrames();
  cancel();
  check('cancelling after the callback ran does nothing', runs === 1 && frames.length === 0 && timers.length === 0, runs);
}

// The engine's observer paths must schedule through nextFrame, never a bare
// frame: those are the paths that went quiet in an unpainted page.
{
  const src = path.join(__dirname, '..', '..', '..', '..', 'packages', 'core', 'src');
  for (const file of ['apply-rule.ts', 'bridge-rule.ts', 'route-rule.ts']) {
    const text = fs.readFileSync(path.join(src, file), 'utf8');
    const observerAt = text.indexOf('new MutationObserver(');
    check(`${file} imports nextFrame`, /import \{ nextFrame \} from '\.\/next-frame';/.test(text));
    check(`${file} has a MutationObserver`, observerAt >= 0);
  }
  const apply = fs.readFileSync(path.join(src, 'apply-rule.ts'), 'utf8');
  const bridge = fs.readFileSync(path.join(src, 'bridge-rule.ts'), 'utf8');
  check('apply-rule.ts never schedules a bare animation frame', !/requestAnimationFrame\(/.test(apply));
  check('bridge-rule.ts never schedules a bare animation frame', !/requestAnimationFrame\(/.test(bridge));
  const route = fs.readFileSync(path.join(src, 'route-rule.ts'), 'utf8');
  const heal = route.slice(route.indexOf('const observer = new MutationObserver('), route.indexOf('document.addEventListener(\'click\', onClick, true)'));
  check('route-rule.ts heals through nextFrame', heal.includes('nextFrame(') && !heal.includes('requestAnimationFrame('), heal.length);
}

g.setTimeout = realSetTimeout;
g.clearTimeout = realClearTimeout;

if (failures > 0) {
  console.error(`\n✗ next-frame-harness: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n✓ next-frame-harness passed');
