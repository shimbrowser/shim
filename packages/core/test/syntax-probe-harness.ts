// Harness for core's Node-free syntax probe (packages/core/src/syntax-probe.ts).
//
// spec-lint used `new vm.Script(code)` to syntax-check rewrite-response
// transforms and intercept wraps. Core imports no Node builtin (shim-core
// design D4), so `syntaxProbe` rebuilds the check from an eval parse and a
// `new Function` parse. This pins it to vm.Script: same accept / reject AND the
// same error message, over a corpus that covers the places the two grammars
// could drift (top-level return and new.target, directive prologues, hashbangs,
// HTML-like comments, function-body injection, module syntax). It also pins
// that the probe never runs the source and never leaks a declaration onto the
// global object.
//
//   node out/packages/core/test/syntax-probe-harness.js
//
// Bare node. Uses `vm` as the reference only — the probe itself never does.

import * as vm from 'vm';
import { syntaxProbe } from '../src/syntax-probe';
import { detectTransformForm } from '../src/rewrite-response';
import type { CompileProbe } from '../src/rewrite-response';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const vmProbe: CompileProbe = (code) => {
  try { new vm.Script(code); return { ok: true }; } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

const CORPUS: string[] = [
  // Well-formed: the shapes transforms and wraps are written in.
  'function f(){}',
  '(function transform(body) { return body; }\n)',
  'module.exports = function (body) { return body; };\n',
  'module.exports = function (body) { return body; }',
  'const KEEP = 2;\nmodule.exports = (body) => body.slice(0, KEEP);',
  '(body) => ({ ...body, items: body.items.filter(Boolean) })',
  'async () => await 1',
  'function* g() { yield 1; }',
  'a?.b ?? c',
  'class A { #x = 1; has(o) { return #x in o; } }',
  '/x/u.test("a")',
  'with (a) {}',
  '010',
  'let let1 = 1; var arguments2 = 2;',
  'if (1) function f(){}',
  'arguments',
  'this',
  'debugger',
  'throw 1',
  'while (true) {}',
  'var s = 1',
  'let __shimProbeSource = 2',
  'var leakedVar = 1; function leakedFn(){}',
  'globalThis.probeRan = true;',
  '<!-- html open comment\nfoo()',
  'x\n-->html close comment',
  '#!/usr/bin/env node\nx()',
  '',
  '   ',
  '// only a comment',
  // Script-grammar errors a function body would accept.
  'return 1',
  'return',
  'new.target',
  'new.target.x',
  '() => new.target',
  // Allowed again inside a real function.
  'function f(){ return new.target }',
  // Directive prologue: strict-only errors.
  '"use strict"; with (a) {}',
  "'use strict'\nvar eval",
  '"use strict"; 010',
  '"use strict"; delete x',
  '"use strict"; function f(a, a){}',
  '"use strict"; let implements',
  // Plain syntax errors.
  'function(){',
  '}',
  '}{',
  'x =>',
  '(1+)',
  'a b',
  'const a;',
  'let x = 1; let x = 2;',
  'await x',
  'yield x',
  'enum',
  'break',
  'super.x',
  'import x from "y"',
  'export default 1',
  'class A { m(){ return this.#y } }',
  'for await (x of y) {}',
  '/* unterminated',
  '`unterminated',
  "'unterminated",
  '/[/',
  '#!/x\n}',
  // Function-body injection: must stay a syntax error, never a second function.
  '}); evil(); (function(){',
  '*/ x /*',
  '}, function () {',
];

console.log('syntaxProbe matches vm.Script — accept/reject and message');
for (const code of CORPUS) {
  const want = vmProbe(code);
  const got = syntaxProbe(code);
  const same = want.ok === got.ok && want.error === got.error;
  check(JSON.stringify(code).slice(0, 70), same, `vm=${JSON.stringify(want)} probe=${JSON.stringify(got)}`);
}

console.log('detectTransformForm agrees under either probe');
const FORMS = [
  'function (body) { return body; }',
  'module.exports = function (body) { return body; };\n',
  'const X = 1;\nmodule.exports = (b) => b;',
  'function (body) { return body;',
  'return body',
  'function (body) { return new.target; }',
];
for (const src of FORMS) {
  const want = detectTransformForm(src, vmProbe);
  const got = detectTransformForm(src, syntaxProbe);
  check(`form of ${JSON.stringify(src).slice(0, 50)}`, JSON.stringify(want) === JSON.stringify(got),
    `vm=${JSON.stringify(want)} probe=${JSON.stringify(got)}`);
}

console.log('the probe never runs the source and leaks nothing');
const g = globalThis as Record<string, unknown>;
check('a top-level statement did not run', g.probeRan === undefined, String(g.probeRan));
check('a var declaration did not reach the global object', !('leakedVar' in g));
check('a function declaration did not reach the global object', !('leakedFn' in g));
let sideEffect = false;
g.__probeSideEffect = () => { sideEffect = true; };
syntaxProbe('__probeSideEffect();');
syntaxProbe('(function () { __probeSideEffect(); })()');
syntaxProbe('"use strict"; __probeSideEffect();');
check('a call in the source is never made', sideEffect === false);
delete g.__probeSideEffect;

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
