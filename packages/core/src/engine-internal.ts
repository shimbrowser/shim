// Types + leaf helpers shared across the engine's rule-processing modules
// (engine.ts, apply-rule.ts, dispatch-mutation.ts, route-rule.ts,
// rule-status.ts, rule-reconcile.ts). Everything here is either a pure type or
// a small stateless helper — no rule/patch state lives in this module.

import type { Spec, Rule, Mutation } from './types';
import type { MountRecord } from './anchor-change';
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

// A patch-declared custom mutation kind (rare — the built-in kinds
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
// anchor to give). The engine never compiles source: the HOST turns
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
  // This mount's api.onAnchorChange record (anchor-change.ts).
  change?: MountRecord<Node>;
}

// Structural echo of anchors.ts's (unexported) RejectedSample — only the
// fields the reconciler reads (`detail`, `source`); anchors.ts's internal
// `score` field is irrelevant here.
export interface RejectedSample {
  detail: string[];
  source?: string | null;
}

// --- Bounded enrichment ------------------------------------------------------
//
// The component-identity signal reaches the engine through two async calls:
// `api.componentId.verify` (the main-world bridge, which bounds itself at
// 400 ms in the browser) and `api.componentId.symbols()` (the deploy's symbol
// map). In the Shim browser the second one awaits an in-flight Bundle
// Discovery run for the current chunk set, which has no time limit: a cold
// Discovery fetches and parses every bundle on the page. Every engine consumer
// therefore waits at most ENRICH_BUDGET_MS and then goes on without the map.
//
// The budget is sized against the host's read of a preview. The Shim browser
// reads preview events once, APPLY_SETTLE_MS (2000 ms) after the apply, and
// the headless host uses the same window (HEADLESS_SETTLE_MS). Witness
// capture runs on the first scan that resolves its element, normally the
// apply's own synchronous scan, so a 1000 ms wait still lands the witness
// with half the window to spare. A Discovery run that answers inside the
// budget (the warm case: a cached deploy answers in milliseconds) still
// enriches; one that doesn't leaves the witness without `component`.
export const ENRICH_BUDGET_MS = 1000;

// What a bounded symbols read found:
//   - ready     the deploy's {minified: original} map
//   - no-map    the host answered, and there is no map (unmapped site, stub
//               api, forwarded frame, a host without the bridge)
//   - timed-out the host had not answered inside the budget. Not the same as
//               no-map: a mapped witness can't be judged or translated
//               without the map, so consumers skip the component signal
//               instead of comparing original names against raw fibers.
export type SymbolsRead =
  | { state: 'ready'; symbols: Record<string, string> }
  | { state: 'no-map' }
  | { state: 'timed-out' };

// Settle `p` within `ms`: `{ done: true, value }` when it resolved in time,
// `{ done: false }` when it timed out or rejected. The timer is cleared either
// way, so a pending engine never holds the event loop open.
export function withinBudget<T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ done: false });
    }, ms);
    p.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ done: true, value });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ done: false });
      },
    );
  });
}

// The current deploy's component-name map (sourcemap Stage B) via the api
// bridge, bounded by `budgetMs`. Null-safe on every degraded surface (stub
// apis, forwarded frames, harnesses) and never throws. A host whose call throws
// reads as no-map, as before; only a call still pending at the deadline reads
// as timed-out.
export async function readSymbols(api: CoreApi, budgetMs: number = ENRICH_BUDGET_MS): Promise<SymbolsRead> {
  if (!api || !api.componentId || typeof api.componentId.symbols !== 'function') {
    return { state: 'no-map' };
  }
  const call = Promise.resolve()
    .then(() => api.componentId.symbols())
    .catch(() => null);
  const r = await withinBudget(call, budgetMs);
  if (!r.done) return { state: 'timed-out' };
  return r.value ? { state: 'ready', symbols: r.value } : { state: 'no-map' };
}

// The map a ready read carries, else null ("compare raw names").
export function symbolsOf(read: SymbolsRead): Record<string, string> | null {
  return read.state === 'ready' ? read.symbols : null;
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
