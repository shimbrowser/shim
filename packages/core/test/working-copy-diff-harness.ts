// Harness for the working-copy differ (packages/core/src/working-copy-diff.ts,
// shim-core design D10): a shim folder diffed against the session's working
// state becomes the DeltaOps the emit path applies. Pins that applying the
// ops yields exactly the folder's rules (in the folder's order) and
// declarations, that an untouched checkout diffs to nothing, that a rule
// whose anchor is unchanged keeps its stored witness while an edited anchor
// drops it, and that edits no op can carry are refused.
//
// Parity with the browser's internal worker (the same ops for equivalent
// edits) is pinned app-side in scripts/working-copy-diff-parity-harness.ts.
//
//   node out/packages/core/test/working-copy-diff-harness.js
//
// Bare node.

import { diffWorkingCopy } from '../src/working-copy-diff';
import type { WorkingState } from '../src/working-copy-diff';
import { checkoutShim, ShimFolderError, SHIM_JSON, stableStringify } from '../src/shim-folder';
import type { FolderInput, ShimFolderErrorCode } from '../src/shim-folder';
import { applyDelta } from '../src/spec-delta';
import type { DeltaOp } from '../src/spec-delta';
import { expressionToModule } from '../src/handler-source';
import type { Spec, Rule, Witness } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

function rejects(label: string, code: ShimFolderErrorCode, fn: () => unknown, mentions: string): void {
  try {
    fn();
    check(label, false, 'did not throw');
  } catch (err) {
    const ok = err instanceof ShimFolderError && err.code === code && err.problems.some((p) => p.includes(mentions));
    check(label, ok, err instanceof ShimFolderError ? `${err.code}: ${err.problems.join(' | ')}` : String(err));
  }
}

const witness = (text: string): Witness => ({ v: 1, tag: 'div', textStem: text });
const rule = (id: string, extra: Partial<Rule> = {}): Rule => ({
  id, anchor: { primary: { kind: 'css', value: `.${id}` }, witness: witness(id) }, mutations: [{ kind: 'hide' }], ...extra,
});
const scriptRule = (id: string, name: string, source: string): Rule => rule(id, {
  mutations: [{ kind: 'script', handler: name, mount: { strategy: 'portal' } }], handlers: { [name]: source },
});

const WORKING: Spec = {
  id: 'shim-1', version: 4, bundleHash: 'h1', match: { hosts: ['example.com'] },
  rules: [rule('a'), scriptRule('b', 'mountB', 'function mountB({ anchor }) { anchor.dataset.b = "1"; }'), rule('c')],
  permissions: ['ai'], intent: 'hide junk',
};
const state: WorkingState = { spec: WORKING };

const checkout = (): FolderInput => checkoutShim(state);
const withSpec = (mutate: (spec: Spec) => void, files: FolderInput = checkout()): FolderInput => {
  const spec = JSON.parse(String(files[SHIM_JSON])) as Spec;
  mutate(spec);
  return { ...files, [SHIM_JSON]: JSON.stringify(spec, null, 2) };
};
const find = (spec: Spec, id: string): Rule => {
  const found = spec.rules?.find((r) => r.id === id);
  if (!found) throw new Error(`no rule ${id}`);
  return found;
};
const stripWitness = (r: Rule): Rule => {
  if (!r.anchor?.witness) return r;
  const { witness: _w, ...anchor } = r.anchor;
  return { ...r, anchor };
};
const ids = (spec: Spec): string => (spec.rules || []).map((r) => r.id).join(',');
const kinds = (ops: DeltaOp[]): string => ops.map((op) => `${op.op}:${op.rule?.id ?? op.ruleId ?? ''}`).join(' ');

// What the folder says the shim is: applying the ops must produce exactly this
// (witnesses aside — they are the differ's own business, checked separately).
function expectApplied(label: string, files: FolderInput, prev: WorkingState = state): { ops: DeltaOp[]; next: Spec } {
  const { ops } = diffWorkingCopy(prev, files);
  const next = applyDelta(prev.spec, ops);
  // shim.json compared as JSON (the edits here don't keep its formatting),
  // handler files byte for byte.
  const normalize = (folder: FolderInput): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [path, content] of Object.entries(folder)) out[path] = path === SHIM_JSON ? JSON.parse(String(content)) : String(content);
    return out;
  };
  const roundTrip = normalize(checkoutShim({ spec: next, handlers: prev.handlers }));
  const want = normalize(files);
  check(`${label}: applying the ops reproduces the folder`, stableStringify(roundTrip) === stableStringify(want),
    `ops=${kinds(ops)}\n  got ${stableStringify(roundTrip)}\n  want ${stableStringify(want)}`);
  return { ops, next };
}

console.log('an untouched checkout');
let result = diffWorkingCopy(state, checkout());
check('diffs to no ops and no warnings', result.ops.length === 0 && result.warnings.length === 0, kinds(result.ops));

console.log('rule edits');
let applied = expectApplied('a handler edit', { ...checkout(), 'handlers/mountB.js': expressionToModule('function mountB({ anchor }) { anchor.dataset.b = "2"; }') });
check('one update-rule for the rule that uses it', kinds(applied.ops) === 'update-rule:b', kinds(applied.ops));
let op = applied.ops[0];
check('the op carries the whole rule, handler inline as an expression',
  op?.rule?.handlers?.mountB === 'function mountB({ anchor }) { anchor.dataset.b = "2"; }' && op.rule.mutations?.[0]?.kind === 'script');
check('anchor unchanged → the stored witness rides the op', stableStringify(op?.rule?.anchor?.witness) === stableStringify(witness('b')));
check('…so the applied spec keeps it', stableStringify(find(applied.next, 'b').anchor?.witness) === stableStringify(witness('b')));

applied = expectApplied('an anchor edit', withSpec((spec) => { const a = find(spec, 'c').anchor; if (a) a.primary = { kind: 'css', value: '.c-v2' }; }));
op = applied.ops[0];
check('one update-rule', kinds(applied.ops) === 'update-rule:c', kinds(applied.ops));
check('anchor changed → no witness on the op (re-captured on apply)', op?.rule?.anchor?.witness === undefined);

applied = expectApplied('a mutation edit', withSpec((spec) => { find(spec, 'a').mutations = [{ kind: 'restyle', properties: { opacity: '0.5' } }]; }));
check('update-rule, witness kept', kinds(applied.ops) === 'update-rule:a' && applied.ops[0]?.rule?.anchor?.witness !== undefined, kinds(applied.ops));

applied = expectApplied('a new rule', withSpec((spec) => {
  spec.rules?.push({ id: 'd', anchor: { primary: { kind: 'css', value: '.d' } }, mutations: [{ kind: 'script', handler: 'mountD' }] });
}, { ...checkout(), 'handlers/mountD.js': expressionToModule('function mountD() {}') }));
check('add-rule with its handler inline', kinds(applied.ops) === 'add-rule:d' && applied.ops[0]?.rule?.handlers?.mountD === 'function mountD() {}', kinds(applied.ops));

const withoutB = withSpec((spec) => { spec.rules = spec.rules?.filter((r) => r.id !== 'b'); });
delete withoutB['handlers/mountB.js'];
applied = expectApplied('a deleted rule', withoutB);
check('remove-rule', kinds(applied.ops) === 'remove-rule:b', kinds(applied.ops));

applied = expectApplied('a reorder', withSpec((spec) => { spec.rules = [find(spec, 'c'), find(spec, 'a'), find(spec, 'b')]; }));
check('the folder\'s order wins', ids(applied.next) === 'c,a,b', ids(applied.next));
check('moved rules are removed then re-emitted (applyDelta only appends)', kinds(applied.ops) === 'remove-rule:a remove-rule:b update-rule:a update-rule:b', kinds(applied.ops));
check('a moved rule keeps its witness', applied.ops.filter((o) => o.op === 'update-rule').every((o) => o.rule?.anchor?.witness !== undefined));

applied = expectApplied('a rule inserted mid-list', withSpec((spec) => {
  spec.rules?.splice(1, 0, { id: 'mid', anchor: { primary: { kind: 'css', value: '.mid' } }, mutations: [{ kind: 'hide' }] });
}));
check('lands where the folder puts it', ids(applied.next) === 'a,mid,b,c', `${ids(applied.next)} via ${kinds(applied.ops)}`);

applied = expectApplied('a rename', withSpec((spec) => { find(spec, 'c').id = 'c2'; }));
check('remove the old id, add the new one, no witness carried across ids',
  kinds(applied.ops) === 'remove-rule:c add-rule:c2' && applied.ops[1]?.rule?.anchor?.witness === undefined, kinds(applied.ops));

console.log('declaration edits');
applied = expectApplied('permissions, intent, settings, storage, connections', withSpec((spec) => {
  spec.permissions = [];
  spec.intent = 'hide junk and add notes';
  spec.settings = [{ key: 'k', type: 'string' }];
  spec.storage = { tables: [{ name: 'notes', columns: [{ name: 'id', type: 'integer' }] }] };
  spec.connections = [{ name: 'remote', engine: 'postgres' }];
}));
check('one set-* op each, in a fixed order',
  applied.ops.map((o) => o.op).join() === 'set-settings,set-permissions,set-intent,set-storage,set-connections', applied.ops.map((o) => o.op).join());
applied = expectApplied('a removed declaration', withSpec((spec) => { delete spec.intent; }));
check('clears it', kinds(applied.ops) === 'set-intent:' && applied.next.intent === undefined, kinds(applied.ops));
rejects('settings that aren\'t an array', 'malformed-shim-folder', () => diffWorkingCopy(state, withSpec((spec) => { (spec as unknown as Record<string, unknown>).settings = {}; })), '"settings" must be an array');
rejects('permissions that aren\'t strings', 'malformed-shim-folder', () => diffWorkingCopy(state, withSpec((spec) => { (spec as unknown as Record<string, unknown>).permissions = [1]; })), '"permissions" must be an array of strings');

console.log('edits no op can carry');
rejects('match', 'not-editable', () => diffWorkingCopy(state, withSpec((spec) => { spec.match = { hosts: ['other.com'] }; })), '"match"');
rejects('id', 'not-editable', () => diffWorkingCopy(state, withSpec((spec) => { spec.id = 'other'; })), '"id"');
rejects('a new top-level field', 'not-editable', () => diffWorkingCopy(state, withSpec((spec) => { spec.css = 'body{}'; })), '"css"');
rejects('a witness written into shim.json', 'malformed-shim-folder', () => diffWorkingCopy(state, withSpec((spec) => { const a = find(spec, 'a').anchor; if (a) a.witness = witness('forged'); })), 'witness');

console.log('handler files');
result = diffWorkingCopy(state, { ...checkout(), 'handlers/unused.js': 'module.exports = 1;\n' });
check('a file no rule uses → a warning, no op', result.ops.length === 0 && result.warnings.some((w) => w.includes('handlers/unused.js')), JSON.stringify(result));
const shared: WorkingState = {
  spec: {
    id: 's', match: { hosts: ['example.com'] },
    rules: [
      rule('x', { mutations: [{ kind: 'script', handler: 'imported' }] }),
      rule('y', { mutations: [{ kind: 'script', handler: 'imported' }] }),
    ],
  },
  handlers: { imported: 'const N = 2;\nmodule.exports = function imported() { return N; };\n' },
};
result = diffWorkingCopy(shared, checkoutShim(shared));
check('stored (non-inline) handlers: an untouched checkout is still no ops', result.ops.length === 0, kinds(result.ops));
applied = expectApplied('editing a handler two rules share', { ...checkoutShim(shared), 'handlers/imported.js': 'const N = 3;\nmodule.exports = function imported() { return N; };\n' }, shared);
check('updates both rules', kinds(applied.ops) === 'update-rule:x update-rule:y', kinds(applied.ops));
check('a helper-carrying module goes inline as an IIFE', applied.ops[0]?.rule?.handlers?.imported?.startsWith('(function () {') === true);
const sharedEdited = { ...checkoutShim(shared), 'handlers/imported.js': 'const N = 3;\nmodule.exports = function imported() { return N; };\n' };
result = diffWorkingCopy({ spec: applied.next, handlers: shared.handlers }, sharedEdited);
check('diffing the same folder again is no ops (the IIFE reads back as the module)', result.ops.length === 0, kinds(result.ops));
const unreferenced: WorkingState = {
  spec: { id: 'u', match: { hosts: ['example.com'] }, rules: [rule('r', { handlers: { spare: 'function spare() {}' } })] },
};
result = diffWorkingCopy(unreferenced, checkoutShim(unreferenced));
check('an inline handler no mutation names round-trips without an op or warning', result.ops.length === 0 && result.warnings.length === 0, JSON.stringify(result));

console.log('handler names that are Object.prototype keys');
{
  const protoState: WorkingState = {
    spec: { id: 'p', match: { hosts: ['example.com'] }, rules: [rule('a', { mutations: [{ kind: 'script', handler: 'constructor' }] })] },
    handlers: { constructor: 'module.exports = function constructor() {};\n' },
  };
  const protoFolder = checkoutShim(protoState);
  const untouched = diffWorkingCopy(protoState, protoFolder);
  check('a stored handler named constructor round-trips with no op', untouched.ops.length === 0, JSON.stringify(untouched));
  const edited = diffWorkingCopy(protoState, { ...protoFolder, 'handlers/constructor.js': 'module.exports = function constructor() { return 1; };\n' });
  const ctor: string = 'constructor';
  const source: unknown = edited.ops[0]?.rule?.handlers?.[ctor];
  check('editing it carries its source as a string', edited.ops.length === 1 && typeof source === 'string' && source.includes('return 1'), JSON.stringify(edited.ops));
  rejects('a rule naming toString with no file is refused, not bound to Object.prototype', 'malformed-shim-folder',
    () => diffWorkingCopy(protoState, withSpec((spec) => { const m = spec.rules?.[0]?.mutations?.[0]; if (m) m.handler = 'toString'; }, protoFolder)),
    'handlers/toString.js is missing');
}

console.log('witness parity with stripping');
applied = expectApplied('edit both a handler and the anchor of one rule', withSpec((spec) => {
  const a = find(spec, 'b').anchor; if (a) a.fallbacks = [{ kind: 'text', value: 'Notes' }];
}, { ...checkout(), 'handlers/mountB.js': expressionToModule('function mountB() {}') }));
check('one update-rule without witness', kinds(applied.ops) === 'update-rule:b' && applied.ops[0]?.rule?.anchor?.witness === undefined);
check('ops never carry a witness the previous rule didn\'t have',
  diffWorkingCopy({ spec: { ...WORKING, rules: WORKING.rules?.map(stripWitness) } }, { ...checkout(), 'handlers/mountB.js': expressionToModule('function mountB() {}') })
    .ops.every((o) => o.rule?.anchor?.witness === undefined));
check('the working state is never mutated', stableStringify(state.spec) === stableStringify(WORKING));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
