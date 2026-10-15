// A rule carrying a `mount-route` mutation registers a virtual route: a URL
// path pattern (`/budgets`, `/budgets/:id`) plus a handler that renders the
// page for matching navigations. Two entry paths converge here:
//
//   - Soft nav: the user clicks an <a> whose path matches, or back/forward
//     lands on a matching path. We intercept clicks (preventDefault +
//     history.pushState) and listen for popstate. No server round-trip.
//   - Hard load: the user types the URL or reloads. Main serves a same-origin
//     local shell for registered routes (the Shim browser's
//     route protocol), so the document loads at the real URL with the
//     site's session intact; the engine boots and `evaluate()` sees the path
//     already matches.
//
// Both reduce to one question — does `location.pathname` match the pattern? —
// so mounting is identical regardless of how the path was reached. The page
// itself is mounted at `document.body` and the site's own body children are
// hidden, reusing the Tier-4 `replace-root` token machinery.

import * as routeMatch from './route-match';
import { routeTransition } from './route-transition';
import { createRouteScrollStore } from './route-scroll';
import {
  injectReplaceRootRule, removeReplaceRootRule, injectRouteEnvRule, removeRouteEnvRule,
  tagReplaceRootAnchor, stripReplaceRootToken, tagMountedNode,
} from './css-sheets';
import { normalizeOutputs, trimStackForEvent } from './engine-internal';
import type { HandlerMap } from './engine-internal';
import type { Rule, Spec } from './types';
import type { CoreApi, CoreRouteMountApi, HostApiMembers, RouteMatch } from './api';
import { errMessage } from './error';

// routeRule's single mounted-route record — see mountRoute/unmountRoute.
interface MountedRoute {
  outputs: HTMLElement[];
  cleanups: Array<() => void>;
  path: string;
  prevTitle: string;
}

// --- virtual-route scroll restoration -------------------------------
// Page-global: window scroll + history are shared across all route rules, so a
// single store + one ref-counted scroll listener serve them all. We never touch
// history.scrollRestoration (that would change the HOST site's own scroll
// behavior); we only save/restore for entries a route is mounted on, and the
// listener is active only while a route is mounted, so site-only history entries
// are never stamped with a key.
const routeScroll = createRouteScrollStore();
let routeScrollRefs = 0;
let routeScrollFrame = 0;

// Resolve (and, if newly minted, attach via replaceState) the scroll key for
// the CURRENT history entry. Only ever called while a route is mounted.
function currentRouteScrollKey(): string {
  const { key, attach } = routeScroll.resolveKey(history.state);
  if (attach) {
    try { history.replaceState(attach.state, ''); } catch { /* detached */ }
  }
  return key;
}

function recordRouteScroll(): void {
  try { routeScroll.record(currentRouteScrollKey(), window.scrollY); } catch { /* detached */ }
}

function onRouteScroll(): void {
  if (routeScrollFrame) return; // coalesce a scroll storm to one record per frame
  routeScrollFrame = requestAnimationFrame(() => { routeScrollFrame = 0; recordRouteScroll(); });
}

function attachRouteScroll(): void {
  if (routeScrollRefs++ === 0) window.addEventListener('scroll', onRouteScroll, { passive: true });
}

function detachRouteScroll(): void {
  if (--routeScrollRefs <= 0) {
    routeScrollRefs = 0;
    window.removeEventListener('scroll', onRouteScroll);
    if (routeScrollFrame) { cancelAnimationFrame(routeScrollFrame); routeScrollFrame = 0; }
  }
}

// Apply the current entry's saved scroll (or top), on a rAF so the DOM has
// settled. restoreOnly=true (in-place update) applies ONLY for an entry we've
// already saved — so a FORWARD in-place nav to a fresh entry leaves the shell's
// scroll untouched (preserving #275's no-scroll-on-update contract). mount uses
// restoreOnly=false: fresh entry → target 0 → top; seen entry → restore.
function applyRouteScroll(restoreOnly: boolean): void {
  const key = currentRouteScrollKey();
  if (restoreOnly && !routeScroll.has(key)) return;
  const target = routeScroll.targetFor(key);
  requestAnimationFrame(() => {
    try { window.scrollTo(0, target); } catch { /* jsdom / detached */ }
  });
}

// `handlers` are already-compiled functions for this rule (bag handlers with
// the rule's own inline handlers on top — setupRule in engine.ts merges them;
// the host compiles, the engine never does).
export function routeRule(rule: Rule, spec: Spec, api: CoreApi, handlers: HandlerMap): () => void {
  const mut = (rule.mutations || []).find((m) => m.kind === 'mount-route');
  if (!mut || !mut.pattern) {
    console.warn('[shim] mount-route rule missing `pattern`');
    return () => {};
  }

  const reportHandlerError = (err: unknown) => {
    if (typeof api.reportEvent !== 'function') return;
    api.reportEvent('handler-error', {
      specId: spec.id,
      handlerName: mut.handler || '(anonymous)',
      ruleId: rule.id,
      message: errMessage(err),
      stack: trimStackForEvent(err instanceof Error ? err.stack || '' : ''),
    });
  };

  const handlerName = typeof mut.handler === 'string' ? mut.handler : '';
  const handlerFn = handlers[handlerName];
  if (!handlerFn) {
    console.warn(`[shim] mount-route: unknown handler "${mut.handler}"`);
    reportHandlerError(new Error(`unknown handler "${mut.handler}" — the rule references a handler name that wasn't compiled with this shim`));
    return () => {};
  }

  const match = routeMatch.matcher(mut.pattern);
  const token = `shim-${spec.id}-${rule.id}-mount-route`;

  let lastReportedMatched = -1;
  const reportStatus = (matched: number) => {
    if (matched === lastReportedMatched) return;
    lastReportedMatched = matched;
    if (typeof api.reportEvent !== 'function') return;
    api.reportEvent('rule-status', {
      specId: spec.id,
      ruleId: rule.id,
      matched,
      matchedVia: matched ? 'route' : null,
    });
  };

  // { outputs, cleanups, path } while a route is mounted; null when the
  // current path doesn't match.
  let mounted: MountedRoute | null = null;

  // Handlers opt into in-place inner-route updates by registering onRouteChange
  // callbacks (nested sub-routes): each is called on a same-route path change
  // with the new match, keeping the shell mounted. A callback may return a
  // teardown fn — run before its NEXT call and on final unmount (per-inner-view
  // cleanup). No callback registered → a param change remounts, exactly as before.
  const routeChangeCbs: Array<(match: RouteMatch) => void | (() => void)> = [];
  const routeChangeTeardowns = new Map<(match: RouteMatch) => void | (() => void), () => void>();

  // A `const` arrow (not a hoisted `function` declaration): TS's narrowing of
  // `mut` from the guard above doesn't survive into a hoisted function body (it
  // could in principle run before the narrowing check), but does survive into a
  // `const`-bound closure defined after it — which this always is.
  const mountRoute = (m: { params: Record<string, string | undefined> }) => {
    // A prior mount attempt on this rule may have registered onRouteChange
    // callbacks and then thrown before `mounted` was ever set — in that case
    // unmountRoute() never ran (it early-returns when !mounted) and the
    // registry would otherwise leak into this mount. Reset unconditionally; on
    // the normal remount path unmountRoute already cleared it, so this is a
    // no-op there.
    routeChangeCbs.length = 0;
    routeChangeTeardowns.clear();
    const cleanups: Array<() => void> = [];
    const mountApi: CoreRouteMountApi = Object.assign(Object.create(api) as CoreApi & HostApiMembers, {
      cleanup(fn: () => void) { if (typeof fn === 'function') cleanups.push(fn); },
      onRouteChange(cb: (match: RouteMatch) => void | (() => void)) {
        if (typeof cb === 'function') routeChangeCbs.push(cb);
      },
    });
    let outputs: Node[];
    try {
      const raw = handlerFn({
        match: { path: routeMatch.normalizePath(location.pathname), params: m.params },
        mutation: mut,
        rule,
        spec,
        api: mountApi,
      });
      outputs = normalizeOutputs(raw);
    } catch (err) {
      console.error('[shim] mount-route handler failed', err);
      reportHandlerError(err);
      return;
    }
    const body = document.body;
    if (!body) return;
    injectReplaceRootRule(token);
    injectRouteEnvRule(token);
    tagReplaceRootAnchor(body, token);
    // The page mounts inside a shadow root so soft nav and hard load render
    // IDENTICALLY. The two paths live in different CSS universes — soft nav
    // keeps the site's stylesheets loaded, hard load is a bare shell — and
    // without isolation the same handler output looks different per path (site
    // h1 sizing, fonts, even site-targeting Tier-1 rules leak in). `all:
    // initial` severs inherited properties (font, color) from the host document
    // for the same reason. Route pages are self-contained by contract: they
    // style themselves via inline styles or their own <style>.
    const host = document.createElement('div');
    host.setAttribute('data-shim', 'route-host');
    tagMountedNode(host, token);
    const shadow = host.attachShadow({ mode: 'open' });
    const base = document.createElement('style');
    base.textContent = ':host { all: initial; display: block; }';
    shadow.appendChild(base);
    for (const n of outputs) shadow.appendChild(n);
    body.appendChild(host);
    // Tab title: the hard-load shell has an empty <title> and on soft nav the
    // site's own title would linger. `mutation.title` declares the route's; the
    // previous value is restored on unmount either way (handlers that set
    // document.title themselves are unwound by the same restore).
    const prevTitle = document.title;
    if (typeof mut.title === 'string') document.title = mut.title;
    // Match real-navigation behavior: a fresh route view starts at the top; a
    // back/forward return to a previously-scrolled route restores its position.
    applyRouteScroll(false);
    mounted = { outputs: [host], cleanups, path: routeMatch.normalizePath(location.pathname), prevTitle };
    attachRouteScroll();
    reportStatus(1);
  };

  // In-place inner navigation: the shell stays mounted, each onRouteChange
  // callback is re-run with the new match. A const arrow (not hoisted fn) so
  // `mut`'s narrowing survives, same reason mountRoute is one. Never scrolls or
  // re-applies mut.title — the handler owns inner scroll/title.
  const updateRoute = (m: { params: Record<string, string | undefined> }) => {
    if (!mounted) return;
    const here = routeMatch.normalizePath(location.pathname);
    const nextMatch: RouteMatch = { path: here, params: m.params };
    for (const cb of routeChangeCbs) {
      const prev = routeChangeTeardowns.get(cb);
      if (prev) {
        routeChangeTeardowns.delete(cb);
        try { prev(); } catch (err) { console.error('[shim] route onRouteChange teardown failed', err); }
      }
      try {
        const t = cb(nextMatch);
        if (typeof t === 'function') routeChangeTeardowns.set(cb, t);
      } catch (err) {
        console.error('[shim] route onRouteChange callback failed', err);
        reportHandlerError(err);
      }
    }
    mounted.path = here;
    // Restore scroll on a BACK/FORWARD return to a seen entry; a forward
    // in-place nav (fresh entry) stays scroll-neutral (the in-place nav contract).
    applyRouteScroll(true);
  };

  function unmountRoute() {
    if (!mounted) return;
    // Captured once so the narrowed (non-null) type survives the cleanup calls
    // below — TS conservatively widens a re-checked `let` back to `MountedRoute
    // | null` across an intervening function call.
    const entry = mounted;
    // Per-inner-view teardowns (onRouteChange) run before the shell cleanups,
    // then the registry is cleared so a later remount starts fresh.
    for (const t of routeChangeTeardowns.values()) {
      try { t(); } catch (err) { console.error('[shim] route onRouteChange teardown failed', err); }
    }
    routeChangeTeardowns.clear();
    routeChangeCbs.length = 0;
    for (const fn of entry.cleanups) {
      try { fn(); } catch (err) { console.error('[shim] route cleanup failed', err); }
    }
    for (const node of entry.outputs) node.remove();
    if (document.body) stripReplaceRootToken(document.body, token);
    removeReplaceRootRule(token);
    removeRouteEnvRule(token);
    document.title = entry.prevTitle;
    detachRouteScroll();
    mounted = null;
    reportStatus(0);
  }

  // The single source of truth: reconcile mounted-state against the current
  // path. Called on init (covers hard load), on every click we intercept, and
  // on popstate (back/forward). A path that still matches but changed params
  // (`/budgets/1` → `/budgets/2`) re-mounts so the handler re-renders with the
  // new params.
  function evaluate() {
    const here = routeMatch.normalizePath(location.pathname);
    const m = match(here);
    const decision = routeTransition(mounted ? mounted.path : null, here, !!m, routeChangeCbs.length > 0);
    if (decision === 'mount') { if (mounted) unmountRoute(); if (m) mountRoute(m); } // remount when already mounted
    else if (decision === 'unmount') unmountRoute();
    else if (decision === 'update') { if (m) updateRoute(m); }
    // 'noop' → nothing
  }

  function onClick(e: MouseEvent) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let the browser open new tab/window
    // composedPath()[0], not e.target: clicks inside the route page's shadow
    // root retarget to the host element at the document level, which would hide
    // the actual <a>. composedPath sees through the shadow boundary, so
    // route-to-route links inside a mounted page keep getting intercepted.
    const rawTarget: EventTarget | null = e.composedPath ? (e.composedPath()[0] ?? null) : e.target;
    // A click's target is always a DOM Node in practice (Element or a text node
    // inside one); `EventTarget` itself is too generic to carry
    // `.parentElement`, so this narrows to the realistic domain rather than
    // assuming every EventTarget is Element-shaped.
    const el = rawTarget instanceof Element
      ? rawTarget
      : rawTarget instanceof Node
        ? rawTarget.parentElement
        : null;
    // `closest('a[href]')` can't be typed to a specific tag from a runtime
    // attribute selector string — it's provably an <a> or null at runtime.
    const a = el?.closest?.('a[href]') as HTMLAnchorElement | null | undefined;
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    let url: URL;
    try { url = new URL(a.href, location.href); } catch { return; }
    if (url.origin !== location.origin) return; // external link — real navigation
    if (!match(routeMatch.normalizePath(url.pathname))) return; // not one of our routes
    e.preventDefault();
    if (url.href !== location.href) {
      if (mounted) recordRouteScroll(); // save the outgoing route entry's scroll before we leave it
      history.pushState({}, '', url.pathname + url.search + url.hash);
    }
    evaluate();
  }

  function onPopState() { evaluate(); }
  // bfcache restores can land a frozen document on a different history entry
  // WITHOUT firing popstate (only pageshow with persisted=true). Re-evaluate so
  // a doc frozen on /notes and restored on / unmounts, and vice versa.
  function onPageShow(e: PageTransitionEvent) { if (e.persisted) evaluate(); }

  // Light self-heal: if a framework re-render detaches our mounted root while
  // the route is still active, re-attach it. The replace-root CSS keeps the
  // site's own (re-rendered) body children hidden on its own, so this only has
  // to worry about our own node going missing.
  let healHandle = 0;
  const observer = new MutationObserver(() => {
    if (!mounted || healHandle) return;
    healHandle = requestAnimationFrame(() => {
      healHandle = 0;
      if (!mounted || !document.body) return;
      tagReplaceRootAnchor(document.body, token);
      for (const n of mounted.outputs) {
        if (!document.contains(n)) document.body.appendChild(n);
      }
    });
  });

  document.addEventListener('click', onClick, true); // capture, so we beat the site's own handlers
  window.addEventListener('popstate', onPopState);
  window.addEventListener('pageshow', onPageShow);
  if (document.body) observer.observe(document.body, { childList: true });
  evaluate(); // hard-load / initial-path case

  return function teardownRouteRule() {
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener('pageshow', onPageShow);
    observer.disconnect();
    if (healHandle) { cancelAnimationFrame(healHandle); healHandle = 0; }
    unmountRoute();
  };
}
