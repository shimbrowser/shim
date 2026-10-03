// Harness for the @shimbrowser/mcp server (packages/mcp/src/server.ts) over a
// scripted control endpoint: a real MCP client talks to the real server over
// the SDK's in-memory transport, and every request the server makes to Shim
// is recorded and answered by a script.
//
// Covers: the static tool list (session tools, the page tools, then the API
// map tools — exactly core's session definitions); shim_status with and without Shim; opening a
// session (the agent name from the MCP client, an existing shim or a new
// one, refusing both or neither, a checkout into a folder); checkout writes
// the folder; preview sends the WHOLE folder as a wire working copy (hidden
// files skipped) and tracks the revision; preview with a screenshot; commit
// defaults to the latest revision, carries a commitId, and retries a lost
// reply once with the SAME id; refusals come back as error results with a
// hint; page tools forward to /call with images converted to MCP content;
// API map tools forward the same way and an API map refusal carries its hint;
// a composition session (open by compositionId with no tab, a flat checkout
// with its marker, a re-checkout that removes stale files, the composition
// tools forwarded);
// a session-ended answer forgets the session; ending a session.
//
//   node out/packages/mcp/test/mcp-server-harness.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decodeWorkingCopy, encodeWorkingCopy } from '@shimbrowser/core/working-copy-wire';
import { SESSION_PAGE_TOOLS } from '@shimbrowser/core/page-tools';
import { SESSION_API_MAP_TOOLS } from '@shimbrowser/core/api-map-tools';
import { SESSION_COMPOSITION_TOOLS } from '@shimbrowser/core/composition-session-tools';
import { COMPOSITION_MARKER } from '../src/folder';
import { createShimMcpServer, agentDisplayName, type ShimMcpDeps } from '../src/server';
import { SESSION_TOOL_NAMES, SESSION_TOOLS } from '../src/contract';
import { ControlTransportError, type ControlClient, type ControlReply } from '../src/control-client';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

interface Sent { method: string; path: string; body: unknown }
type Script = (req: Sent) => ControlReply | Promise<ControlReply>;

function ok(body: Record<string, unknown>): ControlReply {
  return { status: 200, body: { ok: true, ...body } };
}
function refuse(status: number, error: string, detail?: string): ControlReply {
  return { status, body: { ok: false, error, ...(detail ? { detail } : {}) } };
}

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function rig(script: Script, opts: { running?: boolean; agentName?: string } = {}) {
  const sent: Sent[] = [];
  let ids = 0;
  const control: ControlClient = {
    info: { socketPath: '/x', token: 't', pid: 1, appVersion: '0.7.0', startedAt: 0 },
    async request(method, urlPath, body) {
      const req = { method, path: urlPath, body };
      sent.push(req);
      return script(req);
    },
  };
  const deps: ShimMcpDeps = {
    version: 'test',
    controlFile: '/tmp/control.json',
    connect: () => (opts.running === false ? null : control),
    launch: async () => ({ ok: true, how: 'attached', info: control.info, detail: 'running' }),
    newCommitId: () => `commit-${++ids}`,
    maxOutputTokens: 25_000,
    ...(opts.agentName ? { agentName: opts.agentName } : {}),
  };
  return { sent, deps };
}

async function connect(deps: ShimMcpDeps, clientName = 'claude-code'): Promise<Client> {
  const server = createShimMcpServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

interface Result { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as unknown as Result;
}

function firstJson(r: Result): Record<string, unknown> {
  const t = r.content[0]?.text ?? '';
  try { return JSON.parse(t) as Record<string, unknown>; } catch { return { raw: t }; }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shim-mcp-'));
}

const CHECKOUT_FILES = {
  'shim.json': '{\n  "id": "s1",\n  "rules": []\n}\n',
  'handlers/mark.js': 'module.exports = function mark() {};\n',
};

async function main(): Promise<void> {
  console.log('tool list:');
  {
    const { deps } = rig(() => ok({}));
    const client = await connect(deps);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    check('session tools first, then every page tool, the API map tools, then the composition tools',
      JSON.stringify(names) === JSON.stringify([...SESSION_TOOL_NAMES, ...Object.keys(SESSION_PAGE_TOOLS), ...Object.keys(SESSION_API_MAP_TOOLS), ...Object.keys(SESSION_COMPOSITION_TOOLS)]), names.join(','));
    const readCalls = tools.find((t) => t.name === 'read_calls');
    const { sessionId: readCallsSession, ...readCallsCore } = (readCalls?.inputSchema.properties ?? {}) as Record<string, unknown>;
    check('composition tools are core\'s session definitions', readCalls?.description === SESSION_COMPOSITION_TOOLS.read_calls.description
      && JSON.stringify(readCallsCore) === JSON.stringify(SESSION_COMPOSITION_TOOLS.read_calls.input_schema.properties));
    check('every composition tool also takes an optional sessionId', !!readCallsSession && tools.filter((t) => t.name in SESSION_COMPOSITION_TOOLS)
      .every((t) => 'sessionId' in ((t.inputSchema.properties ?? {}) as Record<string, unknown>) && !(t.inputSchema.required ?? []).includes('sessionId')));
    const inspect = tools.find((t) => t.name === 'inspect_endpoint');
    const { sessionId: inspectSession, ...inspectCore } = (inspect?.inputSchema.properties ?? {}) as Record<string, unknown>;
    check('API map tools are core\'s session definitions', inspect?.description === SESSION_API_MAP_TOOLS.inspect_endpoint.description
      && JSON.stringify(inspectCore) === JSON.stringify(SESSION_API_MAP_TOOLS.inspect_endpoint.input_schema.properties)
      && JSON.stringify(inspect?.inputSchema.required) === JSON.stringify(SESSION_API_MAP_TOOLS.inspect_endpoint.input_schema.required));
    check('every API map tool also takes an optional sessionId', !!inspectSession && tools.filter((t) => t.name in SESSION_API_MAP_TOOLS)
      .every((t) => 'sessionId' in ((t.inputSchema.properties ?? {}) as Record<string, unknown>) && !(t.inputSchema.required ?? []).includes('sessionId')));
    const view = tools.find((t) => t.name === 'view_page');
    const viewProps = (view?.inputSchema.properties ?? {}) as Record<string, unknown>;
    const { sessionId: viewSession, ...viewCore } = viewProps;
    check('page tools are core\'s session definitions', view?.description === SESSION_PAGE_TOOLS.view_page.description
      && JSON.stringify(viewCore) === JSON.stringify(SESSION_PAGE_TOOLS.view_page.input_schema.properties));
    check('every page tool also takes an optional sessionId', !!viewSession && tools.filter((t) => t.name in SESSION_PAGE_TOOLS)
      .every((t) => 'sessionId' in ((t.inputSchema.properties ?? {}) as Record<string, unknown>) && !(t.inputSchema.required ?? []).includes('sessionId')));
    const open = tools.find((t) => t.name === 'shim_open_session');
    check('session tools carry their schema', JSON.stringify(open?.inputSchema) === JSON.stringify(SESSION_TOOLS.shim_open_session.input_schema));
    check('the server states its instructions', (client.getInstructions() ?? '').includes('shim_preview'));
    await client.close();
  }

  console.log('status:');
  {
    const { deps } = rig(() => ok({}), { running: false });
    const client = await connect(deps);
    const r = firstJson(await call(client, 'shim_status'));
    check('no Shim: running false with the control file and a hint', r.running === false && r.controlFile === '/tmp/control.json' && /shim_launch/.test(String(r.hint)));
    const page = await call(client, 'view_page');
    check('a page tool without a session is refused', page.isError === true && /no-session/.test(page.content[0]?.text ?? ''));
    await client.close();
  }
  {
    const { deps, sent } = rig((req) => (req.path === '/status' ? ok({ version: '0.7.0', sessions: [] }) : ok({})));
    const client = await connect(deps);
    const r = firstJson(await call(client, 'shim_status'));
    check('Shim running: its status', r.running === true && r.version === '0.7.0' && sent[0]?.method === 'GET');
    await client.close();
  }
  {
    const { deps } = rig(() => { throw new ControlTransportError('shim-not-running', 'ECONNREFUSED'); });
    const client = await connect(deps);
    const r = firstJson(await call(client, 'shim_status'));
    check('a stale control file reads as not running', r.running === false && /ECONNREFUSED/.test(String(r.detail)));
    const tabs = await call(client, 'shim_list_tabs');
    check('other tools answer shim-not-running with the launch hint', tabs.isError === true && /shim-not-running[\s\S]*shim_launch/.test(tabs.content[0]?.text ?? ''));
    await client.close();
  }

  console.log('tab ids:');
  {
    const { deps, sent } = rig((req) => {
      if (req.path === '/tabs') return ok({ windows: [{ windowId: 2, tabs: [{ webContentsId: 41, tabId: 3, url: 'https://a.example/' }, { webContentsId: null, tabId: 4, url: 'https://b.example/' }] }] });
      if (req.path === '/sessions') return ok({ sessionId: 'sess-t' });
      return refuse(404, 'not-found');
    });
    const client = await connect(deps);
    const listed = firstJson(await call(client, 'shim_list_tabs'));
    const tabs = ((listed.windows as Array<Record<string, unknown>>)[0]?.tabs ?? []) as Array<Record<string, unknown>>;
    check('shim_list_tabs answers each tab\'s tabId as the id a session targets (its webContentsId)', tabs[0]?.tabId === 41 && !('webContentsId' in (tabs[0] ?? {}))
      && tabs.length === 1 && tabs[0]?.url === 'https://a.example/', JSON.stringify(tabs));
    await call(client, 'shim_open_session', { tabId: tabs[0]?.tabId, intent: 'x', shimId: 's' });
    const target = (sent.filter((r) => r.path === '/sessions').pop()?.body as Record<string, unknown> | undefined)?.target;
    check('…and that tabId is the target shim_open_session sends', JSON.stringify(target) === JSON.stringify({ webContentsId: 41 }), JSON.stringify(target));
    await client.close();
  }

  console.log('a session, end to end:');
  const dir = path.join(tmpDir(), 'work');
  let previewBody: unknown = null;
  let commitAttempts = 0;
  const { deps, sent } = rig(async (req) => {
    if (req.path === '/tabs') {
      return ok({ windows: [{ windowId: 1, focused: true, tabs: [
        { webContentsId: 3, tabId: 1, url: 'https://example.com/', title: 'Example', active: true, kind: 'site' },
        { webContentsId: null, tabId: 2, url: 'https://gone.example/', title: 'Gone', active: false, kind: 'site' },
      ] }] });
    }
    if (req.path === '/sessions' && req.method === 'POST') return ok({ sessionId: 'sess-1' });
    if (req.path === '/sessions/sess-1/checkout') return ok({ revision: 0, files: encodeWorkingCopy(CHECKOUT_FILES) });
    if (req.path === '/sessions/sess-1/preview') {
      previewBody = req.body;
      return ok({ applied: true, revision: 1, evidence: { rules: [{ id: 'hide', matched: 1 }], verification: 'full' } });
    }
    if (req.path === '/sessions/sess-1/call') {
      const b = req.body as { name: string; input: Record<string, unknown> };
      if (b.name === 'view_page') return ok({ result: [{ type: 'text', text: `shot ${JSON.stringify(b.input)}` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1x1 } }] });
      if (b.name === 'inspect_endpoint') return ok({ result: { ok: false, error: 'host-not-granted', detail: 'b.example is not granted' } });
      if (b.name === 'search_discovered_api') return ok({ result: { ok: true, endpoints: [{ id: 4, host: 'a.example' }] } });
      return ok({ result: JSON.stringify({ candidates: [], name: b.name }) });
    }
    if (req.path === '/sessions/sess-1/commit') {
      commitAttempts += 1;
      if (commitAttempts === 1) throw new ControlTransportError('control-failed', 'socket hang up');
      return ok({ versionId: 7, revision: (req.body as { revision: number }).revision });
    }
    if (req.path === '/sessions/sess-1' && req.method === 'DELETE') return ok({ reason: 'ended', versionId: 7 });
    return refuse(404, 'not-found');
  });
  const client = await connect(deps);

  const listed = firstJson(await call(client, 'shim_list_tabs'));
  const listedTabs = ((listed.windows as Array<Record<string, unknown>> | undefined)?.[0]?.tabs ?? []) as Array<Record<string, unknown>>;
  check('list_tabs: tabId is the id a session targets (Shim\'s webContentsId), never Shim\'s own tab id',
    listedTabs.length === 1 && listedTabs[0]?.tabId === 3 && !('webContentsId' in (listedTabs[0] ?? {})) && listedTabs[0]?.url === 'https://example.com/', JSON.stringify(listed));
  check('list_tabs: a tab with no live page is left out', !listedTabs.some((t) => t.url === 'https://gone.example/'));
  sent.length = 0;

  const both = await call(client, 'shim_open_session', { tabId: 3, intent: 'x', shimId: 'a', newShimName: 'b' });
  check('naming both shimId and newShimName is refused', both.isError === true && /exactly one/.test(both.content[0]?.text ?? ''));
  const neither = await call(client, 'shim_open_session', { tabId: 3, intent: 'x' });
  check('naming neither is refused', neither.isError === true);
  check('neither refusal reached Shim', sent.length === 0);

  const opened = firstJson(await call(client, 'shim_open_session', { tabId: 3, intent: 'Hide the promo banner', newShimName: 'tidy', dir }));
  const openReq = sent.find((s) => s.path === '/sessions');
  const openBody = openReq?.body as Record<string, unknown> | undefined;
  check('open sends kind, target, agent, intent and the new shim', openBody?.kind === 'shim'
    && JSON.stringify(openBody.target) === JSON.stringify({ webContentsId: 3 })
    && openBody.agent === 'Claude Code' && openBody.intent === 'Hide the promo banner'
    && JSON.stringify(openBody.create) === JSON.stringify({ name: 'tidy' }) && !('artifactId' in openBody), JSON.stringify(openBody));
  check('open answers the session id', opened.sessionId === 'sess-1');
  const co = opened.checkout as Record<string, unknown> | undefined;
  check('open with dir checks out', co?.revision === 0 && fs.readFileSync(path.join(dir, 'shim.json'), 'utf8') === CHECKOUT_FILES['shim.json']
    && fs.readFileSync(path.join(dir, 'handlers', 'mark.js'), 'utf8') === CHECKOUT_FILES['handlers/mark.js']);

  // The agent edits: a new handler, a hidden file that must not travel.
  fs.writeFileSync(path.join(dir, 'handlers', 'extra.js'), 'module.exports = function extra() {};\n');
  fs.writeFileSync(path.join(dir, '.shim-state.json'), '{}');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref');
  const preview = await call(client, 'shim_preview');
  const ev = firstJson(preview);
  check('preview answers revision, applied and evidence', ev.revision === 1 && ev.applied === true
    && (ev.evidence as Record<string, unknown>).verification === 'full');
  const wire = (previewBody as { workingCopy?: unknown } | null)?.workingCopy;
  const folder = decodeWorkingCopy(wire);
  check('preview sends the whole folder, hidden entries skipped',
    JSON.stringify(Object.keys(folder).sort()) === JSON.stringify(['handlers/extra.js', 'handlers/mark.js', 'shim.json']), JSON.stringify(Object.keys(folder)));

  const withShot = await call(client, 'shim_preview', { screenshot: true, selector: '.banner' });
  const img = withShot.content.find((c) => c.type === 'image');
  check('preview with screenshot appends view_page\'s caption and image', img?.data === PNG_1x1 && img.mimeType === 'image/png'
    && withShot.content.some((c) => c.text === 'shot {"selector":".banner"}'));

  const page = await call(client, 'query_page', { description: 'promo banner' });
  const callReq = [...sent].reverse().find((s) => s.path === '/sessions/sess-1/call');
  check('a page tool forwards name and input to /call', JSON.stringify(callReq?.body) === JSON.stringify({ name: 'query_page', input: { description: 'promo banner' } }));
  await call(client, 'inspect_element', { selector: '.banner', sessionId: 'sess-1' });
  const aimed = [...sent].reverse().find((s) => s.path === '/sessions/sess-1/call');
  check('a page tool\'s sessionId picks the session and is not forwarded', JSON.stringify(aimed?.body) === JSON.stringify({ name: 'inspect_element', input: { selector: '.banner' } }));
  check('a string result comes back as text', JSON.parse(page.content[0]?.text ?? '{}').name === 'query_page');

  const search = firstJson(await call(client, 'search_discovered_api', { description: 'tracks', host: 'a.example' }));
  const searchReq = [...sent].reverse().find((s) => s.path === '/sessions/sess-1/call');
  check('an API map tool forwards name and input to /call', JSON.stringify(searchReq?.body) === JSON.stringify({ name: 'search_discovered_api', input: { description: 'tracks', host: 'a.example' } }));
  check('its result comes back as JSON text', search.ok === true && Array.isArray(search.endpoints));
  await call(client, 'search_discovered_api', { description: 'tracks', sessionId: 'sess-1' });
  const aimedApi = [...sent].reverse().find((s) => s.path === '/sessions/sess-1/call');
  check('an API map tool\'s sessionId picks the session and is not forwarded', JSON.stringify(aimedApi?.body) === JSON.stringify({ name: 'search_discovered_api', input: { description: 'tracks' } }));
  const notGranted = await call(client, 'inspect_endpoint', { host: 'b.example', endpointId: 4 });
  const ng = firstJson(notGranted);
  check('an API map refusal is a result with its hint, not a transport error', notGranted.isError !== true && ng.error === 'host-not-granted'
    && typeof ng.hint === 'string' && /request_sources/.test(String(ng.hint)), JSON.stringify(ng));

  const committed = firstJson(await call(client, 'shim_commit', { summary: 'Hid the banner.' }));
  const commits = sent.filter((s) => s.path === '/sessions/sess-1/commit').map((s) => s.body as Record<string, unknown>);
  check('commit defaults to the latest preview revision', commits[0]?.revision === 1 && commits[0]?.summary === 'Hid the banner.');
  check('a lost reply is retried once with the same commitId', commits.length === 2 && commits[0]?.commitId === 'commit-1' && commits[1]?.commitId === 'commit-1');
  check('commit answers the version', committed.committed === true && committed.versionId === 7 && committed.commitId === 'commit-1');

  const ended = firstJson(await call(client, 'shim_end_session'));
  check('end answers the reason and last version', ended.ended === true && ended.lastVersionId === 7);
  const after = await call(client, 'view_page');
  check('after ending, there is no current session', after.isError === true && /no-session/.test(after.content[0]?.text ?? ''));
  await client.close();

  console.log('refusals:');
  {
    const { deps: d2 } = rig((req) => {
      if (req.path === '/sessions') return refuse(403, 'consent-denied');
      return refuse(404, 'not-found');
    });
    const c2 = await connect(d2, 'some-agent');
    const r = await call(c2, 'shim_open_session', { tabId: 1, intent: 'x', shimId: 's' });
    check('a declined session is an error with the "don\'t retry" hint', r.isError === true && /consent-denied[\s\S]*Do not retry/.test(r.content[0]?.text ?? ''));
    await c2.close();
  }
  {
    let n = 0;
    const { deps: d3, sent: s3 } = rig((req) => {
      if (req.path === '/sessions') return ok({ sessionId: 'sess-2' });
      if (req.path.endsWith('/checkout')) return ok({ revision: 0, files: encodeWorkingCopy(CHECKOUT_FILES) });
      if (req.path.endsWith('/commit')) return refuse(409, 'stale-revision', 'latest applied revision is 4');
      if (req.path.endsWith('/call')) { n += 1; return refuse(410, 'session-ended'); }
      return refuse(404, 'not-found');
    }, { agentName: 'Custom Agent' });
    const c3 = await connect(d3);
    await call(c3, 'shim_open_session', { tabId: 1, intent: 'x', shimId: 's' });
    check('SHIM_AGENT_NAME overrides the client name', (s3[0]?.body as Record<string, unknown>).agent === 'Custom Agent');
    check('shimId opens an existing shim', (s3[0]?.body as Record<string, unknown>).artifactId === 's' && !('create' in (s3[0]?.body as Record<string, unknown>)));
    const stale = await call(c3, 'shim_commit', { summary: 's', revision: 2, commitId: 'mine' });
    const sentCommit = s3.find((s) => s.path.endsWith('/commit'))?.body as Record<string, unknown> | undefined;
    check('an explicit revision and commitId are sent as given', sentCommit?.revision === 2 && sentCommit?.commitId === 'mine');
    check('stale-revision is an error with its detail and hint', stale.isError === true && /stale-revision: latest applied revision is 4[\s\S]*Preview again/.test(stale.content[0]?.text ?? ''));
    check('a refused commit is not retried', s3.filter((s) => s.path.endsWith('/commit')).length === 1);
    const gone = await call(c3, 'view_page');
    check('session-ended is an error', gone.isError === true && /session-ended/.test(gone.content[0]?.text ?? ''));
    const again = await call(c3, 'view_page');
    check('…and the session is forgotten', again.isError === true && /no-session/.test(again.content[0]?.text ?? '') && n === 1);
    const preview = await call(c3, 'shim_preview', { sessionId: 'sess-2' });
    check('preview with no folder says to check out first', preview.isError === true && /no-working-copy/.test(preview.content[0]?.text ?? ''));
    const occupied = path.join(tmpDir(), 'occupied');
    fs.mkdirSync(occupied, { recursive: true });
    fs.writeFileSync(path.join(occupied, 'README.md'), 'mine');
    const openedBusy = await call(c3, 'shim_open_session', { tabId: 1, intent: 'x', shimId: 's', dir: occupied });
    const busy = firstJson(openedBusy);
    const busyCheckout = busy.checkout as Record<string, unknown> | undefined;
    check('open whose checkout fails still answers the open session', openedBusy.isError !== true && busy.sessionId === 'sess-2'
      && busyCheckout?.error === 'not-a-working-copy' && /shim_checkout/.test(String(busy.hint)), JSON.stringify(busy));
    check('…and leaves the folder alone', fs.readdirSync(occupied).join(',') === 'README.md');
    const unknown = await call(c3, 'not_a_tool');
    check('an unknown tool is an error result', unknown.isError === true && /unknown-tool/.test(unknown.content[0]?.text ?? ''));
    await c3.close();
  }

  console.log('a composition session:');
  {
    const cdir = path.join(tmpDir(), 'comp');
    let body: unknown = null;
    // A composition can hold hidden files of its own (an internal turn may write them).
    const COMP_FILES: Record<string, string | Uint8Array> = {
      'manifest.json': '{\n  "format": "composition/1"\n}\n', 'index.html': '<p>hi</p>', 'logo.png': new Uint8Array([137, 80, 78, 71, 255]),
      '.config.js': 'export default {};', '.well-known/data.json': '{}',
    };
    let checkoutFiles = COMP_FILES;
    const { deps: dc, sent: sc } = rig((req) => {
      if (req.path === '/sessions') return ok({ sessionId: 'sess-c', artifactId: 'comp-1' });
      if (req.path === '/sessions/sess-c/checkout') return ok({ revision: 0, files: encodeWorkingCopy(checkoutFiles) });
      if (req.path === '/sessions/sess-c/preview') { body = req.body; return ok({ applied: true, revision: 1, evidence: { changes: ['write-file app.js'] } }); }
      if (req.path === '/sessions/sess-c/call') return ok({ result: { scope: 'current', calls: [] } });
      return refuse(404, 'not-found');
    });
    const cc = await connect(dc);
    const three = await call(cc, 'shim_open_session', { intent: 'x', shimId: 'a', compositionId: 'c' });
    check('naming a shim and a composition together is refused', three.isError === true && /exactly one/.test(three.content[0]?.text ?? ''));
    const noTab = await call(cc, 'shim_open_session', { intent: 'x', shimId: 'a' });
    check('a shim session without tabId is refused', noTab.isError === true && /needs tabId/.test(noTab.content[0]?.text ?? ''));
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, 'manifest.json'), '{}');
    const notOurs = await call(cc, 'shim_open_session', { intent: 'Build a crate view', compositionId: 'comp-1', dir: cdir });
    const notOursOut = firstJson(notOurs);
    check('a folder that merely holds a manifest.json is not a checkout target (the session still opens)', notOurs.isError !== true
      && (notOursOut.checkout as Record<string, unknown> | undefined)?.error === 'not-a-working-copy'
      && fs.readdirSync(cdir).join(',') === 'manifest.json', JSON.stringify(notOursOut));
    fs.rmSync(cdir, { recursive: true });
    const openedC = firstJson(await call(cc, 'shim_open_session', { intent: 'Build a crate view', compositionId: 'comp-1', dir: cdir }));
    const openC = sc.filter((s) => s.path === '/sessions').pop()?.body as Record<string, unknown> | undefined;
    check('open sends kind composition, the id, and no target without a tab', openC?.kind === 'composition' && openC.artifactId === 'comp-1' && !('target' in openC), JSON.stringify(openC));
    check('open answers the composition id', openedC.kind === 'composition' && openedC.compositionId === 'comp-1');
    check('the checkout writes the files flat, binary intact, with the marker', fs.existsSync(path.join(cdir, 'manifest.json'))
      && fs.readFileSync(path.join(cdir, 'logo.png')).equals(Buffer.from([137, 80, 78, 71, 255])) && fs.existsSync(path.join(cdir, COMPOSITION_MARKER)));
    check('the checkout writes the composition\'s hidden files too', fs.readFileSync(path.join(cdir, '.config.js'), 'utf8') === 'export default {};'
      && fs.existsSync(path.join(cdir, '.well-known', 'data.json')));
    fs.writeFileSync(path.join(cdir, 'app.js'), 'go();');
    fs.writeFileSync(path.join(cdir, 'stale.css'), 'x');
    // Editor and VCS litter, beside and inside a hidden folder the composition has.
    fs.writeFileSync(path.join(cdir, '.index.html.swp'), 'swap');
    fs.mkdirSync(path.join(cdir, '.git'));
    fs.writeFileSync(path.join(cdir, '.git', 'HEAD'), 'ref');
    fs.writeFileSync(path.join(cdir, '.well-known', '.DS_Store'), 'x');
    const pc = firstJson(await call(cc, 'shim_preview'));
    const sentFolder = decodeWorkingCopy((body as { workingCopy?: unknown } | null)?.workingCopy, { maxFiles: 300, maxBytes: 60 * 1024 * 1024 });
    check('preview sends the folder without the marker', pc.revision === 1 && 'app.js' in sentFolder && !(COMPOSITION_MARKER in sentFolder), JSON.stringify(Object.keys(sentFolder)));
    check('preview sends the hidden files the checkout wrote, and no other hidden file', sentFolder['.config.js'] === 'export default {};'
      && '.well-known/data.json' in sentFolder && !('.index.html.swp' in sentFolder) && !('.git/HEAD' in sentFolder) && !('.well-known/.DS_Store' in sentFolder),
    JSON.stringify(Object.keys(sentFolder)));
    checkoutFiles = { ...COMP_FILES };
    delete checkoutFiles['.config.js'];
    const again = firstJson(await call(cc, 'shim_checkout', { dir: cdir }));
    const removed = Array.isArray(again.removed) ? (again.removed as string[]).slice().sort() : [];
    check('a re-checkout removes what the composition no longer has, hidden files it wrote included', JSON.stringify(removed) === JSON.stringify(['.config.js', 'app.js', 'stale.css'])
      && !fs.existsSync(path.join(cdir, 'app.js')) && !fs.existsSync(path.join(cdir, '.config.js')) && fs.existsSync(path.join(cdir, '.git', 'HEAD')), JSON.stringify(again));
    checkoutFiles = { ...COMP_FILES, [COMPOSITION_MARKER]: 'mine' };
    const clash = await call(cc, 'shim_checkout', { dir: cdir });
    check('a composition holding a file named like the marker is refused, the folder untouched', clash.isError === true
      && /unsafe-path/.test(clash.content[0]?.text ?? '') && fs.existsSync(path.join(cdir, 'index.html'))
      && fs.readFileSync(path.join(cdir, COMPOSITION_MARKER), 'utf8').includes('shim-composition-checkout/1'), clash.content[0]?.text);
    checkoutFiles = COMP_FILES;
    // A stray or corrupt file by the marker's name does not make a folder a checkout.
    for (const [label, marker] of [['an empty stray', ''], ['a corrupt', '{"hidden": ['], ['a foreign-format', '{"format":"other","hidden":[]}']] as const) {
      const project = path.join(tmpDir(), `stray-${label.replace(/\W+/g, '-')}`);
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, 'README.md'), 'mine');
      fs.writeFileSync(path.join(project, COMPOSITION_MARKER), marker);
      const stray = await call(cc, 'shim_checkout', { dir: project });
      check(`${label} marker beside a project does not authorize the checkout, nothing deleted`, stray.isError === true
        && /not-a-working-copy/.test(stray.content[0]?.text ?? '') && fs.readFileSync(path.join(project, 'README.md'), 'utf8') === 'mine'
        && fs.readFileSync(path.join(project, COMPOSITION_MARKER), 'utf8') === marker, stray.content[0]?.text);
    }
    const onlyStray = path.join(tmpDir(), 'only-stray-marker');
    fs.mkdirSync(onlyStray, { recursive: true });
    fs.writeFileSync(path.join(onlyStray, COMPOSITION_MARKER), 'not json');
    const onlyStrayOut = await call(cc, 'shim_checkout', { dir: onlyStray });
    check('a folder holding only a stray marker is refused and left alone', onlyStrayOut.isError === true
      && fs.readdirSync(onlyStray).join(',') === COMPOSITION_MARKER, onlyStrayOut.content[0]?.text);
    // A hidden file the user already has is not the checkout's to overwrite.
    const dotted = path.join(tmpDir(), 'dotted');
    fs.mkdirSync(path.join(dotted, '.well-known'), { recursive: true });
    fs.writeFileSync(path.join(dotted, '.config.js'), 'my config');
    const collide = await call(cc, 'shim_checkout', { dir: dotted });
    check('a checkout refuses to overwrite a hidden file no earlier checkout wrote', collide.isError === true
      && /not-a-working-copy/.test(collide.content[0]?.text ?? '') && /\.config\.js/.test(collide.content[0]?.text ?? '')
      && fs.readFileSync(path.join(dotted, '.config.js'), 'utf8') === 'my config' && !fs.existsSync(path.join(dotted, 'index.html')), collide.content[0]?.text);
    fs.rmSync(path.join(dotted, '.config.js'));
    const intoDotted = firstJson(await call(cc, 'shim_checkout', { dir: dotted }));
    check('…while a hidden folder of the user\'s with no clashing file is fine', Array.isArray(intoDotted.files)
      && fs.existsSync(path.join(dotted, '.well-known', 'data.json')) && fs.existsSync(path.join(dotted, COMPOSITION_MARKER)), JSON.stringify(intoDotted));
    fs.writeFileSync(path.join(dotted, '.config.js'), 'edited');
    const redo = firstJson(await call(cc, 'shim_checkout', { dir: dotted }));
    check('…and a re-checkout overwrites the hidden files its marker lists', Array.isArray(redo.files)
      && fs.readFileSync(path.join(dotted, '.config.js'), 'utf8') === 'export default {};', JSON.stringify(redo));
    const rc = firstJson(await call(cc, 'read_calls', {}));
    const rcReq = sc.filter((s) => s.path === '/sessions/sess-c/call').pop();
    check('a composition tool forwards to /call', JSON.stringify(rcReq?.body) === JSON.stringify({ name: 'read_calls', input: {} }) && rc.scope === 'current');
    await cc.close();
  }

  console.log('agent names:');
  check('claude-code reads as Claude Code', agentDisplayName('claude-code') === 'Claude Code');
  check('another client keeps its name', agentDisplayName('cursor') === 'cursor');
  check('no client name has a fallback', agentDisplayName(undefined) === 'An MCP client');
}

main().then(() => {
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}, (e: unknown) => {
  console.error(e);
  process.exit(1);
});
