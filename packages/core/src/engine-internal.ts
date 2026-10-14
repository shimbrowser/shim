// Types + leaf helpers shared across the engine's rule-processing modules
// (engine.ts, apply-rule.ts, dispatch-mutation.ts, route-rule.ts,
// rule-status.ts, rule-reconcile.ts). Everything here is either a pure type or
// a small stateless helper — no rule/patch state lives in this module.

import type { Spec, Rule, Mutation } from './types';
import type { CoreApi, CoreHandlerApi, CoreRouteMountApi, RouteMatch } from './api';

// --- Runtime/engine-only Spec extension ------------------------------------
//
// The shared `Spec` (./types.ts) models the AUTHORED spec shape every stage of
// the pipeline agrees on. `run()` stamps a runtime-only field onto it purely
// for the rule-processing path: `__cssPriority` already lives on the shared
// type (other files read it too); `__bundleHashFn` never crosses out of the
// engine, so it's kept here rather than widening the shared contract for a
// field only the engine reads. `css` is a legitimate top-level authored field
// (a whole-patch CSS block) folded into collectCssForSpec.
export interface RuntimeSpec extends Spec {
  __bundleHashFn: () => string | null;
}

// A patch-declared custom mutation kind (rare — the built-ins in CLAUDE.md §6
// cover nearly every authored shim; both shipped fixtures declare an empty
// registry, `mutations: {}`). `deps` lets one custom kind pull in another's
// CSS; `mount` is invoked exactly like a script handler against the anchor.
export interface MutationHandlerDef {
  deps?: string[];
  css?: string;
  mount(el: Element, mut: Mutation, rule: Rule, spec: Spec, api: CoreHandlerApi): unknown;
}
export type MutationRegistry = Record<string, MutationHandlerDef>;

// Args a compiled handler function is invoked with. Two shapes: `script` /
// `replace-root` mutations hand the handler the resolved DOM anchor;
// `mount-route` handlers get the route match instead (routeRule has no DOM
// anchor to give). The engine never compiles source (design D4): the HOST turns
// handler source into functions — the Shim browser with `vm` in the preload's
// isolated world, other hosts their own way — and hands the engine functions.
// A handler's RETURN value is the one genuinely dynamic boundary, handled via
// normalizeOutputs below (`unknown` in, `Node[]` out).
export interface ScriptHandlerArgs {
  anchor: Element;
  mutation: Mutation;
  rule: Rule;
  spec: Spec;
  api: CoreHandlerApi;
}
export interface RouteHandlerArgs {
  match: RouteMatch;
  mutation: Mutation;
  rule: Rule;
  spec: Spec;
  api: CoreRouteMountApi;
}
export type PatchHandler = (args: ScriptHandlerArgs | RouteHandlerArgs) => unknown;
export type HandlerMap = Record<string, PatchHandler>;

// Per-anchor mounted state applyRule tracks: the DOM nodes a rule's mutations
// produced (post mount-strategy, so always real HTMLElements — see mountOn)
// plus the cleanup callbacks registered against them.
export interface RuleMountEntry {
  outputs: HTMLElement[];
  cleanups: Array<() => void>;
}

// Structural echo of anchors.ts's (unexported) RejectedSample — only the
// fields the reconciler reads (`detail`, `source`); anchors.ts's internal
// `score` field is irrelevant here.
export interface RejectedSample {
  detail: string[];
  source?: string | null;
}

// Current deploy's {minified: original} component-name map (§8 Stage B), via
// the api bridge. Null-safe on every degraded surface — stub apis, forwarded
// frames, harnesses — and never throws; null means "compare raw names".
export function getSymbols(api: CoreApi): Promise<Record<string, string> | null> {
  if (!api || !api.componentId || typeof api.componentId.symbols !== 'function') {
    return Promise.resolve(null);
  }
  return Promise.resolve()
    .then(() => api.componentId.symbols())
    .catch(() => null);
}

// The one genuinely dynamic boundary in the engine: a handler is arbitrary
// host-compiled source, so its return value is `unknown` until normalized
// here. Array outputs are filtered for falsy entries (a handler
// that conditionally returns nothing for some of several roots); non-array
// truthy outputs are wrapped as a single-element result.
export function normalizeOutputs(r: unknown): Node[] {
  if (!r) return [];
  if (Array.isArray(r)) return r.filter(Boolean) as Node[];
  return [r as Node];
}

// Trim a stack trace to the top 8 frames — enough to see the throwing line +
// immediate callers, not enough to bury the LLM in V8 internals. Mirrors the
// page-preload's `trimStack` (kept local rather than imported because the
// engine is loaded from both Node and the page-preload's vm context, and an
// import cycle would be awkward).
export function trimStackForEvent(stack: string): string {
  if (!stack) return '';
  return stack.split('\n').slice(0, 8).join('\n');
}
