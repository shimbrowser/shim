// Diagnostic harness for the pure route-transition decision (packages/core/src/
// route-transition.ts nested sub-routes). Bare node, no DOM:
//
//   node out/packages/core/test/route-transition-harness.js
//
// Pins the full truth table the engine's evaluate() relies on: first mount,
// leaving the route, redundant re-eval, in-place update when a handler opted in
// via onRouteChange, and remount (back-compat) when it did not.

import { routeTransition } from '../src/route-transition';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// not mounted (prevPath === null)
check('not mounted + match → mount', routeTransition(null, '/budgets', true, false) === 'mount');
check('not mounted + no match → noop', routeTransition(null, '/other', false, false) === 'noop');
check('not mounted + match, canUpdate irrelevant → mount', routeTransition(null, '/budgets', true, true) === 'mount');

// mounted, leaving the route
check('mounted + no match → unmount', routeTransition('/budgets', '/other', false, true) === 'unmount');
check('mounted + no match, no callback → unmount', routeTransition('/budgets', '/other', false, false) === 'unmount');

// mounted, same path (redundant popstate / re-eval)
check('mounted + same path → noop', routeTransition('/budgets', '/budgets', true, true) === 'noop');
check('mounted + same path, no callback → noop', routeTransition('/budgets', '/budgets', true, false) === 'noop');

// mounted, path changed within the route
check('mounted + different path + canUpdate → update', routeTransition('/budgets', '/budgets/42', true, true) === 'update');
check('mounted + different path + NO callback → mount (remount, back-compat)', routeTransition('/budgets', '/budgets/42', true, false) === 'mount');

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all checks passed');
