// The handler compile for full mode: a shim's stored handler modules become
// the functions the engine calls, the way the Shim browser's preload and
// the headless driver compile them (the same expression wrap and the same
// `sourceURL` layout, so a stack trace reads the same on every host). It
// runs where eval is allowed: the user-script world. A module that does
// not compile, or exports no function, is a problem the runtime reports
// (`handler-compile-failed`) and the rule then has no handler. Pure apart
// from the evaluator, which a harness can supply.

import type * as Core from '@shimbrowser/core';
import { handlerExpressionSource, moduleToExpression } from '@shimbrowser/core/handler-source';

type PatchBundle = Parameters<typeof Core.run>[0];
export type HandlerMap = NonNullable<PatchBundle['handlers']>;
type HandlerFn = HandlerMap[string];

export interface CompileProblem {
  name: string;
  error: string;
}

/** The source that evaluates to the handler `name` of shim `shimId`, from its stored module. */
export function handlerSourceFor(moduleSource: string, shimId: string, name: string): string {
  // `sourceURL` runs to end of line, and the expression wrap already puts
  // its closer on its own line; the pragma then gets a line of its own.
  return `${handlerExpressionSource(moduleToExpression(moduleSource, 'isolated'))}\n//# sourceURL=shim://patches/${shimId}/handlers/${name}.js\n`;
}

// Indirect eval: global, sloppy, so the module wrapper's `typeof require`
// guards read the world's globals and nothing of this module's scope.
const indirectEval = (code: string): unknown => (0, eval)(code);

/**
 * Compile every module in `modules`. A failure never stops the others:
 * the rule whose handler failed reports it, the rest of the shim runs.
 */
export function compileHandlers(
  modules: Readonly<Record<string, string>>,
  shimId: string,
  evaluate: (code: string) => unknown = indirectEval,
): { handlers: HandlerMap; problems: CompileProblem[] } {
  const handlers: HandlerMap = {};
  const problems: CompileProblem[] = [];
  for (const [name, moduleSource] of Object.entries(modules)) {
    let value: unknown;
    try {
      value = evaluate(handlerSourceFor(moduleSource, shimId, name));
    } catch (err) {
      problems.push({ name, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      continue;
    }
    if (typeof value !== 'function') {
      problems.push({ name, error: `exports ${value === null ? 'null' : typeof value}, not a function` });
      continue;
    }
    // The one dynamic boundary: a compiled export's real signature is the
    // engine's to call with (anchor, mutation, rule, spec, api).
    handlers[name] = value as HandlerFn;
  }
  return { handlers, problems };
}
