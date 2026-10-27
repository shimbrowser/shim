// rewrite-response — Tier-5 JSON response transforms (narrow slice).
// This module is
// PURE / Electron-free, mirroring the `redirect` mutation's shape (non-DOM
// rule, table + registry, conditional install) and `component-id.ts`'s
// main-world-helper-injection pattern (a function is written as real,
// type-checked TypeScript, then crossed into the page's main world via
// `.toString()` at runtime — never a hand-maintained string literal).
//
// A rewrite-response rule wraps `window.fetch` / `XMLHttpRequest` in the
// page's MAIN world (not the isolated world the engine runs in) so it can
// intercept same-registrable-domain JSON responses before the page's own JS
// reads them, and hand them through a user-authored `transform(json, ctx)`.
// Everything below is either:
//   - pure data-shaping (validate / collect / serialize a token table), or
//   - a STRING BUILDER for the main-world wrapper, where two pieces
//     (`matchSerializedTokens`, `hostInScope`) are themselves real functions
//     stringified via `.toString()` — see the "self-contained" note on each.
//
// Wiring (main-process IPC, page-preload injection, spec-lint hookup) is a
// later task; this file only produces the table/matcher/wrapper-builder
// primitives and has zero Electron/DOM dependencies, so it is bare-node
// testable end-to-end (a bare-node harness), including
// running the built wrapper source in a `vm` sandbox. `detectTransformForm`
// (below) follows the same discipline for a THIRD piece — transform-source
// syntax detection — by taking its `vm.Script`-backed compile probe as a
// parameter rather than importing `vm` itself.

import * as routeMatch from './route-match';
import type { Token } from './route-match';
import { handlerExpressionSource } from './handler-source';

// The shape of `mutation.endpoint` on a `rewrite-response` mutation (design
// doc "Spec shape"). Declared here for downstream consumers (the `Mutation`
// type extension + spec-lint land in later tasks); this module itself only
// ever sees `endpoint` as `unknown` and narrows it defensively — dynamic
// input (possibly hallucinated/malformed spec JSON) never gets trusted as
// this shape without re-checking each field.
export interface RewriteEndpoint {
  method?: string;
  path: string;
}

// route-match's `Token` flattened into one shape with every field optional —
// this is what actually crosses process/world boundaries as JSON (a
// discriminated union round-trips through JSON fine at the VALUE level, but a
// flat shape is simpler for `matchSerializedTokens`, which has to reconstruct
// it from plain objects on the other side of a `JSON.parse`).
export interface SerializedToken {
  type: 'literal' | 'param' | 'wildcard';
  value?: string;
  name?: string;
  optional?: boolean;
}

// One compiled rewrite rule, ready to ride an IPC payload / be embedded in
// generated main-world source. `key` is stable across a table rebuild as long
// as the rule's mutation doesn't move within `rule.mutations` — used both as
// the transforms-object key in the generated wrapper source and as the
// per-rule stats key the wrapper stamps back for apply-time feedback.
export interface RewriteEntry {
  key: string; // `${specId}/${ruleId}:${mutationIndex}`
  specId: string;
  ruleId: string;
  method: string | null; // uppercased; null = any method
  toks: SerializedToken[];
  hasWildcard: boolean;
  transformSource: string; // verbatim handler source (bare-expression or CJS module form)
}

// The per-host table handed to the main-world wrapper: every rewrite rule
// live for the current page's registrable domain, plus that domain string
// itself (computed main-side once so the in-page scope check is a cheap
// suffix match — see `hostInScope`).
export interface RewriteTablePayload {
  regDomain: string;
  entries: RewriteEntry[];
  // Every shim id on the host in chain order (ascending priority), including
  // shims with no rewrite rules yet, so an authoring preview of a shim's
  // first rewrite can take that shim's slot (`mergePreviewEntries`). Stays
  // on the isolated side: the wrapper's table carries only regDomain+entries.
  specOrder?: string[];
}

// A transform handler's storage form — same split `script` handlers use:
// the LLM emits a bare function EXPRESSION at `rule.handlers[name]`; an
// imported/exported shim's handler travels as a full CJS MODULE source
// (`module.exports = ...`). `buildWrapperSrc`'s caller decides which form a
// given source string is in (its own concern — this module doesn't sniff).
export type TransformForm = 'expr' | 'module';

// Result of one `tryCompile` probe inside `detectTransformForm`, below.
export interface CompileAttempt {
  ok: boolean;
  error?: string;
}

// A source-parsing probe, INJECTED by the caller: this module stays
// vm/Node-free (bare-node testable with zero Electron process), so the
// actual parse lives with each real caller instead — spec-lint.ts
// (authoring/commit-time syntax check) passes core's Node-free
// `syntaxProbe` (syntax-probe.ts) and the browser's rewrite-install.ts
// (document-start install-time filter) its own vm.Script-backed one; the two
// give identical diagnostics (syntax-probe-harness). That keeps the real
// expr-then-module DETECTION ALGORITHM (`detectTransformForm` itself) in
// exactly one place shared by both, rather than reimplemented per caller.
export type CompileProbe = (code: string) => CompileAttempt;

export type DetectedForm = { form: TransformForm } | { form: null; error: string };

// Detect whether `src` is a bare function EXPRESSION (the LLM's
// `rule.handlers[name]` convention — wrapped in parens so it parses as an
// expression rather than a statement list) or a full CJS MODULE source (an
// imported/exported shim's `module.exports = ...` convention) — or NEITHER,
// i.e. genuinely malformed source. The motivating bug this closes: a naive
// "try expr, anything else is module form" detector never actually verified
// the module-form probe, so a missing brace (or any unparsable garbage)
// silently defaulted to 'module' and shipped, unchecked, into
// `buildWrapperSrc`'s ONE shared generated script — one bad transform's
// syntax error failed the whole script's parse, killing every rewrite rule
// on the host. Expression form is tried first: a source that
// parses as a bare expression is never ALSO meaningfully module source (the
// only overlap is a lone function expression, which the module-form probe
// would also accept as a harmless no-op expression STATEMENT — trying expr
// first and returning immediately on success is the correct precedence, not
// an arbitrary tie-break). Returns `{ form: null, error }` only when BOTH
// probes fail, with the FIRST (expr) probe's error message, since that's
// the form most transform sources are actually written in.
export function detectTransformForm(src: string, tryCompile: CompileProbe): DetectedForm {
  const expr = tryCompile(handlerExpressionSource(src));
  if (expr.ok) return { form: 'expr' };
  const mod = tryCompile(src);
  if (mod.ok) {
    // Module source must also parse where it actually runs: inside
    // transformLiteral's `(function (module, exports) { … })` wrapper. A
    // top-level `const module = …` / `let exports` is fine on its own but a
    // parse-time redeclaration error there — and that literal shares ONE
    // generated install script with every other rule on the host, where a
    // SyntaxError can't be caught by the literal's own try.
    const wrapped = tryCompile(transformLiteral(src, 'module'));
    if (wrapped.ok) return { form: 'module' };
    return { form: null, error: wrapped.error ?? 'does not parse inside the module wrapper' };
  }
  return { form: null, error: expr.error ?? mod.error ?? 'does not parse as JavaScript' };
}

// Last-two-labels registrable domain — same imprecision as
// `deploy-id.ts`'s `sameRegistrableDomain`
// (no Public Suffix List; `a.co.uk` and `b.co.uk` read as the same site).
// Computed main-side (once, per host) so the in-page scope check
// (`hostInScope`, below) is a cheap string-suffix comparison with no PSL
// logic shipped into the page.
export function registrableDomainOf(host: string): string {
  const h = String(host || '').toLowerCase();
  return h.split('.').slice(-2).join('.');
}

// SELF-CONTAINED — stringified via `.toString()` into the main-world wrapper
// (buildInfraSrc, below), the same discipline as component-id.ts's
// `componentScore` (packages/core/src/component-id.ts:76-87): no references to
// anything outside this function body — no module-level helper, no closure
// variable, nothing but arguments and language builtins. (Modern syntax is
// fine here, unlike the hand-written STRING helpers such as buildInfraSrc's
// template literal or component-id's FIBER_WALK_SRC: this is a real,
// type-checked TS function — `componentScore` itself is the precedent, and
// it's written with plain `let`/`const` — the repo's `no-var` lint rule
// applies to actual parsed TS same as anywhere else; ES5 only matters for
// hand-authored string blobs eslint never parses.)
export function hostInScope(reqHost: string, regDomain: string): boolean {
  if (!regDomain) return false;
  const h = String(reqHost || '').toLowerCase();
  const d = String(regDomain).toLowerCase();
  return h === d || h.slice(-(d.length + 1)) === '.' + d;
}

// SELF-CONTAINED — stringified via `.toString()` into the main-world wrapper,
// same rule as `hostInScope` above. This is a faithful transcription of the
// `matcher` closure body in route-match.ts (lines ~80-108): inline
// normalizePath (strip query/hash, force a leading slash, collapse a
// trailing slash) + inline splitSegments (split on "/", drop empty
// segments), then the same literal/param/optional/wildcard walk. Semantics
// must not drift from route-match's — a harness
// pins parity against `matchPath` across a pattern × pathname table.
//
// `hasWildcard` is accepted (it rides along on every table entry and callers
// may use it to skip work before invoking this) but unused here — the token
// walk already branches on `tok.type === 'wildcard'`, so no special-casing
// is needed inside the matcher itself.
export function matchSerializedTokens(
  toks: SerializedToken[],
  hasWildcard: boolean,
  pathname: string,
): { params: Record<string, string | undefined> } | null {
  // Inline normalizePath: strip a "?"/"#" tail, force a leading "/", collapse
  // a trailing "/" (but never collapse the root "/" itself).
  const raw = pathname || '/';
  let cut = raw.length;
  for (let qi = 0; qi < raw.length; qi++) {
    const ch = raw.charAt(qi);
    if (ch === '?' || ch === '#') { cut = qi; break; }
  }
  let p = raw.slice(0, cut);
  if (p.charAt(0) !== '/') p = '/' + p;
  if (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);

  // Inline splitSegments: "/" on the normalized path, drop empty segments.
  const segs: string[] = [];
  const rawSegs = p.split('/');
  for (let si2 = 0; si2 < rawSegs.length; si2++) {
    const rawSeg = rawSegs[si2];
    if (rawSeg) segs.push(rawSeg);
  }

  const params: Record<string, string | undefined> = {};
  let si = 0;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (!tok) continue;
    if (tok.type === 'wildcard') {
      params['*'] = segs.slice(si).join('/');
      return { params: params };
    }
    if (tok.type === 'literal') {
      if (segs[si] !== tok.value) return null;
      si++;
      continue;
    }
    // param — segs never holds empty/undefined entries (the split above
    // drops falsy segments), so `seg !== undefined` is exactly `si <
    // segs.length`, mirroring route-match's own comment on this branch.
    const seg = segs[si];
    if (seg !== undefined) {
      let decoded: string;
      try { decoded = decodeURIComponent(seg); } catch (e) { decoded = seg; }
      if (tok.name !== undefined) params[tok.name] = decoded;
      si++;
    } else if (tok.optional) {
      if (tok.name !== undefined) params[tok.name] = undefined;
    } else {
      return null; // required param has no segment to fill it
    }
  }
  // All tokens consumed — the path must be fully consumed too, otherwise
  // `/budgets` would spuriously match `/budgets/extra`.
  if (si !== segs.length) return null;
  return { params: params };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Validate a single `rewrite-response` mutation PAYLOAD (not the bound
// transform source — that's a source-scan heuristic and lives in spec-lint,
// Task 4). Errors reject the emit (same anti-hallucination posture as
// spec-lint's unknown-kind / malformed-layout-mutation errors); this
// function never throws — it just enumerates what's wrong.
export function validateRewriteMutation(mut: Record<string, unknown>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const endpoint = mut.endpoint;
  if (!isRecord(endpoint)) {
    errors.push('rewrite-response requires an "endpoint" object with a "path".');
  } else {
    if (typeof endpoint.path !== 'string' || !endpoint.path.trim()) {
      errors.push('rewrite-response endpoint.path is required and must be a non-empty string.');
    } else {
      // route-match's `compile` never throws for any string input (it's pure
      // string splitting, no parsing that can reject) — but a pattern that
      // splits to zero segments (e.g. "/") can't usefully match a specific
      // JSON endpoint, so that's the "does not parse" case this validator
      // actually catches. The try/catch stays as the contract in case a
      // future compile() gains real rejection (unbalanced ":" params, etc.).
      try {
        const { toks } = routeMatch.compile(endpoint.path);
        if (toks.length === 0) {
          errors.push(`rewrite-response endpoint.path does not parse: "${endpoint.path}" compiles to zero path segments.`);
        }
      } catch (err) {
        errors.push(`rewrite-response endpoint.path does not parse: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (endpoint.method !== undefined && typeof endpoint.method !== 'string') {
      errors.push('rewrite-response endpoint.method must be a string when present.');
    }
  }

  if (typeof mut.transform !== 'string' || !mut.transform.trim()) {
    errors.push('rewrite-response requires a "transform" handler name (string).');
  }

  return { errors, warnings };
}

function serializeToken(t: Token): SerializedToken {
  switch (t.type) {
    case 'literal': return { type: 'literal', value: t.value };
    case 'param': return { type: 'param', name: t.name, optional: t.optional };
    case 'wildcard': return { type: 'wildcard' };
  }
}

// Bag shape mirrors `registry.ts`'s `bagForUserPatch` output (`{ spec,
// handlers, mutations }`, handlers/mutations kept in sync via patch_files) —
// this module only needs `spec` + `handlers`, so the parameter type stays
// narrow rather than importing the real (Electron-adjacent) bag type.
interface RewriteBag {
  spec: { id: string; rules?: unknown[] };
  handlers: Record<string, string>;
}

// Collect every valid `rewrite-response` entry across a set of patch bags.
// Total (never throws): a mutation that fails validation, or whose transform
// name resolves to nothing (inline rule.handlers, then the bag's spec-level
// handlers — same precedence order the design doc's "transform names a
// handler in rule.handlers" implies for the common case, and a reasonable
// default when both are absent) is silently skipped — spec-lint (Task 4) is
// where the model hears about a bad rewrite-response mutation at emit time;
// this collector's job is only to build the table from whatever already
// committed cleanly.
export function collectRewriteEntries(bags: RewriteBag[]): RewriteEntry[] {
  const entries: RewriteEntry[] = [];
  for (const bag of bags) {
    const specId = bag.spec.id;
    if (typeof specId !== 'string' || !specId) continue;
    const rulesList: unknown[] = Array.isArray(bag.spec.rules) ? bag.spec.rules : [];

    for (const ruleValue of rulesList) {
      if (!isRecord(ruleValue)) continue;
      const ruleId = ruleValue.id;
      if (typeof ruleId !== 'string' || !ruleId) continue;
      const ruleHandlers = isRecord(ruleValue.handlers) ? ruleValue.handlers : null;
      const mutationsList: unknown[] = Array.isArray(ruleValue.mutations) ? ruleValue.mutations : [];

      for (let mutIndex = 0; mutIndex < mutationsList.length; mutIndex++) {
        const mutValue = mutationsList[mutIndex];
        if (!isRecord(mutValue) || mutValue.kind !== 'rewrite-response') continue;

        const { errors } = validateRewriteMutation(mutValue);
        if (errors.length > 0) continue;

        // Re-derive locally rather than trust validateRewriteMutation's
        // success as a type guard — it returns { errors, warnings }, not a
        // narrowed type, so the shape needs re-checking to read it safely.
        if (!isRecord(mutValue.endpoint)) continue;
        const path = mutValue.endpoint.path;
        if (typeof path !== 'string') continue;
        const transformName = mutValue.transform;
        if (typeof transformName !== 'string') continue;

        const inlineSource = ruleHandlers ? ruleHandlers[transformName] : undefined;
        const bagSource = bag.handlers[transformName];
        const transformSource = typeof inlineSource === 'string' ? inlineSource : bagSource;
        if (typeof transformSource !== 'string') continue; // unresolvable — skip, don't throw

        const { toks, hasWildcard } = routeMatch.compile(path);
        const method = typeof mutValue.endpoint.method === 'string'
          ? mutValue.endpoint.method.toUpperCase()
          : null;

        entries.push({
          key: `${specId}/${ruleId}:${mutIndex}`,
          specId,
          ruleId,
          method,
          toks: toks.map(serializeToken),
          hasWildcard,
          transformSource,
        });
      }
    }
  }
  return entries;
}

// The committed shim/rule an authoring preview stands for.
export type PreviewOwner = { specId: string; ruleId: string };

// Pure: splice preview entries into the committed table's chain order (the
// wrapper runs EVERY matching entry in table order, highest priority last).
// A preview of a committed rule REPLACES that rule's entries in place: both
// running would apply the transform twice, the rewrite analogue of the
// engine's twin suppression for DOM previews. A new rule of a committed shim
// goes right after that shim's last entry, its own priority slot (a shim
// with no committed rewrite yet is placed by `specOrder`). A preview
// with no committed shim on this host goes last (the shim being authored has
// the final say while it is previewed).
export function mergePreviewEntries(
  committed: RewriteEntry[],
  previews: Array<{ owner: PreviewOwner | null; entries: RewriteEntry[] }>,
  specOrder: string[] = [],
): RewriteEntry[] {
  // Previews keep their own (ruleKey) specId, so placement works off the
  // owner recorded here, never off entries already spliced in: each committed
  // shim's slot is rebuilt from its own committed entries plus its previews.
  const lastIndex = new Map<string, number>();
  committed.forEach((e, i) => { lastIndex.set(e.specId, i); });
  const rank = new Map<string, number>();
  specOrder.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
  const twinKey = (specId: string, ruleId: string): string => `${specId}\u0000${ruleId}`;
  const committedRules = new Set(committed.map((e) => twinKey(e.specId, e.ruleId)));
  const twins = new Map<string, RewriteEntry[]>(); // twinKey → preview entries
  const added = new Map<string, RewriteEntry[]>(); // specId with entries → new-rule previews
  // A shim on the host with no committed rewrite yet: its previews go where
  // its priority puts it, before the first entry of any higher-ranked shim.
  const slotless = new Map<string, RewriteEntry[]>();
  const tail: RewriteEntry[] = [];
  for (const { owner, entries } of previews) {
    if (!owner) { tail.push(...entries); continue; }
    const key = twinKey(owner.specId, owner.ruleId);
    if (committedRules.has(key)) { twins.set(key, entries); continue; }
    const into = lastIndex.has(owner.specId) ? added : rank.has(owner.specId) ? slotless : null;
    if (!into) { tail.push(...entries); continue; }
    const list = into.get(owner.specId) || [];
    list.push(...entries);
    into.set(owner.specId, list);
  }
  const pending = [...slotless.entries()]
    .map(([specId, entries]) => ({ r: rank.get(specId) ?? Infinity, entries }))
    .sort((x, y) => x.r - y.r);
  const out: RewriteEntry[] = [];
  const flushBelow = (r: number): void => {
    let next = pending[0];
    while (next && next.r < r) {
      pending.shift();
      out.push(...next.entries);
      next = pending[0];
    }
  };
  const placed = new Set<string>();
  committed.forEach((e, i) => {
    const r = rank.get(e.specId);
    if (r !== undefined) flushBelow(r);
    const key = twinKey(e.specId, e.ruleId);
    const twin = twins.get(key);
    if (!twin) out.push(e);
    else if (!placed.has(key)) { placed.add(key); out.push(...twin); }
    if (lastIndex.get(e.specId) === i) out.push(...(added.get(e.specId) || []));
  });
  flushBelow(Infinity);
  return [...out, ...tail];
}

// Wrap a transform's raw handler source into a self-invoking literal the
// generated wrapper source can embed directly:
//   - "expr" form: the LLM's bare function-expression convention
//     (`rule.handlers[name]`) — wrapped in parens so it evaluates to the
//     function value instead of being parsed as a statement.
//   - "module" form: an imported/exported shim's full CJS module source
//     (`module.exports = function (...) {...}`) — run inside a fake
//     `(module, exports)` IIFE and its `module.exports` extracted, exactly
//     the `script` handler compile pattern, just inlined as source text
//     instead of run through Node's `vm` module (there is no `vm` in the
//     page's main world).
//
// Exported: `intercept.ts` (the define-trap/module-interception mutation
// kind) consumes this too, for the exact same handler-source-to-literal
// splice (a `wrap` handler is bound the same way a `transform` handler is) —
// this stays the one source of truth for that rule rather than a second
// hand-copied implementation drifting from it.
export function transformLiteral(src: string, form: TransformForm): string {
  // The expr splice still provides a `module` shell: a semicolon-less CJS
  // source (`module.exports = fn` with no trailing `;`) parses as a valid
  // ASSIGNMENT EXPRESSION, so the dual-form probe classifies it 'expr' — and
  // a bare `(src)` splice would then throw `module is not defined` at
  // install, aborting the shared install call for every rule on the host
  // (the hand-edited .shim import path can carry exactly this shape). With
  // the shell, the assignment evaluates to the function and both readings
  // agree; genuine expression sources never touch `module` and are unchanged.
  //
  // Every literal is fault-isolated: evaluating it runs the source's own
  // top-level code (a module-form source's helper statements, an expr-form
  // source's initializer), and these literals are object-property values in
  // ONE shared install argument — a throw there would abort the install for
  // every rule on the host. A throwing source yields `null` instead, which
  // the wrapper already skips (`typeof fn !== 'function'`), so only its own
  // rule goes inactive. spec-lint rejects a module-form source that leaves no
  // function on module.exports up front; this is the runtime backstop.
  if (form === 'expr') {
    return '(function () { try { var module = { exports: {} }; var exports = module.exports; return (' + src
      + '\n); } catch (e) { return null; } })()';
  }
  return '(function () { try { var module = { exports: {} }; (function (module, exports) {\n' + src
    + '\n})(module, module.exports); return typeof module.exports === "function" ? module.exports : null; }'
    + ' catch (e) { return null; } })()';
}

// The once-guarded main-world IIFE: installs (and, on a live update, re-
// installs) the fetch/XHR wrapper, matches same-registrable-domain JSON
// requests against the table, chains every matching transform, and publishes
// per-rule apply/error stats onto `<html data-shim-rewrite-stats>` for the
// engine to read at settle time (component-id's cross-world attribute-bridge
// pattern). `matchSerializedTokens`/`hostInScope` are interpolated via
// `.toString()` — see their own header comments for why they're written the
// way they are. TypeScript notes: everything below is ONE template string —
// no TS syntax lives inside it, so there is nothing for tsc to check beyond
// the two interpolated function bodies, which are checked (as real
// functions) at their own declarations above.
function buildInfraSrc(): string {
  return `(function () {
  'use strict';
  if (window.__shimRewriteInstall) return;
  var MATCH = ${matchSerializedTokens.toString()};
  var IN_SCOPE = ${hostInScope.toString()};
  var table = { regDomain: '', entries: [] };
  var transforms = {};
  var stats = {};
  function publish() { try { document.documentElement.setAttribute('data-shim-rewrite-stats', JSON.stringify(stats)); } catch (e) {} }
  function bump(k, field, err) {
    var s = stats[k] || (stats[k] = { applied: 0, errors: 0, lastError: null });
    s[field]++;
    if (err) s.lastError = String((err && err.message) || err);
    publish();
  }
  window.__shimRewriteInstall = function (arg) {
    table = (arg && arg.table && Array.isArray(arg.table.entries)) ? arg.table : { regDomain: '', entries: [] };
    transforms = (arg && arg.transforms) || {};
    for (var i = 0; i < table.entries.length; i++) {
      var k = table.entries[i].key;
      if (!stats[k]) stats[k] = { applied: 0, errors: 0, lastError: null };
    }
    publish();
  };
  // EVERY matching entry runs, chained in table order: each transform gets
  // the previous one's output. Table order is ascending cascade priority
  // (the host sorts the bags it collects; within a shim, rule then
  // mutation order), so the highest-priority shim's transform runs LAST and has the
  // final say on the body, the same way its CSS rule sits last in the sorted
  // sheet and wins. First-match-wins used to silently shadow every later
  // rule on an overlapping endpoint.
  function findEntries(method, urlStr) {
    if (!table.entries.length) return null;
    var u; try { u = new URL(urlStr, location.href); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!IN_SCOPE(u.hostname, table.regDomain)) return null;
    var hits = [];
    for (var i = 0; i < table.entries.length; i++) {
      var e = table.entries[i];
      if (e.method && e.method !== method) continue;
      var m = MATCH(e.toks, e.hasWildcard, u.pathname);
      if (m) hits.push({ entry: e, params: m.params, url: u.href });
    }
    return hits.length ? hits : null;
  }
  // One entry's transform. An entry counts as applied only once its output
  // serializes, so an unserializable return (a cycle) is that entry's error
  // and its input passes on, never the whole response's failure.
  function runTransform(hit, json, method, status) {
    var fn = transforms[hit.entry.key];
    if (typeof fn !== 'function') return null;
    try {
      var out = fn(json, { url: hit.url, method: method, status: status, params: hit.params });
      if (out === undefined) return null;
      var text = JSON.stringify(out);
      if (typeof text !== 'string') return null;
      bump(hit.entry.key, 'applied');
      return { value: out, text: text };
    } catch (err) {
      bump(hit.entry.key, 'errors', err);
      return null;
    }
  }
  // Run the chain. "text" is the current body as JSON text; "first" is an
  // already-parsed copy the first entry may take (saves a parse). Every later
  // entry gets a fresh parse of the last good text, so a transform that
  // mutated its input in place and then threw or returned undefined can't
  // leak a half-edit into the next one. Returns null when nothing changed.
  function runChain(hits, text, first, method, status) {
    var cur = null;
    for (var i = 0; i < hits.length; i++) {
      var input;
      if (i === 0 && first !== undefined) input = first;
      else { try { input = JSON.parse(cur ? cur.text : text); } catch (e) { break; } }
      var r = runTransform(hits[i], input, method, status);
      if (r) cur = r;
    }
    return cur;
  }
  function isJson(ct) { return typeof ct === 'string' && ct.toLowerCase().indexOf('json') !== -1; }
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var method = 'GET'; var urlStr = '';
      try {
        if (typeof input === 'string' || (typeof URL !== 'undefined' && input instanceof URL)) urlStr = String(input);
        else if (input && typeof input.url === 'string') { urlStr = input.url; method = input.method || 'GET'; }
        if (init && init.method) method = init.method;
        method = String(method).toUpperCase();
      } catch (e) {}
      var hits = urlStr ? findEntries(method, urlStr) : null;
      var p = origFetch.apply(this, arguments);
      if (!hits) return p;
      return p.then(function (res) {
        try {
          if (!isJson(res.headers.get('content-type'))) return res;
          return res.clone().text().then(function (text) {
            var json; try { json = JSON.parse(text); } catch (e) { return res; }
            var out = runChain(hits, text, json, method, res.status);
            if (!out) return res;
            try {
              var headers = new Headers(res.headers);
              headers.delete('content-length');
              var rewritten = new Response(out.text, { status: res.status, statusText: res.statusText, headers: headers });
              try {
                Object.defineProperty(rewritten, 'url', { value: res.url });
                Object.defineProperty(rewritten, 'redirected', { value: res.redirected });
                Object.defineProperty(rewritten, 'type', { value: res.type });
              } catch (e) {}
              return rewritten;
            } catch (e) { return res; }
          }, function () { return res; });
        } catch (e) { return res; }
      });
    };
  }
  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && XHR.prototype.open) {
    var origOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url) {
      try {
        this.__shimRewriteReq = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
        if (!this.__shimRewriteHooked) {
          this.__shimRewriteHooked = true;
          var xhr = this;
          // Registered inside open(), BEFORE the page assigns its own
          // handlers post-open — listeners fire in registration order, so
          // the payload is swapped before the page reads it. A handler the
          // page registered before calling open() still sees the original
          // body: accepted residual, noted in the design doc.
          this.addEventListener('readystatechange', function () {
            if (xhr.readyState !== 4) return;
            var req = xhr.__shimRewriteReq;
            if (!req) return;
            var hits = findEntries(req.method, req.url);
            if (!hits) return;
            var ct; try { ct = xhr.getResponseHeader('content-type'); } catch (e) { return; }
            if (!isJson(ct)) return;
            try {
              var rt = xhr.responseType;
              var text;
              var json;
              if (rt === '' || rt === 'text') { text = xhr.responseText; json = JSON.parse(text); }
              else if (rt === 'json') {
                json = xhr.response;
                // Later entries re-parse from text; take it before the first
                // transform can touch the page's own object.
                text = hits.length > 1 ? JSON.stringify(json) : '';
              }
              else return;
              var out = runChain(hits, text, json, req.method, xhr.status);
              if (!out) return;
              if (rt === 'json') {
                Object.defineProperty(xhr, 'response', { value: out.value, configurable: true });
              } else {
                Object.defineProperty(xhr, 'responseText', { value: out.text, configurable: true });
                Object.defineProperty(xhr, 'response', { value: out.text, configurable: true });
              }
            } catch (e) {}
          });
        }
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };
  }
})();`;
}

// Build the full source to inject via `webFrame.executeJavaScript` (main-
// world, CSP-immune): the once-guarded
// infra IIFE, followed by one call installing this table's entries + bound
// transforms. `formFor` lets the caller (which knows whether a given source
// string is the LLM's bare-expression convention or an imported shim's full
// CJS module) pick the right wrap per entry — this module has no opinion.
export function buildWrapperSrc(payload: RewriteTablePayload, formFor: (src: string) => TransformForm): string {
  // The table sent into the page never carries transform SOURCE — only the
  // compiled matcher shape (key/method/toks/hasWildcard) the wrapper's
  // findEntries() needs. The actual functions live in `transforms`, spliced in
  // as source text below (keyed the same way), never round-tripped through
  // JSON (functions aren't JSON-serializable in the first place).
  const strippedEntries = payload.entries.map(({ transformSource, ...rest }) => rest);
  const tableJson = JSON.stringify({ regDomain: payload.regDomain, entries: strippedEntries });

  const transformParts = payload.entries.map(
    (entry) => `${JSON.stringify(entry.key)}: ${transformLiteral(entry.transformSource, formFor(entry.transformSource))}`,
  );
  const installArg = `{ table: ${tableJson}, transforms: { ${transformParts.join(', ')} } }`;

  return `${buildInfraSrc()}\nwindow.__shimRewriteInstall(${installArg});`;
}
