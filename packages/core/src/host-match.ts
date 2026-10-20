// Host-pattern matching for `spec.match.hosts`: does a spec apply to a page
// at `hostname[:port]`? One implementation for every host — the Shim
// browser's registry, its external-session page guard, the Playwright driver
// and a browser extension turning `match.hosts` into script registrations
// all need the same answer, so the rule lives here and nowhere else.
//
// Semantics:
//   - a pattern WITHOUT a port matches any port ("example.com")
//   - a pattern WITH a port requires an exact host:port match ("localhost:5173")
//   - "*.example.com" matches any subdomain (suffix match on ".example.com"),
//     never the bare apex
//   - a missing or non-array pattern list never matches
//
// Hostnames are compared as given: callers pass the URL's hostname
// (already lowercase and punycoded by the URL parser) and its port string,
// or omit the port for the default one.
function hostMatches(patterns: string[] | undefined, hostname: string, port?: string | number): boolean {
  if (!Array.isArray(patterns)) return false;
  const withPort = port ? `${hostname}:${port}` : hostname;
  for (const p of patterns) {
    if (p.includes(':')) {
      if (p === withPort) return true;
      continue;
    }
    if (p === hostname) return true;
    if (p.startsWith('*.') && hostname.endsWith(p.slice(1))) return true;
  }
  return false;
}

export { hostMatches };
