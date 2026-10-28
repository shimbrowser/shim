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
  const r = reconcileShims(new Map([['a', { priority: -1, version: 1, handlersKey: 'h1' }]]), [{ ...w('a', -1, 2), handlersKey: 'h2' }]);
  check('a version move with other handler modules restarts the shim (its code was compiled at boot)', r.stop.join() === 'a' && ids(r.start) === 'a' && r.update.length === 0);
  const same = reconcileShims(new Map([['a', { priority: -1, version: 1, handlersKey: 'h1' }]]), [{ ...w('a', -1, 2), handlersKey: 'h1' }]);
  check('a version move with the same handler modules is an in-place update', same.stop.length === 0 && ids(same.update) === 'a');
  const unknown = reconcileShims(new Map([['a', { priority: -1, version: 1 }]]), [{ ...w('a', -1, 2), handlersKey: 'h2' }]);
  check('a side without a key is not compared', unknown.stop.length === 0 && ids(unknown.update) === 'a');
}
{
  // A setting changed on the settings page: same version, same code, a new
  // digest. The shim reboots so its handlers read the new value; the other
  // shims on the page are left alone.
  const before = new Map([['a', { priority: -1, version: 4, settingsKey: 's1' }], ['b', { priority: -2, version: 1, settingsKey: 'x' }]]);
  const r = reconcileShims(before, [{ ...w('a', -1, 4), settingsKey: 's2' }, { ...w('b', -2, 1), settingsKey: 'x' }]);
  check('a changed settings digest restarts that shim only', r.stop.join() === 'a' && ids(r.start) === 'a' && r.update.length === 0);
  const same = reconcileShims(before, [{ ...w('a', -1, 4), settingsKey: 's1' }, { ...w('b', -2, 1), settingsKey: 'x' }]);
  check('the same digest leaves it alone', same.stop.length === 0 && same.start.length === 0 && same.update.length === 0);
  const moved = reconcileShims(before, [{ ...w('a', -1, 5), settingsKey: 's1' }]);
  check('a version move with the same digest is still an in-place update', ids(moved.update) === 'a' && !moved.stop.includes('a'));
  // No digest means no settings declared, which is a state like any other.
  const first = reconcileShims(new Map([['a', { priority: -1, version: 4 }]]), [{ ...w('a', -1, 5), settingsKey: 's1' }]);
  check('declaring the first setting (rules and code unchanged) restarts, so a handler reads the new default', first.stop.join() === 'a' && ids(first.start) === 'a' && first.update.length === 0);
  const last = reconcileShims(new Map([['a', { priority: -1, version: 4, settingsKey: 's1' }]]), [w('a', -1, 5)]);
  check('dropping the last setting restarts too', last.stop.join() === 'a' && ids(last.start) === 'a' && last.update.length === 0);
  const none = reconcileShims(new Map([['a', { priority: -1, version: 4 }]]), [w('a', -1, 5)]);
  check('no settings on either side: a version move stays an in-place update', none.stop.length === 0 && ids(none.update) === 'a');
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
