// Harness for the self-healing verdict on a mount's returned roots
// (packages/core/src/mount-health.ts) and the rule-status note it feeds
// (rule-status.ts). Bare node: roots are `{ isConnected }` stubs.
//
//   node out/packages/core/test/mount-health-harness.js
//
// The bug this pins: an inline `script` handler that RETURNED a node it never
// inserted read as "stomped by the site" on every scan, so the engine tore the
// mount down and re-ran the handler on every body mutation, forever, with
// nothing reported. A never-connected root must not re-mount; a root that was
// on the page and left it must still self-heal. The end-to-end behavior (mount
// counts across many page mutations, sync and async handlers) runs in real
// browsers: the page-host conformance case `unattached-inline-output`.

import { judgeMount, makeInsertionLog, unattachedNote } from '../src/mount-health';
import { makeStatusReporter } from '../src/rule-status';
import { makeRuleState } from '../src/rule-state';
import { describeRuleStatus } from '../src/preview-evidence';
import type { CoreApi } from '../src/api';
import type { RuleMountEntry } from '../src/engine-internal';
import type { Rule, Spec } from '../src/types';
import * as fs from 'fs';
import * as path from 'path';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

interface Root { isConnected: boolean; name: string; parent: Root | null }
const root = (name: string, isConnected: boolean, parent: Root | null = null): Root => ({ name, isConnected, parent });

// An insertion log over stub nodes; `pending` is what the observer has queued
// but not delivered (what takeRecords would return).
function testLog(cap = 5000) {
  const calls = { connect: 0, disconnect: 0 };
  let observing = false;
  const pending: Root[] = [];
  const log = makeInsertionLog<Root>({
    cap,
    parentOf: (n) => n.parent,
    connect: () => { calls.connect++; observing = true; },
    disconnect: () => { calls.disconnect++; observing = false; },
    flush: () => pending.splice(0),
  });
  // A page change: queued only while observing, as a MutationObserver would.
  const change = (...nodes: Root[]) => { if (observing) pending.push(...nodes); };
  const deliver = () => log.record(pending.splice(0));
  return { log, calls, change, deliver, observing: () => observing };
}

console.log('insertion log');
{
  // The bug: a returned root the handler never inserted.
  const t = testLog();
  const start = t.log.begin();
  t.change(root('site-node', true));
  const orphan = root('orphan', false);
  const orphans = t.log.unattached([orphan], start);
  t.log.end();
  check('a root never on the page while the handler ran is unattached', orphans.has(orphan) && orphans.size === 1);
  let remounts = 0;
  for (let i = 0; i < 200; i++) if (judgeMount([orphan], orphans) === 'stomped') remounts++;
  check('…and never judged stomped across 200 scans', remounts === 0, remounts);
  check('…it reads as untracked', judgeMount([orphan], orphans) === 'untracked');
  check('the observer runs only while a mount is in flight', t.calls.connect === 1 && t.calls.disconnect === 1 && !t.observing());
  check('…and holds nothing after', t.log.held === 0);

  // Inserted, then removed before the handler settled.
  const t2 = testLog();
  const s2 = t2.log.begin();
  const flashed = root('flashed', false);
  t2.change(flashed); // added, then removed (both records name it)
  t2.deliver();
  const parent = root('row', false);
  const child = root('child', false, parent);
  t2.change(parent); // its removed ancestor
  const u2 = t2.log.unattached([flashed, child], s2);
  t2.log.end();
  check('a root the log saw added/removed is not unattached', !u2.has(flashed));
  check('…nor one under a removed ancestor (from takeRecords at settle)', !u2.has(child));
  check('…so it is judged stomped and re-mounts', judgeMount([flashed], u2) === 'stomped');

  // Only changes after this mount's start count.
  const t3 = testLog();
  const early = t3.log.begin();
  const before = root('before', false);
  t3.change(before);
  t3.deliver();
  const late = t3.log.begin();
  check('a change before a mount\'s start is not its evidence', t3.log.unattached([before], late).has(before));
  check('…but is for a mount started earlier', !t3.log.unattached([before], early).has(before));
  t3.log.end(); t3.log.end();

  // Many anchors at once: one observer, one record per change.
  const t4 = testLog();
  const starts: number[] = [];
  for (let i = 0; i < 1000; i++) starts.push(t4.log.begin());
  const rows: Root[] = [];
  for (let i = 0; i < 1000; i++) { const r = root(`row${i}`, true); rows.push(r); t4.change(r); }
  t4.deliver();
  check('1,000 concurrent mounts share one observer', t4.calls.connect === 1, t4.calls);
  check('…and hold one entry per changed node, not per mount', t4.log.held === 1000, t4.log.held);
  for (let i = 0; i < 1000; i++) t4.log.end();
  check('…all released when the last mount ends', t4.log.active === 0 && t4.log.held === 0 && t4.calls.disconnect === 1);

  // Past the cap the log gives up: nothing judged never-inserted.
  const t5 = testLog(10);
  const s5 = t5.log.begin();
  for (let i = 0; i < 11; i++) t5.change(root(`n${i}`, true));
  t5.deliver();
  check('past the cap the log stops observing and drops its nodes', !t5.observing() && t5.log.held === 0);
  check('…and judges no root never-inserted', t5.log.unattached([root('z', false)], s5).size === 0);
  t5.log.end();
  const s5b = t5.log.begin();
  check('a fresh mount after every mount ended observes again', t5.observing() && t5.log.unattached([root('y', false)], s5b).size === 1);
  t5.log.end();

  // Teardown with a handler that never settles.
  const t6 = testLog();
  t6.log.begin();
  t6.change(root('a', true));
  t6.deliver();
  t6.log.stop();
  check('teardown stops observing a still-pending mount and drops what it held', !t6.observing() && t6.log.held === 0);
  t6.change(root('b', true));
  t6.log.record([root('c', true)]);
  check('…and later page changes are not collected', t6.log.held === 0);
  t6.log.end();
  t6.log.end();
  check('…and the mount\'s late end is harmless', t6.log.active === 0 && !t6.observing());
  t6.log.begin();
  check('…nor does anything observe after teardown', !t6.observing());
}

console.log('judgeMount');
{
  check('no outputs: untracked (opted out of self-healing)', judgeMount([], new Set()) === 'untracked');
  check('no unattached set (older entries): connected outputs are healthy', judgeMount([root('a', true)], undefined) === 'healthy');

  const placed = root('placed', true);
  const none = new Set<Root>();
  check('…healthy while connected', judgeMount([placed], none) === 'healthy');
  placed.isConnected = false;
  check('…stomped once the site removes it', judgeMount([placed], none) === 'stomped');

  // Mixed: one inserted, one forgotten.
  const kept = root('kept', true);
  const lost = root('lost', false);
  const mixed = new Set([lost]);
  check('mixed: healthy while the inserted root stays', judgeMount([kept, lost], mixed) === 'healthy');
  kept.isConnected = false;
  check('mixed: stomped when the inserted root is removed', judgeMount([kept, lost], mixed) === 'stomped');

  // A handler that inserts its returned root later (from a timer).
  const late = root('late', false);
  const lateSet = new Set([late]);
  check('late insert: untracked before it lands', judgeMount([late], lateSet) === 'untracked');
  late.isConnected = true;
  check('late insert: healthy once seen connected', judgeMount([late], lateSet) === 'healthy');
  check('…and it leaves the unattached set', !lateSet.has(late));
  late.isConnected = false;
  check('late insert: self-heals like any root after that', judgeMount([late], lateSet) === 'stomped');
}

console.log('rule-status note');
{
  check('no note for zero', unattachedNote(0) === null);
  const n = unattachedNote(2) ?? '';
  check('the note counts the nodes and says they were never put on the page', n.includes('returned 2 node(s) it never put on the page'), n);
  check('…and names the two fixes', n.includes('insert your output yourself') && n.includes('portal') && n.includes('overlay'), n);

  const rule: Rule = { id: 'badge', anchor: { primary: { kind: 'css', value: '.t' } }, mutations: [{ kind: 'script', handler: 'badge' }] };
  const spec = { id: 'shim-x', version: 1, match: { hosts: ['example.com'] }, rules: [rule] } as Spec;
  const events: Record<string, unknown>[] = [];
  const api = { reportEvent: (_k: string, d: Record<string, unknown>) => { events.push(d); } } as unknown as CoreApi;
  const rs = makeRuleState();
  const anchor = { ownerDocument: { defaultView: null }, getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }) };
  const orphan = root('o', false);
  const entry = { outputs: [orphan], cleanups: [], unattached: new Set([orphan]) } as unknown as RuleMountEntry;
  rs.state.set(anchor as unknown as Element, entry);
  rs.matchedSource = 'primary';
  const reporter = makeStatusReporter(rule, spec, api, rs);
  reporter.reportStatusIfChanged();
  const note = events.at(-1)?.note;
  check('rule-status carries the note for a mount with an unattached root', typeof note === 'string' && note.includes('returned 1 node(s) it never put on the page'), note);
  const line = describeRuleStatus(rule, { matched: 1, matchedVia: 'primary', note: typeof note === 'string' ? note : undefined });
  check('…and the preview evidence line shows it', line.includes('never put on the page'), line);

  // The handler inserts it after all: the next scan's judge prunes it and the note clears.
  orphan.isConnected = true;
  judgeMount(entry.outputs as unknown as Root[], entry.unattached as unknown as Set<Root>);
  reporter.reportStatusIfChanged();
  check('the note clears once the root is on the page', events.at(-1)?.note === null || events.at(-1)?.note === undefined, events.at(-1));
}

console.log('apply-rule wiring');
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'packages', 'core', 'src', 'apply-rule.ts'), 'utf8');
  check('the scan\'s self-heal check goes through judgeMount', /judgeMount\(existing\.outputs, existing\.unattached\) !== 'stomped'/.test(src));
  check('the old document.contains stomp check is gone', !/existing\.outputs\.every\(\(n\) => document\.contains\(n\)\)/.test(src));
  check('mountOn records unattached roots after each handler settles', /insertionLog\.unattached\(placed, insertionStart\)/.test(src) && /rs\.state\.set\(el, \{ outputs, cleanups, change, unattached \}\)/.test(src));
  check('one insertion observer per rule, on the document\'s childList', /insertionObserver \?\?= new MutationObserver/.test(src)
    && /insertionObserver\.observe\(document, \{ childList: true, subtree: true \}\)/.test(src));
  check('each mount ends its share of the log in a finally', /finally \{\s*insertionLog\.end\(\);/.test(src));
  check('rule teardown stops the insertion log', /tornDown = true;\s*insertionLog\?\.stop\(\);/.test(src));
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall mount-health checks passed');
