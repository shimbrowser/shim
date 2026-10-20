// tagged-api-harness — pins that an extra rule's events carry the tag of the
// application that produced them (packages/core/src/tagged-api.ts, engine.ts
// applyExtraRule's `applyId`). Bare node — no DOM.
//
// A host replaying a preview onto a fresh document and then applying the
// agent's next edit of the same key must be able to tell a late event of the
// first application from one the second caused: the tag is stamped by the api
// the rule's setup holds, not by whoever receives the event.
//
//   node out/packages/core/test/tagged-api-harness.js

import { taggedApi } from '../src/tagged-api';
import type { CoreApi } from '../src/api';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  failures += 1;
  console.error(`  ✗ ${label}${detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}

const reported: Array<{ kind: string; payload: Record<string, unknown> | undefined }> = [];
const base: CoreApi & { storage: { marker: string } } = {
  origin: 'https://example.test',
  host: 'example.test',
  patchId: 'preview:test',
  bridge: { forwardRule: () => undefined },
  componentId: {
    verify: () => Promise.resolve(null),
    find: () => Promise.resolve([]),
    symbols: () => Promise.resolve(null),
  },
  reportEvent: (kind, payload) => { reported.push({ kind, payload }); },
  onReady: (fn) => fn(),
  storage: { marker: 'host-storage' },
};

{
  const same = taggedApi(base, undefined);
  check('no tag: the host api itself, unwrapped', same === base);
  check('an empty tag is no tag', taggedApi(base, '') === base);
}

{
  const first = taggedApi(base, 'restore:g1:1');
  const second = taggedApi(base, 'emit:7');
  // The second application starts; the first one's witness arrives late.
  second.reportEvent('rule-status', { specId: 'preview:s:r', matched: 1 });
  first.reportEvent('rule-witness', { specId: 'preview:s:r', ruleId: 'r', witness: { tag: 'div' } });
  const [status, witness] = reported;
  check('each event carries its own application tag', status?.payload?.applyId === 'emit:7' && witness?.payload?.applyId === 'restore:g1:1', reported);
  check('the payload is otherwise unchanged', witness?.payload?.ruleId === 'r' && witness.kind === 'rule-witness');
  first.reportEvent('handler-error', { applyId: 'spoofed', message: 'x' });
  check('a payload cannot carry another application tag', reported[2]?.payload?.applyId === 'restore:g1:1', reported[2]);
  first.reportEvent('rule-no-match');
  check('an event with no payload still gets the tag', reported[3]?.payload?.applyId === 'restore:g1:1');
  check('every other member is the host api\'s', first.storage.marker === 'host-storage' && first.host === 'example.test');
  check('wrapping never touches the host api', base.reportEvent !== first.reportEvent && !Object.prototype.hasOwnProperty.call(base, 'applyId'));
}

if (failures) {
  console.error(`\n✗ tagged-api: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n✓ tagged-api: all checks passed');
