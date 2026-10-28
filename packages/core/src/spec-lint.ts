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
// The allowlists below mirror the spec format and the engine's
// mutation dispatch. Keep them in sync when a real kind/field is added.
//
// `lintSpec`'s input is a genuinely dynamic boundary — it exists to validate
// (possibly malformed/hallucinated) spec JSON, so it can't assume the input
// already conforms to `Spec`/`Rule`/`Mutation`. It takes `unknown` and
// narrows defensively; once a piece of data has been confirmed record-shaped
// it's read through the real @shimbrowser/core types.

//
// Lives in @shimbrowser/core (spec-lint is public) so the
// Shim browser, the MCP server and a headless host all lint with one copy.
// Node-free like the rest of core: the transform / wrap syntax check uses
// `syntaxProbe` (syntax-probe.ts), which gives vm.Script's diagnostics
// without `vm`.

import { referencesApiAi, apiDbConnectionNames } from './capability-refs';
import type { Spec, Rule, Mutation, AnchorSpec } from './types';
import { RESHAPE_ALIGN, RESHAPE_JUSTIFY } from './layout-kinds';
import {
  validateInjectTree, scanHtmlForActiveContent, INJECT_PLACEMENTS, INJECT_HTML_MAX_CHARS,
} from './inject-kinds';
import { validateRewriteMutation, detectTransformForm } from './rewrite-response';
import { validateInterceptMutation } from './intercept';
import { syntaxProbe } from './syntax-probe';
import { expressionToModule, handlerModuleProblem } from './handler-source';
import { ENGINE_MANAGED_ANCHOR_KEYS } from './managed-anchor';

// A transform / wrap is kept by transformLiteral only if it evaluates to a
// function; anything else parses fine and then leaves the rule silently
// inactive (the wrapper skips non-functions). Two shapes reach it: CJS
// source (`module.exports = …` — what an export writes and an import
// carries; without a trailing `;` the dual-form probe calls it 'expr') and a
// bare function expression (the authoring convention). Static only — lint
// runs on import content, which must never be executed, and core has no
// parser dependency — so this rejects what can never work (a module that
// never touches `module`, a literal export, a literal expression) and lets
// anything dynamic through: transformLiteral's fault isolation keeps a bad
// one to its own rule.
const MODULE_EXPORTS_RE = /^\s*module\.exports\s*=/;
const NOT_A_FUNCTION_EXPORT = 'is module-form source that does not assign a function to module.exports, so the rule would never run. '
  + 'Write it as `module.exports = function (…) { … };` (or a bare function expression).';

// Shared tail of the transform / wrap check: null when the bound source is
// usable, otherwise the reason it is not.
function boundSourceProblem(source: string): string | null {
  const syntax = detectTransformForm(source, syntaxProbe);
  if (syntax.form === null) return `does not parse as JavaScript: ${syntax.error}`;
  if (syntax.form === 'module' || MODULE_EXPORTS_RE.test(source)) {
    return handlerModuleProblem(source) === null ? null : NOT_A_FUNCTION_EXPORT;
  }
  // An expression is a function unless it is a literal; wrapped as a module
  // it gets handlerModuleProblem's literal-export check.
  if (handlerModuleProblem(expressionToModule(source)) !== null) {
    return 'does not evaluate to a function, so the rule would never run. Write it as a function expression: `function (…) { … }`.';
  }
  return null;
}

const BUILTIN_KINDS = new Set([
  'hide', 'restyle', 'script', 'remove', 'replace-root', 'mount-route', 'redirect',
  'reorder', 'reshape', 'inject-element', 'inject-html', 'rewrite-response', 'intercept',
]);
const RULE_KEYS = new Set(['id', 'anchor', 'mutations', 'handlers']);
// Mirrors the Shim browser's DB_ENGINES.
// A local copy, not an import: this file stays a pure, dependency-free leaf
// like the rest of its allowlists (keep in sync when a real engine is added —
// same "mirror the spec format" contract the header comment describes).
// Redundant with connections.ts's own validateConnectionsDecl (which commit
// also runs, and which throws with the identical bad-engine wording) — this
// is deliberately cheap, same-turn feedback so the model sees the rejection
// before the commit round-trip.
const CONNECTION_ENGINES = new Set(['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite-remote', 'supabase']);
const ANCHOR_KEYS = new Set<string>(['primary', 'fallbacks', 'iframe', 'cardinality', ...ENGINE_MANAGED_ANCHOR_KEYS]);
// anchor.cardinality: the only authored value. 'many' marks an anchor meant
// to match a set (every row, every card) — never fingerprinted as one element.
const ANCHOR_CARDINALITIES = new Set(['many']);
// Union across kinds: properties (restyle), handler/mount (script,
// replace-root, mount-route), pattern/title (mount-route), from/to/exceptPaths
// (redirect), position/before/after (reorder), layout/direction/columns/rows/
// gap/wrap/align/justify (reshape — note "wrap" here is reshape's flex-wrap
// boolean, a DIFFERENT field from intercept's wrap handler name below; same
// key name, two kinds, no collision since MUTATION_KEYS is just an allowlist
// of field NAMES, not a per-kind schema), element/html/placement
// (inject-element, inject-html), endpoint/transform (rewrite-response),
// module/symbol/wrap (intercept).
const MUTATION_KEYS = new Set([
  'kind', 'properties', 'handler', 'mount', 'pattern', 'title', 'from', 'to', 'exceptPaths',
  'position', 'before', 'after',
  'layout', 'direction', 'columns', 'rows', 'gap', 'wrap', 'align', 'justify',
  'element', 'html', 'placement',
  'endpoint', 'transform',
  'module', 'symbol',
]);

// Anchor-quality lint: the model drifts toward positional CSS
// (`:nth-child(3)`) and build-generated classes (`.css-1a2b3c`) — selectors
// that resolve today and die on the next deploy/reorder, turning into
// quarantine → re-anchor churn. Warn on the PRIMARY only: the engine's own
// synthesis legitimately keeps a positional spec as the ladder's last
// fallback, so a positional tail is fine — a positional primary is the smell.
const POSITIONAL_RE = /:(?:nth-child|nth-of-type|nth-last-child|nth-last-of-type|first-child|last-child|first-of-type|last-of-type|only-child|only-of-type)\b/i;
const GENERATED_CLASS_RE = /\.(?:css|jss|jsx|sc|svelte|emotion|chakra)-[A-Za-z0-9_-]+|\.[\w-]*[0-9a-f]{6,}/i;

// Media-hide lint (belt for the engine's apply-time note): a hide/remove on the
// main <video>/<audio> element blanks the whole player — audio keeps playing,
// picture goes blank. Live-caught: a ".video-stream" hide meant for Shorts nuked
// YouTube's main player. Matches a `video`/`audio` TYPE selector (NOT a
// `.video-*` utility class — those are legitimately hidden all the time) or a
// well-known player class. The robust check is the runtime rule-status note,
// which knows the actually-matched element; this warns statically for the
// obvious cases the selector text already reveals.
// A `video`/`audio` TYPE selector (boundary-guarded so `.video-card` etc. are
// NOT matched), OR a known player CLASS token. The class alternatives require a
// leading dot AND a token boundary (`(?![\w-])`) so `.video-stream-thumbnail`,
// `.video-js-poster`, `[data-id="video-stream-preview"]` — which contain but
// don't SELECT the player class — don't draw a false warning.
const MEDIA_SELECTOR_RE = /(?:^|[\s>+~,(])(?:video|audio)(?=$|[\s>+~,.:#[)])|\.(?:video-stream|html5-main-video|html5-video|vjs-tech|jw-video|video-js)(?![\w-])/i;

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
// inspector (in the Shim browser, handler-scoped: `exportToShim` strips
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
// false-negative, pinned (not fixed) in packages/core/test/spec-lint-harness.ts.
function observerLoopWarning(handlerName: string, src: string): string | null {
  if (!OBSERVER_RE.test(src) || !DOM_WRITE_RE.test(src)) return null;
  const disconnects = (src.match(DISCONNECT_RE) || []).length;
  if (disconnects >= 2) return null;
  if (childListObserverWithAttributeWrites(src)) return null;
  return `handler "${handlerName}" creates a MutationObserver and also writes DOM — if the observer `
    + 'watches DOM the handler mutates, it re-triggers itself in an infinite microtask loop and freezes the page. '
    + 'To react when the site changes what is inside the anchor, use api.onAnchorChange(fn) instead of an observer '
    + '(the engine batches it per frame and never reports the callback\'s own writes back to it). '
    + 'To catch new repeated elements, anchor the element itself (the engine dispatches the handler once per match '
    + 'and auto-dispatches new ones). If you still need an observer, disconnect() before mutating and re-observe() '
    + 'after, plus register observer.disconnect via api.cleanup.';
}

// The one observer shape that provably can't see its own writes, recognized
// fail-closed: EVERY `.observe(` call passes an object literal whose keys are
// only `childList` / `subtree` with literal booleans (no spreads, computed keys
// or variables), AND every DOM write DOM_WRITE_RE recognizes is a
// `setAttribute(` — an attribute write is invisible to a childList observer.
// Inherits DOM_WRITE_RE's blind spots (it doesn't know e.g. `before(` or
// `outerHTML =`), so a childList write it can't see stays unseen here too —
// the same posture as the rest of this heuristic. Live-caught false positives:
// a wikipedia table filter and a facebook sponsored-unit hider, both a
// childList-only observer with setAttribute writes.
const DOM_WRITE_ALL_RE = new RegExp(DOM_WRITE_RE.source, 'g');
const OBSERVE_CALL_RE = /\.observe\s*\(/g;
const CHILDLIST_ONLY_OPTIONS_RE = /^\{\s*(?:(?:childList|subtree)\s*:\s*(?:true|false)\s*(?:,\s*)?)*\}$/;

// The top-level arguments of the call whose `(` sits just before `start`,
// or null when the source ends first. Skips string/template literals and
// nested brackets.
function callArguments(src: string, start: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = start; i < src.length; i++) {
    const ch = src.charAt(i);
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length && src.charAt(j) !== ch) j += src.charAt(j) === '\\' ? 2 : 1;
      current += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === ')') {
      if (depth === 0) { args.push(current.trim()); return args; }
      depth -= 1;
    } else if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  return null;
}

function childListObserverWithAttributeWrites(src: string): boolean {
  for (const m of src.matchAll(DOM_WRITE_ALL_RE)) {
    if (m[1] !== 'setAttribute') return false;
  }
  let calls = 0;
  for (const m of src.matchAll(OBSERVE_CALL_RE)) {
    calls += 1;
    const args = callArguments(src, (m.index ?? 0) + m[0].length);
    const options = args?.[1];
    if (args === null || args.length !== 2 || options === undefined || !CHILDLIST_ONLY_OPTIONS_RE.test(options)) return false;
  }
  return calls > 0;
}

export interface LintResult {
  errors: string[];
  warnings: string[];
}

// `mutations` is a reserved bag field for per-patch declarative kinds —
// not part of the canonical `Spec` shape (registry.ts's bagForUserPatch
// always passes it undefined for user patches today), so it's typed as a
// spec-lint-local extension rather than added to the shared type. `handlers`
// is the import-carried top-level handler map (shims.ts's `SpecWithHandlers`
// — populated when a `.shim` import hasn't folded handlers back onto
// individual rules yet); same rationale for staying a local extension.
type LintableSpec = Spec & { mutations?: Record<string, unknown>; handlers?: Record<string, unknown> };

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
// silently (a downgraded rule-status note) with no self-heal path.
function lintReorderTarget(rid: string, key: 'before' | 'after', target: unknown, warnings: string[]): void {
  if (!isRecord(target) || target.kind !== 'css' || typeof target.value !== 'string') return;
  const { value } = target;
  const extraNote = ` This reorder ${key} target has no fallback ladder or witness recovery — a stale selector fails silently on the next deploy.`;
  pushPositionalWarning(rid, value, warnings, `reorder ${key} target`, extraNote);
  pushGeneratedClassWarning(rid, value, warnings, `reorder ${key} target`, extraNote);
}

// A hide/remove rule whose CSS anchor (primary OR any fallback) targets the main
// media element blanks the whole player — audio keeps playing, picture goes
// blank. WARNING, not error (the robust check is the engine's apply-time
// rule-status note, which knows the actually-matched element; this is the
// static belt for the selectors that reveal the mistake in their text).
function lintMediaHideRule(rid: string, rule: Rule, mutationsList: unknown[], warnings: string[]): void {
  const hidesOrRemoves = mutationsList.some(
    (m) => isRecord(m) && (m.kind === 'hide' || m.kind === 'remove'),
  );
  if (!hidesOrRemoves || !isRecord(rule.anchor)) return;
  const { anchor } = rule;
  const specs: unknown[] = [
    anchor.primary,
    ...(Array.isArray(anchor.fallbacks) ? anchor.fallbacks : []),
  ];
  for (const spec of specs) {
    if (!isRecord(spec) || spec.kind !== 'css' || typeof spec.value !== 'string') continue;
    if (!MEDIA_SELECTOR_RE.test(spec.value)) continue;
    warnings.push(
      `rule "${rid}": hide/remove anchor "${spec.value}" targets a media element `
      + '(<video>/<audio> or a main-player class) — this blanks the whole player (audio may keep '
      + 'playing, picture goes blank). If you meant to hide an overlay, control, or thumbnail, '
      + 'anchor on that specific element instead.',
    );
    return; // one warning per rule is enough
  }
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

// Inject kinds: payload-shape problems are ERRORS (a malformed tree is
// a silent no-op otherwise); strippable content in inject-html is a WARNING
// (the runtime strip is the belt — the model should hear it before apply).
// inject-element's tree is inspectable, so active content there is an ERROR
// at emit rather than a runtime strip.
function lintInjectMutation(rid: string, mut: Mutation, errors: string[], warnings: string[]): void {
  if (mut.kind !== 'inject-element' && mut.kind !== 'inject-html') return;
  if (mut.placement !== undefined && !INJECT_PLACEMENTS.has(mut.placement)) {
    errors.push(`rule "${rid}": placement "${String(mut.placement)}" — must be one of before, after, prepend, append`);
  }
  if (mut.kind === 'inject-element') {
    if (mut.html !== undefined) {
      errors.push(`rule "${rid}": inject-element takes "element", not "html" (use inject-html for raw markup)`);
    }
    if (mut.element === undefined) {
      errors.push(`rule "${rid}": inject-element requires an "element" node tree`);
      return;
    }
    for (const p of validateInjectTree(mut.element)) errors.push(`rule "${rid}": ${p}`);
    return;
  }
  if (mut.element !== undefined) {
    errors.push(`rule "${rid}": inject-html takes "html", not "element" (use inject-element for a node tree)`);
  }
  if (typeof mut.html !== 'string' || !mut.html.trim()) {
    errors.push(`rule "${rid}": inject-html requires an "html" string`);
    return;
  }
  if (mut.html.length > INJECT_HTML_MAX_CHARS) {
    errors.push(`rule "${rid}": inject-html is ${mut.html.length} chars (max ${INJECT_HTML_MAX_CHARS}) — that much markup belongs in a script handler or replace-root`);
  }
  for (const found of scanHtmlForActiveContent(mut.html)) {
    warnings.push(`rule "${rid}": ${found} — it will be stripped at apply time; inject kinds are static-only, use a script handler for behavior`);
  }
}

// Main-world source heuristics, shared across the two kinds whose handler-
// like code runs in the page's MAIN world rather than the isolated world
// every other handler kind gets: a rewrite-response `transform` and an
// intercept `wrap`. `api.*` doesn't exist in that world for either kind, so
// MAIN_WORLD_API_RE backs a warning in both `lintRewriteMutation` and
// `lintInterceptMutation` below. MAIN_WORLD_DOM_RE stays REWRITE-ONLY: a
// rewrite transform is meant to be a pure data function (DOM access there is
// meaningless — the transform never touches a page context, and DOM work
// belongs in a `script` handler), but an intercept wrap runs legitimately IN
// that same main world by design, so touching `document`/`window` from one
// isn't the same smell. REWRITE_ASYNC_RE is also rewrite-only — a rewrite
// transform must be synchronous (nothing awaits it), but a wrap's replacement
// function may legitimately be async (it's just a function the page calls;
// the page decides whether to await its result). Source-text heuristics, same
// posture as the api.ai / observer-loop scans below (comments/strings can
// false-positive) — warnings, not errors, since a runtime miss here either
// ships the original body untouched (rewrite) or throws at wrap-apply time,
// which the intercept infra already catches and falls back from (never a
// broken page either way).
const MAIN_WORLD_API_RE = /\bapi\s*\./;
const REWRITE_ASYNC_RE = /\basync\b|\bawait\b/;
const MAIN_WORLD_DOM_RE = /\b(?:document|window)\s*\./;

// `api.db.connection("<name>")` and `api.ai` scans live in
// capability-refs.ts (shared with the browser's composition emit lint) — same
// source-text-heuristic posture, warnings only.

// rewrite-response. Payload
// shape errors delegate to `validateRewriteMutation` (packages/core/src/
// rewrite-response.ts) rather than re-deriving them here — one source of
// truth for what a valid endpoint/transform payload looks like, shared with
// the runtime table builder (`collectRewriteEntries`).
//
// The transform-name BINDING check lives here, and only here. It does NOT
// mirror `shims.ts`'s `assertHandlersBound` (which would be the obvious
// "existing binding authority" to defer to) because that function is
// hard-coded to `kind === 'script'` — it doesn't even cover `replace-root` /
// `mount-route`, which share the exact same `.handler` field, let alone a new
// kind's `.transform` field. Rather than bolt a second, differently-shaped
// check onto a commit-time-only function outside spec-lint's own file (and
// risk drifting from it), spec-lint is the sole authority for whether a
// `transform` name resolves — there is nowhere else `transform` binding is
// (or should be) checked.
function lintRewriteMutation(
  rid: string,
  mut: Mutation,
  rule: { handlers?: Record<string, unknown> },
  errors: string[],
  warnings: string[],
): void {
  if (mut.kind !== 'rewrite-response') return;
  // `endpoint`/`transform` aren't on the shared `Mutation` type (they're
  // narrow to this one kind) — read them off the raw record, same dynamic-
  // boundary posture `validateRewriteMutation` itself takes.
  const raw = mut as unknown as Record<string, unknown>;

  const { errors: rewriteErrors } = validateRewriteMutation(raw);
  for (const e of rewriteErrors) errors.push(`rule "${rid}": ${e}`);

  const transformName = typeof raw.transform === 'string' ? raw.transform : undefined;
  if (!transformName) return; // validateRewriteMutation already flagged the missing/malformed name

  const source = rule.handlers && typeof rule.handlers[transformName] === 'string'
    ? (rule.handlers[transformName] as string)
    : undefined;
  if (source === undefined) {
    errors.push(
      `rule "${rid}": transform "${transformName}" is not bound — it must be a key in this rule's `
      + '"handlers" or the patch-level handler set. Emit the handler source alongside the rule.',
    );
    return;
  }

  // Syntax-check the bound source itself: a malformed
  // transform (e.g. a missing brace) used to pass lint/commit untouched,
  // then poison rewrite-install.ts's ONE shared generated script at
  // install time — one bad rule's syntax error killed every rewrite rule
  // on the host. Rejecting it here, at emit/commit/import (every path runs
  // `assertNoSpecErrors`), closes that at the source.
  const problem = boundSourceProblem(source);
  if (problem !== null) {
    errors.push(`rule "${rid}": transform "${transformName}" ${problem}`);
    return;
  }

  if (MAIN_WORLD_API_RE.test(source)) {
    warnings.push(`rule "${rid}": transform "${transformName}" — transform runs in the page's main world — api.* does not exist there.`);
  }
  if (REWRITE_ASYNC_RE.test(source)) {
    warnings.push(`rule "${rid}": transform "${transformName}" — transform must be synchronous — async transforms are not supported.`);
  }
  if (MAIN_WORLD_DOM_RE.test(source)) {
    warnings.push(`rule "${rid}": transform "${transformName}" — transform should be a pure data function — DOM access is a script-handler job.`);
  }
}

// intercept. Structural copy of
// `lintRewriteMutation` immediately above — same three jobs, same order:
// delegate payload shape to `validateInterceptMutation` (packages/core/src/
// intercept.ts, the one source of truth shared with the runtime table
// builder `collectInterceptEntries`), resolve+bind the handler name (here
// `wrap` instead of `transform`) against inline `rule.handlers` then the
// spec-level handler set — the SAME resolution order
// `collectInterceptEntries` uses, and the same "spec-lint is the sole
// binding authority" rationale as `lintRewriteMutation`'s comment above (no
// other function checks whether a `wrap` name resolves) — then syntax-check
// the bound source so one bad wrap can't poison intercept-install.ts's
// shared generated wrapper script for every other intercept rule on the
// host, the same Fix-1a rationale `lintRewriteMutation` documents.
//
// One deliberate asymmetry from `lintRewriteMutation`: no `REWRITE_ASYNC_RE`
// check here. A rewrite transform is a synchronous pure function by
// contract; a wrap's REPLACEMENT function is just a function the page ends
// up calling in the original's place, and the page may legitimately expect
// (or not care) whether it returns a promise — flagging async as wrong would
// be flagging a valid pattern.
function lintInterceptMutation(
  rid: string,
  mut: Mutation,
  rule: { handlers?: Record<string, unknown> },
  errors: string[],
  warnings: string[],
): void {
  if (mut.kind !== 'intercept') return;
  // `module`/`symbol`/`wrap` aren't on the shared `Mutation` type (narrow to
  // this one kind) — read them off the raw record, same dynamic-boundary
  // posture `lintRewriteMutation` takes for `endpoint`/`transform`.
  const raw = mut as unknown as Record<string, unknown>;

  const { errors: interceptErrors } = validateInterceptMutation(raw);
  for (const e of interceptErrors) errors.push(`rule "${rid}": ${e}`);

  const wrapName = typeof raw.wrap === 'string' ? raw.wrap : undefined;
  // No wrap name: either an expose-only mutation (module-level, api.modules.
  // invoke gate — nothing to bind or syntax-check) or `validateInterceptMutation`
  // already flagged a malformed `wrap` field above. Either way, done.
  if (!wrapName) return;

  const source = rule.handlers && typeof rule.handlers[wrapName] === 'string'
    ? (rule.handlers[wrapName] as string)
    : undefined;
  if (source === undefined) {
    errors.push(
      `rule "${rid}": wrap "${wrapName}" is not bound — it must be a key in this rule's `
      + '"handlers" or the patch-level handler set. Emit the handler source alongside the rule.',
    );
    return;
  }

  const problem = boundSourceProblem(source);
  if (problem !== null) {
    errors.push(`rule "${rid}": wrap "${wrapName}" ${problem}`);
    return;
  }

  if (MAIN_WORLD_API_RE.test(source)) {
    warnings.push(`rule "${rid}": wrap "${wrapName}" — the wrap runs in the page's main world, where api.* and the isolated world don't exist.`);
  }
}

// Handler names are authored rule-local but stored and shipped by NAME alone
// (patch_files, the `.shim` file's `handlers` map, a promoted global impl):
// shims.extractHandlers flattens every rule's handlers into one map, so two
// rules defining the same name with DIFFERENT source leave only the later
// rule's source in it. The running shim hides this — the engine prefers a
// rule's own inline source — but export strips rule-local handlers, so the
// exported file runs the later rule's code for both. Identical source under
// one name loses nothing and is allowed.
//
// A name-keyed map held beside the rules is a definition too, and the one that
// WINS over a rule's own when stored: a rule redefining one of its names runs
// its inline source here and the map's source after an export. Two such maps
// exist — the spec-level `handlers` (extractHandlers) and the sources a caller
// holds outside the spec, a `.shim` file's top-level `handlers` (import writes
// it to patch_files as-is).
function lintHandlerNameCollisions(
  rulesList: unknown[],
  specHandlers: unknown,
  carriedHandlers: unknown,
  errors: string[],
): void {
  interface Definition { where: string; ruleId: string | null; module: string; refFields: string[] }
  const definitions = new Map<string, Definition[]>();
  const define = (name: string, def: Definition) => {
    const seen = definitions.get(name);
    if (seen) seen.push(def);
    else definitions.set(name, [def]);
  };
  for (const ruleValue of rulesList) {
    if (!isRecord(ruleValue) || !isRecord(ruleValue.handlers)) continue;
    const rid = typeof ruleValue.id === 'string' && ruleValue.id ? ruleValue.id : '(unnamed)';
    for (const [name, src] of Object.entries(ruleValue.handlers)) {
      if (typeof src !== 'string') continue;
      define(name, {
        where: `rule "${rid}"`,
        ruleId: rid,
        // A rule-local handler is a bare function expression; this is the
        // module form extractHandlers stores it in.
        module: canonicalModule(expressionToModule(src)),
        refFields: handlerRefFields(ruleValue.mutations, name),
      });
    }
  }
  const maps: Array<[unknown, string]> = [
    [specHandlers, 'the spec-level "handlers" map'],
    [carriedHandlers, 'the file\'s "handlers" map'],
  ];
  for (const [map, where] of maps) {
    if (!isRecord(map)) continue;
    for (const [name, src] of Object.entries(map)) {
      if (typeof src !== 'string') continue;
      // Already in module form.
      define(name, { where, ruleId: null, module: canonicalModule(src), refFields: [] });
    }
  }
  for (const [name, defs] of definitions) {
    const [first] = defs;
    if (!first || defs.every((d) => d.module === first.module)) continue;
    const places = defs.map((d) => d.where).join(', ');
    // Name the field that actually holds the reference: telling the model to
    // set "handler" on a rewrite-response or intercept mutation would add an
    // ignored field and leave the real reference pointing at the old name.
    const used = [...new Set(defs.flatMap((d) => d.refFields))];
    const fields = (used.length ? used : [...HANDLER_REF_FIELDS]).map((f) => `"${f}"`).join(' / ');
    const exampleRule = defs.find((d) => d.ruleId !== null)?.ruleId ?? 'a';
    errors.push(
      `handler "${name}" is defined with different source in ${places}. `
      + 'A shim keeps ONE source per handler name, so only one of these would survive an export. '
      + `Give each rule's handler its own name (e.g. "${name}" → "${name}${toPascalCase(exampleRule)}") and update the mutation field that names it (${fields}) to match — `
      + 'or, if they are meant to share one handler, make the source identical.',
    );
  }
}

// Two module sources that differ only in surrounding whitespace or trailing
// semicolons store the same handler.
function canonicalModule(moduleSource: string): string {
  return moduleSource.trim().replace(/[;\s]+$/, '');
}

// The mutation fields that reference a handler by name: `handler` (script,
// replace-root, mount-route), `transform` (rewrite-response), `wrap`
// (intercept).
const HANDLER_REF_FIELDS = ['handler', 'transform', 'wrap'] as const;

// Which of those fields, on this rule's mutations, name `handlerName`.
function handlerRefFields(mutations: unknown, handlerName: string): string[] {
  if (!Array.isArray(mutations)) return [];
  const found = new Set<string>();
  for (const mut of mutations) {
    if (!isRecord(mut)) continue;
    for (const field of HANDLER_REF_FIELDS) {
      if (mut[field] === handlerName) found.add(field);
    }
  }
  return [...found];
}

function toPascalCase(value: string): string {
  const word = value.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return word || 'A';
}

// `carriedHandlers`: handler sources the caller holds OUTSIDE the spec (a
// `.shim` file's top-level `handlers` map) — same role as
// shims.assertHandlersBound's extraDefinedSources. Read by the handler-name
// collision check only; every other check sees exactly what it always has.
function lintSpec(spec: unknown, carriedHandlers?: unknown): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Double-cast: `Record<string, unknown>` doesn't structurally overlap
  // `LintableSpec` (its fields are all optional-on-top-of-required-`id`), but
  // this is exactly the dynamic-boundary case the cast pattern is for — the
  // fields are read defensively below, never trusted blind.
  const s: LintableSpec | null = isRecord(spec) ? (spec as unknown as LintableSpec) : null;
  // Per-patch declarative kinds (rare extension point) are valid too.
  const declaredKinds = s && isRecord(s.mutations)
    ? new Set(Object.keys(s.mutations))
    : new Set<string>();

  // Declared remote connections. Spec-level,
  // not per-rule — computed once, same as declaredKinds above.
  //   - engine-enum ERROR: cheap same-turn feedback for an unknown engine,
  //     redundant with (but earlier than) commit's validateConnectionsDecl.
  //     Only fires when `engine` is actually a string that isn't a known
  //     engine — a missing/wrong-typed engine is left to the full validator's
  //     complete problem list rather than duplicated here.
  //   - declaredConnectionNames feeds the api.db.connection(...) scan inside
  //     the rule loop below.
  const declaredConnectionNames = new Set<string>();
  if (s && Array.isArray(s.connections)) {
    s.connections.forEach((c, i) => {
      if (!isRecord(c)) return;
      if (typeof c.name === 'string') declaredConnectionNames.add(c.name);
      if (typeof c.engine === 'string' && !CONNECTION_ENGINES.has(c.engine)) {
        errors.push(
          `connections[${i}]: unknown engine "${c.engine}". Must be one of ${[...CONNECTION_ENGINES].join('|')}.`,
        );
      }
      // supabase-with-no-nested-tables WARNING, not an error: unlike the SQL
      // engines, a supabase connection with no `storage.tables` is a
      // legitimate shape — it's exactly what pointing at an existing
      // Supabase project through the paste door looks like (there is
      // nothing to provision; declarative-additive migrations never apply
      // to it). But it's worth
      // flagging: with no declared tables the connection has no
      // declared-table allowlist (B.1a) — every table on the project is
      // reachable through it, not just the ones the shim's own schema
      // names. Fires only for a real `engine === "supabase"` row; a missing/
      // wrong-typed engine already gets its own feedback elsewhere.
      if (c.engine === 'supabase') {
        const storage = isRecord(c.storage) ? c.storage : null;
        const tables = storage && Array.isArray(storage.tables) ? storage.tables : [];
        if (tables.length === 0) {
          const label = typeof c.name === 'string' ? c.name : `[${i}]`;
          warnings.push(
            `connections[${i}]: supabase connection "${label}" declares no nested storage.tables. `
            + 'That is only correct when pointing at an existing Supabase project via the paste door — '
            + "there's nothing to provision. Without a declared table set, the declared-table allowlist "
            + 'stays inactive and every table on the project is reachable, not just the ones this shim uses.',
          );
        }
      }
    });
  }

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
      const cardinality: unknown = rule.anchor.cardinality;
      if (cardinality !== undefined && (typeof cardinality !== 'string' || !ANCHOR_CARDINALITIES.has(cardinality))) {
        errors.push(`rule "${rid}": anchor "cardinality" must be "many" (an anchor meant to match a set of elements) or absent — got ${JSON.stringify(cardinality)}`);
      }
    }

    // Same base-preserving iteration as rules above (throw on truthy non-array).
    const mutationsList = (rule.mutations || []) as unknown[];

    lintMediaHideRule(rid, rule, mutationsList, warnings);

    // The "patch-level handler set" a rewrite-response transform / intercept
    // wrap may resolve through, alongside this rule's own `handlers` — merged
    // once per rule (not per mutation) since it's the same scope for every
    // mutation in the rule. Lowest to highest precedence: the caller-carried
    // map (a `.shim` file's top-level `handlers` — export strips both
    // rule.handlers and spec.handlers, so on import this is the ONLY place a
    // transform/wrap source lives; it lands in patch_files, which is what the
    // runtime bag resolves through), then `s.handlers`, then rule.handlers —
    // the same extraDefinedSources → spec.handlers → rule.handlers order
    // shims' findUnboundScriptHandlers uses for script handlers. Precedence
    // only matters for binding here: a name defined with DIFFERENT source in
    // two of these places is still rejected by lintHandlerNameCollisions.
    const handlerScope: { handlers: Record<string, unknown> } = {
      handlers: {
        ...(isRecord(carriedHandlers) ? carriedHandlers : {}),
        ...(s && isRecord(s.handlers) ? s.handlers : {}),
        ...(isRecord(rule.handlers) ? rule.handlers : {}),
      },
    };

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
      lintInjectMutation(rid, mut, errors, warnings);
      lintRewriteMutation(rid, mut, handlerScope, errors, warnings);
      lintInterceptMutation(rid, mut, handlerScope, errors, warnings);
    }

    // api.ai without the 'ai' permission declared: the call would
    // reject at runtime with a permission error, so the shim ships broken.
    // A WARNING (not error): the source scan is heuristic (comments/strings
    // can false-positive), and the runtime failure is loud + explicable.
    if (isRecord(rule.handlers)) {
      const declared: string[] = s && Array.isArray(s.permissions) ? s.permissions : [];
      if (!declared.includes('ai')) {
        for (const [name, src] of Object.entries(rule.handlers)) {
          if (typeof src === 'string' && referencesApiAi(src)) {
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

    // api.db.connection("x") referencing an undeclared connection name: the call would resolve { ok: false, error:
    // "not-declared" } at runtime, so the shim ships broken against a name
    // that's either a typo or a connection the model forgot to declare. A
    // WARNING, not an error — same heuristic-source-scan posture as the
    // api.ai check above (comments/strings can false-positive).
    if (isRecord(rule.handlers)) {
      for (const [name, src] of Object.entries(rule.handlers)) {
        if (typeof src !== 'string') continue;
        for (const connName of apiDbConnectionNames(src)) {
          if (!declaredConnectionNames.has(connName)) {
            warnings.push(
              `rule "${rid}": handler "${name}" calls api.db.connection("${connName}") but "${connName}" is not `
              + 'declared in spec.connections — the call will resolve { ok: false, error: "not-declared" } until '
              + 'it is. Emit a set-connections op adding it, or fix the name if this was a typo.',
            );
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
  lintHandlerNameCollisions(rulesList, s ? s.handlers : undefined, carriedHandlers, errors);
  return { errors, warnings };
}

// Throw on lint ERRORS (unknown kinds / malformed mutations) — same contract
// as shims.assertHandlersBound, so a bad emit rejects with a clear message in
// the same authoring turn. Warnings don't throw; callers surface them.
function assertNoSpecErrors(spec: unknown, carriedHandlers?: unknown): void {
  const { errors } = lintSpec(spec, carriedHandlers);
  if (errors.length === 0) return;
  const err = new Error(`spec uses unsupported constructs: ${errors.join('; ')}`) as Error & {
    code: string;
    errors: string[];
  };
  err.code = 'unsupported_spec';
  err.errors = errors;
  throw err;
}

export { lintSpec, assertNoSpecErrors, BUILTIN_KINDS, observerLoopWarning, canonicalModule, HANDLER_REF_FIELDS };
