// Deploy identity for the §12 auto-rebase gate — a page fingerprint that is
// STABLE ACROSS ROUTES of a code-split SPA but changes on every deploy.
//
// Why this exists (found live on a real SPA): the gate originally reused the
// full script+stylesheet-set hash (computeBundleHash). That set is per-ROUTE on
// code-split apps — lazy chunks, route CSS links, and third-party tags are
// injected as you navigate — so crossing routes flipped the hash and read as a
// "deploy". A rule whose target legitimately doesn't exist on the current route
// (a login-page button, viewed from the dashboard) then hit trigger 4:
// quarantined as deploy-broken — banner noise, and with auto-repair on, a
// wasted LLM re-anchor turn against the wrong page. Route ping-pong could
// repeat it per navigation.
//
// The fix: the gate hashes only the SAME-SITE `<script src>` URLs — on
// Vite/Next-style builds that's the content-hashed entry file(s), which are
// identical on every route and rewritten on every deploy. Exactly the two
// properties the gate needs. Route CSS (stylesheets) and third-party scripts
// (analytics, support widgets — appear/disappear per route and consent) are
// excluded as route/session noise, not deploy signal.
//
// Fallback: a page with NO same-site scripts (static/MPA sites with inline-only
// JS, or an app served entirely off an unrelated CDN domain) falls back to
// hashing ALL scripts + stylesheets — the old behavior. Static MPAs don't
// lazy-inject per route (every nav is a full load), so the variance problem
// this module solves doesn't apply to them, and keeping the broad hash keeps
// their deploy gate alive.
//
// Discovery / symbol-dict keying deliberately KEEPS the per-route
// computeBundleHash — a route's symbol dict describes that route's chunk set,
// so per-route keys are correct there. Two hashes, two jobs.
//
// Pure + bare-node testable (scripts/deploy-id-harness.js); the preload only
// contributes DOM collection.

const crypto = require('crypto');

// Same last-two-labels semantics as redirect-net's trust gate — no Public
// Suffix List, imprecise for multi-part suffixes (a.co.uk vs b.co.uk read as
// the same site). Here the failure mode of a false-same is merely including a
// third-party script in the hash (possible route noise on exotic TLDs), not a
// trust decision — acceptable until the PSL-backed version lands (§15).
function sameRegistrableDomain(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const reg = (host) => host.split('.').slice(-2).join('.');
  return reg(a) === reg(b);
}

function stripVolatile(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (_) {
    return String(url).split('?')[0].split('#')[0];
  }
}

function hashUrls(urls) {
  const cleaned = [...new Set(urls.map(stripVolatile))].sort();
  if (!cleaned.length) return null;
  return crypto.createHash('sha256').update(cleaned.join('\n')).digest('hex').slice(0, 16);
}

// Only http(s) URLs carry deploy signal: `blob:` script URLs are random per
// page LOAD (hashing them would flip the id on every visit) and `data:` URLs
// are content, not a fetchable artifact.
function isHttp(u) {
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch (_) { return false; }
}

// scriptUrls / styleUrls: absolute URLs collected from the live DOM.
// pageHost: location.hostname. Returns a 16-hex hash or null (no assets at all
// → the gate can't judge, engine treats it as "no deploy detected").
function computeDeployId({ scriptUrls = [], styleUrls = [], pageHost = '' } = {}) {
  const httpScripts = scriptUrls.filter(isHttp);
  const sameSite = httpScripts.filter((u) => {
    try {
      return sameRegistrableDomain(new URL(u).hostname, pageHost);
    } catch (_) { return false; }
  });
  if (sameSite.length) return hashUrls(sameSite);
  return hashUrls([...httpScripts, ...styleUrls.filter(isHttp)]);
}

module.exports = { computeDeployId, sameRegistrableDomain };
