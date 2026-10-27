// Authoring sessions in the service worker: @shimbrowser/core's session
// registry over core's shim session (the page half every host shares),
// bound to this host: a tab's PageHost (page-host.ts) as the page, the
// installed shim as the artifact, IndexedDB as where commits go.
//
//   - The lease is in-worker and exclusive per shim id; preempting it (an
//     uninstall or restore from the popup) ends the session, and the caller
//     waits for the teardown before it writes.
//   - begin applies nothing: the committed rules already run as the
//     installed shim. A disabled shim, or one the mode in force does not
//     run, opens too, and the agent is told its committed rules are not up.
//   - A commit replays the ops applied since the session's base onto the
//     shim as stored now, inside the worker's per-shim write chain, so what
//     other tabs learned meanwhile on untouched rules survives; a rule both
//     rebased since and edited here is a conflict, answered with a reset.
//     The durable write is the commit; activation (previews off while the
//     claims stay, the tab's runtime synced to the new version, the claims
//     released) is a follow-up every later op and the finish wait for.
//   - Handler syntax is checked in the session's world (the worker's CSP
//     permits no eval) before packing, and packShim takes the result.
//   - interact_page is refused on this host (its input policy is not built);
//     browser-only tools answer requires-shim-browser.

import type { Spec, Rule } from '@shimbrowser/core/types';
import type { PageHost } from '@shimbrowser/core/page-host';
import { createSessionRegistry, LEASE_TIMEOUT, BeginRefusal, TargetChangedError, type SessionLease, type SessionLeases, type SessionRegistry, type SessionBackend } from '@shimbrowser/core/session-registry';
import {
  createShimSessionBackend, type ShimSessionSource, type ShimSessionTarget, type ShimSessionHandle, type PreparedCommit, type CommitWrite,
} from '@shimbrowser/core/shim-session';
import { anchorDigest, withoutManagedKeys } from '@shimbrowser/core/managed-anchor';
import { referencedHandlerNames } from '@shimbrowser/core/shim-folder';
import { ruleModules } from '@shimbrowser/core/rule-form';
import { preflightSpec } from '@shimbrowser/core/capability-preflight';
import { isApiMapToolName } from '@shimbrowser/core/api-map-tools';
import { isDataToolName } from '@shimbrowser/core/data-tools';
import { isCompositionSessionToolName } from '@shimbrowser/core/composition-session-tools';
import type { DeltaOp } from '@shimbrowser/core/spec-delta';
import type { ExtensionPageHost, NudgeOutcome } from './page-host';
import type { ShimStore, InstalledShim } from './store';
import { capabilitiesFor, UNSUPPORTED_ERROR, HOW_TO_ENABLE, type ExtensionMode } from './capabilities';

export const REQUIRES_SHIM_BROWSER = 'requires-shim-browser';
/** How long a commit's activation waits for the tab's runtime to run the new version. */
export const ACTIVATION_WAIT_MS = 5000;

/** What a session starts from: the installed shim as stored. */
export interface ExtensionShimSource extends ShimSessionSource {
  shimId: string;
}

export type ExtensionSessionHandle = ShimSessionHandle<ExtensionShimSource>;

export interface ExtensionSessionPage {
  host: ExtensionPageHost;
  close(): Promise<void>;
}

/** The registry's target: the tab's host, the shim, and what the agent should know at open. */
export interface ExtensionSessionTarget extends ShimSessionTarget<ExtensionShimSource> {
  page: ExtensionSessionPage;
  /** The shim's committed rules are not running on the page (disabled, or outside the mode in force). */
  committedDown: string | null;
}

export interface SessionsDeps {
  store(): Promise<ShimStore>;
  mode(): ExtensionMode;
  /** Runs `work` in the shim's write chain (no rebase or fingerprint write interleaves). */
  chained<T>(shimId: string, work: () => Promise<T>): Promise<T>;
  /** Nudge the tab's committed runtime to sync; acked once it runs `version` of `shimId`. */
  syncTab(tabId: number, shimId: string, version: number): Promise<NudgeOutcome>;
  /** The other open tabs look again at the shim. */
  refreshTabs(shim: InstalledShim): Promise<void>;
  /** Remove a draft shim a session created and never committed (its finish). */
  removeDraft(shimId: string): Promise<void>;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  newId?(): string;
}

export interface Sessions {
  registry: SessionRegistry;
  /** End the session holding `shimId`, if any, and wait for its teardown. */
  preempt(shimId: string): Promise<void>;
  /** Pending notes of a session (activation reports), taken once. */
  takeNotes(sessionId: string): string[];
  /** Wait for a session's activation task, if one runs. */
  settleActivation(sessionId: string): Promise<void>;
}

interface LeaseEntry {
  controller: AbortController;
  released: Promise<void>;
  release(): void;
}

// One holder per shim id, never queued; preempt aborts the holder's signal
// (the registry ends the session) and resolves once it let go.
function exclusiveLeases(): SessionLeases & { preempt(key: string): Promise<void> } {
  const held = new Map<string, LeaseEntry>();
  return {
    async acquire(key) {
      if (held.has(key)) throw new Error(LEASE_TIMEOUT);
      const controller = new AbortController();
      let done: () => void = () => undefined;
      const released = new Promise<void>((resolve) => { done = resolve; });
      let over = false;
      const entry: LeaseEntry = {
        controller,
        released,
        release() {
          if (over) return;
          over = true;
          held.delete(key);
          done();
        },
      };
      held.set(key, entry);
      const lease: SessionLease = { signal: controller.signal, release: () => entry.release() };
      return lease;
    },
    async preempt(key) {
      const entry = held.get(key);
      if (!entry) return;
      entry.controller.abort();
      await entry.released;
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function specVersion(spec: { version?: unknown }): number {
  return typeof spec.version === 'number' && Number.isFinite(spec.version) ? spec.version : 1;
}

function authoredDigest(rule: Rule | undefined): string {
  return rule?.anchor ? anchorDigest(withoutManagedKeys(rule.anchor)) : '';
}

export type Merge =
  | { ok: true; spec: Spec; handlers: Record<string, string> }
  | { ok: false; conflicts: string[] };

/**
 * The commit as a replay of the session's ops onto the shim as stored now.
 * Each op'd rule takes its final working form (the preview's last capture
 * included); untouched rules stay as stored, with what they learned since.
 * A rule edited or removed here whose stored authored anchor differs from
 * the session's base (a rebase since) is a conflict. Pure.
 */
export function mergeCommit(stored: { spec: Spec; handlers: Record<string, string> }, base: Spec, ops: readonly DeltaOp[], working: { spec: Spec; handlers: Record<string, string> }): Merge {
  const storedRules = new Map((stored.spec.rules ?? []).map((r) => [r.id, r]));
  const baseRules = new Map((base.rules ?? []).map((r) => [r.id, r]));
  const workingRules = new Map((working.spec.rules ?? []).map((r) => [r.id, r]));
  const conflicts = new Set<string>();
  const touched = new Set<string>();
  const removed = new Set<string>();
  for (const op of ops) {
    const id = op.op === 'remove-rule' ? op.ruleId : op.rule?.id;
    if (typeof id !== 'string') continue;
    const inStored = storedRules.get(id);
    const inBase = baseRules.get(id);
    if (inBase && inStored && authoredDigest(inStored) !== authoredDigest(inBase)) conflicts.add(id);
    if (op.op === 'remove-rule') { removed.add(id); touched.delete(id); } else { touched.add(id); removed.delete(id); }
  }
  if (conflicts.size) return { ok: false, conflicts: [...conflicts] };
  // The folder's order for the rules it has; stored rules it does not touch
  // keep their place.
  const order: string[] = [];
  for (const r of working.spec.rules ?? []) order.push(r.id);
  for (const r of stored.spec.rules ?? []) if (!order.includes(r.id) && !removed.has(r.id)) order.push(r.id);
  const rules: Rule[] = [];
  for (const id of order) {
    if (removed.has(id)) continue;
    const rule = touched.has(id) ? workingRules.get(id) : (storedRules.get(id) ?? workingRules.get(id));
    if (rule) rules.push(clone(rule));
  }
  const handlers: Record<string, string> = { ...stored.handlers };
  for (const id of touched) {
    const rule = workingRules.get(id);
    if (!rule) continue;
    for (const name of referencedHandlerNames(rule)) {
      if (Object.hasOwn(working.handlers, name)) handlers[name] = working.handlers[name] as string;
    }
  }
  const { rules: _rules, ...rest } = working.spec;
  const spec: Spec = { ...stored.spec, ...rest, rules };
  return { ok: true, spec, handlers };
}

export function createSessions(deps: SessionsDeps): Sessions {
  const leases = exclusiveLeases();
  const notes = new Map<string, string[]>();
  const activations = new Map<string, Promise<void>>();
  const note = (sessionId: string, text: string): void => {
    const list = notes.get(sessionId) ?? [];
    list.push(text);
    notes.set(sessionId, list);
  };
  // What the session's world says of a module's syntax, by the probe's
  // code: made just before a commit packs, read by the probe packShim runs.
  const syntaxChecks = new WeakMap<ExtensionSessionHandle, Map<string, { ok: boolean; error?: string }>>();
  let committing: ExtensionSessionHandle | null = null;

  // Keyed by the module's trimmed source: the probe is handed the module
  // wrapped (and the folder may have normalized its line ends), so the
  // wrapper is stripped and the source trimmed before the lookup.
  const PROBE_HEAD = '(function (module, exports) {\n';
  const PROBE_TAIL = '\n});';
  const moduleOfProbe = (code: string): string => (code.startsWith(PROBE_HEAD) && code.endsWith(PROBE_TAIL) ? code.slice(PROBE_HEAD.length, -PROBE_TAIL.length) : code).trim();
  async function checkSyntax(handle: ExtensionSessionHandle): Promise<void> {
    const results = new Map<string, { ok: boolean; error?: string }>();
    const host: PageHost = handle.host;
    // Every module the commit will pack: a rule's modules are its inline
    // handlers (read back to module form) over the stored ones, so an
    // edited handler riding inline on a working rule is checked too.
    const modules = new Map<string, string>();
    for (const rule of handle.working.rules ?? []) {
      for (const [name, source] of Object.entries(ruleModules(rule, handle.storedHandlers))) modules.set(name, source);
    }
    for (const [name, source] of Object.entries(handle.storedHandlers)) if (!modules.has(name)) modules.set(name, source);
    for (const [, source] of modules) {
      const code = `${PROBE_HEAD}${source}${PROBE_TAIL}`;
      try {
        const out = await host.evaluate(`(() => { try { (0, eval)(${JSON.stringify(code)}); return null; } catch (e) { return String(e && e.message || e); } })()`, 'engine');
        results.set(source.trim(), out === null ? { ok: true } : { ok: false, error: typeof out === 'string' ? out : 'syntax error' });
      } catch (e) {
        results.set(source.trim(), { ok: false, error: `could not be checked: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    syntaxChecks.set(handle, results);
  }

  const backend = createShimSessionBackend<ExtensionShimSource>({
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    unsupportedError: UNSUPPORTED_ERROR,
    unsupportedDetail: 'Shim for Chrome runs hide, restyle, reorder, reshape, remove, inject-element, inject-html, script and replace-root rules, with api.storage and api.cleanup. Nothing was applied. Remove what is listed, or author this shim in the Shim browser.',
    unsupportedNote: (ruleId, member) => `rule "${ruleId}" used api.${member}, which Shim for Chrome does not provide (${UNSUPPORTED_ERROR}) — its result is partial`,
    previewCommittedAtBegin: false,
    syntaxProbe: (code) => (committing && syntaxChecks.get(committing)?.get(moduleOfProbe(code))) ?? { ok: false, error: 'handler syntax was not checked in the page' },
    async tombstone(handle, ruleId, held) {
      const host = handle.page.host as ExtensionPageHost;
      if (held) await host.holdOnly(handle.source.shimId, ruleId);
      else await host.releaseOnly(handle.source.shimId, ruleId);
    },
    writeCommit: (handle, prepared, signal) => writeCommit(handle, prepared, signal),
  });
  async function writeCommit(handle: ExtensionSessionHandle, prepared: PreparedCommit, signal: AbortSignal): Promise<CommitWrite> {
    const shimId = handle.source.shimId;
    const db = await deps.store();
    const pre = preflightSpec(prepared.file.spec, capabilitiesFor(deps.mode()));
    if (!pre.ok) {
      return { ok: false, error: 'unsupported-in-mode', detail: `this shim needs what Shim for Chrome does not run in ${deps.mode()} mode: ${pre.unsupported.map((u) => u.message).join('; ')}. ${HOW_TO_ENABLE}` };
    }
    const host = handle.page.host as ExtensionPageHost;
    if (host.isClosed()) return { ok: false, error: 'page-closed', detail: 'the session\'s page closed; nothing was written' };
    const written = await deps.chained(shimId, async (): Promise<CommitWrite & { next?: Spec; shim?: InstalledShim }> => {
      if (signal.aborted) return { ok: false, error: 'session-ended' };
      const current = await db.getShim(shimId);
      if (!current) return { ok: false, error: 'unknown-artifact', detail: 'the shim was removed' };
      const merged = mergeCommit({ spec: current.spec, handlers: current.handlers }, handle.base.spec, prepared.opsSinceBase, { spec: prepared.file.spec, handlers: prepared.file.handlers });
      if (!merged.ok) {
        return {
          ok: false, error: 'conflict',
          detail: `the shim's rule${merged.conflicts.length === 1 ? '' : 's'} ${merged.conflicts.join(', ')} moved in the extension (a rebase) since this session began; the session was reset to the shim as it is now — check out again and redo the change`,
          reset: { spec: current.spec, handlers: current.handlers },
        };
      }
      const version = specVersion(current.spec) + 1;
      const next: Spec = { ...merged.spec, id: shimId, version, ...(typeof current.spec.bundleHash === 'string' ? { bundleHash: current.spec.bundleHash } : {}) };
      if (!(await db.reviseSpec(shimId, next, merged.handlers, 'commit', specVersion(current.spec), { clearDraft: true }))) {
        return { ok: false, error: 'commit-failed', detail: 'the shim changed while the commit was being written; try again' };
      }
      // The edited rules' reviews and captures no longer describe them.
      const edited = new Set(prepared.opsSinceBase.flatMap((op) => (op.op === 'remove-rule' ? [op.ruleId] : [op.rule?.id])).filter((id): id is string => typeof id === 'string'));
      for (const state of await db.ruleState.listForShim(shimId)) {
        if (edited.has(state.ruleId) && (state.quarantine || state.capture)) await db.ruleState.put({ ...state, quarantine: undefined, capture: undefined });
      }
      return { ok: true, versionId: version, next, shim: { ...current, spec: next, handlers: merged.handlers }, adopted: { spec: next, handlers: merged.handlers } };
    });
    if (!written.ok) return written;
    // Durable from here. Activation follows, outside the write chain.
    handle.source = { ...handle.source, created: false };
    const next = written.next as Spec;
    const shim = written.shim as InstalledShim;
    activations.set(handle.sessionId, activate(handle, shim, next).catch((e: unknown) => {
      note(handle.sessionId, `activation failed: ${e instanceof Error ? e.message : String(e)}`);
    }).finally(() => { activations.delete(handle.sessionId); }));
    return { ok: true, versionId: written.versionId, notes: ['activation pending: the page is being brought to the committed version'], adopted: written.adopted };
  }

  // The handoff: previews off while their twins stay held, the tab's
  // runtime synced to the committed version, then the holds let go.
  async function activate(handle: ExtensionSessionHandle, shim: InstalledShim, next: Spec): Promise<void> {
    const host = handle.page.host as ExtensionPageHost;
    const shimId = handle.source.shimId;
    await host.retainHolds(shimId);
    const version = specVersion(next);
    const synced = host.isClosed() ? 'no-runtime' : await deps.syncTab(host.tabId, shimId, version);
    if (synced === 'timed-out') note(handle.sessionId, `the page did not confirm it runs version ${version} within ${ACTIVATION_WAIT_MS / 1000}s; the held rules were released anyway`);
    await host.releaseHolds(shimId);
    await deps.refreshTabs(shim);
    if (synced !== 'timed-out') note(handle.sessionId, `version ${version} is live on the page`);
  }

  // Around core's backend: what this host adds per op (the activation
  // wait, the refusals, the syntax check, the open note).
  const shimBackend: SessionBackend<ExtensionSessionHandle> = {
    async begin(args) {
      const target = args.target as ExtensionSessionTarget;
      const sessionId = args.sessionId;
      // The page as attached must still be what the card approved: the
      // lease wait and the attach leave room for a navigation. A mismatch
      // closes the host and answers target-changed.
      const url = target.page.host.url();
      const now = ((): URL | null => { try { return new URL(url); } catch { return null; } })();
      const scopeOk = args.approvedScope === undefined || (now !== null && now.hostname === args.approvedScope);
      const originOk = args.approvedOrigin === undefined || (now !== null && now.origin === args.approvedOrigin);
      if (!scopeOk || !originOk) {
        await target.page.close().catch(() => undefined);
        throw new TargetChangedError(`the tab moved to ${url || 'an empty page'} before the session opened; ask again`);
      }
      const handle = await backend.begin(args);
      if (target.committedDown) note(sessionId, target.committedDown);
      return handle;
    },
    checkout: (handle, signal) => (backend.checkout ? backend.checkout(handle, signal) : Promise.resolve({ ok: false as const, error: 'checkout-unavailable' })),
    async preview(handle, input, signal) {
      await activations.get(handle.sessionId);
      return backend.preview(handle, input, signal);
    },
    async call(handle, name, input, signal) {
      const h = handle;
      await activations.get(h.sessionId);
          if (name === 'interact_page') {
            return JSON.stringify({ error: REQUIRES_SHIM_BROWSER, detail: 'interact_page is not available in Shim for Chrome yet: drive the page in the Shim browser, or ask the user to click' });
          }
          if (isApiMapToolName(name) || isDataToolName(name) || isCompositionSessionToolName(name)) {
            return JSON.stringify({ error: REQUIRES_SHIM_BROWSER, detail: `${name} needs the Shim browser` });
          }
      return backend.call(handle, name, input, signal);
    },
    async commit(handle, req) {
      const h = handle;
      await activations.get(h.sessionId);
      await checkSyntax(h);
      // Commits run one at a time per session, and the registry never
      // runs two sessions' commits in one tick of this backend: the
      // probe reads the handle being committed.
      committing = h;
      try {
        return await backend.commit(handle, req);
      } finally {
        if (committing === h) committing = null;
      }
    },
    async finish(handle, info, release) {
      const h = handle;
      await activations.get(h.sessionId);
      try {
        await backend.finish(handle, info, release);
        // A shim created for this session that never got a commit is a
        // draft to drop now (boot sweeps one a dead worker left behind).
        if (h.source.created && !info.committed) await deps.removeDraft(h.source.shimId);
      } finally {
        notes.delete(h.sessionId);
      }
    },
  };

  const registry = createSessionRegistry({
    leases: { shim: leases },
    backends: { shim: shimBackend },
    ...(deps.newId ? { newId: deps.newId } : {}),
    onError: (label, err) => console.error(`[shim] session ${label}:`, err),
  });

  return {
    registry,
    preempt: (shimId) => leases.preempt(shimId),
    takeNotes(sessionId) {
      const list = notes.get(sessionId) ?? [];
      notes.delete(sessionId);
      return list;
    },
    settleActivation: (sessionId) => activations.get(sessionId) ?? Promise.resolve(),
  };
}

export { BeginRefusal };
