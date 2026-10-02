// A headless authoring session on a shim (shim-core design D9, D10, D11, D14,
// D15): the session backend @shimbrowser/core's session registry drives when
// there is no Shim browser — a Playwright Chromium page (any PageHost) instead
// of a tab, a `.shim` file instead of the shim library.
//
//   begin     open the page, apply the shim as committed (every rule, as a
//             preview: headless has no installed shims), start listening
//   checkout  the working state as a shim folder (D10)
//   preview   the agent's whole folder → diff against the working state →
//             lint → preflight (D15) → apply the changed rules to the live
//             page → settle → evidence (D11)
//   call      the page tools, over core's page-host-tools
//   commit    write the working state to the `.shim` file: a new version,
//             witnesses kept, the session's exchange in its history
//   finish    tear every preview down and close the page
//
// Ordering, revisions, idempotent commit and ending are the registry's — the
// same implementation the Shim browser runs (D14).
//
// Invariants:
//   - Preflight is atomic: a working copy that declares anything outside
//     HEADLESS_CAPABILITIES applies nothing and answers `unsupported` with
//     the list (D15).
//   - Every rule's evidence carries its verification level: `partial` when
//     the witness carries component identity (headless can't check it) or an
//     `unsupported-api` event fired for the rule since it was last applied.
//   - Witnesses never reach the agent: the evidence carries none, checkout
//     writes none; they live in the session and in the committed `.shim`.
//   - Nothing here reads the Shim browser's profile (invariant 10): the page
//     is the caller's, `api.storage` is the caller's file.

import * as fs from 'fs';
import * as path from 'path';
import type { Spec, Rule, Witness } from '@shimbrowser/core/types';
import type { PageHost, PageRuntimeEvent, PreviewRule, Unsubscribe } from '@shimbrowser/core/page-host';
import type { SessionBackend, BackendPreview, BackendCheckout, BackendCommit, FinishInfo } from '@shimbrowser/core/session-registry';
import type { DeltaOp } from '@shimbrowser/core/spec-delta';
import { applyDelta } from '@shimbrowser/core/spec-delta';
import { lintSpec } from '@shimbrowser/core/spec-lint';
import {
  checkoutShim, packShim, anchorDigest, referencedHandlerNames, ShimFolderError,
  SHIM_STATE_FILE, SHIM_STATE_FORMAT, type ShimFile, type ShimState, type FolderInput,
} from '@shimbrowser/core/shim-folder';
import { moduleToExpression } from '@shimbrowser/core/handler-source';
import { diffWorkingCopy } from '@shimbrowser/core/working-copy-diff';
import { decodeWorkingCopy, encodeWorkingCopy, WorkingCopyWireError } from '@shimbrowser/core/working-copy-wire';
import {
  preflightSpec, scanRuleHandlers, verificationLevel, UNSUPPORTED_API_EVENT, type UnsupportedFeature,
} from '@shimbrowser/core/capability-preflight';
import { describeRuleStatus, previewKey, shimViewPageCaption } from '@shimbrowser/core/preview-evidence';
import { createConsoleFeed, formatAutoBlock, formatConsoleRead, type ConsoleFeed } from '@shimbrowser/core/console-feed';
import {
  viewPageOnHost, queryPageByScript, inspectElementByScript, evaluateOnHost, expressionProblem,
  QUERY_TIMEOUT_MS, INSPECT_TIMEOUT_MS, EVALUATE_TIMEOUT_MS,
} from '@shimbrowser/core/page-host-tools';
import { REQUIRES_SHIM_BROWSER } from './playwright-page-host';

// How long the page gets to react after an apply before the evidence is read:
// the Shim browser's window (APPLY_SETTLE_MS), above the engine's 1.5s
// no-match delay so an explicit rule-no-match lands inside it.
export const HEADLESS_SETTLE_MS = 2000;
// reload_page is a recovery tool, not a loop primitive (the browser's bound).
export const MAX_RELOADS_PER_SESSION = 3;
const RELOAD_LOAD_TIMEOUT_MS = 15_000;
// The runtime event buffer a preview's evidence reads from.
const EVENT_CAP = 2000;

/** Page tools that need a Shim browser subsystem (D2: they answer requires-shim-browser headless). */
export const BROWSER_ONLY_PAGE_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  verify_across_pages: 'verify_across_pages loads other pages of the site in a hidden Shim tab; headless mode has one page. Navigate with reload_page or check each page yourself.',
  interact_page: 'interact_page drives a composition\'s preview, and compositions run only in the Shim browser.',
});

/** One page a session works on, and how to let go of it. */
export interface HeadlessSessionPage {
  host: PageHost;
  close(): Promise<void>;
}

/** What a session starts from: the shim as committed, and where commits go. */
export interface HeadlessShimSource {
  /** Absolute path of the `.shim` file commits write. */
  shimFile: string;
  /** The display name. */
  name: string;
  /** The spec as committed (rules name their handlers; witnesses, version and bundleHash included). */
  spec: Spec;
  /** The handler modules (module form), by name. */
  handlers: Record<string, string>;
  /** The file's other envelope fields (authoringHistory, userData, …). */
  envelope: Record<string, unknown>;
  /** No file yet: the shim was created for this session. */
  created: boolean;
}

/** The registry's `target` for a headless session. */
export interface HeadlessTarget {
  page: HeadlessSessionPage;
  source: HeadlessShimSource;
}

export interface HeadlessBackendOptions {
  settleMs?: number;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** Where commits are written (default: fs, atomically). */
  writeShimFile?(file: string, content: string): void;
}

interface TimedEvent {
  at: number;
  event: PageRuntimeEvent;
}

export interface HeadlessHandle {
  sessionId: string;
  agent: string;
  intent: string;
  source: HeadlessShimSource;
  page: HeadlessSessionPage;
  host: PageHost;
  /** The page's host when the session began: the page-away guard's reference. */
  startUrl: string;
  startHost: string;
  /** The spec as of the latest applied revision (rules carry witnesses; changed rules carry handlers inline). */
  working: Spec;
  /** Module-form sources for handlers a working rule names without carrying them inline. */
  storedHandlers: Record<string, string>;
  /** As committed: version, bundleHash, the file's envelope. */
  version: number;
  bundleHash: string | undefined;
  envelope: Record<string, unknown>;
  /** Live previews by ruleKey: what reload_page re-applies. */
  live: Map<string, PreviewRule>;
  events: TimedEvent[];
  console: ConsoleFeed;
  /** unsupported-api members per ruleKey since the rule was last applied. */
  unsupported: Map<string, Set<string>>;
  /** unsupported-api uses not yet reported in a preview's evidence. */
  unreported: Array<{ ruleId: string; member: string }>;
  reloads: number;
  off: Unsubscribe[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
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
  const handlers: Record<string, string> = { ...(rule.handlers || {}) };
  for (const name of names) {
    const module = stored[name];
    if (handlers[name] === undefined && typeof module === 'string') handlers[name] = moduleToExpression(module);
  }
  return Object.keys(handlers).length ? { ...rule, handlers } : { ...rule };
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// The page-away guard (the browser's page-guard): page tools and previews
// refuse once the page left the session's site, so nothing is measured or
// witnessed against the wrong document.
function pageAway(handle: HeadlessHandle): { error: string; detail: string } | null {
  if (handle.host.isClosed()) return { error: 'page-closed', detail: 'the session\'s page closed — end the session and open a new one' };
  const url = handle.host.url();
  const now = hostnameOf(url);
  if (now && now === handle.startHost) return null;
  return {
    error: 'page-away',
    detail: `the page left ${handle.startHost} (it is at ${url || 'no page'}) — call reload_page to go back to ${handle.startUrl}`,
  };
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
export function unsupportedEvidence(unsupported: UnsupportedFeature[]): Record<string, unknown> {
  return {
    error: 'unsupported',
    detail: 'headless mode supports a subset of shim features (hide, restyle, reorder, reshape, script, ' +
      'inject-element, inject-html, remove, replace-root; api.storage and api.cleanup). Nothing was applied. ' +
      'Remove what is listed, or author this shim in the Shim browser.',
    unsupported: unsupported.map((u) => u.message),
  };
}

export function createHeadlessShimBackend(options: HeadlessBackendOptions = {}): SessionBackend<HeadlessHandle> {
  const settleMs = options.settleMs ?? HEADLESS_SETTLE_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const writeShimFile = options.writeShimFile ?? writeAtomic;

  function apply(handle: HeadlessHandle, preview: PreviewRule): void {
    handle.unsupported.delete(preview.ruleKey);
    handle.live.set(preview.ruleKey, preview);
    handle.host.applyPreview(preview);
  }

  function remove(handle: HeadlessHandle, ruleKey: string): void {
    handle.live.delete(ruleKey);
    handle.unsupported.delete(ruleKey);
    handle.host.removePreview(ruleKey);
  }

  // A rule applies behind the committed deploy baseline only while it keeps
  // the witness it was committed with (an unchanged anchor): a new or
  // re-anchored rule has nothing to rebase from.
  function previewFor(handle: HeadlessHandle, rule: Rule): PreviewRule {
    const preview: PreviewRule = {
      patchId: handle.source.spec.id,
      rule: previewRule(rule, handle.storedHandlers),
      ruleKey: previewKey(handle.source.spec.id, rule.id),
    };
    if (handle.bundleHash && rule.anchor?.witness) preview.bundleHash = handle.bundleHash;
    return preview;
  }

  async function settle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await Promise.race([
      sleep(settleMs),
      new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    ]);
  }

  async function currentDeployId(handle: HeadlessHandle): Promise<string | null> {
    try {
      const id = await handle.host.evaluate('ShimCore.deployIdForDocument(document)', 'engine');
      return typeof id === 'string' && id ? id : null;
    } catch {
      return null;
    }
  }

  async function preview(handle: HeadlessHandle, input: unknown, signal: AbortSignal): Promise<BackendPreview> {
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
    // The browser's commit-time check, dry-run: a lint error applies nothing.
    // First, so an invented kind reads as the typo it is, not as a feature
    // this host lacks.
    const lint = lintSpec(next);
    if (lint.errors.length) return refused({ rejected: lint.errors.join('; ') });
    // D15 preflight, atomic: nothing reaches the page.
    const pre = preflightSpec(next, handle.host.capabilities);
    if (!pre.ok) return refused(unsupportedEvidence(pre.unsupported));
    const away = pageAway(handle);
    if (away) return refused(away);
    if (signal.aborted) return refused({ error: 'session-ended' });

    const appliedAt = now();
    const emitKeys = new Map<string, Rule>();
    const nextById = new Map((next.rules || []).map((r) => [r.id, r]));
    for (const op of diff.ops) {
      if ((op.op === 'add-rule' || op.op === 'update-rule') && op.rule?.id) {
        const rule = nextById.get(op.rule.id) ?? op.rule;
        const p = previewFor(handle, rule);
        emitKeys.set(p.ruleKey, rule);
        apply(handle, p);
      } else if (op.op === 'remove-rule' && op.ruleId) {
        const key = previewKey(handle.source.spec.id, op.ruleId);
        emitKeys.delete(key);
        remove(handle, key);
      }
    }
    handle.working = next;

    await settle(signal);

    const mine = handle.events.filter((t) => t.at >= appliedAt && typeof t.event.specId === 'string' && emitKeys.has(t.event.specId));
    const errors = mine
      .filter((t) => t.event.kind === 'handler-error')
      .map(({ event: e }) => ({ ruleId: e.ruleId, handler: e.handlerName, message: e.message, stack: e.stack }));
    const noMatch = mine
      .filter((t) => t.event.kind === 'rule-no-match')
      .map(({ event: e }) => ({ ruleId: e.ruleId, selector: e.selector }));
    const lastStatus = new Map<string, PageRuntimeEvent>();
    for (const { event: e } of mine) {
      if (e.kind === 'rule-status' && e.specId) lastStatus.set(e.specId, e);
    }
    // Witness capture (§8): the engine fingerprinted a rule that resolved
    // exactly one element. Kept on the working rule for commit; never in the
    // evidence (invariant 8).
    for (const { event: e } of mine) {
      if (e.kind !== 'rule-witness' || typeof e.ruleId !== 'string' || !isRecord(e.witness)) continue;
      const rule = (handle.working.rules || []).find((r) => r.id === e.ruleId);
      if (rule?.anchor) rule.anchor = { ...rule.anchor, witness: e.witness as unknown as Witness };
    }
    const quarantined = mine
      .filter((t) => t.event.kind === 'rule-quarantined')
      .map(({ event: e }) => ({ ruleId: e.ruleId, ...(typeof e.selector === 'string' && e.selector ? { selector: e.selector } : {}) }));
    const rebased = mine.filter((t) => t.event.kind === 'rule-rebase');

    const rules = [...emitKeys].map(([key, rule]) => {
      const status = lastStatus.get(key);
      const live = (handle.working.rules || []).find((r) => r.id === rule.id);
      return {
        ruleId: rule.id,
        status: describeRuleStatus(rule, status as Parameters<typeof describeRuleStatus>[1]),
        verification: verificationLevel(live?.anchor?.witness, handle.host.capabilities, (handle.unsupported.get(key)?.size ?? 0) > 0),
      };
    });

    const changed = [...emitKeys.values()];
    const scan = scanRuleHandlers(changed, handle.host.capabilities, handle.storedHandlers, REQUIRES_SHIM_BROWSER);
    const warnings = [...diff.warnings, ...lint.warnings, ...scan.map((f) => f.message)];
    const unsupportedApi = handle.unreported.splice(0);
    const notes: string[] = [];
    for (const { ruleId, member } of unsupportedApi) {
      notes.push(`rule "${ruleId}" used api.${member}, which headless mode does not provide (${REQUIRES_SHIM_BROWSER}) — its result is partial`);
    }
    for (const { event: e } of rebased) {
      const how = typeof e.strategy === 'string' ? e.strategy : 'rebase';
      notes.push(`rule "${String(e.ruleId)}" was re-anchored on this deploy (${how}) — the page changed since the shim was committed; update its anchor in shim.json to keep the fix`);
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

  async function call(handle: HeadlessHandle, name: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const args = isRecord(input) ? input : {};
    const str = (key: string): string => (typeof args[key] === 'string' ? args[key] : '');
    if (name in BROWSER_ONLY_PAGE_TOOLS) {
      return JSON.stringify({ error: REQUIRES_SHIM_BROWSER, detail: BROWSER_ONLY_PAGE_TOOLS[name] });
    }
    const guardOr = (): string | null => {
      const away = pageAway(handle);
      return away ? JSON.stringify(away) : null;
    };
    switch (name) {
      case 'view_page': {
        const away = guardOr();
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
        const away = guardOr();
        if (away) return away;
        const r = await queryPageByScript(handle.host, str('description'), QUERY_TIMEOUT_MS, 'main');
        return JSON.stringify('error' in r ? { error: r.detail ? `${r.error}: ${r.detail}` : r.error } : { candidates: r.candidates });
      }
      case 'inspect_element': {
        const away = guardOr();
        if (away) return away;
        const r = await inspectElementByScript(handle.host, str('selector'), INSPECT_TIMEOUT_MS, 'main');
        return JSON.stringify('error' in r ? { found: false, error: r.detail ? `${r.error}: ${r.detail}` : r.error } : r.element);
      }
      case 'evaluate_in_page': {
        const expression = args.expression;
        const problem = expressionProblem(expression);
        if (problem) return JSON.stringify({ error: problem });
        const away = guardOr();
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
      default:
        return JSON.stringify({ error: `unknown tool "${name}"` });
    }
  }

  // reload_page: in place on the session's site, or back to the session's
  // start URL — never a destination the agent named. The reload wipes every
  // preview; the session re-applies them all (headless has no installed shim
  // to re-boot the committed rules).
  async function reloadPage(handle: HeadlessHandle, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (handle.host.isClosed()) return { error: 'the session\'s page closed' };
    if (handle.reloads >= MAX_RELOADS_PER_SESSION) {
      return {
        error: `reload limit (${MAX_RELOADS_PER_SESSION} per session) reached — do not keep reloading. ` +
          'Summarize what is applied, what is broken, and what the user should check.',
      };
    }
    handle.reloads += 1;
    const away = pageAway(handle);
    const loaded = handle.host.waitForLoad({ signal, timeoutMs: RELOAD_LOAD_TIMEOUT_MS, failures: 'any-frame' });
    if (away) handle.host.reload(handle.startUrl);
    else handle.host.reload();
    await loaded;
    if (signal.aborted) return { error: 'session ended during reload' };
    if (handle.host.isClosed()) return { error: 'the page closed during reload' };
    await settle(signal);
    let reapplied = 0;
    for (const p of handle.live.values()) {
      apply(handle, p);
      reapplied++;
    }
    return { ok: true, url: handle.host.url(), reapplied };
  }

  // --- commit ----------------------------------------------------------------

  async function commit(handle: HeadlessHandle, req: { revision: number; summary: string; signal: AbortSignal }): Promise<BackendCommit> {
    // The deploy baseline is read from the page, so the page must still be
    // on the session's site: another host's deploy id would stamp the .shim
    // with a baseline its rules never match (rebase / quarantine in Shim).
    // A closed page has no document to read: the last baseline stands.
    const away = pageAway(handle);
    if (away && away.error === 'page-away') return { ok: false, error: away.error, detail: away.detail };
    const deployId = away ? null : await currentDeployId(handle);
    const version = handle.version + 1;
    const bundleHash = deployId ?? handle.bundleHash;
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
      rules: {},
      file: { ...handle.envelope, authoringHistory: history },
    };
    for (const rule of spec.rules || []) {
      if (rule.anchor?.witness) state.rules[rule.id] = { anchorDigest: anchorDigest(rule.anchor), witness: rule.anchor.witness };
    }
    let file: ShimFile;
    try {
      file = packShim({ ...files, [SHIM_STATE_FILE]: JSON.stringify(state) });
    } catch (e) {
      if (e instanceof ShimFolderError) return { ok: false, error: e.code, detail: e.problems.join('; ') };
      throw e;
    }
    // The last moment the session can still refuse: after this the commit
    // happened (registry.ts SessionBackend.commit).
    if (req.signal.aborted) return { ok: false, error: 'session-ended' };
    try {
      writeShimFile(handle.source.shimFile, `${JSON.stringify(file, null, 2)}\n`);
    } catch (e) {
      return { ok: false, error: 'commit-failed', detail: `could not write ${handle.source.shimFile}: ${errMessage(e)}` };
    }
    handle.version = version;
    handle.bundleHash = bundleHash;
    handle.envelope = { ...handle.envelope, authoringHistory: history };
    handle.storedHandlers = { ...file.handlers };
    handle.source = { ...handle.source, created: false };
    return { ok: true, versionId: version };
  }

  return {
    async begin({ sessionId, target, agent, intent }) {
      if (!isRecord(target) || !isRecord(target.page) || !isRecord(target.source)) {
        throw new Error('a headless session needs its page and its shim');
      }
      const { page, source } = target as unknown as HeadlessTarget;
      const host = page.host;
      const startUrl = host.url();
      const handle: HeadlessHandle = {
        sessionId,
        agent,
        intent,
        source,
        page,
        host,
        startUrl,
        startHost: hostnameOf(startUrl),
        working: clone(source.spec),
        storedHandlers: { ...source.handlers },
        version: typeof source.spec.version === 'number' ? source.spec.version : 1,
        bundleHash: typeof source.spec.bundleHash === 'string' ? source.spec.bundleHash : undefined,
        envelope: { ...source.envelope },
        live: new Map(),
        events: [],
        console: createConsoleFeed(),
        unsupported: new Map(),
        unreported: [],
        reloads: 0,
        off: [],
      };
      handle.off.push(host.onRuntimeEvent((event) => {
        handle.events.push({ at: now(), event });
        if (handle.events.length > EVENT_CAP) handle.events.splice(0, handle.events.length - EVENT_CAP);
        if (event.kind === UNSUPPORTED_API_EVENT && typeof event.specId === 'string' && typeof event.member === 'string') {
          const live = handle.live.get(event.specId);
          let members = handle.unsupported.get(event.specId);
          if (!members) {
            members = new Set();
            handle.unsupported.set(event.specId, members);
          }
          if (!members.has(event.member) && live) handle.unreported.push({ ruleId: live.rule.id, member: event.member });
          members.add(event.member);
        }
      }));
      handle.off.push(host.onConsole((m) => handle.console.push({ level: m.level, message: m.message, source: m.source, ts: now() })));
      // Headless has no installed shims: the committed rules run as previews.
      for (const rule of handle.working.rules || []) apply(handle, previewFor(handle, rule));
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
    async finish(handle: HeadlessHandle, _info: FinishInfo) {
      for (const off of handle.off) off();
      for (const key of [...handle.live.keys()]) {
        try { handle.host.removePreview(key); } catch { /* page gone */ }
      }
      handle.live.clear();
      try {
        await handle.page.close();
      } catch {
        /* already closed */
      }
    },
  };
}
