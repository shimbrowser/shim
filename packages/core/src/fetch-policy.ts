// What a handler's `api.fetch` may reach, and how much it may read: the
// rules every host's broker shares, so a shim fetches the same things in
// the Shim browser and in Shim for Chrome. Pure, no network.
//
// The broker runs outside the page (the browser's main process, the
// extension's service worker), so it is not subject to the site's CSP, and
// it never sends cookies: a handler reads public content, never the user's
// authenticated sessions. It may not reach the user's own network either
// (router admin pages, local dev servers, other apps' debug ports, the cloud
// metadata endpoint): a literal loopback, private or link-local address is
// refused here, and a host that can resolve DNS also refuses a name that
// resolves into that space.

/** Bytes of the body returned to the handler. */
export const FETCH_MAX_BODY_BYTES = 5 * 1024 * 1024;
/** A response declaring more than this is refused before its body is read. */
export const FETCH_HARD_CONTENT_LENGTH = 25 * 1024 * 1024;
/** A request still pending after this is aborted. */
export const FETCH_TIMEOUT_MS = 15000;

/** What a handler may choose about a request: the url and these. */
export interface HandlerFetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * A completed HTTP response (any status — `ok` mirrors the response's) or a
 * transport failure (no response; `error`). A 404 is the first shape with
 * `ok: false` and a body; handlers check `'text' in r` or `r.error`.
 */
export type HandlerFetchResult =
  | { ok: boolean; status: number; statusText: string; url: string; headers: Record<string, string>; text: string; truncated: boolean }
  | { ok: false; error: string; status?: number };

/** Parse a dotted quad into 4 octets, or null. Rejects out-of-range and non-numeric parts. */
export function parseIpv4(h: string): [number, number, number, number] | null {
  const parts = h.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

function isPrivateIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  return false;
}

function isPrivateIpv6(raw: string): boolean {
  const h = raw.toLowerCase();
  if (h === '::1' || h === '::') return true; // loopback / unspecified
  // IPv4-mapped/compatible (`::ffff:127.0.0.1`): defer to v4. A miss reads as private (fail safe).
  const mapped = h.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) { const v4 = parseIpv4(mapped[1] ?? ''); return v4 ? isPrivateIpv4(v4) : true; }
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h)) {
    // ::ffff:7f00:0001 form — reconstruct the embedded v4 and classify.
    const [hi, lo] = h.slice(7).split(':').map((x) => parseInt(x, 16));
    if (hi === undefined || lo === undefined) return true;
    return isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true; // fe80::/10 link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
  return false;
}

/**
 * True if a literal host names the loopback / private / link-local space a
 * handler must never reach: the localhost name family and IPv4 / IPv6
 * literals (IPv4-mapped IPv6 included). A DNS name is not classified here.
 */
export function isPrivateHost(host: string): boolean {
  if (!host) return false;
  let h = host.trim().toLowerCase();
  // Strip an IPv6 literal's brackets and any zone id (`fe80::1%en0`).
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const pct = h.indexOf('%');
  if (pct !== -1) h = h.slice(0, pct);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = parseIpv4(h);
  if (v4) return isPrivateIpv4(v4);
  if (h.includes(':')) return isPrivateIpv6(h);
  return false;
}

/** The reason a literal host is blocked, or null. */
export function privateHostReason(host: string): string | null {
  return isPrivateHost(host)
    ? `blocked: "${host}" is a loopback/private/link-local address (api.fetch may not reach your local network)`
    : null;
}

/**
 * The url a handler asked for, checked: a parsed http(s) URL whose host is
 * not a literal private address, or the error the handler gets.
 */
export function checkFetchUrl(url: unknown): { ok: true; url: URL } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, error: `invalid url: ${String(url)}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `unsupported protocol "${parsed.protocol}" — api.fetch allows http/https only` };
  }
  const blocked = privateHostReason(parsed.hostname);
  if (blocked) return { ok: false, error: blocked };
  return { ok: true, url: parsed };
}

/**
 * The request a handler may make: its method (GET by default), string-valued
 * headers and a string body. Nothing else a handler passes reaches the
 * broker (no credentials, no cache mode, no redirect policy).
 */
export function handlerFetchInit(opts: unknown): { method: string; headers: Record<string, string>; body?: string } {
  const o = typeof opts === 'object' && opts !== null ? opts as Record<string, unknown> : {};
  const method = typeof o.method === 'string' ? o.method.toUpperCase() : 'GET';
  const headers: Record<string, string> = {};
  if (typeof o.headers === 'object' && o.headers !== null) {
    for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) {
      if (typeof v === 'string') Object.defineProperty(headers, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
  }
  return typeof o.body === 'string' ? { method, headers, body: o.body } : { method, headers };
}
