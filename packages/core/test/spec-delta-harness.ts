// Harness for core's pure delta application (packages/core/src/spec-delta.ts):
// the ops an authoring turn (or the working-copy differ) produces, applied to
// a spec without touching storage.
//
//   node out/packages/core/test/spec-delta-harness.js
//
// Bare node.

import { applyDelta } from '../src/spec-delta';
import type { DeltaOp } from '../src/spec-delta';
import type { Spec, Rule } from '../src/types';
import { MAX_INTENT_CHARS } from '../src/intent';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const rule = (id: string, value = `.${id}`): Rule => ({
  id, anchor: { primary: { kind: 'css', value } }, mutations: [{ kind: 'hide' }],
});
const base: Spec = {
  id: 's', version: 3, match: { hosts: ['example.com'] }, rules: [rule('a'), rule('b')],
  settings: [{ key: 'k', type: 'string' }], permissions: ['ai'], intent: 'hide things',
};
const frozen = JSON.stringify(base);

console.log('rule ops');
let next = applyDelta(base, [{ op: 'update-rule', rule: rule('a', '.changed') }]);
check('update-rule replaces in place', next.rules?.[0]?.anchor?.primary.value === '.changed' && next.rules?.length === 2);
next = applyDelta(base, [{ op: 'update-rule', rule: rule('c') }]);
check('update-rule of an unknown id appends', next.rules?.map((r) => r.id).join() === 'a,b,c');
next = applyDelta(base, [{ op: 'add-rule', rule: rule('c') }]);
check('add-rule appends', next.rules?.map((r) => r.id).join() === 'a,b,c');
next = applyDelta(base, [{ op: 'remove-rule', ruleId: 'a' }, { op: 'remove-rule', ruleId: 'nope' }]);
check('remove-rule removes, an unknown id is a no-op', next.rules?.map((r) => r.id).join() === 'b');
next = applyDelta(base, [{ op: 'remove-rule', ruleId: 'a' }, { op: 'update-rule', rule: rule('a') }]);
check('remove then update moves a rule to the end', next.rules?.map((r) => r.id).join() === 'b,a');
check('the input spec is never mutated', JSON.stringify(base) === frozen);

console.log('declaration ops replace wholesale');
next = applyDelta(base, [{ op: 'set-settings', settings: [] }, { op: 'set-permissions', permissions: [] }]);
check('set-settings / set-permissions replace', Array.isArray(next.settings) && next.settings.length === 0 && next.permissions?.length === 0);
next = applyDelta(base, [{ op: 'set-settings' } as DeltaOp]);
check('a non-array settings value clears to []', Array.isArray(next.settings) && next.settings.length === 0);
next = applyDelta(base, [{ op: 'set-intent', intent: '  new purpose  ' }]);
check('set-intent normalizes (trims)', next.intent === 'new purpose');
next = applyDelta(base, [{ op: 'set-intent', intent: '' }]);
check('an empty intent clears it', next.intent === undefined);
next = applyDelta(base, [{ op: 'set-intent', intent: 'x'.repeat(MAX_INTENT_CHARS + 50) }]);
check('an over-long intent is truncated to the cap', (next.intent?.length ?? 0) <= MAX_INTENT_CHARS);
next = applyDelta(base, [{ op: 'set-storage', storage: { tables: [] } }, { op: 'set-connections', connections: [] }]);
check('set-storage / set-connections carry the value through as-is',
  JSON.stringify(next.storage) === '{"tables":[]}' && Array.isArray(next.connections));
next = applyDelta(base, []);
check('no ops leaves every declaration untouched',
  JSON.stringify(next) === frozen);

console.log('shared code-space');
next = applyDelta(base, [{ op: 'set-shared-handler', name: 'fmt', source: 'function fmt(){}' }]);
check('set-shared-handler upserts', next.sharedHandlers?.fmt === 'function fmt(){}');
const withShared = next;
next = applyDelta(withShared, [{ op: 'remove-shared-handler', name: 'fmt' }]);
check('remove-shared-handler deletes', next.sharedHandlers !== undefined && !('fmt' in next.sharedHandlers));
check('the earlier spec\'s map is untouched', withShared.sharedHandlers?.fmt === 'function fmt(){}');

next = applyDelta(base, [{ op: 'set-match', match: { hosts: ['a.com', '*.b.com'] } }]);
check('set-match replaces the match', JSON.stringify(next.match) === '{"hosts":["a.com","*.b.com"]}');
const hostsIn = next.match?.hosts;
check('…as a copy of the op\'s list', Array.isArray(hostsIn));
check('a malformed set-match leaves the match as it was',
  JSON.stringify(applyDelta(base, [{ op: 'set-match', match: { hosts: 'a.com' } }]).match) === JSON.stringify(base.match)
  && JSON.stringify(applyDelta(base, [{ op: 'set-match', match: null }]).match) === JSON.stringify(base.match));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
