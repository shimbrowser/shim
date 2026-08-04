// Static lint for an authored spec — catch hallucinated engine features
// before they silently no-op. The authoring model sometimes invents a
// mutation kind or a rule/mutation field (the motivating case: a fabricated
// `cspRelax` directive) and confidently reports success; the engine just
// ignores the unknown thing (engine.js: `console.warn('unknown mutation
// kind')` then no-op). This turns that silent failure into loud feedback:
//
//   - unknown KIND  → error  (the rule does nothing — reject the emit so the
//                             model can't claim a fabricated feature works)
//   - unknown FIELD → warning (ignored by the engine, but surfaced to the
//                             model + chat: probably a typo or an invented
//                             capability the user should hear about)
//
// The allowlists below mirror the spec format (CLAUDE.md §5) and the engine's
// mutation dispatch. Keep them in sync when a real kind/field is added.
//
// `lintSpec`'s input is a genuinely dynamic boundary — it exists to validate
// (possibly malformed/hallucinated) spec JSON, so it can't assume the input
// already conforms to `Spec`/`Rule`/`Mutation`. It takes `unknown` and
// narrows defensively; once a piece of data has been confirmed record-shaped
// it's read through the real patch-engine types.

import type { Spec, Rule, Mutation, AnchorSpec } from '../patch-engine/types';
import { RESHAPE_ALIGN, RESHAPE_JUSTIFY } from '../patch-engine/layout-kinds';

const BUILTIN_KINDS = new Set([
  'hide', 'restyle', 'script', 'remove', 'replace-root', 'mount-route', 'redirect',
  'reorder', 'reshape',
]);
const RULE_KEYS = new Set(['id', 'anchor', 'mutations', 'handlers']);
const ANCHOR_KEYS = new Set(['primary', 'fallbacks', 'iframe', 'witness']);
// Union across kinds: properties (restyle), handler/mount (script,
// replace-root, mount-route), pattern/title (mount-route), from/to/exceptPaths
// (redirect), position/before/after (reorder), layout/direction/columns/rows/
// gap/wrap/align/justify (reshape).
const MUTATION_KEYS = new Set([
  'kind', 'properties', 'handler', 'mount', 'pattern', 'title', 'from', 'to', 'exceptPaths',
  'position', 'before', 'after',
  'layout', 'direction', 'columns', 'rows', 'gap', 'wrap', 'align', 'justify',
]);

// Anchor-quality lint (§8): the model drifts toward positional CSS
// (`:nth-child(3)`) and build-generated classes (`.css-1a2b3c`) — selectors
// that resolve today and die on the next deploy/reorder, turning into
// quarantine → re-anchor churn. Warn on the PRIMARY only: the engine's own
// synthesis legitimately keeps a positional spec as the ladder's last
// fallback, so a positional tail is fine — a positional primary is the smell.
const POSITIONAL_RE = /:(?:nth-child|nth-of-type|nth-last-child|nth-last-of-type|first-child|last-child|first-of-type|last-of-type|only-child|only-of-type)\b/i;
const GENERATED_CLASS_RE = /\.(?:css|jss|jsx|sc|svelte|emotion|chakra)-[A-Za-z0-9_-]+|\.[\w-]*[0-9a-f]{6,}/i;

// Loop-hazard scan (freeze prevention): a handler that creates a
// MutationObserver AND writes DOM can observe its own writes and re-queue
// itself forever — a hard tab freeze (microtasks run before paint). The
// safe pattern always has ≥2 `.disconnect(` calls: the mutate-guard inside
// the callback plus the api.cleanup teardown. Heuristic (comments/strings
// can trip it) — warning, not error, same posture as the api.ai scan.
const OBSERVER_RE = /new\s+(?:window\.)?MutationObserver\b/;
const DOM_WRITE_RE = /\b(appendChild|insertBefore|removeChild|replaceChildren|insertAdjacentHTML|insertAdjacentElement|replaceWith|prepend|append|setAttribute)\s*\(|\.remove\s*\(\s*\)|\binnerHTML\s*=|\btextContent\s*=/;
const DISCONNECT_RE = /\.disconnect\s*\(/g;

// Single source of truth for the observer-loop heuristic itself — both the
// in-spec scan below (rule.handlers, rule-scoped) and the pre-import
// inspector (src/main/shim-inspect.ts, handler-scoped: `exportToShim` strips
// `rule.handlers` into a top-level `handlers` map, so a canonically exported
// `.shim` file has no rule.handlers left for the rule-scoped scan below to
// find) call this rather than each carrying its own copy of the regex logic.
// Returns the warning text (no rule context — callers that have a rule id
// prepend their own `rule "<id>": ` prefix) or null when the pattern looks
// safe. Heuristic, not proof: counting total `.disconnect(` occurrences in
// the source is blind to WHICH observer a given disconnect call belongs to,
// so two independently guard-less observers whose only disconnects are two
// unrelated `api.cleanup` teardown registrations read as "≥2 disconnects,
// looks safe" and stay silent even though both loop forever — an accepted
// false-negative, pinned (not fixed) in scripts/spec-lint-harness.ts.
function observerLoopWarning(handlerName: string, src: string): string | null {
  if (!OBSERVER_RE.test(src) || !DOM_WRITE_RE.test(src)) return null;
  const disconnects = (src.match(DISCONNECT_RE) || []).length;
  if (disconnects >= 2) return null;
  return `handler "${handlerName}" creates a MutationObserver and also writes DOM — if the observer `
    + 'watches DOM the handler mutates, it re-triggers itself in an infinite microtask loop and freezes the page. '
    + 'Either anchor the repeated element itself (the engine dispatches the handler once per matched element and '
    + 'auto-dispatches new ones — no observer needed), or disconnect() before mutating and re-observe() after, '
    + 'plus register observer.disconnect via api.cleanup.';
}

interface LintResult {
  errors: string[];
  warnings: string[];
}

// `mutations` is a reserved bag field for per-patch declarative kinds (§6) —
// not part of the canonical `Spec` shape (registry.ts's bagForUserPatch
// always passes it undefined for user patches today), so it's typed as a
// spec-lint-local extension rather than added to the shared type.
type LintableSpec = Spec & { mutations?: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Shared positional/generated-class checks — used both for rule primaries
// (lintPrimaryAnchor) and for a reorder mutation's relative before/after
// target (lintReorderTarget). `extraNote` lets a caller append
// location-specific guidance (e.g. "this target has no fallback ladder").
function pushPositionalWarning(
  rid: string,
  value: string,
  warnings: string[],
  subject: string,
  extraNote: string,
): void {
  if (!POSITIONAL_RE.test(value)) return;
  warnings.push(
    `rule "${rid}": ${subject} "${value}" is positional — it breaks when the site reorders or `
    + 'inserts siblings, which happens on most deploys. Anchor on WHY this element is the target instead: '
    + `a data-* attribute, aria role/label, or its text.${extraNote}`,
  );
}

function pushGeneratedClassWarning(
  rid: string,
  value: string,
  warnings: string[],
  subject: string,
  extraNote: string,
): void {
  if (!GENERATED_CLASS_RE.test(value)) return;
  warnings.push(
    `rule "${rid}": ${subject} "${value}" uses a build-generated class name — these are rewritten `
    + `on every deploy. Prefer a data-* attribute, aria role/label, text, or a human-named class.${extraNote}`,
  );
}

function lintPrimaryAnchor(rid: string, primary: AnchorSpec | undefined, warnings: string[]): void {
  if (!primary || primary.kind !== 'css' || typeof primary.value !== 'string') return;
  const { value } = primary;
  pushPositionalWarning(rid, value, warnings, 'primary anchor', ' Positional CSS is acceptable only as the last fallback.');
  pushGeneratedClassWarning(rid, value, warnings, 'primary anchor', '');
}

// A reorder mutation's before/after target has NO fallback ladder and NO
// witness — it's a single css/data-attr/aria/text spec resolved fresh every
// scan, with nothing to fall back to and nothing to verify it against. A
// brittle selector here is worse than a brittle primary anchor: it fails
// silently (a downgraded rule-status note, §6/§8) with no self-heal path.
function lintReorderTarget(rid: string, key: 'before' | 'after', target: unknown, warnings: string[]): void {
  if (!isRecord(target) || target.kind !== 'css' || typeof target.value !== 'string') return;
  const { value } = target;
  const extraNote = ` This reorder ${key} target has no fallback ladder or witness recovery — a stale selector fails silently on the next deploy.`;
  pushPositionalWarning(rid, value, warnings, `reorder ${key} target`, extraNote);
  pushGeneratedClassWarning(rid, value, warnings, `reorder ${key} target`, extraNote);
}

const REORDER_POSITIONS = new Set(['first', 'last']);
const RESHAPE_FIELDS = ['layout', 'direction', 'columns', 'rows', 'gap', 'wrap', 'align', 'justify'] as const;

// Malformed layout-kind payloads compile to nothing (layout-kinds.ts returns
// null / drops the field) — the same silent no-op class as an unknown kind,
// so they reject the emit as errors rather than warn.
function lintLayoutMutation(rid: string, mut: Mutation, errors: string[], warnings: string[]): void {
  if (mut.kind === 'reorder') {
    const modes = [mut.position !== undefined, mut.before !== undefined, mut.after !== undefined]
      .filter(Boolean).length;
    if (modes !== 1) {
      errors.push(`rule "${rid}": reorder needs exactly one of "position", "before", "after" (got ${modes}).`);
    }
    if (mut.position !== undefined && typeof mut.position !== 'number'
      && !REORDER_POSITIONS.has(mut.position)) {
      errors.push(`rule "${rid}": reorder position must be "first", "last", or a number (CSS order sort key).`);
    }
    for (const key of ['before', 'after'] as const) {
      const t = mut[key];
      if (t !== undefined && (!isRecord(t) || typeof t.kind !== 'string')) {
        errors.push(`rule "${rid}": reorder ${key} must be an anchor spec ({ "kind": ..., "value": ... }).`);
      } else if (t !== undefined) {
        lintReorderTarget(rid, key, t, warnings);
      }
    }
  }
  if (mut.kind === 'reshape') {
    if (!RESHAPE_FIELDS.some((f) => mut[f] !== undefined)) {
      errors.push(`rule "${rid}": reshape needs at least one of ${RESHAPE_FIELDS.join(', ')}.`);
    }
    if (mut.layout !== undefined && mut.layout !== 'flex' && mut.layout !== 'grid') {
      errors.push(`rule "${rid}": reshape layout must be "flex" or "grid".`);
    }
    if (mut.direction !== undefined && mut.direction !== 'row' && mut.direction !== 'column') {
      errors.push(`rule "${rid}": reshape direction must be "row" or "column" (flex only).`);
    }
    for (const key of ['columns', 'rows'] as const) {
      const v = mut[key];
      if (v !== undefined && typeof v !== 'number' && typeof v !== 'string') {
        errors.push(`rule "${rid}": reshape ${key} must be a number (equal tracks) or a template string.`);
      }
    }
    if (mut.gap !== undefined && typeof mut.gap !== 'string') {
      errors.push(`rule "${rid}": reshape gap must be a CSS length string.`);
    }
    if (mut.wrap !== undefined && typeof mut.wrap !== 'boolean') {
      errors.push(`rule "${rid}": reshape wrap must be a boolean.`);
    }
    if (mut.align !== undefined && (typeof mut.align !== 'string' || !RESHAPE_ALIGN.has(mut.align))) {
      errors.push(`rule "${rid}": reshape align must be one of ${[...RESHAPE_ALIGN].join(', ')}.`);
    }
    if (mut.justify !== undefined && (typeof mut.justify !== 'string' || !RESHAPE_JUSTIFY.has(mut.justify))) {
      errors.push(`rule "${rid}": reshape justify must be one of ${[...RESHAPE_JUSTIFY].join(', ')}.`);
    }
  }
}

function lintSpec(spec: unknown): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Double-cast: `Record<string, unknown>` doesn't structurally overlap
  // `LintableSpec` (its fields are all optional-on-top-of-required-`id`), but
  // this is exactly the dynamic-boundary case the cast pattern is for — the
  // fields are read defensively below, never trusted blind.
  const s: LintableSpec | null = isRecord(spec) ? (spec as unknown as LintableSpec) : null;
  // Per-patch declarative kinds (rare extension point, §6) are valid too.
  const declaredKinds = s && isRecord(s.mutations)
    ? new Set(Object.keys(s.mutations))
    : new Set<string>();

  // Preserve base semantics exactly: iterate spec.rules directly (a truthy
  // non-array — e.g. a hallucinated `"rules": {}` — makes for...of throw, which
  // rejects the emit, the intended anti-hallucination behavior); undefined → [].
  const rulesList = ((s && s.rules) || []) as unknown[];
  for (const ruleValue of rulesList) {
    if (!isRecord(ruleValue)) continue;
    const rule = ruleValue as unknown as Rule;
    const rid = rule.id || '(unnamed)';

    for (const k of Object.keys(ruleValue)) {
      if (!RULE_KEYS.has(k)) {
        warnings.push(
          `rule "${rid}": unknown field "${k}" — not part of the spec format, so the engine ignores it. `
          + 'If you added it expecting an engine capability, that capability does not exist — remove it and use a real mutation kind, or tell the user it is not supported.',
        );
      }
    }

    if (isRecord(rule.anchor)) {
      for (const k of Object.keys(rule.anchor)) {
        if (!ANCHOR_KEYS.has(k)) {
          warnings.push(`rule "${rid}": unknown anchor field "${k}" — ignored by the engine.`);
        }
      }
      lintPrimaryAnchor(rid, rule.anchor.primary, warnings);
    }

    // Same base-preserving iteration as rules above (throw on truthy non-array).
    const mutationsList = (rule.mutations || []) as unknown[];

    // At most one reorder mutation per rule (per-RULE check, not per-mutation):
    // two reorder mutations on the same anchor stamp conflicting order values
    // — the second silently wins or is ignored depending on sheet insertion
    // order, with no lint signal otherwise.
    const reorderCount = mutationsList
      .filter((m) => isRecord(m) && m.kind === 'reorder').length;
    if (reorderCount > 1) {
      errors.push(
        `rule "${rid}": at most one reorder mutation per rule — multiple order stamps on the same `
        + 'elements conflict silently; use a single reorder (or separate rules with position sort keys).',
      );
    }

    for (const mutValue of mutationsList) {
      if (!isRecord(mutValue)) continue;
      const mut = mutValue as unknown as Mutation;
      const { kind } = mut;
      if (!kind) {
        errors.push(`rule "${rid}": a mutation is missing its "kind".`);
        continue;
      }
      if (!BUILTIN_KINDS.has(kind) && !declaredKinds.has(kind)) {
        errors.push(
          `rule "${rid}": unknown mutation kind "${kind}". The engine supports only: ${[...BUILTIN_KINDS].join(', ')}. `
          + 'Do not invent kinds — for custom behavior use "script".',
        );
        continue;
      }
      for (const k of Object.keys(mutValue)) {
        if (!MUTATION_KEYS.has(k)) {
          warnings.push(
            `rule "${rid}": mutation "${kind}" has unknown field "${k}" — ignored by the engine. `
            + 'If you meant to switch on a capability, the engine has no such directive.',
          );
        }
      }
      lintLayoutMutation(rid, mut, errors, warnings);
    }

    // api.ai without the 'ai' permission declared (§19): the call would
    // reject at runtime with a permission error, so the shim ships broken.
    // A WARNING (not error): the source scan is heuristic (comments/strings
    // can false-positive), and the runtime failure is loud + explicable.
    if (isRecord(rule.handlers)) {
      const declared: string[] = s && Array.isArray(s.permissions) ? s.permissions : [];
      if (!declared.includes('ai')) {
        for (const [name, src] of Object.entries(rule.handlers)) {
          if (typeof src === 'string' && /\bapi\s*\.\s*ai\b/.test(src)) {
            warnings.push(
              `rule "${rid}": handler "${name}" calls api.ai but the spec does not declare the "ai" permission — `
              + 'every api.ai call will return { ok: false } until it is declared AND the user grants it. '
              + 'Emit a set-permissions op with ["ai"].',
            );
            break;
          }
        }
      }
    }

    if (isRecord(rule.handlers)) {
      for (const [name, src] of Object.entries(rule.handlers)) {
        if (typeof src !== 'string') continue;
        const warning = observerLoopWarning(name, src);
        if (warning) {
          warnings.push(`rule "${rid}": ${warning}`);
          break;
        }
      }
    }
  }
  return { errors, warnings };
}

// Throw on lint ERRORS (unknown kinds / malformed mutations) — same contract
// as shims.assertHandlersBound, so a bad emit rejects with a clear message in
// the same authoring turn. Warnings don't throw; callers surface them.
function assertNoSpecErrors(spec: unknown): void {
  const { errors } = lintSpec(spec);
  if (errors.length === 0) return;
  const err = new Error(`spec uses unsupported constructs: ${errors.join('; ')}`) as Error & {
    code: string;
    errors: string[];
  };
  err.code = 'unsupported_spec';
  err.errors = errors;
  throw err;
}

export { lintSpec, assertNoSpecErrors, BUILTIN_KINDS, observerLoopWarning };
