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

const BUILTIN_KINDS = new Set([
  'hide', 'restyle', 'script', 'remove', 'replace-root', 'mount-route', 'redirect',
]);
const RULE_KEYS = new Set(['id', 'anchor', 'mutations', 'handlers']);
const ANCHOR_KEYS = new Set(['primary', 'fallbacks', 'iframe', 'witness']);
// Union across kinds: properties (restyle), handler/mount (script,
// replace-root, mount-route), pattern/title (mount-route), from/to/exceptPaths
// (redirect).
const MUTATION_KEYS = new Set([
  'kind', 'properties', 'handler', 'mount', 'pattern', 'title', 'from', 'to', 'exceptPaths',
]);

// Anchor-quality lint (§8): the model drifts toward positional CSS
// (`:nth-child(3)`) and build-generated classes (`.css-1a2b3c`) — selectors
// that resolve today and die on the next deploy/reorder, turning into
// quarantine → re-anchor churn. Warn on the PRIMARY only: the engine's own
// synthesis legitimately keeps a positional spec as the ladder's last
// fallback, so a positional tail is fine — a positional primary is the smell.
const POSITIONAL_RE = /:(?:nth-child|nth-of-type|nth-last-child|nth-last-of-type|first-child|last-child|first-of-type|last-of-type|only-child|only-of-type)\b/i;
const GENERATED_CLASS_RE = /\.(?:css|jss|jsx|sc|svelte|emotion|chakra)-[A-Za-z0-9_-]+|\.[\w-]*[0-9a-f]{6,}/i;

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

function lintPrimaryAnchor(rid: string, primary: AnchorSpec | undefined, warnings: string[]): void {
  if (!primary || primary.kind !== 'css' || typeof primary.value !== 'string') return;
  const { value } = primary;
  if (POSITIONAL_RE.test(value)) {
    warnings.push(
      `rule "${rid}": primary anchor "${value}" is positional — it breaks when the site reorders or `
      + 'inserts siblings, which happens on most deploys. Anchor on WHY this element is the target instead: '
      + 'a data-* attribute, aria role/label, or its text. Positional CSS is acceptable only as the last fallback.',
    );
  }
  if (GENERATED_CLASS_RE.test(value)) {
    warnings.push(
      `rule "${rid}": primary anchor "${value}" uses a build-generated class name — these are rewritten `
      + 'on every deploy. Prefer a data-* attribute, aria role/label, text, or a human-named class.',
    );
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

export { lintSpec, assertNoSpecErrors, BUILTIN_KINDS };
