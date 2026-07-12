// Diagnostic harness for the deploy-identity hash (src/patch-engine/deploy-id.js)
// — the §12 auto-rebase gate's ROUTE-STABLE page fingerprint. Bare node. Run
// when touching the gate's identity logic:
//
//   node scripts/deploy-id-harness.js
//
// The invariant under test: navigating between routes of a code-split SPA must
// NOT change the id (lazy chunks / route CSS / third-party tags are noise), but
// a deploy (content-hashed entry filename rewritten) MUST change it.

import { computeDeployId, sameRegistrableDomain } from '../src/patch-engine/deploy-id';

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
tRouteStability();
tFallback();
tRegistrable();
console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all deploy-id checks passed');
