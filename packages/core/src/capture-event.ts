// The `rule-witness` event, as hosts read it. The engine reports a rule's
// fingerprint while a preview runs; a host turns the events into the one
// fingerprint it attaches to the rule at commit.
//
// Every event is an ATOMIC REPLACEMENT of the rule's whole engine-managed
// fingerprint state — `{ witness, setWitness }`, either or neither (an
// explicit "none" withdraws whatever came before). Events are provisional
// while the preview runs: a set's aggregate grows as members appear, a
// one-member scan's element witness is superseded by a set once a second
// member shows up, a mixed-tag member withdraws the set. So a host keeps the
// LATEST valid event inside the preview's binding and freezes it at its own
// read boundary (when it reads the preview's evidence):
//
//   binding   the host's preview version (`applyId`, stamped by the host),
//             the anchor the event was captured for (`anchorDigest`), and
//             the document (`documentId`, minted by the engine per page)
//   order     `rev`, minted by the engine when the work is SCHEDULED, so a
//             slow job (an element witness waiting on enrichment) can't
//             outrank a later decision
//
// Within the binding, a later document replaces an earlier one; within a
// document, only a higher rev replaces.

import type { Witness, SetWitness } from './types';
import type { ManagedFingerprint } from './managed-anchor';

/** Why a capture ended with no fingerprint (the engine's note on a "none" event). */
export type CaptureNote = 'one-member' | 'mixed-tags' | 'too-many' | 'remove-rule';

export interface CaptureEvent {
  witness: Witness | null;
  setWitness: SetWitness | null;
  documentId: string | null;
  anchorDigest: string | null;
  rev: number;
  applyId: string | null;
  note: CaptureNote | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const NOTES: ReadonlySet<string> = new Set<CaptureNote>(['one-member', 'mixed-tags', 'too-many', 'remove-rule']);

/**
 * A `rule-witness` event's capture state, or null when it isn't one. An event
 * from an engine that predates set witnesses (only `witness`, no `rev`) reads
 * as an element capture at rev -1.
 */
export function readCaptureEvent(e: unknown): CaptureEvent | null {
  if (!isRecord(e) || e.kind !== 'rule-witness') return null;
  const witness = isRecord(e.witness) ? (e.witness as unknown as Witness) : null;
  const setWitness = isRecord(e.setWitness) ? (e.setWitness as unknown as SetWitness) : null;
  return {
    witness,
    setWitness,
    documentId: typeof e.documentId === 'string' ? e.documentId : null,
    anchorDigest: typeof e.anchorDigest === 'string' ? e.anchorDigest : null,
    rev: typeof e.rev === 'number' && Number.isFinite(e.rev) ? e.rev : -1,
    applyId: typeof e.applyId === 'string' ? e.applyId : null,
    note: typeof e.captureNote === 'string' && NOTES.has(e.captureNote) ? (e.captureNote as CaptureNote) : null,
  };
}

/** The preview a capture must belong to. */
export interface CaptureBinding {
  /** The preview version the host applied; null when the host stamps none. */
  applyId: string | null;
  /** anchorDigest() of the rule's anchor as applied. */
  anchorDigest: string;
}

/** Whether `e` belongs to `binding`. */
export function inCaptureBinding(e: CaptureEvent, binding: CaptureBinding): boolean {
  // A host may not stamp applyId, and a consumer accepts events without it
  // (PageHost PreviewRule.applyId); a stamped one must be this preview's.
  if (binding.applyId !== null && e.applyId !== null && e.applyId !== binding.applyId) return false;
  // An event without a digest predates bindings: accepted on applyId alone.
  if (e.anchorDigest !== null && e.anchorDigest !== binding.anchorDigest) return false;
  return true;
}

/**
 * Whether `next` replaces `current` (both already in the binding): a
 * different document is a newer one (events arrive in order per preview); in
 * the same document only a higher rev wins.
 */
export function supersedes(next: CaptureEvent, current: CaptureEvent | null): boolean {
  if (!current) return true;
  if (next.documentId !== current.documentId) return true;
  return next.rev > current.rev;
}

/** The latest capture inside the binding among `events` (arrival order), or null. */
export function selectCapture(events: readonly unknown[], binding: CaptureBinding): CaptureEvent | null {
  let best: CaptureEvent | null = null;
  for (const raw of events) {
    const e = readCaptureEvent(raw);
    if (!e || !inCaptureBinding(e, binding)) continue;
    if (supersedes(e, best)) best = e;
  }
  return best;
}

/** The fingerprint a capture says the rule carries: each kind in its own field, "none" as `{}`. */
export function fingerprintOfCapture(e: CaptureEvent): ManagedFingerprint {
  const out: ManagedFingerprint = {};
  if (e.witness) out.witness = e.witness;
  if (e.setWitness) out.setWitness = e.setWitness;
  return out;
}
