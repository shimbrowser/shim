// Pins the full-mode handler compile (src/compile.ts): a stored module
// becomes the function the engine calls, through the same expression wrap
// and sourceURL layout the other hosts use; a module that does not parse or
// exports no function is a problem for its name alone, and the rest of the
// shim's handlers still compile.

import { compileHandlers, handlerSourceFor } from '../src/compile';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

console.log('\n=== compile harness ===\n');

const BADGE = 'module.exports = function badge({ anchor }) { return anchor; };';
const WITH_HELPER = 'const tag = "i";\nfunction make() { return document.createElement(tag); }\nmodule.exports = function helper() { return make; };';
const BROKEN = 'module.exports = function ( { return 1; };';
const NOT_A_FUNCTION = 'module.exports = 42;';
const NULL_EXPORT = 'module.exports = null;';

console.log('the source:');
{
  const src = handlerSourceFor(BADGE, 'shim-1', 'badge');
  check('wraps the expression with its closer on its own line', src.startsWith('(function badge') && src.includes('\n)'));
  check('ends with the sourceURL pragma on a line of its own', /\n\/\/# sourceURL=shim:\/\/patches\/shim-1\/handlers\/badge\.js\n$/.test(src), JSON.stringify(src.slice(-70)));
  const helper = handlerSourceFor(WITH_HELPER, 'shim-1', 'helper');
  check('a module with helpers beside the export runs in its own CommonJS scope', helper.includes('var module = { exports: {} }'));
}

console.log('compiling:');
{
  const { handlers, problems } = compileHandlers({ badge: BADGE, helper: WITH_HELPER }, 'shim-1');
  check('every module compiles', Object.keys(handlers).sort().join(',') === 'badge,helper' && problems.length === 0, JSON.stringify(problems));
  const badge = handlers.badge as unknown as (ctx: { anchor: string }) => string;
  check('to the function the module exports', typeof badge === 'function' && badge({ anchor: 'x' }) === 'x');
  const helper = handlers.helper as unknown as () => unknown;
  check('with its helpers in scope', typeof helper === 'function' && typeof helper() === 'function');
}
{
  const { handlers, problems } = compileHandlers({ badge: BADGE, broken: BROKEN, number: NOT_A_FUNCTION, nothing: NULL_EXPORT }, 'shim-2');
  check('a module that does not parse is a problem for its name', problems.some((p) => p.name === 'broken' && /SyntaxError/.test(p.error)), JSON.stringify(problems));
  check('a module that exports no function is a problem for its name', problems.some((p) => p.name === 'number' && p.error === 'exports number, not a function'), JSON.stringify(problems));
  check('a null export too', problems.some((p) => p.name === 'nothing' && p.error === 'exports null, not a function'), JSON.stringify(problems));
  check('the good one still compiles', typeof handlers.badge === 'function' && !('broken' in handlers) && !('number' in handlers));
  check('nothing else is reported', problems.length === 3);
}
{
  // An evaluator of the harness's own, so the compile's own eval is not what is pinned.
  const seen: string[] = [];
  const { handlers } = compileHandlers({ badge: BADGE }, 'shim-3', (code) => { seen.push(code); return () => 'evaluated'; });
  check('the evaluator receives the wrapped source', seen.length === 1 && seen[0] === handlerSourceFor(BADGE, 'shim-3', 'badge'));
  check('and its function is the handler', (handlers.badge as unknown as () => string)() === 'evaluated');
}
{
  const { handlers, problems } = compileHandlers({}, 'shim-4');
  check('no modules, no handlers, no problems', Object.keys(handlers).length === 0 && problems.length === 0);
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log(`all compile checks passed (${passes})`);
