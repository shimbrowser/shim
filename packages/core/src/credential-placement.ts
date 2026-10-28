// Placing a secret settings value on a handler's request (D17): the rules
// every host's fetch broker shares, so a credential travels the same way in
// the Shim browser and in Shim for Chrome. Pure, no network, no storage.
//
// A secret field that declares `use` is never handed to the handler. The
// handler names it (`api.fetch(url, { secrets: ['openaiKey'] })`) and the
// broker places the value exactly where the declaration says: one header, or
// one query parameter, on a request to exactly the declared HTTPS origin, as
// the declared format. There is no string substitution anywhere else.
//
// The broker's order:
//
//   1. planCredentialRequest: parse the url once, check every named secret is
//      the caller's own placed field, the origin is exactly its declared one,
//      and nothing collides — all before any value is decrypted.
//   2. the host checks its grants and decrypts the named values.
//   3. placeCredentials: builds each formatted value once and places it on
//      the same parsed URL (or the header map), returning the dispatch URL,
//      the headers and the redaction candidates.
//   4. the host fetches the dispatch URL with CREDENTIAL_REQUEST_POLICY,
//      answers with the plan's publicUrl (never the response's url), redacts
//      the body and header values with redactCredentialText, and maps every
//      failure to a fixed CREDENTIAL_ERRORS string.
//
// What this guarantees is the request the broker sends. A service that
// echoes, logs or decodes the value its own way is trusted with it; the
// redaction of exact echoes is best effort.

import type { CredentialUse } from './settings-schema';
import { credentialHeaderAllowed, credentialQueryNameAllowed, hasLoneSurrogate } from './settings-schema';

/** A stored secret's most UTF-8 bytes. */
export const CREDENTIAL_MAX_VALUE_BYTES = 8 * 1024;
/** The most secrets one request may name. */
export const CREDENTIAL_MAX_PER_REQUEST = 4;
/** Redaction candidates shorter than this are not redacted (they would match ordinary text). */
export const CREDENTIAL_MIN_REDACT_CHARS = 8;
/** What a redacted echo reads as. */
export const CREDENTIAL_REDACTED = '[redacted]';

/** The request policy of every secret-bearing request; a handler overrides none of it. */
export const CREDENTIAL_REQUEST_POLICY = {
  redirect: 'error',
  cache: 'no-store',
  credentials: 'omit',
  referrer: '',
  referrerPolicy: 'no-referrer',
} as const;

/**
 * The fixed answers of a secret-bearing request. A native error message, a
 * status text or a response url can carry the request url (and with it a
 * query-placed value), so none of them is ever passed through.
 */
export const CREDENTIAL_ERRORS = {
  /** The request could not be made or did not complete (network, TLS, a redirect, a refusal). */
  failed: 'secret-request-failed',
  /** A response arrived, but its body could not be read. */
  unreadable: 'secret-response-unreadable',
  /** The request took longer than the broker allows. */
  timedOut: 'secret-request-timed-out',
} as const;

/** A request's secrets, after the url and every name checked out. */
export interface CredentialPlan {
  /**
   * The one parsed URL the request goes to: its fragment dropped, no
   * credentials placed yet. placeCredentials places query values on this same
   * object, so a plan is placed at most once.
   */
  url: URL;
  /** The url the handler is answered with: the request url before any value was placed. */
  publicUrl: string;
  /** The named secrets, in request order, with their declared placements. */
  placements: Array<{ key: string; use: CredentialUse }>;
}

export type CredentialPlanResult = { ok: true; plan: CredentialPlan } | { ok: false; error: string };

// Compare a query parameter's name the way the strictest server would: after
// form decoding, case-insensitively.
function queryNameKey(name: string): string {
  return name.toLowerCase();
}

/**
 * Check a secret-bearing request before anything is decrypted. `placedUse`
 * answers a key's declared `use` when the caller's own spec declares it as a
 * placed secret, and undefined otherwise (a plain secret, a non-secret field,
 * another shim's field, or nothing). `headers` are the handler's own.
 */
export function planCredentialRequest(input: {
  url: unknown;
  headers: Record<string, string>;
  secrets: unknown;
  placedUse: (key: string) => CredentialUse | undefined;
}): CredentialPlanResult {
  const { secrets } = input;
  if (!Array.isArray(secrets) || secrets.length === 0 || secrets.some((k) => typeof k !== 'string')) {
    return { ok: false, error: '`secrets` must be a non-empty array of secret setting keys' };
  }
  const keys = secrets as string[];
  if (keys.length > CREDENTIAL_MAX_PER_REQUEST) {
    return { ok: false, error: `a request may name at most ${CREDENTIAL_MAX_PER_REQUEST} secrets` };
  }
  if (new Set(keys).size !== keys.length) return { ok: false, error: '`secrets` names a key more than once' };

  if (typeof input.url !== 'string') return { ok: false, error: 'the url must be a string' };
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { ok: false, error: 'invalid url' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'a request carrying a secret must use https' };
  if (url.username !== '' || url.password !== '') return { ok: false, error: 'a request carrying a secret may not carry credentials in its url' };
  url.hash = '';
  const publicUrl = url.href;

  const handlerHeaders = new Set(Object.keys(input.headers).map((h) => h.toLowerCase()));
  const urlQueryNames = new Set<string>();
  for (const name of url.searchParams.keys()) urlQueryNames.add(queryNameKey(name));

  const placements: Array<{ key: string; use: CredentialUse }> = [];
  const placedHeaders = new Set<string>();
  const placedQuery = new Set<string>();
  for (const key of keys) {
    const use = input.placedUse(key);
    if (!use) return { ok: false, error: `"${key}" is not one of this shim's secret settings with a declared \`use\`` };
    if (url.origin !== use.origin) {
      return { ok: false, error: `"${key}" may be sent only to ${use.origin}, not ${url.origin}` };
    }
    if (use.header !== undefined) {
      const h = use.header.toLowerCase();
      if (!credentialHeaderAllowed(h)) return { ok: false, error: `"${key}" declares a header a secret may not be sent in` };
      if (handlerHeaders.has(h)) return { ok: false, error: `the request sets the "${use.header}" header itself; "${key}" is placed there by Shim` };
      if (placedHeaders.has(h)) return { ok: false, error: `two secrets in this request go in the "${use.header}" header` };
      placedHeaders.add(h);
    } else {
      if (!credentialQueryNameAllowed(use.query)) return { ok: false, error: `"${key}" declares a query parameter a secret may not be sent in` };
      const q = queryNameKey(use.query);
      if (urlQueryNames.has(q)) return { ok: false, error: `the url already carries a "${use.query}" parameter (in some spelling); "${key}" is placed there by Shim` };
      if (placedQuery.has(q)) return { ok: false, error: `two secrets in this request go in the "${use.query}" parameter` };
      placedQuery.add(q);
    }
    placements.push({ key, use });
  }
  return { ok: true, plan: { url, publicUrl, placements } };
}

/** A request with its secrets placed. */
export interface PlacedCredentialRequest {
  /** The url to dispatch; carries any query-placed values. Never stored, logged or returned. */
  dispatchUrl: string;
  /** The handler's headers with any header-placed values added. */
  headers: Record<string, string>;
  /** Strings to redact from the response (raw values and their placed encodings). */
  redact: string[];
}

export type PlaceCredentialsResult = { ok: true; request: PlacedCredentialRequest } | { ok: false; error: string };

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

function formatValue(format: string, value: string): string {
  const at = format.indexOf('{}');
  return format.slice(0, at) + value + format.slice(at + 2);
}

// Percent escapes in lower case, which some servers echo instead.
function lowerEscapes(s: string): string {
  return s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
}

/**
 * Place each named value (keyed by the plan's keys) on the plan's request.
 * Every value must be a non-empty, well-formed string of at most
 * CREDENTIAL_MAX_VALUE_BYTES; a header-placed one must stay a valid header
 * value. A refusal names the key, never the value.
 */
export function placeCredentials(
  plan: CredentialPlan,
  headers: Record<string, string>,
  values: ReadonlyMap<string, string>,
): PlaceCredentialsResult {
  const out: Record<string, string> = { ...headers };
  const redact = new Set<string>();
  const formatted: Array<{ use: CredentialUse; text: string }> = [];
  for (const { key, use } of plan.placements) {
    const value = values.get(key);
    if (typeof value !== 'string' || value === '') return { ok: false, error: `"${key}" is not set` };
    if (utf8Length(value) > CREDENTIAL_MAX_VALUE_BYTES) return { ok: false, error: `"${key}" is longer than ${CREDENTIAL_MAX_VALUE_BYTES} bytes` };
    if (hasLoneSurrogate(value)) return { ok: false, error: `"${key}" is not well-formed text` };
    const text = formatValue(use.format, value);
    if (use.header !== undefined && /[^ -~\u0080-ÿ\t]/.test(text)) {
      return { ok: false, error: `"${key}" holds characters a header cannot carry` };
    }
    formatted.push({ use, text });
    redact.add(value);
    redact.add(text);
  }
  for (const { use, text } of formatted) {
    if (use.header !== undefined) {
      out[use.header] = text;
    } else {
      plan.url.searchParams.append(use.query, text);
      const encoded = new URLSearchParams([[use.query, text]]).toString().slice(use.query.length + 1);
      for (const s of [encoded, encodeURIComponent(text)]) {
        redact.add(s);
        redact.add(lowerEscapes(s));
      }
    }
  }
  for (const value of values.values()) {
    const e = encodeURIComponent(value);
    redact.add(e);
    redact.add(lowerEscapes(e));
  }
  const candidates = [...redact].filter((s) => s.length >= CREDENTIAL_MIN_REDACT_CHARS).sort((a, b) => b.length - a.length);
  return { ok: true, request: { dispatchUrl: plan.url.href, headers: out, redact: candidates } };
}

/**
 * Replace every occurrence of every candidate in `text`. When the text was
 * cut short (`truncated`), a trailing piece that could be the start of a
 * candidate is withheld as well, so a value straddling the cut never shows
 * in part. Candidates go longest first, so an encoding containing the raw
 * value is redacted whole.
 */
export function redactCredentialText(text: string, candidates: readonly string[], truncated = false): string {
  let out = text;
  for (const c of candidates) {
    if (c.length < CREDENTIAL_MIN_REDACT_CHARS) continue;
    if (out.includes(c)) out = out.split(c).join(CREDENTIAL_REDACTED);
  }
  if (!truncated) return out;
  let cut = 0;
  for (const c of candidates) {
    for (let n = Math.min(c.length - 1, out.length); n > cut; n--) {
      if (out.endsWith(c.slice(0, n))) { cut = n; break; }
    }
  }
  return cut ? out.slice(0, out.length - cut) : out;
}

/**
 * How a grant names a placement, for trusted UI: where the value goes, said
 * plainly, with the logging risk of a query placement.
 */
export function describeCredentialUse(use: CredentialUse): string {
  if (use.header !== undefined) return `to ${use.origin} in the ${use.header} header`;
  return `to ${use.origin} in the web address as "${use.query}" (services often record web addresses in their logs)`;
}

/**
 * The exact placement a grant is bound to: canonical origin, placement kind,
 * its exact spelling, and the format. Any change to one of them is a
 * different placement, needing the user's approval again.
 */
export function credentialUseBinding(use: CredentialUse): string {
  return JSON.stringify(use.header !== undefined
    ? ['header', use.origin, use.header, use.format]
    : ['query', use.origin, use.query, use.format]);
}
