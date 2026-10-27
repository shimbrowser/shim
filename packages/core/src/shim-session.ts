// A shim session, the page-side half: what @shimbrowser/core's session
// registry drives for a shim on any PageHost, in any host that has one.
// The headless mode of @shimbrowser/mcp runs it over a Playwright page and a
// `.shim` file; Shim for Chrome runs it in its service worker over a tab and
// the installed shim. What differs between them comes in through
// ShimSessionDeps: where a commit goes, whether the committed rules are
// applied as previews at begin (a host with no installed shim) or already
// run (a host that installs the shim), how a handler module's syntax is
// checked, whether interact_page is served, and how the host names what it
// cannot serve.
//
//   begin     open on the page; apply the shim as committed when the host
//             asks for it; start listening
//   checkout  the working state as a shim folder (D10)
//   preview   the agent's whole folder → diff against the working state →
//             lint → preflight (D15) → apply the changed rules to the live
//             page → settle → evidence (D11)
//   call      the page tools, over core's page-host-tools
//   commit    pack the working state (version, witnesses, the exchange in
//             its history) and hand it to the host to write
//   finish    tear every preview down and close the page
//
// Ordering, revisions, idempotent commit and ending are the registry's (D14).
//
// Invariants:
//   - Preflight is atomic: a working copy that declares anything outside the
//     host's capabilities applies nothing and answers `unsupported` with the
//     list (D15).
//   - Every rule's evidence carries its verification level: `partial` when
//     the witness carries component identity (a host without it can't check
//     it) or an `unsupported-api` event fired for the rule since it was last
//     applied.
//   - Witnesses never reach the agent: the evidence carries none, checkout
//     writes none; they live in the session and in the committed shim. They
//     are taken whenever the engine reports one for a live rule (a standing
//     listener, not a preview's evidence window): an element that appears
//     after the settle still gets fingerprinted.
//   - A recovery the engine reports on a deploy (`rule-rebase`) is evidence
//     only, never applied to the working rule. While any rule with an
//     unchanged anchor stands broken — an unapplied recovery, or quarantined
//     — a commit keeps the committed deploy baseline, so the installed shim
//     still sees the deploy and runs its own recovery / quarantine path.
//   - A rule the folder removes is a tombstone until commit or discard: the
//     host is told (ShimSessionDeps.tombstone) so a host that installs the
//     shim can hold the committed rule down without a preview to show.
//   - The ops applied since the session's base (its begin, or its last
//     successful commit) ride with the prepared commit, so a host that
//     merges onto a store other tabs keep learning into can replay exactly
//     what was authored.
//   - Nothing here is Node or a browser: the page is the host's, storage
//     is the host's, the clock is injectable.
import type { Spec, Rule } from './types';
import type { PageHost, PageLoadOutcome, PageRuntimeEvent, PreviewRule, Unsubscribe } from './page-host';
import type { SessionBackend, BackendPreview, BackendCheckout, BackendCommit, FinishInfo } from './session-registry';
import type { DeltaOp } from './spec-delta';
import { applyDelta } from './spec-delta';
import { lintSpec } from './spec-lint';
import {
  checkoutShim, packShim, anchorDigest, referencedHandlerNames, nameMap, ShimFolderError,
  SHIM_STATE_FILE, SHIM_STATE_FORMAT, type ShimFile, type ShimState, type RuleState, type SetWitnessState, type FolderInput,
} from './shim-folder';
import type { CompileProbe } from './rewrite-response';
import { handlerWorlds, moduleToExpression } from './handler-source';
import { diffWorkingCopy } from './working-copy-diff';
import { hasManagedKeys, withManagedFingerprint, withoutManagedKeys } from './managed-anchor';
import { readCaptureEvent, inCaptureBinding, supersedes, fingerprintOfCapture } from './capture-event';
import type { CaptureEvent } from './capture-event';
import { decodeWorkingCopy, encodeWorkingCopy, WorkingCopyWireError } from './working-copy-wire';
import {
  preflightSpec, scanRuleHandlers, verificationLevel, UNSUPPORTED_API_EVENT, type UnsupportedFeature,
} from './capability-preflight';
import { describeRuleStatus, previewKey, previewNoMatch, shimViewPageCaption } from './preview-evidence';
import type { StatusCapture } from './preview-evidence';
import { createConsoleFeed, formatAutoBlock, formatConsoleRead, type ConsoleFeed } from './console-feed';
import {
  viewPageOnHost, queryPageByScript, inspectElementByScript, evaluateOnHost, expressionProblem,
  QUERY_TIMEOUT_MS, INSPECT_TIMEOUT_MS, EVALUATE_TIMEOUT_MS,
} from './page-host-tools';
import { navigationScopeOf, runNavigate, isSameDocumentNavigation, type NavigationState, type NavigateLoad } from './navigate-scope';

// How long the page gets to react after an apply before the evidence is read:
// the Shim browser's window (APPLY_SETTLE_MS), above the engine's 1.5s
// no-match delay so an explicit rule-no-match lands inside it.
export const SESSION_SETTLE_MS = 2000;
// reload_page is a recovery tool, not a loop primitive (the browser's bound).
export const MAX_RELOADS_PER_SESSION = 3;
const RELOAD_LOAD_TIMEOUT_MS = 15_000;
// The runtime event buffer a preview's evidence reads from.
const EVENT_CAP = 2000;

/** Page tools that need a Shim browser subsystem (D2: a host without it answers its unsupported error). */
export const BROWSER_ONLY_PAGE_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  verify_across_pages: 'verify_across_pages loads other pages of the site in a hidden Shim tab; this host has one page. Move it with navigate and check each page yourself.',
});

/** One page a session works on, and how to let go of it. */
export interface ShimSessionPage {
  host: PageHost;
  close(): Promise<void>;
}

/** What a session starts from: the shim as committed. A host extends it with where commits go. */
export interface ShimSessionSource {
  /** The display name. */
  name: string;
  /** The spec as committed (rules name their handlers; witnesses, version and bundleHash included). */
  spec: Spec;
  /** The handler modules (module form), by name. */
  handlers: Record<string, string>;
  /** The artifact's other envelope fields (authoringHistory, userData, …). */
  envelope: Record<string, unknown>;
  /** Nothing committed yet: the shim was created for this session. */
  created: boolean;
}

/** The registry's `target` for a shim session. */
export interface ShimSessionTarget<S extends ShimSessionSource = ShimSessionSource> {
  page: ShimSessionPage;
  source: S;
}

/** What a commit hands the host to write: the packed file and the state that made it. */
export interface PreparedCommit {
  /** The `shim/1` file as packShim made it: spec with version and baseline, witnesses on their rules, handlers, the envelope with this exchange appended to its history. */
  file: ShimFile;
  state: ShimState;
  version: number;
  bundleHash: string | undefined;
  history: unknown[];
  /** The ops the session applied since its base (begin, or its last successful commit), in order. */
  opsSinceBase: DeltaOp[];
}

export type CommitWrite =
  | {
      ok: true;
      versionId: string | number;
      notes?: string[];
      /** The artifact as written when it differs from what was prepared (a host that merged onto a store other tabs changed): the session continues from it. */
      adopted?: { spec: Spec; handlers: Record<string, string> };
    }
  | {
      ok: false;
      error: string;
      detail?: string;
      /** A conflict the host resolved by resetting: the session drops its previews and tombstones and continues from this state, for the agent to check out again. */
      reset?: { spec: Spec; handlers: Record<string, string> };
    };

export interface ShimSessionDeps<S extends ShimSessionSource = ShimSessionSource> {
  settleMs?: number;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** The error code a handler's call to an api member this host lacks fails with; names the host in evidence. */
  unsupportedError: string;
  /** The detail of a preflight refusal: what this host supports, and where to author what it does not. */
  unsupportedDetail: string;
  /** The note for a rule that used an api member this host lacks. */
  unsupportedNote(ruleId: string, member: string): string;
  /** Apply the committed rules as previews at begin: a host with no installed shim. A host that installs the shim already runs them. */
  previewCommittedAtBegin: boolean;
  /** interact_page. Absent: the tool answers unsupportedError (a host whose input policy is not yet built). */
  interact?(handle: ShimSessionHandle<S>, input: unknown, signal: AbortSignal): Promise<unknown>;
  /** The syntax check packShim runs on handler modules at commit (default: core's probe, which needs eval). A host whose context forbids eval checks elsewhere first and passes what it found. */
  syntaxProbe?: CompileProbe;
  /** Writes a commit. Runs with the session's signal: a host must check it immediately before its own durable write and never after. */
  writeCommit(handle: ShimSessionHandle<S>, prepared: PreparedCommit, signal: AbortSignal): Promise<CommitWrite>;
  /**
   * A rule the folder removed (`held` true) or put back (`held` false): a
   * host that installs the shim holds the committed rule down meanwhile.
   * Told on every preview that changes the set and on discard (finish, a
   * conflict reset). Not told on a successful commit: the host's
   * writeCommit saw handle.tombstones and owns their release.
   */
  tombstone?(handle: ShimSessionHandle<S>, ruleId: string, held: boolean): void | Promise<void>;
  /**
   * Witnesses kept outside the artifact (a folder's .shim-state.json rules, by
   * rule id): a preview that adds a rule the working state doesn't have gets
   * its entry's witness back while the anchor digest still matches — as pack
   * restores it — so a preview verifies against the fingerprint the shim
   * was committed with instead of capturing a fresh one.
   */
  seedWitnesses?: Record<string, RuleState>;
  /**
   * The committed anchor digests of rules that have no witness (a folder's
   * .shim-state.json anchors, by rule id). With seedWitnesses, they tell a
   * preview which added rules are unchanged since the commit, so those run
   * behind the deploy baseline.
   */
  seedAnchors?: Record<string, string>;
  /**
   * Set witnesses kept outside the artifact (a folder's .shim-state.json
   * setWitnesses, by rule id), seeded the way seedWitnesses are, each into its
   * own anchor field.
   */
  seedSetWitnesses?: Record<string, SetWitnessState>;
}

/** A rule's broken reconciliation outcome: a recovery the engine reported but nothing applied, or a quarantine. */
type BrokenOutcome = 'recovery' | 'quarantined';

interface TimedEvent {
  at: number;
  event: PageRuntimeEvent;
}

export interface ShimSessionHandle<S extends ShimSessionSource = ShimSessionSource> {
  sessionId: string;
  agent: string;
  intent: string;
  source: S;
  page: ShimSessionPage;
  host: PageHost;
  /** The artifact as of the session's base: its begin, or its last successful commit. */
  base: { spec: Spec; handlers: Record<string, string> };
  /** The ops applied since the base, in order (PreparedCommit.opsSinceBase). */
  opsSinceBase: DeltaOp[];
  /** Rules the folder removed since the base: held by the host meanwhile (ShimSessionDeps.tombstone). */
  tombstones: Set<string>;
  /** The page's host and port ('' = the scheme's default) when the session began: the page-away guard's reference. */
  startUrl: string;
  startHost: string;
  startPort: string;
  /** The spec as of the latest applied revision (rules carry witnesses; changed rules carry handlers inline). */
  working: Spec;
  /** Module-form sources for handlers a working rule names without carrying them inline. */
  storedHandlers: Record<string, string>;
  /** As committed: version, bundleHash, the file's envelope. */
  version: number;
  bundleHash: string | undefined;
  /**
   * The committed anchor of each rule, by rule id (anchorDigest, witness
   * aside): the rules that run behind `bundleHash`. Seeded witnesses and
   * anchors count as committed, since .shim-state.json pins them to the
   * committed anchor.
   */
  committedAnchors: Map<string, string>;
  envelope: Record<string, unknown>;
  /** Live previews by ruleKey: what reload_page re-applies. */
  live: Map<string, PreviewRule>;
  /**
   * Each live preview version's latest capture (capture-event.ts), by
   * ruleKey: kept while the preview runs, frozen at the preview's read
   * boundary (its settle), reset when the key is applied again.
   */
  captures: Map<string, { applyId: string | undefined; event: CaptureEvent | null; frozen: boolean; freezeOnFirst: boolean }>;
  /** Preview versions minted (PreviewRule.applyId). */
  applies: number;
  /** Rules the engine last reported broken, by rule id: how, and the anchor digest it was reported against. A healthy report clears one. */
  broken: Map<string, { digest: string; outcome: BrokenOutcome }>;
  /** Broken reports not yet in a preview's evidence. */
  unreportedBroken: Array<{ ruleId: string; outcome: BrokenOutcome; strategy?: string; to?: string }>;
  events: TimedEvent[];
  console: ConsoleFeed;
  /** unsupported-api members per ruleKey since the rule was last applied. */
  unsupported: Map<string, Set<string>>;
  /** unsupported-api uses not yet reported in a preview's evidence. */
  unreported: Array<{ ruleId: string; member: string }>;
  reloads: number;
  off: Unsubscribe[];
  /** The token marking the document the live previews were applied to (see documentChanged). */
  docToken: string | null;
  docTokens: number;
  /** navigate's fixed scope (the start origin) and budget. */
  navigation: NavigationState;
}

// A document's mark, kept in the engine world: that world is created afresh
// for every document, so a full navigation (a link, a form, a script's
// location change — not only reload_page) drops the mark along with every
// preview applied to the old document. A same-document (SPA) navigation
// keeps both.
const DOC_TOKEN_KEY = '__shimSessionDocument';
const DOC_TOKEN_READ = `globalThis[${JSON.stringify(DOC_TOKEN_KEY)}] ?? null`;
const docTokenWrite = (token: string): string => `globalThis[${JSON.stringify(DOC_TOKEN_KEY)}] = ${JSON.stringify(token)}`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function portOf(url: string): string {
  try {
    return new URL(url).port;
  } catch {
    return '';
  }
}

/**
 * Whether a match.hosts pattern covers `url` — the browser registry's
 * semantics: a pattern without a port
 * matches any port, an exact host or a `*.` subdomain wildcard; a pattern
 * with a port matches only that exact host:port.
 */
export function hostPatternMatches(pattern: string, url: URL): boolean {
  if (pattern.includes(':')) return pattern === (url.port ? `${url.hostname}:${url.port}` : url.hostname);
  if (pattern === url.hostname) return true;
  return pattern.startsWith('*.') && url.hostname.endsWith(pattern.slice(1));
}

/** Whether `url` is an http(s) page one of the shim's declared hosts covers. */
function onDeclaredHost(spec: Spec, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return (spec.match?.hosts ?? []).some((h) => typeof h === 'string' && h !== '' && hostPatternMatches(h, u));
}

/** A new shim's spec for a page (the browser's shims.create shape). */
export function newShimSpec(url: string, id: string): Spec {
  const u = new URL(url);
  return { id, version: 1, match: { hosts: [u.port ? `${u.hostname}:${u.port}` : u.hostname] }, rules: [] };
}

/** A shim id in the browser's format. */
export function newShimId(now: number = Date.now(), random: () => number = Math.random): string {
  return `shim-${now}-${random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

/** A rule as the page needs it: its handler modules inlined as expressions. */
function previewRule(rule: Rule, stored: Record<string, string>): Rule {
  const names = referencedHandlerNames(rule);
  const worlds = handlerWorlds([rule]);
  const handlers: Record<string, string> = { ...(rule.handlers || {}) };
  for (const name of names) {
    const module = Object.hasOwn(stored, name) ? stored[name] : undefined;
    // Own properties only: a handler named `constructor` or `toString` must
    // not resolve through Object.prototype and skip its stored module.
    if (!Object.hasOwn(handlers, name) && typeof module === 'string') handlers[name] = moduleToExpression(module, worlds.get(name) ?? 'isolated');
  }
  return Object.keys(handlers).length ? { ...rule, handlers } : { ...rule };
}

// The page-away guard (the browser's page-guard): page tools and previews
// refuse once the page left the session's site, so nothing is measured or
// witnessed against the wrong document. The site is the host the session
// started on plus every host the shim declares (match.hosts, the registry's
// pattern semantics), as in the Shim browser: a multi-host or wildcard shim
// can be worked on across its declared sites. The start host holds to the
// start port (the browser's turnPort), so a session begun on localhost:5173
// can't follow the page to another local service on localhost:9090.
export function pageAway<S extends ShimSessionSource>(handle: ShimSessionHandle<S>): { error: string; detail: string } | null {
  if (handle.host.isClosed()) return { error: 'page-closed', detail: 'the session\'s page closed — end the session and open a new one' };
  const url = handle.host.url();
  const now = hostnameOf(url);
  if (now && now === handle.startHost && portOf(url) === handle.startPort) return null;
  if (onDeclaredHost(handle.working, url)) return null;
  return {
    error: 'page-away',
    detail: `the page left ${handle.startHost} (it is at ${url || 'no page'}) — call reload_page to go back to ${handle.startUrl}`,
  };
}

function describeLoadOutcome(outcome: PageLoadOutcome): string {
  switch (outcome.kind) {
    case 'failed': return `failed: ${outcome.description || `error ${outcome.code}`}`;
    case 'timed-out': return `timed out after ${RELOAD_LOAD_TIMEOUT_MS / 1000}s`;
    case 'aborted': return 'aborted';
    case 'destroyed': return 'the page went away';
    case 'finished': return 'finished';
  }
}

function refused(evidence: Record<string, unknown>): BackendPreview {
  return { applied: false, evidence: { applied: false, ...evidence } };
}

// What each op did, for the agent (the browser's describeOp).
function describeOp(op: DeltaOp): string {
  if (op.op === 'add-rule' || op.op === 'update-rule') return `${op.op} ${op.rule?.id ?? '?'}`;
  if (op.op === 'remove-rule') return `remove-rule ${op.ruleId ?? '?'}`;
  return op.op ?? 'unknown-op';
}

/** The evidence for a preflight refusal. */
export function unsupportedEvidence(unsupported: UnsupportedFeature[], detail: string): Record<string, unknown> {
  return {
    error: 'unsupported',
    detail,
    unsupported: unsupported.map((u) => u.message),
  };
}

export function createShimSessionBackend<S extends ShimSessionSource = ShimSessionSource>(deps: ShimSessionDeps<S>): SessionBackend<ShimSessionHandle<S>> {
  const settleMs = deps.settleMs ?? SESSION_SETTLE_MS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const seedWitnesses = deps.seedWitnesses;
  const seedAnchors = deps.seedAnchors;
  const seedSetWitnesses = deps.seedSetWitnesses;

  // A rule new to the working state takes its seeded witness while its anchor
  // is the one the witness was captured for (HeadlessBackendOptions.seedWitnesses).
  function seedAddedRules(prev: Spec, next: Spec, ops: DeltaOp[]): void {
    if ((!seedWitnesses && !seedSetWitnesses) || !next.rules) return;
    const had = new Set((prev.rules || []).map((r) => r.id));
    const added = new Set(ops.filter((op) => op.op === 'add-rule' && op.rule?.id && !had.has(op.rule.id)).map((op) => op.rule?.id));
    next.rules = next.rules.map((rule) => {
      if (!added.has(rule.id) || !rule.anchor || hasManagedKeys(rule.anchor)) return rule;
      const digest = anchorDigest(rule.anchor);
      const entry = seedWitnesses && Object.hasOwn(seedWitnesses, rule.id) ? seedWitnesses[rule.id] : undefined;
      const setEntry = seedSetWitnesses && Object.hasOwn(seedSetWitnesses, rule.id) ? seedSetWitnesses[rule.id] : undefined;
      // Each fingerprint to its own field, only while the anchor is the one it was captured for.
      const fingerprint = {
        ...(entry && entry.anchorDigest === digest ? { witness: clone(entry.witness) } : {}),
        ...(setEntry && setEntry.anchorDigest === digest ? { setWitness: clone(setEntry.setWitness) } : {}),
      };
      if (!hasManagedKeys(fingerprint)) return rule;
      return { ...rule, anchor: withManagedFingerprint(rule.anchor, fingerprint) };
    });
  }

  // The live preview and working rule a runtime event is about, or null when
  // the event is stale: its key no longer live, an older version of the key
  // (applyId, where the host stamps it), a working rule whose anchor changed
  // since, or a page that left the site.
  function currentRuleFor(handle: ShimSessionHandle<S>, event: PageRuntimeEvent): { key: string; live: PreviewRule; rule: Rule } | null {
    if (typeof event.specId !== 'string' || typeof event.ruleId !== 'string') return null;
    const live = handle.live.get(event.specId);
    if (!live || live.rule.id !== event.ruleId || !live.rule.anchor) return null;
    if (typeof event.applyId === 'string' && event.applyId !== live.applyId) return null;
    const rule = (handle.working.rules || []).find((r) => r.id === event.ruleId);
    if (!rule?.anchor || anchorDigest(rule.anchor) !== anchorDigest(live.rule.anchor)) return null;
    if (pageAway(handle)) return null;
    return { key: event.specId, live, rule };
  }

  // Witness capture: the engine fingerprints what a live rule showed (one
  // element → element witness, several → set witness, or none with a reason)
  // in rule-witness events, each replacing the rule's whole fingerprint state.
  // The latest one inside the preview's binding (its applyId, the anchor it
  // was applied with, the newest document) wins until the preview's read
  // boundary freezes it (freezeCaptures). Kept on the working rule for commit
  // and on its live preview, so a replay onto a new document (reload_page,
  // followDocument) filters by it as the committed shim will, instead of
  // re-resolving the bare selector. The preview's deploy baseline is left as
  // applied: a fresh witness is this deploy's, with nothing committed to
  // rebase from.
  function takeWitness(handle: ShimSessionHandle<S>, event: PageRuntimeEvent): void {
    const read = readCaptureEvent(event);
    if (!read) return;
    const current = currentRuleFor(handle, event);
    if (!current?.rule.anchor || !current.live.rule.anchor) return;
    const entry = handle.captures.get(current.key);
    if (!entry || entry.frozen || entry.applyId !== current.live.applyId) return;
    const binding = { applyId: current.live.applyId ?? null, anchorDigest: anchorDigest(current.live.rule.anchor) };
    if (!inCaptureBinding(read, binding) || !supersedes(read, entry.event)) return;
    entry.event = read;
    if (entry.freezeOnFirst) entry.frozen = true;
    const fingerprint = fingerprintOfCapture(read);
    current.rule.anchor = withManagedFingerprint(withoutManagedKeys(current.rule.anchor), fingerprint);
    handle.live.set(current.key, {
      ...current.live,
      rule: { ...current.live.rule, anchor: withManagedFingerprint(withoutManagedKeys(current.live.rule.anchor), fingerprint) },
    });
  }

  // The read boundary: what each of these previews captured so far is what
  // the rule carries; later events are not this preview's evidence. A preview
  // that captured nothing yet (its element hadn't appeared) takes the first
  // capture that arrives, and freezes on it.
  function freezeCaptures(handle: ShimSessionHandle<S>, keys: Iterable<string>): void {
    for (const key of keys) {
      const entry = handle.captures.get(key);
      if (!entry) continue;
      if (entry.event) entry.frozen = true;
      else entry.freezeOnFirst = true;
    }
  }

  // The status line's view of a preview's capture.
  function statusCapture(handle: ShimSessionHandle<S>, key: string): StatusCapture | null {
    const e = handle.captures.get(key)?.event;
    if (!e) return null;
    return { fingerprint: e.setWitness ? 'set' : e.witness ? 'element' : 'none', note: e.note };
  }

  // A live rule's latest reconciliation outcome (rule-reconcile): a recovery
  // it reported (only reported; nothing here applies it) or a quarantine
  // marks the rule broken; resolving through its primary again clears it.
  function noteOutcome(handle: ShimSessionHandle<S>, event: PageRuntimeEvent): void {
    const healthy = event.kind === 'rule-status' && typeof event.matched === 'number' && event.matched > 0 && event.matchedVia === 'primary';
    const outcome: BrokenOutcome | null = event.kind === 'rule-rebase' ? 'recovery' : event.kind === 'rule-quarantined' ? 'quarantined' : null;
    if (!healthy && !outcome) return;
    const current = currentRuleFor(handle, event);
    if (!current?.rule.anchor) return;
    if (!outcome) {
      handle.broken.delete(current.rule.id);
      return;
    }
    handle.broken.set(current.rule.id, { digest: anchorDigest(current.rule.anchor), outcome });
    handle.unreportedBroken.push({
      ruleId: current.rule.id,
      outcome,
      ...(outcome === 'recovery' ? { strategy: typeof event.strategy === 'string' ? event.strategy : 'rebase' } : {}),
      ...(outcome === 'recovery' && typeof event.to === 'string' && event.to ? { to: event.to } : {}),
    });
  }

  // Rules still broken: the working rule keeps the anchor the break was
  // reported against (a re-anchored or removed rule is no longer one).
  function brokenRules(handle: ShimSessionHandle<S>): string[] {
    const out: string[] = [];
    for (const [ruleId, { digest }] of handle.broken) {
      const rule = (handle.working.rules || []).find((r) => r.id === ruleId);
      if (rule?.anchor && anchorDigest(rule.anchor) === digest) out.push(ruleId);
    }
    return out;
  }

  function apply(handle: ShimSessionHandle<S>, preview: PreviewRule): void {
    handle.unsupported.delete(preview.ruleKey);
    // A new version captures afresh; a replay of the same version (a new
    // document) keeps what this version already settled.
    if (handle.captures.get(preview.ruleKey)?.applyId !== preview.applyId) {
      handle.captures.set(preview.ruleKey, { applyId: preview.applyId, event: null, frozen: false, freezeOnFirst: false });
    }
    handle.live.set(preview.ruleKey, preview);
    handle.host.applyPreview(preview);
  }

  function remove(handle: ShimSessionHandle<S>, ruleKey: string): void {
    handle.live.delete(ruleKey);
    handle.captures.delete(ruleKey);
    handle.unsupported.delete(ruleKey);
    handle.host.removePreview(ruleKey);
  }

  // The committed anchors, by rule id: every committed rule's, then (for a
  // rule the committed spec doesn't have) a seeded witness's or seeded
  // anchor's — until this session commits, which rewrites what is committed.
  function committedAnchorsOf(rules: Rule[] | undefined, seeded: boolean): Map<string, string> {
    const out = new Map<string, string>();
    for (const rule of rules || []) {
      if (typeof rule?.id === 'string' && rule.anchor) out.set(rule.id, anchorDigest(rule.anchor));
    }
    if (!seeded) return out;
    for (const [id, entry] of Object.entries(seedWitnesses ?? {})) {
      if (!out.has(id)) out.set(id, entry.anchorDigest);
    }
    for (const [id, entry] of Object.entries(seedSetWitnesses ?? {})) {
      if (!out.has(id)) out.set(id, entry.anchorDigest);
    }
    for (const [id, digest] of Object.entries(seedAnchors ?? {})) {
      if (!out.has(id)) out.set(id, digest);
    }
    return out;
  }

  // A rule applies behind the committed deploy baseline only while its anchor
  // is the one it was committed with, witness or not (a multi-match rule never
  // captures one, and refresh and promote don't need it): a new or re-anchored
  // rule has nothing to rebase from. The spec's autoRepair rides with the
  // baseline, so an opted-out shim's preview never promotes or recovers an
  // anchor the committed shim would leave alone.
  function previewFor(handle: ShimSessionHandle<S>, rule: Rule): PreviewRule {
    handle.applies += 1;
    const preview: PreviewRule = {
      patchId: handle.source.spec.id,
      rule: previewRule(rule, handle.storedHandlers),
      ruleKey: previewKey(handle.source.spec.id, rule.id),
      applyId: `${handle.sessionId}:${handle.applies}`,
    };
    const committed = handle.committedAnchors.get(rule.id);
    if (handle.bundleHash && rule.anchor && committed !== undefined && committed === anchorDigest(rule.anchor)) {
      preview.bundleHash = handle.bundleHash;
      if (handle.working.autoRepair === false) preview.autoRepair = false;
    }
    return preview;
  }

  async function settle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await Promise.race([
      sleep(settleMs),
      new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    ]);
  }

  async function currentDeployId(handle: ShimSessionHandle<S>): Promise<string | null> {
    try {
      const id = await handle.host.evaluate('ShimCore.deployIdForDocument(document)', 'engine');
      return typeof id === 'string' && id ? id : null;
    } catch {
      return null;
    }
  }

  // Marks the current document as the one the live previews are on.
  async function markDocument(handle: ShimSessionHandle<S>): Promise<void> {
    handle.docTokens += 1;
    const token = `${handle.sessionId}:${handle.docTokens}`;
    try {
      await handle.host.evaluate(docTokenWrite(token), 'engine');
      handle.docToken = token;
    } catch {
      handle.docToken = null;
    }
  }

  // Whether the page is still on the document the live previews were last
  // applied to (markDocument).
  async function onMarkedDocument(handle: ShimSessionHandle<S>): Promise<boolean> {
    if (handle.docToken === null || handle.host.isClosed()) return false;
    try {
      return (await handle.host.evaluate(DOC_TOKEN_READ, 'engine')) === handle.docToken;
    } catch {
      return false;
    }
  }

  // An in-scope full navigation since the last check left a fresh document
  // with none of the live previews on it: re-apply them (as reload_page does)
  // before anything measures, screenshots or adds to the page.
  async function followDocument(handle: ShimSessionHandle<S>, signal: AbortSignal): Promise<void> {
    if (handle.host.isClosed()) return;
    let token: unknown;
    try {
      token = await handle.host.evaluate(DOC_TOKEN_READ, 'engine');
    } catch {
      return; // no engine world yet: the next call looks again
    }
    if (token !== null && token === handle.docToken) return;
    for (const p of handle.live.values()) apply(handle, p);
    await markDocument(handle);
    if (handle.live.size > 0) await settle(signal);
  }

  async function preview(handle: ShimSessionHandle<S>, input: unknown, signal: AbortSignal): Promise<BackendPreview> {
    if (!isRecord(input) || !('workingCopy' in input)) {
      return refused({ error: 'invalid-request', detail: 'a headless preview takes the working copy ({ workingCopy })' });
    }
    let folder: FolderInput;
    try {
      folder = decodeWorkingCopy(input.workingCopy);
    } catch (e) {
      if (e instanceof WorkingCopyWireError) return refused({ error: e.code, problems: e.problems });
      throw e;
    }
    let diff;
    try {
      diff = diffWorkingCopy({ spec: handle.working, handlers: handle.storedHandlers }, folder);
    } catch (e) {
      if (e instanceof ShimFolderError) return refused({ error: e.code, problems: e.problems });
      throw e;
    }
    if (diff.ops.length === 0) {
      return refused({
        unchanged: true,
        note: 'the folder matches the working state — nothing to apply',
        ...(diff.warnings.length ? { warnings: diff.warnings } : {}),
      });
    }
    const next = applyDelta(handle.working, diff.ops);
    seedAddedRules(handle.working, next, diff.ops);
    // The browser's commit-time check, dry-run: a lint error applies nothing.
    // First, so an invented kind reads as the typo it is, not as a feature
    // this host lacks.
    const lint = lintSpec(next);
    if (lint.errors.length) return refused({ rejected: lint.errors.join('; ') });
    // D15 preflight, atomic: nothing reaches the page.
    const pre = preflightSpec(next, handle.host.capabilities);
    if (!pre.ok) return refused(unsupportedEvidence(pre.unsupported, deps.unsupportedDetail));
    const away = pageAway(handle);
    if (away) return refused(away);
    await followDocument(handle, signal);
    if (signal.aborted) return refused({ error: 'session-ended' });
    // Again after the replay's wait: the fresh document may have sent the
    // page off the site meanwhile (a script redirect).
    const awayAfter = pageAway(handle);
    if (awayAfter) return refused(awayAfter);

    const appliedAt = now();
    const emitKeys = new Map<string, Rule>();
    // Each emitted key's version (applyId): a replaced version's handler can
    // still report after this apply (a mount the engine doesn't cancel), and
    // its events are not this preview's evidence.
    const versions = new Map<string, string | undefined>();
    const nextById = new Map((next.rules || []).map((r) => [r.id, r]));
    // The working state first: an event the page reports for a preview below
    // (a witness) is matched against it.
    handle.working = next;
    for (const op of diff.ops) {
      if ((op.op === 'add-rule' || op.op === 'update-rule') && op.rule?.id) {
        const rule = nextById.get(op.rule.id) ?? op.rule;
        const p = previewFor(handle, rule);
        emitKeys.set(p.ruleKey, rule);
        versions.set(p.ruleKey, p.applyId);
        apply(handle, p);
        if (handle.tombstones.delete(rule.id)) await deps.tombstone?.(handle, rule.id, false);
      } else if (op.op === 'remove-rule' && op.ruleId) {
        const key = previewKey(handle.source.spec.id, op.ruleId);
        emitKeys.delete(key);
        remove(handle, key);
        // Removed since the base: a host that installs the shim keeps the
        // committed rule down until the removal is committed or discarded.
        if (handle.base.spec.rules?.some((r) => r.id === op.ruleId) && !handle.tombstones.has(op.ruleId)) {
          handle.tombstones.add(op.ruleId);
          await deps.tombstone?.(handle, op.ruleId, true);
        }
      }
    }
    handle.opsSinceBase.push(...diff.ops);

    await settle(signal);
    freezeCaptures(handle, emitKeys.keys());

    const mine = handle.events.filter((t) => t.at >= appliedAt && typeof t.event.specId === 'string' && emitKeys.has(t.event.specId)
      && (typeof t.event.applyId !== 'string' || t.event.applyId === versions.get(t.event.specId)));
    const errors = mine
      .filter((t) => t.event.kind === 'handler-error')
      .map(({ event: e }) => ({ ruleId: e.ruleId, handler: e.handlerName, message: e.message, stack: e.stack }));
    const lastStatus = new Map<string, PageRuntimeEvent>();
    const peak = new Map<string, number>();
    for (const { event: e } of mine) {
      if (e.kind !== 'rule-status' || !e.specId) continue;
      lastStatus.set(e.specId, e);
      if (typeof e.matched === 'number') peak.set(e.specId, Math.max(peak.get(e.specId) ?? 0, e.matched));
    }
    const quarantined = mine
      .filter((t) => t.event.kind === 'rule-quarantined')
      .map(({ event: e }) => ({ ruleId: e.ruleId, ...(typeof e.selector === 'string' && e.selector ? { selector: e.selector } : {}) }));
    const previewed = [...emitKeys].map(([key, rule]) => ({
      key,
      rule,
      status: lastStatus.get(key) as Parameters<typeof describeRuleStatus>[1],
      peakMatched: peak.get(key) ?? 0,
    }));
    const noMatch = previewNoMatch(
      mine
        .filter((t) => t.event.kind === 'rule-no-match')
        .map(({ event: e }) => ({ ruleId: e.ruleId, selector: typeof e.selector === 'string' ? e.selector : undefined })),
      previewed,
      new Set(quarantined.flatMap((q) => (typeof q.ruleId === 'string' ? [q.ruleId] : []))),
    );
    const noMatchIds = new Set(noMatch.map((n) => n.ruleId));

    const rules = previewed.map(({ key, rule, status }) => {
      const live = (handle.working.rules || []).find((r) => r.id === rule.id);
      return {
        ruleId: rule.id,
        // The working rule carries whatever this preview captured.
        status: describeRuleStatus(rule, status, { capture: statusCapture(handle, key) }),
        verification: verificationLevel(
          live?.anchor, handle.host.capabilities, (handle.unsupported.get(key)?.size ?? 0) > 0, noMatchIds.has(rule.id),
        ),
      };
    });

    const changed = [...emitKeys.values()];
    const scan = scanRuleHandlers(changed, handle.host.capabilities, handle.storedHandlers, deps.unsupportedError);
    const warnings = [...diff.warnings, ...lint.warnings, ...scan.map((f) => f.message)];
    const unsupportedApi = handle.unreported.splice(0);
    const notes: string[] = [];
    for (const { ruleId, member } of unsupportedApi) {
      notes.push(deps.unsupportedNote(ruleId, member));
    }
    for (const { ruleId, outcome, strategy, to } of handle.unreportedBroken.splice(0)) {
      notes.push(outcome === 'recovery'
        ? `rule "${ruleId}" no longer resolves through its anchor on this deploy; the engine found its element again ` +
          `(${strategy ?? 'rebase'}${to ? `, as ${to}` : ''}) but nothing applied that to the shim — update its anchor in shim.json. ` +
          'Until you do, a commit keeps the committed deploy baseline, so Shim can still recover the rule itself'
        : `rule "${ruleId}" is quarantined: its anchor no longer finds the element its witness describes — re-anchor it in shim.json. ` +
          'Until you do, a commit keeps the committed deploy baseline, so Shim still treats the break as a deploy and offers its repair');
    }
    const consoleBlock = formatAutoBlock(handle.console.drainSinceEmit());
    const evidence: Record<string, unknown> = {
      applied: true,
      rules,
      errors,
      noMatch,
      ...(quarantined.length ? { quarantined } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(notes.length ? { notes } : {}),
      ...(unsupportedApi.length ? { unsupportedApi } : {}),
      ...(consoleBlock ? { console: consoleBlock } : {}),
      changes: diff.ops.map(describeOp),
    };
    return { applied: true, evidence };
  }

  // --- page tools ------------------------------------------------------------

  async function call(handle: ShimSessionHandle<S>, name: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const args = isRecord(input) ? input : {};
    const str = (key: string): string => (typeof args[key] === 'string' ? args[key] : '');
    if (name in BROWSER_ONLY_PAGE_TOOLS) {
      return JSON.stringify({ error: deps.unsupportedError, detail: BROWSER_ONLY_PAGE_TOOLS[name] });
    }
    const guardOr = async (): Promise<string | null> => {
      const away = pageAway(handle);
      if (away) return JSON.stringify(away);
      await followDocument(handle, signal);
      // Again after the replay's wait: the page may have left the site meanwhile.
      const awayAfter = pageAway(handle);
      return awayAfter ? JSON.stringify(awayAfter) : null;
    };
    switch (name) {
      case 'view_page': {
        const away = await guardOr();
        if (away) return away;
        const selector = str('selector');
        const view = await viewPageOnHost(handle.host, selector ? { selector } : undefined, 'main');
        if (view.error || !view.dataBase64) return JSON.stringify(view);
        return [
          { type: 'text', text: shimViewPageCaption(view) },
          { type: 'image', source: { type: 'base64', media_type: view.mediaType || 'image/png', data: view.dataBase64 } },
        ];
      }
      case 'query_page': {
        const away = await guardOr();
        if (away) return away;
        const r = await queryPageByScript(handle.host, str('description'), QUERY_TIMEOUT_MS, 'main');
        return JSON.stringify('error' in r ? { error: r.detail ? `${r.error}: ${r.detail}` : r.error } : { candidates: r.candidates });
      }
      case 'inspect_element': {
        const away = await guardOr();
        if (away) return away;
        const r = await inspectElementByScript(handle.host, str('selector'), INSPECT_TIMEOUT_MS, 'main');
        return JSON.stringify('error' in r ? { found: false, error: r.detail ? `${r.error}: ${r.detail}` : r.error } : r.element);
      }
      case 'evaluate_in_page': {
        const expression = args.expression;
        const problem = expressionProblem(expression);
        if (problem) return JSON.stringify({ error: problem });
        const away = await guardOr();
        if (away) return away;
        return JSON.stringify(await evaluateOnHost(handle.host, String(expression), EVALUATE_TIMEOUT_MS, 'main'));
      }
      case 'read_console': {
        const level = args.level === 'error' || args.level === 'warning' ? args.level : 'all';
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 50;
        return JSON.stringify({ text: formatConsoleRead(handle.console.ring(), { level, limit }) });
      }
      case 'reload_page':
        return JSON.stringify(await reloadPage(handle, signal));
      case 'interact_page': {
        if (!deps.interact) return JSON.stringify({ error: deps.unsupportedError, detail: 'interact_page is not available on this host: drive the page in the Shim browser' });
        const away = await guardOr();
        if (away) return away;
        return JSON.stringify(await deps.interact(handle, input, signal));
      }
      case 'navigate':
        return JSON.stringify(await runNavigate(input, handle.navigation, (url) => navigatePage(handle, url, signal)));
      default:
        return JSON.stringify({ error: `unknown tool "${name}"` });
    }
  }

  // navigate: load a page of the start origin (runNavigate checked
  // it), then — when it landed on the session's site — re-apply the live
  // previews on the new document, as reload_page does.
  async function navigatePage(handle: ShimSessionHandle<S>, url: string, signal: AbortSignal): Promise<NavigateLoad> {
    if (handle.host.isClosed()) return { ok: false, url: '', offSite: null, reapplied: 0, error: 'the session\'s page closed' };
    // A fragment on the page already shown: no new document and no load
    // event; the previews stay live. Wait for the URL instead.
    if (isSameDocumentNavigation(handle.host.url(), url)) {
      handle.host.reload(url);
      const deadline = now() + 5000;
      while (now() < deadline && handle.host.url() !== url && !signal.aborted && !handle.host.isClosed()) await sleep(50);
      if (handle.host.url() !== url) return { ok: false, url: handle.host.url(), offSite: pageAway(handle), reapplied: 0, error: 'the page did not move to the fragment' };
      const away = pageAway(handle);
      // The document survived the fragment move, but it may not be the one
      // the previews were last applied to (a full load since): put them back.
      let reapplied = 0;
      if (!away && !(await onMarkedDocument(handle))) {
        for (const p of handle.live.values()) { apply(handle, p); reapplied++; }
        await markDocument(handle);
        if (reapplied > 0) await settle(signal);
        if (signal.aborted) return { ok: false, url: handle.host.url(), offSite: null, reapplied, error: 'session ended during the navigation' };
        if (handle.host.isClosed()) return { ok: false, url: '', offSite: null, reapplied, error: 'the page closed during the navigation' };
      }
      // The final state decides what is reported: the page may have left the
      // site, or loaded another document, while the restore settled.
      const finalAway = pageAway(handle);
      const survived = !finalAway && (reapplied === 0 || await onMarkedDocument(handle));
      return { ok: true, url: handle.host.url(), offSite: finalAway, reapplied, sameDocument: survived };
    }
    const loaded = handle.host.waitForLoad({ signal, timeoutMs: RELOAD_LOAD_TIMEOUT_MS, failures: 'main-frame' });
    handle.host.reload(url);
    const outcome = await loaded;
    if (signal.aborted) return { ok: false, url: handle.host.url(), offSite: null, reapplied: 0, error: 'session ended during the navigation' };
    if (handle.host.isClosed()) return { ok: false, url: '', offSite: null, reapplied: 0, error: 'the page closed during the navigation' };
    if (outcome.kind !== 'finished') {
      return { ok: false, url: handle.host.url(), offSite: pageAway(handle), reapplied: 0, error: `the page did not finish loading (${describeLoadOutcome(outcome)})` };
    }
    const landed = pageAway(handle);
    if (landed) return { ok: true, url: handle.host.url(), offSite: landed, reapplied: 0 };
    let reapplied = 0;
    for (const p of handle.live.values()) {
      apply(handle, p);
      reapplied++;
    }
    await markDocument(handle);
    await settle(signal);
    if (signal.aborted) return { ok: false, url: handle.host.url(), offSite: null, reapplied, error: 'session ended during the navigation' };
    // Where the page is after the settle decides what is reported: it may
    // have moved off the site meanwhile (the live set waits for it).
    return { ok: true, url: handle.host.url(), offSite: pageAway(handle), reapplied };
  }

  // reload_page: in place on the session's site, or back to the session's
  // start URL — never a destination the agent named. The reload wipes every
  // preview; the session re-applies them all (headless has no installed shim
  // to re-boot the committed rules).
  async function reloadPage(handle: ShimSessionHandle<S>, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (handle.host.isClosed()) return { error: 'the session\'s page closed' };
    if (handle.reloads >= MAX_RELOADS_PER_SESSION) {
      return {
        error: `reload limit (${MAX_RELOADS_PER_SESSION} per session) reached — do not keep reloading. ` +
          'Summarize what is applied, what is broken, and what the user should check.',
      };
    }
    handle.reloads += 1;
    const away = pageAway(handle);
    // Only the document's own load decides: a broken iframe must not end the
    // wait while the main navigation is still arriving (it would wipe the
    // previews re-applied below).
    const loaded = handle.host.waitForLoad({ signal, timeoutMs: RELOAD_LOAD_TIMEOUT_MS, failures: 'main-frame' });
    if (away) handle.host.reload(handle.startUrl);
    else handle.host.reload();
    const outcome = await loaded;
    if (signal.aborted) return { error: 'session ended during reload' };
    if (handle.host.isClosed()) return { error: 'the page closed during reload' };
    if (outcome.kind !== 'finished') {
      // No document to re-apply onto (or one still arriving): report it, and
      // keep the live set so the next successful reload restores it.
      return { error: `the reload did not finish (${describeLoadOutcome(outcome)}) — no previews were re-applied`, url: handle.host.url() };
    }
    // Where the load ended decides, not where it was sent: a reload, or the
    // way back to the start URL, can redirect off the session's site (a
    // sign-in host, another local port). Nothing of the shim runs there; the
    // live set is kept for the next document on the site.
    const landed = pageAway(handle);
    if (landed) return { ...landed, url: handle.host.url() };
    let reapplied = 0;
    for (const p of handle.live.values()) {
      apply(handle, p);
      reapplied++;
    }
    await markDocument(handle);
    // Settle after re-applying: the host applies asynchronously, so the
    // agent's next view_page must not race the previews it was told are live.
    await settle(signal);
    if (signal.aborted) return { error: 'session ended during reload' };
    if (handle.host.isClosed()) return { error: 'the page closed during reload' };
    return { ok: true, url: handle.host.url(), reapplied };
  }

  // --- commit ----------------------------------------------------------------

  // A conflict the host resolved by resetting: the session continues from
  // the state the host gave, with nothing of its own left on the page.
  async function resetTo(handle: ShimSessionHandle<S>, to: { spec: Spec; handlers: Record<string, string> }): Promise<void> {
    for (const key of [...handle.live.keys()]) remove(handle, key);
    for (const id of [...handle.tombstones]) {
      handle.tombstones.delete(id);
      await deps.tombstone?.(handle, id, false);
    }
    handle.working = clone(to.spec);
    handle.storedHandlers = { ...to.handlers };
    handle.version = typeof to.spec.version === 'number' ? to.spec.version : handle.version;
    handle.bundleHash = typeof to.spec.bundleHash === 'string' ? to.spec.bundleHash : handle.bundleHash;
    handle.committedAnchors = committedAnchorsOf(to.spec.rules, false);
    handle.base = { spec: clone(to.spec), handlers: { ...to.handlers } };
    handle.opsSinceBase = [];
    handle.broken.clear();
    handle.unreportedBroken.length = 0;
  }

  async function commit(handle: ShimSessionHandle<S>, req: { revision: number; summary: string; signal: AbortSignal }): Promise<BackendCommit> {
    // The deploy baseline is read from the page, so the page must still be
    // on the session's site: another host's deploy id would stamp the .shim
    // with a baseline its rules never match (rebase / quarantine in Shim).
    // A closed page has no document to read: the last baseline stands.
    const away = pageAway(handle);
    if (away && away.error === 'page-away') return { ok: false, error: away.error, detail: away.detail };
    // The deploy id is only worth recording from the document the rules
    // last ran on (marked when the live set was applied there): a document
    // loaded since — possibly another deploy — never reconciled them, so
    // its id would vouch for anchors nobody checked against it.
    const reconciled = !away && await onMarkedDocument(handle);
    const deployId = reconciled ? await currentDeployId(handle) : null;
    const version = handle.version + 1;
    // A rule left broken on this deploy (a recovery nothing applied, or a
    // quarantine) still has its dead anchor: stamping this deploy would hide
    // the deploy from Shim — a transient no-match instead of its recovery /
    // quarantine path, for good — so the committed baseline stands.
    const bundleHash = brokenRules(handle).length ? handle.bundleHash : (deployId ?? handle.bundleHash);
    const notes: string[] = [];
    if (!away && !reconciled) {
      notes.push('the page loaded a new document since the rules last ran on it, so this commit kept the committed deploy baseline ' +
        '(the rules were not checked against that document). Preview again, then commit, to record the page\'s deploy');
    }
    const spec = clone(handle.working) as Spec & Record<string, unknown>;
    delete spec.version;
    delete spec.bundleHash;
    let files;
    try {
      files = checkoutShim({ spec, handlers: handle.storedHandlers });
    } catch (e) {
      if (e instanceof ShimFolderError) return { ok: false, error: e.code, detail: e.problems.join('; ') };
      throw e;
    }
    const history = Array.isArray(handle.envelope.authoringHistory) ? [...(handle.envelope.authoringHistory as unknown[])] : [];
    history.push(
      { role: 'user', content: handle.intent.trim() || 'Work on this through an external session.', external: true, agent: handle.agent },
      { role: 'assistant', content: req.summary.trim() || 'Committed changes from an external session.', external: true, agent: handle.agent, versionId: version },
    );
    const state: ShimState = {
      format: SHIM_STATE_FORMAT,
      name: handle.source.name,
      version,
      ...(bundleHash ? { bundleHash } : {}),
      // No prototype: a rule id may be "__proto__", which a plain object's
      // assignment would swallow (and drop that rule's witness).
      rules: nameMap<RuleState>(),
      file: { ...handle.envelope, authoringHistory: history },
    };
    const setWitnesses = nameMap<SetWitnessState>();
    for (const rule of spec.rules || []) {
      if (rule.anchor?.witness) state.rules[rule.id] = { anchorDigest: anchorDigest(rule.anchor), witness: rule.anchor.witness };
      if (rule.anchor?.setWitness) setWitnesses[rule.id] = { anchorDigest: anchorDigest(rule.anchor), setWitness: rule.anchor.setWitness };
    }
    if (Object.keys(setWitnesses).length) state.setWitnesses = setWitnesses;
    let file: ShimFile;
    try {
      file = packShim({ ...files, [SHIM_STATE_FILE]: JSON.stringify(state) }, deps.syntaxProbe ? { syntax: deps.syntaxProbe } : undefined);
    } catch (e) {
      if (e instanceof ShimFolderError) return { ok: false, error: e.code, detail: e.problems.join('; ') };
      throw e;
    }
    // The last moment the session can still refuse: after this the commit
    // is the host's to make (registry.ts SessionBackend.commit).
    if (req.signal.aborted) return { ok: false, error: 'session-ended' };
    const written = await deps.writeCommit(handle, { file, state, version, bundleHash, history, opsSinceBase: [...handle.opsSinceBase] }, req.signal);
    if (!written.ok) {
      if (written.reset) await resetTo(handle, written.reset);
      return { ok: false, error: written.error, ...(written.detail !== undefined ? { detail: written.detail } : {}) };
    }
    handle.version = version;
    handle.bundleHash = bundleHash;
    handle.envelope = { ...handle.envelope, authoringHistory: history };
    if (written.adopted) {
      handle.working = clone(written.adopted.spec);
      handle.storedHandlers = { ...written.adopted.handlers };
    } else {
      handle.storedHandlers = { ...file.handlers };
    }
    handle.committedAnchors = committedAnchorsOf(handle.working.rules, false);
    handle.base = { spec: clone(handle.working), handlers: { ...handle.storedHandlers } };
    handle.opsSinceBase = [];
    // The host's writeCommit saw the tombstones and owns their release.
    handle.tombstones.clear();
    handle.source = { ...handle.source, created: false };
    notes.push(...(written.notes ?? []));
    return { ok: true, versionId: written.versionId, ...(notes.length ? { notes } : {}) };
  }

  return {
    async begin({ sessionId, target, agent, intent, signal }) {
      if (!isRecord(target) || !isRecord(target.page) || !isRecord(target.source)) {
        throw new Error('a shim session needs its page and its shim');
      }
      const { page, source } = target as unknown as ShimSessionTarget<S>;
      const host = page.host;
      const startUrl = host.url();
      const handle: ShimSessionHandle<S> = {
        sessionId,
        agent,
        intent,
        source,
        page,
        host,
        base: { spec: clone(source.spec), handlers: { ...source.handlers } },
        opsSinceBase: [],
        tombstones: new Set(),
        startUrl,
        startHost: hostnameOf(startUrl),
        startPort: portOf(startUrl),
        working: clone(source.spec),
        storedHandlers: { ...source.handlers },
        version: typeof source.spec.version === 'number' ? source.spec.version : 1,
        bundleHash: typeof source.spec.bundleHash === 'string' ? source.spec.bundleHash : undefined,
        committedAnchors: committedAnchorsOf(source.spec.rules, true),
        envelope: { ...source.envelope },
        live: new Map(),
        captures: new Map(),
        applies: 0,
        broken: new Map(),
        unreportedBroken: [],
        events: [],
        console: createConsoleFeed(),
        unsupported: new Map(),
        unreported: [],
        reloads: 0,
        off: [],
        docToken: null,
        docTokens: 0,
        navigation: { scope: navigationScopeOf(startUrl), used: 0 },
      };
      handle.off.push(host.onRuntimeEvent((event) => {
        handle.events.push({ at: now(), event });
        if (handle.events.length > EVENT_CAP) handle.events.splice(0, handle.events.length - EVENT_CAP);
        if (event.kind === 'rule-witness') takeWitness(handle, event);
        else noteOutcome(handle, event);
        if (event.kind === UNSUPPORTED_API_EVENT && typeof event.specId === 'string' && typeof event.member === 'string') {
          const live = handle.live.get(event.specId);
          // Only the live version's own calls count: a replaced version's
          // handler that resumes later (its applyId stamped on the event)
          // must not mark the replacement partial, as the evidence's other
          // event filters already hold.
          if (!live || (typeof event.applyId === 'string' && event.applyId !== live.applyId)) return;
          let members = handle.unsupported.get(event.specId);
          if (!members) {
            members = new Set();
            handle.unsupported.set(event.specId, members);
          }
          if (!members.has(event.member) && live) handle.unreported.push({ ruleId: live.rule.id, member: event.member });
          members.add(event.member);
        }
      }));
      handle.off.push(host.onConsole((m) => handle.console.push({ level: m.level, message: m.message, source: m.source, ts: now(), ...(m.frame ? { frame: m.frame } : {}), ...(m.hostLike ? { hostLike: true } : {}), ...(m.engineWorld ? { engineWorld: true } : {}) })));
      // A host with no installed shim runs the committed rules as previews;
      // one that installs the shim already runs them.
      if (deps.previewCommittedAtBegin) for (const rule of handle.working.rules || []) apply(handle, previewFor(handle, rule));
      await markDocument(handle);
      // The host applies asynchronously: settle (as preview and reload do) so
      // the agent's first view_page sees the committed shim, not the bare page.
      if (handle.live.size > 0) await settle(signal);
      freezeCaptures(handle, handle.live.keys());
      return handle;
    },
    async checkout(handle): Promise<BackendCheckout> {
      try {
        return { ok: true, files: encodeWorkingCopy(checkoutShim({ spec: handle.working, handlers: handle.storedHandlers })) };
      } catch (e) {
        if (e instanceof ShimFolderError) return { ok: false, error: e.code, detail: e.problems.join('; ') };
        throw e;
      }
    },
    preview,
    call,
    commit,
    async finish(handle: ShimSessionHandle<S>, _info: FinishInfo) {
      for (const off of handle.off) off();
      for (const key of [...handle.live.keys()]) {
        try { handle.host.removePreview(key); } catch { /* page gone */ }
      }
      handle.live.clear();
      for (const id of [...handle.tombstones]) {
        handle.tombstones.delete(id);
        try { await deps.tombstone?.(handle, id, false); } catch { /* page gone */ }
      }
      try {
        await handle.page.close();
      } catch {
        /* already closed */
      }
    },
  };
}
