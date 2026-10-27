// The mutable per-rule runtime state shared between an anchored rule's three
// cooperating pieces: the scan/mount lifecycle (apply-rule.ts, the writer of
// most fields), the status reporter (rule-status.ts), and the settle-delayed
// reconciler (rule-reconcile.ts). applyRule owns one instance per rule and
// threads it into the reporter + reconciler factories; those read it back.
//
// This is deliberately a plain mutable bag rather than getters/setters: the
// scan loop writes these fields on every pass (hot path), and the reporter /
// reconciler read the latest values at settle time. The alternative — passing
// a dozen getter closures — is noisier for no safety gain (all three pieces are
// same-file-adjacent by construction and single-threaded).

import type { RuleMountEntry, RejectedSample } from './engine-internal';

export interface RuleRuntimeState {
  // anchor -> { outputs, cleanups }. Map (not WeakMap) so scan can iterate and
  // prune anchors that left the DOM, tearing down their portal/overlay
  // listeners and removing nodes parked in document.body.
  state: Map<Element, RuleMountEntry>;
  // Which anchor spec resolved this scan — 'primary', 'fallback:N', or null
  // when nothing matched. Read by the reporter (matchedVia) and the reconciler
  // (promote/recover routing).
  matchedSource: string | null;
  // The single resolved element (for capturing a fresh witness on a promote);
  // null when zero or multiple matched. Written by scan, read by reconcile.
  resolvedEl: Element | null;
  // Latest witness rejection verdict — lets the reconciler tell quarantine
  // ("found something that isn't the thing") from plain no-match ("found
  // nothing"). Written by scan, read by reconcile.
  witnessRejection: RejectedSample | null;
  // Relative-reorder (before/after) precondition note for the current scan.
  // Written by apply-rule's restamp path, read by the status reporter's
  // layoutNote. Reset to null each restamp pass.
  relativeReorderNote: string | null;
  // Set once when an api.onAnchorChange hook on this rule is throttled (it
  // re-fired continuously). Persistent for the rule's life; composed into the
  // rule-status note by the reporter.
  anchorChangeNote: string | null;
  // Matches that passed the rule's fingerprint on the latest scan — what the
  // reconciler judges resolution by. `state.size` can be larger: a script
  // rule's member that stopped verifying stays mounted (apply-rule.ts).
  verifiedCount: number;
  // Mounted members of a set-witnessed rule that no longer verify (kept, not
  // torn down). Reported on rule-status.
  unverifiedCount: number;
}

export function makeRuleState(): RuleRuntimeState {
  return {
    state: new Map<Element, RuleMountEntry>(),
    matchedSource: null,
    resolvedEl: null,
    witnessRejection: null,
    relativeReorderNote: null,
    anchorChangeNote: null,
    verifiedCount: 0,
    unverifiedCount: 0,
  };
}
