// Diagnostic harness for view_page's element-scoped crop geometry
// (packages/core/src/view-crop.ts) — the padding / minimum-size / viewport-clamp
// rules behind the authoring loop's visual-verification screenshots.
// Bare node. Run when touching the crop math:
//
//   node out/packages/core/test/view-crop-harness.js
//
// Invariants under test: the crop always contains the element plus context
// margin, sliver elements widen to a judgeable floor, the rect never
// escapes the viewport, and an off-screen element yields null (view_page
// scrolls a cut-off target in before measuring, so null is left for one
// scrolling can't reach) rather than a degenerate capturePage call.

import { computeCropRect, CROP_PAD, CROP_MIN } from '../src/view-crop';
import type { CropMeasurement } from '../src/view-crop';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

const VP = { vw: 1440, vh: 900 };
const m = (x: number, y: number, w: number, h: number): CropMeasurement => ({ x, y, w, h, ...VP });

function tPadding() {
  console.log('padding + containment:');
  const r = computeCropRect(m(400, 300, 300, 200))!;
  check('crop exists for a mid-viewport element', !!r);
  check('pad applied on all sides', r.x === 400 - CROP_PAD && r.y === 300 - CROP_PAD, JSON.stringify(r));
  check('crop contains element + pad', r.width === 300 + 2 * CROP_PAD && r.height === 200 + 2 * CROP_PAD, JSON.stringify(r));
}

function tSliverFloor() {
  console.log('sliver widening (tiny badge case):');
  const r = computeCropRect(m(600, 400, 20, 20))!;
  check('tiny element widens to the CROP_MIN floor', r.width >= CROP_MIN && r.height >= CROP_MIN, JSON.stringify(r));
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  check('element stays centered in the widened crop', Math.abs(cx - 610) <= 1 && Math.abs(cy - 410) <= 1, `center (${cx}, ${cy})`);
}

function tClamping() {
  console.log('viewport clamping:');
  const corner = computeCropRect(m(0, 0, 50, 50))!;
  check('top-left corner clamps to origin', corner.x === 0 && corner.y === 0, JSON.stringify(corner));
  const edge = computeCropRect(m(1400, 860, 100, 100))!;
  check('bottom-right overflow clamps to viewport', edge.x + edge.width <= VP.vw && edge.y + edge.height <= VP.vh, JSON.stringify(edge));
  const wide = computeCropRect(m(-100, 100, 2000, 100))!;
  check('wider-than-viewport element spans the full width', wide.x === 0 && wide.width === VP.vw, JSON.stringify(wide));
}

function tOffscreen() {
  console.log('off-screen elements:');
  check('element below the fold → null', computeCropRect(m(400, 2000, 300, 200)) === null);
  check('element left of the viewport → null', computeCropRect(m(-500, 300, 300, 200)) === null);
  check('element barely visible at the edge still crops',
    computeCropRect(m(-250, 300, 300, 200)) !== null);
}

tPadding();
tSliverFloor();
tClamping();
tOffscreen();

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
