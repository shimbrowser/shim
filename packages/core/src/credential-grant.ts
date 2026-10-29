// What a credential grant is bound to (D17): the code that may use a placed
// secret. A user approves `(shim, field, placement)` against the shim as it
// is when they approve; an authored change to anything that runs, or decides
// where it runs, suspends the grant until they approve again.
//
// The execution manifest is the spec with its handler sources, minus what
// the engine and the host manage on their own (versions, priority, deploy
// hashes, and the anchors' witness fingerprints). Pure: no storage.

import type { Spec } from './types';
import { sha256Hex } from './sha256';
import { deleteManagedKeys } from './managed-anchor';

// Top-level spec fields that never change what runs.
const UNMANAGED_TOP_LEVEL = new Set(['version', 'bundleHash', 'priority', '__cssPriority', 'autoRepair', 'intent']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

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
