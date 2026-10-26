// Pins the document's reconciliation (src/reconcile.ts): a changed answer
// from the worker stops exactly what is no longer wanted, restarts what
// moved in the cascade, updates in place what moved to another version (a
// rebase, a restore), and starts exactly what is new, in answer order.

import { reconcileShims } from '../src/reconcile';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

const ids = (list: readonly { id: string }[]) => list.map((s) => s.id).join(',');
const running = (entries: [string, number, number?][]) => new Map(entries.map(([id, priority, version]) => [id, { priority, version: version ?? 1 }]));
const w = (id: string, priority = -1, version = 1) => ({ id, priority, version });

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
{
  const r = reconcileShims(running([['a', -1, 1], ['b', -2, 1]]), [w('a', -1, 2), w('b', -2, 1)]);
  check('a shim whose spec moved (a rebase) is updated in place, not restarted', r.stop.length === 0 && r.start.length === 0 && ids(r.update) === 'a' && r.update[0]?.version === 2);
}
{
  const r = reconcileShims(running([['a', -1, 3]]), [w('a', -1, 3)]);
  check('the same version is left alone', r.stop.length === 0 && r.start.length === 0 && r.update.length === 0);
}
{
  const r = reconcileShims(running([['a', -1, 1]]), [w('a', -5, 2)]);
  check('a moved priority and version together: restart, not update', r.stop.join() === 'a' && ids(r.start) === 'a' && r.update.length === 0);
}
{
  const r = reconcileShims(running([['a', -1, 1], ['b', -2, 1]]), [w('b', -2, 2), w('c', -3, 1)]);
  check('stop, update and start at once, in answer order', r.stop.join() === 'a' && ids(r.update) === 'b' && ids(r.start) === 'c');
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log(`all reconcile checks passed (${passes})`);
