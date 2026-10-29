// The vault's formats, cryptography and state machine (vault-crypto.ts,
// vault-keeper.ts) and its database (vault-store.ts), without a browser:
// the record and sealed-value formats and their bounds, binding of a value
// to its vault, shim, field and placement, passphrase rules, and the
// lifecycle under adversarial interleavings: a wrong passphrase changes
// nothing, lock wins at every await, a worker evicted mid-operation, expiry
// checked on every wake, idle renewal only from the user's own activity,
// corrupt or partial records refused (and reset offered), reset clearing
// secrets and grants in one transaction, change of passphrase and rotation
// of the data key, and the downgrade contract (the shim store's version is
// untouched).
//
//   node out/packages/extension/test/vault-keeper-harness.js

import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import {
  createVault, unwrapDataKey, sealSecret, openSecret, parseVaultRecord, parseSealed, passphraseProblem, suggestPassphrase, rewrapVault,
  additionalData, fromB64, toB64, KDF_MIN_ITERATIONS, type VaultRecord,
} from '../src/vault-crypto';
import { VaultKeeper, VAULT_ERRORS, UNLOCK_MAX_MS, LOCK_AFTER_CHOICES, type VaultKeeperDeps, type SecretRow } from '../src/vault-keeper';
import { openVaultStore, type VaultStore } from '../src/vault-store';
import { openShimStore, STORE_SCHEMA_VERSION } from '../src/store';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { passes++; console.log(`  ✓ ${label}`); return; }
  failures++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
}

const errOf = (r: { ok: boolean }): string => ('error' in r && typeof r.error === 'string' ? r.error : '');
const PASS = 'tavor-mikel-dusan-pobit-zelur';
const PASS2 = 'gamon-ritul-vasek-nobed-hulip';

/** The keeper's world: a vault store on an in-memory IndexedDB, a session record, a clock, and hooks run at chosen awaits. */
interface World {
  deps: VaultKeeperDeps;
  db: VaultStore;
  session: { value: unknown };
  clock: { now: number };
  scheduled: Array<number | null>;
  /** Called at every dep call by name, before it resolves (an await point of the keeper). */
  hook: { at?: (name: string) => void | Promise<void> };
  lockAfter: { value: unknown };
}

let worldSeq = 0;
async function world(shared?: { db: VaultStore; session: { value: unknown }; clock: { now: number }; lockAfter: { value: unknown } }): Promise<World> {
  const db = shared?.db ?? await openVaultStore(fakeIndexedDB, `vault-keeper-harness-${Date.now()}-${++worldSeq}`);
  const session = shared?.session ?? { value: undefined };
  const clock = shared?.clock ?? { now: 1_000_000 };
  const lockAfter = shared?.lockAfter ?? { value: undefined };
  const hook: World['hook'] = {};
  const scheduled: Array<number | null> = [];
  const at = async (name: string): Promise<void> => { await hook.at?.(name); };
  const deps: VaultKeeperDeps = {
    loadRecord: async () => { await at('loadRecord'); return db.record(); },
    saveRecord: async (r) => { await at('saveRecord'); await db.saveRecord(r); },
    resetAll: async (r) => { await at('resetAll'); await db.reset(r); },
    replaceAll: async (r, rows) => { await at('replaceAll'); await db.replace(r, rows); },
    listRows: async () => { await at('listRows'); return db.secrets.list(); },
    getRow: async (s, k) => { await at('getRow'); return db.secrets.get(s, k); },
    putRow: async (row) => { await at('putRow'); await db.secrets.put(row); },
    deleteRow: async (s, k) => { await at('deleteRow'); return db.secrets.delete(s, k); },
    session: {
      get: async () => { await at('session.get'); return session.value; },
      set: async (v) => { await at('session.set'); session.value = structuredClone(v); },
      remove: async () => { await at('session.remove'); session.value = undefined; },
    },
    lockAfterMs: async () => lockAfter.value,
    setLockAfterMs: async (ms) => { lockAfter.value = ms; },
    now: () => clock.now,
    schedule: (when) => { scheduled.push(when); },
  };
  return { deps, db, session, clock, scheduled, hook, lockAfter };
}

const PLACE = JSON.stringify(['header', 'https://api.example.com', 'Authorization', 'Bearer {}']);
const PLACE_Q = JSON.stringify(['query', 'https://api.example.com', 'key', '{}']);

async function main(): Promise<void> {
  console.log('\n=== vault keeper harness ===\n');

  console.log('formats and cryptography');
  {
    const { record, dataKey } = await createVault(PASS);
    check('a new record parses as its own format', parseVaultRecord(record) !== null);
    check('the KDF is PBKDF2-SHA256 at 600,000 iterations with a 16-byte salt', record.kdf.name === 'PBKDF2-SHA256' && record.kdf.iterations === 600_000 && fromB64(record.kdf.salt)?.length === 16);
    const unwrapped = await unwrapDataKey(record, PASS);
    check('the passphrase unwraps the data key', unwrapped !== null && toB64(unwrapped.raw) === toB64(dataKey.raw));
    check('a wrong passphrase does not', (await unwrapDataKey(record, PASS2)) === null);
    check('NFC: a decomposed spelling unlocks what the composed one set', (await unwrapDataKey((await createVault('café-mikel-dusan-pobit')).record, 'café-mikel-dusan-pobit')) !== null);
    const binding = { vaultId: record.vaultId, shimId: 's1', key: 'apiKey', placement: PLACE };
    const sealed = await sealSecret(dataKey, binding, 'sk-secret-123');
    check('a sealed value parses', parseSealed(sealed) !== null);
    check('it opens under its binding', (await openSecret(dataKey, binding, sealed)) === 'sk-secret-123');
    check('not for another shim', (await openSecret(dataKey, { ...binding, shimId: 's2' }, sealed)) === null);
    check('not for another field', (await openSecret(dataKey, { ...binding, key: 'other' }, sealed)) === null);
    check('not for another placement', (await openSecret(dataKey, { ...binding, placement: PLACE_Q }, sealed)) === null);
    check('not in another vault', (await openSecret(dataKey, { ...binding, vaultId: toB64(new Uint8Array(16)) }, sealed)) === null);
    const other = await createVault(PASS);
    check('not under another data key', (await openSecret(other.dataKey, binding, sealed)) === null);
    const flipped = { ...sealed, ct: toB64((() => { const b = fromB64(sealed.ct) ?? new Uint8Array(0); b[0] = (b[0] ?? 0) ^ 1; return b; })()) };
    check('a tampered ciphertext does not open', (await openSecret(dataKey, binding, flipped)) === null);
    const ivs = new Set<string>();
    for (let i = 0; i < 20; i++) ivs.add((await sealSecret(dataKey, binding, 'v')).iv);
    check('every seal takes a fresh IV', ivs.size === 20);
    check('length-delimited AAD: ["ab","c"] and ["a","bc"] differ', toB64(additionalData(['ab', 'c'])) !== toB64(additionalData(['a', 'bc'])));
    check('a value of 0 bytes is refused', await sealSecret(dataKey, binding, '').then(() => false, () => true));
    check('a value over 8 KiB is refused', await sealSecret(dataKey, binding, 'x'.repeat(8193)).then(() => false, () => true));
    const rewrapped = await rewrapVault(record, dataKey, PASS2);
    check('a new passphrase wraps the same data key (new salt)', rewrapped.kdf.salt !== record.kdf.salt && (await unwrapDataKey(rewrapped, PASS2)) !== null && (await unwrapDataKey(rewrapped, PASS)) === null);
    check('the vault id stays', rewrapped.vaultId === record.vaultId);

    console.log('corrupt records refuse');
    const bad = (label: string, mutate: (r: Record<string, unknown>) => void): void => {
      const r = structuredClone(record) as unknown as Record<string, unknown>;
      mutate(r);
      check(label, parseVaultRecord(r) === null);
    };
    bad('an unknown format', (r) => { r.format = 2; });
    bad('an extra field', (r) => { r.extra = 1; });
    bad('a missing field', (r) => { delete r.wrapped; });
    bad('iterations below the floor (a downgrade)', (r) => { (r.kdf as Record<string, unknown>).iterations = KDF_MIN_ITERATIONS - 1; });
    bad('iterations past the ceiling (a denial of service)', (r) => { (r.kdf as Record<string, unknown>).iterations = 50_000_000; });
    bad('a fractional iteration count', (r) => { (r.kdf as Record<string, unknown>).iterations = 600000.5; });
    bad('another KDF', (r) => { (r.kdf as Record<string, unknown>).name = 'scrypt'; });
    bad('a short salt', (r) => { (r.kdf as Record<string, unknown>).salt = 'AAAA'; });
    bad('a wrapped key of the wrong length', (r) => { (r.wrapped as Record<string, unknown>).ct = 'AAAA'; });
    bad('a vault id that is not base64url', (r) => { r.vaultId = 'not base64!!'; });
    check('null and arrays are not records', parseVaultRecord(null) === null && parseVaultRecord([]) === null && parseVaultRecord('x') === null);
    check('a sealed value with an extra field is refused', parseSealed({ ...sealed, x: 1 }) === null);
    check('a sealed value with a short IV is refused', parseSealed({ ...sealed, iv: 'AAAA' }) === null);
    check('createVault refuses iterations below the floor', await createVault(PASS, 1000).then(() => false, () => true));
  }

  console.log('passphrases');
  check('too short is refused', passphraseProblem('short') !== null);
  check('a common password is refused', passphraseProblem('password1234') !== null && passphraseProblem('Password 1234') !== null);
  check('a common password repeated is refused', passphraseProblem('letmeinletmein') !== null);
  check('a long run of one character is refused', passphraseProblem('aaaaaaaaaaaaaaaa') !== null);
  check('not text is refused', passphraseProblem(42) !== null);
  check('over 1024 characters is refused', passphraseProblem('ab'.repeat(600)) !== null);
  check('a suggestion is accepted', passphraseProblem(suggestPassphrase()) === null);
  {
    const s = suggestPassphrase();
    check('a suggestion is five pronounceable words', /^([bdfghjklmnprstvz][aeiou]){2}[bdfghjklmnprstvz](-([bdfghjklmnprstvz][aeiou]){2}[bdfghjklmnprstvz]){4}$/.test(s), s);
    const many = new Set(Array.from({ length: 200 }, () => suggestPassphrase()));
    check('suggestions do not repeat', many.size === 200);
  }

  console.log('the state machine');
  {
    const w = await world();
    const k = new VaultKeeper(w.deps);
    check('none at first', (await k.status()).state === 'none');
    check('unlocking with no vault refuses', !(await k.unlock(PASS)).ok);
    check('a weak passphrase is refused at setup', !(await k.setup('password1234')).ok && (await k.status()).state === 'none');
    // An approval given before the first vault (the install review, or the settings page).
    await w.db.grants.put({ shimId: 's1', key: 'apiKey', binding: PLACE, digest: 'd', grantedAt: 1 });
    check('setup', (await k.setup(PASS)).ok);
    check('setup keeps an approval given before it (approvals are not values)', (await w.db.grants.get('s1', 'apiKey')) !== undefined);
    const st = await k.status();
    check('setup leaves it unlocked, expiring 12 h on', st.state === 'unlocked' && st.expiresAt === w.clock.now + UNLOCK_MAX_MS, st);
    check('a second setup is refused', errOf(await k.setup(PASS2)) === VAULT_ERRORS.exists);
    check('an alarm is scheduled at the deadline', w.scheduled.at(-1) === w.clock.now + UNLOCK_MAX_MS);
    check('a secret is set', (await k.setSecret('s1', 'apiKey', PLACE, 'sk-1')).ok);
    const revealed = await k.reveal('s1', 'apiKey', PLACE);
    check('and revealed with the generation', revealed.ok && revealed.value === 'sk-1' && k.isCurrent(revealed.gen));
    check('the stored row is ciphertext only', !JSON.stringify(await w.db.secrets.list()).includes('sk-1'));
    check('the session record holds no passphrase', !JSON.stringify(w.session.value).includes(PASS));
    check('a placement other than the one entered is unreadable', (await k.reveal('s1', 'apiKey', PLACE_Q)).ok === false);
    check('an unset key says so', (await k.reveal('s1', 'nope', PLACE) as { code?: string }).code === 'unset');
    const gen = revealed.ok ? revealed.gen : -1;
    await k.lock();
    check('lock: the old generation is not current', !k.isCurrent(gen));
    check('lock: reveal refuses', (await k.reveal('s1', 'apiKey', PLACE) as { code?: string }).code === 'locked');
    check('lock: the session record is gone', w.session.value === undefined);
    check('lock: the alarm is cleared', w.scheduled.at(-1) === null);
    check('lock: setting a secret refuses', errOf(await k.setSecret('s1', 'apiKey', PLACE, 'x')) === VAULT_ERRORS.locked);

    console.log('a wrong passphrase changes nothing');
    const genBefore = k.generation();
    const rowsBefore = JSON.stringify(await w.db.secrets.list());
    const recordBefore = JSON.stringify(await w.db.record());
    check('it is refused', errOf(await k.unlock(PASS2)) === VAULT_ERRORS.wrong);
    check('the generation, the rows, the record and the session are as they were',
      k.generation() === genBefore && JSON.stringify(await w.db.secrets.list()) === rowsBefore && JSON.stringify(await w.db.record()) === recordBefore && w.session.value === undefined);
    check('still locked', (await k.status()).state === 'locked');
    check('not text is refused', !(await k.unlock({ toString: () => PASS })).ok);
    check('the right one unlocks', (await k.unlock(PASS)).ok && (await k.status()).state === 'unlocked');

    console.log('worker eviction: a new keeper over the same storage');
    const k2 = new VaultKeeper((await world({ db: w.db, session: w.session, clock: w.clock, lockAfter: w.lockAfter })).deps);
    const after = await k2.reveal('s1', 'apiKey', PLACE);
    check('a woken worker reads the unlocked key from the session record', after.ok && after.value === 'sk-1');
    w.clock.now += UNLOCK_MAX_MS;
    const k3 = new VaultKeeper((await world({ db: w.db, session: w.session, clock: w.clock, lockAfter: w.lockAfter })).deps);
    check('expiry is checked on wake: past 12 h it is locked', (await k3.status()).state === 'locked' && w.session.value === undefined);
    check('and the earlier worker, still running, refuses too', !(await k2.reveal('s1', 'apiKey', PLACE)).ok);
  }

  console.log('expiry and idle renewal');
  {
    const w = await world();
    const k = new VaultKeeper(w.deps);
    await k.setup(PASS);
    check('lock-after accepts only its choices', !(await k.setLockAfter(1234)).ok && (await k.setLockAfter(LOCK_AFTER_CHOICES[0])).ok);
    const quarter = LOCK_AFTER_CHOICES[0] ?? 0;
    const r = await k.reveal('x', 'y', PLACE);
    void r;
    w.clock.now += quarter - 1000;
    await k.setSecret('s', 'k', PLACE, 'v');
    const used = await k.reveal('s', 'k', PLACE);
    check('a shim using a secret does not renew the idle window', used.ok && (await k.status()).expiresAt === 1_000_000 + quarter);
    w.clock.now += 2000;
    check('past the idle window it is locked (checked at use, no alarm needed)', !(await k.reveal('s', 'k', PLACE)).ok && (await k.status()).state === 'locked');
    await k.unlock(PASS);
    const t0 = w.clock.now;
    w.clock.now += quarter - 1000;
    await k.touch();
    w.clock.now += quarter - 1000;
    check('the user\'s own activity renews it', (await k.status()).state === 'unlocked');
    // Renewal never passes the absolute limit.
    for (let i = 0; i < 60; i++) { w.clock.now += quarter - 1000; await k.touch(); }
    check('but never past 12 hours from unlocking', w.clock.now > t0 + UNLOCK_MAX_MS ? (await k.status()).state === 'locked' : false, { now: w.clock.now - t0 });
    // isCurrent itself enforces the deadline synchronously.
    await k.unlock(PASS);
    const g = k.generation();
    w.clock.now += UNLOCK_MAX_MS;
    check('isCurrent is false past the deadline, synchronously', !k.isCurrent(g));
  }

  console.log('lock wins at every await');
  {
    type Op = 'setup' | 'unlock' | 'changePassphrase' | 'reset' | 'rotateDataKey';
    const cases: Array<[Op, string[]]> = [
      ['setup', ['loadRecord', 'replaceAll', 'session.set']],
      ['unlock', ['loadRecord', 'session.set']],
      ['changePassphrase', ['loadRecord', 'saveRecord', 'session.set']],
      ['reset', ['session.remove', 'resetAll', 'session.set']],
      ['rotateDataKey', ['loadRecord', 'listRows', 'replaceAll', 'session.set']],
    ];
    for (const [op, names] of cases) {
      for (const name of names) {
        const w = await world();
        const k = new VaultKeeper(w.deps);
        if (op !== 'setup') {
          await k.setup(PASS);
          await k.setSecret('s', 'k', PLACE, 'v');
          await k.lock();
        }
        let fired = false;
        w.hook.at = (n) => { if (n === name && !fired) { fired = true; void k.lock(); } };
        const res = op === 'setup' ? await k.setup(PASS)
          : op === 'unlock' ? await k.unlock(PASS)
            : op === 'changePassphrase' ? await k.changePassphrase(PASS, PASS2)
              : op === 'reset' ? await k.reset(PASS2)
                : await k.rotateDataKey(PASS);
        w.hook.at = undefined;
        await new Promise((r) => setTimeout(r, 5));
        const st = await k.status();
        check(`${op}: a lock at ${name} leaves it locked`, fired && st.state !== 'unlocked' && w.session.value === undefined, { res, st, fired });
      }
    }
    // A reveal that had read its value before a lock is caught by the final synchronous check.
    const w = await world();
    const k = new VaultKeeper(w.deps);
    await k.setup(PASS);
    await k.setSecret('s', 'k', PLACE, 'v');
    w.hook.at = (n) => { if (n === 'getRow') void k.lock(); };
    const r = await k.reveal('s', 'k', PLACE);
    w.hook.at = undefined;
    check('a lock during a reveal: whatever it answered is not current', !r.ok || !k.isCurrent(r.gen));
    // A secret entry racing a lock writes nothing.
    await k.unlock(PASS);
    const rows = (await w.db.secrets.list()).length;
    w.hook.at = (n) => { if (n === 'putRow') void k.lock(); };
    const set = await k.setSecret('s', 'k2', PLACE, 'v2');
    w.hook.at = undefined;
    check('a value sealed under a generation a lock ended is not written', set.ok === false || (await w.db.secrets.list()).length === rows + 1, set);
  }

  console.log('corrupt or partial records');
  {
    const w = await world();
    const k = new VaultKeeper(w.deps);
    await k.setup(PASS);
    await k.setSecret('s', 'k', PLACE, 'v');
    await k.lock();
    const rec = await w.db.record() as Record<string, unknown>;
    await w.db.saveRecord({ ...rec, wrapped: { iv: (rec.wrapped as Record<string, unknown>).iv } });
    const fresh = new VaultKeeper(w.deps);
    check('a partly written record reads as corrupt', (await fresh.status()).state === 'corrupt');
    check('unlock refuses with the reset offer', errOf(await fresh.unlock(PASS)) === VAULT_ERRORS.corrupt);
    check('a secret cannot be revealed', !(await fresh.reveal('s', 'k', PLACE)).ok);
    check('reset is the way out', (await fresh.reset(PASS2)).ok && (await fresh.status()).state === 'unlocked');
    check('reset cleared every secret', (await w.db.secrets.list()).length === 0);
    // A sealed row damaged in place answers unreadable.
    await fresh.setSecret('s', 'k', PLACE, 'v');
    const row = await w.db.secrets.get('s', 'k') as SecretRow;
    await w.db.secrets.put({ ...row, sealed: { ...row.sealed, ct: row.sealed.ct.slice(0, -4) + 'AAAA' } });
    check('a damaged row is unreadable, never a wrong value', (await fresh.reveal('s', 'k', PLACE) as { code?: string }).code === 'unreadable');
    // A session record for another vault, or a damaged one, is dropped.
    w.session.value = { ...(w.session.value as object), vaultId: toB64(new Uint8Array(16)) };
    const other = new VaultKeeper(w.deps);
    check('a session record for another vault does not unlock', (await other.status()).state === 'locked' && w.session.value === undefined);
    w.session.value = { junk: true };
    check('a damaged session record does not unlock', (await new VaultKeeper(w.deps).status()).state === 'locked');
  }

  console.log('reset, change passphrase, rotate');
  {
    const w = await world();
    const k = new VaultKeeper(w.deps);
    await k.setup(PASS);
    await k.setSecret('a', 'k', PLACE, 'va');
    await k.setSecret('b', 'k', PLACE_Q, 'vb');
    await w.db.grants.put({ shimId: 'a', key: 'k', binding: PLACE, digest: 'd', grantedAt: 1 });
    const oldId = (await w.db.record() as VaultRecord).vaultId;
    check('change passphrase needs the current one', errOf(await k.changePassphrase(PASS2, PASS2)) === VAULT_ERRORS.wrong);
    check('change passphrase', (await k.changePassphrase(PASS, PASS2)).ok);
    await k.lock();
    check('the old passphrase no longer unlocks', !(await k.unlock(PASS)).ok);
    check('the new one does, secrets intact', (await k.unlock(PASS2)).ok && ((await k.reveal('a', 'k', PLACE)) as { value?: string }).value === 'va');
    const before = (await w.db.secrets.list()).map((r) => r.sealed.ct).join();
    const rot = await k.rotateDataKey(PASS2);
    check('rotate the data key', rot.ok && rot.dropped === 0, rot);
    check('every row re-encrypted', (await w.db.secrets.list()).map((r) => r.sealed.ct).join() !== before);
    check('and still readable', ((await k.reveal('b', 'k', PLACE_Q)) as { value?: string }).value === 'vb');
    check('the vault id is kept', (await w.db.record() as VaultRecord).vaultId === oldId);
    // A worker that dies right after a rotation commits: the next one must not take the old key as current.
    {
      const w2 = await world();
      const r1 = new VaultKeeper(w2.deps);
      await r1.setup(PASS);
      await r1.setSecret('a', 'k', PLACE, 'va');
      let afterCommit: VaultKeeper | null = null;
      w2.hook.at = async (n) => {
        if (n !== 'session.set' || afterCommit) return;
        // replaceAll has committed (session.set comes after it): a new worker starts here.
        afterCommit = new VaultKeeper((await world({ db: w2.db, session: w2.session, clock: w2.clock, lockAfter: w2.lockAfter })).deps);
        const st = await afterCommit.status();
        check('a worker woken between the rotation\'s commit and its new key sees the vault locked', st.state === 'locked', st);
      };
      await r1.rotateDataKey(PASS);
      w2.hook.at = undefined;
      const r2 = new VaultKeeper((await world({ db: w2.db, session: w2.session, clock: w2.clock, lockAfter: w2.lockAfter })).deps);
      await r2.lock();
      check('it unlocks with the passphrase, under the new key', (await r2.unlock(PASS)).ok && ((await r2.reveal('a', 'k', PLACE)) as { value?: string }).value === 'va');
      await r2.setSecret('a', 'k', PLACE, 'vb');
      await r2.lock();
      await r2.unlock(PASS);
      check('a value saved after it stays readable across lock and unlock', ((await r2.reveal('a', 'k', PLACE)) as { value?: string }).value === 'vb');
    }
    const gen = k.generation();
    check('reset needs a valid passphrase', !(await k.reset('short')).ok);
    check('reset', (await k.reset(PASS)).ok);
    check('reset moved the generation', k.generation() !== gen && !k.isCurrent(gen));
    check('a new vault id', (await w.db.record() as VaultRecord).vaultId !== oldId);
    check('every secret and grant cleared in one go', (await w.db.secrets.list()).length === 0 && (await w.db.grants.listForShim('a')).length === 0);
  }

  console.log('the databases');
  {
    const name = `vault-keeper-harness-shim-store-${Date.now()}`;
    const s = await openShimStore(fakeIndexedDB, name);
    s.close();
    const opened = await new Promise<number>((resolve, reject) => {
      // What an older build does: open the shim store at its own version.
      const req = fakeIndexedDB.open(name, 3);
      req.onsuccess = () => { const v = req.result.version; req.result.close(); resolve(v); };
      req.onerror = () => reject(req.error ?? new Error('open failed'));
    });
    check('the shim store keeps its schema version, so an older build still opens it', STORE_SCHEMA_VERSION === 3 && opened === 3);
    const v = await openVaultStore(fakeIndexedDB, `vault-keeper-harness-store-${Date.now()}`);
    await v.secrets.put({ shimId: 'gone', key: 'k', classification: 'secret', placement: PLACE, sealed: { format: 1, iv: 'a', ct: 'b' }, updatedAt: 1 });
    await v.secrets.put({ shimId: 'live', key: 'k', classification: 'secret', placement: PLACE, sealed: { format: 1, iv: 'a', ct: 'b' }, updatedAt: 1 });
    await v.grants.put({ shimId: 'gone', key: 'k', binding: PLACE, digest: 'd', grantedAt: 1 });
    check('a sweep removes the rows of shims that are gone', (await v.sweep(new Set(['live']))) === 2 && (await v.secrets.list()).length === 1);
    await v.grants.put({ shimId: 'live', key: 'k', binding: PLACE, digest: 'old', grantedAt: 1 });
    await v.grants.put({ shimId: 'live', key: 'j', binding: PLACE, digest: 'other', grantedAt: 1 });
    check('rebind moves only grants at the old digest', (await v.grants.rebind('live', 'old', 'new')) === 1 && (await v.grants.get('live', 'k'))?.digest === 'new' && (await v.grants.get('live', 'j'))?.digest === 'other');
    await v.deleteShim('live');
    check('a shim\'s removal takes its secrets and grants', (await v.secrets.list()).length === 0 && (await v.grants.listForShim('live')).length === 0);
  }

  console.log('');
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log(`all vault keeper checks passed (${passes})`);
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
