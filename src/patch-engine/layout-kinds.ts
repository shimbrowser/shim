// Pure compile + precondition logic for the Tier-1 layout kinds — `reorder`
// and `reshape` (CLAUDE.md §6). Sugar + apply-time feedback: each kind
// compiles deterministically to a Tier-1 CSS body (engine.ts injects it via
// the shared token machinery), and the precondition evaluators produce
// diagnostics (`rule-status` note field) when the compiled CSS cannot take
// effect. DOM walking stays in engine.ts; everything here is bare-node
// testable (scripts/layout-kinds-harness.js).
import type { Mutation } from './types';

// Relative reorder stamps every child of the shared parent; a virtualized
// list would mean thousands of rules for nothing (its DOM order is
// synthetic anyway), so refuse past this and let the note explain.
const REORDER_SIBLING_CAP = 100;

// position mode only: "first"/"last" are the dominant intents; a raw number
// is a CSS `order` sort key for multi-element arrangements. Relative
// (before/after) compiles to null — the engine's restamp path owns it.
function compileReorderCss(mut: Mutation): string | null {
  if (mut.before || mut.after) return null;
  const pos = mut.position;
  const order = pos === 'first' ? -9999 : pos === 'last' ? 9999 : typeof pos === 'number' ? pos : null;
  if (order === null) return null;
  return `order: ${order} !important;`;
}

const RESHAPE_ALIGN = new Set(['start', 'center', 'end', 'stretch']);
const RESHAPE_JUSTIFY = new Set(['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly']);

// number → shrinkable equal tracks (minmax(0,·) so content can't blow the
// track wider); string → verbatim template.
function trackTemplate(v: number | string): string {
  return typeof v === 'number' ? `repeat(${v}, minmax(0, 1fr))` : v;
}

function compileReshapeCss(mut: Mutation): string | null {
  const decls: string[] = [];
  if (mut.layout === 'flex' || mut.layout === 'grid') decls.push(`display: ${mut.layout}`);
  // direction is flex-only: mapping it to grid-auto-flow would quietly mean
  // something different, so with layout:"grid" it's refused here and the
  // precondition note surfaces it.
  if ((mut.direction === 'row' || mut.direction === 'column') && mut.layout !== 'grid') {
    decls.push(`flex-direction: ${mut.direction}`);
  }
  if (mut.columns !== undefined) decls.push(`grid-template-columns: ${trackTemplate(mut.columns)}`);
  if (mut.rows !== undefined) decls.push(`grid-template-rows: ${trackTemplate(mut.rows)}`);
  if (typeof mut.gap === 'string') decls.push(`gap: ${mut.gap}`);
  if (typeof mut.wrap === 'boolean') decls.push(`flex-wrap: ${mut.wrap ? 'wrap' : 'nowrap'}`);
  if (typeof mut.align === 'string' && RESHAPE_ALIGN.has(mut.align)) decls.push(`align-items: ${mut.align}`);
  if (typeof mut.justify === 'string' && RESHAPE_JUSTIFY.has(mut.justify)) decls.push(`justify-content: ${mut.justify}`);
  if (!decls.length) return null;
  return decls.map((d) => `${d} !important;`).join(' ');
}

// Desired sibling sequence for relative reorder: `children` (DOM order) with
// `anchor` re-seated adjacent to `target`. Null when the inputs don't form a
// valid move (engine treats null as no-op). Generic so the harness can use
// plain strings; the engine passes Elements.
function desiredSequence<T>(children: T[], anchor: T, target: T, mode: 'before' | 'after'): T[] | null {
  if (anchor === target) return null;
  if (!children.includes(anchor) || !children.includes(target)) return null;
  const rest = children.filter((c) => c !== anchor);
  const at = rest.indexOf(target);
  const idx = mode === 'before' ? at : at + 1;
  return [...rest.slice(0, idx), anchor, ...rest.slice(idx)];
}

const ORDER_CONTAINERS = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);

// Notes are diagnostics for the authoring loop, never behavior changes.
// `parentDisplay` = computed display of the anchor's parent; null when no
// parent resolved (rule-no-match covers that case, so no note).
function reorderNote(parentDisplay: string | null): string | null {
  if (parentDisplay === null || ORDER_CONTAINERS.has(parentDisplay)) return null;
  return `reorder: parent has display:${parentDisplay} — CSS order has no effect; reshape the parent to flex/grid first`;
}

function reshapeNote(mut: Mutation, resolvedDisplay: string | null): string | null {
  const notes: string[] = [];
  if ((mut.columns !== undefined || mut.rows !== undefined)
    && (resolvedDisplay === 'flex' || resolvedDisplay === 'inline-flex')) {
    notes.push('reshape: columns/rows given but the element resolves to display:flex — grid templates have no effect; set layout:"grid" or drop them');
  }
  if (mut.direction !== undefined && (resolvedDisplay === 'grid' || resolvedDisplay === 'inline-grid')) {
    notes.push('reshape: direction is flex-only and the element resolves to display:grid — use columns/rows to shape a grid');
  }
  return notes.length ? notes.join('; ') : null;
}

export {
  compileReorderCss, compileReshapeCss, desiredSequence,
  reorderNote, reshapeNote, REORDER_SIBLING_CAP,
  RESHAPE_ALIGN, RESHAPE_JUSTIFY,
};
