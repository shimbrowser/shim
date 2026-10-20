// Bounded witness enrichment. A witness is captured synchronously, then
// enriched with the element's framework component identity: the main-world
// bridge (api.componentId.verify) plus the deploy's symbol map
// (api.componentId.symbols). In the Shim browser the map waits on any
// in-flight Bundle Discovery run with no time limit, and the host reads a
// preview's events once, at its settle boundary — so a witness emitted after a
// slow Discovery was lost and the rule committed without one. The same
// unbounded call stalled the settle-time verify and component-recovery arms.
// Pins:
//   - readSymbols is three-state: ready / no-map / timed-out
//   - capture: a never-resolving symbols() still yields the witness inside the
//     preview window, without `component`; a slow bridge likewise; both quick
//     → component attached (mapped when the map renamed it)
//   - verify: a map that times out makes the component veto not applicable
//     (no quarantine); a map that answers still vetoes a mismatch
//   - recovery: a mapped component witness skips the component scan on a
//     timed-out map (never sends original names into a raw scan), and the DOM
//     witness scan still runs
//
//   node out/packages/core/test/witness-enrichment-harness.js

import { readSymbols, withinBudget, ENRICH_BUDGET_MS } from '../src/engine-internal';
import type { RuntimeSpec } from '../src/engine-internal';
import { enrichWitness } from '../src/witness-enrich';
import { makeReconciler } from '../src/rule-reconcile';
import { makeRuleState } from '../src/rule-state';
import type { CoreApi } from '../src/api';
import type { ComponentDescriptor, Rule, Witness } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// The Shim browser's and the headless host's preview read boundary.
const PREVIEW_WINDOW_MS = 2000;

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const after = <T>(ms: number, v: T): Promise<T> => new Promise<T>((r) => setTimeout(() => r(v), ms));

const cid = (path: string[], extra: Partial<ComponentDescriptor> = {}): ComponentDescriptor => ({ v: 1, path, propKeys: [], ...extra });

interface CidImpl {
  verify?: () => Promise<ComponentDescriptor | null>;
  find?: (expected: unknown) => Promise<Element[]>;
  symbols?: () => Promise<Record<string, string> | null>;
}
function makeApi(impl: CidImpl, events: Array<{ kind: string; payload: Record<string, unknown> }> = []): CoreApi {
  return {
    origin: 'https://example.com',
    host: 'example.com',
    patchId: 's',
    bridge: { forwardRule() {} },
    componentId: {
      verify: impl.verify ?? (() => Promise.resolve(null)),
      find: impl.find ?? (() => Promise.resolve([])),
      symbols: impl.symbols ?? (() => Promise.resolve(null)),
    },
    reportEvent(kind: string, payload: Record<string, unknown> = {}) { events.push({ kind, payload }); },
    onReady() {},
  };
}

const stubEl = (): Element => ({ tagName: 'DIV', attributes: [], children: [], parentElement: null, getAttribute: () => null, textContent: '' }) as unknown as Element;
const baseWitness = (): Witness => ({ v: 1, tag: 'div', attrs: { 'data-x': 'y' } });

async function tReadSymbols(): Promise<void> {
  console.log('readSymbols (three-state):');
  check('a map → ready', (await readSymbols(makeApi({ symbols: () => Promise.resolve({ Wc: 'TrackRow' }) }), 50)).state === 'ready');
  check('null → no-map', (await readSymbols(makeApi({ symbols: () => Promise.resolve(null) }), 50)).state === 'no-map');
  check('a throwing host → no-map, never throws', (await readSymbols(makeApi({ symbols: () => Promise.reject(new Error('x')) }), 50)).state === 'no-map');
  const t0 = Date.now();
  const slow = await readSymbols(makeApi({ symbols: never }), 60);
  check('a never-resolving host → timed-out at the budget', slow.state === 'timed-out' && Date.now() - t0 < 500, `${slow.state} after ${Date.now() - t0}ms`);
  const noBridge = { ...makeApi({}), componentId: undefined } as unknown as CoreApi;
  check('no bridge at all → no-map', (await readSymbols(noBridge, 50)).state === 'no-map');
  const late = await withinBudget(after(80, 1), 20);
  check('withinBudget: late value reads as not done', late.done === false);
  check('the default budget leaves the witness half the preview window', ENRICH_BUDGET_MS * 2 <= PREVIEW_WINDOW_MS, String(ENRICH_BUDGET_MS));
}

async function tCapture(): Promise<void> {
  console.log('capture enrichment:');
  {
    const t0 = Date.now();
    const w = await enrichWitness(stubEl(), baseWitness(), makeApi({
      verify: () => Promise.resolve(cid(['Wc'])),
      symbols: never,
    }));
    const took = Date.now() - t0;
    check('never-resolving symbols(): the witness lands inside the preview window', took < PREVIEW_WINDOW_MS, `${took}ms`);
    check('…without component', w.component === undefined, JSON.stringify(w.component));
    check('…and keeps its DOM signals', w.tag === 'div' && w.attrs?.['data-x'] === 'y');
  }
  {
    const t0 = Date.now();
    const w = await enrichWitness(stubEl(), baseWitness(), makeApi({
      verify: never,
      symbols: () => Promise.resolve({ Wc: 'TrackRow' }),
    }));
    check('a bridge that never answers: witness inside the window, no component', Date.now() - t0 < PREVIEW_WINDOW_MS && w.component === undefined);
  }
  {
    const w = await enrichWitness(stubEl(), baseWitness(), makeApi({
      verify: () => after(30, cid(['Wc'])),
      symbols: () => after(30, { Wc: 'TrackRow' }),
    }));
    check('both answer in time → component in original-name space, marked mapped',
      w.component?.path[0] === 'TrackRow' && w.component.mapped === true, JSON.stringify(w.component));
  }
  {
    const w = await enrichWitness(stubEl(), baseWitness(), makeApi({
      verify: () => Promise.resolve(cid(['TrackRow'])),
      symbols: () => Promise.resolve(null),
    }));
    check('no map → raw names, unmarked', w.component?.path[0] === 'TrackRow' && !w.component.mapped, JSON.stringify(w.component));
  }
  {
    const noVerify = { ...makeApi({}), componentId: { symbols: never } } as unknown as CoreApi;
    const t0 = Date.now();
    const w = await enrichWitness(stubEl(), baseWitness(), noVerify);
    check('no verify member → immediate, unenriched', Date.now() - t0 < 50 && w.component === undefined);
  }
}

// A primary-resolved rule whose committed component witness is mapped, and a
// live fiber that confidently mismatches it.
function runVerify(symbols: () => Promise<Record<string, string> | null>): Promise<string[]> {
  return new Promise((resolve) => {
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const api = makeApi({ verify: () => Promise.resolve(cid(['Ad'])), symbols }, events);
    const rule: Rule = {
      id: 'r',
      anchor: { primary: { kind: 'css', value: '.row' }, witness: { ...baseWitness(), component: cid(['TrackRow'], { mapped: true }) } },
      mutations: [{ kind: 'hide' }],
    };
    const spec = { id: 's', rules: [rule], bundleHash: 'h1', __bundleHashFn: () => 'h1' } as RuntimeSpec;
    const rs = makeRuleState();
    const el = stubEl();
    rs.state.set(el, { outputs: [], cleanups: [] });
    rs.matchedSource = 'primary';
    rs.resolvedEl = el;
    rs.verifiedCount = 1;
    const r = makeReconciler(rule, spec, api, rs, new Set());
    r.start();
    setTimeout(() => { r.stop(); resolve(events.map((e) => e.kind)); }, 1500 + ENRICH_BUDGET_MS + 600);
  });
}

// A deploy killed the selector; the rule carries a mapped component witness.
function runRecovery(symbols: () => Promise<Record<string, string> | null>): Promise<{ events: Array<{ kind: string; payload: Record<string, unknown> }>; findCalls: number }> {
  return new Promise((resolve) => {
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    let findCalls = 0;
    const api = makeApi({
      symbols,
      find: () => { findCalls++; return Promise.resolve([]); },
    }, events);
    (globalThis as unknown as { document: unknown }).document = { getElementsByTagName: (): unknown[] => [] };
    const rule: Rule = {
      id: 'r',
      anchor: { primary: { kind: 'css', value: '.row' }, witness: { ...baseWitness(), component: cid(['TrackRow'], { mapped: true }) } },
      mutations: [{ kind: 'hide' }],
    };
    const spec = { id: 's', rules: [rule], bundleHash: 'old', __bundleHashFn: () => 'new' } as RuntimeSpec;
    const r = makeReconciler(rule, spec, api, makeRuleState(), new Set());
    r.start();
    // settle + budget, retry + budget, plus slack
    setTimeout(() => { r.stop(); resolve({ events, findCalls }); }, 1500 + 2500 + 2 * ENRICH_BUDGET_MS + 800);
  });
}

async function tReconcile(): Promise<void> {
  console.log('settle-time verify + recovery:');
  const [timedOut, answered, rec, recMapped] = await Promise.all([
    runVerify(never),
    runVerify(() => Promise.resolve({ Wc: 'TrackRow' })),
    runRecovery(never),
    runRecovery(() => Promise.resolve({ Wc: 'TrackRow' })),
  ]);
  check('verify: a timed-out map never vetoes (no quarantine)', !timedOut.includes('rule-quarantined'), JSON.stringify(timedOut));
  check('verify: an answered map still vetoes the mismatch', answered.includes('rule-quarantined'), JSON.stringify(answered));
  const q = rec.events.find((e) => e.kind === 'rule-quarantined');
  const recovery = typeof q?.payload.recovery === 'string' ? q.payload.recovery : '';
  check('recovery: a mapped witness on a timed-out map never runs the component scan', rec.findCalls === 0, String(rec.findCalls));
  check('recovery: the skip is recorded', /component-id: skipped/.test(recovery), recovery);
  check('recovery: DOM witness recovery still runs', /witness-scan:/.test(recovery), recovery);
  check('recovery: an answered map runs the component scan', recMapped.findCalls > 0, String(recMapped.findCalls));
}

void (async () => {
  console.log('\n=== witness-enrichment harness ===\n');
  await tReadSymbols();
  await tCapture();
  await tReconcile();
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall witness-enrichment checks passed');
})();
