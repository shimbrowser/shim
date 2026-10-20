// Set witnesses: the pure readers (set-witness.ts) — member snapshots,
// aggregation, per-member scoring, the identity predicate and its
// recovery-equivalence check — over fixtures drawn from the multi-match shims
// the automated authoring loop committed witness-less (2026-10-20): YouTube
// search results, Reddit comment trees and nameplates, Amazon search tiles and
// a price block with a hidden clone, Google's mixed result cards. Plus the
// old-engine check: the engine's element-witness paths ignore `setWitness`.
// Bare node: elements are stubs shaped like the subset of Element these read.
//
//   node out/packages/core/test/set-witness-harness.js

import {
  snapshotMember, buildSetWitness, matchSetWitness, matchSetSnapshot, identityPredicateFor,
  identityEquivalent, membersNested, textStemPrefix, MAX_SET_MEMBERS, SET_WITNESS_VERSION,
} from '../src/set-witness';
import type { SetMemberSnapshot } from '../src/set-witness';
import { resolveAllWithSource } from '../src/anchors';
import type { Anchor, SetWitness } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail: unknown = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}

// --- a tiny DOM -------------------------------------------------------------

interface StubText { nodeType: 3; data: string; reads: number }
interface StubEl {
  nodeType: 1;
  tagName: string;
  attributes: Array<{ name: string; value: string }>;
  children: StubEl[];
  childNodes: Array<StubEl | StubText>;
  parentElement: StubEl | null;
  getAttribute(name: string): string | null;
  owned?: boolean;
}
type Kid = StubEl | string;

let textReads = 0;
function text(data: string): StubText {
  const node = { nodeType: 3 as const, reads: 0, _d: data } as unknown as StubText & { _d: string };
  Object.defineProperty(node, 'data', { get() { textReads++; return (node as { _d: string })._d; } });
  return node;
}
function h(tag: string, attrs: Record<string, string> = {}, kids: Kid[] = []): StubEl {
  const el: StubEl = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    children: [],
    childNodes: [],
    parentElement: null,
    getAttribute(n: string) { const a = this.attributes.find((x) => x.name === n); return a ? a.value : null; },
  };
  for (const k of kids) {
    if (typeof k === 'string') el.childNodes.push(text(k));
    else { k.parentElement = el; el.children.push(k); el.childNodes.push(k); }
  }
  return el;
}
function under(parent: StubEl, kids: StubEl[]): StubEl[] {
  for (const k of kids) { k.parentElement = parent; parent.children.push(k); parent.childNodes.push(k); }
  return kids;
}
const asEl = (e: StubEl): Element => e as unknown as Element;
const owned = (n: Element): boolean => (n as unknown as StubEl).owned === true;
const snaps = (els: StubEl[]): SetMemberSnapshot[] => els.map((e) => snapshotMember(asEl(e), owned));
function build(els: StubEl[]): SetWitness {
  const r = buildSetWitness(snaps(els), { nested: membersNested(els.map(asEl)) });
  if (!r.ok) throw new Error(`expected a set witness, got ${r.reason}`);
  return r.setWitness;
}

// --- fixtures ----------------------------------------------------------------

function tYouTube(): void {
  console.log('YouTube ytd-video-renderer ×75 (filter-only):');
  const section = h('ytd-item-section-renderer');
  const items = under(section, Array.from({ length: 75 }, (_, i) => h('ytd-video-renderer',
    { class: `style-scope ytd-item-section-renderer x${i}`, lockup: 'true' },
    [h('div', { id: 'dismissible' }, [h('ytd-thumbnail'), h('div', { id: 'details' }, [`Video title number ${i} with words ${'abc'.repeat(i % 5)}`])])])));
  const sw = build(items);
  check('captures: tag, the lockup constant name, child shape, parent', sw.tag === 'ytd-video-renderer' && sw.count === 75
    && sw.parentTag === 'ytd-item-section-renderer' && (sw.childTags || []).join() === 'div', sw);
  check('class never becomes a signal', !(sw.attrNames || []).includes('class') && !Object.keys(sw.attrs || {}).includes('class'), sw);
  check('no site data-* → no identity predicate (filter-only)', identityPredicateFor(sw) === null, identityPredicateFor(sw));
  check('every member passes', items.every((el) => matchSetWitness(sw, asEl(el), owned).pass));
  const late = under(section, [h('ytd-video-renderer', { class: 'new-build-class', lockup: 'true' }, [h('div', { id: 'dismissible' }, ['A late result'])])])[0] as StubEl;
  check('a late member with a new class still passes', matchSetWitness(sw, asEl(late), owned).pass);
  const shelf = h('ytd-shelf-renderer', {}, [h('div')]);
  check('a different tag fails the hard gate', !matchSetWitness(sw, asEl(shelf), owned).pass);
  const stray = h('ytd-video-renderer', {}, [h('span'), h('span')]);
  const strayParent = h('ytd-mini-guide-renderer'); under(strayParent, [stray]);
  check('a same-tag element with nothing in common fails', !matchSetWitness(sw, asEl(stray), owned).pass, matchSetWitness(sw, asEl(stray), owned));
}

function tRedditComments(): void {
  console.log('Reddit nested shreddit-comment (bounded text work):');
  // A comment tree: each comment holds a long body and up to two replies.
  const body = (d: number, i: number) => h('div', { slot: 'comment' }, [h('p', {}, [`${'lorem ipsum dolor sit amet '.repeat(40)} depth ${d} #${i}`])]);
  const all: StubEl[] = [];
  let made = 0;
  const comment = (d: number): StubEl => {
    const i = made++;
    const kids: StubEl[] = [body(d, i)];
    if (d < 6) kids.push(comment(d + 1), comment(d + 1));
    const c = h('shreddit-comment', { 'thing-id': `t1_${i}`, depth: String(d), author: `user${i}` }, kids);
    all.push(c);
    return c;
  };
  const root = comment(0);
  check('the fixture is big (127 comments)', all.length === 127, all.length);
  textReads = 0;
  const stem = textStemPrefix(asEl(root));
  check('the root\'s text stem is read from a prefix, never the whole tree', stem.length === 40 && textReads <= 3, `${textReads} text reads`);
  textReads = 0;
  const sw = build(all);
  check('aggregating 127 members reads a bounded amount of text', textReads <= 127 * 3, `${textReads} text reads`);
  check('nesting is recorded', sw.nested === true);
  check('constant names (thing-id, depth, author) captured, values not', ['author', 'depth', 'thing-id'].every((n) => (sw.attrNames || []).includes(n)) && !sw.attrs, sw);
  check('text prefix common to every member is kept', sw.textStem === 'lorem ipsum dolor sit amet lorem ipsum d', sw.textStem);
  check('every member passes', all.every((el) => matchSetWitness(sw, asEl(el), owned).pass));
  check('no identity predicate', identityPredicateFor(sw) === null);
}

function tRedditNameplates(): void {
  console.log('Reddit nameplate links (filter-only):');
  const plates = Array.from({ length: 145 }, (_, i) => {
    const card = h('faceplate-hovercard');
    under(card, [h('a', { href: `/user/u${i}/`, class: 'author-name' }, [h('span', {}, [`u/u${i}`])])]);
    return card.children[0] as StubEl;
  });
  const sw = build(plates);
  check('href is a constant name, not a value; parent recorded', (sw.attrNames || []).includes('href') && !sw.attrs && sw.parentTag === 'faceplate-hovercard', sw);
  check('no identity predicate', identityPredicateFor(sw) === null);
  const p = h('p'); const link = under(p, [h('a', { href: '/r/sub' }, ['a subreddit'])])[0] as StubEl;
  check('an ordinary in-text link fails the veto', !matchSetWitness(sw, asEl(link), owned).pass, matchSetWitness(sw, asEl(link), owned));
  check('a new nameplate passes', matchSetWitness(sw, asEl(under(h('faceplate-hovercard'), [h('a', { href: '/user/new/' }, [h('span', {}, ['u/new'])])])[0] as StubEl), owned).pass);
}

function amazonTile(i: number, extra: Record<string, string> = { 'data-csa-c-type': 'item' }): StubEl {
  return h('div', {
    'data-component-type': 's-search-result', 'data-asin': `B0${1000 + i}`, 'data-index': String(i), 'data-uuid': `u-${i}`,
    role: 'listitem', class: `sg-col s-result-item s-asin x${i}`, ...extra,
  }, [h('div', { class: 'sg-col-inner' }, [`Product ${i}`])]);
}

function tAmazonTiles(): void {
  console.log('Amazon s-search-result ×48 (+ a late member lacking an incidental constant):');
  const grid = h('div', { class: 's-main-slot' });
  const tiles = under(grid, Array.from({ length: 48 }, (_, i) => amazonTile(i)));
  const sw = build(tiles);
  check('constant values: component type, role, the incidental csa type', sw.attrs?.['data-component-type'] === 's-search-result'
    && sw.attrs.role === 'listitem' && sw.attrs['data-csa-c-type'] === 'item', sw.attrs);
  check('per-member values are names only (asin, index, uuid)', ['data-asin', 'data-index', 'data-uuid'].every((n) => (sw.attrNames || []).includes(n)), sw.attrNames);
  const id = identityPredicateFor(sw);
  check('identity predicate: tag + constant site data-*', id === 'div[data-component-type="s-search-result"][data-csa-c-type="item"]', id);
  const late = under(grid, [amazonTile(48, {})])[0] as StubEl;
  const v = matchSetWitness(sw, asEl(late), owned);
  check('the late member lacking the incidental constant still passes', v.pass, v);
  const ad = under(grid, [h('div', { 'data-component-type': 'sp-sponsored-banner', class: 'ad' }, [h('span')])])[0] as StubEl;
  check('a different component on the same grid fails', !matchSetWitness(sw, asEl(ad), owned).pass, matchSetWitness(sw, asEl(ad), owned));
}

function tAmazonPriceClone(): void {
  console.log('Amazon price block + hidden clone (n=2):');
  const page = h('div', { id: 'centerCol' });
  const block = () => h('div', { 'data-feature-name': 'corePriceDisplay_desktop', 'data-csa-c-content-id': 'corePriceDisplay_desktop' }, [h('span', { class: 'a-price' }, ['$19.99'])]);
  const pair = under(page, [block(), block()]);
  const sw = build(pair);
  check('a two-member set is captured', sw.count === 2 && sw.attrs?.['data-feature-name'] === 'corePriceDisplay_desktop', sw);
  check('identity predicate exists', identityPredicateFor(sw) === 'div[data-csa-c-content-id="corePriceDisplay_desktop"][data-feature-name="corePriceDisplay_desktop"]', identityPredicateFor(sw));
  check('both pass', pair.every((el) => matchSetWitness(sw, asEl(el), owned).pass));
}

function tGoogleMixed(): void {
  console.log('Google mixed tags (refused):');
  const r = buildSetWitness(snaps([h('div', { class: 'g' }), h('div', { class: 'g' }), h('g-section-with-header')]), { nested: false });
  check('mixed tags → no set witness', !r.ok && r.reason === 'mixed-tags', r);
}

function tDataIndexOnly(): void {
  console.log('a data-index / boolean-only set (no identity):');
  const rows = Array.from({ length: 5 }, () => h('li', { 'data-index': '2', 'data-visible': 'true', 'data-x': '' }, [h('span')]));
  under(h('ul'), rows);
  const sw = build(rows);
  check('numeric / boolean-like / empty constants are kept as signals', sw.attrs?.['data-index'] === '2' && sw.attrs['data-visible'] === 'true', sw.attrs);
  check('…but never form an identity predicate', identityPredicateFor(sw) === null, identityPredicateFor(sw));
}

function tLimits(): void {
  console.log('limits and edge cases:');
  check('one member is not a set', (() => { const r = buildSetWitness(snaps([h('li')]), { nested: false }); return !r.ok && r.reason === 'too-few'; })());
  const many = Array.from({ length: MAX_SET_MEMBERS + 1 }, () => h('li'));
  check('over the member cap → refused', (() => { const r = buildSetWitness(snaps(many), { nested: false }); return !r.ok && r.reason === 'too-many'; })());
  const long = 'x'.repeat(500);
  const big = [h('li', { 'data-state': long }), h('li', { 'data-state': long })];
  const sw = build(big);
  check('an over-long attribute value is never stored, its name still counts', !sw.attrs && (sw.attrNames || []).includes('data-state'), sw);
  const shimChild = () => { const c = h('div', { 'data-shim-mounted': '1' }, ['injected note text that is long enough']); c.owned = true; return c; };
  const a = h('li', {}, [shimChild(), h('span', {}, ['Track one'])]);
  const b = h('li', {}, [h('span', {}, ['Track two'])]);
  const swOwn = build([a, b]);
  check('shim-owned children never enter child shape or text', (swOwn.childTags || []).join() === 'span' && !swOwn.textStem, swOwn);
  check('data-shim* stamps are never signals', (() => {
    const s = build([h('li', { 'data-shim-css': 'tok-a' }), h('li', { 'data-shim-css': 'tok-b' })]);
    return !s.attrs && !s.attrNames;
  })());
  check('an unknown-version set witness passes everything', matchSetWitness({ v: 99, tag: 'li', count: 2, nested: false }, asEl(h('div')), owned).pass);
  check('tag-only witness: the tag is the whole test', matchSetSnapshot({ v: SET_WITNESS_VERSION, tag: 'li', count: 2, nested: false }, snapshotMember(asEl(h('li')))).pass);
  const x = h('li'); const y = h('li');
  check('identityEquivalent: same members, any order', identityEquivalent([asEl(y), asEl(x)], [asEl(x), asEl(y)]));
  check('identityEquivalent: a broader predicate is not equivalent', !identityEquivalent([asEl(x), asEl(y), asEl(h('li'))], [asEl(x), asEl(y)]));
  check('names a selector would misread (. or :) never enter the predicate',
    identityPredicateFor({ v: 1, tag: 'div', count: 2, nested: false, attrs: { 'data-kind.name': 'product', 'data-a:b': 'x' } }) === null);
  const huge = h('li', {}, [`${' 1 2 3 '.repeat(20)}${'word '.repeat(400000)}`]);
  const t0 = Date.now();
  const hugeStem = textStemPrefix(asEl(huge));
  check('one multi-megabyte text node is read only up to the raw budget', hugeStem.startsWith('word word') && hugeStem.length === 40 && Date.now() - t0 < 250, `${hugeStem} in ${Date.now() - t0}ms`);
  const blank = h('li', {}, [`${' 7 '.repeat(1000000)}tail`]);
  check('a leading run of whitespace and digits past the budget yields no stem', textStemPrefix(asEl(blank)) === '');
  check('identity values with quotes are escaped', identityPredicateFor({ v: 1, tag: 'div', count: 2, nested: false, attrs: { 'data-k': 'a"b' } }) === 'div[data-k="a\\"b"]');
}

// Organic / sponsored: the author's selector deliberately kept 20 organic
// tiles while 10 sponsored tiles share the same data-*. The identity
// predicate would find all 30, so the equivalence check refuses it — the
// capture stores the set witness filter-only and recovery can never broaden
// the rule.
function tOrganicSponsored(): void {
  console.log('organic / sponsored counterexample:');
  const organic = Array.from({ length: 20 }, () => h('div', { 'data-kind': 'product' }, [h('span')]));
  const sponsored = Array.from({ length: 10 }, () => h('div', { 'data-kind': 'product' }, [h('span')]));
  const sw = build(organic);
  const id = identityPredicateFor(sw);
  check('a predicate exists', id === 'div[data-kind="product"]', id);
  check('…but its complete result (30) is not the anchor\'s (20): not stored', !identityEquivalent([...organic, ...sponsored].map(asEl), organic.map(asEl)));
}

// The engine's element-witness paths read `anchor.witness` only: a rule
// carrying just a set witness resolves exactly as a witness-less one (every
// match trusted) — what an older engine does with the unknown field.
function tOldEngineIgnores(): void {
  console.log('engine paths ignore setWitness:');
  const items = [h('li', { class: 'r' }), h('li', { class: 'r' }), h('div', { class: 'r' })];
  const root = { querySelectorAll: () => items } as unknown as Document;
  const setWitness: SetWitness = { v: 1, tag: 'li', count: 2, nested: false };
  const withSet: Anchor = { primary: { kind: 'css', value: '.r' }, setWitness };
  const bare: Anchor = { primary: { kind: 'css', value: '.r' } };
  const a = resolveAllWithSource(withSet, root);
  const b = resolveAllWithSource(bare, root);
  check('same matches as a witness-less anchor (no filtering, no rejection)', a.nodes.length === 3 && b.nodes.length === 3 && !a.witnessRejected, a);
}

console.log('\n=== set-witness harness ===\n');
tYouTube();
tRedditComments();
tRedditNameplates();
tAmazonTiles();
tAmazonPriceClone();
tGoogleMixed();
tDataIndexOnly();
tLimits();
tOrganicSponsored();
tOldEngineIgnores();
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall set-witness checks passed');
