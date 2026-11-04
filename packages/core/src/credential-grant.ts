// What a credential grant is bound to (D17): the code that may use a placed
// secret. A user approves `(shim, field, placement)` against the shim as it
// is when they approve; an authored change to anything that runs, or decides
// where it runs, suspends the grant until they approve again.
//
// The execution manifest is the spec with its handler sources, minus what
// the engine and the host manage on their own (versions, priority, deploy
// hashes, and the anchors' witness fingerprints). Pure: no storage.
//
// The rest of a grant's rule lives here too, so every host keeps the same
// one: which fields are placed, what an approval names, when a stored grant
// is current, and how one re-binds across the engine's own rebase. A host
// keeps the rows; nothing here reads or writes them.

import type { Spec } from './types';
import { sha256Hex } from './sha256';
import { normalizeSchema, type CredentialUse } from './settings-schema';
import { credentialUseBinding } from './credential-placement';
import { deleteManagedKeys } from './managed-anchor';
import { isRecord } from './is-record';

// Top-level spec fields that never change what runs.
const UNMANAGED_TOP_LEVEL = new Set(['version', 'bundleHash', 'priority', '__cssPriority', 'autoRepair', 'intent']);

// JSON with object keys sorted at every depth, so a digest doesn't move when
// a store reorders keys.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// A rule without its anchor's witness fields — the only part of a rule the
// engine manages itself. Everything else, inline `handlers` included, is
// hashed as written: the digest never drops what it doesn't model (fail
// closed). A host that stores the same code in two forms (the browser's
// bare imported rules vs their hydrated view) brings a spec to one form
// before hashing it.
function stripRule(rule: unknown): unknown {
  if (!isRecord(rule)) return rule;
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(rule)) as Record<string, unknown>;
  if (isRecord(copy.anchor)) deleteManagedKeys(copy.anchor);
  return copy;
}

function stripRules(rules: unknown): unknown {
  return Array.isArray(rules) ? rules.map(stripRule) : rules;
}

/**
 * The digest a credential grant is bound to: the spec as written (minus the
 * top-level fields that never change what runs and the anchors' witness
 * fields) and the host's stored handler sources by name.
 */
export function executionManifestDigest(spec: Spec, handlers: Record<string, string> = {}): string {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec as unknown as Record<string, unknown>)) {
    if (UNMANAGED_TOP_LEVEL.has(k)) continue;
    body[k] = k === 'rules' ? stripRules(v) : v;
  }
  if (isRecord(body.default)) body.default = { ...body.default, rules: stripRules(body.default.rules) };
  return sha256Hex(canonical({ spec: body, handlers }));
}

/**
 * The same digest with every rule's anchor left out: what stays fixed when
 * the engine's own deterministic, witness-verified rebase moves an anchor.
 * A host re-binds a grant across a rebase only when this part is unchanged.
 */
export function executionManifestDigestWithoutAnchors(spec: Spec, handlers: Record<string, string> = {}): string {
  const noAnchors = (rules: unknown): unknown => Array.isArray(rules)
    ? rules.map((r) => (isRecord(r) ? { ...r, anchor: undefined } : r))
    : rules;
  const copy = { ...(spec as unknown as Record<string, unknown>) };
  copy.rules = noAnchors(copy.rules);
  if (isRecord(copy.default)) copy.default = { ...copy.default, rules: noAnchors(copy.default.rules) };
  return executionManifestDigest(copy as unknown as Spec, handlers);
}

/** A placed secret: a `secret` setting that declares `use`. */
export interface PlacedField {
  key: string;
  label: string;
  use: CredentialUse;
}

/**
 * The spec's secret fields that declare `use`, in declaration order. A host
 * that accepts specs whose settings schema didn't validate checks that first
 * (`settingsSchemaProblems`).
 */
export function placedFields(spec: Spec): PlacedField[] {
  return normalizeSchema(spec).flatMap((f) => (f.type === 'secret' && f.use ? [{ key: f.key, label: f.label, use: f.use }] : []));
}

/**
 * What a user is shown and approves: the placement and the code as one
 * opaque token. An approval naming another token is stale (the shim changed
 * since it was shown) and is refused.
 */
export function grantReviewToken(use: CredentialUse, digest: string): string {
  return sha256Hex(`${credentialUseBinding(use)}\n${digest}`);
}

export type GrantState = 'granted' | 'suspended' | 'none';

/** What a host stores for a grant: the placement and the digest approved. */
export interface StoredGrant {
  binding: string;
  digest: string;
}

/**
 * A stored grant's state against the field's placement now and the shim's
 * digest now (null when the host has no code to bind to): granted only when
 * both are exactly what was approved.
 */
export function grantState(row: StoredGrant | undefined, use: CredentialUse, digest: string | null): GrantState {
  if (!row) return 'none';
  return digest !== null && row.binding === credentialUseBinding(use) && row.digest === digest ? 'granted' : 'suspended';
}

export type GrantApproval =
  | { ok: true; binding: string; digest: string }
  | { ok: false; error: string; code?: 'stale' };

/** What approving `key` with `review` would store, if `review` is what the shim is now. */
export function checkGrantApproval(spec: Spec, handlers: Record<string, string>, key: string, review: string): GrantApproval {
  const field = placedFields(spec).find((f) => f.key === key);
  if (!field) return { ok: false, error: `"${key}" is not one of this shim's placed secrets` };
  const digest = executionManifestDigest(spec, handlers);
  if (review !== grantReviewToken(field.use, digest)) return { ok: false, error: 'the shim changed since this was shown; review it again', code: 'stale' };
  return { ok: true, binding: credentialUseBinding(field.use), digest };
}

/**
 * After the engine's rebase moved an anchor: the digest a grant current for
 * `before` moves to, when nothing but anchors changed; null otherwise (the
 * grant then stays bound to the old code, suspended).
 */
export function rebindGrantDigest(before: Spec, after: Spec, handlers: Record<string, string>): { from: string; to: string } | null {
  if (executionManifestDigestWithoutAnchors(before, handlers) !== executionManifestDigestWithoutAnchors(after, handlers)) return null;
  return { from: executionManifestDigest(before, handlers), to: executionManifestDigest(after, handlers) };
}
