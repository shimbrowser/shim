// Types + leaf helpers shared across the engine's rule-processing modules
// (engine.ts, apply-rule.ts, dispatch-mutation.ts, route-rule.ts,
// rule-status.ts, rule-reconcile.ts). Everything here is either a pure type or
// a small stateless helper — no rule/patch state lives in this module.

import vm from 'vm';
import type { Spec, Rule, Mutation } from './types';
import type { ShimApiBase, ShimApi, RouteMatch, RouteMountApi } from '../preload/shim-api-types';

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
  mount(el: Element, mut: Mutation, rule: Rule, spec: Spec, api: ShimApiBase): unknown;
}
export type MutationRegistry = Record<string, MutationHandlerDef>;

// Args a compiled handler function is invoked with. Two shapes: `script` /
// `replace-root` mutations hand the handler the resolved DOM anchor;
// `mount-route` handlers get the route match instead (routeRule has no DOM
// anchor to give). A handler is arbitrary vm-eval'd or `require`d source — its
// RETURN value is the one genuinely dynamic boundary, handled via
// normalizeOutputs below (`unknown` in, `Node[]` out).
export interface ScriptHandlerArgs {
  anchor: Element;
  mutation: Mutation;
  rule: Rule;
  spec: Spec;
  api: ShimApi;
}
export interface RouteHandlerArgs {
  match: RouteMatch;
  mutation: Mutation;
  rule: Rule;
  spec: Spec;
  api: RouteMountApi;
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
export function getSymbols(api: ShimApiBase): Promise<Record<string, string> | null> {
  if (!api || !api.componentId || typeof api.componentId.symbols !== 'function') {
    return Promise.resolve(null);
  }
  return Promise.resolve()
    .then(() => api.componentId.symbols())
    .catch(() => null);
}

// The one genuinely dynamic boundary in the engine: a handler is arbitrary
// vm-eval'd or `require`d source, so its return value is `unknown` until
// normalized here. Array outputs are filtered for falsy entries (a handler
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

// Preview rules arrive with handler source as strings on rule.handlers (the
// LLM emits them as text). Evaluate each as a function expression so the engine
// can invoke them like any module-loaded handler. Trust model: these strings
// originate from the authoring LLM routed through main — per CLAUDE.md §15
// user-authored patch code is trusted for now; the sandbox work listed there
// is what replaces this once patches come from other users or a registry.
//
// `vm.runInThisContext` (not the dynamic-code-generation alternative) is
// load-bearing: pages with a strict CSP (reddit, many bank sites) set
// `script-src` without `'unsafe-eval'`, and V8 enforces that by throwing
// `EvalError: Code generation from strings disallowed for this context` from
// the eval/Function path. The preload's Node-equipped isolated world sits
// outside the page's CSP and `vm` works regardless — same path `compileBag` in
// the page-preload uses for committed handlers, kept identical here so preview
// and committed share one trust + capability surface.
export function compileInlineHandlers(rawHandlers: Record<string, string>, spec: Spec): HandlerMap {
  const out: HandlerMap = {};
  const specId = spec?.id || 'inline';
  for (const [name, source] of Object.entries(rawHandlers)) {
    if (typeof source === 'function') { out[name] = source; continue; }
    if (typeof source !== 'string') continue;
    try {
      // Tag dynamically-compiled previews with a virtual sourceURL pragma so
      // DevTools stacktraces — and the page-preload's runtime-error
      // attribution regex — point at this exact handler. Without it, throws
      // from a preview would land in `<anonymous>` and the sidebar would never
      // know which shim caused them.
      //
      // Layout matters: the closing `)` of the inner function expression MUST
      // come BEFORE the `//# sourceURL=...` line. `//` starts a single-line
      // comment that runs to the next newline; if the pragma sat between
      // `${source}` and `)`, the comment would eat the paren and the function
      // expression never closes.
      const sourceURL = `shim://patches/${specId}/handlers/${name}.js`;
      out[name] = vm.runInThisContext(
        `(${source})\n//# sourceURL=${sourceURL}\n`,
        { filename: sourceURL },
      );
    } catch (err) {
      console.error(`[shim] failed to compile inline handler "${name}"`, err);
    }
  }
  return out;
}
