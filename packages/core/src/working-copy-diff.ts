// The working-copy differ: an attached session sends
// its whole shim folder; the host diffs it against the session's working
// state and applies the difference through the existing emit path. This is
// that diff — (previous working spec + stored handler modules, new folder)
// → the DeltaOp list, in the same shape the browser's internal worker emits
// after its own normalization:
//
//   - a changed rule → `update-rule` carrying the whole rule with its
//     handlers inline as expressions (handler-source.ts); a new rule →
//     `add-rule`; a deleted one → `remove-rule`. An unchanged rule gets no op,
//     except a `cardinality: 'many'` rule still without a fingerprint, which
//     is re-applied so the next preview can capture its set witness.
//   - applyDelta can only replace in place or append, so a rule that moved
//     (or that sits after a new one) is removed and re-emitted, which
//     appends it. The resulting rule order is the folder's.
//   - settings / permissions / intent / storage / connections changes →
//     their replace-wholesale `set-*` op. They're compared in the form
//     applyDelta stores them in (an absent settings / permissions list is
//     `[]`, intent is normalizeIntent'd), so applying the ops always yields a
//     state the same folder diffs against to no ops — re-syncing an unchanged
//     folder never emits an op (and a commit) again.
//   - a global shim's shared code space (`sharedHandlers`, name → raw
//     function-expression source) → one `set-shared-handler` per added or
//     changed name and one `remove-shared-handler` per dropped one. An absent
//     map is `{}`, the form applyDelta leaves once the last name is removed.
//     The evolution contract (a still-referenced function can't be removed)
//     is enforced at commit, as for an internal turn. On a non-global shim it
//     stays not-editable — an internal turn never adds a shared code space
//     there either.
//   - `match` (where the shim runs) → one replace-wholesale `set-match`, on
//     a non-global shim only (a global shim runs where it has a per-site
//     implementation, so there it stays not-editable). The value must be
//     `{ hosts: [...] }`,
//     non-empty, and every pattern the previous working list didn't carry
//     must pass match-scope's admission check (hostPatternProblem); patterns
//     already there are never re-validated (an imported list isn't broken by
//     an unrelated edit). With the committed list given, at most
//     MAX_NEW_MATCH_PATTERNS patterns may run the shim somewhere the
//     committed list doesn't (widenedPatterns: the commit card's own list) —
//     more is not-editable. Whether a newly covered host commits is the
//     host's question (the Shim browser asks on its commit card).
//   - any other spec field (id, css, …) has no op, so changing it is a
//     ShimFolderError('not-editable') rather than a silent drop.
//
// Witnesses: the folder never carries them. A rule whose anchor is unchanged
// (same anchorDigest) gets the stored witness back on its op, so re-emitting
// it doesn't throw away a verified fingerprint; a changed anchor goes out
// without one and the engine re-captures on apply. The host ignores
// .shim-state.json — in attach mode it holds witnesses itself.

import type { Spec, Rule } from './types';
import type { DeltaOp } from './spec-delta';
import { handlerWorlds, moduleForExpression, moduleToExpression } from './handler-source';
import { canonicalModule } from './spec-lint';
import { ruleModules, ruleFormKey } from './rule-form';
import { normalizeIntent } from './intent';
import { hasManagedKeys, withoutManagedKeys, withManagedFingerprint, managedFingerprintOf } from './managed-anchor';
import {
  readShimFolder, ShimFolderError, anchorDigest, referencedHandlerNames, stableStringify, handlerPath,
} from './shim-folder';
import type { FolderInput } from './shim-folder';
import { hostPatternProblem, widenedPatterns, MAX_NEW_MATCH_PATTERNS } from './match-scope';

/** The session's working state: the spec it would commit, and the stored handler modules. */
export interface WorkingState {
  spec: Spec;
  /** Module-form sources (patch_files) for handlers a rule names but doesn't carry inline. */
  handlers?: Record<string, string>;
  /**
   * The shim's `match.hosts` as committed, when the host knows it: the
   * baseline the widening cap counts against (MAX_NEW_MATCH_PATTERNS).
   * Absent, the previous working list stands in.
   */
  committedMatchHosts?: readonly unknown[];
  /**
   * Whether this host allows editing a non-global shim's `match.hosts` from the
   * folder. Editable only when true: a host that can ask (the Shim browser's
   * commit card) or tell (headless, in notes) opts in; absent or false keeps
   * match not-editable, as a global shim's is. Fail-closed by default.
   */
  matchEditable?: boolean;
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
// (On a global shim `sharedHandlers` is compared, per name, by
// sharedHandlerOps; on any other shim it's a field no op can carry.)
const UNCOMPARED_FIELDS = new Set(['rules', 'handlers', 'version', 'bundleHash', 'priority', '__cssPriority']);

// One rule's handler modules and its authored identity are rule-form.ts's
// (shared with the hosts, which stamp what they apply with the same form).
const previousModules = ruleModules;
const ruleFingerprint = ruleFormKey;

// A declaration as applyDelta would store it: set-settings / set-permissions
// store a missing list as `[]`, set-intent trims and caps. A malformed value
// passes through unchanged so declarationOp still reports it.
function canonicalDeclaration(field: DeclarationField, value: unknown): unknown {
  if ((field === 'settings' || field === 'permissions') && value === undefined) return [];
  if (field === 'intent' && typeof value === 'string') return normalizeIntent(value);
  return value;
}

// A non-editable field as checkout writes it. A global shim's promoted
// default goes out without its rules' witnesses and inline handler source
// (shim-folder.ts authoredSpec), so it is compared that way: the host keeps
// those fields, and an untouched default reads as unchanged.
function comparableField(key: string, value: unknown): unknown {
  if (key !== 'default' || !isRecord(value) || !Array.isArray(value.rules)) return value;
  return {
    ...value,
    rules: value.rules.map((rule: unknown) => {
      if (!isRecord(rule)) return rule;
      const { handlers: _handlers, ...rest } = rule;
      if (!isRecord(rest.anchor)) return rest;
      return { ...rest, anchor: withoutManagedKeys(rest.anchor) };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The shared code space's per-name ops: set every name the folder adds or
// changes (in its order), remove every name it dropped. applyDelta upserts
// into a plain object, where a `__proto__` key would never land, so that
// name is refused rather than re-emitted on every sync.
function sharedHandlerOps(before: unknown, after: unknown, problems: string[]): DeltaOp[] {
  if (after !== undefined && !isRecord(after)) { problems.push('"sharedHandlers" must be an object of name → function source'); return []; }
  const prevMap = isRecord(before) ? before : {};
  const nextMap = after ?? {};
  const ops: DeltaOp[] = [];
  for (const [name, source] of Object.entries(nextMap)) {
    if (name === '__proto__') { problems.push('"sharedHandlers": "__proto__" is not a valid shared handler name'); continue; }
    if (typeof source !== 'string') { problems.push(`"sharedHandlers.${name}" must be a function source string`); continue; }
    const previous = Object.hasOwn(prevMap, name) ? prevMap[name] : undefined;
    if (previous !== source) ops.push({ op: 'set-shared-handler', name, source });
  }
  for (const name of Object.keys(prevMap)) {
    if (!Object.hasOwn(nextMap, name)) ops.push({ op: 'remove-shared-handler', name });
  }
  return ops;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((h) => typeof h === 'string');
}

// The `set-match` op a changed `match` makes, or null when it is unchanged.
// Shape and admission problems go to `problems` (malformed-shim-folder); a
// widening past the cap throws not-editable.
function matchOp(before: unknown, after: unknown, committed: readonly unknown[] | undefined, problems: string[]): DeltaOp | null {
  if (stableStringify(before) === stableStringify(after)) return null;
  if (!isRecord(after) || !isStringList(after.hosts)) {
    problems.push('"match" must be { "hosts": [host patterns] }');
    return null;
  }
  const extra = Object.keys(after).filter((key) => key !== 'hosts');
  if (extra.length) {
    problems.push(`"match" takes only "hosts" (not ${extra.map((k) => JSON.stringify(k)).join(', ')})`);
    return null;
  }
  const hosts = after.hosts;
  if (hosts.length === 0) {
    problems.push('"match.hosts" needs at least one host pattern');
    return null;
  }
  const had = new Set(isRecord(before) && isStringList(before.hosts) ? before.hosts : []);
  const seen = new Set<string>();
  for (const pattern of hosts) {
    if (seen.has(pattern)) { problems.push(`"match.hosts" lists ${JSON.stringify(pattern)} twice`); continue; }
    seen.add(pattern);
    if (had.has(pattern)) continue;
    const problem = hostPatternProblem(pattern);
    if (problem) problems.push(`"match.hosts": ${problem}`);
  }
  if (problems.length) return null;
  const baseline = committed ?? [...had];
  const widened = widenedPatterns(baseline, hosts);
  if (widened.length > MAX_NEW_MATCH_PATTERNS) {
    throw new ShimFolderError('not-editable', [
      `"match.hosts" would run the shim on ${widened.length} new host patterns; one commit can add at most ${MAX_NEW_MATCH_PATTERNS}`,
    ]);
  }
  return { op: 'set-match', match: { hosts: [...hosts] } };
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
  const sharedEditable = prev.global === true;
  // A global shim's match is impl-presence (it runs where it has a per-site
  // implementation), so it stays not-editable. For a plain shim, match is
  // editable only where the host opts in (previous.matchEditable === true): a
  // host that forgets to pass it cannot widen where a shim runs with no card
  // and no note — fail-closed on purpose, since widening is a consent decision.
  const matchEditable = !sharedEditable && previous.matchEditable === true;
  if (sharedEditable) declarations.add('sharedHandlers');
  if (matchEditable) declarations.add('match');
  for (const key of new Set([...Object.keys(prevRecord), ...Object.keys(nextRecord)])) {
    if (UNCOMPARED_FIELDS.has(key) || declarations.has(key)) continue;
    if (stableStringify(comparableField(key, prevRecord[key])) !== stableStringify(comparableField(key, nextRecord[key]))) {
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
  if (sharedEditable) ops.push(...sharedHandlerOps(prevRecord.sharedHandlers, nextRecord.sharedHandlers, problems));
  if (matchEditable) {
    const op = matchOp(prevRecord.match, nextRecord.match, previous.committedMatchHosts, problems);
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
  // One inline expression per name, shared by every rule that carries it
  // (commit refuses two different sources under one name). A name whose file
  // and worlds are both unchanged keeps the expression the working spec
  // already holds — it may have come from hydration, whose conversion differs
  // in form, and an untouched rule must keep matching it. Otherwise the file
  // converts under the convention of every world the folder's rules run it in
  // (a name shared across worlds gets the expression that picks per world); a
  // name only carried inline runs nowhere yet and takes the isolated form.
  const nextWorlds = handlerWorlds(nextRules);
  const prevWorlds = handlerWorlds(prevRules);
  const prevExpressions = new Map<string, string>();
  for (const rule of prevRules) {
    for (const [name, source] of Object.entries(rule.handlers || {})) {
      if (typeof source === 'string' && !prevExpressions.has(name)) prevExpressions.set(name, source);
    }
  }
  const sameWorlds = (a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined): boolean =>
    (a?.size ?? 0) === (b?.size ?? 0) && [...(a ?? [])].every((w) => b?.has(w));
  const expressions = new Map<string, string>();
  const expressionFor = (name: string, source: string): string => {
    const known = expressions.get(name);
    if (known !== undefined) return known;
    const prev = prevExpressions.get(name);
    const keep = prev !== undefined
      && canonicalModule(moduleForExpression(prev)) === canonicalModule(source)
      && sameWorlds(prevWorlds.get(name), nextWorlds.get(name));
    const expression = keep ? prev : moduleToExpression(source, nextWorlds.get(name) ?? 'isolated');
    expressions.set(name, expression);
    return expression;
  };
  const built = nextRules.map((authored) => {
    const before = prevById.get(authored.id);
    const names = new Set(referencedHandlerNames(authored));
    for (const name of Object.keys(before?.handlers || {})) if (Object.hasOwn(files, name)) names.add(name);
    const modules: Record<string, string> = Object.create(null) as Record<string, string>;
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
      rule.handlers = Object.fromEntries(Object.entries(modules).map(([name, source]) => [name, expressionFor(name, source)]));
    }
    // Changed when its authored content is, or when a handler it holds inline
    // now needs a different expression (the name gained or lost a world
    // through another rule). A rule that held none inline runs the stored
    // module under its own world's convention, so it has nothing to update.
    const held = before?.handlers;
    // A set rule (`cardinality: 'many'`) still without a fingerprint is
    // re-applied on every preview even when unchanged: its last preview showed
    // too few members, and once more are on the page (the agent scrolled), a
    // fresh apply is what captures its set witness.
    const recapture = !!before && authored.anchor?.cardinality === 'many' && before.anchor?.cardinality === 'many' && !hasManagedKeys(before.anchor);
    const changed = !before || recapture || ruleFingerprint(authored, modules) !== ruleFingerprint(before, previousModules(before, stored))
      || Object.entries(rule.handlers || {}).some(([name, expression]) => !!held && Object.hasOwn(held, name) && held[name] !== expression);
    // Carry back every fingerprint the host holds for an unchanged anchor,
    // each to its own field (a set witness never lands in `witness`).
    if (before?.anchor && rule.anchor && hasManagedKeys(before.anchor) && anchorDigest(before.anchor) === anchorDigest(rule.anchor)) {
      rule.anchor = withManagedFingerprint(rule.anchor, managedFingerprintOf(before.anchor));
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
