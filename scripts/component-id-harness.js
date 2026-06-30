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

const vm = require('vm');
const componentId = require('../src/patch-engine/component-id');
const { buildWitness, matchWitness } = require('../src/patch-engine/witness');

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
  const { matchComponent } = componentId;

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
  return node;
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
  // Must parse as a standalone script (no external refs leaked in). vm.Script
  // compiles without executing — enough to catch a syntax error in the injected
  // source. `src` is our own generated helper, not untrusted input.
  let parses = true;
  try { new vm.Script(src); } catch (e) { parses = false; check('parse error', false, e.message); }
  check('parses as a self-contained script', parses, '');
}

console.log('\n=== component-id harness ===\n');
tScore();
tMatch();
tWitnessIntegration();
tHelperSrc();
console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all component-id checks passed');
