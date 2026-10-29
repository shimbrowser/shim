// Pins the site access a credential grant owns (src/credential-access.ts)
// and how a plain api.fetch treats it (src/fetch.ts):
//
//   - a grant's origin maps to exactly `https://<host>/*` (no port, no
//     path); anything that is not an https origin maps to nothing;
//   - releasing gives back only what no remaining shim's sites and no
//     remaining grant still need, and never a grant host a shim's sites
//     cover (wildcards and ported hosts included);
//   - a host is grant-only while a grant owns it and no shim's sites cover
//     it; then another shim's plain fetch to it is not refused as held, but
//     read as CORS would allow: a request CORS would preflight is refused
//     before any request, an answer without Access-Control-Allow-Origin (* or
//     the extension's origin) is refused unread, and only exposed headers
//     come back; a redirect landing on a grant-only host is checked too;
//   - a host a shim's own sites cover stays its own: no CORS emulation.

import {
  accessPatternForOrigin, accessReplaced, grantOrigin, grantAccessPattern, grantAccessPatterns, accessToRelease, grantOnlyHost, hostOfPattern, shimSitesCover,
} from '../src/credential-access';
import { brokerFetch, fetchReach, corsOnlyReach, corsSimpleRequest } from '../src/fetch';
import { credentialUseBinding } from '@shimbrowser/core/credential-placement';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail: unknown = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail !== '' ? ' — ' + JSON.stringify(detail) : ''}`);
}

const row = (origin: string, extra: { header?: string; query?: string } = { header: 'Authorization' }) => ({
  binding: credentialUseBinding(extra.query !== undefined
    ? { origin, query: extra.query, format: '{}' }
    : { origin, header: extra.header ?? 'Authorization', format: 'Bearer {}' }),
});
const errOf = (r: object): string => ('error' in r && typeof r.error === 'string' ? r.error : '');
const shim = (...hosts: string[]) => ({ spec: { match: { hosts } } });

async function main(): Promise<void> {
  console.log('\n=== credential access harness ===\n');

  console.log('patterns:');
  check('an origin maps to its host on https, every port', accessPatternForOrigin('https://api.example.com') === 'https://api.example.com/*'
    && accessPatternForOrigin('https://api.example.com:8443') === 'https://api.example.com/*');
  check('an upper-case or root-dotted host maps lowercase without the dot', accessPatternForOrigin('https://API.Example.com.') === 'https://api.example.com/*');
  check('http, a bad url and an empty string map to nothing',
    accessPatternForOrigin('http://api.example.com') === null && accessPatternForOrigin('not a url') === null && accessPatternForOrigin('') === null);
  check('a row reads its origin from its binding, header or query', grantOrigin(row('https://a.test')) === 'https://a.test' && grantOrigin(row('https://b.test', { query: 'key' })) === 'https://b.test');
  check('an unreadable binding reads as nothing', grantOrigin({ binding: '{nope' }) === null && grantAccessPattern({ binding: '[]' }) === null);
  check('the patterns of several rows, deduplicated', [...grantAccessPatterns([row('https://a.test'), row('https://a.test:444', { query: 'k' }), row('https://b.test')])].join() === 'https://a.test/*,https://b.test/*');
  check('a grant pattern\'s host reads back; a shim pattern does not', hostOfPattern('https://a.test/*') === 'a.test' && hostOfPattern('*://a.test/*') === null);

  console.log('what a shim\'s sites cover:');
  check('an exact host', shimSitesCover(shim('api.example.com'), 'api.example.com'));
  check('a wildcard covers a subdomain', shimSitesCover(shim('*.example.com'), 'api.example.com'));
  check('a ported host covers the host (Chrome holds it on every port)', shimSitesCover(shim('api.example.com:8443'), 'api.example.com'));
  check('another host is not covered', !shimSitesCover(shim('example.com'), 'api.example.com'));

  console.log('release:');
  check('a grant pattern nothing else needs goes', accessToRelease(['https://api.test/*'], [], []).includes('https://api.test/*'));
  check('one another grant still owns stays', accessToRelease(['https://api.test/*'], [], [row('https://api.test:8443', { query: 'k' })]).length === 0);
  check('one a shim\'s sites cover stays (wildcard)', accessToRelease(['https://api.test/*'], [shim('*.test')], []).length === 0);
  check('a shim\'s site pattern on a host a grant still owns stays (removing it would take the grant\'s access)',
    accessToRelease(['*://api.test/*'], [], [row('https://api.test')]).length === 0, accessToRelease(['*://api.test/*'], [], [row('https://api.test')]));
  check('…and goes with the grant\'s last pattern', accessToRelease(['https://api.test/*'], [], []).sort().join() === '*://api.test/*,https://api.test/*');
  check('…unless a shim\'s sites still cover the host', accessToRelease(['https://api.test/*'], [shim('api.test')], []).length === 0);
  check('a shim\'s site pattern another shim registers stays', accessToRelease(['*://site.test/*'], [shim('site.test')], []).length === 0);
  check('a shim\'s site pattern nobody needs goes', accessToRelease(['*://site.test/*'], [shim('other.test')], [row('https://api.test')]).join() === '*://site.test/*');
  check('duplicates release once', accessToRelease(['https://api.test/*', 'https://api.test/*'], [], []).filter((p) => p === 'https://api.test/*').length === 1);

  console.log('approving a changed destination:');
  check('the old access is given up when the same field is approved for another origin', accessReplaced(row('https://api.a.test'), row('https://api.b.test')) === 'https://api.a.test/*');
  check('nothing when the host is the same (another port, another header)', accessReplaced(row('https://api.a.test'), row('https://api.a.test:444', { query: 'k' })) === null);
  check('nothing on a first approval', accessReplaced(undefined, row('https://api.a.test')) === null);
  check('and the old one is then released unless another grant still owns it',
    accessToRelease(['https://api.a.test/*'], [], [row('https://api.b.test')]).includes('https://api.a.test/*')
    && accessToRelease(['https://api.a.test/*'], [], [row('https://api.b.test'), row('https://api.a.test', { query: 'k' })]).length === 0);

  console.log('grant-only hosts:');
  check('a host only a grant owns', grantOnlyHost('api.test', [shim('site.test')], [row('https://api.test')]));
  check('…spelled with a root dot or upper case', grantOnlyHost('API.test.', [], [row('https://api.test')]));
  check('a host a shim\'s sites also cover is not grant-only', !grantOnlyHost('api.test', [shim('*.test')], [row('https://api.test')]));
  check('a host no grant owns is not', !grantOnlyHost('other.test', [], [row('https://api.test')]));

  console.log('the reach rule:');
  {
    const heldAll = async (): Promise<boolean> => true;
    const grantOnly = async (h: string): Promise<boolean> => h === 'api.test';
    const reach = fetchReach(['site.test'], heldAll, grantOnly);
    check('a grant-only host is not refused as held for another shim', (await reach(new URL('https://api.test/x'))) === null);
    check('…but only over https', (await reach(new URL('http://api.test/x'))) !== null);
    check('a host held for another shim is still refused', ((await reach(new URL('https://other.test/x'))) ?? '').includes('another shim'));
    check('the shim\'s own site is its own', (await reach(new URL('https://site.test/x'))) === null);
    const throwing = fetchReach([], heldAll, async () => { throw new Error('boom'); });
    check('a grant lookup that throws refuses', (await throwing(new URL('https://api.test/x'))) !== null);
    const cors = corsOnlyReach(['site.test'], grantOnly);
    check('CORS is emulated on a grant-only host', await cors(new URL('https://api.test/x')));
    check('not on the shim\'s own site, nor elsewhere', !(await cors(new URL('https://site.test/x'))) && !(await cors(new URL('https://other.test/x'))));
    check('not over http (Chrome holds no https grant there)', !(await cors(new URL('http://api.test/x'))));
    const corsOwn = corsOnlyReach(['api.test'], grantOnly);
    check('a grant host that is the shim\'s own site is read directly', !(await corsOwn(new URL('https://api.test/x'))));
    const corsThrow = corsOnlyReach([], async () => { throw new Error('boom'); });
    check('a grant lookup that throws emulates CORS (the stricter answer)', await corsThrow(new URL('https://api.test/x')));
  }

  console.log('simple requests:');
  check('GET with no headers', corsSimpleRequest('GET', {}));
  check('POST with a form content type', corsSimpleRequest('POST', { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }));
  check('POST with JSON is not simple', !corsSimpleRequest('POST', { 'content-type': 'application/json' }));
  check('an Authorization header is not simple', !corsSimpleRequest('GET', { Authorization: 'Bearer x' }));
  check('PUT is not simple', !corsSimpleRequest('PUT', {}));
  check('an over-long safelisted value is not simple', !corsSimpleRequest('GET', { accept: 'x'.repeat(129) }));
  check('a content type with a quoted parameter is not simple (CORS-unsafe bytes)', !corsSimpleRequest('POST', { 'content-type': 'text/plain; charset="utf-8"' }));
  check('an accept with a quoted or bracketed value is not simple', !corsSimpleRequest('GET', { accept: 'text/html; q="0.5"' }) && !corsSimpleRequest('GET', { accept: 'a{b}' }));
  check('a control byte is not simple', !corsSimpleRequest('GET', { accept: 'text/html\u0001' }));
  check('a language header outside its alphabet is not simple', !corsSimpleRequest('GET', { 'accept-language': 'en/us' }) && !corsSimpleRequest('GET', { 'content-language': 'en"' }));
  check('a well-formed language header is simple', corsSimpleRequest('GET', { 'accept-language': 'en-US,en;q=0.9' }));
  check('a 128-byte value counts bytes, not characters', !corsSimpleRequest('GET', { accept: 'é'.repeat(65) }));
  const spellings = ['accept', 'Accept', 'ACCEPT', 'aCcept', 'acCept', 'accEpt', 'accePt', 'ACCept', 'AcCePt'];
  check('more than 1024 safelisted bytes in all is not simple (one header spelled nine ways)',
    !corsSimpleRequest('GET', Object.fromEntries(spellings.map((k) => [k, 'a'.repeat(128)])))
    && corsSimpleRequest('POST', { accept: 'a'.repeat(128), 'accept-language': 'b'.repeat(128), 'content-language': 'c'.repeat(128), 'content-type': 'text/plain' }));

  console.log('the broker on a grant-only host:');
  {
    const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const seen: string[] = [];
    const respond = (headers: Record<string, string>, landed?: string) => ((input: RequestInfo | URL): Promise<Response> => {
      seen.push(String(input));
      const res = new Response('{"v":1}', { status: 200, headers });
      Object.defineProperty(res, 'url', { value: landed ?? String(input) });
      return Promise.resolve(res);
    }) as typeof fetch;
    const deps = (f: typeof fetch) => ({
      fetch: f,
      mayRead: fetchReach([], async (p: string) => p.includes('api.test'), async (h: string) => h === 'api.test'),
      corsOnly: corsOnlyReach([], async (h: string) => h === 'api.test'),
      corsOrigin: EXT,
    });
    const allowed = await brokerFetch('https://api.test/data', {}, deps(respond({ 'access-control-allow-origin': '*', 'content-type': 'application/json', 'x-secret-ish': 'nope' })));
    check('an answer that allows anyone is read', allowed.ok === true && allowed.text === '{"v":1}', allowed);
    check('with only the exposed headers', allowed.ok === true && allowed.headers?.['content-type'] === 'application/json' && allowed.headers['x-secret-ish'] === undefined, allowed);
    const exposedAll = await brokerFetch('https://api.test/data', {}, deps(respond({ 'access-control-allow-origin': EXT, 'access-control-expose-headers': 'x-rate', 'x-rate': '9', 'x-other': '1' })));
    check('one allowing the extension\'s origin is read, listed headers exposed', exposedAll.ok === true && exposedAll.headers?.['x-rate'] === '9' && exposedAll.headers['x-other'] === undefined, exposedAll);
    const refused = await brokerFetch('https://api.test/data', {}, deps(respond({ 'content-type': 'application/json' })));
    check('one without Access-Control-Allow-Origin is refused unread', refused.ok === false && !('text' in refused && refused.text) && errOf(refused).includes('cross-origin'), refused);
    const wrongOrigin = await brokerFetch('https://api.test/data', {}, deps(respond({ 'access-control-allow-origin': 'https://elsewhere.test' })));
    check('one allowing another origin is refused', wrongOrigin.ok === false, wrongOrigin);
    seen.length = 0;
    const preflighted = await brokerFetch('https://api.test/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, deps(respond({ 'access-control-allow-origin': '*' })));
    check('a request CORS would preflight is refused before any request', preflighted.ok === false && seen.length === 0 && errOf(preflighted).includes('simple requests'), preflighted);
    const quoted = await brokerFetch('https://api.test/data', { method: 'POST', headers: { 'content-type': 'text/plain; charset="utf-8"' }, body: 'x' }, deps(respond({ 'access-control-allow-origin': '*' })));
    check('…a quoted content-type parameter too: it never reaches fetch', quoted.ok === false && seen.length === 0, quoted);
    const redirected = await brokerFetch('https://public.test/start', {}, deps(respond({ 'content-type': 'text/plain' }, 'https://api.test/landed')));
    check('a redirect landing on a grant-only host is read only as CORS allows', redirected.ok === false && errOf(redirected).includes('cross-origin'), redirected);
    const elsewhere = await brokerFetch('https://public.test/x', {}, deps(respond({ 'content-type': 'text/plain', 'x-any': '1' })));
    check('elsewhere nothing changes (Chrome\'s own CORS decides)', elsewhere.ok === true && elsewhere.headers?.['x-any'] === '1', elsewhere);
    const own = await brokerFetch('https://api.test/x', { method: 'PUT' }, {
      fetch: respond({ 'x-any': '1' }),
      mayRead: fetchReach(['api.test'], async () => true, async () => true),
      corsOnly: corsOnlyReach(['api.test'], async () => true),
      corsOrigin: EXT,
    });
    check('on the shim\'s own site a grant host is read directly', own.ok === true && own.headers?.['x-any'] === '1', own);
  }

  console.log('');
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log(`all credential access checks passed (${passes})`);
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
