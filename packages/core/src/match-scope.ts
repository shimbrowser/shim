// Where a shim runs, as an external session may change it: the admission
// check a pattern a session adds to `match.hosts` must pass, and which of a
// working list's patterns run the shim somewhere the committed list doesn't
// (the hosts the Shim browser's commit card asks about, one by one).
//
// Two separate questions, on purpose:
//   - Admission (hostPatternProblem) is policy for a NEW pattern: canonical,
//     so `hostMatches` (which compares as given) can actually match it.
//   - Containment (patternCovers, widenedPatterns) is runtime semantics: a
//     committed string covers exactly the (hostname, port) set hostMatches
//     matches for it, legacy or not, never normalized. An identical retained
//     pattern is always covered, so an approved host is never asked about
//     again, and a non-canonical legacy string never authorizes a different
//     functional one.
//
// Plus the honesty helpers both hosts use for a session's evidence: the
// warning (and `partial` cap) on a page the working match doesn't cover, and
// where a session has fresh rule evidence from — a statement about the
// session, never a proof per rule version.
//
// Pure and dependency-free: the browser's commit card, the working-copy
// differ and headless all use it, so a bare-node harness covers it
// (match-scope-harness).
import { hostMatches } from './host-match';

/** The note a preview that changes only where the shim runs carries: it ran no rule, so it vouches for none. */
export const NO_RULE_EVIDENCE_NOTE = 'this preview produced no fresh rule evidence — a rule\'s evidence comes from a preview that changes it';

/** The most patterns one commit may newly run a shim on: each is one line of the commit card. */
export const MAX_NEW_MATCH_PATTERNS = 20;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function canonicalHostname(host: string): boolean {
  try {
    return new URL(`http://${host}/`).hostname === host;
  } catch {
    return false;
  }
}

/**
 * Why `pattern` can't be added to a shim's `match.hosts`, or null. A host
 * (`example.com`), a host with a port (`localhost:5173`), or a subdomain
 * wildcard (`*.example.com`, never the apex and never with a port).
 */
export function hostPatternProblem(pattern: unknown): string | null {
  if (typeof pattern !== 'string' || pattern === '') return 'a host pattern must be a non-empty string';
  const show = JSON.stringify(pattern);
  if (/\s/.test(pattern)) return `${show}: a host pattern has no whitespace`;
  if (pattern.includes('/') || pattern.includes('@') || pattern.includes('?') || pattern.includes('#')) {
    return `${show}: a host pattern is a hostname, not a URL (no scheme, path or query)`;
  }
  if (pattern.includes('[') || pattern.includes(']')) return `${show}: IPv6 addresses aren't supported in match.hosts`;
  let host = pattern;
  let port: string | null = null;
  const colon = pattern.indexOf(':');
  if (colon !== -1) {
    host = pattern.slice(0, colon);
    port = pattern.slice(colon + 1);
    if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) return `${show}: the port must be a number from 1 to 65535, written without leading zeros`;
  }
  const wildcard = host.startsWith('*.');
  if (wildcard) {
    if (port !== null) return `${show}: a wildcard can't carry a port (it would never match)`;
    host = host.slice(2);
  }
  if (host === '' || host === '*') return `${show}: name a host`;
  if (host.endsWith('.')) return `${show}: drop the trailing dot`;
  if (host.length > 253) return `${show}: a hostname is at most 253 characters`;
  const labels = host.split('.');
  if (!labels.every((label) => LABEL.test(label))) {
    return `${show}: each part of a hostname is 1-63 lowercase letters, digits or hyphens, not starting or ending with a hyphen ` +
      '(write an internationalized name in its xn-- form)';
  }
  if (!canonicalHostname(host)) return `${show}: write the hostname the way a browser shows it`;
  if (wildcard) {
    if (labels.length < 2) return `${show}: a wildcard must name a domain with at least two parts (not "*.${host}")`;
    if (IPV4.test(host)) return `${show}: a wildcard can't cover an IP address`;
  }
  return null;
}

function hostPart(pattern: string): string {
  const colon = pattern.indexOf(':');
  return colon === -1 ? pattern : pattern.slice(0, colon);
}

/**
 * Whether the committed pattern `committed` already matches every page
 * `pattern` matches, by hostMatches' own semantics (see the header).
 */
export function patternCovers(committed: string, pattern: string): boolean {
  if (committed === pattern) return true;
  // A pattern with a port matches only its own exact string.
  if (committed.includes(':')) return false;
  if (committed.startsWith('*.')) {
    const suffix = committed.slice(1); // ".example.com"
    // An exact host (with or without a port): its hostname must end with
    // the suffix.
    if (!pattern.startsWith('*.')) return hostPart(pattern).endsWith(suffix);
    // A wildcard (one with a port matches nothing, so anything covers it).
    if (pattern.includes(':')) return true;
    return pattern.slice(1).endsWith(suffix);
  }
  // An exact host without a port: that hostname on any port.
  if (pattern.startsWith('*.')) return pattern.includes(':');
  return hostPart(pattern) === committed;
}

/**
 * The patterns of `working` no pattern of `committed` covers, in working
 * order and without repeats: where the working list would newly run the
 * shim. A non-string entry is skipped (the validators refuse it).
 */
export function widenedPatterns(committed: readonly unknown[] | undefined, working: readonly unknown[] | undefined): string[] {
  const before = (committed ?? []).filter((p): p is string => typeof p === 'string');
  const out: string[] = [];
  for (const pattern of working ?? []) {
    if (typeof pattern !== 'string' || out.includes(pattern)) continue;
    if (!before.some((c) => patternCovers(c, pattern))) out.push(pattern);
  }
  return out;
}

/**
 * Whether a page at `hostname[:port]` that `before` covered is no longer
 * covered by `after`: a frame a narrowing commit must tear the shim down on,
 * since a broadcast keyed on the new match never reaches it again.
 */
export function leftMatchScope(before: readonly unknown[] | undefined, after: readonly unknown[] | undefined, hostname: string, port?: string): boolean {
  const p = port || undefined;
  return hostMatches(stringHosts(before), hostname, p) && !hostMatches(stringHosts(after), hostname, p);
}

function httpUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function stringHosts(hosts: readonly unknown[] | undefined): string[] {
  return (hosts ?? []).filter((h): h is string => typeof h === 'string' && h !== '');
}

/**
 * The warning a preview carries while its page is one `hosts` (the working
 * match.hosts) doesn't cover, or null (covered, or not an http(s) page). In
 * Shim the shim would not run on that page at all, so nothing seen there says
 * it behaves the same in Shim: the caller caps every rule at `partial`
 * (withOffMatch).
 */
export function offMatchWarning(hosts: readonly unknown[] | undefined, url: string): string | null {
  const u = httpUrl(url);
  if (!u) return null;
  const list = stringHosts(hosts);
  if (hostMatches(list, u.hostname, u.port || undefined)) return null;
  const where = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  return `the shim's match.hosts (${list.join(', ') || 'none'}) doesn't cover ${where}: in Shim it would not run on this page, ` +
    'so no rule here is verified beyond partial. If it should run here, add the host to match.hosts';
}

/**
 * Evidence on an off-match page: every rule's verification capped at
 * `partial` (`full` drops, `none` stays), and the warning added.
 */
export function withOffMatch(evidence: Record<string, unknown>, warning: string): Record<string, unknown> {
  const warnings = Array.isArray(evidence.warnings) ? [...(evidence.warnings as unknown[])] : [];
  warnings.push(warning);
  const out: Record<string, unknown> = { ...evidence, warnings };
  if (Array.isArray(evidence.rules)) {
    out.rules = evidence.rules.map((r: unknown) => (
      typeof r === 'object' && r !== null && !Array.isArray(r) && (r as Record<string, unknown>).verification === 'full'
        ? { ...(r as Record<string, unknown>), verification: 'partial' }
        : r
    ));
  }
  return out;
}

/** An http(s) page's location as a session records its evidence: scheme, host and port. */
export function evidenceLocation(url: string): string | null {
  const u = httpUrl(url);
  return u ? `${u.protocol}//${u.host}` : null;
}

/** A page's location and document token (PageHost.documentToken) at one moment. */
export interface DocumentMark { location: string | null; token: string | null }

/**
 * The location a preview's rule evidence may be recorded against, or null:
 * only when the page kept the same location and document from the apply to
 * the evidence. A preview whose page navigated mid-settle reported on the
 * old document, so it records nowhere.
 */
export function attributableLocation(start: DocumentMark, end: DocumentMark): string | null {
  return start.location !== null && start.location === end.location && start.token === end.token ? start.location : null;
}

/** The recorded locations (evidenceLocation's form) `pattern` matches. */
export function locationsMatching(pattern: string, locations: Iterable<string>): string[] {
  const out: string[] = [];
  for (const location of locations) {
    const u = httpUrl(`${location}/`);
    if (u && hostMatches([pattern], u.hostname, u.port || undefined)) out.push(location);
  }
  return out;
}

/**
 * The commit note saying where the shim runs beyond what this session tried,
 * or null when every pattern is an exact host the session got rule evidence
 * on. A wildcard is never "tried" by one member.
 */
export function untriedMatchNote(hosts: readonly unknown[] | undefined, locations: Iterable<string>): string | null {
  const seen = [...locations];
  const parts: string[] = [];
  for (const pattern of stringHosts(hosts)) {
    const tried = locationsMatching(pattern, seen);
    if (tried.length === 0) parts.push(`${pattern} (not tried)`);
    else if (pattern.startsWith('*.')) parts.push(`${pattern} (tried only on ${tried.join(', ')})`);
  }
  if (parts.length === 0) return null;
  const where = seen.length ? `this session got rule evidence only on ${seen.join(', ')}` : 'this session got no rule evidence';
  return `${where}. The shim ${seen.length ? 'also ' : ''}runs on ${parts.join(', ')}: ` +
    'beyond the pages this session tried, its rules are untested there. To check a site, open a session on a page of it';
}
