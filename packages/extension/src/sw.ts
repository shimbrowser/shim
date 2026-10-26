// The service worker: owns the store, registers one content script per
// enabled shim for exactly its hosts, and answers the page runtime, the
// popup and the install page. It holds no key and runs no model; a session
// host and the bridge arrive in later phases.
//
// Registration is serialized: onInstalled, onStartup and the worker's own
// boot can all fire together, and two concurrent registrations of one id
// race ("Duplicate script ID"), so every sync queues behind the last.

import { hostMatches } from '@shimbrowser/core/host-match';
import { preflightSpec } from '@shimbrowser/core/capability-preflight';
import { openShimStore, type ShimStore, type InstalledShim } from './store';
import { registrationsFor, scriptIdFor, shimIdFor, patternsFor, originsToRelease, RUNTIME_FILES } from './registration';
import { capabilitiesFor, currentMode } from './capabilities';
import { mintShimId } from './install';
import { matchPatternsForHosts } from './match-patterns';
import { senderContext, allowedFrom, type SenderContext } from './sender';
import { isToWorker, type ToWorker, type ToRuntime, type WorkerAnswer, type BundledShim, type ShimSummary } from './messages';

let storePromise: Promise<ShimStore> | null = null;
function store(): Promise<ShimStore> {
  storePromise ??= openShimStore();
  return storePromise;
}

// --- registration -----------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** Does this shim fit the mode in force? One installed under full mode stays, disabled, while the browser runs declarative. */
function fitsMode(shim: InstalledShim): boolean {
  return preflightSpec(shim.spec, capabilitiesFor(currentMode())).ok;
}

async function syncRegistrations(): Promise<void> {
  await serialized(async () => {
    const shims = (await (await store()).listShims()).filter(fitsMode);
    const wanted = registrationsFor(shims);
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const ours = existing.map((s) => s.id).filter((id) => shimIdFor(id) !== null);
    if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });
    const granted = [];
    for (const registration of wanted) {
      // A registration for a host the user has not granted would only error;
      // the shim waits until the install page's grant (or a later one) lands.
      if (await chrome.permissions.contains({ origins: registration.matches })) granted.push(registration);
    }
    if (granted.length) await chrome.scripting.registerContentScripts(granted);
  });
}

// Every open document looks again at what runs there. First a message to
// every tab: a document that runs the runtime syncs on it (content.ts),
// and the message needs no site access, so it reaches a page whose site
// the extension can no longer touch (access revoked) and the shims that
// no longer run there are torn down. Then, for the tabs on `patterns` that
// did not answer (no runtime yet: a shim just enabled on a page loaded
// before), the engine and the runtime are injected. Every tab is best
// effort: one the extension cannot reach is skipped.
async function refreshOpenTabs(patterns: readonly string[]): Promise<void> {
  const answered = new Set<number>();
  let all: chrome.tabs.Tab[];
  try {
    all = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(all.map(async (tab) => {
    if (tab.id === undefined) return;
    try {
      const answer: unknown = await chrome.tabs.sendMessage(tab.id, { type: 'sync' } satisfies ToRuntime);
      if (typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok === true) answered.add(tab.id);
    } catch {
      // No runtime in that tab.
    }
  }));
  if (patterns.length === 0) return;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: [...patterns] });
  } catch {
    return;
  }
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id === undefined || answered.has(tab.id)) return;
    try {
      const target = { tabId: tab.id };
      const [probe] = await chrome.scripting.executeScript({
        target,
        func: () => typeof (globalThis as { ShimCore?: unknown }).ShimCore !== 'undefined',
      });
      // The engine is one instance per document: re-running its bundle would
      // give a second instance that cannot order its rules against the
      // first's, so a document that has it gets the runtime alone.
      const files = probe?.result === true ? [RUNTIME_FILES[1] ?? 'content.js'] : [...RUNTIME_FILES];
      await chrome.scripting.executeScript({ target, files });
    } catch {
      // Not reachable: nothing to refresh there.
    }
  }));
}

chrome.runtime.onInstalled.addListener(() => { void syncRegistrations(); });
chrome.runtime.onStartup.addListener(() => { void syncRegistrations(); });
// Site access revoked (chrome://extensions) stops the scripts that needed it
// and tears the shims down on the pages already open; access granted again
// (or granted for a shim whose install never got it) brings them back.
chrome.permissions.onRemoved.addListener(() => {
  void syncRegistrations().then(() => refreshOpenTabs([]));
});
chrome.permissions.onAdded.addListener((added) => {
  void syncRegistrations().then(() => refreshOpenTabs(added.origins ?? []));
});
void syncRegistrations();

// --- answers ---------------------------------------------------------------------

function summary(shim: InstalledShim): ShimSummary {
  return {
    id: shim.id,
    name: shim.name,
    enabled: shim.enabled,
    hosts: [...(shim.spec.match?.hosts ?? [])],
    installedAt: shim.installedAt,
    ruleCount: (shim.spec.rules ?? []).length,
    needsFullMode: !fitsMode(shim),
  };
}

/** Does the extension hold access to every host the shim names? Revoked access stops the shim everywhere. */
async function hostsGranted(shim: InstalledShim): Promise<boolean> {
  const origins = patternsFor(shim);
  if (origins.length === 0) return false;
  try {
    return await chrome.permissions.contains({ origins });
  } catch {
    return false;
  }
}

/** Does `shim` run on the sender's page right now? Enabled, fits the mode, its hosts cover the page, and the extension has them. */
async function runsOn(shim: InstalledShim, page: { hostname: string; port: string }): Promise<boolean> {
  if (!shim.enabled || !fitsMode(shim)) return false;
  if (!hostMatches(shim.spec.match?.hosts, page.hostname, page.port || undefined)) return false;
  return hostsGranted(shim);
}

/**
 * Cascade priority from the shim's rank: higher wins in the engine, the top
 * of the list (rank 1) wins here, and it depends on nothing but the shim's
 * own rank, so installing or removing another shim never changes it.
 */
export function priorityForRank(rank: number): number {
  return -rank;
}

async function bundleFor(page: { hostname: string; port: string }): Promise<BundledShim[]> {
  const shims = await (await store()).listShims();
  const out: BundledShim[] = [];
  for (const shim of shims) {
    if (await runsOn(shim, page)) out.push({ id: shim.id, spec: shim.spec, priority: priorityForRank(shim.rank) });
  }
  return out;
}

async function handle(msg: ToWorker, from: SenderContext): Promise<WorkerAnswer> {
  if (!allowedFrom(msg.type, from)) return { ok: false, error: 'not from a sender this message is answered for' };
  const db = await store();
  // A content message is about the sender's own page and one of the shims
  // that run there; the page named in a message body would be the page's word.
  const page = from.kind === 'content' ? from : null;
  switch (msg.type) {
    case 'bundle':
      if (!page) return { ok: false, error: 'no page' };
      return { ok: true, mode: currentMode(), shims: await bundleFor(page) };
    case 'storage': {
      if (!page) return { ok: false, error: 'no page' };
      const shim = await db.getShim(msg.shimId);
      if (!shim || !(await runsOn(shim, page))) return { ok: false, error: 'not a shim of this page' };
      const scope = { shimId: shim.id, origin: page.origin };
      const key = typeof msg.key === 'string' ? msg.key : '';
      switch (msg.method) {
        case 'get': return { ok: true, value: await db.userData.get(scope, key) };
        case 'set': return { ok: true, value: await db.userData.set(scope, key, msg.value) };
        case 'delete': return { ok: true, value: await db.userData.delete(scope, key) };
        case 'list': return { ok: true, value: await db.userData.list(scope) };
        default: return { ok: false, error: 'unknown storage method' };
      }
    }
    case 'event':
      // Rule status, rebases and quarantines arrive here; persisting them
      // (versions, page memory, the needs-review badge) is a later phase.
      return { ok: true };
    case 'shims.list': {
      const shims = await db.listShims();
      return { ok: true, mode: currentMode(), shims: shims.map(summary) };
    }
    case 'shims.setEnabled': {
      const shim = await db.getShim(msg.id);
      if (!shim) return { ok: false, error: 'no such shim' };
      await db.setEnabled(msg.id, msg.enabled);
      await syncRegistrations();
      await refreshOpenTabs(patternsFor(shim));
      return { ok: true };
    }
    case 'shims.uninstall': {
      const shim = await db.getShim(msg.id);
      if (!shim) return { ok: false, error: 'no such shim' };
      await db.deleteShim(msg.id);
      await syncRegistrations();
      // Open pages tear the shim down while its hosts are still ours; the
      // release comes after.
      await refreshOpenTabs(patternsFor(shim));
      const remaining = await db.listShims();
      const release = originsToRelease(patternsFor(shim), remaining);
      if (release.length) {
        try {
          await chrome.permissions.remove({ origins: release });
        } catch {
          // A pattern the user already revoked: nothing to release.
        }
      }
      return { ok: true };
    }
    case 'install.commit': {
      const { prepared, provenance } = msg;
      if (!prepared || prepared.ok !== true) return { ok: false, error: 'nothing prepared to install' };
      // The worker trusts only what it checks itself: the page's prepared
      // install gets its hosts checked and is re-preflighted against the
      // mode in force before it is written.
      const { patterns, problems } = matchPatternsForHosts(prepared.spec.match?.hosts ?? []);
      if (problems.length || patterns.length === 0) return { ok: false, error: `the shim's hosts cannot be registered: ${problems.join('; ') || 'none named'}` };
      const mode = currentMode();
      const pre = preflightSpec(prepared.spec, capabilitiesFor(mode));
      if (!pre.ok) return { ok: false, error: `the shim needs what this browser cannot run: ${pre.unsupported.map((u) => u.message).join('; ')}` };
      const id = mintShimId(crypto.randomUUID());
      const shim: Omit<InstalledShim, 'rank'> = {
        id,
        name: prepared.name,
        enabled: true,
        installedAt: Date.now(),
        provenance,
        mode,
        spec: { ...prepared.spec, id },
        handlers: prepared.handlers,
        envelope: prepared.envelope,
      };
      // The rank comes with the write, in one transaction, so two installs
      // in flight never share one.
      await db.addShim(shim);
      await db.userData.restore(id, prepared.userData);
      await syncRegistrations();
      await refreshOpenTabs(patterns);
      return { ok: true, id };
    }
    default:
      return { ok: false, error: 'unknown message' };
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse: (answer: WorkerAnswer) => void) => {
  if (!isToWorker(msg)) return false;
  handle(msg, senderContext(sender, chrome.runtime.id, chrome.runtime.getURL(''))).then(sendResponse, (err: unknown) => {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });
  return true;
});

export { scriptIdFor };
