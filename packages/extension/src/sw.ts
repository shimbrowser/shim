// The service worker: owns the store, registers one script per enabled shim
// for exactly its hosts, and answers the page runtime, the popup and the
// install page. It holds no key and runs no model; a session host and the
// bridge arrive in later phases.
//
// Two modes (capabilities.ts). Full mode, while the user allows user
// scripts: the engine and the runtime are user scripts in the user-script
// world, whose CSP permits the handler compile, and rules with handlers
// run. Declarative mode otherwise: content scripts in the isolated world,
// declarative rules only. The mode is measured by a call on the API (the
// toggle fires no event and reloads nothing: under a running extension the
// API object stays and its calls start throwing), so the worker measures
// again on every navigation and every message, and when the answer has
// changed it syncs the registrations to the new mode and refreshes the
// open pages. Every shim is preflighted against the mode in force: one that
// no longer fits stops, stays installed, and the popup says why.
//
// Registration is serialized: onInstalled, onStartup and the worker's own
// boot can all fire together, and two concurrent registrations of one id
// race ("Duplicate script ID"), so every sync queues behind the last.

import { hostMatches } from '@shimbrowser/core/host-match';
import { preflightSpec } from '@shimbrowser/core/capability-preflight';
import type { PageHostCapabilities } from '@shimbrowser/core/page-host';
import { openShimStore, type ShimStore, type InstalledShim } from './store';
import {
  registrationsFor, userScriptRegistrationsFor, shimIdFor, patternsFor, originsToRelease, RUNTIME_FILES,
  USER_SCRIPT_WORLD_CSP,
} from './registration';
import { capabilitiesFor, detectMode, type ExtensionMode } from './capabilities';
import { arbitrate, type RuntimeWorld as ArbitratedWorld } from './arbitrate';
import { baselineForPath, pagePathKey } from '@shimbrowser/core/deploy-id';
import {
  rebasedSpec, refreshedSpec, witnessedSpec, rememberPath, escalationAllowed, quarantineFrom, emptyRuleState, type RuntimeEventPayload,
} from './rebase';
import { mintShimId } from './install';
import { matchPatternsForHosts } from './match-patterns';
import { senderContext, allowedFrom, type SenderContext } from './sender';
import {
  isToWorker, isFromRuntime, RUNTIME_PORT, type ToWorker, type ToRuntime, type WorkerAnswer, type BundledShim, type ShimSummary,
  type ReviewItem,
} from './messages';
import { SHIM_FILE_FORMAT } from '@shimbrowser/core/shim-folder';

let storePromise: Promise<ShimStore> | null = null;
function store(): Promise<ShimStore> {
  storePromise ??= openShimStore();
  return storePromise;
}

// --- the mode ----------------------------------------------------------------------

/** The world a message came from: the isolated world (a content script) or the user-script world. */
type RuntimeWorld = ArbitratedWorld;

/** The mode as last measured. Read right after refreshMode. */
let modeNow: ExtensionMode = 'declarative';
/** The mode the registrations were last synced to; null before the first sync. */
let syncedMode: ExtensionMode | null = null;

async function refreshMode(): Promise<ExtensionMode> {
  modeNow = await detectMode();
  return modeNow;
}

function fitsCapabilities(shim: InstalledShim, capabilities: PageHostCapabilities): boolean {
  return preflightSpec(shim.spec, capabilities).ok;
}

/** Does this shim fit the mode in force? One installed under full mode stays, disabled, while the browser runs declarative. */
function fitsMode(shim: InstalledShim): boolean {
  return fitsCapabilities(shim, capabilitiesFor(modeNow));
}

/**
 * What a runtime in `world` may run: the isolated world compiles nothing,
 * so it gets the declarative constant whatever the mode; the user-script
 * world gets full mode's while the mode is full, and the declarative one
 * once user scripts are disallowed again, so a page still open from
 * before drops its handler shims on its next sync.
 */
function capabilitiesForWorld(world: RuntimeWorld): PageHostCapabilities {
  return capabilitiesFor(world === 'user-script' && modeNow === 'full' ? 'full' : 'declarative');
}

// --- registration -----------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** The registrations whose hosts the user has granted: one for a host withheld would only error; the shim waits for the grant. */
async function granted<T extends { matches: string[] }>(registrations: readonly T[]): Promise<T[]> {
  const out: T[] = [];
  for (const registration of registrations) {
    if (await chrome.permissions.contains({ origins: registration.matches })) out.push(registration);
  }
  return out;
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

async function syncRegistrations(): Promise<void> {
  await serialized(async () => {
    const mode = await refreshMode();
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
      // the next full-mode sync replaces them. The world configuration is
      // re-sent then too.
      worldConfigured = false;
      const wanted = await granted(registrationsFor(shims));
      if (wanted.length) await chrome.scripting.registerContentScripts(wanted);
    }
    syncedMode = mode;
  });
}

// --- the runtimes on open pages ---------------------------------------------------

// Every runtime holds a port to the worker: a full-mode runtime cannot
// receive a message (the user-script world has no onMessage), so the port
// is how the worker nudges it, and in both worlds its loss tells the
// runtime whether this extension instance is still there. Each port is
// one document's runtime; the map says which tab it is in. Content
// scripts connect on onConnect, user scripts on onUserScriptConnect.
const runtimePorts = new Map<chrome.runtime.Port, { tabId: number; world: RuntimeWorld }>();
function post(port: chrome.runtime.Port, msg: ToRuntime): void {
  try {
    port.postMessage(msg);
  } catch {
    runtimePorts.delete(port);
  }
}
/**
 * Retire `loser` for `survivor`. The loser says as it goes whether it had
 * run anything; only then can its teardown have taken stylesheets or
 * tokens the survivor shares, and only then does the survivor reboot.
 */
function retireFor(loser: chrome.runtime.Port, survivor: chrome.runtime.Port): void {
  loser.onMessage.addListener((msg: unknown) => {
    if (isFromRuntime(msg) && msg.type === 'retiring' && msg.booted) post(survivor, { type: 'reboot' });
  });
  post(loser, { type: 'retire' });
}

function acceptRuntimePort(world: RuntimeWorld): (port: chrome.runtime.Port) => void {
  return (port) => {
    const tabId = port.sender?.tab?.id;
    if (port.name !== RUNTIME_PORT || tabId === undefined || (port.sender?.frameId ?? 0) !== 0) {
      port.disconnect();
      return;
    }
    // One runtime per page. Two can meet when a handover and a reconnect
    // cross (a holder's port down for the moment, the other world's
    // runtime injected beside it, the holder reconnecting later): the one
    // that does not fit the mode is retired, whichever connected first,
    // and the survivor reboots if the loser had run, since the loser's
    // teardown takes stylesheets and tokens the survivor's rules share
    // (arbitrate.ts).
    // The page's mark is only a hint; this is the decision.
    const rival = [...runtimePorts].find(([, r]) => r.tabId === tabId && r.world !== world);
    if (rival) {
      const [rivalPort, { world: rivalWorld }] = rival;
      const verdict = arbitrate(rivalWorld, world, modeNow);
      if (verdict?.retire === 'incoming') {
        retireFor(port, rivalPort);
        return;
      }
      runtimePorts.delete(rivalPort);
      runtimePorts.set(port, { tabId, world });
      port.onDisconnect.addListener(() => { runtimePorts.delete(port); });
      retireFor(rivalPort, port);
      return;
    }
    runtimePorts.set(port, { tabId, world });
    port.onDisconnect.addListener(() => { runtimePorts.delete(port); });
    // A connection is a runtime that may have missed a change: the worker
    // it held a port to went away (idled out) and the change happened
    // before this one reconnected, when no port was there to nudge. So
    // every connection starts with a look at what runs there.
    post(port, { type: 'sync' });
  };
}
chrome.runtime.onConnect.addListener(acceptRuntimePort('isolated'));
const onUserScriptConnect = (chrome.runtime as { onUserScriptConnect?: chrome.events.Event<(port: chrome.runtime.Port) => void> }).onUserScriptConnect;
if (onUserScriptConnect) onUserScriptConnect.addListener(acceptRuntimePort('user-script'));

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
// every runtime: over its port, and a message to its tab for an
// isolated-world runtime; a document that runs the runtime syncs on it
// (content.ts), and the nudge needs no site access, so it reaches a page
// whose site the extension can no longer touch (access revoked) and the
// shims that no longer run there are torn down. In full mode an
// isolated-world runtime (a page loaded while user scripts were off) is
// retired instead, since it can never compile a handler: it tears down
// and drops its mark, and the page is treated as one with no runtime.
// Then, for the tabs on `patterns` that did not answer (no runtime yet: a
// shim just enabled on a page loaded before, a page loaded while the mode
// had nothing registered, a page just retired), the engine and the
// runtime are injected in the mode's world; the user-script runtime waits
// for the retired one's mark to go before it boots. Every tab is best
// effort: one the extension cannot reach is skipped.
// Refreshes queue behind registration syncs and each other: two at once
// would both find a tab without a runtime and inject the engine twice.
function refreshOpenTabs(patterns: readonly string[]): Promise<void> {
  return serialized(() => refreshOpenTabsNow(patterns));
}

async function refreshOpenTabsNow(patterns: readonly string[]): Promise<void> {
  const mode = modeNow;
  const answered = new Set<number>();
  // What an isolated-world runtime is told: in full mode it leaves, when a
  // user-script runtime can be injected in its place (Chrome 135+);
  // before that it stays and keeps the declarative rules running.
  const canInjectUserScript = mode === 'full' && typeof (chrome.userScripts as { execute?: unknown }).execute === 'function';
  const toIsolated: ToRuntime = canInjectUserScript ? { type: 'retire' } : { type: 'sync' };
  for (const [port, { tabId, world }] of runtimePorts) {
    const nudge: ToRuntime = world === 'isolated' ? toIsolated : { type: 'sync' };
    post(port, nudge);
    if (nudge.type === 'sync' && runtimePorts.has(port)) answered.add(tabId);
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
      const answer: unknown = await chrome.tabs.sendMessage(tab.id, toIsolated);
      if (toIsolated.type === 'sync' && typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok === true) answered.add(tab.id);
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
      await injectRuntime(tab.id, mode);
    } catch {
      // Not reachable: nothing to refresh there.
    }
  }));
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

/** The patterns of every shim that runs in this mode and whose hosts are held: where an open page may need the runtime. */
async function activePatterns(): Promise<string[]> {
  const shims = (await (await store()).listShims()).filter((shim) => shim.enabled && fitsMode(shim));
  const out = new Set<string>();
  for (const shim of shims) {
    if (await hostsGranted(shim)) for (const pattern of patternsFor(shim)) out.add(pattern);
  }
  return [...out];
}

/**
 * The mode measured again; when it differs from the one the registrations
 * were synced to, they are synced again and every open page looks again
 * (a page open from the other mode drops what it may no longer run; one
 * loaded while nothing was registered gets the runtime). Serialized with
 * the syncs so two navigations in a row do not sync twice.
 */
let reconciling: Promise<void> = Promise.resolve();
function reconcileMode(): Promise<void> {
  reconciling = reconciling.then(async () => {
    const mode = await refreshMode();
    if (syncedMode === mode) return;
    await syncRegistrations();
    await refreshOpenTabs(await activePatterns());
  }, () => undefined);
  return reconciling;
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
// A page load is the moment a mode flip shows: the toggle fires no event,
// so each top-frame navigation measures the mode again, and a page that
// loaded with nothing registered for the new mode gets the runtime.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  void reconcileMode();
});
void bootRefresh();

// --- answers ---------------------------------------------------------------------

function specVersion(spec: { version?: unknown }): number {
  return typeof spec.version === 'number' && Number.isFinite(spec.version) ? spec.version : 1;
}

async function summary(db: ShimStore, shim: InstalledShim): Promise<ShimSummary> {
  const ruleIds = new Set((shim.spec.rules ?? []).map((r) => r.id));
  const review: ReviewItem[] = (await db.ruleState.listForShim(shim.id))
    .filter((r) => r.quarantine && ruleIds.has(r.ruleId))
    .map((r) => ({ ruleId: r.ruleId, reason: r.quarantine?.reason ?? '', occurredAt: r.quarantine?.occurredAt ?? 0 }))
    .sort((a, b) => b.occurredAt - a.occurredAt);
  return {
    id: shim.id,
    name: shim.name,
    enabled: shim.enabled,
    hosts: [...(shim.spec.match?.hosts ?? [])],
    installedAt: shim.installedAt,
    ruleCount: (shim.spec.rules ?? []).length,
    needsFullMode: !fitsMode(shim),
    version: specVersion(shim.spec),
    review,
  };
}

// --- what the engine reports -------------------------------------------------------
//
// The deterministic rebase ladder runs in the page; the worker keeps what it
// reports, as main does (rebase.ts has the pure part). A document's own
// shim id is the only one it may report for (runsOn), and a composite id
// (a preview's) is never durable state.

async function recordBaseline(db: ShimStore, shimId: string, host: string, payload: RuntimeEventPayload): Promise<void> {
  if (typeof payload.bundleHash !== 'string' || !payload.bundleHash) return;
  await db.baselines.record(shimId, host, pagePathKey(payload.path), payload.bundleHash);
}

async function ruleStateFor(db: ShimStore, shimId: string, ruleId: string) {
  return (await db.ruleState.get(shimId, ruleId)) ?? emptyRuleState(shimId, ruleId);
}

/** Per shim, the event being kept now; the next one waits for it. */
const ingesting = new Map<string, Promise<void>>();

/** One engine event from the runtime of `shim` on `page`; answers whether the open pages should look again. */
async function ingestEvent(db: ShimStore, shim: InstalledShim, page: { hostname: string }, kind: string, payload: RuntimeEventPayload): Promise<boolean> {
  const ruleId = typeof payload.ruleId === 'string' ? payload.ruleId : null;
  switch (kind) {
    case 'rule-rebase': {
      if (!ruleId) return false;
      // The page kind's baseline advances with the rebase, before the page is
      // served its baseline again, so the re-run sees no deploy.
      await recordBaseline(db, shim.id, page.hostname, payload);
      const out = rebasedSpec(shim.spec, ruleId, payload.anchor, payload.bundleHash);
      if (!out) return false;
      await db.reviseSpec(shim.id, out.spec, 'rebase');
      // Healed: whatever review it was held for no longer applies.
      const state = await ruleStateFor(db, shim.id, ruleId);
      if (state.quarantine) await db.ruleState.put({ ...state, quarantine: undefined });
      console.log(`[shim] auto-rebase (${String(payload.strategy)}${payload.via ? ` via ${String(payload.via)}` : ''}) ${shim.id}/${ruleId}: spec v${out.version}`);
      return true;
    }
    case 'spec-bundle-update': {
      await recordBaseline(db, shim.id, page.hostname, payload);
      const next = refreshedSpec(shim.spec, payload.bundleHash);
      if (next) await db.amendSpec(shim.id, next);
      return false;
    }
    case 'rule-witness': {
      if (!ruleId) return false;
      const next = witnessedSpec(shim.spec, ruleId, payload.witness, payload.setWitness);
      if (next) await db.amendSpec(shim.id, next);
      return false;
    }
    case 'rule-status': {
      if (!ruleId || typeof payload.matched !== 'number' || payload.matched <= 0 || typeof payload.path !== 'string') return false;
      const state = await ruleStateFor(db, shim.id, ruleId);
      await db.ruleState.put({ ...state, paths: rememberPath(state.paths, payload.path, Date.now()) });
      return false;
    }
    case 'rule-quarantined': {
      if (!ruleId) return false;
      const state = await ruleStateFor(db, shim.id, ruleId);
      // A miss on a page kind the rule has never applied on is a wrong-page
      // miss, not a break: no review.
      if (!escalationAllowed(state.paths, payload.path)) return false;
      await db.ruleState.put({ ...state, quarantine: quarantineFrom(payload, Date.now()) });
      return false;
    }
    default:
      return false;
  }
}

/** The `.shim` file a shim exports as: its spec as it stands, its handlers, its saved data, and the envelope's other fields. */
async function exportFile(db: ShimStore, shim: InstalledShim): Promise<string> {
  const userData = await db.userData.listForShim(shim.id);
  const file: Record<string, unknown> = { ...shim.envelope, format: SHIM_FILE_FORMAT, name: shim.name, spec: shim.spec, handlers: shim.handlers };
  if (userData.length) file.userData = userData;
  return JSON.stringify(file, null, 2);
}

function fileNameFor(name: string): string {
  const stem = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'shim';
  return `${stem}.shim`;
}

/** Does `shim` run on the sender's page for a runtime with `capabilities`? Enabled, fits, its hosts cover the page, and the extension has them. */
async function runsOn(shim: InstalledShim, page: { hostname: string; port: string }, capabilities: PageHostCapabilities): Promise<boolean> {
  if (!shim.enabled || !fitsCapabilities(shim, capabilities)) return false;
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

async function bundleFor(page: { hostname: string; port: string; pathname: string }, world: RuntimeWorld): Promise<BundledShim[]> {
  const capabilities = capabilitiesForWorld(world);
  const withHandlers = capabilities === capabilitiesFor('full');
  const db = await store();
  const shims = await db.listShims();
  const out: BundledShim[] = [];
  for (const shim of shims) {
    if (!(await runsOn(shim, page, capabilities))) continue;
    // Handler source goes only where it compiles: the user-script world, in full mode.
    const handlers = withHandlers ? { ...shim.handlers } : {};
    // The deploy baseline a page is judged against is its own page kind's,
    // never the shim-wide one: a multi-page site loads a different bundle per
    // page kind. No baseline for this kind → the engine judges no deploy, and
    // a clean resolve records one.
    const baseline = baselineForPath(await db.baselines.forHost(shim.id, page.hostname), page.pathname);
    const spec = { ...shim.spec, bundleHash: baseline ?? undefined };
    out.push({ id: shim.id, spec, priority: priorityForRank(shim.rank), version: specVersion(shim.spec), handlers });
  }
  return out;
}

async function handle(msg: ToWorker, from: SenderContext, world: RuntimeWorld): Promise<WorkerAnswer> {
  if (!allowedFrom(msg.type, from)) return { ok: false, error: 'not from a sender this message is answered for' };
  // Every message is a moment the mode may have flipped since the last look.
  await reconcileMode();
  const db = await store();
  // A content message is about the sender's own page and one of the shims
  // that run there; the page named in a message body would be the page's word.
  const page = from.kind === 'content' ? from : null;
  switch (msg.type) {
    case 'bundle': {
      if (!page) return { ok: false, error: 'no page' };
      return { ok: true, mode: modeNow, shims: await bundleFor(page, world) };
    }
    case 'storage': {
      if (!page) return { ok: false, error: 'no page' };
      const shim = await db.getShim(msg.shimId);
      if (!shim || !(await runsOn(shim, page, capabilitiesForWorld(world)))) return { ok: false, error: 'not a shim of this page' };
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
    case 'event': {
      if (!page) return { ok: false, error: 'no page' };
      const shimId = msg.shimId;
      const capabilities = capabilitiesForWorld(world);
      // One shim's events are kept one after another: two rebases reported
      // by one document (two rules healed in one pass) each read the spec
      // the other wrote, so neither overwrites the other's anchor.
      const kept = (ingesting.get(shimId) ?? Promise.resolve()).then(async (): Promise<WorkerAnswer> => {
        const shim = await db.getShim(shimId);
        if (!shim || !(await runsOn(shim, page, capabilities))) return { ok: false, error: 'not a shim of this page' };
        let changed = false;
        try {
          changed = await ingestEvent(db, shim, page, msg.kind, msg.payload);
        } catch (err) {
          console.error(`[shim] could not keep a ${msg.kind} event for ${shim.id}`, err);
        }
        // A rebased spec re-applies on the open pages: the runtime reconciles
        // on the version and boots the shim again with the healed anchor.
        if (changed) void refreshOpenTabs(patternsFor(shim));
        return { ok: true };
      });
      ingesting.set(shimId, kept.then(() => undefined, () => undefined));
      return kept;
    }
    case 'mode':
      return { ok: true, mode: modeNow };
    case 'shims.list': {
      const shims = await db.listShims();
      const summaries: ShimSummary[] = [];
      for (const shim of shims) summaries.push(await summary(db, shim));
      return { ok: true, mode: modeNow, shims: summaries };
    }
    case 'shims.export': {
      const shim = await db.getShim(msg.id);
      if (!shim) return { ok: false, error: 'no such shim' };
      return { ok: true, file: await exportFile(db, shim), fileName: fileNameFor(shim.name) };
    }
    case 'shims.versions': {
      const shim = await db.getShim(msg.id);
      if (!shim) return { ok: false, error: 'no such shim' };
      const versions = (await db.versions.listForShim(shim.id)).map((v) => ({ version: v.version, at: v.at, reason: v.reason }));
      return { ok: true, versions };
    }
    case 'shims.restore': {
      const shim = await db.getShim(msg.id);
      if (!shim) return { ok: false, error: 'no such shim' };
      const snapshot = await db.versions.get(shim.id, msg.version);
      if (!snapshot) return { ok: false, error: 'no such version' };
      // A restore is a forward change: the chosen spec comes back as the
      // next version (never the old number, so history stays a line). Its
      // rules' reviews are cleared: whatever broke, this is a different
      // spec now.
      const next = { ...snapshot.spec, id: shim.id, version: specVersion(shim.spec) + 1 };
      await db.reviseSpec(shim.id, next, 'restore');
      for (const state of await db.ruleState.listForShim(shim.id)) {
        if (state.quarantine) await db.ruleState.put({ ...state, quarantine: undefined });
      }
      await refreshOpenTabs(patternsFor(shim));
      return { ok: true };
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
      const mode = modeNow;
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
      const rank = await db.addShim(shim);
      await db.versions.snapshot({ ...shim, rank }, 'install');
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

// The event a message arrives on names the world it came from, which no
// message body can claim: onMessage serves the isolated world (and the
// extension's own pages), onUserScriptMessage the user-script world.
function listenerFor(world: RuntimeWorld): MessageListener {
  return (msg, sender, sendResponse) => {
    if (!isToWorker(msg)) return false;
    handle(msg, senderContext(sender, chrome.runtime.id, chrome.runtime.getURL('')), world).then(sendResponse, (err: unknown) => {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
    return true;
  };
}

chrome.runtime.onMessage.addListener(listenerFor('isolated'));
const onUserScriptMessage = (chrome.runtime as { onUserScriptMessage?: chrome.events.Event<MessageListener> }).onUserScriptMessage;
if (onUserScriptMessage) onUserScriptMessage.addListener(listenerFor('user-script'));

export { scriptIdFor } from './registration';
