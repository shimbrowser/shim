// The control routes, as the bridge relays them to the worker: the Shim
// browser's route set and reply shapes (an MCP client drives either host the
// same way), served from the session registry here. Pure: the worker passes
// what each route needs (tabs, the store, the consent gate, the registry)
// and a harness drives it without Chrome.
//
//   GET    /status                 version, mode, the open sessions
//   GET    /tabs                   the tabs whose site is granted, per window
//   POST   /sessions               { kind: 'shim', artifactId | create, target, agent, intent }
//                                  → the attach card → { sessionId, artifactId, consent }
//   GET    /sessions/:id/checkout  POST .../preview  POST .../call  POST .../commit
//   GET    /sessions/:id/cards     always none: a shim commit asks nothing
//   DELETE /sessions/:id
//
//   - Consent before ownership: the request is validated and its target
//     resolved first, then it pends on the card, and only an allowed request
//     reaches the registry's open(). The target is resolved again after the
//     answer: a tab that left the host answers target-changed.
//   - A grant has an owner: the origins an open newly acquired are released
//     on every exit but success.
//   - A url target opens a tab after the card, checks where it landed, and
//     closes it on every failure.
//   - Compositions, the API map and data tools answer requires-shim-browser.

import type { SessionRegistry, OpenRequest } from '@shimbrowser/core/session-registry';
import type { ConsentGate, ConsentSubject } from './attach-consent';

export const MAX_AGENT_LENGTH = 200;
export const MAX_INTENT_LENGTH = 10_000;
export const MAX_SUMMARY_LENGTH = 10_000;
export const MAX_COMMIT_ID_LENGTH = 256;
export const MAX_ARTIFACT_ID_LENGTH = 256;
export const MAX_ARTIFACT_NAME_LENGTH = 200;
export const MAX_URL_LENGTH = 4096;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const REQUIRES_SHIM_BROWSER = 'requires-shim-browser';

export interface ControlRequest {
  method: string;
  url: string;
  body: unknown;
  signal: AbortSignal;
}

export interface ControlResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface AttachRequest {
  artifactId: string;
  create: { name: string } | null;
  target: unknown;
  agent: string;
  intent: string;
}

/** A tab as the worker sees it. */
export interface TabInfo {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
}

export type Resolution =
  | { ok: true; subject: ConsentSubject; tab: TabInfo }
  | { ok: false; error: string; detail?: string };

export interface ControlDeps {
  status(): Record<string, unknown>;
  /** The tabs whose site is granted (the only ones with a readable url). */
  tabs(): Promise<TabInfo[]>;
  tab(tabId: number): Promise<TabInfo | null>;
  /** The installed shims that run on `tab`'s host (id, name, enabled), and whether opening one would show a card. */
  shimsOn(tab: TabInfo): Promise<Array<{ id: string; name: string; enabled: boolean; connect: 'asks' | 'allowed' }>>;
  sessions: Pick<SessionRegistry, 'open' | 'checkout' | 'preview' | 'call' | 'commit' | 'end'>;
  consent: Pick<ConsentGate, 'request'>;
  /** The card's subject for a request against `tab` (the shim checked, the missing origins listed). */
  resolveAttach(req: AttachRequest, tab: TabInfo): Promise<Resolution>;
  /** The origins the card's allow acquired for this open, to release on failure. */
  acquiredOrigins(req: AttachRequest, tab: TabInfo): Promise<string[]>;
  releaseOrigins(origins: string[]): Promise<void>;
  /** Makes the shim a `create` request names (after consent) as a draft, and removes it when its session did not open. */
  createShim(req: AttachRequest, tab: TabInfo, sessionDraftId: string): Promise<{ ok: true; artifactId: string } | { ok: false; error: string; detail?: string }>;
  discardShim(artifactId: string): Promise<void>;
  /** The registry's target for a session on `tab`, with a disposer that closes the host it attached. A refusal (a tab already held) leaves nothing to dispose. */
  targetFor(tab: TabInfo, artifactId: string): Promise<{ ok: true; target: unknown; dispose(): Promise<void> } | { ok: false; error: string; detail?: string }>;
  /** Opens a tab at `url` and waits for its main document. */
  openTab(url: string, signal: AbortSignal): Promise<{ ok: true; tab: TabInfo } | { ok: false; error: string; detail: string; tabId: number | null }>;
  closeTab(tabId: number): Promise<void>;
  /** Pending notes of a session (activation reports), delivered on the next answer. */
  takeNotes(sessionId: string): string[];
  newDraftId(): string;
}

const STATUS_BY_ERROR: Record<string, number> = {
  'invalid-request': 400,
  'invalid-json': 400,
  'invalid-target': 400,
  'consent-denied': 403,
  'consent-timeout': 403,
  'consent-cancelled': 403,
  'unknown-session': 404,
  'unknown-artifact': 404,
  'not-found': 404,
  'method-not-allowed': 405,
  'artifact-busy': 409,
  'target-changed': 409,
  'commit-pending': 409,
  'stale-revision': 409,
  'nothing-to-commit': 409,
  conflict: 409,
  'page-load-failed': 502,
  'session-ended': 410,
  'too-many-pending': 429,
  'op-failed': 500,
  'internal-error': 500,
};

export function statusForError(error: string): number {
  return STATUS_BY_ERROR[error] ?? 422;
}

export function errorResponse(error: string, detail?: string): ControlResponse {
  return { status: statusForError(error), body: { ok: false, error, ...(detail !== undefined ? { detail } : {}) } };
}

function fromResult(result: { ok: boolean; error?: unknown }, notes: string[] = []): ControlResponse {
  const body: Record<string, unknown> = { ...result };
  if (notes.length) body.notes = [...(Array.isArray(body.notes) ? body.notes as unknown[] : []), ...notes];
  if (result.ok) return { status: 200, body };
  const error = typeof result.error === 'string' ? result.error : 'internal-error';
  return { status: statusForError(error), body };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t !== '' && t.length <= max ? t : null;
}

export function parseAttachRequest(body: unknown): AttachRequest | { error: string } {
  if (!isRecord(body)) return { error: 'the body must be a JSON object' };
  if (body.kind === 'composition') return { error: REQUIRES_SHIM_BROWSER };
  if (body.kind !== 'shim') return { error: 'kind must be "shim"' };
  let create: { name: string } | null = null;
  let artifactId: string | null = null;
  if (body.create !== undefined && body.create !== null) {
    if (body.artifactId !== undefined) return { error: 'name either artifactId or create, not both' };
    const name = isRecord(body.create) ? nonEmptyString(body.create.name, MAX_ARTIFACT_NAME_LENGTH) : null;
    if (name === null) return { error: `create.name is required (at most ${MAX_ARTIFACT_NAME_LENGTH} characters)` };
    create = { name };
  } else {
    artifactId = nonEmptyString(body.artifactId, MAX_ARTIFACT_ID_LENGTH);
    if (artifactId === null) return { error: 'artifactId (or, for a new shim, create) is required' };
  }
  const agent = nonEmptyString(body.agent, MAX_AGENT_LENGTH);
  if (agent === null) return { error: `agent is required (at most ${MAX_AGENT_LENGTH} characters)` };
  if (typeof body.intent !== 'string' || body.intent.length > MAX_INTENT_LENGTH) return { error: `intent must be a string of at most ${MAX_INTENT_LENGTH} characters` };
  return { artifactId: artifactId ?? '', create, target: body.target ?? null, agent, intent: body.intent };
}

export interface UrlTarget { url: string; origin: string; hostname: string; port: string }

export function parseUrlTarget(target: unknown): { ok: true; target: UrlTarget } | { ok: false; detail: string } {
  if (!isRecord(target)) return { ok: false, detail: 'target must be an object' };
  const extra = Object.keys(target).filter((k) => k !== 'url');
  if (extra.length) return { ok: false, detail: `a url target names only the url (not ${extra.join(', ')})` };
  const raw = target.url;
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > MAX_URL_LENGTH) return { ok: false, detail: `url must be a string of at most ${MAX_URL_LENGTH} characters` };
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, detail: 'url is not a valid absolute URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, detail: 'url must be http or https' };
  if (u.username !== '' || u.password !== '') return { ok: false, detail: 'url must not carry credentials' };
  if (!u.hostname) return { ok: false, detail: 'url has no host' };
  return { ok: true, target: { url: u.href, origin: u.origin, hostname: u.hostname, port: u.port } };
}

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

function segments(url: string): string[] | null {
  const q = url.indexOf('?');
  const p = q === -1 ? url : url.slice(0, q);
  if (!p.startsWith('/')) return null;
  try {
    return p.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

function consentRefusal(consent: { allowed: false; reason: string }): ControlResponse {
  if (consent.reason === 'too-many-pending') return errorResponse('too-many-pending', 'too many sessions are already waiting for an answer in Shim for Chrome');
  return errorResponse(`consent-${consent.reason}`, consent.reason === 'timeout' ? 'nobody answered the card within two minutes' : undefined);
}

const CANCELLED = 'the request went away before the session opened';

// Tab targets name `webContentsId` (the browser's wire field), read here as the Chrome tab id.
function tabIdOf(target: unknown): number | null {
  if (!isRecord(target) || typeof target.webContentsId !== 'number' || !Number.isInteger(target.webContentsId)) return null;
  return target.webContentsId;
}

async function openOn(deps: ControlDeps, req: AttachRequest, tab: TabInfo, signal: AbortSignal, opts: { approvedOrigin?: string; ownsTab: boolean; consent: 'asked' | 'remembered' }): Promise<ControlResponse> {
  const acquired = await deps.acquiredOrigins(req, tab);
  const fail = async (response: ControlResponse, artifactId?: string): Promise<ControlResponse> => {
    if (artifactId) await deps.discardShim(artifactId);
    if (opts.ownsTab) await deps.closeTab(tab.tabId);
    if (acquired.length) await deps.releaseOrigins(acquired);
    return response;
  };
  let artifactId = req.artifactId;
  const created = req.create !== null;
  // Every acquisition after consent — the draft, the page host — is undone
  // on any exit but success, whether it returns a refusal or throws.
  let dispose: (() => Promise<void>) | null = null;
  try {
    if (req.create !== null) {
      const made = await deps.createShim(req, tab, deps.newDraftId());
      if (!made.ok) return await fail(errorResponse(made.error, made.detail));
      artifactId = made.artifactId;
      if (signal.aborted) return await fail(errorResponse('consent-cancelled', CANCELLED), artifactId);
    }
    const made = await deps.targetFor(tab, artifactId);
    if (!made.ok) return await fail(errorResponse(made.error, made.detail), created ? artifactId : undefined);
    dispose = made.dispose;
    const open: OpenRequest = {
      kind: 'shim', artifactId, target: made.target, agent: req.agent, intent: req.intent, created,
      approvedScope: tab.url ? new URL(tab.url).hostname : undefined,
      ...(opts.approvedOrigin ? { approvedOrigin: opts.approvedOrigin } : {}),
      signal,
    };
    const opened = await deps.sessions.open(open);
    if (!opened.ok) {
      // open answered without taking over the host (artifact-busy before
      // begin, or a failed/target-changed begin that tore its own down):
      // dispose closes the host this acquisition attached.
      await dispose();
      dispose = null;
      if (opened.error === 'open-cancelled') return await fail(errorResponse('consent-cancelled', CANCELLED), created ? artifactId : undefined);
      return await fail(fromResult(opened), created ? artifactId : undefined);
    }
    // Opened: the session owns the host now (its finish closes it).
    dispose = null;
    if (signal.aborted) {
      void Promise.resolve(deps.sessions.end(opened.sessionId, 'ended')).finally(() => { if (opts.ownsTab) void deps.closeTab(tab.tabId); });
      return errorResponse('consent-cancelled', CANCELLED);
    }
    const notes = deps.takeNotes(opened.sessionId);
    return { status: 200, body: { ...opened, artifactId, consent: opts.consent, tabId: tab.tabId, url: tab.url, ...(notes.length ? { notes } : {}) } };
  } catch (e) {
    if (dispose) { try { await dispose(); } catch { /* best effort */ } }
    return await fail(errorResponse('internal-error', e instanceof Error ? e.message : String(e)), created ? artifactId : undefined);
  }
}

async function openOnUrl(deps: ControlDeps, req: AttachRequest, signal: AbortSignal): Promise<ControlResponse> {
  const parsed = parseUrlTarget(req.target);
  if (!parsed.ok) return errorResponse('invalid-target', parsed.detail);
  const target = parsed.target;
  const probe: TabInfo = { tabId: -1, windowId: -1, url: target.url, title: '', active: false };
  const resolved = await deps.resolveAttach(req, probe);
  if (!resolved.ok) return errorResponse(resolved.error, resolved.detail);
  const consent = await deps.consent.request({ ...resolved.subject, openUrl: target.url, openOrigin: target.origin }, signal);
  if (!consent.allowed) return consentRefusal(consent);
  const acquired = await deps.acquiredOrigins(req, probe);
  const fail = async (response: ControlResponse): Promise<ControlResponse> => {
    if (acquired.length) await deps.releaseOrigins(acquired);
    return response;
  };
  if (signal.aborted) return fail(errorResponse('consent-cancelled', CANCELLED));
  const again = await deps.resolveAttach(req, probe);
  if (!again.ok) return fail(errorResponse(again.error, again.detail));
  const opened = await deps.openTab(target.url, signal);
  if (!opened.ok) {
    if (opened.tabId !== null) await deps.closeTab(opened.tabId);
    if (signal.aborted) return fail(errorResponse('consent-cancelled', CANCELLED));
    return fail(errorResponse(opened.error, opened.detail));
  }
  const tab = opened.tab;
  const landed = originOf(tab.url);
  if (landed !== target.origin) {
    await deps.closeTab(tab.tabId);
    return fail({ status: statusForError('target-changed'), body: { ok: false, error: 'target-changed', landedHost: landed ?? tab.url, detail: `the page loaded at ${landed ?? (tab.url || 'an empty page')}, not ${target.origin} that was approved; the tab was closed` } });
  }
  return openOn(deps, req, tab, signal, { approvedOrigin: target.origin, ownsTab: true, consent: 'asked' });
}

async function openSession(deps: ControlDeps, body: unknown, signal: AbortSignal): Promise<ControlResponse> {
  const req = parseAttachRequest(body);
  if ('error' in req) {
    if (req.error === REQUIRES_SHIM_BROWSER) return errorResponse(REQUIRES_SHIM_BROWSER, 'compositions run only in the Shim browser');
    return errorResponse('invalid-request', req.error);
  }
  if (isRecord(req.target) && 'url' in req.target) return openOnUrl(deps, req, signal);
  const tabId = tabIdOf(req.target);
  if (tabId === null) return errorResponse('invalid-target', 'target must name a tab ({ webContentsId: tabId }) or a url');
  const tab = await deps.tab(tabId);
  if (!tab) return errorResponse('invalid-target', `no tab ${tabId} with a site this extension may see`);
  const resolved = await deps.resolveAttach(req, tab);
  if (!resolved.ok) return errorResponse(resolved.error, resolved.detail);
  const consent = await deps.consent.request(resolved.subject, signal);
  if (!consent.allowed) return consentRefusal(consent);
  // From here the card's allow may have acquired origins: every exit but
  // the open's success gives back the ones nothing else needs.
  const acquired = await deps.acquiredOrigins(req, tab);
  const fail = async (response: ControlResponse): Promise<ControlResponse> => {
    if (acquired.length) await deps.releaseOrigins(acquired);
    return response;
  };
  const current = await deps.tab(tabId);
  const again = current ? await deps.resolveAttach(req, current) : null;
  if (!current || !again) return fail(errorResponse('target-changed', 'the tab went away while the card waited for an answer'));
  if (!again.ok) return fail(errorResponse(again.error, again.detail));
  if (again.subject.scope !== resolved.subject.scope) return fail(errorResponse('target-changed', `the tab left ${resolved.subject.scope} while the card waited for an answer`));
  return openOn(deps, req, current, signal, { ownsTab: false, consent: consent.via === 'remembered' ? 'remembered' : 'asked' });
}

export async function routeControlRequest(deps: ControlDeps, req: ControlRequest): Promise<ControlResponse> {
  const parts = segments(req.url);
  if (parts === null) return errorResponse('not-found');
  const method = req.method.toUpperCase();
  const [head, id, action, ...rest] = parts;
  if (parts.length === 1 && head === 'status') {
    if (method !== 'GET') return errorResponse('method-not-allowed');
    return { status: 200, body: { ok: true, ...deps.status() } };
  }
  if (parts.length === 1 && head === 'tabs') {
    if (method !== 'GET') return errorResponse('method-not-allowed');
    const tabs = await deps.tabs();
    const windows = new Map<number, Record<string, unknown>[]>();
    for (const t of tabs) {
      const list = windows.get(t.windowId) ?? [];
      const shims = await deps.shimsOn(t);
      list.push({ tabId: t.tabId, webContentsId: t.tabId, url: t.url, title: t.title, active: t.active, host: 'chrome-extension', shims });
      windows.set(t.windowId, list);
    }
    return { status: 200, body: { ok: true, host: 'chrome-extension', windows: [...windows].map(([windowId, list]) => ({ windowId, tabs: list })), note: 'only tabs on sites Shim for Chrome may see are listed; for another site open the session on its url' } };
  }
  if (head !== 'sessions' || rest.length > 0) return errorResponse('not-found');
  if (id === undefined) {
    if (method !== 'POST') return errorResponse('method-not-allowed');
    return openSession(deps, req.body, req.signal);
  }
  if (!SESSION_ID_RE.test(id)) return errorResponse('unknown-session');
  if (action === undefined) {
    if (method !== 'DELETE') return errorResponse('method-not-allowed');
    const notes = deps.takeNotes(id);
    return fromResult(await deps.sessions.end(id, 'ended'), notes);
  }
  switch (action) {
    case 'checkout':
      if (method !== 'GET') return errorResponse('method-not-allowed');
      return fromResult(await deps.sessions.checkout(id), deps.takeNotes(id));
    case 'preview':
      if (method !== 'POST') return errorResponse('method-not-allowed');
      if (req.body === undefined) return errorResponse('invalid-request', 'the preview input is required');
      return fromResult(await deps.sessions.preview(id, req.body), deps.takeNotes(id));
    case 'call': {
      if (method !== 'POST') return errorResponse('method-not-allowed');
      const body = req.body;
      if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') return errorResponse('invalid-request', 'name is required');
      return fromResult(await deps.sessions.call(id, body.name, body.input ?? {}), deps.takeNotes(id));
    }
    case 'cards':
      if (method !== 'GET') return errorResponse('method-not-allowed');
      return { status: 200, body: { ok: true, cards: [] } };
    case 'commit': {
      if (method !== 'POST') return errorResponse('method-not-allowed');
      const body = req.body;
      if (!isRecord(body)) return errorResponse('invalid-request', 'the body must be a JSON object');
      if (typeof body.revision !== 'number') return errorResponse('invalid-request', 'revision is required');
      if (typeof body.commitId !== 'string' || body.commitId === '' || body.commitId.length > MAX_COMMIT_ID_LENGTH) return errorResponse('invalid-request', `commitId is required (at most ${MAX_COMMIT_ID_LENGTH} characters)`);
      if (typeof body.summary !== 'string' || body.summary.length > MAX_SUMMARY_LENGTH) return errorResponse('invalid-request', `summary must be a string of at most ${MAX_SUMMARY_LENGTH} characters`);
      return fromResult(await deps.sessions.commit(id, { revision: body.revision, commitId: body.commitId, summary: body.summary }), deps.takeNotes(id));
    }
    default:
      return errorResponse('not-found');
  }
}
