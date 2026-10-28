// Own-DOM guard — the predicate that keeps the engine from ever treating DOM
// it created as a legitimate anchor target. Split out of engine.ts as a leaf
// module: pure, dependency-free, and covered by scripts/engine-own-dom-harness.
//
// Nothing stops a rule's anchor selector from matching DOM the engine itself
// created. `hide`/`restyle`/`reshape`/`reorder` outputs are the resolved SITE
// anchor restamped in place (never a new node), so they're never at risk — but
// a `script`/`replace-root` handler's OUTPUT is new DOM, and an `inline`-
// strategy output carries no marker attribute at all (only `replace-root`
// outputs get `data-shim-mounted`; portal/overlay park inside
// `[data-shim="portal-root"]`, shadow wraps in `[data-shim="shadow-host"]`).
// If a handler's injected output happens to match its own rule's anchor
// selector, the next scan mounts it too: dispatch → insert → new match →
// dispatch, unbounded. engine.ts's module-level `mountedOutputRoots` registry
// is the other half of this guard (the roots passed in below); it stays there
// because dispatch/apply mutate it.

// The selector side of the guard: an anchor candidate already living inside
// engine-owned DOM is never a legitimate target, regardless of the
// module-level registry. Deliberately narrow — `data-shim-css` and
// `data-shim-replace-root` are stamped ON SITE ELEMENTS (tier-1 targets and
// replace-root anchors, respectively) and must NOT make an element
// "shim-owned"; only markers on DOM the engine itself CREATED belong here.
// `data-shim-injected` (inject-element / inject-html roots) is a marker on
// engine-CREATED nodes, so it belongs here — unlike script outputs, inject
// outputs always carry it, giving marker coverage even where the registry
// arm can't reach (a node detached and reattached outside the engine's
// bookkeeping).
const OWN_DOM_SELECTOR = '[data-shim-mounted],[data-shim="portal-root"],[data-shim="shadow-host"],[data-shim="route-host"],[data-shim-injected]';

// O(1) per node: does this node ITSELF carry one of the engine's own-DOM
// markers? (Ancestry is the caller's walk — anchor-change.ts walks to the top
// anyway, so it checks each step with this rather than `closest`.)
export function hasOwnDomMarker(node: unknown): boolean {
  const el = node as { matches?: (sel: string) => boolean };
  return typeof el.matches === 'function' && el.matches(OWN_DOM_SELECTOR);
}

// Pure predicate: true when `el` is inside DOM the engine mounted — either
// because it (or an ancestor) carries one of the engine's own-DOM markers,
// or because it's contained by a registered mounted-output root (the
// `inline`-strategy case, which carries no marker at all). Exported for the
// bare-node harness; both parameters are feature-detected duck types (real
// DOM Elements/Nodes satisfy them trivially) rather than the DOM lib types,
// so a minimal test stub without a full Element/Node implementation still
// type-checks — same trade-off `anchors.ts`'s `AnchorElement` makes.
export function isShimOwnedElement(
  el: { closest?: (sel: string) => unknown },
  // Method-signature syntax (not an arrow-typed property) so TS checks
  // `contains`'s parameter bivariantly: a real DOM `Node.contains(other:
  // Node | null)` satisfies this even though `unknown` is wider than
  // `Node | null` — an arrow-property type would fail that under
  // `strictFunctionTypes`. The harness's duck-typed stubs (`contains(n:
  // unknown)`) satisfy it either way.
  roots: Iterable<{ contains?(n: unknown): boolean }>,
): boolean {
  if (typeof el.closest === 'function' && el.closest(OWN_DOM_SELECTOR)) return true;
  for (const root of roots) {
    if (typeof root.contains === 'function' && root.contains(el)) return true;
  }
  return false;
}

// Which patch owns `el`: the owner recorded for the CLOSEST registered output
// root containing it (the deepest, when one shim's output sits inside
// another's), or null when no registered root contains it. Only the
// registry answers — a marker attribute alone names no owner (it is DOM any
// script can stamp), so marker-only DOM (a route host, a detached-and-
// reattached injected node) reads as unowned here. Duck-typed like
// isShimOwnedElement, for the bare-node harness.
export function closestOutputOwner<R extends { contains?(n: unknown): boolean }>(
  el: unknown,
  owners: Iterable<readonly [R, string]>,
): string | null {
  let best: { root: R; owner: string } | null = null;
  for (const [root, owner] of owners) {
    if (typeof root.contains !== 'function' || !root.contains(el)) continue;
    if (best === null || (typeof best.root.contains === 'function' && best.root.contains(root))) best = { root, owner };
  }
  return best ? best.owner : null;
}
