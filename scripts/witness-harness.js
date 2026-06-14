// Diagnostic harness for the witness layer (src/patch-engine/witness.js
// + the witness filtering in src/patch-engine/anchors.js). Bare node —
// no Electron, no DOM: elements are stubs shaped like the subset of the
// Element interface the witness code reads (tagName, attributes,
// textContent, children, parentElement, getAttribute). Run when touching
// witness scoring, capture, or ladder fall-through:
//
//   node scripts/witness-harness.js
//
// What it asserts:
//   - buildWitness captures stable attrs only (no class, no data-shim-*)
//   - matchWitness tolerance: text drift, class churn, child add — pass;
//     tag swap, attr loss + text change — fail
//   - resolveAllWithSource: witness filters impostors, falls through to
//     a fallback whose match passes, reports witnessRejected when
//     nothing survives
//   - unknown witness versions never quarantine

const { buildWitness, matchWitness, WITNESS_VERSION } = require('../src/patch-engine/witness');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// Minimal element stub. attrs is a plain object; children an array of
// stubs; parent wired by caller.
function el(tag, attrs = {}, { text = '', children = [], parent = null } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    children,
    parentElement: parent,
    getAttribute(name) {
      const found = this.attributes.find((a) => a.name === name);
      return found ? found.value : null;
    },
    get textContent() {
      return text + children.map((c) => c.textContent).join('');
    },
  };
  for (const c of children) c.parentElement = node;
  return node;
}

function tBuild() {
  console.log('buildWitness:');
  const parent = el('section');
  const target = el('button', {
    id: 'fav-btn',
    class: 'btn btn-primary tw-rounded',
    'data-testid': 'favorite',
    'data-shim-css': 'shim-x-y-hide',
    'aria-label': 'favorite this track',
  }, { text: 'Favorite', children: [el('svg')], parent });

  const w = buildWitness(target);
  check('captures tag', w.tag === 'button', JSON.stringify(w));
  check('captures id + data-* + aria-label', w.attrs.id === 'fav-btn' && w.attrs['data-testid'] === 'favorite' && w.attrs['aria-label'] === 'favorite this track', JSON.stringify(w.attrs));
  check('excludes class', !('class' in (w.attrs || {})), '');
  check('excludes data-shim-* (engine-stamped tokens)', !('data-shim-css' in (w.attrs || {})), '');
  check('captures text stem lowercased', w.textStem === 'favorite', JSON.stringify(w.textStem));
  check('captures child shape + parent tag', w.childTags.join() === 'svg' && w.parentTag === 'section', '');
  check('stamps version', w.v === WITNESS_VERSION, '');
}

function tMatchTolerance() {
  console.log('matchWitness tolerance (site churn should pass):');
  const parent = el('section');
  const original = el('button', { id: 'fav-btn', 'data-testid': 'favorite' }, { text: 'Favorite', parent });
  const w = buildWitness(original);

  // Deploy churn: class list changed (not captured), text gained a count
  // suffix, same identity attrs.
  const redeployed = el('button', { id: 'fav-btn', 'data-testid': 'favorite', class: 'tw-x9q' }, { text: 'Favorite (3)', parent: el('section') });
  check('text suffix + class churn passes', matchWitness(w, redeployed).pass, JSON.stringify(matchWitness(w, redeployed)));

  // One attr lost but the other + text intact.
  const attrLost = el('button', { 'data-testid': 'favorite' }, { text: 'Favorite', parent: el('section') });
  check('one lost attr still passes on remaining signals', matchWitness(w, attrLost).pass, JSON.stringify(matchWitness(w, attrLost)));
}

function tMatchRejection() {
  console.log('matchWitness rejection (different element should fail):');
  const original = el('button', { id: 'fav-btn', 'data-testid': 'favorite' }, { text: 'Favorite', parent: el('section') });
  const w = buildWitness(original);

  const tagSwap = el('a', { id: 'fav-btn', 'data-testid': 'favorite' }, { text: 'Favorite' });
  const v1 = matchWitness(w, tagSwap);
  check('tag swap is a hard fail', !v1.pass && /tag mismatch/.test(v1.detail[0]), JSON.stringify(v1));

  // Same tag, but it's a different button: no identity attrs, different label.
  const impostor = el('button', { 'data-testid': 'subscribe' }, { text: 'Subscribe now', parent: el('nav') });
  const v2 = matchWitness(w, impostor);
  check('impostor button fails with diff detail', !v2.pass && v2.detail.length >= 2, JSON.stringify(v2));

  const future = { v: WITNESS_VERSION + 1, tag: 'div' };
  check('unknown witness version passes (never quarantine on shape we cannot read)', matchWitness(future, impostor).pass, '');
}

function tLadder() {
  console.log('anchors ladder with witness filtering:');
  // Stub document root supporting querySelectorAll over a tiny fixed set.
  const parent = el('section');
  const realTarget = el('button', { id: 'fav-btn', 'data-testid': 'favorite' }, { text: 'Favorite', parent });
  const impostor = el('button', { 'data-testid': 'promo' }, { text: 'Subscribe', parent: el('nav') });
  const w = buildWitness(realTarget);

  const makeRoot = (bySelector) => ({
    querySelectorAll(sel) {
      if (!(sel in bySelector)) return [];
      return bySelector[sel];
    },
    getElementsByTagName() { return []; },
  });

  const anchors = require('../src/patch-engine/anchors');

  // Case 1: primary resolves the impostor; fallback resolves the real
  // target — witness filters the impostor, ladder falls through.
  const anchor1 = {
    primary: { kind: 'css', value: '.old-fav' },
    fallbacks: [{ kind: 'css', value: '[data-testid="favorite"]' }],
    witness: w,
  };
  const r1 = anchors.resolveAllWithSource(anchor1, makeRoot({
    '.old-fav': [impostor],
    '[data-testid="favorite"]': [realTarget],
  }));
  check('impostor on primary falls through to fallback', r1.source === 'fallback:0' && r1.nodes[0] === realTarget, JSON.stringify({ source: r1.source }));

  // Case 2: primary resolves both impostor AND target — witness picks
  // the target out of the match set, stays on primary.
  const anchor2 = { primary: { kind: 'css', value: 'button' }, witness: w };
  const r2 = anchors.resolveAllWithSource(anchor2, makeRoot({ button: [impostor, realTarget] }));
  check('witness filters multi-match down to the real target on primary', r2.source === 'primary' && r2.nodes.length === 1 && r2.nodes[0] === realTarget, JSON.stringify({ source: r2.source, n: r2.nodes.length }));

  // Case 3: every rung resolves only impostors → witnessRejected with a
  // sample diff (the quarantine signal).
  const r3 = anchors.resolveAllWithSource(anchor1, makeRoot({
    '.old-fav': [impostor],
    '[data-testid="favorite"]': [impostor],
  }));
  check('all-impostor resolution reports witnessRejected', r3.nodes.length === 0 && r3.witnessRejected === true && !!r3.rejectedSample, JSON.stringify({ rejected: r3.witnessRejected }));

  // Case 4: selector resolves nothing anywhere → plain no-match, NOT
  // witnessRejected (different signal, different event).
  const r4 = anchors.resolveAllWithSource(anchor1, makeRoot({}));
  check('dead selectors are no-match, not quarantine', r4.nodes.length === 0 && r4.witnessRejected === false, JSON.stringify({ rejected: r4.witnessRejected }));

  // Case 5: no witness on the anchor → original trust-on-resolve behavior.
  const r5 = anchors.resolveAllWithSource({ primary: { kind: 'css', value: '.old-fav' } }, makeRoot({ '.old-fav': [impostor] }));
  check('witness-less anchors keep legacy trust', r5.source === 'primary' && r5.nodes[0] === impostor, '');
}

tBuild();
tMatchTolerance();
tMatchRejection();
tLadder();

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');
