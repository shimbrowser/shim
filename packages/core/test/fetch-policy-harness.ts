// Harness for @shimbrowser/core/fetch-policy (what a handler's api.fetch may
// reach, shared by the Shim browser's broker and Shim for Chrome's):
//
//   - isPrivateHost blocks the loopback / private / link-local space in every
//     literal spelling (names, IPv4, IPv6, IPv4-mapped IPv6, zone ids) and
//     allows public addresses next to those ranges' edges;
//   - checkFetchUrl refuses a malformed url, a non-http(s) scheme and a
//     literal private host, and answers the parsed url otherwise;
//   - handlerFetchInit takes only a method (GET by default, upper-cased),
//     string-valued headers and a string body from what a handler passes.
//
//   node out/packages/core/test/fetch-policy-harness.js

import { isPrivateHost, checkFetchUrl, handlerFetchInit, FETCH_MAX_BODY_BYTES, FETCH_HARD_CONTENT_LENGTH, FETCH_TIMEOUT_MS } from '../src/fetch-policy';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

console.log('isPrivateHost');
{
  const blocked = [
    'localhost', 'app.localhost', 'LOCALHOST', '127.0.0.1', '127.9.9.9', '10.0.0.5',
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '[::1]', '::1', '::', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1%en0', '[fe80::1%25en0]',
  ];
  const wrong = blocked.filter((h) => !isPrivateHost(h));
  check(`blocks every private spelling (${blocked.length})`, wrong.length === 0, wrong.join(', '));
  const allowed = [
    'example.com', 'api.github.com', '8.8.8.8', '1.1.1.1',
    '172.32.0.1', '172.15.0.1', '192.167.0.1', '11.0.0.1', '169.253.0.1',
    '2606:4700:4700::1111', 'notlocalhost.com', '', '1.2.3', '999.1.1.1',
  ];
  const wrongly = allowed.filter((h) => isPrivateHost(h));
  check(`allows public hosts and non-addresses next to the edges (${allowed.length})`, wrongly.length === 0, wrongly.join(', '));
}

console.log('checkFetchUrl');
{
  const ok = checkFetchUrl('https://api.example.com/v1/items?x=1');
  check('an https url passes, parsed', ok.ok && ok.url.hostname === 'api.example.com' && ok.url.search === '?x=1');
  check('http passes too', checkFetchUrl('http://example.com/').ok);
  const bad = checkFetchUrl('not a url');
  check('a malformed url is refused, named', !bad.ok && bad.error.includes('invalid url'));
  const scheme = checkFetchUrl('file:///etc/passwd');
  check('a non-http(s) scheme is refused', !scheme.ok && scheme.error.includes('"file:"'));
  check('so are data: and javascript:', !checkFetchUrl('data:text/plain,hi').ok && !checkFetchUrl('javascript:alert(1)').ok);
  const priv = checkFetchUrl('http://192.168.1.1/admin');
  check('a literal private host is refused with the reason', !priv.ok && priv.error.includes('loopback/private/link-local'));
  check('so is the metadata endpoint and an IPv6 loopback', !checkFetchUrl('http://169.254.169.254/latest').ok && !checkFetchUrl('http://[::1]:8080/').ok);
  check('a url object is read as its string', checkFetchUrl(new URL('https://example.com/')).ok);
}

console.log('handlerFetchInit');
{
  check('no opts: a GET with no headers and no body', JSON.stringify(handlerFetchInit(undefined)) === JSON.stringify({ method: 'GET', headers: {} }));
  const init = handlerFetchInit({ method: 'post', headers: { 'content-type': 'application/json', bad: 3, 'x-a': 'b' }, body: '{"a":1}', credentials: 'include', cache: 'reload', redirect: 'manual' });
  check('the method is upper-cased', init.method === 'POST');
  check('only string-valued headers pass', JSON.stringify(init.headers) === JSON.stringify({ 'content-type': 'application/json', 'x-a': 'b' }), JSON.stringify(init.headers));
  check('a string body passes', init.body === '{"a":1}');
  check('credentials, cache mode and redirect policy never pass', !('credentials' in init) && !('cache' in init) && !('redirect' in init));
  check('a non-string body is dropped', !('body' in handlerFetchInit({ method: 'POST', body: { a: 1 } })));
  const proto = handlerFetchInit({ headers: JSON.parse('{"__proto__":"x"}') as Record<string, string> });
  check('a "__proto__" header is data, not a prototype', Object.hasOwn(proto.headers, '__proto__') && Object.getPrototypeOf(proto.headers) === Object.prototype);
}

console.log('caps');
check('the body cap, hard content length and timeout are the Shim browser\'s', FETCH_MAX_BODY_BYTES === 5 * 1024 * 1024 && FETCH_HARD_CONTENT_LENGTH === 25 * 1024 * 1024 && FETCH_TIMEOUT_MS === 15000);

if (failures) { console.error(`\n${failures} fetch-policy check(s) failed`); process.exit(1); }
console.log('\nall fetch-policy checks passed');
