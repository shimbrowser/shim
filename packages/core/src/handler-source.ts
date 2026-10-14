// Handler source forms (CLAUDE.md §5). A handler is authored rule-local as a
// bare function EXPRESSION (`rule.handlers[name]`, the LLM's convention) and
// stored, exported and shipped by name as a CJS MODULE (`module.exports =
// <expr>;`) — patch_files, a `.shim` file's top-level `handlers` map, a shim
// folder's handlers/<name>.js. This module owns the flattening between the
// two so the browser's commit path and the shim folder format agree on it.

import type { Spec } from './types';
import { syntaxProbe } from './syntax-probe';

/** A spec that may carry an import-time top-level `handlers` map (module form). */
export type SpecWithHandlers = Spec & { handlers?: Record<string, string> };

const MODULE_PREFIX = 'module.exports = ';
const MODULE_SUFFIX = ';\n';

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
// The IIFE moduleToExpression wraps a module in: runs it in its own
// `(module, exports)` scope and evaluates to its `module.exports`.
const MODULE_IIFE_PREFIX = '(function () {\nvar module = { exports: {} };\n(function (module, exports) {\n';
// `.call(module.exports, …)` keeps CommonJS's top-level `this` (the browser's
// module compile runs a module with `this === module.exports`).
const MODULE_IIFE_SUFFIX = '\n}).call(module.exports, module, module.exports);\nreturn module.exports;\n})()';

const WRAPPED_EXPRESSION_RE = /^\s*module\.exports\s*=\s*([\s\S]*?)\s*;?\s*$/;

/**
 * The rule-local expression form of a handler module (a shim folder's
 * handlers/<name>.js going back onto `rule.handlers`). A module that is just
 * `module.exports = <expr>;` gives back `<expr>`, so expression → module →
 * expression is the identity. Anything else (helpers beside the export, a
 * leading comment) becomes an IIFE that runs the module in its own
 * `(module, exports)` scope and evaluates to its `module.exports` — the same
 * value the browser's module compile produces, in a form `module.exports =
 * <expr>;` can carry.
 */
export function moduleToExpression(moduleSource: string): string {
  return exportedExpression(moduleSource) ?? `${MODULE_IIFE_PREFIX}${moduleSource}${MODULE_IIFE_SUFFIX}`;
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
  if (!MODULE_REF_RE.test(moduleSource)) {
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
  if (expression.startsWith(MODULE_IIFE_PREFIX) && expression.endsWith(MODULE_IIFE_SUFFIX)
    && expression.length >= MODULE_IIFE_PREFIX.length + MODULE_IIFE_SUFFIX.length) {
    return expression.slice(MODULE_IIFE_PREFIX.length, expression.length - MODULE_IIFE_SUFFIX.length);
  }
  return expressionToModule(expression);
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
