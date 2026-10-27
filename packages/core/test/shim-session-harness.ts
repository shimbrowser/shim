// shim-session-harness — the host-parameterized parts of the shared shim
// session (packages/core/src/shim-session.ts) that headless does not use:
// a host that does NOT preview the committed rules at begin (an installed
// shim already runs them), where a removed rule becomes a tombstone the host
// is asked to hold, and where a hold the host could not take drops the
// tombstone and names the rule in the preview evidence.
//
//   node out/packages/core/test/shim-session-harness.js

import { createShimSessionBackend, type ShimSessionHandle, type ShimSessionSource, type ShimSessionTarget, type PreparedCommit, type CommitWrite } from '../src/shim-session';
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
  iframeRules: false, specCss: false, apiMembers: Object.freeze([]), componentIdentity: false, engineInspection: false, trustedInput: true,
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

  if (failures) {
    console.error(`\nshim-session: ${failures} failed, ${passes} passed`);
    process.exit(1);
  }
  console.log(`shim-session: all ${passes} checks passed`);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
