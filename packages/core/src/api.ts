// The `api` surface the ENGINE itself depends on — owned by the engine, so
// @shimbrowser/core has no type path into any host (the Shim browser's preload,
// main, shim-db). A host builds an object satisfying `CoreApi` and hands it to
// `engine.run(patch, api)`; everything else it puts on that object (storage,
// db, ai, fetch, settings, modules, shared, …) the engine never reads — it only
// passes the object through to handlers via a per-mount `Object.create(api)`.
//
// The Shim browser's full handler surface (src/preload/shim-api-types.ts's
// `ShimApiBase`) EXTENDS `CoreApi`, so the browser keeps its complete typing
// while the engine names none of the browser's capability types.
//
// Types only: nothing here exists at runtime.

import type { ComponentDescriptor, Rule } from './types';

// What `engine.run` receives. Each member below is one the engine calls; the
// rest of a host's api is invisible to the engine's types by design.
export interface CoreApi {
  origin: string;
  host: string;
  patchId: string;
  // Parent→child iframe rule forwarding (CLAUDE.md §11). Hosts without frames
  // may provide a stub; bridge-rule.ts guards `api.bridge?.forwardRule`.
  bridge: {
    forwardRule(targetOrigin: string, rule: Rule, sourcePatchId: string): void;
  };
  // Framework component identity (CLAUDE.md §8). Every engine consumer
  // null-checks the member and each method before calling.
  componentId: {
    verify(el: Element): Promise<ComponentDescriptor | null>;
    // `expected` may be one descriptor or an array (the helper scores max).
    find(expected: ComponentDescriptor | ComponentDescriptor[]): Promise<Element[]>;
    // The current deploy's {minified: original} component-name map, or null.
    symbols(): Promise<Record<string, string> | null>;
  };
  reportEvent(kind: string, payload?: Record<string, unknown>): void;
  onReady(fn: () => void): void;
}

// The host capabilities a handler receives alongside the core members, typed
// opaquely: the engine passes them through (prototype inheritance from the
// host's api) without ever naming them. Applied only to the handler-facing
// types below — never to `CoreApi` itself, so a host interface extending
// `CoreApi` doesn't inherit an index signature that would hide its own typos.
export interface HostApiMembers {
  readonly [member: string]: unknown;
}

// The per-mount `cleanup` the engine layers on top of the host's api
// (apply-rule.ts / route-rule.ts build it with `Object.create(api)`).
export interface MountCleanup {
  cleanup(fn: () => void): void;
}

// The full surface a `script` / `replace-root` handler (or a custom mutation's
// `mount`) receives, as the engine sees it.
export type CoreHandlerApi = CoreApi & MountCleanup & HostApiMembers;

// The route match a mount-route handler receives, and receives again on each
// in-place inner navigation via api.onRouteChange (CLAUDE.md §6 nested
// sub-routes).
export interface RouteMatch {
  path: string;
  params: Record<string, string | undefined>;
}

// A callback runs on every same-route path change (the shell stays mounted);
// it may return a teardown fn, run before its next call AND on final unmount
// (the per-inner-view cleanup scope). Registering ≥1 callback is what opts a
// route into in-place updates — without one, a param change remounts.
export interface RouteChangeRegistrar {
  onRouteChange(cb: (match: RouteMatch) => void | (() => void)): void;
}

// The api a mount-route handler gets: the handler api plus onRouteChange.
export type CoreRouteMountApi = CoreHandlerApi & RouteChangeRegistrar;
