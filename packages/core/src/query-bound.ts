// Bounds query_page's output. Every host's candidates are plain JSON in rank
// order, but a site page's carry markup, class lists, ancestry and computed
// style, and on a heavy page (long utility-class lists, deep wrappers) 25 of
// them run to tens of thousands of characters on one line — past what an
// agent's tool output takes, so the whole result is lost. This cuts each
// long string field to an excerpt with a marker, then keeps candidates in
// rank order while the serialized result fits a total budget, and says what
// it cut. Pure, so a harness pins it (test/query-bound-harness.ts).

/** Longest a candidate's string field runs before it is cut to an excerpt. */
export const QUERY_FIELD_MAX = 300;
/** Budget, in characters of JSON, for the candidates of one query_page result. */
export const QUERY_TOTAL_MAX = 16_000;

// Fields kept whole: a cut selector or anchor value would be wrong, not
// short. They still count toward the total.
const KEEP_WHOLE = new Set(['selector', 'value']);

export interface BoundedQuery {
  candidates: unknown[];
  /** Present when anything was cut: what, and how to read more. */
  truncated?: string;
}

export interface QueryBoundLimits {
  fieldMax?: number;
  totalMax?: number;
}

const CUT_MARK = /…\[\+\d+ chars\]$/;

function cutString(s: string, max: number, counts: { fields: number }): string {
  if (s.length <= max) return s;
  // Already an excerpt this cut made: leave it (and count it, so a second
  // pass still reports the cut).
  const mark = CUT_MARK.exec(s);
  if (mark && mark.index <= max) { counts.fields++; return s; }
  counts.fields++;
  return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

function cutValue(v: unknown, max: number, counts: { fields: number }, key: string | null): unknown {
  if (typeof v === 'string') return key !== null && KEEP_WHOLE.has(key) ? v : cutString(v, max, counts);
  if (Array.isArray(v)) return v.map((item) => cutValue(item, max, counts, null));
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(v)) out[k] = cutValue(item, max, counts, k);
    return out;
  }
  return v;
}

/**
 * query_page's candidates, bounded: long string fields cut to `fieldMax`
 * with a "…[+N chars]" marker, then as many candidates, in rank order, as fit
 * `totalMax` characters of JSON (always at least the top one). Idempotent on
 * its own output.
 */
export function boundQueryCandidates(candidates: readonly unknown[], limits: QueryBoundLimits = {}): BoundedQuery {
  const fieldMax = limits.fieldMax ?? QUERY_FIELD_MAX;
  const totalMax = limits.totalMax ?? QUERY_TOTAL_MAX;
  const counts = { fields: 0 };
  const kept: unknown[] = [];
  let size = 2; // the array's brackets
  for (const c of candidates) {
    const cut = cutValue(c, fieldMax, counts, null);
    const len = (JSON.stringify(cut) ?? 'null').length + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && size + len > totalMax) break;
    kept.push(cut);
    size += len;
  }
  const dropped = candidates.length - kept.length;
  if (counts.fields === 0 && dropped === 0) return { candidates: kept };
  const parts: string[] = [];
  if (dropped > 0) parts.push(`showing the top ${kept.length} of ${candidates.length} candidates (the rest dropped to keep the result under ${totalMax} characters)`);
  if (counts.fields > 0) parts.push(`${counts.fields} long field${counts.fields === 1 ? '' : 's'} cut to ${fieldMax} characters (marked "…[+N chars]")`);
  return {
    candidates: kept,
    truncated: `${parts.join('; ')} — narrow the description, or inspect_element a candidate's selector for more of it`,
  };
}
