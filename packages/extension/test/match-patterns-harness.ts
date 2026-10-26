// Pins the map from a shim's host patterns to Chrome match patterns
// (src/match-patterns.ts): each grammar the engine's matcher accepts
// becomes the pattern that covers it, and anything else is a named problem
// so an install never registers a narrower net than the shim declares.

import { hostPatternProblem, matchPatternForHost, matchPatternsForHosts } from '../src/match-patterns';
import { hostMatches } from '@shimbrowser/core/host-match';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

console.log('\n=== match-patterns harness ===\n');

console.log('one host pattern:');
check('a bare host', matchPatternForHost('example.com') === '*://example.com/*');
check('a wildcard host', matchPatternForHost('*.example.com') === '*://*.example.com/*');
check('a host with a port', matchPatternForHost('localhost:5173') === '*://localhost:5173/*');
check('a single label', hostPatternProblem('localhost') === null);
check('an IPv4 host', hostPatternProblem('127.0.0.1') === null && matchPatternForHost('127.0.0.1') === '*://127.0.0.1/*');
check('an IPv4 host with a port', hostPatternProblem('127.0.0.1:5173') === null);
check('hyphens inside labels', hostPatternProblem('my-app.example-site.co.uk') === null);

console.log('problems:');
check('empty', hostPatternProblem('') !== null);
check('not a string', hostPatternProblem(42) !== null);
check('a scheme', hostPatternProblem('https://example.com') !== null);
check('a path', hostPatternProblem('example.com/app') !== null);
check('whitespace', hostPatternProblem('example .com') !== null);
check('a lone asterisk', hostPatternProblem('*') !== null);
check('an asterisk inside a label', hostPatternProblem('app.*.com') !== null);
check('a wildcard without a dot', hostPatternProblem('*example.com') !== null);
check('a leading hyphen', hostPatternProblem('-bad.example.com') !== null);
check('a trailing dot', hostPatternProblem('example.com.') !== null);
check('a port out of range', hostPatternProblem('example.com:70000') !== null);
check('a non-numeric port', hostPatternProblem('example.com:abc') !== null);
check('an IPv6 literal', hostPatternProblem('[::1]') !== null);

console.log('a host list:');
{
  const { patterns, problems } = matchPatternsForHosts(['example.com', '*.example.com', 'example.com', 'localhost:5173']);
  check('in order, de-duplicated', JSON.stringify(patterns) === JSON.stringify(['*://example.com/*', '*://*.example.com/*', '*://localhost:5173/*']), JSON.stringify(patterns));
  check('no problems', problems.length === 0);
}
{
  const { patterns, problems } = matchPatternsForHosts(['example.com', 'https://bad', '']);
  check('the good ones still map', patterns.length === 1);
  check('every bad one is a problem', problems.length === 2, JSON.stringify(problems));
}
check('an empty list maps to nothing', matchPatternsForHosts([]).patterns.length === 0);

console.log('the registration is never narrower than the matcher:');
// Every host the engine's matcher accepts for a pattern is covered by the
// pattern's registration: a URL on that host parses to a hostname and port
// the match pattern covers (any port when none is named, that port when one is).
const cases: Array<[string, string, string | undefined]> = [
  ['example.com', 'example.com', undefined],
  ['example.com', 'example.com', '8443'],
  ['*.example.com', 'deep.app.example.com', '3000'],
  ['localhost:5173', 'localhost', '5173'],
];
for (const [pattern, hostname, port] of cases) {
  check(`${pattern} covers ${hostname}${port ? ':' + port : ''}`, hostMatches([pattern], hostname, port) && hostPatternProblem(pattern) === null);
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log(`all match-patterns checks passed (${passes})`);
