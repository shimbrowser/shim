// Diagnostic harness for anchor synthesis quality (§8): suggestAnchorLadder /
// suggestAnchorFor — the ranked, DOM-verified ladder the auto-rebase recover
// paths use to re-point a rule. Bare node — no DOM, no Electron: elements are
// stubs, and the "document" stub implements just enough querySelectorAll for
// the selector shapes synthesis emits (#id, [attr="v"], tag.cls, descendant
// combos). Run when touching the synthesis/ranking logic:
//
//   node scripts/anchor-synthesis-harness.js
//
// Covers:
//   - uniqueness ranking: a unique weaker-kind anchor outranks a strong kind
//     shared by a crowd (the recover paths only re-point single-target rules)
//   - candidates that resolve to a DIFFERENT element are dropped (text
//     deepest-matcher resolving to a child, not the wrapper)
//   - generated-class filtering (css-in-js hashes, minified names, css-module
//     suffixes) vs human-named / BEM classes
//   - text rung for attribute-poor leaf elements (not just button/link/heading)
//   - ancestor-scoped rung beating a crowd-matching bare class
//   - positional path always present, always last; ladder capped
//   - suggestAnchorFor back-compat: head of the ladder, kind-ordered when the
//     scope can't verify (stub roots without querySelectorAll)

import { suggestAnchorFor, suggestAnchorLadder, resolveAll } from '../src/patch-engine/anchors';
import { must } from '../src/shared/assert';

let failures = 0;
function check(label: string, cond: boolean, detail: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// --- element + document stubs -------------------------------------------
// Rich enough for synthesis verification: parentElement links, descendant
// walks, and a micro selector matcher for the grammar synthesis generates.

interface ElOpts {
  text?: string;
  children?: Element[];
}

function el(tag: string, attrs: Record<string, string> = {}, { text = '', children = [] }: ElOpts = {}): Element {
  const node = {
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    children,
    parentElement: null as Element | null,
    getAttribute(n: string) {
      const f = this.attributes.find((a) => a.name === n);
      return f ? f.value : null;
    },
    get textContent() { return text + children.map((c) => c.textContent).join(''); },
    querySelectorAll(sel: string): Element[] {
      if (sel === '*') return descendantsOf(node as unknown as Element);
      return [];
    },
  };
  for (const c of children) (c as unknown as { parentElement: Element | null }).parentElement = node as unknown as Element;
  // Stub is shaped like the subset of Element anchors.ts reads (see header
  // comment), not a real DOM Element — cast at this single choke point,
  // mirroring witness-harness.ts's `el()`, so every caller downstream can
  // pass it to the now-typed suggestAnchorLadder/suggestAnchorFor/resolveAll
  // without widening those signatures back to `any` for a bare-node test
  // double's sake.
  return node as unknown as Element;
}

function descendantsOf(node: Element): Element[] {
  const out: Element[] = [];
  for (const c of node.children || []) {
    out.push(c, ...descendantsOf(c));
  }
  return out;
}

// Micro selector matcher. Supports what synthesis emits for its verifiable
// candidates: `#id`, `[attr]`, `[attr="v"]`, `tag`, `.cls`, compounds of
// those, and descendant combinators (single space). No `>` / `:nth-*` — the
// positional tail is appended AFTER verification, never resolved here.
function matchesSimple(node: Element, part: string): boolean {
  const tokens = part.match(/^[a-z0-9-]+|#[\w-]+|\.[\w-]+|\[[^\]]+\]/gi) || [];
  let consumed = 0;
  for (const t of tokens) {
    consumed += t.length;
    if (t.startsWith('#')) {
      if (node.getAttribute('id') !== t.slice(1)) return false;
    } else if (t.startsWith('.')) {
      const cls = (node.getAttribute('class') || '').split(/\s+/);
      if (!cls.includes(t.slice(1))) return false;
    } else if (t.startsWith('[')) {
      const m = t.slice(1, -1).match(/^([\w-]+)(?:="(.*)")?$/);
      if (!m) return false;
      // Capture group 1 is mandatory in the pattern above, so a successful
      // match always has it.
      const [, attrName, attrValue] = m;
      const v = node.getAttribute(must(attrName, 'attribute-selector name'));
      if (attrValue !== undefined ? v !== attrValue : v === null) return false;
    } else if (node.tagName.toLowerCase() !== t.toLowerCase()) {
      return false;
    }
  }
  return consumed === part.length && tokens.length > 0;
}

// Doc stub. Structurally a subset of Document (querySelectorAll +
// getElementsByTagName, the only members anchors.ts's verification pass
// reads off `root`) — cast at this single choke point rather than widening
// suggestAnchorLadder/resolveAll's `root: Document | Element` param.
function makeDoc(rootChildren: Element[]): Document {
  const rootEl = el('body', {}, { children: rootChildren });
  const all = descendantsOf(rootEl);
  const doc = {
    querySelectorAll(sel: string): Element[] {
      const parts = sel.trim().split(/\s+/);
      return all.filter((node) => {
        // split() on a trimmed, non-empty string always yields ≥1 part, so
        // the last-part and i-th-part indices below are always in range.
        if (!matchesSimple(node, must(parts[parts.length - 1], 'selector last part'))) return false;
        let i = parts.length - 2;
        let cur = node.parentElement;
        while (i >= 0 && cur) {
          if (matchesSimple(cur, must(parts[i], 'selector part'))) i--;
          cur = cur.parentElement;
        }
        return i < 0;
      });
    },
    getElementsByTagName(tag: string): Element[] {
      if (tag === '*') return all;
      return all.filter((n) => n.tagName.toLowerCase() === tag.toLowerCase());
    },
  };
  return doc as unknown as Document;
}

// --- tests ----------------------------------------------------------------

function tUniquenessRanking() {
  console.log('uniqueness ranking:');
  // Three rows share data-testid="row"; the target alone says "Watchlist".
  const target = el('button', { 'data-testid': 'row' }, { text: 'Watchlist' });
  const rows = [
    el('button', { 'data-testid': 'row' }, { text: 'Discover' }),
    target,
    el('button', { 'data-testid': 'row' }, { text: 'Library' }),
  ];
  const doc = makeDoc(rows);
  const ladder = suggestAnchorLadder(target, doc);
  const head = ladder[0];
  check('unique text outranks crowd data-attr',
    !!head && head.kind === 'text' && head.value === 'Watchlist',
    JSON.stringify(head));
  check('crowd data-attr kept as a runner-up rung',
    ladder.some((s) => s.kind === 'data-attr' && s.name === 'data-testid'),
    JSON.stringify(ladder));

  // When the strong kind IS unique, it stays on top.
  const solo = el('button', { 'data-testid': 'fav' }, { text: 'Favorite' });
  const doc2 = makeDoc([solo, el('button', {}, { text: 'Other' })]);
  const ladder2 = suggestAnchorLadder(solo, doc2);
  const head2 = ladder2[0];
  check('unique data-attr stays primary',
    !!head2 && head2.kind === 'data-attr' && head2.value === 'fav',
    JSON.stringify(head2));
}

function tWrongElementDropped() {
  console.log('wrong-element candidates dropped:');
  // Wrapper div whose text lives in a child leaf: the text candidate
  // deepest-matches the child, so it must be dropped for the wrapper.
  const label = el('span', {}, { text: 'Settings' });
  const wrapper = el('div', { class: 'nav-item' }, { children: [label] });
  const doc = makeDoc([wrapper, el('div', { class: 'nav-item' }, { children: [el('span', {}, { text: 'Home' })] })]);
  const ladder = suggestAnchorLadder(wrapper, doc);
  check('text anchor resolving to the child is not used for the wrapper',
    !ladder.some((s) => s.kind === 'text'),
    JSON.stringify(ladder));
}

function tGeneratedClassFilter() {
  console.log('generated-class filtering:');
  const target = el('div', { class: 'css-1a2b3c4 track-row x9' }, { text: 'A very long piece of body text that exceeds sixty characters total' });
  const doc = makeDoc([target, el('div', { class: 'css-9z8y7x6' })]);
  const ladder = suggestAnchorLadder(target, doc);
  check('human-named class used',
    ladder.some((s) => s.kind === 'css' && s.value === 'div.track-row'),
    JSON.stringify(ladder));
  check('generated classes never appear',
    !ladder.some((s) => s.kind === 'css' && /css-|x9/.test(String(s.value))),
    JSON.stringify(ladder));
}

function tLeafTextRung() {
  console.log('attribute-poor leaf text:');
  // Plain div, no attrs, short distinctive text — used to fall straight to a
  // positional path.
  const target = el('div', {}, { text: 'Recently played' });
  const doc = makeDoc([target, el('div', {}, { text: 'Made for you' })]);
  const ladder = suggestAnchorLadder(target, doc);
  const head = ladder[0];
  check('leaf div gets a text anchor',
    !!head && head.kind === 'text' && head.value === 'Recently played',
    JSON.stringify(head));
}

function tAncestorScoping() {
  console.log('ancestor scoping:');
  // `.row` matches in both panels; only `#main .row`-style scoping is unique.
  const target = el('div', { class: 'row' });
  const main = el('section', { id: 'main' }, { children: [target] });
  const side = el('section', { id: 'side' }, { children: [el('div', { class: 'row' }), el('div', { class: 'row' })] });
  const doc = makeDoc([main, side]);
  const ladder = suggestAnchorLadder(target, doc);
  const head = ladder[0];
  check('scoped selector wins over crowd bare class',
    !!head && head.kind === 'css' && head.value === '#main div.row',
    JSON.stringify(head));
  check('bare class demoted but kept',
    ladder.some((s) => s.kind === 'css' && s.value === 'div.row'),
    JSON.stringify(ladder));
}

function tPositionalTail() {
  console.log('positional tail:');
  // No signal at all → ladder is just the positional path.
  const bare = el('span', {}, { text: 'x'.repeat(80) });
  const doc = makeDoc([bare]);
  const ladder = suggestAnchorLadder(bare, doc);
  const [onlyHead] = ladder;
  // ladder.length === 1 is checked first, so index 0 is proven present.
  check('signal-less element still gets a (positional) anchor',
    ladder.length === 1 && !!onlyHead && onlyHead.kind === 'css' && onlyHead.value!.includes('span'),
    JSON.stringify(ladder));

  // Rich element: positional still present but never first, ladder capped.
  const rich = el('button', { id: 'fav', 'data-testid': 'fav', role: 'button', 'aria-label': 'Favorite' }, { text: 'Favorite' });
  const doc2 = makeDoc([rich]);
  const ladder2 = suggestAnchorLadder(rich, doc2);
  check('ladder capped at 4', ladder2.length <= 4, `${ladder2.length}`);
  // ladder2 was just shown non-empty above (ladder capped at 4, and rich has
  // multiple strong signals so it's never empty); index 0 is present.
  const richHead = must(ladder2[0], 'rich-element ladder head');
  check('positional never first on a rich element',
    !/nth-of-type|>/.test(richHead.value || ''),
    JSON.stringify(richHead));
}

function tBackCompat() {
  console.log('suggestAnchorFor back-compat (unverifiable stub → kind order):');
  check('id wins',
    JSON.stringify(suggestAnchorFor(el('div', { id: 'cart', 'data-testid': 'x' }), undefined)) === JSON.stringify({ kind: 'css', value: '#cart' }), '');
  check('site data-* when no id',
    JSON.stringify(suggestAnchorFor(el('div', { 'data-testid': 'cart' }), undefined)) === JSON.stringify({ kind: 'data-attr', name: 'data-testid', value: 'cart' }), '');
  check('never anchors to data-shim* tokens',
    JSON.stringify(suggestAnchorFor(el('button', { 'data-shim-css': 'shim-x', role: 'button', 'aria-label': 'Buy' }), undefined)) === JSON.stringify({ kind: 'aria', role: 'button', label: 'Buy' }), '');
}

function tTextCaseInsensitive() {
  console.log('text matching is case-insensitive:');
  // The live bug: an AI re-anchor copied the witness stem's lowercase form
  // ("Forgot password?") while the page said "Forgot Password?" — exact text
  // matching was case-sensitive, so the committed anchor matched 0 elements.
  const target = el('button', {}, { text: 'Forgot Password?' });
  const doc = makeDoc([target, el('button', {}, { text: 'Sign In' })]);
  check('exact match ignores case',
    resolveAll({ primary: { kind: 'text', value: 'Forgot password?' } }, doc)[0] === target, '');
  check('contains match ignores case',
    resolveAll({ primary: { kind: 'text', value: 'forgot', match: 'contains' } }, doc)[0] === target, '');
  check('non-matching text still resolves nothing',
    resolveAll({ primary: { kind: 'text', value: 'Reset Password?' } }, doc).length === 0, '');
}

tUniquenessRanking();
tTextCaseInsensitive();
tWrongElementDropped();
tGeneratedClassFilter();
tLeafTextRung();
tAncestorScoping();
tPositionalTail();
tBackCompat();

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');
