// Witness capture over one rule lifecycle (witness-capture.ts) and how hosts
// read its events (capture-event.ts). Bare node: elements are stubs, frames
// are flushed by hand, the api records events.
// Pins:
//   - one member at once → an element witness; several → a set witness that
//     supersedes it (higher rev, same document); a mixed-tag member then
//     withdraws everything (explicit none) — singleton → set → withdrawal
//     ends with no fingerprint
//   - a re-rendered single element (old node gone, new one in) stays an
//     element rule
//   - the aggregate re-emits when members change, frame-coalesced, and never
//     when nothing changed
//   - cardinality 'many': one member → none with `one-member`, never an
//     element witness; two → a set
//   - a remove rule over several members → none with `remove-rule`
//   - a rule that already carries a fingerprint captures nothing
//   - the identity predicate is stored only when its complete result equals
//     the anchor's
//   - hosts: selectCapture keeps the latest event in binding (applyId,
//     anchor digest), a lower rev never wins, an event from another applyId
//     or anchor is ignored, a newer document replaces an older one
//
//   node out/packages/core/test/witness-capture-harness.js

import { makeCaptureController } from '../src/witness-capture';
import { selectCapture, readCaptureEvent, fingerprintOfCapture } from '../src/capture-event';
import { anchorDigest } from '../src/managed-anchor';
import { makeReconciler } from '../src/rule-reconcile';
import { makeRuleState } from '../src/rule-state';
import type { RuntimeSpec } from '../src/engine-internal';
import type { Anchor } from '../src/types';
import type { CoreApi } from '../src/api';
import type { Rule } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail: unknown = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}

interface StubEl { nodeType: 1; tagName: string; attributes: Array<{ name: string; value: string }>; children: StubEl[]; childNodes: StubEl[]; parentElement: StubEl | null; getAttribute(n: string): string | null }
function h(tag: string, attrs: Record<string, string> = {}): StubEl {
  return {
    nodeType: 1, tagName: tag.toUpperCase(), attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    children: [], childNodes: [], parentElement: null,
    getAttribute(n: string) { const a = this.attributes.find((x) => x.name === n); return a ? a.value : null; },
  };
}
const el = (e: StubEl): Element => e as unknown as Element;
const parent = h('ul');
const row = (i: number, extra: Record<string, string> = {}) => { const r = h('li', { 'data-kind': 'row', 'data-i': String(i), ...extra }); r.parentElement = parent; return r; };

interface Harness {
  events: Array<Record<string, unknown>>;
  flush(): void;
  observe(nodes: StubEl[]): void;
  stop(): void;
  settle(): Promise<void>;
}
function harness(rule: Rule, queryAll: (sel: string) => StubEl[] = () => []): Harness {
  const events: Array<Record<string, unknown>> = [];
  const frames: Array<() => void> = [];
  const api = {
    origin: 'https://x.test', host: 'x.test', patchId: 's', bridge: { forwardRule() {} },
    componentId: { verify: () => Promise.resolve(null), find: () => Promise.resolve([]), symbols: () => Promise.resolve(null) },
    reportEvent(kind: string, payload: Record<string, unknown> = {}) { events.push({ kind, ...payload }); },
    onReady() {},
  } as CoreApi;
  const c = makeCaptureController(rule, 'preview:s:r', api, {
    isOwned: () => false,
    schedule: (run) => { frames.push(run); return () => { const i = frames.indexOf(run); if (i >= 0) frames.splice(i, 1); }; },
    queryAll: (sel) => queryAll(sel).map(el),
  });
  return {
    events,
    flush() { while (frames.length) frames.shift()?.(); },
    observe(nodes) { c.observe(nodes.map(el)); },
    stop() { c.stop(); },
    settle: () => new Promise((r) => setTimeout(r, 20)),
  };
}
const ruleOf = (extra: Partial<Rule> = {}, anchorExtra: Record<string, unknown> = {}): Rule => ({
  id: 'r', anchor: { primary: { kind: 'css', value: 'li' }, ...anchorExtra }, mutations: [{ kind: 'hide' }], ...extra,
});

async function tLifecycle(): Promise<void> {
  console.log('singleton → set → mixed-tag withdrawal:');
  const H = harness(ruleOf());
  const a = row(1);
  H.observe([a]);
  await H.settle(); H.flush();
  const first = H.events.at(-1);
  check('one member → an element witness', !!first && (first.witness as { tag?: string } | null)?.tag === 'li' && first.setWitness === null, first);
  const b = row(2);
  H.observe([a, b]); H.flush();
  const second = H.events.at(-1);
  check('a second member at once → a set witness, no element witness', second?.witness === null && (second?.setWitness as { count?: number } | null)?.count === 2, second);
  check('…at a higher rev, same document', (second?.rev as number) > (first?.rev as number) && second?.documentId === first?.documentId);
  const before = H.events.length;
  H.observe([a, b]); H.flush();
  check('nothing changed → nothing re-emitted', H.events.length === before);
  const c = row(3);
  H.observe([a, b, c]); H.flush(); H.observe([a, b, c]); H.flush();
  check('a new member → one re-emission with the new count', H.events.length === before + 1 && (H.events.at(-1)?.setWitness as { count?: number }).count === 3);
  const span = h('span', { 'data-kind': 'row' }); span.parentElement = parent;
  H.observe([a, b, c, span]); H.flush();
  const last = H.events.at(-1);
  check('a mixed-tag member withdraws: explicit none, with the reason', last?.witness === null && last?.setWitness === null && last?.captureNote === 'mixed-tags', last);
  const picked = selectCapture(H.events, { applyId: null, anchorDigest: anchorDigest(ruleOf().anchor) });
  check('a host reading the stream ends with no fingerprint', !!picked && Object.keys(fingerprintOfCapture(picked)).length === 0, picked);
  H.stop();
}

async function tRerender(): Promise<void> {
  console.log('a single element the page re-rendered:');
  const H = harness(ruleOf());
  H.observe([row(1)]); await H.settle();
  H.observe([row(1)]); await H.settle(); H.flush();
  check('stays an element rule (one at once), never a set', H.events.length === 1 && !!H.events[0]?.witness && !H.events.some((e) => e.setWitness), H.events);
}

async function tMany(): Promise<void> {
  console.log('cardinality many:');
  const H = harness(ruleOf({}, { cardinality: 'many' }));
  const a = row(1);
  H.observe([a]); H.flush(); await H.settle();
  check('one member → none with one-member, never an element witness', H.events.length === 1 && H.events[0]?.witness === null && H.events[0]?.captureNote === 'one-member', H.events);
  H.observe([a, row(2)]); H.flush();
  check('two → a set witness', (H.events.at(-1)?.setWitness as { count?: number } | null)?.count === 2);
  const P = harness(ruleOf({}, { cardinality: 'many' }));
  const x = row(1);
  P.observe([x]); P.observe([x, row(2)]); P.flush();
  check('a second member before the first frame: the set wins, no one-member note', P.events.length === 1 && !!P.events[0]?.setWitness, P.events);
}

async function tRemoveAndCarrying(): Promise<void> {
  console.log('remove rules, carried fingerprints:');
  const R = harness(ruleOf({ mutations: [{ kind: 'remove' }] }));
  R.observe([row(1), row(2)]); R.flush();
  check('a remove rule over several → none with remove-rule', R.events.at(-1)?.captureNote === 'remove-rule' && R.events.at(-1)?.setWitness === null);
  const C = harness(ruleOf({}, { setWitness: { v: 1, tag: 'li', count: 2, nested: false } }));
  C.observe([row(1), row(2)]); C.flush(); await C.settle();
  check('a rule already carrying a fingerprint captures nothing', C.events.length === 0);
}

async function tIdentity(): Promise<void> {
  console.log('identity predicate equivalence:');
  const a = row(1); const b = row(2);
  const eq = harness(ruleOf(), () => [a, b]);
  eq.observe([a, b]); eq.flush();
  check('stored when the predicate finds exactly the anchor\'s result', (eq.events.at(-1)?.setWitness as { identity?: string }).identity === 'li[data-kind="row"]', eq.events.at(-1));
  const broad = harness(ruleOf(), () => [a, b, row(9)]);
  broad.observe([a, b]); broad.flush();
  check('not stored when it would find more', (broad.events.at(-1)?.setWitness as { identity?: string }).identity === undefined);
}

// Promote after a deploy (rule-reconcile): an authored set keeps its
// cardinality and never gets an element witness from the one member the
// fallback found; a set witness is carried, never refreshed.
function promoteOf(anchor: Anchor): Promise<Anchor | null> {
  return new Promise((resolve) => {
    let out: Anchor | null = null;
    const api = {
      origin: 'x', host: 'x', patchId: 's', bridge: { forwardRule() {} },
      componentId: { verify: () => Promise.resolve(null), find: () => Promise.resolve([]), symbols: () => Promise.resolve(null) },
      reportEvent(kind: string, payload: Record<string, unknown> = {}) { if (kind === 'rule-rebase') out = payload.anchor as Anchor; },
      onReady() {},
    } as CoreApi;
    const rule: Rule = { id: 'r', anchor, mutations: [{ kind: 'hide' }] };
    const spec = { id: 's', rules: [rule], bundleHash: 'old', __bundleHashFn: () => 'new' } as RuntimeSpec;
    const rs = makeRuleState();
    const member = el(row(1));
    rs.state.set(member, { outputs: [], cleanups: [] });
    rs.verifiedCount = 1;
    rs.matchedSource = 'fallback:0';
    rs.resolvedEl = member;
    const r = makeReconciler(rule, spec, api, rs, new Set());
    r.start();
    setTimeout(() => { r.stop(); resolve(out); }, 1800);
  });
}

async function tPromote(): Promise<void> {
  console.log('promote:');
  const ladder = { primary: { kind: 'css' as const, value: '.dead' }, fallbacks: [{ kind: 'css' as const, value: 'li.row' }] };
  const sw = { v: 1, tag: 'li', count: 3, nested: false };
  const [bare, withSet, plain] = await Promise.all([
    promoteOf({ ...ladder, cardinality: 'many' }),
    promoteOf({ ...ladder, cardinality: 'many', setWitness: sw }),
    promoteOf({ ...ladder }),
  ]);
  check('a fingerprint-less many-rule promotes without an element witness, keeping cardinality', !!bare && !bare.witness && bare.cardinality === 'many' && bare.primary.value === 'li.row', bare);
  check('a set-witnessed many-rule keeps its set witness and cardinality', !!withSet && withSet.setWitness === sw && !withSet.witness && withSet.cardinality === 'many', withSet);
  check('an ordinary rule still gets an element witness from the promoted element', !!plain?.witness, plain);
}

function tHostSelection(): void {
  console.log('host-side selection:');
  const digest = anchorDigest({ primary: { kind: 'css', value: 'li' } });
  const ev = (rev: number, extra: Record<string, unknown> = {}) => ({ kind: 'rule-witness', specId: 'k', ruleId: 'r', witness: null, setWitness: { v: 1, tag: 'li', count: rev, nested: false }, documentId: 'd1', anchorDigest: digest, rev, applyId: 'A', ...extra });
  const pick = (events: unknown[]) => selectCapture(events, { applyId: 'A', anchorDigest: digest });
  check('the highest rev wins whatever the arrival order', pick([ev(3), ev(5), ev(4)])?.rev === 5);
  check('another applyId is ignored', pick([ev(3), ev(9, { applyId: 'B' })])?.rev === 3);
  check('another anchor is ignored', pick([ev(3), ev(9, { anchorDigest: 'other' })])?.rev === 3);
  check('a newer document replaces an older one, whatever its rev', pick([ev(7), ev(1, { documentId: 'd2' })])?.documentId === 'd2');
  check('a legacy element event (no rev) reads as an element capture', readCaptureEvent({ kind: 'rule-witness', witness: { v: 1, tag: 'a' } })?.rev === -1);
  check('nothing in binding → null', pick([ev(3, { applyId: 'B' })]) === null);
  check('an untagged event (a host that stamps no applyId) is accepted', pick([ev(3, { applyId: undefined })])?.rev === 3);
}

void (async () => {
  console.log('\n=== witness-capture harness ===\n');
  await tLifecycle();
  await tRerender();
  await tMany();
  await tRemoveAndCarrying();
  await tIdentity();
  await tPromote();
  tHostSelection();
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall witness-capture checks passed');
})();
