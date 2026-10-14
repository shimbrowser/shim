// The settle-delayed reconciler for an anchored rule (§12/§14). After the page
// has had a beat to render (React hydration, async content), it looks once at
// how the rule resolved and acts — refresh the baseline hash, promote a working
// fallback, recover via witness/component-id, or emit no-match/quarantine.
// Factored out of applyRule: owns all its own timing + one-shot flags, reads
// the shared RuleRuntimeState (state map, matchedSource, resolvedEl,
// witnessRejection) that the scan loop writes. `start()` schedules the settle
// pass; `stop()` cancels a pending one at rule teardown.

import * as anchors from './anchors';
import * as witnessMod from './witness';
import * as componentId from './component-id';
import { isShimOwnedElement } from './own-dom';
import { getSymbols } from './engine-internal';
import type { RuntimeSpec } from './engine-internal';
import type { RuleRuntimeState } from './rule-state';
import type { Rule, Anchor, AnchorSpec } from './types';
import type { CoreApi } from './api';

export interface Reconciler {
  start(): void;
  stop(): void;
}

export function makeReconciler(
  rule: Rule,
  spec: RuntimeSpec,
  api: CoreApi,
  rs: RuleRuntimeState,
  mountedOutputRoots: Set<Node>,
): Reconciler {
  const SETTLE_DELAY_MS = 1500;
  // One extra beat granted before a deploy-path miss escalates to
  // quarantine/recovery-failure — covers content that renders after settle (see
  // the late-render grace note in reconcile).
  const RECONCILE_RETRY_MS = 2500;

  let noMatchTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let noMatchReported = false;
  let rebaseReported = false;
  let reconcileRetried = false;
  // Why the deterministic recoveries refused, for the quarantine that follows —
  // "component-id: no match; witness-scan: ambiguous — 2 disjoint strong
  // matches". Emitted on the quarantine event + diagnostics so a failed recovery
  // is debuggable after the fact instead of silently escalating.
  let lastRecoveryDetail: string | null = null;
  // The current page fingerprint, resolved lazily in reconcile (not at
  // construction): boot() builds the getter before the page's scripts are in the
  // DOM, so it would compute null then. By reconcile time the DOM is settled.
  let currentBundle: string | null = null;

  const summarizeAnchor = (a: Anchor | undefined): string => {
    const p = a && a.primary;
    if (!p) return '(none)';
    return `${p.kind}:${p.value || p.name || p.role || p.label || ''}`;
  };
  // Fallbacks for a recovered anchor: the synthesis ladder's runner-up rungs
  // first (fresh, verified against the found element — they give the NEXT deploy
  // something to promote from), then the rule's previous fallbacks (A/B-flip
  // insurance), deduped against the new primary and each other, capped so the
  // ladder never grows without bound across repeated recovers.
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
    if (rs.witnessRejection) {
      api.reportEvent('rule-quarantined', {
        specId: spec.id,
        ruleId: rule.id,
        selector: rule.anchor?.primary?.value || '',
        expected: rule.anchor?.witness || null,
        seen: rs.witnessRejection.detail || [],
        rejectedVia: rs.witnessRejection.source || null,
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
    // Resolve the current bundle hash now (DOM is settled). A deploy is when the
    // shim has a stored baseline that differs from it.
    try { currentBundle = spec.__bundleHashFn(); } catch (_) { currentBundle = null; }
    const baselineStale = typeof currentBundle === 'string' && currentBundle !== spec.bundleHash;
    const deploy = typeof spec.bundleHash === 'string' && baselineStale;
    // Per-shim auto-repair (§14). On by default; when off, a deploy that breaks
    // the anchor is NOT silently re-pointed — it surfaces as no-match /
    // quarantine so the user decides. The baseline refresh below (primary path)
    // still runs either way: it only tracks the bundle hash, never changes an
    // anchor, and keeps the gate honest if they re-enable.
    const canRebase = deploy && spec.autoRepair !== false;

    // Resolving cleanly via primary — keep the stored baseline current. Fires
    // when the baseline is MISSING (freshly-committed shim → initialize the
    // gate) or STALE (deploy the primary survived → advance it). Skips when
    // already current. This is what bootstraps the deploy gate: a shim can only
    // be judged "deployed since last reconciled" once it has a baseline, and a
    // clean primary resolution is when we record one.
    if (rs.state.size > 0 && rs.matchedSource === 'primary') {
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
      if (rs.resolvedEl && expectedComponent &&
          api.componentId && typeof api.componentId.verify === 'function') {
        const actual = await api.componentId.verify(rs.resolvedEl);
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

    // Resolving via a fallback — the primary is dead. On a deploy, promote the
    // working fallback to primary and demote the dead primary (keep it as a
    // fallback — cheap insurance if the site A/B-flips back). Same bundle →
    // leave the ladder alone; matchedVia already surfaces it.
    if (rs.state.size > 0 && typeof rs.matchedSource === 'string' &&
        rs.matchedSource.startsWith('fallback:')) {
      // Not a deploy, or auto-repair off → leave the ladder as-is. The rule
      // still works via the fallback; matchedVia already surfaces that the
      // primary is stale, so nothing is broken for the user to see.
      if (!canRebase) return;
      const idx = parseInt(rs.matchedSource.slice('fallback:'.length), 10);
      // Same "only reached for anchored rules" invariant as scan()'s resolve
      // call — a 'fallback:N' matchedVia can only have been produced by a rule
      // whose anchor (primary + fallbacks) was actually resolved.
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
      const fresh = rs.resolvedEl
        ? witnessMod.buildWitness(rs.resolvedEl, { component: definiteAnchor.witness?.component })
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

    // Resolving nothing. On a deploy with a witness (and auto-repair on), try to
    // recover the target by scanning for it; else emit the no-match / quarantine
    // signal (which is also the auto-repair-off behavior — the drift surfaces
    // instead of self-healing).
    if (rs.state.size === 0) {
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
        // TrackRow witness finds the node now named Xd. No map → raw only, the
        // pre-Stage-B behavior.
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
        // checks above/below guarantee they're present, but the guard keeps the
        // access honest rather than asserting it.
        const [rawMatch] = Array.isArray(matches) && matches.length === 1 ? matches : [];
        // Own-DOM guard: a unique component-identity match is exactly what a
        // handler's own mounted output can produce after a deploy kills the real
        // selector — the fiber tree still reports the captured component name,
        // just now on DOM the engine itself created. Treat a shim-owned match as
        // no match at all so the arm falls through (to witnessRecover, then
        // quarantine) instead of committing a rebased anchor that points at shim
        // DOM, which the own-DOM scan filter would then treat as a permanent
        // no-match on every subsequent scan.
        const matched = rawMatch && !isShimOwnedElement(rawMatch, mountedOutputRoots) ? rawMatch : null;
        const ladder = matched ? anchors.suggestAnchorLadder(matched) : [];
        const [ladderHead] = ladder;
        if (matched && ladderHead) {
          const fresh = witnessMod.buildWitness(matched, { component: stored })
            || rule.anchor?.witness;
          emitRebase({
            strategy: 'recover',
            // `via` names the rung that found the element — component identity
            // (the strongest signal) vs the witness shape-scan. Diagnostics-only:
            // lets a human tell WHICH recovery fired.
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
        // Same own-DOM guard as the component-identity arm above: the witness
        // shape-scan walks every live element of the anchor's tag, which
        // includes anything the engine mounted. A shape match there is never a
        // legitimate recovery target.
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
      //     the selector, the component scan, and the witness scan all missed an
      //     element that simply didn't exist yet. Found live: a heal the witness
      //     rung should have made for free fell to the LLM tier.
      //   - witness REJECTION (deploy or not): a generic selector can resolve
      //     the page's OTHER elements while the real target is still rendering —
      //     the veto correctly rejects those impostors, but quarantining on that
      //     single look escalates a transient mis-resolution to an LLM turn even
      //     though the target mounts fine moments later (found live: two wasted
      //     AI turns ~40min apart on a healthy shim). The veto stays
      //     deploy-independent — only the ESCALATION waits one beat.
      //
      // On the retry, a now-rendered target either mounted via the scan loop
      // (state > 0 → healthy verify path) or gives the recovery scans a real
      // shot. Plain non-deploy no-match stays single-pass — rule-no-match is
      // transient/informational and authoring wants that feedback promptly.
      if (!reconcileRetried && (deploy || rs.witnessRejection)) {
        reconcileRetried = true;
        noMatchTimer = setTimeout(reconcile, RECONCILE_RETRY_MS);
        return;
      }
      noMatchReported = true;
      // Deploy + a witness we couldn't deterministically recover → the element
      // changed beyond witness recognition (e.g. a tag swap killed the selector
      // AND the witness can't re-find it). That's a real break that needs the
      // LLM, not a transient absence — route it into the quarantine/re-anchor
      // flow (banner + auto-reanchor). Gated on `deploy` (NOT auto-repair) so it
      // still surfaces for manual review when auto-repair is off; the auto-fire
      // itself is auto-repair-gated downstream (shouldAutoReanchor). Without a
      // deploy, a bare no-match stays transient (reportUnresolved →
      // rule-no-match). The empty `seen` distinguishes this from a
      // witness-rejection quarantine (nothing resolved, so there's no element to
      // diff against).
      // Only a *true* no-match (selector matched nothing) routes here. A
      // witness-rejection (selector resolved a wrong element → witnessRejection
      // set) falls through to reportUnresolved, which emits the quarantine WITH
      // its expected-vs-seen diff — don't preempt that and lose the diff.
      if (deploy && hasWitness && !rs.witnessRejection) {
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

  return {
    start() { noMatchTimer = setTimeout(reconcile, SETTLE_DELAY_MS); },
    stop() {
      if (noMatchTimer) {
        clearTimeout(noMatchTimer);
        noMatchTimer = 0;
      }
    },
  };
}
