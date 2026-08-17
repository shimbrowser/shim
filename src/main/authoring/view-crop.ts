// Pure crop-rect math for view_page's element-scoped screenshots (§16).
// Separated from author-brokers.ts so the padding / minimum-size / viewport
// clamping rules are bare-node testable (scripts/view-crop-harness.ts) —
// the broker owns the Electron halves (executeJavaScript measurement,
// capturePage) and delegates the geometry here.

// The element's measured viewport rect plus the viewport bounds, all CSS px
// (what getBoundingClientRect + window.inner{Width,Height} report — the same
// DIP space Electron's capturePage rect parameter expects).
export interface CropMeasurement {
  x: number;
  y: number;
  w: number;
  h: number;
  vw: number;
  vh: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Context margin around the target — enough surrounding page that the model
// can judge alignment against neighbors, small enough that the target stays
// the subject of the shot.
export const CROP_PAD = 60;
// Floor per axis. A 20px badge + pad is still a sliver at extreme aspect
// ratios; widening to a judgeable minimum keeps tiny targets legible.
export const CROP_MIN = 200;

// null = the padded crop has no visible intersection with the viewport
// (element scrolled out of view / zero-sized off-screen).
export function computeCropRect(m: CropMeasurement): CropRect | null {
  let x0 = m.x - CROP_PAD;
  let y0 = m.y - CROP_PAD;
  let x1 = m.x + m.w + CROP_PAD;
  let y1 = m.y + m.h + CROP_PAD;
  if (x1 - x0 < CROP_MIN) { const grow = (CROP_MIN - (x1 - x0)) / 2; x0 -= grow; x1 += grow; }
  if (y1 - y0 < CROP_MIN) { const grow = (CROP_MIN - (y1 - y0)) / 2; y0 -= grow; y1 += grow; }
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(m.vw, Math.ceil(x1));
  y1 = Math.min(m.vh, Math.ceil(y1));
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
