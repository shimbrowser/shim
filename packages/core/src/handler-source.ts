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
  const inner = exactWrappedExpression(moduleSource) ?? WRAPPED_EXPRESSION_RE.exec(moduleSource)?.[1];
  if (inner && syntaxProbe(`(${inner}\n)`).ok) return inner;
  return '(function () {\n'
    + 'var module = { exports: {} };\n'
    + '(function (module, exports) {\n'
    + `${moduleSource}\n`
    + '})(module, module.exports);\n'
    + 'return module.exports;\n'
    + '})()';
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
