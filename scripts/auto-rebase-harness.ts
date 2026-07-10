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
//     and that it never anchors to data-shim* engine tokens. This exercises
//     the LADDER HEAD in unverifiable-scope mode; the full ranked/DOM-verified
//     ladder is covered by scripts/anchor-synthesis-harness.js
//   - witnessRecover: finds the unique strong match, refuses when zero or
//     when multiple strong candidates exist (ambiguity → no auto-rebase)

import {
  suggestAnchorFor as _suggestAnchorFor,
  witnessRecover as _witnessRecover,
  witnessRecoverDetail as _witnessRecoverDetail,
} from '../src/patch-engine/anchors';
import { buildWitness } from '../src/patch-engine/witness';

// Harness calls these with stub root/element objects shaped like the subset
// of Document/Element they actually read, and omits the optional `root` arg
// in some calls — cast to any rather than touching anchors.ts.
const suggestAnchorFor: any = _suggestAnchorFor;
const witnessRecover: any = _witnessRecover;
const witnessRecoverDetail: any = _witnessRecoverDetail;

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
  // Stub shaped like the subset of Element buildWitness reads (see comment
  // above), not a real DOM Element — cast at this single choke point
  // rather than widening buildWitness's signature back to `any`.
  return node as unknown as Element;
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

  // Detail form: a refused scan says WHY (surfaced via the quarantine event
  // + diagnostics so failed recoveries are debuggable).
  const d1 = witnessRecoverDetail(w, root1);
  check('detail: success carries el + null reason', d1.el === moved && d1.reason === null, JSON.stringify(d1.reason));
  const d2 = witnessRecoverDetail(w, root2);
  check('detail: absence reason names the miss', d2.el === null && /0 of \d+ <button>/.test(d2.reason), d2.reason);
  const d3 = witnessRecoverDetail(w, root3);
  check('detail: ambiguity reason counts disjoint strong', d3.el === null && /ambiguous — 2 disjoint/.test(d3.reason), d3.reason);
  const d5 = witnessRecoverDetail(null, root1);
  check('detail: no witness → explicit reason', d5.el === null && /no witness/.test(d5.reason), d5.reason);
}

tSuggestRanking();
tWitnessRecover();

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');
