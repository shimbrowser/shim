// Pins `hostMatches` (src/host-match.ts), the one rule every host uses to
// decide whether `spec.match.hosts` covers a page. The semantics are a
// contract shared by the Shim browser's registry, its page guard, the
// headless driver and any extension that turns `match.hosts` into script
// registrations, so a change here must be deliberate.
//
//   node out/packages/core/test/host-match-harness.js

import { hostMatches } from '../src/host-match';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

console.log('\n=== host-match harness ===\n');

console.log('exact hosts:');
check('exact match', hostMatches(['example.com'], 'example.com'));
check('a different host misses', !hostMatches(['example.com'], 'example.org'));
check('a subdomain does not match a bare host pattern', !hostMatches(['example.com'], 'www.example.com'));
check('a superstring host misses (no prefix matching)', !hostMatches(['example.com'], 'notexample.com'));
check('comparison is literal, case included', !hostMatches(['Example.com'], 'example.com'));
check('any pattern in the list may match', hostMatches(['a.test', 'b.test', 'example.com'], 'example.com'));

console.log('ports:');
check('a portless pattern matches the default port', hostMatches(['example.com'], 'example.com'));
check('a portless pattern matches any explicit port (string)', hostMatches(['example.com'], 'example.com', '8443'));
check('a portless pattern matches any explicit port (number)', hostMatches(['example.com'], 'example.com', 8443));
check('a port pattern matches its own port (string)', hostMatches(['localhost:5173'], 'localhost', '5173'));
check('a port pattern matches its own port (number)', hostMatches(['localhost:5173'], 'localhost', 5173));
check('a port pattern requires that port', !hostMatches(['localhost:5173'], 'localhost', 5174));
check('a port pattern never matches the default port', !hostMatches(['localhost:5173'], 'localhost'));
check('an empty port string reads as the default port', !hostMatches(['localhost:5173'], 'localhost', ''));
check('a port pattern is not a wildcard', !hostMatches(['*.example.com:5173'], 'app.example.com', 5173));

console.log('wildcards:');
check('*. matches one subdomain level', hostMatches(['*.example.com'], 'app.example.com'));
check('*. matches deeper subdomains', hostMatches(['*.example.com'], 'deep.app.example.com'));
check('*. does not match the bare apex', !hostMatches(['*.example.com'], 'example.com'));
check('*. does not match a lookalike suffix', !hostMatches(['*.example.com'], 'evilexample.com'));
check('*. plus the apex covers both', hostMatches(['example.com', '*.example.com'], 'example.com')
  && hostMatches(['example.com', '*.example.com'], 'cdn.example.com'));
check('*. with any port', hostMatches(['*.example.com'], 'app.example.com', 3000));
check('a mid-pattern asterisk is literal, not a glob', !hostMatches(['app.*.com'], 'app.example.com'));

console.log('degenerate inputs:');
check('undefined patterns never match', !hostMatches(undefined, 'example.com'));
check('an empty list never matches', !hostMatches([], 'example.com'));
check('an empty hostname matches nothing sensible', !hostMatches(['example.com', '*.example.com'], ''));
check('an IP host matches literally', hostMatches(['127.0.0.1'], '127.0.0.1', 5173));
check('an IP host with a port pattern', hostMatches(['127.0.0.1:5173'], '127.0.0.1', '5173')
  && !hostMatches(['127.0.0.1:5173'], '127.0.0.1', '5174'));

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log(`all host-match checks passed (${passes})`);
