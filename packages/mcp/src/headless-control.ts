// MCP headless mode's "Shim" (shim-core design D2, D9, D14, D15): an
// in-process ControlClient that answers the same routes the Shim browser's
// control endpoint does — so server.ts drives a headless session through
// exactly the code path, wire encoding and reply shapes it drives an attached
// one with, and the tool contract stays the one static list.
//
//   GET    /status                  mode: 'headless', the open sessions
//   GET    /tabs                    requires-shim-browser (no Shim tabs)
//   POST   /sessions                open a page, load or create the shim,
//                                   preflight it (D15), open a session
//   GET    /sessions/:id/checkout   ┐
//   POST   /sessions/:id/preview    │ @shimbrowser/core's session registry
//   POST   /sessions/:id/call       │ over the headless shim backend
//   POST   /sessions/:id/commit     │ (headless-session.ts)
//   DELETE /sessions/:id            ┘
//
// What differs from attach mode, by design:
//   - No consent card: the agent drives its own browser, on a page it named,
//     with no logins (invariant 10: a fresh Chromium profile per session,
//     never the Shim browser's persist:user).
//   - The artifact is a `.shim` file the session loads (if it exists) and
//     commits to, not a row in Shim's library. Its path is the lease key, so
//     two sessions can't hold one file.
//   - Compositions, Shim's tabs, the shim library and the browser-only page
//     tools answer `requires-shim-browser`.

import * as fs from 'fs';
import * as path from 'path';
import { createSessionRegistry, LEASE_TIMEOUT, type SessionLease, type SessionLeases, type SessionRegistry, type Timers } from '@shimbrowser/core/session-registry';
import { unpackShim, ShimFolderError, type ShimFile } from '@shimbrowser/core/shim-folder';
import { preflightSpec } from '@shimbrowser/core/capability-preflight';
import type { Spec } from '@shimbrowser/core/types';
import type { ControlClient, ControlInfo, ControlReply } from './control-client';
import type { HeadlessStorage } from './playwright-page-host';
import { HEADLESS_CAPABILITIES, REQUIRES_SHIM_BROWSER } from './playwright-page-host';
import { fileStorage } from './file-storage';
import { HeadlessUnavailableError, PLAYWRIGHT_MISSING } from './playwright-launch';
import {
  createHeadlessShimBackend, newShimId, newShimSpec, unsupportedEvidence, BROWSER_ONLY_PAGE_TOOLS,
  type HeadlessSessionPage, type HeadlessShimSource, type HeadlessTarget, type HeadlessBackendOptions,
} from './headless-session';

/** How long opening a page may take before the session is refused. */
export const OPEN_PAGE_TIMEOUT_MS = 30_000;

export interface HeadlessControlOptions {
  version: string;
  /** Open a fresh page at `url` with `storage` backing its api.storage. Throws when it can't. */
  openPage(url: string, storage: HeadlessStorage): Promise<HeadlessSessionPage>;
  /** Where a session's api.storage lives, for its `.shim` file. Default: `<file>.storage.json` beside it. */
  storageFileFor?(shimFile: string): string;
  /** Whether Playwright is installed (reported by /status). */
  playwrightAvailable?(): boolean;
  backend?: HeadlessBackendOptions;
  idleTimeoutMs?: number;
  timers?: Timers;
  newId?(): string;
  newShimId?(): string;
}

/** The control client, plus ending every open session (the server shutting down). */
export interface HeadlessControl extends ControlClient {
  readonly sessions: SessionRegistry;
  closeAll(): Promise<void>;
}

const STATUS_BY_ERROR: Record<string, number> = {
  'invalid-request': 400,
  'unknown-session': 404,
  'not-found': 404,
  'method-not-allowed': 405,
  'artifact-busy': 409,
  'commit-pending': 409,
  'stale-revision': 409,
  'nothing-to-commit': 409,
  'session-ended': 410,
  'op-failed': 500,
  'internal-error': 500,
};

function reply(body: Record<string, unknown>): ControlReply {
  if (body.ok === true) return { status: 200, body };
  const error = typeof body.error === 'string' ? body.error : 'internal-error';
  return { status: STATUS_BY_ERROR[error] ?? 422, body };
}

function refuse(error: string, detail?: string, extra: Record<string, unknown> = {}): ControlReply {
  return reply({ ok: false, error, ...(detail !== undefined ? { detail } : {}), ...extra });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// One holder per key, never queued: a second session on the same `.shim`
// file is busy at once (the registry answers artifact-busy).
function exclusiveLeases(): SessionLeases {
  const held = new Set<string>();
  return {
    async acquire(key) {
      if (held.has(key)) throw new Error(LEASE_TIMEOUT);
      held.add(key);
      const controller = new AbortController();
      let released = false;
      const lease: SessionLease = {
        signal: controller.signal,
        release() {
          if (released) return;
          released = true;
          held.delete(key);
        },
      };
      return lease;
    },
  };
}

/** The `.shim` file a headless session starts from, or a refusal. */
export function loadShimFile(file: string): { ok: true; source: Omit<HeadlessShimSource, 'shimFile'> } | { ok: false; error: string; detail: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, error: 'invalid-request', detail: `could not read ${file}: ${errMessage(e)}` };
  }
  try {
    // unpackShim is the format check (shim/1, ids, handler names, …).
    unpackShim(text);
  } catch (e) {
    if (e instanceof ShimFolderError) return { ok: false, error: e.code, detail: e.problems.join('; ') };
    throw e;
  }
  const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as ShimFile;
  const spec = parsed.spec as Spec & { handlers?: Record<string, string> };
  // Handlers ride as the file's top-level module map; a non-canonical file's
  // inline sources stay on their rules (previews inline either way).
  const handlers: Record<string, string> = {};
  for (const [name, source] of Object.entries(isRecord(parsed.handlers) ? parsed.handlers : {})) {
    if (typeof source === 'string') handlers[name] = source;
  }
  for (const [name, source] of Object.entries(isRecord(spec.handlers) ? spec.handlers : {})) {
    if (typeof source === 'string' && !(name in handlers)) handlers[name] = source;
  }
  const specOnly = { ...spec };
  delete specOnly.handlers;
  const envelope: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== 'format' && key !== 'name' && key !== 'spec' && key !== 'handlers') envelope[key] = value;
  }
  return {
    ok: true,
    source: { name: typeof parsed.name === 'string' ? parsed.name : spec.id, spec: specOnly, handlers, envelope, created: false },
  };
}

/** The page's URL once it loaded: an http(s) URL, else the one requested. */
export function finalPageUrl(current: string, requested: URL): URL {
  try {
    const u = new URL(current);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u;
  } catch {
    // not a URL: fall through
  }
  return requested;
}

/**
 * Whether a match.hosts pattern covers `url` — the browser registry's
 * semantics (src/main/patches/host-match.ts): a pattern without a port
 * matches any port, an exact host or a `*.` subdomain wildcard; a pattern
 * with a port matches only that exact host:port.
 */
export function hostPatternMatches(pattern: string, url: URL): boolean {
  if (pattern.includes(':')) return pattern === (url.port ? `${url.hostname}:${url.port}` : url.hostname);
  if (pattern === url.hostname) return true;
  return pattern.startsWith('*.') && url.hostname.endsWith(pattern.slice(1));
}

export function defaultStorageFile(shimFile: string): string {
  return `${shimFile}.storage.json`;
}

export function createHeadlessControl(options: HeadlessControlOptions): HeadlessControl {
  const backend = createHeadlessShimBackend(options.backend);
  const sessions = createSessionRegistry({
    leases: { shim: exclusiveLeases() },
    backends: { shim: backend },
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.newId ? { newId: options.newId } : {}),
    onError: (label, err) => console.error(`[shim-mcp] ${label}:`, err),
  });
  const storageFileFor = options.storageFileFor ?? defaultStorageFile;
  const mintShimId = options.newShimId ?? (() => newShimId());
  const info: ControlInfo = { socketPath: '', token: '', pid: process.pid, appVersion: `${options.version} (headless)`, startedAt: Date.now() };

  function playwrightStatus(): Record<string, unknown> {
    const available = options.playwrightAvailable ? options.playwrightAvailable() : null;
    return { playwright: available, ...(available === false ? { playwrightMissing: PLAYWRIGHT_MISSING } : {}) };
  }

  async function openSession(body: unknown): Promise<ControlReply> {
    if (!isRecord(body)) return refuse('invalid-request', 'the body must be a JSON object');
    if (body.kind !== 'shim') {
      return refuse(REQUIRES_SHIM_BROWSER, 'compositions run only in the Shim browser: author them in attach mode');
    }
    if (body.artifactId !== undefined) {
      return refuse(REQUIRES_SHIM_BROWSER, 'headless mode has no shim library: name the .shim file to work on (shimFile)');
    }
    const target = isRecord(body.target) ? body.target : {};
    const url = typeof target.url === 'string' ? target.url : '';
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return refuse('invalid-request', 'headless mode opens a page by url: pass an http(s) url');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return refuse('invalid-request', 'headless mode opens http(s) pages only');
    }
    const rawFile = typeof body.shimFile === 'string' ? body.shimFile.trim() : '';
    if (!rawFile) return refuse('invalid-request', 'headless mode needs shimFile: the .shim file the session loads and commits to');
    const shimFile = path.resolve(rawFile);
    const agent = typeof body.agent === 'string' && body.agent.trim() ? body.agent.trim().slice(0, 200) : 'An MCP client';
    const intent = typeof body.intent === 'string' ? body.intent : '';
    const createName = isRecord(body.create) && typeof body.create.name === 'string' ? body.create.name.trim() : '';

    let loadedSource: Omit<HeadlessShimSource, 'shimFile'> | null = null;
    if (fs.existsSync(shimFile)) {
      if (createName) {
        return refuse('invalid-request', `${shimFile} already exists: drop newShimName to work on it, or name a new file`);
      }
      const loaded = loadShimFile(shimFile);
      if (!loaded.ok) return refuse(loaded.error, loaded.detail);
      loadedSource = loaded.source;

      // D15 preflight before anything opens: a shim declaring what headless
      // can't run is refused whole. (A new shim declares nothing.)
      const pre = preflightSpec(loadedSource.spec, HEADLESS_CAPABILITIES);
      if (!pre.ok) {
        const evidence = unsupportedEvidence(pre.unsupported);
        return refuse('unsupported', `${String(evidence.detail)}\n- ${pre.unsupported.map((u) => u.message).join('\n- ')}`, { unsupported: evidence.unsupported });
      }
    } else if (!createName) {
      return refuse('invalid-request', `${shimFile} does not exist: pass newShimName to start a new shim there`);
    }

    let page: HeadlessSessionPage;
    try {
      page = await options.openPage(parsedUrl.href, fileStorage(storageFileFor(shimFile)));
    } catch (e) {
      // No Playwright, or no Chromium for it: say which, with the exact
      // command that fixes it (Shim never bundles a browser).
      if (e instanceof HeadlessUnavailableError) return refuse(e.code, e.message, { install: e.install });
      return refuse('page-open-failed', errMessage(e));
    }
    // The page the session works on is where the url ended up, after any
    // redirect (example.com → www.example.com, a sign-in host): a new shim
    // matches that host, and the match warning checks against it.
    const landed = finalPageUrl(page.host.url(), parsedUrl);
    const source: HeadlessShimSource = loadedSource
      ? { ...loadedSource, shimFile }
      : { shimFile, name: createName, spec: newShimSpec(landed.href, mintShimId()), handlers: {}, envelope: {}, created: true };
    const sessionTarget: HeadlessTarget = { page, source };
    const opened = await sessions.open({ kind: 'shim', artifactId: shimFile, target: sessionTarget, agent, intent, created: source.created });
    if (!opened.ok) {
      await page.close().catch(() => undefined);
      return reply({ ...opened });
    }
    const hosts = source.spec.match?.hosts ?? [];
    const matches = hosts.some((h) => hostPatternMatches(h, landed));
    const where = landed.port ? `${landed.hostname}:${landed.port}` : landed.hostname;
    return reply({
      ok: true,
      sessionId: opened.sessionId,
      artifactId: source.spec.id,
      shimFile,
      url: page.host.url(),
      ...(matches ? {} : { warnings: [`the shim's match.hosts (${hosts.join(', ') || 'none'}) doesn't include ${where}: in Shim it would not run on this page`] }),
    });
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

  async function route(method: string, urlPath: string, body: unknown): Promise<ControlReply> {
    const parts = segments(urlPath);
    if (parts === null) return refuse('not-found');
    const m = method.toUpperCase();
    const [head, id, action, ...rest] = parts;
    if (parts.length === 1 && head === 'status') {
      if (m !== 'GET') return refuse('method-not-allowed');
      return reply({
        ok: true,
        app: 'shim-mcp',
        mode: 'headless',
        version: options.version,
        enabled: true,
        ...playwrightStatus(),
        sessions: sessions.list().map((s) => ({ sessionId: s.sessionId, shimFile: s.artifactId, revision: s.revision, state: s.state })),
      });
    }
    if (parts.length === 1 && head === 'tabs') {
      return refuse(REQUIRES_SHIM_BROWSER, 'headless mode has no Shim tabs: open a session on a url (shim_open_session with url)');
    }
    if (head !== 'sessions' || rest.length > 0) return refuse('not-found');
    if (id === undefined) {
      if (m !== 'POST') return refuse('method-not-allowed');
      return openSession(body);
    }
    if (action === undefined) {
      if (m !== 'DELETE') return refuse('method-not-allowed');
      return reply({ ...(await sessions.end(id, 'ended')) });
    }
    switch (action) {
      case 'checkout':
        if (m !== 'GET') return refuse('method-not-allowed');
        return reply({ ...(await sessions.checkout(id)) });
      case 'preview':
        if (m !== 'POST') return refuse('method-not-allowed');
        if (body === undefined) return refuse('invalid-request', 'the preview input is required');
        return reply({ ...(await sessions.preview(id, body)) });
      case 'call': {
        if (m !== 'POST') return refuse('method-not-allowed');
        if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') return refuse('invalid-request', 'name is required');
        const browserOnly = BROWSER_ONLY_PAGE_TOOLS[body.name];
        if (browserOnly !== undefined) {
          // Still a session call: an unknown or ended session answers that first.
          if (!sessions.get(id)) return reply({ ...(await sessions.call(id, body.name, {})) });
          return refuse(REQUIRES_SHIM_BROWSER, browserOnly);
        }
        return reply({ ...(await sessions.call(id, body.name, body.input ?? {})) });
      }
      case 'commit': {
        if (m !== 'POST') return refuse('method-not-allowed');
        if (!isRecord(body)) return refuse('invalid-request', 'the body must be a JSON object');
        if (typeof body.revision !== 'number') return refuse('invalid-request', 'revision is required');
        if (typeof body.commitId !== 'string') return refuse('invalid-request', 'commitId is required');
        if (typeof body.summary !== 'string') return refuse('invalid-request', 'summary is required');
        return reply({ ...(await sessions.commit(id, { revision: body.revision, commitId: body.commitId, summary: body.summary })) });
      }
      default:
        return refuse('not-found');
    }
  }

  return {
    info,
    sessions,
    async request(method, urlPath, body) {
      try {
        // A JSON round trip, as over the socket: the server and the backend
        // never share an object.
        const wire = body === undefined ? undefined : JSON.parse(JSON.stringify(body)) as unknown;
        const out = await route(method, urlPath, wire);
        return { status: out.status, body: JSON.parse(JSON.stringify(out.body)) as Record<string, unknown> };
      } catch (e) {
        return refuse('internal-error', errMessage(e));
      }
    },
    async closeAll() {
      await Promise.all(sessions.list().map((s) => sessions.end(s.sessionId, 'ended')));
    },
  };
}
