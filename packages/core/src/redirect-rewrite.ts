// The `rewrite` part of a `redirect` mutation: a declarative change to a top-level
// navigation's path and query, decided from the request URL alone before the
// request leaves. Pure and dependency-free: the host's network layer decides
// which entries may run on a request (hosts, page scope, admission, method);
// this module only says what one entry does to one URL.
//
//   { "kind": "redirect",
//     "rewrite": { "path": "/shorts/:id", "toPath": "/watch", "set": { "v": ":id" } } }
//
// Grammar (deliberately small, lifted from three real shims):
//   path    the pathname to match: literal segments and whole-segment `:name`
//           captures, all required, names unique. Omitted: any path.
//   toPath  the new pathname, from literals and `:name`s `path` declares.
//           Omitted: the pathname is kept.
//   set     query keys to set, each to a literal or a whole `:name`.
//   drop    query keys to remove.
//   unless  query keys whose presence (any value, empty included) skips the
//           whole mutation, its host change included.
//
// Untouched query components keep their exact bytes and order, so a rewrite
// that changes nothing produces no navigation. One application must be final:
// an entry that would fire again on its own output never fires
// (`resolveRewrite`).

import { isRecord } from './is-record';

export interface RedirectRewrite {
  path?: string;
  toPath?: string;
  set?: Record<string, string>;
  drop?: string[];
  unless?: string[];
}

export const REWRITE_LIMITS = {
  templateChars: 256,
  segments: 16,
  entries: 16,
  keyChars: 256,
  urlChars: 8192,
} as const;

type Segment = { lit: string } | { cap: string };
type SetValue = { lit: string } | { cap: string };

export interface CompiledRewrite {
  path: Segment[] | null;
  toPath: Segment[] | null;
  set: Array<[string, SetValue]>;
  drop: ReadonlySet<string>;
  unless: ReadonlySet<string>;
}

export type CompileResult = { ok: true; rewrite: CompiledRewrite } | { ok: false; error: string };

const CAPTURE_RE = /^:([A-Za-z_][A-Za-z0-9_]*)$/;
// RFC 3986 unreserved + sub-delims + ':' '@', minus '%' (a literal is written
// as it should appear, never pre-escaped) and '*' (it reads as a wildcard,
// which the grammar doesn't have).
const LITERAL_RE = /^[A-Za-z0-9\-._~!$&'()+,;=:@]+$/;
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

// A bare, canonical hostname: lowercase labels, no scheme, port or path. The
// form a redirect's `to` must take when the mutation carries a `rewrite`.
export function isBareHostname(value: unknown): value is string {
  return typeof value === 'string' && HOSTNAME_RE.test(value);
}

function parseTemplate(field: string, template: unknown): { ok: true; segments: Segment[] } | { ok: false; error: string } {
  if (typeof template !== 'string') return { ok: false, error: `rewrite.${field} must be a string` };
  if (template.length > REWRITE_LIMITS.templateChars) {
    return { ok: false, error: `rewrite.${field} is longer than ${REWRITE_LIMITS.templateChars} characters` };
  }
  if (!template.startsWith('/')) return { ok: false, error: `rewrite.${field} must start with "/"` };
  let body = template.slice(1);
  if (body.endsWith('/')) body = body.slice(0, -1);
  if (body === '') return { ok: true, segments: [] };
  const parts = body.split('/');
  if (parts.length > REWRITE_LIMITS.segments) {
    return { ok: false, error: `rewrite.${field} has more than ${REWRITE_LIMITS.segments} segments` };
  }
  const segments: Segment[] = [];
  for (const part of parts) {
    if (part === '') return { ok: false, error: `rewrite.${field} has an empty segment ("//")` };
    const cap = CAPTURE_RE.exec(part);
    if (cap?.[1] !== undefined) {
      segments.push({ cap: cap[1] });
      continue;
    }
    if (part.startsWith(':')) {
      return { ok: false, error: `rewrite.${field}: "${part}" is not a capture — a capture is ":" then letters, digits or "_"` };
    }
    if (part === '.' || part === '..' || !LITERAL_RE.test(part)) {
      return { ok: false, error: `rewrite.${field}: segment "${part}" isn't allowed — write literal characters (no "%", "*", "\\", "?", "#", "." or "..") or a whole ":name"` };
    }
    segments.push({ lit: part });
  }
  return { ok: true, segments };
}

function parseKeyList(field: 'drop' | 'unless', value: unknown): { ok: true; keys: Set<string> } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: `rewrite.${field} must be an array of query keys` };
  if (value.length > REWRITE_LIMITS.entries) {
    return { ok: false, error: `rewrite.${field} has more than ${REWRITE_LIMITS.entries} keys` };
  }
  const keys = new Set<string>();
  for (const k of value) {
    if (typeof k !== 'string' || k === '' || k.length > REWRITE_LIMITS.keyChars) {
      return { ok: false, error: `rewrite.${field} keys must be non-empty strings of at most ${REWRITE_LIMITS.keyChars} characters` };
    }
    keys.add(k);
  }
  return { ok: true, keys };
}

const REWRITE_FIELDS = new Set(['path', 'toPath', 'set', 'drop', 'unless']);

// Validate and compile a `rewrite` object. The same check backs spec-lint and
// the host's collection, so a rewrite that lints clean is exactly one that runs.
export function compileRewrite(raw: unknown): CompileResult {
  if (!isRecord(raw)) return { ok: false, error: 'rewrite must be an object' };
  for (const k of Object.keys(raw)) {
    if (!REWRITE_FIELDS.has(k)) return { ok: false, error: `rewrite has an unknown field "${k}" — allowed: ${[...REWRITE_FIELDS].join(', ')}` };
  }
  let path: Segment[] | null = null;
  if (raw.path !== undefined) {
    const parsed = parseTemplate('path', raw.path);
    if (!parsed.ok) return parsed;
    path = parsed.segments;
  }
  const declared = new Set<string>();
  for (const seg of path ?? []) {
    if (!('cap' in seg)) continue;
    if (declared.has(seg.cap)) return { ok: false, error: `rewrite.path declares ":${seg.cap}" twice` };
    declared.add(seg.cap);
  }
  const undeclared = (name: string): string =>
    `rewrite uses ":${name}", which rewrite.path doesn't declare`;
  let toPath: Segment[] | null = null;
  if (raw.toPath !== undefined) {
    const parsed = parseTemplate('toPath', raw.toPath);
    if (!parsed.ok) return parsed;
    for (const seg of parsed.segments) {
      if ('cap' in seg && !declared.has(seg.cap)) return { ok: false, error: undeclared(seg.cap) };
    }
    toPath = parsed.segments;
  }
  const set: Array<[string, SetValue]> = [];
  if (raw.set !== undefined) {
    if (!isRecord(raw.set)) return { ok: false, error: 'rewrite.set must be an object of query key → value' };
    const entries = Object.entries(raw.set);
    if (entries.length > REWRITE_LIMITS.entries) {
      return { ok: false, error: `rewrite.set has more than ${REWRITE_LIMITS.entries} keys` };
    }
    for (const [k, v] of entries) {
      if (k === '' || k.length > REWRITE_LIMITS.keyChars) {
        return { ok: false, error: `rewrite.set keys must be non-empty strings of at most ${REWRITE_LIMITS.keyChars} characters` };
      }
      if (typeof v !== 'string' || v.length > REWRITE_LIMITS.keyChars) {
        return { ok: false, error: `rewrite.set "${k}" must be a string of at most ${REWRITE_LIMITS.keyChars} characters` };
      }
      if (v.startsWith(':')) {
        const cap = CAPTURE_RE.exec(v);
        if (cap?.[1] === undefined) return { ok: false, error: `rewrite.set "${k}": a value starting with ":" must be a whole capture like ":id"` };
        if (!declared.has(cap[1])) return { ok: false, error: undeclared(cap[1]) };
        set.push([k, { cap: cap[1] }]);
      } else {
        set.push([k, { lit: v }]);
      }
    }
  }
  let drop: Set<string> = new Set();
  if (raw.drop !== undefined) {
    const parsed = parseKeyList('drop', raw.drop);
    if (!parsed.ok) return parsed;
    drop = parsed.keys;
  }
  let unless: Set<string> = new Set();
  if (raw.unless !== undefined) {
    const parsed = parseKeyList('unless', raw.unless);
    if (!parsed.ok) return parsed;
    unless = parsed.keys;
  }
  for (const [k] of set) {
    if (drop.has(k)) return { ok: false, error: `rewrite sets and drops "${k}" — pick one` };
  }
  if (toPath === null && set.length === 0 && drop.size === 0) {
    return { ok: false, error: 'rewrite changes nothing — give it a toPath, set or drop' };
  }
  return { ok: true, rewrite: { path, toPath, set, drop, unless } };
}

function decodeOrNull(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

// application/x-www-form-urlencoded decoding: `+` is a space, `%2B` a plus.
function formDecode(s: string): string | null {
  return decodeOrNull(s.replace(/\+/g, ' '));
}

interface QueryComponent { raw: string; key: string | null; value: string | null }

function parseQuery(search: string): QueryComponent[] {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (raw === '') return [];
  return raw.split('&').map((part) => {
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
    return { raw: part, key: part === '' ? null : formDecode(rawKey), value: formDecode(rawValue) };
  });
}

function matchPath(segments: Segment[], pathname: string): Map<string, string> | null {
  let body = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  if (body.endsWith('/')) body = body.slice(0, -1);
  const parts = body === '' ? [] : body.split('/');
  if (parts.length !== segments.length) return null;
  const captures = new Map<string, string>();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const part = parts[i];
    if (seg === undefined || part === undefined || part === '') return null;
    const decoded = decodeOrNull(part);
    if (decoded === null) return null;
    if ('lit' in seg) {
      if (decoded !== seg.lit) return null;
    } else {
      captures.set(seg.cap, decoded);
    }
  }
  return captures;
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

// One application of a compiled rewrite (plus an optional host change) to a
// URL: the new URL, or null when the entry doesn't fire here (its path or
// `unless` fails, a capture can't be placed, or nothing would change).
export function applyRewrite(rewrite: CompiledRewrite, to: string | null, href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!isHttpUrl(url)) return null;
  if (to !== null && !isBareHostname(to)) return null;

  const captures = rewrite.path ? matchPath(rewrite.path, url.pathname) : new Map<string, string>();
  if (captures === null) return null;

  const components = parseQuery(url.search);
  if (rewrite.unless.size > 0 && components.some((c) => c.key !== null && rewrite.unless.has(c.key))) return null;

  const captured = (name: string): string | null => {
    const v = captures.get(name);
    return v === undefined || v === '' || v === '.' || v === '..' ? null : v;
  };

  let pathname: string | null = null;
  if (rewrite.toPath) {
    const out: string[] = [];
    for (const seg of rewrite.toPath) {
      if ('lit' in seg) {
        out.push(seg.lit);
        continue;
      }
      const v = captured(seg.cap);
      if (v === null) return null;
      out.push(encodeURIComponent(v));
    }
    pathname = `/${out.join('/')}`;
  }

  let next = components.filter((c) => !(c.key !== null && rewrite.drop.has(c.key)));
  const appended: string[] = [];
  for (const [key, valueSpec] of rewrite.set) {
    let value: string;
    if ('lit' in valueSpec) {
      value = valueSpec.lit;
    } else {
      const v = captured(valueSpec.cap);
      if (v === null) return null;
      value = v;
    }
    const existing = next.filter((c) => c.key === key);
    const only = existing[0];
    if (existing.length === 1 && only !== undefined && only.value === value) continue;
    next = next.filter((c) => c.key !== key);
    appended.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  const before = components.map((c) => c.raw);
  const after = [...next.map((c) => c.raw), ...appended];
  const queryChanged = before.length !== after.length || before.some((raw, i) => raw !== after[i]);

  const out = new URL(url.href);
  if (pathname !== null) out.pathname = pathname;
  if (queryChanged) out.search = after.length > 0 ? `?${after.join('&')}` : '';
  if (to !== null) out.hostname = to;

  if (!isHttpUrl(out) || out.protocol !== url.protocol || out.port !== url.port) return null;
  if (out.hostname !== (to ?? url.hostname)) return null;
  if (out.href === url.href || out.href.length > REWRITE_LIMITS.urlChars) return null;
  return out.href;
}

export type RewriteOutcome =
  | { kind: 'rewrite'; url: string }
  | { kind: 'no-match' }
  | { kind: 'not-idempotent'; url: string };

// What one entry does to a navigation: the rewrite, nothing, or a refusal
// because the entry would fire again on its own output (no loop, no partial
// chain: such an entry never fires).
export function resolveRewrite(rewrite: CompiledRewrite, to: string | null, href: string): RewriteOutcome {
  const first = applyRewrite(rewrite, to, href);
  if (first === null) return { kind: 'no-match' };
  if (applyRewrite(rewrite, to, first) !== null) return { kind: 'not-idempotent', url: first };
  return { kind: 'rewrite', url: first };
}

const SIMULATION_NOTE = 'simulation only, the network change is not verified: it applies in main to full page loads (GET), '
  + 'never to in-page navigation, and when shims overlap the top shim\'s first matching rewrite wins alone';

function shortUrl(href: string, keepHost: boolean): string {
  try {
    const u = new URL(href);
    return `${keepHost ? u.host : ''}${u.pathname}${u.search}`;
  } catch {
    return href;
  }
}

// The preview's account of a `redirect` mutation that carries a `rewrite`,
// against the page the preview is on. Pure, so every host words it the same.
export function describeRewriteSimulation(mutation: { rewrite?: unknown; to?: unknown }, pageUrl: string | null): string {
  const compiled = compileRewrite(mutation.rewrite);
  if (!compiled.ok) return `redirect rewrite not registered: ${compiled.error}`;
  const to = mutation.to === undefined ? null : mutation.to;
  if (to !== null && !isBareHostname(to)) return 'redirect rewrite not registered: "to" must be a bare lowercase hostname (no scheme, port or path)';
  if (!pageUrl) return `redirect rewrite registered (${SIMULATION_NOTE})`;
  const outcome = resolveRewrite(compiled.rewrite, to, pageUrl);
  const hostChanges = to !== null;
  if (outcome.kind === 'no-match') return `redirect rewrite registered; it doesn't apply to this page's URL (${SIMULATION_NOTE})`;
  if (outcome.kind === 'not-idempotent') {
    return `redirect rewrite would never run: on this page it gives ${shortUrl(outcome.url, hostChanges)}, which it would rewrite again — add an "unless" or narrow "path" so its own result doesn't match`;
  }
  return `redirect rewrite registered; a full load of this page would go to ${shortUrl(outcome.url, hostChanges)} (${SIMULATION_NOTE})`;
}
