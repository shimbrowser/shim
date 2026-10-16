// Route-pattern matcher for the `mount-route` mutation kind (Tier 4).
//
// Compiles a path pattern like `/budgets`, `/budgets/:id`, `/budgets/:id?`,
// or `/files/*` into a tester that, given a concrete pathname, returns
// `{ params }` on a match or `null` on a miss. Zero dependencies — both the
// engine (client side, against `location.pathname`) and the main-process
// route registry (server side, deciding whether to serve a local shell)
// import this, so it has to run in a plain Node context and the page's
// isolated world alike.
//
// Grammar (deliberately small — lifted from real patterns, not guessed):
//   /literal           exact segment
//   /:name             required param, matches one non-empty segment
//   /:name?            optional param, the whole segment may be absent
//   /*                 trailing wildcard, captures the rest as params['*']
//
// Matching is case-sensitive on literals, anchored at both ends, and ignores
// a trailing slash so `/budgets` and `/budgets/` are the same route. Query
// string and hash are the caller's job to strip — we only see a pathname.

// Strip query + hash and collapse a trailing slash. Applied to concrete
// PATHNAMES only — never to patterns, where `?` is the optional-param marker
// (`/budgets/:id?`) rather than a query-string delimiter.
function normalizePath(path: string): string {
  if (!path) return '/';
  const q = path.search(/[?#]/);
  let p = q === -1 ? path : path.slice(0, q);
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

// Split into non-empty segments, no query/hash handling. Used for patterns
// (which may carry a literal `?`) and, after normalizePath, for pathnames.
function splitSegments(str: string): string[] {
  return String(str).split('/').filter(Boolean);
}

// Segments of a concrete pathname: query/hash stripped first. "/" → [].
function pathSegments(path: string): string[] {
  return splitSegments(normalizePath(path));
}

type Token =
  | { type: 'literal'; value: string }
  | { type: 'param'; name: string; optional: boolean }
  | { type: 'wildcard' };

// Compile a pattern string into { tokens, hasWildcard }. Each token is one of:
//   { type: 'literal', value }
//   { type: 'param', name, optional }
//   { type: 'wildcard' }
function compile(pattern: string): { toks: Token[]; hasWildcard: boolean } {
  const toks: Token[] = [];
  let hasWildcard = false;
  for (const seg of splitSegments(pattern)) {
    if (seg === '*') {
      hasWildcard = true;
      toks.push({ type: 'wildcard' });
      continue;
    }
    if (seg.startsWith(':')) {
      const optional = seg.endsWith('?');
      const name = seg.slice(1, optional ? -1 : undefined);
      toks.push({ type: 'param', name, optional });
      continue;
    }
    toks.push({ type: 'literal', value: seg });
  }
  return { toks, hasWildcard };
}

// Returns a function (pathname) -> { params } | null.
function matcher(pattern: string): (pathname: string) => { params: Record<string, string | undefined> } | null {
  const { toks } = compile(pattern);
  return function match(pathname: string): { params: Record<string, string | undefined> } | null {
    const segs = pathSegments(pathname);
    const params: Record<string, string | undefined> = {};
    let si = 0; // index into the concrete path segments
    for (const tok of toks) {
      if (tok.type === 'wildcard') {
        // Capture everything remaining (possibly empty) and stop.
        params['*'] = segs.slice(si).join('/');
        return { params };
      }
      if (tok.type === 'literal') {
        if (segs[si] !== tok.value) return null;
        si++;
        continue;
      }
      // param — segs never holds empty/undefined entries (splitSegments
      // filters falsy segments), so `seg !== undefined` is exactly
      // `si < segs.length`.
      const seg = segs[si];
      if (seg !== undefined) {
        params[tok.name] = decodeSegment(seg);
        si++;
      } else if (tok.optional) {
        params[tok.name] = undefined;
      } else {
        return null; // required param has no segment to fill it
      }
    }
    // All tokens consumed — the path must be fully consumed too, otherwise
    // `/budgets` would spuriously match `/budgets/extra`.
    if (si !== segs.length) return null;
    return { params };
  };
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Convenience one-shot: does `pathname` match `pattern`? Returns the match
// object or null. Callers that test the same pattern repeatedly should hold
// onto matcher(pattern) instead of re-compiling each call.
function matchPath(pattern: string, pathname: string): { params: Record<string, string | undefined> } | null {
  return matcher(pattern)(pathname);
}

export { matcher, matchPath, normalizePath, compile };
export type { Token };
