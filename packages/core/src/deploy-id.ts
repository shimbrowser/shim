// Deploy identity for the auto-rebase deploy gate — a page fingerprint that is
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
// Pure + bare-node testable (packages/core/test/deploy-id-harness.ts); the preload only
// contributes DOM collection. No Node builtins: the hash is the
// pure-JS ./sha256, pinned to Node crypto's output by sha256-harness.

import { must } from './assert';
import { sha256Hex } from './sha256';

// Same last-two-labels semantics as redirect-net's trust gate — no Public
// Suffix List, imprecise for multi-part suffixes (a.co.uk vs b.co.uk read as
// the same site). Here the failure mode of a false-same is merely including a
// third-party script in the hash (possible route noise on exotic TLDs), not a
// trust decision — acceptable until the PSL-backed version lands.
function sameRegistrableDomain(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const reg = (host: string) => host.split('.').slice(-2).join('.');
  return reg(a) === reg(b);
}

function stripVolatile(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (_) {
    // String.split always returns ≥1 element, so index 0 is provably safe.
    const beforeQuery = must(String(url).split('?')[0], 'stripVolatile: url before ?');
    return must(beforeQuery.split('#')[0], 'stripVolatile: url before #');
  }
}

function hashUrls(urls: string[]): string | null {
  const cleaned = [...new Set(urls.map(stripVolatile))].sort();
  if (!cleaned.length) return null;
  // Pure-JS sha256 (./sha256), byte-identical to Node's crypto digest, so
  // ids minted before the engine dropped Node still compare equal.
  return sha256Hex(cleaned.join('\n')).slice(0, 16);
}

// Only http(s) URLs carry deploy signal: `blob:` script URLs are random per
// page LOAD (hashing them would flip the id on every visit) and `data:` URLs
// are content, not a fetchable artifact.
function isHttp(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch (_) { return false; }
}

// scriptUrls / styleUrls: absolute URLs collected from the live DOM.
// pageHost: location.hostname. Returns a 16-hex hash or null (no assets at all
// → the gate can't judge, engine treats it as "no deploy detected").
function computeDeployId(
  { scriptUrls = [], styleUrls = [], pageHost = '' }:
    { scriptUrls?: string[]; styleUrls?: string[]; pageHost?: string } = {},
): string | null {
  const httpScripts = scriptUrls.filter(isHttp);
  const sameSite = httpScripts.filter((u) => {
    try {
      return sameRegistrableDomain(new URL(u).hostname, pageHost);
    } catch (_) { return false; }
  });
  if (sameSite.length) return hashUrls(sameSite);
  return hashUrls([...httpScripts, ...styleUrls.filter(isHttp)]);
}

// The deploy identity of a live document: computeDeployId over its
// `<script src>` and stylesheet links. Every host gates rebase on this one
// collection (the Shim browser's page-preload and a headless driver's page
// runtime), so the two can't disagree about what a deploy is. Null on any
// failure — the gate then reads "no deploy detected".
function deployIdForDocument(doc: Document): string | null {
  try {
    const scriptUrls: string[] = [];
    for (const s of doc.querySelectorAll<HTMLScriptElement>('script[src]')) {
      if (s.src) scriptUrls.push(s.src);
    }
    const styleUrls: string[] = [];
    for (const l of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')) {
      if (l.href) styleUrls.push(l.href);
    }
    return computeDeployId({ scriptUrls, styleUrls, pageHost: doc.location ? doc.location.hostname : '' });
  } catch (_) {
    return null;
  }
}

export { computeDeployId, deployIdForDocument, sameRegistrableDomain };
