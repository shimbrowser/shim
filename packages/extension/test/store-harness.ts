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

  console.log('versions, rule state and baselines:');
  {
    const b = await store.getShim('b');
    check('a shim to revise', b !== null);
    if (b) {
      await store.versions.snapshot(b, 'install');
      const v1 = await store.versions.listForShim('b');
      check('an install snapshot under its version', v1.length === 1 && v1[0]?.version === (b.spec.version ?? 1) && v1[0]?.reason === 'install');
      const v = b.spec.version ?? 1;
      // An amendment since the install's snapshot (a captured fingerprint, say) rides the current spec.
      check('amendSpec replaces without a snapshot', (await store.amendSpec('b', { ...b.spec, bundleHash: 'amended' }, v)) === true
        && (await store.getShim('b'))?.spec.bundleHash === 'amended' && (await store.versions.listForShim('b')).length === 1);
      check('amendSpec against a moved version is refused', (await store.amendSpec('b', { ...b.spec, bundleHash: 'stale' }, v + 7)) === false && (await store.getShim('b'))?.spec.bundleHash === 'amended');
      const next = { ...b.spec, version: v + 1, bundleHash: 'b2' };
      check('reviseSpec against a moved version is refused', (await store.reviseSpec('b', next, b.handlers, 'rebase', v + 1)) === false && ((await store.getShim('b'))?.spec.version ?? 1) === v);
      check('reviseSpec stores the next spec and snapshots it under its version, in one go', (await store.reviseSpec('b', next, b.handlers, 'rebase', v)) === true);
      const after = await store.getShim('b');
      check('the shim carries the next spec', after?.spec.version === next.version && after.spec.bundleHash === 'b2');
      const versions = await store.versions.listForShim('b');
      check('every version the shim has been, in order, with what produced it', versions.map((x) => `${x.version}:${x.reason}`).join(',') === `${v}:install,${v + 1}:rebase`, versions.map((x) => `${x.version}:${x.reason}`).join(','));
      const got = await store.versions.get('b', v + 1);
      check('a snapshot reads back with the spec it held', got !== null && got.spec.bundleHash === 'b2' && got.reason === 'rebase');
      const first = await store.versions.get('b', v);
      check('the version revised away was snapshotted again as it stood, amendments included, keeping its reason', first?.spec.bundleHash === 'amended' && first.reason === 'install');
      check('revising a missing shim is false', (await store.reviseSpec('zzz', next, b.handlers, 'rebase', v)) === false && (await store.amendSpec('zzz', next, v)) === false);
      // A session's commit: the handler modules move with the spec, both
      // snapshotted, and a draft the session created is settled by it.
      await store.putShim({ ...(await store.getShim('b'))!, sessionDraft: { sessionId: 's1', at: 1 } });
      const committed = { ...next, version: v + 2 };
      const modules = { badge: 'module.exports = function () {};' };
      check('a commit writes spec and handlers, snapshots both, and clears the draft',
        (await store.reviseSpec('b', committed, modules, 'commit', v + 1, { clearDraft: true })) === true
        && (await store.getShim('b'))?.handlers.badge === modules.badge
        && (await store.getShim('b'))?.sessionDraft === undefined
        && (await store.versions.get('b', v + 2))?.handlers.badge === modules.badge
        && (await store.versions.get('b', v + 2))?.reason === 'commit'
        && (await store.versions.get('b', v + 1))?.handlers.badge === undefined);
    }
    check('no rule state to start', (await store.ruleState.get('b', 'r1')) === null && (await store.ruleState.listForShim('b')).length === 0);
    await store.ruleState.put({ shimId: 'b', ruleId: 'r1', paths: { '/projects/*': 5 } });
    await store.ruleState.put({ shimId: 'b', ruleId: 'r2', paths: {}, quarantine: { reason: 'gone', expected: null, seen: [], occurredAt: 9 } });
    const r1 = await store.ruleState.get('b', 'r1');
    check('rule state reads back', r1?.paths['/projects/*'] === 5 && r1.quarantine === undefined);
    check('and lists per shim', (await store.ruleState.listForShim('b')).map((r) => r.ruleId).sort().join() === 'r1,r2');
    await store.ruleState.put({ shimId: 'b', ruleId: 'r1', paths: { '/projects/*': 6 }, quarantine: { reason: 'x', expected: null, seen: [], occurredAt: 1 } });
    check('put replaces', (await store.ruleState.get('b', 'r1'))?.quarantine?.reason === 'x');

    check('no baselines to start', Object.keys(await store.baselines.forHost('b', 'example.com')).length === 0);
    await store.baselines.record('b', 'example.com', '/', 'h1');
    await store.baselines.record('b', 'example.com', '/projects/*', 'h2');
    await store.baselines.record('b', 'other.test', '/', 'h9');
    const forHost = await store.baselines.forHost('b', 'example.com');
    check('baselines read back per host and page kind', forHost['/'] === 'h1' && forHost['/projects/*'] === 'h2' && Object.keys(forHost).length === 2);
    await store.baselines.record('b', 'example.com', '/', 'h1b');
    check('recording a page kind again replaces its hash', (await store.baselines.forHost('b', 'example.com'))['/'] === 'h1b');
    for (let i = 0; i < 105; i++) await store.baselines.record('c', 'cap.test', `/kind${i}`, `h${i}`);
    const capped = await store.baselines.forHost('c', 'cap.test');
    check('at most the cap of page kinds per host, the least recently refreshed gone', Object.keys(capped).length === 100 && capped['/kind104'] === 'h104' && capped['/kind0'] === undefined, String(Object.keys(capped).length));
  }

  console.log('settings values:');
  {
    check('a shim with no values reads an empty record', Object.keys(await store.settings.get('b')).length === 0);
    await store.settings.set('b', 'units', 'metric');
    await store.settings.set('b', 'limit', 25);
    await store.settings.set('b', 'on', false);
    await store.settings.set('c', 'units', 'imperial');
    const b = await store.settings.get('b');
    check('values read back as set, typed', b.units === 'metric' && b.limit === 25 && b.on === false && Object.keys(b).length === 3, JSON.stringify(b));
    check('each shim keeps its own', (await store.settings.get('c')).units === 'imperial');
    await store.settings.set('b', 'units', 'imperial');
    check('setting a key again replaces it', (await store.settings.get('b')).units === 'imperial');
    await store.settings.set('b', '__proto__', 'x');
    const proto = await store.settings.get('b');
    check('a "__proto__" key is data, not a prototype', Object.hasOwn(proto, '__proto__') && Object.getPrototypeOf(proto) === Object.prototype);
    check('delete answers whether a row went away', (await store.settings.delete('b', 'limit')) === true && (await store.settings.delete('b', 'limit')) === false);
    check('the deleted key is gone, the rest stay', !('limit' in (await store.settings.get('b'))) && (await store.settings.get('b')).on === false);
  }

  console.log('delete cascades the new stores:');
  {
    check('deleteShim', (await store.deleteShim('b')) === true);
    check('its versions, rule state and baselines went with it',
      (await store.versions.listForShim('b')).length === 0 && (await store.ruleState.listForShim('b')).length === 0 && Object.keys(await store.baselines.forHost('b', 'example.com')).length === 0);
    check('its settings values went with it', Object.keys(await store.settings.get('b')).length === 0);
    check('another shim\'s baselines stay', Object.keys(await store.baselines.forHost('c', 'cap.test')).length === 100);
    check('another shim\'s settings stay', (await store.settings.get('c')).units === 'imperial');
  }

  console.log('schema:');
  check('version 3', STORE_SCHEMA_VERSION === 3);
  store.close();

  console.log('upgrade from version 1:');
  {
    // A store as the previous version left it: the shims store with a shim in it, and no baselines store.
    const name = `store-upgrade-${Date.now()}`;
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = fakeIndexedDB.open(name, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore('shims', { keyPath: 'id' }).createIndex('byRank', 'rank', { unique: true });
        db.createObjectStore('versions', { keyPath: ['shimId', 'version'] }).createIndex('byShim', 'shimId');
        const ud = db.createObjectStore('user_data', { keyPath: ['shimId', 'origin', 'key'] });
        ud.createIndex('byShim', 'shimId');
        ud.createIndex('byScope', ['shimId', 'origin']);
        db.createObjectStore('rule_state', { keyPath: ['shimId', 'ruleId'] }).createIndex('byShim', 'shimId');
        db.createObjectStore('prefs', { keyPath: 'key' });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = old.transaction('shims', 'readwrite');
      tx.objectStore('shims').put(shim('kept', 1));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    old.close();
    const upgraded = await openShimStore(fakeIndexedDB, name);
    check('the shim from version 1 is still there', (await upgraded.getShim('kept')) !== null);
    await upgraded.baselines.record('kept', 'example.com', '/', 'h');
    check('and the new store works', (await upgraded.baselines.forHost('kept', 'example.com'))['/'] === 'h');
    await upgraded.settings.set('kept', 'units', 'metric');
    check('and the settings store (version 3) works', (await upgraded.settings.get('kept')).units === 'metric');
    upgraded.close();
  }

  console.log('');
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log(`all store checks passed (${passes})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
