// The anchor fields the ENGINE owns: verification fingerprints captured from
// the live page, never authored, never shown to a model. Every site that
// strips, digests, refuses or carries them goes through this one list, so a
// new engine-managed field is one line here, not a hunt across the tree
// (managed-anchor-keys-harness pins each site to it).
//
//   witness     the single-element fingerprint (witness.ts)
//   setWitness  the multi-match set fingerprint (set-witness.ts), a separate
//               field so an older engine (which reads any `witness` as a
//               single element) ignores it
//
// The two are mutually exclusive as written by current engines. An older
// engine can still attach an element `witness` next to an inert
// `setWitness`; readers call that `conflicted` (fingerprintKind).

import type { Anchor } from './types';
import { sha256Hex } from './sha256';

export const ENGINE_MANAGED_ANCHOR_KEYS = ['witness', 'setWitness'] as const;
export type EngineManagedAnchorKey = typeof ENGINE_MANAGED_ANCHOR_KEYS[number];

/** The engine-managed fields of an anchor, each in its own field. */
export type ManagedFingerprint = Pick<Anchor, EngineManagedAnchorKey>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether an anchor-shaped value carries any engine-managed field. */
export function hasManagedKeys(anchor: unknown): boolean {
  if (!isRecord(anchor)) return false;
  return ENGINE_MANAGED_ANCHOR_KEYS.some((key) => key in anchor);
}

/** The engine-managed keys an anchor-shaped value carries, in list order. */
export function managedKeysIn(anchor: unknown): EngineManagedAnchorKey[] {
  if (!isRecord(anchor)) return [];
  return ENGINE_MANAGED_ANCHOR_KEYS.filter((key) => key in anchor);
}

/**
 * A shallow copy of an anchor-shaped value without any engine-managed field.
 * Returns the same object when there is nothing to strip.
 */
export function withoutManagedKeys<T extends object>(anchor: T): T {
  if (!hasManagedKeys(anchor)) return anchor;
  const out: Record<string, unknown> = { ...(anchor as Record<string, unknown>) };
  for (const key of ENGINE_MANAGED_ANCHOR_KEYS) delete out[key];
  return out as T;
}

/** Delete every engine-managed field from an anchor-shaped record in place. */
export function deleteManagedKeys(anchor: Record<string, unknown>): void {
  for (const key of ENGINE_MANAGED_ANCHOR_KEYS) delete anchor[key];
}

/** The engine-managed fields an anchor carries (only those present). */
export function managedFingerprintOf(anchor: Anchor | undefined): ManagedFingerprint {
  const out: ManagedFingerprint = {};
  if (!anchor) return out;
  if (anchor.witness !== undefined) out.witness = anchor.witness;
  if (anchor.setWitness !== undefined) out.setWitness = anchor.setWitness;
  return out;
}

/**
 * `to` with every engine-managed field `from` carries restored to its OWN
 * field (a set fingerprint never lands in `witness`, nor the reverse). Fields
 * `to` already carries are replaced; `to`'s other fields are kept.
 */
export function withManagedFingerprint(to: Anchor, from: ManagedFingerprint): Anchor {
  const out: Anchor = { ...to };
  if (from.witness !== undefined) out.witness = from.witness;
  if (from.setWitness !== undefined) out.setWitness = from.setWitness;
  return out;
}

/**
 * What an anchor's fingerprint state is:
 *   none        neither field
 *   element     an element witness only
 *   set         a set witness only
 *   conflicted  both (an older engine attached an element witness beside an
 *               inert set witness): filter with the element witness, recover
 *               with neither, and say the rule needs a recapture
 */
export type FingerprintKind = 'none' | 'element' | 'set' | 'conflicted';

export function fingerprintKind(anchor: unknown): FingerprintKind {
  if (!isRecord(anchor)) return 'none';
  const element = isRecord(anchor.witness);
  const set = isRecord(anchor.setWitness);
  if (element && set) return 'conflicted';
  if (element) return 'element';
  if (set) return 'set';
  return 'none';
}

/**
 * Deterministic JSON: object keys sorted, arrays kept in order, undefined
 * dropped. Used for digests and for "did this change" comparisons.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** sha256 of the anchor without its engine-managed fields — what a stored witness is pinned to. */
export function anchorDigest(anchor: Anchor | undefined): string {
  if (!anchor) return sha256Hex('null');
  return sha256Hex(stableStringify(withoutManagedKeys(anchor)));
}
