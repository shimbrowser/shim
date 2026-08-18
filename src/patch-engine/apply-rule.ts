// applyRule drives the lifecycle of one anchored rule: resolve the anchor,
// mount each mutation's output on every match, self-heal across DOM churn via a
// rAF-coalesced MutationObserver, capture a witness fingerprint, and tear it all
// down cleanly. The status reporting (rule-status.ts), the settle-delayed rebase
// reconciler (rule-reconcile.ts), and the per-mutation dispatch
// (dispatch-mutation.ts) are factored out; this file owns the scan/mount loop,
// the relative-reorder restamp path, witness capture, and teardown, threading a
// shared RuleRuntimeState into the reporter + reconciler.

import * as anchors from './anchors';
import * as witnessMod from './witness';
import * as componentId from './component-id';
import { applyStrategy } from './strategies';
import { isShimOwnedElement } from './own-dom';
import {
  injectTier1Rule, removeTier1Rule, tagElement, stripToken, cssPriorityOf,
  removeReplaceRootRule, stripReplaceRootToken,
} from './css-sheets';
import { desiredSequence, REORDER_SIBLING_CAP } from './layout-kinds';
import { dispatchMutation, injectStripNotes } from './dispatch-mutation';
import { compileInlineHandlers, getSymbols } from './engine-internal';
import type { HandlerMap, MutationRegistry, RuntimeSpec } from './engine-internal';
import { makeRuleState } from './rule-state';
import { makeStatusReporter } from './rule-status';
import { makeReconciler } from './rule-reconcile';
import type { Rule, Anchor } from './types';
import type { ShimApiBase, ShimApi } from '../preload/shim-api-types';

// --- Own-DOM guard ----------------------------------------------------------
//
// Nothing stops a rule's anchor selector from matching DOM the engine itself
// created. `hide`/`restyle`/`reshape`/`reorder` outputs are the resolved SITE
// anchor restamped in place (never a new node), so they're never at risk — but
// a `script`/`replace-root` handler's OUTPUT is new DOM, and an `inline`-strategy
// output carries no marker attribute at all (only `replace-root` outputs get
// `data-shim-mounted`; portal/overlay park inside `[data-shim="portal-root"]`,
// shadow wraps in `[data-shim="shadow-host"]`). If a handler's injected output
// happens to match its own rule's anchor selector, the next scan mounts it too:
// dispatch → insert → new match → dispatch, unbounded.
//
// `mountedOutputRoots` is a MODULE-level registry (not per-applyRule-call):
// every `engine.run` instance for every patch on the page shares it, so one
// shim's handler output is never mistaken for another shim's anchor target
// either. `mountOn` adds each mount's outputs after recording them in the state
// bag; `teardownEntry` removes exactly those entries' outputs — no leaks across
// toggle/self-heal cycles, no cross-rule interference. The reconciler's recovery
// scans also read it (a shim-owned match is never a legitimate rebase target).
//
// Accepted residual: this only registers OUTPUT A HANDLER RETURNED (the mountOn/
// state bookkeeping path). A handler that opts out of self-healing by returning
// nothing (CLAUDE.md §6, "empty return = mounted once") but still appends DOM by
// hand — `el.appendChild(...)` without returning it — produces DOM this registry
// never learns about, so if that DOM happens to match the rule's own anchor
// selector the loop this guard exists to prevent can still occur. Not closable
// without either requiring a return value (a real API change) or diffing the DOM
// tree the handler touched, which is out of scope here.
//
// The selector side of the guard (`isShimOwnedElement` + `OWN_DOM_SELECTOR`)
// lives in ./own-dom — a pure, harness-covered leaf module. `mountedOutputRoots`
// stays here because dispatch/apply mutate it, and it's passed into the
// predicate as the `roots` argument.
export const mountedOutputRoots = new Set<Node>();

// Returns a teardown function that unobserves, removes all mounted outputs, runs
// per-entry cleanups, and strips any Tier-1 CSS this rule stamped onto its
// anchors (plus the rule text from the shared stylesheet). Preview iterative
// refinement in the authoring UI relies on this.
export function applyRule(
  rule: Rule,
  spec: RuntimeSpec,
  api: ShimApiBase,
  mutations: MutationRegistry,
  handlers: HandlerMap,
): () => void {
  // Rules from the authoring UI preview path carry their handler sources inline
  // on the rule as strings (the LLM emits them that way). Compile them to
  // functions once here and merge into the module-level handlers lookup for this
  // rule's dispatch. On the disk-loaded path this field is absent — handlers
  // already arrive as real functions via the patch module's handlers/*.js.
  const effectiveHandlers: HandlerMap = rule.handlers
    ? { ...handlers, ...compileInlineHandlers(rule.handlers, spec) }
    : handlers;

  // Shared mutable state the scan loop writes and the reporter + reconciler read
  // (state map, matchedSource, resolvedEl, witnessRejection, relativeReorderNote).
  const rs = makeRuleState();
  const inFlight = new WeakSet<Element>();
  // Witness capture fires at most once per lifecycle.
  let witnessCaptured = false;

  const reporter = makeStatusReporter(rule, spec, api, rs);
  const reconciler = makeReconciler(rule, spec, api, rs, mountedOutputRoots);

  // Relative reorder (§6): "immediately before/after Y" is a whole-sibling
  // ordering, not a single-element style — CSS `order` is a sort key across ALL
  // siblings (default 0), so the engine stamps EVERY child of the shared parent
  // with an explicit order matching the desired sequence. DOM (source) order is
  // stable under CSS order, so recomputing from it is idempotent; scan() calls
  // this every pass, folding in new siblings after re-renders. Stamping proceeds
  // even when the parent isn't flex/grid yet — harmless (order is inert
  // elsewhere), and a same-shim reshape on the parent makes the stamps live the
  // moment it applies. layoutNote (rule-status.ts) carries the warning.
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
    rs.relativeReorderNote = null;
    if (resolved.length === 0) return; // no-match reporting covers this
    if (resolved.length > 1) {
      rs.relativeReorderNote = `reorder: before/after needs a single-match anchor (matched ${resolved.length}) — narrow the anchor or use position`;
      return;
    }
    const el: Element | undefined = resolved[0];
    const targetSpec = relativeMut.before ?? relativeMut.after;
    if (!el || !targetSpec) return;
    const mode: 'before' | 'after' = relativeMut.before ? 'before' : 'after';
    const targets = anchors.resolveAll({ primary: targetSpec }, document);
    if (targets.length !== 1) {
      rs.relativeReorderNote = targets.length === 0
        ? 'reorder: before/after target not found on this page'
        : `reorder: before/after target matched ${targets.length} elements — needs exactly 1`;
      return;
    }
    const target = targets[0];
    const parent = el.parentElement;
    if (!parent || !target || target.parentElement !== parent) {
      rs.relativeReorderNote = 'reorder: target is not a sibling of the anchor — before/after only reorders within one container';
      return;
    }
    if (target === el) {
      rs.relativeReorderNote = 'reorder: before/after target resolves to the anchor itself — pick a different sibling';
      return;
    }
    const children = Array.from(parent.children);
    if (children.length > REORDER_SIBLING_CAP) {
      rs.relativeReorderNote = `reorder: container has ${children.length} children (cap ${REORDER_SIBLING_CAP}) — likely a virtualized list; use position or a different container`;
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
  // Note on observer feedback: stamping writes `data-shim-css` attributes, and
  // the rule's MutationObserver (below) watches `childList`/`subtree` only (not
  // attributes) — so restamping cannot re-trigger scans (no loop). A sibling
  // REMOVED later leaves its index rule in the sheet unmatched — harmless,
  // cleaned at teardown. Likewise, if the ANCHOR migrates to a different parent,
  // the old container's children keep their stamps until rule teardown (accepted
  // — cleaned by the teardown sweep, not re-derived per-scan).

  async function mountOn(el: Element): Promise<void> {
    const outputs: HTMLElement[] = [];
    const cleanups: Array<() => void> = [];
    // Per-mount api proxy. Handlers call `api.cleanup(fn)` to register tear-down
    // work — event listeners on document, intervals, inner MutationObservers,
    // anything that won't unwind by itself when the handler's returned DOM is
    // removed. The engine runs each fn when the anchor leaves the DOM (scan-time
    // pruning) or the rule itself tears down (toggle-off / shim-delete / patch
    // teardownAll). Cleanups run in registration order, BEFORE the strategy
    // cleanup that unparks portal/overlay nodes — so handler state is gone
    // before the DOM it observed disappears.
    //
    // `Object.create(api)` prototypically inherits storage/bridge/host/
    // reportEvent/etc. from the shared api, then we add `cleanup` as an own
    // property scoped to this mount's `cleanups` array. Concurrent mounts of the
    // same rule on different anchors get distinct proxies — one anchor's cleanup
    // registrations don't leak into another's.
    const mountApi: ShimApi = Object.assign(Object.create(api) as ShimApiBase, {
      cleanup(fn: () => void) {
        if (typeof fn === 'function') cleanups.push(fn);
      },
    });
    for (const mut of rule.mutations || []) {
      const raw = await dispatchMutation(el, mut, rule, spec, mountApi, mutations, effectiveHandlers);
      // dispatchMutation's contract is the broader `Node[]` (handlers may return
      // any Node); applyStrategy's portal/overlay/shadow machinery needs
      // `.style`/`.offsetHeight` and so is typed against `HTMLElement`
      // (strategies.ts). Every real mount target is one in practice —
      // script/replace-root handlers build ordinary elements — so this is a
      // boundary cast, not a loosening of either contract.
      const { placed, cleanup } = applyStrategy(raw as HTMLElement[], el as HTMLElement, mut);
      outputs.push(...placed);
      if (cleanup) cleanups.push(cleanup);
    }
    rs.state.set(el, { outputs, cleanups });
    // Register with the module-level own-DOM registry (see above) so no rule's
    // anchor resolution — this rule's or any other patch's — can ever re-match
    // this mount's output and re-dispatch onto it.
    for (const o of outputs) mountedOutputRoots.add(o);
  }

  function teardownEntry(entry: { outputs: HTMLElement[]; cleanups: Array<() => void> }) {
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
    for (const [anchor, entry] of rs.state) {
      if (!document.contains(anchor)) {
        teardownEntry(entry);
        rs.state.delete(anchor);
      }
    }

    // Only reached for anchored rules — setupRule forks iframe / mount-route /
    // redirect rules to their own lifecycles before falling through to
    // applyRule, so `rule.anchor` is always present here for a well-formed spec.
    // The shared `Rule` type keeps it optional to also describe those anchor-less
    // rule shapes.
    const { nodes: resolvedNodes, source, witnessRejected, rejectedSample } =
      anchors.resolveAllWithSource(rule.anchor as Anchor);
    // Own-DOM guard (see above): drop any candidate that's inside DOM the engine
    // itself mounted before anything downstream sees it — witness capture, the
    // mount loop, tier-1 stamping (`hide`/`restyle` go through the same `nodes`
    // list, so a shim styling its own output would need a handler, not an
    // anchor), relative-reorder restamping. Deliberately NOT folded into
    // `anchors.resolveAllWithSource` itself: witness/no-match semantics read raw
    // resolution counts, and an all-owned resolution correctly falls through to
    // the existing no-match path here (0 nodes after filter) rather than needing
    // a distinct signal. Inject-kind outputs are covered twice: they're
    // registered in `mountedOutputRoots` like any returned output, and their
    // `data-shim-injected` stamp is an own-DOM marker (OWN_DOM_SELECTOR) — so the
    // guard holds even for a detached-and-reattached injected node the registry
    // no longer tracks.
    const nodes = resolvedNodes.filter((el) => !isShimOwnedElement(el, mountedOutputRoots));
    // Track which spec carried the rule this scan. When state.size goes to 0 (no
    // match), we keep the last source for context — the inspector can still show
    // "previously via fallback:0" if useful, though today we just null it. The
    // matchedVia is most informative right when mounts exist; on no-match it's
    // redundant with `state.size === 0`.
    rs.matchedSource = source;
    // Remember the latest witness verdict so the settle-delayed reporter can tell
    // quarantine ("selector found something that isn't the thing") apart from
    // plain no-match ("selector found nothing").
    rs.witnessRejection = witnessRejected ? (rejectedSample || { detail: [] }) : null;
    // Snapshot resolution for the settle-delayed rebase reconciler. Unlike the
    // raw resolve above, `nodes` here is already filtered — a single
    // engine-injected match reads as zero, not one.
    const [singleNode] = nodes;
    rs.resolvedEl = nodes.length === 1 ? (singleNode ?? null) : null;

    // Witness capture (§8): a rule without a witness that resolves to exactly ONE
    // element gets fingerprinted, and the fingerprint is reported up. During
    // authoring previews the loop attaches it to the rule before commit; for
    // committed rules the event is groundwork for the rebase pass to backfill.
    // Once per applyRule lifecycle — the shape doesn't change scan-to-scan, and
    // re-emitting on churn would be noise. Multi-match rules skip capture: one
    // witness can't describe N different elements (§8 v1 scope).
    if (!witnessCaptured && !rule.anchor?.witness && nodes.length === 1 && singleNode) {
      witnessCaptured = true;
      const el = singleNode;
      const w = witnessMod.buildWitness(el);
      if (w && typeof api.reportEvent === 'function') {
        // Enrich with framework-component-identity via the main-world bridge (§8)
        // before emitting — the isolated world can't read fibers itself. Resolves
        // null on non-React pages / no bridge, in which case the witness simply
        // omits `component`. The slight defer is harmless: this event is
        // groundwork the authoring loop / rebase pass consume async.
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
                // `mapped: true` marks a witness whose names only exist through a
                // symbol map (translation actually renamed them) — the verify
                // veto then refuses to score it raw against minified fibers when
                // no map is available (see matchComponent). Untranslated captures
                // (no map, or names already original) stay unmarked.
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
      const existing = rs.state.get(el);
      if (existing) {
        // Opted out of self-healing (no outputs returned) — never re-mount.
        if (existing.outputs.length === 0) continue;
        // All outputs still attached — mounted state is healthy.
        if (existing.outputs.every((n) => document.contains(n))) continue;
        // Something got stomped: tear down and re-mount.
        teardownEntry(existing);
        rs.state.delete(el);
      }
      inFlight.add(el);
      // Measure viewport coverage BEFORE mountOn stamps display:none / detaches
      // the node — post-apply the box is 0x0 (see mediaHideKind's comment).
      reporter.noteLargeCoverAtMount(el);
      mountOn(el).finally(() => {
        inFlight.delete(el);
        // mountOn updates state.size as it inserts. Re-report so the inspector
        // sees the bump even when the surrounding scan() found no further
        // changes.
        reporter.reportStatusIfChanged();
      });
    }

    restampRelativeReorder(nodes);
    reporter.reportStatusIfChanged();
  };

  // rAF-coalesce the observer — React-style reconcilers can fire hundreds of
  // mutation batches per second during normal re-rendering, and each scan runs a
  // `querySelectorAll` per rule. One scan per frame is plenty for self-healing
  // and keeps the renderer's CPU baseline low.
  let scanHandle = 0;
  const scheduleScan = () => {
    if (scanHandle) return;
    scanHandle = requestAnimationFrame(() => {
      scanHandle = 0;
      scan();
    });
  };

  scan();

  // Settle-delayed reconciliation (rule-reconcile.ts): after the page has had a
  // beat to render, look once at how the rule resolved and act (baseline
  // refresh / promote / recover / quarantine). The reconciler owns its own
  // timing + one-shot flags; it reads this rule's resolution off the shared
  // state bag.
  reconciler.start();

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
    reconciler.stop();
    for (const [anchor, entry] of rs.state) {
      teardownEntry(entry);
      for (const mut of rule.mutations || []) {
        if (mut.kind === 'hide' || mut.kind === 'restyle' || mut.kind === 'reorder' || mut.kind === 'reshape') {
          stripToken(anchor, `shim-${spec.id}-${rule.id}-${mut.kind}`);
        } else if (mut.kind === 'replace-root') {
          stripReplaceRootToken(anchor, `shim-${spec.id}-${rule.id}-replace-root`);
        }
      }
    }
    rs.state.clear();
    for (const mut of rule.mutations || []) {
      if (mut.kind === 'hide' || mut.kind === 'restyle' || mut.kind === 'reorder' || mut.kind === 'reshape') {
        removeTier1Rule(`shim-${spec.id}-${rule.id}-${mut.kind}`);
      } else if (mut.kind === 'replace-root') {
        removeReplaceRootRule(`shim-${spec.id}-${rule.id}-replace-root`);
      }
    }
    // Relative-reorder index tokens: rules keyed per sibling index, stamped on
    // elements that aren't this rule's anchors — swept independently.
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
