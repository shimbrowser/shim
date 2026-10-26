// navigate's scope: where a shim session may send its page. Pure.
//
// A separate, immutable scope — not the page-away verdict. Page-away is
// observation binding (which pages the session's tools may read: the shim's
// match hosts, any port for a portless pattern, scheme-blind); navigation
// scope is a destination rule, and the narrowest one the evidence needs: the
// session's START ORIGIN (scheme + host + port), captured once when the
// session begins. http(s) only, no credentials in the URL.
//
// It is checked before anything loads. Where the load ends is judged
// afterwards by the page-away guard: a site's own redirect can take the tab
// off the origin (a sign-in host), and the session's tools and previews act
// only once it is back on the site. Redirects are contained, not prevented.

/** The origin a session may navigate within. */
export interface NavigationScope {
  /** `http:` or `https:`. */
  protocol: string;
  /** Lowercase host name, without the port. */
  hostname: string;
  /** The explicit port, '' for the scheme's default. */
  port: string;
}

/** navigate's per-session budget (reload_page keeps its own, smaller one). */
export const MAX_NAVIGATIONS_PER_SESSION = 20;

/** The scope a session that started on `startUrl` gets, or null when the start page has no http(s) origin to keep. */
export function navigationScopeOf(startUrl: string | null | undefined): NavigationScope | null {
  if (!startUrl) return null;
  let u: URL;
  try { u = new URL(startUrl); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return { protocol: u.protocol, hostname: u.hostname.toLowerCase(), port: u.port };
}

/** The scope as an origin string, for messages (`https://example.com`, `http://127.0.0.1:5173`). */
export function describeScope(scope: NavigationScope): string {
  return `${scope.protocol}//${scope.hostname}${scope.port ? `:${scope.port}` : ''}`;
}

/** Whether `url` (a URL the page shows) is on the scope's origin. */
export function onScopeOrigin(scope: NavigationScope, url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === scope.protocol && u.hostname.toLowerCase() === scope.hostname && u.port === scope.port;
}

/**
 * A navigate request checked against the scope: the canonical URL to load,
 * or why it is refused. A relative URL resolves against the start origin.
 */
export function checkNavigateTarget(
  scope: NavigationScope | null,
  raw: unknown,
): { ok: true; url: string } | { ok: false; error: 'invalid-url' | 'off-origin' | 'no-scope'; detail: string } {
  if (!scope) return { ok: false, error: 'no-scope', detail: 'the session did not start on an http(s) page, so it has no origin to navigate within' };
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, error: 'invalid-url', detail: 'url must be a non-empty string' };
  let u: URL;
  try { u = new URL(raw.trim(), describeScope(scope)); } catch { return { ok: false, error: 'invalid-url', detail: `"${raw}" is not a URL` }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'invalid-url', detail: `only http(s) pages can be opened (got ${u.protocol})` };
  }
  if (u.username || u.password) return { ok: false, error: 'invalid-url', detail: 'a URL with credentials in it is refused' };
  if (!onScopeOrigin(scope, u.href)) {
    return { ok: false, error: 'off-origin', detail: `navigate stays on the session's start origin, ${describeScope(scope)} (same scheme, host and port); ${u.protocol}//${u.host} is outside it` };
  }
  return { ok: true, url: u.href };
}

/**
 * Whether loading `target` from `current` is a same-document navigation (a
 * fragment on the same page): the document survives, no load event comes,
 * and the previews on it stay live.
 */
export function isSameDocumentNavigation(current: string, target: string): boolean {
  let a: URL;
  let b: URL;
  try { a = new URL(current); b = new URL(target); } catch { return false; }
  // A present but empty fragment (`/page#`) counts: `hash` reads '' for it.
  if (b.hash === '' && !b.href.includes('#')) return false;
  return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
}

// --- the tool -----------------------------------------------------------------

/** A session's navigation state: its fixed scope and how many navigations it has used. */
export interface NavigationState {
  readonly scope: NavigationScope | null;
  used: number;
}

/** What a host's load reported: where the page ended up, and whether that is still the session's site. */
export interface NavigateLoad {
  /** The load finished (the document arrived). */
  ok: boolean;
  /** Where the page is now. */
  url: string;
  /** The page-away guard's verdict on where it landed: null on the session's site. */
  offSite: { error: string; detail?: string } | null;
  /** Previews re-applied on the new document. */
  reapplied: number;
  /** A fragment move on the same page: the document (and its previews) survived. */
  sameDocument?: boolean;
  /** What putting the previews back on the new document said (reported as `newDocument`). */
  note?: string;
  error?: string;
}

/**
 * One navigate call: check the destination against the scope and the
 * budget, then load it (the host's job) and report where the page landed.
 * A refused request loads nothing and costs nothing; every load counts.
 */
export async function runNavigate(
  input: unknown,
  state: NavigationState,
  load: (url: string) => Promise<NavigateLoad>,
): Promise<Record<string, unknown>> {
  const raw = typeof input === 'object' && input !== null ? (input as { url?: unknown }).url : undefined;
  const target = checkNavigateTarget(state.scope, raw);
  if (!target.ok) return { error: target.error, detail: target.detail };
  if (state.used >= MAX_NAVIGATIONS_PER_SESSION) {
    return {
      error: 'navigation-limit',
      detail: `navigate is limited to ${MAX_NAVIGATIONS_PER_SESSION} per session and this one has used them all — finish with the pages you have, or ask the user to open the page`,
    };
  }
  state.used += 1;
  const left = MAX_NAVIGATIONS_PER_SESSION - state.used;
  const r = await load(target.url);
  const scope = state.scope as NavigationScope;
  const redirected = r.url !== '' && r.url !== target.url;
  if (!r.ok) {
    return { error: 'load-failed', detail: r.error ?? 'the page did not load', requested: target.url, url: r.url, navigationsLeft: left };
  }
  if (r.offSite) {
    return {
      ok: true,
      requested: target.url,
      url: r.url,
      redirected,
      onSite: false,
      navigationsLeft: left,
      note: `the site sent the tab to ${r.url} — off the session's site (${r.offSite.detail ?? r.offSite.error}). The page tools and previews act only once the tab is back on the site: navigate to a page on ${describeScope(scope)}, or reload_page to return to where the session started.${r.reapplied > 0 ? '' : ' Nothing was re-applied here.'}`,
    };
  }
  return {
    ok: true,
    requested: target.url,
    url: r.url,
    ...(redirected ? { redirected: true, note: `the site redirected the request to ${r.url}` } : {}),
    onSite: true,
    ...(r.note ? { newDocument: r.note } : {}),
    ...(r.sameDocument
      ? (r.reapplied > 0
        ? { sameDocument: true, reapplied: r.reapplied, note: 'a fragment on the same page; the page had loaded a new document since your previews were last applied, so they were re-applied' }
        : { sameDocument: true, note: 'a fragment on the same page: the document stayed, and so did your previews' })
      : { reapplied: r.reapplied }),
    navigationsLeft: left,
  };
}
