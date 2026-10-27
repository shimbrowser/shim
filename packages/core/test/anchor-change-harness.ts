// Bare-node harness for anchor-change.ts — the api.onAnchorChange hub.
// Duck-typed nodes (a parent pointer and an owned flag), a fake clock and a
// manual timer queue; the hub never touches the DOM itself.
//
//   node out/packages/core/test/anchor-change-harness.js
//
// Real-DOM behavior (the rule observer, drains, self-heal ordering) is pinned
// on both PageHosts by page-host-conformance's `anchor-change` case.

import { makeAnchorChangeHub, makeTokenBucket, BUCKET_BURST } from '../src/anchor-change';
import type { ChangeRecordLike, HubDeps } from '../src/anchor-change';
import type { ScriptHandlerArgs, MutationHandlerDef } from '../src/engine-internal';

// Compile-time: the handler contracts an anchored handler and a custom kind's
// mount are typed against expose a callable api.onAnchorChange (typecheck
// fails here if they regress to the plain CoreHandlerApi, whose index
// signature makes the member `unknown`).
const typedScriptHandler = ({ api }: ScriptHandlerArgs): (() => void) => api.onAnchorChange(() => {});
const typedCustomKind: Pick<MutationHandlerDef, 'mount'> = {
  mount: (_el, _mut, _rule, _spec, api) => api.onAnchorChange(() => {}),
};
void typedScriptHandler; void typedCustomKind;

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

interface FakeNode { name: string; parent: FakeNode | null; owned?: boolean }
const node = (name: string, parent: FakeNode | null, owned = false): FakeNode => ({ name, parent, owned });
const rec = (target: FakeNode, added: FakeNode[] = [], removed: FakeNode[] = []): ChangeRecordLike<FakeNode> =>
  ({ target, addedNodes: added, removedNodes: removed });

function setup() {
  let now = 0;
  let frames = 0;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  const errors: Array<{ err: unknown; handlerName: string }> = [];
  let throttles = 0;
  const deps: HubDeps<FakeNode> = {
    parentOf: (n) => n.parent,
    isOwnedNode: (n) => n.owned === true,
    now: () => now,
    setTimer: (run, ms) => { const t = { at: now + ms, run, live: true }; timers.push(t); return () => { t.live = false; }; },
    requestFrame: () => { frames += 1; },
    reportError: (err, handlerName) => { errors.push({ err, handlerName }); },
    onThrottle: () => { throttles += 1; },
  };
  const hub = makeAnchorChangeHub(deps);
  const html = node('html', null);
  const body = node('body', html);
  const a = node('a', body);
  const aInner = node('a-inner', a);
  const b = node('b', body);
  return {
    hub, html, body, a, aInner, b, errors, timers,
    frames: () => frames,
    resetFrames: () => { frames = 0; },
    throttles: () => throttles,
    advance: (ms: number) => {
      now += ms;
      for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.run(); }
    },
  };
}

const always = () => true;
const none = (): ArrayLike<ChangeRecordLike<FakeNode>> => [];

console.log('token bucket');
{
  const bucket = makeTokenBucket(2, 4);
  check('burst tokens available', bucket.take(0) && bucket.take(0));
  check('then empty', !bucket.take(0));
  check('nextAt is one refill period away (250ms at 4/s)', bucket.nextAt(0) === 250, bucket.nextAt(0));
  check('refills over time', bucket.take(250));
  check('caps at burst', (() => { const b2 = makeTokenBucket(2, 4); b2.take(0); b2.take(0); return b2.take(100000) && b2.take(100000) && !b2.take(100000); })());
}

console.log('attribution');
{
  const t = setup();
  let calls = 0;
  const r = t.hub.createRecord(t.a);
  check('no hooks: hasHooks false', !t.hub.hasHooks());
  t.hub.register(r, () => { calls += 1; }, 'h');
  t.hub.land(r);
  check('a registration turns hasHooks on', t.hub.hasHooks());
  t.hub.attribute([rec(t.aInner)]);
  check('a change deep inside the anchor requests a frame', t.frames() === 1);
  t.hub.deliver(always, none);
  check('…and delivers once', calls === 1);
  t.hub.deliver(always, none);
  check('nothing dirty: no second call', calls === 1);
  t.hub.attribute([rec(t.b)]);
  t.hub.deliver(always, none);
  check('a sibling subtree change is not delivered', calls === 1);
  t.hub.attribute([rec(t.body)]);
  t.hub.deliver(always, none);
  check('a change on an ancestor of the anchor is not delivered', calls === 1);
  t.hub.attribute([rec(t.a)]);
  t.hub.deliver(always, none);
  check('a change on the anchor itself (its children) is delivered', calls === 2);
  const owned = node('owned', t.a, true);
  const inOwned = node('in-owned', owned);
  t.hub.attribute([rec(inOwned)]);
  t.hub.deliver(always, none);
  check('a change inside shim-owned DOM is never delivered', calls === 2);
  t.hub.attribute([rec(t.a, [owned])]);
  t.hub.deliver(always, none);
  check('adding/removing only shim-owned nodes is not delivered', calls === 2);
  t.hub.attribute([rec(t.a, [owned, node('site', null)])]);
  t.hub.deliver(always, none);
  check('a mixed add (site + owned) is delivered', calls === 3);
  t.hub.attribute([rec(t.aInner), rec(t.aInner), rec(t.a)]);
  t.hub.deliver(always, none);
  check('many records in one frame coalesce into one call', calls === 4);
}

console.log('html/body anchors are reachable');
{
  const t = setup();
  let htmlCalls = 0;
  const r = t.hub.createRecord(t.html);
  t.hub.register(r, () => { htmlCalls += 1; }, 'h');
  t.hub.land(r);
  t.hub.attribute([rec(t.aInner)]);
  t.hub.deliver(always, none);
  check('a change deep under body reaches an html-anchored hook', htmlCalls === 1);
}

console.log('nested anchors');
{
  const t = setup();
  let outer = 0; let inner = 0;
  const ro = t.hub.createRecord(t.a); t.hub.register(ro, () => { outer += 1; }, 'o'); t.hub.land(ro);
  const ri = t.hub.createRecord(t.aInner); t.hub.register(ri, () => { inner += 1; }, 'i'); t.hub.land(ri);
  t.hub.attribute([rec(t.aInner)]);
  t.hub.deliver(always, none);
  check('both the inner and the outer anchor get the change', outer === 1 && inner === 1);
}

console.log('mount-record lifecycle');
{
  const t = setup();
  let calls = 0;
  const r = t.hub.createRecord(t.a);
  t.hub.register(r, () => { calls += 1; }, 'h');
  t.hub.attribute([rec(t.aInner)]);
  t.hub.deliver(always, none);
  check('in flight: a change is held, not delivered', calls === 0);
  t.resetFrames();
  t.hub.land(r);
  check('landing a dirty record requests a frame', t.frames() === 1);
  t.hub.deliver(always, none);
  check('…and delivers once after landing', calls === 1);
  t.hub.kill(r);
  check('killed: no hooks left', !t.hub.hasHooks());
  t.hub.attribute([rec(t.aInner)]);
  t.hub.deliver(always, none);
  check('killed: never delivered again', calls === 1);
  const unsub = t.hub.register(r, () => { calls += 100; }, 'late');
  check('registering on a dead record is a no-op', !t.hub.hasHooks() && typeof unsub === 'function');
  // A re-mount on the same anchor is a fresh record.
  const r2 = t.hub.createRecord(t.a);
  t.hub.register(r2, () => { calls += 10; }, 'h');
  t.hub.land(r2);
  t.hub.attribute([rec(t.aInner)]);
  t.hub.deliver(always, none);
  check('a fresh record on the same anchor delivers to its own hooks only', calls === 11, calls);
}

console.log('eligibility (unverified / replaced / detached)');
{
  const t = setup();
  let calls = 0;
  const r = t.hub.createRecord(t.a);
  t.hub.register(r, () => { calls += 1; }, 'h');
  t.hub.land(r);
  t.hub.attribute([rec(t.aInner)]);
  t.hub.deliver(() => false, none);
  check('ineligible (e.g. unverified member): not delivered', calls === 0);
  t.hub.deliver(always, none);
  check('…the change is kept and delivered once eligible again', calls === 1);
}

console.log('unsubscribe + snapshot semantics');
{
  const t = setup();
  const order: string[] = [];
  const r = t.hub.createRecord(t.a);
  let unsubB: () => void = () => {};
  t.hub.register(r, () => { order.push('a'); unsubB(); }, 'h');
  unsubB = t.hub.register(r, () => { order.push('b'); }, 'h');
  t.hub.register(r, () => { order.push('c'); }, 'h');
  t.hub.land(r);
  t.hub.attribute([rec(t.aInner)]);
  t.hub.deliver(always, none);
  check('an unsubscribe during the batch takes effect for the next hook', order.join('') === 'ac', order);
  t.hub.attribute([rec(t.aInner)]);
  t.hub.deliver(always, none);
  check('…and stays off', order.join('') === 'acac', order);
}

console.log('errors');
{
  const t = setup();
  let after = 0;
  const r = t.hub.createRecord(t.a);
  t.hub.register(r, () => { throw new Error('boom'); }, 'thrower');
  t.hub.register(r, () => { after += 1; }, 'next');
  t.hub.land(r);
  t.hub.attribute([rec(t.aInner)]);
  t.hub.deliver(always, none);
  check('a throwing hook is reported with its handler name', t.errors.length === 1 && t.errors[0]?.handlerName === 'thrower');
  check('…and the next hook still runs', after === 1);
  t.hub.attribute([rec(t.aInner)]);
  t.hub.deliver(always, none);
  check('…and the thrower stays registered', t.errors.length === 2);
}

console.log('self-write suppression (the post-batch drain)');
{
  const t = setup();
  let calls = 0;
  const r = t.hub.createRecord(t.a);
  // The hook "writes" inside its anchor: the rule observer would queue a record.
  let queued: Array<ChangeRecordLike<FakeNode>> = [];
  const drain = () => { const q = queued; queued = []; return q; };
  t.hub.register(r, () => { calls += 1; queued.push(rec(t.aInner)); }, 'h');
  t.hub.land(r);
  t.hub.attribute([rec(t.aInner)]);
  t.resetFrames();
  t.hub.deliver(always, drain);
  check('delivered once', calls === 1);
  check('the hook\'s own write requests one more frame (a scan for self-healing)…', t.frames() === 1);
  t.hub.deliver(always, drain);
  check('…but is never delivered back to the hook', calls === 1);
  // Records already queued BEFORE the batch are attributed, not dropped.
  queued = [rec(t.aInner)];
  t.hub.deliver(always, drain);
  check('a change queued before the batch is still delivered', calls === 2);
}

console.log('async serialization');
void (async () => {
  {
    const t = setup();
    let calls = 0;
    let resolve: () => void = () => {};
    const r = t.hub.createRecord(t.a);
    t.hub.register(r, () => { calls += 1; return new Promise<void>((res) => { resolve = res; }); }, 'h');
    t.hub.land(r);
    t.hub.attribute([rec(t.aInner)]);
    t.hub.deliver(always, none);
    t.hub.attribute([rec(t.aInner)]);
    t.hub.deliver(always, none);
    check('busy: a change while the async hook is pending is not delivered yet', calls === 1);
    t.resetFrames();
    resolve();
    await new Promise((res) => setTimeout(res, 0));
    check('settling a dirty busy record requests a frame', t.frames() === 1);
    t.hub.deliver(always, none);
    check('…and the coalesced change is delivered once', calls === 2);
  }
  {
    const t = setup();
    const r = t.hub.createRecord(t.a);
    t.hub.register(r, () => Promise.reject('not an Error'), 'rej');
    t.hub.land(r);
    t.hub.attribute([rec(t.aInner)]);
    t.hub.deliver(always, none);
    await new Promise((res) => setTimeout(res, 0));
    check('a rejected promise (non-Error reason) is reported', t.errors.length === 1 && t.errors[0]?.err === 'not an Error');
  }
  {
    const t = setup();
    let resolve: () => void = () => {};
    const r = t.hub.createRecord(t.a);
    t.hub.register(r, () => new Promise<void>((res) => { resolve = res; }), 'h');
    t.hub.land(r);
    t.hub.attribute([rec(t.aInner)]);
    t.hub.deliver(always, none);
    t.hub.attribute([rec(t.aInner)]);
    t.hub.teardown();
    t.resetFrames();
    resolve();
    await new Promise((res) => setTimeout(res, 0));
    check('a settlement after teardown schedules nothing', t.frames() === 0);
  }

  console.log('token-bucket throttling');
  {
    const t = setup();
    let calls = 0;
    const r = t.hub.createRecord(t.a);
    t.hub.register(r, () => { calls += 1; }, 'h');
    t.hub.land(r);
    for (let i = 0; i < BUCKET_BURST + 5; i++) {
      t.hub.attribute([rec(t.aInner)]);
      t.hub.deliver(always, none);
    }
    check(`a burst delivers at most ${BUCKET_BURST} times at once`, calls === BUCKET_BURST, calls);
    check('the first throttle notifies once', t.throttles() === 1);
    check('a delivery timer is armed (one, at the earliest deadline)', t.timers.filter((x) => x.live).length === 1);
    t.resetFrames();
    t.advance(250);
    check('the timer requests a frame when a token refills', t.frames() === 1);
    t.hub.deliver(always, none);
    check('…and the last change is delivered late, not lost', calls === BUCKET_BURST + 1, calls);
    t.hub.attribute([rec(t.aInner)]);
    t.hub.deliver(always, none);
    t.hub.teardown();
    check('teardown cancels the delivery timer', t.timers.every((x) => !x.live));
  }

  console.log('cost: a rule with no registrations does no attribution');
  {
    const t = setup();
    let walked = 0;
    const deps: HubDeps<FakeNode> = {
      parentOf: (n) => { walked += 1; return n.parent; },
      isOwnedNode: () => false, now: () => 0, setTimer: () => () => {}, requestFrame: () => {},
      reportError: () => {}, onThrottle: () => {},
    };
    const hub = makeAnchorChangeHub(deps);
    hub.attribute([rec(t.aInner), rec(t.b)]);
    check('zero parent walks without a hook', walked === 0);
  }

  console.log('cost: chat-like load (1k records, depth 30, 500 hooked anchors)');
  {
    let now = 0;
    const deps: HubDeps<FakeNode> = {
      parentOf: (n) => n.parent, isOwnedNode: (n) => n.owned === true, now: () => now,
      setTimer: () => () => {}, requestFrame: () => {}, reportError: () => {}, onThrottle: () => {},
    };
    const hub = makeAnchorChangeHub(deps);
    let top: FakeNode = node('html', null);
    for (let d = 0; d < 28; d++) top = node(`d${d}`, top);
    const lines: FakeNode[] = [];
    for (let i = 0; i < 500; i++) {
      const line = node(`line${i}`, top);
      lines.push(line);
      const r = hub.createRecord(line);
      hub.register(r, () => {}, 'h');
      hub.land(r);
    }
    const records = Array.from({ length: 1000 }, (_, i) => rec(node(`t${i}`, lines[i % 500] ?? top)));
    const started = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) { hub.attribute(records); hub.deliver(always, none); now += 16; }
    const ms = Number(process.hrtime.bigint() - started) / 1e6 / 20;
    console.log(`    ${ms.toFixed(2)}ms per frame (attribute + deliver)`);
    check('well under a frame budget per pass', ms < 8, ms);
  }

  if (failures) { console.error(`\n${failures} anchor-change check(s) failed`); process.exit(1); }
  console.log('\n✓ all anchor-change checks passed');
})();
