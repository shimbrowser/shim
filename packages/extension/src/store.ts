// The extension's store: IndexedDB in the service worker. The unit is the
// installed shim (its `shim/1` envelope plus what the install recorded), and
// beside it the stores the later phases fill:
//
//   shims       id → the installed shim
//   versions    [shimId, version] → every version the shim has been (install, rebase, restore), each restorable
//   user_data   [shimId, origin, key] → a handler's `api.storage` row
//   rule_state  [shimId, ruleId] → quarantine and page memory
//   baselines   [shimId, host, pathKey] → the deploy id a page kind was last seen at
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
export const STORE_SCHEMA_VERSION = 2;

/** Distinct page kinds kept per (shim, host); past this the least recently refreshed go. */
export const BASELINE_CAP = 100;

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
  /**
   * Created by an authoring session that has not committed yet: a draft.
   * Stamped in the transaction that adds the row, cleared by the first
   * commit; a worker that boots and finds one removes it (the session that
   * made it died with the worker that ran it).
   */
  sessionDraft?: { sessionId: string; at: number };
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

/** A restorable snapshot of a shim as it was before a change (or as installed). */
export interface VersionRecord {
  shimId: string;
  version: number;
  spec: Spec;
  handlers: Record<string, string>;
  at: number;
  reason: 'install' | 'rebase' | 'restore' | 'commit';
}

/** Why a rule is held for review, from the engine's quarantine event. */
export interface QuarantineState {
  reason: string;
  expected: unknown;
  seen: unknown[];
  occurredAt: number;
}

/**
 * One rule's learned state: the page kinds it has applied on (page memory,
 * the escalation gate's evidence) and its quarantine, if any.
 */
/**
 * The capture a rule's fingerprint came from, when the extension captured
 * it (a rule that arrived without one): the document and rev of the event
 * it kept, and the anchor it was captured for. Absent when the rule's
 * fingerprint came committed (the file's, a rebase's), which a capture
 * never replaces.
 */
export interface CaptureRecord {
  documentId: string | null;
  rev: number;
  anchorDigest: string;
}

export interface RuleStateRecord {
  shimId: string;
  ruleId: string;
  /** pathKey → last seen, ms. */
  paths: Record<string, number>;
  quarantine?: QuarantineState;
  capture?: CaptureRecord;
}

export interface BaselineRecord {
  shimId: string;
  host: string;
  pathKey: string;
  bundleHash: string;
  updatedAt: number;
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
  /** Removes the shim and, in the same transaction, its versions, user data, rule state and baselines. */
  deleteShim(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<boolean>;
  /**
   * Replaces the shim's spec with `next` (already bumped) and its handler
   * modules with `handlers`, and snapshots both under the new version with
   * the reason that produced it, in one transaction: a rebase, a restore,
   * a session's commit (`clearDraft` then settles a draft the session
   * created). The spec as it stood is
   * snapshotted again under its own version first (keeping that version's
   * reason and time), so what was amended since (captured fingerprints,
   * the advanced baseline) is what a restore of it brings back. Every
   * version the shim has been, the current one included, is then a
   * snapshot, each restorable. Refused (false) when the shim is gone or
   * its spec is no longer at `expectedVersion`: the caller read a version
   * another write has moved since.
   */
  reviseSpec(id: string, next: Spec, handlers: Record<string, string>, reason: VersionRecord['reason'], expectedVersion: number, opts?: { clearDraft?: boolean; envelope?: Record<string, unknown> }): Promise<boolean>;
  /** Replaces the spec without a snapshot (a baseline refresh, a captured fingerprint); refused when its version moved. */
  amendSpec(id: string, spec: Spec, expectedVersion: number): Promise<boolean>;
  versions: {
    /** Snapshots the shim as it is now under its version (an install's first record). */
    snapshot(shim: InstalledShim, reason: VersionRecord['reason']): Promise<void>;
    listForShim(shimId: string): Promise<VersionRecord[]>;
    get(shimId: string, version: number): Promise<VersionRecord | null>;
  };
  ruleState: {
    get(shimId: string, ruleId: string): Promise<RuleStateRecord | null>;
    put(record: RuleStateRecord): Promise<void>;
    listForShim(shimId: string): Promise<RuleStateRecord[]>;
  };
  baselines: {
    /** Records the deploy id `pathKey` on `host` was last seen at, and keeps at most BASELINE_CAP page kinds per (shim, host). */
    record(shimId: string, host: string, pathKey: string, bundleHash: string): Promise<void>;
    /** pathKey → bundleHash for one shim on one host; empty when nothing is recorded. */
    forHost(shimId: string, host: string): Promise<Record<string, string>>;
  };
  userData: {
    get(scope: UserDataScope, key: string): Promise<unknown>;
    set(scope: UserDataScope, key: string, value: unknown): Promise<unknown>;
    delete(scope: UserDataScope, key: string): Promise<boolean>;
    list(scope: UserDataScope): Promise<Record<string, unknown>>;
    /** Every row of one shim, across origins: what an export carries. */
    listForShim(shimId: string): Promise<UserDataRow[]>;
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
const BASELINES = 'baselines';
const PREFS = 'prefs';
const BY_SHIM = 'byShim';
const BY_SCOPE = 'byScope';
const BY_RANK = 'byRank';
const BY_HOST = 'byHost';

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
  if (from < 2) {
    const baselines = db.createObjectStore(BASELINES, { keyPath: ['shimId', 'host', 'pathKey'] });
    baselines.createIndex(BY_SHIM, 'shimId');
    baselines.createIndex(BY_HOST, ['shimId', 'host']);
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

/** A spec's version; one without one is version 1. */
export function versionOf(spec: { version?: unknown }): number {
  return typeof spec.version === 'number' && Number.isFinite(spec.version) ? spec.version : 1;
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
      const tx = write([SHIMS, VERSIONS, USER_DATA, RULE_STATE, BASELINES]);
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
      await deleteByIndex(tx.objectStore(BASELINES), BY_SHIM, id);
      await completion(tx);
      return true;
    },
    async reviseSpec(id, next, handlers, reason, expectedVersion, opts) {
      const tx = write([SHIMS, VERSIONS]);
      const shims = tx.objectStore(SHIMS);
      const versions = tx.objectStore(VERSIONS);
      const shim = await request(shims.get(id) as IDBRequest<InstalledShim | undefined>);
      if (!shim || versionOf(shim.spec) !== expectedVersion) {
        tx.abort();
        return false;
      }
      const now = Date.now();
      const current = versionOf(shim.spec);
      const held = await request(versions.get([id, current]) as IDBRequest<VersionRecord | undefined>);
      versions.put({ shimId: id, version: current, spec: shim.spec, handlers: shim.handlers, at: held?.at ?? now, reason: held?.reason ?? 'install' } satisfies VersionRecord);
      versions.put({ shimId: id, version: versionOf(next), spec: next, handlers: { ...handlers }, at: now, reason } satisfies VersionRecord);
      const revised: InstalledShim = { ...shim, spec: next, handlers: { ...handlers }, ...(opts?.envelope ? { envelope: opts.envelope } : {}) };
      if (opts?.clearDraft) delete revised.sessionDraft;
      shims.put(revised);
      await completion(tx);
      return true;
    },
    async amendSpec(id, spec, expectedVersion) {
      const tx = write(SHIMS);
      const shims = tx.objectStore(SHIMS);
      const shim = await request(shims.get(id) as IDBRequest<InstalledShim | undefined>);
      if (!shim || versionOf(shim.spec) !== expectedVersion) {
        tx.abort();
        return false;
      }
      shims.put({ ...shim, spec });
      await completion(tx);
      return true;
    },
    versions: {
      async snapshot(shim, reason) {
        const version = versionOf(shim.spec);
        const tx = write(VERSIONS);
        tx.objectStore(VERSIONS).put({ shimId: shim.id, version, spec: shim.spec, handlers: shim.handlers, at: Date.now(), reason } satisfies VersionRecord);
        await completion(tx);
      },
      async listForShim(shimId) {
        const rows = await request(read(VERSIONS).objectStore(VERSIONS).index(BY_SHIM).getAll(shimId) as IDBRequest<VersionRecord[]>);
        return rows.sort((a, b) => a.version - b.version);
      },
      async get(shimId, version) {
        const row = await request(read(VERSIONS).objectStore(VERSIONS).get([shimId, version]) as IDBRequest<VersionRecord | undefined>);
        return row ?? null;
      },
    },
    ruleState: {
      async get(shimId, ruleId) {
        const row = await request(read(RULE_STATE).objectStore(RULE_STATE).get([shimId, ruleId]) as IDBRequest<RuleStateRecord | undefined>);
        return row ?? null;
      },
      async put(record) {
        const tx = write(RULE_STATE);
        tx.objectStore(RULE_STATE).put(record);
        await completion(tx);
      },
      async listForShim(shimId) {
        return request(read(RULE_STATE).objectStore(RULE_STATE).index(BY_SHIM).getAll(shimId) as IDBRequest<RuleStateRecord[]>);
      },
    },
    baselines: {
      async record(shimId, host, pathKey, bundleHash) {
        const tx = write(BASELINES);
        const store = tx.objectStore(BASELINES);
        const rows = await request(store.index(BY_HOST).getAll([shimId, host]) as IDBRequest<BaselineRecord[]>);
        // Recency is strictly ordered: two records in one millisecond would
        // tie, and the eviction below would then pick by name.
        const latest = rows.reduce((max, row) => Math.max(max, row.updatedAt), 0);
        const updatedAt = Math.max(Date.now(), latest + 1);
        store.put({ shimId, host, pathKey, bundleHash, updatedAt } satisfies BaselineRecord);
        const kept = rows.filter((row) => row.pathKey !== pathKey);
        if (kept.length + 1 > BASELINE_CAP) {
          kept.sort((a, b) => b.updatedAt - a.updatedAt);
          for (const row of kept.slice(BASELINE_CAP - 1)) store.delete([row.shimId, row.host, row.pathKey]);
        }
        await completion(tx);
      },
      async forHost(shimId, host) {
        const rows = await request(read(BASELINES).objectStore(BASELINES).index(BY_HOST).getAll([shimId, host]) as IDBRequest<BaselineRecord[]>);
        const out: Record<string, string> = {};
        for (const row of rows) put(out, row.pathKey, row.bundleHash);
        return out;
      },
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
      async listForShim(shimId) {
        const rows = await request(read(USER_DATA).objectStore(USER_DATA).index(BY_SHIM).getAll(shimId) as IDBRequest<UserDataRecord[]>);
        return rows.map((row) => ({ origin: row.origin, key: row.key, value: row.value }));
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
