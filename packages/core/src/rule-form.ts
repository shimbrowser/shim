// The authored form of a rule, as one digest: what the rule says, with
// nothing the engine or a host learned or stamped on it. Two uses share it:
//
//   - the working-copy differ asks "did the agent change this rule?" by
//     comparing the form of the folder's rule with the form of the one it
//     last applied;
//   - a host stamps every rule it applies (a bundled rule, a preview) with
//     its form, the page runtime echoes the stamp on every event about the
//     rule (a rebase, a quarantine, a capture, a status), and the host
//     keeps an outcome only while the stored rule still has that form. A
//     tab still running a rule as it was before a commit, or an old handler
//     module under an unchanged rule, reports against a form the store no
//     longer holds, and its outcome is dropped; a stored witness, a learned
//     fingerprint or a bumped version leaves the form unchanged, so
//     unchanged rules keep learning.
//
// The form is: every field of the rule but `handlers`, the anchor with the
// engine-managed keys (witness, set witness) removed, and each handler the
// rule references as its canonical module source (an inline expression,
// the shape a preview carries, read back to the module it stands for; a
// stored module as is; surrounding whitespace and trailing semicolons
// ignored). Hashed over the stable JSON, as anchorDigest is.

import type { Rule } from './types';
import { stableStringify, withoutManagedKeys } from './managed-anchor';
import { moduleForExpression } from './handler-source';
import { canonicalModule } from './spec-lint';
import { referencedHandlerNames } from './shim-folder';
import { sha256Hex } from './sha256';

/**
 * The handler modules a rule runs with: the stored module for each name it
 * references, overridden by its own inline source (as the module that
 * expression stands for). Own properties only: a handler named like an
 * Object.prototype member must not resolve through the prototype.
 */
export function ruleModules(rule: Rule, stored: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of referencedHandlerNames(rule)) {
    const source = Object.prototype.hasOwnProperty.call(stored, name) ? stored[name] : undefined;
    if (typeof source === 'string') out[name] = source;
  }
  for (const [name, source] of Object.entries(rule.handlers || {})) {
    if (typeof source === 'string') out[name] = moduleForExpression(source);
  }
  return out;
}

/** The rule's authored form as stable JSON (ruleFormDigest's input), for a comparison that needs no hash. */
export function ruleFormKey(rule: Rule, modules: Record<string, string>): string {
  const { handlers: _handlers, ...rest } = rule;
  const anchor = rest.anchor ? withoutManagedKeys(rest.anchor) : undefined;
  const canonical: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, source] of Object.entries(modules)) canonical[name] = canonicalModule(source);
  return stableStringify({ ...rest, anchor, handlers: canonical });
}

/** The digest of the rule's authored form: 16 hex characters, as anchorDigest. */
export function ruleFormDigest(rule: Rule, stored: Record<string, string> = {}): string {
  return sha256Hex(ruleFormKey(rule, ruleModules(rule, stored))).slice(0, 16);
}
