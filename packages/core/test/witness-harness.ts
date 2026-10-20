// Diagnostic harness for the witness layer (packages/core/src/witness.js
// + the witness filtering in packages/core/src/anchors.js). Bare node —
// no Electron, no DOM: elements are stubs shaped like the subset of the
// Element interface the witness code reads (tagName, attributes,
// textContent, children, parentElement, getAttribute). Run when touching
// witness scoring, capture, or ladder fall-through:
//
//   node out/packages/core/test/witness-harness.js
//
// What it asserts:
//   - buildWitness captures stable attrs only (no class, no data-shim-*)
//   - matchWitness tolerance: text drift, class churn, child add — pass;
//     tag swap, attr loss + text change — fail
//   - resolveAllWithSource: witness filters impostors, falls through to
//     a fallback whose match passes, reports witnessRejected when
//     nothing survives
//   - unknown witness versions never quarantine

import { buildWitness, matchWitness, WITNESS_VERSION } from '../src/witness';
import * as anchors from '../src/anchors';
import type { Anchor, Witness, Rule } from '../src/types';
import { makeReconciler } from '../src/rule-reconcile';
import { makeRuleState } from '../src/rule-state';
import type { RuntimeSpec, RuleMountEntry } from '../src/engine-internal';
import type { CoreApi } from '../src/api';

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
    nodeType: 1,
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
    // Own text first, then the children — the same order textContent reads.
    // A plain (writable) property: some cases swap in their own child nodes.
    childNodes: [{ nodeType: 3, data: text }, ...children] as unknown[],
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
  const [v1FirstDetail] = v1.detail;
  check('tag swap is a hard fail', !v1.pass && !!v1FirstDetail && /tag mismatch/.test(v1FirstDetail), JSON.stringify(v1));

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
      // A dynamic-key lookup is `T | undefined` under noUncheckedIndexedAccess;
      // fall back to [] for an absent selector, same as the old `in`-guarded miss.
      return bySelector[sel] ?? [];
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

// The text stem is VISIBLE text only — the same extraction text anchors use.
// textContent concatenates inline <script>/<style>/<template>/<noscript>
// source, so a container with an inline style block got a CSS stem (live-
// caught on Google /search by the auto-improve loop): a noisy signal that
// shifted with every stylesheet tweak while the visible label held still.
function tStemVisibleText() {
  console.log('textStem visible text only:');
  const card = () => el('div', { role: 'region' }, {
    children: [
      el('style', {}, { text: '.card{color:red}.card h2{font-weight:700}' }),
      el('script', {}, { text: 'window.__init({cfg:1})' }),
      el('h2', {}, { text: 'Recent payments' }),
      el('template', {}, { text: 'Template body' }),
      el('noscript', {}, { text: 'Enable JavaScript' }),
      el('p', {}, { text: 'Acme Corp' }),
    ],
  });
  const w = buildWitness(card())!;
  check('capture skips script/style/template/noscript text', w.textStem === 'recent paymentsacme corp', JSON.stringify(w.textStem));

  // The inline CSS/JS changes, the visible content doesn't: still the element.
  const restyled = el('div', { role: 'region' }, {
    children: [
      el('style', {}, { text: '.x9{margin:0}' }),
      el('h2', {}, { text: 'Recent payments' }),
      el('p', {}, { text: 'Acme Corp' }),
    ],
  });
  const v = matchWitness(w, restyled);
  check('inline style/script churn leaves the stem matching', v.pass && !v.detail.some((d) => d.startsWith('text:')), JSON.stringify(v));

  // Back-compat: a witness captured BEFORE the fix stored the textContent stem
  // (CSS first). The same, unchanged element must still match it.
  const legacy: Witness = { v: WITNESS_VERSION, tag: 'div', attrs: { role: 'region' }, textStem: '.card{color:red}.card h{font-weight:}win' };
  const lv = matchWitness(legacy, card());
  check('legacy textContent stem still matches the unchanged element', lv.pass && !lv.detail.some((d) => d.startsWith('text:')), JSON.stringify(lv));

  check('new witnesses carry the visible-text marker', w.textStemFrom === 'visible', JSON.stringify(w));

  // A NEW witness never takes the textContent retry: hidden text can hold an
  // ordinary label. Captured: a payments div whose noscript says "Enable
  // JavaScript"; after a deploy a generic rung resolves an invoices div whose
  // noscript says "Recent payments". Id and visible stem both differ — the
  // hidden label must not carry it over the threshold.
  const section = el('section');
  const payments = el('div', { id: 'payments' }, { children: [el('noscript', {}, { text: 'Enable JavaScript' })], parent: section });
  (payments as unknown as { childNodes: unknown[] }).childNodes.push({ nodeType: 3, data: 'Recent payments' });
  Object.defineProperty(payments, 'textContent', { get: () => 'Enable JavaScriptRecent payments' });
  const pw = buildWitness(payments)!;
  check('capture reads the visible label past the noscript', pw.textStem === 'recent payments', JSON.stringify(pw));
  const invoices = el('div', { id: 'invoices' }, { children: [el('noscript', {}, { text: 'Recent payments' })], parent: el('section') });
  (invoices as unknown as { childNodes: unknown[] }).childNodes.push({ nodeType: 3, data: 'Upcoming invoices' });
  Object.defineProperty(invoices, 'textContent', { get: () => 'Recent paymentsUpcoming invoices' });
  const iv = matchWitness(pw, invoices);
  check('hidden-label collision does not verify a new witness', !iv.pass, JSON.stringify(iv));

  // A genuinely different visible label still fails the stem.
  const other = el('div', { role: 'region' }, { children: [el('h2', {}, { text: 'Upcoming invoices' })] });
  const ov = matchWitness(w, other);
  check('different visible label still misses the stem', ov.detail.some((d) => d.startsWith('text:')), JSON.stringify(ov));

  // The capture walk stops early once the stem is settled; the result must be
  // the stem the whole text gives (digit runs and whitespace across text-node
  // boundaries included).
  const parts = ['Quarterly revenue  ', '12', '34 by region  ', ' and product line ', '2026', ' detail', ' tail '.repeat(50)];
  const long = el('section', {}, { children: parts.map((t) => el('span', {}, { text: t })) });
  const full = parts.join('').toLowerCase().replace(/\d+/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  check('early-stopped walk yields the full-text stem', buildWitness(long)!.textStem === full, JSON.stringify([buildWitness(long)!.textStem, full]));
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

// Volatile-text leniency. The live loop this pins (soundeo, 2026-08-06): a
// rule anchored the player bar's track-title link — the element's text IS the
// currently playing track, so the witness stem went stale on every track
// change. The selector kept resolving the right element uniquely, the stem
// mismatch alone vetoed it → quarantine → auto-reanchor on every app launch,
// and each repair baked in the NEW track title — a loop by construction.
// Leniency is opt-in per call: a stem-only mismatch passes when every other
// present signal matches. The anchors ladder enables it ONLY for a non-text
// rung that resolved exactly one element; text-kind rungs, multi-match rungs,
// and every recovery scan stay strict (there the text discriminates).
function tVolatileTextLenient() {
  console.log('volatile-text leniency (matchWitness opts):');
  const playing = el('a', {}, { text: 'Ev, Nova Blue - Weekend Cinderella (Extended Mix)', parent: el('div') });
  const w = buildWitness(playing)!;
  const nextTrack = el('a', {}, { text: 'Fred again.., LATIN MAFIA - Piensas En Mi (Original Mix)', parent: el('div') });

  const strict = matchWitness(w, nextTrack);
  check('strict still rejects wholesale text change', !strict.pass, JSON.stringify(strict));
  const lenient = matchWitness(w, nextTrack, { lenientText: true });
  check('lenientText passes a stem-only mismatch', lenient.pass, JSON.stringify(lenient));
  check('lenient verdict names the tolerated drift', lenient.detail.some((d) => /text drifted/.test(d)), JSON.stringify(lenient.detail));

  // Leniency only forgives the stem — any other mismatching signal still fails.
  const withAttr = el('a', { 'data-testid': 'player-title' }, { text: 'Track A', parent: el('div') });
  const wa = buildWitness(withAttr)!;
  const wrongAttr = el('a', { 'data-testid': 'promo-link' }, { text: 'Track B', parent: el('div') });
  check('lenientText does not rescue an attr mismatch', !matchWitness(wa, wrongAttr, { lenientText: true }).pass, JSON.stringify(matchWitness(wa, wrongAttr, { lenientText: true })));

  const swapped = el('span', {}, { text: 'Track B', parent: el('div') });
  check('tag swap still hard-fails under leniency', !matchWitness(w, swapped, { lenientText: true }).pass, '');

  // A matching stem takes the normal path — no drift note.
  const sameish = el('a', {}, { text: 'Ev, Nova Blue - Weekend Cinderella (Extended Mix) [playing]', parent: el('div') });
  const okv = matchWitness(w, sameish, { lenientText: true });
  check('matching stem passes without the drift note', okv.pass && !okv.detail.some((d) => /text drifted/.test(d)), JSON.stringify(okv));
}

function tLadderVolatileText() {
  console.log('ladder leniency (gated on kind + uniqueness):');
  const captured = el('a', {}, { text: 'Ev, Nova Blue - Weekend Cinderella', parent: el('div') });
  const w = buildWitness(captured)!;
  const live = el('a', {}, { text: 'Fred again.., LATIN MAFIA - Piensas En Mi', parent: el('div') });

  // The player-bar case end to end: unique css rung + text-only drift → applies.
  const cssAnchor: Anchor = { primary: { kind: 'css', value: 'section.player a.title' }, witness: w };
  const r1 = anchors.resolveAllWithSource(cssAnchor, makeRoot({ 'section.player a.title': [live] }));
  check('unique css rung survives text-only drift', r1.source === 'primary' && r1.nodes[0] === live, JSON.stringify({ source: r1.source, rejected: r1.witnessRejected }));

  // Same drift, but the rung resolves TWO candidates — strict, both rejected.
  const live2 = el('a', {}, { text: 'Some Other Link Entirely', parent: el('div') });
  const r2 = anchors.resolveAllWithSource(cssAnchor, makeRoot({ 'section.player a.title': [live, live2] }));
  check('multi-match rung stays strict on text drift', r2.nodes.length === 0 && r2.witnessRejected === true, JSON.stringify({ n: r2.nodes.length, rejected: r2.witnessRejected }));

  // text-kind rung: the text IS the identity — drift stays a rejection even
  // when the scan resolves exactly one element. The text scan's visible-text
  // walk reads childNodes (nodeType-3 data), which el() stubs don't carry —
  // graft one text node on for this scenario only.
  const liveWalkable = live as unknown as { childNodes: Array<{ nodeType: number; data: string }> };
  liveWalkable.childNodes = [{ nodeType: 3, data: 'Fred again.., LATIN MAFIA - Piensas En Mi' }];
  const textAnchor: Anchor = { primary: { kind: 'text', value: 'fred again.., latin mafia - piensas en mi', match: 'contains' }, witness: w };
  const textRoot = {
    querySelectorAll: (): Element[] => [],
    getElementsByTagName: (tag: string): Element[] => (tag === '*' ? [live] : []),
  } as unknown as Document;
  const r3 = anchors.resolveAllWithSource(textAnchor, textRoot);
  check('text-kind rung stays strict on text drift', r3.nodes.length === 0 && r3.witnessRejected === true, JSON.stringify({ n: r3.nodes.length, rejected: r3.witnessRejected }));
}

// Document singletons (<html>, <head>, <body>). Live-caught on Google
// (2026-10-20): a page-level `script` rule anchored `css body`, committed on
// /search, captured the search page's body — `id="gsr"`, a stem of inline CSS,
// the first children — and then matched 0 on the homepage, whose body has none
// of those. Every document has exactly one body, so a body-tag candidate can't
// be "a different element"; those soft signals describe the PAGE, and they
// silently scoped the rule to one page type. The tag gate alone verifies a
// singleton; the selector keeps any deliberate scoping (`body.home`). Recovery
// refuses a singleton witness: the scan would always "find" the body and
// re-point a page-scoped selector onto a page it was never meant for.
function tDocumentSingletons() {
  console.log('document singletons (html/head/body):');
  // The witness the loop actually committed on google.com/search.
  const searchBody: Witness = {
    v: WITNESS_VERSION, tag: 'body', attrs: { id: 'gsr' },
    textStem: ':root{--coemy:#fff;--xhugwc:#fff}:root{-',
    childTags: ['style', 'style', 'style', 'script', 'noscript', 'div', 'div', 'span'],
    parentTag: 'html',
  };
  const homeBody = el('body', { jsmodel: 'hspDDf' }, { text: '(function(){window.google={kEI:', children: [el('div'), el('script')], parent: el('html') });
  const v = matchWitness(searchBody, homeBody);
  check('a body witness from one page verifies another page\'s body', v.pass, JSON.stringify(v));

  const anchor: Anchor = { primary: { kind: 'css', value: 'body' }, witness: searchBody };
  const r = anchors.resolveAllWithSource(anchor, makeRoot({ body: [homeBody] }));
  check('`css body` resolves on the homepage under a /search witness', r.nodes.length === 1 && r.nodes[0] === homeBody && !r.witnessRejected,
    JSON.stringify({ n: r.nodes.length, rejected: r.witnessRejected }));

  const htmlW: Witness = { v: WITNESS_VERSION, tag: 'html', attrs: { 'data-theme': 'dark' }, childTags: ['head', 'body'] };
  check('an html witness verifies by tag alone', matchWitness(htmlW, el('html', { lang: 'en' })).pass, '');

  // The tag gate still holds: a body witness never verifies a non-body.
  check('tag gate still applies to a singleton witness', !matchWitness(searchBody, el('div', { id: 'gsr' })).pass, '');
  // Non-singletons keep their soft scoring.
  const divW: Witness = { v: WITNESS_VERSION, tag: 'div', attrs: { id: 'search' }, textStem: 'results', parentTag: 'body' };
  check('a div witness still rejects an impostor div', !matchWitness(divW, el('div', { id: 'other' }, { text: 'about', parent: el('main') })).pass, '');

  // Capture keeps only the tag (and parent) for singletons — nothing page-specific
  // travels on the spec, and an older engine reading it verifies by tag too.
  const captured = buildWitness(homeBody);
  check('buildWitness on body keeps no page-specific signals',
    !!captured && captured.tag === 'body' && !captured.attrs && !captured.textStem && !captured.childTags,
    JSON.stringify(captured));

  // Recovery must not re-point onto the body (it would always "succeed").
  const root = { getElementsByTagName(tag: string): Element[] { return tag === 'body' ? [homeBody] : []; } };
  const rec = anchors.witnessRecoverDetail(searchBody, root);
  check('witness recovery refuses a singleton witness', rec.el === null && /singleton/.test(rec.reason || ''), JSON.stringify(rec.reason));
}

// The component-identity arms honour singletons too: a body witness carrying a
// `component` (captured before singletons skipped enrichment) must neither veto
// the body on another page type nor drive a component recovery onto it.
async function tSingletonComponentArms() {
  console.log('document singletons vs component identity (reconciler):');
  const body = el('body', {}, { parent: el('html') });
  (globalThis as unknown as { document: unknown }).document = { getElementsByTagName: (): Element[] => [body] };
  const bodyWitness: Witness = { v: WITNESS_VERSION, tag: 'body', parentTag: 'html', component: { path: ['SearchLayout', 'App'], propKeys: [] } };
  const run = (rule: Rule, rs: ReturnType<typeof makeRuleState>, specExtra: Partial<RuntimeSpec>) => new Promise<Array<{ kind: string; payload: unknown }>>((resolve) => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    const api = {
      reportEvent: (kind: string, payload: unknown) => { events.push({ kind, payload }); },
      componentId: {
        verify: async () => ({ path: ['HomeLayout', 'App'] }),
        find: async () => [body],
        symbols: async () => null,
      },
    } as unknown as CoreApi;
    const spec = { id: 's', rules: [rule], __bundleHashFn: () => 'new', ...specExtra } as RuntimeSpec;
    const r = makeReconciler(rule, spec, api, rs, new Set());
    r.start();
    setTimeout(() => { r.stop(); resolve(events); }, 4500);
  });

  // Primary resolves the homepage body; the stored component names the search layout.
  const rsA = makeRuleState();
  rsA.state.set(body, {} as RuleMountEntry);
  rsA.matchedSource = 'primary';
  rsA.resolvedEl = body;
  const ruleA: Rule = { id: 'page', anchor: { primary: { kind: 'css', value: 'body' }, witness: bodyWitness }, mutations: [{ kind: 'script', handler: 'h' }] };
  const evA = await run(ruleA, rsA, { bundleHash: 'new' });
  check('a stored body component never vetoes the body', !evA.some((e) => e.kind === 'rule-quarantined'), JSON.stringify(evA));

  // Deploy + a page-scoped `body.home` that resolves nothing: component identity
  // would find the body, but re-pointing onto it would drop the scoping.
  const ruleB: Rule = { id: 'home-only', anchor: { primary: { kind: 'css', value: 'body.home' }, witness: bodyWitness }, mutations: [{ kind: 'script', handler: 'h' }] };
  const evB = await run(ruleB, makeRuleState(), { bundleHash: 'old' });
  check('no component recovery onto a singleton', !evB.some((e) => e.kind === 'rule-rebase'), JSON.stringify(evB));
}

tBuild();
tMatchTolerance();
tMatchRejection();
tStemVolatility();
tStemVisibleText();
tRecoverChain();
tLadder();
tVolatileTextLenient();
tLadderVolatileText();
tDocumentSingletons();

void tSingletonComponentArms().then(() => {
  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall checks passed');
});
