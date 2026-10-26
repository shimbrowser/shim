// Pins the IndexedDB store (src/store.ts) on an in-memory IndexedDB
// (fake-indexeddb): installed shims in cascade order, enable / disable, a
// delete that takes the shim's user data with it, and `user_data` with the
// `api.storage` semantics every Shim host shares (null for a missing key,
// `set` answers the value, `delete` whether a row went, `list` a record,
// JSON values, "__proto__" as data).

import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { openShimStore, STORE_SCHEMA_VERSION, type InstalledShim } from '../src/store';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

function shim(id: string, rank: number, hosts = ['example.com']): InstalledShim {
  return {
    id, name: `Shim ${id}`, enabled: true, installedAt: 1000 + rank, rank, provenance: { source: 'file' }, mode: 'declarative',
    spec: { id, match: { hosts }, rules: [] }, handlers: {}, envelope: {},
  };
}

async function main(): Promise<void> {
  console.log('\n=== store harness ===\n');
  const store = await openShimStore(fakeIndexedDB, `store-harness-${Date.now()}`);

  console.log('shims:');
  check('empty at first', (await store.listShims()).length === 0);
  const { rank: _b, ...b } = shim('b', 0);
  const { rank: _a, ...a } = shim('a', 0);
  const { rank: _c, ...c } = shim('c', 0);
  void _a; void _b; void _c;
  check('the first add takes rank 1', (await store.addShim(b)) === 1);
  check('the next takes one past the highest', (await store.addShim(a)) === 2);
  // Three adds in flight at once: the rank is read and written in one
  // transaction, so they take three distinct ranks whatever the interleaving.
  const { rank: _d, ...d } = shim('d', 0);
  const { rank: _e, ...e } = shim('e', 0);
  void _d; void _e;
  const ranks = await Promise.all([store.addShim(c), store.addShim(d), store.addShim(e)]);
  check('concurrent adds take distinct ranks', new Set(ranks).size === 3 && [...ranks].sort().join() === '3,4,5', JSON.stringify(ranks));
  check('the records carry those ranks', (await store.listShims()).map((s) => s.rank).join() === '1,2,3,4,5');
  await store.deleteShim('d');
  await store.deleteShim('e');
  const listed = await store.listShims();
  check('listed by rank', listed.map((s) => s.id).join(',') === 'b,a,c', listed.map((s) => s.id).join(','));
  let dup = false;
  try { await store.putShim(shim('z', 2)); } catch { dup = true; }
  check('a second record at an existing rank is refused (the index is unique)', dup && (await store.getShim('z')) === null);
  check('get', (await store.getShim('a'))?.name === 'Shim a');
  check('adding an id that exists is refused', await store.addShim(a).then(() => false, () => true));
  check('get a missing one is null', (await store.getShim('zz')) === null);
  check('setEnabled', (await store.setEnabled('a', false)) === true && (await store.getShim('a'))?.enabled === false);
  check('setEnabled on a missing shim is false', (await store.setEnabled('zz', false)) === false);
  await store.putShim({ ...shim('a', 2), name: 'Renamed' });
  check('put replaces', (await store.getShim('a'))?.name === 'Renamed' && (await store.listShims()).length === 3);

  console.log('user data:');
  const scope = { shimId: 'a', origin: 'https://example.com' };
  const other = { shimId: 'a', origin: 'https://other.example.com' };
  check('a missing key reads null', (await store.userData.get(scope, 'k')) === null);
  check('set answers the value', JSON.stringify(await store.userData.set(scope, 'k', { n: 1 })) === '{"n":1}');
  check('and get reads it back', JSON.stringify(await store.userData.get(scope, 'k')) === '{"n":1}');
  check('another origin is another bucket', (await store.userData.get(other, 'k')) === null);
  await store.userData.set(scope, 'j', 'two');
  await store.userData.set(other, 'k', 'elsewhere');
  const list = await store.userData.list(scope);
  check('list is the bucket as a record', JSON.stringify(list) === '{"j":"two","k":{"n":1}}', JSON.stringify(list));
  check('undefined stores as null', (await store.userData.set(scope, 'u', undefined)) === null && (await store.userData.get(scope, 'u')) === null);
  check('a function stores as null', (await store.userData.set(scope, 'f', () => 1)) === null);
  await store.userData.set(scope, '__proto__', 'data');
  const proto = await store.userData.list(scope);
  check('"__proto__" is a key, not a prototype', Object.hasOwn(proto, '__proto__') && Object.getPrototypeOf(proto) === Object.prototype);
  check('delete answers true once', (await store.userData.delete(scope, 'j')) === true && (await store.userData.delete(scope, 'j')) === false);
  check('and the key is gone', (await store.userData.get(scope, 'j')) === null);
  check('restore writes the file\'s rows', (await store.userData.restore('b', [
    { origin: 'https://example.com', key: 'seen', value: [1] },
    { origin: 'https://example.com', key: 'n', value: 2 },
  ])) === 2 && JSON.stringify(await store.userData.get({ shimId: 'b', origin: 'https://example.com' }, 'seen')) === '[1]');
  check('restore of nothing is 0', (await store.userData.restore('b', [])) === 0);

  console.log('prefs:');
  check('a missing pref is undefined', (await store.prefs.get('bridge')) === undefined);
  await store.prefs.set('bridge', true);
  check('set then get', (await store.prefs.get('bridge')) === true);
  await store.prefs.set('bridge', false);
  check('set replaces', (await store.prefs.get('bridge')) === false);

  console.log('delete:');
  check('deleteShim', (await store.deleteShim('a')) === true);
  check('the shim is gone', (await store.getShim('a')) === null && (await store.listShims()).length === 2);
  check('its user data went with it, on every origin',
    Object.keys(await store.userData.list(scope)).length === 0 && Object.keys(await store.userData.list(other)).length === 0);
  check('another shim\'s data stays', (await store.userData.get({ shimId: 'b', origin: 'https://example.com' }, 'n')) === 2);
  check('deleting a missing shim is false', (await store.deleteShim('a')) === false);
  const { rank: _f, ...f } = shim('f', 0);
  void _f;
  // Live records are b (1) and c (3): the next rank is one past the highest live one.
  check('a new install takes one past the highest live rank', (await store.addShim(f)) === 4);

  console.log('schema:');
  check('version 1', STORE_SCHEMA_VERSION === 1);
  store.close();

  console.log('');
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log(`all store checks passed (${passes})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
