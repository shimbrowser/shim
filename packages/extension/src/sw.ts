// The service worker: owns the store, registers one script per enabled shim
// for exactly its hosts, and answers the page runtime, the popup and the
// install page. It holds no key and runs no model; a session host and the
// bridge arrive in later phases.
//
// Two modes (capabilities.ts). Full mode, while the user allows user
// scripts: the engine and the runtime are user scripts in the user-script
// world, whose CSP permits the handler compile, and rules with handlers
// run. Declarative mode otherwise: content scripts in the isolated world,
// declarative rules only. The mode is read from the API's presence; the
// toggle reloads the extension, so each worker boot syncs the registrations
// to the mode it finds, and every shim is preflighted against it again
// (one that no longer fits stops, stays installed, and the popup says why).
//
// Registration is serialized: onInstalled, onStartup and the worker's own
// boot can all fire together, and two concurrent registrations of one id
// race ("Duplicate script ID"), so every sync queues behind the last.

import { hostMatches } from '@shimbrowser/core/host-match';
import { preflightSpec } from '@shimbrowser/core/capability-preflight';
import { openShimStore, type ShimStore, type InstalledShim } from './store';
import {
  registrationsFor, userScriptRegistrationsFor, shimIdFor, patternsFor, originsToRelease, RUNTIME_FILES,
  USER_SCRIPT_WORLD_CSP,
} from './registration';
import { capabilitiesFor, currentMode, type ExtensionMode } from './capabilities';
import { mintShimId } from './install';
import { matchPatternsForHosts } from './match-patterns';
import { senderContext, allowedFrom, type SenderContext } from './sender';
import {
  isToWorker, RUNTIME_PORT, type ToWorker, type ToRuntime, type WorkerAnswer, type BundledShim, type ShimSummary,
} from './messages';

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

// The user-script world's configuration, once per worker boot. Chrome keeps
// the configuration across the toggle going off and on, so a configureWorld
// that repeats it changes nothing and the renderers, whose copy the toggle
// cleared, never hear of it again: a page's user-script world then has no
// chrome.runtime.sendMessage and the runtime cannot reach the worker. A
// reset first makes the configure a change every renderer receives.
// (resetWorldConfiguration arrived in Chrome 128.)
let worldConfigured = false;
async function configureUserScriptWorld(): Promise<void> {
  if (worldConfigured) return;
  const api = chrome.userScripts as { resetWorldConfiguration?: () => Promise<void> };
  if (typeof api.resetWorldConfiguration === 'function') await api.resetWorldConfiguration();
  await chrome.userScripts.configureWorld({ csp: USER_SCRIPT_WORLD_CSP, messaging: true });
  worldConfigured = true;
}

/** The registrations whose hosts the user has granted: one for a host withheld would only error; the shim waits for the grant. */
async function granted<T extends { matches: string[] }>(registrations: readonly T[]): Promise<T[]> {
  const out: T[] = [];
  for (const registration of registrations) {
    if (await chrome.permissions.contains({ origins: registration.matches })) out.push(registration);
  }
  return out;
}

async function syncRegistrations(): Promise<void> {
  await serialized(async () => {
    const mode = currentMode();
    const shims = (await (await store()).listShims()).filter(fitsMode);
    // Our content scripts go first in both modes: declarative mode replaces
    // them, full mode runs the engine in the user-script world alone (one
    // engine per document, and a mode flip leaves the other mode's
    // registrations behind).
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const ours = existing.map((s) => s.id).filter((id) => shimIdFor(id) !== null);
    if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });
    if (mode === 'full') {
      await configureUserScriptWorld();
      const registered = await chrome.userScripts.getScripts();
      const stale = registered.map((s) => s.id).filter((id) => shimIdFor(id) !== null);
      if (stale.length) await chrome.userScripts.unregister({ ids: stale });
      const wanted = await granted(userScriptRegistrationsFor(shims));
      if (wanted.length) await chrome.userScripts.register(wanted);
    } else {
      // Full mode's user scripts, if any are left, are inert while the user
      // disallows user scripts, and the API to drop them is gone with it;
      // the next full-mode sync replaces them.
      const wanted = await granted(registrationsFor(shims));
      if (wanted.length) await chrome.scripting.registerContentScripts(wanted);
    }
  });
}

// --- the runtimes on open pages ---------------------------------------------------

// Every runtime holds a port to the worker: a full-mode runtime cannot
// receive a message (the user-script world has no onMessage), so the port
// is how the worker nudges it, and in both worlds its loss tells the
// runtime whether this extension instance is still there. Each port is
// one document's runtime; the map says which tab it is in. Content
// scripts connect on onConnect, user scripts on onUserScriptConnect.
const runtimePorts = new Map<chrome.runtime.Port, number>();
function acceptRuntimePort(port: chrome.runtime.Port): void {
  const tabId = port.sender?.tab?.id;
  if (port.name !== RUNTIME_PORT || tabId === undefined) {
    port.disconnect();
    return;
  }
  runtimePorts.set(port, tabId);
  port.onDisconnect.addListener(() => { runtimePorts.delete(port); });
  // A connection is a runtime that may have missed a change: the worker
  // it held a port to went away (idled out) and the change happened
  // before this one reconnected, when no port was there to nudge. So
  // every connection starts with a look at what runs there.
  try {
    port.postMessage({ type: 'sync' } satisfies ToRuntime);
  } catch {
    runtimePorts.delete(port);
  }
}
chrome.runtime.onConnect.addListener(acceptRuntimePort);
const onUserScriptConnect = (chrome.runtime as { onUserScriptConnect?: chrome.events.Event<(port: chrome.runtime.Port) => void> }).onUserScriptConnect;
if (onUserScriptConnect) onUserScriptConnect.addListener(acceptRuntimePort);

/** The engine and the runtime into `tabId`, or the runtime alone where the engine already runs, in the mode's world. */
async function injectRuntime(tabId: number, mode: ExtensionMode): Promise<void> {
  const [engine, runtime] = RUNTIME_FILES;
  if (engine === undefined || runtime === undefined) return;
  if (mode === 'full') {
    // userScripts.execute arrived in Chrome 135; before that an open page
    // gets the change on its next load.
    const api = chrome.userScripts as { execute?: unknown };
    if (typeof api.execute !== 'function') return;
    const target = { tabId };
    const [probe] = await chrome.userScripts.execute({ target, js: [{ code: 'typeof ShimCore !== "undefined"' }] });
    const js: [{ file: string }, ...{ file: string }[]] = probe?.result === true ? [{ file: runtime }] : [{ file: engine }, { file: runtime }];
    await chrome.userScripts.execute({ target, js });
    return;
  }
  const target = { tabId };
  const [probe] = await chrome.scripting.executeScript({
    target,
    func: () => typeof (globalThis as { ShimCore?: unknown }).ShimCore !== 'undefined',
  });
  // The engine is one instance per document: re-running its bundle would
  // give a second instance that cannot order its rules against the
  // first's, so a document that has it gets the runtime alone.
  const files = probe?.result === true ? [runtime] : [engine, runtime];
  await chrome.scripting.executeScript({ target, files });
}

// Every open document looks again at what runs there. First a nudge to
// every runtime: over its port (full mode) or a message to its tab
// (declarative mode); a document that runs the runtime syncs on it
// (content.ts), and the nudge needs no site access, so it reaches a page
// whose site the extension can no longer touch (access revoked) and the
// shims that no longer run there are torn down. Then, for the tabs on
// `patterns` that did not answer (no runtime yet: a shim just enabled on a
// page loaded before), the engine and the runtime are injected. Every tab
// is best effort: one the extension cannot reach is skipped.
async function refreshOpenTabs(patterns: readonly string[]): Promise<void> {
  const answered = new Set<number>();
  for (const [port, tabId] of runtimePorts) {
    try {
      port.postMessage({ type: 'sync' } satisfies ToRuntime);
      answered.add(tabId);
    } catch {
      runtimePorts.delete(port);
    }
  }
  let all: chrome.tabs.Tab[];
  try {
    all = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(all.map(async (tab) => {
    if (tab.id === undefined || answered.has(tab.id)) return;
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
  const mode = currentMode();
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id === undefined || answered.has(tab.id)) return;
    try {
      await injectRuntime(tab.id, mode);
    } catch {
      // Not reachable: nothing to refresh there.
    }
  }));
}

/** The patterns of every shim that runs in this mode and whose hosts are held: where an open page may need the runtime. */
async function activePatterns(): Promise<string[]> {
  const shims = (await (await store()).listShims()).filter((shim) => shim.enabled && fitsMode(shim));
  const out = new Set<string>();
  for (const shim of shims) {
    if (await hostsGranted(shim)) for (const pattern of patternsFor(shim)) out.add(pattern);
  }
  return [...out];
}

// The first boot of this extension instance (installed, updated, reloaded,
// enabled again): the documents already open ran the previous instance's
// runtime, which tore its shims down when that instance went, so they get
// this one's. A worker that merely idled out and restarted is the same
// instance, and its runtimes reconnect their ports on their own.
// chrome.storage.session lives exactly as long as an instance.
async function bootRefresh(): Promise<void> {
  const { booted } = await chrome.storage.session.get('booted');
  await syncRegistrations();
  if (booted === true) return;
  await chrome.storage.session.set({ booted: true });
  await refreshOpenTabs(await activePatterns());
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
void bootRefresh();

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

async function bundleFor(page: { hostname: string; port: string }, mode: ExtensionMode): Promise<BundledShim[]> {
  const shims = await (await store()).listShims();
  const out: BundledShim[] = [];
  for (const shim of shims) {
    if (!(await runsOn(shim, page))) continue;
    // Handler source goes only where it compiles: the user-script world.
    const handlers = mode === 'full' ? { ...shim.handlers } : {};
    out.push({ id: shim.id, spec: shim.spec, priority: priorityForRank(shim.rank), handlers });
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
    case 'bundle': {
      if (!page) return { ok: false, error: 'no page' };
      const mode = currentMode();
      return { ok: true, mode, shims: await bundleFor(page, mode) };
    }
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

type MessageListener = (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (answer: WorkerAnswer) => void) => boolean;

const onWorkerMessage: MessageListener = (msg, sender, sendResponse) => {
  if (!isToWorker(msg)) return false;
  handle(msg, senderContext(sender, chrome.runtime.id, chrome.runtime.getURL(''))).then(sendResponse, (err: unknown) => {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });
  return true;
};

chrome.runtime.onMessage.addListener(onWorkerMessage);
// A message from the user-script world (full mode) arrives on its own
// event, with the same sender Chrome attaches, so the same authorization.
const onUserScriptMessage = (chrome.runtime as { onUserScriptMessage?: chrome.events.Event<MessageListener> }).onUserScriptMessage;
if (onUserScriptMessage) onUserScriptMessage.addListener(onWorkerMessage);

export { scriptIdFor } from './registration';
