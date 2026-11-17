// Diagnostic harness for the deploy-identity hash (packages/core/src/deploy-id.js)
// — the auto-rebase deploy gate's ROUTE-STABLE page fingerprint. Bare node. Run
// when touching the gate's identity logic:
//
//   node out/packages/core/test/deploy-id-harness.js
//
// The invariant under test: navigating between routes of a code-split SPA must
// NOT change the id (lazy chunks / route CSS / third-party tags are noise), but
// a deploy (content-hashed entry filename rewritten) MUST change it.

import { computeDeployId, deployIdForDocument, watchDeployId, sameRegistrableDomain, pagePathKey, baselineForPath } from '../src/deploy-id';
import { makeReconciler } from '../src/rule-reconcile';
import { makeRuleState } from '../src/rule-state';
import type { RuntimeSpec } from '../src/engine-internal';
import type { CoreApi } from '../src/api';
import type { Rule } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

const HOST = 'app.example.com';
const ENTRY = 'https://app.example.com/assets/index-C18nbkrQ.js';

function tRouteStability() {
  console.log('route stability (the SPA false-deploy fix):');
  const login = computeDeployId({
    scriptUrls: [ENTRY, 'https://widget.intercom.io/widget/abc.js'],
    styleUrls: ['https://app.example.com/assets/index-CZBby6Zt.css'],
    pageHost: HOST,
  });
  const dashboard = computeDeployId({
    scriptUrls: [ENTRY, 'https://js.sentry-cdn.com/xyz.min.js'],
    styleUrls: [
      'https://app.example.com/assets/index-CZBby6Zt.css',
      'https://app.example.com/assets/dashboard-Bq2w.css', // lazy route CSS
    ],
    pageHost: HOST,
  });
  check('login vs dashboard (route CSS + 3p churn) → SAME id', login === dashboard, `${login} vs ${dashboard}`);

  const deployed = computeDeployId({
    scriptUrls: ['https://app.example.com/assets/index-Xy9kPq2w.js'],
    styleUrls: ['https://app.example.com/assets/index-CZBby6Zt.css'],
    pageHost: HOST,
  });
  check('entry filename rewritten → DIFFERENT id (deploy)', login !== deployed, `${login} vs ${deployed}`);

  // CDN subdomain serving the app bundle counts as same-site.
  const cdn = computeDeployId({
    scriptUrls: ['https://static.example.com/assets/index-C18nbkrQ.js', 'https://cdn.thirdparty.net/lib.js'],
    pageHost: HOST,
  });
  const cdnOnlyEntry = computeDeployId({
    scriptUrls: ['https://static.example.com/assets/index-C18nbkrQ.js'],
    pageHost: HOST,
  });
  check('CDN-subdomain entry is same-site; 3p excluded', cdn === cdnOnlyEntry, `${cdn} vs ${cdnOnlyEntry}`);

  // Query strings (cache busters) are stripped.
  const busted = computeDeployId({ scriptUrls: [ENTRY + '?v=123'], pageHost: HOST });
  const plain = computeDeployId({ scriptUrls: [ENTRY], pageHost: HOST });
  check('query strings stripped', busted === plain, `${busted} vs ${plain}`);
}

function tFallback() {
  console.log('static-site fallback (no same-site scripts):');
  // Static MPA: only a cross-site lib + local CSS → falls back to hashing all
  // assets, so its deploy gate stays alive (MPAs don't lazy-inject per route).
  const a = computeDeployId({
    scriptUrls: ['https://cdn.jquery.com/jquery.min.js'],
    styleUrls: ['https://legacy.example.org/site-v1.css'],
    pageHost: 'legacy.example.org',
  });
  const b = computeDeployId({
    scriptUrls: ['https://cdn.jquery.com/jquery.min.js'],
    styleUrls: ['https://legacy.example.org/site-v2.css'], // css revved → deploy
    pageHost: 'legacy.example.org',
  });
  check('fallback hashes all assets', typeof a === 'string' && a.length === 16, String(a));
  check('fallback still detects a deploy (css revved)', a !== b, `${a} vs ${b}`);
  check('no assets at all → null (gate abstains)', computeDeployId({ pageHost: 'x.com' }) === null, '');
  check('non-http script ignored', computeDeployId({ scriptUrls: ['data:text/javascript,1'], pageHost: 'x.com' }) === null, '');
}

function tRegistrable() {
  console.log('sameRegistrableDomain:');
  check('subdomains match', sameRegistrableDomain('static.example.com', 'app.example.com'), '');
  check('different domains do not', !sameRegistrableDomain('example.com', 'other.com'), '');
  // Deliberately violates the declared `string` param to exercise the
  // runtime falsy-guard (`if (!a || !b) return false`) — the signature says
  // `string` but the implementation is defensive against bad callers.
  check('null-safe', !sameRegistrableDomain(null as unknown as string, 'x.com'), '');
}

console.log('\n=== deploy-id harness ===\n');
// Multi-page sites load a different same-site bundle per page type — one deploy,
// several ids. Live-caught on Google (2026-10-20): a rule anchored `#search`
// (results page only) logged "recovery failed → quarantine" on the homepage,
// because the shim's one baseline came from /search. The fix keeps one
// baseline per page kind and gates a document only against its own kind's.
const GOOGLE = 'www.google.com';
const homeId = computeDeployId({
  scriptUrls: [
    'https://www.google.com/xjs/_/js/k=xjs.hd.en.oEtejGMorkw.2023.O/am=AAAA/d=1/ed=1/m=cdos,hsm,jsa,mb4ZUb,d,csi?cb=121509378',
    'https://www.gstatic.com/og/_/js/k=og.asy.en_US.lLriHBky4GQ.2019.O/rt=j/m=_ac,_awd',
  ],
  pageHost: GOOGLE,
});
const searchId = computeDeployId({
  scriptUrls: [
    'https://www.google.com/xjs/_/js/k=xjs.s.en.oEtejGMorkw.2023.O/am=AAAB/d=1/ed=1/m=cdos,hsm,jsa,aLUfP,d,csi',
    'https://www.gstatic.com/og/_/js/k=og.asy.en_US.lLriHBky4GQ.2019.O/rt=j/m=_ac,_awd',
  ],
  pageHost: GOOGLE,
});

function tPerPageKind() {
  console.log('per-page-kind baselines (the multi-page false-deploy fix):');
  check('google home vs /search load different same-site bundles → different ids (one deploy)', !!homeId && !!searchId && homeId !== searchId, `${homeId} vs ${searchId}`);
  check('pagePathKey: / and /search are different kinds', pagePathKey('/') !== pagePathKey('/search'), '');
  check('pagePathKey: query/hash stripped, ids starred, two segments', pagePathKey('/Projects/123/estimates?x=1#y') === '/projects/*', pagePathKey('/Projects/123/estimates?x=1#y'));
  check('pagePathKey: garbage → /', pagePathKey(null) === '/' && pagePathKey(42) === '/', '');
  const baselines = { '/search': searchId as string };
  check('baselineForPath picks the page kind\'s own baseline', baselineForPath(baselines, '/search') === searchId, '');
  check('baselineForPath: an unrecorded page kind has none', baselineForPath(baselines, '/') === null, '');
  check('baselineForPath: no map → none', baselineForPath(undefined, '/search') === null, '');
  check('baselineForPath: inherited keys never count', baselineForPath({}, '/constructor') === null && baselineForPath(baselines, '/__proto__') === null, '');
}

// End to end through the reconciler: a rule that resolves nothing on the
// homepage. Gated against the homepage's own (absent) baseline it stays a
// transient no-match; a real deploy on /search, gated against /search's
// baseline, still reaches recovery → quarantine.
function reconcileMiss(baseline: string | null, current: string): Promise<string[]> {
  return new Promise((resolve) => {
    const kinds: string[] = [];
    (globalThis as unknown as { document: unknown }).document = { getElementsByTagName: (): unknown[] => [] };
    const api = { reportEvent: (kind: string) => { kinds.push(kind); } } as unknown as CoreApi;
    const rule: Rule = {
      id: 'blocklist-controller',
      anchor: { primary: { kind: 'css', value: '#search' }, witness: { v: 1, tag: 'div', attrs: { id: 'search' }, parentTag: 'div' } },
      mutations: [{ kind: 'script', handler: 'h' }],
    };
    const spec = { id: 's', rules: [rule], __bundleHashFn: () => current, ...(baseline ? { bundleHash: baseline } : {}) } as RuntimeSpec;
    const r = makeReconciler(rule, spec, api, makeRuleState(), new Set());
    r.start();
    setTimeout(() => { r.stop(); resolve(kinds); }, 4500);
  });
}

async function tReconcileGate() {
  console.log('reconciler behind a per-page-kind baseline:');
  // The bug, pinned: gated against the shim-wide baseline /search recorded, the
  // homepage reads as a deploy and the miss escalates.
  const shimWide = await reconcileMiss(searchId as string, homeId as string);
  check('(the bug) a shim-wide /search baseline quarantines the homepage miss', shimWide.includes('rule-quarantined'), JSON.stringify(shimWide));
  const baselines = { '/search': searchId as string };
  const home = await reconcileMiss(baselineForPath(baselines, '/'), homeId as string);
  check('homepage miss (no homepage baseline) → transient no-match, no quarantine', home.includes('rule-no-match') && !home.includes('rule-quarantined'), JSON.stringify(home));
  const deployed = await reconcileMiss(baselineForPath(baselines, '/search?q=x'), 'deadbeefdeadbeef');
  check('a real deploy on /search still quarantines', deployed.includes('rule-quarantined'), JSON.stringify(deployed));
}

// A fake document: its scripts can grow, its readyState can move, and it fires
// DOMContentLoaded to whoever listens.
function fakeDocument(initial: string[], readyState: 'loading' | 'interactive' | 'complete' = 'loading') {
  const scripts = [...initial];
  const listeners: (() => void)[] = [];
  const doc = {
    readyState: readyState as string,
    location: { hostname: 'www.allrecipes.com' },
    querySelectorAll: (sel: string) => (sel.startsWith('script') ? scripts.map((src) => ({ src })) : []),
    addEventListener: (type: string, fn: () => void) => { if (type === 'DOMContentLoaded') listeners.push(fn); },
  };
  return {
    doc: doc as unknown as Document,
    add: (src: string) => { scripts.push(src); },
    contentLoaded: () => { doc.readyState = 'interactive'; for (const fn of listeners.splice(0)) fn(); },
    parsed: () => { doc.readyState = 'interactive'; },
    complete: () => { doc.readyState = 'complete'; },
  };
}

function tDomContentLoaded() {
  console.log('taken at DOMContentLoaded (late-injected scripts are not a deploy):');
  const APP = 'https://www.allrecipes.com/static/5.189.0/cache/app.js';
  const LATE = ['https://forms.allrecipes.com/main.js', 'https://www.allrecipes.com/ayAnalytics.js'];
  const quiet = fakeDocument([APP]);
  watchDeployId(quiet.doc);
  check('before DOMContentLoaded the gate can\'t judge (null)', deployIdForDocument(quiet.doc) === null, '');
  quiet.contentLoaded();
  const quietId = deployIdForDocument(quiet.doc);
  const busy = fakeDocument([APP]);
  watchDeployId(busy.doc);
  busy.contentLoaded();
  for (const src of LATE) busy.add(src);
  const busyId = deployIdForDocument(busy.doc);
  check('a load whose page later injects same-site scripts has the quiet load\'s id', quietId !== null && busyId === quietId, `${quietId} vs ${busyId}`);
  busy.add('https://www.allrecipes.com/more.js');
  check('…and keeps it for the document\'s life', deployIdForDocument(busy.doc) === quietId, '');
  const deployed = fakeDocument(['https://www.allrecipes.com/static/5.190.0/cache/app.js']);
  watchDeployId(deployed.doc);
  deployed.contentLoaded();
  check('a new entry bundle at DOMContentLoaded is still a deploy', deployIdForDocument(deployed.doc) !== quietId, '');
  // Parsed, but DOMContentLoaded still waits on a deferred script, which
  // inserts another same-site script: the event-time set includes it.
  const deferred = fakeDocument([APP]);
  watchDeployId(deferred.doc);
  deferred.parsed();
  check('parsed but before DOMContentLoaded the gate still can\'t judge', deployIdForDocument(deferred.doc) === null, '');
  deferred.add('https://www.allrecipes.com/deferred-loader.js');
  deferred.contentLoaded();
  const withDeferred = fakeDocument([APP, 'https://www.allrecipes.com/deferred-loader.js']);
  watchDeployId(withDeferred.doc);
  withDeferred.contentLoaded();
  check('…and the id is the event-time set, deferred insertions included', deployIdForDocument(deferred.doc) === deployIdForDocument(withDeferred.doc) && deployIdForDocument(deferred.doc) !== quietId, '');
  const firstInteractive = fakeDocument([APP], 'interactive');
  check('a document first seen parsed, with no sign the event fired, waits for it', deployIdForDocument(firstInteractive.doc) === null, '');
  firstInteractive.contentLoaded();
  check('…and takes it at the event', deployIdForDocument(firstInteractive.doc) === quietId, '');
  const missed = fakeDocument([APP]);
  watchDeployId(missed.doc);
  missed.complete();
  check('an event the watch never heard is taken at the first ask once the document is complete', deployIdForDocument(missed.doc) === quietId, '');
  const late = fakeDocument([APP], 'complete');
  check('a document first seen complete is taken then', deployIdForDocument(late.doc) === quietId, '');
  const heard: (string | null)[] = [];
  const handed = fakeDocument([APP]);
  watchDeployId(handed.doc, (id) => { heard.push(id); });
  check('a listener hears nothing before the event', heard.length === 0, '');
  handed.contentLoaded();
  watchDeployId(handed.doc, (id) => { heard.push(id); });
  check('…then hears the id once, and a later one at once', heard.length === 2 && heard.every((id) => id === quietId), JSON.stringify(heard));
}

tDomContentLoaded();
tRouteStability();
tFallback();
tRegistrable();
tPerPageKind();
console.log('');
void tReconcileGate().then(() => {
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log('all deploy-id checks passed');
});
