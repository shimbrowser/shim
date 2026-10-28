// Pins the worker's api.fetch broker (src/fetch.ts) over a fake fetch:
//
//   - a malformed url, a non-http(s) scheme and a literal private host are
//     refused before any request is made;
//   - the request is cookie-less, follows redirects, and carries only the
//     method, string headers and string body a handler chose;
//   - a response maps to the Shim browser's result shape (any status), its
//     body capped at 5 MB (truncated marked) and a declared size past 25 MB
//     refused unread;
//   - a request redirected onto a private address is refused, its body
//     unread; a redirect between public hosts is followed;
//   - a timeout, a network or cross-origin failure, and any other throw each
//     resolve { ok: false, error }: the broker never throws.

import { brokerFetch } from '../src/fetch';
import { FETCH_MAX_BODY_BYTES, FETCH_HARD_CONTENT_LENGTH } from '@shimbrowser/core/fetch-policy';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

interface Seen { url: string; init: RequestInit }

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init: init ?? {} });
    return Promise.resolve(respond(url, init ?? {}));
  }) as typeof fetch;
  return { fetch: f, seen };
}

function withUrl(res: Response, url: string): Response {
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

async function main(): Promise<void> {
  console.log('\n=== fetch broker harness ===\n');

  console.log('refused before a request:');
  {
    const f = fakeFetch(() => new Response('x'));
    const bad = await brokerFetch('nope', undefined, f);
    const scheme = await brokerFetch('file:///etc/hosts', undefined, f);
    const priv = await brokerFetch('http://127.0.0.1:9222/json', undefined, f);
    const meta = await brokerFetch('http://169.254.169.254/latest/meta-data', undefined, f);
    check('a malformed url', !bad.ok && 'error' in bad && bad.error.includes('invalid url'));
    check('a non-http(s) scheme', !scheme.ok && 'error' in scheme && scheme.error.includes('http/https only'));
    check('a literal private host and the metadata endpoint', !priv.ok && !meta.ok && 'error' in priv && priv.error.includes('loopback/private/link-local'));
    check('none of them reached fetch', f.seen.length === 0);
  }

  console.log('the request:');
  {
    const f = fakeFetch(() => new Response('{}', { status: 201 }));
    await brokerFetch('https://api.example.com/items', { method: 'post', headers: { 'content-type': 'application/json', n: 3 }, body: '{"a":1}', credentials: 'include', mode: 'no-cors' }, f);
    const req = f.seen[0];
    check('one request, to the url as parsed', f.seen.length === 1 && req?.url === 'https://api.example.com/items');
    check('cookie-less and following redirects, whatever the handler asked', req?.init.credentials === 'omit' && req.init.redirect === 'follow' && req.init.mode === undefined);
    check('the method, string headers and string body pass', req?.init.method === 'POST' && req.init.body === '{"a":1}'
      && JSON.stringify(req.init.headers) === JSON.stringify({ 'content-type': 'application/json' }), JSON.stringify(req?.init));
    check('the request can be aborted (timeout)', req?.init.signal instanceof AbortSignal);
    await brokerFetch('https://example.com/', undefined, f);
    check('no opts: a GET with no body', f.seen[1]?.init.method === 'GET' && !('body' in (f.seen[1]?.init ?? {})));
  }

  console.log('the response:');
  {
    const f = fakeFetch(() => withUrl(new Response('hello', { status: 200, statusText: 'OK', headers: { 'x-thing': '1', 'content-type': 'text/plain' } }), 'https://example.com/final'));
    const r = await brokerFetch('https://example.com/start', undefined, f);
    check('the Shim browser\'s shape: ok, status, statusText, url, headers, text, truncated', r.ok && 'text' in r && r.status === 200 && r.statusText === 'OK'
      && r.url === 'https://example.com/final' && r.headers['x-thing'] === '1' && r.text === 'hello' && r.truncated === false, JSON.stringify(r));
    const nf = await brokerFetch('https://example.com/missing', undefined, fakeFetch(() => new Response('gone', { status: 404, statusText: 'Not Found' })));
    check('a 404 is a response with ok false and its body', !nf.ok && 'text' in nf && nf.status === 404 && nf.text === 'gone');
  }

  console.log('the caps:');
  {
    const big = new Uint8Array(FETCH_MAX_BODY_BYTES + 10).fill(0x61);
    const r = await brokerFetch('https://example.com/big', undefined, fakeFetch(() => new Response(big)));
    check('a body past 5 MB is cut there and marked truncated', r.ok && 'text' in r && r.text.length === FETCH_MAX_BODY_BYTES && r.truncated === true, 'text' in r ? String(r.text.length) : JSON.stringify(r));
    const exact = await brokerFetch('https://example.com/exact', undefined, fakeFetch(() => new Response(new Uint8Array(FETCH_MAX_BODY_BYTES).fill(0x62))));
    check('a body of exactly the cap is whole', exact.ok && 'text' in exact && exact.truncated === false && exact.text.length === FETCH_MAX_BODY_BYTES);
    let pulled = false;
    // highWaterMark 0: the stream pulls only when read, so `pulled` means the body was read.
    const huge = new ReadableStream<Uint8Array>({ pull(c) { pulled = true; c.enqueue(new Uint8Array(10)); } }, { highWaterMark: 0 });
    const declared = await brokerFetch('https://example.com/huge', undefined, fakeFetch(() => new Response(huge, { status: 200, headers: { 'content-length': String(FETCH_HARD_CONTENT_LENGTH + 1) } })));
    check('a declared size past 25 MB is refused, with the status', !declared.ok && 'error' in declared && declared.error.includes('too large') && declared.status === 200);
    check('…before its body is read', !pulled);
  }

  console.log('redirects:');
  {
    // fetch follows a redirect itself; the landing shows in res.url.
    let pulled = false;
    const secret = new ReadableStream<Uint8Array>({ pull(c) { pulled = true; c.enqueue(new TextEncoder().encode('router admin')); c.close(); } }, { highWaterMark: 0 });
    const r = await brokerFetch('https://public.example/go', undefined, fakeFetch(() => withUrl(new Response(secret, { status: 200 }), 'http://192.168.1.1/admin')));
    check('a request redirected onto a private address is refused', !r.ok && 'error' in r && r.error.startsWith('redirected, then blocked') && r.error.includes('192.168.1.1'), JSON.stringify(r));
    check('…before its body is read', !pulled);
    check('so is the metadata endpoint and loopback by name',
      !(await brokerFetch('https://public.example/a', undefined, fakeFetch(() => withUrl(new Response('x'), 'http://169.254.169.254/latest')))).ok
      && !(await brokerFetch('https://public.example/b', undefined, fakeFetch(() => withUrl(new Response('x'), 'http://localhost:9222/json')))).ok);
    const moved = await brokerFetch('http://public.example/old', undefined, fakeFetch(() => withUrl(new Response('here'), 'https://public.example/new')));
    check('a redirect between public hosts is followed and reported', moved.ok && 'text' in moved && moved.text === 'here' && moved.url === 'https://public.example/new', JSON.stringify(moved));
  }

  console.log('failures resolve, never throw:');
  {
    const hang = ((_u: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as typeof fetch;
    const t = await brokerFetch('https://example.com/slow', undefined, { fetch: hang, timeoutMs: 20 });
    check('a timeout', !t.ok && 'error' in t && t.error === 'request timed out after 20ms', JSON.stringify(t));
    const cors = await brokerFetch('https://elsewhere.test/', undefined, { fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch });
    check('a network or cross-origin failure, saying how a site is reached', !cors.ok && 'error' in cors && cors.error.includes('Failed to fetch') && cors.error.includes('cross-origin reads (CORS)'));
    const odd = await brokerFetch('https://example.com/', undefined, { fetch: (() => { throw new Error('boom'); }) as unknown as typeof fetch });
    check('a fetch that throws outright', !odd.ok && 'error' in odd && odd.error === 'boom');
  }

  console.log('');
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log(`all fetch broker checks passed (${passes})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
