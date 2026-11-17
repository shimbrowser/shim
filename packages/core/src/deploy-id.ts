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

// computeDeployId over what a document has now: its `<script src>` and
// stylesheet links. Null on any failure.
function liveDeployId(doc: Document): string | null {
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

// Taken once per document, at DOMContentLoaded. The scripts the page's HTML
// declares are all in the DOM by then; what the page's own code injects later
// (a pop-up vendor, an ad or analytics loader, often different from one visit
// to the next) mostly isn't. Collected whenever a host happened to ask, two
// loads of the same deploy hashed different sets, read as a deploy, and a rule
// whose target was legitimately absent (a pop-up shown once per visit)
// quarantined. One value per document also keeps the judging and the baseline
// it refreshes the same. A page whose main bundle a loader injects after
// DOMContentLoaded is judged by what it had then (the all-assets fallback when
// that is no same-site script): a weaker gate, never a false one.
interface Snapshot { taken: boolean; id: string | null; waiting: ((id: string | null) => void)[] }
const snapshots = new WeakMap<Document, Snapshot>();

// Whether DOMContentLoaded has fired. `interactive` alone doesn't say: parsing
// is over, but the event waits for deferred and module scripts, which can
// still insert scripts the event-time set includes. The navigation timing
// entry does say, and `complete` comes only after the event.
function contentLoaded(doc: Document): boolean {
  if (doc.readyState === 'complete') return true;
  if (doc.readyState === 'loading') return false;
  try {
    const nav = doc.defaultView?.performance?.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
    return typeof nav?.domContentLoadedEventStart === 'number' && nav.domContentLoadedEventStart > 0;
  } catch (_) {
    return false;
  }
}

function take(doc: Document, entry: Snapshot): void {
  if (entry.taken) return;
  entry.id = liveDeployId(doc);
  entry.taken = true;
  for (const fn of entry.waiting.splice(0)) {
    try { fn(entry.id); } catch (_) { /* one listener can't cost the others */ }
  }
}

function snapshotOf(doc: Document): Snapshot {
  const seen = snapshots.get(doc);
  if (seen) {
    // The listener can miss the event (a page listener before ours stopped
    // it): once it has fired, take the id at the first ask.
    if (!seen.taken && contentLoaded(doc)) take(doc, seen);
    return seen;
  }
  const entry: Snapshot = { taken: false, id: null, waiting: [] };
  snapshots.set(doc, entry);
  if (contentLoaded(doc)) take(doc, entry);
  else doc.addEventListener('DOMContentLoaded', () => { take(doc, entry); }, { once: true });
  return entry;
}

/**
 * Starts the watch that takes `doc`'s deploy id at DOMContentLoaded. Every
 * host calls it as its runtime starts in a document (document start, where it
 * can), since a first ask after the page has injected more scripts can only
 * take what is there by then. `onTaken` hears the id once it is taken (at
 * once when it already is): a host whose engine runs elsewhere hands it on.
 */
function watchDeployId(doc: Document, onTaken?: (id: string | null) => void): void {
  try {
    const snap = snapshotOf(doc);
    if (!onTaken) return;
    if (snap.taken) onTaken(snap.id);
    else snap.waiting.push(onTaken);
  } catch (_) { /* the gate then reads "no deploy detected" */ }
}

// The deploy identity of a live document, the one every host gates rebase on
// (the Shim browser's page-preload and shim world, a headless driver's page
// runtime, Shim for Chrome), so they can't disagree about what a deploy is:
// computeDeployId over the `<script src>` and stylesheet links it had at
// DOMContentLoaded. Null before then (the gate can't judge a half-parsed page)
// and on any failure: the gate then reads "no deploy detected".
function deployIdForDocument(doc: Document): string | null {
  try {
    const snap = snapshotOf(doc);
    return snap.taken ? snap.id : null;
  } catch (_) {
    return null;
  }
}

// --- Per-page-kind baselines --------------------------------------------
//
// The deploy id above is route-stable on a code-split SPA (one content-hashed
// entry on every route), but NOT on a multi-page site whose page types each
// load their own same-site bundle. Found live on Google: the homepage loads
// `/xjs/_/js/k=xjs.hd.…/m=<home modules>` and /search loads
// `/xjs/_/js/k=xjs.s.…/m=<search modules>` — same deploy, different ids. With
// one baseline per shim, every crossing between the two page types read as a
// deploy: rules legitimately absent from the other page ran the deploy-only
// recovery scans and emitted `rule-quarantined`, and the baseline flip-flopped
// on every navigation.
//
// So a baseline is only ever compared against the id of the SAME KIND of page:
// the host keeps one baseline per `pagePathKey`, and a page kind with no
// baseline yet can't judge a deploy (a miss stays a transient no-match — the
// first clean resolve there records one). On an SPA every key converges on the
// same id, so nothing is lost there.
//
// `pagePathKey` is coarse on purpose — /projects/123/estimates and
// /projects/456 share a key: lowercase, query/hash stripped, duplicate slashes
// collapsed, id-ish segments starred, two segments kept. The page-memory
// escalation gate keys on the same function, so "a page kind" means one thing
// to both gates.
function isIdishSegment(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true; // all digits
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(segment)) return true; // uuid
  if (/^[0-9a-f]{16,}$/.test(segment)) return true; // long pure hex (tokens, content hashes)
  if (segment.length > 24) return true; // slugs-with-ids, opaque blobs
  return false;
}

// `pathname` is `unknown`: callers hand it values straight off IPC payloads.
// Garbage in → '/'.
function pagePathKey(pathname: unknown): string {
  if (typeof pathname !== 'string' || pathname === '') return '/';
  let p = must(pathname.split(/[?#]/)[0], 'pathname split').toLowerCase();
  p = p.replace(/\/{2,}/g, '/');
  const segments = p
    .split('/')
    .filter(Boolean)
    .map((seg) => (isIdishSegment(seg) ? '*' : seg))
    .slice(0, 2);
  return '/' + segments.join('/');
}

// The baseline a document on `pathname` is gated against: the one recorded for
// its page kind, or null (no baseline → the engine detects no deploy).
function baselineForPath(baselines: Record<string, string> | null | undefined, pathname: unknown): string | null {
  if (!baselines || typeof baselines !== 'object') return null;
  const key = pagePathKey(pathname);
  const hit = Object.prototype.hasOwnProperty.call(baselines, key) ? baselines[key] : undefined;
  return typeof hit === 'string' && hit ? hit : null;
}

export { computeDeployId, deployIdForDocument, watchDeployId, sameRegistrableDomain, pagePathKey, baselineForPath };
