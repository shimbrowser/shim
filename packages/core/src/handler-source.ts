// Handler source forms (CLAUDE.md §5). A handler is authored rule-local as a
// bare function EXPRESSION (`rule.handlers[name]`, the LLM's convention) and
// stored, exported and shipped by name as a CJS MODULE (`module.exports =
// <expr>;`) — patch_files, a `.shim` file's top-level `handlers` map, a shim
// folder's handlers/<name>.js. This module owns the flattening between the
// two so the browser's commit path and the shim folder format agree on it.

import type { Spec } from './types';

/** A spec that may carry an import-time top-level `handlers` map (module form). */
export type SpecWithHandlers = Spec & { handlers?: Record<string, string> };

/** The module form a rule-local handler expression is stored in. */
export function expressionToModule(expression: string): string {
  return `module.exports = ${expression};\n`;
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
