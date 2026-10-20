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

import { describeRuleStatus, UNWITNESSED_MULTI_MATCH_NOTE, CAPTURE_NOTES, CONFLICTED_NOTE } from '../src/preview-evidence';
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
check('a multi-match status line with no capture says no fingerprint was captured', two.includes(UNWITNESSED_MULTI_MATCH_NOTE), two);
check('…and still reports the count', two.startsWith('matched 2 element(s) via primary'), two);
check('…and says how to fix it', /narrow the anchor/.test(two) && /exactly one/.test(two), two);
const one = describeRuleStatus(scriptRule, { matched: 1, matchedVia: 'primary' });
check('a single match carries no note', one === 'matched 1 element(s) via primary', one);
check('a rule that already has a witness carries no note', !describeRuleStatus(witnessed, { matched: 3 }).includes('NOTE'));
check('an iframe rule (resolved in the child frame) carries no note', !describeRuleStatus(iframeRule, { matched: 3 }).includes('NOTE'));
check('an anchorless route rule carries no note', !describeRuleStatus(routeRule, { matched: 2 }).includes('NOTE'));
const capturedThenMore = describeRuleStatus(scriptRule, { matched: 2 }, { witnessed: true });
check('a preview that captured a witness (one match, then more) carries no note', !capturedThenMore.includes('NOTE'), capturedThenMore);
const asSet = describeRuleStatus(scriptRule, { matched: 48 }, { capture: { fingerprint: 'set' } });
check('a preview that captured a set witness carries no note', !asSet.includes('NOTE'), asSet);
const mixed = describeRuleStatus(scriptRule, { matched: 6 }, { capture: { fingerprint: 'none', note: 'mixed-tags' } });
check('mixed tags: the note says why and how to fix it', mixed.endsWith(CAPTURE_NOTES['mixed-tags']) && /one kind of element/.test(mixed), mixed);
const lonely = describeRuleStatus({ ...scriptRule, anchor: { ...anchor, cardinality: 'many' } }, { matched: 1 }, { capture: { fingerprint: 'none', note: 'one-member' } });
check('cardinality many with one member: load more items and preview again', /load more items/.test(lonely) && /preview again/.test(lonely), lonely);
check('a remove rule over several: the note says so', describeRuleStatus(scriptRule, { matched: 3 }, { capture: { fingerprint: 'none', note: 'remove-rule' } }).includes(CAPTURE_NOTES['remove-rule']));
const conflicted: Rule = { ...scriptRule, anchor: { ...anchor, witness: { v: 1, tag: 'div' }, setWitness: { v: 1, tag: 'div', count: 2, nested: false } } };
check('a conflicted rule says it needs a recapture', describeRuleStatus(conflicted, { matched: 2 }).endsWith(CONFLICTED_NOTE));
const unverified = describeRuleStatus({ ...scriptRule, anchor: { ...anchor, setWitness: { v: 1, tag: 'div', count: 2, nested: false } } }, { matched: 3, unverified: 1 });
check('a set rule with a member that stopped verifying says so', /1 mounted element\(s\) no longer match/.test(unverified), unverified);
check('zero matches keeps its own wording', describeRuleStatus(scriptRule, { matched: 0 }) === 'matched 0 elements — the anchor does not resolve on this page');

console.log('runtime warning:');
const warning = unwitnessedRecoveryWarning('product-price-history');
check('names the rule', warning.includes('"product-price-history"'), warning);
check('explains when a fingerprint is captured', /matches one element/.test(warning) && /several of the same tag/.test(warning), warning);
check('never advises a bare re-commit (an unchanged rule has nothing to commit)', !/re-commit/.test(warning), warning);
check('gives the fix that works: change the anchor, preview, commit', /change the anchor/.test(warning) && /preview/.test(warning) && /commit that change/.test(warning), warning);

console.log(failures === 0 ? '\nall passed\n' : `\n${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
