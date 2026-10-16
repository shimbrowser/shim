// syntaxProbe — a `CompileProbe` (rewrite-response.ts) that needs no Node:
// does `code` parse as a classic SCRIPT, with exactly the diagnostics
// `new vm.Script(code)` gives? spec-lint runs it over rewrite-response
// transforms and intercept wraps so a malformed one is rejected at emit /
// commit / import instead of poisoning the shared install script. It
// used to be `vm.Script`; core imports no Node builtin,
// so the same check is built from two parses the language itself offers.
// Nothing in `code` ever runs: pass 1's first statement throws before any of
// it, and declaration instantiation only creates bindings and uncalled
// function objects; pass 2 constructs a function it never calls. (Handler
// source is trusted code anyway; this is a parse, not a gate.)
//
//   1. Script grammar, sloppy, via a DIRECT eval inside an arrow function
//      created at global scope (by one indirect eval). The eval'd source is
//      `throw 0;\n` + code, so evaluation stops before any of `code` runs.
//      Why each piece:
//        - eval code, not a function body: a top-level `return` is a
//          SyntaxError, as in a script.
//        - inside an ARROW at global scope: `new.target` stays a
//          SyntaxError (an arrow takes it from its enclosing function, and
//          there is none), while the arrow's own variable scope catches the
//          declarations eval instantiates — `var` / function declarations
//          never reach the global object.
//        - created by an indirect eval, so the arrow is sloppy whatever the
//          strictness of this module.
//   2. The prefix pushes `code`'s directive prologue out of directive
//      position, so a leading "use strict" is not seen by (1). `new
//      Function(code)` (constructed, never called) parses the same source as
//      a function body, where the prologue does apply. Every script is a
//      valid function body, so this pass only adds the strict-mode errors.
//
// (1) runs first so a source broken in both reports the script parser's
// message, which is what vm.Script reports. A leading hashbang (legal at the
// start of a script) is blanked to a `//` comment of the same length for
// both passes, since the prefix would otherwise move it off the start.
//
// Pinned against vm.Script over a corpus in packages/core/test/
// syntax-probe-harness.ts. Both passes need the host to allow eval: under a
// page CSP without 'unsafe-eval' the probe answers not-ok with a reason
// rather than passing source it could not check.

import type { CompileProbe } from './rewrite-response';

type ScriptParser = (source: string) => unknown;

let scriptParser: ScriptParser | null = null;

function getScriptParser(): ScriptParser {
  if (scriptParser) return scriptParser;
  // Indirect eval: evaluated as global, sloppy code.
  const made: unknown = (0, eval)('(__shimProbeSource) => eval(__shimProbeSource)');
  if (typeof made !== 'function') throw new Error('syntax probe: could not create the script parser');
  scriptParser = made as ScriptParser;
  return scriptParser;
}

// The value the prefix throws. Anything else caught means the parse failed.
const HALT = 0;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const syntaxProbe: CompileProbe = (code) => {
  const source = code.startsWith('#!') ? `//${code.slice(2)}` : code;
  let parse: ScriptParser;
  try {
    parse = getScriptParser();
  } catch (err) {
    return { ok: false, error: `syntax check unavailable in this host (${messageOf(err)})` };
  }
  try {
    parse(`throw ${HALT};\n${source}`);
  } catch (err) {
    if (err !== HALT) {
      if (err instanceof EvalError) return { ok: false, error: `syntax check unavailable in this host (${err.message})` };
      return { ok: false, error: messageOf(err) };
    }
  }
  try {
    // Constructed to parse, never called.
    new Function(source);
  } catch (err) {
    if (err instanceof EvalError) return { ok: false, error: `syntax check unavailable in this host (${err.message})` };
    return { ok: false, error: messageOf(err) };
  }
  return { ok: true };
};
