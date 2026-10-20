// Visible text of an element — the one extraction every text signal in the
// engine shares (text anchors in anchors.ts, witness text stems in
// witness.ts), so "the text of an element" can't mean two different things.
//
// Tags whose textContent is code/markup, not visible page text.
export const NON_VISIBLE_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

// Child-node walk that skips NON_VISIBLE_TEXT_TAGS subtrees at EVERY level.
// Native textContent is not usable because it concatenates script/style
// descendants — live-caught twice on one page for text anchors: (1) an inline
// module script containing a label string, and (2) the engine's OWN tier-1
// sheet in <head>, whose rule tokens embed the rule id ("…-reorder-delta-
// first-…") — so the moment a rule named after its anchor text first stamped,
// <head> (no visible matching descendant to lose the deepest-filter to) became
// a second match and the single-match guard refused every later restamp.
// Element-level tag exclusion alone can't fix the ancestor case; only
// subtree-skipping text extraction can. Witness stems hit the same leak: a
// container with an inline <style> had CSS as its stem.
//
// Shaped as a structural view (not lib.dom's ChildNode) so bare-node harness
// stubs — {nodeType, data} text nodes + stub elements — walk identically;
// cast at the single entry choke point, same idiom as ScanRoot.
interface TextWalkNode {
  nodeType?: number;
  data?: string;
  tagName?: string;
  childNodes?: ArrayLike<TextWalkNode>;
}
//
// `enough` (optional) ends the walk early once the text gathered so far
// suffices — a witness stem needs ~40 chars, and a JS walk of a whole-page
// container per candidate (recovery scans visit every same-tag element) would
// otherwise read the entire subtree just to keep its first line.
export function visibleTextOf(el: Element, enough?: (textSoFar: string) => boolean): string {
  let out = '';
  let stop = false;
  const walk = (node: TextWalkNode): void => {
    for (const child of Array.from(node.childNodes || [])) {
      if (stop) return;
      if (child.nodeType === 3) {
        out += child.data || '';
        if (enough && enough(out)) stop = true;
      } else if (child.nodeType === 1) {
        if (NON_VISIBLE_TEXT_TAGS.has((child.tagName || '').toUpperCase())) continue;
        walk(child);
      }
    }
  };
  walk(el as unknown as TextWalkNode);
  return out;
}
