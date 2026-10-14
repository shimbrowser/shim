// extra-rule-teardown-harness — pins that a torn-down patch control never
// mounts an extra rule whose setup was still deferred (packages/core/src/
// engine.ts, applyExtraRule). Bare node — no DOM.
//
// applyExtraRule defers setup through api.onReady, so a preview sent while the
// document is still loading waits for DOMContentLoaded. If the control is torn
// down first (the headless host's detach removing every preview, the browser
// removing a patch), that deferred setup must do nothing: without the guard it
// would install the rule after its owner had let go of the page, with no
// teardown left to undo it.
//
// The stub api's onReady queues callbacks instead of running them, and a
// `document` getter on globalThis records any access: a setup that runs reads
// the document, a guarded one never does.
//
//   node out/packages/core/test/extra-rule-teardown-harness.js

import { run } from '../src/engine';
import type { CoreApi } from '../src/api';
import type { Rule } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  failures += 1;
  console.error(`  ✗ ${label}${detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}

let documentReads = 0;
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  get() {
    documentReads += 1;
    throw new Error('document read');
  },
});

function stubApi(deferred: Array<() => void>): CoreApi {
  return {
    origin: 'https://example.test',
    host: 'example.test',
    patchId: 'preview:test',
    bridge: { forwardRule: () => undefined },
    componentId: {
      verify: () => Promise.resolve(null),
      find: () => Promise.resolve([]),
      symbols: () => Promise.resolve(null),
    },
    reportEvent: () => undefined,
    onReady: (fn) => { deferred.push(fn); },
  };
}

// Runs every deferred callback; reports whether any of them touched the document.
function flush(deferred: Array<() => void>): boolean {
  const before = documentReads;
  for (const fn of deferred.splice(0)) {
    try { fn(); } catch { /* the stub document throws; the read is what counts */ }
  }
  return documentReads > before;
}

const rule: Rule = { id: 'hide-it', anchor: { primary: { kind: 'css', value: '#target' } }, mutations: [{ kind: 'hide' }] };

{
  // Control: with the control live, the deferred setup does run.
  const deferred: Array<() => void> = [];
  const control = run({ spec: { id: 'preview:live', rules: [] } }, stubApi(deferred));
  control.applyExtraRule(rule, 'preview:live', 'preview:live');
  check('the setup is deferred until the document is ready', deferred.length > 0, deferred.length);
  check('a live control runs the deferred setup', flush(deferred));
}

{
  const deferred: Array<() => void> = [];
  const control = run({ spec: { id: 'preview:gone', rules: [] } }, stubApi(deferred));
  control.applyExtraRule(rule, 'preview:gone', 'preview:gone');
  control.teardownAll();
  check('a control torn down before the document was ready mounts nothing afterwards', !flush(deferred));
}

if (failures) {
  console.error(`\n✗ extra-rule-teardown: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n✓ extra-rule-teardown: all checks passed');
