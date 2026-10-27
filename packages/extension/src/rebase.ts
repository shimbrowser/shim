// What the worker does with the engine's rebase ladder, as main does: the
// pure part. The engine runs the deterministic ladder in the page (baseline
// refresh, fallback promote, witness recovery, quarantine) and reports it;
// the host keeps the result. A rebase rewrites the rule's anchor and bumps
// the spec's version (the previous spec is snapshotted beside); a clean
// resolve on a new build refreshes the baseline the deploy gate compares
// against, kept per page kind (deploy-id's pagePathKey), never one per
// shim; a match remembers the page kind, so a later miss on a page kind the
// rule has never applied on is a wrong-page miss, not a break, and never
// escalates to a quarantine; a quarantine that does escalate holds the rule
// for review. No LLM re-anchor: review is the ceiling here.

import type { Spec, Anchor, AnchorSpec, Rule } from '@shimbrowser/core/types';
import { ruleFormDigest } from '@shimbrowser/core/rule-form';
import { pagePathKey } from '@shimbrowser/core/deploy-id';
import { readCaptureEvent, inCaptureBinding, supersedes, fingerprintOfCapture, type CaptureEvent } from '@shimbrowser/core/capture-event';
import { anchorDigest, withManagedFingerprint, withoutManagedKeys, managedFingerprintOf, hasManagedKeys } from '@shimbrowser/core/managed-anchor';
import type { QuarantineState, RuleStateRecord, CaptureRecord } from './store';

/** The anchor kinds the engine resolves; a reported anchor of any other kind is not an anchor. */
export const ANCHOR_KINDS: ReadonlySet<string> = new Set<AnchorSpec['kind']>(['css', 'data-attr', 'aria', 'text']);
const ANCHOR_SPEC_FIELDS = ['value', 'name', 'role', 'label', 'match'] as const;
const MAX_ANCHOR_TEXT = 4096;

/** A rule with this many page kinds remembered is global: every page kind counts as known. */
export const PAGE_MEMORY_CAP = 50;

/** The fields read off a runtime event; the wire shape varies per kind. */
export interface RuntimeEventPayload {
  specId?: unknown;
  ruleId?: unknown;
  path?: unknown;
  bundleHash?: unknown;
  anchor?: unknown;
  strategy?: unknown;
  via?: unknown;
  matched?: unknown;
  matchedVia?: unknown;
  expected?: unknown;
  seen?: unknown;
  fingerprint?: unknown;
  witness?: unknown;
  setWitness?: unknown;
  anchorDigest?: unknown;
  documentId?: unknown;
  /** The authored form of the rule the reporting runtime ran (BundledShim.forms). */
  form?: unknown;
  rev?: unknown;
  applyId?: unknown;
  captureNote?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A reported anchor spec, kept to the core's shape: one of the engine's
 * kinds, its string fields and nothing else. A reported event is the
 * page's word (a handler can report what it likes about its own shim),
 * so what is stored is what the schema allows, no more.
 */
function anchorSpec(v: unknown): AnchorSpec | null {
  if (!isRecord(v) || typeof v.kind !== 'string' || !ANCHOR_KINDS.has(v.kind)) return null;
  const out: AnchorSpec = { kind: v.kind as AnchorSpec['kind'] };
  for (const field of ANCHOR_SPEC_FIELDS) {
    const value = v[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > MAX_ANCHOR_TEXT) return null;
    if (field === 'match' && value !== 'exact' && value !== 'contains') return null;
    out[field] = value as never;
  }
  return out;
}

/** A reported anchor in the core's shape, or null: the primary of a known kind, fallbacks likewise, a fingerprint as an object. */
export function reportedAnchor(v: unknown): Anchor | null {
  if (!isRecord(v)) return null;
  const primary = anchorSpec(v.primary);
  if (!primary) return null;
  const anchor: Anchor = { primary };
  if (v.fallbacks !== undefined) {
    if (!Array.isArray(v.fallbacks)) return null;
    const fallbacks: AnchorSpec[] = [];
    for (const f of v.fallbacks) {
      const spec = anchorSpec(f);
      if (!spec) return null;
      fallbacks.push(spec);
    }
    anchor.fallbacks = fallbacks;
  }
  if (v.witness !== undefined) {
    if (!isRecord(v.witness) || typeof v.witness.tag !== 'string') return null;
    anchor.witness = v.witness as unknown as Anchor['witness'];
  }
  if (v.setWitness !== undefined) {
    if (!isRecord(v.setWitness)) return null;
    anchor.setWitness = v.setWitness as unknown as Anchor['setWitness'];
  }
  if (v.cardinality !== undefined) {
    if (v.cardinality !== 'many') return null;
    anchor.cardinality = 'many';
  }
  return anchor;
}

/**
 * The rule's anchor after a rebase: the authored fields the engine does not
 * rewrite (`cardinality`, `iframe`) stay the rule's own, the ladder comes
 * from the report, and the managed fingerprint is replaced as a whole by
 * what the report carries (a promotion of a `many` rule carries none, and
 * gets none).
 */
function rebasedAnchor(existing: Anchor | undefined, reported: Anchor): Anchor {
  const authored = existing ? withoutManagedKeys(existing) : undefined;
  const base: Anchor = { primary: reported.primary };
  if (reported.fallbacks) base.fallbacks = reported.fallbacks;
  if (authored?.iframe) base.iframe = authored.iframe;
  if (authored?.cardinality === 'many' || reported.cardinality === 'many') base.cardinality = 'many';
  return withManagedFingerprint(base, managedFingerprintOf(reported));
}

/**
 * Whether an event about `ruleId` was reported by a runtime running the
 * rule's current authored form (core's rule-form digest, over the stored
 * handler modules). An event with no stamp is taken (a runtime older than
 * the stamp); one with another form's stamp is a tab still running the rule
 * as it was before a commit, or an old handler module under an unchanged
 * rule, and its outcome is dropped. A missing rule matches nothing.
 */
export function eventFormMatches(spec: Spec, handlers: Record<string, string>, ruleId: string, form: unknown): boolean {
  if (form === undefined) return true;
  if (typeof form !== 'string') return false;
  const rule = (spec.rules ?? []).find((r) => r.id === ruleId);
  return rule !== undefined && ruleFormDigest(rule, handlers) === form;
}

/** Each rule's authored form, by id: what a bundle stamps on the rules it serves. */
export function ruleForms(spec: Spec, handlers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of spec.rules ?? []) {
    if (typeof rule?.id === 'string') Object.defineProperty(out, rule.id, { value: ruleFormDigest(rule, handlers), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

export interface RebaseOutcome {
  spec: Spec;
  version: number;
  before: Anchor | undefined;
  after: Anchor;
}

/**
 * The spec after a `rule-rebase`: the rule's anchor replaced, the version
 * bumped, the bundle hash advanced. Null when there is nothing to do: no
 * such rule, or the same primary at the same bundle hash (two documents
 * can report the same recovery; re-applying it would be churn with a
 * version bump and a snapshot for nothing). A new bundle hash with the same
 * primary still proceeds, so the gate stays honest.
 */
export function rebasedSpec(spec: Spec, ruleId: string, reported: unknown, bundleHash: unknown): RebaseOutcome | null {
  const anchor = reportedAnchor(reported);
  if (!anchor) return null;
  const rules = [...(spec.rules ?? [])];
  const index = rules.findIndex((r) => r.id === ruleId);
  const before = rules[index];
  if (index < 0 || !before) return null;
  const hash = typeof bundleHash === 'string' && bundleHash ? bundleHash : null;
  if (JSON.stringify(before.anchor?.primary) === JSON.stringify(anchor.primary) && (hash === null || spec.bundleHash === hash)) return null;
  const merged = rebasedAnchor(before.anchor, anchor);
  const after: Rule = { ...before, anchor: merged };
  rules[index] = after;
  const current = typeof spec.version === 'number' && Number.isFinite(spec.version) ? spec.version : 1;
  const version = current + 1;
  const next: Spec = { ...spec, rules, version, ...(hash ? { bundleHash: hash } : {}) };
  return { spec: next, version, before: before.anchor, after: merged };
}

/** The spec with its bundle hash advanced, or null when it already is (or the hash is no string). */
export function refreshedSpec(spec: Spec, bundleHash: unknown): Spec | null {
  if (typeof bundleHash !== 'string' || !bundleHash || spec.bundleHash === bundleHash) return null;
  return { ...spec, bundleHash };
}

export interface CaptureOutcome {
  spec: Spec;
  capture: CaptureRecord;
}

/**
 * A `rule-witness` event kept, by the engine's capture contract: each event
 * replaces the rule's whole managed fingerprint, is bound to the anchor it
 * was captured for, and is ordered by document then rev (a later document
 * replaces, within a document only a higher rev does), withdrawal (an
 * explicit "none") included. A fingerprint that came committed (the
 * file's, a rebase's) is never captured over: only a rule that has none,
 * or one whose fingerprint this host captured (`capture`), takes a
 * capture. Null when nothing changes.
 */
export function capturedSpec(spec: Spec, ruleId: string, capture: CaptureRecord | undefined, payload: RuntimeEventPayload): CaptureOutcome | null {
  const read = readCaptureEvent({ kind: 'rule-witness', ...payload });
  if (!read) return null;
  const rules = [...(spec.rules ?? [])];
  const index = rules.findIndex((r) => r.id === ruleId);
  const rule = rules[index];
  if (index < 0 || !rule || !rule.anchor) return null;
  if (hasManagedKeys(rule.anchor) && !capture) return null;
  const binding = { applyId: null, anchorDigest: anchorDigest(rule.anchor) };
  if (!inCaptureBinding(read, binding)) return null;
  const current: CaptureEvent | null = capture
    ? { witness: null, setWitness: null, documentId: capture.documentId, anchorDigest: capture.anchorDigest, rev: capture.rev, applyId: null, note: null }
    : null;
  if (!supersedes(read, current)) return null;
  const anchor = withManagedFingerprint(withoutManagedKeys(rule.anchor), fingerprintOfCapture(read));
  rules[index] = { ...rule, anchor };
  return {
    spec: { ...spec, rules },
    capture: { documentId: read.documentId, rev: read.rev, anchorDigest: read.anchorDigest ?? binding.anchorDigest },
  };
}

/** The page memory with `path`'s kind remembered as of `now`. */
export function rememberPath(paths: Readonly<Record<string, number>>, path: unknown, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, seen] of Object.entries(paths)) Object.defineProperty(out, key, { value: seen, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(out, pagePathKey(path), { value: now, enumerable: true, writable: true, configurable: true });
  return out;
}

/**
 * Should a miss on `path` escalate to a quarantine? Yes when the rule has
 * no memory at all (never recorded: escalate as before), when it has
 * applied on this page kind, or when it is known on so many kinds that it
 * is plainly global. No only when it has memory and this kind is not in
 * it: a wrong-page miss. No path at all escalates.
 */
export function escalationAllowed(paths: Readonly<Record<string, number>> | undefined, path: unknown, cap = PAGE_MEMORY_CAP): boolean {
  if (typeof path !== 'string') return true;
  const known = paths ? Object.keys(paths) : [];
  if (known.length === 0 || known.length >= cap) return true;
  return known.includes(pagePathKey(path));
}

/** The review reason a `rule-quarantined` payload states, in main's words. */
export function quarantineFrom(payload: RuntimeEventPayload, now: number): QuarantineState {
  const seen = Array.isArray(payload.seen) ? payload.seen : [];
  const reason = payload.fingerprint === 'conflicted'
    ? 'the rule carries two conflicting fingerprints — re-anchor it to recapture'
    : payload.fingerprint === 'set'
      ? seen.length
        ? `anchor resolves, but none of the matches look like the original set (${String(seen[0])})`
        : 'the set of elements could not be found after a site update'
      : seen.length
        ? `anchor resolves, but the match no longer looks like the original target (${String(seen[0])})`
        : 'the target could not be found after a site update';
  return { reason, expected: payload.expected ?? null, seen, occurredAt: now };
}

/** A fresh rule-state record. */
export function emptyRuleState(shimId: string, ruleId: string): RuleStateRecord {
  return { shimId, ruleId, paths: {} };
}
