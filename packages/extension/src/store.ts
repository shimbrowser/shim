// The extension's store: IndexedDB in the service worker. The unit is the
// installed shim (its `shim/1` envelope plus what the install recorded), and
// beside it the stores the later phases fill:
//
//   shims       id → the installed shim
//   versions    [shimId, version] → a restorable snapshot (every commit and rebase)
//   user_data   [shimId, origin, key] → a handler's `api.storage` row
//   rule_state  [shimId, ruleId] → quarantine and page memory
//   prefs       key → an extension setting
//
// `user_data` has the semantics every Shim host gives `api.storage`: JSON
// values, a missing key reads null, `set` answers the value, `delete`
// whether a row went away, `list` the bucket as a record. What travels and
// what does not is the install's and the export's business, not the store's.
//
// The schema is versioned; `upgrade` runs the steps from the stored version
// to this one, so an extension update migrates before anything is
// registered. The factory is a parameter so a harness runs this on an
// in-memory IndexedDB.

import type { Spec } from '@shimbrowser/core/types';
import type { InstallProvenance, UserDataRow } from './install';
import type { ExtensionMode } from './capabilities';

export const STORE_DB_NAME = 'shim-for-chrome';
export const STORE_SCHEMA_VERSION = 1;

export interface InstalledShim {
  id: string;
  name: string;
  enabled: boolean;
  installedAt: number;
  /**
   * The shim's place in the cascade: lower is higher up, and the top wins a
   * cross-shim conflict. Assigned once at install (one past the highest
   * live rank) and never shifted by another shim's install or removal, so
   * a running document's priorities stay right whatever happens around it.
   */
  rank: number;
  provenance: InstallProvenance;
  /** The mode the install preflighted against. */
  mode: ExtensionMode;
  /** The spec, with `id` set to this install's id. */
  spec: Spec;
  handlers: Record<string, string>;
  /** The envelope's other fields, for export. */
  envelope: Record<string, unknown>;
}

export interface UserDataScope {
  shimId: string;
  origin: string;
}

interface UserDataRecord extends UserDataRow {
  shimId: string;
  updatedAt: number;
}

interface PrefRecord {
  key: string;
  value: unknown;
}

export interface ShimStore {
  /** Every installed shim in cascade order (lowest rank first; the top wins). */
  listShims(): Promise<InstalledShim[]>;
  getShim(id: string): Promise<InstalledShim | null>;
  /**
   * Adds a new shim and gives it its rank, one past the highest, in one
   * readwrite transaction: two installs in flight at once can never take
   * the same rank (the index is unique besides). Answers the rank.
   */
  addShim(shim: Omit<InstalledShim, 'rank'>): Promise<number>;
  /** Writes a shim as given (an update of an existing one; a new one goes through addShim). */
  putShim(shim: InstalledShim): Promise<void>;
  /** Removes the shim and, in the same transaction, its versions, user data and rule state. */
  deleteShim(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<boolean>;
  userData: {
    get(scope: UserDataScope, key: string): Promise<unknown>;
    set(scope: UserDataScope, key: string, value: unknown): Promise<unknown>;
    delete(scope: UserDataScope, key: string): Promise<boolean>;
    list(scope: UserDataScope): Promise<Record<string, unknown>>;
    /** Writes the rows a `.shim` file carried for `shimId` (an install's opt-in user data). */
    restore(shimId: string, rows: readonly UserDataRow[]): Promise<number>;
  };
  prefs: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  close(): void;
}

const SHIMS = 'shims';
const VERSIONS = 'versions';
const USER_DATA = 'user_data';
const RULE_STATE = 'rule_state';
const PREFS = 'prefs';
const BY_SHIM = 'byShim';
const BY_SCOPE = 'byScope';
const BY_RANK = 'byRank';

function upgrade(db: IDBDatabase, from: number): void {
  if (from < 1) {
    db.createObjectStore(SHIMS, { keyPath: 'id' }).createIndex(BY_RANK, 'rank', { unique: true });
    db.createObjectStore(VERSIONS, { keyPath: ['shimId', 'version'] }).createIndex(BY_SHIM, 'shimId');
    const userData = db.createObjectStore(USER_DATA, { keyPath: ['shimId', 'origin', 'key'] });
    userData.createIndex(BY_SHIM, 'shimId');
    userData.createIndex(BY_SCOPE, ['shimId', 'origin']);
    db.createObjectStore(RULE_STATE, { keyPath: ['shimId', 'ruleId'] }).createIndex(BY_SHIM, 'shimId');
    db.createObjectStore(PREFS, { keyPath: 'key' });
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

// A value as it round-trips through JSON: undefined and functions become
// null, as in every other Shim host's store.
function jsonValue(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? null : JSON.parse(text);
}

// Own-property writes only: a key like "__proto__" is data, never a prototype.
function put<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

async function deleteByIndex(store: IDBObjectStore, index: string, key: IDBValidKey): Promise<number> {
  const keys = await request(store.index(index).getAllKeys(key));
  for (const k of keys) store.delete(k);
  return keys.length;
}

export function openShimStore(factory: IDBFactory = indexedDB, name: string = STORE_DB_NAME): Promise<ShimStore> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(name, STORE_SCHEMA_VERSION);
    open.onupgradeneeded = (event) => upgrade(open.result, event.oldVersion);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('could not open the shim store'));
    open.onblocked = () => reject(new Error('the shim store is open elsewhere at an older version'));
  }).then((db) => bind(db));
}

function bind(db: IDBDatabase): ShimStore {
  const read = (stores: string | string[]) => db.transaction(stores, 'readonly');
  const write = (stores: string | string[]) => db.transaction(stores, 'readwrite');

  const dataKey = (scope: UserDataScope, key: string): IDBValidKey => [scope.shimId, scope.origin, key];

  return {
    async listShims() {
      const shims = await request(read(SHIMS).objectStore(SHIMS).index(BY_RANK).getAll() as IDBRequest<InstalledShim[]>);
      // The index orders by rank; a tie (never minted, but a record is data)
      // by id, so the cascade order is the same on every read.
      return shims.sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    async addShim(shim) {
      const tx = write(SHIMS);
      const shims = tx.objectStore(SHIMS);
      // The highest rank is the last record of the rank index, read inside
      // the same transaction that writes the new record. (An index's
      // getAllKeys answers primary keys, not index keys, so a cursor from
      // the top it is.)
      const last = await request(shims.index(BY_RANK).openCursor(null, 'prev'));
      const top = last ? (last.value as InstalledShim).rank : 0;
      const rank = (Number.isFinite(top) ? top : 0) + 1;
      shims.add({ ...shim, rank });
      await completion(tx);
      return rank;
    },
    async getShim(id) {
      const shim = await request(read(SHIMS).objectStore(SHIMS).get(id) as IDBRequest<InstalledShim | undefined>);
      return shim ?? null;
    },
    async putShim(shim) {
      const tx = write(SHIMS);
      tx.objectStore(SHIMS).put(shim);
      await completion(tx);
    },
    async deleteShim(id) {
      const tx = write([SHIMS, VERSIONS, USER_DATA, RULE_STATE]);
      const shims = tx.objectStore(SHIMS);
      const existing = await request(shims.getKey(id));
      if (existing === undefined) {
        tx.abort();
        return false;
      }
      shims.delete(id);
      await deleteByIndex(tx.objectStore(VERSIONS), BY_SHIM, id);
      await deleteByIndex(tx.objectStore(USER_DATA), BY_SHIM, id);
      await deleteByIndex(tx.objectStore(RULE_STATE), BY_SHIM, id);
      await completion(tx);
      return true;
    },
    async setEnabled(id, enabled) {
      const tx = write(SHIMS);
      const shims = tx.objectStore(SHIMS);
      const shim = await request(shims.get(id) as IDBRequest<InstalledShim | undefined>);
      if (!shim) {
        tx.abort();
        return false;
      }
      shims.put({ ...shim, enabled });
      await completion(tx);
      return true;
    },
    userData: {
      async get(scope, key) {
        const row = await request(read(USER_DATA).objectStore(USER_DATA).get(dataKey(scope, key)) as IDBRequest<UserDataRecord | undefined>);
        return row ? row.value : null;
      },
      async set(scope, key, value) {
        const stored = jsonValue(value);
        const tx = write(USER_DATA);
        const row: UserDataRecord = { shimId: scope.shimId, origin: scope.origin, key, value: stored, updatedAt: Date.now() };
        tx.objectStore(USER_DATA).put(row);
        await completion(tx);
        return stored;
      },
      async delete(scope, key) {
        const tx = write(USER_DATA);
        const store = tx.objectStore(USER_DATA);
        const k = dataKey(scope, key);
        const existing = await request(store.getKey(k));
        if (existing === undefined) {
          tx.abort();
          return false;
        }
        store.delete(k);
        await completion(tx);
        return true;
      },
      async list(scope) {
        const rows = await request(read(USER_DATA).objectStore(USER_DATA).index(BY_SCOPE).getAll([scope.shimId, scope.origin]) as IDBRequest<UserDataRecord[]>);
        const out: Record<string, unknown> = {};
        for (const row of rows) put(out, row.key, row.value);
        return out;
      },
      async restore(shimId, rows) {
        if (rows.length === 0) return 0;
        const tx = write(USER_DATA);
        const store = tx.objectStore(USER_DATA);
        const now = Date.now();
        for (const row of rows) {
          store.put({ shimId, origin: row.origin, key: row.key, value: jsonValue(row.value), updatedAt: now } satisfies UserDataRecord);
        }
        await completion(tx);
        return rows.length;
      },
    },
    prefs: {
      async get(key) {
        const row = await request(read(PREFS).objectStore(PREFS).get(key) as IDBRequest<PrefRecord | undefined>);
        return row ? row.value : undefined;
      },
      async set(key, value) {
        const tx = write(PREFS);
        tx.objectStore(PREFS).put({ key, value: jsonValue(value) } satisfies PrefRecord);
        await completion(tx);
      },
    },
    close() {
      db.close();
    },
  };
}
