// Pins how the worker settles two runtimes on one page (src/arbitrate.ts):
// the one that does not fit the mode is retired, whichever connected
// first, and the survivor always survivors, since the loser's teardown
// takes stylesheets and tokens the survivor's rules share.

import fs from 'fs';
import path from 'path';
import { arbitrate, createModeHold, worldFor } from '../src/arbitrate';

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

function fakePort(): { onDisconnect: { addListener(cb: () => void): void }; disconnect(): void } {
  const listeners: Array<() => void> = [];
  return {
    onDisconnect: { addListener: (cb) => { listeners.push(cb); } },
    disconnect: () => { for (const cb of listeners) cb(); },
  };
}
const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function holds(): Promise<void> {
  console.log('the hold on a cold wake:');
  let measure: (mode: string) => void = () => undefined;
  const hold = createModeHold(new Promise<string>((r) => { measure = r; }));
  check('unsettled until the first measurement', !hold.settled());

  const resumed: string[] = [];
  const stays = fakePort();
  const leaves = fakePort();
  hold.hold(stays, () => { resumed.push('stays'); });
  hold.hold(leaves, () => { resumed.push('leaves'); });
  await turn();
  check('nothing resumes before the measurement', resumed.length === 0);
  leaves.disconnect();
  measure('full');
  await turn();
  check('settled once measured', hold.settled());
  check('a held port resumes, a port that went does not', JSON.stringify(resumed) === JSON.stringify(['stays']), resumed.join(','));

  const failed = createModeHold(Promise.reject(new Error('no answer')));
  let ran = false;
  failed.hold(fakePort(), () => { ran = true; });
  await turn();
  check('a failed measurement settles on the guess, so no port waits for ever', failed.settled() && ran);

  // The worker's half: no verdict is reached past an unsettled hold, and the
  // hold sits after the listeners went on (acceptRuntimePort), never before.
  const worker = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'packages', 'extension', 'src', 'sw.ts'), 'utf8');
  const guard = worker.indexOf('if (!modeHold.settled())');
  const verdict = worker.indexOf('arbitrate(rivalWorld, world, modeNow)');
  check('the worker checks the hold before it arbitrates', guard !== -1 && guard < verdict);
  check('the worker arbitrates in one place', worker.split('arbitrate(').length === 2);
  check('the worker never awaits the mode before a port is listened to',
    !/acceptRuntimePort[\s\S]{0,400}await /.test(worker.slice(worker.indexOf('function acceptRuntimePort'), worker.indexOf('function disconnectQuietly'))));
}

void holds().then(() => {
  console.log('');
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log(`all arbitrate checks passed (${passes})`);
});
