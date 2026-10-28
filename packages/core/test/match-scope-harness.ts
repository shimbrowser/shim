// Pins match-scope (src/match-scope.ts): which patterns a session may add to
// `match.hosts` (admission), which of a working list's patterns run the shim
// somewhere the committed list doesn't (containment, by hostMatches' own
// semantics — what the Shim browser's commit card asks about), and the
// evidence-honesty helpers both hosts share.
//
//   node out/packages/core/test/match-scope-harness.js

import {
  hostPatternProblem, patternCovers, widenedPatterns, offMatchWarning, withOffMatch,
  evidenceLocation, locationsMatching, untriedMatchNote, MAX_NEW_MATCH_PATTERNS,
} from '../src/match-scope';
import { hostMatches } from '../src/host-match';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}

console.log('admission');
for (const ok of ['example.com', 'old.reddit.com', 'localhost', 'localhost:5173', 'example.com:80', 'example.com:443', '127.0.0.1',
  '*.wikipedia.org', '*.co.uk', 'xn--bcher-kva.example', 'a-b.example']) {
  check(`accepts ${ok}`, hostPatternProblem(ok) === null, hostPatternProblem(ok) ?? '');
}
const refused: Array<[unknown, string]> = [
  ['', 'non-empty'], [42, 'non-empty'], ['Example.com', 'lowercase'], ['https://example.com', 'not a URL'], ['example.com/path', 'not a URL'],
  ['*', 'name a host'], ['*.com', 'two parts'], ['*.example.com:8080', "can't carry a port"], ['example.com:0', '1 to 65535'],
  ['example.com:65536', '1 to 65535'], ['example.com:080', 'leading zeros'], ['example.com.', 'trailing dot'], ['[::1]', 'IPv6'],
  ['exa mple.com', 'whitespace'], ['-bad.com', 'hyphen'], ['bad-.com', 'hyphen'], ['bücher.example', 'xn--'], ['127.1', 'the way a browser shows it'],
  ['*.10.0.0.1', 'IP address'], ['a..com', 'lowercase letters'], [`${'a'.repeat(64)}.com`, '1-63'],
];
for (const [pattern, why] of refused) {
  const problem = hostPatternProblem(pattern);
  check(`refuses ${JSON.stringify(pattern)} (${why})`, problem !== null && problem.includes(why), problem ?? 'accepted');
}

console.log('containment follows hostMatches');
check('an identical string is covered, legacy or not', patternCovers('Old.Reddit.com', 'Old.Reddit.com') && patternCovers('*.x.com:80', '*.x.com:80'));
check('a legacy string never covers a different functional one', !patternCovers('Old.Reddit.com', 'old.reddit.com'));
check('a portless host covers itself on any port', patternCovers('example.com', 'example.com:8080'));
check('a host with a port covers only itself', !patternCovers('example.com:5173', 'example.com') && !patternCovers('example.com:5173', 'example.com:9090'));
check('a wildcard covers deeper hosts and their ports', patternCovers('*.reddit.com', 'old.reddit.com') && patternCovers('*.reddit.com', 'a.b.reddit.com:8080'));
check('a wildcard never covers the apex', !patternCovers('*.reddit.com', 'reddit.com'));
check('a wildcard covers a narrower wildcard on a label boundary', patternCovers('*.example.com', '*.eu.example.com') && !patternCovers('*.example.com', '*.badexample.com'));
check('an exact host never covers a wildcard', !patternCovers('example.com', '*.example.com'));
check('a wildcard does not cover a host merely ending in its text', !patternCovers('*.example.com', 'badexample.com'));
// Containment agrees with hostMatches on sample pages.
const pages: Array<[string, string]> = [['old.reddit.com', ''], ['reddit.com', ''], ['a.b.reddit.com', '8080'], ['example.com', '5173'], ['example.com', '']];
for (const [committed, pattern] of [['*.reddit.com', 'old.reddit.com'], ['example.com', 'example.com:5173'], ['*.reddit.com', '*.b.reddit.com']] as const) {
  const agrees = pages.every(([h, p]) => !hostMatches([pattern], h, p || undefined) || hostMatches([committed], h, p || undefined));
  check(`${committed} ⊇ ${pattern} on every sample page`, agrees);
}

console.log('widened patterns');
check('nothing new, nothing asked', widenedPatterns(['www.reddit.com'], ['www.reddit.com']).length === 0);
check('an added host is asked', JSON.stringify(widenedPatterns(['www.reddit.com'], ['www.reddit.com', 'old.reddit.com'])) === '["old.reddit.com"]');
check('a wildcard replacing a host is asked', JSON.stringify(widenedPatterns(['en.wikipedia.org'], ['*.wikipedia.org'])) === '["*.wikipedia.org"]');
check('narrowing within a committed wildcard asks nothing', widenedPatterns(['*.wikipedia.org'], ['en.wikipedia.org', 'ja.wikipedia.org']).length === 0);
check('dropping a port widens', JSON.stringify(widenedPatterns(['localhost:5173'], ['localhost'])) === '["localhost"]');
check('repeats and non-strings are skipped', JSON.stringify(widenedPatterns([], ['a.com', 'a.com', 7])) === '["a.com"]');
check('the cap is 20', MAX_NEW_MATCH_PATTERNS === 20);

console.log('evidence honesty');
check('off-match warns with the page host', (offMatchWarning(['other.test'], 'https://site.test/x') ?? '').includes("doesn't cover site.test"));
check('a covered page has no warning', offMatchWarning(['*.site.test'], 'https://www.site.test/') === null);
check('a non-http page is never judged', offMatchWarning([], 'about:blank') === null);
const capped = withOffMatch({ rules: [{ verification: 'full' }, { verification: 'none' }] }, 'w');
check('the cap drops full, keeps none', JSON.stringify(capped.rules) === '[{"verification":"partial"},{"verification":"none"}]' && JSON.stringify(capped.warnings) === '["w"]');
check('a location keeps scheme and port', evidenceLocation('https://en.wikipedia.org/wiki/X') === 'https://en.wikipedia.org'
  && evidenceLocation('http://localhost:5173/a') === 'http://localhost:5173' && evidenceLocation('about:blank') === null);
check('locations a pattern matches', JSON.stringify(locationsMatching('*.wikipedia.org', ['https://en.wikipedia.org', 'https://example.com'])) === '["https://en.wikipedia.org"]');
const note = untriedMatchNote(['*.wikipedia.org', 'old.reddit.com', 'en.wikipedia.org'], ['https://en.wikipedia.org']);
check('the commit note: a wildcard is tried only on its members seen, an exact host not seen is not tried',
  note !== null && note.includes('*.wikipedia.org (tried only on https://en.wikipedia.org)') && note.includes('old.reddit.com (not tried)') && !note.includes('en.wikipedia.org (not'), note);
check('no note when every pattern is an exact host the session tried', untriedMatchNote(['example.com'], ['https://example.com']) === null);
check('a session with no rule evidence says so', (untriedMatchNote(['example.com'], []) ?? '').startsWith('this session got no rule evidence'));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall match-scope checks passed');
