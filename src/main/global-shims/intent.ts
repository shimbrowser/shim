// Pure helpers for a shim's `intent` — its distilled statement of purpose.
// No db / Electron imports (type-only): safe to import from bare-node harnesses.

import type { Spec } from '@shimbrowser/core/types';

// The normalizer is pure delta application's (`set-intent`), so it lives in
// @shimbrowser/core; re-exported here for the browser's existing callers.
export { MAX_INTENT_CHARS, normalizeIntent } from '@shimbrowser/core/intent';

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
