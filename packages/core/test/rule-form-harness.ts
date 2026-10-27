// rule-form-harness — the authored form of a rule (packages/core/src/rule-form.ts):
// what changes it (an authored field, an anchor, a handler's code) and what
// does not (an engine-managed fingerprint, an inline expression standing for
// the stored module, whitespace and trailing semicolons around a module, a
// handler the rule never references). The working-copy differ compares rules
// by the same form, so what it calls unchanged is what a host stamps as the
// same form.
//
//   node out/packages/core/test/rule-form-harness.js

import { ruleFormDigest, ruleFormKey, ruleModules } from '../src/rule-form';
import { moduleToExpression } from '../src/handler-source';
import type { Rule } from '../src/types';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

const MODULE = 'module.exports = function badge({ anchor }) { anchor.dataset.badge = "1"; };';
const PRIMARY = { kind: 'css' as const, value: '#target' };
const base: Rule = {
  id: 'badge',
  anchor: { primary: PRIMARY },
  mutations: [{ kind: 'script', handler: 'badge' }],
};
const stored = { badge: MODULE };

const d0 = ruleFormDigest(base, stored);
check('a digest is 16 hex characters', /^[0-9a-f]{16}$/.test(d0), d0);
check('the same rule and modules digest the same', ruleFormDigest({ ...base }, { ...stored }) === d0);

// Managed keys are not part of the form.
const witnessed: Rule = { ...base, anchor: { primary: PRIMARY, witness: { tag: 'div', text: 'x' } as never } };
check('a stored witness leaves the form unchanged', ruleFormDigest(witnessed, stored) === d0);
const setWitnessed: Rule = { ...base, anchor: { primary: PRIMARY, setWitness: { count: 3 } as never } };
check('a set witness leaves the form unchanged', ruleFormDigest(setWitnessed, stored) === d0);

// Inline (a preview's shape) and stored (a bundle's shape) are one form.
const inline: Rule = { ...base, handlers: { badge: moduleToExpression(MODULE, 'isolated') } };
check('an inline expression for the stored module is the same form', ruleFormDigest(inline, {}) === d0,
  `${ruleFormDigest(inline, {})} vs ${d0}`);
check('the inline source wins over a stale stored module', ruleFormDigest(inline, { badge: 'module.exports = () => 0;' }) === d0);
check('whitespace and a trailing semicolon around the module are ignored',
  ruleFormDigest(base, { badge: `\n  ${MODULE.replace(/;$/, '')}  \n;;` }) === d0);

// What changes the form.
check('a handler code change changes the form', ruleFormDigest(base, { badge: MODULE.replace('"1"', '"2"') }) !== d0);
check('an anchor change changes the form', ruleFormDigest({ ...base, anchor: { primary: { kind: 'css', value: '#other' } } }, stored) !== d0);
check('a mutation change changes the form', ruleFormDigest({ ...base, mutations: [{ kind: 'hide' }] }, stored) !== d0);
check('an id change changes the form', ruleFormDigest({ ...base, id: 'badge2' }, stored) !== d0);
check('a module the rule never references is not part of the form', ruleFormDigest(base, { ...stored, other: 'module.exports = 1;' }) === d0);
check('a referenced module missing from the store is a different form than one present', ruleFormDigest(base, {}) !== d0);

// The modules a rule runs with.
const mods = ruleModules(inline, { badge: 'stale', other: 'x' });
check('ruleModules reads the inline expression back as its module', mods.badge?.trim() === MODULE, JSON.stringify(mods.badge));
check('ruleModules carries only referenced names', !('other' in mods));
const proto: Rule = { ...base, mutations: [{ kind: 'script', handler: 'constructor' }] };
check('a handler named like an Object.prototype member resolves only as an own property', !('constructor' in ruleModules(proto, {})));
check('the key is stable JSON with managed keys out', !ruleFormKey(witnessed, ruleModules(witnessed, stored)).includes('witness'));

if (failures) {
  console.error(`\nrule-form: ${failures} failed, ${passes} passed`);
  process.exit(1);
}
console.log(`rule-form: all ${passes} checks passed`);
