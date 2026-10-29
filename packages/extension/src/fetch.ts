// A handler's `api.fetch`, brokered by the service worker: the same bounds
// and result shape as the Shim browser's (core's fetch-policy), so a shim
// fetches the same way on both. Never throws: every failure is
// `{ ok: false, error }`.
//
// Cookie-less (`credentials: 'omit'`): a handler reads public content, never
// the user's signed-in sessions. http(s) only; a literal loopback, private or
// link-local address is refused. The worker skips CORS for every site the
// extension holds access to, so the caller decides which of those a request
// may reach (`mayRead`): the worker allows the calling shim's own sites (it
// runs there already) and refuses another shim's, so one shim never reads a
// site through access granted for another, and what a fetch can read does
// not depend on what else is installed. Anywhere else a fetch succeeds only
// when that site allows cross-origin reads. That is stricter than the Shim
// browser, which skips CORS everywhere.
//
// A site the extension holds only because the user approved sending a secret
// there (credential-access.ts) is no shim's site: a plain fetch to it is not
// refused as held, but it is read as CORS would allow (corsOnly), since
// Chrome itself skips CORS there. A request CORS would preflight is refused,
// because a worker cannot send a preflight of its own.
//
// Redirects are followed by fetch itself: an MV3 worker cannot read a
// redirect's Location to vet each hop (`redirect: 'manual'` answers an opaque
// response). So where the request landed is checked, and a body from a
// private address is never read or returned, even from a private host the
// extension holds access to (where CORS would not stop the read).
//
// Residual, accepted: the hops' requests themselves go out. And an extension
// cannot resolve DNS, so a name that resolves into the private space is not
// refused here (the Shim browser refuses it). Its response is readable only
// on the calling shim's own sites (granted by name, so no CORS), which that
// shim runs on anyway; elsewhere it stays unreadable under CORS, but a
// request that needs no preflight still goes out.

import {
  checkFetchUrl, handlerFetchInit, FETCH_MAX_BODY_BYTES, FETCH_HARD_CONTENT_LENGTH, FETCH_TIMEOUT_MS, type HandlerFetchResult,
} from '@shimbrowser/core/fetch-policy';
import { hostMatches } from '@shimbrowser/core/host-match';

/**
 * The worker's reach rule for one shim (FetchBrokerDeps.mayRead): its own
 * sites are allowed, a site the extension holds for another shim is refused,
 * anything else is left to CORS. The hostname is compared without a root dot
 * (`nas.local.` is nas.local), so no spelling slips past either check. `held`
 * answers whether the extension holds a match pattern; a throw refuses.
 */
export function fetchReach(
  ownHosts: readonly unknown[] | undefined,
  held: (pattern: string) => Promise<boolean>,
  grantOnly: (host: string) => Promise<boolean> = async () => false,
): (url: URL) => Promise<string | null> {
  const own = (ownHosts ?? []).filter((h): h is string => typeof h === 'string');
  return async (url) => {
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    if (!host) return 'api.fetch may not read a url with no host';
    if (hostMatches(own, host, url.port || undefined)) return null;
    let isHeld = true;
    try {
      // Access a credential grant owns is no shim's site: the fetch goes
      // ahead, read only as CORS allows (corsOnlyReach).
      if (url.protocol === 'https:' && await grantOnly(host)) return null;
      isHeld = await held(`${url.protocol}//${host}/*`);
    } catch { /* refuse below */ }
    return isHeld
      ? `api.fetch may not read ${host}: Shim for Chrome holds access to it for another shim, and a shim never reads a site through another's access`
      : null;
  };
}

/**
 * The worker's CORS rule for one shim (FetchBrokerDeps.corsOnly): a site the
 * extension holds only for a credential grant (credential-access.ts), and
 * not one of the shim's own, is read as CORS would allow, since Chrome skips
 * CORS for every site the extension holds.
 */
export function corsOnlyReach(ownHosts: readonly unknown[] | undefined, grantOnly: (host: string) => Promise<boolean>): (url: URL) => Promise<boolean> {
  const own = (ownHosts ?? []).filter((h): h is string => typeof h === 'string');
  return async (url) => {
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    if (url.protocol !== 'https:' || hostMatches(own, host, url.port || undefined)) return false;
    try {
      return await grantOnly(host);
    } catch {
      return true;
    }
  };
}

const SAFELISTED_CONTENT_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']);
const SAFELISTED_REQUEST_HEADERS = new Set(['accept', 'accept-language', 'content-language', 'content-type']);
const SAFELISTED_RESPONSE_HEADERS = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);

/** A CORS-unsafe request-header byte (Fetch): a control byte other than tab, `"():<>?@[\]{}` or DEL. */
function hasCorsUnsafeByte(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    if ((b < 0x20 && b !== 0x09) || b === 0x7f) return true;
    if ('"():<>?@[\\]{}'.includes(String.fromCharCode(b))) return true;
  }
  return false;
}

/**
 * A request CORS sends without a preflight (Fetch's CORS-safelisted method
 * and request-headers): GET, HEAD or POST; only accept, accept-language,
 * content-language and content-type; each value at most 128 bytes; accept
 * and content-type without a CORS-unsafe byte; the language headers only
 * `0-9 A-Z a-z space * , - . ; =`; content-type's essence one of the three
 * form types; and at most 1024 safelisted bytes in all. A worker cannot send
 * a preflight of its own (the Access-Control-Request-* headers are forbidden
 * to set), so a request that would need one is refused where CORS is
 * emulated.
 */
export function corsSimpleRequest(method: string, headers: Record<string, string>): boolean {
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return false;
  const encoder = new TextEncoder();
  let total = 0;
  for (const [name, value] of Object.entries(headers)) {
    const n = name.toLowerCase();
    if (!SAFELISTED_REQUEST_HEADERS.has(n)) return false;
    const bytes = encoder.encode(value);
    if (bytes.length > 128) return false;
    total += bytes.length;
    if (n === 'accept' && hasCorsUnsafeByte(bytes)) return false;
    if ((n === 'accept-language' || n === 'content-language') && !/^[0-9A-Za-z *,.;=-]*$/.test(value)) return false;
    if (n === 'content-type') {
      if (hasCorsUnsafeByte(bytes)) return false;
      if (!SAFELISTED_CONTENT_TYPES.has((value.split(';')[0] ?? '').trim().toLowerCase())) return false;
    }
  }
  return total <= 1024;
}

/** Does a response allow a cookie-less cross-origin read by `origin`? */
export function corsAllowsRead(headers: Headers, origin: string): boolean {
  const allow = headers.get('access-control-allow-origin')?.trim();
  return allow === '*' || (origin !== '' && allow === origin);
}

/** The response headers a CORS read exposes: the safelisted ones and those the server lists. */
export function corsExposedHeaders(headers: Headers): Set<string> {
  const out = new Set(SAFELISTED_RESPONSE_HEADERS);
  const listed = headers.get('access-control-expose-headers') ?? '';
  for (const name of listed.split(',')) {
    const n = name.trim().toLowerCase();
    if (n && n !== '*') out.add(n);
    if (n === '*') headers.forEach((_v, k) => { out.add(k.toLowerCase()); });
  }
  return out;
}

const CORS_REFUSED = 'the request failed (the site does not allow cross-origin reads). Shim for Chrome reads a site it has no access to only when that site allows cross-origin reads (CORS)';

export interface FetchBrokerDeps {
  /** The fetch to make the request with (the worker's own by default). */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Whether the caller may read `url` (checked before the request and again
   * where it landed): null to allow, else the refusal. The worker refuses a
   * site it holds access to for another shim (see the header).
   */
  mayRead?(url: URL): Promise<string | null>;
  /**
   * Whether `url` is read only as CORS would allow (corsOnlyReach): a
   * request there must be simple, and its answer is read only when the
   * response allows `corsOrigin` (or anyone), with only the exposed headers.
   */
  corsOnly?(url: URL): Promise<boolean>;
  /** The origin requests come from (the extension's), for the CORS check. */
  corsOrigin?: string;
}

function errName(err: unknown): string {
  return typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string' ? (err as { name: string }).name : '';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reads at most `cap + 1` bytes of a body (the extra byte marks it
 * truncated) and cancels the rest, so a chunked or lying-length response
 * never buffers past the cap.
 */
async function readCapped(res: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
  let bytes: Uint8Array;
  if (!res.body) {
    bytes = new Uint8Array(await res.arrayBuffer());
  } else {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total <= cap) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      if (total > cap) reader.cancel().catch(() => { /* already closed */ });
      else reader.releaseLock();
    }
    bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  }
  return { text: new TextDecoder().decode(bytes.subarray(0, cap)), truncated: bytes.byteLength > cap };
}

/** One `api.fetch(url, opts)` call, made by the worker. */
export async function brokerFetch(url: unknown, opts: unknown, deps: FetchBrokerDeps = {}): Promise<HandlerFetchResult> {
  const checked = checkFetchUrl(url);
  if (!checked.ok) return { ok: false, error: checked.error };
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const { method, headers, body } = handlerFetchInit(opts);
  const refusedBefore = await deps.mayRead?.(checked.url) ?? null;
  if (refusedBefore) return { ok: false, error: refusedBefore };
  const corsAtStart = await deps.corsOnly?.(checked.url) ?? false;
  if (corsAtStart && !corsSimpleRequest(method, headers)) {
    return { ok: false, error: `api.fetch sends ${checked.url.hostname} only simple requests (GET, HEAD or POST with standard headers): Shim for Chrome holds access to it for a secret you approved, and cannot run the cross-origin check (CORS) this request needs` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(checked.url.href, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    });
    // Where it landed after any redirects: a private address is refused
    // before its body is read.
    const landed = checkFetchUrl(res.url || checked.url.href);
    if (!landed.ok) {
      controller.abort();
      return { ok: false, status: res.status, error: `redirected, then ${landed.error}` };
    }
    if (landed.url.href !== checked.url.href) {
      const refusedAfter = await deps.mayRead?.(landed.url) ?? null;
      if (refusedAfter) {
        controller.abort();
        return { ok: false, status: res.status, error: `redirected, then ${refusedAfter}` };
      }
    }
    // Read as CORS would allow, where the extension's access is a grant's alone.
    let exposed: Set<string> | null = null;
    if (corsAtStart || (await deps.corsOnly?.(landed.url) ?? false)) {
      if (!corsAllowsRead(res.headers, deps.corsOrigin ?? '')) {
        controller.abort();
        return { ok: false, error: CORS_REFUSED };
      }
      exposed = corsExposedHeaders(res.headers);
    }
    // Refuse before reading the body when the server declares an absurd size.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > FETCH_HARD_CONTENT_LENGTH) {
      controller.abort();
      return { ok: false, status: res.status, error: `response too large (${declared} bytes)` };
    }
    const { text, truncated } = await readCapped(res, FETCH_MAX_BODY_BYTES);
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      if (exposed && !exposed.has(key.toLowerCase())) return;
      Object.defineProperty(outHeaders, key, { value, enumerable: true, writable: true, configurable: true });
    });
    return { ok: res.ok, status: res.status, statusText: res.statusText, url: res.url, headers: outHeaders, text, truncated };
  } catch (err) {
    if (errName(err) === 'AbortError') return { ok: false, error: `request timed out after ${timeoutMs}ms` };
    // A network failure and a cross-origin refusal look the same from here.
    if (errName(err) === 'TypeError') {
      return {
        ok: false,
        error: `the request failed (${errText(err)}). Shim for Chrome reads a site it has no access to only when that site allows cross-origin reads (CORS)`,
      };
    }
    return { ok: false, error: errText(err) };
  } finally {
    clearTimeout(timer);
  }
}
