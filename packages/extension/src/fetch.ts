// A handler's `api.fetch`, brokered by the service worker: the same bounds
// and result shape as the Shim browser's (core's fetch-policy), so a shim
// fetches the same way on both. Never throws: every failure is
// `{ ok: false, error }`.
//
// Cookie-less (`credentials: 'omit'`): a handler reads public content, never
// the user's signed-in sessions. http(s) only; a literal loopback, private or
// link-local address is refused. The worker skips CORS only for sites the
// extension holds access to (the installed shims' hosts); a fetch anywhere
// else succeeds only when that site allows cross-origin reads. That is
// stricter than the Shim browser, which skips CORS everywhere.
//
// Redirects are followed by fetch itself: an MV3 worker cannot read a
// redirect's Location to vet each hop (`redirect: 'manual'` answers an opaque
// response). So where the request landed is checked, and a body from a
// private address is never read or returned, even from a private host the
// extension holds access to (where CORS would not stop the read).
//
// Residual, accepted: the hops' requests themselves go out. And an extension
// cannot resolve DNS, so a public name that resolves into the private space
// is not refused here (the Shim browser refuses it); host access is granted
// by name, so its response stays unreadable under CORS, but a request that
// needs no preflight still goes out.

import {
  checkFetchUrl, handlerFetchInit, FETCH_MAX_BODY_BYTES, FETCH_HARD_CONTENT_LENGTH, FETCH_TIMEOUT_MS, type HandlerFetchResult,
} from '@shimbrowser/core/fetch-policy';

export interface FetchBrokerDeps {
  /** The fetch to make the request with (the worker's own by default). */
  fetch?: typeof fetch;
  timeoutMs?: number;
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
    // Refuse before reading the body when the server declares an absurd size.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > FETCH_HARD_CONTENT_LENGTH) {
      controller.abort();
      return { ok: false, status: res.status, error: `response too large (${declared} bytes)` };
    }
    const { text, truncated } = await readCapped(res, FETCH_MAX_BODY_BYTES);
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
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
