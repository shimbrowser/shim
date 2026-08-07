// Handler-fetch budget harness (src/patch-engine/fetch-budget.ts) — the
// token bucket behind the per-frame same-site fetch throttle.
// Run: node out/scripts/fetch-budget-harness.js
//
// Asserts:
// - a burst up to `burst` passes immediately (delayMs 0, not throttled)
// - request burst+1 onward queues FIFO at refillPerSec spacing
// - idle time refills the bucket (later burst passes immediately again)
// - queued slots don't double-spend the refill stream (a long queue stays
//   paced at refillPerSec even as time advances)
// - throttledCount counts only delayed requests
import { createFetchBudget } from '../src/patch-engine/fetch-budget';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

console.log('burst passes untouched:');
{
  const b = createFetchBudget({ burst: 5, refillPerSec: 2 });
  const t0 = 100000;
  for (let i = 0; i < 5; i++) {
    const r = b.take(t0 + i);
    check(`request ${i + 1}/5 immediate`, r.delayMs === 0 && !r.throttled, JSON.stringify(r));
  }
  check('no throttles counted', b.throttledCount() === 0, String(b.throttledCount()));
}

console.log('over-burst queues FIFO at refill spacing:');
{
  const b = createFetchBudget({ burst: 3, refillPerSec: 2 }); // 500ms interval
  const t0 = 200000;
  for (let i = 0; i < 3; i++) b.take(t0);
  const q1 = b.take(t0);
  const q2 = b.take(t0);
  const q3 = b.take(t0);
  check('first queued waits one interval', q1.throttled && q1.delayMs === 500, JSON.stringify(q1));
  check('second queued waits two intervals', q2.throttled && q2.delayMs === 1000, JSON.stringify(q2));
  check('third queued waits three intervals', q3.throttled && q3.delayMs === 1500, JSON.stringify(q3));
  check('throttledCount tracks the queue', b.throttledCount() === 3, String(b.throttledCount()));
}

console.log('idle refill restores the burst:');
{
  const b = createFetchBudget({ burst: 3, refillPerSec: 2 });
  const t0 = 300000;
  for (let i = 0; i < 3; i++) b.take(t0);
  const later = b.take(t0 + 3000); // 3s idle → refill past cap, clamped to burst
  check('post-idle request immediate', later.delayMs === 0 && !later.throttled, JSON.stringify(later));
}

console.log('long queue stays paced (no double-spend):');
{
  const b = createFetchBudget({ burst: 2, refillPerSec: 4 }); // 250ms interval
  const t0 = 400000;
  b.take(t0); b.take(t0);
  const delays: number[] = [];
  for (let i = 0; i < 4; i++) delays.push(b.take(t0).delayMs);
  check('queue spacing monotonic at interval', delays.join() === '250,500,750,1000', delays.join());
  // Time advances past the first queued slot — the NEXT take must land
  // after the existing tail, not grab a "refilled" token ahead of the queue.
  const r = b.take(t0 + 260);
  check('later take respects the queue tail', r.throttled && r.delayMs === 1250 - 260, JSON.stringify(r));
}

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');
