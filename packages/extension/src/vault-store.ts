// The vault's own IndexedDB: the vault record, the sealed secret values and
// the credential grants, in a database apart from the shim store
// (store.ts). Apart so that
//
//   - a reset clears secrets and grants and writes the new record in one
//     transaction, touching nothing else; and
//   - an older build, which opens the shim store at its own schema version
//     and knows nothing of this database, still opens its store after a
//     downgrade (an IndexedDB opened below its version fails outright).
//
// It holds only ciphertext and approvals: a value never reaches it in the
// clear (vault-keeper.ts seals it first), and nothing here ever travels with
// an export. A shim's rows go when the shim does (deleteShim), and rows
// whose shim is gone are swept at boot (ids are never reused, so such a row
// could never answer for anything anyway).

import type { SecretRow } from './vault-keeper';
import type { GrantRow } from './credential-grants';

export const VAULT_DB_NAME = 'shim-for-chrome-vault';
export const VAULT_DB_VERSION = 1;

const META = 'meta';
const SECRETS = 'secrets';
const GRANTS = 'grants';
const BY_SHIM = 'byShim';
const RECORD_KEY = 'vault';

export interface VaultStore {
  record(): Promise<unknown>;
  saveRecord(record: unknown): Promise<void>;
  secrets: {
    get(shimId: string, key: string): Promise<SecretRow | undefined>;
    put(row: SecretRow): Promise<void>;
    delete(shimId: string, key: string): Promise<boolean>;
    list(): Promise<SecretRow[]>;
    listForShim(shimId: string): Promise<SecretRow[]>;
  };
  grants: {
    get(shimId: string, key: string): Promise<GrantRow | undefined>;
    listForShim(shimId: string): Promise<GrantRow[]>;
    /** Every grant, of every shim. */
    list(): Promise<GrantRow[]>;
    put(row: GrantRow): Promise<void>;
    delete(shimId: string, key: string): Promise<boolean>;
    /** Re-bind this shim's grants at digest `from` to `to` (an anchor-only rebase); answers how many moved. */
    rebind(shimId: string, from: string, to: string): Promise<number>;
  };
  /** Every secret and grant of one shim. */
  deleteShim(shimId: string): Promise<void>;
  /** Rows of shims not in `live`; answers how many went. */
  sweep(live: ReadonlySet<string>): Promise<number>;
  /** In one transaction: the record set to `record` (or removed), every secret row and every grant cleared. */
  reset(record: unknown): Promise<void>;
  /** In one transaction: the record set to `record`, and exactly `rows` in place of every secret row. */
  replace(record: unknown, rows: readonly SecretRow[]): Promise<void>;
  close(): void;
}

function upgrade(db: IDBDatabase, from: number): void {
  if (from < 1) {
    db.createObjectStore(META);
    db.createObjectStore(SECRETS, { keyPath: ['shimId', 'key'] }).createIndex(BY_SHIM, 'shimId');
    db.createObjectStore(GRANTS, { keyPath: ['shimId', 'key'] }).createIndex(BY_SHIM, 'shimId');
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function completion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

// Plain data only: what is stored is what JSON would carry.
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function openVaultStore(factory: IDBFactory = indexedDB, name: string = VAULT_DB_NAME): Promise<VaultStore> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(name, VAULT_DB_VERSION);
    open.onupgradeneeded = (event) => upgrade(open.result, event.oldVersion);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('could not open the vault store'));
    open.onblocked = () => reject(new Error('the vault store is open elsewhere at an older version'));
  }).then(bind);
}

function bind(db: IDBDatabase): VaultStore {
  const read = (stores: string | string[]) => db.transaction(stores, 'readonly');
  const write = (stores: string | string[]) => db.transaction(stores, 'readwrite');
  const deleteOne = async (storeName: string, key: IDBValidKey): Promise<boolean> => {
    const tx = write(storeName);
    const done = completion(tx);
    const store = tx.objectStore(storeName);
    const existing = await request(store.getKey(key));
    if (existing === undefined) {
      tx.abort();
      await done.catch(() => undefined);
      return false;
    }
    store.delete(key);
    await done;
    return true;
  };
  const putOne = async (storeName: string, value: unknown): Promise<void> => {
    const tx = write(storeName);
    tx.objectStore(storeName).put(plain(value));
    await completion(tx);
  };
  const byShim = <T>(storeName: string, shimId: string): Promise<T[]> =>
    request(read(storeName).objectStore(storeName).index(BY_SHIM).getAll(shimId) as IDBRequest<T[]>);

  return {
    async record() {
      return request(read(META).objectStore(META).get(RECORD_KEY) as IDBRequest<unknown>);
    },
    async saveRecord(record) {
      const tx = write(META);
      tx.objectStore(META).put(plain(record), RECORD_KEY);
      await completion(tx);
    },
    secrets: {
      get: (shimId, key) => request(read(SECRETS).objectStore(SECRETS).get([shimId, key]) as IDBRequest<SecretRow | undefined>),
      put: (row) => putOne(SECRETS, row),
      delete: (shimId, key) => deleteOne(SECRETS, [shimId, key]),
      list: () => request(read(SECRETS).objectStore(SECRETS).getAll() as IDBRequest<SecretRow[]>),
      listForShim: (shimId) => byShim<SecretRow>(SECRETS, shimId),
    },
    grants: {
      get: (shimId, key) => request(read(GRANTS).objectStore(GRANTS).get([shimId, key]) as IDBRequest<GrantRow | undefined>),
      listForShim: (shimId) => byShim<GrantRow>(GRANTS, shimId),
      list: () => request(read(GRANTS).objectStore(GRANTS).getAll() as IDBRequest<GrantRow[]>),
      put: (row) => putOne(GRANTS, row),
      delete: (shimId, key) => deleteOne(GRANTS, [shimId, key]),
      async rebind(shimId, from, to) {
        const tx = write(GRANTS);
        const done = completion(tx);
        const store = tx.objectStore(GRANTS);
        const rows = await request(store.index(BY_SHIM).getAll(shimId) as IDBRequest<GrantRow[]>);
        let n = 0;
        for (const row of rows) {
          if (row.digest !== from) continue;
          store.put({ ...row, digest: to } satisfies GrantRow);
          n++;
        }
        await done;
        return n;
      },
    },
    async deleteShim(shimId) {
      const tx = write([SECRETS, GRANTS]);
      const done = completion(tx);
      for (const name of [SECRETS, GRANTS]) {
        const store = tx.objectStore(name);
        for (const k of await request(store.index(BY_SHIM).getAllKeys(shimId))) store.delete(k);
      }
      await done;
    },
    async sweep(live) {
      const tx = write([SECRETS, GRANTS]);
      const done = completion(tx);
      let n = 0;
      for (const name of [SECRETS, GRANTS]) {
        const store = tx.objectStore(name);
        const rows = await request(store.getAll() as IDBRequest<Array<{ shimId: string; key: string }>>);
        for (const row of rows) {
          if (live.has(row.shimId)) continue;
          store.delete([row.shimId, row.key]);
          n++;
        }
      }
      await done;
      return n;
    },
    async reset(record) {
      const tx = write([META, SECRETS, GRANTS]);
      if (record === null || record === undefined) tx.objectStore(META).delete(RECORD_KEY);
      else tx.objectStore(META).put(plain(record), RECORD_KEY);
      tx.objectStore(SECRETS).clear();
      tx.objectStore(GRANTS).clear();
      await completion(tx);
    },
    async replace(record, rows) {
      const tx = write([META, SECRETS]);
      tx.objectStore(META).put(plain(record), RECORD_KEY);
      const secrets = tx.objectStore(SECRETS);
      secrets.clear();
      for (const row of rows) secrets.put(plain(row));
      await completion(tx);
    },
    close() {
      db.close();
    },
  };
}
