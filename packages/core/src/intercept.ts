// intercept — module-boundary interception for AMD-loaded (RequireJS-style)
// site modules (docs/2026-08-04-intercept-design.md is the design doc; this
// module is PURE / Electron-free, mirroring `rewrite-response.ts`'s shape:
// non-DOM rule, table + registry, conditional install, and the SAME
// handler-source-splice discipline via `transformLiteral` — a `wrap` handler
// is bound exactly the way a `transform` handler is).
//
// An `intercept` rule traps `window.define` in the page's MAIN world (not
// the isolated world the engine runs in) so it can observe and, optionally,
// wrap named exports off a site's own AMD modules — the module-graph analog
// of `rewrite-response`'s network-layer interception. Everything below is
// either:
//   - pure data-shaping (validate / collect / serialize a token table), or
//   - a STRING BUILDER for the main-world define-trap infra, where the
//     infra itself is one hand-authored ES5 template string (no interpolated
//     real-TS helper functions today, unlike rewrite-response's
//     `matchSerializedTokens`/`hostInScope` — the whole infra is small enough
//     to stay one block).
//
// Wiring (main-process IPC, page-preload injection, spec-lint hookup) is a
// later task; this file only produces the table/wrapper-builder primitives
// and has zero Electron/DOM dependencies, so it is bare-node testable
// end-to-end (scripts/intercept-harness.ts), including running the built
// infra source against a hand-rolled fake DOM + a tiny synchronous AMD
// loader in a `vm` sandbox.

import { transformLiteral } from './rewrite-response';
import type { TransformForm } from './rewrite-response';

// The shape of `mutation.module` on an `intercept` mutation (design doc
// "Spec shape"). Today only the `amd` loader is supported — RequireJS-style
// `define`/`require`. Declared here for downstream consumers (the
// `Mutation` type extension + spec-lint land in later tasks); this module
// itself only ever sees `module` as `unknown` and narrows it defensively.
export interface InterceptModuleSpec { loader: 'amd'; id: string }

// One compiled intercept rule, ready to ride an IPC payload / be embedded in
// generated main-world source. `key` is stable across a table rebuild as
// long as the rule's mutation doesn't move within `rule.mutations` — used
// both as the wraps-object key in the generated infra source and as the
// per-rule stats key the infra stamps back for apply-time feedback (the
// same convention `rewrite-response.ts`'s `RewriteEntry.key` uses).
export interface InterceptEntry {
  key: string; // `${specId}/${ruleId}:${mutationIndex}`
  specId: string;
  ruleId: string;
  moduleId: string;
  symbol: string | null; // dot-path into the export; null = whole-export
  wrapSource: string | null; // null = expose-only (api.modules.invoke gate)
}

// The table handed to the main-world infra: every intercept entry live for
// the current page (intercept has no host/registrable-domain scoping the way
// rewrite-response does — a module id is already page-scoped by construction).
export interface InterceptTablePayload { entries: InterceptEntry[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Validate a single `intercept` mutation PAYLOAD (not the bound wrap
// source — that's a source-scan heuristic and lives in spec-lint, a later
// task). Errors reject the emit (same anti-hallucination posture as
// spec-lint's unknown-kind / malformed-layout-mutation errors, and
// `rewrite-response.ts`'s `validateRewriteMutation`); this function never
// throws — it just enumerates what's wrong.
export function validateInterceptMutation(mut: Record<string, unknown>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mod = mut.module;
  if (!isRecord(mod)) {
    errors.push('intercept requires a "module" object: { loader: "amd", id: "<module id>" }.');
  } else {
    if (mod.loader !== 'amd') errors.push('intercept module.loader must be "amd" (the only supported loader).');
    if (typeof mod.id !== 'string' || !mod.id.trim()) errors.push('intercept module.id is required and must be a non-empty string.');
  }
  if (mut.symbol !== undefined && (typeof mut.symbol !== 'string' || !mut.symbol.trim())) {
    errors.push('intercept symbol must be a non-empty string when present.');
  }
  if (mut.wrap !== undefined && (typeof mut.wrap !== 'string' || !mut.wrap.trim())) {
    errors.push('intercept wrap must be a handler name (string) when present.');
  }
  if (typeof mut.symbol === 'string' && mut.wrap === undefined) {
    errors.push('intercept symbol requires a wrap handler — expose-only mutations are module-level (drop the symbol).');
  }
  return { errors, warnings };
}

// Bag shape mirrors `registry.ts`'s `bagForUserPatch` output (`{ spec,
// handlers, mutations }`, handlers/mutations kept in sync via patch_files) —
// this module only needs `spec` + `handlers`, same narrow shape
// `rewrite-response.ts`'s `RewriteBag` uses.
interface InterceptBag {
  spec: { id: string; rules?: unknown[] };
  handlers: Record<string, string>;
}

// Collect every valid `intercept` entry across a set of patch bags.
// Structural copy of `collectRewriteEntries`: same bag walk, same inline-
// `rule.handlers`-then-bag-handlers precedence for a bound wrap handler, same
// skip-don't-throw posture. Total (never throws): a mutation that fails
// validation, or whose `wrap` name resolves to nothing, is silently skipped
// — spec-lint (a later task) is where the model hears about a bad intercept
// mutation at emit time; this collector's job is only to build the table
// from whatever already committed cleanly. A mutation with no `wrap` at all
// is a valid expose-only entry and is kept with `wrapSource: null`.
export function collectInterceptEntries(bags: InterceptBag[]): InterceptEntry[] {
  const entries: InterceptEntry[] = [];
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
        if (!isRecord(mutValue) || mutValue.kind !== 'intercept') continue;

        const { errors } = validateInterceptMutation(mutValue);
        if (errors.length > 0) continue;

        // Re-derive locally rather than trust validateInterceptMutation's
        // success as a type guard — it returns { errors, warnings }, not a
        // narrowed type, so the shape needs re-checking to read it safely.
        if (!isRecord(mutValue.module)) continue;
        const moduleId = mutValue.module.id;
        if (typeof moduleId !== 'string' || !moduleId) continue;

        const symbol = typeof mutValue.symbol === 'string' ? mutValue.symbol : null;

        let wrapSource: string | null = null;
        if (typeof mutValue.wrap === 'string') {
          const wrapName = mutValue.wrap;
          const inlineSource = ruleHandlers ? ruleHandlers[wrapName] : undefined;
          const bagSource = bag.handlers[wrapName];
          const resolved = typeof inlineSource === 'string' ? inlineSource : bagSource;
          if (typeof resolved !== 'string') continue; // unresolvable — skip, don't throw
          wrapSource = resolved;
        }

        entries.push({
          key: `${specId}/${ruleId}:${mutIndex}`,
          specId,
          ruleId,
          moduleId,
          symbol,
          wrapSource,
        });
      }
    }
  }
  return entries;
}

// Unique module ids declared across a spec's `intercept` mutations, in
// first-seen order — Task 4's route-registration gate (declaring an
// intercept for a module the page never loads) reads this. Walks rules the
// same way `collectInterceptEntries` does but doesn't require a full bag
// (handlers aren't needed to know WHICH modules are declared) and doesn't
// gate on `validateInterceptMutation` passing wholesale — only a present,
// non-empty `module.id` is required, since a declared-but-otherwise-invalid
// mutation (e.g. missing wrap for a symbol) still names a real module the
// caller wants to know about.
export function declaredInterceptModules(rules: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const rulesList: unknown[] = Array.isArray(rules) ? rules : [];
  for (const ruleValue of rulesList) {
    if (!isRecord(ruleValue)) continue;
    const mutationsList: unknown[] = Array.isArray(ruleValue.mutations) ? ruleValue.mutations : [];
    for (const mutValue of mutationsList) {
      if (!isRecord(mutValue) || mutValue.kind !== 'intercept') continue;
      if (!isRecord(mutValue.module)) continue;
      const id = mutValue.module.id;
      if (typeof id !== 'string' || !id.trim()) continue;
      if (!seen.has(id)) { seen.add(id); out.push(id); }
    }
  }
  return out;
}

// The once-guarded main-world IIFE: traps `window.define` (property-trap
// when it doesn't exist yet, in-place wrap when it does — mid-session
// enable), maintains a per-symbol trampoline that consults the live table on
// every call, retro-applies onto already-defined modules through RequireJS's
// PUBLIC surface only (`require.defined`/sync `require`, never a network
// load), and services `api.modules.invoke` requests via the same
// isolated-world -> main-world attribute-bridge pattern `component-id.ts`
// uses (request consumed on observation, response via a `-result` value
// attribute followed by a `-res` id attribute set LAST). TypeScript notes:
// this is ONE template string — no TS syntax lives inside it, so there is
// nothing for tsc to check.
function buildInterceptInfraSrc(): string {
  return `(function () {
  'use strict';
  if (window.__shimInterceptInstall) return;
  var registry = {};   // moduleId -> { mod: <export value> }
  var slots = {};      // moduleId + '\\u0000' + symbol -> { raw, live, keys }
  var table = { entries: [] };
  var wraps = {};      // entry.key -> wrap fn
  var stats = {};      // entry.key -> { applied, errors, lastError, state }
  var wrappedDefine;
  var publishTimer = null;
  var publishDirty = false;

  // A wrapped call bumps only a count (applied), and a hot site function can
  // fire thousands of times a second — one JSON.stringify + attribute write +
  // cross-world observer hop per call would be pathological. So COUNT-only
  // updates go through publishSoon(), which is leading+trailing coalesced:
  // the first bump in a quiet window writes immediately (feedback stays
  // prompt, and a bare-node harness reading synchronously after one call still
  // sees it), then further bumps within 250ms collapse into one trailing
  // flush. A STATE change or a new error still calls publish() directly —
  // immediate, and it cancels any pending coalesced flush so it can't wait
  // behind a count timer.
  function writeStats() { try { document.documentElement.setAttribute('data-shim-intercept-stats', JSON.stringify(stats)); } catch (e) {} }
  function publish() {
    publishDirty = false;
    if (publishTimer !== null) { clearTimeout(publishTimer); publishTimer = null; }
    writeStats();
  }
  function publishSoon() {
    if (publishTimer === null) {
      writeStats();
      publishTimer = setTimeout(function () {
        publishTimer = null;
        if (publishDirty) { publishDirty = false; writeStats(); }
      }, 250);
    } else {
      publishDirty = true;
    }
  }
  function stat(k) { return stats[k] || (stats[k] = { applied: 0, errors: 0, lastError: null, state: 'module-pending' }); }
  function bumpErr(k, err) { var s = stat(k); s.errors++; s.lastError = String((err && err.message) || err); publish(); }

  function resolvePath(obj, path) {
    var parts = String(path).split('.');
    var parent = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (parent === null || parent === undefined) return null;
      parent = parent[parts[i]];
    }
    if (parent === null || parent === undefined) return null;
    return { parent: parent, prop: parts[parts.length - 1] };
  }

  function liveRequire() {
    var r = window.require || window.requirejs;
    return (typeof r === 'function') ? r : null;
  }

  // Retro-resolve an already-defined module through RequireJS's PUBLIC
  // surface only: require.defined(id) guards, sync require(id) reads. Never
  // triggers a network load (the guard is the point — require(['id']) on an
  // undefined id would fetch /id.js).
  function tryRetro(moduleId) {
    // Require a non-null recorded mod before short-circuiting: an exports-
    // pattern module records nothing here (see onDefined), and a defensive
    // { mod: null } must fall through to a fresh require(id) read below rather
    // than declaring the module resolved with no usable export.
    if (registry[moduleId] && registry[moduleId].mod != null) return true;
    var req = liveRequire();
    if (!req || typeof req.defined !== 'function') return false;
    var has = false;
    try { has = req.defined(moduleId); } catch (e) { return false; }
    if (!has) return false;
    try { registry[moduleId] = { mod: req(moduleId) }; } catch (e) { return false; }
    return true;
  }

  // Install (once) the per-symbol trampoline: parent[prop] becomes a
  // table-consulting shim. slot.live === null -> transparent passthrough.
  function ensureSlot(moduleId, symbol) {
    var key = moduleId + '\\u0000' + symbol;
    if (slots[key]) return slots[key];
    var reg = registry[moduleId];
    if (!reg) return null;
    var loc = resolvePath(reg.mod, symbol);
    if (!loc || typeof loc.parent[loc.prop] !== 'function') return null;
    var raw = loc.parent[loc.prop];
    var slot = { raw: raw, live: null, keys: [] };
    slots[key] = slot;
    try {
      loc.parent[loc.prop] = function () {
        var fn = slot.live;
        if (!fn) return raw.apply(this, arguments);
        try {
          var out = fn.apply(this, arguments);
          for (var i = 0; i < slot.keys.length; i++) { stat(slot.keys[i]).applied++; }
          publishSoon();
          return out;
        } catch (err) {
          for (var j = 0; j < slot.keys.length; j++) bumpErr(slot.keys[j], err);
          return raw.apply(this, arguments);
        }
      };
    } catch (e) { delete slots[key]; return null; }
    return slot;
  }

  // Recompose every symbol-wrap chain from raw originals. Called on every
  // table push and every module registration. Whole-export entries are NOT
  // handled here — they apply at define time only (applyWholeExport).
  function recompose() {
    for (var k in slots) { slots[k].live = null; slots[k].keys = []; }
    for (var i = 0; i < table.entries.length; i++) {
      var e = table.entries[i];
      if (!e.symbol) continue;
      var wrapFn = wraps[e.key];
      var s = stat(e.key);
      if (typeof wrapFn !== 'function') continue;
      if (!registry[e.moduleId] && !tryRetro(e.moduleId)) { s.state = 'module-pending'; continue; }
      var slot = ensureSlot(e.moduleId, e.symbol);
      if (!slot) { s.state = 'symbol-missing'; continue; }
      var base = slot.live || slot.raw;
      try {
        var replacement = wrapFn(base, { moduleId: e.moduleId, symbol: e.symbol });
        if (typeof replacement !== 'function') { bumpErr(e.key, new Error('wrap did not return a function')); continue; }
        slot.live = replacement;
        slot.keys.push(e.key);
        s.state = 'live';
      } catch (err) { bumpErr(e.key, err); }
    }
    publish();
  }

  // Whole-export wraps: registration time only. Late table pushes for an
  // already-registered module mark 'reload' (identity already handed out).
  function applyWholeExport(moduleId, exportValue) {
    var out = exportValue;
    for (var i = 0; i < table.entries.length; i++) {
      var e = table.entries[i];
      if (e.moduleId !== moduleId || e.symbol) continue;
      var wrapFn = wraps[e.key];
      var s = stat(e.key);
      if (typeof wrapFn !== 'function') continue;
      try {
        var replaced = wrapFn(out, { moduleId: moduleId, symbol: null });
        if (replaced !== undefined) { out = replaced; s.applied++; }
        s.state = 'live';
      } catch (err) { bumpErr(e.key, err); }
    }
    publish();
    return out;
  }

  function onDefined(id, exportValue) {
    var out = applyWholeExport(id, exportValue);
    // An exports-pattern module (writes onto the injected exports object and
    // returns undefined) has no identity to record here -- RequireJS holds the
    // real exports object. Recording { mod: undefined } would poison the
    // registry: tryRetro would short-circuit on it and never re-read the true
    // export via require(id), so a symbol wrap on it would report
    // symbol-missing forever. Skip the undefined; recompose (below) and later
    // recomposes re-resolve it through require(id) once RequireJS registers it.
    if (out !== undefined) registry[id] = { mod: out };
    recompose();
    return out;
  }

  function wrapDefine(orig) {
    var wrapped = function (name) {
      if (typeof name === 'string') {
        var args = Array.prototype.slice.call(arguments);
        var fi = args.length - 1; // factory/object is always the last argument
        var factory = args[fi];
        if (typeof factory === 'function') {
          var wrappedFactory = function () {
            var value = factory.apply(this, arguments);
            return onDefined(name, value);
          };
          // RequireJS inspects callback.length and callback.toString() to
          // auto-inject ['require','exports','module'] deps for CommonJS-sugar
          // modules — define('m', function (require, exports, module) {...}).
          // A bare replacement has arity 0 and its own toString, so those
          // modules would get deps=[] and be called with no args:
          // 'require is not a function'. That would break UNRELATED site
          // modules merely because an intercept shim is enabled. Preserve
          // both — Function.prototype.length is configurable (defineProperty
          // works), and RequireJS calls callback.toString() directly (an own
          // method is honored).
          try { Object.defineProperty(wrappedFactory, 'length', { value: factory.length, configurable: true }); } catch (e) {}
          wrappedFactory.toString = function () { return factory.toString(); };
          args[fi] = wrappedFactory;
        } else if (factory && typeof factory === 'object') {
          args[fi] = onDefined(name, factory);
        }
        return orig.apply(this, args);
      }
      return orig.apply(this, arguments);
    };
    for (var k in orig) { try { wrapped[k] = orig[k]; } catch (e) {} }
    // RequireJS may set define.amd AFTER assigning window.define — delegate.
    try {
      Object.defineProperty(wrapped, 'amd', {
        configurable: true,
        get: function () { return orig.amd; },
        set: function (v) { orig.amd = v; },
      });
    } catch (e) { wrapped.amd = orig.amd; }
    return wrapped;
  }

  // Trap window.define. Document-start: define doesn't exist yet -> accessor
  // trap catches the loader's assignment. Late install (mid-session enable):
  // define already exists -> wrap it in place (already-defined modules are
  // reached via tryRetro instead).
  (function armDefineTrap() {
    var current = window.define;
    if (typeof current === 'function') {
      wrappedDefine = wrapDefine(current);
      try { window.define = wrappedDefine; } catch (e) {}
      return;
    }
    try {
      Object.defineProperty(window, 'define', {
        configurable: true,
        get: function () { return wrappedDefine; },
        set: function (v) {
          if (typeof v === 'function') { wrappedDefine = wrapDefine(v); }
          else { wrappedDefine = v; }
        },
      });
    } catch (e) {}
  })();

  // --- api.modules.invoke servicing (isolated -> main world, component-id
  // attribute-bridge pattern; request consumed on observation, response via
  // -result + -res attributes, res set LAST). ---
  function handleInvoke() {
    var root = document.documentElement;
    var raw = root.getAttribute('data-shim-modinv-req');
    if (!raw) return;
    root.removeAttribute('data-shim-modinv-req');
    var msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || !msg.reqId) return;
    function respond(payload) {
      try {
        root.setAttribute('data-shim-modinv-result', JSON.stringify(payload));
        root.setAttribute('data-shim-modinv-res', String(msg.reqId));
      } catch (e) {}
    }
    if (typeof msg.moduleId !== 'string' || typeof msg.path !== 'string' || !msg.path) {
      return respond({ ok: false, error: 'invoke requires a module id and a symbol path' });
    }
    if (!registry[msg.moduleId] && !tryRetro(msg.moduleId)) {
      return respond({ ok: false, error: 'module "' + msg.moduleId + '" is not registered on this page' });
    }
    var loc = resolvePath(registry[msg.moduleId].mod, msg.path);
    if (!loc || loc.parent[loc.prop] === undefined) {
      return respond({ ok: false, error: 'symbol "' + msg.path + '" not found on module "' + msg.moduleId + '"' });
    }
    var value = loc.parent[loc.prop];
    var result;
    try {
      result = (typeof value === 'function') ? value.apply(loc.parent, Array.isArray(msg.args) ? msg.args : []) : value;
    } catch (err) {
      return respond({ ok: false, error: String((err && err.message) || err) });
    }
    Promise.resolve(result).then(function (settled) {
      var serialized = null;
      var note;
      if (settled !== undefined) {
        try { serialized = JSON.parse(JSON.stringify(settled)); } catch (e) { note = 'The call succeeded, but its return value was not JSON-serializable.'; }
      }
      var out = { ok: true, result: serialized };
      if (note) out.note = note;
      respond(out);
    }, function (err) {
      respond({ ok: false, error: String((err && err.message) || err) });
    });
  }
  // document.documentElement is reliably NULL at the exact moment this IIFE
  // runs (proven empirically: a document-start webFrame.executeJavaScript
  // injection races the HTML parser's creation of <html>, and the race is
  // lost every time, not just occasionally — scripts/intercept-wrap-harness.js
  // caught this live). A bare try/catch here would silently and PERMANENTLY
  // break api.modules.invoke for the whole page load. The stats observer
  // (intercept-install.ts's observeStats) hits the identical race and now
  // guards it the same way this does. Same idiom page-preload.ts's
  // bootMatchesWhenNotChallenged/engine.ts use elsewhere in this codebase:
  // try immediately (covers the rare case documentElement already exists),
  // fall back to DOMContentLoaded (guaranteed to fire once documentElement —
  // and the whole document — exist).
  function attachInvokeObserver() {
    if (!document.documentElement) return false;
    try {
      new MutationObserver(handleInvoke).observe(document.documentElement, { attributes: true, attributeFilter: ['data-shim-modinv-req'] });
      return true;
    } catch (e) { return false; }
  }
  if (!attachInvokeObserver()) {
    try {
      document.addEventListener('DOMContentLoaded', attachInvokeObserver, { once: true });
    } catch (e) {}
  }

  window.__shimInterceptInstall = function (arg) {
    table = (arg && arg.table && Array.isArray(arg.table.entries)) ? arg.table : { entries: [] };
    wraps = (arg && arg.wraps) || {};
    for (var i = 0; i < table.entries.length; i++) {
      var e = table.entries[i];
      var s = stat(e.key);
      // The embedded table never carries wrapSource (buildInterceptInstallArg
      // strips it), so "does this entry actually have a bound wrap" is
      // answered by looking up the live wraps object, not a table field.
      if (!e.symbol) {
        if (typeof wraps[e.key] === 'function') {
          // Whole-export entry arriving after its module registered can only
          // take effect on reload (identity already handed out); symbol
          // entries recompose live below.
          if (registry[e.moduleId] && s.state !== 'live') s.state = 'reload';
        } else {
          // Expose-only entry (no symbol, no wrap): it changes nothing about
          // the module, it only satisfies the api.modules.invoke gate. It's
          // healthy by declaration — 'declared' ranks alongside 'live' so it
          // never drags a sibling symbol wrap's aggregate down to a false
          // 'module-pending' (the default stat state, which nothing else
          // would clear for it since recompose skips symbol-less entries).
          s.state = 'declared';
        }
      }
    }
    recompose();
  };
})();`;
}

// Build the `{ table, wraps }` argument literal `window.__shimInterceptInstall`
// consumes: the table JSON with `wrapSource` stripped (functions aren't
// JSON-serializable in the first place, and the actual wrap source ships
// separately as source text — same split `rewrite-response.ts`'s
// `buildWrapperSrc` makes between its stripped table and its `transforms`
// object), plus a `wraps` object keyed the same way, each value a
// self-invoking literal built via the SHARED `transformLiteral` splice
// (expr vs module form, `formFor` decides per-source). Exported on its own
// (not just inlined into `buildInterceptWrapperSrc`) so a live table push —
// toggle, commit, global pause — can call `window.__shimInterceptInstall(...)`
// directly with a freshly-built argument, without re-running the infra IIFE.
export function buildInterceptInstallArg(payload: InterceptTablePayload, formFor: (src: string) => TransformForm): string {
  const strippedEntries = payload.entries.map(({ wrapSource, ...rest }) => rest);
  const tableJson = JSON.stringify({ entries: strippedEntries });
  const wrapParts = payload.entries
    .filter((e): e is InterceptEntry & { wrapSource: string } => typeof e.wrapSource === 'string')
    .map((e) => `${JSON.stringify(e.key)}: ${transformLiteral(e.wrapSource, formFor(e.wrapSource))}`);
  return `{ table: ${tableJson}, wraps: { ${wrapParts.join(', ')} } }`;
}

// Build the full source to inject via `webFrame.executeJavaScript` (main-
// world, CSP-immune — same install mechanism `rewrite-install.ts` uses for
// `rewrite-response`, a later task's wiring): the once-guarded infra IIFE,
// followed by one call installing this table's entries + bound wraps.
export function buildInterceptWrapperSrc(payload: InterceptTablePayload, formFor: (src: string) => TransformForm): string {
  return `${buildInterceptInfraSrc()}\nwindow.__shimInterceptInstall(${buildInterceptInstallArg(payload, formFor)});`;
}
