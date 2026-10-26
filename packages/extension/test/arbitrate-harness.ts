// Pins how the worker settles two runtimes on one page (src/arbitrate.ts):
// the one that does not fit the mode is retired, whichever connected
// first, and the survivor always survivors, since the loser's teardown
// takes stylesheets and tokens the survivor's rules share.

import { arbitrate, worldFor } from '../src/arbitrate';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

console.log('\n=== arbitrate harness ===\n');

check('full mode keeps the user-script world', worldFor('full') === 'user-script');
check('declarative mode keeps the isolated world', worldFor('declarative') === 'isolated');

check('the same world is no contest (a reconnect, or a second copy the runtime folds in)',
  arbitrate('isolated', 'isolated', 'full') === null && arbitrate('user-script', 'user-script', 'declarative') === null);

console.log('full mode:');
check('an isolated newcomer beside a user-script holder: the newcomer leaves, the holder survives',
  JSON.stringify(arbitrate('user-script', 'isolated', 'full')) === JSON.stringify({ retire: 'incoming', survivor: 'existing' }));
check('a user-script newcomer beside an isolated holder: the holder leaves, the newcomer survives',
  JSON.stringify(arbitrate('isolated', 'user-script', 'full')) === JSON.stringify({ retire: 'existing', survivor: 'incoming' }));

console.log('declarative mode:');
check('a user-script runtime reconnecting beside an isolated holder (its port was down past the wait): it leaves, the holder survives',
  JSON.stringify(arbitrate('isolated', 'user-script', 'declarative')) === JSON.stringify({ retire: 'incoming', survivor: 'existing' }));
check('an isolated newcomer beside a user-script holder: the holder leaves, the newcomer survives',
  JSON.stringify(arbitrate('user-script', 'isolated', 'declarative')) === JSON.stringify({ retire: 'existing', survivor: 'incoming' }));

console.log('whichever loses, the other survives:');
for (const existing of ['isolated', 'user-script'] as const) {
  for (const incoming of ['isolated', 'user-script'] as const) {
    for (const mode of ['full', 'declarative'] as const) {
      const a = arbitrate(existing, incoming, mode);
      if (a) check(`${existing} then ${incoming} in ${mode}: retire one, keep the other`, a.retire !== a.survivor);
    }
  }
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log(`all arbitrate checks passed (${passes})`);
