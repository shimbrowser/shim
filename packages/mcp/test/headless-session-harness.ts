// Harness for headless sessions (packages/mcp/src/headless-control.ts,
// headless-session.ts, file-storage.ts; shim-core design D9, D10, D11, D14,
// D15) over a scripted fake PageHost — no browser. Covers:
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
//     baseline only where a witness exists) and settles before it answers;
//   - preview: preflight is atomic (nothing applied, no revision), lint
//     refuses, the evidence shape (rules with status + verification, errors,
//     noMatch, console, changes), `partial` for an unsupported-api use and
//     for a component-identity witness, the source-scan warning, witnesses
//     captured but never in the evidence or the checkout;
//   - the page-away guard (the start host plus the shim's declared hosts),
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
import type { FolderInput } from '@shimbrowser/core/shim-folder';
import { fileStorage, HEADLESS_STORAGE_FORMAT } from '../src/file-storage';
import { createHeadlessControl, hostPatternMatches, type HeadlessControl } from '../src/headless-control';
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
  emit(event: PageRuntimeEvent): void;
  log(message: PageConsoleMessage): void;
  // Runs on every applyPreview: what the "engine" reports for it.
  onApply: (p: PreviewRule, host: FakeHost) => void;
}

function fakeHost(startUrl: string): FakeHost {
  const runtime = new Set<(e: PageRuntimeEvent) => void>();
  const consoleL = new Set<(m: PageConsoleMessage) => void>();
  let url = startUrl;
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
    emit(e) { for (const l of [...runtime]) l(e); },
    log(m) { for (const l of [...consoleL]) l(m); },
    async evaluate(code) {
      if (code.includes('deployIdForDocument')) return 'deploy-2';
      return null;
    },
    async screenshot() { return { error: 'the fake host takes no screenshots' }; },
    applyPreview(p) { host.applied.push(p); host.onApply(p, host); },
    removePreview(key) { host.removed.push(key); },
    onRuntimeEvent(l) { runtime.add(l); return () => { runtime.delete(l); }; },
    onConsole(l) { consoleL.add(l); return () => { consoleL.delete(l); }; },
    reload(u) { host.reloads.push(u); if (u) url = u; },
    async waitForLoad(o): Promise<PageLoadOutcome> { host.loadWaits.push(o); return host.loadOutcome; },
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
}

function rig(fileLock?: FileLockOptions): Rig {
  const r: Rig = {
    control: null as unknown as HeadlessControl, hosts: [], storages: [], writes: [], failOpen: false, gate: null, appliedAtSettle: [], redirect: (u) => u,
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

  console.log('cli mode');
  {
    check('attach by default', !cliMode([], {}).headless);
    check('--headless', cliMode(['--headless'], {}).headless && !cliMode(['--headless'], {}).visible);
    check('SHIM_MCP_MODE=headless and --visible', cliMode(['--visible'], { SHIM_MCP_MODE: 'headless' }).headless && cliMode(['--visible'], {}).visible);
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
    check('a rule with a witness runs behind the deploy baseline; one without does not',
      host.applied[0]?.bundleHash === 'deploy-1' && host.applied[2]?.bundleHash === undefined);
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
      if (p.rule.id === 'gone') h.emit({ kind: 'rule-no-match', specId: p.ruleKey, ruleId: p.rule.id, selector: '.gone' });
      if (p.rule.id === 'fetcher') {
        h.emit({ kind: 'unsupported-api', specId: p.ruleKey, member: 'fetch', path: '/tracks' });
        h.emit({ kind: 'handler-error', specId: p.ruleKey, ruleId: p.rule.id, handlerName: 'fetcher', message: 'boom', stack: 'Error: boom\n    at shim://patches/x/handlers/fetcher.js:1:1' });
      }
      if (!p.rule.anchor?.witness) h.emit({ kind: 'rule-witness', specId: p.ruleKey, ruleId: p.rule.id, witness: { v: 1, tag: 'span', textStem: 'new' } });
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
    check('a plain rule is full', byId.get('gone')?.verification === 'full');
    check('the re-applied rule kept its committed deploy baseline', host.applied.find((p) => p.ruleKey.endsWith(':row') && host.applied.indexOf(p) >= before)?.bundleHash === 'deploy-1');
    check('handler errors carry rule, handler, message, stack', JSON.stringify(ev.errors).includes('"handler":"fetcher"') && JSON.stringify(ev.errors).includes('boom'));
    check('no-match is reported', JSON.stringify(ev.noMatch) === JSON.stringify([{ ruleId: 'gone', selector: '.gone' }]));
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
    for (const name of ['search_discovered_api', 'request_sources', 'probe_request', 'read_calls']) {
      const refused = await req(r, 'POST', `/sessions/${id}/call`, { name, input: {} });
      check(`${name} answers requires-shim-browser (no API map, no compositions)`, refused.error === 'requires-shim-browser', refused);
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

    // Commit.
    host.setUrl('https://elsewhere.test/');
    const awayCommit = await req(r, 'POST', `/sessions/${id}/commit`, { revision: 1, commitId: 'one', summary: 'Restyled rows; added two rules.' });
    check('a commit refuses once the page left the site, writing nothing', awayCommit.error === 'page-away' && r.writes.length === 0, awayCommit);
    host.setUrl(url);
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
    check('kept witnesses stay, new ones are captured', isRecord(witnessOf('hide-promo')) && isRecord(witnessOf('gone'))
      && JSON.stringify(witnessOf('row')).includes('TrackRow'), frules.map((x) => x.id));
    check('rules name handlers; sources are modules', isRecord(file.handlers) && typeof file.handlers.fetcher === 'string'
      && frules.every((x) => !('handlers' in x)));
    const history = Array.isArray(file.authoringHistory) ? file.authoringHistory.filter(isRecord) : [];
    check('the history keeps what was there and appends the exchange', history.length === 3 && history[0]?.content === 'earlier'
      && history[1]?.content === 'Tidy up' && history[1]?.agent === 'Claude Code' && history[2]?.versionId === 5, history);
    const nothing = await req(r, 'POST', `/sessions/${id}/commit`, { revision: 1, commitId: 'three', summary: 's' });
    check('committing the committed revision again is nothing-to-commit', nothing.error === 'nothing-to-commit');

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
