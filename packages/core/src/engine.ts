// The engine's public entry: `run(patch, api)` boots a compiled patch bundle
// against the live document and returns a PatchControl for live-preview /
// forwarded-rule application and whole-patch teardown. The per-rule machinery
// lives in sibling modules — applyRule (apply-rule.ts) for anchored rules,
// routeRule (route-rule.ts) for virtual routes, bridgeRule (bridge-rule.ts) for
// iframe forwarding, plus the shared helpers/types in engine-internal.ts. This
// file is the coordinator: spec setup, whole-patch CSS, the setupRule dispatch,
// and the rule-teardown bookkeeping.

import { injectStyle, firstGreaterIndex } from './css-sheets';
import { isShimOwnedElement } from './own-dom';
import { applyRule } from './apply-rule';
import { routeRule } from './route-rule';
import { bridgeRule } from './bridge-rule';
import { taggedApi } from './tagged-api';
import type { RuntimeSpec, MutationRegistry, HandlerMap } from './engine-internal';
import type { Spec, Rule } from './types';
import type { CoreApi } from './api';

// The bundle run() receives from page-preload — NOT the same shape as `Spec`:
// this is the compiled module/bag (`{ spec, mutations, handlers }`) plus two
// fields page-preload adds before calling in (`priority`, the sidebar/registry
// ordering; `bundleHash`, the current-deploy fingerprint — see the comment on
// run() for why it may be a function).
interface PatchBundle {
  spec: Spec;
  mutations?: MutationRegistry;
  handlers?: HandlerMap;
  // Each spec rule's own inline handlers (`rule.handlers`, authored as source
  // strings), already compiled by the host and keyed by the rule object in
  // `spec.rules`. The engine never compiles source (no Node, and the
  // CSP-immune way to compile differs per host). A rule's own handlers win
  // over the bag's `handlers` on a name collision — see setupRule.
  ruleHandlers?: ReadonlyMap<Rule, HandlerMap>;
  priority?: number;
  bundleHash?: string | (() => string | null);
  // Spec rule ids to boot suppressed: a live preview already owns each of
  // them (it arrived before this patch booted, or the patch re-booted under
  // it). They are never set up until restoreRule, so the committed rule and
  // its preview twin never run side by side, not even for one apply.
  suppressedRuleIds?: readonly string[];
}

// An extra rule's deploy gate: the baseline it was committed under and the
// page's current deploy identity (computed lazily, at reconcile time).
// `autoRepair` is the committed spec's: false keeps the anchor-changing
// rebases (promote, witness recovery) off, as they are for the committed rule.
interface ExtraRuleDeploy {
  bundleHash: string;
  current: () => string | null;
  autoRepair?: boolean;
}

// The control object run() returns to page-preload — lets the sidebar /
// cross-frame bridge apply live-preview or forwarded rules and tear the whole
// patch down.
interface PatchControl {
  // `ruleHandlers` is the rule's own `rule.handlers` already compiled by the
  // host (preview and forwarded rules carry handler source inline). The rule
  // itself stays plain JSON — bridgeRule forwards it to child frames as-is.
  // `deploy` puts the extra rule behind the deploy gate: `bundleHash` is
  // the baseline it was committed under, `current` the page's deploy identity
  // getter. Without it the rule never sees a deploy (the control's own spec
  // carries no baseline). PageHost previews of a committed rule pass it.
  // `applyId` tags this application: every event the rule reports carries it
  // (tagged-api.ts, PageHost PreviewRule.applyId), stamped at the producer, so
  // a late event from a replaced application stays attributable to it.
  applyExtraRule(rule: Rule, specIdOverride?: string, ruleKey?: string, ruleHandlers?: HandlerMap, deploy?: ExtraRuleDeploy, applyId?: string): void;
  removeExtraRule(ruleKey: string): boolean;
  // Preview twin-conflict guard (live-caught: a committed replace-root rule and
  // its own update-rule PREVIEW each hide everything except their own mounted
  // output — two rules, two tokens, both mounts hidden, blank page; the quieter
  // sibling is a committed script rule + its preview double-mounting a widget).
  // While a preview for rule X is live, the preload suppresses the committed X
  // and restores it when the preview is removed.
  suppressRule(ruleId: string): boolean;
  restoreRule(ruleId: string): void;
  teardownAll(): void;
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

// Pick the right setup path for a rule. Route rules and iframe-bridge rules take
// dedicated lifecycles; everything else is a normal anchored rule.
//
// `ruleHandlers` are the rule's own inline handlers, host-compiled. They layer
// over the bag's handlers for this rule only, so two rules defining the same
// name with different source each run their own (spec-lint's collision note).
function setupRule(
  rule: Rule,
  spec: RuntimeSpec,
  api: CoreApi,
  mutations: MutationRegistry,
  bagHandlers: HandlerMap,
  ruleHandlers: HandlerMap | undefined,
): () => void {
  if (rule.anchor?.iframe) return bridgeRule(rule, spec, api);
  const handlers: HandlerMap = ruleHandlers ? { ...bagHandlers, ...ruleHandlers } : bagHandlers;
  if ((rule.mutations || []).some((m) => m.kind === 'mount-route')) {
    return routeRule(rule, spec, api, handlers);
  }
  // `redirect`, `rewrite-response`, and `intercept` rules are network/module-
  // layer concerns handled outside the anchored DOM path (redirect in main,
  // rewrite in the main-world response wrapper, intercept in the main-world
  // define-trap wrapper — all installed by page-preload). intercept has no DOM
  // anchor at all: it's a module-boundary concern handled by the main-world
  // wrapper page-preload installs. Running any of these down the anchored path
  // would emit a spurious `rule-no-match`.
  if ((rule.mutations || []).some((m) => m.kind === 'redirect' || m.kind === 'rewrite-response' || m.kind === 'intercept')) {
    return () => {};
  }
  return applyRule(rule, spec, api, mutations, handlers);
}

function run(patch: PatchBundle, api: CoreApi): PatchControl {
  const { mutations = {}, handlers = {}, ruleHandlers } = patch;
  const compiledFor = (rule: Rule): HandlerMap | undefined => ruleHandlers?.get(rule);
  // Stamp two runtime-only fields onto the spec so the deep rule-processing path
  // can read them without threading params through every signature. Shallow copy
  // keeps the authored spec untouched; preview/forwarded paths that spread `spec`
  // inherit both.
  //   - `__cssPriority` — cross-shim cascade priority for the tier-1 injector
  //     (main: user shims above platform fixtures; sidebar order among users).
  //   - `__bundleHashFn` — getter for the current page fingerprint, compared by
  //     the rebase pass against the stored `spec.bundleHash` to detect a deploy.
  //     A getter (not a value) because it must be evaluated at reconcile
  //     time — boot() computes it before the page's scripts are in the DOM. A
  //     plain string is accepted too (tests/stubs).
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

  // Track teardowns for each rule in spec.rules so the whole patch can be torn
  // down live (sidebar toggle-off). Extra rules (previews + forwarded) have
  // their own lifecycle via extraTeardowns below. Keyed by rule id so
  // suppressRule/restoreRule can address one spec rule; rules without an id
  // (never emitted by authoring, but the type allows it) key by index and are
  // simply not suppressible.
  const ruleTeardowns = new Map<string, () => void>();
  const hasRule = (ruleId: string): boolean => (spec.rules || []).some((r) => r.id === ruleId);
  const suppressedRuleIds = new Set<string>((patch.suppressedRuleIds || []).filter(hasRule));
  let tornDown = false;
  api.onReady(() => {
    if (tornDown) return;
    for (const [i, rule] of (spec.rules || []).entries()) {
      const key = rule.id || `__idx_${i}`;
      // A preview twin claimed it before the document was ready (or at boot).
      if (suppressedRuleIds.has(key) || ruleTeardowns.has(key)) continue;
      ruleTeardowns.set(key, setupRule(rule, spec, api, mutations, handlers, compiledFor(rule)));
    }
  });

  // Extra rules are those applied *after* the patch's own spec.rules — used by
  // the preload for rules forwarded in from a parent frame's bridge, and by the
  // authoring UI for live previews. Keyed rules can be updated in place (same key
  // replaces previous apply) and torn down via `removeExtraRule`.
  const extraTeardowns = new Map<string, () => void>();
  // ruleKey → the latest apply still waiting for the document. A remove (or a
  // newer apply) before DOMContentLoaded cancels it; without this a preview
  // removed during load mounted anyway, with nothing left to undo it, beside
  // the committed rule its removal had restored.
  const pendingExtra = new Map<string, object>();

  return {
    applyExtraRule(rule: Rule, specIdOverride?: string, ruleKey?: string, extraRuleHandlers?: HandlerMap, deploy?: ExtraRuleDeploy, applyId?: string) {
      let effectiveSpec: RuntimeSpec = specIdOverride ? { ...spec, id: specIdOverride } : spec;
      if (deploy) {
        effectiveSpec = { ...effectiveSpec, bundleHash: deploy.bundleHash, __bundleHashFn: deploy.current };
        if (deploy.autoRepair === false) effectiveSpec.autoRepair = false;
      }
      const ticket = {};
      if (ruleKey) pendingExtra.set(ruleKey, ticket);
      api.onReady(() => {
        // Setup waits for the document. A control torn down meanwhile (a host
        // letting go of the page, a patch removed mid-load) must not mount it:
        // nothing would be left to undo it.
        if (tornDown) return;
        if (ruleKey) {
          if (pendingExtra.get(ruleKey) !== ticket) return;
          pendingExtra.delete(ruleKey);
          const prev = extraTeardowns.get(ruleKey);
          if (prev) {
            prev();
            extraTeardowns.delete(ruleKey);
          }
        }
        const teardown = setupRule(rule, effectiveSpec, taggedApi(api, applyId), mutations, handlers, extraRuleHandlers);
        if (ruleKey) extraTeardowns.set(ruleKey, teardown);
      });
    },
    removeExtraRule(ruleKey: string) {
      const cancelled = pendingExtra.delete(ruleKey);
      const teardown = extraTeardowns.get(ruleKey);
      if (!teardown) return cancelled;
      teardown();
      extraTeardowns.delete(ruleKey);
      return true;
    },
    // See the PatchControl doc comment: tear down ONE spec-declared rule while
    // its preview twin is live, and bring it back afterwards. restore is a strict
    // no-op unless the id was suppressed by suppressRule on THIS control instance
    // — a commit re-boots the patch into a fresh control, so a stale restore from
    // the old preview teardown can't double-apply anything there.
    // Suppression is by declaration, not by what is mounted yet: a rule whose
    // setup is still waiting for the document (a preview sent during load) is
    // marked so the deferred setup skips it. Without that the committed rule
    // mounted at DOMContentLoaded beside its preview, and two script handlers
    // observing one container fed each other until the page hung.
    suppressRule(ruleId: string) {
      if (tornDown || !ruleId || !hasRule(ruleId)) return false;
      const teardown = ruleTeardowns.get(ruleId);
      if (teardown) {
        try { teardown(); } catch (err) { console.error('[shim] rule suppress failed', err); }
        ruleTeardowns.delete(ruleId);
      }
      suppressedRuleIds.add(ruleId);
      return true;
    },
    restoreRule(ruleId: string) {
      if (tornDown || !suppressedRuleIds.has(ruleId)) return;
      suppressedRuleIds.delete(ruleId);
      const rule = (spec.rules || []).find((r) => r.id === ruleId);
      if (!rule) return;
      api.onReady(() => {
        // The boot's own deferred setup may have run it already (restored
        // before the document was ready): one instance, never two.
        if (tornDown || suppressedRuleIds.has(ruleId) || ruleTeardowns.has(ruleId)) return;
        ruleTeardowns.set(ruleId, setupRule(rule, spec, api, mutations, handlers, compiledFor(rule)));
      });
    },
    // Tears down every rule this patch mounted (observers, mounted outputs,
    // Tier-1 CSS tokens). Leaves injected stylesheets (`mutation-<kind>` /
    // `patch-<id>`) in place — they're idempotent and may be shared with other
    // patches. Does NOT recall rules already forwarded into child iframes via
    // anchor.iframe; those persist in the iframe's stub engine until navigation.
    teardownAll() {
      tornDown = true;
      for (const fn of ruleTeardowns.values()) {
        try { fn(); } catch (err) { console.error('[shim] rule teardown failed', err); }
      }
      ruleTeardowns.clear();
      suppressedRuleIds.clear();
      for (const fn of extraTeardowns.values()) {
        try { fn(); } catch (err) { console.error('[shim] extra teardown failed', err); }
      }
      extraTeardowns.clear();
    },
  };
}

// `firstGreaterIndex` (css-priority-harness) and `isShimOwnedElement`
// (engine-own-dom-harness) live in ./css-sheets and ./own-dom; re-exported here
// so those harnesses' engine imports — and engine's
// public surface — stay unchanged.
export { run, firstGreaterIndex, isShimOwnedElement };
