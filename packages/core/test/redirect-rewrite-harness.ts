// Harness for a redirect's path/query rewrite (packages/core/src/redirect-rewrite.ts):
// the grammar the compiler accepts, the strict path matcher, the byte-preserving
// query algorithm, self-idempotence and the preview's simulation text. Bare node.
//
//   node out/packages/core/test/redirect-rewrite-harness.js

import {
  compileRewrite, applyRewrite, resolveRewrite, describeRewriteSimulation, isBareHostname,
  REWRITE_LIMITS, type CompiledRewrite,
} from '../src/redirect-rewrite';
import { lintSpec } from '../src/spec-lint';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

function compiled(raw: unknown): CompiledRewrite {
  const r = compileRewrite(raw);
  if (!r.ok) throw new Error(`expected ${JSON.stringify(raw)} to compile: ${r.error}`);
  return r.rewrite;
}
function errorOf(raw: unknown): string {
  const r = compileRewrite(raw);
  return r.ok ? '' : r.error;
}

const reddit = compiled({ drop: ['tl'] });
const google = compiled({ path: '/search', set: { udm: '14' }, unless: ['udm', 'tbm'] });
const youtube = compiled({ path: '/shorts/:id', toPath: '/watch', set: { v: ':id' } });

console.log('the three cases');
check('reddit: ?tl= dropped, rest kept byte for byte',
  applyRewrite(reddit, null, 'https://www.reddit.com/r/x/comments/1/t/?tl=de&a=%20~&b=1#c') === 'https://www.reddit.com/r/x/comments/1/t/?a=%20~&b=1#c',
  String(applyRewrite(reddit, null, 'https://www.reddit.com/r/x/comments/1/t/?tl=de&a=%20~&b=1#c')));
check('reddit: the only param dropped → no "?"', applyRewrite(reddit, null, 'https://www.reddit.com/r/x/?tl=de') === 'https://www.reddit.com/r/x/');
check('reddit: no tl → no rewrite', applyRewrite(reddit, null, 'https://www.reddit.com/r/x/?a=1') === null);
check('reddit: duplicate tl all dropped', applyRewrite(reddit, null, 'https://www.reddit.com/?tl=de&x=1&tl=fr') === 'https://www.reddit.com/?x=1');
check('google: udm=14 added on /search', applyRewrite(google, null, 'https://www.google.com/search?q=a+b') === 'https://www.google.com/search?q=a+b&udm=14');
check('google: another tab (tbm) left alone', applyRewrite(google, null, 'https://www.google.com/search?q=a&tbm=isch') === null);
check('google: a chosen udm left alone', applyRewrite(google, null, 'https://www.google.com/search?q=a&udm=2') === null);
check('google: empty udm still counts as present', applyRewrite(google, null, 'https://www.google.com/search?q=a&udm') === null);
check('google: other paths untouched', applyRewrite(google, null, 'https://www.google.com/maps?q=a') === null);
check('google: trailing slash still /search', applyRewrite(google, null, 'https://www.google.com/search/?q=a') === 'https://www.google.com/search/?q=a&udm=14');
check('youtube: shorts → watch, t= kept',
  applyRewrite(youtube, null, 'https://www.youtube.com/shorts/abc_D-1?t=12&feature=share') === 'https://www.youtube.com/watch?t=12&feature=share&v=abc_D-1',
  String(applyRewrite(youtube, null, 'https://www.youtube.com/shorts/abc_D-1?t=12&feature=share')));
check('youtube: /shorts alone does not match', applyRewrite(youtube, null, 'https://www.youtube.com/shorts') === null);
check('youtube: /shorts//abc does not match', applyRewrite(youtube, null, 'https://www.youtube.com/shorts//abc') === null);
check('youtube: /shorts/a/b does not match', applyRewrite(youtube, null, 'https://www.youtube.com/shorts/a/b') === null);
check('youtube: encoded capture re-encoded', applyRewrite(youtube, null, 'https://www.youtube.com/shorts/a%20b') === 'https://www.youtube.com/watch?v=a%20b');
check('youtube: malformed escape does not match', applyRewrite(youtube, null, 'https://www.youtube.com/shorts/%ZZ') === null);
check('youtube: a "." capture is no rewrite', applyRewrite(compiled({ path: '/s/:id', toPath: '/w/:id' }), null, 'https://y.com/s/%2E') === null);

console.log('query algorithm');
check('+ is a space, %2B a plus: set keeps a satisfied pair',
  applyRewrite(compiled({ set: { q: 'a b' } }), null, 'https://x.com/?q=a+b') === null);
check('%2B is not a space', applyRewrite(compiled({ set: { q: 'a b' } }), null, 'https://x.com/?q=a%2Bb') === 'https://x.com/?q=a%20b');
check('set replaces duplicates with one appended pair', applyRewrite(compiled({ set: { k: '1' } }), null, 'https://x.com/?k=1&a=2&k=1') === 'https://x.com/?a=2&k=1');
check('a malformed value never hides its key from unless',
  applyRewrite(compiled({ set: { z: '1' }, unless: ['udm'] }), null, 'https://x.com/?udm=%ZZ') === null);
check('a malformed value is dropped by key', applyRewrite(compiled({ drop: ['udm'] }), null, 'https://x.com/?udm=%ZZ&a=1') === 'https://x.com/?a=1');
check('a malformed key is opaque and kept', applyRewrite(compiled({ drop: ['u'] }), null, 'https://x.com/?%ZZ=1&u=2') === 'https://x.com/?%ZZ=1');
check('empty components are kept', applyRewrite(compiled({ drop: ['u'] }), null, 'https://x.com/?a=1&&u=2') === 'https://x.com/?a=1&');
check('bare "?" with nothing to do stays as is', applyRewrite(reddit, null, 'https://x.com/p?') === null);
check('set on a bare "?" appends', applyRewrite(compiled({ set: { a: '1' } }), null, 'https://x.com/p?') === 'https://x.com/p?a=1');
check('set values are encoded', applyRewrite(compiled({ set: { 'a b': 'c&d' } }), null, 'https://x.com/') === 'https://x.com/?a%20b=c%26d');

console.log('host, scheme, port');
check('to swaps the hostname and keeps the port',
  applyRewrite(compiled({ drop: ['tl'] }), 'old.example.com', 'http://www.example.com:8080/a?tl=1') === 'http://old.example.com:8080/a');
check('to alone (already there, nothing else) → no rewrite', applyRewrite(reddit, 'old.example.com', 'https://old.example.com/a') === null);
check('a non-http URL is never rewritten', applyRewrite(reddit, null, 'file:///a?tl=1') === null);
check('a bad to never rewrites', applyRewrite(reddit, 'Old.Example.com:1', 'https://x.com/?tl=1') === null);
check('isBareHostname', isBareHostname('old.reddit.com') && !isBareHostname('https://x.com') && !isBareHostname('x.com:80') && !isBareHostname('X.com') && !isBareHostname(''));
check('an output over the URL bound is no rewrite',
  applyRewrite(compiled({ set: { a: 'b' } }), null, `https://x.com/?p=${'x'.repeat(REWRITE_LIMITS.urlChars)}`) === null);

console.log('self-idempotence');
const loops = compiled({ set: { n: '1' } });
check('a set that its own result satisfies is idempotent', resolveRewrite(loops, null, 'https://x.com/').kind === 'rewrite');
const flip = compiled({ path: '/a/:x', toPath: '/a/b/:x' });
check('a path rewrite whose output leaves its path is idempotent', resolveRewrite(flip, null, 'https://x.com/a/c').kind === 'rewrite');
const bounce = compiled({ path: '/:a/:b', toPath: '/:b/:a' });
const swapped = resolveRewrite(bounce, null, 'https://x.com/p/q');
check('a rewrite that fires again on its output never fires', swapped.kind === 'not-idempotent', JSON.stringify(swapped));
check('the three cases are idempotent',
  resolveRewrite(reddit, null, 'https://r.com/?tl=1').kind === 'rewrite'
  && resolveRewrite(google, null, 'https://g.com/search?q=1').kind === 'rewrite'
  && resolveRewrite(youtube, null, 'https://y.com/shorts/x').kind === 'rewrite');

console.log('grammar');
check('unknown field', /unknown field "regex"/.test(errorOf({ drop: ['a'], regex: 'x' })));
check('empty rewrite', /changes nothing/.test(errorOf({ path: '/a' })));
check('undeclared capture in toPath', /doesn't declare/.test(errorOf({ path: '/a', toPath: '/:id' })));
check('undeclared capture in set', /doesn't declare/.test(errorOf({ set: { v: ':id' } })));
check('a set value starting with ":" must be a capture', /whole capture/.test(errorOf({ set: { v: ':a-b' } })));
check('duplicate capture', /twice/.test(errorOf({ path: '/:a/:a', toPath: '/:a' })));
check('optional capture refused', errorOf({ path: '/:a?', toPath: '/x' }) !== '');
check('wildcard refused', errorOf({ path: '/a/*', toPath: '/x' }) !== '');
check('literal dot segments refused', errorOf({ toPath: '/a/../b' }) !== '' && errorOf({ toPath: '/./b' }) !== '');
check('empty interior segment refused', /empty segment/.test(errorOf({ toPath: '/a//b' })));
check('escapes and backslashes refused', errorOf({ toPath: '/a%20b' }) !== '' && errorOf({ toPath: '/a\\b' }) !== '');
check('must start with /', errorOf({ toPath: 'watch' }) !== '');
check('set and drop overlap', /sets and drops/.test(errorOf({ set: { a: '1' }, drop: ['a'] })));
check('too many keys', errorOf({ drop: Array.from({ length: 17 }, (_, i) => `k${i}`) }) !== '');
check('too long a template', errorOf({ toPath: `/${'a'.repeat(300)}` }) !== '');
check('too many segments', errorOf({ toPath: `/${Array.from({ length: 17 }, () => 'a').join('/')}` }) !== '');
check('a root toPath compiles', compileRewrite({ path: '/home', toPath: '/' }).ok);

console.log('simulation');
const sim = (m: { rewrite?: unknown; to?: unknown }, url: string | null) => describeRewriteSimulation(m, url);
check('would go to', /would go to www\.youtube\.com\/watch\?v=x|would go to \/watch\?v=x/.test(sim({ rewrite: { path: '/shorts/:id', toPath: '/watch', set: { v: ':id' } } }, 'https://www.youtube.com/shorts/x')));
check('says it is a simulation and names its limits', /simulation only/.test(sim({ rewrite: { drop: ['tl'] } }, 'https://r.com/?tl=1')) && /in-page navigation/.test(sim({ rewrite: { drop: ['tl'] } }, 'https://r.com/?tl=1')));
check('doesn\'t apply', /doesn't apply/.test(sim({ rewrite: { drop: ['tl'] } }, 'https://r.com/')));
check('never runs', /would never run/.test(sim({ rewrite: { path: '/:a/:b', toPath: '/:b/:a' } }, 'https://r.com/p/q')));
check('invalid', /not registered/.test(sim({ rewrite: { path: '/a' } }, 'https://r.com/a')));
check('bad to', /bare lowercase hostname/.test(sim({ rewrite: { drop: ['a'] }, to: 'https://x.com' }, 'https://r.com/')));
check('no page URL', /registered/.test(sim({ rewrite: { drop: ['a'] } }, null)));

console.log('spec-lint');
const lint = (mut: Record<string, unknown>) => lintSpec({ rules: [{ id: 'r', mutations: [{ kind: 'redirect', ...mut }] }] });
check('a valid rewrite lints clean', lint({ rewrite: { drop: ['tl'] } }).errors.length === 0, JSON.stringify(lint({ rewrite: { drop: ['tl'] } })));
check('rewrite is a known field', lint({ rewrite: { drop: ['tl'] } }).warnings.every((w) => !w.includes('unknown field')));
check('neither to nor rewrite is an error', lint({}).errors.some((e) => e.includes('needs "to"')));
check('an invalid rewrite is an error', lint({ rewrite: { path: '/a' } }).errors.some((e) => e.includes('changes nothing')));
check('a bad to beside a rewrite is an error', lint({ rewrite: { drop: ['a'] }, to: 'x.com:80' }).errors.some((e) => e.includes('bare lowercase hostname')));
check('host-only redirects keep their old check', lint({ to: ' old.example.com ' }).errors.length === 0);

console.log('');
if (failures) { console.error(`✗ ${failures} check(s) failed`); process.exit(1); }
console.log('✓ all redirect-rewrite checks passed');
