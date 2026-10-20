// The one bounded, kind-aware description of what a quarantined rule's
// target looked like — the only form a witness may take on its way into model
// context. A raw witness object never reaches a model (an engine invariant: the
// LLM never authors or sees witnesses); a re-anchor turn still needs a search
// brief, so it gets this instead:
//
//   element  a <h1> element (data-testid="cart") with text "welcome back…"
//   set      ~48 <div> elements sharing data-component-type="s-search-result"…
//
// Works on whatever the event carried (`unknown`): a value that is neither
// shape summarizes to null.

const MAX_ATTRS = 3;
const MAX_VALUE = 40;
const MAX_SUMMARY = 280;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function tagOf(value: Record<string, unknown>): string | null {
  return typeof value.tag === 'string' && /^[a-z][a-z0-9-]*$/i.test(value.tag) ? value.tag.toLowerCase() : null;
}

function attrList(attrs: unknown): string[] {
  if (!isRecord(attrs)) return [];
  const out: string[] = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value !== 'string' || name.startsWith('data-shim')) continue;
    out.push(`${clip(name, MAX_VALUE)}=${JSON.stringify(clip(value, MAX_VALUE))}`);
    if (out.length >= MAX_ATTRS) break;
  }
  return out;
}

function stemOf(value: Record<string, unknown>): string | null {
  return typeof value.textStem === 'string' && value.textStem.trim() ? clip(value.textStem.trim(), MAX_VALUE) : null;
}

/** Whether a fingerprint-shaped value is a set witness (it counts members). */
export function isSetWitnessShape(value: unknown): boolean {
  return isRecord(value) && typeof value.count === 'number' && typeof value.tag === 'string';
}

/** The summary, or null when `expected` is not a fingerprint. */
export function summarizeExpectedTarget(expected: unknown): string | null {
  if (!isRecord(expected)) return null;
  const tag = tagOf(expected);
  if (!tag) return null;
  const attrs = attrList(expected.attrs);
  const stem = stemOf(expected);
  let out: string;
  if (isSetWitnessShape(expected)) {
    const n = Math.max(0, Math.round(expected.count as number));
    const shared: string[] = [...attrs];
    if (stem) shared.push(`text starting "${stem}"`);
    if (typeof expected.parentTag === 'string' && tagOf({ tag: expected.parentTag })) shared.push(`a <${expected.parentTag.toLowerCase()}> parent`);
    out = `~${n} <${tag}> elements sharing ${shared.length ? shared.join(', ') : 'only their tag'}`;
  } else {
    out = `a <${tag}> element`;
    if (attrs.length) out += ` (${attrs.join(', ')})`;
    if (stem) out += ` with text "${stem}…"`;
  }
  return clip(out, MAX_SUMMARY);
}

/** The text stem a re-anchor brief may lead with, or null (sets have none to lead with). */
export function expectedTextStem(expected: unknown): string | null {
  if (!isRecord(expected) || isSetWitnessShape(expected)) return null;
  return stemOf(expected);
}
