// A shim's settings on this host: the declaration is the shim's spec
// (`spec.settings`, read through core's settings-schema, the same reader the
// Shim browser uses), the values are what the user set on the settings page
// (the store's `settings`). Pure: the worker answers the page and the
// handlers through these, and a harness pins them.
//
// A handler reads declared keys only, each resolving to its stored value,
// else its declared default, else undefined, as in every Shim host. A value
// is checked against its field's type before it is stored. A secret field's
// value never reaches here: it is sealed in the vault (vault-keeper.ts) and
// placed on a request by the worker (credential-fetch.ts). A handler reads a
// secret's presence only: `true` when a value is stored for its declared
// placement, else undefined, as on every Shim host. This module refuses to
// store a secret as a plain setting.

import { normalizeSchema, settingsSchemaProblems, type SettingFieldSchema, type SettingsDeclarer } from '@shimbrowser/core/settings-schema';
import { sha256Hex } from '@shimbrowser/core/sha256';

/** One field as the settings page shows it: the declaration, whether a value is stored, and the value in force. */
export interface SettingsPageField extends SettingFieldSchema {
  isSet: boolean;
  /** The stored value, else the declared default, else null. */
  value: unknown;
}

/**
 * The secret fields with a value stored for their declared placement, each
 * with an opaque revision (when it was last set): presence, never a value.
 */
export type SecretPresence = ReadonlyMap<string, number>;
const NO_SECRETS: SecretPresence = new Map();

export type SettingValueCheck = { ok: true; value: unknown } | { ok: false; error: string };

/** The declaration's fields, or none when it is not valid (a malformed declaration offers no field to fill). */
export function settingsFields(declarer: SettingsDeclarer | null | undefined): SettingFieldSchema[] {
  if (settingsSchemaProblems(declarer).length) return [];
  return normalizeSchema(declarer);
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** What `api.settings.getAll()` answers: every declared key, resolved. Stored rows a since-removed field left are ignored. */
export function valuesForHandler(declarer: SettingsDeclarer | null | undefined, stored: Record<string, unknown>, secrets: SecretPresence = NO_SECRETS): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of settingsFields(declarer)) {
    if (f.type === 'secret') { setOwn(out, f.key, secrets.has(f.key) ? true : undefined); continue; }
    setOwn(out, f.key, own(stored, f.key) ? stored[f.key] : f.default);
  }
  return out;
}

/**
 * `getAll` as it crosses a JSON message (chrome.runtime, the session world's
 * binding): JSON drops a key whose value is undefined, so the declared keys
 * travel beside the values and the page rebuilds the record with every
 * declared key, as the Shim browser's structured-clone IPC delivers it.
 */
export interface SettingsTransport {
  keys: string[];
  values: Record<string, unknown>;
}

export function settingsTransport(declarer: SettingsDeclarer | null | undefined, stored: Record<string, unknown>, secrets: SecretPresence = NO_SECRETS): SettingsTransport {
  const values = valuesForHandler(declarer, stored, secrets);
  return { keys: Object.keys(values), values };
}

/** The record a handler's getAll answers, from a transport: every declared key, undefined where unset. */
export function fromSettingsTransport(transport: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof transport !== 'object' || transport === null) return out;
  const { keys, values } = transport as { keys?: unknown; values?: unknown };
  if (!Array.isArray(keys)) return out;
  const record = typeof values === 'object' && values !== null ? values as Record<string, unknown> : {};
  for (const key of keys as unknown[]) {
    if (typeof key === 'string') setOwn(out, key, own(record, key) ? record[key] : undefined);
  }
  return out;
}

/** What `api.settings.get(key)` answers: the declared key resolved, undefined for an undeclared one. */
export function valueForHandler(declarer: SettingsDeclarer | null | undefined, stored: Record<string, unknown>, key: unknown, secrets: SecretPresence = NO_SECRETS): unknown {
  if (typeof key !== 'string') return undefined;
  const all = valuesForHandler(declarer, stored, secrets);
  return own(all, key) ? all[key] : undefined;
}

/** The settings page's fields, in declaration order. */
export function settingsPageFields(declarer: SettingsDeclarer | null | undefined, stored: Record<string, unknown>, secrets: SecretPresence = NO_SECRETS): SettingsPageField[] {
  return settingsFields(declarer).map((f) => {
    const isSet = f.type === 'secret' ? secrets.has(f.key) : own(stored, f.key);
    const value = isSet ? stored[f.key] : (f.default ?? null);
    return { ...f, isSet, value: f.type === 'secret' ? null : value };
  });
}

/**
 * The values a handler would read, as one digest: what a page's runtime
 * compares to know a setting changed (reconcile.ts). Undefined when the shim
 * declares no settings. A digest, so the bundle carries no value.
 */
export function settingsKey(declarer: SettingsDeclarer | null | undefined, stored: Record<string, unknown>, secrets: SecretPresence = NO_SECRETS): string | undefined {
  const fields = settingsFields(declarer);
  if (!fields.length) return undefined;
  const values = valuesForHandler(declarer, stored, secrets);
  // A secret contributes its revision, never its value.
  return sha256Hex(JSON.stringify(fields.map((f) => [f.key, f.type === 'secret' ? (secrets.get(f.key) ?? null) : values[f.key] === undefined ? null : values[f.key]]))).slice(0, 16);
}

/** A required field with no default and no stored value: the shim needs setup before it can do what it says. */
export function needsSetup(declarer: SettingsDeclarer | null | undefined, stored: Record<string, unknown>, secrets: SecretPresence = NO_SECRETS): boolean {
  return settingsFields(declarer).some((f) => f.required && f.default === undefined && !(f.type === 'secret' ? secrets.has(f.key) : own(stored, f.key)));
}

/**
 * Checks a value the settings page sends for `key` against the declaration:
 * the key must be declared, and the value fit its field's type (text: a
 * string; number: a finite number; boolean: a boolean; select: one of the
 * options). Answers the value to store.
 */
export function checkSettingValue(declarer: SettingsDeclarer | null | undefined, key: unknown, value: unknown): SettingValueCheck {
  if (typeof key !== 'string') return { ok: false, error: 'a setting key is a string' };
  const field = settingsFields(declarer).find((f) => f.key === key);
  if (!field) return { ok: false, error: `"${key}" is not a declared setting of this shim` };
  switch (field.type) {
    case 'secret':
      return { ok: false, error: `"${key}" is a secret setting: it is entered into the vault, never stored as a plain setting` };
    case 'text':
      return typeof value === 'string' ? { ok: true, value } : { ok: false, error: `"${key}" takes text` };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? { ok: true, value } : { ok: false, error: `"${key}" takes a number` };
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: `"${key}" takes true or false` };
    case 'select': {
      const options = field.options ?? [];
      return typeof value === 'string' && options.includes(value)
        ? { ok: true, value }
        : { ok: false, error: `"${key}" takes one of ${options.map((o) => JSON.stringify(o)).join(', ')}` };
    }
  }
}
