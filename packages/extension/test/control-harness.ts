// control-harness — the worker's route handler (packages/extension/src/control.ts)
// over fakes: a tab list, a consent gate with manual timers, a scripted
// session registry. Covers the route set and reply shapes (status, tabs with
// the chrome host, unknown routes and methods), the open path in order
// (validate, resolve, the card, resolve again, open) with every refusal
// (compositions, a bad target, a tab that left the host, a denied, timed
// out or cancelled card, a busy artifact), a new shim created only after
// consent and discarded when the open fails, grants acquired by the card
// released on every failed exit, a url target (opened after the card, the
// landed origin checked, the tab closed on failure), per-session routes
// (checkout, preview, call, commit, cards, end) with their argument checks,
// and pending notes delivered on the next answer.
//
//   node out/packages/extension/test/control-harness.js

import { routeControlRequest, parseUrlTarget, type ControlDeps, type ControlRequest, type TabInfo, type AttachRequest } from '../src/control';
import { createConsentGate, type Timers } from '../src/attach-consent';
import type { OpenRequest, SessionRegistry } from '@shimbrowser/core/session-registry';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

function manualTimers(): Timers & { advance(ms: number): void } {
  let clock = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let n = 0;
  return {
    setTimeout(fn, ms) { const id = ++n; timers.set(id, { at: clock + ms, fn }); return id; },
    clearTimeout(h) { timers.delete(h as number); },
    advance(ms) { clock += ms; for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); } },
  };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Rig {
  deps: ControlDeps;
  log: string[];
  tabs: TabInfo[];
  gate: ReturnType<typeof createConsentGate>;
  timers: ReturnType<typeof manualTimers>;
  granted: Set<string>;
  shims: Map<string, { name: string; hosts: string[] }>;
  landAt: string;
  busy: Set<string>;
  notes: Map<string, string[]>;
  hostsOpen: Set<string>;
  hostSeq: number;
  hostBusy: Set<number>;
}

function rig(): Rig {
  const log: string[] = [];
  const timers = manualTimers();
  const gate = createConsentGate({ timers, maxPending: 2, newId: (() => { let i = 0; return () => `c${++i}`; })() });
  const tabs: TabInfo[] = [{ tabId: 7, windowId: 1, url: 'https://site.test/page', title: 'Site', active: true }];
  const granted = new Set<string>(['*://site.test/*']);
  const shims = new Map<string, { name: string; hosts: string[] }>([['shim-1', { name: 'Notes', hosts: ['site.test'] }]]);
  const busy = new Set<string>();
  const notes = new Map<string, string[]>();
  let n = 0;
  const open = async (req: OpenRequest): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> => {
    log.push(`open:${req.artifactId}:${req.created ? 'created' : 'existing'}:${req.approvedScope ?? ''}:${req.approvedOrigin ?? ''}`);
    if (req.signal?.aborted) return { ok: false, error: 'open-cancelled' };
    if (busy.has(req.artifactId)) return { ok: false, error: 'artifact-busy' };
    return { ok: true, sessionId: `s${++n}` };
  };
  const sessions: Pick<SessionRegistry, 'open' | 'checkout' | 'preview' | 'call' | 'commit' | 'end'> = {
    open,
    async checkout(id) { log.push(`checkout:${id}`); return { ok: true, revision: 0, files: { format: 'x', files: [] } }; },
    async preview(id, input) { log.push(`preview:${id}:${JSON.stringify(input)}`); return { ok: true, applied: true, revision: 1, evidence: {} }; },
    async call(id, name, input) { log.push(`call:${id}:${name}:${JSON.stringify(input)}`); return { ok: true, result: `${name} ran` }; },
    async commit(id, req) { log.push(`commit:${id}:${req.revision}:${req.commitId}`); return { ok: true, versionId: 2, revision: req.revision }; },
    async end(id) { log.push(`end:${id}`); return { ok: true, reason: 'ended', versionId: null }; },
  };
  const r: Rig = { deps: null as unknown as ControlDeps, log, tabs, gate, timers, granted, shims, landAt: '', busy, notes, hostsOpen: new Set(), hostSeq: 0, hostBusy: new Set() };
  const patternsOf = (req: AttachRequest, tab: TabInfo): string[] => {
    const host = new URL(tab.url).hostname;
    return req.create ? [`*://${host}/*`] : (r.shims.get(req.artifactId)?.hosts ?? []).map((h) => `*://${h}/*`);
  };
  r.deps = {
    status: () => ({ version: '0.7.0', mode: 'full' }),
    tabs: async () => r.tabs,
    tab: async (id) => r.tabs.find((t) => t.tabId === id) ?? null,
    sessions,
    consent: gate,
    async resolveAttach(req, tab) {
      const host = new URL(tab.url).hostname;
      if (!req.create && !r.shims.has(req.artifactId)) return { ok: false, error: 'unknown-artifact', detail: 'no such shim' };
      if (!req.create && !(r.shims.get(req.artifactId)?.hosts ?? []).includes(host)) return { ok: false, error: 'invalid-target', detail: 'not on this host' };
      const missing = patternsOf(req, tab).filter((p) => !r.granted.has(p));
      return { ok: true, tab, subject: { agent: req.agent, intent: req.intent, shimId: req.create ? '' : req.artifactId, shimName: req.create?.name ?? 'Notes', scope: host, tabId: tab.tabId, url: tab.url, title: tab.title, missingOrigins: missing } };
    },
    async acquiredOrigins(req, tab) { return patternsOf(req, tab).filter((p) => r.granted.has(p) && p !== '*://site.test/*'); },
    async releaseOrigins(origins) { log.push(`release:${origins.join(',')}`); for (const o of origins) r.granted.delete(o); },
    async createShim(req, _tab, draftId) {
      if (req.create?.name === 'boom') return { ok: false, error: 'invalid-target', detail: 'cannot register' };
      const id = `new-${req.create?.name ?? ''}`;
      r.shims.set(id, { name: req.create?.name ?? '', hosts: ['site.test', 'other.test'] });
      log.push(`create:${id}:${draftId}`);
      return { ok: true, artifactId: id };
    },
    async discardShim(id) { log.push(`discard:${id}`); r.shims.delete(id); },
    async targetFor(tab, artifactId) {
      if (r.hostBusy.has(tab.tabId)) return { ok: false as const, error: 'artifact-busy', detail: 'a session already holds this tab' };
      const hid = `host-${++r.hostSeq}`;
      r.hostsOpen.add(hid);
      log.push(`targetFor:${hid}:${artifactId}`);
      return { ok: true as const, target: { tab: tab.tabId, artifactId, hid }, dispose: async () => { r.hostsOpen.delete(hid); log.push(`dispose:${hid}`); } };
    },
    async shimsOn(tab) {
      const host = new URL(tab.url).hostname;
      return [...r.shims].filter(([, v]) => v.hosts.includes(host)).map(([id, v]) => ({ id, name: v.name, enabled: true, connect: 'asks' as const }));
    },
    async openTab(url, signal) {
      log.push(`openTab:${url}`);
      if (signal.aborted) return { ok: false, error: 'page-load-failed', detail: 'aborted', tabId: 31 };
      if (url.includes('fail')) return { ok: false, error: 'page-load-failed', detail: 'net::ERR_FAILED', tabId: 31 };
      const landed = r.landAt || url;
      const tab: TabInfo = { tabId: 31, windowId: 1, url: landed, title: 'Opened', active: true };
      r.tabs.push(tab);
      return { ok: true, tab };
    },
    async closeTab(id) { log.push(`closeTab:${id}`); r.tabs = r.tabs.filter((t) => t.tabId !== id); },
    takeNotes: (id) => { const list = r.notes.get(id) ?? []; r.notes.delete(id); return list; },
    newDraftId: () => 'draft-1',
  };
  return r;
}

async function route(r: Rig, method: string, url: string, body?: unknown, signal: AbortSignal = new AbortController().signal) {
  const req: ControlRequest = { method, url, body, signal };
  return routeControlRequest(r.deps, req);
}
const attach = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: 'shim', artifactId: 'shim-1', target: { webContentsId: 7 }, agent: 'Claude Code', intent: 'x', ...over });

// Opens and answers the card in one go.
async function openAllowed(r: Rig, body: Record<string, unknown>, answer: 'allow-once' | 'allow-host' = 'allow-once') {
  const p = route(r, 'POST', '/sessions', body);
  await tick();
  const id = r.gate.pending()[0]?.id;
  if (id) r.gate.answer(id, answer);
  return p;
}

async function main(): Promise<void> {
  console.log('routes:');
  {
    const r = rig();
    const st = await route(r, 'GET', '/status');
    check('status carries the status it was given', st.status === 200 && st.body.ok === true && st.body.version === '0.7.0');
    const tabs = await route(r, 'GET', '/tabs');
    const w = (tabs.body.windows as Array<{ windowId: number; tabs: Array<Record<string, unknown>> }>)[0];
    check('tabs: per window, each tab with tabId and webContentsId alike, and the chrome host', tabs.status === 200 && tabs.body.host === 'chrome-extension' && w?.windowId === 1 && w.tabs[0]?.webContentsId === 7 && w.tabs[0].host === 'chrome-extension', JSON.stringify(tabs.body));
    check('an unknown route is not-found', (await route(r, 'GET', '/nope')).status === 404 && (await route(r, 'GET', '/sessions/x/y/z')).status === 404);
    check('a wrong method is method-not-allowed', (await route(r, 'POST', '/status')).status === 405 && (await route(r, 'GET', '/sessions')).status === 405);
    check('a malformed path is not-found', (await route(r, 'GET', 'status')).status === 404);
  }

  console.log('opening:');
  {
    const r = rig();
    check('a composition answers requires-shim-browser', (await route(r, 'POST', '/sessions', attach({ kind: 'composition' }))).body.error === 'requires-shim-browser');
    check('no artifact is invalid-request', (await route(r, 'POST', '/sessions', attach({ artifactId: undefined }))).status === 400);
    check('a target that is neither a tab nor a url is invalid-target', (await route(r, 'POST', '/sessions', attach({ target: { x: 1 } }))).body.error === 'invalid-target');
    check('an unknown tab is invalid-target', (await route(r, 'POST', '/sessions', attach({ target: { webContentsId: 99 } }))).body.error === 'invalid-target');
    check('an unknown shim is unknown-artifact, before any card', (await route(r, 'POST', '/sessions', attach({ artifactId: 'nope' }))).body.error === 'unknown-artifact' && r.gate.pending().length === 0);
    const opened = await openAllowed(r, attach());
    check('a valid open pends on the card and opens once allowed', opened.status === 200 && opened.body.sessionId === 's1' && opened.body.consent === 'asked' && opened.body.tabId === 7, JSON.stringify(opened.body));
    check('the registry got the scope and the artifact', r.log.includes('open:shim-1:existing:site.test:'));
    const remembered = await openAllowed(r, attach(), 'allow-host');
    const again = await route(r, 'POST', '/sessions', attach());
    check('allow host: the next open needs no card and says remembered', remembered.status === 200 && again.status === 200 && again.body.consent === 'remembered' && r.gate.pending().length === 0, JSON.stringify(again.body));
    const denied = route(r, 'POST', '/sessions', attach({ artifactId: 'shim-1', target: { webContentsId: 7 }, intent: 'deny me' }));
    await tick();
    // The host is remembered now, so this one needs a missing grant to show a card again.
    r.granted.delete('*://site.test/*');
    const d2 = route(r, 'POST', '/sessions', attach());
    await tick();
    const pendingId = r.gate.pending()[0]?.id ?? '';
    r.gate.answer(pendingId, 'deny');
    check('a denied card is consent-denied (403)', (await d2).status === 403 && (await d2).body.error === 'consent-denied');
    void denied;
    r.granted.add('*://site.test/*');
    r.gate.reset();
    const slow = route(r, 'POST', '/sessions', attach());
    await tick();
    r.timers.advance(2 * 60_000);
    check('an unanswered card times out as consent-timeout', (await slow).body.error === 'consent-timeout');
    const ac = new AbortController();
    const gone = route(r, 'POST', '/sessions', attach(), ac.signal);
    await tick();
    ac.abort();
    check('the client gone while the card waits is consent-cancelled', (await gone).body.error === 'consent-cancelled');
    // The shim runs on two hosts; the tab moves to the other one while the card waits.
    r.shims.set('shim-1', { name: 'Notes', hosts: ['site.test', 'elsewhere.test'] });
    r.granted.add('*://elsewhere.test/*');
    const moving = route(r, 'POST', '/sessions', attach());
    await tick();
    r.tabs[0] = { ...r.tabs[0] as TabInfo, url: 'https://elsewhere.test/' };
    r.gate.answer(r.gate.pending()[0]?.id ?? '', 'allow-once');
    const moved = await moving;
    check('a tab that left the host while the card waited is target-changed, nothing opened', moved.body.error === 'target-changed' && !r.log.some((l) => l.startsWith('open:') && l.includes('elsewhere.test')), JSON.stringify(moved.body));
    r.tabs[0] = { ...r.tabs[0] as TabInfo, url: 'https://site.test/page' };
    r.shims.set('shim-1', { name: 'Notes', hosts: ['site.test'] });
    r.busy.add('shim-1');
    const busy = await openAllowed(r, attach());
    check('a busy artifact is artifact-busy (409)', busy.status === 409 && busy.body.error === 'artifact-busy');
  }

  console.log('a new shim, and grants:');
  {
    const r = rig();
    const made = await openAllowed(r, attach({ artifactId: undefined, create: { name: 'Fresh' } }));
    check('a new shim is created after consent, as a draft, and the session opened as created', made.status === 200 && made.body.artifactId === 'new-Fresh' && r.log.includes('create:new-Fresh:draft-1') && r.log.includes('open:new-Fresh:created:site.test:'), r.log.join(' | '));
    r.busy.add('new-Busy');
    const failed = await openAllowed(r, attach({ artifactId: undefined, create: { name: 'Busy' } }));
    check('a new shim whose open fails is discarded', failed.body.error === 'artifact-busy' && r.log.includes('discard:new-Busy'));
    const boom = await openAllowed(r, attach({ artifactId: undefined, create: { name: 'boom' } }));
    check('a create that fails answers its error', boom.body.error === 'invalid-target');
    // A grant the card acquired (a shim's second host, granted by the
    // card's click) is released when the open fails, kept when it opens.
    r.shims.set('shim-2', { name: 'Two hosts', hosts: ['site.test', 'other.test'] });
    r.log.length = 0;
    r.busy.add('shim-2');
    const failing = route(r, 'POST', '/sessions', attach({ artifactId: 'shim-2' }));
    await tick();
    r.granted.add('*://other.test/*'); // what the card's allow acquired
    r.gate.answer(r.gate.pending()[0]?.id ?? '', 'allow-once');
    check('grants the card acquired are released on a failed open', (await failing).body.error === 'artifact-busy' && r.log.some((l) => l === 'release:*://other.test/*'), r.log.join(' | '));
    r.busy.delete('shim-2');
    r.log.length = 0;
    const opening = route(r, 'POST', '/sessions', attach({ artifactId: 'shim-2' }));
    await tick();
    r.granted.add('*://other.test/*');
    r.gate.answer(r.gate.pending()[0]?.id ?? '', 'allow-once');
    const kept = await opening;
    check('…and kept on success', kept.status === 200 && !r.log.some((l) => l.startsWith('release:')), r.log.join(' | '));
  }

  console.log('a url target:');
  {
    const r = rig();
    check('parseUrlTarget refuses credentials, other schemes and extra fields',
      !parseUrlTarget({ url: 'https://u:p@site.test/' }).ok && !parseUrlTarget({ url: 'ftp://site.test/' }).ok && !parseUrlTarget({ url: 'https://site.test/', x: 1 }).ok && parseUrlTarget({ url: 'https://site.test/a' }).ok);
    const opened = await openAllowed(r, attach({ target: { url: 'https://site.test/new' } }));
    check('a url opens a tab after the card and the session on it, with the approved origin', opened.status === 200 && opened.body.tabId === 31 && r.log.includes('openTab:https://site.test/new') && r.log.includes('open:shim-1:existing:site.test:https://site.test'), JSON.stringify(opened.body) + r.log.join(' | '));
    r.log.length = 0;
    r.landAt = 'https://login.site.test/';
    const landed = await openAllowed(r, attach({ target: { url: 'https://site.test/new' } }));
    check('a page that lands on another origin is target-changed and its tab closed', landed.body.error === 'target-changed' && r.log.includes('closeTab:31'), JSON.stringify(landed.body));
    r.landAt = '';
    const failed = await openAllowed(r, attach({ target: { url: 'https://site.test/fail' } }));
    check('a load that fails closes the tab and answers page-load-failed', failed.body.error === 'page-load-failed' && r.log.filter((l) => l === 'closeTab:31').length === 2);
    const bad = await route(r, 'POST', '/sessions', attach({ target: { url: 'nope' } }));
    check('a bad url is invalid-target before any card', bad.body.error === 'invalid-target' && r.gate.pending().length === 0);
    // The card for a url is never remembered: allow host behaves as allow once.
    const first = await openAllowed(r, attach({ target: { url: 'https://site.test/one' } }), 'allow-host');
    const second = route(r, 'POST', '/sessions', attach({ target: { url: 'https://site.test/two' } }));
    await tick();
    check('a url is asked every time', first.status === 200 && r.gate.pending().length === 1);
    r.gate.answer(r.gate.pending()[0]?.id ?? '', 'deny');
    await second;
  }

  console.log('the host and the tab listing:');
  {
    const r = rig();
    // A busy artifact (lease held before begin): the host targetFor opened is disposed, none left.
    r.busy.add('shim-1');
    const busy = await openAllowed(r, attach());
    check('a busy open disposes the host targetFor attached', busy.body.error === 'artifact-busy' && r.hostsOpen.size === 0 && r.log.some((l) => l.startsWith('dispose:')), r.log.join(' | '));
    // targetFor refusing (a tab already held) leaves nothing and is answered.
    r.busy.delete('shim-1');
    r.hostBusy.add(7);
    const held = await openAllowed(r, attach());
    check('targetFor refusing a held tab is artifact-busy, nothing opened', held.body.error === 'artifact-busy' && r.hostsOpen.size === 0);
    r.hostBusy.delete(7);
    // The tab listing carries the matching installed shims.
    r.shims.set('shim-1', { name: 'Notes', hosts: ['site.test'] });
    const tabs = await route(r, 'GET', '/tabs');
    const t = (tabs.body.windows as Array<{ tabs: Array<{ shims: Array<{ id: string; name: string }> }> }>)[0]?.tabs[0];
    check('each tab lists the shims on its host, with ids', Array.isArray(t?.shims) && t?.shims.some((x) => x.id === 'shim-1' && x.name === 'Notes'), JSON.stringify(t?.shims));
  }

  console.log('session routes:');
  {
    const r = rig();
    const opened = await openAllowed(r, attach());
    const id = String(opened.body.sessionId);
    check('checkout', (await route(r, 'GET', `/sessions/${id}/checkout`)).body.revision === 0 && r.log.includes(`checkout:${id}`));
    check('preview needs a body', (await route(r, 'POST', `/sessions/${id}/preview`)).status === 400);
    check('preview forwards the body', (await route(r, 'POST', `/sessions/${id}/preview`, { workingCopy: 1 })).body.revision === 1 && r.log.includes(`preview:${id}:{"workingCopy":1}`));
    check('call needs a name', (await route(r, 'POST', `/sessions/${id}/call`, {})).status === 400);
    check('call forwards name and input', (await route(r, 'POST', `/sessions/${id}/call`, { name: 'view_page', input: { selector: '#x' } })).body.result === 'view_page ran');
    check('commit checks its fields', (await route(r, 'POST', `/sessions/${id}/commit`, { revision: 'x' })).status === 400 && (await route(r, 'POST', `/sessions/${id}/commit`, { revision: 1, commitId: '', summary: '' })).status === 400);
    check('commit forwards', (await route(r, 'POST', `/sessions/${id}/commit`, { revision: 1, commitId: 'c', summary: 's' })).body.versionId === 2);
    check('cards is always empty', JSON.stringify((await route(r, 'GET', `/sessions/${id}/cards`)).body.cards) === '[]');
    r.notes.set(id, ['version 2 is live on the page']);
    const withNotes = await route(r, 'POST', `/sessions/${id}/call`, { name: 'read_console' });
    check('pending notes ride the next answer, once', JSON.stringify(withNotes.body.notes) === '["version 2 is live on the page"]' && (await route(r, 'POST', `/sessions/${id}/call`, { name: 'read_console' })).body.notes === undefined);
    check('end', (await route(r, 'DELETE', `/sessions/${id}`)).body.reason === 'ended' && r.log.includes(`end:${id}`));
    check('a bad session id is unknown-session', (await route(r, 'GET', '/sessions/bad id/checkout')).status === 404);
  }

  if (failures) {
    console.error(`\ncontrol: ${failures} failed, ${passes} passed`);
    process.exit(1);
  }
  console.log(`control: all ${passes} checks passed`);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
