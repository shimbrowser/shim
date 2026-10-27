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
import { applyStrategy } from './strategies';
import { isShimOwnedElement, closestOutputOwner, hasOwnDomMarker } from './own-dom';
import { makeAnchorChangeHub } from './anchor-change';
import type { ChangeRecordLike, MountRecord } from './anchor-change';
import { errMessage } from './error';
import { trimStackForEvent } from './engine-internal';
import {
  injectTier1Rule, removeTier1Rule, tagElement, stripToken, cssPriorityOf,
  removeReplaceRootRule, stripReplaceRootToken,
} from './css-sheets';
import { desiredSequence, REORDER_SIBLING_CAP } from './layout-kinds';
import { dispatchMutation, injectStripNotes } from './dispatch-mutation';
import { makeCaptureController } from './witness-capture';
import { fingerprintKind } from './managed-anchor';
import { matchSetWitness } from './set-witness';
import type { HandlerMap, MutationRegistry, RuntimeSpec, RuleMountEntry } from './engine-internal';
import { makeRuleState } from './rule-state';
import { makeStatusReporter } from './rule-status';
import { makeReconciler } from './rule-reconcile';
import type { Rule, Anchor } from './types';
import type { CoreApi, CoreAnchoredHandlerApi, HostApiMembers } from './api';
import { nextFrame } from './next-frame';

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
// nothing ("empty return = mounted once") but still appends DOM by
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
// The owning patch (the spec id the output was mounted under) per registered
// output root, kept in step with `mountedOutputRoots`. A host asks "whose
// output is this element in?" through `outputOwnerOf` — e.g. to keep an
// agent's input to one shim's own controls. Association, not provenance: a
// page can move its own nodes into a shim's container.
export const outputOwners = new Map<Node, string>();

/** The patch whose mounted output (the closest registered root) contains `el`, or null. */
export function outputOwnerOf(el: Node): string | null {
  return closestOutputOwner(el, outputOwners);
}

// Returns a teardown function that unobserves, removes all mounted outputs, runs
// per-entry cleanups, and strips any Tier-1 CSS this rule stamped onto its
// anchors (plus the rule text from the shared stylesheet). Preview iterative
// refinement in the authoring UI relies on this.
export function applyRule(
  rule: Rule,
  spec: RuntimeSpec,
  api: CoreApi,
  mutations: MutationRegistry,
  // Already-compiled functions for THIS rule: the patch's bag handlers with
  // the rule's own inline handlers layered on top (setupRule in engine.ts does
  // the merge; the host compiled both — the engine never compiles source).
  handlers: HandlerMap,
): () => void {
  // Shared mutable state the scan loop writes and the reporter + reconciler read
  // (state map, matchedSource, resolvedEl, witnessRejection, relativeReorderNote).
  const rs = makeRuleState();
  const inFlight = new WeakSet<Element>();
  // The same members, iterable (a revoke must reach mounts still in flight).
  const inFlightMembers = new Set<Element>();
  // Set by teardownRule. A mount still awaiting a handler when the rule tears
  // down (a preview replaced, a shim toggled off) must not land afterwards:
  // its outputs would outlive the rule, and its status would read as the
  // replacement's (the same ruleKey) in a host's preview evidence.
  let tornDown = false;
  // Per-member mount generation: bumped when a member is revoked (it stopped
  // verifying against the rule's set witness), so a mountOn still awaiting a
  // handler for it tears its own outputs down instead of landing.
  const generation = new WeakMap<Element, number>();
  const isOwned = (node: Element): boolean => isShimOwnedElement(node, mountedOutputRoots);
  // Witness capture (witness-capture.ts): what this lifecycle observed decides
  // the fingerprint — one member at once → element witness, several → set
  // witness — reported as rule-witness events. A rule that already carries a
  // fingerprint captures nothing.
  const capture = makeCaptureController(rule, spec.id, api, {
    isOwned,
    schedule: (run) => nextFrame(run),
    queryAll: (selector) => Array.from(document.querySelectorAll(selector)),
  });
  // A set-witnessed rule (not conflicted) whose member stops verifying has
  // that member's mount torn down — but only when no mutation of the rule can
  // change the member's own signals: tier-1 kinds stamp only data-shim-css
  // (excluded from every signal) and inject kinds add shim-owned DOM
  // (excluded too). A script / replace-root rule's member that stops
  // verifying stays mounted and is counted unverified: its own handler may be
  // what changed it, and tearing it down would flap.
  const setWitnessed = fingerprintKind(rule.anchor) === 'set';
  const TEARDOWN_SAFE_KINDS = new Set(['hide', 'restyle', 'reorder', 'reshape', 'inject-element', 'inject-html']);
  const revokeOnUnverify = setWitnessed && (rule.mutations || []).every((m) => TEARDOWN_SAFE_KINDS.has(m.kind));

  const reporter = makeStatusReporter(rule, spec, api, rs);
  const reconciler = makeReconciler(rule, spec, api, rs, mountedOutputRoots);

  // api.onAnchorChange (anchor-change.ts): derived from this rule's own
  // childList observer below — no observer of its own. `observer` and
  // `scheduleScan` are assigned further down; the hub only calls into them
  // after setup.
  let observer: MutationObserver | null = null;
  // Set-witnessed members the latest scan counted unverified: mounted, but
  // their hooks are suspended until they verify again.
  let unverifiedMembers = new Set<Element>();
  const changeHub = makeAnchorChangeHub<Node>({
    parentOf: (node) => node.parentNode,
    isOwnedNode: (node) => mountedOutputRoots.has(node as HTMLElement) || hasOwnDomMarker(node),
    now: () => Date.now(),
    setTimer: (run, ms) => { const t = setTimeout(run, ms); return () => clearTimeout(t); },
    requestFrame: () => scheduleScan(),
    reportError: (err, handlerName) => {
      console.error('[shim] onAnchorChange callback failed', err);
      if (typeof api.reportEvent !== 'function') return;
      api.reportEvent('handler-error', {
        specId: spec.id,
        handlerName: handlerName || '(anonymous)',
        ruleId: rule.id,
        message: `onAnchorChange: ${errMessage(err)}`,
        stack: trimStackForEvent(err instanceof Error ? err.stack || '' : ''),
      });
    },
    onThrottle: () => {
      if (rs.anchorChangeNote) return;
      rs.anchorChangeNote = 'an api.onAnchorChange callback on this rule is re-firing continuously and is being '
        + 'throttled — something keeps changing the anchor\'s subtree: the callback\'s own async writes into site DOM, '
        + 'another rule, or the site itself. Write only what changed, and write into your own returned DOM where you can '
        + '(writes there are never reported back).';
      reporter.reportStatusIfChanged();
    },
  });
  const isChangeEligible = (record: MountRecord<Node>): boolean => {
    const anchor = record.anchor as Element;
    return !tornDown && document.contains(anchor) && rs.state.get(anchor)?.change === record
      && !unverifiedMembers.has(anchor);
  };
  const drainObserver = (): ArrayLike<ChangeRecordLike<Node>> => (observer ? observer.takeRecords() : []);

  // Relative reorder: "immediately before/after Y" is a whole-sibling
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
    const gen = generation.get(el) ?? 0;
    const outputs: HTMLElement[] = [];
    const cleanups: Array<() => void> = [];
    const change = changeHub.createRecord(el);
    // The handler whose dispatch is running — names the hooks it registers.
    let currentHandler = '';
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
    const mountApi: CoreAnchoredHandlerApi = Object.assign(Object.create(api) as CoreApi & HostApiMembers, {
      cleanup(fn: () => void) {
        if (typeof fn === 'function') cleanups.push(fn);
      },
      onAnchorChange(fn: () => unknown) {
        return changeHub.register(change, fn, currentHandler);
      },
    });
    for (const mut of rule.mutations || []) {
      currentHandler = typeof mut.handler === 'string' ? mut.handler : '';
      const raw = await dispatchMutation(el, mut, rule, spec, mountApi, mutations, handlers);
      // dispatchMutation's contract is the broader `Node[]` (handlers may return
      // any Node); applyStrategy's portal/overlay/shadow machinery needs
      // `.style`/`.offsetHeight` and so is typed against `HTMLElement`
      // (strategies.ts). Every real mount target is one in practice —
      // script/replace-root handlers build ordinary elements — so this is a
      // boundary cast, not a loosening of either contract.
      const { placed, cleanup } = applyStrategy(raw as HTMLElement[], el as HTMLElement, mut);
      outputs.push(...placed);
      if (cleanup) cleanups.push(cleanup);
      // Its tier-1 tokens stay: a replacement under the same spec and rule id
      // stamps the same token names, so stripping here could undo its work.
      if (tornDown) {
        teardownEntry({ outputs, cleanups, change });
        return;
      }
      // The member was revoked while this mount awaited: undo it here.
      if ((generation.get(el) ?? 0) !== gen) {
        teardownEntry({ outputs, cleanups, change });
        stripAnchorTokens(el);
        return;
      }
    }
    rs.state.set(el, { outputs, cleanups, change });
    // Register with the module-level own-DOM registry (see above) so no rule's
    // anchor resolution — this rule's or any other patch's — can ever re-match
    // this mount's output and re-dispatch onto it.
    for (const o of outputs) {
      mountedOutputRoots.add(o);
      outputOwners.set(o, spec.id);
    }
    changeHub.land(change);
  }

  // Strip the tier-1 / replace-root tokens this rule stamped on one anchor.
  function stripAnchorTokens(anchor: Element): void {
    for (const mut of rule.mutations || []) {
      if (mut.kind === 'hide' || mut.kind === 'restyle' || mut.kind === 'reorder' || mut.kind === 'reshape') {
        stripToken(anchor, `shim-${spec.id}-${rule.id}-${mut.kind}`);
      } else if (mut.kind === 'replace-root') {
        stripReplaceRootToken(anchor, `shim-${spec.id}-${rule.id}-replace-root`);
      }
    }
  }

  function teardownEntry(entry: RuleMountEntry) {
    // Hooks die first: no callback runs once its mount is going away.
    if (entry.change) changeHub.kill(entry.change);
    for (const fn of entry.cleanups) {
      try { fn(); } catch (err) { console.error('[shim] cleanup failed', err); }
    }
    for (const node of entry.outputs) {
      mountedOutputRoots.delete(node);
      outputOwners.delete(node);
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
      anchors.resolveAllWithSource(rule.anchor as Anchor, document, { isOwned });
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

    // The verified count (what the reconciler reads): members that passed
    // the rule's fingerprint this scan. Mounted-but-unverified members (a
    // script rule's, kept rather than torn down) are counted apart.
    rs.verifiedCount = nodes.length;
    const verified = new Set(nodes);
    let unverified = 0;
    const unverifiedNow = new Set<Element>();
    // A member is judged by its own fingerprint, never by the selector alone:
    // a rule's own output can make the selector stop matching a member that
    // still verifies (an injection filling `.slot:empty`), and revoking it
    // would re-inject on the next scan, forever.
    // Set-witnessed rules only: a conflicted rule's element witness decides.
    const stillMember = (el: Element): boolean => setWitnessed && !!rule.anchor?.setWitness
      && document.contains(el) && matchSetWitness(rule.anchor.setWitness, el, isOwned).pass;
    // A conflicted rule's mount must still pass its element witness (that
    // witness decides for it); any other rule's connected mount stays a
    // success, as it always was — its own script may have rewritten the very
    // signals its witness recorded.
    const elementWitness = fingerprintKind(rule.anchor) === 'conflicted' ? rule.anchor?.witness : undefined;
    const stillMounted = (el: Element): boolean => document.contains(el)
      && (!elementWitness || witnessMod.matchWitness(elementWitness, el).pass);
    let retained = 0;
    for (const [anchor, entry] of rs.state) {
      if (verified.has(anchor)) continue;
      // Still a member: healthy, and counted as verified for the reconciler.
      if (stillMember(anchor)) { retained += 1; continue; }
      // A rule without a set witness keeps counting a mount its own output
      // took out of the selector's result (an injection filling
      // `#slot:empty`, a script rewriting its anchor's text) as success.
      if (!setWitnessed && stillMounted(anchor)) { retained += 1; continue; }
      if (revokeOnUnverify) {
        teardownEntry(entry);
        stripAnchorTokens(anchor);
        rs.state.delete(anchor);
        generation.set(anchor, (generation.get(anchor) ?? 0) + 1);
      } else if (setWitnessed) {
        unverified += 1;
        unverifiedNow.add(anchor);
      }
    }
    // A member revoked while its mount is still in flight.
    if (revokeOnUnverify) {
      for (const el of inFlightMembers) {
        if (!verified.has(el) && !stillMember(el)) generation.set(el, (generation.get(el) ?? 0) + 1);
      }
    }
    rs.unverifiedCount = unverified;
    unverifiedMembers = unverifiedNow;
    rs.verifiedCount = nodes.length + retained;

    // Witness capture sees every match BEFORE anything below mounts on it.
    capture.observe(nodes);
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
      inFlightMembers.add(el);
      // Measure viewport coverage BEFORE mountOn stamps display:none / detaches
      // the node — post-apply the box is 0x0 (see mediaHideKind's comment).
      reporter.noteLargeCoverAtMount(el);
      mountOn(el).finally(() => {
        inFlight.delete(el);
        inFlightMembers.delete(el);
        if (tornDown) return;
        // mountOn updates state.size as it inserts. Re-report so the inspector
        // sees the bump even when the surrounding scan() found no further
        // changes.
        reporter.reportStatusIfChanged();
      });
    }

    restampRelativeReorder(nodes);
    reporter.reportStatusIfChanged();
  };

  // Frame-coalesce the observer — React-style reconcilers can fire hundreds of
  // mutation batches per second during normal re-rendering, and each scan runs a
  // `querySelectorAll` per rule. One scan per frame is plenty for self-healing
  // and keeps the renderer's CPU baseline low. nextFrame falls back to a timer
  // when the page gets no frames (hidden or behind another window), so a page
  // that re-renders there is still re-shimmed.
  let cancelScan: (() => void) | null = null;
  function scheduleScan(): void {
    if (cancelScan || tornDown) return;
    cancelScan = nextFrame(() => {
      cancelScan = null;
      scan();
      // After the scan (prune, self-heal, membership): the subtree-change hooks.
      changeHub.deliver(isChangeEligible, drainObserver);
    });
  }

  scan();

  // Settle-delayed reconciliation (rule-reconcile.ts): after the page has had a
  // beat to render, look once at how the rule resolved and act (baseline
  // refresh / promote / recover / quarantine). The reconciler owns its own
  // timing + one-shot flags; it reads this rule's resolution off the shared
  // state bag.
  reconciler.start();

  observer = new MutationObserver((records) => {
    if (changeHub.hasHooks()) changeHub.attribute(records);
    scheduleScan();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  return function teardownRule() {
    tornDown = true;
    changeHub.teardown();
    capture.stop();
    observer?.disconnect();
    if (cancelScan) {
      cancelScan();
      cancelScan = null;
    }
    reconciler.stop();
    for (const [anchor, entry] of rs.state) {
      teardownEntry(entry);
      stripAnchorTokens(anchor);
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
