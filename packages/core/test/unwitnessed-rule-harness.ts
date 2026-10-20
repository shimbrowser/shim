// An anchored rule that matches several elements gets no witness: apply-rule
// fingerprints only a single match, so the rule commits without one and can't
// self-heal after a redesign. Found live on a product page: a price rule's
// anchor also matched a hidden duplicate, the commit carried no witness, and
// the runtime's advice ("re-commit the rule while it resolves") could not
// work: an unchanged rule has nothing to commit, and re-previewing it still
// matches twice. Pins:
//   - preview evidence says so while it's cheap to fix: a multi-match status
//     line carries the note; a single match, a rule already carrying a
//     witness, an iframe rule and the anchorless kinds don't
//   - the runtime warning names the real cause and a fix that works (narrow
//     the anchor, preview, commit), never "re-commit"
//
//   node out/packages/core/test/unwitnessed-rule-harness.js

import { describeRuleStatus, UNWITNESSED_MULTI_MATCH_NOTE } from '../src/preview-evidence';
import { unwitnessedRecoveryWarning } from '../src/rule-reconcile';
import type { Rule } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const anchor = {
  primary: { kind: 'data-attr' as const, name: 'data-feature-name', value: 'corePriceDisplay_desktop' },
  fallbacks: [{ kind: 'css' as const, value: '#corePrice_feature_div' }],
};
const scriptRule: Rule = { id: 'product-price-history', anchor, mutations: [{ kind: 'script', handler: 'renderHistory' }] };
const witnessed: Rule = { ...scriptRule, anchor: { ...anchor, witness: { v: 1, tag: 'div' } } };
const iframeRule: Rule = { ...scriptRule, anchor: { ...anchor, iframe: { kind: 'css', value: 'iframe#x' } } };
const routeRule: Rule = { id: 'r', mutations: [{ kind: 'mount-route', path: '/x', handler: 'h' }] } as unknown as Rule;

console.log('preview evidence:');
const two = describeRuleStatus(scriptRule, { matched: 2, matchedVia: 'primary' });
check('a multi-match status line says no witness is captured', two.includes(UNWITNESSED_MULTI_MATCH_NOTE), two);
check('…and still reports the count', two.startsWith('matched 2 element(s) via primary'), two);
check('…and says how to fix it', /narrow the anchor/.test(two) && /exactly one/.test(two), two);
const one = describeRuleStatus(scriptRule, { matched: 1, matchedVia: 'primary' });
check('a single match carries no note', one === 'matched 1 element(s) via primary', one);
check('a rule that already has a witness carries no note', !describeRuleStatus(witnessed, { matched: 3 }).includes('witness'));
check('an iframe rule (resolved in the child frame) carries no note', !describeRuleStatus(iframeRule, { matched: 3 }).includes('witness'));
check('an anchorless route rule carries no note', !describeRuleStatus(routeRule, { matched: 2 }).includes('witness'));
const capturedThenMore = describeRuleStatus(scriptRule, { matched: 2 }, { witnessed: true });
check('a preview that captured a witness (one match, then more) carries no note', !capturedThenMore.includes('witness'), capturedThenMore);
check('zero matches keeps its own wording', describeRuleStatus(scriptRule, { matched: 0 }) === 'matched 0 elements — the anchor does not resolve on this page');

console.log('runtime warning:');
const warning = unwitnessedRecoveryWarning('product-price-history');
check('names the rule', warning.includes('"product-price-history"'), warning);
check('explains the single-match rule', /exactly one element/.test(warning), warning);
check('never advises a bare re-commit (an unchanged rule has nothing to commit)', !/re-commit/.test(warning), warning);
check('gives the fix that works: narrow, preview, commit', /narrow the anchor/.test(warning) && /preview/.test(warning) && /commit that change/.test(warning), warning);

console.log(failures === 0 ? '\nall passed\n' : `\n${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
