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

import type { Spec, Anchor, Rule } from '@shimbrowser/core/types';
import { pagePathKey } from '@shimbrowser/core/deploy-id';
import type { QuarantineState, RuleStateRecord } from './store';

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
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isAnchor(v: unknown): v is Anchor {
  return isRecord(v) && isRecord(v.primary) && typeof v.primary.kind === 'string' && typeof v.primary.value === 'string';
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
export function rebasedSpec(spec: Spec, ruleId: string, anchor: unknown, bundleHash: unknown): RebaseOutcome | null {
  if (!isAnchor(anchor)) return null;
  const rules = [...(spec.rules ?? [])];
  const index = rules.findIndex((r) => r.id === ruleId);
  const before = rules[index];
  if (index < 0 || !before) return null;
  const hash = typeof bundleHash === 'string' && bundleHash ? bundleHash : null;
  if (JSON.stringify(before.anchor?.primary) === JSON.stringify(anchor.primary) && (hash === null || spec.bundleHash === hash)) return null;
  const after: Rule = { ...before, anchor };
  rules[index] = after;
  const current = typeof spec.version === 'number' && Number.isFinite(spec.version) ? spec.version : 1;
  const version = current + 1;
  const next: Spec = { ...spec, rules, version, ...(hash ? { bundleHash: hash } : {}) };
  return { spec: next, version, before: before.anchor, after: anchor };
}

/** The spec with its bundle hash advanced, or null when it already is (or the hash is no string). */
export function refreshedSpec(spec: Spec, bundleHash: unknown): Spec | null {
  if (typeof bundleHash !== 'string' || !bundleHash || spec.bundleHash === bundleHash) return null;
  return { ...spec, bundleHash };
}

/**
 * The spec with a captured fingerprint kept on a rule that has none: a
 * shim that arrived without witnesses (authored where none were captured)
 * gains them from its first clean resolves, so the ladder's recovery and
 * verification have something to work with on the next deploy. A rule that
 * has a fingerprint keeps it (the commit's, or the last rebase's). Null
 * when nothing changes.
 */
export function witnessedSpec(spec: Spec, ruleId: string, witness: unknown, setWitness: unknown): Spec | null {
  const rules = [...(spec.rules ?? [])];
  const index = rules.findIndex((r) => r.id === ruleId);
  const rule = rules[index];
  if (index < 0 || !rule || !rule.anchor) return null;
  if (rule.anchor.witness || rule.anchor.setWitness) return null;
  const anchor: Anchor = { ...rule.anchor };
  if (isRecord(witness)) anchor.witness = witness as unknown as Anchor['witness'];
  else if (isRecord(setWitness)) anchor.setWitness = setWitness as unknown as Anchor['setWitness'];
  else return null;
  rules[index] = { ...rule, anchor };
  return { ...spec, rules };
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
