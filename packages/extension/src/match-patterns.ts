// A shim's `match.hosts` as Chrome match patterns: what the extension
// registers its content scripts for and what it asks the user to grant.
//
// The host-pattern grammar is the engine's (`@shimbrowser/core/host-match`):
// a hostname, `*.hostname` for its subdomains, or `hostname:port`. Chrome's
// match patterns say the same things: `*://example.com/*` matches any port
// on that host, `*://*.example.com/*` any subdomain, `*://localhost:5173/*`
// that port only. The registration is the coarse net; on the page the
// runtime still asks the worker, which applies `hostMatches` exactly, so a
// difference between the two grammars can only widen the net, never a match.

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const HOST_PATTERN_RE = new RegExp(`^(\\*\\.)?${LABEL}(?:\\.${LABEL})*(?::(\\d{1,5}))?$`);

/** Why `pattern` cannot be registered, or null. */
export function hostPatternProblem(pattern: unknown): string | null {
  if (typeof pattern !== 'string') return 'a host pattern is not a string';
  if (pattern === '') return 'an empty host pattern';
  const m = HOST_PATTERN_RE.exec(pattern);
  if (!m) return `"${pattern}" is not a host pattern (a hostname, "*.hostname" or "hostname:port")`;
  if (m[2] !== undefined && Number(m[2]) > 65535) return `"${pattern}": the port is out of range`;
  return null;
}

/** The match pattern for one valid host pattern. */
export function matchPatternForHost(pattern: string): string {
  return `*://${pattern}/*`;
}

/**
 * The match patterns for `hosts`, in order and de-duplicated, and every host
 * pattern that could not become one. A shim with any problem is not
 * installable: it would run on fewer sites than it declares.
 */
export function matchPatternsForHosts(hosts: readonly unknown[]): { patterns: string[]; problems: string[] } {
  const patterns: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const host of hosts) {
    const problem = hostPatternProblem(host);
    if (problem !== null) {
      problems.push(problem);
      continue;
    }
    const pattern = matchPatternForHost(host as string);
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    patterns.push(pattern);
  }
  return { patterns, problems };
}
