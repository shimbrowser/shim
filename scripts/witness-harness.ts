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

import { buildWitness, matchWitness, WITNESS_VERSION } from '../src/patch-engine/witness';
import * as anchors from '../src/patch-engine/anchors';
import type { Anchor, Witness } from '../src/patch-engine/types';

let failures = 0;
function check(label: string, cond: boolean, detail: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

interface ElOpts {
  text?: string;
  children?: Element[];
  parent?: Element | null;
}

// Minimal element stub. attrs is a plain object; children an array of
// stubs; parent wired by caller.
function el(tag: string, attrs: Record<string, string> = {}, { text = '', children = [], parent = null }: ElOpts = {}): Element {
  const node = {
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    children,
    parentElement: parent,
    getAttribute(name: string) {
      const found = this.attributes.find((a) => a.name === name);
      return found ? found.value : null;
    },
    get textContent() {
      return text + children.map((c) => c.textContent).join('');
    },
  };
  for (const c of children) (c as unknown as { parentElement: Element | null }).parentElement = node as unknown as Element;
  // Stub is shaped like the subset of Element the witness code reads (see
  // header comment), not a real DOM Element — cast at this single choke
  // point so every caller downstream can pass it to the now-typed
  // buildWitness/matchWitness without widening those signatures back to
  // `any` for the sake of a bare-node test double.
  return node as unknown as Element;
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

  // buildWitness only returns null for an element with no tagName; every
  // el() stub always has one, so `!` is safe throughout this file.
  const w = buildWitness(target)!;
  check('captures tag', w.tag === 'button', JSON.stringify(w));
  check('captures id + data-* + aria-label', w.attrs!.id === 'fav-btn' && w.attrs!['data-testid'] === 'favorite' && w.attrs!['aria-label'] === 'favorite this track', JSON.stringify(w.attrs));
  check('excludes class', !('class' in (w.attrs || {})), '');
  check('excludes data-shim-* (engine-stamped tokens)', !('data-shim-css' in (w.attrs || {})), '');
  check('captures text stem lowercased', w.textStem === 'favorite', JSON.stringify(w.textStem));
  check('captures child shape + parent tag', w.childTags!.join() === 'svg' && w.parentTag === 'section', '');
  check('stamps version', w.v === WITNESS_VERSION, '');
}

function tMatchTolerance() {
  console.log('matchWitness tolerance (site churn should pass):');
  const parent = el('section');
  const original = el('button', { id: 'fav-btn', 'data-testid': 'favorite' }, { text: 'Favorite', parent });
  const w = buildWitness(original)!;

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
  const w = buildWitness(original)!;

  const tagSwap = el('a', { id: 'fav-btn', 'data-testid': 'favorite' }, { text: 'Favorite' });
  const v1 = matchWitness(w, tagSwap);
  check('tag swap is a hard fail', !v1.pass && /tag mismatch/.test(v1.detail[0]), JSON.stringify(v1));

  // Same tag, but it's a different button: no identity attrs, different label.
  const impostor = el('button', { 'data-testid': 'subscribe' }, { text: 'Subscribe now', parent: el('nav') });
  const v2 = matchWitness(w, impostor);
  check('impostor button fails with diff detail', !v2.pass && v2.detail.length >= 2, JSON.stringify(v2));

  const future: Witness = { v: WITNESS_VERSION + 1, tag: 'div' };
  check('unknown witness version passes (never quarantine on shape we cannot read)', matchWitness(future, impostor).pass, '');
}

// Doc stub for the ladder tests: only querySelectorAll/getElementsByTagName
// are read (see anchors.ts's ScanRoot) — cast at this single choke point
// rather than widening resolveAllWithSource's `root: Document | Element`.
function makeRoot(bySelector: Record<string, Element[]>): Document {
  const root = {
    querySelectorAll(sel: string): Element[] {
      if (!(sel in bySelector)) return [];
      return bySelector[sel];
    },
    getElementsByTagName(): Element[] { return []; },
  };
  return root as unknown as Document;
}

function tLadder() {
  console.log('anchors ladder with witness filtering:');
  // Stub document root supporting querySelectorAll over a tiny fixed set.
  const parent = el('section');
  const realTarget = el('button', { id: 'fav-btn', 'data-testid': 'favorite' }, { text: 'Favorite', parent });
  const impostor = el('button', { 'data-testid': 'promo' }, { text: 'Subscribe', parent: el('nav') });
  const w = buildWitness(realTarget)!;

  // Case 1: primary resolves the impostor; fallback resolves the real
  // target — witness filters the impostor, ladder falls through.
  const anchor1: Anchor = {
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
  const anchor2: Anchor = { primary: { kind: 'css', value: 'button' }, witness: w };
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

// Volatile-text normalization: digits are live data (badge counts, dates), not
// identity — stripped from the stem on BOTH sides. The live regression this
// pins: a dashboard card captured as "estimates needing attention94colin's
// pal…" (badge count + row data baked mid-stem) failed witnessRecover the
// moment the count ticked, dropping a heal that should have been free to the
// LLM tier.
function tStemVolatility() {
  console.log('textStem digit normalization:');

  // Capture strips digit runs — the stored stem is stable words only.
  const card = el('div', {}, { text: 'Estimates Needing Attention94Colin\'s Palace Remodel' });
  const w = buildWitness(card)!;
  check('capture strips digits from the stem', !!(w.textStem && !/\d/.test(w.textStem)), JSON.stringify(w.textStem));

  // THE regression: same card next visit — count ticked, rows changed.
  const later = el('div', {}, { text: 'Estimates Needing Attention97Beacon Tower Phase 2' });
  const verdict = matchWitness(w, later);
  check('count tick + row churn mid-stem still matches', verdict.pass, JSON.stringify(verdict));

  // Back-compat: a PRE-normalization witness (digits stored in the stem)
  // matches a live element through stored-side normalization.
  const legacy: Witness = { v: WITNESS_VERSION, tag: 'div', textStem: 'estimates needing attention94colin\'s pal' };
  const legacyVerdict = matchWitness(legacy, later);
  check('legacy digit-bearing stored stem still matches', legacyVerdict.pass, JSON.stringify(legacyVerdict));

  // An all-digits stem normalizes to nothing — no stable signal, so it neither
  // matches nor penalizes (a genuinely different element must fail on OTHER
  // signals, not sneak through on a bare count).
  const counter = el('span', { role: 'status' }, { text: '42' });
  const wc = buildWitness(counter)!;
  check('all-digit text → no stem stored', !('textStem' in wc), JSON.stringify(wc));
  const legacyCount: Witness = { v: WITNESS_VERSION, tag: 'span', attrs: { role: 'status' }, textStem: '42' };
  const other = el('span', { role: 'status' }, { text: '7' });
  check('legacy all-digit stem contributes nothing (passes on attrs)', matchWitness(legacyCount, other).pass, '');

  // A genuinely different label still fails — normalization must not blunt
  // the signal into mush.
  const different = el('div', {}, { text: 'Recent Payments12Acme Corp' });
  check('different label still rejected', !matchWitness(w, different).pass, JSON.stringify(matchWitness(w, different)));
}

// witnessRecover containment-chain collapse. The live failure this pins: a
// dashboard card's wrapper ancestors (and the grid parent, when the card is
// its first child) inherit the card's textContent, so several same-tag
// elements pass the witness strongly and the old exactly-one veto declined —
// every witness recovery on a nested-div dashboard fell to the LLM tier.
function tRecoverChain() {
  console.log('witnessRecover chain collapse:');

  // grid > card > title — title/text nest so all three carry the same stem.
  const title = el('div', {}, { text: 'Estimates Needing Attention' });
  const bodyA = el('div', {}, { text: 'Colin\'s Palace Remodel' });
  const card = el('div', {}, { children: [title, bodyA] });
  const sibling = el('div', {}, { text: 'Recent Payments' });
  const grid = el('div', {}, { children: [card, sibling] });
  // Witness as captured from the card: div, stem, two div children, div parent.
  const w: Witness = { v: WITNESS_VERSION, tag: 'div', textStem: 'estimates needing attentioncolin\'s pala', childTags: ['div', 'div'], parentTag: 'div' };
  // grid also passes (stem inherited via first child, div children, and we give
  // it a div parent so its parentTag signal matches too).
  el('div', {}, { children: [grid] });

  const root = { getElementsByTagName(tag: string): Element[] { return tag === 'div' ? [grid, card, title, bodyA, sibling] : []; } };
  const found = anchors.witnessRecover(w, root);
  check('nested chain collapses to the best-scoring element (the card)', found === card,
    found === grid ? 'picked grid (ancestor)' : found === title ? 'picked title (descendant)' : found === null ? 'null (old veto)' : 'other');

  // Two DISJOINT strong candidates (identical twin cards) — genuinely
  // ambiguous, still declined.
  const twinTitle = el('div', {}, { text: 'Estimates Needing Attention' });
  const twinBody = el('div', {}, { text: 'Colin\'s Palace Remodel' });
  const twin = el('div', {}, { children: [twinTitle, twinBody] });
  el('div', {}, { children: [twin] });
  const root2 = { getElementsByTagName(tag: string): Element[] { return tag === 'div' ? [card, twin] : []; } };
  check('disjoint twins still decline (no guessing)', anchors.witnessRecover(w, root2) === null, '');
}

tBuild();
tMatchTolerance();
tMatchRejection();
tStemVolatility();
tRecoverChain();
tLadder();

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');
