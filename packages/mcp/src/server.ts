// The @shimbrowser/mcp server: a
// stdio MCP server that drives authoring sessions on the running Shim
// browser through its control endpoint.
//
//   session tools  shim_status, shim_launch, shim_list_tabs,
//                  shim_open_session, shim_checkout, shim_preview,
//                  shim_commit, shim_end_session
//   page tools     forwarded as-is to POST /sessions/:id/call — Shim runs
//                  them with the same implementation its own worker uses
//   API map tools  forwarded the same way (D13) — Shim asks the user for
//                  each level of access on its own cards
//   composition    probe_request, read_calls, verify_mint — forwarded the
//   tools          same way; a shim session refuses them as composition-only
//                  (interact_page and navigate are page tools: a shim session
//                  drives its own shim's controls and moves within its site)
//
// Three server modes, one tool contract (D2; modes.ts): attach drives the
// Shim browser over its control endpoint; headless drives headless-control.ts,
// an in-process stand-in for that endpoint over a Playwright page, so every
// tool takes the same path in both; auto (the default, what the plugin runs)
// holds both and picks per session — a Shim tab attaches, a url runs headless
// while no Shim is reachable. Each session remembers its mode and every later
// call goes to that mode's endpoint. Tools that need the browser answer
// requires-shim-browser in headless sessions.
//
// The server keeps only what a client needs between calls: which sessions it
// opened, the folder each was checked out into, and the latest revision a
// preview returned (what shim_commit commits by default). Everything that
// matters — ownership, ordering, revisions, consent — lives in Shim.
//
// Invariants:
//   - The whole working copy goes over the socket as bytes; Shim never reads
//     a path (D10).
//   - Every commit carries a commitId; a transport failure retries once with
//     the same id, which Shim answers from its record, never committing
//     twice (D14).
//   - No result exceeds Claude Code's tool-result limit (results.ts).
//   - Nothing here answers a consent card: the endpoint has no route for it.
//   - No silent mode switch: shim_open_session's answer names the session's
//     mode, and a url while Shim is reachable is refused unless the call asks
//     for headless (mode: "headless").

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { encodeWorkingCopy, decodeWorkingCopy, WorkingCopyWireError } from '@shimbrowser/core/working-copy-wire';
import { isPageToolName } from '@shimbrowser/core/page-tools';
import * as path from 'path';
import { isApiMapToolName } from '@shimbrowser/core/api-map-tools';
import { isDataToolName } from '@shimbrowser/core/data-tools';
import { isCompositionSessionToolName } from '@shimbrowser/core/composition-session-tools';
import { COMPOSITION_WIRE_LIMITS, SHIM_WIRE_LIMITS } from '@shimbrowser/core/working-copy-wire';
import { staticTools, isSessionToolName, SERVER_INSTRUCTIONS, HEADLESS_SERVER_INSTRUCTIONS, AUTO_SERVER_INSTRUCTIONS, type SessionToolName } from './contract';
import { pickAttachHost, type AttachHost, type AttachProbe, type ServerMode, type SessionMode } from './modes';
import type { HeadlessReadiness } from './playwright-launch';
import { ControlTransportError, type ControlClient, type ControlReply } from './control-client';
import type { LaunchOutcome } from './launch';
import {
  FolderError, readWorkingCopy, readCompositionWorkingCopy, writeCheckout, writeCompositionCheckout, checkoutKind, folderKind, type WorkingCopyKind,
} from './folder';
import { toMcpContent, fitToBudget, fitText, estimateTokens, type McpContent } from './results';

export const SERVER_NAME = 'shim';

export interface ShimMcpDeps {
  version: string;
  // The control endpoint the discovery file names, or null when there is none.
  connect(): ControlClient | null;
  // Where the discovery file is looked for (reported when Shim isn't found).
  controlFile: string;
  launch(opts: { timeoutMs?: number }): Promise<LaunchOutcome>;
  newCommitId(): string;
  maxOutputTokens: number;
  // Overrides the agent name shown on Shim's cards (default: from the MCP
  // client's own name).
  agentName?: string;
  // 'headless': connect() is the in-process headless control
  // (headless-control.ts). 'auto': connect() is the Shim browser and
  // headlessControl the headless one, picked per session. Default 'attach'.
  mode?: ServerMode;
  // Shim for Chrome's bridge (control-chrome.json), or null when there is
  // none: the second attach host. Absent: this server knows only the browser.
  connectChrome?(): ControlClient | null;
  chromeControlFile?: string;
  // Whether the bridge is there (its discovery file names a live process).
  // Default: connectChrome() is not null.
  probeChrome?(): AttachProbe;
  // `--target`: the attach host every open goes to unless the call names one.
  defaultTarget?: AttachHost;
  // auto: where headless sessions go.
  headlessControl?: ControlClient;
  // auto: whether a Shim browser is there to attach to (the discovery file
  // names a live process). Default: connect() is not null.
  probeAttach?(): AttachProbe;
  // auto / headless: whether a headless session can open a page (Playwright
  // found), with the install command when not.
  headlessReadiness?(): HeadlessReadiness;
  // How soon, then how often, a call waiting on the user in Shim reports it
  // as MCP progress (when the client asked for progress). Default 2 s, 5 s.
  waitNotices?: { firstMs: number; everyMs: number };
  now?(): number;
}

// The attach card's two minutes (Shim's CONSENT_TIMEOUT_MS): how long an
// open waits for the user before Shim answers consent-timeout.
export const ATTACH_CARD_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_WAIT_NOTICES = { firstMs: 2_000, everyMs: 5_000 };

// Session tools that never wait on a card: no progress watch for them.
const NO_CARD_TOOLS: ReadonlySet<string> = new Set(['shim_status', 'shim_launch', 'shim_list_tabs', 'shim_checkout', 'shim_end_session']);

// "1:52" — whole seconds left, never negative.
export function clockLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

// What a card from GET /sessions/:id/cards asks of the user, for a progress
// message: what to do, and on which sites.
export function cardWaitMessage(cards: readonly unknown[]): string | null {
  const first = cards.find(isRecord);
  if (!first || typeof first.card !== 'string') return null;
  const hosts = Array.isArray(first.hosts) ? first.hosts.filter((h): h is string => typeof h === 'string').join(', ') : '';
  const on = (what: string): string => (hosts ? `${what} ${hosts}` : what);
  const asks: Record<string, string> = {
    commit: 'approve the commit',
    'site-names': 'share the list of sites with an API map',
    sources: on('allow access to'),
    'replay-write': on('allow the request to'),
    reach: on('allow the composition to read'),
    'mint-host': on('allow the token check on'),
    'read-override': on('allow the request to'),
  };
  const what = asks[first.card] ?? 'answer the card';
  const more = cards.length > 1 ? ` (and ${cards.length - 1} more)` : '';
  const left = typeof first.msLeft === 'number' ? ` (${clockLeft(first.msLeft)} left)` : '';
  return `waiting for you in Shim: ${what} on the card in its sidebar${more}${left}`;
}

export interface CallToolResult {
  content: McpContent[];
  isError?: boolean;
  [key: string]: unknown;
}

interface SessionState {
  mode: SessionMode;
  // attach: the host that opened the session; every later call goes there.
  host?: AttachHost;
  dir: string | null;
  revision: number;
  // What the session is on; null when this server didn't open it (it is
  // then read off the checkout or the folder).
  kind: WorkingCopyKind | null;
  // Headless: the .shim file commits write.
  shimFile?: string;
}

/** A refusal the agent gets as an error result: a stable code plus what to do. */
export class ToolFailure extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ToolFailure';
    this.code = code;
    this.detail = detail;
  }
}

// What to do about each refusal, appended to its message.
const HINTS: Record<string, string> = {
  'shim-not-running': 'Call shim_launch.',
  unauthorized: 'Shim restarted since this server read its control file; call shim_launch to reconnect.',
  'consent-denied': 'The user declined in Shim. Do not retry unless they ask you to.',
  'consent-timeout': 'Nobody answered the card in Shim. Ask the user to watch Shim\'s sidebar and try again.',
  'artifact-busy': 'Another turn or session holds this shim. Ask the user to finish it in Shim first.',
  'session-ended': 'The session is over (ended, stopped in Shim, idle, or taken over by the user). Open a new one.',
  'unknown-session': 'Open a session with shim_open_session.',
  'no-session': 'Open a session with shim_open_session.',
  'stale-revision': 'Preview again (or commit the latest revision shim_preview returned).',
  'nothing-to-commit': 'Nothing was previewed since the last commit.',
  'commit-pending': 'A commit is waiting for the user\'s approval in Shim; wait for it to settle.',
  'commit-denied': 'The user declined the commit in Shim. The session is still open.',
  'commit-timeout': 'Nobody approved the commit in Shim within two minutes. The session is still open.',
  'invalid-target': 'Use a tabId from shim_list_tabs for a tab with a site loaded.',
  'ambiguous-target': 'Both the Shim browser and Shim for Chrome are reachable; call shim_list_tabs and pass target: "shim" or "chrome" with the tabId.',
  'multiple-targets': 'Both the Shim browser and Shim for Chrome are reachable; pass target: "shim" or "chrome" to say which opens the url.',
  'target-changed': 'The tab went to another site (or, for a url, the page landed on another origin and Shim closed the tab); check shim_list_tabs, or open the url the page actually lives at, and open the session again.',
  'unknown-artifact': 'Use a shim id or a compositionId from shim_list_tabs, or newShimName / newCompositionName to start a new one.',
  'mount-taken': 'Another composition has that address; propose a different mount (shim_list_tabs lists the ones in use), or omit it and Shim suggests a free one.',
  'invalid-mount': 'A mount is lowercase letters, digits and hyphens, not starting with a hyphen.',
  'requires-shim-browser': 'This needs the Shim browser: it is not available in headless mode. Run shim-mcp without --headless, with Shim running.',
  unsupported: 'Headless mode supports a subset of shim features: remove what is listed, or author this shim in the Shim browser.',
  'page-open-failed': 'Check the url (http or https, reachable from this machine) and try again.',
  'page-load-failed': 'The page did not load in the new tab, and Shim closed it. Check the url and try again.',
  'no-window': 'Shim has no open window. Ask the user to open one, then try again.',
  'headless-unavailable': 'Restart the server without --attach (or with SHIM_MCP_MODE unset) to open headless sessions.',
  'playwright-missing': 'Run the install command above (once, in a terminal), then open the session again. Shim does not bundle Chromium.',
  'chromium-missing': 'Run the install command above (once, in a terminal), then open the session again. Shim does not bundle Chromium.',
  'system-deps-missing': 'Run the install command above (once, in a terminal; it may need sudo), then open the session again.',
};

// What a refusal means differs in auto mode, where headless is one call away.
const AUTO_HINTS: Record<string, string> = {
  'shim-not-running': 'Call shim_launch to start Shim (if it is installed), or open a headless session with shim_open_session { url, … }: no Shim needed.',
  unauthorized: 'Shim restarted since this server read its control file; call shim_launch to reconnect.',
  'requires-shim-browser': 'This needs the Shim browser: open the session on a Shim tab instead (shim_launch, shim_list_tabs, then shim_open_session with tabId).',
};

// What to do about each API map refusal (D13). These come back as a result
// with ok: false, not a transport error, so the hint rides in the result.
export const API_MAP_HINTS: Record<string, string> = {
  'host-not-granted': 'Ask for the site with request_sources; the user answers in Shim.',
  'no-sources': 'Ask for the sites you need with request_sources first.',
  'site-names-denied': 'The user declined to share the site list for this session. Ask them which site to use, then request_sources.',
  'sources-denied': 'The user declined. Do not ask for the same sites again unless they tell you to.',
  'replay-declined': 'The user declined this replay. Do not retry it unless they ask you to.',
  'read-only': 'A composition session can only replay GET and HEAD.',
  'discovery-off': 'Discovery is off in Shim\'s settings; ask the user to turn it on if the shim needs the site\'s API.',
  'consent-timeout': 'Nobody answered the card in Shim. Ask the user to watch Shim\'s sidebar and try again.',
  'too-many-pending': 'Too many cards are waiting in Shim. Try again once the user has answered them.',
};

function withApiMapHint(result: unknown): unknown {
  if (!isRecord(result) || result.ok !== false || typeof result.error !== 'string') return result;
  const hint = API_MAP_HINTS[result.error];
  return hint ? { ...result, hint } : result;
}

// An error answer is held to the same output budget as a success: a detail
// listing hundreds of bad folder paths would otherwise be dropped whole by
// Claude Code. The detail gives way; the code and the hint always survive.
function failureResult(code: string, detail: string, maxTokens: number, mode: ServerMode = 'attach'): CallToolResult {
  const hint = (mode === 'auto' ? AUTO_HINTS[code] : undefined) ?? HINTS[code];
  const tail = hint ? `\n${hint}` : '';
  const head = fitText(`${code}: ${detail}`, Math.max(0, maxTokens - estimateTokens({ type: 'text', text: tail })));
  return { isError: true, content: [{ type: 'text', text: `${head}${tail}` }] };
}

function text(value: unknown): McpContent {
  return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

// 'claude-code' → 'Claude Code'.
export function agentDisplayName(clientName: string | undefined): string {
  if (!clientName) return 'An MCP client';
  if (/^claude[-_ ]?code$/i.test(clientName)) return 'Claude Code';
  return clientName.slice(0, 200);
}

// GET /tabs names each tab twice: Shim's own tab id, and the webContentsId
// a session's target needs. The agent is told one id, `tabId`, and passes it
// to shim_open_session as the target — so it must be the webContentsId. A
// tab whose page is gone (no webContentsId) can't be targeted and is left out.
export function agentTabs(body: Record<string, unknown>, host?: AttachHost): Record<string, unknown> {
  if (!Array.isArray(body.windows)) return body;
  const windows = (body.windows as unknown[]).map((w) => {
    if (!isRecord(w) || !Array.isArray(w.tabs)) return w;
    const tabs = (w.tabs as unknown[]).flatMap((t) => {
      if (!isRecord(t)) return [];
      const { webContentsId, tabId: _shimTabId, ...rest } = t;
      return typeof webContentsId === 'number' ? [{ tabId: webContentsId, ...rest, ...(host ? { host } : {}) }] : [];
    });
    return { ...w, ...(host ? { host } : {}), tabs };
  });
  const { ok: _ok, ...rest } = body;
  return { ...rest, windows };
}

// The tab numbers a listing carried, for the open that follows it.
function listedTabIds(listing: Record<string, unknown>): number[] {
  if (!Array.isArray(listing.windows)) return [];
  return (listing.windows as unknown[]).flatMap((w) => (isRecord(w) && Array.isArray(w.tabs) ? (w.tabs as unknown[]) : []))
    .flatMap((t) => (isRecord(t) && typeof t.tabId === 'number' ? [t.tabId] : []));
}

function replyOrThrow(reply: ControlReply): Record<string, unknown> {
  if (reply.body.ok === true) return reply.body;
  const code = typeof reply.body.error === 'string' ? reply.body.error : `http-${reply.status}`;
  const detail = typeof reply.body.detail === 'string' ? reply.body.detail : `Shim answered ${reply.status}`;
  throw new ToolFailure(code, detail);
}

export function createShimMcpServer(deps: ShimMcpDeps): Server {
  const server = new Server(
    { name: SERVER_NAME, version: deps.version },
    {
      capabilities: { tools: {} },
      instructions: deps.mode === 'headless' ? HEADLESS_SERVER_INSTRUCTIONS : deps.mode === 'auto' ? AUTO_SERVER_INSTRUCTIONS : SERVER_INSTRUCTIONS,
    },
  );
  const serverMode: ServerMode = deps.mode ?? 'attach';
  const tools = staticTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
  const sessions = new Map<string, SessionState>();
  let current: string | null = null;
  // Which attach hosts listed each tab number, as of the last shim_list_tabs:
  // the two hosts number their tabs separately, so an open on a number both
  // listed must say which.
  const listedBy = new Map<number, Set<AttachHost>>();

  function attachProbe(): AttachProbe {
    if (deps.probeAttach) return deps.probeAttach();
    const c = deps.connect();
    return c ? { reachable: true, info: c.info } : { reachable: false, reason: `no Shim control endpoint found (looked for ${deps.controlFile})` };
  }
  function chromeProbe(): AttachProbe {
    if (deps.probeChrome) return deps.probeChrome();
    const c = deps.connectChrome?.() ?? null;
    return c ? { reachable: true, info: c.info } : { reachable: false, reason: `no Shim for Chrome bridge found (looked for ${deps.chromeControlFile ?? 'its discovery file'})` };
  }
  const reachable = (): Record<AttachHost, boolean> => ({ shim: attachProbe().reachable, chrome: deps.connectChrome ? chromeProbe().reachable : false });

  // The endpoint a session talks to: its mode, and for attach its host.
  function client(via: SessionMode, host: AttachHost = 'shim'): ControlClient {
    if (serverMode === 'auto' && via === 'headless') {
      if (!deps.headlessControl) throw new ToolFailure('internal-error', 'auto mode was started without a headless control');
      return deps.headlessControl;
    }
    if (host === 'chrome') {
      const c = deps.connectChrome?.() ?? null;
      if (!c) {
        const probe = chromeProbe();
        throw new ToolFailure('shim-not-running', probe.reachable ? `the Shim for Chrome bridge did not answer (${deps.chromeControlFile ?? 'its discovery file'})` : probe.reason);
      }
      return c;
    }
    const c = deps.connect();
    if (!c) {
      if (serverMode === 'auto') {
        const probe = attachProbe();
        throw new ToolFailure('shim-not-running', probe.reachable ? `no Shim control endpoint found (looked for ${deps.controlFile})` : probe.reason);
      }
      throw new ToolFailure('shim-not-running', `no Shim control endpoint found (looked for ${deps.controlFile})`);
    }
    return c;
  }

  // The mode (and attach host) a session runs in: the one it opened in. A
  // session this server didn't open goes wherever the server would open one,
  // and that endpoint answers unknown-session.
  function endpointOf(id: string): { mode: SessionMode; host: AttachHost } {
    const known = sessions.get(id);
    if (known) return { mode: known.mode, host: known.host ?? 'shim' };
    const host: AttachHost = deps.defaultTarget ?? (attachProbe().reachable || !deps.connectChrome ? 'shim' : chromeProbe().reachable ? 'chrome' : 'shim');
    if (serverMode === 'auto') return { mode: attachProbe().reachable || (deps.connectChrome && chromeProbe().reachable) ? 'attach' : 'headless', host };
    return { mode: serverMode, host };
  }

  async function control(via: SessionMode | { mode: SessionMode; host: AttachHost }, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<Record<string, unknown>> {
    const at = typeof via === 'string' ? { mode: via, host: 'shim' as AttachHost } : via;
    try {
      return replyOrThrow(await client(at.mode, at.host).request(method, path, body, timeoutMs !== undefined ? { timeoutMs } : {}));
    } catch (e) {
      if (e instanceof ControlTransportError) throw new ToolFailure(e.code, e.message);
      throw e;
    }
  }

  function sessionId(input: Record<string, unknown>): string {
    const id = str(input, 'sessionId') ?? current;
    if (!id) throw new ToolFailure('no-session', 'no session is open');
    return id;
  }

  function stateOf(id: string): SessionState {
    let s = sessions.get(id);
    if (!s) {
      const at = endpointOf(id);
      s = { mode: at.mode, ...(at.mode === 'attach' ? { host: at.host } : {}), dir: null, revision: 0, kind: null };
      sessions.set(id, s);
    }
    return s;
  }

  function sessionPath(id: string, action?: string): string {
    return `/sessions/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;
  }

  function forget(id: string): void {
    sessions.delete(id);
    if (current === id) current = null;
  }

  async function checkout(id: string, dir: string): Promise<Record<string, unknown>> {
    const reply = await control(endpointOf(id), 'GET', sessionPath(id, 'checkout'));
    const state = stateOf(id);
    // Decoded under the session's own limits, known before the files are:
    // a composition may carry far more than a shim (50 MiB vs 8). A session
    // this process didn't open decodes under the larger bound, then its
    // files say which kind it is.
    let files;
    try {
      files = decodeWorkingCopy(reply.files, state.kind === 'shim' ? SHIM_WIRE_LIMITS : COMPOSITION_WIRE_LIMITS);
    } catch (e) {
      if (e instanceof WorkingCopyWireError) throw new ToolFailure(e.code, e.problems.join('; '));
      throw e;
    }
    const kind = state.kind ?? checkoutKind(files);
    state.kind = kind;
    const written = kind === 'composition' ? writeCompositionCheckout(dir, files) : writeCheckout(dir, files);
    state.dir = written.dir;
    const revision = typeof reply.revision === 'number' ? reply.revision : state.revision;
    state.revision = revision;
    return { dir: written.dir, revision, files: written.written, ...(written.removed.length ? { removed: written.removed } : {}) };
  }

  async function pageTool(id: string, name: string, input: unknown): Promise<McpContent[]> {
    // sessionId picks the session here; it is not part of Shim's tool input.
    const { sessionId: _sessionId, ...toolInput } = isRecord(input) ? input : {};
    const reply = await control(endpointOf(id), 'POST', sessionPath(id, 'call'), { name, input: toolInput });
    return toMcpContent(reply.result);
  }

  // An API map tool: forwarded like a page tool (sessionId stripped the
  // same way); a refusal carries its hint.
  async function apiMapTool(id: string, name: string, input: unknown): Promise<McpContent[]> {
    const { sessionId: _sessionId, ...toolInput } = isRecord(input) ? input : {};
    const reply = await control(endpointOf(id), 'POST', sessionPath(id, 'call'), { name, input: toolInput });
    return toMcpContent(withApiMapHint(reply.result));
  }

  // auto: both modes, each available or not and why, and what to do next.
  async function autoStatus(): Promise<Record<string, unknown>> {
    const probe = attachProbe();
    let attach: Record<string, unknown>;
    // A live Shim whose endpoint does not answer: attach can't be used, yet a
    // bare url is still refused (pickMode sees the live pid), so headless
    // must be asked for by name.
    let unresponsivePid: number | null = null;
    if (!probe.reachable) {
      attach = { available: false, reason: probe.reason, controlFile: deps.controlFile };
    } else {
      const c = deps.connect();
      try {
        if (!c) throw new ToolFailure('shim-not-running', `no Shim control endpoint found (looked for ${deps.controlFile})`);
        const { ok: _ok, ...body } = replyOrThrow(await c.request('GET', '/status', undefined, { timeoutMs: 5_000 }));
        attach = { available: true, ...body };
      } catch (e) {
        if (!(e instanceof ControlTransportError) && !(e instanceof ToolFailure)) throw e;
        unresponsivePid = probe.info.pid;
        attach = {
          available: false,
          reason: `Shim (process ${probe.info.pid}) has a discovery file but did not answer on its control endpoint: ${e.message}`,
          controlFile: deps.controlFile,
        };
      }
    }
    const ready = deps.headlessReadiness ? deps.headlessReadiness() : null;
    const headlessOut: Record<string, unknown> = !ready
      ? { available: true }
      : ready.available
        ? { available: true, playwright: ready.playwright, note: 'Chromium itself is checked when a session opens.' }
        : { available: false, reason: ready.reason, install: ready.install };
    const headlessOk = headlessOut.available === true;
    const next = attach.available === true
      ? 'Shim is running: shim_list_tabs, then shim_open_session with tabId (the user\'s logins; commits go to Shim\'s library), ' +
        'or with url for a page no tab shows (the user allows Shim to open it in a new tab). ' +
        'To work on a fresh Chromium and a .shim file instead, pass url with mode: "headless".'
      : unresponsivePid !== null
        ? `Shim (process ${unresponsivePid}) is running but its control endpoint did not answer: ask the user to check Shim, or call shim_launch to reconnect. ` +
          (headlessOk
            ? 'For a headless session meanwhile, pass url with mode: "headless" (a url alone goes to Shim, which is not answering).'
            : `Headless needs Playwright, installed once: \`${String(headlessOut.install)}\`.`)
      : headlessOk
        ? 'No Shim browser: shim_open_session with url opens a headless session (a fresh Chromium, no logins; commits write a .shim file). ' +
          'If the user has Shim, shim_launch starts it instead.'
        : `Neither mode is ready. For headless, the user installs Playwright once: \`${String(headlessOut.install)}\`. Or, with Shim installed, shim_launch.`;
    return {
      mode: 'auto',
      attach,
      ...(deps.connectChrome ? { chrome: await chromeStatus() } : {}),
      headless: headlessOut,
      openedHere: [...sessions].map(([sessionId, s]) => ({ sessionId, mode: s.mode, ...(s.host ? { host: s.host } : {}) })),
      currentSession: current,
      next,
    };
  }

  // Shim for Chrome's bridge: reachable or not and why, and its status when it answers.
  async function chromeStatus(): Promise<Record<string, unknown>> {
    const probe = chromeProbe();
    if (!probe.reachable) return { available: false, reason: probe.reason, ...(deps.chromeControlFile ? { controlFile: deps.chromeControlFile } : {}) };
    const c = deps.connectChrome?.() ?? null;
    try {
      if (!c) throw new ToolFailure('shim-not-running', 'no Shim for Chrome bridge found');
      const { ok: _ok, ...body } = replyOrThrow(await c.request('GET', '/status', undefined, { timeoutMs: 5_000 }));
      return { available: true, ...body, next: 'shim_list_tabs lists its tabs with host "chrome"; shim_open_session with such a tabId (or target "chrome") opens a session there.' };
    } catch (e) {
      if (!(e instanceof ControlTransportError) && !(e instanceof ToolFailure)) throw e;
      return { available: false, reason: `Shim for Chrome (process ${probe.info.pid}) has a discovery file but its bridge did not answer: ${e.message}` };
    }
  }

  // Which mode a new session runs in, and why: never a silent switch.
  function pickMode(requested: SessionMode | undefined, hasTab: boolean, hasUrl: boolean, target?: AttachHost): { mode: SessionMode; why: string } {
    // A named attach host is an attach session, whatever else the call says.
    if (target !== undefined && requested === 'headless') throw new ToolFailure('invalid-request', 'target names an attach host; it cannot go with mode "headless"');
    if (target !== undefined && requested === undefined && serverMode !== 'headless') requested = 'attach';
    if (serverMode === 'headless') {
      if (requested === 'attach') {
        throw new ToolFailure('requires-shim-browser', 'this server runs headless only (--headless or SHIM_MCP_MODE=headless): there is no Shim browser to attach to');
      }
      return { mode: 'headless', why: 'this server runs headless only: a fresh Chromium with no logins; commits write the .shim file' };
    }
    if (serverMode === 'attach') {
      if (requested === 'headless') throw new ToolFailure('headless-unavailable', 'this server runs attach only (--attach or SHIM_MCP_MODE=attach)');
      return { mode: 'attach', why: 'a tab in the Shim browser, with the user\'s logins; commits go to Shim\'s library' };
    }
    if (requested === 'attach' || (requested === undefined && hasTab)) {
      // With two hosts the host suffix (pickAttachHost) names which; with
      // one, name the Shim browser.
      return { mode: 'attach', why: deps.connectChrome ? 'a tab in an attach host, with the user\'s logins; commits go to the host\'s library' : 'a tab in the Shim browser, with the user\'s logins; commits go to Shim\'s library' };
    }
    if (requested === 'headless') return { mode: 'headless', why: 'headless as asked: a fresh Chromium with no logins; commits write the .shim file' };
    if (!hasUrl) throw new ToolFailure('invalid-request', 'pass tabId (a tab from shim_list_tabs) or url (a page to open)');
    // A url in auto mode attaches when an attach host is reachable. With no
    // Chrome bridge configured, that is the Shim browser (the original
    // wording). With both, the effective target (the call's, else the
    // server's) pins which, so with only that host up attach is still chosen.
    if (!deps.connectChrome) {
      const probe = attachProbe();
      if (probe.reachable) {
        return { mode: 'attach', why: `the Shim browser is running (process ${probe.info.pid}): a new Shim tab at the url, once the user allows it, with their logins; commits go to Shim's library` };
      }
      return { mode: 'headless', why: `${probe.reason}, so this session runs headless: a fresh Chromium with no logins; commits write the .shim file` };
    }
    const up = reachable();
    const pinned = target ?? deps.defaultTarget;
    const attachUp = pinned === 'shim' ? up.shim : pinned === 'chrome' ? up.chrome : up.shim || up.chrome;
    if (attachUp) {
      return { mode: 'attach', why: 'an attach host is running: a new tab at the url, once the user allows it, with their logins; commits go to the host\'s library' };
    }
    const reason = pinned === 'chrome' ? 'Shim for Chrome is not reachable' : pinned === 'shim' ? 'the Shim browser is not reachable' : 'no attach host is reachable';
    return { mode: 'headless', why: `${reason}, so this session runs headless: a fresh Chromium with no logins; commits write the .shim file` };
  }

  async function runSessionTool(name: SessionToolName, input: Record<string, unknown>): Promise<McpContent[]> {
    switch (name) {
      case 'shim_status': {
        if (serverMode === 'auto') return [text(await autoStatus())];
        const c = deps.connect();
        if (!c) {
          return [text({ running: false, controlFile: deps.controlFile, hint: 'Shim is not running with its control endpoint on. Call shim_launch, or turn the endpoint on in Shim\'s Settings.' })];
        }
        try {
          const body = replyOrThrow(await c.request('GET', '/status', undefined, { timeoutMs: 5_000 }));
          return [text({ running: true, ...body, openedHere: [...sessions.keys()], currentSession: current })];
        } catch (e) {
          if (e instanceof ControlTransportError) {
            return [text({ running: false, controlFile: deps.controlFile, detail: e.message, hint: 'Call shim_launch.' })];
          }
          throw e;
        }
      }
      case 'shim_launch': {
        if (serverMode === 'headless') {
          throw new ToolFailure('requires-shim-browser', 'headless mode drives its own Chromium per session: there is no Shim to launch. Open a session with shim_open_session { url, … }.');
        }
        const seconds = typeof input.timeoutSeconds === 'number' && input.timeoutSeconds > 0 ? input.timeoutSeconds : undefined;
        const outcome = await deps.launch(seconds !== undefined ? { timeoutMs: seconds * 1000 } : {});
        if (!outcome.ok) throw new ToolFailure(outcome.error, outcome.detail);
        return [text({ ok: true, how: outcome.how, detail: outcome.detail, version: outcome.info.appVersion })];
      }
      case 'shim_list_tabs': {
        // Every attach host that is there, each tab marked with its host;
        // a host that is not reachable is left out, not an error, unless
        // none is.
        const up = reachable();
        if (!up.shim && !up.chrome) return [text(agentTabs(await control('attach', 'GET', '/tabs')))];
        listedBy.clear();
        const out: Record<string, unknown> = { windows: [] as unknown[] };
        const windows: unknown[] = [];
        const hosts: Record<string, unknown> = {};
        for (const host of ['shim', 'chrome'] as const) {
          if (!up[host]) continue;
          const listing = agentTabs(await control({ mode: 'attach', host }, 'GET', '/tabs'), deps.connectChrome ? host : undefined);
          for (const tabId of listedTabIds(listing)) {
            const set = listedBy.get(tabId) ?? new Set<AttachHost>();
            set.add(host);
            listedBy.set(tabId, set);
          }
          const { windows: w, ...rest } = listing;
          if (Array.isArray(w)) windows.push(...w);
          if (deps.connectChrome) hosts[host] = rest;
          else Object.assign(out, rest);
        }
        out.windows = windows;
        if (deps.connectChrome) out.hosts = hosts;
        return [text(out)];
      }
      case 'shim_open_session': {
        const intent = typeof input.intent === 'string' ? input.intent : '';
        if (!intent.trim()) throw new ToolFailure('invalid-request', 'intent is required');
        const shimId = str(input, 'shimId');
        const newShimName = str(input, 'newShimName');
        const compositionId = str(input, 'compositionId');
        const newCompositionName = str(input, 'newCompositionName');
        const mount = str(input, 'mount');
        const dir = str(input, 'dir');
        const url = str(input, 'url');
        const requested = input.mode;
        if (requested !== undefined && requested !== 'attach' && requested !== 'headless') {
          throw new ToolFailure('invalid-request', 'mode must be "attach" or "headless" (or left out)');
        }
        const target = input.target;
        if (target !== undefined && target !== 'shim' && target !== 'chrome') {
          throw new ToolFailure('invalid-request', 'target must be "shim" or "chrome" (or left out)');
        }
        // A composition runs only in the Shim browser and needs no tab: it
        // picks attach as a tabId does (a headless pin still refuses it below).
        const wantsComposition = compositionId !== undefined || newCompositionName !== undefined;
        if (url !== undefined && input.tabId !== undefined) throw new ToolFailure('invalid-request', 'pass tabId or url, not both');
        const pickedMode = pickMode(requested, input.tabId !== undefined || wantsComposition, url !== undefined, target);
        const picked = wantsComposition && pickedMode.mode === 'attach'
          ? { mode: pickedMode.mode, why: 'the Shim browser, where compositions run (its preview opens in a Shim tab); commits go to Shim\'s library' }
          : pickedMode;
        const agent = deps.agentName || agentDisplayName(server.getClientVersion()?.name);
        let kind: WorkingCopyKind;
        let body: Record<string, unknown>;
        if (picked.mode === 'headless') {
          if (compositionId !== undefined || newCompositionName !== undefined) {
            throw new ToolFailure('requires-shim-browser', 'compositions run only in the Shim browser: author them in attach mode');
          }
          if (!url) throw new ToolFailure('invalid-request', 'headless mode opens a page by url: pass url (tabId is for the Shim browser)');
          if (shimId !== undefined) {
            throw new ToolFailure('requires-shim-browser', 'headless mode has no shim library: name the .shim file to work on with shimFile');
          }
          // The .shim file: named, or for a new shim the checkout folder's
          // sibling (<dir>.shim).
          const named = str(input, 'shimFile');
          const shimFile = named ? path.resolve(named) : newShimName && dir ? `${path.resolve(dir)}.shim` : undefined;
          if (!shimFile) {
            throw new ToolFailure('invalid-request', 'headless mode works on a .shim file: pass shimFile (or newShimName with dir, to create <dir>.shim)');
          }
          kind = 'shim';
          body = { kind, target: { url }, agent, intent, shimFile, ...(newShimName !== undefined ? { create: { name: newShimName } } : {}) };
        } else {
          const tabId = input.tabId;
          if (tabId !== undefined && (typeof tabId !== 'number' || !Number.isInteger(tabId))) {
            throw new ToolFailure('invalid-request', 'tabId must be a tab id from shim_list_tabs');
          }
          if ([shimId, newShimName, compositionId, newCompositionName].filter((v) => v !== undefined).length !== 1) {
            throw new ToolFailure('invalid-request', 'name exactly one of shimId (an existing shim), newShimName (a new one), compositionId (a composition) or newCompositionName (a new one)');
          }
          if (mount !== undefined && newCompositionName === undefined) throw new ToolFailure('invalid-request', 'mount goes with newCompositionName (a new composition\'s address)');
          kind = compositionId !== undefined || newCompositionName !== undefined ? 'composition' : 'shim';
          if (kind === 'composition' && url !== undefined) throw new ToolFailure('invalid-request', 'a url is for a shim session; a composition takes tabId (optional) or nothing');
          if (kind === 'shim' && tabId === undefined && url === undefined) throw new ToolFailure('invalid-request', 'a shim session needs tabId (a site tab from shim_list_tabs) or url (a page Shim opens in a new tab once the user allows)');
          body = {
            kind,
            ...(tabId !== undefined ? { target: { webContentsId: tabId } } : url !== undefined ? { target: { url } } : {}),
            agent,
            intent,
            ...(compositionId !== undefined ? { artifactId: compositionId }
              : shimId !== undefined ? { artifactId: shimId }
                : newCompositionName !== undefined ? { create: { name: newCompositionName, ...(mount !== undefined ? { mount } : {}) } }
                  : { create: { name: newShimName } }),
          };
        }
        // attach: which host. Only when there are two to choose from.
        let host: AttachHost = 'shim';
        let hostWhy: string | null = null;
        if (picked.mode === 'attach' && deps.connectChrome) {
          const tabNumber = typeof input.tabId === 'number' ? input.tabId : null;
          const choice = pickAttachHost({
            ...(target !== undefined ? { requested: target } : {}),
            ...(deps.defaultTarget !== undefined ? { defaultTarget: deps.defaultTarget } : {}),
            reachable: reachable(),
            listedBy: tabNumber === null ? [] : [...(listedBy.get(tabNumber) ?? [])],
            url: url !== undefined,
            composition: wantsComposition,
          });
          if (!choice.ok) throw new ToolFailure(choice.error, choice.detail);
          host = choice.host;
          hostWhy = choice.why;
        } else if (picked.mode === 'attach' && target === 'chrome') {
          throw new ToolFailure('shim-not-running', 'this server knows no Shim for Chrome bridge (target "chrome")');
        }
        const opened = await control({ mode: picked.mode, host }, 'POST', '/sessions', body);
        const id = typeof opened.sessionId === 'string' ? opened.sessionId : null;
        if (!id) throw new ToolFailure('invalid-reply', 'Shim opened a session but returned no id');
        sessions.set(id, { mode: picked.mode, ...(picked.mode === 'attach' ? { host } : {}), dir: null, revision: 0, kind, ...(typeof opened.shimFile === 'string' ? { shimFile: opened.shimFile } : {}) });
        current = id;
        const artifactId = typeof opened.artifactId === 'string' ? opened.artifactId : null;
        const out: Record<string, unknown> = {
          sessionId: id,
          kind,
          mode: picked.mode,
          modeReason: hostWhy ? `${picked.why}; ${hostWhy}` : picked.why,
          ...(picked.mode === 'attach' && deps.connectChrome ? { host } : {}),
          ...(artifactId !== null ? (kind === 'composition' ? { compositionId: artifactId } : { shimId: artifactId }) : {}),
          ...(picked.mode === 'headless' ? { shimFile: opened.shimFile, url: opened.url } : {}),
          // A session on a url in Shim: the new tab it opened, and where the
          // page landed.
          ...(picked.mode === 'attach' && typeof opened.tabId === 'number' ? { tabId: opened.tabId } : {}),
          ...(picked.mode === 'attach' && typeof opened.url === 'string' ? { url: opened.url } : {}),
          ...(Array.isArray(opened.warnings) ? { warnings: opened.warnings } : {}),
          // A new composition's address, as the user allowed it.
          ...(typeof opened.mount === 'string' ? { mount: opened.mount } : {}),
          // 'asked': the user allowed it on the card just now; 'remembered':
          // an earlier "allow … until quit" did, and no card was shown.
          ...(opened.consent === 'asked' || opened.consent === 'remembered' ? { consent: opened.consent } : {}),
        };
        if (dir) {
          // The session is open whatever happens to the checkout: a failed
          // write (a non-empty folder, say) must not read as a failed open,
          // or the agent opens again and finds its own session holding the
          // shim (or, for a new shim, makes a second one).
          try {
            out.checkout = await checkout(id, dir);
          } catch (e) {
            // Any failure, including a native fs error (an unwritable dir, a
            // full disk), is the checkout's, never the open's.
            if (e instanceof ToolFailure) out.checkout = { error: e.code, detail: e.detail };
            else if (e instanceof FolderError) out.checkout = { error: e.code, detail: e.message };
            else out.checkout = { error: 'checkout-failed', detail: e instanceof Error ? e.message : String(e) };
            out.hint = 'The session is open, but the checkout failed: call shim_checkout with an empty folder.';
          }
        }
        return [text(out)];
      }
      case 'shim_checkout': {
        const dir = str(input, 'dir');
        if (!dir) throw new ToolFailure('invalid-request', 'dir is required');
        return [text(await checkout(sessionId(input), dir))];
      }
      case 'shim_preview': {
        const id = sessionId(input);
        const state = stateOf(id);
        const dir = str(input, 'dir') ?? state.dir;
        if (!dir) throw new ToolFailure('no-working-copy', 'this session has no folder yet: shim_checkout first, or pass dir');
        const kind = state.kind ?? folderKind(dir) ?? 'shim';
        const folder = kind === 'composition' ? readCompositionWorkingCopy(dir, COMPOSITION_WIRE_LIMITS) : readWorkingCopy(dir, SHIM_WIRE_LIMITS);
        const reply = await control(endpointOf(id), 'POST', sessionPath(id, 'preview'), { workingCopy: encodeWorkingCopy(folder) });
        if (typeof reply.revision === 'number') state.revision = reply.revision;
        state.dir = dir;
        const content: McpContent[] = [text({ revision: reply.revision, applied: reply.applied, evidence: reply.evidence })];
        if (input.screenshot === true) {
          const selector = str(input, 'selector');
          try {
            content.push(...await pageTool(id, 'view_page', selector ? { selector } : {}));
          } catch (e) {
            if (!(e instanceof ToolFailure)) throw e;
            content.push(text(`(screenshot failed: ${e.code}: ${e.detail})`));
          }
        }
        return content;
      }
      case 'shim_commit': {
        const id = sessionId(input);
        const state = stateOf(id);
        const summary = typeof input.summary === 'string' ? input.summary : '';
        if (!summary.trim()) throw new ToolFailure('invalid-request', 'summary is required');
        const revision = typeof input.revision === 'number' ? input.revision : state.revision;
        const commitId = str(input, 'commitId') ?? deps.newCommitId();
        const body = { revision, commitId, summary };
        let reply: Record<string, unknown>;
        try {
          reply = await control(endpointOf(id), 'POST', sessionPath(id, 'commit'), body);
        } catch (e) {
          // The reply was lost, not refused: the same id answers whatever
          // the first attempt did, so the retry can never commit twice.
          if (!(e instanceof ToolFailure) || !['control-failed', 'control-timeout', 'shim-not-running'].includes(e.code)) throw e;
          reply = await control(endpointOf(id), 'POST', sessionPath(id, 'commit'), body);
        }
        return [text({
          committed: true,
          versionId: reply.versionId,
          revision: reply.revision ?? revision,
          commitId,
          ...(Array.isArray(reply.notes) && reply.notes.length ? { notes: reply.notes } : {}),
          ...(state.shimFile ? { writtenTo: state.shimFile } : {}),
        })];
      }
      case 'shim_end_session': {
        const id = sessionId(input);
        const reply = await control(endpointOf(id), 'DELETE', sessionPath(id));
        forget(id);
        return [text({ ended: true, sessionId: id, reason: reply.reason, lastVersionId: reply.versionId ?? null })];
      }
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  // While an attach-mode call waits on the user in Shim — an open on its
  // attach card, a session call on a commit / API map / reach / token-check
  // card — the agent's own "look at Shim" line has long scrolled by, and the
  // call shows nothing. So when the client asked for progress, the wait is
  // reported as MCP progress: what the card asks and how long it has left.
  // A session call reports only while Shim lists a card for that session
  // (GET /sessions/:id/cards); an open reports while it is still waiting, in
  // words that hold whether or not a card is up. Returns the stop function.
  function watchWait(name: string, input: Record<string, unknown>, send: (progress: number, message: string) => void): () => void {
    let target: string | null = null;
    if (name === 'shim_open_session') {
      if (serverMode === 'headless' || input.mode === 'headless' || (input.url !== undefined && input.mode !== 'attach')) return () => {};
    } else {
      if (NO_CARD_TOOLS.has(name)) return () => {};
      const id = str(input, 'sessionId') ?? current;
      if (!id || sessions.get(id)?.mode !== 'attach') return () => {};
      target = id;
    }
    const now = deps.now ?? Date.now;
    const { firstMs, everyMs } = deps.waitNotices ?? DEFAULT_WAIT_NOTICES;
    const started = now();
    let stopped = false;
    let progress = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      let message: string | null = null;
      if (target === null) {
        message = `waiting for Shim: if its sidebar shows a "coding agent wants to connect" card, allow it there (${clockLeft(started + ATTACH_CARD_TIMEOUT_MS - now())} left)`;
      } else {
        try {
          const reply = await client('attach', endpointOf(target).host).request('GET', sessionPath(target, 'cards'), undefined, { timeoutMs: 5_000 });
          if (reply.body.ok === true && Array.isArray(reply.body.cards)) message = cardWaitMessage(reply.body.cards);
        } catch {
          // An older Shim without the route, or a hiccup: report nothing.
        }
      }
      if (stopped) return;
      if (message !== null) {
        progress += 1;
        send(progress, message);
      }
      timer = setTimeout(() => { void tick(); }, everyMs);
    };
    timer = setTimeout(() => { void tick(); }, firstMs);
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const name = request.params.name;
    const input = isRecord(request.params.arguments) ? request.params.arguments : {};
    const progressToken = request.params._meta?.progressToken;
    const stopWatch = progressToken === undefined ? () => {} : watchWait(name, input, (progress, message) => {
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress, message } }).catch(() => {});
    });
    try {
      let content: McpContent[];
      if (isSessionToolName(name)) content = await runSessionTool(name, input);
      else if (isPageToolName(name)) content = await pageTool(sessionId(input), name, input);
      else if (isApiMapToolName(name)) content = await apiMapTool(sessionId(input), name, input);
      else if (isDataToolName(name)) content = await pageTool(sessionId(input), name, input);
      else if (isCompositionSessionToolName(name)) content = await pageTool(sessionId(input), name, input);
      else return failureResult('unknown-tool', `no tool named "${name}"`, deps.maxOutputTokens);
      return { content: fitToBudget(content, deps.maxOutputTokens) };
    } catch (e) {
      if (e instanceof ToolFailure) {
        if (e.code === 'session-ended' || e.code === 'unknown-session') {
          const id = str(input, 'sessionId') ?? current;
          if (id) forget(id);
        }
        return failureResult(e.code, e.detail, deps.maxOutputTokens, serverMode);
      }
      if (e instanceof FolderError) return failureResult(e.code, e.message, deps.maxOutputTokens);
      return failureResult('internal-error', e instanceof Error ? e.message : String(e), deps.maxOutputTokens);
    } finally {
      stopWatch();
    }
  });

  return server;
}
