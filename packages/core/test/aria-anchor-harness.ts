// aria anchors honor implicit ARIA roles, and every no-match report names the
// selector an anchor actually resolved through (packages/core/src/
// anchor-selector.ts). Bare node, no DOM:
//
//   node out/packages/core/test/aria-anchor-harness.js
//
// The motivating case: on medium.com `{ kind: "aria", role: "button", label:
// "Get the Medium app" }` matched 0 because the target is a native
// `<button aria-label="…">` with no role attribute (the resolver composed
// `[role="button"][aria-label="…"]`), and the no-match evidence reported
// `selector: ""` because it read `primary.value`, which an aria anchor has
// none of. The real-DOM half (which elements each selector finds) is the
// conformance suite's `aria-anchor` case, on both hosts.

import { ariaSelector, anchorSelectorOf, implicitRoleSelectors, IMPLICIT_ROLE_SELECTORS } from '../src/anchor-selector';
import { resolveAll } from '../src/anchors';
import { previewNoMatch } from '../src/preview-evidence';
import type { Rule } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 400)}`); }
}

const parts = (sel: string | null): string[] => (sel ?? '').split(', ');

console.log('ariaSelector:');
{
  const sel = ariaSelector('button', 'Get the Medium app');
  check('role + label keeps the explicit-role match first',
    parts(sel)[0] === '[role="button"][aria-label="Get the Medium app"]', sel);
  check('…and adds the native <button> with no role attribute',
    parts(sel).includes('button:not([role])[aria-label="Get the Medium app"]'), sel);
  check('…and the button-typed inputs, case-insensitively',
    parts(sel).includes('input[type="submit" i]:not([role])[aria-label="Get the Medium app"]'), sel);
  check('every native alternative excludes an explicit role (it overrides the native one)',
    parts(sel).slice(1).every((p) => p.includes(':not([role])')), sel);
  check('every alternative carries the label', parts(sel).every((p) => p.endsWith('[aria-label="Get the Medium app"]')), sel);
}
check('label only stays one attribute selector', ariaSelector(undefined, 'Close') === '[aria-label="Close"]', ariaSelector(undefined, 'Close'));
check('neither role nor label is null', ariaSelector(' ', '') === null && ariaSelector(undefined, undefined) === null);
check('a role with no native mapping matches the explicit role only',
  ariaSelector('tab', undefined) === '[role="tab"]', ariaSelector('tab', undefined));
check('role lookup is trimmed and case-insensitive',
  parts(ariaSelector(' Navigation ', undefined)).includes('nav:not([role])'), ariaSelector(' Navigation ', undefined));
check('quotes and backslashes in the label are escaped',
  ariaSelector(undefined, 'say "hi" \\ bye') === '[aria-label="say \\"hi\\" \\\\ bye"]', ariaSelector(undefined, 'say "hi" \\ bye'));
check('a role named like an Object prototype key has no native mapping',
  implicitRoleSelectors('constructor').length === 0 && implicitRoleSelectors('toString').length === 0);

console.log('implicit-role table:');
check('link needs an href', implicitRoleSelectors('link').join() === 'a[href],area[href]', implicitRoleSelectors('link'));
check('heading covers h1–h6', implicitRoleSelectors('heading').length === 6);
check('img excludes alt="" (that is presentation)', implicitRoleSelectors('img').join() === 'img:not([alt=""])');
check('name-dependent landmarks are left out (an empty or dangling label names nothing)',
  implicitRoleSelectors('form').length === 0 && implicitRoleSelectors('region').length === 0);
check('a listed input is neither textbox, searchbox nor combobox (its role depends on the datalist resolving)',
  [...implicitRoleSelectors('textbox'), ...implicitRoleSelectors('searchbox')].every((s) => s === 'textarea' || s.endsWith(':not([list])'))
  && implicitRoleSelectors('combobox').join() === 'select:not([multiple]):not([size])', implicitRoleSelectors('combobox'));
check('context-dependent roles are left out',
  ['banner', 'contentinfo', 'complementary', 'columnheader', 'rowheader'].every((r) => !(r in IMPLICIT_ROLE_SELECTORS)));

console.log('resolution:');
{
  const asked: string[] = [];
  const root = { querySelectorAll(sel: string): Element[] { asked.push(sel); return []; } } as unknown as Document;
  resolveAll({ primary: { kind: 'aria', role: 'button', label: 'Get the Medium app' } }, root);
  check('the resolver queries the implicit-role selector list', asked[0] === ariaSelector('button', 'Get the Medium app'), asked);
  asked.length = 0;
  resolveAll({ primary: { kind: 'aria' } }, root);
  check('an aria anchor with no signal never queries', asked.length === 0, asked);
}

console.log('anchorSelectorOf (the no-match evidence):');
check('css reports its value', anchorSelectorOf({ kind: 'css', value: '#x' }) === '#x');
check('data-attr reports the attribute selector, prefix normalised',
  anchorSelectorOf({ kind: 'data-attr', name: 'testid', value: 'buy' }) === '[data-testid="buy"]'
  && anchorSelectorOf({ kind: 'data-attr', name: 'data-track-id' }) === '[data-track-id]');
check('aria reports the selector it resolves through, never ""',
  anchorSelectorOf({ kind: 'aria', role: 'button', label: 'Get the Medium app' }) === ariaSelector('button', 'Get the Medium app'));
check('text reports a description', anchorSelectorOf({ kind: 'text', value: 'Save' }) === 'text="Save"'
  && anchorSelectorOf({ kind: 'text', value: 'Save', match: 'contains' }) === 'text~="Save"');
check('a missing anchor is ""', anchorSelectorOf(undefined) === '');
{
  const rule: Rule = { id: 'get-app', anchor: { primary: { kind: 'aria', role: 'button', label: 'Get the Medium app' } }, mutations: [{ kind: 'hide' }] };
  const out = previewNoMatch([], [{ rule, status: { matched: 0 }, peakMatched: 0 }]);
  check('a dead aria rule\'s noMatch entry names its selector',
    out.length === 1 && out[0]?.selector === ariaSelector('button', 'Get the Medium app'), out);
}

if (failures > 0) {
  console.error(`\n${failures} aria-anchor check(s) failed`);
  process.exit(1);
}
console.log('\naria-anchor-harness: all checks passed');
