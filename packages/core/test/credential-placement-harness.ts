// Harness for @shimbrowser/core/credential-placement and credential-grant
// (D17): how a broker places a declared secret on a handler's request, and
// what a credential grant is bound to.
//
//   - planCredentialRequest parses the url once, refuses anything but https
//     and userinfo, drops the fragment, and refuses a key that is not the
//     caller's placed secret, a different origin (IDNA, case, ports, trailing
//     dots), a header the handler set, a query parameter the url already
//     carries in any spelling or encoding, collisions between secrets, and
//     repeated keys — all before a value is needed;
//   - placeCredentials builds each value once, appends a query value through
//     URLSearchParams (so `&`, `=`, `#`, `/`, `%` in a value never create
//     another parameter or change the destination), keeps the public url free
//     of the value, refuses unset, oversize, ill-formed and header-unsafe
//     values, and lists redaction candidates (raw, formatted, encodings);
//   - redactCredentialText replaces echoes, longest first, and withholds a
//     trailing partial echo when the text was cut short;
//   - executionManifestDigest moves with authored changes to what runs and
//     not with witnesses, versions or key order.
//
//   node out/packages/core/test/credential-placement-harness.js

import {
  planCredentialRequest, placeCredentials, redactCredentialText, describeCredentialUse, credentialUseBinding,
  CREDENTIAL_REQUEST_POLICY, CREDENTIAL_ERRORS, CREDENTIAL_REDACTED, CREDENTIAL_MAX_VALUE_BYTES,
  type CredentialPlan,
} from '../src/credential-placement';
import { executionManifestDigest, executionManifestDigestWithoutAnchors } from '../src/credential-grant';
import type { CredentialUse } from '../src/settings-schema';
import type { Spec } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

const HEADER: CredentialUse = { origin: 'https://api.example.com', header: 'Authorization', format: 'Bearer {}' };
const QUERY: CredentialUse = { origin: 'https://maps.example.com', query: 'key', format: '{}' };
const XKEY: CredentialUse = { origin: 'https://api.example.com', header: 'X-Api-Key', format: '{}' };
const QUERY2: CredentialUse = { origin: 'https://maps.example.com', query: 'KEY', format: 'k:{}' };
const DECL: Record<string, CredentialUse> = { api: HEADER, maps: QUERY, xkey: XKEY, maps2: QUERY2 };
const placedUse = (k: string): CredentialUse | undefined => DECL[k];

function plan(url: unknown, secrets: unknown, headers: Record<string, string> = {}): ReturnType<typeof planCredentialRequest> {
  return planCredentialRequest({ url, headers, secrets, placedUse });
}
function refused(label: string, r: ReturnType<typeof planCredentialRequest>, has?: string): void {
  check(`refused: ${label}`, !r.ok && (has === undefined || r.error.includes(has)), r.ok ? 'accepted' : r.error);
}
function must(r: ReturnType<typeof planCredentialRequest>): CredentialPlan {
  if (!r.ok) throw new Error(`plan refused: ${r.error}`);
  return r.plan;
}

console.log('policy and errors');
{
  check('the request policy refuses redirects, caching, cookies and referrers',
    CREDENTIAL_REQUEST_POLICY.redirect === 'error' && CREDENTIAL_REQUEST_POLICY.cache === 'no-store' && CREDENTIAL_REQUEST_POLICY.credentials === 'omit'
      && CREDENTIAL_REQUEST_POLICY.referrer === '' && CREDENTIAL_REQUEST_POLICY.referrerPolicy === 'no-referrer');
  check('the error strings are fixed and carry no url', Object.values(CREDENTIAL_ERRORS).every((e) => /^[a-z-]+$/.test(e)));
}

console.log('planCredentialRequest: the url');
{
  const p = must(plan('https://api.example.com/v1/chat?x=1#frag', ['api']));
  check('a header secret to its origin plans; the fragment is dropped from both urls',
    p.publicUrl === 'https://api.example.com/v1/chat?x=1' && p.url.hash === '' && p.placements[0]?.key === 'api');
  check('case and the default port normalize to the declared origin',
    plan('https://API.Example.COM:443/x', ['api']).ok);
  check('an IDNA host compares by its punycode origin', planCredentialRequest({
    url: 'https://bücher.example/x', headers: {}, secrets: ['k'],
    placedUse: () => ({ origin: 'https://xn--bcher-kva.example', header: 'X-Api-Key', format: '{}' }),
  }).ok);
  refused('http', plan('http://api.example.com/x', ['api']), 'https');
  refused('userinfo', plan('https://user:pw@api.example.com/x', ['api']), 'credentials');
  refused('a username alone', plan('https://user@api.example.com/x', ['api']));
  refused('another host', plan('https://evil.example/x', ['api']), 'only to https://api.example.com');
  refused('a subdomain', plan('https://a.api.example.com/x', ['api']));
  refused('a lookalike suffix', plan('https://api.example.com.evil.example/x', ['api']));
  refused('a trailing-dot host (a different origin)', plan('https://api.example.com./x', ['api']));
  refused('a non-default port', plan('https://api.example.com:8443/x', ['api']));
  refused('a backslash authority trick', plan('https://evil.example\\@api.example.com/x', ['api']));
  refused('a non-string url', plan(42, ['api']));
  refused('an invalid url', plan('not a url', ['api']));
  refused('a data url', plan('data:text/plain,hi', ['api']));
}

console.log('planCredentialRequest: names and collisions');
{
  refused('no secrets', plan('https://api.example.com/', []));
  refused('secrets not an array', plan('https://api.example.com/', 'api'));
  refused('a non-string key', plan('https://api.example.com/', [1]));
  refused('a repeated key', plan('https://api.example.com/', ['api', 'api']), 'more than once');
  refused('too many keys', plan('https://api.example.com/', ['a', 'b', 'c', 'd', 'e']));
  refused('a key that is not a placed secret', plan('https://api.example.com/', ['other']), 'declared');
  refused('a header the handler set (any case)', plan('https://api.example.com/', ['api'], { authorization: 'mine' }), 'itself');
  check('another header the handler set is fine', plan('https://api.example.com/', ['api'], { Accept: 'application/json' }).ok);
  check('two secrets in different headers plan together', plan('https://api.example.com/', ['api', 'xkey']).ok);
  const twoHeaders = planCredentialRequest({
    url: 'https://api.example.com/', headers: {}, secrets: ['a', 'b'],
    placedUse: (k) => ({ origin: 'https://api.example.com', header: k === 'a' ? 'X-Key' : 'x-key', format: '{}' }),
  });
  refused('two secrets for one header (any case)', twoHeaders, 'two secrets');
  refused('two secrets for one query name (any case)', plan('https://maps.example.com/', ['maps', 'maps2']), 'two secrets');
  refused('a query parameter the url already carries', plan('https://maps.example.com/?key=mine', ['maps']), 'already carries');
  refused('…in upper case', plan('https://maps.example.com/?KEY=mine', ['maps']));
  refused('…percent-encoded', plan('https://maps.example.com/?k%65y=mine', ['maps']));
  refused('…with a "+"-free empty value', plan('https://maps.example.com/?key', ['maps']));
  refused('…repeated after another parameter', plan('https://maps.example.com/?a=1&key=2', ['maps']));
  check('a different parameter is fine', plan('https://maps.example.com/?keys=1&q=key', ['maps']).ok);
  check('a key that only collides after double decoding is the service\'s own semantics (allowed)', plan('https://maps.example.com/?%256bey=1', ['maps']).ok);
}

console.log('placeCredentials');
{
  const hp = must(plan('https://api.example.com/v1?x=1', ['api']));
  const h = placeCredentials(hp, { Accept: 'application/json' }, new Map([['api', 'sk-live-1234567890']]));
  check('a header value is formatted once and added beside the handler\'s headers',
    h.ok && h.request.headers.Authorization === 'Bearer sk-live-1234567890' && h.request.headers.Accept === 'application/json'
      && h.request.dispatchUrl === 'https://api.example.com/v1?x=1', JSON.stringify(h));
  check('the formatted value and the raw value are redaction candidates', h.ok && h.request.redact.includes('sk-live-1234567890') && h.request.redact.includes('Bearer sk-live-1234567890'));

  const evil = 'a&b=c#d/e?f%g+h i';
  const qp = must(plan('https://maps.example.com/geo?q=paris#top', ['maps']));
  const q = placeCredentials(qp, {}, new Map([['maps', evil]]));
  check('a query value goes in through URLSearchParams, as one parameter', q.ok && (() => {
    const u = new URL(q.request.dispatchUrl);
    return u.origin === 'https://maps.example.com' && u.pathname === '/geo' && u.hash === ''
      && u.searchParams.get('key') === evil && u.searchParams.get('q') === 'paris' && [...u.searchParams.keys()].length === 2;
  })(), q.ok ? q.request.dispatchUrl : q.error);
  check('the public url never carries the value', qp.publicUrl === 'https://maps.example.com/geo?q=paris' && !qp.publicUrl.includes('a%26b'));
  check('the encodings of the value are redaction candidates',
    q.ok && q.request.redact.includes(new URLSearchParams([['key', evil]]).toString().slice(4)) && q.request.redact.includes(encodeURIComponent(evil)), q.ok ? q.request.redact.join(' | ') : '');

  const tp = must(planCredentialRequest({ url: 'https://maps.example.com/', headers: {}, secrets: ['t'],
    placedUse: () => ({ origin: 'https://maps.example.com', query: 'api~key', format: '{}' }) }));
  const tv = 'secret value/with+chars';
  const t = placeCredentials(tp, {}, new Map([['t', tv]]));
  check('a name that encodes (~) still yields the exact form-encoded value as a candidate',
    t.ok && t.request.redact.includes('secret+value%2Fwith%2Bchars') && redactCredentialText('echo=secret+value%2Fwith%2Bchars', t.request.redact) === `echo=${CREDENTIAL_REDACTED}`,
    t.ok ? t.request.redact.join(' | ') : t.error);

  const fp = must(planCredentialRequest({ url: 'https://maps.example.com/', headers: {}, secrets: ['m'], placedUse: () => QUERY2 }));
  const f = placeCredentials(fp, {}, new Map([['m', 'secretvalue']]));
  check('the format applies to a query value too', f.ok && new URL(f.request.dispatchUrl).searchParams.get('KEY') === 'k:secretvalue');
  const dollar = placeCredentials(must(plan('https://api.example.com/', ['api'])), {}, new Map([['api', "$&$'$`x"]]));
  check('"$" patterns in a value are inserted literally', dollar.ok && dollar.request.headers.Authorization === "Bearer $&$'$`x");

  const p = () => must(plan('https://api.example.com/', ['api']));
  const bad: Array<[string, Map<string, string>]> = [
    ['an unset value', new Map()],
    ['an empty value', new Map([['api', '']])],
    ['an oversize value', new Map([['api', 'x'.repeat(CREDENTIAL_MAX_VALUE_BYTES + 1)]])],
    ['an ill-formed value', new Map([['api', 'abc\uD800']])],
    ['CR/LF in a header value', new Map([['api', 'v\r\nX-Evil: 1']])],
    ['a non-latin1 header value', new Map([['api', 'value✓']])],
  ];
  for (const [label, values] of bad) {
    const r = placeCredentials(p(), {}, values);
    check(`refused: ${label}, naming the key and never the value`, !r.ok && r.error.includes('"api"') && !r.error.includes('X-Evil'), r.ok ? 'placed' : r.error);
  }
}

console.log('redactCredentialText');
{
  const c = ['Bearer sk-live-1234567890', 'sk-live-1234567890'];
  check('every echo is replaced, the longer form whole',
    redactCredentialText('auth=Bearer sk-live-1234567890; raw=sk-live-1234567890', c) === `auth=${CREDENTIAL_REDACTED}; raw=${CREDENTIAL_REDACTED}`);
  check('text with no echo is unchanged', redactCredentialText('hello', c) === 'hello');
  check('a trailing partial echo is withheld when truncated', redactCredentialText('ok sk-live-12', c, true) === 'ok ');
  check('…but not when the text is complete', redactCredentialText('ok sk-live-12', c, false) === 'ok sk-live-12');
  check('short candidates are skipped (ordinary text)', redactCredentialText('abc abc', ['abc']) === 'abc abc');
}

console.log('describe and bind');
{
  check('a header placement reads plainly', describeCredentialUse(HEADER) === 'to https://api.example.com in the Authorization header');
  check('a query placement names the logging risk and the report collector',
    describeCredentialUse(QUERY).includes('web address as "key"') && describeCredentialUse(QUERY).includes('logs') && describeCredentialUse(QUERY).includes('error-report collector'));
  check('…without the collector where the host suppresses reports',
    describeCredentialUse(QUERY, { reportsSuppressed: true }).includes('logs') && !describeCredentialUse(QUERY, { reportsSuppressed: true }).includes('collector'));
  check('a header placement carries neither warning', !describeCredentialUse(HEADER).includes('logs') && !describeCredentialUse(HEADER).includes('collector'));
  check('the binding changes with the origin, the kind, the spelling and the format',
    new Set([HEADER, { ...HEADER, origin: 'https://api2.example.com' }, { ...HEADER, header: 'authorization' }, { ...HEADER, format: '{}' },
      { origin: HEADER.origin, query: 'Authorization', format: 'Bearer {}' } as CredentialUse].map(credentialUseBinding)).size === 5);
}

console.log('executionManifestDigest');
{
  // Specs as plain JSON, the way a store hands them over.
  const asSpec = (o: unknown): Spec => o as Spec;
  const rule = (anchor: unknown, handler = 'h') => ({ id: 'r', anchor, mutations: [{ kind: 'script', handler }] });
  const fields = { id: 's', version: 3, bundleHash: 'abc', match: { hosts: ['a.test'] }, settings: [{ key: 'k', type: 'secret', use: HEADER }] };
  const base = asSpec({ ...fields, rules: [rule({ primary: { kind: 'css', value: '.x' }, witness: { v: 1 } })] });
  const H = { h: 'function h(){}' };
  const d0 = executionManifestDigest(base, H);
  const same = (o: unknown, hs: Record<string, string> = H) => executionManifestDigest(asSpec(o), hs) === d0;
  check('a version, deploy hash or priority change keeps the digest', same({ ...base, version: 9, bundleHash: 'zzz', priority: 2 }));
  check('a witness change keeps the digest', same({ ...base, rules: [rule({ primary: { kind: 'css', value: '.x' }, witness: { v: 2 } })] }));
  check('key order does not matter', same(JSON.parse(JSON.stringify({ rules: base.rules, settings: base.settings, match: base.match, id: 's' }))));
  check('a handler source change moves it', !same(base, { h: 'function h(){ steal() }' }));
  check('a new handler moves it', !same(base, { ...H, g: 'x' }));
  check('an anchor change moves it', !same({ ...base, rules: [rule({ primary: { kind: 'css', value: '.y' } })] }));
  check('a match change moves it', !same({ ...base, match: { hosts: ['a.test', 'b.test'] } }));
  check('a settings change moves it', !same({ ...base, settings: [{ key: 'k', type: 'secret', use: { ...HEADER, origin: 'https://evil.example' } }] }));
  check('a mutation change moves it', !same({ ...base, rules: [rule({ primary: { kind: 'css', value: '.x' } }, 'g')] }));
  const a1 = executionManifestDigestWithoutAnchors(base, H);
  const moved = asSpec({ ...base, rules: [rule({ primary: { kind: 'css', value: '.y' } })] });
  check('without anchors, an anchor-only change keeps the digest', executionManifestDigestWithoutAnchors(moved, H) === a1);
  check('…and a handler change still moves it', executionManifestDigestWithoutAnchors(moved, { h: 'x' }) !== a1);
}

if (failures) { console.error(`\n${failures} credential-placement check(s) failed`); process.exit(1); }
console.log('\nall credential-placement checks passed');
