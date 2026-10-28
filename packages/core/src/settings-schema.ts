// A shim's settings declaration (`spec.settings`): the fields a shim asks
// the user for, validated and normalized with no storage behind it. Every
// host reads a declaration through these, so the Shim browser's settings
// panel, Shim for Chrome's settings page and the capability preflight agree
// on what a declaration says.
//
// The declaration travels with a shim; the values a user types never do.
// Each field is `{ key, label?, type?, required?, help?, options?, default? }`;
// a field with no type is text. A `secret` field holds a credential, which a
// host stores only if it can encrypt it at rest (`secretSettings`, D15).

import type { Spec } from './types';

export type SettingFieldType = 'text' | 'secret' | 'number' | 'boolean' | 'select';

// Kept as `Set<string>` (not `Set<SettingFieldType>`) on purpose: every call
// site checks membership against a genuinely dynamic value (authored JSON,
// not yet validated), so the argument is cast to `string` at each call rather
// than trusted as `SettingFieldType` up front.
const FIELD_TYPES = new Set<string>(['text', 'secret', 'number', 'boolean', 'select']);

/**
 * A raw, not-yet-normalized field as it appears in `spec.settings`. Every
 * property is `unknown` on purpose: this is a dynamic boundary, not a
 * trusted shape.
 */
export interface RawSettingField {
  key?: unknown;
  label?: unknown;
  type?: unknown;
  required?: unknown;
  help?: unknown;
  options?: unknown;
  default?: unknown;
}

/** A field as a settings surface works with it, after normalizeSchema. */
export interface SettingFieldSchema {
  key: string;
  label: string;
  type: SettingFieldType;
  required: boolean;
  help: string;
  options?: string[];
  default?: unknown;
}

/** Anything carrying a settings declaration: a shim spec, or a composition manifest. */
export type SettingsDeclarer = Spec | { settings?: unknown };

/**
 * Every problem with a settings declaration, one line each; empty when it is
 * valid. No declaration is valid (most shims declare none).
 */
export function settingsSchemaProblems(declarer: SettingsDeclarer | null | undefined, label = 'spec'): string[] {
  const raw = declarer?.settings;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return [`${label}.settings must be an array of field declarations (or omitted)`];
  const seen = new Set<string>();
  const problems: string[] = [];
  raw.forEach((item: unknown, i) => {
    const where = `settings[${i}]`;
    if (!item || typeof item !== 'object') { problems.push(`${where}: not an object`); return; }
    const f = item as RawSettingField;
    if (typeof f.key !== 'string' || !/^[A-Za-z0-9_]+$/.test(f.key)) {
      problems.push(`${where}: \`key\` must be an identifier (letters, digits, underscore)`);
    } else if (seen.has(f.key)) {
      problems.push(`${where}: duplicate key "${f.key}"`);
    } else {
      seen.add(f.key);
    }
    if (f.type !== undefined && !FIELD_TYPES.has(f.type as string)) {
      problems.push(`${where}: \`type\` "${String(f.type)}" is not one of ${[...FIELD_TYPES].join(', ')}`);
    }
    if (f.type === 'select' && !(Array.isArray(f.options) && f.options.length)) {
      problems.push(`${where}: a "select" field needs a non-empty \`options\` array`);
    }
  });
  return problems;
}

/**
 * Validates a settings declaration before it is committed or installed.
 * Throws a clear, agent-readable error (code `bad_settings_schema`) so a bad
 * declaration comes back in the same authoring turn. `label` names the
 * document in messages ('spec' / 'manifest').
 */
export function validateSchema(declarer: SettingsDeclarer | null | undefined, label = 'spec'): void {
  const problems = settingsSchemaProblems(declarer, label);
  if (!problems.length) return;
  // Not an array is one problem with no field to describe; anything else
  // lists the fields' problems and the shape a field takes.
  const err = new Error(!Array.isArray(declarer?.settings)
    ? problems.join('; ')
    : `invalid settings schema: ${problems.join('; ')}. Each field is `
      + '{ key, label, type: "text"|"secret"|"number"|"boolean"|"select", required?, help?, options?, default? }.') as Error & { code?: string };
  err.code = 'bad_settings_schema';
  throw err;
}

function isFieldType(type: unknown): type is SettingFieldType {
  return typeof type === 'string' && FIELD_TYPES.has(type);
}

/**
 * A field's type and options as the settings runtime reads them: a field
 * that declares no type is text, and a select's options compare as strings.
 * Anything that checks a value against a declaration reads it through these,
 * so it agrees with the runtime.
 */
export function effectiveFieldType(type: unknown): SettingFieldType {
  return isFieldType(type) ? type : 'text';
}

export function effectiveOptions(options: unknown): string[] | undefined {
  return Array.isArray(options) ? options.map(String) : undefined;
}

/**
 * The declaration as a settings surface works with it. Assumes a valid
 * declaration (validateSchema first): a malformed entry throws here, as it
 * does in every host.
 */
export function normalizeSchema(declarer: SettingsDeclarer | null | undefined): SettingFieldSchema[] {
  const raw: unknown[] = Array.isArray(declarer?.settings) ? declarer.settings : [];
  return raw.map((item) => {
    const f = item as RawSettingField;
    return {
      key: f.key as string,
      label: typeof f.label === 'string' && f.label.trim() ? f.label : (f.key as string),
      type: effectiveFieldType(f.type),
      required: !!f.required,
      help: typeof f.help === 'string' ? f.help : '',
      options: effectiveOptions(f.options),
      default: f.default,
    };
  });
}

/**
 * The keys of the declaration's `secret` fields, in declaration order. Reads
 * the raw declaration defensively (it may not be validated yet), so the
 * capability preflight can refuse a secret on a host that cannot keep one.
 */
export function secretSettingKeys(declarer: SettingsDeclarer | null | undefined): string[] {
  const raw = declarer?.settings;
  if (!Array.isArray(raw)) return [];
  const keys: string[] = [];
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const f = item as RawSettingField;
    if (f.type === 'secret') keys.push(typeof f.key === 'string' ? f.key : '?');
  }
  return keys;
}

export { FIELD_TYPES };
