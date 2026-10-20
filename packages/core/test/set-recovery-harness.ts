// Identity-predicate recovery for set-witnessed rules (set-witness.ts
// recoverSetByIdentity, wired in rule-reconcile.ts), over before/after
// "deploy" fixtures. The selector dies on the new build; the predicate (tag +
// constant site data-*) is queried completely and the result accepted only
// when every element scores ≥0.75 on the set witness, nesting matches what
// was captured, and the count stays in band. Pins:
//   - class rename with data-* intact → recovers (rule-rebase via
//     set-identity, the predicate as the new primary, the old rungs as
//     fallbacks, the set witness kept)
//   - data-* renamed → escalates (quarantine)
//   - over-band flood → refuses
//   - lone match of a set of ≥3 → refuses
//   - a set of 2 → 1 recovers (the hidden-duplicate case)
//   - nesting the capture didn't have → refuses
//   - organic/sponsored: no predicate stored at capture → no recovery
//   - conflicted rule → no recovery
//   - auto-repair off → no recovery
//
//   node out/packages/core/test/set-recovery-harness.js

import { buildSetWitness, snapshotMember, identityPredicateFor, recoverSetByIdentity } from '../src/set-witness';
import { makeReconciler } from '../src/rule-reconcile';
import { makeRuleState } from '../src/rule-state';
import type { RuntimeSpec } from '../src/engine-internal';
import type { CoreApi } from '../src/api';
import type { Anchor, Rule, SetWitness } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail: unknown = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}

interface StubEl { nodeType: 1; tagName: string; attributes: Array<{ name: string; value: string }>; children: StubEl[]; childNodes: StubEl[]; parentElement: StubEl | null; getAttribute(n: string): string | null }
function h(tag: string, attrs: Record<string, string> = {}, kids: StubEl[] = []): StubEl {
  const e: StubEl = {
    nodeType: 1, tagName: tag.toUpperCase(), attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    children: [], childNodes: [], parentElement: null,
    getAttribute(n: string) { const a = this.attributes.find((x) => x.name === n); return a ? a.value : null; },
  };
  for (const k of kids) { k.parentElement = e; e.children.push(k); e.childNodes.push(k); }
  return e;
}
const el = (e: StubEl): Element => e as unknown as Element;
function grid(tiles: StubEl[]): StubEl[] { const g = h('div', { class: 's-main-slot' }); for (const t of tiles) { t.parentElement = g; g.children.push(t); } return tiles; }
const tile = (i: number, cls = 'old-tile', type = 's-search-result') =>
  h('div', { 'data-component-type': type, 'data-asin': `B0${i}`, class: `${cls} x${i}` }, [h('span'), h('a')]);

function capture(members: StubEl[]): SetWitness {
  const r = buildSetWitness(members.map((m) => snapshotMember(el(m))), { nested: false });
  if (!r.ok) throw new Error(r.reason);
  const sw = r.setWitness;
  const id = identityPredicateFor(sw);
  if (id) sw.identity = id;
  return sw;
}

// The reconciler on the new build: the authored selector matches nothing.
function reconcileAfterDeploy(anchor: Anchor, page: Record<string, StubEl[]>, opts: { autoRepair?: boolean } = {}): Promise<Array<{ kind: string; payload: Record<string, unknown> }>> {
  return new Promise((resolve) => {
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    (globalThis as unknown as { document: unknown }).document = {
      querySelectorAll: (sel: string) => page[sel] ?? [],
      getElementsByTagName: () => [],
    };
    const api = {
      origin: 'x', host: 'x', patchId: 's', bridge: { forwardRule() {} },
      componentId: { verify: () => Promise.resolve(null), find: () => Promise.resolve([]), symbols: () => Promise.resolve(null) },
      reportEvent(kind: string, payload: Record<string, unknown> = {}) { events.push({ kind, payload }); },
      onReady() {},
    } as CoreApi;
    const rule: Rule = { id: 'tiles', anchor, mutations: [{ kind: 'hide' }] };
    const spec = { id: 's', rules: [rule], bundleHash: 'b1', __bundleHashFn: () => 'b2', ...(opts.autoRepair === false ? { autoRepair: false } : {}) } as RuntimeSpec;
    const r = makeReconciler(rule, spec, api, makeRuleState(), new Set());
    r.start();
    setTimeout(() => { r.stop(); resolve(events); }, 4600);
  });
}

const before = grid(Array.from({ length: 6 }, (_, i) => tile(i)));
const sw = capture(before);
const PRED = 'div[data-component-type="s-search-result"]';
const anchorOf = (extra: Partial<Anchor> = {}): Anchor => ({ primary: { kind: 'css', value: '.old-tile' }, fallbacks: [{ kind: 'css', value: '.s-main-slot > div' }], setWitness: sw, cardinality: 'many', ...extra });

function tPure(): void {
  console.log('recoverSetByIdentity (pure):');
  check('the capture stored the identity predicate', sw.identity === PRED, sw.identity);
  const renamed = grid(Array.from({ length: 6 }, (_, i) => tile(i, 'new-tile')));
  const ok = recoverSetByIdentity(sw, (s) => (s === PRED ? renamed.map(el) : []));
  check('class rename, data-* intact → recovers all six', ok.ok && ok.nodes.length === 6, ok);
  const flood = grid(Array.from({ length: 60 }, (_, i) => tile(i, 'new-tile')));
  const f = recoverSetByIdentity(sw, () => flood.map(el));
  check('over the band (60 > max(24, 56)) → refused', !f.ok && /over the band/.test(f.reason), f);
  const lone = recoverSetByIdentity(sw, () => [el(tile(1, 'new'))]);
  check('a lone match of a set of 6 → refused', !lone.ok && /needs ≥2/.test(lone.reason), lone);
  const weak = grid([tile(1, 'n'), h('div', { 'data-component-type': 's-search-result' }, [h('p')])]);
  const w = recoverSetByIdentity(sw, () => weak.map(el));
  check('a member that scores < 0.75 → refused', !w.ok && /scored/.test(w.reason), w);
  const outer = tile(1, 'n'); const inner = tile(2, 'n'); outer.children.push(inner); inner.parentElement = outer;
  const nested = recoverSetByIdentity(sw, () => [el(outer), el(inner)]);
  check('nesting the capture didn\'t have → refused', !nested.ok && /nested/.test(nested.reason), nested);
  const pair = capture(grid([h('div', { 'data-feature-name': 'corePrice' }, [h('span')]), h('div', { 'data-feature-name': 'corePrice' }, [h('span')])]));
  const one = recoverSetByIdentity(pair, () => [el(h('div', { 'data-feature-name': 'corePrice', class: 'v2' }, [h('span')]))]);
  check('a set of 2 → 1 recovers (hidden duplicate)', one.ok && one.nodes.length === 1, one);
  const organic = capture(grid([h('div', { class: 'organic', 'data-kind': 'product' }, [h('span')]), h('div', { class: 'organic', 'data-kind': 'product' }, [h('span')]), h('div', { class: 'organic', 'data-kind': 'product' }, [h('span')])]));
  delete organic.identity; // the capture's equivalence check refused it (sponsored tiles share the data-*)
  const o = recoverSetByIdentity(organic, () => []);
  check('no stored predicate (organic/sponsored) → no recovery, never a broadened query', !o.ok && /no identity predicate/.test(o.reason), o);
}

async function tReconcile(): Promise<void> {
  console.log('through the reconciler:');
  const renamed = grid(Array.from({ length: 6 }, (_, i) => tile(i, 'new-tile')));
  const dataRenamed = grid(Array.from({ length: 6 }, (_, i) => tile(i, 'new-tile', 'search-card')));
  // One at a time: each run swaps the global document stub.
  const rec = await reconcileAfterDeploy(anchorOf(), { [PRED]: renamed });
  const esc = await reconcileAfterDeploy(anchorOf(), { [PRED]: [], 'div[data-component-type="search-card"]': dataRenamed });
  const conflicted = await reconcileAfterDeploy(anchorOf({ witness: { v: 1, tag: 'div' } }), { [PRED]: renamed });
  const off = await reconcileAfterDeploy(anchorOf(), { [PRED]: renamed }, { autoRepair: false });
  const rebase = rec.find((e) => e.kind === 'rule-rebase')?.payload;
  const a = rebase?.anchor as Anchor | undefined;
  check('class rename → rule-rebase recover via set-identity', rebase?.strategy === 'recover' && rebase.via === 'set-identity', rebase);
  check('…with the predicate as the primary and the dead rungs as fallbacks', a?.primary.value === PRED
    && (a.fallbacks || [])[0]?.value === '.old-tile' && (a.fallbacks || []).some((f) => f.value === '.s-main-slot > div'), a);
  check('…keeping the set witness (never refreshed) and the authored cardinality', a?.setWitness === sw && a.cardinality === 'many' && !a.witness, a);
  const q = esc.find((e) => e.kind === 'rule-quarantined')?.payload;
  check('data-* renamed → escalates to the banner (quarantine, fingerprint set)', !esc.some((e) => e.kind === 'rule-rebase') && q?.fingerprint === 'set', esc.map((e) => e.kind));
  check('…recording why recovery refused', typeof q?.recovery === 'string' && /set-identity: identity predicate found 0/.test(q.recovery as string), q?.recovery);
  check('a conflicted rule never recovers', !conflicted.some((e) => e.kind === 'rule-rebase') && conflicted.some((e) => e.kind === 'rule-quarantined'), conflicted.map((e) => e.kind));
  check('auto-repair off → no recovery, the break surfaces', !off.some((e) => e.kind === 'rule-rebase') && off.some((e) => e.kind === 'rule-quarantined'), off.map((e) => e.kind));
}

void (async () => {
  console.log('\n=== set-recovery harness ===\n');
  tPure();
  await tReconcile();
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall set-recovery checks passed');
})();
