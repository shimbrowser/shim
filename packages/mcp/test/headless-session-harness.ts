// Harness for headless sessions (packages/mcp/src/headless-control.ts,
// headless-session.ts, file-storage.ts) over a scripted fake PageHost — no browser. Covers:
//
//   - the file-backed api.storage: the browser's semantics per shim and
//     origin, persistence across instances, atomic writes, own-property keys,
//     a foreign file never overwritten;
//   - the CLI's mode switch;
//   - opening: the routes that answer requires-shim-browser (tabs,
//     compositions, the shim library), url / shimFile validation, a .shim
//     declaring an unsupported feature refused before any page opens, a page
//     that fails to open, one session per .shim file;
//   - begin applies the committed shim (handlers inlined; behind the deploy
//     baseline while a rule's anchor is the committed one, witness or not,
//     with the spec's autoRepair: false) and settles before it answers;
//   - preview: preflight is atomic (nothing applied, no revision), lint
//     refuses, the evidence shape (rules with status + verification, errors,
//     noMatch, console, changes), `partial` for an unsupported-api use and
//     for a component-identity witness, the source-scan warning, witnesses
//     captured but never in the evidence or the checkout;
//   - the page-away guard (the start host on its start port, plus the
//     shim's declared hosts), a stored handler named after an
//     Object.prototype property still inlined,
//     and reload_page returning to the start URL, re-applying every live
//     preview before it settles, and re-applying nothing when the load did
//     not finish;
//   - a second open on a file claimed before the file is read (no stale
//     source when the holder commits and ends while its page loads);
//   - the cross-process file lock (file-lock.ts): another shim-mcp process
//     is busy before any page opens, ending or a failed open drops the lock,
//     a dead process's lock (or a file that isn't one) is taken over, one
//     from another machine never is, and a takeover only removes the lock it
//     judged stale (under the takeover mutex, itself recovered from a dead
//     holder);
//   - a .shim whose match.hosts isn't a list of strings refused at open;
//   - a captured witness carried by every replay of its rule (reload_page,
//     a followed navigation), so the replay can't attach to another match;
//   - witnesses taken whenever the engine reports them (during begin, after
//     a preview answered) and kept through replay and commit, but never
//     from a replaced version of a rule (applyId) or a key no longer live;
//   - a deploy recovery the engine reported but nothing applied keeps the
//     committed baseline on commit (and says so), so a reopened shim still
//     sees the deploy; updating the anchor lets the baseline advance;
//   - a reload (in place, or back to the start URL) that lands off the
//     site answers page-away, applying nothing there;
//   - a commit after a navigation the rules never ran on keeps the
//     committed baseline and says so; a preview there lets it advance;
//   - a page that leaves the site during the replay wait: the preview and
//     the page tools refuse with page-away, changing nothing;
//   - a quarantined rule keeps the committed baseline on commit (and says
//     so) until it resolves through its primary again;
//   - shutdown (closeAll) refuses new opens and settles one in flight — a
//     page still launching, a begin still settling — leaving no session,
//     page or lock;
//   - file storage: a failed write rejects and changes nothing, in memory
//     or in the next write;
//   - a .shim with a spec-level css block refused at open (D15: headless
//     installs no whole-patch stylesheet);
//   - commit: the .shim written once per commitId, version + deploy baseline +
//     witnesses + history, the session continuing from it;
//   - ending tears every preview down, closes the page and frees the file.
//
// The real-browser version of the loop is headless-session-e2e-harness.ts
// (its own CI job, with playwright-conformance).
//
//   node out/packages/mcp/test/headless-session-harness.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  PageHost, PreviewRule, PageRuntimeEvent, PageConsoleMessage, PageLoadOutcome, LoadWaitOptions,
} from '@shimbrowser/core/page-host';
import { decodeWorkingCopy, encodeWorkingCopy } from '@shimbrowser/core/working-copy-wire';
import { unpackShim, anchorDigest, SHIM_STATE_FILE, type FolderInput, type ShimState } from '@shimbrowser/core/shim-folder';
import { fileStorage, HEADLESS_STORAGE_FORMAT } from '../src/file-storage';
import { createHeadlessControl, hostPatternMatches, MAX_COMMIT_ID_LENGTH, MAX_SUMMARY_LENGTH, type HeadlessControl } from '../src/headless-control';
import { HEADLESS_CAPABILITIES, type HeadlessStorage } from '../src/playwright-page-host';
import { cliMode } from '../src/cli';
import { lockFileFor, tryLockFile, type FileLockOptions } from '../src/file-lock';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    const d = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail);
    console.error(`  ✗ ${label}${d ? ` — ${d}` : ''}`);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-headless-'));

// --- a scripted PageHost -------------------------------------------------------

interface FakeHost extends PageHost {
  applied: PreviewRule[];
  removed: string[];
  reloads: Array<string | undefined>;
  loadWaits: LoadWaitOptions[];
  loadOutcome: PageLoadOutcome;
  closed: boolean;
  setUrl(url: string): void;
  // A full-document navigation: a new document, so a fresh engine world.
  navigate(url: string): void;
  emit(event: PageRuntimeEvent): void;
  log(message: PageConsoleMessage): void;
  // Runs on every applyPreview: what the "engine" reports for it.
  onApply: (p: PreviewRule, host: FakeHost) => void;
}

function fakeHost(startUrl: string): FakeHost {
  const runtime = new Set<(e: PageRuntimeEvent) => void>();
  const consoleL = new Set<(m: PageConsoleMessage) => void>();
  let url = startUrl;
  // The engine world's globals: one set per document.
  let world: Record<string, unknown> = {};
  const host: FakeHost = {
    capabilities: HEADLESS_CAPABILITIES,
    applied: [],
    removed: [],
    reloads: [],
    loadWaits: [],
    loadOutcome: { kind: 'finished' },
    closed: false,
    onApply: (p, h) => {
      h.emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: 1, matchedVia: 'primary', box: { x: 0, y: 0, w: 10, h: 20 } });
      if (!p.rule.anchor?.witness) h.emit({ kind: 'rule-witness', specId: p.ruleKey, ruleId: p.rule.id, witness: { v: 1, tag: 'div' } });
    },
    url: () => url,
    isClosed: () => host.closed,
    setUrl(next) { url = next; },
    navigate(next) { url = next; world = {}; },
    emit(e) { for (const l of [...runtime]) l(e); },
    log(m) { for (const l of [...consoleL]) l(m); },
    async evaluate(code) {
      if (code.includes('deployIdForDocument')) return 'deploy-2';
      const write = /^globalThis\["(\w+)"\] = (".*")$/.exec(code);
      if (write?.[1] && write[2]) { world[write[1]] = JSON.parse(write[2]) as unknown; return world[write[1]]; }
      const read = /^globalThis\["(\w+)"\] \?\? null$/.exec(code);
      if (read?.[1]) return world[read[1]] ?? null;
      return null;
    },
    async screenshot() { return { error: 'the fake host takes no screenshots' }; },
    applyPreview(p) { host.applied.push(p); host.onApply(p, host); },
    removePreview(key) { host.removed.push(key); },
    onRuntimeEvent(l) { runtime.add(l); return () => { runtime.delete(l); }; },
    onConsole(l) { consoleL.add(l); return () => { consoleL.delete(l); }; },
    reload(u) { host.reloads.push(u); if (u) url = u; world = {}; },
    async waitForLoad(o): Promise<PageLoadOutcome> { host.loadWaits.push(o); return host.loadOutcome; },
    async documentToken() { return null; },
  };
  return host;
}

interface Rig {
  control: HeadlessControl;
  hosts: FakeHost[];
  storages: HeadlessStorage[];
  writes: string[];
  failOpen: boolean;
  // When set, opening a page waits for it (a slow page load).
  gate: Promise<void> | null;
  // How many previews every host had applied at each settle.
  appliedAtSettle: number[];
  // Where opening a url lands (a redirect); the url itself by default.
  redirect: (url: string) => string;
  // When set, every settle waits for it (a begin still settling).
  settleGate: Promise<void> | null;
  // When set, runs during the next settle's wait, then clears (the page doing something meanwhile).
  duringSettle: (() => void) | null;
}

function rig(fileLock?: FileLockOptions): Rig {
  const r: Rig = {
    control: null as unknown as HeadlessControl, hosts: [], storages: [], writes: [], failOpen: false, gate: null, appliedAtSettle: [], redirect: (u) => u, settleGate: null, duringSettle: null,
  };
  let ids = 0;
  r.control = createHeadlessControl({
    version: 'test',
    newShimId: () => `shim-new-${++ids}`,
    newId: () => `sess${++ids}`,
    ...(fileLock ? { fileLock } : {}),
    async openPage(url, storage) {
      if (r.failOpen) throw new Error('net::ERR_CONNECTION_REFUSED');
      if (r.gate) await r.gate;
      const host = fakeHost(r.redirect(url));
      r.hosts.push(host);
      r.storages.push(storage);
      return { host, close: async () => { host.closed = true; } };
    },
    backend: {
      settleMs: 5,
      sleep: async () => {
        r.appliedAtSettle.push(r.hosts.reduce((n, h) => n + h.applied.length, 0));
        if (r.settleGate) await r.settleGate;
        const during = r.duringSettle;
        r.duringSettle = null;
        during?.();
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      },
      writeShimFile: (file, content) => {
        r.writes.push(file);
        fs.writeFileSync(file, content);
      },
    },
  });
  return r;
}

async function req(r: Rig, method: string, p: string, body?: unknown): Promise<Record<string, unknown>> {
  return (await r.control.request(method, p, body)).body;
}

function folderOf(files: Record<string, string>): FolderInput {
  return { ...files };
}

async function preview(r: Rig, id: string, files: Record<string, string>): Promise<Record<string, unknown>> {
  return req(r, 'POST', `/sessions/${id}/preview`, { workingCopy: encodeWorkingCopy(folderOf(files)) });
}

const css = (value: string): { primary: { kind: 'css'; value: string } } => ({ primary: { kind: 'css', value } });
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

async function main(): Promise<void> {
  console.log('file storage');
  {
    const file = path.join(tmp, 'store', 'data.json');
    const a = fileStorage(file);
    const scope = { patchId: 'p', origin: 'https://a.test' };
    check('a missing key reads null', (await a.get(scope, 'k')) === null);
    check('set answers the value', JSON.stringify(await a.set(scope, 'k', { n: 1 })) === '{"n":1}');
    check('the value reads back', JSON.stringify(await a.get(scope, 'k')) === '{"n":1}');
    await a.set(scope, 'u', undefined);
    check('undefined stores as null, like the browser', (await a.get(scope, 'u')) === null && 'u' in (await a.list(scope)));
    await a.set(scope, '__proto__', 7);
    check('"__proto__" is a plain key', (await a.get(scope, '__proto__')) === 7 && Object.getPrototypeOf(await a.list(scope)) === Object.prototype);
    const listed = await a.list(scope);
    check('…and list answers it as an own key', Object.prototype.hasOwnProperty.call(listed, '__proto__')
      && JSON.stringify(listed).includes('"__proto__":7'), JSON.stringify(listed));
    check('buckets are per shim and per origin', (await a.get({ patchId: 'q', origin: scope.origin }, 'k')) === null
      && (await a.get({ patchId: 'p', origin: 'https://b.test' }, 'k')) === null);
    check('delete answers whether a key went away', (await a.delete(scope, 'k')) === true && (await a.delete(scope, 'k')) === false);
    const b = fileStorage(file);
    check('a second instance reads the same file', (await b.get(scope, '__proto__')) === 7);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    check('the file is the documented format', onDisk.format === HEADLESS_STORAGE_FORMAT);
    check('no temp files are left behind', fs.readdirSync(path.dirname(file)).length === 1, fs.readdirSync(path.dirname(file)));
    const foreign = path.join(tmp, 'foreign.json');
    fs.writeFileSync(foreign, '{"not":"ours"}');
    const c = fileStorage(foreign);
    let rejected = false;
    try { await c.set(scope, 'k', 1); } catch { rejected = true; }
    check('a file that is not ours is refused, never overwritten', rejected && fs.readFileSync(foreign, 'utf8') === '{"not":"ours"}');
  }

  console.log('file storage: a failed write changes nothing');
  {
    const dir = path.join(tmp, 'store-fail');
    const file = path.join(dir, 'data.json');
    let fail = false;
    const st = fileStorage(file, {
      writeFile: (tmpFile, text) => {
        if (fail) throw new Error('ENOSPC: disk full');
        fs.writeFileSync(tmpFile, text);
      },
    });
    const scope = { patchId: 'p', origin: 'https://a.test' };
    await st.set(scope, 'kept', 1);
    fail = true;
    const outcome = async (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: unknown) => (e instanceof Error ? e.message : String(e)));
    check('a set whose write fails rejects', (await outcome(st.set(scope, 'lost', 2))).includes('disk full'));
    check('…and reads never see it', (await st.get(scope, 'lost')) === null && JSON.stringify(await st.list(scope)) === JSON.stringify({ kept: 1 }));
    check('a delete whose write fails rejects', (await outcome(st.delete(scope, 'kept'))).includes('disk full'));
    check('…and the key reads as before', (await st.get(scope, 'kept')) === 1);
    check('a set into a new bucket whose write fails leaves no bucket behind', (await outcome(st.set({ patchId: 'q', origin: 'https://b.test' }, 'k', 1))).includes('disk full')
      && JSON.stringify(await st.list({ patchId: 'q', origin: 'https://b.test' })) === '{}');
    check('…and no temp file is left behind', fs.readdirSync(dir).every((f) => !f.endsWith('.tmp')), fs.readdirSync(dir));
    fail = false;
    await st.set(scope, 'next', 3);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as { buckets: Record<string, Record<string, Record<string, unknown>>> };
    check('the next successful write persists none of the failed changes', JSON.stringify(onDisk.buckets) === JSON.stringify({ 'https://a.test': { p: { kept: 1, next: 3 } } }), onDisk.buckets);
  }

  console.log('cli mode');
  {
    check('auto by default (what the plugin runs)', cliMode([], {}).mode === 'auto' && cliMode([], { SHIM_MCP_MODE: 'auto' }).mode === 'auto');
    check('--attach', cliMode(['--attach'], {}).mode === 'attach' && cliMode([], { SHIM_MCP_MODE: 'attach' }).mode === 'attach');
    check('--headless', cliMode(['--headless'], {}).mode === 'headless' && !cliMode(['--headless'], {}).visible);
    check('SHIM_MCP_MODE=headless and --visible', cliMode(['--visible'], { SHIM_MCP_MODE: 'headless' }).mode === 'headless' && cliMode(['--visible'], {}).visible);
    check('a flag beats the environment', cliMode(['--attach'], { SHIM_MCP_MODE: 'headless' }).mode === 'attach');
    let both = '';
    try { cliMode(['--attach', '--headless'], {}); } catch (e) { both = e instanceof Error ? e.message : String(e); }
    check('--attach with --headless is an error', /exclusive/.test(both), both);
    let bad = '';
    try { cliMode([], { SHIM_MCP_MODE: 'cloud' }); } catch (e) { bad = e instanceof Error ? e.message : String(e); }
    check('an unknown SHIM_MCP_MODE is an error, never a silent default', /auto, attach or headless/.test(bad), bad);
  }

  console.log('opening');
  const url = 'https://site.test/tracks';
  {
    const r = rig();
    const status = await req(r, 'GET', '/status');
    check('status reports headless mode', status.ok === true && status.mode === 'headless' && Array.isArray(status.sessions));
    const tabs = await req(r, 'GET', '/tabs');
    check('tabs answer requires-shim-browser', tabs.error === 'requires-shim-browser');
    const comp = await req(r, 'POST', '/sessions', { kind: 'composition', target: { url }, agent: 'a', intent: 'x', artifactId: 'c' });
    check('a composition answers requires-shim-browser', comp.error === 'requires-shim-browser');
    const lib = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', artifactId: 'shim-1' });
    check('a library shim id answers requires-shim-browser', lib.error === 'requires-shim-browser');
    const noUrl = await req(r, 'POST', '/sessions', { kind: 'shim', target: {}, agent: 'a', intent: 'x', shimFile: path.join(tmp, 'x.shim') });
    check('no url is invalid', noUrl.error === 'invalid-request');
    const fileUrl = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url: 'file:///etc/passwd' }, agent: 'a', intent: 'x', shimFile: path.join(tmp, 'x.shim') });
    check('a non-http url is invalid', fileUrl.error === 'invalid-request');
    const noFile = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x' });
    check('no shimFile is invalid', noFile.error === 'invalid-request');
    const missing = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile: path.join(tmp, 'nope.shim') });
    check('a missing file without newShimName is invalid', missing.error === 'invalid-request' && String(missing.detail).includes('newShimName'));

    const badFile = path.join(tmp, 'bad.shim');
    fs.writeFileSync(badFile, json({
      format: 'shim/1', name: 'Bad', handlers: {},
      spec: { id: 'shim-bad', match: { hosts: ['site.test'] }, rules: [{ id: 'r', anchor: css('body'), mutations: [{ kind: 'mount-route', path: '/x' }] }], permissions: ['ai'] },
    }));
    const unsupported = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile: badFile });
    check('a .shim declaring unsupported features is refused with the list', unsupported.error === 'unsupported'
      && Array.isArray(unsupported.unsupported) && unsupported.unsupported.length === 2, unsupported);
    check('…before any page opened', r.hosts.length === 0);
    const exists = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile: badFile, create: { name: 'n' } });
    check('newShimName on an existing file is invalid', exists.error === 'invalid-request');
    r.failOpen = true;
    const failed = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile: path.join(tmp, 'new.shim'), create: { name: 'n' } });
    check('a page that fails to open is reported', failed.error === 'page-open-failed' && String(failed.detail).includes('REFUSED'), failed);
  }

  console.log('a session on a committed .shim');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'tracks.shim');
    fs.writeFileSync(shimFile, json({
      format: 'shim/1',
      name: 'Tracks',
      spec: {
        id: 'shim-tracks', version: 4, bundleHash: 'deploy-1', match: { hosts: ['site.test'] },
        rules: [
          { id: 'hide-promo', anchor: { ...css('.promo'), witness: { v: 1, tag: 'div', textStem: 'buy' } }, mutations: [{ kind: 'hide' }] },
          { id: 'row', anchor: { ...css('.row'), witness: { v: 1, tag: 'li', component: { name: 'TrackRow' } } }, mutations: [{ kind: 'restyle', css: { color: 'red' } }] },
          { id: 'mark', anchor: css('.track'), mutations: [{ kind: 'script', handler: 'mark' }] },
        ],
      },
      handlers: { mark: 'module.exports = function mark({ anchor }) { anchor.dataset.m = "1"; };\n' },
      authoringHistory: [{ role: 'user', content: 'earlier' }],
    }));
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'Claude Code', intent: 'Tidy up', shimFile });
    check('the session opens', opened.ok === true && opened.artifactId === 'shim-tracks' && opened.shimFile === shimFile, opened);
    const id = String(opened.sessionId);
    const host = r.hosts[0] as FakeHost;
    check('every committed rule runs as a preview', host.applied.map((p) => p.ruleKey).join() === 'preview:shim-tracks:hide-promo,preview:shim-tracks:row,preview:shim-tracks:mark');
    check('every committed rule runs behind the deploy baseline, witness or not',
      host.applied.every((p) => p.bundleHash === 'deploy-1'), host.applied.map((p) => p.bundleHash));
    check('a spec that never set autoRepair sends none', host.applied.every((p) => p.autoRepair === undefined));
    check('opening settles after applying the committed rules, so the first view sees them', r.appliedAtSettle[0] === 3, r.appliedAtSettle);
    check('stored handler modules are inlined for the page', typeof host.applied[2]?.rule.handlers?.mark === 'string' && !host.applied[2].rule.handlers.mark.startsWith('module.exports'));
    const busy = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'x', intent: 'x', shimFile });
    check('a second session on the same file is busy, before any page opens', busy.error === 'artifact-busy' && r.hosts.length === 1, busy);

    const co = await req(r, 'GET', `/sessions/${id}/checkout`);
    const files = decodeWorkingCopy(co.files);
    const text = (k: string): string => {
      const v = files[k];
      return typeof v === 'string' ? v : new TextDecoder().decode(v);
    };
    const shimJson = text('shim.json');
    check('checkout is revision 0 with no witness, version or bundleHash', co.revision === 0 && !shimJson.includes('witness') && !shimJson.includes('bundleHash') && !shimJson.includes('"version"'));
    const spec = JSON.parse(shimJson) as Record<string, unknown> & { rules: Array<Record<string, unknown>> };
    const working: Record<string, string> = { 'shim.json': shimJson, 'handlers/mark.js': text('handlers/mark.js') };

    // Preflight: atomic.
    const before = host.applied.length;
    const p0 = await preview(r, id, { ...working, 'shim.json': json({ ...spec, rules: [...spec.rules, { id: 'x', anchor: { ...css('.y'), iframe: { kind: 'css', value: 'iframe' } }, mutations: [{ kind: 'hide' }] }] }) });
    const ev0 = isRecord(p0.evidence) ? p0.evidence : {};
    check('an iframe rule is unsupported: nothing applied, no revision', p0.applied === false && p0.revision === 0 && ev0.error === 'unsupported'
      && host.applied.length === before && host.removed.length === 0, p0);
    const pl = await preview(r, id, { ...working, 'shim.json': json({ ...spec, rules: [...spec.rules, { id: 'bad', anchor: css('.z'), mutations: [{ kind: 'sparkle' }] }] }) });
    check('a lint error is rejected, nothing applied', pl.applied === false && isRecord(pl.evidence) && typeof pl.evidence.rejected === 'string' && host.applied.length === before, pl);
    const same = await preview(r, id, working);
    check('an unchanged folder applies nothing', same.applied === false && isRecord(same.evidence) && same.evidence.unchanged === true);

    // An applied preview: change two rules, add one that uses an unsupported member.
    host.onApply = (p, h) => {
      h.emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: p.rule.id === 'gone' ? 0 : 1, box: { x: 1, y: 2, w: 3, h: 4 } });
      // No rule-no-match for 'gone': the engine's timer can fire past the
      // settle window (a background page), so the evidence reads the status.
      if (p.rule.id === 'fetcher') {
        h.emit({ kind: 'unsupported-api', specId: p.ruleKey, member: 'fetch', path: '/tracks' });
        h.emit({ kind: 'handler-error', specId: p.ruleKey, ruleId: p.rule.id, handlerName: 'fetcher', message: 'boom', stack: 'Error: boom\n    at shim://patches/x/handlers/fetcher.js:1:1' });
      }
      // The engine fingerprints a rule that resolved exactly one element.
      if (!p.rule.anchor?.witness && p.rule.id !== 'gone') h.emit({ kind: 'rule-witness', specId: p.ruleKey, ruleId: p.rule.id, witness: { v: 1, tag: 'span', textStem: 'new' } });
    };
    host.log({ level: 'error', message: 'TypeError: x is undefined', source: 'https://site.test/app.js' });
    const rules = spec.rules.map((rule) => (rule.id === 'row' ? { ...rule, mutations: [{ kind: 'restyle', css: { color: 'blue' } }] } : rule));
    const next = {
      ...working,
      'shim.json': json({ ...spec, rules: [...rules, { id: 'gone', anchor: css('.gone'), mutations: [{ kind: 'hide' }] }, { id: 'fetcher', anchor: css('.list'), mutations: [{ kind: 'script', handler: 'fetcher' }] }] }),
      'handlers/fetcher.js': 'module.exports = async function fetcher({ api }) { await api.fetch("https://x.test"); };\n',
    };
    const p1 = await preview(r, id, next);
    const ev = isRecord(p1.evidence) ? p1.evidence : {};
    const byId = new Map((Array.isArray(ev.rules) ? ev.rules.filter(isRecord) : []).map((x) => [x.ruleId, x]));
    check('the preview applies as revision 1', p1.applied === true && p1.revision === 1, p1);
    check('changed and new rules are reported, unchanged ones are not', [...byId.keys()].join() === 'row,gone,fetcher', [...byId.keys()]);
    check('status lines read like the browser\'s', byId.get('row')?.status === 'matched 1 element(s) via primary — anchor box 3×4px at (1, 2)'
      && byId.get('gone')?.status === 'matched 0 elements — the anchor does not resolve on this page', byId.get('row'));
    check('a component-identity witness headless can\'t check is partial', byId.get('row')?.verification === 'partial');
    check('a rule that used an unsupported member is partial', byId.get('fetcher')?.verification === 'partial');
    check('a rule that matched nothing is none, not full', byId.get('gone')?.verification === 'none');
    check('the re-applied rule kept its committed deploy baseline', host.applied.find((p) => p.ruleKey.endsWith(':row') && host.applied.indexOf(p) >= before)?.bundleHash === 'deploy-1');
    check('a new rule runs behind none', host.applied.filter((p) => (p.rule.id === 'gone' || p.rule.id === 'fetcher')).every((p) => p.bundleHash === undefined));
    check('handler errors carry rule, handler, message, stack', JSON.stringify(ev.errors).includes('"handler":"fetcher"') && JSON.stringify(ev.errors).includes('boom'));
    check('no-match is reported from the status, with no engine event', JSON.stringify(ev.noMatch) === JSON.stringify([{ ruleId: 'gone', selector: '.gone' }]), ev.noMatch);
    check('unsupported uses are listed with a note', JSON.stringify(ev.unsupportedApi) === JSON.stringify([{ ruleId: 'fetcher', member: 'fetch' }])
      && Array.isArray(ev.notes) && String(ev.notes[0]).includes('api.fetch'), ev);
    check('the source scan warns about the handler', Array.isArray(ev.warnings) && ev.warnings.some((w) => String(w).includes('handler "fetcher" mentions api.fetch')), ev.warnings);
    check('the console since the last preview rides along', typeof ev.console === 'string' && ev.console.includes('[site] error: TypeError'));
    check('the changes are listed', JSON.stringify(ev.changes) === JSON.stringify(['update-rule row', 'add-rule gone', 'add-rule fetcher']), ev.changes);
    check('no witness reaches the evidence', !JSON.stringify(p1).includes('witness') && !JSON.stringify(p1).includes('textStem'));
    const co2 = decodeWorkingCopy((await req(r, 'GET', `/sessions/${id}/checkout`)).files);
    const co2Spec = co2['shim.json'];
    check('the checkout follows the working state, still witness-free', co2.revision === undefined && typeof co2Spec !== 'undefined'
      && new TextDecoder().decode(typeof co2Spec === 'string' ? new TextEncoder().encode(co2Spec) : co2Spec).includes('"fetcher"')
      && !new TextDecoder().decode(typeof co2Spec === 'string' ? new TextEncoder().encode(co2Spec) : co2Spec).includes('witness'));

    // Page tools.
    const browserOnly = await req(r, 'POST', `/sessions/${id}/call`, { name: 'verify_across_pages', input: {} });
    check('verify_across_pages answers requires-shim-browser', browserOnly.error === 'requires-shim-browser');
    for (const name of ['search_discovered_api', 'request_sources', 'probe_request', 'read_calls', 'inspect_storage', 'query_db', 'read_sibling_shim']) {
      const refused = await req(r, 'POST', `/sessions/${id}/call`, { name, input: {} });
      check(`${name} answers requires-shim-browser (no API map, no compositions, no saved data)`, refused.error === 'requires-shim-browser', refused);
    }
    const consoleRead = await req(r, 'POST', `/sessions/${id}/call`, { name: 'read_console', input: { level: 'error' } });
    check('read_console reads the session\'s buffer', typeof consoleRead.result === 'string' && consoleRead.result.includes('TypeError'));
    host.setUrl('https://elsewhere.test/');
    const away = await req(r, 'POST', `/sessions/${id}/call`, { name: 'view_page', input: {} });
    check('a page tool refuses once the page left the site', typeof away.result === 'string' && away.result.includes('page-away'));
    const awayPreview = await preview(r, id, { ...next, 'shim.json': json({ ...JSON.parse(next['shim.json'] ?? '{}') as object, intent: 'x' }) });
    check('a preview refuses too, applying nothing', awayPreview.applied === false && isRecord(awayPreview.evidence) && awayPreview.evidence.error === 'page-away');
    const liveBefore = host.applied.length;
    const settlesBefore = r.appliedAtSettle.length;
    const reload = await req(r, 'POST', `/sessions/${id}/call`, { name: 'reload_page', input: {} });
    const reloaded = typeof reload.result === 'string' ? JSON.parse(reload.result) as Record<string, unknown> : {};
    check('reload_page goes back to the start URL, never elsewhere', host.reloads[host.reloads.length - 1] === url && reloaded.ok === true, reloaded);
    check('…and re-applies every live preview', reloaded.reapplied === 5 && host.applied.length === liveBefore + 5, reloaded);
    check('…before it settles, so the reply never races the previews', r.appliedAtSettle.length === settlesBefore + 1
      && r.appliedAtSettle[settlesBefore] === liveBefore + 5, r.appliedAtSettle);
    check('…waiting on the main frame\'s load only (a broken iframe doesn\'t end the wait)', host.loadWaits[host.loadWaits.length - 1]?.failures === 'main-frame');
    host.loadOutcome = { kind: 'failed', code: -105, description: 'net::ERR_NAME_NOT_RESOLVED' };
    const failedAt = host.applied.length;
    const failedReload = await req(r, 'POST', `/sessions/${id}/call`, { name: 'reload_page', input: {} });
    const failedOut = typeof failedReload.result === 'string' ? JSON.parse(failedReload.result) as Record<string, unknown> : {};
    check('a reload that did not finish is an error, re-applying nothing', failedOut.ok === undefined
      && String(failedOut.error).includes('ERR_NAME_NOT_RESOLVED') && host.applied.length === failedAt, failedOut);
    host.loadOutcome = { kind: 'finished' };
    // Bring the page back to a finished document with every preview on it.
    await req(r, 'POST', `/sessions/${id}/call`, { name: 'reload_page', input: {} });

    // The page navigates itself (a link, a form) to a new document on the site.
    host.navigate(url);
    const navAt = host.applied.length;
    await req(r, 'POST', `/sessions/${id}/call`, { name: 'view_page', input: {} });
    check('a full navigation on the site re-applies every live preview before a page tool runs', host.applied.length === navAt + 5, host.applied.length - navAt);
    await req(r, 'POST', `/sessions/${id}/call`, { name: 'view_page', input: {} });
    check('…once: the same document is not re-applied again', host.applied.length === navAt + 5, host.applied.length - navAt);

    // Commit.
    host.setUrl('https://elsewhere.test/');
    const awayCommit = await req(r, 'POST', `/sessions/${id}/commit`, { revision: 1, commitId: 'one', summary: 'Restyled rows; added two rules.' });
    check('a commit refuses once the page left the site, writing nothing', awayCommit.error === 'page-away' && r.writes.length === 0, awayCommit);
    host.setUrl(url);
    const longId = await req(r, 'POST', `/sessions/${id}/commit`, { revision: 1, commitId: 'x'.repeat(MAX_COMMIT_ID_LENGTH + 1), summary: 's' });
    const longSummary = await req(r, 'POST', `/sessions/${id}/commit`, { revision: 1, commitId: 'long', summary: 'x'.repeat(MAX_SUMMARY_LENGTH + 1) });
    check('an oversized commitId or summary is refused before the registry, writing nothing', longId.error === 'invalid-request'
      && longSummary.error === 'invalid-request' && r.writes.length === 0, { longId, longSummary });
    const c1 = await req(r, 'POST', `/sessions/${id}/commit`, { revision: 1, commitId: 'one', summary: 'Restyled rows; added two rules.' });
    check('the commit answers the new version', c1.ok === true && c1.versionId === 5 && c1.revision === 1, c1);
    const again = await req(r, 'POST', `/sessions/${id}/commit`, { revision: 1, commitId: 'one', summary: 'Restyled rows; added two rules.' });
    check('a retry with the same commitId is answered from the record, not rewritten', again.ok === true && again.versionId === 5 && r.writes.length === 1);
    const stale = await req(r, 'POST', `/sessions/${id}/commit`, { revision: 0, commitId: 'two', summary: 's' });
    check('an old revision is stale', stale.error === 'stale-revision');
    const file = JSON.parse(fs.readFileSync(shimFile, 'utf8')) as Record<string, unknown>;
    const fspec = isRecord(file.spec) ? file.spec : {};
    const frules = Array.isArray(fspec.rules) ? fspec.rules.filter(isRecord) : [];
    const witnessOf = (rid: string): unknown => {
      const rule = frules.find((x) => x.id === rid);
      return isRecord(rule) && isRecord(rule.anchor) ? rule.anchor.witness : undefined;
    };
    check('the file carries the new version and the page\'s deploy id', fspec.version === 5 && fspec.bundleHash === 'deploy-2', fspec);
    check('kept witnesses stay, new ones are captured (none for a rule that matched nothing)', isRecord(witnessOf('hide-promo')) && isRecord(witnessOf('fetcher')) && witnessOf('gone') === undefined
      && JSON.stringify(witnessOf('row')).includes('TrackRow'), frules.map((x) => x.id));
    check('rules name handlers; sources are modules', isRecord(file.handlers) && typeof file.handlers.fetcher === 'string'
      && frules.every((x) => !('handlers' in x)));
    const history = Array.isArray(file.authoringHistory) ? file.authoringHistory.filter(isRecord) : [];
    check('the history keeps what was there and appends the exchange', history.length === 3 && history[0]?.content === 'earlier'
      && history[1]?.content === 'Tidy up' && history[1]?.agent === 'Claude Code' && history[2]?.versionId === 5, history);
    const nothing = await req(r, 'POST', `/sessions/${id}/commit`, { revision: 1, commitId: 'three', summary: 's' });
    check('committing the committed revision again is nothing-to-commit', nothing.error === 'nothing-to-commit');

    host.navigate(url);
    const navPreviewAt = host.applied.length;
    const navPreview = await preview(r, id, { ...next, 'shim.json': json({ ...JSON.parse(next['shim.json'] ?? '{}') as object, intent: 'after a navigation' }) });
    check('a preview after a full navigation re-applies the live set first', host.applied.length === navPreviewAt + 5 && isRecord(navPreview.evidence), host.applied.length - navPreviewAt);

    // End.
    const live = new Set(host.applied.map((p) => p.ruleKey));
    const ended = await req(r, 'DELETE', `/sessions/${id}`);
    check('ending answers the last version', ended.ok === true && ended.versionId === 5, ended);
    check('every live preview is torn down and the page closed', [...live].every((k) => host.removed.includes(k)) && host.closed);
    const afterEnd = await req(r, 'POST', `/sessions/${id}/call`, { name: 'read_console', input: {} });
    check('calls after the end answer session-ended', afterEnd.error === 'session-ended');
    const reopened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    check('the file is free again', reopened.ok === true, reopened);
    await r.control.closeAll();
  }

  console.log('a new shim');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'fresh.shim');
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url: 'http://localhost:5173/x' }, agent: 'a', intent: 'x', shimFile, create: { name: 'Fresh' } });
    check('a new shim opens on the page\'s host and port', opened.ok === true && opened.artifactId === 'shim-new-1', opened);
    const co = decodeWorkingCopy((await req(r, 'GET', `/sessions/${String(opened.sessionId)}/checkout`)).files);
    const s = co['shim.json'];
    const specText = typeof s === 'string' ? s : new TextDecoder().decode(s);
    check('its spec matches localhost:5173', specText.includes('"localhost:5173"'));
    check('nothing is written until a commit', !fs.existsSync(shimFile));
    await req(r, 'DELETE', `/sessions/${String(opened.sessionId)}`);
    check('ending without a commit writes nothing', !fs.existsSync(shimFile));
  }

  console.log('a redirect on open');
  {
    const r = rig();
    r.redirect = (u) => u.replace('://site.test/', '://www.site.test/');
    const shimFile = path.join(tmp, 'redirected.shim');
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile, create: { name: 'Redirected' } });
    check('a new shim opens on the page it landed on', opened.ok === true && opened.url === 'https://www.site.test/tracks' && opened.warnings === undefined, opened);
    const co = decodeWorkingCopy((await req(r, 'GET', `/sessions/${String(opened.sessionId)}/checkout`)).files);
    const s = co['shim.json'];
    const specText = typeof s === 'string' ? s : new TextDecoder().decode(s);
    const hosts = (JSON.parse(specText) as { match?: { hosts?: string[] } }).match?.hosts;
    check('…and matches the final host, not the requested one', JSON.stringify(hosts) === '["www.site.test"]', hosts);
    await r.control.closeAll();

    const existing = path.join(tmp, 'apex.shim');
    fs.writeFileSync(existing, json({ format: 'shim/1', name: 'Apex', handlers: {}, spec: { id: 'shim-apex', match: { hosts: ['site.test'] }, rules: [] } }));
    const r2 = rig();
    r2.redirect = r.redirect;
    const warned = await req(r2, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile: existing });
    check('an existing shim is warned against the final host', warned.ok === true && Array.isArray(warned.warnings)
      && String(warned.warnings[0]).includes('www.site.test'), warned);
    await r2.control.closeAll();

    const u = (x: string): URL => new URL(x);
    check('a host pattern without a port matches any port', hostPatternMatches('site.test', u('http://site.test:8080/')));
    check('a host pattern with a port matches only that port', hostPatternMatches('site.test:8080', u('http://site.test:8080/'))
      && !hostPatternMatches('site.test:8080', u('http://site.test:9090/')) && !hostPatternMatches('site.test:8080', u('http://site.test/')));
    check('a wildcard matches subdomains, not the apex', hostPatternMatches('*.site.test', u('https://www.site.test/'))
      && !hostPatternMatches('*.site.test', u('https://site.test/')));
  }

  console.log('a shim declaring several hosts');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'multi.shim');
    fs.writeFileSync(shimFile, json({ format: 'shim/1', name: 'Multi', handlers: {}, spec: { id: 'shim-multi', match: { hosts: ['site.test', '*.other.test', 'local.test:8080'] }, rules: [] } }));
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    const id = String(opened.sessionId);
    const host = r.hosts[0] as FakeHost;
    const tool = async (): Promise<string> => {
      const out = await req(r, 'POST', `/sessions/${id}/call`, { name: 'inspect_element', input: { selector: 'body' } });
      return typeof out.result === 'string' ? out.result : '';
    };
    host.setUrl('https://app.other.test/inbox');
    check('a page on a wildcard-declared host is on the site', !(await tool()).includes('page-away'));
    host.setUrl('http://local.test:8080/');
    check('…and one on a declared host:port', !(await tool()).includes('page-away'));
    host.setUrl('http://local.test:9090/');
    check('…but not the same host on another port', (await tool()).includes('page-away'));
    host.setUrl('https://other.test/');
    check('…nor a wildcard\'s apex', (await tool()).includes('page-away'));
    host.setUrl('https://elsewhere.test/');
    check('…nor an undeclared host', (await tool()).includes('page-away'));
    await r.control.closeAll();
  }

  console.log('the start host holds to its port');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'ported.shim');
    fs.writeFileSync(shimFile, json({ format: 'shim/1', name: 'Ported', handlers: {}, spec: { id: 'shim-ported', match: { hosts: ['elsewhere.test'] }, rules: [] } }));
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url: 'http://localhost:5173/app' }, agent: 'a', intent: 'x', shimFile });
    check('a session opens on an explicit port', opened.ok === true, opened);
    const id = String(opened.sessionId);
    const host = r.hosts[0] as FakeHost;
    const tool = async (): Promise<string> => {
      const out = await req(r, 'POST', `/sessions/${id}/call`, { name: 'inspect_element', input: { selector: 'body' } });
      return typeof out.result === 'string' ? out.result : '';
    };
    host.setUrl('http://localhost:5173/other');
    check('another path on the start host:port is on the site', !(await tool()).includes('page-away'));
    host.setUrl('http://localhost:9090/');
    check('…but the start host on another port is away', (await tool()).includes('page-away'));
    host.setUrl('http://localhost/');
    check('…and so is its default port', (await tool()).includes('page-away'));
    await r.control.closeAll();
  }

  console.log('a stored handler named after an Object.prototype property');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'ctor.shim');
    fs.writeFileSync(shimFile, json({
      format: 'shim/1', name: 'Ctor',
      spec: { id: 'shim-ctor', match: { hosts: ['site.test'] }, rules: [{ id: 'c', anchor: css('.track'), mutations: [{ kind: 'script', handler: 'constructor' }] }] },
      handlers: { constructor: 'module.exports = function constructor({ anchor }) { anchor.dataset.c = "1"; };\n' },
    }));
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    check('the session opens', opened.ok === true, opened);
    const ruleHandlers = (r.hosts[0] as FakeHost | undefined)?.applied[0]?.rule.handlers;
    const inlined: unknown = ruleHandlers !== undefined ? Object.getOwnPropertyDescriptor(ruleHandlers, 'constructor')?.value : undefined;
    check('its stored module is inlined for the page, not skipped via the prototype',
      typeof inlined === 'string' && !inlined.startsWith('module.exports'), ruleHandlers);
    await r.control.closeAll();
  }

  console.log('two opens racing for one file');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'race.shim');
    fs.writeFileSync(shimFile, json({ format: 'shim/1', name: 'Race', handlers: {}, spec: { id: 'shim-race', version: 1, match: { hosts: ['site.test'] }, rules: [] } }));
    let release: () => void = () => undefined;
    r.gate = new Promise<void>((resolve) => { release = resolve; });
    const first = req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    // Bounded: an open that read the file and is waiting on its own page
    // would otherwise hang here instead of failing.
    const second = await Promise.race([
      req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'b', intent: 'y', shimFile }),
      new Promise<Record<string, unknown>>((resolve) => setTimeout(() => resolve({ error: 'still waiting on its page' }), 500)),
    ]);
    check('a second open while the first one\'s page loads is busy at once, reading nothing', second.error === 'artifact-busy' && r.hosts.length === 0, second);
    r.gate = null;
    release();
    const opened = await first;
    check('the first open goes on to hold the file', opened.ok === true, opened);
    await req(r, 'DELETE', `/sessions/${String(opened.sessionId)}`);
    const third = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'c', intent: 'z', shimFile });
    check('once it ends the file opens again', third.ok === true, third);
    await r.control.closeAll();
  }

  console.log('two shim-mcp processes on one file');
  {
    const shimFile = path.join(tmp, 'shared.shim');
    fs.writeFileSync(shimFile, json({ format: 'shim/1', name: 'Shared', handlers: {}, spec: { id: 'shim-shared', version: 1, match: { hosts: ['site.test'] }, rules: [] } }));
    const lockFile = lockFileFor(shimFile);
    const a = rig({ pid: 1001, isAlive: () => true });
    const b = rig({ pid: 1002, isAlive: () => true });
    const first = await req(a, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    check('the first process opens the file and locks it', first.ok === true && fs.existsSync(lockFile), first);
    const other = await req(b, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'b', intent: 'y', shimFile });
    check('another process is busy, before any page opens', other.error === 'artifact-busy' && b.hosts.length === 0 && String(other.detail).includes('pid 1001'), other);
    await req(a, 'DELETE', `/sessions/${String(first.sessionId)}`);
    check('ending the session drops the lock', !fs.existsSync(lockFile));
    const now = await req(b, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'b', intent: 'y', shimFile });
    check('…and the other process opens it', now.ok === true, now);
    await b.control.closeAll();
    check('closing every session drops its locks', !fs.existsSync(lockFile));

    a.failOpen = true;
    const failed = await req(a, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    check('an open that fails leaves no lock behind', failed.error === 'page-open-failed' && !fs.existsSync(lockFile), failed);

    // A process that crashed holding the file.
    const hostname = os.hostname();
    fs.writeFileSync(lockFile, JSON.stringify({ format: 'shim-mcp-lock/1', pid: 4242, hostname, token: 'dead', at: 1 }));
    const c = rig({ pid: 1003, isAlive: (pid) => pid !== 4242 });
    const takeover = await req(c, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'c', intent: 'z', shimFile });
    check('a dead process\'s lock is taken over', takeover.ok === true && !fs.readFileSync(lockFile, 'utf8').includes('"dead"'), takeover);
    await c.control.closeAll();

    fs.writeFileSync(lockFile, 'not a lock');
    const d = rig({ pid: 1004, isAlive: () => true });
    const junk = await req(d, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'd', intent: 'z', shimFile });
    check('a file that isn\'t a lock is taken over', junk.ok === true, junk);
    await d.control.closeAll();

    fs.writeFileSync(lockFile, JSON.stringify({ format: 'shim-mcp-lock/1', pid: 4242, hostname: `${hostname}-elsewhere`, token: 'remote', at: 1 }));
    const e = rig({ pid: 1005, isAlive: () => false });
    const remote = await req(e, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'e', intent: 'z', shimFile });
    check('a lock from another machine is never judged stale', remote.error === 'artifact-busy' && e.hosts.length === 0 && fs.readFileSync(lockFile, 'utf8').includes('remote'), remote);
    fs.unlinkSync(lockFile);

    // Two processes recovering one stale lock: the other one wins between
    // this one judging the lock stale and removing it.
    const deadLock = JSON.stringify({ format: 'shim-mcp-lock/1', pid: 4242, hostname, token: 'dead', at: 1 });
    const fresh = JSON.stringify({ format: 'shim-mcp-lock/1', pid: 5151, hostname, token: 'winner', at: 2 });
    fs.writeFileSync(lockFile, deadLock);
    const raced = tryLockFile(shimFile, {
      pid: 1006,
      isAlive: (pid) => {
        if (pid === 4242) {
          fs.writeFileSync(lockFile, fresh); // the other recoverer took over first
          return false;
        }
        return true;
      },
    });
    check('a stale lock another process took over first is never removed', !raced.ok && raced.holder?.pid === 5151 && fs.readFileSync(lockFile, 'utf8').includes('winner'), raced);
    check('…and the takeover mutex is released', !fs.existsSync(`${lockFile}.takeover`));

    fs.writeFileSync(lockFile, deadLock);
    fs.writeFileSync(`${lockFile}.takeover`, JSON.stringify({ format: 'shim-mcp-lock/1', pid: 6161, hostname, token: 'busy', at: 3 }));
    const blocked = tryLockFile(shimFile, { pid: 1007, isAlive: (pid) => pid !== 4242 });
    check('while a live process holds the takeover mutex, a stale lock is not touched', !blocked.ok && fs.readFileSync(lockFile, 'utf8').includes('"dead"'), blocked);
    const recovered = tryLockFile(shimFile, { pid: 1008, isAlive: (pid) => pid !== 4242 && pid !== 6161 });
    check('a mutex its dead holder left behind is recovered', recovered.ok && !fs.existsSync(`${lockFile}.takeover`), recovered);
    if (recovered.ok) recovered.lock.release();
    check('…and its lock released', !fs.existsSync(lockFile));
    check('no temp files are left beside the lock', fs.readdirSync(tmp).every((f) => !f.endsWith('.tmp')), fs.readdirSync(tmp));
  }

  console.log('a .shim whose match.hosts is unusable');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'nohosts.shim');
    fs.writeFileSync(shimFile, json({ format: 'shim/1', name: 'No hosts', handlers: {}, spec: { id: 'shim-nohosts', version: 1, match: { hosts: 'site.test' }, rules: [] } }));
    const bad = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    check('is refused before any page opens', bad.error === 'malformed-shim-file' && r.hosts.length === 0, bad);
    check('…holding nothing', !fs.existsSync(lockFileFor(shimFile)) && r.control.sessions.list().length === 0);
    fs.writeFileSync(shimFile, json({ format: 'shim/1', name: 'No hosts', handlers: {}, spec: { id: 'shim-nohosts', version: 1, rules: [] } }));
    const none = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    check('…as is one with no match at all', none.error === 'malformed-shim-file' && r.hosts.length === 0, none);
  }

  console.log('a hand-edited .shim with malformed rules');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'badrules.shim');
    const rule = (mutations: unknown): Record<string, unknown> => ({ id: 'r1', anchor: { primary: { kind: 'css', value: '.x' } }, mutations });
    fs.writeFileSync(shimFile, json({ format: 'shim/1', name: 'Bad', handlers: {}, spec: { id: 'shim-bad', version: 1, match: { hosts: ['site.test'] }, rules: [rule({ kind: 'hide' })] } }));
    const shape = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    check('a rule whose mutations is an object is refused before preflight or any page (not internal-error)', shape.error === 'malformed-shim-file' && r.hosts.length === 0, shape);
    fs.writeFileSync(shimFile, json({ format: 'shim/1', name: 'Bad', handlers: {}, spec: { id: 'shim-bad', version: 1, match: { hosts: ['site.test'] }, rules: [rule([{ kind: 'explode' }])] } }));
    const kind = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    check('an invented mutation kind is refused by the commit-time lint', kind.error === 'spec-lint' && r.hosts.length === 0, kind);
    check('…holding nothing', !fs.existsSync(lockFileFor(shimFile)) && r.control.sessions.list().length === 0);
  }

  console.log('a rule whose id is __proto__ keeps its witness through a commit');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'proto.shim');
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile, create: { name: 'Proto' } });
    const pid = String(opened.sessionId);
    const co = await req(r, 'GET', `/sessions/${pid}/checkout`);
    const folder = decodeWorkingCopy(co.files);
    const spec = JSON.parse(String(folder['shim.json'])) as Record<string, unknown>;
    spec.rules = [JSON.parse('{"id":"__proto__","anchor":{"primary":{"kind":"css","value":".promo"}},"mutations":[{"kind":"hide"}]}') as unknown];
    const pv = await preview(r, pid, { ...folder, 'shim.json': json(spec) } as Record<string, string>);
    check('the __proto__ rule previews', pv.applied === true, pv);
    const cm = await req(r, 'POST', `/sessions/${pid}/commit`, { revision: 1, commitId: 'p1', summary: 's' });
    check('…and commits', cm.ok === true, cm);
    const saved = JSON.parse(fs.readFileSync(shimFile, 'utf8')) as { spec: { rules: Array<{ id: string; anchor?: { witness?: unknown } }> } };
    check('…with its captured witness on the committed rule', isRecord(saved.spec.rules.find((x) => x.id === '__proto__')?.anchor?.witness), saved.spec.rules);
    await req(r, 'DELETE', `/sessions/${pid}`);
  }

  console.log('a captured witness rides every replay of its rule');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'witness-replay.shim');
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile, create: { name: 'Replay' } });
    const wid = String(opened.sessionId);
    const host = r.hosts[0] as FakeHost;
    // A fake engine over two `.item` elements: on the first document the
    // selector resolves "first"; on every later one "second" comes first, so
    // only the witness keeps the rule off it.
    let doc = 0;
    const attached: string[] = [];
    host.onApply = (p, h) => {
      const witness = p.rule.anchor?.witness as { textStem?: string } | undefined;
      const element = doc === 0 || witness?.textStem === 'first' ? 'first' : 'second';
      attached.push(element);
      h.emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: 1 });
      if (!witness) h.emit({ kind: 'rule-witness', specId: p.ruleKey, ruleId: p.rule.id, witness: { v: 1, tag: 'li', textStem: element } });
    };
    const folder = decodeWorkingCopy((await req(r, 'GET', `/sessions/${wid}/checkout`)).files);
    const spec = JSON.parse(String(folder['shim.json'])) as Record<string, unknown>;
    spec.rules = [{ id: 'pick', anchor: css('.item'), mutations: [{ kind: 'hide' }] }];
    const pv = await preview(r, wid, { ...folder, 'shim.json': json(spec) } as Record<string, string>);
    check('the rule previews and captures its witness', pv.applied === true && attached.join() === 'first', { pv, attached });
    const lastPick = (): PreviewRule | undefined => [...host.applied].reverse().find((p) => p.rule.id === 'pick');
    const witnessStem = (): unknown => (lastPick()?.rule.anchor?.witness as { textStem?: string } | undefined)?.textStem;

    doc = 1;
    const reload = await req(r, 'POST', `/sessions/${wid}/call`, { name: 'reload_page', input: {} });
    check('reload_page replays the rule with its captured witness', String(reload.result).includes('"ok":true') && witnessStem() === 'first', { reload, rule: lastPick()?.rule });
    check('…so the replay attaches to the witnessed element, not the selector\'s new first match', attached.join() === 'first,first', attached);

    doc = 2;
    host.navigate(url);
    await req(r, 'POST', `/sessions/${wid}/call`, { name: 'view_page', input: {} });
    check('a followed navigation replays it with the witness too', witnessStem() === 'first' && attached.join() === 'first,first,first', attached);
    check('…keeping the preview\'s deploy baseline (a new rule runs behind none)', lastPick()?.bundleHash === undefined);
    await req(r, 'DELETE', `/sessions/${wid}`);
  }

  console.log('a cardinality-many rule previewed with one row captures its set once more rows load');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'one-row.shim');
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile, create: { name: 'Rows' } });
    const sid = String(opened.sessionId);
    const host = r.hosts[0] as FakeHost;
    // The fake engine: one row on the page at first, three once the agent scrolls.
    let rows = 1;
    host.onApply = (p, h) => {
      h.emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: rows, matchedVia: 'primary', applyId: p.applyId });
      const base = { kind: 'rule-witness', specId: p.ruleKey, ruleId: p.rule.id, witness: null, documentId: 'd1', rev: rows, applyId: p.applyId };
      h.emit(rows === 1
        ? { ...base, setWitness: null, captureNote: 'one-member' }
        : { ...base, setWitness: { v: 1, tag: 'li', count: rows, nested: false } });
    };
    const folder = decodeWorkingCopy((await req(r, 'GET', `/sessions/${sid}/checkout`)).files);
    const spec = JSON.parse(String(folder['shim.json'])) as Record<string, unknown>;
    spec.rules = [{ id: 'rows', anchor: { ...css('li.row'), cardinality: 'many' }, mutations: [{ kind: 'hide' }] }];
    const files = { ...folder, 'shim.json': json(spec) } as Record<string, string>;
    const p1 = await preview(r, sid, files);
    const status1 = (isRecord(p1.evidence) && Array.isArray(p1.evidence.rules) ? p1.evidence.rules.filter(isRecord)[0]?.status : '') as string;
    check('one row: no fingerprint, and the evidence says to load more and preview again', /load more items/.test(String(status1)), p1);
    rows = 3;
    const p2 = await preview(r, sid, decodeWorkingCopy((await req(r, 'GET', `/sessions/${sid}/checkout`)).files) as Record<string, string>);
    check('the unchanged rule is re-applied on the repeat preview (not "unchanged")', p2.applied === true, p2);
    const cm = await req(r, 'POST', `/sessions/${sid}/commit`, { revision: 2, commitId: 'r1', summary: 's' });
    const saved = JSON.parse(fs.readFileSync(shimFile, 'utf8')) as { spec: { rules: Array<{ id: string; anchor?: { setWitness?: { count?: number }; witness?: unknown } }> } };
    const rule = saved.spec.rules.find((x) => x.id === 'rows');
    check('…and commits the set witness the second preview captured', cm.ok === true && rule?.anchor?.setWitness?.count === 3 && rule.anchor.witness === undefined, { cm, rule });
    await req(r, 'DELETE', `/sessions/${sid}`);
  }

  console.log('a cardinality-many rule that first matches after a navigation commits its set witness');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'after-nav.shim');
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile, create: { name: 'AfterNav' } });
    const sid = String(opened.sessionId);
    const host = r.hosts[0] as FakeHost;
    // Nothing on the first document; eleven members on the next one.
    let rows = 0;
    host.onApply = (p, h) => {
      h.emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: rows, matchedVia: 'primary', applyId: p.applyId });
      if (rows > 1) {
        h.emit({ kind: 'rule-witness', specId: p.ruleKey, ruleId: p.rule.id, witness: null, documentId: `d${rows}`, rev: rows, applyId: p.applyId,
          setWitness: { v: 1, tag: 'div', count: rows, nested: false } });
      }
    };
    const folder = decodeWorkingCopy((await req(r, 'GET', `/sessions/${sid}/checkout`)).files);
    const spec = JSON.parse(String(folder['shim.json'])) as Record<string, unknown>;
    spec.rules = [{ id: 'cards', anchor: { ...css('div.card'), cardinality: 'many' }, mutations: [{ kind: 'hide' }] }];
    const files = { ...folder, 'shim.json': json(spec) } as Record<string, string>;
    const p1 = await preview(r, sid, files);
    check('matching nothing, the rule previews', p1.applied === true, p1);
    rows = 11;
    host.navigate(url);
    await req(r, 'POST', `/sessions/${sid}/call`, { name: 'view_page', input: {} });
    const p2 = await preview(r, sid, files);
    const ev2 = isRecord(p2.evidence) ? p2.evidence : {};
    check('the repeat preview of the unchanged folder reports applied consistently (top level and evidence)', p2.applied === ev2.applied, p2);
    const cm = await req(r, 'POST', `/sessions/${sid}/commit`, { revision: p2.revision, commitId: 'n1', summary: 's' });
    const saved = JSON.parse(fs.readFileSync(shimFile, 'utf8')) as { spec: { rules: Array<{ id: string; anchor?: { setWitness?: { count?: number }; witness?: unknown } }> } };
    const rule = saved.spec.rules.find((x) => x.id === 'cards');
    check('…and the commit carries the set witness of the eleven', cm.ok === true && rule?.anchor?.setWitness?.count === 11 && rule.anchor.witness === undefined, { cm, rule });
    await req(r, 'DELETE', `/sessions/${sid}`);
  }

  console.log('a witness the engine reports after the preview answered is still taken');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'late-witness.shim');
    fs.writeFileSync(shimFile, json({
      format: 'shim/1', name: 'Late', handlers: {},
      spec: { id: 'shim-late', version: 1, match: { hosts: ['site.test'] }, rules: [{ id: 'old', anchor: css('.old'), mutations: [{ kind: 'hide' }] }] },
    }));
    // The engine fingerprints `old` while begin applies it; every later
    // apply only reports status (an element still being fetched).
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    const lid = String(opened.sessionId);
    const host = r.hosts[0] as FakeHost;
    host.onApply = (p, h) => { h.emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: 0, applyId: p.applyId }); };
    const folder = decodeWorkingCopy((await req(r, 'GET', `/sessions/${lid}/checkout`)).files);
    const spec = JSON.parse(String(folder['shim.json'])) as Record<string, unknown> & { rules: unknown[] };
    const withRules = (rules: unknown[]): Record<string, string> => ({ ...folder, 'shim.json': json({ ...spec, rules }) } as Record<string, string>);
    const late = { id: 'late', anchor: css('.late'), mutations: [{ kind: 'hide' }] };
    const swap = { id: 'swap', anchor: css('.swap-a'), mutations: [{ kind: 'hide' }] };
    const p1 = await preview(r, lid, withRules([...spec.rules, late, swap]));
    check('the preview answers before either new rule matched', p1.applied === true, p1);
    const keyOf = (rid: string): string => `preview:shim-late:${rid}`;
    const lastOf = (rid: string): PreviewRule | undefined => [...host.applied].reverse().find((x) => x.rule.id === rid);
    const swapV1 = lastOf('swap')?.applyId;
    // The element arrives: the engine fingerprints `late` after the window.
    host.emit({ kind: 'rule-witness', specId: keyOf('late'), ruleId: 'late', witness: { v: 1, tag: 'li', textStem: 'arrived' }, applyId: lastOf('late')?.applyId });
    // `swap` is re-anchored, then a late witness from its first version lands.
    const p2 = await preview(r, lid, withRules([...spec.rules, late, { ...swap, anchor: css('.swap-b') }]));
    check('swap is re-anchored as a new version', p2.applied === true && typeof swapV1 === 'string' && lastOf('swap')?.applyId !== swapV1, p2);
    host.emit({ kind: 'rule-witness', specId: keyOf('swap'), ruleId: 'swap', witness: { v: 1, tag: 'li', textStem: 'stale' }, applyId: swapV1 });
    // A replaced version's handler reports a match during the next version's
    // window: not this preview's evidence.
    const swapV2 = lastOf('swap')?.applyId;
    host.onApply = (p, h) => {
      if (p.rule.id === 'swap') h.emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: 'swap', matched: 1, applyId: swapV2 });
      h.emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: 0, applyId: p.applyId });
    };
    const p3 = await preview(r, lid, withRules([...spec.rules, late, { ...swap, anchor: css('.swap-gone') }]));
    const ev3 = isRecord(p3.evidence) ? p3.evidence : {};
    const swap3 = (Array.isArray(ev3.rules) ? ev3.rules.filter(isRecord) : []).find((x) => x.ruleId === 'swap');
    check('a replaced version\'s late match is not this preview\'s evidence: still no match, verification none',
      JSON.stringify(ev3.noMatch) === JSON.stringify([{ ruleId: 'swap', selector: '.swap-gone' }]) && swap3?.verification === 'none', ev3);
    // A replaced version's async handler resumes during the next version's
    // window and calls a member headless lacks: the event carries the old
    // applyId, so the replacement is not marked partial for it.
    const swapV3 = lastOf('swap')?.applyId;
    host.onApply = (p, h) => {
      if (p.rule.id === 'swap') h.emit({ kind: 'unsupported-api', specId: p.ruleKey, member: 'fetch', path: '/old', applyId: swapV3 });
      h.emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: 1, matchedVia: 'primary', applyId: p.applyId });
    };
    const p4 = await preview(r, lid, withRules([...spec.rules, late, { ...swap, anchor: css('.swap-c') }]));
    const ev4 = isRecord(p4.evidence) ? p4.evidence : {};
    const swap4 = (Array.isArray(ev4.rules) ? ev4.rules.filter(isRecord) : []).find((x) => x.ruleId === 'swap');
    check('a replaced version\'s late unsupported call does not make the replacement partial',
      typeof swapV3 === 'string' && lastOf('swap')?.applyId !== swapV3 && swap4?.verification === 'full' && ev4.unsupportedApi === undefined, ev4);
    host.onApply = (p, h) => { h.emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: 0, applyId: p.applyId }); };
    // And one for a rule key that is not live at all.
    host.emit({ kind: 'rule-witness', specId: keyOf('ghost'), ruleId: 'ghost', witness: { v: 1, tag: 'li' } });

    const stemOf = (p: PreviewRule | undefined): unknown => (p?.rule.anchor?.witness as { textStem?: string } | undefined)?.textStem;
    const reload = await req(r, 'POST', `/sessions/${lid}/call`, { name: 'reload_page', input: {} });
    check('reload_page replays the late-captured witness', String(reload.result).includes('"ok":true') && stemOf(lastOf('late')) === 'arrived', lastOf('late')?.rule);
    check('…and the witness captured during begin', isRecord(lastOf('old')?.rule.anchor?.witness), lastOf('old')?.rule);
    check('…but not a late witness from a version of the rule since replaced', lastOf('swap')?.rule.anchor?.witness === undefined, lastOf('swap')?.rule);
    const cm = await req(r, 'POST', `/sessions/${lid}/commit`, { revision: 4, commitId: 'l1', summary: 's' });
    check('the session commits', cm.ok === true, cm);
    const saved = JSON.parse(fs.readFileSync(shimFile, 'utf8')) as { spec: { rules: Array<{ id: string; anchor?: { witness?: { textStem?: string } } }> } };
    const savedRule = (rid: string): { anchor?: { witness?: { textStem?: string } } } | undefined => saved.spec.rules.find((x) => x.id === rid);
    check('the commit keeps the witness captured after the preview answered', savedRule('late')?.anchor?.witness?.textStem === 'arrived', saved.spec.rules);
    check('…and the one captured during begin', isRecord(savedRule('old')?.anchor?.witness), saved.spec.rules);
    check('…and no stale one', savedRule('swap')?.anchor?.witness === undefined && !saved.spec.rules.some((x) => x.id === 'ghost'), saved.spec.rules);
    await req(r, 'DELETE', `/sessions/${lid}`);
  }

  console.log('the deploy baseline follows the committed anchor, and autoRepair rides with it');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'rows.shim');
    fs.writeFileSync(shimFile, json({
      format: 'shim/1', name: 'Rows', handlers: {},
      spec: {
        id: 'shim-rows', version: 2, bundleHash: 'deploy-1', autoRepair: false, match: { hosts: ['site.test'] },
        rules: [
          // Multi-match: the engine never captures a witness for it.
          { id: 'rows', anchor: { primary: { kind: 'css', value: '.row' }, fallbacks: [{ kind: 'css', value: '[data-row]' }] }, mutations: [{ kind: 'restyle', css: { color: 'red' } }] },
          { id: 'buy', anchor: { ...css('.buy'), witness: { v: 1, tag: 'button' } }, mutations: [{ kind: 'hide' }] },
        ],
      },
    }));
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    const sid = String(opened.sessionId);
    const host = r.hosts[0] as FakeHost;
    const last = (ruleId: string): PreviewRule | undefined => [...host.applied].reverse().find((p) => p.rule.id === ruleId);
    // From here on the engine matches many elements, so it captures no witness.
    host.onApply = (p, h) => h.emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: 2, matchedVia: 'primary', applyId: p.applyId });
    check('a witness-less committed rule runs behind the baseline', last('rows')?.bundleHash === 'deploy-1', last('rows'));
    check('an opted-out shim\'s committed rules carry autoRepair: false', last('rows')?.autoRepair === false && last('buy')?.autoRepair === false,
      [last('rows'), last('buy')]);

    const folder = decodeWorkingCopy((await req(r, 'GET', `/sessions/${sid}/checkout`)).files);
    const spec = JSON.parse(String(folder['shim.json'])) as Record<string, unknown> & { rules: Array<Record<string, unknown>> };
    const reanchored = spec.rules.map((rule) => (rule.id === 'rows' ? { ...rule, anchor: css('.track-row') } : rule));
    const pv = await preview(r, sid, { ...folder, 'shim.json': json({ ...spec, rules: [...reanchored, { id: 'fresh', anchor: css('.fresh'), mutations: [{ kind: 'hide' }] }] }) } as Record<string, string>);
    check('the re-anchored and new rules preview', pv.applied === true, pv);
    check('a re-anchored rule runs behind no baseline, and so no autoRepair', last('rows')?.bundleHash === undefined && last('rows')?.autoRepair === undefined, last('rows'));
    check('a new rule runs behind no baseline', last('fresh')?.bundleHash === undefined && last('fresh')?.autoRepair === undefined, last('fresh'));

    const back = spec.rules.map((rule) => (rule.id === 'rows' ? { ...rule, mutations: [{ kind: 'restyle', css: { color: 'blue' } }] } : rule));
    const pv2 = await preview(r, sid, { ...folder, 'shim.json': json({ ...spec, rules: back }) } as Record<string, string>);
    check('back on the committed anchor, the rule runs behind the baseline again', pv2.applied === true && last('rows')?.bundleHash === 'deploy-1' && last('rows')?.autoRepair === false, last('rows'));

    const pv3 = await preview(r, sid, { ...folder, 'shim.json': json({ ...spec, rules: reanchored }) } as Record<string, string>);
    check('re-anchored again', pv3.applied === true && last('rows')?.bundleHash === undefined, last('rows'));
    const c = await req(r, 'POST', `/sessions/${sid}/commit`, { revision: 3, commitId: 'rows-1', summary: 're-anchored rows' });
    const saved = JSON.parse(fs.readFileSync(shimFile, 'utf8')) as { spec: { bundleHash?: string; autoRepair?: boolean } };
    check('the re-anchor commits', c.ok === true && typeof saved.spec.bundleHash === 'string', { c, spec: saved.spec });
    check('…keeping autoRepair off', saved.spec.autoRepair === false, saved.spec);
    const unpackedState = JSON.parse(unpackShim(fs.readFileSync(shimFile, 'utf8'))[SHIM_STATE_FILE] ?? '{}') as ShimState;
    check('the committed file unpacks with the witness-less rule\'s new anchor digest',
      unpackedState.anchors?.rows === anchorDigest(css('.track-row')) && !('rows' in unpackedState.rules), unpackedState);
    const edited = reanchored.map((rule) => (rule.id === 'rows' ? { ...rule, mutations: [{ kind: 'restyle', css: { color: 'green' } }] } : rule));
    const pv4 = await preview(r, sid, { ...folder, 'shim.json': json({ ...spec, rules: edited }) } as Record<string, string>);
    check('once committed, the new anchor runs behind the committed baseline', pv4.applied === true && last('rows')?.bundleHash === saved.spec.bundleHash, last('rows'));
    await req(r, 'DELETE', `/sessions/${sid}`);
  }

  console.log('an unapplied deploy recovery keeps the committed baseline');
  {
    const shimFile = path.join(tmp, 'recover.shim');
    fs.writeFileSync(shimFile, json({
      format: 'shim/1', name: 'Recover', handlers: {},
      spec: {
        id: 'shim-rec', version: 2, bundleHash: 'deploy-1', match: { hosts: ['site.test'] },
        rules: [
          { id: 'buy', anchor: { ...css('.buy-v1'), witness: { v: 1, tag: 'button', textStem: 'buy' } }, mutations: [{ kind: 'hide' }] },
          { id: 'other', anchor: { ...css('.other'), witness: { v: 1, tag: 'div' } }, mutations: [{ kind: 'hide' }] },
        ],
      },
    }));
    // The page is on deploy-2: `.buy-v1` is dead, and the witness finds the
    // button again — reported, not applied (rule-reconcile).
    const engine = (p: PreviewRule, h: FakeHost): void => {
      const dead = p.rule.anchor?.primary.value === '.buy-v1';
      if (dead && p.bundleHash === 'deploy-1') {
        h.emit({ kind: 'rule-rebase', specId: p.ruleKey, ruleId: p.rule.id, strategy: 'recover', via: 'witness', anchor: css('.buy-v2'), from: '.buy-v1', to: '.buy-v2', bundleHash: 'deploy-2', applyId: p.applyId });
      }
      h.emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: dead ? 0 : 1, applyId: p.applyId });
    };
    const open = async (): Promise<{ r: Rig; sid: string; host: FakeHost }> => {
      const r = rig();
      const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
      const host = r.hosts[0] as FakeHost;
      return { r, sid: String(opened.sessionId), host };
    };
    const first = await open();
    const begun = first.host.applied.find((p) => p.rule.id === 'buy');
    check('the dead rule runs behind the committed baseline', begun?.bundleHash === 'deploy-1', begun);
    first.host.onApply = engine;
    // begin ran on the fake's default engine: replay as the deploy-2 page would.
    const reload = await req(first.r, 'POST', `/sessions/${first.sid}/call`, { name: 'reload_page', input: {} });
    check('the reload replays the committed rules', String(reload.result).includes('"ok":true'), reload);
    const folder = decodeWorkingCopy((await req(first.r, 'GET', `/sessions/${first.sid}/checkout`)).files);
    const spec = JSON.parse(String(folder['shim.json'])) as Record<string, unknown> & { rules: Array<Record<string, unknown>> };
    const edited = spec.rules.map((rule) => (rule.id === 'other' ? { ...rule, mutations: [{ kind: 'restyle', css: { opacity: '0.5' } }] } : rule));
    const pv = await preview(first.r, first.sid, { ...folder, 'shim.json': json({ ...spec, rules: edited }) } as Record<string, string>);
    const notes = isRecord(pv.evidence) && Array.isArray(pv.evidence.notes) ? pv.evidence.notes.map(String) : [];
    check('the evidence says the recovery is not applied and what a commit does meanwhile', notes.some((n) => n.includes('rule "buy"')
      && n.includes('.buy-v2') && n.includes('nothing applied') && n.includes('keeps the committed deploy baseline')), notes);
    const c1 = await req(first.r, 'POST', `/sessions/${first.sid}/commit`, { revision: 1, commitId: 'r1', summary: 'restyled other' });
    const saved1 = JSON.parse(fs.readFileSync(shimFile, 'utf8')) as { spec: { version: number; bundleHash?: string } };
    check('an unrelated commit keeps the committed deploy baseline', c1.ok === true && saved1.spec.version === 3 && saved1.spec.bundleHash === 'deploy-1', saved1.spec);
    await req(first.r, 'DELETE', `/sessions/${first.sid}`);

    const second = await open();
    const reopened = second.host.applied.find((p) => p.rule.id === 'buy');
    check('reopened, the dead rule still runs behind deploy-1, so the deploy is still seen and recoverable', reopened?.bundleHash === 'deploy-1', reopened);
    second.host.onApply = engine;
    await req(second.r, 'POST', `/sessions/${second.sid}/call`, { name: 'reload_page', input: {} });
    // The agent takes the recovery into the shim: the baseline may advance.
    const folder2 = decodeWorkingCopy((await req(second.r, 'GET', `/sessions/${second.sid}/checkout`)).files);
    const spec2 = JSON.parse(String(folder2['shim.json'])) as Record<string, unknown> & { rules: Array<Record<string, unknown>> };
    const fixed = spec2.rules.map((rule) => (rule.id === 'buy' ? { ...rule, anchor: css('.buy-v2') } : rule));
    const pv2 = await preview(second.r, second.sid, { ...folder2, 'shim.json': json({ ...spec2, rules: fixed }) } as Record<string, string>);
    check('the re-anchored rule previews', pv2.applied === true, pv2);
    const c2 = await req(second.r, 'POST', `/sessions/${second.sid}/commit`, { revision: 1, commitId: 'r2', summary: 're-anchored buy' });
    const saved2 = JSON.parse(fs.readFileSync(shimFile, 'utf8')) as { spec: { bundleHash?: string } };
    check('once the anchor is updated, a commit advances the baseline to this deploy', c2.ok === true && saved2.spec.bundleHash === 'deploy-2', saved2.spec);
    await req(second.r, 'DELETE', `/sessions/${second.sid}`);
  }

  console.log('a quarantined rule keeps the committed baseline until it is healthy or re-anchored');
  {
    const shimFile = path.join(tmp, 'quarantine.shim');
    fs.writeFileSync(shimFile, json({
      format: 'shim/1', name: 'Quarantine', handlers: {},
      spec: {
        id: 'shim-q', version: 2, bundleHash: 'deploy-1', match: { hosts: ['site.test'] },
        rules: [
          { id: 'buy', anchor: { ...css('.buy-v1'), witness: { v: 1, tag: 'button', textStem: 'buy' } }, mutations: [{ kind: 'hide' }] },
          { id: 'other', anchor: { ...css('.other'), witness: { v: 1, tag: 'div' } }, mutations: [{ kind: 'hide' }] },
        ],
      },
    }));
    // deploy-2: `.buy-v1` resolves to nothing its witness accepts, and
    // neither recovery scan finds the button — quarantined, no rule-rebase.
    let buyHealthy = false;
    const engine = (p: PreviewRule, h: FakeHost): void => {
      const isBuy = p.rule.anchor?.primary.value === '.buy-v1';
      if (isBuy && !buyHealthy) {
        h.emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: 0, matchedVia: null, applyId: p.applyId });
        h.emit({ kind: 'rule-quarantined', specId: p.ruleKey, ruleId: p.rule.id, selector: '.buy-v1', applyId: p.applyId });
        return;
      }
      h.emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: 1, matchedVia: 'primary', applyId: p.applyId });
    };
    const openQ = async (): Promise<{ r: Rig; sid: string; host: FakeHost }> => {
      const r = rig();
      const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
      const host = r.hosts[0] as FakeHost;
      host.onApply = engine;
      await req(r, 'POST', `/sessions/${String(opened.sessionId)}/call`, { name: 'reload_page', input: {} });
      return { r, sid: String(opened.sessionId), host };
    };
    const editOther = async (o: { r: Rig; sid: string }, opacity: string): Promise<Record<string, unknown>> => {
      const folder = decodeWorkingCopy((await req(o.r, 'GET', `/sessions/${o.sid}/checkout`)).files);
      const spec = JSON.parse(String(folder['shim.json'])) as Record<string, unknown> & { rules: Array<Record<string, unknown>> };
      const rules = spec.rules.map((rule) => (rule.id === 'other' ? { ...rule, mutations: [{ kind: 'restyle', css: { opacity } }] } : rule));
      return preview(o.r, o.sid, { ...folder, 'shim.json': json({ ...spec, rules }) } as Record<string, string>);
    };
    const bundleOnDisk = (): unknown => (JSON.parse(fs.readFileSync(shimFile, 'utf8')) as { spec: { bundleHash?: unknown } }).spec.bundleHash;

    const first = await openQ();
    const pv = await editOther(first, '0.5');
    const notes = isRecord(pv.evidence) && Array.isArray(pv.evidence.notes) ? pv.evidence.notes.map(String) : [];
    check('the evidence says the rule is quarantined and what a commit does meanwhile', notes.some((n) => n.includes('rule "buy" is quarantined')
      && n.includes('keeps the committed deploy baseline')), notes);
    const c1 = await req(first.r, 'POST', `/sessions/${first.sid}/commit`, { revision: 1, commitId: 'q1', summary: 'restyled other' });
    check('an unrelated commit keeps the committed baseline over the quarantined rule', c1.ok === true && bundleOnDisk() === 'deploy-1', bundleOnDisk());
    await req(first.r, 'DELETE', `/sessions/${first.sid}`);

    const second = await openQ();
    const buy = [...second.host.applied].reverse().find((p) => p.rule.id === 'buy');
    check('reopened, the rule still runs behind deploy-1: the deploy and its quarantine path are still there', buy?.bundleHash === 'deploy-1', buy);
    // The button comes back under its primary: healthy, so the baseline may advance.
    buyHealthy = true;
    await req(second.r, 'POST', `/sessions/${second.sid}/call`, { name: 'reload_page', input: {} });
    await editOther(second, '0.6');
    const c2 = await req(second.r, 'POST', `/sessions/${second.sid}/commit`, { revision: 1, commitId: 'q2', summary: 'again' });
    check('once the rule resolves through its primary again, a commit advances the baseline', c2.ok === true && bundleOnDisk() === 'deploy-2', bundleOnDisk());
    await req(second.r, 'DELETE', `/sessions/${second.sid}`);
  }

  console.log('shutdown settles opens in flight');
  {
    // A page still launching when shutdown begins.
    const r = rig();
    let release: () => void = () => undefined;
    r.gate = new Promise<void>((resolve) => { release = resolve; });
    const shimFile = path.join(tmp, 'shutdown-launch.shim');
    const pending = req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile, create: { name: 'S' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    check('the open holds the file lock while its page launches', fs.existsSync(lockFileFor(shimFile)));
    const closed = r.control.closeAll();
    const refusedNewAt = req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile: path.join(tmp, 'other.shim'), create: { name: 'O' } });
    release();
    await closed;
    const refusedNew = await refusedNewAt;
    check('a new open during shutdown is refused', refusedNew.error === 'shutting-down', refusedNew);
    const answered = await pending;
    check('closeAll waits for the launch, then the open answers shutting-down', answered.error === 'shutting-down', answered);
    check('…its page closed, no session, no lock', r.hosts.length === 1 && r.hosts[0]?.closed === true
      && r.control.sessions.list().length === 0 && !fs.existsSync(lockFileFor(shimFile)));
  }
  {
    // A session whose begin is still settling when shutdown begins.
    const r = rig();
    const shimFile = path.join(tmp, 'shutdown-begin.shim');
    fs.writeFileSync(shimFile, json({
      format: 'shim/1', name: 'B', handlers: {},
      spec: { id: 'shim-b', version: 1, match: { hosts: ['site.test'] }, rules: [{ id: 'h', anchor: css('.ad'), mutations: [{ kind: 'hide' }] }] },
    }));
    let release: () => void = () => undefined;
    r.settleGate = new Promise<void>((resolve) => { release = resolve; });
    const pending = req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    check('begin is settling with the page open', r.hosts.length === 1 && r.hosts[0]?.closed === false);
    const closed = r.control.closeAll();
    release();
    r.settleGate = null;
    await closed;
    const answered = await pending;
    check('a session that registers after shutdown began is ended, and the open answers shutting-down', answered.error === 'shutting-down', answered);
    check('…its page closed, no session, no lock', r.hosts[0]?.closed === true
      && r.control.sessions.list().length === 0 && !fs.existsSync(lockFileFor(shimFile)));
  }

  console.log('a commit after a navigation the rules never ran on keeps the baseline');
  {
    const shimFile = path.join(tmp, 'nav-commit.shim');
    fs.writeFileSync(shimFile, json({
      format: 'shim/1', name: 'Nav', handlers: {},
      spec: { id: 'shim-nav', version: 1, bundleHash: 'deploy-1', match: { hosts: ['site.test'] }, rules: [{ id: 'h', anchor: { ...css('.ad'), witness: { v: 1, tag: 'div' } }, mutations: [{ kind: 'hide' }] }] },
    }));
    const r = rig();
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    const nid = String(opened.sessionId);
    const host = r.hosts[0] as FakeHost;
    const folder = decodeWorkingCopy((await req(r, 'GET', `/sessions/${nid}/checkout`)).files);
    const spec = JSON.parse(String(folder['shim.json'])) as Record<string, unknown> & { rules: unknown[] };
    const withRule = (id: string): Record<string, string> => ({ ...folder, 'shim.json': json({ ...spec, rules: [...spec.rules, { id, anchor: css(`.${id}`), mutations: [{ kind: 'hide' }] }] }) } as Record<string, string>);
    const pv = await preview(r, nid, withRule('n1'));
    check('the preview verifies on the first document', pv.applied === true, pv);
    // The page navigates itself on the site, to a document (and deploy) the rules never ran on.
    host.navigate(`${url}?next`);
    const c1 = await req(r, 'POST', `/sessions/${nid}/commit`, { revision: 1, commitId: 'n1', summary: 's' });
    const bundleOnDisk = (): unknown => (JSON.parse(fs.readFileSync(shimFile, 'utf8')) as { spec: { bundleHash?: unknown } }).spec.bundleHash;
    check('the commit keeps the committed baseline', c1.ok === true && bundleOnDisk() === 'deploy-1', { c1, bundle: bundleOnDisk() });
    check('…and says why', Array.isArray(c1.notes) && c1.notes.some((n) => String(n).includes('kept the committed deploy baseline')), c1);
    await req(r, 'DELETE', `/sessions/${nid}`);
    const r2 = rig();
    await req(r2, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    check('reopened, the witnessed rule still runs behind deploy-1, so the deploy change is still seen',
      r2.hosts[0]?.applied.find((p) => p.rule.id === 'h')?.bundleHash === 'deploy-1');
    const s2 = String(r2.control.sessions.list()[0]?.sessionId);
    const folder2 = decodeWorkingCopy((await req(r2, 'GET', `/sessions/${s2}/checkout`)).files);
    const spec2 = JSON.parse(String(folder2['shim.json'])) as Record<string, unknown> & { rules: unknown[] };
    await preview(r2, s2, { ...folder2, 'shim.json': json({ ...spec2, rules: [...spec2.rules, { id: 'n2', anchor: css('.n2'), mutations: [{ kind: 'hide' }] }] }) } as Record<string, string>);
    const c2 = await req(r2, 'POST', `/sessions/${s2}/commit`, { revision: 1, commitId: 'n2', summary: 's' });
    check('a commit on the document the rules ran on records its deploy', c2.ok === true && c2.notes === undefined && bundleOnDisk() === 'deploy-2', { c2, bundle: bundleOnDisk() });
    await req(r2, 'DELETE', `/sessions/${s2}`);
  }

  console.log('a page that leaves the site during the replay wait is refused');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'replay-away.shim');
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile, create: { name: 'R' } });
    const rid = String(opened.sessionId);
    const host = r.hosts[0] as FakeHost;
    const folder = decodeWorkingCopy((await req(r, 'GET', `/sessions/${rid}/checkout`)).files);
    const spec = JSON.parse(String(folder['shim.json'])) as Record<string, unknown>;
    const withRules = (ids: string[]): Record<string, string> => ({ ...folder, 'shim.json': json({ ...spec, rules: ids.map((id) => ({ id, anchor: css(`.${id}`), mutations: [{ kind: 'hide' }] })) }) } as Record<string, string>);
    check('a rule is live', (await preview(r, rid, withRules(['a']))).applied === true);
    // A fresh document on the site, which script-redirects off it while the replay settles.
    host.navigate(url);
    r.duringSettle = () => host.navigate('https://elsewhere.test/');
    const pv = await preview(r, rid, withRules(['a', 'b']));
    check('the preview refuses with page-away', pv.applied === false && isRecord(pv.evidence) && pv.evidence.error === 'page-away', pv);
    check('…applying nothing new to the off-site page', !host.applied.some((p) => p.rule.id === 'b'));
    const co = decodeWorkingCopy((await req(r, 'GET', `/sessions/${rid}/checkout`)).files);
    check('…and leaving the working state as it was', !String(co['shim.json']).includes('".b"'), String(co['shim.json']));
    host.navigate(url);
    r.duringSettle = () => host.navigate('https://elsewhere.test/');
    const tool = await req(r, 'POST', `/sessions/${rid}/call`, { name: 'evaluate_in_page', input: { expression: 'document.title' } });
    check('a page tool refuses too', String(tool.result).includes('page-away'), tool);
    await req(r, 'DELETE', `/sessions/${rid}`);
  }

  console.log('an on-site reload keeps the current URL, hash and all');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'reload-in-place.shim');
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile, create: { name: 'InPlace' } });
    const pid = String(opened.sessionId);
    const host = r.hosts[0] as FakeHost;
    // An in-page state change (a SERP's `#sv=…`) moves the URL without leaving the site.
    const moved = `${url}#sv=CAESJA`;
    host.setUrl(moved);
    const res = await req(r, 'POST', `/sessions/${pid}/call`, { name: 'reload_page', input: {} });
    const out = typeof res.result === 'string' ? JSON.parse(res.result) as Record<string, unknown> : {};
    check('reload_page on the site reloads in place (no destination), as its description says', out.ok === true
      && host.reloads.length === 1 && host.reloads[0] === undefined && host.url() === moved, { out, reloads: host.reloads });
    await req(r, 'DELETE', `/sessions/${pid}`);
  }

  console.log('a reload that lands off the site re-applies nothing');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'reload-away.shim');
    const opened = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile, create: { name: 'Away' } });
    const aid = String(opened.sessionId);
    const host = r.hosts[0] as FakeHost;
    const folder = decodeWorkingCopy((await req(r, 'GET', `/sessions/${aid}/checkout`)).files);
    const spec = JSON.parse(String(folder['shim.json'])) as Record<string, unknown>;
    spec.rules = [{ id: 'mark', anchor: css('.track'), mutations: [{ kind: 'script', handler: 'mark' }] }];
    const pv = await preview(r, aid, { ...folder, 'shim.json': json(spec), 'handlers/mark.js': 'module.exports = function mark({ anchor }) { anchor.dataset.m = "1"; };\n' } as Record<string, string>);
    check('a script rule is live', pv.applied === true, pv);
    // Every load lands where `landing` says, whatever the reload asked for.
    let landing = 'https://login.other.test/sign-in';
    host.reload = (u) => { host.reloads.push(u); host.navigate(landing); };
    const call = async (): Promise<Record<string, unknown>> => {
      const res = await req(r, 'POST', `/sessions/${aid}/call`, { name: 'reload_page', input: {} });
      return typeof res.result === 'string' ? JSON.parse(res.result) as Record<string, unknown> : {};
    };

    let at = host.applied.length;
    let settles = r.appliedAtSettle.length;
    const inPlace = await call();
    check('an in-place reload redirected off the site answers page-away', inPlace.error === 'page-away'
      && inPlace.url === landing && host.reloads[host.reloads.length - 1] === undefined, inPlace);
    check('…applying nothing to that page, and not settling', host.applied.length === at && r.appliedAtSettle.length === settles, host.applied.length - at);
    const tool = await req(r, 'POST', `/sessions/${aid}/call`, { name: 'view_page', input: {} });
    check('…and the page tools stay away from it too', String(tool.result).includes('page-away') && host.applied.length === at);

    landing = 'http://localhost:9090/';
    at = host.applied.length;
    settles = r.appliedAtSettle.length;
    const back = await call();
    check('the way back to the start URL redirected off the site answers page-away', back.error === 'page-away'
      && back.url === landing && host.reloads[host.reloads.length - 1] === url, back);
    check('…applying nothing there either', host.applied.length === at && r.appliedAtSettle.length === settles, host.applied.length - at);

    landing = url;
    at = host.applied.length;
    const home = await call();
    check('a reload that lands on the site re-applies the live set kept through the detours', home.ok === true && home.reapplied === 1
      && host.applied.length === at + 1 && host.applied[at]?.rule.id === 'mark', home);
    await req(r, 'DELETE', `/sessions/${aid}`);
  }

  console.log('a .shim with a spec-level css block is refused before any page opens');
  {
    const r = rig();
    const shimFile = path.join(tmp, 'spec-css.shim');
    fs.writeFileSync(shimFile, json({
      format: 'shim/1', name: 'Styled', handlers: {},
      spec: { id: 'shim-css', version: 1, match: { hosts: ['site.test'] }, css: '.promo { display: none }', rules: [{ id: 'h', anchor: css('.ad'), mutations: [{ kind: 'hide' }] }] },
    }));
    const res = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    check('the open answers unsupported, naming the css block', res.error === 'unsupported' && Array.isArray(res.unsupported)
      && res.unsupported.length === 1 && String(res.unsupported[0]).includes('"css"'), res);
    check('…before any page opened, holding nothing', r.hosts.length === 0 && r.control.sessions.list().length === 0 && !fs.existsSync(lockFileFor(shimFile)));
    fs.writeFileSync(shimFile, json({
      format: 'shim/1', name: 'Styled', handlers: {},
      spec: { id: 'shim-css', version: 1, match: { hosts: ['site.test'] }, css: ' \n', rules: [{ id: 'h', anchor: css('.ad'), mutations: [{ kind: 'hide' }] }] },
    }));
    const blank = await req(r, 'POST', '/sessions', { kind: 'shim', target: { url }, agent: 'a', intent: 'x', shimFile });
    check('a whitespace-only css block styles nothing, so the shim opens', blank.ok === true, blank);
    if (blank.ok === true) await req(r, 'DELETE', `/sessions/${String(blank.sessionId)}`);
  }
}

main().then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall headless-session checks passed');
}, (e: unknown) => {
  console.error(e);
  process.exit(1);
});
