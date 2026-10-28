// sessions-harness — the worker's session wiring (packages/extension/src/sessions.ts)
// over fakes: the merge (mergeCommit) and the commit's cancellation guard.
// The full open/preview/commit loop against a real browser is the e2e;
// this pins the pure merge and the abort-before-write contract without one.
//
//   node out/packages/extension/test/sessions-harness.ts

import { createSessions, mergeCommit, type SessionsDeps } from '../src/sessions';
import type { ExtensionPageHost, NudgeOutcome } from '../src/page-host';
import type { InstalledShim, ShimStore } from '../src/store';
import type { Spec } from '@shimbrowser/core/types';
import type { PageRuntimeEvent, PageConsoleMessage, PageLoadOutcome, LoadWaitOptions } from '@shimbrowser/core/page-host';
import { encodeWorkingCopy } from '@shimbrowser/core/working-copy-wire';
import { checkoutShim } from '@shimbrowser/core/shim-folder';
import type { Rule } from '@shimbrowser/core/types';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

const CAPS = Object.freeze({
  mutationKinds: Object.freeze(['hide', 'restyle', 'script', 'replace-root']),
  iframeRules: false, specCss: false, apiMembers: Object.freeze([]), componentIdentity: false, engineInspection: false, trustedInput: true,
});

const baseSpec = (): Spec => ({
  id: 'shim-1', version: 1, bundleHash: 'b1', match: { hosts: ['site.test'] },
  rules: [
    { id: 'a', anchor: { primary: { kind: 'css', value: '#a' } }, mutations: [{ kind: 'hide' }] },
    { id: 'b', anchor: { primary: { kind: 'css', value: '#b' } }, mutations: [{ kind: 'restyle', properties: { color: 'red' } }] },
  ],
});

console.log('mergeCommit:');
{
  const stored = { spec: baseSpec(), handlers: {} };
  const base = baseSpec();
  // Edit rule a; untouched rule b keeps the stored form (with any managed state).
  const ruleB = baseSpec().rules?.[1] as Rule;
  const editedA: Rule = { id: 'a', anchor: { primary: { kind: 'css', value: '#a2' } }, mutations: [{ kind: 'hide' }] };
  const working: Spec = { ...baseSpec(), rules: [editedA, ruleB] };
  const m = mergeCommit(stored, base, [{ op: 'update-rule', rule: editedA }], { spec: working, handlers: {} });
  check('an authored edit merges onto the stored spec', m.ok && (m.spec.rules?.find((r) => r.id === 'a')?.anchor?.primary.value) === '#a2');
  // A rebase of the edited rule since the base is a conflict.
  const rebasedA: Rule = { id: 'a', anchor: { primary: { kind: 'css', value: '#a-rebased' } }, mutations: [{ kind: 'hide' }] };
  const rebased = { spec: { ...baseSpec(), rules: [rebasedA, ruleB] }, handlers: {} };
  const c = mergeCommit(rebased, base, [{ op: 'update-rule', rule: editedA }], { spec: working, handlers: {} });
  check('an edit of a rule rebased since the base is a conflict', !c.ok && c.conflicts.includes('a'));
  // A witness-only amendment of the edited rule is not a conflict.
  const witnessedA: Rule = { id: 'a', anchor: { primary: { kind: 'css', value: '#a' }, witness: { v: 1, tag: 'div' } as never }, mutations: [{ kind: 'hide' }] };
  const witnessed = { spec: { ...baseSpec(), rules: [witnessedA, ruleB] }, handlers: {} };
  const w = mergeCommit(witnessed, base, [{ op: 'update-rule', rule: editedA }], { spec: working, handlers: {} });
  check('a witness-only amendment of the edited rule is not a conflict', w.ok);
  // A commit never changes which sites the shim runs on: the merged spec
  // keeps the stored shim's match, whatever the working copy carries.
  const widened: Spec = { ...baseSpec(), match: { hosts: ['site.test', 'evil.test'] }, rules: [editedA, ruleB] };
  const m2 = mergeCommit(stored, base, [{ op: 'update-rule', rule: editedA }], { spec: widened, handlers: {} });
  check('a commit cannot widen match.hosts', m2.ok && JSON.stringify(m2.spec.match?.hosts) === JSON.stringify(stored.spec.match?.hosts), m2.ok ? JSON.stringify(m2.spec.match) : 'conflict');
}

// A fake ExtensionPageHost for the session target.
function fakeHost(): ExtensionPageHost {
  const runtime = new Set<(e: PageRuntimeEvent) => void>();
  let world: Record<string, unknown> = {};
  const host: ExtensionPageHost = {
    tabId: 1,
    capabilities: CAPS as unknown as ExtensionPageHost['capabilities'],
    url: () => 'https://site.test/p',
    isClosed: () => false,
    async evaluate(code) {
      if (code.includes('deployIdForDocument')) return 'b1';
      const w = /globalThis\[(".*?")\] = (".*")$/.exec(code);
      if (w && w[1] && w[2]) { const k = JSON.parse(w[1]) as string; world[k] = JSON.parse(w[2]) as unknown; return world[k]; }
      const r = /globalThis\[(".*?")\] \?\? null$/.exec(code);
      if (r && r[1]) return world[JSON.parse(r[1]) as string] ?? null;
      // the syntax probe: everything parses
      if (code.includes('eval(')) return null;
      return null;
    },
    async screenshot() { return { error: 'none' }; },
    applyPreview(p) { for (const l of [...runtime]) l({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: 1, matchedVia: 'primary', box: { x: 0, y: 0, w: 1, h: 1 } }); },
    removePreview() { /* */ },
    onRuntimeEvent(l) { runtime.add(l); return () => { runtime.delete(l); }; },
    onConsole(_l: (m: PageConsoleMessage) => void) { return () => undefined; },
    reload() { world = {}; },
    async waitForLoad(_o: LoadWaitOptions): Promise<PageLoadOutcome> { return { kind: 'finished' }; },
    async documentToken() { return null; },
    heldFor: () => [],
    heldAll: () => ({}),
    async holdOnly() { return 'acked' as NudgeOutcome; },
    async releaseOnly() { return 'acked' as NudgeOutcome; },
    async retainHolds() { /* */ },
    async releaseHolds() { return 'acked' as NudgeOutcome; },
    onClosed() { return () => undefined; },
    async close() { /* */ },
  };
  return host;
}

interface FakeStore {
  shim: InstalledShim;
  revisions: number;
  gateGetShim: Promise<void> | null;
  onGetShim: (() => void) | null;
  store: Pick<ShimStore, 'getShim' | 'reviseSpec' | 'ruleState'>;
}

function fakeStore(): FakeStore {
  const f: FakeStore = {
    shim: { id: 'shim-1', name: 'S', enabled: true, installedAt: 0, rank: 1, provenance: { source: 'file' }, mode: 'full', spec: baseSpec(), handlers: {}, envelope: {} },
    revisions: 0,
    gateGetShim: null,
    onGetShim: null,
    store: null as unknown as FakeStore['store'],
  };
  f.store = {
    async getShim() { f.onGetShim?.(); if (f.gateGetShim) await f.gateGetShim; return f.shim; },
    async reviseSpec(_id, next, handlers, _reason, _expected, opts) {
      f.revisions += 1;
      f.shim = { ...f.shim, spec: next, handlers, ...(opts?.envelope ? { envelope: opts.envelope } : {}) };
      return true;
    },
    ruleState: { async get() { return null; }, async put() { /* */ }, async listForShim() { return []; } },
  };
  return f;
}

function makeSessions(f: FakeStore) {
  const deps: SessionsDeps = {
    store: async () => f.store as unknown as ShimStore,
    mode: () => 'full',
    chained: (_id, work) => work(),
    syncTab: async () => 'acked',
    refreshTabs: async () => undefined,
    removeDraft: async () => undefined,
  };
  return createSessions(deps);
}

async function openAndPreview(sessions: ReturnType<typeof makeSessions>, host: ExtensionPageHost) {
  const target = { page: { host, close: async () => undefined }, source: { shimId: 'shim-1', name: 'S', spec: baseSpec(), handlers: {}, envelope: {}, created: false }, committedDown: null };
  const opened = await sessions.registry.open({ kind: 'shim', artifactId: 'shim-1', target, agent: 'a', intent: 'i' });
  if (!opened.ok) throw new Error(`open failed: ${opened.error}`);
  const id = opened.sessionId;
  // Edit rule a.
  const files = checkoutShim({ spec: baseSpec(), handlers: {} });
  const sj = JSON.parse(files['shim.json'] as string) as { rules: Array<{ id: string; anchor: { primary: { value: string } } }> };
  const ra = sj.rules.find((r) => r.id === 'a');
  if (ra) ra.anchor.primary.value = '#a2';
  files['shim.json'] = JSON.stringify(sj);
  const prev = await sessions.registry.preview(id, { workingCopy: encodeWorkingCopy(files) });
  if (!prev.ok || !prev.applied) throw new Error('preview did not apply');
  return { id, revision: prev.revision };
}

async function main(): Promise<void> {
  console.log('a session ended during the commit read does not write:');
  {
    const f = fakeStore();
    const sessions = makeSessions(f);
    const host = fakeHost();
    const { id, revision } = await openAndPreview(sessions, host);
    // Gate getShim so the commit parks inside the write chain after its
    // first abort check. End the session while the read is in flight, then
    // release it so the backend continuation runs the post-read abort check
    // inside end's settle window — not after it times out. Await both before
    // inspecting the store, so this fails if the post-read guard is removed.
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const enteredRead = new Promise<void>((r) => { entered = r; });
    f.onGetShim = () => entered();
    f.gateGetShim = new Promise<void>((r) => { release = r; });
    const committing = sessions.registry.commit(id, { revision, commitId: 'c1', summary: 's' });
    await enteredRead;
    const ending = sessions.registry.end(id, 'ended');
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [out] = await Promise.all([committing, ending]);
    check('the commit answers session-ended', !out.ok && out.error === 'session-ended', JSON.stringify(out));
    check('no revision was written', f.revisions === 0, String(f.revisions));
  }

  console.log('a commit with the session live writes once:');
  {
    const f = fakeStore();
    const sessions = makeSessions(f);
    const host = fakeHost();
    const { id, revision } = await openAndPreview(sessions, host);
    const out = await sessions.registry.commit(id, { revision, commitId: 'c1', summary: 's' });
    await sessions.settleActivation(id);
    check('the commit succeeds and writes one revision', out.ok && f.revisions === 1, JSON.stringify(out));
    check('the written shim carries the edit and the authoring history', (f.shim.spec.rules?.find((r) => r.id === 'a')?.anchor?.primary.value) === '#a2' && Array.isArray(f.shim.envelope.authoringHistory), JSON.stringify(f.shim.envelope));
    await sessions.registry.end(id, 'ended');
  }

  if (failures) {
    console.error(`\nsessions: ${failures} failed, ${passes} passed`);
    process.exit(1);
  }
  console.log(`sessions: all ${passes} checks passed`);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
