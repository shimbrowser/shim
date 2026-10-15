// Diagnostic harness for the auto-rebase building blocks:
// anchors.suggestAnchorFor (synthesize a fresh anchor for a found element)
// and anchors.witnessRecover (find a drifted element by its witness). Bare
// node — no DOM, no Electron: elements are stubs shaped like the subset of
// the Element interface these functions read. Run when touching the rebase
// synthesis/recovery logic:
//
//   node out/packages/core/test/auto-rebase-harness.js
//
// Covers:
//   - suggestAnchorFor ranking (id > site data-* > aria > text > positional),
//     and that it never anchors to data-shim* engine tokens. This exercises
//     the LADDER HEAD in unverifiable-scope mode; the full ranked/DOM-verified
//     ladder is covered by packages/core/test/anchor-synthesis-harness.js
//   - witnessRecover: finds the unique strong match, refuses when zero or
//     when multiple strong candidates exist (ambiguity → no auto-rebase)

import {
  suggestAnchorFor,
  witnessRecover,
  witnessRecoverDetail,
} from '../src/anchors';
import { buildWitness } from '../src/witness';

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

// Element stub. Supports the methods the rebase code calls: getAttribute,
// attributes, textContent, children, parentElement, tagName.
function el(tag: string, attrs: Record<string, string> = {}, { text = '', children = [], parent = null }: ElOpts = {}): Element {
  const node = {
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    children,
    parentElement: parent,
    getAttribute(n: string) {
      const f = this.attributes.find((a) => a.name === n);
      return f ? f.value : null;
    },
    get textContent() { return text + children.map((c) => c.textContent).join(''); },
  };
  for (const c of children) (c as unknown as { parentElement: Element }).parentElement = node as unknown as Element;
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
  // long text, not label-like — this fixed stub always falls through to the
  // css-path rung, so the `!` is safe (proven by the hardcoded input above,
  // not assumed).
  const positional = suggestAnchorFor(el('span', {}, { text: 'x'.repeat(80) }))!;
  check('positional css path as last resort', positional.kind === 'css' && positional.value!.includes('span'), JSON.stringify(positional));
}

function tWitnessRecover() {
  console.log('witnessRecover:');
  // A page (root stub) exposing getElementsByTagName.
  const makeRoot = (byTag: Record<string, Element[]>) => ({
    getElementsByTagName(tag: string): Element[] { return byTag[tag] || []; },
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
  check('detail: absence reason names the miss', d2.el === null && /0 of \d+ <button>/.test(String(d2.reason)), d2.reason);
  const d3 = witnessRecoverDetail(w, root3);
  check('detail: ambiguity reason counts disjoint strong', d3.el === null && /ambiguous — 2 disjoint/.test(String(d3.reason)), d3.reason);
  const d5 = witnessRecoverDetail(null, root1);
  check('detail: no witness → explicit reason', d5.el === null && /no witness/.test(String(d5.reason)), d5.reason);

  // Engine-injected candidates (the shim-owned DOM back door) must never be
  // recovery targets — an injected node that happens to satisfy the witness
  // (tag/attrs/text-stem/parent/child-shape) would otherwise silently
  // re-anchor the rule onto the engine's own output.
  //
  // Two witness-satisfying elements, one stamped `data-shim-injected`:
  // recovery must pick the clean one and must NOT treat the injected one as
  // a second strong match (i.e. no "ambiguous — 2 disjoint" reason).
  const cleanTwin = el('button', { 'data-testid': 'favorite' }, { text: 'Favorite' });
  const injectedTwin = el('button', { 'data-testid': 'favorite', 'data-shim-injected': 'tok1' }, { text: 'Favorite' });
  const root5 = makeRoot({ button: [injectedTwin, cleanTwin] });
  check('picks the clean element over an injected witness-satisfying twin', witnessRecover(w, root5) === cleanTwin, '');
  const d6 = witnessRecoverDetail(w, root5);
  check('does not report ambiguity from the injected twin', d6.el === cleanTwin && d6.reason === null, JSON.stringify(d6));

  // The ONLY witness-satisfying element is engine-injected → recovery
  // refuses outright rather than re-anchoring onto engine output.
  const onlyInjected = el('button', { 'data-testid': 'favorite', 'data-shim-injected': 'tok2' }, { text: 'Favorite' });
  const root6 = makeRoot({ button: [noise1, onlyInjected] });
  check('refuses when the only witness-satisfying element is engine-injected', witnessRecover(w, root6) === null, '');
  const d7 = witnessRecoverDetail(w, root6);
  check('detail: injected-only miss reads as an ordinary no-match, not a mis-attach', d7.el === null && /0 of \d+ <button>/.test(String(d7.reason)), d7.reason);
}

tSuggestRanking();
tWitnessRecover();

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');
