// Pins the document's reconciliation (src/reconcile.ts): a changed answer
// from the worker stops exactly what is no longer wanted, restarts what
// moved in the cascade, and starts exactly what is new, in answer order.

import { reconcileShims } from '../src/reconcile';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

const ids = (list: readonly { id: string }[]) => list.map((s) => s.id).join(',');
const running = (entries: [string, number][]) => new Map(entries);
const w = (id: string, priority = -1) => ({ id, priority });

console.log('\n=== reconcile harness ===\n');

{
  const r = reconcileShims(running([]), [w('a', -1), w('b', -2)]);
  check('first answer starts everything, in order', r.stop.length === 0 && ids(r.start) === 'a,b');
}
{
  const r = reconcileShims(running([['a', -1], ['b', -2]]), [w('a', -1), w('b', -2)]);
  check('an unchanged answer does nothing', r.stop.length === 0 && r.start.length === 0);
}
{
  const r = reconcileShims(running([['a', -1], ['b', -2]]), [w('b', -2)]);
  check('a shim gone from the answer stops', r.stop.join() === 'a' && r.start.length === 0);
}
{
  const r = reconcileShims(running([['a', -1]]), [w('a', -1), w('c', -3)]);
  check('a new shim starts', r.stop.length === 0 && ids(r.start) === 'c');
}
{
  const r = reconcileShims(running([['a', -1], ['b', -2]]), [w('b', -2), w('c', -3)]);
  check('both at once', r.stop.join() === 'a' && ids(r.start) === 'c');
}
{
  const r = reconcileShims(running([['a', -1], ['b', -2]]), []);
  check('an empty answer stops everything', r.stop.join() === 'a,b' && r.start.length === 0);
}
{
  const r = reconcileShims(running([['a', -1]]), [w('c', -3), w('a', -1), w('d', -4)]);
  check('start keeps answer order', ids(r.start) === 'c,d' && r.stop.length === 0);
}
{
  const r = reconcileShims(running([['a', -1], ['b', -2]]), [w('a', -5), w('b', -2)]);
  check('a shim whose priority moved stops and starts again with the new one', r.stop.join() === 'a' && ids(r.start) === 'a' && r.start[0]?.priority === -5);
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log(`all reconcile checks passed (${passes})`);
