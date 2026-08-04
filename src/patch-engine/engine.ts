import vm from 'vm';
import * as anchors from './anchors';
import {
  compileReorderCss, compileReshapeCss, desiredSequence, reorderNote, reshapeNote, REORDER_SIBLING_CAP,
} from './layout-kinds';
import { buildElement, parseInjectHtml, resolvePlacement } from './inject-kinds';
import * as witnessMod from './witness';
import * as componentId from './component-id';
import { applyStrategy } from './strategies';
import * as routeMatch from './route-match';
import type { Spec, Rule, Mutation, Anchor, AnchorSpec } from './types';
import type { ShimApiBase, ShimApi } from '../preload/shim-api-types';
import { errMessage } from '../shared/error';

// --- Local runtime/engine-only type extensions -----------------------------
//
// The shared `Spec` (./types.ts) models the AUTHORED spec shape every stage
// of the pipeline agrees on. `run()` below stamps two fields onto it purely
// for internal use by the rule-processing path (see the comment at run()):
// `__cssPriority` already lives on the shared type (other files read it
// too); `__bundleHashFn` never crosses out of this file, so it's kept local
// rather than widening the shared contract for a field only this module
// reads. `css` is a legitimate top-level authored field (a whole-patch CSS
// block, folded into collectCssForSpec) that no shipped shim actually emits
// today but the engine has always supported — also kept local since nothing
// outside this file reads it.
interface RuntimeSpec extends Spec {
  // `css?` now lives on the shared Spec (a real persistable field). Only the
  // runtime-stamped bundle-hash accessor is engine-local.
  __bundleHashFn: () => string | null;
}

// A patch-declared custom mutation kind (rare — the seven built-ins in
// CLAUDE.md §6 cover nearly every authored shim; both shipped fixtures
// declare an empty registry, `mutations: {}`). `deps` lets one custom kind
// pull in another's CSS; `mount` is invoked exactly like a script handler
// against the resolved anchor.
interface MutationHandlerDef {
  deps?: string[];
  css?: string;
  mount(el: Element, mut: Mutation, rule: Rule, spec: Spec, api: ShimApiBase): unknown;
}
type MutationRegistry = Record<string, MutationHandlerDef>;

// Args a compiled handler function is invoked with. Two shapes: `script` /
// `replace-root` mutations hand the handler the resolved DOM anchor;
// `mount-route` handlers get the route match instead (routeRule has no DOM
// anchor to give). A handler is arbitrary vm-eval'd or `require`d source —
// its RETURN value is the one genuinely dynamic boundary in this file,
// handled via normalizeOutputs below (`unknown` in, `Node[]` out).
interface ScriptHandlerArgs {
  anchor: Element;
  mutation: Mutation;
  rule: Rule;
  spec: Spec;
  api: ShimApi;
}
interface RouteHandlerArgs {
  match: { path: string; params: Record<string, string | undefined> };
  mutation: Mutation;
  rule: Rule;
  spec: Spec;
  api: ShimApi;
}
type PatchHandler = (args: ScriptHandlerArgs | RouteHandlerArgs) => unknown;
type HandlerMap = Record<string, PatchHandler>;

// The bundle run() receives from page-preload — NOT the same shape as
// `Spec`: this is the compiled module/bag (`{ spec, mutations, handlers }`)
// plus two fields page-preload adds before calling in (`priority`, the
// sidebar/registry ordering; `bundleHash`, the current-deploy fingerprint —
// see the comment on run() for why it may be a function).
interface PatchBundle {
  spec: Spec;
  mutations?: MutationRegistry;
  handlers?: HandlerMap;
  priority?: number;
  bundleHash?: string | (() => string | null);
}

// The control object run() returns to page-preload — lets the sidebar /
// cross-frame bridge apply live-preview or forwarded rules and tear the
// whole patch down.
interface PatchControl {
  applyExtraRule(rule: Rule, specIdOverride?: string, ruleKey?: string): void;
  removeExtraRule(ruleKey: string): boolean;
  teardownAll(): void;
}

// Structural echo of anchors.ts's (unexported) RejectedSample — only the
// fields this file reads (`detail`, `source`); anchors.ts's internal
// `score` field is irrelevant here.
interface RejectedSample {
  detail: string[];
  source?: string | null;
}

// Per-anchor mounted state applyRule tracks: the DOM nodes a rule's
// mutations produced (post mount-strategy, so always real HTMLElements —
// see mountOn) plus the cleanup callbacks registered against them.
interface RuleMountEntry {
  outputs: HTMLElement[];
  cleanups: Array<() => void>;
}

// --- Own-DOM guard ----------------------------------------------------------
//
// Nothing stops a rule's anchor selector from matching DOM the engine itself
// created. `hide`/`restyle`/`reshape`/`reorder` outputs are the resolved
// SITE anchor restamped in place (never a new node), so they're never at
// risk — but a `script`/`replace-root` handler's OUTPUT is new DOM, and an
// `inline`-strategy output carries no marker attribute at all (only
// `replace-root` outputs get `data-shim-mounted`; portal/overlay park inside
// `[data-shim="portal-root"]`, shadow wraps in `[data-shim="shadow-host"]`).
// If a handler's injected output happens to match its own rule's anchor
// selector, the next scan mounts it too: dispatch → insert → new match →
// dispatch, unbounded.
//
// `mountedOutputRoots` is a MODULE-level registry (not per-applyRule-call):
// every `engine.run` instance for every patch on the page shares it, so one
// shim's handler output is never mistaken for another shim's anchor target
// either. `mountOn` adds each mount's outputs after recording them in
// `state`; `teardownEntry` removes exactly those entries' outputs — no
// leaks across toggle/self-heal cycles, no cross-rule interference.
//
// Accepted residual: this only registers OUTPUT A HANDLER RETURNED (the
// `mountOn`/`state` bookkeeping path). A handler that opts out of
// self-healing by returning nothing (CLAUDE.md §6, "empty return = mounted
// once") but still appends DOM by hand — `el.appendChild(...)` without
// returning it — produces DOM this registry never learns about, so if that
// DOM happens to match the rule's own anchor selector the loop this guard
// exists to prevent can still occur. Not closable without either requiring
// a return value (a real API change) or diffing the DOM tree the handler
// touched, which is out of scope here.
const mountedOutputRoots = new Set<Node>();

// The selector side of the guard: an anchor candidate already living inside
// engine-owned DOM is never a legitimate target, regardless of the
// module-level registry. Deliberately narrow — `data-shim-css` and
// `data-shim-replace-root` are stamped ON SITE ELEMENTS (tier-1 targets and
// replace-root anchors, respectively) and must NOT make an element
// "shim-owned"; only markers on DOM the engine itself CREATED belong here.
// `data-shim-injected` (inject-element / inject-html roots) is a marker on
// engine-CREATED nodes, so it belongs here — unlike script outputs, inject
// outputs always carry it, giving marker coverage even where the registry
// arm can't reach (a node detached and reattached outside the engine's
// bookkeeping).
const OWN_DOM_SELECTOR = '[data-shim-mounted],[data-shim="portal-root"],[data-shim="shadow-host"],[data-shim="route-host"],[data-shim-injected]';

// Pure predicate: true when `el` is inside DOM the engine mounted — either
// because it (or an ancestor) carries one of the engine's own-DOM markers,
// or because it's contained by a registered mounted-output root (the
// `inline`-strategy case, which carries no marker at all). Exported for the
// bare-node harness; both parameters are feature-detected duck types (real
// DOM Elements/Nodes satisfy them trivially) rather than the DOM lib types,
// so a minimal test stub without a full Element/Node implementation still
// type-checks — same trade-off `anchors.ts`'s `AnchorElement` makes.
function isShimOwnedElement(
  el: { closest?: (sel: string) => unknown },
  // Method-signature syntax (not an arrow-typed property) so TS checks
  // `contains`'s parameter bivariantly: a real DOM `Node.contains(other:
  // Node | null)` satisfies this even though `unknown` is wider than
  // `Node | null` — an arrow-property type would fail that under
  // `strictFunctionTypes`. The harness's duck-typed stubs (`contains(n:
  // unknown)`) satisfy it either way.
  roots: Iterable<{ contains?(n: unknown): boolean }>,
): boolean {
  if (typeof el.closest === 'function' && el.closest(OWN_DOM_SELECTOR)) return true;
  for (const root of roots) {
    if (typeof root.contains === 'function' && root.contains(el)) return true;
  }
  return false;
}

// routeRule's single mounted-route record — see mountRoute/unmountRoute.
interface MountedRoute {
  outputs: HTMLElement[];
  cleanups: Array<() => void>;
  path: string;
  prevTitle: string;
}

// All shim CSS lives inside one named cascade layer, `shim`. This is what
// makes "your local layer wins over the site" a guarantee rather than a
// specificity gamble (CLAUDE.md §6). The load-bearing CSS rule: for
// `!important` declarations, a *layered* style beats an *un-layered* style —
// regardless of selector specificity or source order. Virtually every real
// site ships un-layered CSS, so a shim `!important` rule in `@layer shim`
// wins against the site's `!important` rules even when the site's selector is
// far more specific. Multiple `@layer shim { … }` blocks merge by name into
// the one layer, so each rule keeps its own removable text node (teardown is
// unchanged) while all of them share the layer's precedence.
const SHIM_LAYER = 'shim';
function layered(cssText: string): string {
  return `@layer ${SHIM_LAYER} { ${cssText} }\n`;
}

// Cross-shim cascade priority (higher wins). Stamped onto the runtime spec by
// `run()` from the patch's `priority` (assigned in main: user shims above
// platform fixtures; among user shims, sidebar list order). Read here rather
// than threaded through every rule-processing signature. Previews / forwarded
// rules that shallow-copy the spec inherit it.
function cssPriorityOf(spec: Spec): number {
  return Number.isFinite(spec && spec.__cssPriority) ? (spec.__cssPriority as number) : 0;
}

// Current deploy's {minified: original} component-name map (§8 Stage B), via
// the api bridge. Null-safe on every degraded surface — stub apis, forwarded
// frames, harnesses — and never throws; null means "compare raw names".
function getSymbols(api: ShimApiBase): Promise<Record<string, string> | null> {
  if (!api || !api.componentId || typeof api.componentId.symbols !== 'function') {
    return Promise.resolve(null);
  }
  return Promise.resolve()
    .then(() => api.componentId.symbols())
    .catch(() => null);
}

function injectStyle(id: string, css: string): void {
  if (!css || document.querySelector(`style[data-shim="${id}"]`)) return;
  const style = document.createElement('style');
  style.setAttribute('data-shim', id);
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
}

// Tier-1 CSS built-ins (`hide`, `restyle`) target elements via a shared
// `data-shim-css` attribute. Each rule owns a CSS fragment keyed by a token
// (e.g. `shim-<patchId>-<ruleId>-<kind>`); the engine stamps that token onto
// the resolved anchor and appends the fragment to a shared <style> tag. React
// (and other reconcilers) don't touch data-* attributes they didn't declare,
// so styling survives re-renders without needing self-healing.
//
// The per-token Map (rather than a bare Set) lets us (a) update a rule's CSS
// in place when it's re-applied with different properties, and (b) cleanly
// remove it from the sheet during rule teardown. Each entry stores the text
// node plus its `priority` so cross-shim conflicts resolve deterministically
// (see injectTier1Rule).
interface Tier1RuleEntry {
  node: Text;
  priority: number;
}
const tier1RuleNodes = new Map<string, Tier1RuleEntry>();
function ensureTier1Sheet(): HTMLStyleElement {
  let sheet = document.querySelector('style[data-shim="tier1-css"]') as HTMLStyleElement | null;
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.setAttribute('data-shim', 'tier1-css');
    (document.head || document.documentElement).appendChild(sheet);
  }
  return sheet;
}
// All tier-1 rules share one `@layer shim` (so they all beat the site), which
// means a conflict between two shims on the same element+property is decided
// by SOURCE ORDER within the layer — later wins. Blind append makes that
// order depend on apply timing (which shim's rule resolved first, whether a
// rule self-healed late), so the winner flips between reload and toggle. We
// instead insert each rule at a position keyed by `priority` (higher wins):
// the sheet stays sorted low→high, so the highest-priority shim's rule is
// always last and always wins, regardless of when it resolved. Priority is
// assigned in main (user shims > platform fixtures; among user shims, the
// one higher in the sidebar list) and threaded in via the spec.
function injectTier1Rule(token: string, cssBody: string, priority = 0): void {
  const text = layered(`[data-shim-css~="${token}"] { ${cssBody} }`);
  const existing = tier1RuleNodes.get(token);
  if (existing) {
    existing.node.nodeValue = text;
    existing.priority = priority;
    return;
  }
  const node = document.createTextNode(text);
  const sheet = ensureTier1Sheet();
  // Keep the sheet ordered ascending by priority: insert before the first
  // already-placed node whose priority is strictly higher. Ties (same
  // priority — e.g. two rules of one shim) fall to append-after, preserving
  // intra-shim authoring order. Walking childNodes (DOM order) keeps the
  // position correct even as nodes are added and removed over time.
  const children = Array.from(sheet.childNodes);
  const priorities = children.map((c) => {
    const entry = nodeToEntry(c);
    return entry ? entry.priority : -Infinity; // untracked nodes sort first
  });
  const idx = firstGreaterIndex(priorities, priority);
  sheet.insertBefore(node, children[idx] || null); // out-of-range → append
  tier1RuleNodes.set(token, { node, priority });
}
// First index whose value is strictly greater than `priority`, else the
// array length (append). Pure — exported for scripts/css-priority-harness.js.
function firstGreaterIndex(priorities: number[], priority: number): number {
  for (const [i, p] of priorities.entries()) {
    if (p > priority) return i;
  }
  return priorities.length;
}
// Reverse lookup (text node → its tracked entry) for the ordered insert.
// The rule set is small (a handful per page), so the linear scan is cheap.
function nodeToEntry(node: Node): Tier1RuleEntry | null {
  for (const entry of tier1RuleNodes.values()) {
    if (entry.node === node) return entry;
  }
  return null;
}
function removeTier1Rule(token: string): void {
  const entry = tier1RuleNodes.get(token);
  if (!entry) return;
  entry.node.remove();
  tier1RuleNodes.delete(token);
}
function tagElement(el: Element, token: string): void {
  const current = el.getAttribute('data-shim-css') || '';
  const tokens = current.split(/\s+/).filter(Boolean);
  if (tokens.includes(token)) return;
  tokens.push(token);
  el.setAttribute('data-shim-css', tokens.join(' '));
}
function stripToken(el: Element, token: string): void {
  const current = el.getAttribute('data-shim-css') || '';
  const tokens = current.split(/\s+/).filter((t) => t && t !== token);
  if (tokens.length) el.setAttribute('data-shim-css', tokens.join(' '));
  else el.removeAttribute('data-shim-css');
}
const toKebab = (s: string): string => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
function cssBodyFromProps(props?: Record<string, string>): string {
  return Object.entries(props || {})
    .map(([k, v]) => `${toKebab(k)}: ${v} !important;`)
    .join(' ');
}

// Tier-4 `replace-root` machinery. Distinct attr + sheet from Tier-1 because
// the rule shape differs: Tier-1 styles the anchor; replace-root styles the
// anchor's direct children (hiding them so the handler's mounted DOM can
// occupy the space). Same token-per-rule discipline so teardown can pull
// just this rule's CSS out of the sheet.
const replaceRootRuleNodes = new Map<string, Text>();

// Apply-time strip feedback for inject-html (§6): when the strip pass
// removed active content, the fact rides the rule-status `note` field so the
// authoring loop tells the model its onclick/script never shipped. Keyed
// spec/rule; set at mount, cleared at rule teardown.
const injectStripNotes = new Map<string, string>();
function ensureReplaceRootSheet(): HTMLStyleElement {
  let sheet = document.querySelector('style[data-shim="replace-root"]') as HTMLStyleElement | null;
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.setAttribute('data-shim', 'replace-root');
    (document.head || document.documentElement).appendChild(sheet);
  }
  return sheet;
}
function injectReplaceRootRule(token: string): void {
  if (replaceRootRuleNodes.has(token)) return;
  // The `:not([data-shim-mounted~="..."])` clause keeps the handler's own
  // mounted output visible; without it the children-hide rule would also
  // hit the node the handler appended to the anchor. The handler tags its
  // returned roots with a matching `data-shim-mounted` token (see the
  // dispatch path) so the rule excludes them.
  const text = layered(`[data-shim-replace-root~="${token}"] > *:not([data-shim-mounted~="${token}"]) { display: none !important; }`);
  const node = document.createTextNode(text);
  ensureReplaceRootSheet().appendChild(node);
  replaceRootRuleNodes.set(token, node);
}
function removeReplaceRootRule(token: string): void {
  const node = replaceRootRuleNodes.get(token);
  if (!node) return;
  node.remove();
  replaceRootRuleNodes.delete(token);
}

// Route-only environment pinning. The shadow root isolates a route page's
// CONTENTS, but the page still sits inside the host document's <html>/<body>
// — and those differ per entry path: soft nav keeps the site's stylesheet
// (body max-width / margins / html font-size, which rem resolves against),
// hard load is a bare shell with UA defaults. Pinning both to a neutral state
// while a route is mounted is what makes the two paths render identically.
// NOT applied for the `replace-root` kind — an in-place region replacement is
// supposed to live in the site's layout context; a route page replaces it.
function injectRouteEnvRule(token: string): void {
  const key = `${token}::env`;
  if (replaceRootRuleNodes.has(key)) return;
  const text =
    layered(`html:has(> body[data-shim-replace-root~="${token}"]) { margin: 0 !important; padding: 0 !important; font-size: 16px !important; background: #fff !important; }`) +
    layered(`body[data-shim-replace-root~="${token}"] { margin: 0 !important; padding: 0 !important; max-width: none !important; width: auto !important; min-height: 100vh !important; background: #fff !important; display: block !important; }`);
  const node = document.createTextNode(text);
  ensureReplaceRootSheet().appendChild(node);
  replaceRootRuleNodes.set(key, node);
}
function removeRouteEnvRule(token: string): void {
  removeReplaceRootRule(`${token}::env`);
}
function tagReplaceRootAnchor(el: Element, token: string): void {
  const current = el.getAttribute('data-shim-replace-root') || '';
  const tokens = current.split(/\s+/).filter(Boolean);
  if (tokens.includes(token)) return;
  tokens.push(token);
  el.setAttribute('data-shim-replace-root', tokens.join(' '));
}
function stripReplaceRootToken(el: Element, token: string): void {
  const current = el.getAttribute('data-shim-replace-root') || '';
  const tokens = current.split(/\s+/).filter((t) => t && t !== token);
  if (tokens.length) el.setAttribute('data-shim-replace-root', tokens.join(' '));
  else el.removeAttribute('data-shim-replace-root');
}
function tagMountedNode(node: Node, token: string): void {
  if (!(node instanceof Element)) return;
  const current = node.getAttribute('data-shim-mounted') || '';
  const tokens = current.split(/\s+/).filter(Boolean);
  if (tokens.includes(token)) return;
  tokens.push(token);
  node.setAttribute('data-shim-mounted', tokens.join(' '));
}

function collectMutationKinds(spec: Spec, mutations: MutationRegistry): Set<string> {
  const direct = new Set<string>();
  for (const rule of spec.rules || []) {
    for (const mut of rule.mutations || []) direct.add(mut.kind);
  }
  const resolved = new Set<string>();
  const walk = (kind: string) => {
    if (resolved.has(kind)) return;
    resolved.add(kind);
    const handler = mutations[kind];
    if (handler?.deps) for (const d of handler.deps) walk(d);
  };
  for (const k of direct) walk(k);
  return resolved;
}

function collectCssForSpec(spec: RuntimeSpec, mutations: MutationRegistry): Array<{ id: string; css: string }> {
  const chunks: Array<{ id: string; css: string }> = [];
  for (const kind of collectMutationKinds(spec, mutations)) {
    const handler = mutations[kind];
    if (handler?.css) chunks.push({ id: `mutation-${kind}`, css: handler.css });
  }
  if (spec.css) chunks.push({ id: `patch-${spec.id}`, css: spec.css });
  return chunks;
}

// The one genuinely dynamic boundary in this file: a handler is arbitrary
// vm-eval'd or `require`d source, so its return value is `unknown` until
// normalized here. Array outputs are filtered for falsy entries (a handler
// that conditionally returns nothing for some of several roots); non-array
// truthy outputs are wrapped as a single-element result.
function normalizeOutputs(r: unknown): Node[] {
  if (!r) return [];
  if (Array.isArray(r)) return r.filter(Boolean) as Node[];
  return [r as Node];
}

// Preview rules arrive with handler source as strings on rule.handlers
// (the LLM emits them as text). Evaluate each as a function expression so
// the engine can invoke them like any module-loaded handler. Trust model:
// these strings originate from the authoring LLM routed through main —
// per CLAUDE.md §15 user-authored patch code is trusted for now; the
// sandbox work listed there is what replaces this once patches come from
// other users or a registry.
//
// `vm.runInThisContext` (not the dynamic-code-generation alternative) is
// load-bearing: pages with a strict CSP (reddit, many bank sites) set
// `script-src` without `'unsafe-eval'`, and V8 enforces that by throwing
// `EvalError: Code generation from strings disallowed for this context`
// from the eval/Function path. The preload's Node-equipped isolated
// world sits outside the page's CSP and `vm` works regardless — same
// path `compileBag` in the page-preload uses for committed handlers,
// kept identical here so preview and committed share one trust +
// capability surface.
function compileInlineHandlers(rawHandlers: Record<string, string>, spec: Spec): HandlerMap {
  const out: HandlerMap = {};
  const specId = spec?.id || 'inline';
  for (const [name, source] of Object.entries(rawHandlers)) {
    if (typeof source === 'function') { out[name] = source; continue; }
    if (typeof source !== 'string') continue;
    try {
      // Tag dynamically-compiled previews with a virtual sourceURL pragma
      // so DevTools stacktraces — and the page-preload's runtime-error
      // attribution regex — point at this exact handler. Without it,
      // throws from a preview would land in `<anonymous>` and the
      // sidebar would never know which shim caused them.
      //
      // Layout matters: the closing `)` of the inner function expression
      // MUST come BEFORE the `//# sourceURL=...` line. `//` starts a
      // single-line comment that runs to the next newline; if the
      // pragma sat between `${source}` and `)`, the comment would eat
      // the paren and the function expression never closes.
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

// Trim a stack trace to the top 8 frames — enough to see the throwing line
// + immediate callers, not enough to bury the LLM in V8 internals. Mirrors
// the page-preload's `trimStack` (kept local rather than imported because
// the engine is loaded from both Node and the page-preload's vm context,
// and an import cycle would be awkward).
function trimStackForEvent(stack: string): string {
  if (!stack) return '';
  return stack.split('\n').slice(0, 8).join('\n');
}

// Invokes one mutation against the anchor and returns a Promise<Node[]> of the
// nodes the handler produced. Handlers enable self-healing by returning the
// root node(s) they mounted; handlers that return nothing opt out (we never
// re-mount them, matching the pre-self-healing behavior).
function dispatchMutation(
  el: Element,
  mut: Mutation,
  rule: Rule,
  spec: Spec,
  api: ShimApi,
  mutations: MutationRegistry,
  handlers: HandlerMap,
): Promise<Node[]> {
  // Emit a handler-error event into the authoring channel. Handler throws
  // are caught by the wrapper below (so a buggy handler can't take down
  // the whole engine), which means they never bubble to window.error —
  // we'd only see them in the console without this. Reporting from here
  // is the primary path for synchronous mount-time throws + initial
  // promise rejections; the page-preload's window.error / unhandled-
  // rejection listeners stay the backstop for async throws that escape
  // the wrapper (e.g. event listeners installed by a successful mount
  // that throw later).
  const reportError = (handlerName: string, err: unknown) => {
    if (typeof api.reportEvent !== 'function') return;
    api.reportEvent('handler-error', {
      specId: spec.id,
      handlerName: handlerName || '(anonymous)',
      ruleId: rule.id,
      message: errMessage(err),
      stack: trimStackForEvent(err instanceof Error ? err.stack || '' : ''),
    });
  };

  const safe = (label: string, handlerName: string | null | undefined, work: () => unknown): Promise<Node[]> => {
    try {
      return Promise.resolve(work()).then(normalizeOutputs, (err) => {
        console.error(`[shim] ${label} failed`, err);
        if (handlerName) reportError(handlerName, err);
        return [];
      });
    } catch (err) {
      console.error(`[shim] ${label} failed`, err);
      if (handlerName) reportError(handlerName, err);
      return Promise.resolve([]);
    }
  };

  if (mut.kind === 'script') {
    const handlerName = typeof mut.handler === 'string' ? mut.handler : '';
    const fn = handlers[handlerName];
    if (!fn) {
      console.warn(`[shim] script: unknown handler "${mut.handler}"`);
      // Missing handler is a kind of authoring error too — surface it the
      // same way as a throw so the LLM learns the rule emitted a handler
      // name that doesn't exist (probably a typo or stale ref).
      if (typeof api.reportEvent === 'function') {
        api.reportEvent('handler-error', {
          specId: spec.id,
          handlerName: mut.handler,
          ruleId: rule.id,
          message: `unknown handler "${mut.handler}" — the rule references a handler name that wasn't compiled with this shim`,
          stack: '',
        });
      }
      return Promise.resolve([]);
    }
    return safe(`script handler "${mut.handler}"`, mut.handler, () =>
      fn({ anchor: el, mutation: mut, rule, spec, api }),
    );
  }

  if (mut.kind === 'hide') {
    const token = `shim-${spec.id}-${rule.id}-hide`;
    injectTier1Rule(token, 'display: none !important;', cssPriorityOf(spec));
    tagElement(el, token);
    return Promise.resolve([]);
  }

  if (mut.kind === 'restyle') {
    const body = cssBodyFromProps(mut.properties);
    if (!body) return Promise.resolve([]);
    const token = `shim-${spec.id}-${rule.id}-restyle`;
    injectTier1Rule(token, body, cssPriorityOf(spec));
    tagElement(el, token);
    return Promise.resolve([]);
  }

  // Tier-1 layout kinds (§6): compile via layout-kinds.ts, ride the same
  // token machinery as hide/restyle. Relative reorder (before/after)
  // compiles to null here — applyRule's restamp path owns it (a whole-
  // sibling ordering can't be expressed as one anchor rule).
  if (mut.kind === 'reorder') {
    const body = compileReorderCss(mut);
    if (body) {
      const token = `shim-${spec.id}-${rule.id}-reorder`;
      injectTier1Rule(token, body, cssPriorityOf(spec));
      tagElement(el, token);
    }
    return Promise.resolve([]);
  }

  if (mut.kind === 'reshape') {
    const body = compileReshapeCss(mut);
    if (body) {
      const token = `shim-${spec.id}-${rule.id}-reshape`;
      injectTier1Rule(token, body, cssPriorityOf(spec));
      tagElement(el, token);
    }
    return Promise.resolve([]);
  }

  // Tier-2 declarative injection (§6): build static DOM from the payload,
  // insert per `placement`, and RETURN the nodes — the script-output path
  // (self-healing, per-anchor dedupe, teardown, emit feedback) does the rest.
  if (mut.kind === 'inject-element') {
    return safe(`inject-element ${rule.id}`, null, () => {
      if (!mut.element) return [];
      const pos = resolvePlacement(el, mut.placement);
      if (!pos) return [];
      const node = buildElement(mut.element, document);
      node.setAttribute('data-shim-injected', `shim-${spec.id}-${rule.id}-inject`);
      pos.parent.insertBefore(node, pos.before);
      return [node];
    });
  }

  if (mut.kind === 'inject-html') {
    return safe(`inject-html ${rule.id}`, null, () => {
      if (typeof mut.html !== 'string') return [];
      const pos = resolvePlacement(el, mut.placement);
      if (!pos) return [];
      const { nodes, stripped } = parseInjectHtml(mut.html, document);
      const noteKey = `${spec.id}/${rule.id}`;
      if (stripped > 0) {
        injectStripNotes.set(noteKey,
          `inject-html stripped ${stripped} active item(s) (scripts / on* handlers / javascript: URLs) — `
          + 'inject kinds are static-only; use a script handler for behavior');
      } else {
        injectStripNotes.delete(noteKey);
      }
      for (const node of nodes) {
        node.setAttribute('data-shim-injected', `shim-${spec.id}-${rule.id}-inject`);
        pos.parent.insertBefore(node, pos.before);
      }
      return nodes;
    });
  }

  // Tier 3 — delete the anchor outright. Hostile to reconcilers by design:
  // the engine's scan loop catches re-rendered nodes and re-removes them.
  // Irreversible by nature — toggle-off can't restore a deleted node; the
  // user reloads, or the framework re-renders, to recover. Prefer `hide`
  // unless the parent's layout actually depends on child count / structural
  // selectors (`:nth-child`, flex/grid count, etc.).
  if (mut.kind === 'remove') {
    el.remove();
    return Promise.resolve([]);
  }

  // Tier 4 `replace-root` — mount handler-returned DOM inside the anchor and
  // hide the anchor's original children via CSS. Reversible: toggle-off
  // strips the token, the CSS rule comes out of the sheet, original children
  // reappear. Handler contract mirrors `script`: it returns the node(s) it
  // mounted; the engine tags each with `data-shim-mounted="<token>"` so the
  // children-hide rule's `:not(...)` clause spares them. Self-healing comes
  // for free from the scan loop — if the framework reconciles our mount
  // away, the next scan re-runs the handler.
  if (mut.kind === 'replace-root') {
    const handlerName = typeof mut.handler === 'string' ? mut.handler : '';
    const fn = handlers[handlerName];
    if (!fn) {
      console.warn(`[shim] replace-root: unknown handler "${mut.handler}"`);
      if (typeof api.reportEvent === 'function') {
        api.reportEvent('handler-error', {
          specId: spec.id,
          handlerName: mut.handler,
          ruleId: rule.id,
          message: `unknown handler "${mut.handler}" — the rule references a handler name that wasn't compiled with this shim`,
          stack: '',
        });
      }
      return Promise.resolve([]);
    }
    const token = `shim-${spec.id}-${rule.id}-replace-root`;
    injectReplaceRootRule(token);
    tagReplaceRootAnchor(el, token);
    return safe(`replace-root handler "${mut.handler}"`, mut.handler, () =>
      fn({ anchor: el, mutation: mut, rule, spec, api }),
    ).then((nodes) => {
      for (const n of nodes) tagMountedNode(n, token);
      return nodes;
    });
  }

  const handler = mutations[mut.kind];
  if (!handler) {
    console.warn(`[shim] unknown mutation kind: ${mut.kind}`);
    return Promise.resolve([]);
  }
  // Custom declarative mutations don't carry a handler-name slot in the
  // event vocabulary; pass null so the throw still hits the console but
  // no event is emitted. (None ship today — see CLAUDE.md §22 step 23.)
  return safe(`mount ${rule.id}/${mut.kind}`, null, () =>
    handler.mount(el, mut, rule, spec, api),
  );
}

// Returns a teardown function that unobserves, removes all mounted outputs,
// runs per-entry cleanups, and strips any Tier-1 CSS this rule stamped onto
// its anchors (plus the rule text from the shared stylesheet). Preview
// iterative refinement in the authoring UI relies on this.
function applyRule(
  rule: Rule,
  spec: RuntimeSpec,
  api: ShimApiBase,
  mutations: MutationRegistry,
  handlers: HandlerMap,
): () => void {
  // Rules from the authoring UI preview path carry their handler sources
  // inline on the rule as strings (the LLM emits them that way). Compile
  // them to functions once here and merge into the module-level handlers
  // lookup for this rule's dispatch. On the disk-loaded path this field
  // is absent — handlers already arrive as real functions via the patch
  // module's handlers/*.js.
  const effectiveHandlers: HandlerMap = rule.handlers
    ? { ...handlers, ...compileInlineHandlers(rule.handlers, spec) }
    : handlers;

  // anchor -> { outputs: HTMLElement[], cleanups: Function[] }
  // Map (not WeakMap) so we can iterate and prune anchors that left the DOM,
  // tearing down their portal/overlay listeners and removing nodes we parked
  // in document.body.
  const state = new Map<Element, RuleMountEntry>();
  const inFlight = new WeakSet<Element>();

  // Zero-match warning state — declared up here so scan() (defined below)
  // can clear the timer when something finally anchors. Wire-up (timer
  // schedule + teardown clear) happens after scan is defined.
  let noMatchTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let noMatchReported = false;
  // Witness state: capture fires at most once per lifecycle; the latest
  // rejection verdict feeds the settle-delayed unresolved reporter.
  let witnessCaptured = false;
  let lastWitnessRejection: RejectedSample | null = null;
  // Rebase state (§14): the latest scan's resolution, read by the
  // settle-delayed rebase reconciler. `lastResolvedEl` is the single
  // resolved element (for capturing a fresh witness on a promote); null
  // when zero or multiple matched.
  let lastResolvedEl: Element | null = null;
  let rebaseReported = false;

  // Rule-status reporting for the inspector panel. We only emit when the
  // current anchor count changes (transitioned from N → M, where N ≠ M),
  // not on every scan — most scans are no-ops because the DOM churns
  // around the rule's anchor without affecting it. `lastReportedCount`
  // starts at -1 so the first scan always emits, even if it resolves 0
  // anchors (the inspector wants to know "rule is mounted but not yet
  // matching" which is distinct from "rule hasn't run").
  let lastReportedCount = -1;
  let lastReportedSource: string | null = '__unset__';
  // `matchedVia` carries which anchor spec ended up resolving — `'primary'`,
  // `'fallback:0'`, ..., or `null` when nothing matched. Tracked separately
  // from count because a rule can keep its match count steady while
  // sliding from primary to a fallback (e.g. site renames `data-testid`,
  // primary now zero, fallback aria-role takes over with the same count).
  // Inspector surfaces this so users can spot "rule still works, but the
  // primary I wrote is now wrong."
  let lastMatchedSource: string | null = null;
  // Apply-time precondition notes for the layout kinds (§6): computed-style
  // checks whose failure means the compiled CSS silently does nothing
  // (reorder under a block parent, grid templates on a flex container).
  // Joined into the rule-status `note` so the authoring loop sees them
  // mid-turn and self-corrects. Diagnostics only — never behavior changes.
  const hasLayoutKind = (rule.mutations || []).some((m) => m.kind === 'reorder' || m.kind === 'reshape');
  // Assigned by the relative-reorder restamp path (`restampRelativeReorder`,
  // defined below) every scan pass — never null-initialized-and-forgotten,
  // so this genuinely needs `let`.
  let relativeReorderNote: string | null = null;
  const layoutNote = (el: Element | undefined): string | null => {
    const notes: string[] = [];
    if (el && hasLayoutKind) {
      const win = el.ownerDocument.defaultView;
      if (win) {
        for (const mut of rule.mutations || []) {
          if (mut.kind === 'reorder') {
            const parent = el.parentElement;
            const n = reorderNote(parent ? win.getComputedStyle(parent).display : null);
            if (n) notes.push(n);
          } else if (mut.kind === 'reshape') {
            const n = reshapeNote(mut, win.getComputedStyle(el).display);
            if (n) notes.push(n);
          }
        }
      }
    }
    if (relativeReorderNote) notes.push(relativeReorderNote);
    const stripNote = injectStripNotes.get(`${spec.id}/${rule.id}`);
    if (stripNote) notes.push(stripNote);
    return notes.length ? notes.join('; ') : null;
  };
  let lastReportedNote: string | null = null;
  const reportStatusIfChanged = () => {
    const first: Element | undefined = state.size ? state.keys().next().value : undefined;
    const note = layoutNote(first);
    if (state.size === lastReportedCount && lastMatchedSource === lastReportedSource
      && note === lastReportedNote) return;
    lastReportedCount = state.size;
    lastReportedSource = lastMatchedSource;
    lastReportedNote = note;
    if (typeof api.reportEvent !== 'function') return;
    // Measured box of the first matched anchor (viewport CSS px, post-apply —
    // tier-1 stamps land synchronously in mountOn, and mountOn's .finally
    // re-report runs after handler mounts too). This is the deterministic
    // half of authoring-time visual verification: "make X the same size as
    // Y" is a numbers problem, and the authoring feedback loop reads this
    // straight out of the rule-status event instead of eyeballing a
    // screenshot. Zero matches → no box; multi-match → first element only
    // (representative, and the common visual-tuning case is single-target).
    let box: { x: number; y: number; w: number; h: number } | undefined;
    if (first) {
      const r = first.getBoundingClientRect();
      box = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }
    api.reportEvent('rule-status', {
      specId: spec.id,
      ruleId: rule.id,
      matched: state.size,
      matchedVia: lastMatchedSource,
      ...(box ? { box } : {}),
      ...(note ? { note } : {}),
    });
  };

  // Relative reorder (§6): "immediately before/after Y" is a whole-sibling
  // ordering, not a single-element style — CSS `order` is a sort key across
  // ALL siblings (default 0), so the engine stamps EVERY child of the shared
  // parent with an explicit order matching the desired sequence. DOM (source)
  // order is stable under CSS order, so recomputing from it is idempotent;
  // scan() calls this every pass, folding in new siblings after re-renders.
  // Stamping proceeds even when the parent isn't flex/grid yet — harmless
  // (order is inert elsewhere), and a same-shim reshape on the parent makes
  // the stamps live the moment it applies. layoutNote carries the warning.
  const relativeMut = (rule.mutations || []).find(
    (m) => m.kind === 'reorder' && (m.before !== undefined || m.after !== undefined),
  );
  const relativeBase = `shim-${spec.id}-${rule.id}-reorder`;
  const relativeTokens = new Set<string>();
  const stripStaleIndexTokens = (child: Element, keep: string): void => {
    const attr = child.getAttribute('data-shim-css') || '';
    for (const t of attr.split(/\s+/)) {
      if (t && t !== keep && t.startsWith(`${relativeBase}-`)) stripToken(child, t);
    }
  };
  const restampRelativeReorder = (resolved: Element[]): void => {
    if (!relativeMut) return;
    relativeReorderNote = null;
    if (resolved.length === 0) return; // no-match reporting covers this
    if (resolved.length > 1) {
      relativeReorderNote = `reorder: before/after needs a single-match anchor (matched ${resolved.length}) — narrow the anchor or use position`;
      return;
    }
    const el: Element | undefined = resolved[0];
    const targetSpec = relativeMut.before ?? relativeMut.after;
    if (!el || !targetSpec) return;
    const mode: 'before' | 'after' = relativeMut.before ? 'before' : 'after';
    const targets = anchors.resolveAll({ primary: targetSpec }, document);
    if (targets.length !== 1) {
      relativeReorderNote = targets.length === 0
        ? 'reorder: before/after target not found on this page'
        : `reorder: before/after target matched ${targets.length} elements — needs exactly 1`;
      return;
    }
    const target = targets[0];
    const parent = el.parentElement;
    if (!parent || !target || target.parentElement !== parent) {
      relativeReorderNote = 'reorder: target is not a sibling of the anchor — before/after only reorders within one container';
      return;
    }
    if (target === el) {
      relativeReorderNote = 'reorder: before/after target resolves to the anchor itself — pick a different sibling';
      return;
    }
    const children = Array.from(parent.children);
    if (children.length > REORDER_SIBLING_CAP) {
      relativeReorderNote = `reorder: container has ${children.length} children (cap ${REORDER_SIBLING_CAP}) — likely a virtualized list; use position or a different container`;
      return;
    }
    const seq = desiredSequence(children, el, target, mode);
    if (!seq) return;
    seq.forEach((child, i) => {
      const token = `${relativeBase}-${i}`;
      stripStaleIndexTokens(child, token);
      tagElement(child, token);
      if (!relativeTokens.has(token)) {
        injectTier1Rule(token, `order: ${i} !important;`, cssPriorityOf(spec));
        relativeTokens.add(token);
      }
    });
  };
  // Note on observer feedback: stamping writes `data-shim-css` attributes,
  // and the rule's MutationObserver (below) watches `childList`/`subtree`
  // only (not attributes) — so restamping cannot re-trigger scans (no
  // loop). A sibling REMOVED later leaves its index rule in the sheet
  // unmatched — harmless, cleaned at teardown. Likewise, if the ANCHOR
  // migrates to a different parent, the old container's children keep
  // their stamps until rule teardown (accepted — cleaned by the teardown
  // sweep, not re-derived per-scan).

  async function mountOn(el: Element): Promise<void> {
    const outputs: HTMLElement[] = [];
    const cleanups: Array<() => void> = [];
    // Per-mount api proxy. Handlers call `api.cleanup(fn)` to register
    // tear-down work — event listeners on document, intervals, inner
    // MutationObservers, anything that won't unwind by itself when the
    // handler's returned DOM is removed. The engine runs each fn when
    // the anchor leaves the DOM (scan-time pruning) or the rule itself
    // tears down (toggle-off / shim-delete / patch teardownAll). Cleanups
    // run in registration order, BEFORE the strategy cleanup that
    // unparks portal/overlay nodes — so handler state is gone before
    // the DOM it observed disappears.
    //
    // `Object.create(api)` prototypically inherits storage/bridge/host/
    // reportEvent/etc. from the shared api, then we add `cleanup` as an
    // own property scoped to this mount's `cleanups` array. Concurrent
    // mounts of the same rule on different anchors get distinct proxies
    // — one anchor's cleanup registrations don't leak into another's.
    const mountApi: ShimApi = Object.assign(Object.create(api) as ShimApiBase, {
      cleanup(fn: () => void) {
        if (typeof fn === 'function') cleanups.push(fn);
      },
    });
    for (const mut of rule.mutations || []) {
      const raw = await dispatchMutation(el, mut, rule, spec, mountApi, mutations, effectiveHandlers);
      // dispatchMutation's contract is the broader `Node[]` (handlers may
      // return any Node); applyStrategy's portal/overlay/shadow machinery
      // needs `.style`/`.offsetHeight` and so is typed against
      // `HTMLElement` (strategies.ts). Every real mount target is one in
      // practice — script/replace-root handlers build ordinary elements —
      // so this is a boundary cast, not a loosening of either contract.
      const { placed, cleanup } = applyStrategy(raw as HTMLElement[], el as HTMLElement, mut);
      outputs.push(...placed);
      if (cleanup) cleanups.push(cleanup);
    }
    state.set(el, { outputs, cleanups });
    // Register with the module-level own-DOM registry (see above) so no
    // rule's anchor resolution — this rule's or any other patch's — can
    // ever re-match this mount's output and re-dispatch onto it.
    for (const o of outputs) mountedOutputRoots.add(o);
  }

  function teardownEntry(entry: RuleMountEntry) {
    for (const fn of entry.cleanups) {
      try { fn(); } catch (err) { console.error('[shim] cleanup failed', err); }
    }
    for (const node of entry.outputs) {
      mountedOutputRoots.delete(node);
      node.remove();
    }
  }

  const scan = () => {
    // Prune anchors that are no longer in the DOM. Without this, portal-mounted
    // widgets (which live in document.body, unrelated to the anchor's parent)
    // would leak when the anchor unmounts.
    for (const [anchor, entry] of state) {
      if (!document.contains(anchor)) {
        teardownEntry(entry);
        state.delete(anchor);
      }
    }

    // Only reached for anchored rules — setupRule forks iframe / mount-route
    // / redirect rules to their own lifecycles before falling through to
    // applyRule, so `rule.anchor` is always present here for a well-formed
    // spec. The shared `Rule` type keeps it optional to also describe those
    // anchor-less rule shapes.
    const { nodes: resolvedNodes, source, witnessRejected, rejectedSample } =
      anchors.resolveAllWithSource(rule.anchor as Anchor);
    // Own-DOM guard (see above): drop any candidate that's inside DOM the
    // engine itself mounted before anything downstream sees it — witness
    // capture, the mount loop, tier-1 stamping (`hide`/`restyle` go through
    // the same `nodes` list, so a shim styling its own output would need a
    // handler, not an anchor), relative-reorder restamping. Deliberately
    // NOT folded into `anchors.resolveAllWithSource` itself: witness/
    // no-match semantics read raw resolution counts, and an all-owned
    // resolution correctly falls through to the existing no-match path here
    // (0 nodes after filter) rather than needing a distinct signal.
    // Inject-kind outputs are covered twice: they're registered in
    // `mountedOutputRoots` like any returned output, and their
    // `data-shim-injected` stamp is an own-DOM marker (OWN_DOM_SELECTOR) —
    // so the guard holds even for a detached-and-reattached injected node
    // the registry no longer tracks.
    const nodes = resolvedNodes.filter((el) => !isShimOwnedElement(el, mountedOutputRoots));
    // Track which spec carried the rule this scan. When state.size goes
    // to 0 (no match), we keep the last source for context — the inspector
    // can still show "previously via fallback:0" if useful, though today
    // we just null it. The matchedVia is most informative right when
    // mounts exist; on no-match it's redundant with `state.size === 0`.
    lastMatchedSource = source;
    // Remember the latest witness verdict so the settle-delayed reporter
    // can tell quarantine ("selector found something that isn't the
    // thing") apart from plain no-match ("selector found nothing").
    lastWitnessRejection = witnessRejected ? (rejectedSample || { detail: [] }) : null;
    // Snapshot resolution for the settle-delayed rebase reconciler. Unlike
    // the raw resolve above, `nodes` here is already filtered — a single
    // engine-injected match reads as zero, not one.
    const [singleNode] = nodes;
    lastResolvedEl = nodes.length === 1 ? (singleNode ?? null) : null;

    // Witness capture (§8): a rule without a witness that resolves to
    // exactly ONE element gets fingerprinted, and the fingerprint is
    // reported up. During authoring previews the loop attaches it to the
    // rule before commit; for committed rules the event is groundwork for
    // the rebase pass to backfill. Once per applyRule lifecycle — the
    // shape doesn't change scan-to-scan, and re-emitting on churn would
    // be noise. Multi-match rules skip capture: one witness can't
    // describe N different elements (§8 v1 scope).
    if (!witnessCaptured && !rule.anchor?.witness && nodes.length === 1 && singleNode) {
      witnessCaptured = true;
      const el = singleNode;
      const w = witnessMod.buildWitness(el);
      if (w && typeof api.reportEvent === 'function') {
        // Enrich with framework-component-identity via the main-world bridge
        // (§8) before emitting — the isolated world can't read fibers itself.
        // Resolves null on non-React pages / no bridge, in which case the
        // witness simply omits `component`. The slight defer is harmless: this
        // event is groundwork the authoring loop / rebase pass consume async.
        const emit = () => api.reportEvent('rule-witness', {
          specId: spec.id,
          ruleId: rule.id,
          witness: w,
        });
        const verifyFn = api.componentId && api.componentId.verify;
        if (typeof verifyFn === 'function') {
          // Store the identity in ORIGINAL-name space when the deploy's symbol
          // map is available (§8 Stage B): `Wc` → `TrackRow`. That's what makes
          // the witness deploy-durable — the next build renames Wc to Xd, but
          // both translate back to TrackRow. No map (or Discovery not finished
          // yet) → raw names, exactly the pre-Stage-B behavior.
          Promise.resolve()
            .then(() => Promise.all([verifyFn(el), getSymbols(api)]))
            .then(([cid, syms]) => {
              if (cid && Array.isArray(cid.path) && cid.path.length) {
                const t = componentId.translateComponent(cid, syms);
                // `mapped: true` marks a witness whose names only exist through
                // a symbol map (translation actually renamed them) — the verify
                // veto then refuses to score it raw against minified fibers
                // when no map is available (see matchComponent). Untranslated
                // captures (no map, or names already original) stay unmarked.
                // (translateComponent's signature allows null/undefined for
                // callers with a possibly-absent descriptor; `cid` is already
                // verified non-empty above, so `t` is always populated here —
                // this guard just satisfies the type, not a behavior change.)
                if (t) w.component = t !== cid ? { ...t, mapped: true } : t;
              }
            })
            .catch(() => {})
            .finally(emit);
        } else {
          emit();
        }
      }
    }
    for (const el of nodes) {
      if (inFlight.has(el)) continue;
      const existing = state.get(el);
      if (existing) {
        // Opted out of self-healing (no outputs returned) — never re-mount.
        if (existing.outputs.length === 0) continue;
        // All outputs still attached — mounted state is healthy.
        if (existing.outputs.every((n) => document.contains(n))) continue;
        // Something got stomped: tear down and re-mount.
        teardownEntry(existing);
        state.delete(el);
      }
      inFlight.add(el);
      mountOn(el).finally(() => {
        inFlight.delete(el);
        // mountOn updates state.size as it inserts. Re-report so the
        // inspector sees the bump even when the surrounding scan() found
        // no further changes.
        reportStatusIfChanged();
      });
    }

    restampRelativeReorder(nodes);
    reportStatusIfChanged();
  };

  // rAF-coalesce the observer — React-style reconcilers can fire hundreds
  // of mutation batches per second during normal re-rendering, and each
  // scan runs a `querySelectorAll` per rule. One scan per frame is plenty
  // for self-healing and keeps the renderer's CPU baseline low.
  let scanHandle = 0;
  const scheduleScan = () => {
    if (scanHandle) return;
    scanHandle = requestAnimationFrame(() => {
      scanHandle = 0;
      scan();
    });
  };

  scan();

  // Settle-delayed reconciliation. After the page has had a beat to render
  // (React hydration, async content), look once at how the rule resolved and
  // act. This subsumes the old no-match/quarantine reporter and adds the
  // rebase pass (§14):
  //   - resolving via PRIMARY on a changed bundle → just refresh the stored
  //     baseline hash (no anchor change), so the next deploy is measured
  //     against the current bundle (keeps A/B vs deploy honest).
  //   - resolving via a FALLBACK on a changed bundle → the primary died in a
  //     deploy; promote the working fallback to primary (Strategy 1).
  //   - resolving NOTHING on a changed bundle → scan for the target by its
  //     witness and re-anchor to it (Strategy 2); if that can't find a
  //     unique strong match, emit the existing no-match / quarantine signal.
  // The bundle gate avoids rewriting anchors over a transient A/B variant or
  // logged-out state (same bundle → the element returns on its own). The
  // witness stays the safety net: every rebase TARGET must pass it, so even a
  // mis-fired gate can't mis-attach — worst case it no-ops. Fires once.
  const SETTLE_DELAY_MS = 1500;
  // One extra beat granted before a deploy-path miss escalates to
  // quarantine/recovery-failure — covers content that renders after settle
  // (see the late-render grace note in reconcile).
  const RECONCILE_RETRY_MS = 2500;
  let reconcileRetried = false;
  // Why the deterministic recoveries refused, for the quarantine that follows
  // — "component-id: no match; witness-scan: ambiguous — 2 disjoint strong
  // matches". Emitted on the quarantine event + diagnostics so a failed
  // recovery is debuggable after the fact instead of silently escalating.
  let lastRecoveryDetail: string | null = null;
  // The current page fingerprint, resolved lazily here (not at run() time):
  // boot() builds the getter before the page's scripts are in the DOM, so it
  // would compute null then. By reconcile time the DOM is settled.
  let currentBundle: string | null = null;
  const summarizeAnchor = (a: Anchor | undefined): string => {
    const p = a && a.primary;
    if (!p) return '(none)';
    return `${p.kind}:${p.value || p.name || p.role || p.label || ''}`;
  };
  // Fallbacks for a recovered anchor: the synthesis ladder's runner-up rungs
  // first (fresh, verified against the found element — they give the NEXT
  // deploy something to promote from), then the rule's previous fallbacks
  // (A/B-flip insurance), deduped against the new primary and each other,
  // capped so the ladder never grows without bound across repeated recovers.
  const mergeFallbacks = (ladder: AnchorSpec[], prevFallbacks: AnchorSpec[] | undefined): AnchorSpec[] => {
    const seen = new Set<string>([JSON.stringify(ladder[0])]);
    const out: AnchorSpec[] = [];
    const prev = Array.isArray(prevFallbacks) ? prevFallbacks : [];
    for (const candidate of [...ladder.slice(1), ...prev]) {
      const key = JSON.stringify(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
      if (out.length >= 4) break;
    }
    return out;
  };
  const reportUnresolved = () => {
    if (typeof api.reportEvent !== 'function') return;
    if (lastWitnessRejection) {
      api.reportEvent('rule-quarantined', {
        specId: spec.id,
        ruleId: rule.id,
        selector: rule.anchor?.primary?.value || '',
        expected: rule.anchor?.witness || null,
        seen: lastWitnessRejection.detail || [],
        rejectedVia: lastWitnessRejection.source || null,
        recovery: lastRecoveryDetail,
      });
      return;
    }
    api.reportEvent('rule-no-match', {
      specId: spec.id,
      ruleId: rule.id,
      selector: rule.anchor?.primary?.value || '',
    });
  };
  const emitRebase = (payload: Record<string, unknown>) => {
    if (rebaseReported || typeof api.reportEvent !== 'function') return;
    rebaseReported = true;
    api.reportEvent('rule-rebase', {
      specId: spec.id,
      ruleId: rule.id,
      bundleHash: currentBundle,
      ...payload,
    });
  };
  const reconcile = async () => {
    noMatchTimer = 0;
    if (rebaseReported || noMatchReported) return;
    // Resolve the current bundle hash now (DOM is settled). A deploy is when
    // the shim has a stored baseline that differs from it.
    try { currentBundle = spec.__bundleHashFn(); } catch (_) { currentBundle = null; }
    const baselineStale = typeof currentBundle === 'string' && currentBundle !== spec.bundleHash;
    const deploy = typeof spec.bundleHash === 'string' && baselineStale;
    // Per-shim auto-repair (§14). On by default; when off, a deploy that
    // breaks the anchor is NOT silently re-pointed — it surfaces as
    // no-match / quarantine so the user decides. The baseline refresh below
    // (primary path) still runs either way: it only tracks the bundle hash,
    // never changes an anchor, and keeps the gate honest if they re-enable.
    const canRebase = deploy && spec.autoRepair !== false;

    // Resolving cleanly via primary — keep the stored baseline current.
    // Fires when the baseline is MISSING (freshly-committed shim → initialize
    // the gate) or STALE (deploy the primary survived → advance it). Skips
    // when already current. This is what bootstraps the deploy gate: a shim
    // can only be judged "deployed since last reconciled" once it has a
    // baseline, and a clean primary resolution is when we record one.
    if (state.size > 0 && lastMatchedSource === 'primary') {
      // Component-identity verification (§8). The sync resolve path filters by
      // the witness's tag/attr/text/child signals but CAN'T read fibers, so the
      // strongest signal is checked here via the main-world bridge. A confident
      // mismatch means the selector latched onto the wrong element (right
      // tag/attrs, wrong component) — a mis-attach, quarantined like any other
      // witness rejection. Checked regardless of deploy: never silently
      // mis-attach is the core contract, deploy or not. The bridge resolving
      // null (non-React / timeout) → applicable:false → skipped, never failed.
      //
      // Captured into a local const BEFORE the `await`s below: narrowing of a
      // dotted property path like `rule.anchor?.witness?.component` doesn't
      // survive an intervening async call, so `expectedComponent` is what
      // carries the non-null fact across them.
      const expectedComponent = rule.anchor?.witness?.component;
      if (lastResolvedEl && expectedComponent &&
          api.componentId && typeof api.componentId.verify === 'function') {
        const actual = await api.componentId.verify(lastResolvedEl);
        // Dual raw/translated scoring (§8 Stage B): the stored identity may be
        // in original-name space (new witnesses) or minified space (pre-map
        // witnesses); matchComponent takes the max of comparing the live fiber
        // names raw and translated through the deploy's symbol map, so neither
        // generation false-quarantines.
        const syms = await getSymbols(api);
        const verdict = componentId.matchComponent(expectedComponent, actual, syms);
        if (verdict.applicable && !verdict.pass) {
          noMatchReported = true;
          if (typeof api.reportEvent === 'function') {
            const seen = actual && Array.isArray(actual.path) ? actual.path.join(' > ') : 'none';
            api.reportEvent('rule-quarantined', {
              specId: spec.id,
              ruleId: rule.id,
              selector: rule.anchor?.primary?.value || '',
              expected: rule.anchor?.witness,
              seen: [`component: expected [${expectedComponent.path.join(' > ')}], saw [${seen}]`],
              rejectedVia: 'primary',
            });
          }
          return;
        }
      }
      if (baselineStale && typeof api.reportEvent === 'function') {
        api.reportEvent('spec-bundle-update', {
          specId: spec.id,
          bundleHash: currentBundle,
        });
      }
      return;
    }

    // Resolving via a fallback — the primary is dead. On a deploy, promote
    // the working fallback to primary and demote the dead primary (keep it
    // as a fallback — cheap insurance if the site A/B-flips back). Same
    // bundle → leave the ladder alone; matchedVia already surfaces it.
    if (state.size > 0 && typeof lastMatchedSource === 'string' &&
        lastMatchedSource.startsWith('fallback:')) {
      // Not a deploy, or auto-repair off → leave the ladder as-is. The rule
      // still works via the fallback; matchedVia already surfaces that the
      // primary is stale, so nothing is broken for the user to see.
      if (!canRebase) return;
      const idx = parseInt(lastMatchedSource.slice('fallback:'.length), 10);
      // Same "only reached for anchored rules" invariant as scan()'s resolve
      // call — a 'fallback:N' matchedVia can only have been produced by a
      // rule whose anchor (primary + fallbacks) was actually resolved.
      const definiteAnchor = rule.anchor as Anchor;
      const fallbacks = Array.isArray(definiteAnchor.fallbacks) ? definiteAnchor.fallbacks : [];
      const promoted = fallbacks[idx];
      if (!promoted) return;
      const newAnchor: Anchor = {
        primary: promoted,
        fallbacks: [definiteAnchor.primary, ...fallbacks.filter((_, i) => i !== idx)],
      };
      // Carry the component identity into the refreshed witness — it names the
      // COMPONENT, not the markup, so it stays valid across the promote (and,
      // stored in original-name space, across deploys). Rebuilding without it
      // silently dropped the strongest signal on every promotion.
      const fresh = lastResolvedEl
        ? witnessMod.buildWitness(lastResolvedEl, { component: definiteAnchor.witness?.component })
        : null;
      if (fresh) newAnchor.witness = fresh;
      else if (definiteAnchor.witness) newAnchor.witness = definiteAnchor.witness;
      emitRebase({
        strategy: 'promote',
        anchor: newAnchor,
        from: summarizeAnchor(rule.anchor),
        to: summarizeAnchor(newAnchor),
      });
      return;
    }

    // Resolving nothing. On a deploy with a witness (and auto-repair on), try
    // to recover the target by scanning for it; else emit the no-match /
    // quarantine signal (which is also the auto-repair-off behavior — the
    // drift surfaces instead of self-healing).
    if (state.size === 0) {
      const hasWitness = !!rule.anchor?.witness;
      const recoveryNotes: string[] = [];
      // Component-identity recovery (§8), tried first because it's the strongest
      // signal: the selector died, but the component that rendered the target
      // may still be on the page. The main-world helper scans for nodes whose
      // fiber identity matches the captured one; a UNIQUE match re-anchors. This
      // catches the exact deploy class css anchors can't survive — markup/class
      // rewrite with the React tree intact. Falls through to witnessRecover
      // (tag/attr/text scan) when there's no component witness or no unique hit.
      const storedComponent = rule.anchor?.witness?.component;
      if (canRebase && storedComponent &&
          api.componentId && typeof api.componentId.find === 'function') {
        // The stored identity is (for post-map witnesses) in ORIGINAL-name
        // space; live fibers carry the CURRENT deploy's minified names. Invert
        // the symbol map (original→minified; ambiguous originals dropped) and
        // scan for BOTH the translated and the raw descriptor — the helper
        // scores max across the list. This is the cross-deploy payoff: a
        // TrackRow witness finds the node now named Xd. No map → raw only,
        // the pre-Stage-B behavior.
        const stored = storedComponent;
        const syms = await getSymbols(api);
        const toMin = componentId.translateComponent(stored, componentId.invertSymbols(syms));
        // `toMin` is only ever null/undefined per translateComponent's general
        // signature — with a defined, non-empty `stored` input (guaranteed by
        // the guard above) every one of its return paths yields a real
        // descriptor. The truthy check just narrows the type for the array
        // literal below; it's never false in practice.
        const expectedList = toMin && toMin !== stored ? [toMin, stored] : stored;
        const matches = await api.componentId.find(expectedList);
        // `matched`/`ladderHead` are the "first element" idiom: the length
        // checks above/below guarantee they're present, but the guard keeps
        // the access honest rather than asserting it.
        const [rawMatch] = Array.isArray(matches) && matches.length === 1 ? matches : [];
        // Own-DOM guard (see near the top of this file): a unique
        // component-identity match is exactly what a handler's own mounted
        // output can produce after a deploy kills the real selector — the
        // fiber tree still reports the captured component name, just now on
        // DOM the engine itself created. Treat a shim-owned match as no
        // match at all so the arm falls through (to witnessRecover, then
        // quarantine) instead of committing a rebased anchor that points at
        // shim DOM, which the own-DOM scan filter would then treat as a
        // permanent no-match on every subsequent scan.
        const matched = rawMatch && !isShimOwnedElement(rawMatch, mountedOutputRoots) ? rawMatch : null;
        const ladder = matched ? anchors.suggestAnchorLadder(matched) : [];
        const [ladderHead] = ladder;
        if (matched && ladderHead) {
          const fresh = witnessMod.buildWitness(matched, { component: stored })
            || rule.anchor?.witness;
          emitRebase({
            strategy: 'recover',
            // `via` names the rung that found the element — component
            // identity (the strongest signal) vs the witness shape-scan.
            // Diagnostics-only: lets a human tell WHICH recovery fired.
            via: 'component-identity',
            anchor: {
              primary: ladderHead,
              fallbacks: mergeFallbacks(ladder, rule.anchor?.fallbacks),
              witness: fresh,
            },
            from: summarizeAnchor(rule.anchor),
            to: summarizeAnchor({ primary: ladderHead }),
          });
          return;
        }
        recoveryNotes.push(!Array.isArray(matches) || matches.length === 0
          ? 'component-id: no match'
          : rawMatch && !matched
            ? 'component-id: unique match is shim-created DOM'
            : `component-id: ${matches.length} matches (not unique)`);
      }
      if (canRebase && hasWitness) {
        const rec = anchors.witnessRecoverDetail(rule.anchor?.witness, document);
        const rawFound = rec.el;
        // Same own-DOM guard as the component-identity arm above: the
        // witness shape-scan walks every live element of the anchor's tag,
        // which includes anything the engine mounted. A shape match there
        // is never a legitimate recovery target.
        const found = rawFound && !isShimOwnedElement(rawFound, mountedOutputRoots) ? rawFound : null;
        const ladder = found ? anchors.suggestAnchorLadder(found) : [];
        const [ladderHead] = ladder;
        if (rec.reason) recoveryNotes.push(`witness-scan: ${rec.reason}`);
        else if (rawFound && !found) recoveryNotes.push('witness-scan: match is shim-created DOM');
        if (found && ladderHead) {
          emitRebase({
            strategy: 'recover',
            via: 'witness',
            anchor: {
              primary: ladderHead,
              fallbacks: mergeFallbacks(ladder, rule.anchor?.fallbacks),
              witness: witnessMod.buildWitness(found) || rule.anchor?.witness,
            },
            from: summarizeAnchor(rule.anchor),
            to: summarizeAnchor({ primary: ladderHead }),
          });
          return;
        }
      } else if (canRebase && !hasWitness) {
        // No witness at all (e.g. a prior bad commit dropped it): recovery is
        // structurally impossible and the rule can only ever report no-match.
        // Say so where a human debugging "why isn't this healing" will look.
        console.warn(
          `[shim] rule "${rule.id}" cannot auto-recover: no witness on the anchor `
          + '(re-commit the rule while it resolves to re-capture one)',
        );
      }
      lastRecoveryDetail = recoveryNotes.length ? recoveryNotes.join('; ') : null;
      // Late-render grace (one retry) for the two paths about to ESCALATE —
      // quarantine banner, and with auto-repair on, an LLM re-anchor turn:
      //
      //   - deploy + nothing resolved: SPA content routinely renders seconds
      //     after the settle delay (a dashboard card behind a data fetch), so
      //     the selector, the component scan, and the witness scan all missed
      //     an element that simply didn't exist yet. Found live: a heal the
      //     witness rung should have made for free fell to the LLM tier.
      //   - witness REJECTION (deploy or not): a generic selector can resolve
      //     the page's OTHER elements while the real target is still
      //     rendering — the veto correctly rejects those impostors, but
      //     quarantining on that single look escalates a transient
      //     mis-resolution to an LLM turn even though the target mounts fine
      //     moments later (found live: two wasted AI turns ~40min apart on a
      //     healthy shim). The veto stays deploy-independent — only the
      //     ESCALATION waits one beat.
      //
      // On the retry, a now-rendered target either mounted via the scan loop
      // (state > 0 → healthy verify path) or gives the recovery scans a real
      // shot. Plain non-deploy no-match stays single-pass — rule-no-match is
      // transient/informational and authoring wants that feedback promptly.
      if (!reconcileRetried && (deploy || lastWitnessRejection)) {
        reconcileRetried = true;
        noMatchTimer = setTimeout(reconcile, RECONCILE_RETRY_MS);
        return;
      }
      noMatchReported = true;
      // Deploy + a witness we couldn't deterministically recover → the element
      // changed beyond witness recognition (e.g. a tag swap killed the
      // selector AND the witness can't re-find it). That's a real break that
      // needs the LLM, not a transient absence — route it into the
      // quarantine/re-anchor flow (banner + auto-reanchor). Gated on `deploy`
      // (NOT auto-repair) so it still surfaces for manual review when
      // auto-repair is off; the auto-fire itself is auto-repair-gated
      // downstream (shouldAutoReanchor). Without a deploy, a bare no-match
      // stays transient (reportUnresolved → rule-no-match). The empty `seen`
      // distinguishes this from a witness-rejection quarantine (nothing
      // resolved, so there's no element to diff against).
      // Only a *true* no-match (selector matched nothing) routes here. A
      // witness-rejection (selector resolved a wrong element → lastWitnessRejection
      // set) falls through to reportUnresolved, which emits the quarantine WITH
      // its expected-vs-seen diff — don't preempt that and lose the diff.
      if (deploy && hasWitness && !lastWitnessRejection) {
        if (lastRecoveryDetail) {
          console.warn(`[shim] rule "${rule.id}" recovery failed → quarantine (${lastRecoveryDetail})`);
        }
        if (typeof api.reportEvent === 'function') {
          api.reportEvent('rule-quarantined', {
            specId: spec.id,
            ruleId: rule.id,
            selector: rule.anchor?.primary?.value || '',
            expected: rule.anchor?.witness,
            seen: [],
            rejectedVia: null,
            recovery: lastRecoveryDetail,
          });
        }
        return;
      }
      reportUnresolved();
    }
  };
  noMatchTimer = setTimeout(reconcile, SETTLE_DELAY_MS);

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  return function teardownRule() {
    observer.disconnect();
    if (scanHandle) {
      cancelAnimationFrame(scanHandle);
      scanHandle = 0;
    }
    if (noMatchTimer) {
      clearTimeout(noMatchTimer);
      noMatchTimer = 0;
    }
    for (const [anchor, entry] of state) {
      teardownEntry(entry);
      for (const mut of rule.mutations || []) {
        if (mut.kind === 'hide' || mut.kind === 'restyle' || mut.kind === 'reorder' || mut.kind === 'reshape') {
          stripToken(anchor, `shim-${spec.id}-${rule.id}-${mut.kind}`);
        } else if (mut.kind === 'replace-root') {
          stripReplaceRootToken(anchor, `shim-${spec.id}-${rule.id}-replace-root`);
        }
      }
    }
    state.clear();
    for (const mut of rule.mutations || []) {
      if (mut.kind === 'hide' || mut.kind === 'restyle' || mut.kind === 'reorder' || mut.kind === 'reshape') {
        removeTier1Rule(`shim-${spec.id}-${rule.id}-${mut.kind}`);
      } else if (mut.kind === 'replace-root') {
        removeReplaceRootRule(`shim-${spec.id}-${rule.id}-replace-root`);
      }
    }
    // Relative-reorder index tokens: rules keyed per sibling index, stamped
    // on elements that aren't this rule's anchors — swept independently.
    for (const token of relativeTokens) {
      removeTier1Rule(token);
      for (const el of Array.from(document.querySelectorAll(`[data-shim-css~="${token}"]`))) {
        stripToken(el, token);
      }
    }
    relativeTokens.clear();
    injectStripNotes.delete(`${spec.id}/${rule.id}`);
  };
}

// A rule whose anchor declares `iframe: { kind: 'css', value }` targets elements
// inside a child iframe instead of this frame. Resolve the iframe(s) locally,
// derive each one's origin from its `src`, then ask main to deliver the rule
// (with the iframe field stripped) to every frame of that origin. The iframe's
// own engine receives it via bridge:rule and applies it locally.
//
// Returns a teardown fn that disconnects the observer and cancels any pending
// rAF. Forwarded rules already applied in child frames aren't recalled —
// teardown-by-source is a separate bridge concern not wired yet.
function bridgeRule(rule: Rule, spec: Spec, api: ShimApiBase): () => void {
  if (!api.bridge?.forwardRule) {
    console.warn('[shim] anchor.iframe set but api.bridge unavailable');
    return () => {};
  }
  const sel = rule.anchor?.iframe;
  if (sel?.kind !== 'css') {
    console.warn('[shim] anchor.iframe currently only supports kind:"css"');
    return () => {};
  }

  // `sel` is only ever derived from `rule.anchor?.iframe`, so having reached
  // here (past the `sel?.kind !== 'css'` check) means `rule.anchor` itself is
  // necessarily defined too.
  const anchor = rule.anchor as Anchor;
  const innerRule = { ...rule, anchor: { ...anchor } };
  delete innerRule.anchor.iframe;

  // iframe element → last origin we forwarded to. When an iframe navigates
  // cross-origin (src changes) we re-forward to the new origin.
  const forwardedTo = new Map<Element, string>();

  const scan = () => {
    for (const el of forwardedTo.keys()) {
      if (!document.contains(el)) forwardedTo.delete(el);
    }
    for (const el of document.querySelectorAll(sel.value)) {
      const src = el.getAttribute('src');
      if (!src) continue;
      let origin: string;
      try {
        origin = new URL(src, location.href).origin;
      } catch {
        continue;
      }
      if (forwardedTo.get(el) === origin) continue;
      forwardedTo.set(el, origin);
      api.bridge.forwardRule(origin, innerRule, spec.id);
    }
  };

  let scanHandle = 0;
  const scheduleScan = () => {
    if (scanHandle) return;
    scanHandle = requestAnimationFrame(() => {
      scanHandle = 0;
      scan();
    });
  };

  scan();
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  return function teardownBridgeRule() {
    observer.disconnect();
    if (scanHandle) {
      cancelAnimationFrame(scanHandle);
      scanHandle = 0;
    }
  };
}

// A rule carrying a `mount-route` mutation registers a virtual route: a URL
// path pattern (`/budgets`, `/budgets/:id`) plus a handler that renders the
// page for matching navigations. Two entry paths converge here:
//
//   - Soft nav: the user clicks an <a> whose path matches, or back/forward
//     lands on a matching path. We intercept clicks (preventDefault +
//     history.pushState) and listen for popstate. No server round-trip.
//   - Hard load: the user types the URL or reloads. Main serves a same-origin
//     local shell for registered routes (see src/main/route-protocol.js), so
//     the document loads at the real URL with the site's session intact; the
//     engine boots and `evaluate()` below sees the path already matches.
//
// Both reduce to one question — does `location.pathname` match the pattern? —
// so mounting is identical regardless of how the path was reached. The page
// itself is mounted at `document.body` and the site's own body children are
// hidden, reusing the Tier-4 `replace-root` token machinery.
function routeRule(rule: Rule, spec: Spec, api: ShimApiBase, handlers: HandlerMap): () => void {
  const effectiveHandlers: HandlerMap = rule.handlers
    ? { ...handlers, ...compileInlineHandlers(rule.handlers, spec) }
    : handlers;

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
  const handlerFn = effectiveHandlers[handlerName];
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

  // A `const` arrow (not a hoisted `function` declaration): TS's narrowing
  // of `mut` from the guard above doesn't survive into a hoisted function
  // body (it could in principle run before the narrowing check), but does
  // survive into a `const`-bound closure defined after it — which this
  // always is.
  const mountRoute = (m: { params: Record<string, string | undefined> }) => {
    const cleanups: Array<() => void> = [];
    const mountApi: ShimApi = Object.assign(Object.create(api) as ShimApiBase, {
      cleanup(fn: () => void) { if (typeof fn === 'function') cleanups.push(fn); },
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
    // without isolation the same handler output looks different per path
    // (site h1 sizing, fonts, even site-targeting Tier-1 rules leak in).
    // `all: initial` severs inherited properties (font, color) from the host
    // document for the same reason. Route pages are self-contained by
    // contract: they style themselves via inline styles or their own <style>.
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
    // site's own title would linger. `mutation.title` declares the route's;
    // the previous value is restored on unmount either way (handlers that set
    // document.title themselves are unwound by the same restore).
    const prevTitle = document.title;
    if (typeof mut.title === 'string') document.title = mut.title;
    // Match real-navigation behavior: a fresh route view starts at the top.
    try { window.scrollTo(0, 0); } catch { /* jsdom / detached */ }
    mounted = { outputs: [host], cleanups, path: routeMatch.normalizePath(location.pathname), prevTitle };
    reportStatus(1);
  };

  function unmountRoute() {
    if (!mounted) return;
    // Captured once so the narrowed (non-null) type survives the cleanup
    // calls below — TS conservatively widens a re-checked `let` back to
    // `MountedRoute | null` across an intervening function call.
    const entry = mounted;
    for (const fn of entry.cleanups) {
      try { fn(); } catch (err) { console.error('[shim] route cleanup failed', err); }
    }
    for (const node of entry.outputs) node.remove();
    if (document.body) stripReplaceRootToken(document.body, token);
    removeReplaceRootRule(token);
    removeRouteEnvRule(token);
    document.title = entry.prevTitle;
    mounted = null;
    reportStatus(0);
  }

  // The single source of truth: reconcile mounted-state against the current
  // path. Called on init (covers hard load), on every click we intercept,
  // and on popstate (back/forward). A path that still matches but changed
  // params (`/budgets/1` → `/budgets/2`) re-mounts so the handler re-renders
  // with the new params.
  function evaluate() {
    const here = routeMatch.normalizePath(location.pathname);
    const m = match(here);
    if (m && !mounted) mountRoute(m);
    else if (m && mounted && mounted.path !== here) { unmountRoute(); mountRoute(m); }
    else if (!m && mounted) unmountRoute();
  }

  function onClick(e: MouseEvent) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let the browser open new tab/window
    // composedPath()[0], not e.target: clicks inside the route page's shadow
    // root retarget to the host element at the document level, which would
    // hide the actual <a>. composedPath sees through the shadow boundary, so
    // route-to-route links inside a mounted page keep getting intercepted.
    const rawTarget: EventTarget | null = e.composedPath ? (e.composedPath()[0] ?? null) : e.target;
    // A click's target is always a DOM Node in practice (Element or a text
    // node inside one); `EventTarget` itself is too generic to carry
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
      history.pushState({}, '', url.pathname + url.search + url.hash);
    }
    evaluate();
  }

  function onPopState() { evaluate(); }
  // bfcache restores can land a frozen document on a different history entry
  // WITHOUT firing popstate (only pageshow with persisted=true). Re-evaluate
  // so a doc frozen on /notes and restored on / unmounts, and vice versa.
  function onPageShow(e: PageTransitionEvent) { if (e.persisted) evaluate(); }

  // Light self-heal: if a framework re-render detaches our mounted root while
  // the route is still active, re-attach it. The replace-root CSS keeps the
  // site's own (re-rendered) body children hidden on its own, so this only
  // has to worry about our own node going missing.
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

// Pick the right setup path for a rule. Route rules and iframe-bridge rules
// take dedicated lifecycles; everything else is a normal anchored rule.
function setupRule(rule: Rule, spec: RuntimeSpec, api: ShimApiBase, mutations: MutationRegistry, handlers: HandlerMap): () => void {
  if (rule.anchor?.iframe) return bridgeRule(rule, spec, api);
  if ((rule.mutations || []).some((m) => m.kind === 'mount-route')) {
    return routeRule(rule, spec, api, handlers);
  }
  // `redirect` rules are a network-layer concern handled entirely in main
  // (src/main/redirect-net.js rewrites the navigation before this page ever
  // loads). They have no DOM anchor, so running them down the normal anchored
  // path would emit a spurious `rule-no-match`. No-op here — same shape as
  // routeRule's teardown contract (a teardown fn the caller can call).
  if ((rule.mutations || []).some((m) => m.kind === 'redirect')) {
    return () => {};
  }
  return applyRule(rule, spec, api, mutations, handlers);
}

function run(patch: PatchBundle, api: ShimApiBase): PatchControl {
  const { mutations = {}, handlers = {} } = patch;
  // Stamp two runtime-only fields onto the spec so the deep rule-processing
  // path can read them without threading params through every signature.
  // Shallow copy keeps the authored spec untouched; preview/forwarded paths
  // that spread `spec` inherit both.
  //   - `__cssPriority` — cross-shim cascade priority for the tier-1 injector
  //     (main: user shims above platform fixtures; sidebar order among users).
  //   - `__bundleHashFn` — getter for the current page fingerprint, compared
  //     by the rebase pass against the stored `spec.bundleHash` to detect a
  //     deploy (§14). A getter (not a value) because it must be evaluated at
  //     reconcile time — boot() computes it before the page's scripts are in
  //     the DOM. A plain string is accepted too (tests/stubs).
  const bundleHashFn = typeof patch.bundleHash === 'function'
    ? patch.bundleHash
    : () => (typeof patch.bundleHash === 'string' ? patch.bundleHash : null);
  const spec: RuntimeSpec = {
    ...patch.spec,
    __cssPriority: Number.isFinite(patch.priority) ? patch.priority : 0,
    __bundleHashFn: bundleHashFn,
  };

  for (const { id, css } of collectCssForSpec(spec, mutations)) {
    const inject = () => injectStyle(id, css);
    if (document.head) inject();
    else document.addEventListener('DOMContentLoaded', inject, { once: true });
  }

  // Track teardowns for each rule in spec.rules so the whole patch can be
  // torn down live (sidebar toggle-off). Extra rules (previews + forwarded)
  // have their own lifecycle via extraTeardowns below.
  const ruleTeardowns: Array<() => void> = [];
  let tornDown = false;
  api.onReady(() => {
    if (tornDown) return;
    for (const rule of spec.rules || []) {
      ruleTeardowns.push(setupRule(rule, spec, api, mutations, handlers));
    }
  });

  // Extra rules are those applied *after* the patch's own spec.rules — used by
  // the preload for rules forwarded in from a parent frame's bridge, and by
  // the authoring UI for live previews. Keyed rules can be updated in place
  // (same key replaces previous apply) and torn down via `removeExtraRule`.
  const extraTeardowns = new Map<string, () => void>();

  return {
    applyExtraRule(rule: Rule, specIdOverride?: string, ruleKey?: string) {
      const effectiveSpec: RuntimeSpec = specIdOverride ? { ...spec, id: specIdOverride } : spec;
      api.onReady(() => {
        if (ruleKey) {
          const prev = extraTeardowns.get(ruleKey);
          if (prev) {
            prev();
            extraTeardowns.delete(ruleKey);
          }
        }
        const teardown = setupRule(rule, effectiveSpec, api, mutations, handlers);
        if (ruleKey) extraTeardowns.set(ruleKey, teardown);
      });
    },
    removeExtraRule(ruleKey: string) {
      const teardown = extraTeardowns.get(ruleKey);
      if (!teardown) return false;
      teardown();
      extraTeardowns.delete(ruleKey);
      return true;
    },
    // Tears down every rule this patch mounted (observers, mounted outputs,
    // Tier-1 CSS tokens). Leaves injected stylesheets (`mutation-<kind>` /
    // `patch-<id>`) in place — they're idempotent and may be shared with
    // other patches. Does NOT recall rules already forwarded into child
    // iframes via anchor.iframe; those persist in the iframe's stub engine
    // until navigation.
    teardownAll() {
      tornDown = true;
      for (const fn of ruleTeardowns) {
        try { fn(); } catch (err) { console.error('[shim] rule teardown failed', err); }
      }
      ruleTeardowns.length = 0;
      for (const fn of extraTeardowns.values()) {
        try { fn(); } catch (err) { console.error('[shim] extra teardown failed', err); }
      }
      extraTeardowns.clear();
    },
  };
}

// firstGreaterIndex exported for scripts/css-priority-harness.js (the cross-
// shim ordering policy); not used elsewhere at runtime.
export { run, firstGreaterIndex, isShimOwnedElement };
