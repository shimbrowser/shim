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

function lintPrimaryAnchor(rid, primary, warnings) {
  if (!primary || primary.kind !== 'css' || typeof primary.value !== 'string') return;
  if (POSITIONAL_RE.test(primary.value)) {
    warnings.push(
      `rule "${rid}": primary anchor "${primary.value}" is positional — it breaks when the site reorders or `
      + 'inserts siblings, which happens on most deploys. Anchor on WHY this element is the target instead: '
      + 'a data-* attribute, aria role/label, or its text. Positional CSS is acceptable only as the last fallback.',
    );
  }
  if (GENERATED_CLASS_RE.test(primary.value)) {
    warnings.push(
      `rule "${rid}": primary anchor "${primary.value}" uses a build-generated class name — these are rewritten `
      + 'on every deploy. Prefer a data-* attribute, aria role/label, text, or a human-named class.',
    );
  }
}

function lintSpec(spec) {
  const errors = [];
  const warnings = [];
  // Per-patch declarative kinds (rare extension point, §6) are valid too.
  const declaredKinds = spec && spec.mutations && typeof spec.mutations === 'object'
    ? new Set(Object.keys(spec.mutations))
    : new Set();

  for (const rule of (spec && spec.rules) || []) {
    if (!rule || typeof rule !== 'object') continue;
    const rid = rule.id || '(unnamed)';

    for (const k of Object.keys(rule)) {
      if (!RULE_KEYS.has(k)) {
        warnings.push(
          `rule "${rid}": unknown field "${k}" — not part of the spec format, so the engine ignores it. `
          + 'If you added it expecting an engine capability, that capability does not exist — remove it and use a real mutation kind, or tell the user it is not supported.',
        );
      }
    }

    if (rule.anchor && typeof rule.anchor === 'object') {
      for (const k of Object.keys(rule.anchor)) {
        if (!ANCHOR_KEYS.has(k)) {
          warnings.push(`rule "${rid}": unknown anchor field "${k}" — ignored by the engine.`);
        }
      }
      lintPrimaryAnchor(rid, rule.anchor.primary, warnings);
    }

    for (const mut of rule.mutations || []) {
      if (!mut || typeof mut !== 'object') continue;
      const kind = mut.kind;
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
      for (const k of Object.keys(mut)) {
        if (!MUTATION_KEYS.has(k)) {
          warnings.push(
            `rule "${rid}": mutation "${kind}" has unknown field "${k}" — ignored by the engine. `
            + 'If you meant to switch on a capability, the engine has no such directive.',
          );
        }
      }
    }
  }
  return { errors, warnings };
}

// Throw on lint ERRORS (unknown kinds / malformed mutations) — same contract
// as shims.assertHandlersBound, so a bad emit rejects with a clear message in
// the same authoring turn. Warnings don't throw; callers surface them.
function assertNoSpecErrors(spec) {
  const { errors } = lintSpec(spec);
  if (errors.length === 0) return;
  const err = new Error(`spec uses unsupported constructs: ${errors.join('; ')}`);
  err.code = 'unsupported_spec';
  err.errors = errors;
  throw err;
}

module.exports = { lintSpec, assertNoSpecErrors, BUILTIN_KINDS };
