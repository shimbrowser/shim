// Harness for src/patch-engine/css-imports.ts: `leadingImports` — the parser
// the strict-CSP style mirror uses to carry a refused sheet's `@import`s over
// as `<link>`s (constructable sheets drop `@import`; style-mirror.ts) — and
// `absolutizeUrls`, which keeps a copied import's relative url()s pointing at
// the imported sheet's directory. Bare node.
//
//   node out/scripts/css-imports-harness.js

import { absolutizeUrls, leadingImports } from '../src/patch-engine/css-imports';
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
  ({ imports: imports.map(([href, media]) => ({ href, media })), unsupported: 0, layerStatements: [] });
const withLayers = (layerStatements: string[], ...imports: Array<[string, string]>): LeadingImports =>
  ({ ...only(...imports), layerStatements });

eq('no imports', leadingImports('.a { color: red; }'), only());
eq('empty text', leadingImports(''), only());
eq('url() with single quotes', leadingImports("@import url('/shim.css');\n.a{}"), only(['/shim.css', '']));
eq('url() unquoted', leadingImports('@import url(/x.css);'), only(['/x.css', '']));
eq('bare string', leadingImports('@import "https://cdn.example/x.css";'), only(['https://cdn.example/x.css', '']));
eq('media query kept', leadingImports('@import url(a.css) screen and (min-width: 600px);'), only(['a.css', 'screen and (min-width: 600px)']));
eq('several, with comments and whitespace between',
  leadingImports('/* fonts */\n  @import url(a.css);\n/* x */ @IMPORT "b.css" print;\n.a{}'),
  only(['a.css', ''], ['b.css', 'print']));
eq('@charset and @layer statements may precede (layer statements reported)',
  leadingImports('@charset "utf-8";\n@layer base, shim;\n@import url(a.css);'),
  withLayers(['@layer base, shim;'], ['a.css', '']));
eq('a @layer statement after an @import ends the import block (as Chromium parses it)',
  leadingImports('@layer x;\n@import "a.css";\n@layer y;\n@import "b.css";'),
  withLayers(['@layer x;'], ['a.css', '']));
eq('a @layer block ends the import block', leadingImports('@layer shim { .a{} }\n@import url(a.css);'), only());
eq('an @import after a style rule is invalid and ignored', leadingImports('.a{}\n@import url(a.css);'), only());
eq('quoted ; and ) inside the url', leadingImports('@import url("a;b).css");@import url(c.css);'), only(['a;b).css', ''], ['c.css', '']));
eq('layer(…) import is unsupported', leadingImports('@import url(a.css) layer(x);@import url(b.css);'), { imports: [{ href: 'b.css', media: '' }], unsupported: 1, layerStatements: [] });
eq('bare layer keyword is unsupported', leadingImports('@import "a.css" layer;'), { imports: [], unsupported: 1, layerStatements: [] });
eq('supports(…) import is unsupported', leadingImports('@import "a.css" supports(display: grid);'), { imports: [], unsupported: 1, layerStatements: [] });
eq('comment between @import and url()', leadingImports("@import /* generated */ url('/shim.css');"), only(['/shim.css', '']));
eq('comments around a bare string and inside a quoted url()', leadingImports('@import/*a*/"a.css"/*b*/ print;@import url( "b.css" /*c*/ );'), only(['a.css', 'print'], ['b.css', '']));
eq('a { inside a comment after the url does not end the import block', leadingImports('@import url(\'/shim.css\') /* build {id} */;@import "b.css";'), only(['/shim.css', ''], ['b.css', '']));
eq('a ; inside a comment does not end the statement early', leadingImports('@import "a.css" /* x; y */ print;'), only(['a.css', 'print']));
eq('comments inside @charset / @layer statements are skipped', leadingImports('@layer a /* {b} */, c;@import url(a.css);'), withLayers(['@layer a /* {b} */, c;'], ['a.css', '']));
eq('hex escapes decode, consuming one trailing space', leadingImports('@import url("\\66 oo.css");@import "\\62 ar.css";@import url(\\62 az.css);'), only(['foo.css', ''], ['bar.css', ''], ['baz.css', '']));
eq('escaped ) inside an unquoted url', leadingImports('@import url(a\\).css) print;'), only(['a).css', 'print']));
eq('an unquoted url() body is raw: /* and ; are URL characters', leadingImports('@import url(/a/*;b.css);@import "c.css";'), only(['/a/*;b.css', ''], ['c.css', '']));
eq('an unclosed comment ends the import block', leadingImports('@import "a.css" /* never closed;'), only());
eq('@importer is not @import', leadingImports('@importer url(a.css);'), only());
eq('unterminated import is dropped', leadingImports('@import url(a.css)'), only());
eq('malformed prelude skipped, later import kept', leadingImports('@import foo;@import "b.css";'), only(['b.css', '']));

function eqText(label: string, actual: string, expected: string): void {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      got      ${actual}\n      expected ${expected}`}`);
  if (!ok) failures++;
}
const BASE = 'https://cdn.example/css/nested/leaf.css';
eqText('absolutize: quoted relative url', absolutizeUrls('.a { background: url("pixel.png"); }', BASE), '.a { background: url("https://cdn.example/css/nested/pixel.png"); }');
eqText('absolutize: unquoted, parent-relative and root-relative', absolutizeUrls(".a { b: url(../x.png), url( /y.png ); }", BASE), '.a { b: url("https://cdn.example/css/x.png"), url("https://cdn.example/y.png"); }');
eqText('absolutize: single quotes with an escaped quote', absolutizeUrls(".a { b: url('it\\'s.png'); }", BASE), '.a { b: url("https://cdn.example/css/nested/it\'s.png"); }');
eqText('absolutize: absolute, data: and fragment urls untouched', absolutizeUrls('.a { b: url("https://o.example/z.png"), url(data:image/png;base64,AA==), url(#f); }', BASE), '.a { b: url("https://o.example/z.png"), url(data:image/png;base64,AA==), url(#f); }');
eqText('absolutize: url( inside a string is text', absolutizeUrls('.a::before { content: "url(x.png)"; }', BASE), '.a::before { content: "url(x.png)"; }');
eqText('absolutize: an ident ending in url( is not a url token', absolutizeUrls('.a { b: myurl(x.png); }', BASE), '.a { b: myurl(x.png); }');
eqText('absolutize: @font-face src, uppercase URL(', absolutizeUrls('@font-face { src: URL(f.woff2) format("woff2"); }', BASE), '@font-face { src: url("https://cdn.example/css/nested/f.woff2") format("woff2"); }');
eqText('absolutize: hex escapes decode before resolving', absolutizeUrls('.a { b: url("\\66 oo.png"), url(\\62 ar.png); }', BASE), '.a { b: url("https://cdn.example/css/nested/foo.png"), url("https://cdn.example/css/nested/bar.png"); }');
eqText('absolutize: an escaped space and a line continuation', absolutizeUrls('.a { b: url("a\\ b.png"), url("c\\\nd.png"); }', BASE), '.a { b: url("https://cdn.example/css/nested/a%20b.png"), url("https://cdn.example/css/nested/cd.png"); }');
eqText('absolutize: unterminated url left as is', absolutizeUrls('.a { b: url(x.png', BASE), '.a { b: url(x.png');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
