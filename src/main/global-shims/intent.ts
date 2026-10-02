// Pure helpers for a shim's `intent` — its distilled statement of purpose.
// No db / Electron imports (type-only): safe to import from bare-node harnesses.

import type { Spec } from '@shimbrowser/core/types';

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

// Render the intent as a context block for an authoring / re-anchor turn.
// Returns '' when there is no intent so callers can push unconditionally or
// guard on a falsy result (mirrors llms-txt's formatSiteContextBlock).
export function formatIntentBlock(intent: string | undefined): string {
  if (!intent) return '';
  return `# Intent (what this shim is for)\n${intent}`;
}

// Gate for the manual "refresh intent" action (the Haiku distillation, run
// on-demand from the settings panel). Mirrors the auto-fill gate in
// authoring/commit.ts: refreshable iff the shim is NON-global and has ≥1 rule.
// A global shim's shared spec has no rules to distill — its intent is preserved
// shared identity, not derived — so refresh would clobber it with nothing;
// `global` is checked by strict equality (a malformed `global: "yes"` reads
// non-global, matching isGlobalSpec). A rule-less shim has nothing to distill.
export function canRefreshIntent(spec: Spec | undefined): boolean {
  if (!spec) return false;
  if (spec.global === true) return false;
  return Array.isArray(spec.rules) && spec.rules.length > 0;
}
