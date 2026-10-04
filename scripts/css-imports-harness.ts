// Harness for src/patch-engine/css-imports.ts `leadingImports` — the parser the
// strict-CSP style mirror uses to carry a refused sheet's `@import`s over as
// `<link>`s (constructable sheets drop `@import`; style-mirror.ts). Bare node.
//
//   node out/scripts/css-imports-harness.js

import { leadingImports } from '../src/patch-engine/css-imports';
import type { LeadingImports } from '../src/patch-engine/css-imports';

let failures = 0;
function eq(label: string, actual: LeadingImports, expected: LeadingImports): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      got      ${a}\n      expected ${e}`}`);
  if (!ok) failures++;
}
const only = (...imports: Array<[string, string]>): LeadingImports =>
  ({ imports: imports.map(([href, media]) => ({ href, media })), unsupported: 0 });

eq('no imports', leadingImports('.a { color: red; }'), only());
eq('empty text', leadingImports(''), only());
eq('url() with single quotes', leadingImports("@import url('/shim.css');\n.a{}"), only(['/shim.css', '']));
eq('url() unquoted', leadingImports('@import url(/x.css);'), only(['/x.css', '']));
eq('bare string', leadingImports('@import "https://cdn.example/x.css";'), only(['https://cdn.example/x.css', '']));
eq('media query kept', leadingImports('@import url(a.css) screen and (min-width: 600px);'), only(['a.css', 'screen and (min-width: 600px)']));
eq('several, with comments and whitespace between',
  leadingImports('/* fonts */\n  @import url(a.css);\n/* x */ @IMPORT "b.css" print;\n.a{}'),
  only(['a.css', ''], ['b.css', 'print']));
eq('@charset and @layer statements may precede',
  leadingImports('@charset "utf-8";\n@layer base, shim;\n@import url(a.css);'),
  only(['a.css', '']));
eq('a @layer block ends the import block', leadingImports('@layer shim { .a{} }\n@import url(a.css);'), only());
eq('an @import after a style rule is invalid and ignored', leadingImports('.a{}\n@import url(a.css);'), only());
eq('quoted ; and ) inside the url', leadingImports('@import url("a;b).css");@import url(c.css);'), only(['a;b).css', ''], ['c.css', '']));
eq('layer(…) import is unsupported', leadingImports('@import url(a.css) layer(x);@import url(b.css);'), { imports: [{ href: 'b.css', media: '' }], unsupported: 1 });
eq('bare layer keyword is unsupported', leadingImports('@import "a.css" layer;'), { imports: [], unsupported: 1 });
eq('supports(…) import is unsupported', leadingImports('@import "a.css" supports(display: grid);'), { imports: [], unsupported: 1 });
eq('comment between @import and url()', leadingImports("@import /* generated */ url('/shim.css');"), only(['/shim.css', '']));
eq('comments around a bare string and inside a quoted url()', leadingImports('@import/*a*/"a.css"/*b*/ print;@import url( "b.css" /*c*/ );'), only(['a.css', 'print'], ['b.css', '']));
eq('@importer is not @import', leadingImports('@importer url(a.css);'), only());
eq('unterminated import is dropped', leadingImports('@import url(a.css)'), only());
eq('malformed prelude skipped, later import kept', leadingImports('@import foo;@import "b.css";'), only(['b.css', '']));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
