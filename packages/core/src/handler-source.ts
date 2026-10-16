// Handler source forms. A handler is authored rule-local as a
// bare function EXPRESSION (`rule.handlers[name]`, the LLM's convention) and
// stored, exported and shipped by name as a CJS MODULE (`module.exports =
// <expr>;`) — patch_files, a `.shim` file's top-level `handlers` map, a shim
// folder's handlers/<name>.js. This module owns the flattening between the
// two so the browser's commit path and the shim folder format agree on it.

import type { Spec, Rule } from './types';
import { syntaxProbe } from './syntax-probe';

/** A spec that may carry an import-time top-level `handlers` map (module form). */
export type SpecWithHandlers = Spec & { handlers?: Record<string, string> };

const MODULE_PREFIX = 'module.exports = ';
const MODULE_SUFFIX = ';\n';

/**
 * `(<expression>\n)` — the source that evaluates to a rule-local handler.
 * The `)` sits on its own line: an expression may end in a `// comment`,
 * which runs to end-of-line (the `//# sourceURL=` trap) and
 * would swallow a closer on the same line, so the handler never compiles.
 */
export function handlerExpressionSource(expression: string): string {
  return `(${expression}\n)`;
}

/** The module form a rule-local handler expression is stored in. */
export function expressionToModule(expression: string): string {
  return `${MODULE_PREFIX}${expression}${MODULE_SUFFIX}`;
}

// The expression expressionToModule wrapped, byte for byte (trailing
// whitespace inside it included), when the module is exactly that wrapper.
function exactWrappedExpression(moduleSource: string): string | null {
  if (!moduleSource.startsWith(MODULE_PREFIX) || !moduleSource.endsWith(MODULE_SUFFIX)) return null;
  return moduleSource.slice(MODULE_PREFIX.length, moduleSource.length - MODULE_SUFFIX.length);
}

// `module.exports = <expr>;` — the exact form expressionToModule writes, with
// the whitespace and trailing semicolon a hand edit might change.
// The IIFE moduleToExpression wraps a module in: runs it in its own CommonJS
// scope and evaluates to its `module.exports`. The parameters are the
// browser's module compile's, in its order (module, exports, require,
// __filename, __dirname), so `arguments[i]` reads the same; require /
// __filename / __dirname come from wherever the expression is compiled, when
// that scope has them.
const MODULE_IIFE_PREFIX = '(function () {\nvar module = { exports: {} };\n(function (module, exports, require, __filename, __dirname) {\n';
// `.call(module.exports, …)` keeps CommonJS's top-level `this` (the browser's
// module compile runs a module with `this === module.exports`).
const MODULE_IIFE_SUFFIX = '\n}).call(module.exports, module, module.exports, '
  + 'typeof require === "undefined" ? undefined : require, '
  + 'typeof __filename === "undefined" ? "" : __filename, '
  + 'typeof __dirname === "undefined" ? "" : __dirname);\nreturn module.exports;\n})()';

const WRAPPED_EXPRESSION_RE = /^\s*module\.exports\s*=\s*([\s\S]*?)\s*;?\s*$/;

/**
 * The rule-local expression form of a handler module (a shim folder's
 * handlers/<name>.js going back onto `rule.handlers`). A module that is just
 * `module.exports = <expr>;` gives back `<expr>`, so expression → module →
 * expression is the identity, as long as `<expr>` runs the same unwrapped
 * (safeBareExpression). Anything else (helpers beside the export, a leading
 * comment, an export that uses `module` / `this` / …) becomes an IIFE that runs the module in its own
 * CommonJS scope and evaluates to its `module.exports` — the same value the
 * stored module produces, in a form `module.exports = <expr>;` can carry.
 * The IIFE is the convention of the world(s) the handler runs in
 * (`worlds`, from handlerWorlds): the module compile's for an isolated-world
 * handler, transformLiteral's for a page-world transform / wrap, and an
 * expression that picks between them for a name referenced from both.
 */
export function moduleToExpression(moduleSource: string, worlds: HandlerWorld | ReadonlySet<HandlerWorld> = 'isolated'): string {
  const inner = exportedExpression(moduleSource);
  return inner !== null && safeBareExpression(inner) ? inner : wrapModuleForWorlds(moduleSource, worlds);
}

/**
 * Where a handler a mutation names runs: a `handler` (script, replace-root,
 * mount-route) in the preload's isolated world, where a stored module runs in
 * the CommonJS wrapper above; a `transform` (rewrite-response) or `wrap`
 * (intercept) spliced into the page's main world by transformLiteral, whose
 * module convention is a plain `(module, exports)` call. A module that needs
 * a wrapper inline needs the one its own world runs it under.
 */
export type HandlerWorld = 'isolated' | 'page';
const HANDLER_REF_WORLDS = { handler: 'isolated', transform: 'page', wrap: 'page' } as const satisfies Record<string, HandlerWorld>;

/** Every handler name the rules' mutations reference, with the worlds each runs in. */
export function handlerWorlds(rules: readonly Rule[]): Map<string, Set<HandlerWorld>> {
  const out = new Map<string, Set<HandlerWorld>>();
  for (const rule of rules) {
    const mutations: unknown = rule?.mutations;
    if (!Array.isArray(mutations)) continue;
    for (const mutation of mutations) {
      if (typeof mutation !== 'object' || mutation === null) continue;
      for (const [field, world] of Object.entries(HANDLER_REF_WORLDS)) {
        const name = (mutation as Record<string, unknown>)[field];
        if (typeof name !== 'string' || !name) continue;
        const worlds = out.get(name) ?? new Set<HandlerWorld>();
        worlds.add(world);
        out.set(name, worlds);
      }
    }
  }
  return out;
}

// transformLiteral's module convention (rewrite-response.ts): a plain
// two-argument call, so the module-level `this` is the page's global and
// `arguments` has two entries, and the export only when it is a function.
const PAGE_IIFE_PREFIX = '(function () {\nvar module = { exports: {} };\n(function (module, exports) {\n';
const PAGE_IIFE_SUFFIX = '\n})(module, module.exports);\nreturn typeof module.exports === "function" ? module.exports : null;\n})()';
// A name referenced from both worlds is one source (lint refuses two), so its
// expression picks the wrapper where it is evaluated: only the isolated world
// has a string `__filename` in scope (compileBag's module wrapper on the
// stored path, compileInlineHandlers inline); a transform / wrap spliced into
// the page sees none. Re-wrapped as `module.exports = <expr>;` it picks the
// same way, so a commit keeps both worlds' conventions.
const CROSS_PREFIX = "(typeof __filename === 'string'\n? ";
const CROSS_MIDDLE = '\n: ';
const CROSS_SUFFIX = ')';

/** The module wrapped to run inline under `world`'s convention. */
export function wrapModuleForWorld(moduleSource: string, world: HandlerWorld): string {
  return world === 'page'
    ? `${PAGE_IIFE_PREFIX}${moduleSource}${PAGE_IIFE_SUFFIX}`
    : `${MODULE_IIFE_PREFIX}${moduleSource}${MODULE_IIFE_SUFFIX}`;
}

/** One expression that evaluates `isolated` in the isolated world and `page` in the page's. */
export function crossWorldExpression(isolated: string, page: string): string {
  return isolated === page ? isolated : `${CROSS_PREFIX}${isolated}${CROSS_MIDDLE}${page}${CROSS_SUFFIX}`;
}

function wrapModuleForWorlds(moduleSource: string, worlds: HandlerWorld | ReadonlySet<HandlerWorld>): string {
  if (typeof worlds === 'string') return wrapModuleForWorld(moduleSource, worlds);
  const isolated = worlds.has('isolated') || worlds.size === 0;
  const page = worlds.has('page');
  if (isolated && page) return crossWorldExpression(wrapModuleForWorld(moduleSource, 'isolated'), wrapModuleForWorld(moduleSource, 'page'));
  return wrapModuleForWorld(moduleSource, page ? 'page' : 'isolated');
}

// The names a module's code can only resolve inside its CommonJS wrapper
// (and its receiver). A bare expression runs inline without that wrapper,
// so one that mentions any of them keeps the IIFE, which binds them.
// A unicode escape can spell any of them (`m\u006fdule`), so it keeps the
// IIFE too.
const CJS_BINDING_RE = /\b(?:module|exports|require|arguments|this|__filename|__dirname|eval)\b|\\u/;

// Whether an exported expression runs the same unwrapped: it uses none of the
// wrapper's bindings, and it parses as `(<expr>)` with the closer on its last
// line — inline compile puts it there, so a trailing `// comment` would
// swallow it (the IIFE's closer sits on its own line).
function safeBareExpression(expression: string): boolean {
  return !CJS_BINDING_RE.test(expression) && syntaxProbe(`(${expression})`).ok;
}

/**
 * `<expr>` when a module is nothing but `module.exports = <expr>;` (give or
 * take whitespace and the semicolon) and `<expr>` parses as one expression;
 * null for any other module.
 */
export function exportedExpression(moduleSource: string): string | null {
  const inner = exactWrappedExpression(moduleSource) ?? WRAPPED_EXPRESSION_RE.exec(moduleSource)?.[1];
  return inner && syntaxProbe(`(${inner}\n)`).ok ? inner : null;
}

// A whole expression that is a primitive literal: a number, a keyword value,
// or a plain string / template without substitutions. Never a function.
const PRIMITIVE_LITERAL_RE = new RegExp([
  String.raw`^[-+]?(?:0[xob][\da-f_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:e[-+]?\d+)?)n?$`,
  String.raw`^(?:null|undefined|true|false|NaN|Infinity)$`,
  String.raw`^'(?:\\[\s\S]|[^'\\\n])*'$`,
  String.raw`^"(?:\\[\s\S]|[^"\\\n])*"$`,
  String.raw`^\x60(?:\\[\s\S]|[^\x60\\$]|\$(?!\{))*\x60$`,
].join('|'), 'i');

// 'an object' / 'an array' when a whole expression is one object or array
// literal (never a function), else null. An expression starting with `{` or
// `[` opens a literal, and no prefix of it parses until that literal closes,
// so the first closing bracket at which the prefix parses is the literal's
// own: the literal is the whole expression only if that is the last
// character. (`[fn][0]` or `{}.constructor` close earlier, so they pass.) The
// parser does the bracket matching, so strings, comments, templates and
// regexes that hold brackets can't fool it.
function wholeLiteral(expression: string): string | null {
  const open = expression[0];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return null;
  for (let end = expression.indexOf(close); end !== -1; end = expression.indexOf(close, end + 1)) {
    if (!syntaxProbe(`(${expression.slice(0, end + 1)}\n)`).ok) continue;
    if (end !== expression.length - 1) return null;
    return open === '{' ? 'an object' : 'an array';
  }
  return null;
}

// Any reference to `module`. A module with none can't change
// `module.exports` (`exports` and `this` are the original object), so it
// certainly exports no function. The test is deliberately loose: one that
// looked for a `module.exports = ...` assignment would refuse
// `Object.defineProperty(module, 'exports', ...)` or
// `Object.assign(module, { exports })`, which import accepts, and a regex
// can't see past comments and strings either way.
const MODULE_REF_RE = /\bmodule\b/;
// The other ways a module can reach `module` without spelling it: the
// wrapper's `arguments` (`arguments[0].exports = …`), a direct `eval`, and a
// unicode escape in an identifier (`m\u006fdule`). A source using any of them
// is left to the browser's execution-based check.
const INDIRECT_MODULE_REF_RE = /\barguments\b|\beval\b|\\u/;

/**
 * Why a handler module can't give the browser a function, or null when
 * nothing static rules it out. The browser compiles a module as
 * `(function (module, exports) { <source> })` and requires
 * `module.exports` to be a function after it runs (import's
 * assertHandlersBound). Core never runs handler code, so this is the static
 * part of that check, and it never refuses a module import would accept: a
 * syntax error, a module that never refers to `module` and so can't assign
 * `module.exports` (a bare `function notes() {}`), or one that exports a
 * literal (`module.exports = 42;`, `= {}`, `= []`). An export only known at
 * run time (a call's result, a variable) passes here and is the browser's to
 * check.
 */
export function handlerModuleProblem(moduleSource: string): string | null {
  if (!moduleSource.trim()) return 'is empty';
  const syntax = syntaxProbe(`(function (module, exports) {\n${moduleSource}\n});`);
  if (!syntax.ok) return `does not parse as JavaScript: ${syntax.error ?? 'syntax error'}`;
  if (!MODULE_REF_RE.test(moduleSource) && !INDIRECT_MODULE_REF_RE.test(moduleSource)) {
    return 'never assigns module.exports — a handler file is `module.exports = function (ctx) { ... };`';
  }
  const expression = exportedExpression(moduleSource)?.trim();
  if (expression === undefined) return null;
  const literal = PRIMITIVE_LITERAL_RE.test(expression)
    ? (expression.length > 40 ? `${expression.slice(0, 37)}...` : expression)
    : wholeLiteral(expression);
  if (literal === null) return null;
  return `exports ${literal}, not a function — a handler file is \`module.exports = function (ctx) { ... };\``;
}

/**
 * The module a rule-local expression stands for — moduleToExpression's
 * inverse. An expression moduleToExpression wrapped as an IIFE gives back the
 * module it wrapped, byte for byte (so a checkout shows an agent the file it
 * wrote, not the wrapper); any other expression is expressionToModule's
 * `module.exports = <expr>;`. Both readings run the same code.
 */
export function moduleForExpression(expression: string): string {
  return wrappedModule(expression) ?? expressionToModule(expression);
}

/**
 * Whether evaluating `expression` inline gives the same, single module the
 * stored `moduleSource` is — so a host may reuse the stored module's compiled
 * export for it instead of evaluating the module a second time. True when the
 * expression is one of the wrapper forms around that module (it runs the
 * module in its own CommonJS scope; the stored module is that module, or the
 * wrapper's own `module.exports = <wrapper>;` once committed), or when it is the module's
 * `module.exports = <expr>` export and names none of the CommonJS bindings
 * (so the module scope and the inline scope evaluate it identically). Source
 * compared ignoring surrounding whitespace and trailing semicolons.
 */
export function isStoredModuleExpression(moduleSource: string, expression: string): boolean {
  const canonical = (src: string): string => src.trim().replace(/[;\s]+$/, '');
  const stored = canonical(moduleSource);
  const wrapped = wrappedModule(expression);
  // A wrapper is the module either as written (hydration's, before a commit)
  // or as commit stores the wrapper itself (`module.exports = <wrapper>;`).
  if (wrapped !== null) return canonical(wrapped) === stored || canonical(expressionToModule(expression)) === stored;
  return !CJS_BINDING_RE.test(expression) && canonical(expressionToModule(expression)) === stored;
}

/**
 * Whether an expression is one of moduleToExpression's wrapper forms (either
 * world's, or the cross-world pick of both) — a whole module run in its own
 * CommonJS scope, so evaluating it inline or as the stored
 * `module.exports = <expr>;` runs the module identically.
 */
export function isModuleWrapperExpression(expression: string): boolean {
  return wrappedModule(expression) !== null;
}

// The module a wrapper form (either world's, or the cross-world pick of both)
// wrapped, when the expression is exactly that wrapper around it.
function wrappedModule(expression: string): string | null {
  const between = (prefix: string, suffix: string): string | null =>
    expression.length >= prefix.length + suffix.length && expression.startsWith(prefix) && expression.endsWith(suffix)
      ? expression.slice(prefix.length, expression.length - suffix.length)
      : null;
  for (const world of ['isolated', 'page'] as const) {
    const inner = world === 'page' ? between(PAGE_IIFE_PREFIX, PAGE_IIFE_SUFFIX) : between(MODULE_IIFE_PREFIX, MODULE_IIFE_SUFFIX);
    if (inner !== null && wrapModuleForWorld(inner, world) === expression) return inner;
  }
  const both = between(`${CROSS_PREFIX}${MODULE_IIFE_PREFIX}`, `${PAGE_IIFE_SUFFIX}${CROSS_SUFFIX}`);
  if (both !== null) {
    // The module appears twice; the first copy ends where the isolated
    // wrapper's suffix plus the page wrapper's prefix begin. Rebuilding the
    // whole expression from it is the proof it is this form.
    const join = `${MODULE_IIFE_SUFFIX}${CROSS_MIDDLE}${PAGE_IIFE_PREFIX}`;
    for (let at = both.indexOf(join); at !== -1; at = both.indexOf(join, at + 1)) {
      const inner = both.slice(0, at);
      if (wrapModuleForWorlds(inner, new Set<HandlerWorld>(['isolated', 'page'])) === expression) return inner;
    }
  }
  return null;
}

// Collapse the spec's handler sources into a flat { name: moduleSource }
// map, wrapping bare function expressions (LLM's rule.handlers convention)
// into full module form. Import-carried spec.handlers arrive already
// wrapped; on name collisions they win, matching the pre-SQLite order.
// (Two rules defining one name with different source is a spec-lint error,
// so a lint-clean spec loses nothing here.)
export function extractHandlers(spec: SpecWithHandlers): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const rule of spec.rules || []) {
    if (!rule.handlers) continue;
    for (const [name, source] of Object.entries(rule.handlers)) {
      merged[name] = expressionToModule(source);
    }
  }
  if (spec.handlers) {
    for (const [name, source] of Object.entries(spec.handlers)) {
      merged[name] = source;
    }
  }
  return merged;
}
