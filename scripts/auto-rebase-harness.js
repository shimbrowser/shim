// Diagnostic harness for the auto-rebase building blocks (§14):
// anchors.suggestAnchorFor (synthesize a fresh anchor for a found element)
// and anchors.witnessRecover (find a drifted element by its witness). Bare
// node — no DOM, no Electron: elements are stubs shaped like the subset of
// the Element interface these functions read. Run when touching the rebase
// synthesis/recovery logic:
//
//   node scripts/auto-rebase-harness.js
//
// Covers:
//   - suggestAnchorFor ranking (id > site data-* > aria > text > positional),
//     and that it never anchors to data-shim* engine tokens
//   - witnessRecover: finds the unique strong match, refuses when zero or
//     when multiple strong candidates exist (ambiguity → no auto-rebase)

const { suggestAnchorFor, witnessRecover } = require('../src/patch-engine/anchors');
const { buildWitness } = require('../src/patch-engine/witness');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// Element stub. Supports the methods the rebase code calls: getAttribute,
// attributes, textContent, children, parentElement, tagName.
function el(tag, attrs = {}, { text = '', children = [], parent = null } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    children,
    parentElement: parent,
    getAttribute(n) {
      const f = this.attributes.find((a) => a.name === n);
      return f ? f.value : null;
    },
    get textContent() { return text + children.map((c) => c.textContent).join(''); },
  };
  for (const c of children) c.parentElement = node;
  return node;
}

function tSuggestRanking() {
  console.log('suggestAnchorFor ranking:');
  check('id wins',
    JSON.stringify(suggestAnchorFor(el('div', { id: 'cart', 'data-testid': 'x' }))) === JSON.stringify({ kind: 'css', value: '#cart' }), '');
  check('site data-* when no id',
    JSON.stringify(suggestAnchorFor(el('div', { 'data-testid': 'cart' }))) === JSON.stringify({ kind: 'data-attr', name: 'data-testid', value: 'cart' }), '');
  check('never anchors to data-shim* (skips to next signal)',
    JSON.stringify(suggestAnchorFor(el('button', { 'data-shim-css': 'shim-x', role: 'button', 'aria-label': 'Buy' }))) === JSON.stringify({ kind: 'aria', role: 'button', label: 'Buy' }), JSON.stringify(suggestAnchorFor(el('button', { 'data-shim-css': 'shim-x', role: 'button', 'aria-label': 'Buy' }))));
  check('label-like text when no attrs',
    JSON.stringify(suggestAnchorFor(el('button', {}, { text: 'Save changes' }))) === JSON.stringify({ kind: 'text', value: 'Save changes' }), '');
  const positional = suggestAnchorFor(el('span', {}, { text: 'x'.repeat(80) })); // long text, not label-like
  check('positional css path as last resort', positional.kind === 'css' && positional.value.includes('span'), JSON.stringify(positional));
}

function tWitnessRecover() {
  console.log('witnessRecover:');
  // A page (root stub) exposing getElementsByTagName.
  const makeRoot = (byTag) => ({
    getElementsByTagName(tag) { return byTag[tag] || []; },
  });

  const original = el('button', { id: 'fav', 'data-testid': 'favorite' }, { text: 'Favorite' });
  const w = buildWitness(original);

  // The same element after a deploy — id dropped, data-testid kept, class
  // churned, text gained a count. Should still be found (strong unique).
  const moved = el('button', { 'data-testid': 'favorite', class: 'x9' }, { text: 'Favorite (3)' });
  const noise1 = el('button', { 'data-testid': 'subscribe' }, { text: 'Subscribe' });
  const root1 = makeRoot({ button: [noise1, moved] });
  check('finds the unique strong match', witnessRecover(w, root1) === moved, '');

  // No match present → null (don't rebase).
  const root2 = makeRoot({ button: [noise1, el('button', { 'data-testid': 'menu' }, { text: 'Menu' })] });
  check('returns null when target is absent', witnessRecover(w, root2) === null, '');

  // Two equally-strong candidates → ambiguous → null (ask LLM/user, don't
  // guess). Build two elements that both match the witness well.
  const twinA = el('button', { 'data-testid': 'favorite' }, { text: 'Favorite' });
  const twinB = el('button', { 'data-testid': 'favorite' }, { text: 'Favorite' });
  const root3 = makeRoot({ button: [twinA, twinB] });
  check('returns null on ambiguous (2 strong matches)', witnessRecover(w, root3) === null, '');

  // Wrong tag entirely → witness tag gate means no candidates scanned.
  const root4 = makeRoot({ a: [el('a', { 'data-testid': 'favorite' }, { text: 'Favorite' })] });
  check('tag mismatch → null (getElementsByTagName(button) empty)', witnessRecover(w, root4) === null, '');
}

tSuggestRanking();
tWitnessRecover();

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');
