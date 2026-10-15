// Pure-logic harness for the Tier-1 layout kinds (packages/core/src/
// layout-kinds.ts reorder/reshape). Bare node — no DOM.
//
//   node out/packages/core/test/layout-kinds-harness.js

import {
  compileReorderCss, compileReshapeCss, desiredSequence,
  reorderNote, reshapeNote, REORDER_SIBLING_CAP,
} from '../src/layout-kinds';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

console.log('compileReorderCss');
check('first → -9999', compileReorderCss({ kind: 'reorder', position: 'first' }) === 'order: -9999 !important;');
check('last → 9999', compileReorderCss({ kind: 'reorder', position: 'last' }) === 'order: 9999 !important;');
check('number passes through', compileReorderCss({ kind: 'reorder', position: 3 }) === 'order: 3 !important;');
check('relative mode → null (engine restamp path owns it)',
  compileReorderCss({ kind: 'reorder', before: { kind: 'css', value: '.x' } }) === null);
check('no mode → null', compileReorderCss({ kind: 'reorder' }) === null);

console.log('compileReshapeCss');
check('grid + numeric columns → repeat(minmax) template',
  compileReshapeCss({ kind: 'reshape', layout: 'grid', columns: 3, gap: '16px' })
  === 'display: grid !important; grid-template-columns: repeat(3, minmax(0, 1fr)) !important; gap: 16px !important;');
check('string columns verbatim',
  compileReshapeCss({ kind: 'reshape', columns: '240px 1fr' })
  === 'grid-template-columns: 240px 1fr !important;');
check('flex combo',
  compileReshapeCss({ kind: 'reshape', layout: 'flex', direction: 'column', wrap: true, align: 'center', justify: 'space-between' })
  === 'display: flex !important; flex-direction: column !important; flex-wrap: wrap !important; align-items: center !important; justify-content: space-between !important;');
check('wrap false → nowrap', compileReshapeCss({ kind: 'reshape', wrap: false }) === 'flex-wrap: nowrap !important;');
check('direction with layout:grid is dropped (note handles it)',
  compileReshapeCss({ kind: 'reshape', layout: 'grid', direction: 'column' }) === 'display: grid !important;');
check('no recognized fields → null', compileReshapeCss({ kind: 'reshape' }) === null);
check('rows numeric', compileReshapeCss({ kind: 'reshape', rows: 2 }) === 'grid-template-rows: repeat(2, minmax(0, 1fr)) !important;');

console.log('desiredSequence');
const kids = ['a', 'b', 'c', 'd'];
check('before middle', JSON.stringify(desiredSequence(kids, 'd', 'b', 'before')) === JSON.stringify(['a', 'd', 'b', 'c']));
check('after target', JSON.stringify(desiredSequence(kids, 'a', 'c', 'after')) === JSON.stringify(['b', 'c', 'a', 'd']));
check('before first → anchor lands first', JSON.stringify(desiredSequence(kids, 'd', 'a', 'before')) === JSON.stringify(['d', 'a', 'b', 'c']));
check('anchor === target → null', desiredSequence(kids, 'b', 'b', 'before') === null);
check('anchor not a child → null', desiredSequence(kids, 'z', 'b', 'before') === null);
check('target not a child → null', desiredSequence(kids, 'b', 'z', 'before') === null);
const seq1 = desiredSequence(kids, 'd', 'b', 'before');
check('idempotent (re-applying yields same sequence)',
  seq1 !== null && JSON.stringify(desiredSequence(seq1, 'd', 'b', 'before')) === JSON.stringify(seq1));

console.log('preconditions');
check('reorder: block parent → note', /display:block/.test(reorderNote('block') || ''));
check('reorder: flex parent → null', reorderNote('flex') === null);
check('reorder: inline-grid parent → null', reorderNote('inline-grid') === null);
check('reorder: no parent → null', reorderNote(null) === null);
check('reshape: columns on resolved flex → note',
  /columns\/rows/.test(reshapeNote({ kind: 'reshape', columns: 3 }, 'flex') || ''));
check('reshape: direction on resolved grid → note',
  /flex-only/.test(reshapeNote({ kind: 'reshape', direction: 'row' }, 'grid') || ''));
check('reshape: columns on grid → null', reshapeNote({ kind: 'reshape', columns: 3 }, 'grid') === null);
check('cap exported', REORDER_SIBLING_CAP === 100);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall green');
