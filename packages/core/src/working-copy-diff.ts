// The working-copy differ (shim-core design D10): an attached session sends
// its whole shim folder; the host diffs it against the session's working
// state and applies the difference through the existing emit path. This is
// that diff — (previous working spec + stored handler modules, new folder)
// → the DeltaOp list, in the same shape the browser's internal worker emits
// after its own normalization:
//
//   - a changed rule → `update-rule` carrying the whole rule with its
//     handlers inline as expressions (handler-source.ts); a new rule →
//     `add-rule`; a deleted one → `remove-rule`. An unchanged rule gets no op.
//   - applyDelta can only replace in place or append, so a rule that moved
//     (or that sits after a new one) is removed and re-emitted, which
//     appends it. The resulting rule order is the folder's.
//   - settings / permissions / intent / storage / connections changes →
//     their replace-wholesale `set-*` op. They're compared in the form
//     applyDelta stores them in (an absent settings / permissions list is
//     `[]`, intent is normalizeIntent'd), so applying the ops always yields a
//     state the same folder diffs against to no ops — re-syncing an unchanged
//     folder never emits an op (and a commit) again.
//   - any other spec field (id, match, css, …) has no op, so changing it is
//     a ShimFolderError('not-editable') rather than a silent drop.
//
// Witnesses: the folder never carries them. A rule whose anchor is unchanged
// (same anchorDigest) gets the stored witness back on its op, so re-emitting
// it doesn't throw away a verified fingerprint; a changed anchor goes out
// without one and the engine re-captures on apply. The host ignores
// .shim-state.json — in attach mode it holds witnesses itself.

import type { Spec, Rule } from './types';
import type { DeltaOp } from './spec-delta';
import { moduleForExpression, moduleToExpression } from './handler-source';
import { canonicalModule } from './spec-lint';
import { normalizeIntent } from './intent';
import {
  readShimFolder, ShimFolderError, anchorDigest, referencedHandlerNames, stableStringify, handlerPath, nameMap,
} from './shim-folder';
import type { FolderInput } from './shim-folder';

/** The session's working state: the spec it would commit, and the stored handler modules. */
export interface WorkingState {
  spec: Spec;
  /** Module-form sources (patch_files) for handlers a rule names but doesn't carry inline. */
  handlers?: Record<string, string>;
}

export interface WorkingCopyDiff {
  ops: DeltaOp[];
  /** Non-fatal notes (e.g. a handler file no rule uses). */
  warnings: string[];
}

// Declarations with a replace-wholesale op, in the order their ops go out.
const DECLARATION_FIELDS = ['settings', 'permissions', 'intent', 'storage', 'connections'] as const;
type DeclarationField = (typeof DECLARATION_FIELDS)[number];
// Never in the folder, never compared: tool-managed or stamped at runtime.
const UNCOMPARED_FIELDS = new Set(['rules', 'handlers', 'version', 'bundleHash', 'priority', '__cssPriority']);

// One rule's handler modules as the previous state stored them: its own
// inline source wins, then the stored map.
function previousModules(rule: Rule, stored: Record<string, string>): Record<string, string> {
  const out = nameMap<string>();
  for (const name of referencedHandlerNames(rule)) {
    const source = Object.hasOwn(stored, name) ? stored[name] : undefined;
    if (typeof source === 'string') out[name] = source;
  }
  for (const [name, source] of Object.entries(rule.handlers || {})) {
    if (typeof source === 'string') out[name] = moduleForExpression(source);
  }
  return out;
}

// Rule identity for "did it change": everything authored, witness dropped,
// handlers compared as canonical module source.
function ruleFingerprint(rule: Rule, modules: Record<string, string>): string {
  const { handlers: _handlers, ...rest } = rule;
  const anchor = rest.anchor ? { ...rest.anchor } : undefined;
  if (anchor) delete anchor.witness;
  const canonical = nameMap<string>();
  for (const [name, source] of Object.entries(modules)) canonical[name] = canonicalModule(source);
  return stableStringify({ ...rest, anchor, handlers: canonical });
}

// A declaration as applyDelta would store it: set-settings / set-permissions
// store a missing list as `[]`, set-intent trims and caps. A malformed value
// passes through unchanged so declarationOp still reports it.
function canonicalDeclaration(field: DeclarationField, value: unknown): unknown {
  if ((field === 'settings' || field === 'permissions') && value === undefined) return [];
  if (field === 'intent' && typeof value === 'string') return normalizeIntent(value);
  return value;
}

function declarationOp(field: DeclarationField, value: unknown, problems: string[]): DeltaOp | null {
  switch (field) {
    case 'settings':
      if (value !== undefined && !Array.isArray(value)) { problems.push('"settings" must be an array'); return null; }
      return { op: 'set-settings', settings: Array.isArray(value) ? value : [] };
    case 'permissions':
      if (value !== undefined && (!Array.isArray(value) || !value.every((p) => typeof p === 'string'))) {
        problems.push('"permissions" must be an array of strings');
        return null;
      }
      return { op: 'set-permissions', permissions: Array.isArray(value) ? (value as string[]) : [] };
    case 'intent':
      if (value !== undefined && typeof value !== 'string') { problems.push('"intent" must be a string'); return null; }
      return { op: 'set-intent', intent: normalizeIntent(value) };
    case 'storage':
      return { op: 'set-storage', storage: value };
    case 'connections':
      return { op: 'set-connections', connections: value };
  }
}

/**
 * Diff a shim folder against the session's working state. Throws a
 * ShimFolderError for a malformed folder ('malformed-shim-folder') or an edit
 * no op can express ('not-editable'); otherwise returns the ops (possibly
 * none) and any warnings.
 */
export function diffWorkingCopy(previous: WorkingState, folder: FolderInput): WorkingCopyDiff {
  const { spec: next, handlers: files } = readShimFolder(folder);
  const prev = previous.spec;
  const stored = previous.handlers || {};
  const problems: string[] = [];
  const warnings: string[] = [];

  // Fields no op can carry must be untouched.
  const nextRecord = next as unknown as Record<string, unknown>;
  const prevRecord = prev as unknown as Record<string, unknown>;
  const declarations = new Set<string>(DECLARATION_FIELDS);
  for (const key of new Set([...Object.keys(prevRecord), ...Object.keys(nextRecord)])) {
    if (UNCOMPARED_FIELDS.has(key) || declarations.has(key)) continue;
    if (stableStringify(prevRecord[key]) !== stableStringify(nextRecord[key])) {
      problems.push(`"${key}" can't be changed from the working copy`);
    }
  }
  if (problems.length) throw new ShimFolderError('not-editable', problems);

  const ops: DeltaOp[] = [];
  for (const field of DECLARATION_FIELDS) {
    const before = canonicalDeclaration(field, prevRecord[field]);
    if (stableStringify(before) === stableStringify(canonicalDeclaration(field, nextRecord[field]))) continue;
    const op = declarationOp(field, nextRecord[field], problems);
    if (op) ops.push(op);
  }
  if (problems.length) throw new ShimFolderError('malformed-shim-folder', problems);

  const prevRules = (prev.rules || []).filter((rule) => typeof rule?.id === 'string');
  const prevById = new Map(prevRules.map((rule) => [rule.id, rule]));
  const prevIndex = new Map(prevRules.map((rule, index) => [rule.id, index]));
  const nextRules = next.rules || [];
  const nextIds = new Set(nextRules.map((rule) => rule.id));

  // Handler files every rule references, plus — so a checkout round-trips —
  // a name the previous rule carried inline without referencing it.
  const used = new Set<string>();
  const built = nextRules.map((authored) => {
    const before = prevById.get(authored.id);
    const names = new Set(referencedHandlerNames(authored));
    for (const name of Object.keys(before?.handlers || {})) if (Object.hasOwn(files, name)) names.add(name);
    const modules = nameMap<string>();
    for (const name of names) {
      if (!Object.hasOwn(files, name)) continue;
      const source = files[name];
      if (source === undefined) continue;
      modules[name] = source;
      used.add(name);
    }
    const rule: Rule = { ...authored };
    // fromEntries defines each name as an own property (`__proto__` too)
    // while the op's rule keeps an ordinary object for the emit path.
    if (names.size) {
      rule.handlers = Object.fromEntries(Object.entries(modules).map(([name, source]) => [name, moduleToExpression(source)]));
    }
    const changed = !before || ruleFingerprint(authored, modules) !== ruleFingerprint(before, previousModules(before, stored));
    if (before?.anchor?.witness && rule.anchor && anchorDigest(before.anchor) === anchorDigest(rule.anchor)) {
      rule.anchor = { ...rule.anchor, witness: before.anchor.witness };
    }
    return { rule, before, changed };
  });
  for (const name of Object.keys(files)) {
    if (!used.has(name)) warnings.push(`${handlerPath(name)} is not used by any rule — it was not applied`);
  }

  // The longest prefix of the folder's rules that are existing rules still in
  // their old relative order stays in place; everything after it is appended
  // in folder order.
  let keep = 0;
  let lastIndex = -1;
  for (const { rule } of built) {
    const index = prevIndex.get(rule.id);
    if (index === undefined || index < lastIndex) break;
    lastIndex = index;
    keep += 1;
  }

  for (const rule of prevRules) {
    if (!nextIds.has(rule.id)) ops.push({ op: 'remove-rule', ruleId: rule.id });
  }
  built.forEach(({ rule, before }, index) => {
    if (index >= keep && before) ops.push({ op: 'remove-rule', ruleId: rule.id });
  });
  built.forEach(({ rule, before, changed }, index) => {
    if (index < keep) {
      if (changed) ops.push({ op: 'update-rule', rule });
    } else {
      ops.push(before ? { op: 'update-rule', rule } : { op: 'add-rule', rule });
    }
  });

  return { ops, warnings };
}
