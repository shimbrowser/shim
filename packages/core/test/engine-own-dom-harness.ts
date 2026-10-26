// Diagnostic harness for the engine's own-DOM guard (packages/core/src/
// engine.ts, `isShimOwnedElement`). Bare node — no DOM, no
// Electron: elements are duck-typed stubs shaped like the subset of
// Element/Node the predicate reads (`closest`, `contains`), the same
// feature-detect style as `AnchorElement` (anchors.ts:38-51). Run when
// touching the guard's predicate or its module-level registry wiring:
//
//   node out/packages/core/test/engine-own-dom-harness.js
//
// What it asserts (the five required stub cases from the task brief):
//   (a) an element contained by a registered mounted-output root is owned
//       (the `inline`-strategy case — no marker attribute at all)
//   (b) an element whose `closest` walk hits `[data-shim-mounted]` is owned
//       (the `replace-root` marker, and by extension portal-root/
//       shadow-host/route-host — all live in the same selector)
//   (c) a plain SITE element carrying `data-shim-css` (a tier-1 target) with
//       empty roots is NOT owned — that marker sits on the site's own
//       anchor, never on engine-created DOM
//   (d) a plain SITE element carrying `data-shim-replace-root` (a
//       replace-root RULE's anchor, not its mounted output) with empty
//       roots is NOT owned — same reasoning, and this is the one the task
//       brief calls out by name as deliberately excluded from the selector
//   (e) a bare stub with no `closest` method at all, empty roots, is NOT
//       owned — feature-detect tolerance, no throw
//
// Also covers (whole-branch review finding, engine.ts `reconcile()`'s
// state-0 recovery arms): the component-identity arm's `matched` (from
// `api.componentId.find(...)`) and the witness-scan arm's `found` (from
// `anchors.witnessRecoverDetail(...).el`) are BOTH guarded with
// `isShimOwnedElement` before either arm calls `emitRebase` — a shim-owned
// candidate is treated as no-match so recovery falls through instead of
// persisting a rebased anchor that points at shim-created DOM. Both values
// are real DOM `Element`s at the call site, which structurally reduce to
// exactly the `{ closest }` shape this harness already stubs — there is no
// arm-specific shape to add. `reconcile()` itself is NOT harnessable here:
// it's an unexported closure inside `applyRule` coupled to `document`,
// `state`, `rule`, the async main-world `componentId` bridge, and
// `emitRebase`'s side effects — pulling it apart to unit-test in isolation
// is a bigger refactor than this guard warrants. `tRecoveryArmCandidates`
// below exercises the exact predicate call both arms make, named for that
// call site, so the coverage claim is explicit rather than implied.

import { isShimOwnedElement } from '../src/engine';
import { closestOutputOwner } from '../src/own-dom';
import * as fs from 'fs';
import * as path from 'path';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

// A minimal element stub: `markers` are the "attributes" this element (or,
// notionally, one of its ancestors) carries. `closest` simulates real DOM
// closest() matching behavior against whatever combined selector the
// predicate actually passes — a substring check against each marker's own
// attribute-name/value fragment. This is a faithful-enough simulation to
// pin the exact selector the implementation uses: if `OWN_DOM_SELECTOR`
// ever grew to include `data-shim-css` or `data-shim-replace-root`, case
// (c)/(d) below would flip to "owned" and fail loudly.
interface StubOpts {
  markers?: string[];
  noClosest?: boolean;
}
function stubEl({ markers = [], noClosest = false }: StubOpts = {}): { closest?: (sel: string) => unknown } {
  if (noClosest) return {};
  return {
    closest(sel: string): unknown {
      return markers.some((m) => sel.includes(m)) ? {} : null;
    },
  };
}

// A minimal root stub: `contains` reports true only for the exact element
// instances registered against it, mirroring `Node.contains`'s identity
// semantics (not a marker/selector check at all — the registry is a plain
// membership set of real output nodes).
function stubRoot(owned: Set<unknown>): { contains: (n: unknown) => boolean } {
  return { contains: (n: unknown) => owned.has(n) };
}

function tContainedByRoot() {
  console.log('\n(a) contained by a registered mounted-output root → owned');
  const el = stubEl();
  const owned = new Set<unknown>([el]);
  const roots = [stubRoot(owned)];
  check('inline-strategy output (no marker at all) is owned via root.contains', isShimOwnedElement(el, roots) === true);

  // A DIFFERENT element, same roots — must NOT be swept in just because
  // *some* root exists.
  const other = stubEl();
  check('an unrelated element is not owned by an unrelated root', isShimOwnedElement(other, roots) === false);
}

function tClosestHitsMounted() {
  console.log('\n(b) closest() hits [data-shim-mounted] → owned');
  const el = stubEl({ markers: ['data-shim-mounted'] });
  check('replace-root mounted output is owned via closest([data-shim-mounted])', isShimOwnedElement(el, []) === true);

  const portal = stubEl({ markers: ['portal-root'] });
  check('portal-root descendant is owned via closest', isShimOwnedElement(portal, []) === true);

  const shadow = stubEl({ markers: ['shadow-host'] });
  check('shadow-host descendant is owned via closest', isShimOwnedElement(shadow, []) === true);

  const route = stubEl({ markers: ['route-host'] });
  check('route-host descendant is owned via closest', isShimOwnedElement(route, []) === true);
}

function tSiteTierOneTargetNotOwned() {
  console.log('\n(c) plain site element with data-shim-css, empty roots → NOT owned');
  // data-shim-css is stamped on the SITE anchor a hide/restyle rule
  // resolved — the resolved TARGET, not anything the engine created. It
  // must never make an element look shim-owned, or a hide/restyle rule
  // would stop being able to re-resolve its own already-tagged anchor on
  // the next scan.
  const el = stubEl({ markers: ['data-shim-css'] });
  check('data-shim-css alone does not make an element shim-owned', isShimOwnedElement(el, []) === false);
}

function tReplaceRootAnchorNotOwned() {
  console.log('\n(d) site element with data-shim-replace-root, empty roots → NOT owned');
  // data-shim-replace-root is stamped on the RULE'S ANCHOR (a site
  // element) by replace-root's own bookkeeping — the anchor whose children
  // get hidden, not the handler's mounted output (which instead gets
  // data-shim-mounted, covered by case (b)). Deliberately excluded from
  // OWN_DOM_SELECTOR: pins the exact distinction the task brief calls out.
  const el = stubEl({ markers: ['data-shim-replace-root'] });
  check('data-shim-replace-root alone does not make an element shim-owned', isShimOwnedElement(el, []) === false);
}

function tNoClosestMethod() {
  console.log('\n(e) bare stub with no closest method, empty roots → NOT owned (no throw)');
  const el = stubEl({ noClosest: true });
  let threw = false;
  let result = true;
  try {
    result = isShimOwnedElement(el, []);
  } catch {
    threw = true;
  }
  check('missing closest() is feature-detected, not called', !threw);
  check('bare stub with no markers and no roots resolves NOT owned', result === false);
}

function tRootsWithoutContains() {
  console.log('\n(extra) a root stub missing contains() is tolerated, not thrown on');
  const el = stubEl();
  let threw = false;
  let result = true;
  try {
    result = isShimOwnedElement(el, [{}]);
  } catch {
    threw = true;
  }
  check('a root without contains() does not throw', !threw);
  check('and does not spuriously mark the element owned', result === false);
}

function tRecoveryArmCandidates() {
  console.log('\n(f) reconcile()\'s recovery-arm candidates: same predicate, named for the call site');
  // Arm 1 (component-identity): `api.componentId.find([...])` returns a
  // unique live Element whose fiber name matches the witness's captured
  // component — exactly the shape a handler's mounted output can produce
  // after a deploy kills the real selector (the fiber tree still reports
  // the captured name; it's just now on DOM the engine created).
  const componentIdMatch = stubEl({ markers: ['data-shim-mounted'] });
  check(
    'a component-identity match inside mounted output is guarded out (arm falls through, not emitRebase)',
    isShimOwnedElement(componentIdMatch, mountedRootsFor()) === true,
  );
  const componentIdRealMatch = stubEl();
  check(
    'a component-identity match on a genuine site element is NOT guarded (arm proceeds to emitRebase)',
    isShimOwnedElement(componentIdRealMatch, mountedRootsFor()) === false,
  );

  // Arm 2 (witness scan): `anchors.witnessRecoverDetail(...).el` walks every
  // live element of the anchor's tag via `getElementsByTagName` — which
  // includes an `inline`-strategy handler output with NO marker attribute
  // at all, only catchable via registry containment.
  const outputNode = stubEl();
  const roots = mountedRootsFor(outputNode);
  check(
    'a witness-scan match that IS a registered inline output is guarded out',
    isShimOwnedElement(outputNode, roots) === true,
  );
  const siteNode = stubEl();
  check(
    'a witness-scan match that is a genuine site element is NOT guarded',
    isShimOwnedElement(siteNode, roots) === false,
  );
}
function mountedRootsFor(...owned: unknown[]): Array<{ contains: (n: unknown) => boolean }> {
  const set = new Set(owned);
  return [stubRoot(set)];
}

// The owner registry (apply-rule.ts `outputOwners`, read through
// `outputOwnerOf`): each mounted output root records the patch it was
// mounted under, and an element's owner is the closest registered root
// containing it — what keeps a session's input to the held shim's own
// controls (another shim's AI button is not the session's to press).
function tOutputOwner() {
  console.log('\n(g) output owner: the closest registered root names the patch');
  const inner = stubEl();
  const outerOnly = stubEl();
  const site = stubEl();
  // Shim B's output sits inside shim A's: the closer root (B) owns `inner`.
  const rootA = stubRoot(new Set<unknown>([inner, outerOnly]));
  const rootB = { contains: (n: unknown) => n === inner || n === rootB };
  const rootAWithB = { contains: (n: unknown) => rootA.contains(n) || n === rootB };
  check('an element in one root is owned by that root\'s patch', closestOutputOwner(outerOnly, [[rootAWithB, 'shim-a'], [rootB, 'shim-b']]) === 'shim-a');
  check('nested roots: the closest (innermost) root wins, whatever the order', closestOutputOwner(inner, [[rootAWithB, 'shim-a'], [rootB, 'shim-b']]) === 'shim-b'
    && closestOutputOwner(inner, [[rootB, 'shim-b'], [rootAWithB, 'shim-a']]) === 'shim-b');
  check('site DOM has no owner', closestOutputOwner(site, [[rootAWithB, 'shim-a'], [rootB, 'shim-b']]) === null);
  check('a marker alone names no owner (marker DOM is spoofable)', closestOutputOwner(stubEl({ markers: ['data-shim-mounted'] }), []) === null);
  check('a root without contains is skipped', closestOutputOwner(inner, [[{}, 'x']]) === null);
  // The registry stays in step with mountedOutputRoots: set on mount (under
  // the spec id), deleted on teardown.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'packages', 'core', 'src', 'apply-rule.ts'), 'utf8');
  check('mountOn records each output root\'s owner as the spec id', /mountedOutputRoots\.add\(o\);\s*outputOwners\.set\(o, spec\.id\);/.test(src));
  check('teardown forgets the owner with the root', /mountedOutputRoots\.delete\(node\);\s*outputOwners\.delete\(node\);/.test(src));
}

tContainedByRoot();
tOutputOwner();
tClosestHitsMounted();
tSiteTierOneTargetNotOwned();
tReplaceRootAnchorNotOwned();
tNoClosestMethod();
tRootsWithoutContains();
tRecoveryArmCandidates();

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');
