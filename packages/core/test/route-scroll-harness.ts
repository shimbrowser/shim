// Diagnostic harness for the pure virtual-route scroll store (packages/core/src/
// route-scroll.ts — CLAUDE.md §6). Bare node, no DOM:
//
//   node out/packages/core/test/route-scroll-harness.js
//
// Pins key minting (deterministic counter), history.state field preservation,
// the saved-position map, and the has()/targetFor() distinction that gates
// updateRoute's restore.

import { createRouteScrollStore, SCROLL_STATE_FIELD } from '../src/route-scroll';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

check('SCROLL_STATE_FIELD is __shimScroll', SCROLL_STATE_FIELD === '__shimScroll');

{
  const s = createRouteScrollStore();
  const r0 = s.resolveKey(null);
  check('resolveKey(null) mints s0 + attach carries the key',
    r0.key === 's0' && !!r0.attach && r0.attach.state[SCROLL_STATE_FIELD] === 's0');
  const r1 = s.resolveKey({});
  check('resolveKey({}) mints the next key', r1.key === 's1' && !!r1.attach);
  check('minted keys are unique', r0.key !== r1.key);
}

{
  const s = createRouteScrollStore();
  const r = s.resolveKey({ [SCROLL_STATE_FIELD]: 's7', other: 1 });
  check('existing key passes through, no attach', r.key === 's7' && r.attach === null);
}

{
  const s = createRouteScrollStore();
  const r = s.resolveKey({ other: 1, nested: { a: 2 } });
  check('attach preserves pre-existing state fields',
    r.attach !== null && r.attach.state.other === 1
    && typeof r.attach.state[SCROLL_STATE_FIELD] === 'string');
}

{
  const s = createRouteScrollStore();
  check('targetFor(unknown) → 0', s.targetFor('sX') === 0);
  check('has(unknown) → false', s.has('k') === false);
  s.record('k', 420);
  check('has(k) → true after record', s.has('k') === true);
  check('targetFor(k) returns the recorded position', s.targetFor('k') === 420);
  s.record('k', 0);
  // The load-bearing distinction: a saved 0 is "seen" (has→true) and restorable,
  // NOT the same as an unknown key (has→false) that updateRoute leaves alone.
  check('record(k,0): targetFor 0 AND has stays true', s.targetFor('k') === 0 && s.has('k') === true);
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all checks passed');
