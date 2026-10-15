// A shim's `intent` — its distilled statement of purpose (Spec A). The
// normalizer lives in core because the pure delta application (spec-delta.ts,
// `set-intent`) runs it; the browser re-exports it
// alongside its own intent helpers.

// A distilled statement of purpose is a short paragraph, but 600 chars cut real
// intents mid-sentence (e.g. the clickbait-rewriter's) and baked a visible
// "[truncated]" marker into stored data. 2000 comfortably fits a genuine intent
// while staying a trivial per-turn context cost (it leads every authoring /
// re-anchor turn); the marker is now only a backstop for pathological lengths.
export const MAX_INTENT_CHARS = 2000;
const TRUNCATION_MARKER = '… [truncated]';

// Coerce an authored intent value into a stored form. Free prose, so this
// never throws: a non-string or empty value clears the intent (returns
// undefined); an over-long one is truncated with a marker rather than rejected.
export function normalizeIntent(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_INTENT_CHARS) return trimmed;
  let cut = MAX_INTENT_CHARS - TRUNCATION_MARKER.length;
  // If the last kept unit is a high surrogate, its low half was cut off —
  // drop it so we never emit a lone surrogate. This only ever removes a unit,
  // so the length stays within cap.
  const lastCode = trimmed.charCodeAt(cut - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut -= 1;
  return trimmed.slice(0, cut) + TRUNCATION_MARKER;
}
