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
//
// A secret field may also declare `use` (D17): exactly where the host sends
// the value, so the handler never sees it. One exact HTTPS origin, one header
// or one query parameter, and a format with a single `{}` slot:
//
//   { "key": "openaiKey", "type": "secret",
//     "use": { "origin": "https://api.openai.com", "header": "Authorization", "format": "Bearer {}" } }
//   { "key": "mapsKey", "type": "secret",
//     "use": { "origin": "https://maps.example.com", "query": "key", "format": "{}" } }

import type { Spec } from './types';
import { isPrivateHost } from './fetch-policy';

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
  use?: unknown;
}

/**
 * Where a host places a secret field's value (D17): exactly one of `header`
 * and `query`, on requests to exactly `origin`, as `format` with the value at
 * its one `{}`.
 */
export type CredentialUse =
  | { origin: string; header: string; query?: undefined; format: string }
  | { origin: string; query: string; header?: undefined; format: string };

/** A format string's most characters. */
export const CREDENTIAL_FORMAT_MAX_CHARS = 256;

// Request headers a credential may not be placed in: the Fetch standard's
// forbidden request headers, hop-by-hop headers, and the ones that describe
// the body or the transfer rather than authorize it.
const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
  'access-control-request-private-network', 'connection', 'content-length', 'content-type',
  'content-encoding', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
  'referer', 'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via', 'range',
  'proxy-connection', 'http2-settings',
]);

/** Whether a header name may carry a credential (case-insensitive). */
export function credentialHeaderAllowed(name: string): boolean {
  const n = name.toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(n)) return false;
  if (FORBIDDEN_CREDENTIAL_HEADERS.has(n)) return false;
  return !n.startsWith('proxy-') && !n.startsWith('sec-');
}

/** A query parameter name a credential may be placed under. */
export function credentialQueryNameAllowed(name: string): boolean {
  return /^[A-Za-z0-9._~-]{1,64}$/.test(name);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether a string holds an unpaired UTF-16 surrogate (not well-formed Unicode). */
export function hasLoneSurrogate(s: string): boolean {
  return LONE_SURROGATE.test(s);
}

function isRecordValue(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Every problem with a `use` declaration, one line each; empty when valid.
 * Strict: unknown properties refuse, and the origin must be written in its
 * canonical form (what `new URL(origin).origin` gives back), so what the user
 * approves is exactly what the host compares.
 */
export function credentialUseProblems(use: unknown): string[] {
  if (!isRecordValue(use)) return ['`use` must be an object { origin, header | query, format }'];
  const problems: string[] = [];
  for (const k of Object.keys(use)) {
    if (k !== 'origin' && k !== 'header' && k !== 'query' && k !== 'format') problems.push(`\`use\` has an unknown property "${k}"`);
  }
  const { origin, header, query, format } = use;
  if (typeof origin !== 'string') {
    problems.push('`use.origin` must be an https origin such as "https://api.example.com"');
  } else {
    let u: URL | null;
    try { u = new URL(origin); } catch { u = null; }
    if (!u || u.protocol !== 'https:') problems.push(`\`use.origin\` "${origin}" must be an https origin`);
    else if (u.origin !== origin) problems.push(`\`use.origin\` "${origin}" must be written exactly as its origin, "${u.origin}" (no path, query, credentials or trailing slash)`);
    else if (origin.includes('*')) problems.push('`use.origin` may not contain a wildcard');
    else if (isPrivateHost(u.hostname)) problems.push(`\`use.origin\` "${origin}" is a loopback/private/link-local address`);
  }
  if ((header === undefined) === (query === undefined)) {
    problems.push('`use` takes exactly one of `header` and `query`');
  } else if (header !== undefined) {
    if (typeof header !== 'string' || !credentialHeaderAllowed(header)) {
      problems.push(`\`use.header\` "${String(header)}" is not a header a credential may be sent in (letters, digits and "-"; not a forbidden, hop-by-hop, body or proxy header)`);
    }
  } else if (typeof query !== 'string' || !credentialQueryNameAllowed(query)) {
    problems.push(`\`use.query\` "${String(query)}" must be 1-64 characters of letters, digits, ".", "_", "~" or "-"`);
  }
  if (typeof format !== 'string') {
    problems.push('`use.format` must be a string with one `{}` where the value goes, such as "Bearer {}" or "{}"');
  } else {
    if (format.split('{}').length !== 2) problems.push('`use.format` must contain exactly one `{}`');
    if (format.length > CREDENTIAL_FORMAT_MAX_CHARS) problems.push(`\`use.format\` is longer than ${CREDENTIAL_FORMAT_MAX_CHARS} characters`);
    if (hasLoneSurrogate(format)) problems.push('`use.format` is not well-formed Unicode');
    if (header !== undefined && /[\r\n\0]/.test(format)) problems.push('`use.format` may not contain CR, LF or NUL');
    if (header !== undefined && /[^\u0020-\u007e\u0080-\u00ff\t]/.test(format)) problems.push('`use.format` for a header may hold only header-safe characters');
  }
  return problems;
}

export interface SettingFieldSchema {
  key: string;
  label: string;
  type: SettingFieldType;
  required: boolean;
  help: string;
  options?: string[];
  default?: unknown;
  /** A secret field's declared placement (D17); absent for every other field. */
  use?: CredentialUse;
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
    if (f.use !== undefined) {
      if (f.type !== 'secret') problems.push(`${where}: only a "secret" field may declare \`use\``);
      for (const p of credentialUseProblems(f.use)) problems.push(`${where}: ${p}`);
      if (f.default !== undefined) problems.push(`${where}: a secret field with \`use\` may not have a \`default\``);
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
      + '{ key, label, type: "text"|"secret"|"number"|"boolean"|"select", required?, help?, options?, default?, use? } '
      + '(`use`, on a secret field only: { origin: "https://…", header | query, format: "…{}…" }).') as Error & { code?: string };
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
      ...(f.type === 'secret' && f.use !== undefined && credentialUseProblems(f.use).length === 0
        ? { use: f.use as CredentialUse } : {}),
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

/**
 * The declaration's secret fields, split by whether they declare `use`. Reads
 * the raw declaration defensively, like secretSettingKeys; a `use` that does
 * not validate counts as none.
 */
export function secretSettingPlacements(declarer: SettingsDeclarer | null | undefined): { placed: string[]; plain: string[] } {
  const raw = declarer?.settings;
  const placed: string[] = [];
  const plain: string[] = [];
  if (!Array.isArray(raw)) return { placed, plain };
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const f = item as RawSettingField;
    if (f.type !== 'secret') continue;
    const key = typeof f.key === 'string' ? f.key : '?';
    if (f.use !== undefined && credentialUseProblems(f.use).length === 0) placed.push(key);
    else plain.push(key);
  }
  return { placed, plain };
}

export { FIELD_TYPES };
