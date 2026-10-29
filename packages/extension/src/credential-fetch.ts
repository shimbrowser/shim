// A handler's api.fetch that names placed secrets, in Shim for Chrome
// (core D17): `api.fetch(url, { …, secrets: ['apiKey'] })`.
// The value never enters the page: the worker checks the request, the
// shim's grant, the tab's session lease and the vault, places the value
// through core's credential-placement, and makes the request itself.
//
// The order:
//
//   1. the tab's document must be outside every session lease (a session
//      holds the tab, or held it while this document existed: refused);
//   2. the shim is read as committed and enabled, and the request planned
//      against its own placed fields (url, exact origin, collisions) before
//      anything is decrypted;
//   3. each named secret needs a current grant (credential-grants.ts);
//   4. the vault decrypts each value (the vault-keeper generation it was
//      read under comes with it);
//   5. then, with nothing awaited between the check and the call, the lease,
//      the store's change epoch (any shim, grant or secret write moves it:
//      the reads above are then re-done, at most a few times) and the vault
//      generation are checked again, and the request is dispatched;
//   6. with core's fixed policy (no redirects, no cache, no cookies, no
//      referrer); the answer carries the handler's own url, fixed error
//      strings, and redacted text.
//
// Per shim, at most CREDENTIAL_CONCURRENCY requests in flight and
// CREDENTIAL_PER_MINUTE started in any minute. Pure but for its deps.

import type { Spec } from '@shimbrowser/core/types';
import {
  planCredentialRequest, placeCredentials, redactCredentialText, CREDENTIAL_ERRORS, CREDENTIAL_REQUEST_POLICY,
} from '@shimbrowser/core/credential-placement';
import { credentialUseBinding } from '@shimbrowser/core/credential-placement';
import {
  checkFetchUrl, FETCH_HARD_CONTENT_LENGTH, FETCH_MAX_BODY_BYTES, FETCH_TIMEOUT_MS, handlerFetchInit, type HandlerFetchResult,
} from '@shimbrowser/core/fetch-policy';
import { grantState, manifestDigest, placedUse, type GrantRow } from './credential-grants';

/** What a refusal says when a session holds, or held, the tab. */
export const SECRETS_NOT_AVAILABLE_IN_SESSION = 'secrets-not-available-in-session';
export const CREDENTIAL_CONCURRENCY = 4;
export const CREDENTIAL_PER_MINUTE = 120;
const ATTEMPTS = 3;

type Reveal = { ok: true; value: string; gen: number } | { ok: false; error: string; code: string };

export interface CredentialFetchDeps {
  /** The shim as committed, when it is installed and enabled. */
  shim(shimId: string): Promise<{ spec: Spec; handlers: Record<string, string> } | null>;
  grant(shimId: string, key: string): Promise<GrantRow | undefined>;
  reveal(shimId: string, key: string, placement: string): Promise<Reveal>;
  /** Synchronous: is the vault still unlocked at the generation a value was read under? */
  vaultCurrent(gen: number): boolean;
  leaseReady: Promise<void>;
  /** Synchronous: may a secret go for a request from this document? */
  leaseAllows(tabId: number | undefined, documentId: string | undefined): boolean;
  /** Synchronous: moves on every write to a shim, a grant or a secret. */
  epoch(): number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface CredentialFetchCall {
  shimId: string;
  tabId: number | undefined;
  documentId: string | undefined;
  url: unknown;
  opts: unknown;
}

function refuse(error: string): HandlerFetchResult {
  return { ok: false, error };
}

async function readCapped(res: Response, cap: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    return { bytes: all.subarray(0, cap), truncated: all.length > cap };
  }
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
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { bytes: all.subarray(0, cap), truncated: total > cap };
}

/** Per-shim budgets, kept by the broker that owns them. */
export class CredentialBudget {
  private inFlight = new Map<string, number>();
  private starts = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  take(shimId: string): string | null {
    const t = this.now();
    const recent = (this.starts.get(shimId) ?? []).filter((s) => t - s < 60_000);
    if ((this.inFlight.get(shimId) ?? 0) >= CREDENTIAL_CONCURRENCY) return `at most ${CREDENTIAL_CONCURRENCY} secret-bearing requests may be in flight per shim`;
    if (recent.length >= CREDENTIAL_PER_MINUTE) return `at most ${CREDENTIAL_PER_MINUTE} secret-bearing requests a minute per shim`;
    recent.push(t);
    this.starts.set(shimId, recent);
    this.inFlight.set(shimId, (this.inFlight.get(shimId) ?? 0) + 1);
    return null;
  }

  give(shimId: string): void {
    const n = (this.inFlight.get(shimId) ?? 1) - 1;
    if (n <= 0) this.inFlight.delete(shimId);
    else this.inFlight.set(shimId, n);
  }
}

export async function runCredentialFetch(call: CredentialFetchCall, deps: CredentialFetchDeps, budget: CredentialBudget): Promise<HandlerFetchResult> {
  await deps.leaseReady;
  if (!deps.leaseAllows(call.tabId, call.documentId)) return refuse(SECRETS_NOT_AVAILABLE_IN_SESSION);
  const over = budget.take(call.shimId);
  if (over) return refuse(over);
  try {
    return await attempt(call, deps);
  } finally {
    budget.give(call.shimId);
  }
}

async function attempt(call: CredentialFetchCall, deps: CredentialFetchDeps): Promise<HandlerFetchResult> {
  const opts = (typeof call.opts === 'object' && call.opts !== null ? call.opts : {}) as Record<string, unknown>;
  const init = handlerFetchInit(opts);
  // The broker's usual pre-check: no literal loopback, private or link-local address.
  const checked = checkFetchUrl(call.url);
  if (!checked.ok) return refuse(checked.error);
  for (let i = 0; i < ATTEMPTS; i++) {
    const epoch = deps.epoch();
    const shim = await deps.shim(call.shimId);
    if (!shim) return refuse('no such shim, or it is turned off');
    const planned = planCredentialRequest({ url: call.url, headers: init.headers, secrets: opts.secrets, placedUse: (k) => placedUse(shim.spec, k) });
    if (!planned.ok) return refuse(planned.error);
    const { plan } = planned;
    const digest = manifestDigest(shim.spec, shim.handlers);
    for (const { key, use } of plan.placements) {
      if (grantState(await deps.grant(call.shimId, key), use, digest) !== 'granted') {
        return refuse(`"${key}" isn't approved for this shim as it is now: approve it in the shim's settings in Shim for Chrome`);
      }
    }
    const values = new Map<string, string>();
    let gen: number | null = null;
    let mixed = false;
    for (const { key, use } of plan.placements) {
      const r = await deps.reveal(call.shimId, key, credentialUseBinding(use));
      if (!r.ok) return refuse(r.error);
      if (gen !== null && gen !== r.gen) mixed = true;
      gen = r.gen;
      values.set(key, r.value);
    }
    const placed = placeCredentials(plan, init.headers, values);
    if (!placed.ok) return refuse(placed.error);

    // Nothing is awaited from here to the dispatch.
    if (!deps.leaseAllows(call.tabId, call.documentId)) return refuse(SECRETS_NOT_AVAILABLE_IN_SESSION);
    if (mixed || deps.epoch() !== epoch) continue;
    if (gen === null || !deps.vaultCurrent(gen)) return refuse('the vault locked while the request waited: unlock it in Shim for Chrome and try again');
    return dispatch(plan.publicUrl, placed.request, init, deps);
  }
  return refuse('the shim or its secrets kept changing while the request waited; try again');
}

async function dispatch(
  publicUrl: string,
  request: { dispatchUrl: string; headers: Record<string, string>; redact: string[] },
  init: ReturnType<typeof handlerFetchInit>,
  deps: CredentialFetchDeps,
): Promise<HandlerFetchResult> {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(request.dispatchUrl, {
      ...CREDENTIAL_REQUEST_POLICY,
      method: init.method,
      headers: request.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return refuse(controller.signal.aborted ? CREDENTIAL_ERRORS.timedOut : CREDENTIAL_ERRORS.failed);
  }
  try {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > FETCH_HARD_CONTENT_LENGTH) {
      controller.abort();
      return { ok: false, status: res.status, error: CREDENTIAL_ERRORS.unreadable };
    }
    const { bytes, truncated } = await readCapped(res, FETCH_MAX_BODY_BYTES);
    const text = new TextDecoder().decode(bytes);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      Object.defineProperty(headers, k, { value: redactCredentialText(v, request.redact), enumerable: true, writable: true, configurable: true });
    });
    return { ok: res.ok, status: res.status, statusText: '', url: publicUrl, headers, text: redactCredentialText(text, request.redact, truncated), truncated };
  } catch {
    return { ok: false, status: res.status, error: controller.signal.aborted ? CREDENTIAL_ERRORS.timedOut : CREDENTIAL_ERRORS.unreadable };
  } finally {
    clearTimeout(timer);
  }
}
