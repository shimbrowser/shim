// shim-session-harness — the host-parameterized parts of the shared shim
// session (packages/core/src/shim-session.ts) that headless does not use:
// a host that does NOT preview the committed rules at begin (an installed
// shim already runs them), where a removed rule becomes a tombstone the host
// is asked to hold, and where a hold the host could not take drops the
// tombstone and names the rule in the preview evidence.
//
//   node out/packages/core/test/shim-session-harness.js

import { createShimSessionBackend, pageAway, type ShimSessionHandle, type ShimSessionSource, type ShimSessionTarget, type PreparedCommit, type CommitWrite } from '../src/shim-session';
import type { PageHost, PreviewRule, PageRuntimeEvent, PageConsoleMessage, PageLoadOutcome, LoadWaitOptions } from '../src/page-host';
import { encodeWorkingCopy } from '../src/working-copy-wire';
import { checkoutShim } from '../src/shim-folder';
import type { Spec } from '../src/types';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

const CAPS = Object.freeze({
  mutationKinds: Object.freeze(['hide', 'restyle', 'reorder', 'reshape', 'remove', 'inject-element', 'inject-html', 'script', 'replace-root']),
  iframeRules: false, specCss: false, pathScope: true, apiMembers: Object.freeze([]), componentIdentity: false, engineInspection: false, trustedInput: true,
});

function fakeHost(): PageHost {
  const runtime = new Set<(e: PageRuntimeEvent) => void>();
  const consoleL = new Set<(m: PageConsoleMessage) => void>();
  let world: Record<string, unknown> = {};
  const host: PageHost = {
    capabilities: CAPS as unknown as PageHost['capabilities'],
    url: () => 'https://site.test/apply',
    isClosed: () => false,
    async evaluate(code) {
      if (code.includes('deployIdForDocument')) return 'deploy-1';
      const write = /globalThis\[(".*?")\] = (".*")$/.exec(code);
      if (write && write[1] && write[2]) { const k = JSON.parse(write[1]) as string; world[k] = JSON.parse(write[2]) as unknown; return world[k]; }
      const read = /globalThis\[(".*?")\] \?\? null$/.exec(code);
      if (read && read[1]) return world[JSON.parse(read[1]) as string] ?? null;
      return null;
    },
    async screenshot() { return { error: 'no screenshots' }; },
    applyPreview(p: PreviewRule) { for (const l of [...runtime]) l({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: 1, matchedVia: 'primary', box: { x: 0, y: 0, w: 1, h: 1 } }); },
    removePreview() { /* nothing */ },
    onRuntimeEvent(l) { runtime.add(l); return () => { runtime.delete(l); }; },
    onConsole(l) { consoleL.add(l); return () => { consoleL.delete(l); }; },
    reload() { world = {}; },
    async waitForLoad(_o: LoadWaitOptions): Promise<PageLoadOutcome> { return { kind: 'finished' }; },
    async documentToken() { return null; },
  };
  return host;
}

interface Source extends ShimSessionSource { shimId: string }

function makeBackend(opts: { holds: Map<string, boolean>; toldHeld: Array<[string, boolean]>; writes: PreparedCommit[] }) {
  return createShimSessionBackend<Source>({
    settleMs: 0,
    unsupportedError: 'unsupported-here',
    unsupportedDetail: 'a subset',
    unsupportedNote: (ruleId, member) => `${ruleId}/${member}`,
    previewCommittedAtBegin: false,
    async tombstone(_handle, ruleId, held): Promise<boolean> {
      opts.toldHeld.push([ruleId, held]);
      // `holds` maps a ruleId to whether its hold takes; default true.
      return held ? (opts.holds.get(ruleId) ?? true) : true;
    },
    async writeCommit(_handle, prepared): Promise<CommitWrite> {
      opts.writes.push(prepared);
      return { ok: true, versionId: prepared.version };
    },
  });
}

const spec: Spec = {
  id: 'shim-x', version: 1, bundleHash: 'b1', match: { hosts: ['site.test'] },
  rules: [
    { id: 'hide-ad', anchor: { primary: { kind: 'css', value: '#ad' } }, mutations: [{ kind: 'hide' }] },
    { id: 'tag', anchor: { primary: { kind: 'css', value: '#t' } }, mutations: [{ kind: 'restyle', properties: { outline: '1px solid red' } }] },
  ],
};

async function folderEditing(ruleId: string): Promise<unknown> {
  const files = checkoutShim({ spec, handlers: {} });
  const sj = JSON.parse(files['shim.json'] as string) as { rules: Array<{ id: string; mutations: Array<Record<string, unknown>> }> };
  const rule = sj.rules.find((r) => r.id === ruleId);
  if (rule) rule.mutations = [{ kind: 'hide' }];
  files['shim.json'] = JSON.stringify(sj);
  return encodeWorkingCopy(files);
}

async function folderRemoving(ruleId: string): Promise<unknown> {
  const files = checkoutShim({ spec, handlers: {} });
  const sj = JSON.parse(files['shim.json'] as string) as { rules: Array<{ id: string }> };
  sj.rules = sj.rules.filter((r) => r.id !== ruleId);
  files['shim.json'] = JSON.stringify(sj);
  return encodeWorkingCopy(files);
}

async function openSession(backend: ReturnType<typeof makeBackend>) {
  const source: Source = { shimId: 'shim-x', name: 'X', spec, handlers: {}, envelope: {}, created: false };
  const target: ShimSessionTarget<Source> = { page: { host: fakeHost(), close: async () => undefined }, source };
  const lease = { signal: new AbortController().signal, release: () => undefined };
  return backend.begin({ sessionId: 's1', artifactId: 'shim-x', target, agent: 'a', intent: 'i', created: false, mint: null, lease, signal: new AbortController().signal }) as Promise<ShimSessionHandle<Source>>;
}

async function main(): Promise<void> {
  console.log('begin applies nothing when the host installs the shim:');
  {
    const opts = { holds: new Map<string, boolean>(), toldHeld: [] as Array<[string, boolean]>, writes: [] as PreparedCommit[] };
    const backend = makeBackend(opts);
    const applied: PreviewRule[] = [];
    const host = fakeHost();
    const orig = host.applyPreview.bind(host);
    host.applyPreview = (p) => { applied.push(p); orig(p); };
    const source: Source = { shimId: 'shim-x', name: 'X', spec, handlers: {}, envelope: {}, created: false };
    const target: ShimSessionTarget<Source> = { page: { host, close: async () => undefined }, source };
    const lease = { signal: new AbortController().signal, release: () => undefined };
    await backend.begin({ sessionId: 's0', artifactId: 'shim-x', target, agent: 'a', intent: 'i', created: false, mint: null, lease, signal: new AbortController().signal });
    check('no preview is applied at begin', applied.length === 0);
  }

  console.log('a removed rule is a tombstone the host holds:');
  {
    const opts = { holds: new Map<string, boolean>(), toldHeld: [] as Array<[string, boolean]>, writes: [] as PreparedCommit[] };
    const backend = makeBackend(opts);
    const handle = await openSession(backend);
    const out = await backend.preview(handle, { workingCopy: await folderRemoving('tag') }, new AbortController().signal);
    const ev = out.evidence as { applied: boolean; notes?: string[] };
    check('the removal applies', out.applied && ev.applied);
    check('the host was asked to hold the removed rule', opts.toldHeld.some(([id, held]) => id === 'tag' && held));
    check('the tombstone is kept when the hold takes', handle.tombstones.has('tag'));
    check('no un-held note when the hold took', !(ev.notes ?? []).some((n) => /could not hold/.test(n)));
  }

  console.log('a hold the host could not take drops the tombstone and is named:');
  {
    const opts = { holds: new Map<string, boolean>([['tag', false]]), toldHeld: [] as Array<[string, boolean]>, writes: [] as PreparedCommit[] };
    const backend = makeBackend(opts);
    const handle = await openSession(backend);
    const out = await backend.preview(handle, { workingCopy: await folderRemoving('tag') }, new AbortController().signal);
    const ev = out.evidence as { applied: boolean; notes?: string[]; changes?: string[] };
    check('the removal still applies (the authored change stands)', out.applied && (ev.changes ?? []).some((c) => /remove-rule tag/.test(c)));
    check('the tombstone is dropped', !handle.tombstones.has('tag'));
    check('the evidence names the rule as still running in the preview', (ev.notes ?? []).some((n) => /tag/.test(n) && /could not hold/.test(n)), JSON.stringify(ev.notes));
  }

  console.log('a rule the engine reported no status for is not verified:');
  {
    // The reported shape: one mid-file rule replaced by four, so the four and
    // every rule after them apply again; the page reports a status for only
    // some of them inside the preview's window.
    const opts = { holds: new Map<string, boolean>(), toldHeld: [] as Array<[string, boolean]>, writes: [] as PreparedCommit[] };
    const backend = makeBackend(opts);
    const host = fakeHost();
    const orig = host.applyPreview.bind(host);
    const reporting = new Set(['b1', 'last']);
    host.applyPreview = (p) => { if (reporting.has(p.rule.id)) orig(p); };
    const source: Source = { shimId: 'shim-x', name: 'X', spec, handlers: {}, envelope: {}, created: false };
    const target: ShimSessionTarget<Source> = { page: { host, close: async () => undefined }, source };
    const lease = { signal: new AbortController().signal, release: () => undefined };
    const handle = await backend.begin({ sessionId: 's9', artifactId: 'shim-x', target, agent: 'a', intent: 'i', created: false, mint: null, lease, signal: new AbortController().signal }) as ShimSessionHandle<Source>;
    const hide = (id: string, sel: string) => ({ id, anchor: { primary: { kind: 'css', value: sel } }, mutations: [{ kind: 'hide' }] });
    const write = async (ids: Array<[string, string]>): Promise<unknown> => {
      const files = checkoutShim({ spec, handlers: {} });
      const sj = JSON.parse(files['shim.json'] as string) as { rules: unknown[] };
      sj.rules = ids.map(([id, sel]) => hide(id, sel));
      files['shim.json'] = JSON.stringify(sj);
      return encodeWorkingCopy(files);
    };
    await backend.preview(handle, { workingCopy: await write([['hide-ad', '#ad'], ['mid', '#m'], ['tag', '#t'], ['last', '#l']]) }, new AbortController().signal);
    const out = await backend.preview(handle, {
      workingCopy: await write([['hide-ad', '#ad'], ['b1', '.b1'], ['b2', '.b2'], ['b3', '.b3'], ['b4', '.b4'], ['tag', '#t'], ['last', '#l']]),
    }, new AbortController().signal);
    const rules = (out.evidence as { rules: Array<{ ruleId: string; status: string; verification: string }> }).rules;
    const by = new Map(rules.map((r) => [r.ruleId, r]));
    check('the four new rules and every rule after them are in the evidence',
      ['b1', 'b2', 'b3', 'b4', 'tag', 'last'].every((id) => by.has(id)), JSON.stringify(rules));
    check('a rule that reported a status keeps full verification', by.get('b1')?.verification === 'full' && by.get('last')?.verification === 'full', JSON.stringify(rules));
    const silent = ['b2', 'b3', 'b4', 'tag'].map((id) => by.get(id));
    check('a rule with no status event is verification none, never full',
      silent.every((r) => r?.verification === 'none' && /no status event/.test(r.status)), JSON.stringify(silent));
  }

  console.log('the prepared commit carries the ops and the history:');
  {
    const opts = { holds: new Map<string, boolean>(), toldHeld: [] as Array<[string, boolean]>, writes: [] as PreparedCommit[] };
    const backend = makeBackend(opts);
    const handle = await openSession(backend);
    await backend.preview(handle, { workingCopy: await folderRemoving('tag') }, new AbortController().signal);
    await backend.commit(handle, { revision: 1, summary: 'drop tag', signal: new AbortController().signal });
    const prepared = opts.writes[0];
    check('the prepared commit carries the ops since base', prepared !== undefined && prepared.opsSinceBase.some((o) => o.op === 'remove-rule' && o.ruleId === 'tag'));
    const history = prepared?.history ?? [];
    check('the prepared history has the external exchange with the intent and summary', history.length >= 2 && JSON.stringify(history).includes('drop tag') && JSON.stringify(history).includes('"external":true'), JSON.stringify(history));
  }

  console.log('a commit retires the replay set when the host installs the shim:')
  {
    const opts = { holds: new Map<string, boolean>(), toldHeld: [] as Array<[string, boolean]>, writes: [] as PreparedCommit[] };
    const backend = makeBackend(opts);
    const handle = await openSession(backend);
    await backend.preview(handle, { workingCopy: await folderRemoving('tag') }, new AbortController().signal);
    // Previewing the committed rules leaves live entries (the agent edited one).
    await backend.preview(handle, { workingCopy: await folderEditing('hide-ad') }, new AbortController().signal);
    check('the session has live previews before the commit', handle.live.size > 0);
    await backend.commit(handle, { revision: 2, summary: 's', signal: new AbortController().signal });
    check('the commit clears the replay set (the committed form runs installed, not replayed)', handle.live.size === 0 && handle.captures.size === 0);
  }

  console.log('a host that commits at a higher version (a rebase) is followed:')
  {
    // writeCommit adopts a spec two versions ahead of core's proposal (a
    // rebase advanced the stored shim before the merge).
    const adopted: Array<number> = [];
    const backend = createShimSessionBackend<Source>({
      settleMs: 0, unsupportedError: 'u', unsupportedDetail: 'd', unsupportedNote: () => 'n', previewCommittedAtBegin: false,
      async writeCommit(_h, prepared): Promise<CommitWrite> {
        adopted.push(prepared.version);
        // Core proposed `prepared.version`; the host commits two ahead.
        const committed = prepared.version + 2;
        const next = { ...prepared.file.spec, version: committed } as Spec;
        return { ok: true, versionId: committed, adopted: { spec: next, handlers: prepared.file.handlers } };
      },
    });
    const handle = await openSession(backend);
    await backend.preview(handle, { workingCopy: await folderRemoving('tag') }, new AbortController().signal);
    const first = await backend.commit(handle, { revision: 1, summary: 'one', signal: new AbortController().signal });
    check('the reply names the committed version, not core\'s proposal', first.ok && first.versionId === 4, JSON.stringify(first));
    const hist = (handle.envelope.authoringHistory ?? []) as Array<{ role: string; versionId?: number }>;
    const assistant = hist.find((e) => e.role === 'assistant');
    check('the persisted history entry is stamped with the committed version', assistant?.versionId === 4, JSON.stringify(assistant));
    check('the continuing handle is at the committed version', handle.version === 4);
    // A second change in the same session proposes the next version after
    // the one actually committed.
    await backend.preview(handle, { workingCopy: await folderRemoving('hide-ad') }, new AbortController().signal);
    await backend.commit(handle, { revision: 2, summary: 'two', signal: new AbortController().signal });
    check('a second commit proposes the version after the committed one', adopted[1] === 5, JSON.stringify(adopted));
  }

  console.log('the page-away guard uses the committed hosts, not the working copy:')
  {
    const opts = { holds: new Map<string, boolean>(), toldHeld: [] as Array<[string, boolean]>, writes: [] as PreparedCommit[] };
    const backend = makeBackend(opts);
    const handle = await openSession(backend);
    // The page moved to a host the committed shim does not cover, and the
    // agent widened the working copy's match.hosts to include it.
    handle.host.url = () => 'https://evil.test/x';
    handle.working = { ...handle.working, match: { hosts: ['site.test', 'evil.test'] } };
    check('a working copy that widened match.hosts does not make the page on-site', pageAway(handle) !== null);
    // The committed hosts still count: a page the base covers is on-site.
    handle.host.url = () => 'https://site.test/other';
    check('a page the committed shim covers is on-site', pageAway(handle) === null);
  }

  console.log('evaluate_in_page takes the caller\'s timeoutMs and the session\'s signal:');
  {
    const opts = { holds: new Map<string, boolean>(), toldHeld: [] as Array<[string, boolean]>, writes: [] as PreparedCommit[] };
    const backend = makeBackend(opts);
    const handle = await openSession(backend);
    // The page's answer to the evaluate wrapper arrives after `delayMs`; every
    // other script (the session's own reads) answers as the fake host does.
    let delayMs = 60;
    let wrapperRuns = 0;
    const base = handle.host.evaluate.bind(handle.host);
    handle.host.evaluate = (code, world) => {
      if (!code.includes('__ss(')) return base(code, world);
      wrapperRuns++;
      if (delayMs === Number.POSITIVE_INFINITY) return new Promise(() => { /* the page never answers */ });
      return new Promise((r) => setTimeout(() => r(JSON.stringify({ result: 'waited' })), delayMs));
    };
    const call = (input: unknown, signal = new AbortController().signal): Promise<unknown> =>
      backend.call(handle, 'evaluate_in_page', input, signal);
    const parse = (raw: unknown): Record<string, unknown> => JSON.parse(String(raw)) as Record<string, unknown>;

    const refused = parse(await call({ expression: '1', timeoutMs: 10_001 }));
    check('a timeoutMs over the ceiling is refused before the page runs anything', typeof refused.error === 'string'
      && refused.error.includes('1 to 10000') && wrapperRuns === 0, JSON.stringify(refused));
    const fraction = parse(await call({ expression: '1', timeoutMs: 2.5 }));
    check('a fractional timeoutMs is refused', typeof fraction.error === 'string' && wrapperRuns === 0, JSON.stringify(fraction));
    const ok = parse(await call({ expression: '1', timeoutMs: 500 }));
    check('a wait inside the given timeoutMs answers its value', ok.result === '"waited"', JSON.stringify(ok));
    const short = parse(await call({ expression: '1', timeoutMs: 20 }));
    check('the given timeoutMs is the one applied', short.error === 'evaluateInPage timeout', JSON.stringify(short));
    const dflt = parse(await call({ expression: '1' }));
    check('no timeoutMs: the default (well over this wait)', dflt.result === '"waited"', JSON.stringify(dflt));

    // The session ends while the page works: the call answers at once, not
    // when the evaluate's own deadline passes.
    delayMs = Number.POSITIVE_INFINITY;
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 20);
    const ended = parse(await call({ expression: '1', timeoutMs: 10_000 }, ac.signal));
    check('ending the session settles a pending evaluate at once', ended.error === 'session-ended' && Date.now() - started < 2000,
      `${JSON.stringify(ended)} after ${Date.now() - started}ms`);
  }

  if (failures) {
    console.error(`\nshim-session: ${failures} failed, ${passes} passed`);
    process.exit(1);
  }
  console.log(`shim-session: all ${passes} checks passed`);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
