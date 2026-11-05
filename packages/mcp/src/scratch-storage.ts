// A headless session's `api.storage`: a scratch overlay over the shim's
// saved data. In headless every rule on the page runs as a preview (there
// is no installed shim), so everything a handler stores during a session is
// preview data: test runs, the agent's clicks, pages it only looked at.
//
// Reads see the saved data (the `<shimFile>.storage.json` file) with the
// session's own writes and deletes over it; writes and deletes land only
// here, in memory, and go when the session does. Nothing is ever written to
// the base store, so neither a preview nor a commit changes what the shim
// has saved, and the next session starts from the saved data again.
//
// Same semantics as the other stores: one bucket per shim per origin, JSON
// values, a missing key reads null, `set` answers the value, `delete`
// whether a key went away, `list` the bucket as a record. Calls run in the
// order made, so a read never overtakes a write before it.

import type { HeadlessStorage, StorageScope } from './playwright-page-host';

// A key the session deleted: it reads as missing whatever the base holds.
const DELETED = Symbol('deleted');
type Entry = string | typeof DELETED;

// Own-property writes only: a key like "__proto__" is data, never a prototype.
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A HeadlessStorage that reads `base` and never writes to it. */
export function scratchStorage(base: HeadlessStorage): HeadlessStorage {
  const buckets = new Map<string, Map<string, Entry>>();
  const bucket = (scope: StorageScope): Map<string, Entry> => {
    const id = JSON.stringify([scope.origin, scope.patchId]);
    let b = buckets.get(id);
    if (!b) {
      b = new Map();
      buckets.set(id, b);
    }
    return b;
  };
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(work: () => Promise<T> | T): Promise<T> => {
    const next = chain.then(work);
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    get: (scope, key) => run(async () => {
      const entry = bucket(scope).get(key);
      if (entry === DELETED) return null;
      if (entry !== undefined) return JSON.parse(entry);
      return base.get(scope, key);
    }),
    set: (scope, key, value) => run(() => {
      // As it round-trips through JSON: undefined (and functions) become null.
      bucket(scope).set(key, JSON.stringify(value) ?? 'null');
      return value;
    }),
    delete: (scope, key) => run(async () => {
      const b = bucket(scope);
      const entry = b.get(key);
      let existed: boolean;
      if (entry === DELETED) existed = false;
      else if (entry !== undefined) existed = true;
      else existed = Object.prototype.hasOwnProperty.call(await base.list(scope), key);
      b.set(key, DELETED);
      return existed;
    }),
    list: (scope) => run(async () => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(await base.list(scope))) put(out, k, v);
      for (const [k, entry] of bucket(scope)) {
        if (entry === DELETED) delete out[k];
        else put(out, k, JSON.parse(entry));
      }
      return out;
    }),
  };
}
