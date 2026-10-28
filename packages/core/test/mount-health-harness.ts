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

import { judgeMount, unattachedRoots, unattachedNote } from '../src/mount-health';
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

interface Root { isConnected: boolean; name: string }
const root = (name: string, isConnected: boolean): Root => ({ name, isConnected });
// A node the insertion watch saw: inclusive `contains` over the roots it holds.
const seenNode = (...holds: Root[]) => ({ contains: (r: Root) => holds.includes(r) });

console.log('judgeMount');
{
  check('no outputs: untracked (opted out of self-healing)', judgeMount([], new Set()) === 'untracked');
  check('no unattached set (older entries): connected outputs are healthy', judgeMount([root('a', true)], undefined) === 'healthy');

  // The bug: a returned root the handler never inserted.
  const orphan = root('orphan', false);
  const orphans = unattachedRoots([orphan], [seenNode(root('site-node', true))]);
  check('a root off the page at mount is recorded unattached', orphans.has(orphan) && orphans.size === 1);
  let remounts = 0;
  for (let i = 0; i < 200; i++) if (judgeMount([orphan], orphans) === 'stomped') remounts++;
  check('a never-attached root is never judged stomped across 200 scans', remounts === 0, remounts);
  check('…it reads as untracked', judgeMount([orphan], orphans) === 'untracked');

  // Inserted, then removed by the site before the handler settled: the watch
  // saw it (or a removed ancestor), so it is tracked and self-heals.
  const flashed = root('flashed', false);
  check('a root the watch saw added/removed is not unattached', unattachedRoots([flashed], [seenNode(flashed)]).size === 0);
  const inRemovedParent = root('child', false);
  check('…nor one inside a node the watch saw removed', unattachedRoots([inRemovedParent], [seenNode(root('x', false), inRemovedParent)]).size === 0);
  check('…so it is judged stomped and re-mounts', judgeMount([flashed], unattachedRoots([flashed], [seenNode(flashed)])) === 'stomped');
  check('a watch that gave up (null) judges nothing never-inserted', unattachedRoots([root('z', false)], null).size === 0);

  // A genuinely stomped root still self-heals.
  const placed = root('placed', true);
  const none = unattachedRoots([placed], []);
  check('a root on the page at mount is tracked', none.size === 0);
  check('…healthy while connected', judgeMount([placed], none) === 'healthy');
  placed.isConnected = false;
  check('…stomped once the site removes it', judgeMount([placed], none) === 'stomped');

  // Mixed: one inserted, one forgotten.
  const kept = root('kept', true);
  const lost = root('lost', false);
  const mixed = unattachedRoots([kept, lost], []);
  check('mixed: only the off-page root is unattached', mixed.size === 1 && mixed.has(lost));
  check('mixed: healthy while the inserted root stays', judgeMount([kept, lost], mixed) === 'healthy');
  kept.isConnected = false;
  check('mixed: stomped when the inserted root is removed', judgeMount([kept, lost], mixed) === 'stomped');

  // A handler that inserts its returned root later (from a timer).
  const late = root('late', false);
  const lateSet = unattachedRoots([late], []);
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
  check('mountOn records unattached roots after each handler settles', /unattachedRoots<HTMLElement>\(placed, watch\.take\(\)\)/.test(src) && /rs\.state\.set\(el, \{ outputs, cleanups, change, unattached \}\)/.test(src));
  check('the insertion watch observes the document\'s childList for the dispatch', /watch\.observe\(document, \{ childList: true, subtree: true \}\)/.test(src)
    && /finally \{\s*watch\?\.stop\(\);/.test(src));
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall mount-health checks passed');
