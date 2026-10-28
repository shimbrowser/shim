// query_page's output bound (packages/core/src/query-bound.ts). Bare node:
//
//   node out/packages/core/test/query-bound-harness.js
//
// The motivating case: on amazon.com one query_page result was 51,752
// characters on one line (25 candidates, each with markup, long class lists
// and computed style), past the agent's tool-output limit, so the whole
// result was lost. Invariants: long fields are cut with a marker, selectors
// and anchor values are never cut, the serialized result stays under the
// budget, rank order is kept, the top candidate always survives, a small
// result passes through untouched with no note, and bounding is idempotent.

import { boundQueryCandidates, QUERY_FIELD_MAX, QUERY_TOTAL_MAX } from '../src/query-bound';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 400)}`); }
}

const classes = Array.from({ length: 120 }, (_, i) => `a-spacing-mini-${i}`).join(' ');
// A heavy-page candidate, shaped like the site-page inspection's.
const heavy = (i: number): Record<string, unknown> => ({
  tagName: 'div',
  stableAttrs: { class: classes, 'data-component-type': 's-search-result' },
  ancestry: Array.from({ length: 5 }, () => `div.${classes.slice(0, 400)}`),
  suggestedAnchors: [{ kind: 'css', value: `div[data-index="${i}"]`, strength: 'strong', matches: 1 }],
  outerHTML: `<div class="${classes}">`.slice(0, 500),
  descendants: '',
  score: 100 - i,
  matchReasons: ['text contains "price"'],
  boundingRect: { x: 0, y: i * 300, width: 1200, height: 280 },
  computedStyle: { display: 'block', position: 'relative', color: 'rgb(15, 17, 17)', backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '14px', border: '0px none rgb(15, 17, 17)' },
  selector: `div.s-result-item:nth-child(${i + 1})`,
});

console.log('heavy page:');
const raw = Array.from({ length: 25 }, (_, i) => heavy(i));
const rawSize = JSON.stringify({ candidates: raw }).length;
check('the fixture overflows like the amazon.com result', rawSize > 40_000, rawSize);
const bounded = boundQueryCandidates(raw);
const size = JSON.stringify(bounded.candidates).length;
check(`the candidates fit the ${QUERY_TOTAL_MAX}-character budget`, size <= QUERY_TOTAL_MAX, size);
check('the whole tool result stays well under an agent\'s output limit', JSON.stringify(bounded).length < 20_000, JSON.stringify(bounded).length);
check('some candidates are dropped, from the bottom of the ranking', bounded.candidates.length > 0 && bounded.candidates.length < 25
  && bounded.candidates.every((c, i) => typeof c === 'object' && c !== null && (c as { score?: unknown }).score === 100 - i), bounded.candidates.length);
const first = bounded.candidates[0] as Record<string, unknown>;
const html = first.outerHTML;
check(`a long field is cut to ${QUERY_FIELD_MAX} characters with a marker`, typeof html === 'string'
  && html.startsWith('<div class="a-spacing-mini-0') && /…\[\+200 chars\]$/.test(html) && html.length < QUERY_FIELD_MAX + 20, html);
const attrs = first.stableAttrs as Record<string, unknown>;
check('nested fields are cut too (a class list inside stableAttrs)', typeof attrs.class === 'string' && attrs.class.includes('…[+'), attrs.class);
check('short fields are left alone', attrs['data-component-type'] === 's-search-result');
const anchors = first.suggestedAnchors as Array<Record<string, unknown>>;
check('a selector and an anchor value are never cut', first.selector === 'div.s-result-item:nth-child(1)' && anchors[0]?.value === 'div[data-index="0"]');
check('numbers and shapes survive', JSON.stringify(first.boundingRect) === JSON.stringify({ x: 0, y: 0, width: 1200, height: 280 }));
check('the note says how many were shown and that fields were cut', typeof bounded.truncated === 'string'
  && bounded.truncated.includes(`showing the top ${bounded.candidates.length} of 25 candidates`) && bounded.truncated.includes(`cut to ${QUERY_FIELD_MAX} characters`), bounded.truncated);
check('the input is not mutated', (raw[0] as { outerHTML: string }).outerHTML.length === 500);

console.log('small page:');
const small = [{ selector: 'button#buy', tag: 'button', text: 'Buy', rect: { x: 1, y: 2, w: 3, h: 4 } }];
const passed = boundQueryCandidates(small);
check('a small result passes through unchanged, with no note', JSON.stringify(passed) === JSON.stringify({ candidates: small }), passed);
check('an empty result stays empty', JSON.stringify(boundQueryCandidates([])) === JSON.stringify({ candidates: [] }));

console.log('edges:');
const huge = boundQueryCandidates([{ selector: 'x'.repeat(30_000) }, { selector: 'y' }]);
check('the top candidate always survives, even alone over budget', huge.candidates.length === 1 && typeof huge.truncated === 'string', huge.truncated);
const again = boundQueryCandidates(bounded.candidates);
check('bounding its own output again changes nothing', JSON.stringify(again.candidates) === JSON.stringify(bounded.candidates));
check('…and still reports the cut fields', typeof again.truncated === 'string' && again.truncated.includes('cut to'), again.truncated);
const tight = boundQueryCandidates(raw, { fieldMax: 50, totalMax: 3000 });
check('limits are configurable', JSON.stringify(tight.candidates).length <= 3000 && (tight.candidates[0] as { outerHTML: string }).outerHTML.startsWith('<div class="a-spacing-mini-0 a-spacing-mini-1 a-sp'), tight.candidates.length);

if (failures > 0) {
  console.error(`\n${failures} query-bound check(s) failed`);
  process.exit(1);
}
console.log('\nquery-bound-harness: all checks passed');
