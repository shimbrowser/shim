// Site access a credential grant owns. Approving a placed secret asks Chrome,
// in the same click, for access to exactly the grant's origin: without it
// the worker's credential request is cross-origin, so its answer is
// unreadable and a header like Authorization costs a preflight. That access
// belongs to the grant, not to the shim: it is not one of the shim's sites,
// so the shim runs nowhere new, and other shims' plain fetches to that
// origin are not refused as "held for another shim". They read it only as
// CORS would let them (fetch.ts, corsOnly). The access goes back when the
// last grant that needs it goes (revoked, its shim removed, the vault reset)
// unless a shim's own sites still need the host. A grant whose access the
// user withdrew on chrome://extensions is dropped, never used. Pure: the
// worker holds the permissions and the rows.

import { hostMatches } from '@shimbrowser/core/host-match';
import type { GrantRow } from './credential-grants';
import { patternsFor } from './registration';

/**
 * The Chrome match pattern for a grant's origin. A host permission carries
 * no port, so `https://api.example.com:8443` asks for the host on every
 * port; the grant itself stays bound to the exact origin.
 */
export function accessPatternForOrigin(origin: string): string | null {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname) return null;
  return `https://${u.hostname.toLowerCase().replace(/\.+$/, '')}/*`;
}

/** The origin a grant row is bound to (its binding: [kind, origin, name, format]); null for a row this build cannot read. */
export function grantOrigin(row: Pick<GrantRow, 'binding'>): string | null {
  try {
    const parsed: unknown = JSON.parse(row.binding);
    return Array.isArray(parsed) && typeof parsed[1] === 'string' ? parsed[1] : null;
  } catch {
    return null;
  }
}

export function grantAccessPattern(row: Pick<GrantRow, 'binding'>): string | null {
  const origin = grantOrigin(row);
  return origin === null ? null : accessPatternForOrigin(origin);
}

/** Every pattern the grants in `rows` own. */
export function grantAccessPatterns(rows: readonly Pick<GrantRow, 'binding'>[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    const p = grantAccessPattern(row);
    if (p) out.add(p);
  }
  return out;
}

type ShimLike = { spec: { match?: { hosts?: string[] } } };

/**
 * Of the patterns that just lost a user (a shim's sites, a grant's access),
 * the ones nothing still needs: no remaining shim registers the pattern, and
 * no remaining grant owns it. A host a remaining shim's sites cover (its
 * hosts may name a wildcard) keeps any grant pattern on it too.
 */
export function accessToRelease(removed: readonly string[], remainingShims: readonly ShimLike[], remainingGrants: readonly Pick<GrantRow, 'binding'>[]): string[] {
  const kept = new Set<string>();
  for (const shim of remainingShims) for (const pattern of patternsFor(shim)) kept.add(pattern);
  const granted = grantAccessPatterns(remainingGrants);
  for (const pattern of granted) kept.add(pattern);
  const candidates = new Set<string>();
  for (const pattern of removed) {
    candidates.add(pattern);
    // A shim's `*://host/*` kept for a grant (below) goes with the grant's last pattern.
    const host = hostOfPattern(pattern);
    if (host !== null) candidates.add(`*://${host}/*`);
  }
  return [...candidates].filter((pattern) => {
    if (kept.has(pattern)) return false;
    const grantHost = hostOfPattern(pattern);
    if (grantHost !== null) return !remainingShims.some((s) => shimSitesCover(s, grantHost));
    // Removing a shim's `*://host/*` would take a remaining grant's https
    // access to that host with it: it stays until that grant goes.
    const siteHost = /^\*:\/\/([^/*:]+)\/\*$/.exec(pattern)?.[1];
    return siteHost === undefined || (!granted.has(`https://${siteHost}/*`) && !remainingShims.some((s) => shimSitesCover(s, siteHost)));
  });
}

/** The hostname of an `https://host/*` pattern (a grant's); null for any other shape. */
export function hostOfPattern(pattern: string): string | null {
  const m = /^https:\/\/([^/*:]+)\/\*$/.exec(pattern);
  return m ? (m[1] as string) : null;
}

/**
 * Is `host` reachable only through a grant's access: some grant owns its
 * pattern, and no installed shim's sites cover it? Then the extension's
 * access to it is the grant's alone, and a plain fetch reads it only as
 * CORS would allow.
 */
export function grantOnlyHost(host: string, shims: readonly ShimLike[], grants: readonly Pick<GrantRow, 'binding'>[]): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '');
  if (!grantAccessPatterns(grants).has(`https://${h}/*`)) return false;
  return !shims.some((s) => shimSitesCover(s, h));
}

/**
 * Does the extension hold `host` for this shim's sites? Chrome's patterns
 * carry no port, so a host named with a port holds the host on every port.
 */
export function shimSitesCover(shim: ShimLike, host: string): boolean {
  const hosts = (shim.spec.match?.hosts ?? []).filter((h): h is string => typeof h === 'string').map((h) => h.replace(/:\d+$/, ''));
  return hostMatches(hosts, host, undefined);
}
