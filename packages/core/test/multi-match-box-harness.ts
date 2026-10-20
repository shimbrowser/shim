// Harness for a multi-match rule's measured box: the engine's rule-status
// event (packages/core/src/rule-status.ts) and the evidence line both hosts
// word from it (packages/core/src/preview-evidence.ts, describeRuleStatus).
// Bare node — elements are duck-typed stubs.
//
//   node out/packages/core/test/multi-match-box-harness.js
//
// A rule matching many elements used to report the FIRST DOM-order match's
// box, and when that one was hidden the evidence read "first match box 0×0px
// at (0, 0)" — no use to an agent. The event now carries the first VISIBLE
// match's box plus a `visible` count, and the evidence says how many matches
// are visible vs hidden.

import { makeStatusReporter } from '../src/rule-status';
import { makeRuleState } from '../src/rule-state';
import { describeRuleStatus } from '../src/preview-evidence';
import type { CoreApi } from '../src/api';
import type { RuleMountEntry } from '../src/engine-internal';
import type { Rule, Spec } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const win = { innerWidth: 1000, innerHeight: 1000, getComputedStyle: () => ({ display: 'block' }) };
const doc = { defaultView: win };
function el(x: number, y: number, w: number, h: number) {
  return {
    ownerDocument: doc,
    matches: () => false,
    querySelector: () => null,
    getBoundingClientRect: () => ({ x, y, width: w, height: h }),
  };
}

const rule: Rule = { id: 'r', anchor: { primary: { kind: 'css', value: '.tile' } }, mutations: [{ kind: 'restyle', properties: { outline: '1px solid red' } }] };
const spec = { id: 'shim-x', version: 1, match: { hosts: ['example.com'] }, rules: [rule] } as Spec;

function status(matched: ReturnType<typeof el>[]): Record<string, unknown> {
  const events: Record<string, unknown>[] = [];
  const api = { reportEvent: (_k: string, d: Record<string, unknown>) => { events.push(d); } } as unknown as CoreApi;
  const rs = makeRuleState();
  for (const m of matched) rs.state.set(m as unknown as Element, {} as RuleMountEntry);
  rs.matchedSource = 'primary';
  makeStatusReporter(rule, spec, api, rs).reportStatusIfChanged();
  return events[events.length - 1] || {};
}

console.log('rule-status event');
let s = status([el(0, 0, 0, 0), el(0, 0, 0, 0), el(10, 20, 300, 40), el(10, 70, 300, 40)]);
check('multi-match box is the first VISIBLE match\'s', JSON.stringify(s.box) === JSON.stringify({ x: 10, y: 20, w: 300, h: 40 }), JSON.stringify(s.box));
check('multi-match carries the visible count', s.visible === 2, JSON.stringify(s));

s = status([el(0, 0, 0, 0), el(0, 0, 0, 0), el(0, 0, 0, 0)]);
check('all hidden → visible 0', s.visible === 0, JSON.stringify(s));
check('all hidden → the box stays the first match\'s (back-compat)', JSON.stringify(s.box) === JSON.stringify({ x: 0, y: 0, w: 0, h: 0 }), JSON.stringify(s.box));

s = status([el(1, 2, 3, 4)]);
check('a single match keeps its box', JSON.stringify(s.box) === JSON.stringify({ x: 1, y: 2, w: 3, h: 4 }), JSON.stringify(s.box));
check('a single match carries no visible count (event unchanged)', !('visible' in s), JSON.stringify(s));

console.log('evidence wording');
check('mixed visibility names the counts and the first visible box',
  describeRuleStatus(rule, { matched: 18, matchedVia: 'primary', visible: 3, box: { x: 10, y: 20, w: 300, h: 40 } })
  === 'matched 18 element(s) via primary — 3 visible, 15 hidden; first visible match box 300×40px at (10, 20)',
  describeRuleStatus(rule, { matched: 18, matchedVia: 'primary', visible: 3, box: { x: 10, y: 20, w: 300, h: 40 } }));
check('none visible says so instead of a 0×0 box',
  describeRuleStatus(rule, { matched: 18, matchedVia: 'primary', visible: 0, box: { x: 0, y: 0, w: 0, h: 0 } })
  === 'matched 18 element(s) via primary — 0 visible, 18 hidden (every match measures 0×0 after apply)',
  describeRuleStatus(rule, { matched: 18, matchedVia: 'primary', visible: 0, box: { x: 0, y: 0, w: 0, h: 0 } }));
check('an event without a visible count reads as before',
  describeRuleStatus(rule, { matched: 2, matchedVia: 'primary', box: { x: 1, y: 2, w: 3, h: 4 } })
  === 'matched 2 element(s) via primary — first match box 3×4px at (1, 2)');
check('a single match reads as before',
  describeRuleStatus(rule, { matched: 1, matchedVia: 'primary', box: { x: 1, y: 2, w: 3, h: 4 } })
  === 'matched 1 element(s) via primary — anchor box 3×4px at (1, 2)');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall green');
