// Path scope (packages/core/src/path-match.ts): globs, the bounded regex
// engine, excludes, and failing closed.
//
//   node out/packages/core/test/path-match-harness.js
//
// Two suites for the regex engine: agreement with RegExp on ordinary
// patterns (fixed and generated), and adversarial patterns with hand-written
// expectations and a time limit, where RegExp is never the oracle.

import {
  PATH_SCOPE_LIMITS, checkPathEntry, compilePathScope, inPathScope, matchingEntries, pathSubjects,
  type UrlParts,
} from '../src/path-match';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

function url(s: string): UrlParts {
  const u = new URL(s, 'https://example.com');
  return { pathname: u.pathname, search: u.search, hash: u.hash };
}
function inScope(paths: unknown, s: string): boolean { return inPathScope(compilePathScope(paths), url(s)); }
// The regex engine on a raw subject: the whole string goes in `pathname`,
// since a regex sees pathname + query + hash concatenated.
function engine(src: string, subject: string): boolean | string {
  const scope = compilePathScope([`re:${src}`]);
  if (!scope.ok) return scope.errors.join('; ');
  return inPathScope(scope, { pathname: subject, search: '', hash: '' });
}

console.log('no paths: every page');
check('undefined', inScope(undefined, '/anything'));
check('empty list', inScope([], '/anything?x#y'));

console.log('globs');
const globCases: Array<[string, string, boolean]> = [
  ['/history', '/history', true],
  ['/history', '/history/', true],
  ['/history/', '/history', true],
  ['/history', '/history/x', false],
  ['/history', '/historyx', false],
  ['/history', '/history?tab=2', true],
  ['/history', '/history#top', true],
  ['/', '/', true],
  ['/', '/a', false],
  ['/tracks/*', '/tracks/5', true],
  ['/tracks/*', '/tracks/', false],
  ['/tracks/*', '/tracks/5/edit', false],
  ['/tracks/*/edit', '/tracks/5/edit', true],
  ['/t*s', '/tracks', true],
  ['/t*s', '/t/s', false],
  ['/account/**', '/account', true],
  ['/account/**', '/account/a/b/c', true],
  ['/account/**', '/accounts', false],
  ['/a/**/b', '/a/b', true],
  ['/a/**/b', '/a/x/y/b', true],
  ['/a/**/b', '/a/x/y/c', false],
  ['/**', '/', true],
  ['/**', '/deep/path', true],
  ['/{history,bookmarks}', '/history', true],
  ['/{history,bookmarks}', '/bookmarks', true],
  ['/{history,bookmarks}', '/downloads', false],
  ['/x{,s}', '/x', true],
  ['/x{,s}', '/xs', true],
  ['/{a*,b}/c', '/abc/c', true],
  ['/a\\*b', '/a*b', true],
  ['/a\\*b', '/axb', false],
  ['/app#/inbox/*', '/app#/inbox/3', true],
  ['/app#/inbox/*', '/app#/sent/3', false],
  ['/app#/inbox/*', '/app', false],
  ['/app#', '/app', true],
  ['/app#', '/app#x', false],
  ['/app#/inbox/**', '/app#/inbox', true],
  ['/caf%C3%A9', '/café', true],
];
for (const [g, s, want] of globCases) check(`${g} on ${s} → ${want}`, inScope([g], s) === want);

console.log('regexes see pathname, query and hash');
check('anchored path without query', inScope(['re:^/tracks/\\d+$'], '/tracks/5'));
check('a query breaks a $ anchor', !inScope(['re:^/tracks/\\d+$'], '/tracks/5?x=1'));
check('allowing [?#] or end', inScope(['re:^/tracks/\\d+(?:[?#]|$)'], '/tracks/5?x=1'));
check('query visible', inScope(['re:tab=history'], '/library?tab=history'));
check('hash visible', inScope(['re:#/inbox'], '/app#/inbox'));
check('unanchored searches anywhere', inScope(['re:hist'], '/a/history/b'));
check('no percent-decoding', inScope(['re:caf%C3%A9'], '/café') && !inScope(['re:café'], '/café'));

console.log('includes and excludes');
check('include miss is out', !inScope(['/a'], '/b'));
check('any include hit is in', inScope(['/a', '/b'], '/b'));
check('exclude wins', !inScope(['/a/**', '!/a/secret'], '/a/secret'));
check('exclude elsewhere leaves include', inScope(['/a/**', '!/a/secret'], '/a/open'));
check('only excludes: everything else in', inScope(['!/admin/**'], '/home') && !inScope(['!/admin/**'], '/admin/x'));
check('regex exclude', !inScope(['!re:\\?debug'], '/x?debug=1') && inScope(['!re:\\?debug'], '/x'));

console.log('fails closed');
for (const bad of [['re:(a'], ['/ok', 're:\\1'], 'nope', [42], [''], ['history'], [null]]) {
  const scope = compilePathScope(bad);
  check(`${JSON.stringify(bad)} → not ok, out of scope`, !scope.ok && !inPathScope(scope, url('/history')) && scope.errors.length > 0, scope.errors.join('; '));
}
const hostile: unknown = JSON.parse('[{"toString":null,"valueOf":null}]');
let hostileScope: ReturnType<typeof compilePathScope> | null;
try { hostileScope = compilePathScope(hostile); } catch { hostileScope = null; }
check('an object entry whose toString is null is refused, not thrown', hostileScope !== null && !hostileScope.ok);
let hostileEntry: ReturnType<typeof checkPathEntry> | null;
try { hostileEntry = checkPathEntry(JSON.parse('{"toString":null}')); } catch { hostileEntry = null; }
check('…and by checkPathEntry', hostileEntry !== null && !hostileEntry.ok);
check('too many entries', !compilePathScope(Array.from({ length: PATH_SCOPE_LIMITS.entries + 1 }, (_, i) => `/p${i}`)).ok);
check('the cap itself is fine', compilePathScope(Array.from({ length: PATH_SCOPE_LIMITS.entries }, (_, i) => `/p${i}`)).ok);
check('an over-long entry', !checkPathEntry(`/${'a'.repeat(PATH_SCOPE_LIMITS.entryChars)}`).ok);
const longUrl = { pathname: `/${'a'.repeat(PATH_SCOPE_LIMITS.subjectChars)}`, search: '', hash: '' };
check('a URL too long to test is out', !inPathScope(compilePathScope(['/**']), longUrl));
check('…unless there are no paths', inPathScope(compilePathScope([]), longUrl));
check('list-wide state cap', !compilePathScope(Array.from({ length: 5 }, () => 're:a{1000}')).ok);

console.log('refused regex syntax, with a message');
const refused: Array<[string, RegExp]> = [
  ['(a)\\1', /backreference/],
  ['(?<n>a)\\k<n>', /named/],
  ['a(?=b)', /lookaround/],
  ['(?<!a)b', /lookaround/],
  ['(?<name>a)', /named group/],
  ['\\bword', /word boundar/],
  ['\\p{L}', /property/],
  ['(?i)a', /isn't supported/],
  ['*a', /nothing to repeat/],
  ['a**', /nothing to repeat/],
  ['^*', /nothing to repeat/],
  ['a{2}{3}', /nothing to repeat/],
  ['a{', /escape it/],
  ['a{,3}', /escape it/],
  ['a{3,1}', /out of order/],
  ['[z-a]', /out of order/],
  ['(a', /unclosed/],
  ['a)', /unmatched/],
  ['[abc', /unclosed/],
  ['a{1001}', /count above/],
  ['\\u{1F600}', /u flag/],
  ['\\q', /supported escape/],
  ['\\07', /octal/],
  ['((((((((((( a)))))))))))', /nest/],
  ['', /empty/],
];
for (const [src, msg] of refused) {
  const r = checkPathEntry(`re:${src}`);
  check(`re:${src} refused`, !r.ok && msg.test(r.error), r.ok ? 'accepted' : r.error);
}
for (const [g, msg] of [['/a?', /query/], ['/a**b', /whole segment/], ['/{a,{b}}', /nest/], ['/{a', /unclosed/], ['/a}', /unmatched/], ['x', /start with/], ['/{a/b}', /"\/"/]] as const) {
  const r = checkPathEntry(g);
  check(`glob ${g} refused`, !r.ok && msg.test(r.error), r.ok ? 'accepted' : r.error);
}

console.log('agreement with RegExp (fixed)');
const agreePatterns = [
  '^/history$', 'history', '^/tracks/\\d+$', '^/a|^/b', 'a|b|c', '(ab)+', '(?:ab)*c', 'a?b', 'a{2}', 'a{2,}', 'a{1,3}$',
  '^a{0}$', 'a*?b', 'a+?', 'a{2,3}?', '[abc]', '[^abc]', '[a-z]+', '[\\d_-]+', '[-a]', '[a-]', '[]', '[^]', '\\d\\w\\s',
  '\\D\\W\\S', '.', '^.$', '\\.', '\\/', '\\x41', '\\u0041', '\\t', '\\0', '^$', '$', '^', '()', '(|a)', 'a(|b)c',
  '(a*)*b', '(a|ab)(c|bcd)', '^(?:/[^/]+)+$', '[\\s\\S]', '[\\D]', '[^\\W]', '[a\\S]', 'x]', 'x}', '\\[\\]', '^/café', '[\\u00e0-\\u00ff]',
  '(a?){3}a{3}', '^(a+)+$', '[.]', '[\\]]', '\\$', '\\^',
];
const agreeSubjects = [
  '', '/', '/history', '/history/', '/tracks/5', '/tracks/5?x', 'a', 'ab', 'abab', 'ababc', 'c', 'b', 'aa', 'aaa', 'aaaa',
  'xyz', 'A', '0', '_', '-', ' ', '\t', '\n', ' ', ' ', '.', '/', 'x]', 'x}', '[]', 'abcd', 'abc', 'ac',
  'aaab', '/a/b/c', '/café', 'é', '\0', '$', '^', 'aaaaaa', 'aaaaaaX',
];
let agreeMismatch = 0;
for (const p of agreePatterns) {
  const re = new RegExp(p);
  for (const s of agreeSubjects) {
    const got = engine(p, s);
    if (got !== re.test(s)) { agreeMismatch++; if (agreeMismatch <= 10) console.error(`    /${p}/ on ${JSON.stringify(s)}: engine ${String(got)}, RegExp ${String(re.test(s))}`); }
  }
}
check(`${agreePatterns.length} × ${agreeSubjects.length} agree`, agreeMismatch === 0, `${agreeMismatch} mismatches`);

console.log('agreement with RegExp (generated)');
// A small deterministic generator over a tiny alphabet, so matches are common.
let seed = 0x5eed;
const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
function gen(depth: number): string {
  const r = rand(depth > 3 ? 4 : 10);
  switch (r) {
    case 0: return 'a';
    case 1: return 'b';
    case 2: return '[ab]';
    case 3: return '.';
    case 4: return `(${gen(depth + 1)})`;
    case 5: return `(?:${gen(depth + 1)}|${gen(depth + 1)})`;
    case 6: return `${gen(depth + 1)}${['*', '+', '?', '{2}', '{1,2}', '{0,}', '*?'][rand(7)] ?? ''}`.replace(/^([*+?{])/, 'a$1');
    case 7: return `${gen(depth + 1)}${gen(depth + 1)}`;
    case 8: return ['^', '$', '[^a]', '\\w'][rand(4)] ?? 'a';
    default: return `${gen(depth + 1)}|${gen(depth + 1)}`;
  }
}
let genMismatch = 0; let genRuns = 0; let genRefused = 0;
for (let i = 0; i < 600; i++) {
  const p = gen(0);
  let re: RegExp;
  try { re = new RegExp(p); } catch { continue; }
  for (let j = 0; j < 12; j++) {
    let s = '';
    const len = rand(7);
    for (let k = 0; k < len; k++) s += 'abc'[rand(3)] ?? 'a';
    const got = engine(p, s);
    if (typeof got === 'string') { genRefused++; break; }
    genRuns++;
    if (got !== re.test(s)) { genMismatch++; if (genMismatch <= 10) console.error(`    /${p}/ on ${JSON.stringify(s)}: engine ${String(got)}, RegExp ${String(re.test(s))}`); }
  }
}
check(`generated: ${genRuns} runs agree (${genRefused} patterns refused)`, genMismatch === 0 && genRuns > 3000, `${genMismatch} mismatches`);

console.log('adversarial: bounded, hand-written expectations');
function timed(label: string, fn: () => boolean, want: boolean, ms: number) {
  const t = Date.now();
  const got = fn();
  const took = Date.now() - t;
  check(`${label} → ${want} in under ${ms}ms`, got === want && took < ms, `got ${String(got)} in ${took}ms`);
}
const aaa = 'a'.repeat(PATH_SCOPE_LIMITS.subjectChars - 2);
timed('^(a+)+$ on a…ab', () => inPathScope(compilePathScope(['re:^(a+)+$']), { pathname: `${aaa}b`, search: '', hash: '' }), false, 500);
timed('(a*)*b on a…a', () => inPathScope(compilePathScope(['re:(a*)*b']), { pathname: aaa, search: '', hash: '' }), false, 500);
timed('(a|aa)*c on a…a', () => inPathScope(compilePathScope(['re:(a|aa)*c']), { pathname: aaa, search: '', hash: '' }), false, 500);
timed('a{1000} matches 1000 a', () => inPathScope(compilePathScope(['re:^a{1000}$']), { pathname: 'a'.repeat(1000), search: '', hash: '' }), true, 500);
timed('a{1000} misses 999 a', () => inPathScope(compilePathScope(['re:^a{1000}$']), { pathname: 'a'.repeat(999), search: '', hash: '' }), false, 500);
timed('(()*)* nullable loops', () => inPathScope(compilePathScope(['re:^(()*)*x$']), { pathname: 'x', search: '', hash: '' }), true, 500);
timed('a full list of large patterns on a long URL', () => inPathScope(compilePathScope(['re:(a|b)*c{0,300}d', '!re:[ab]{1,900}e', '/**/z']), { pathname: aaa, search: '', hash: '' }), false, 1500);
const nested = checkPathEntry('re:((a{100}){100}){100}');
check('((a{100}){100}){100} refused before expanding', !nested.ok && /too large/.test(nested.error), nested.ok ? 'accepted' : nested.error);
const t0 = Date.now();
for (let i = 0; i < 200; i++) checkPathEntry('re:((((a{1000}){1000}){1000}){1000}){1000}');
check('…and refusing it is cheap', Date.now() - t0 < 200, `${Date.now() - t0}ms`);
for (const src of ['(((){1000}){1000}){1000}', '((((((){1000}){1000}){1000}){1000}){1000}){1000}', '(((a{0}){1000}){1000}){1000}', '((()|()){1000}){1000}']) {
  const t = Date.now();
  const r = checkPathEntry(`re:${src}`);
  const took = Date.now() - t;
  check(`re:${src} settles in under 100ms`, took < 100, `${took}ms, ${r.ok ? 'accepted' : r.error}`);
}
timed('nested empty repeats still match like RegExp', () => engine('^x(((){1000}){1000}){1000}y$', 'xy') === true, true, 500);
const atCap = checkPathEntry('re:a{1000}b{999}');
check('a pattern at the state cap compiles', atCap.ok && atCap.states === PATH_SCOPE_LIMITS.patternStates - 1, atCap.ok ? String(atCap.states) : atCap.error);
check('one over is refused', !checkPathEntry('re:a{1000}b{1000}c').ok);

console.log('settings-view helpers');
const scope = compilePathScope(['/history', '/{history,b}', '!re:secret', '/x']);
check('matchingEntries lists every hit', matchingEntries(scope, url('/history')).map((e) => e.text).join(',') === '/history,/{history,b}');
const subj = pathSubjects(url('/app?q=1#/inbox'));
check('subjects', subj.glob === '/app' && subj.globWithHash === '/app#/inbox' && subj.regex === '/app?q=1#/inbox', JSON.stringify(subj));
const kinds = checkPathEntry('!re:x');
check('an exclude regex entry', kinds.ok && kinds.entry.kind === 'regex' && kinds.entry.exclude);

if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
