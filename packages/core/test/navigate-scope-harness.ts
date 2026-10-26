// Pins navigate's scope (src/navigate-scope.ts): a shim session may send its
// page only within its start origin — same scheme, host and port — over
// http(s), with no credentials in the URL. Checked before anything loads.
//
//   node out/packages/core/test/navigate-scope-harness.js

import { navigationScopeOf, checkNavigateTarget, onScopeOrigin, describeScope, runNavigate, isSameDocumentNavigation, MAX_NAVIGATIONS_PER_SESSION, type NavigateLoad, type NavigationState } from '../src/navigate-scope';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

console.log('\n=== navigate-scope harness ===\n');

const scope = navigationScopeOf('https://www.reddit.com/r/music/?sort=new#top');
check('an https start page gives its origin', scope !== null && describeScope(scope) === 'https://www.reddit.com');
check('a non-http(s) start page gives none', navigationScopeOf('about:blank') === null && navigationScopeOf('file:///x.html') === null && navigationScopeOf('shim://library') === null);
check('a garbage or empty start gives none', navigationScopeOf('not a url') === null && navigationScopeOf('') === null && navigationScopeOf(null) === null);
const local = navigationScopeOf('http://127.0.0.1:5173/tracks');
check('the start port is part of the scope', local !== null && describeScope(local) === 'http://127.0.0.1:5173');

const ok = (raw: unknown, s = scope): string | null => { const r = checkNavigateTarget(s, raw); return r.ok ? r.url : null; };
const err = (raw: unknown, s = scope): string | null => { const r = checkNavigateTarget(s, raw); return r.ok ? null : r.error; };

console.log('within the origin:');
check('a path on the same origin', ok('https://www.reddit.com/r/music/comments/abc/') === 'https://www.reddit.com/r/music/comments/abc/');
check('a relative path resolves against the start origin', ok('/r/techno/') === 'https://www.reddit.com/r/techno/');
check('the explicit default port is the same origin', ok('https://www.reddit.com:443/x') === 'https://www.reddit.com/x');
check('host case does not matter', ok('https://WWW.Reddit.com/x') === 'https://www.reddit.com/x');
check('a query and fragment are kept', ok('https://www.reddit.com/search?q=a#b') === 'https://www.reddit.com/search?q=a#b');
check('the same port on a local origin', ok('http://127.0.0.1:5173/other', local) === 'http://127.0.0.1:5173/other');

console.log('refused:');
check('another scheme on the same host', err('http://www.reddit.com/') === 'off-origin');
check('another host', err('https://old.reddit.com/') === 'off-origin');
check('a parent domain', err('https://reddit.com/') === 'off-origin');
check('another port', err('https://www.reddit.com:8443/') === 'off-origin');
check('another port on a local origin', err('http://127.0.0.1:5174/', local) === 'off-origin');
check('a portless URL against a ported origin', err('http://127.0.0.1/', local) === 'off-origin');
check('credentials in the URL', err('https://user:pw@www.reddit.com/') === 'invalid-url' && err('https://user@www.reddit.com/') === 'invalid-url');
check('javascript:, data:, file:, shim:', ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/hosts', 'shim://library'].every((u) => err(u) === 'invalid-url'));
check('a protocol-relative URL to another host', err('//evil.example/') === 'off-origin');
check('a non-string or empty url', err(42) === 'invalid-url' && err('') === 'invalid-url' && err('   ') === 'invalid-url');
check('no scope at all', err('https://www.reddit.com/', null) === 'no-scope');

console.log('landed URLs:');
check('a landed URL on the origin', scope !== null && onScopeOrigin(scope, 'https://www.reddit.com/login'));
check('a redirect off the origin is not on it', scope !== null && !onScopeOrigin(scope, 'https://accounts.google.com/') && !onScopeOrigin(scope, 'not a url'));
check('the budget is 20 per session', MAX_NAVIGATIONS_PER_SESSION === 20);

async function tool(): Promise<void> {
  console.log('the tool:');
  const loads: string[] = [];
  const at = (result: Partial<NavigateLoad>) => async (url: string): Promise<NavigateLoad> => {
    loads.push(url);
    return { ok: true, url, offSite: null, reapplied: 2, ...result };
  };
  const state: NavigationState = { scope, used: 0 };
  const done = await runNavigate({ url: '/r/techno/' }, state, at({}));
  check('a navigation within the origin loads the canonical URL and reports it', done.ok === true && done.url === 'https://www.reddit.com/r/techno/' && done.onSite === true
    && done.reapplied === 2 && done.navigationsLeft === 19 && loads.join() === 'https://www.reddit.com/r/techno/', JSON.stringify(done));
  const refused = await runNavigate({ url: 'https://evil.example/' }, state, at({}));
  check('an off-origin request loads nothing and costs nothing', refused.error === 'off-origin' && loads.length === 1 && state.used === 1, JSON.stringify(refused));
  const redirected = await runNavigate({ url: '/a' }, state, at({ url: 'https://www.reddit.com/b' }));
  check('a redirect within the site is reported', redirected.ok === true && redirected.redirected === true && typeof redirected.note === 'string' && redirected.url === 'https://www.reddit.com/b');
  const away = await runNavigate({ url: '/login' }, state, at({ url: 'https://accounts.example/sso', offSite: { error: 'page-away', detail: 'the tab left reddit.com' }, reapplied: 0 }));
  check('a redirect off the site is contained and said plainly', away.ok === true && away.onSite === false && /back on the site/.test(String(away.note)) && !('reapplied' in away), JSON.stringify(away));
  const failed = await runNavigate({ url: '/x' }, state, at({ ok: false, error: 'the page failed to load (ERR_NAME_NOT_RESOLVED)' }));
  check('a failed load is reported, and it counted', failed.error === 'load-failed' && state.used === 4);
  const frag = await runNavigate({ url: '/r/techno/#comments' }, state, at({ sameDocument: true, reapplied: 0 }));
  check('a fragment move reports the document (and its previews) stayed', frag.ok === true && frag.sameDocument === true && !('reapplied' in frag), JSON.stringify(frag));
  const fragNew = await runNavigate({ url: '/r/techno/#more' }, state, at({ sameDocument: true, reapplied: 3 }));
  check('a fragment move on a document the previews were not yet on reports the re-applied ones', fragNew.sameDocument === true && fragNew.reapplied === 3 && /re-applied/.test(String(fragNew.note)), JSON.stringify(fragNew));
  check('same-document detection: a fragment on the same page only',
    isSameDocumentNavigation('https://a.example/p?q=1', 'https://a.example/p?q=1#x')
    && isSameDocumentNavigation('https://a.example/p#a', 'https://a.example/p#b')
    && isSameDocumentNavigation('https://a.example/p#a', 'https://a.example/p#')
    && !isSameDocumentNavigation('https://a.example/p', 'https://a.example/p')
    && !isSameDocumentNavigation('https://a.example/p', 'https://a.example/q#x')
    && !isSameDocumentNavigation('https://a.example/p?q=1', 'https://a.example/p?q=2#x'));
  state.used = MAX_NAVIGATIONS_PER_SESSION;
  const before = loads.length;
  const limit = await runNavigate({ url: '/y' }, state, at({}));
  check('the 21st navigation is refused before loading', limit.error === 'navigation-limit' && loads.length === before);
}

void tool().then(() => {
  console.log('');
  if (failures) { console.error(`${failures} navigate-scope check(s) failed`); process.exit(1); }
  console.log(`all ${passes} navigate-scope checks passed`);
});
