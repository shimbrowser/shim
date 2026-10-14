// Harness for the MCP server's auto mode (packages/mcp/src/server.ts,
// modes.ts; shim-core C5): one server, the plugin's only entry, serves both
// people with Shim and people without it. A real MCP client talks to the
// real server over the SDK's in-memory transport; the Shim endpoint and the
// headless control are scripted, and every request each receives is recorded.
//
// Covers: shim_status names both modes, whether each is available and why,
// and what to do next (Shim reachable / not; Playwright found / not, with the
// install command; a live pid whose endpoint doesn't answer); a url opens
// headless only while no Shim is reachable, and with Shim running it is
// refused (shim-running) unless the call asks for headless: never a silent
// switch; every open answer names its mode and why; a tabId attaches, and so
// does a composition (it needs no tab, and runs only in Shim); each
// session keeps its mode for every later call even after Shim appears; two
// sessions in different modes side by side; refusals carry auto-mode hints;
// the single-mode servers refuse the other mode; the probe's reading of the
// discovery file (missing, dead pid, live); a headless control refusing a
// missing Playwright or Chromium with the exact command.
//
//   node out/packages/mcp/test/mcp-auto-mode-harness.js

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createShimMcpServer, type ShimMcpDeps } from '../src/server';
import { ControlTransportError, type ControlClient, type ControlReply, type ControlInfo } from '../src/control-client';
import { probeAttach, type AttachProbe } from '../src/modes';
import { createHeadlessControl } from '../src/headless-control';
import { HeadlessUnavailableError, PLAYWRIGHT_INSTALL_COMMAND, PLAYWRIGHT_MISSING, type HeadlessReadiness } from '../src/playwright-launch';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

interface Sent { method: string; path: string; body: unknown }
type Script = (req: Sent) => ControlReply | Promise<ControlReply>;

const ok = (body: Record<string, unknown>): ControlReply => ({ status: 200, body: { ok: true, ...body } });
const refuse = (status: number, error: string, detail?: string): ControlReply => ({ status, body: { ok: false, error, ...(detail ? { detail } : {}) } });

const INFO: ControlInfo = { socketPath: '/s', token: 't', pid: 4242, appVersion: '0.7.0', startedAt: 1 };

function scripted(name: string, script: Script): { client: ControlClient; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    client: {
      info: { ...INFO, socketPath: name },
      async request(method, urlPath, body) {
        const req = { method, path: urlPath, body };
        sent.push(req);
        return script(req);
      },
    },
  };
}

// Answers like Shim / the headless control would, per route.
function endpoint(kind: 'attach' | 'headless', idPrefix: string): Script {
  let n = 0;
  return (req) => {
    if (req.path === '/status') return ok({ app: 'shim', version: kind === 'attach' ? '0.7.0' : 'test (headless)', enabled: true });
    if (req.path === '/tabs') return kind === 'attach' ? ok({ windows: [] }) : refuse(422, 'requires-shim-browser', 'no tabs');
    if (req.method === 'POST' && req.path === '/sessions') {
      n += 1;
      return ok({ sessionId: `${idPrefix}${n}`, artifactId: 'shim-1', ...(kind === 'headless' ? { shimFile: '/tmp/x.shim', url: 'https://site.test/' } : {}) });
    }
    if (req.path.endsWith('/call')) {
      const name = (req.body as { name?: string }).name;
      if (kind === 'headless' && name === 'verify_across_pages') return refuse(422, 'requires-shim-browser', 'one page only');
      return ok({ result: [{ type: 'text', text: `${kind}:${String(name)}` }] });
    }
    if (req.path.endsWith('/preview')) return ok({ revision: 1, applied: true, evidence: {} });
    if (req.path.endsWith('/commit')) return ok({ versionId: `${kind}-v1`, revision: 1 });
    if (req.method === 'DELETE') return ok({ reason: 'ended' });
    return refuse(404, 'not-found');
  };
}

interface World {
  shim: boolean;
  shimAnswers: boolean;
  readiness: HeadlessReadiness;
}

function rig(world: World, mode: ShimMcpDeps['mode'] = 'auto') {
  const attach = scripted('attach', (req) => {
    if (!world.shimAnswers) throw new ControlTransportError('control-failed', 'connect ECONNREFUSED');
    return endpoint('attach', 'a')(req);
  });
  const headless = scripted('headless', endpoint('headless', 'h'));
  const deps: ShimMcpDeps = {
    version: 'test',
    mode,
    controlFile: '/u/control.json',
    connect: () => (mode === 'headless' ? headless.client : world.shim ? attach.client : null),
    headlessControl: headless.client,
    probeAttach: (): AttachProbe => (world.shim ? { reachable: true, info: INFO } : { reachable: false, reason: 'no Shim browser is running with its control endpoint on (no discovery file at /u/control.json)' }),
    headlessReadiness: () => world.readiness,
    launch: async () => ({ ok: true, how: 'attached', info: INFO, detail: 'running' }),
    newCommitId: () => 'c1',
    maxOutputTokens: 25_000,
  };
  return { deps, attach: attach.sent, headless: headless.sent };
}

async function connect(deps: ShimMcpDeps): Promise<Client> {
  const server = createShimMcpServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

interface Result { content: Array<{ type: string; text?: string }>; isError?: boolean }
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as unknown as Result;
}
function json(r: Result): Record<string, unknown> {
  const t = r.content[0]?.text ?? '';
  try { return JSON.parse(t) as Record<string, unknown>; } catch { return { raw: t }; }
}
const textOf = (r: Result): string => r.content[0]?.text ?? '';
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});

const FOUND = { available: true, playwright: '/home/u/.npm-global/lib/node_modules/playwright' } as const satisfies HeadlessReadiness;
const MISSING: HeadlessReadiness = { available: false, error: 'playwright-missing', reason: PLAYWRIGHT_MISSING, install: PLAYWRIGHT_INSTALL_COMMAND };

async function main(): Promise<void> {
  console.log('instructions:');
  {
    const client = await connect(rig({ shim: false, shimAnswers: false, readiness: FOUND }).deps);
    const instructions = client.getInstructions() ?? '';
    check('auto mode explains both modes and says to call shim_status first', /ATTACH/.test(instructions) && /HEADLESS/.test(instructions) && /shim_status first/.test(instructions));
    await client.close();
  }

  console.log('status:');
  {
    const world: World = { shim: false, shimAnswers: false, readiness: FOUND };
    const r = rig(world);
    const client = await connect(r.deps);
    let s = json(await call(client, 'shim_status'));
    check('names auto mode', s.mode === 'auto');
    check('no Shim: attach unavailable, with the reason', rec(s.attach).available === false && /no discovery file/.test(String(rec(s.attach).reason)), JSON.stringify(s.attach));
    check('Playwright found: headless available, and where', rec(s.headless).available === true && rec(s.headless).playwright === FOUND.playwright);
    check('next: open with a url', /shim_open_session with url/.test(String(s.next)), String(s.next));
    check('nothing reached either endpoint for a missing Shim', r.attach.length === 0 && r.headless.length === 0);

    world.readiness = MISSING;
    s = json(await call(client, 'shim_status'));
    check('no Playwright: headless unavailable, with the exact install command', rec(s.headless).available === false && rec(s.headless).install === PLAYWRIGHT_INSTALL_COMMAND);
    check('next: neither ready, says the install command', String(s.next).includes(PLAYWRIGHT_INSTALL_COMMAND), String(s.next));

    world.shim = true;
    world.shimAnswers = true;
    s = json(await call(client, 'shim_status'));
    check('Shim reachable: attach available with its status', rec(s.attach).available === true && rec(s.attach).version === '0.7.0', JSON.stringify(s.attach));
    check('next: work in a Shim tab, headless only on request', /shim_list_tabs/.test(String(s.next)) && /mode: "headless"/.test(String(s.next)), String(s.next));

    world.shimAnswers = false;
    s = json(await call(client, 'shim_status'));
    check('a live pid whose endpoint does not answer: attach unavailable, with why', rec(s.attach).available === false && /did not answer/.test(String(rec(s.attach).reason)), JSON.stringify(s.attach));
    check('…next names the install command while Playwright is missing', String(s.next).includes(PLAYWRIGHT_INSTALL_COMMAND), String(s.next));

    world.readiness = FOUND;
    s = json(await call(client, 'shim_status'));
    check('a live but silent Shim with headless ready: next asks for mode: "headless", never a bare url',
      /mode: "headless"/.test(String(s.next)) && !/with url opens a headless session/.test(String(s.next)), String(s.next));
    const bare = await call(client, 'shim_open_session', { url: 'https://site.test/', intent: 'x', newShimName: 'Site', shimFile: '/tmp/x.shim' });
    check('…because a bare url is refused shim-running there (what next steers around)', bare.isError === true && /shim-running/.test(JSON.stringify(bare.content)), JSON.stringify(bare.content));
    await client.close();
  }

  console.log('opening, never a silent switch:');
  {
    const world: World = { shim: false, shimAnswers: true, readiness: FOUND };
    const r = rig(world);
    const client = await connect(r.deps);
    const opened = await call(client, 'shim_open_session', { url: 'https://site.test/', intent: 'hide the banner', newShimName: 'Site', shimFile: '/tmp/x.shim' });
    const o = json(opened);
    check('no Shim: a url opens headless', !opened.isError && o.mode === 'headless' && r.headless.some((x) => x.path === '/sessions'), textOf(opened));
    check('…and the answer says why', /no discovery file/.test(String(o.modeReason)) && /runs headless/.test(String(o.modeReason)), String(o.modeReason));
    check('…the headless control got the url and the file', JSON.stringify(rec(r.headless.find((x) => x.path === '/sessions')?.body).target) === '{"url":"https://site.test/"}');
    check('…and Shim was never asked', r.attach.length === 0);
    const hid = String(o.sessionId);

    // Shim appears mid-session: the headless session stays headless.
    world.shim = true;
    const preview = await call(client, 'view_page', { sessionId: hid });
    check('a later page tool goes to the session\'s own mode, even with Shim now running', textOf(preview) === 'headless:view_page' && r.attach.length === 0, textOf(preview));

    const refused = await call(client, 'shim_open_session', { url: 'https://site.test/', intent: 'x', newShimName: 'Other', shimFile: '/tmp/y.shim' });
    check('Shim running: a bare url is refused as shim-running', refused.isError === true && textOf(refused).startsWith('shim-running'), textOf(refused));
    check('…naming both ways forward', /shim_list_tabs/.test(textOf(refused)) && /mode: "headless"/.test(textOf(refused)));
    check('…and nothing opened anywhere', r.headless.filter((x) => x.path === '/sessions').length === 1 && !r.attach.some((x) => x.path === '/sessions'));

    const forced = json(await call(client, 'shim_open_session', { url: 'https://site.test/', intent: 'x', newShimName: 'Other', shimFile: '/tmp/y.shim', mode: 'headless' }));
    check('mode "headless" opens headless with Shim running', forced.mode === 'headless' && /as asked/.test(String(forced.modeReason)), JSON.stringify(forced));

    const attached = json(await call(client, 'shim_open_session', { tabId: 7, intent: 'x', newShimName: 'Tab' }));
    check('a tabId attaches', attached.mode === 'attach' && r.attach.some((x) => x.path === '/sessions'), JSON.stringify(attached));
    check('…and says so', /Shim browser/.test(String(attached.modeReason)));
    const aid = String(attached.sessionId);

    const viaAttach = await call(client, 'query_page', { sessionId: aid, selector: 'h1' });
    const viaHeadless = await call(client, 'query_page', { sessionId: hid, selector: 'h1' });
    check('two sessions, two modes, side by side', textOf(viaAttach) === 'attach:query_page' && textOf(viaHeadless) === 'headless:query_page');
    const committed = json(await call(client, 'shim_commit', { sessionId: hid, summary: 'hid it' }));
    check('a commit goes to its session\'s endpoint', committed.versionId === 'headless-v1' && committed.writtenTo === '/tmp/x.shim', JSON.stringify(committed));
    const browserOnly = await call(client, 'verify_across_pages', { sessionId: hid });
    check('requires-shim-browser in auto mode points at a Shim tab', browserOnly.isError === true && /open the session on a Shim tab/.test(textOf(browserOnly)), textOf(browserOnly));
    const ended = json(await call(client, 'shim_end_session', { sessionId: hid }));
    check('ending goes to the session\'s endpoint', ended.ended === true && r.headless.some((x) => x.method === 'DELETE'));

    const s = json(await call(client, 'shim_status'));
    const opened2 = (s.openedHere as Array<{ sessionId: string; mode: string }> | undefined) ?? [];
    check('status lists the sessions with their modes', opened2.some((x) => x.sessionId === aid && x.mode === 'attach') && opened2.some((x) => x.mode === 'headless'), JSON.stringify(s.openedHere));

    const composed = await call(client, 'shim_open_session', { intent: 'x', newCompositionName: 'Board', mount: 'board' });
    const composedJson = composed.isError ? {} : json(composed);
    check('a composition with no tabId attaches (it runs only in Shim, and needs no tab)', composedJson.mode === 'attach' && composedJson.kind === 'composition', textOf(composed));
    check('…and its reason names the composition, not a tab', /compositions run/.test(String(composedJson.modeReason)), String(composedJson.modeReason));
    const composedSent = r.attach.filter((x) => x.path === '/sessions').pop();
    check('…sending the new composition to Shim', JSON.stringify(composedSent?.body).includes('"create":{"name":"Board","mount":"board"}'), JSON.stringify(composedSent?.body));
    const existing = await call(client, 'shim_open_session', { intent: 'x', compositionId: 'comp-1' });
    check('an existing composition with no tabId attaches too', !existing.isError && json(existing).mode === 'attach', textOf(existing));
    const pinned = await call(client, 'shim_open_session', { intent: 'x', compositionId: 'comp-1', mode: 'headless' });
    check('a composition pinned headless is requires-shim-browser', pinned.isError === true && textOf(pinned).startsWith('requires-shim-browser'), textOf(pinned));

    const bad = await call(client, 'shim_open_session', { url: 'https://site.test/', intent: 'x', mode: 'cloud' });
    check('an unknown mode is invalid-request', bad.isError === true && textOf(bad).startsWith('invalid-request'));
    const neither = await call(client, 'shim_open_session', { intent: 'x', newShimName: 'N' });
    check('neither tabId nor url is invalid-request, naming both', neither.isError === true && /tabId/.test(textOf(neither)) && /url/.test(textOf(neither)));
    await client.close();
  }

  console.log('attach without Shim:');
  {
    const r = rig({ shim: false, shimAnswers: false, readiness: FOUND });
    const client = await connect(r.deps);
    const res = await call(client, 'shim_open_session', { tabId: 3, intent: 'x', newShimName: 'N' });
    check('a tabId with no Shim is shim-not-running, with the probe\'s reason', res.isError === true && textOf(res).startsWith('shim-not-running') && /no discovery file/.test(textOf(res)), textOf(res));
    check('…and the hint offers headless', /headless session with shim_open_session \{ url/.test(textOf(res)));
    const comp = await call(client, 'shim_open_session', { intent: 'x', newCompositionName: 'Board' });
    check('a composition with no Shim is shim-not-running, not a headless open', comp.isError === true && textOf(comp).startsWith('shim-not-running') && !r.headless.some((x) => x.path === '/sessions'), textOf(comp));
    const tabs = await call(client, 'shim_list_tabs');
    check('shim_list_tabs with no Shim says the same', tabs.isError === true && /shim_launch/.test(textOf(tabs)) && /url/.test(textOf(tabs)));
    await client.close();
  }

  console.log('single-mode servers:');
  {
    const h = rig({ shim: false, shimAnswers: false, readiness: FOUND }, 'headless');
    const hc = await connect(h.deps);
    const r1 = await call(hc, 'shim_open_session', { url: 'https://site.test/', intent: 'x', mode: 'attach', shimFile: '/tmp/x.shim' });
    check('a headless-only server refuses mode "attach"', r1.isError === true && textOf(r1).startsWith('requires-shim-browser'), textOf(r1));
    const r2 = json(await call(hc, 'shim_open_session', { url: 'https://site.test/', intent: 'x', shimFile: '/tmp/x.shim' }));
    check('…and names the mode it opened', r2.mode === 'headless');
    await hc.close();
    const a = rig({ shim: true, shimAnswers: true, readiness: FOUND }, 'attach');
    const ac = await connect(a.deps);
    const r3 = await call(ac, 'shim_open_session', { url: 'https://site.test/', intent: 'x', mode: 'headless' });
    check('an attach-only server refuses mode "headless"', r3.isError === true && textOf(r3).startsWith('headless-unavailable'), textOf(r3));
    const r4 = json(await call(ac, 'shim_open_session', { tabId: 1, intent: 'x', newShimName: 'N' }));
    check('…and names the mode it opened', r4.mode === 'attach');
    const st = json(await call(ac, 'shim_status'));
    check('attach-only status keeps its shape', st.running === true);
    await ac.close();
  }

  console.log('the attach probe:');
  {
    const file = '/u/control.json';
    const none = probeAttach(file, () => null, () => true);
    check('no discovery file: unreachable, naming the file', !none.reachable && none.reason.includes(file));
    const dead = probeAttach(file, () => INFO, () => false);
    check('a dead pid: unreachable, stale file', !dead.reachable && /4242/.test(dead.reason) && /not running/.test(dead.reason));
    const live = probeAttach(file, () => INFO, (pid) => pid === 4242);
    check('a live pid: reachable', live.reachable && live.info.pid === 4242);
  }

  console.log('headless control, nothing to drive:');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-auto-'));
    try {
      for (const err of [
        new HeadlessUnavailableError('playwright-missing', PLAYWRIGHT_MISSING, PLAYWRIGHT_INSTALL_COMMAND),
        new HeadlessUnavailableError('chromium-missing', 'no chromium: run `node "/pw/cli.js" install chromium`', 'node "/pw/cli.js" install chromium'),
      ]) {
        const control = createHeadlessControl({ version: 'test', openPage: async () => { throw err; } });
        const reply = await control.request('POST', '/sessions', {
          kind: 'shim', target: { url: 'https://site.test/' }, agent: 'a', intent: 'i', shimFile: path.join(tmp, `${err.code}.shim`), create: { name: 'N' },
        });
        check(`${err.code}: refused with that code, the message and the command`, reply.body.ok === false && reply.body.error === err.code
          && reply.body.install === err.install && String(reply.body.detail).includes(err.install), JSON.stringify(reply.body));
        await control.closeAll();
      }
      const control = createHeadlessControl({ version: 'test', playwrightAvailable: () => false, openPage: async () => { throw new Error('unused'); } });
      const status = await control.request('GET', '/status');
      check('headless /status without Playwright carries the install message', status.body.playwright === false && status.body.playwrightMissing === PLAYWRIGHT_MISSING);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  if (failures) {
    console.error(`\n✗ mcp-auto-mode: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ mcp-auto-mode: all checks passed');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
