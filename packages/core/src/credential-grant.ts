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

// A rule without its anchor's witness fields and without its inline
// handler sources (those are hashed as the rule's effective handlers below).
function stripRule(rule: unknown): unknown {
  if (!isRecord(rule)) return rule;
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(rule)) as Record<string, unknown>;
  if (isRecord(copy.anchor)) deleteManagedKeys(copy.anchor);
  delete copy.handlers;
  return copy;
}

function stripRules(rules: unknown): unknown {
  return Array.isArray(rules) ? rules.map(stripRule) : rules;
}

// What each rule actually runs: the stored handlers with the rule's own
// inline ones on top (a rule's inline handler wins on a name collision, as
// the engine resolves it). Hashing this rather than the raw spec keeps the
// digest stable when a store copies stored handler modules onto rules (an
// imported shim read through its hydrated view, then written back).
function effectiveHandlers(rules: unknown, handlers: Record<string, string>): unknown {
  if (!Array.isArray(rules)) return [];
  return rules.map((r) => (isRecord(r) && isRecord(r.handlers) ? { ...handlers, ...r.handlers } : { ...handlers }));
}

/**
 * The digest a credential grant is bound to. `handlers` are the shim's
 * stored handler sources by name; a rule's inline `rule.handlers` override
 * them for that rule.
 */
export function executionManifestDigest(spec: Spec, handlers: Record<string, string> = {}): string {
  const body: Record<string, unknown> = {};
  const record = spec as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(record)) {
    if (UNMANAGED_TOP_LEVEL.has(k)) continue;
    body[k] = k === 'rules' ? stripRules(v) : v;
  }
  let defaultRuns: unknown = null;
  if (isRecord(body.default)) {
    const d = body.default;
    const dHandlers = isRecord(d.handlers) ? d.handlers as Record<string, string> : {};
    defaultRuns = effectiveHandlers(d.rules, dHandlers);
    body.default = { ...d, rules: stripRules(d.rules), handlers: undefined };
  }
  return sha256Hex(canonical({ spec: body, handlers, runs: effectiveHandlers(record.rules, handlers), defaultRuns }));
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
