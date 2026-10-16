// The headless host's file-backed `api.storage`:
// what handlers store while a headless session runs survives the session, in
// one JSON file the session names — never in the Shim browser's profile
// (invariant 10: headless never reads persist:user).
//
// Same semantics as the browser's api.storage (and memoryStorage): one bucket
// per shim per origin, JSON values, a missing key reads null, `set` answers
// the value, `delete` whether a key went away, `list` the bucket as a record.
//
// Writes are serialized and atomic (temp file + rename), so a crash mid-write
// leaves the previous file. A write stages its change on a copy and swaps it
// in only once persisted: a failed write leaves reads, and the next write,
// as they were. A file that isn't ours (unparseable, wrong
// format) is never overwritten: every call on it rejects, and the host
// answers the handler `undefined`.

import * as fs from 'fs';
import * as path from 'path';
import type { HeadlessStorage, StorageScope } from './playwright-page-host';

export const HEADLESS_STORAGE_FORMAT = 'shim-headless-storage/1';

/** The file: origin → shim id → key → JSON value. */
interface StorageFile {
  format: typeof HEADLESS_STORAGE_FORMAT;
  buckets: Record<string, Record<string, Record<string, unknown>>>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// A value as it round-trips through JSON: undefined (and functions) become
// null, like the browser's SQLite-backed store.
function jsonValue(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? null : JSON.parse(text);
}

// Own-property writes only: a key like "__proto__" is data, never a prototype.
function put<T>(target: Record<string, T>, key: string, value: T): T {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  return value;
}

// A copy a write can change without touching the current state: every layer
// down to the rows is new; the values are shared (stored as JSON, never
// mutated in place).
function copyFile(file: StorageFile): StorageFile {
  const buckets: StorageFile['buckets'] = {};
  for (const [origin, shims] of Object.entries(file.buckets)) {
    const byShim: Record<string, Record<string, unknown>> = {};
    for (const [patchId, rows] of Object.entries(shims)) {
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rows)) put(copy, k, v);
      put(byShim, patchId, copy);
    }
    put(buckets, origin, byShim);
  }
  return { format: HEADLESS_STORAGE_FORMAT, buckets };
}

function parseFile(text: string, file: string): StorageFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — left untouched`, { cause: e });
  }
  if (!isRecord(parsed) || parsed.format !== HEADLESS_STORAGE_FORMAT || !isRecord(parsed.buckets)) {
    throw new Error(`${file} is not a ${HEADLESS_STORAGE_FORMAT} file — left untouched`);
  }
  const buckets: StorageFile['buckets'] = {};
  for (const [origin, shims] of Object.entries(parsed.buckets)) {
    if (!isRecord(shims)) continue;
    const byShim: Record<string, Record<string, unknown>> = {};
    for (const [patchId, rows] of Object.entries(shims)) {
      if (isRecord(rows)) put(byShim, patchId, { ...rows });
    }
    put(buckets, origin, byShim);
  }
  return { format: HEADLESS_STORAGE_FORMAT, buckets };
}

export interface FileStorageOptions {
  /** Writes `text` to `tmp` (default: fs, mode 0600); tests inject a failure. */
  writeFile?(tmp: string, text: string): void;
}

/** A HeadlessStorage persisted to `file` (created on the first write). */
export function fileStorage(file: string, options: FileStorageOptions = {}): HeadlessStorage & { readonly file: string } {
  const writeFile = options.writeFile ?? ((tmp: string, text: string) => fs.writeFileSync(tmp, text, { mode: 0o600 }));
  const target = path.resolve(file);
  let data: StorageFile | null = null;
  // One operation at a time: a read never sees a half-applied write, and
  // writes land in call order.
  let chain: Promise<unknown> = Promise.resolve();

  const load = (): StorageFile => {
    if (data) return data;
    let text: string | null = null;
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    data = text === null ? { format: HEADLESS_STORAGE_FORMAT, buckets: {} } : parseFile(text, target);
    return data;
  };

  const save = (file: StorageFile): void => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`);
      fs.renameSync(tmp, target);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw e;
    }
  };

  // Applies `change` to a copy, persists it, then makes it current.
  const commit = <T>(change: (draft: StorageFile) => { result: T; changed: boolean }): T => {
    const draft = copyFile(load());
    const { result, changed } = change(draft);
    if (changed) {
      save(draft);
      data = draft;
    }
    return result;
  };

  const bucket = (file: StorageFile, scope: StorageScope, create: boolean): Record<string, unknown> | null => {
    const own = <T>(rec: Record<string, T>, key: string): T | undefined =>
      (Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined);
    const byShim = own(file.buckets, scope.origin) ?? (create ? put(file.buckets, scope.origin, {}) : null);
    if (!byShim) return null;
    return own(byShim, scope.patchId) ?? (create ? put(byShim, scope.patchId, {}) : null);
  };

  const run = <T>(work: () => T): Promise<T> => {
    const next = chain.then(work);
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    file: target,
    get: (scope, key) => run(() => {
      const rows = bucket(load(), scope, false);
      return rows && Object.prototype.hasOwnProperty.call(rows, key) ? jsonValue(rows[key]) : null;
    }),
    set: (scope, key, value) => run(() => {
      const stored = jsonValue(value);
      return commit((draft) => {
        const rows = bucket(draft, scope, true);
        if (!rows) return { result: value, changed: false };
        put(rows, key, stored);
        return { result: value, changed: true };
      });
    }),
    delete: (scope, key) => run(() => commit((draft) => {
      const rows = bucket(draft, scope, false);
      if (!rows || !Object.prototype.hasOwnProperty.call(rows, key)) return { result: false, changed: false };
      delete rows[key];
      return { result: true, changed: true };
    })),
    list: (scope) => run(() => {
      const rows = bucket(load(), scope, false);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rows ?? {})) put(out, k, jsonValue(v));
      return out;
    }),
  };
}
