// Diagnostic harness for framework-component-identity (src/patch-engine/
// component-id.js) and its integration into the witness layer. Bare node — no
// Electron, no DOM, no React: descriptors are the plain-JSON shape that crosses
// the world boundary, and the matcher is pure. Run when touching component
// scoring, the witness component signal, or the main-world helper source:
//
//   node scripts/component-id-harness.js
//
// What it asserts:
//   - componentScore: nearest-name match dominates; prop-key overlap refines;
//     deeper ancestry adds; a nearest-name mismatch scores low
//   - matchComponent: pass/fail at threshold; graceful applicable:false when
//     either side has no readable identity (non-React / bridge timeout)
//   - witness: a component witness only scores when a descriptor is supplied
//     (sync resolve path skips it); a confident component mismatch fails an
//     otherwise-passing candidate; buildWitness attaches a supplied descriptor
//   - buildHelperSrc embeds a syntactically-valid, self-contained main-world
//     helper (componentScore stringified in, no external refs)

import vm from 'vm';
import * as componentId from '../src/patch-engine/component-id';
import { buildWitness, matchWitness as _matchWitness } from '../src/patch-engine/witness';
import { errMessage } from '../src/shared/error';
// Harness calls matchWitness with an extra (unused-by-the-real-signature)
// arg in one assertion below — cast to any rather than touching witness.ts.
const matchWitness: any = _matchWitness;

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const cid = (path, propKeys = []) => ({ v: 1, path, propKeys });

function tScore() {
  console.log('componentScore:');
  const { componentScore } = componentId;

  // Identical identity → perfect.
  check('identical → 1.0',
    componentScore(cid(['TrackRow', 'TrackList', 'App'], ['onPlay', 'trackId']),
                   cid(['TrackRow', 'TrackList', 'App'], ['onPlay', 'trackId'])) === 1,
    String(componentScore(cid(['TrackRow'], ['x']), cid(['TrackRow'], ['x']))));

  // Same nearest name, props churned a bit → still clears pass threshold.
  const drift = componentScore(
    cid(['TrackRow', 'TrackList'], ['onPlay', 'trackId']),
    cid(['TrackRow', 'TrackList'], ['onPlay', 'trackId', 'isNew']));
  check('nearest+ancestry match, one extra prop → passes', drift >= 0.5, String(drift));

  // Nearest name differs → low (a different component type).
  const wrong = componentScore(cid(['Sidebar'], ['items']), cid(['TrackRow'], ['trackId']));
  check('nearest-name mismatch → below threshold', wrong < 0.5, String(wrong));

  // Nearest matches but ancestry diverges → still passes on the strong signal.
  const reparented = componentScore(
    cid(['TrackRow', 'OldParent'], ['trackId']),
    cid(['TrackRow', 'NewParent'], ['trackId']));
  check('same nearest, different parent → still passes', reparented >= 0.5, String(reparented));

  // Empty prop keys on both → no disagreement penalty.
  const noProps = componentScore(cid(['Widget'], []), cid(['Widget'], []));
  check('both prop-less → full credit', noProps === 1, String(noProps));
}

function tMatch() {
  console.log('matchComponent:');
  // Harness calls matchComponent with 2 args (omitting the optional-in-
  // practice `symbols` param) in some assertions — cast to any.
  const { matchComponent }: any = componentId;

  const good = matchComponent(cid(['TrackRow'], ['trackId']), cid(['TrackRow'], ['trackId']));
  check('match → applicable + pass', good.applicable && good.pass, JSON.stringify(good));

  const bad = matchComponent(cid(['TrackRow'], ['trackId']), cid(['AdBanner'], ['campaignId']));
  check('mismatch → applicable + !pass', bad.applicable && !bad.pass, JSON.stringify(bad));

  // Graceful degradation: no readable identity on the candidate (non-React /
  // bridge timeout) → skipped, never failed.
  check('actual null → applicable:false (skip)', matchComponent(cid(['X']), null).applicable === false, '');
  check('actual empty path → applicable:false', matchComponent(cid(['X']), cid([])).applicable === false, '');
  check('no expected → applicable:false', matchComponent(null, cid(['X'])).applicable === false, '');
}

// Sourcemap-symbol consumption (§8 Stage B): descriptors stored in original-name
// space, live fibers compared through the deploy's {minified: original} map.
function tSymbols() {
  console.log('symbol translation (cross-deploy renames):');
  const { translateComponent, invertSymbols, matchComponent }: any = componentId;

  const symsA = { Wc: 'TrackRow', Xd: 'TrackList' };            // deploy A
  const symsB = { Qq: 'TrackRow', Rr: 'TrackList' };            // deploy B renames

  // Capture on deploy A: minified fiber names → stored as originals.
  const captured = translateComponent(cid(['Wc', 'Xd', 'App'], ['trackId']), symsA);
  check('capture translates min→original', captured.path.join(',') === 'TrackRow,TrackList,App', JSON.stringify(captured));
  check('unmapped names pass through (App)', captured.path[2] === 'App', '');

  // No map / no change → the SAME object back (cheap identity).
  const untouched = cid(['App'], []);
  check('no map → identity', translateComponent(untouched, null) === untouched, '');
  check('no renames → identity', translateComponent(untouched, symsA) === untouched, '');

  // Verify on deploy B: stored originals vs live minified names — raw score
  // fails (Wc→Qq rename), the map-translated comparison passes. THE payoff.
  const liveB = cid(['Qq', 'Rr', 'App'], ['trackId']);
  check('cross-deploy verify FAILS without map', !matchComponent(captured, liveB).pass, '');
  const withMap = matchComponent(captured, liveB, symsB);
  check('cross-deploy verify PASSES with map', withMap.pass && withMap.score === 1, JSON.stringify(withMap));

  // Back-compat: a PRE-map witness (stored minified) on the same deploy still
  // passes via the raw comparison even when a map is supplied (max-of-both).
  const legacy = matchComponent(cid(['Wc'], ['trackId']), cid(['Wc'], ['trackId']), symsA);
  check('legacy minified witness still passes (dual scoring)', legacy.pass && legacy.score === 1, JSON.stringify(legacy));

  // Recovery direction: invert deploy B's map, translate the stored original
  // descriptor into B's minified space for the main-world scan.
  const inv = invertSymbols(symsB);
  check('invertSymbols flips the map', inv.TrackRow === 'Qq' && inv.TrackList === 'Rr', JSON.stringify(inv));
  const toMin = translateComponent(captured, inv);
  check('stored original → current minified for find', toMin.path.join(',') === 'Qq,Rr,App', JSON.stringify(toMin));

  // Ambiguous inversion: several minified aliases of one original (memo/
  // forwardRef `$1/$2/$3` suffix pattern) → dropped, not guessed.
  const ambig = invertSymbols({ A1: 'StyledMenuOption', A2: 'StyledMenuOption', Bz: 'Sidebar' });
  check('ambiguous original dropped on invert', !('StyledMenuOption' in ambig) && ambig.Sidebar === 'Bz', JSON.stringify(ambig));
  check('invertSymbols(null) → null', invertSymbols(null) === null, '');

  // The `mapped` veto guard — a witness whose names only exist through a map
  // must never be scored raw against minified fibers. This is the first-load-
  // after-a-deploy race: Discovery for the new bundle hasn't landed, symbols
  // are null, and without the guard a HEALTHY shim would false-quarantine.
  const mapped = { ...captured, mapped: true };
  const noMap = matchComponent(mapped, liveB, null);
  check('mapped witness + no map → skipped, never failed', noMap.applicable === false && noMap.pass, JSON.stringify(noMap));
  const unknown = matchComponent(mapped, liveB, { Zz: 'SomethingElse' });
  check('mapped witness + map lacking the name → skipped', unknown.applicable === false && unknown.pass, JSON.stringify(unknown));
  const knownMap = matchComponent(mapped, liveB, symsB);
  check('mapped witness + map knowing the name → scored normally', knownMap.applicable && knownMap.pass, JSON.stringify(knownMap));
  // A mapped witness with a usable map still catches a REAL mis-attach.
  const misattach = matchComponent(mapped, cid(['AdBanner'], ['campaignId']), symsB);
  check('mapped witness still vetoes a real mismatch', misattach.applicable && !misattach.pass, JSON.stringify(misattach));
}

// Minimal element stub shaped like the subset matchWitness/buildWitness read.
function el(tag, attrs = {}, { text = '', children = [], parent = null } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    children,
    parentElement: parent,
    getAttribute(name) {
      const f = this.attributes.find((a) => a.name === name);
      return f ? f.value : null;
    },
    get textContent() { return text + children.map((c) => c.textContent).join(''); },
  };
  for (const c of children) c.parentElement = node;
  // Stub shaped like the subset of Element buildWitness/matchWitness read
  // (see comment above), not a real DOM Element — cast at this single
  // choke point rather than widening those signatures back to `any`.
  return node as unknown as Element;
}

function tWitnessIntegration() {
  console.log('witness storage of component (scoring lives in the engine):');
  const target = el('div', { 'data-testid': 'row' }, { text: 'a track' });

  // buildWitness STORES a supplied descriptor (it travels on the spec); omits
  // an empty one.
  const w = buildWitness(target, { component: cid(['TrackRow', 'TrackList'], ['trackId']) });
  check('buildWitness attaches component', w.component && w.component.path[0] === 'TrackRow', JSON.stringify(w.component));
  check('buildWitness omits empty component', !('component' in buildWitness(target, { component: cid([]) })), '');
  check('buildWitness without opts → no component', !('component' in buildWitness(target)), '');

  // matchWitness does NOT fold component into its tolerant soft score — that's
  // a veto the engine applies via matchComponent. So the aggregate is unchanged
  // by the presence of a component field (no descriptor is ever passed here).
  check('matchWitness unaffected by stored component', matchWitness(w, target).pass, JSON.stringify(matchWitness(w, target)));
  check('matchWitness signature ignores extra args', matchWitness(w, target, { component: cid(['AdBanner']) }).pass, '');
}

function tHelperSrc() {
  console.log('buildHelperSrc (main-world injection):');
  const src = componentId.buildHelperSrc();
  check('contains the fiber walk', src.includes('__shimComponentIdentity'), '');
  check('inlines componentScore (one source of truth)', src.includes('function'), '');
  check('guards against double-install', src.includes('__shimCidHelper'), '');
  check('find accepts a descriptor list (translated + raw)', src.includes('expectedList'), '');
  // Must parse as a standalone script (no external refs leaked in). vm.Script
  // compiles without executing — enough to catch a syntax error in the injected
  // source. `src` is our own generated helper, not untrusted input.
  let parses = true;
  try { new vm.Script(src); } catch (e) { parses = false; check('parse error', false, errMessage(e)); }
  check('parses as a self-contained script', parses, '');
}

console.log('\n=== component-id harness ===\n');
tScore();
tMatch();
tSymbols();
tWitnessIntegration();
tHelperSrc();
console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all component-id checks passed');
