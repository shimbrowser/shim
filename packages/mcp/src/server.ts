// The @shimbrowser/mcp server (shim-core design D2, D6, D10, D11, D14): a
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
//   composition    probe_request, read_calls — forwarded the same way; a
//   tools          shim session answers them as not offered
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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { encodeWorkingCopy, decodeWorkingCopy, WorkingCopyWireError } from '@shimbrowser/core/working-copy-wire';
import { isPageToolName } from '@shimbrowser/core/page-tools';
import { isApiMapToolName } from '@shimbrowser/core/api-map-tools';
import { isCompositionSessionToolName } from '@shimbrowser/core/composition-session-tools';
import { COMPOSITION_WIRE_LIMITS, SHIM_WIRE_LIMITS } from '@shimbrowser/core/working-copy-wire';
import { staticTools, isSessionToolName, SERVER_INSTRUCTIONS, type SessionToolName } from './contract';
import { ControlTransportError, type ControlClient, type ControlReply } from './control-client';
import type { LaunchOutcome } from './launch';
import {
  FolderError, readWorkingCopy, writeCheckout, writeCompositionCheckout, checkoutKind, folderKind, type WorkingCopyKind,
} from './folder';
import { toMcpContent, fitToBudget, type McpContent } from './results';

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
}

export interface CallToolResult {
  content: McpContent[];
  isError?: boolean;
  [key: string]: unknown;
}

interface SessionState {
  dir: string | null;
  revision: number;
  // What the session is on; null when this server didn't open it (it is
  // then read off the checkout or the folder).
  kind: WorkingCopyKind | null;
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
  'target-changed': 'The tab went to another site while the user was deciding; check shim_list_tabs and open the session again.',
  'unknown-artifact': 'Use a shim id or a compositionId from shim_list_tabs, or newShimName to start a new shim.',
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
};

function withApiMapHint(result: unknown): unknown {
  if (!isRecord(result) || result.ok !== false || typeof result.error !== 'string') return result;
  const hint = API_MAP_HINTS[result.error];
  return hint ? { ...result, hint } : result;
}

function failureResult(code: string, detail: string): CallToolResult {
  const hint = HINTS[code];
  return { isError: true, content: [{ type: 'text', text: `${code}: ${detail}${hint ? `\n${hint}` : ''}` }] };
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

function replyOrThrow(reply: ControlReply): Record<string, unknown> {
  if (reply.body.ok === true) return reply.body;
  const code = typeof reply.body.error === 'string' ? reply.body.error : `http-${reply.status}`;
  const detail = typeof reply.body.detail === 'string' ? reply.body.detail : `Shim answered ${reply.status}`;
  throw new ToolFailure(code, detail);
}

export function createShimMcpServer(deps: ShimMcpDeps): Server {
  const server = new Server(
    { name: SERVER_NAME, version: deps.version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const tools = staticTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
  const sessions = new Map<string, SessionState>();
  let current: string | null = null;

  function client(): ControlClient {
    const c = deps.connect();
    if (!c) throw new ToolFailure('shim-not-running', `no Shim control endpoint found (looked for ${deps.controlFile})`);
    return c;
  }

  async function control(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<Record<string, unknown>> {
    try {
      return replyOrThrow(await client().request(method, path, body, timeoutMs !== undefined ? { timeoutMs } : {}));
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
      s = { dir: null, revision: 0, kind: null };
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
    const reply = await control('GET', sessionPath(id, 'checkout'));
    let files;
    try {
      files = decodeWorkingCopy(reply.files);
    } catch (e) {
      if (e instanceof WorkingCopyWireError) throw new ToolFailure(e.code, e.problems.join('; '));
      throw e;
    }
    const state = stateOf(id);
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
    const reply = await control('POST', sessionPath(id, 'call'), { name, input: toolInput });
    return toMcpContent(reply.result);
  }

  // An API map tool: forwarded like a page tool (sessionId stripped the
  // same way); a refusal carries its hint.
  async function apiMapTool(id: string, name: string, input: unknown): Promise<McpContent[]> {
    const { sessionId: _sessionId, ...toolInput } = isRecord(input) ? input : {};
    const reply = await control('POST', sessionPath(id, 'call'), { name, input: toolInput });
    return toMcpContent(withApiMapHint(reply.result));
  }

  async function runSessionTool(name: SessionToolName, input: Record<string, unknown>): Promise<McpContent[]> {
    switch (name) {
      case 'shim_status': {
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
        const seconds = typeof input.timeoutSeconds === 'number' && input.timeoutSeconds > 0 ? input.timeoutSeconds : undefined;
        const outcome = await deps.launch(seconds !== undefined ? { timeoutMs: seconds * 1000 } : {});
        if (!outcome.ok) throw new ToolFailure(outcome.error, outcome.detail);
        return [text({ ok: true, how: outcome.how, detail: outcome.detail, version: outcome.info.appVersion })];
      }
      case 'shim_list_tabs':
        return [text(await control('GET', '/tabs'))];
      case 'shim_open_session': {
        const tabId = input.tabId;
        if (tabId !== undefined && (typeof tabId !== 'number' || !Number.isInteger(tabId))) {
          throw new ToolFailure('invalid-request', 'tabId must be a tab id from shim_list_tabs');
        }
        const intent = typeof input.intent === 'string' ? input.intent : '';
        if (!intent.trim()) throw new ToolFailure('invalid-request', 'intent is required');
        const shimId = str(input, 'shimId');
        const newShimName = str(input, 'newShimName');
        const compositionId = str(input, 'compositionId');
        if ([shimId, newShimName, compositionId].filter((v) => v !== undefined).length !== 1) {
          throw new ToolFailure('invalid-request', 'name exactly one of shimId (an existing shim), newShimName (a new one) or compositionId (a composition)');
        }
        const kind: WorkingCopyKind = compositionId !== undefined ? 'composition' : 'shim';
        if (kind === 'shim' && tabId === undefined) throw new ToolFailure('invalid-request', 'a shim session needs tabId: a site tab from shim_list_tabs');
        const agent = deps.agentName || agentDisplayName(server.getClientVersion()?.name);
        const body: Record<string, unknown> = {
          kind,
          ...(tabId !== undefined ? { target: { webContentsId: tabId } } : {}),
          agent,
          intent,
          ...(compositionId !== undefined ? { artifactId: compositionId } : shimId !== undefined ? { artifactId: shimId } : { create: { name: newShimName } }),
        };
        const opened = await control('POST', '/sessions', body);
        const id = typeof opened.sessionId === 'string' ? opened.sessionId : null;
        if (!id) throw new ToolFailure('invalid-reply', 'Shim opened a session but returned no id');
        sessions.set(id, { dir: null, revision: 0, kind });
        current = id;
        const artifactId = typeof opened.artifactId === 'string' ? opened.artifactId : null;
        const out: Record<string, unknown> = {
          sessionId: id,
          kind,
          ...(artifactId !== null ? (kind === 'composition' ? { compositionId: artifactId } : { shimId: artifactId }) : {}),
        };
        const dir = str(input, 'dir');
        if (dir) out.checkout = await checkout(id, dir);
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
        const folder = readWorkingCopy(dir, kind === 'composition' ? COMPOSITION_WIRE_LIMITS : SHIM_WIRE_LIMITS);
        const reply = await control('POST', sessionPath(id, 'preview'), { workingCopy: encodeWorkingCopy(folder) });
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
          reply = await control('POST', sessionPath(id, 'commit'), body);
        } catch (e) {
          // The reply was lost, not refused: the same id answers whatever
          // the first attempt did, so the retry can never commit twice.
          if (!(e instanceof ToolFailure) || !['control-failed', 'control-timeout', 'shim-not-running'].includes(e.code)) throw e;
          reply = await control('POST', sessionPath(id, 'commit'), body);
        }
        return [text({ committed: true, versionId: reply.versionId, revision: reply.revision ?? revision, commitId })];
      }
      case 'shim_end_session': {
        const id = sessionId(input);
        const reply = await control('DELETE', sessionPath(id));
        forget(id);
        return [text({ ended: true, sessionId: id, reason: reply.reason, lastVersionId: reply.versionId ?? null })];
      }
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const input = isRecord(request.params.arguments) ? request.params.arguments : {};
    try {
      let content: McpContent[];
      if (isSessionToolName(name)) content = await runSessionTool(name, input);
      else if (isPageToolName(name)) content = await pageTool(sessionId(input), name, input);
      else if (isApiMapToolName(name)) content = await apiMapTool(sessionId(input), name, input);
      else if (isCompositionSessionToolName(name)) content = await pageTool(sessionId(input), name, input);
      else return failureResult('unknown-tool', `no tool named "${name}"`);
      return { content: fitToBudget(content, deps.maxOutputTokens) };
    } catch (e) {
      if (e instanceof ToolFailure) {
        if (e.code === 'session-ended' || e.code === 'unknown-session') {
          const id = str(input, 'sessionId') ?? current;
          if (id) forget(id);
        }
        return failureResult(e.code, e.detail);
      }
      if (e instanceof FolderError) return failureResult(e.code, e.message);
      return failureResult('internal-error', e instanceof Error ? e.message : String(e));
    }
  });

  return server;
}
