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
import { capabilitiesFor, detectMode, SESSION_CAPABILITIES, type ExtensionMode } from './capabilities';
import { arbitrate, type RuntimeWorld as ArbitratedWorld } from './arbitrate';
import { baselineForPath, pagePathKey } from '@shimbrowser/core/deploy-id';
import {
  rebasedSpec, refreshedSpec, capturedSpec, rememberPath, escalationAllowed, quarantineFrom, emptyRuleState, eventFormMatches, ruleForms,
  type RuntimeEventPayload,
} from './rebase';
import { mintShimId } from './install';
import { matchPatternsForHosts } from './match-patterns';
import { senderContext, allowedFrom, type SenderContext } from './sender';
import {
  isToWorker, isFromRuntime, splitAuth, RUNTIME_PORT, STALE_TOKEN, type ToWorker, type ToRuntime, type FromRuntime, type WorkerAnswer, type BundledShim,
  type ShimSummary, type ReviewItem,
} from './messages';
import { declaresSecret, VAULT_SCRIPT_PREFIX, type VaultCandidate, type VaultUserScriptRegistration } from './vault';
import { reconcileVault, principalForToken, emptyVaultState, VAULT_STATE_KEY, type VaultState } from './vault-sync';
import { SHIM_FILE_FORMAT } from '@shimbrowser/core/shim-folder';
import { openPageHost, type ExtensionPageHost, type SessionStorage, type SessionStorageScope, type SessionHandlerApi, type NudgeOutcome } from './page-host';
import { createSessions, type ExtensionSessionTarget } from './sessions';
import { settingsPageFields, valueForHandler, settingsTransport, checkSettingValue, settingsKey, settingsFields, needsSetup } from './settings';
import { brokerFetch, fetchReach } from './fetch';
import { createConsentGate, type ConsentAnswer, type PendingConsent } from './attach-consent';
import { routeControlRequest, type ControlDeps, type TabInfo, type AttachRequest } from './control';
import { createBridgePort, type PortLike } from './bridge-port';
import type { PageRuntimeEvent, PageConsoleMessage, PreviewRule, ScreenshotOptions, LoadWaitOptions, PageInputCommand, PageWorld } from '@shimbrowser/core/page-host';

let storePromise: Promise<ShimStore> | null = null;
function store(): Promise<ShimStore> {
  storePromise ??= openShimStore();
  return storePromise;
}

// --- vault shims ------------------------------------------------------------------
//
// A shim that declares a secret runs in a world of its own (vault.ts,
// vault-sync.ts), never in the default world beside other shims' handlers.
// Every message and port from a user-script world resolves to one principal
// at the door: the default world (no token), or one vault shim's current
// registration (its token). A vault shim's state answers only its own
// principal; an invalid token is refused, never read as the default world.

/**
 * Who sent a runtime message: the default world, or one vault shim's
 * current registration. The extension's own pages are the default principal
 * too; their messages are page messages, which no runtime may send.
 */
type Principal = { kind: 'default' } | { kind: 'vault'; shimId: string; generation: number };
const DEFAULT_PRINCIPAL: Principal = { kind: 'default' };

/** The vault registrations and tokens as last loaded or saved. */
let vaultState: VaultState | undefined;
/** True while vaultState is this worker's own write (a reconcile in flight here); false for one loaded from the store. */
let vaultOwnRun = false;
/** Shims given a world of their own for the harnesses (pageHosts.setVaultTestWorlds), with no secret declared. */
let vaultTestWorlds = new Set<string>();
const VAULT_TEST_KEY = 'vault.testWorlds';

function isVaultStateShape(v: unknown): v is VaultState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  const records = s.records as Record<string, unknown> | undefined;
  return (s.phase === 'idle' || s.phase === 'running')
    && typeof s.generations === 'object' && s.generations !== null
    && typeof records === 'object' && records !== null
    && Object.values(records).every((r) => {
      const rec = r as Record<string, unknown> | null;
      return rec !== null && typeof rec === 'object' && typeof rec.generation === 'number' && typeof rec.token === 'string' && Array.isArray(rec.matches);
    })
    && typeof s.refused === 'object' && s.refused !== null;
}

async function loadVault(): Promise<void> {
  const db = await store();
  const saved = await db.prefs.get(VAULT_STATE_KEY);
  // A record that does not read is accounting we cannot trust: treated as an
  // interrupted reconcile, so the next one revokes and re-registers everything.
  vaultState = saved === undefined ? undefined : isVaultStateShape(saved) ? saved : { ...emptyVaultState(), phase: 'running' };
  vaultOwnRun = false;
  const test = await db.prefs.get(VAULT_TEST_KEY);
  vaultTestWorlds = new Set(Array.isArray(test) ? test.filter((x): x is string => typeof x === 'string') : []);
}
const vaultReady: Promise<void> = loadVault().catch((err: unknown) => {
  console.error('[shim] could not read the vault state', err);
  vaultState = { ...emptyVaultState(), phase: 'running' };
});

/** Does this shim run in a world of its own? Read before vaultReady settles, the test flag reads as unset. */
function isVaultShim(shim: InstalledShim): boolean {
  return declaresSecret(shim.spec) || vaultTestWorlds.has(shim.id);
}

/** The vault shim's current registration generation, if it has one. */
function vaultGeneration(shimId: string): number | null {
  const record = vaultState?.phase === 'idle' || vaultOwnRun ? vaultState?.records[shimId] : undefined;
  return record ? record.generation : null;
}

/** May `principal` act for `shim`? A vault shim answers only its current registration; every other shim only the default world. */
function mayActFor(shim: InstalledShim, principal: Principal): boolean {
  if (!isVaultShim(shim)) return principal.kind === 'default';
  return principal.kind === 'vault' && principal.shimId === shim.id && vaultGeneration(shim.id) === principal.generation;
}

/** The principal a runtime message proves: none (`null`) for a token that is not current, or one from anywhere but a user-script world. */
async function principalFor(world: RuntimeWorld, auth: unknown): Promise<Principal | null> {
  if (auth === undefined) return DEFAULT_PRINCIPAL;
  if (world !== 'user-script') return null;
  await vaultReady;
  const found = principalForToken(vaultState, auth, vaultOwnRun);
  return found ? { kind: 'vault', ...found } : null;
}

/** Rotation asked for since the last vault reconcile: every shim's, or these. */
let vaultRotation: 'all' | Set<string> = new Set();
function requestVaultRotation(ids: 'all' | readonly string[]): void {
  if (ids === 'all' || vaultRotation === 'all') vaultRotation = 'all';
  else for (const id of ids) vaultRotation.add(id);
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
/** Configures the default world if this boot has not; answers whether it did (the vault worlds then need theirs again too). */
async function configureUserScriptWorld(): Promise<boolean> {
  if (worldConfigured) return false;
  await userScriptsApi().resetWorldConfiguration();
  await chrome.userScripts.configureWorld({ csp: USER_SCRIPT_WORLD_CSP, messaging: true });
  worldConfigured = true;
  return true;
}

/** chrome.userScripts with the members the bundled types may lack (worldId: Chrome 133; resetWorldConfiguration: 128). */
function userScriptsApi(): {
  resetWorldConfiguration(worldId?: string): Promise<void>;
  configureWorld(config: { worldId?: string; csp?: string; messaging?: boolean }): Promise<void>;
  register(scripts: VaultUserScriptRegistration[]): Promise<void>;
} {
  return chrome.userScripts as unknown as ReturnType<typeof userScriptsApi>;
}

let vaultRuntimeSource: Promise<string> | null = null;

/**
 * The vault registrations brought in line with the vault shims that should
 * run (enabled, fitting, granted), with any rotation asked for since the last
 * time. A failure is logged and leaves the state marked interrupted, so every
 * vault token is refused until a later sync recovers.
 */
async function syncVault(vaultShims: readonly InstalledShim[], configure: boolean): Promise<void> {
  const candidates: VaultCandidate[] = [];
  for (const shim of vaultShims) {
    const matches = patternsFor(shim);
    if (matches.length && (await chrome.permissions.contains({ origins: matches }))) candidates.push({ id: shim.id, name: shim.name, matches });
  }
  const rotation = vaultRotation;
  vaultRotation = new Set();
  const db = await store();
  try {
    await reconcileVault({
      load: () => Promise.resolve(vaultState),
      save: async (state) => {
        await db.prefs.set(VAULT_STATE_KEY, state);
        vaultState = state;
        vaultOwnRun = state.phase === 'running';
      },
      registeredIds: async () => (await chrome.userScripts.getScripts()).map((x) => x.id).filter((id) => id.startsWith(VAULT_SCRIPT_PREFIX)),
      unregister: (ids) => chrome.userScripts.unregister({ ids }),
      register: (registrations) => userScriptsApi().register(registrations),
      configureWorld: async (worldId, csp) => {
        // Reset first: Chrome keeps a world's configuration across the toggle
        // going off and on, so a repeat would never reach the renderers.
        await userScriptsApi().resetWorldConfiguration(worldId);
        await userScriptsApi().configureWorld({ worldId, csp, messaging: true });
      },
      runtimeSource: () => {
        vaultRuntimeSource ??= fetch(chrome.runtime.getURL('vault-content.js')).then((r) => r.text());
        return vaultRuntimeSource;
      },
      engineSource: engineBundle,
    }, { candidates, rotate: rotation === 'all' ? 'all' : [...rotation], configure });
  } catch (err) {
    vaultOwnRun = false;
    console.error('[shim] the vault registrations could not be synced; vault shims are off until the next sync', err instanceof Error ? err.message : String(err));
  }
}

async function syncRegistrations(): Promise<void> {
  await serialized(async () => {
    await vaultReady;
    const mode = await refreshMode();
    const fitting = (await (await store()).listShims()).filter(fitsMode);
    // The default world's registrations leave vault shims out: they run only in their own world.
    const shims = fitting.filter((shim) => !isVaultShim(shim));
    // Our content scripts go first in both modes: declarative mode replaces
    // them, full mode runs the engine in the user-script world alone (one
    // engine per document, and a mode flip leaves the other mode's
    // registrations behind).
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const ours = existing.map((s) => s.id).filter((id) => shimIdFor(id) !== null);
    if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });
    if (mode === 'full') {
      const reconfigured = await configureUserScriptWorld();
      const registered = await chrome.userScripts.getScripts();
      const stale = registered.map((s) => s.id).filter((id) => shimIdFor(id) !== null);
      if (stale.length) await chrome.userScripts.unregister({ ids: stale });
      const wanted = await granted(userScriptRegistrationsFor(shims));
      if (wanted.length) await chrome.userScripts.register(wanted);
      await syncVault(fitting.filter((shim) => shim.enabled && isVaultShim(shim)), reconfigured);
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
// A port belongs to one document's runtime in one world, as one principal:
// the default world's runtime (at most one per tab, the arbitration below),
// or a vault shim's (one per vault world). A port is quarantined until its
// first message says which (vault.ts), and nothing is posted to it before.
interface RuntimeRecord {
  tabId: number;
  world: RuntimeWorld;
  documentId?: string;
  principal: Principal;
}
const runtimePorts = new Map<chrome.runtime.Port, RuntimeRecord>();
/** How long a new port may stay silent before its first message; then it is closed. */
const PORT_HELLO_MS = 3000;
const isDefaultRecord = (r: RuntimeRecord): boolean => r.principal.kind === 'default';
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
    const documentId = (port.sender as { documentId?: unknown } | undefined)?.documentId;
    const doc = typeof documentId === 'string' ? documentId : undefined;
    let first = true;
    const silent = setTimeout(() => { if (first) { first = false; disconnectQuietly(port); } }, PORT_HELLO_MS);
    port.onMessage.addListener((msg: unknown) => {
      if (!isFromRuntime(msg)) return;
      if (first) {
        first = false;
        clearTimeout(silent);
        void classifyPort(port, world, tabId, doc, msg);
        return;
      }
      // An ack counts only on the port its nudge went to.
      if (msg.type === 'ack') pendingAcks.get(msg.seq)?.(port, msg);
    });
  };
}

function disconnectQuietly(port: chrome.runtime.Port): void {
  try { port.disconnect(); } catch { /* already gone */ }
}

/** The port's first message decides it: a default-world runtime's hello, or a vault world's token. Anything else closes it. */
async function classifyPort(port: chrome.runtime.Port, world: RuntimeWorld, tabId: number, documentId: string | undefined, first: FromRuntime): Promise<void> {
  if (first.type === 'hello') {
    acceptDefaultPort(port, world, tabId, documentId);
    return;
  }
  if (first.type === 'auth') {
    const principal = await principalFor(world, first.token);
    if (principal?.kind === 'vault') {
      runtimePorts.set(port, { tabId, world, ...(documentId !== undefined ? { documentId } : {}), principal });
      port.onDisconnect.addListener(() => { runtimePorts.delete(port); });
      notifyPortWaiters(tabId, port);
      post(port, { type: 'sync' });
      return;
    }
  }
  disconnectQuietly(port);
}

function acceptDefaultPort(port: chrome.runtime.Port, world: RuntimeWorld, tabId: number, documentId: string | undefined): void {
  {
    const record = (w: RuntimeWorld): RuntimeRecord => ({ tabId, world: w, ...(documentId !== undefined ? { documentId } : {}), principal: DEFAULT_PRINCIPAL });
    // One runtime per page. Two can meet when a handover and a reconnect
    // cross (a holder's port down for the moment, the other world's
    // runtime injected beside it, the holder reconnecting later): the one
    // that does not fit the mode is retired, whichever connected first,
    // and the survivor reboots if the loser had run, since the loser's
    // teardown takes stylesheets and tokens the survivor's rules share
    // (arbitrate.ts).
    // The page's mark is only a hint; this is the decision.
    const rival = [...runtimePorts].find(([, r]) => r.tabId === tabId && r.world !== world && isDefaultRecord(r));
    if (rival) {
      const [rivalPort, { world: rivalWorld }] = rival;
      const verdict = arbitrate(rivalWorld, world, modeNow);
      if (verdict?.retire === 'incoming') {
        retireFor(port, rivalPort);
        return;
      }
      runtimePorts.delete(rivalPort);
      runtimePorts.set(port, record(world));
      port.onDisconnect.addListener(() => { runtimePorts.delete(port); });
      retireFor(rivalPort, port);
      return;
    }
    runtimePorts.set(port, record(world));
    port.onDisconnect.addListener(() => { runtimePorts.delete(port); });
    notifyPortWaiters(tabId, port);
    // A connection is a runtime that may have missed a change: the worker
    // it held a port to went away (idled out) and the change happened
    // before this one reconnected, when no port was there to nudge. So
    // every connection starts with a look at what runs there.
    post(port, { type: 'sync' });
  }
}
chrome.runtime.onConnect.addListener(acceptRuntimePort('isolated'));
const onUserScriptConnect = (chrome.runtime as { onUserScriptConnect?: chrome.events.Event<(port: chrome.runtime.Port) => void> }).onUserScriptConnect;
if (onUserScriptConnect) onUserScriptConnect.addListener(acceptRuntimePort('user-script'));

/** The engine and the runtime into `tabId`, or the runtime alone where the engine already runs, in the mode's world. */
async function injectRuntime(tabId: number, mode: ExtensionMode): Promise<void> {
  const [engine, runtime] = RUNTIME_FILES;
  if (engine === undefined || runtime === undefined) return;
  if (mode === 'full') {
    // The default world only: a vault shim's world is never injected into an
    // open document (vault.ts), it comes with the next load.
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
  // What an isolated-world runtime is told: in full mode it leaves, and a
  // user-script runtime is injected in its place.
  const toIsolated: ToRuntime = mode === 'full' ? { type: 'retire' } : { type: 'sync' };
  for (const [port, record] of runtimePorts) {
    const nudge: ToRuntime = record.world === 'isolated' ? toIsolated : { type: 'sync' };
    post(port, nudge);
    // A vault world's runtime looks again too (a revoked token tears it down),
    // but it is not the tab's default runtime: that one may still be missing.
    if (nudge.type === 'sync' && isDefaultRecord(record) && runtimePorts.has(port)) answered.add(record.tabId);
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
  await vaultReady;
  // Vault shims are left out: their world is never injected into an open page.
  const shims = (await (await store()).listShims()).filter((shim) => shim.enabled && fitsMode(shim) && !isVaultShim(shim));
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
/** Gives back the origins `patterns` needed that no installed shim still needs. */
async function releaseUnusedOrigins(db: ShimStore, patterns: readonly string[]): Promise<void> {
  const remaining = await db.listShims();
  const release = originsToRelease(patterns, remaining);
  if (!release.length) return;
  try {
    await chrome.permissions.remove({ origins: release });
  } catch {
    // A pattern the user already revoked: nothing to release.
  }
}

// A draft is a shim a session created and never committed. Its session
// died with the worker that ran it (a finish would have settled it), so
// the next worker removes it, with the grant it alone needed, before any
// registration or bridge connection could serve it.
async function sweepDrafts(): Promise<void> {
  const db = await store();
  for (const shim of await db.listShims()) {
    if (!shim.sessionDraft) continue;
    await db.deleteShim(shim.id);
    await releaseUnusedOrigins(db, patternsFor(shim));
  }
}

async function bootRefresh(): Promise<void> {
  const { booted } = await chrome.storage.session.get('booted');
  await sweepDrafts();
  await syncRegistrations();
  if (booted === true) return;
  await chrome.storage.session.set({ booted: true });
  await refreshOpenTabs(await activePatterns());
}

// Install and update clear user scripts, and a browser start brings back the
// registrations (and tokens) of the last session: every vault token rotates.
chrome.runtime.onInstalled.addListener(() => { requestVaultRotation('all'); void syncRegistrations(); });
chrome.runtime.onStartup.addListener(() => { requestVaultRotation('all'); void syncRegistrations(); });
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
    // A vault shim runs only in its own user-script world: never in declarative mode.
    needsFullMode: !fitsMode(shim) || (isVaultShim(shim) && modeNow !== 'full'),
    version: specVersion(shim.spec),
    review,
    settingsCount: settingsFields(shim.spec).length,
    needsSetup: needsSetup(shim.spec, await db.settings.get(shim.id)),
    ...(isVaultShim(shim) ? { vault: { overlapping: vaultState?.refused[shim.id] ?? null } } : {}),
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

/**
 * Per shim, the spec write in flight; the next waits for it. Every write
 * that reads the spec, computes and writes (an event kept, a restore) runs
 * in here, so two never read one version and both write the next.
 */
const ingesting = new Map<string, Promise<void>>();
function chained<T>(shimId: string, work: () => Promise<T>): Promise<T> {
  const run = (ingesting.get(shimId) ?? Promise.resolve()).then(work);
  ingesting.set(shimId, run.then(() => undefined, () => undefined));
  return run;
}

/** One engine event from the runtime of `shim` on `page`; answers whether the open pages should look again. */
async function ingestEvent(db: ShimStore, shim: InstalledShim, page: { hostname: string }, kind: string, payload: RuntimeEventPayload): Promise<boolean> {
  const ruleId = typeof payload.ruleId === 'string' ? payload.ruleId : null;
  switch (kind) {
    case 'rule-rebase': {
      if (!ruleId || !eventFormMatches(shim.spec, shim.handlers, ruleId, payload.form)) return false;
      // The page kind's baseline advances with the rebase, before the page is
      // served its baseline again, so the re-run sees no deploy.
      await recordBaseline(db, shim.id, page.hostname, payload);
      const out = rebasedSpec(shim.spec, ruleId, payload.anchor, payload.bundleHash);
      if (!out) return false;
      if (!(await db.reviseSpec(shim.id, out.spec, shim.handlers, 'rebase', specVersion(shim.spec)))) return false;
      // Healed: whatever review it was held for no longer applies, and its
      // fingerprint is the rebase's now, committed, never captured over.
      const state = await ruleStateFor(db, shim.id, ruleId);
      if (state.quarantine || state.capture) await db.ruleState.put({ ...state, quarantine: undefined, capture: undefined });
      console.log(`[shim] auto-rebase (${String(payload.strategy)}${payload.via ? ` via ${String(payload.via)}` : ''}) ${shim.id}/${ruleId}: spec v${out.version}`);
      return true;
    }
    case 'spec-bundle-update': {
      await recordBaseline(db, shim.id, page.hostname, payload);
      const next = refreshedSpec(shim.spec, payload.bundleHash);
      if (next) await db.amendSpec(shim.id, next, specVersion(shim.spec));
      return false;
    }
    case 'rule-witness': {
      if (!ruleId || !eventFormMatches(shim.spec, shim.handlers, ruleId, payload.form)) return false;
      const state = await ruleStateFor(db, shim.id, ruleId);
      const out = capturedSpec(shim.spec, ruleId, state.capture, payload);
      if (!out) return false;
      if (await db.amendSpec(shim.id, out.spec, specVersion(shim.spec))) await db.ruleState.put({ ...state, capture: out.capture });
      return false;
    }
    case 'rule-status': {
      if (!ruleId || typeof payload.matched !== 'number' || payload.matched <= 0 || typeof payload.path !== 'string') return false;
      const state = await ruleStateFor(db, shim.id, ruleId);
      await db.ruleState.put({ ...state, paths: rememberPath(state.paths, payload.path, Date.now()) });
      return false;
    }
    case 'rule-quarantined': {
      if (!ruleId || !eventFormMatches(shim.spec, shim.handlers, ruleId, payload.form)) return false;
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

async function bundleFor(page: { hostname: string; port: string; pathname: string }, world: RuntimeWorld, principal: Principal): Promise<BundledShim[]> {
  const capabilities = capabilitiesForWorld(world);
  const withHandlers = capabilities === capabilitiesFor('full');
  const db = await store();
  const shims = await db.listShims();
  const out: BundledShim[] = [];
  for (const shim of shims) {
    // The default world gets every shim but the vault shims; a vault world its own shim alone.
    if (!mayActFor(shim, principal)) continue;
    if (!(await runsOn(shim, page, capabilities))) continue;
    // Handler source goes only where it compiles: the user-script world, in full mode.
    const handlers = withHandlers ? { ...shim.handlers } : {};
    // The deploy baseline a page is judged against is its own page kind's,
    // never the shim-wide one: a multi-page site loads a different bundle per
    // page kind. No baseline for this kind → the engine judges no deploy, and
    // a clean resolve records one.
    const baseline = baselineForPath(await db.baselines.forHost(shim.id, page.hostname), page.pathname);
    const spec = { ...shim.spec, bundleHash: baseline ?? undefined };
    // Read the values only for a shim that declares settings: every page load runs this.
    const settings = settingsFields(shim.spec).length ? settingsKey(shim.spec, await db.settings.get(shim.id)) : undefined;
    out.push({
      id: shim.id, spec, priority: priorityForRank(shim.rank), version: specVersion(shim.spec), handlers, forms: ruleForms(shim.spec, shim.handlers),
      ...(settings !== undefined ? { settingsKey: settings } : {}),
    });
  }
  return out;
}

async function handle(msg: ToWorker, from: SenderContext, world: RuntimeWorld, principal: Principal): Promise<WorkerAnswer> {
  if (!allowedFrom(msg.type, from)) return { ok: false, error: 'not from a sender this message is answered for' };
  // A vault world sends runtime messages only; everything else is the default principal's.
  if (principal.kind === 'vault' && from.kind !== 'content') return { ok: false, error: 'not from a sender this message is answered for' };
  await vaultReady;
  // Every message is a moment the mode may have flipped since the last look.
  await reconcileMode();
  const db = await store();
  // A content message is about the sender's own page and one of the shims
  // that run there; the page named in a message body would be the page's word.
  const page = from.kind === 'content' ? from : null;
  switch (msg.type) {
    case 'bundle': {
      if (!page) return { ok: false, error: 'no page' };
      // The holds a session has on this tab, current as of this sequence.
      const shims = await bundleFor(page, world, principal);
      const held = page.tabId === undefined ? undefined : hostOnTab(page.tabId)?.heldAll();
      await holdSeqReady;
      return { ok: true, mode: modeNow, shims, ...(held ? { held } : {}), holdSeq };
    }
    case 'storage': {
      if (!page) return { ok: false, error: 'no page' };
      const shim = await db.getShim(msg.shimId);
      if (!shim || !mayActFor(shim, principal) || !(await runsOn(shim, page, capabilitiesForWorld(world)))) return { ok: false, error: 'not a shim of this page' };
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
    case 'settings': {
      // The shim's declared keys only, resolved against what the user set;
      // like storage, only for a shim that runs on the sender's page.
      if (!page) return { ok: false, error: 'no page' };
      const shim = await db.getShim(msg.shimId);
      if (!shim || !mayActFor(shim, principal) || !(await runsOn(shim, page, capabilitiesForWorld(world)))) return { ok: false, error: 'not a shim of this page' };
      const stored = await db.settings.get(shim.id);
      return { ok: true, value: msg.method === 'getAll' ? settingsTransport(shim.spec, stored) : valueForHandler(shim.spec, stored, msg.key) };
    }
    case 'fetch': {
      // The broker answers a handler of a shim that runs here, in a world
      // where handlers run (fetch is a full-mode member).
      if (!page) return { ok: false, error: 'no page' };
      const shim = await db.getShim(msg.shimId);
      const capabilities = capabilitiesForWorld(world);
      if (!shim || !mayActFor(shim, principal) || !(await runsOn(shim, page, capabilities))) return { ok: false, error: 'not a shim of this page' };
      if (!capabilities.apiMembers.includes('fetch')) return { ok: false, error: 'api.fetch runs only with user scripts on' };
      return { ok: true, value: await brokerFetch(msg.url, msg.opts, { mayRead: fetchReachFor(shim.spec.match?.hosts) }) };
    }
    case 'event': {
      if (!page) return { ok: false, error: 'no page' };
      const shimId = msg.shimId;
      const capabilities = capabilitiesForWorld(world);
      // One shim's events are kept one after another: two rebases reported
      // by one document (two rules healed in one pass) each read the spec
      // the other wrote, so neither overwrites the other's anchor.
      return chained(shimId, async (): Promise<WorkerAnswer> => {
        const shim = await db.getShim(shimId);
        if (!shim || !mayActFor(shim, principal) || !(await runsOn(shim, page, capabilities))) return { ok: false, error: 'not a shim of this page' };
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
    case 'shims.restore':
      // A session holding the shim ends first, and its teardown is waited
      // for outside the write chain (its commit may be queued on it).
      await sessions.preempt(msg.id);
      return chained(msg.id, async (): Promise<WorkerAnswer> => {
        const shim = await db.getShim(msg.id);
        if (!shim) return { ok: false, error: 'no such shim' };
        const current = specVersion(shim.spec);
        const snapshot = await db.versions.get(shim.id, msg.version);
        if (!snapshot) return { ok: false, error: 'no such version' };
        // A restore is a forward change: the chosen spec comes back as the
        // next version (never the old number, so history stays a line). Its
        // rules' reviews and captures are cleared: whatever broke, this is
        // a different spec now, and its fingerprints are the snapshot's.
        // The current version's source is the spec as it stands (its
        // snapshot is refreshed only as it is revised away), amendments
        // and all.
        const source = msg.version === current ? shim.spec : snapshot.spec;
        const handlers = msg.version === current ? shim.handlers : snapshot.handlers;
        const next = { ...source, id: shim.id, version: current + 1 };
        if (!(await db.reviseSpec(shim.id, next, handlers, 'restore', current))) return { ok: false, error: 'the shim changed meanwhile; try again' };
        for (const state of await db.ruleState.listForShim(shim.id)) {
          if (state.quarantine || state.capture) await db.ruleState.put({ ...state, quarantine: undefined, capture: undefined });
        }
        await refreshOpenTabs(patternsFor(shim));
        return { ok: true };
      });
    case 'settings.fields': {
      const shim = await db.getShim(msg.id);
      if (!shim) return { ok: false, error: 'no such shim' };
      return { ok: true, name: shim.name, fields: settingsPageFields(shim.spec, await db.settings.get(shim.id)) };
    }
    case 'settings.set':
    case 'settings.clear': {
      const shim = await db.getShim(msg.id);
      if (!shim) return { ok: false, error: 'no such shim' };
      if (msg.type === 'settings.set') {
        const checked = checkSettingValue(shim.spec, msg.key, msg.value);
        if (!checked.ok) return { ok: false, error: checked.error };
        await db.settings.set(shim.id, msg.key, checked.value);
      } else {
        await db.settings.delete(shim.id, msg.key);
      }
      // A handler reads a setting when it runs: the open pages reboot the
      // shim (its settings digest moved), as the Shim browser re-applies it.
      await refreshOpenTabs(patternsFor(shim));
      return { ok: true };
    }
    case 'shims.setEnabled': {
      const shim = await db.getShim(msg.id);
      if (!shim) return { ok: false, error: 'no such shim' };
      await db.setEnabled(msg.id, msg.enabled);
      // Enabling a vault shim gives it a new registration and token; its world comes with the next load.
      if (msg.enabled && isVaultShim(shim)) requestVaultRotation([shim.id]);
      await syncRegistrations();
      await refreshOpenTabs(patternsFor(shim));
      return { ok: true };
    }
    case 'shims.uninstall': {
      const shim = await db.getShim(msg.id);
      if (!shim) return { ok: false, error: 'no such shim' };
      await sessions.preempt(msg.id);
      await db.deleteShim(msg.id);
      await syncRegistrations();
      // Open pages tear the shim down while its hosts are still ours; the
      // release comes after.
      await refreshOpenTabs(patternsFor(shim));
      await releaseUnusedOrigins(db, patternsFor(shim));
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
    case 'bridge.status':
      return { ok: true, bridge: { enabled: await bridgeEnabled(), connected: bridgePort.connected(), error: bridgePort.lastError(), sessions: sessions.registry.list().length } };
    case 'bridge.setEnabled':
      await setBridgeEnabled(msg.enabled);
      return { ok: true };
    case 'attach.pending':
      return { ok: true, pending: consent.pending() };
    case 'attach.answer':
      return consent.answer(msg.id, msg.answer) ? { ok: true } : { ok: false, error: 'that request is no longer waiting' };
    default:
      return { ok: false, error: 'unknown message' };
  }
}

// --- the session hosts --------------------------------------------------------------
//
// A PageHost per tab a session drives (page-host.ts). Opened and driven from
// inside the worker (a session's registry, the bridge) and, in the
// conformance runner, through the handle below over the worker's own global.
// Previews' api.storage goes to the installed shim's rows when the preview's
// shim is installed, and to the host's own bucket otherwise.

// Holds are ordered: every hold nudge carries the next sequence number, a
// bundle answer carries the current one, and a runtime applies only what is
// newer than what it has, so a hold that crosses a bundle answer in flight
// is not undone by it. The sequence outlives this worker: a page's runtime
// keeps the last it saw across the worker idling out and starting again,
// so the next worker continues from where the last one was
// (chrome.storage.session, which lives as long as the browser session, as
// the pages do), seeded no lower than the clock in case that record is
// gone. A worker that still fell behind (the clock set back, the record
// gone) learns so from the runtime's ack, which says whether the nudge was
// applied; a stale one is no hold.
const HOLD_SEQ_KEY = 'holdSeq';
let holdSeq = 0;
const seedHoldSeq = async (): Promise<void> => {
  let stored = 0;
  try {
    const got = await chrome.storage.session.get(HOLD_SEQ_KEY);
    if (typeof got[HOLD_SEQ_KEY] === 'number') stored = got[HOLD_SEQ_KEY];
  } catch { /* no record */ }
  holdSeq = Math.max(holdSeq, stored, Date.now());
};
let holdSeqReady: Promise<void> = seedHoldSeq();
async function nextHoldSeq(): Promise<number> {
  await holdSeqReady;
  holdSeq += 1;
  void chrome.storage.session.set({ [HOLD_SEQ_KEY]: holdSeq }).catch(() => undefined);
  return holdSeq;
}
type RuntimeAck = Extract<FromRuntime, { type: 'ack' }>;
const pendingAcks = new Map<number, (port: chrome.runtime.Port, ack: RuntimeAck) => void>();
const NUDGE_ACK_MS = 2000;
// How long a nudge waits for a runtime's port when one is expected and
// none is connected: a runtime whose port the worker dropped (idled out)
// reconnects a second later, and gets its hold then.
const PORT_WAIT_MS = 3000;
const portWaiters = new Map<number, Array<(port: chrome.runtime.Port) => void>>();
function notifyPortWaiters(tabId: number, port: chrome.runtime.Port): void {
  for (const waiter of [...(portWaiters.get(tabId) ?? [])]) waiter(port);
}
/** The next port on `tabId` whose runtime `wanted` accepts, or null after `ms`. */
function waitForPort(tabId: number, ms: number, wanted: (record: RuntimeRecord) => boolean): Promise<chrome.runtime.Port | null> {
  return new Promise((resolve) => {
    const waiters = portWaiters.get(tabId) ?? [];
    const remove = (): void => {
      const list = portWaiters.get(tabId) ?? [];
      const i = list.indexOf(onPort);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) portWaiters.delete(tabId);
    };
    const settle = (port: chrome.runtime.Port | null): void => {
      clearTimeout(timer);
      remove();
      resolve(port);
    };
    const onPort = (port: chrome.runtime.Port): void => {
      const record = runtimePorts.get(port);
      if (record && wanted(record)) settle(port);
    };
    const timer = setTimeout(() => settle(null), ms);
    waiters.push(onPort);
    portWaiters.set(tabId, waiters);
  });
}

/**
 * Which runtime on a page a nudge about `shimId` is for: a vault shim's own
 * world, or the default world for every other shim (a preview's id
 * included). With no shim, every runtime there.
 */
async function nudgeTarget(shimId: string | undefined): Promise<(record: RuntimeRecord) => boolean> {
  if (shimId === undefined) return () => true;
  await vaultReady;
  const shim = shimId.includes(':') ? undefined : await (await store()).getShim(shimId);
  if (shim && isVaultShim(shim)) return (r) => r.principal.kind === 'vault' && r.principal.shimId === shim.id;
  return isDefaultRecord;
}

/** Does an installed shim run on the tab's page (so a committed runtime is there, port or no port)? */
async function runtimeExpected(tabId: number, wanted: (record: RuntimeRecord) => boolean): Promise<boolean> {
  let url: URL;
  try {
    const tab = await chrome.tabs.get(tabId);
    url = new URL(tab.url ?? '');
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const page = { hostname: url.hostname, port: url.port };
  const capabilities = capabilitiesFor(modeNow);
  for (const shim of await (await store()).listShims()) {
    if (!(await runsOn(shim, page, capabilities))) continue;
    // The shim's runtime is the one wanted: its own world for a vault shim, the default world otherwise.
    const principal: Principal = isVaultShim(shim) ? { kind: 'vault', shimId: shim.id, generation: vaultGeneration(shim.id) ?? -1 } : DEFAULT_PRINCIPAL;
    if (wanted({ tabId, world: 'user-script', principal })) return true;
  }
  return false;
}

/**
 * A nudge to the page's committed runtime, over its port (both worlds) or
 * the isolated world's message. Answers what became of it: `acked` by a
 * runtime, `no-runtime` when none is there to, `timed-out` when one may be
 * there but did not answer in time, which the host treats as a hold not
 * taken: a session is never held up by a page that does not answer, and
 * never previews beside a twin it is not sure is down.
 *
 * "None is there" is the registry's word, not the channel's: a user-script
 * runtime has no message listener and may be between ports (the worker
 * idled out and woke, the runtime reconnects a second later) with its
 * committed rules still running. So when an installed shim runs on the
 * page, a nudge with no port waits for one, and a message no runtime
 * answers is uncertainty, not absence.
 */
async function nudgeTab(
  tabId: number, msg: Extract<ToRuntime, { seq?: number }>, accepts: (ack: RuntimeAck) => boolean = (ack) => ack.applied, shimId?: string,
): Promise<NudgeOutcome> {
  const seq = await nextHoldSeq();
  const stamped: ToRuntime = { ...msg, seq };
  // A hold is about one shim, and goes to the runtime that runs it; the end of a session to every runtime on the page.
  const wanted = await nudgeTarget(msg.type === 'hold' ? msg.patchId : shimId);
  let ports = [...runtimePorts].filter(([, r]) => r.tabId === tabId && wanted(r)).map(([port]) => port);
  const expected = ports.length > 0 || await runtimeExpected(tabId, wanted);
  if (!ports.length && expected) {
    const port = await waitForPort(tabId, PORT_WAIT_MS, wanted);
    if (port) ports = [port];
  }
  return new Promise((resolve) => {
    let done = false;
    const settle = (outcome: NudgeOutcome): void => {
      if (done) return;
      done = true;
      pendingAcks.delete(seq);
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => settle('timed-out'), NUDGE_ACK_MS);
    // Acked once every port it went to has acked it, each on its own port. A
    // runtime that ignored the nudge as older than what it has answered too,
    // and that is no hold.
    const waiting = new Set(ports);
    pendingAcks.set(seq, (port, ack) => {
      if (!waiting.has(port)) return;
      if (!accepts(ack)) { settle('timed-out'); return; }
      waiting.delete(port);
      if (!waiting.size) settle('acked');
    });
    if (ports.length) {
      for (const port of ports) post(port, stamped);
      return;
    }
    // No port: an isolated-world runtime of the default world, if one is there, answers the message.
    if (!wanted({ tabId, world: 'isolated', principal: DEFAULT_PRINCIPAL })) { settle(expected ? 'timed-out' : 'no-runtime'); return; }
    chrome.tabs.sendMessage(tabId, stamped).then(() => settle('acked'), () => settle(expected ? 'timed-out' : 'no-runtime'));
  });
}


/**
 * What a shim's api.fetch may read through the extension's access (fetch.ts
 * fetchReach): the worker skips CORS on every site the extension holds, so a
 * shim reads its own sites (it runs there already) but never another shim's,
 * and what a fetch reaches does not depend on what else is installed.
 */
function fetchReachFor(hosts: readonly unknown[] | undefined): (url: URL) => Promise<string | null> {
  return fetchReach(hosts, (pattern) => chrome.permissions.contains({ origins: [pattern] }));
}

/**
 * The installed shim a preview's call is about, when that shim runs on the
 * page's origin (enabled, hosts cover it, granted), else null: a preview of a
 * shim installed for another site reads nothing of it, storage or settings.
 */
async function installedRunsOn(db: ShimStore, scope: SessionStorageScope): Promise<InstalledShim | null> {
  await vaultReady;
  if (scope.patchId === '' || scope.patchId.includes(':')) return null;
  const shim = await db.getShim(scope.patchId);
  if (!shim) return null;
  let page: { hostname: string; port: string };
  try {
    const u = new URL(scope.origin);
    page = { hostname: u.hostname, port: u.port };
  } catch {
    return null;
  }
  return (await runsOn(shim, page, SESSION_CAPABILITIES)) ? shim : null;
}

/**
 * The installed shim whose saved state a preview may read and write: never a
 * vault shim, whose state answers only its own world's token. A vault shim's
 * previews use the session's scratch bucket and read no stored setting.
 */
async function installedStateFor(db: ShimStore, scope: SessionStorageScope): Promise<InstalledShim | null> {
  const shim = await installedRunsOn(db, scope);
  return shim && !isVaultShim(shim) ? shim : null;
}

/**
 * Previews' api.settings and api.fetch. Settings resolve the session's
 * working declaration (a field just declared reads its default) against the
 * installed shim's values; fetch is the broker installed shims use.
 */
function sessionHandlerApiFor(db: ShimStore): SessionHandlerApi {
  return {
    async settings(scope) {
      const shim = await installedRunsOn(db, scope);
      const declarer = sessions.workingSpec(scope.patchId) ?? shim?.spec ?? null;
      const values = (await installedStateFor(db, scope)) ? await db.settings.get(shim?.id ?? '') : {};
      return settingsTransport(declarer, values);
    },
    async fetch(scope, url, opts) {
      // The preview's own sites (the working declaration's), only while that
      // shim runs on the preview's page, the gate storage and settings use;
      // otherwise no site is its own, and CORS decides everywhere else.
      const shim = await installedRunsOn(db, scope);
      const hosts = shim ? (sessions.workingSpec(scope.patchId) ?? shim.spec).match?.hosts : [];
      return brokerFetch(url, opts, { mayRead: fetchReachFor(hosts) });
    },
  };
}

function sessionStorageFor(db: ShimStore, bucket: Map<string, Map<string, unknown>>): SessionStorage {
  const own = (scope: SessionStorageScope): Map<string, unknown> => {
    const id = `${scope.origin}\n${scope.patchId}`;
    let b = bucket.get(id);
    if (!b) {
      b = new Map();
      bucket.set(id, b);
    }
    return b;
  };
  const installed = async (scope: SessionStorageScope): Promise<boolean> => (await installedStateFor(db, scope)) !== null;
  const asScope = (scope: SessionStorageScope) => ({ shimId: scope.patchId, origin: scope.origin });
  return {
    async get(scope, key) {
      if (await installed(scope)) return db.userData.get(asScope(scope), key);
      const v = own(scope).get(key);
      return v === undefined ? null : v;
    },
    async set(scope, key, value) {
      if (await installed(scope)) return db.userData.set(asScope(scope), key, value);
      const stored: unknown = JSON.parse(JSON.stringify(value) ?? 'null');
      own(scope).set(key, stored);
      return stored;
    },
    async delete(scope, key) {
      if (await installed(scope)) return db.userData.delete(asScope(scope), key);
      return own(scope).delete(key);
    },
    async list(scope) {
      if (await installed(scope)) return db.userData.list(asScope(scope));
      const out: Record<string, unknown> = {};
      for (const [k, v] of own(scope)) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
      return out;
    },
  };
}

let engineBundleText: Promise<string> | null = null;
function engineBundle(): Promise<string> {
  engineBundleText ??= fetch(chrome.runtime.getURL(RUNTIME_FILES[0] ?? 'shim-core.page.js')).then((r) => r.text());
  return engineBundleText;
}

interface OpenHost {
  host: ExtensionPageHost;
  events: PageRuntimeEvent[];
  console: PageConsoleMessage[];
  popups: string[];
  offs: Array<() => void>;
}
const openHosts = new Map<string, OpenHost>();
let hostSeq = 0;
/** The open host on a tab, if any (one per tab: the debugger attaches once). */
function hostOnTab(tabId: number): ExtensionPageHost | undefined {
  for (const { host } of openHosts.values()) if (host.tabId === tabId && !host.isClosed()) return host;
  return undefined;
}

/** Opens a PageHost on `tabId`; answers its handle. */
async function openHost(tabId: number): Promise<string> {
  if (hostOnTab(tabId)) throw new Error('a session already holds this tab');
  const db = await store();
  const host = await openPageHost(tabId, { engineBundle, storage: sessionStorageFor(db, new Map()), handlerApi: sessionHandlerApiFor(db), nudge: nudgeTab });
  const id = `host-${++hostSeq}`;
  const entry: OpenHost = { host, events: [], console: [], popups: [], offs: [] };
  entry.offs.push(host.onRuntimeEvent((e) => { entry.events.push(e); }));
  entry.offs.push(host.onConsole((m) => { entry.console.push(m); }));
  openHosts.set(id, entry);
  return id;
}

/**
 * The worker's handle on its session hosts, for a driver outside the worker
 * (the conformance runner, over the worker's global): open, call a member
 * by name, drain what the page reported since the last drain, close.
 */
const pageHosts = {
  open: openHost,
  async close(id: string): Promise<boolean> {
    const entry = openHosts.get(id);
    if (!entry) return false;
    openHosts.delete(id);
    for (const off of entry.offs) off();
    await entry.host.close();
    return true;
  },
  drain(id: string): { url: string; closed: boolean; events: PageRuntimeEvent[]; console: PageConsoleMessage[]; popups: string[] } | null {
    const entry = openHosts.get(id);
    if (!entry) return null;
    const out = { url: entry.host.url(), closed: entry.host.isClosed(), events: entry.events, console: entry.console, popups: entry.popups };
    entry.events = [];
    entry.console = [];
    entry.popups = [];
    return out;
  },
  /**
   * For the harnesses: the hold sequence as a worker that starts with no
   * record of it would seed it (`forgetHoldSeq`), or set to a value the
   * pages are past (`forceHoldSeq`), since a real restart of the worker
   * cannot be driven under Playwright (its own attachment keeps the
   * worker alive).
   */
  async forgetHoldSeq(): Promise<number> {
    await chrome.storage.session.remove(HOLD_SEQ_KEY).catch(() => undefined);
    holdSeq = 0;
    holdSeqReady = seedHoldSeq();
    await holdSeqReady;
    return holdSeq;
  },
  forceHoldSeq(seq: number): void {
    holdSeq = seq;
  },
  /**
   * For the harnesses: drop the tab's runtime ports the way the worker
   * idling out does (the runtime reconnects a second later, its committed
   * rules running meanwhile). Answers how many it dropped.
   */
  dropRuntimePorts(tabId: number): number {
    let n = 0;
    for (const [port, r] of [...runtimePorts]) {
      if (r.tabId !== tabId) continue;
      runtimePorts.delete(port);
      try { port.disconnect(); } catch { /* already gone */ }
      n++;
    }
    return n;
  },
  /** Watch popups (closed on creation and reported in `drain`) or stop. */
  watchPopups(id: string, on: boolean): boolean {
    const entry = openHosts.get(id);
    if (!entry) return false;
    if (on && !entry.offs.some((f) => f.name === 'popups')) {
      const off = entry.host.onPopup?.((url) => { entry.popups.push(url); });
      if (off) {
        const named = Object.defineProperty(() => off(), 'name', { value: 'popups' }) as () => void;
        entry.offs.push(named);
      }
    } else if (!on) {
      const i = entry.offs.findIndex((f) => f.name === 'popups');
      if (i >= 0) {
        entry.offs[i]?.();
        entry.offs.splice(i, 1);
      }
    }
    return true;
  },
  /**
   * For the harnesses: give these installed shims a world of their own, as
   * if each declared a secret (no secret is installable on Chrome yet).
   * Still preflighted against the mode like every shim; the registrations
   * sync before this answers.
   */
  async setVaultTestWorlds(ids: string[]): Promise<void> {
    await vaultReady;
    const next = new Set(ids);
    const changed = [...new Set([...next, ...vaultTestWorlds])].filter((id) => next.has(id) !== vaultTestWorlds.has(id));
    vaultTestWorlds = next;
    await (await store()).prefs.set(VAULT_TEST_KEY, [...next]);
    requestVaultRotation(changed);
    await syncRegistrations();
    await refreshOpenTabs([]);
  },
  /** For the harnesses: the vault registrations as the worker holds them (generations and refusals; never a token). */
  async vaultState(): Promise<{ phase: string; generations: Record<string, number>; refused: Record<string, string[]>; scripts: string[] }> {
    await vaultReady;
    const records = vaultState?.records ?? {};
    const generations: Record<string, number> = {};
    for (const [id, r] of Object.entries(records)) generations[id] = r.generation;
    const scripts = (await chrome.userScripts.getScripts()).map((x) => x.id).filter((id) => id.startsWith(VAULT_SCRIPT_PREFIX));
    return { phase: vaultState?.phase ?? 'none', generations, refused: { ...(vaultState?.refused ?? {}) }, scripts };
  },
  /** For the harnesses: rotate tokens (the grant-change and enable path) and sync. */
  async rotateVault(ids: string[] | 'all'): Promise<void> {
    requestVaultRotation(ids);
    await syncRegistrations();
    await refreshOpenTabs([]);
  },
  /**
   * For the harnesses: the state a worker that died mid-reconcile leaves (the
   * phase persisted as running, the registrations still in Chrome), loaded
   * as the next worker would load it. `recover` then syncs as that worker's boot does.
   */
  async interruptVault(): Promise<void> {
    await vaultReady;
    const state: VaultState = { ...(vaultState ?? emptyVaultState()), phase: 'running' };
    await (await store()).prefs.set(VAULT_STATE_KEY, state);
    await loadVault();
  },
  async recoverVault(): Promise<void> {
    await syncRegistrations();
    await refreshOpenTabs([]);
  },
  /** For the harnesses: the attach card's answer, and the bridge's switch, without the pages. */
  answerCard: (id: string, answer: ConsentAnswer): boolean => consent.answer(id, answer),
  pendingCards: (): PendingConsent[] => consent.pending(),
  sessions: () => sessions.registry.list(),
  setBridge: (enabled: boolean): Promise<void> => setBridgeEnabled(enabled),
  async call(id: string, method: string, args: unknown[]): Promise<unknown> {
    const entry = openHosts.get(id);
    if (!entry) throw new Error(`no such host: ${id}`);
    const h = entry.host;
    switch (method) {
      case 'url': return h.url();
      case 'isClosed': return h.isClosed();
      case 'capabilities': return h.capabilities;
      case 'evaluate': return h.evaluate(String(args[0]), args[1] as PageWorld);
      case 'screenshot': return h.screenshot(args[0] as ScreenshotOptions | undefined);
      case 'applyPreview': h.applyPreview(args[0] as PreviewRule); return undefined;
      case 'removePreview': h.removePreview(String(args[0])); return undefined;
      case 'reload': h.reload(typeof args[0] === 'string' ? args[0] : undefined); return undefined;
      case 'waitForLoad': return h.waitForLoad(args[0] as LoadWaitOptions);
      case 'input': return h.input?.(args[0] as PageInputCommand[], () => true);
      case 'documentToken': return h.documentToken();
      case 'navigationCount': return h.navigationCount?.();
      case 'heldFor': return h.heldFor(String(args[0]));
      case 'heldAll': return h.heldAll();
      default: throw new Error(`unknown host member: ${method}`);
    }
  },
};
(globalThis as unknown as { shimPageHosts: typeof pageHosts }).shimPageHosts = pageHosts;

// --- sessions and the bridge ----------------------------------------------------
//
// The session registry runs here (sessions.ts), the routes an MCP client
// drives are answered here (control.ts), and both reach the worker only
// through the native messaging port to `shim bridge` (bridge-port.ts),
// held while the popup's "let Claude Code author here" is on. Every session
// pends on the attach card (attach-consent.ts, attach.html) before it
// opens; nothing on a route answers a card.

const BRIDGE_PREF = 'bridge';
const REMEMBERED_KEY = 'attachRemembered';
const OPEN_TAB_TIMEOUT_MS = 30_000;

async function syncTabForVersion(tabId: number, shimId: string, version: number): Promise<NudgeOutcome> {
  return nudgeTab(tabId, { type: 'sync' }, (ack) => ack.applied && (ack.versions?.[shimId] ?? 0) >= version, shimId);
}

const sessions = createSessions({
  store,
  mode: () => modeNow,
  chained,
  syncTab: syncTabForVersion,
  refreshTabs: (shim) => refreshOpenTabs(patternsFor(shim)),
  removeDraft: async (shimId) => {
    const db = await store();
    const shim = await db.getShim(shimId);
    if (!shim || !shim.sessionDraft) return;
    await db.deleteShim(shimId);
    await syncRegistrations();
    await refreshOpenTabs(patternsFor(shim));
    await releaseUnusedOrigins(db, patternsFor(shim));
  },
});

const consent = createConsentGate();
// "Allow this host until Chrome restarts" outlives the worker: mirrored to
// session storage, which lives as long as the browser session.
const rememberedReady = (async () => {
  try {
    const got = await chrome.storage.session.get(REMEMBERED_KEY);
    const list = got[REMEMBERED_KEY];
    if (Array.isArray(list)) consent.remember(list.filter((s): s is string => typeof s === 'string'));
  } catch { /* nothing remembered */ }
})();
// The attach card is a small window of the extension's own page. The worker
// owns its lifetime: one window while requests wait, closed a moment after
// the last is answered, a fresh one for the next. Serialized, so two
// rapid changes never open two windows or race a close against an open.
let cardWindowId: number | null = null;
let cardCloseTimer: ReturnType<typeof setTimeout> | null = null;
let cardWork: Promise<void> = Promise.resolve();
const CARD_CLOSE_GRACE_MS = 1200;

function syncCard(pending: PendingConsent[]): void {
  cardWork = cardWork.then(async () => {
    if (pending.length > 0) {
      if (cardCloseTimer !== null) { clearTimeout(cardCloseTimer); cardCloseTimer = null; }
      if (cardWindowId !== null) {
        try { await chrome.windows.get(cardWindowId); return; } catch { cardWindowId = null; }
      }
      try {
        const win = await chrome.windows.create({ url: chrome.runtime.getURL('attach.html'), type: 'popup', width: 460, height: 440, focused: true });
        cardWindowId = win?.id ?? null;
      } catch (e) {
        console.error('[shim] could not open the attach card', e);
      }
    } else if (cardWindowId !== null && cardCloseTimer === null) {
      const id = cardWindowId;
      cardCloseTimer = setTimeout(() => {
        cardCloseTimer = null;
        if (cardWindowId === id && consent.pending().length === 0) {
          cardWindowId = null;
          void chrome.windows.remove(id).catch(() => undefined);
        }
      }, CARD_CLOSE_GRACE_MS);
    }
  }, () => undefined);
}
chrome.windows.onRemoved.addListener((id) => { if (id === cardWindowId) cardWindowId = null; });
consent.onChange((pending) => {
  void chrome.storage.session.set({ [REMEMBERED_KEY]: consent.remembered() }).catch(() => undefined);
  syncCard(pending);
});

const hostPattern = (hostname: string, port: string): string => `*://${hostname}${port ? `:${port}` : ''}/*`;

function tabInfoOf(tab: chrome.tabs.Tab): TabInfo | null {
  if (tab.id === undefined || typeof tab.url !== 'string') return null;
  let u: URL;
  try { u = new URL(tab.url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return { tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title ?? '', active: tab.active };
}

// The origin patterns a session on `tab` needs for its shim: the shim's
// own (an installed one) or the tab's host (a new one).
async function patternsNeeded(req: AttachRequest, tab: TabInfo): Promise<{ patterns: string[]; shim: InstalledShim | null; error?: string; detail?: string }> {
  const db = await store();
  const u = new URL(tab.url);
  // A Chrome host permission carries no port, so a new shim is granted its
  // host for every port; its match.hosts keeps the port (createShim).
  if (req.create !== null) return { patterns: [hostPattern(u.hostname, '')], shim: null };
  const shim = await db.getShim(req.artifactId);
  if (!shim) return { patterns: [], shim: null, error: 'unknown-artifact', detail: `no shim "${req.artifactId}" is installed` };
  if (!hostMatches(shim.spec.match?.hosts, u.hostname, u.port || undefined)) {
    return { patterns: [], shim, error: 'invalid-target', detail: `"${shim.name}" does not run on ${u.host}` };
  }
  return { patterns: patternsFor(shim), shim };
}

async function missingOf(patterns: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of patterns) if (!(await chrome.permissions.contains({ origins: [p] }))) out.push(p);
  return out;
}

// What each open still had to acquire when its card was shown.
const missingAtResolve = new WeakMap<AttachRequest, string[]>();

// Every route open runs under the bridge generation's scope: turning the
// bridge off aborts them all before the shutdown waits.
let openScope = new AbortController();

function withScope(signal: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (signal.aborted || openScope.signal.aborted) controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  openScope.signal.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function waitForTabLoad(tabId: number, signal: AbortSignal): Promise<'finished' | 'failed' | 'timed-out' | 'aborted'> {
  return new Promise((resolve) => {
    const settle = (outcome: 'finished' | 'failed' | 'timed-out' | 'aborted'): void => {
      clearTimeout(timer);
      chrome.webNavigation.onCompleted.removeListener(onCompleted);
      chrome.webNavigation.onErrorOccurred.removeListener(onError);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onCompleted = (d: chrome.webNavigation.WebNavigationFramedCallbackDetails): void => { if (d.tabId === tabId && d.frameId === 0) settle('finished'); };
    const onError = (d: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails): void => { if (d.tabId === tabId && d.frameId === 0) settle('failed'); };
    const onAbort = (): void => settle('aborted');
    const timer = setTimeout(() => settle('timed-out'), OPEN_TAB_TIMEOUT_MS);
    chrome.webNavigation.onCompleted.addListener(onCompleted);
    chrome.webNavigation.onErrorOccurred.addListener(onError);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

const controlDeps: ControlDeps = {
  status: () => ({
    app: 'shim-for-chrome', host: 'chrome-extension', version: SHIM_EXTENSION_VERSION, enabled: true, mode: modeNow,
    sessions: sessions.registry.list().map((x) => ({ sessionId: x.sessionId, shimId: x.artifactId, revision: x.revision, state: x.state })),
  }),
  async tabs() {
    const all = await chrome.tabs.query({});
    return all.map(tabInfoOf).filter((t): t is TabInfo => t !== null);
  },
  async tab(tabId) {
    try { return tabInfoOf(await chrome.tabs.get(tabId)); } catch { return null; }
  },
  async shimsOn(tab) {
    const db = await store();
    let u: URL;
    try { u = new URL(tab.url); } catch { return []; }
    const out: Array<{ id: string; name: string; enabled: boolean; connect: 'asks' | 'allowed' }> = [];
    for (const shim of await db.listShims()) {
      if (!hostMatches(shim.spec.match?.hosts, u.hostname, u.port || undefined)) continue;
      out.push({ id: shim.id, name: shim.name, enabled: shim.enabled, connect: consent.isRemembered(u.hostname) ? 'allowed' : 'asks' });
    }
    return out;
  },
  sessions: sessions.registry,
  consent: {
    async request(subject, signal) {
      await rememberedReady;
      return consent.request(subject, signal);
    },
  },
  async resolveAttach(req, tab) {
    const u = new URL(tab.url);
    const needed = await patternsNeeded(req, tab);
    if (needed.error) return { ok: false, error: needed.error, ...(needed.detail ? { detail: needed.detail } : {}) };
    const missing = await missingOf(needed.patterns);
    // What the card may acquire: the first resolve's view, never the one
    // after the answer (by then nothing is missing).
    if (!missingAtResolve.has(req)) missingAtResolve.set(req, missing);
    return {
      ok: true,
      tab,
      subject: {
        agent: req.agent, intent: req.intent,
        shimId: needed.shim?.id ?? '', shimName: needed.shim?.name ?? req.create?.name ?? '',
        scope: u.hostname, tabId: tab.tabId >= 0 ? tab.tabId : null, url: tab.url, title: tab.title, missingOrigins: missing,
      },
    };
  },
  async acquiredOrigins(req) {
    const missing = missingAtResolve.get(req) ?? [];
    const now: string[] = [];
    for (const p of missing) if (await chrome.permissions.contains({ origins: [p] })) now.push(p);
    return now;
  },
  async releaseOrigins(origins) {
    const db = await store();
    await releaseUnusedOrigins(db, origins);
  },
  async createShim(req, tab, draftId) {
    const db = await store();
    const u = new URL(tab.url);
    const id = mintShimId(crypto.randomUUID());
    // Chrome match patterns carry no port anywhere (permission, content
    // script, permissions.contains), so a new shim matches the host for
    // every port. On a dev server that is any port of localhost; the user
    // can narrow it in the Shim browser.
    const { patterns, problems } = matchPatternsForHosts([u.hostname]);
    if (problems.length || !patterns.length) return { ok: false, error: 'invalid-target', detail: `the tab's host cannot be registered: ${problems.join('; ')}` };
    const shim: Omit<InstalledShim, 'rank'> = {
      id, name: req.create?.name ?? 'New shim', enabled: true, installedAt: Date.now(),
      provenance: { source: 'session' },
      mode: modeNow, spec: { id, version: 1, match: { hosts: [u.hostname] }, rules: [] }, handlers: {}, envelope: {},
      sessionDraft: { sessionId: draftId, at: Date.now() },
    };
    await db.addShim(shim);
    await syncRegistrations();
    return { ok: true, artifactId: id };
  },
  async discardShim(artifactId) {
    const db = await store();
    const shim = await db.getShim(artifactId);
    if (!shim) return;
    await db.deleteShim(artifactId);
    await syncRegistrations();
    await refreshOpenTabs(patternsFor(shim));
    await releaseUnusedOrigins(db, patternsFor(shim));
  },
  async targetFor(tab, artifactId) {
    const db = await store();
    const shim = await db.getShim(artifactId);
    if (!shim) return { ok: false, error: 'unknown-artifact', detail: `no shim "${artifactId}"` };
    if (hostOnTab(tab.tabId)) return { ok: false, error: 'artifact-busy', detail: 'a session already holds this tab' };
    const worldId = crypto.randomUUID();
    const host = await openPageHost(tab.tabId, { engineBundle, storage: sessionStorageFor(db, new Map()), handlerApi: sessionHandlerApiFor(db), nudge: nudgeTab }, { worldId });
    const id = `host-${++hostSeq}`;
    const entry: OpenHost = { host, events: [], console: [], popups: [], offs: [] };
    openHosts.set(id, entry);
    // The host over (Chrome's bar, the tab gone): its session ends at once.
    entry.offs.push(host.onClosed(() => {
      const s = sessions.registry.sessionFor('shim', artifactId);
      if (s) void sessions.registry.end(s.sessionId, 'ended');
    }));
    const u = new URL(tab.url);
    const page = { hostname: u.hostname, port: u.port };
    const runs = shim.enabled && (await runsOn(shim, page, capabilitiesFor(modeNow)));
    const committedDown = runs ? null
      : !shim.enabled ? `"${shim.name}" is disabled in Shim for Chrome: its committed rules are not running on the page; previews still apply`
        : `"${shim.name}" needs what Shim for Chrome does not run in ${modeNow} mode: its committed rules are not running on the page; previews still apply`;
    const target: ExtensionSessionTarget = {
      page: { host, close: () => pageHosts.close(id).then(() => undefined) },
      source: { shimId: shim.id, name: shim.name, spec: shim.spec, handlers: shim.handlers, envelope: shim.envelope, created: shim.sessionDraft !== undefined },
      committedDown,
    };
    // The disposer the route calls when the open does not take over the host
    // (a lease busy before begin, a throw): closes it and drops its entry.
    return { ok: true, target, dispose: () => pageHosts.close(id).then(() => undefined) };
  },
  async openTab(url, signal) {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.create({ url, active: true });
    } catch (e) {
      return { ok: false, error: 'page-load-failed', detail: `could not open a tab: ${e instanceof Error ? e.message : String(e)}`, tabId: null };
    }
    const tabId = tab.id ?? null;
    if (tabId === null) return { ok: false, error: 'page-load-failed', detail: 'the tab has no id', tabId: null };
    const outcome = await waitForTabLoad(tabId, signal);
    if (outcome !== 'finished') return { ok: false, error: 'page-load-failed', detail: `the page did not finish loading (${outcome})`, tabId };
    const info = tabInfoOf(await chrome.tabs.get(tabId));
    if (!info) return { ok: false, error: 'page-load-failed', detail: 'the page is not on a site this extension may see', tabId };
    return { ok: true, tab: info };
  },
  closeTab: (tabId) => chrome.tabs.remove(tabId).catch(() => undefined),
  takeNotes: (sessionId) => sessions.takeNotes(sessionId),
  newDraftId: () => crypto.randomUUID(),
};

// Everything a bridge generation holds, ended in order: no new opens, the
// ones in flight aborted and waited for, every session ended, every
// remembered consent forgotten.
async function shutdownSessions(): Promise<void> {
  openScope.abort();
  openScope = new AbortController();
  await sessions.registry.settleOpens();
  await Promise.all(sessions.registry.list().map((x) => sessions.registry.end(x.sessionId, 'ended')));
  consent.reset();
  await chrome.storage.session.remove(REMEMBERED_KEY).catch(() => undefined);
}

function nativePort(name: string): PortLike {
  const port = chrome.runtime.connectNative(name);
  return {
    postMessage: (m) => port.postMessage(m),
    disconnect: () => port.disconnect(),
    onMessage: { addListener: (cb) => port.onMessage.addListener((m: unknown) => cb(m)) },
    onDisconnect: { addListener: (cb) => port.onDisconnect.addListener(() => cb()) },
    lastError: () => chrome.runtime.lastError?.message ?? null,
  };
}

const bridgePort = createBridgePort({
  connect: nativePort,
  handle: (req, signal) => routeControlRequest(controlDeps, { method: req.method, url: req.url, body: req.body, signal: withScope(signal) }),
  shutdown: () => shutdownSessions(),
  version: SHIM_EXTENSION_VERSION,
  log: (line) => console.log(line),
});

async function bridgeEnabled(): Promise<boolean> {
  return (await (await store()).prefs.get(BRIDGE_PREF)) === true;
}

async function setBridgeEnabled(enabled: boolean): Promise<void> {
  await (await store()).prefs.set(BRIDGE_PREF, enabled);
  if (enabled) bridgePort.enable();
  else await bridgePort.disable();
}

// On while the setting is on, from every worker boot.
void bridgeEnabled().then((on) => { if (on) bridgePort.enable(); });

type MessageListener = (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (answer: WorkerAnswer) => void) => boolean;

// The event a message arrives on names the world it came from, which no
// message body can claim: onMessage serves the isolated world (and the
// extension's own pages), onUserScriptMessage the user-script world.
function listenerFor(world: RuntimeWorld): MessageListener {
  return (msg, sender, sendResponse) => {
    if (!isToWorker(msg)) return false;
    // The token comes off first: what is narrowed, answered and logged below never carries it.
    const { auth, rest } = splitAuth(msg);
    const from = senderContext(sender, chrome.runtime.id, chrome.runtime.getURL(''));
    principalFor(world, auth).then((principal) => {
      if (!principal) return { ok: false, error: STALE_TOKEN } satisfies WorkerAnswer;
      return handle(rest as ToWorker, from, world, principal);
    }).then(sendResponse, (err: unknown) => {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
    return true;
  };
}

chrome.runtime.onMessage.addListener(listenerFor('isolated'));
const onUserScriptMessage = (chrome.runtime as { onUserScriptMessage?: chrome.events.Event<MessageListener> }).onUserScriptMessage;
if (onUserScriptMessage) onUserScriptMessage.addListener(listenerFor('user-script'));

export { scriptIdFor } from './registration';
