// sessions/registry.ts — external authoring sessions (design D1, D6, D14):
// an agent outside Shim (Claude Code, through the control endpoint) owns one
// artifact for a while and drives the same turn machinery an internal turn
// drives. Pure and Electron-free: the per-kind work lives behind a
// SessionBackend, the ownership behind the artifact's LeaseRegistry, and the
// clock behind injectable timers, so every ordering rule below is
// bare-node harness-pinned (session-registry-harness).
//
// Invariants:
//   - Ownership. open() takes the artifact's 'turn' lease without preempting
//     (a running turn is never stopped by an agent) and holds it for the
//     session's life. Anything that preempts the lease — a sidebar turn, a
//     delete — ends the session (reason 'preempted'), and the preempter is
//     granted the lease only once the session has torn down and released.
//   - One FIFO queue per session. Checkouts, previews, tool calls and
//     commits run one at a time, in arrival order.
//   - Revisions. The checkout is revision 0; every preview that applies
//     gets the next number. A commit names the revision it commits: anything
//     but the latest applied revision answers 'stale-revision', the revision
//     already committed answers 'nothing-to-commit'.
//   - Idempotent commit. A commit carries a caller-made commitId. A retry
//     with the id of a commit that completed returns the recorded result
//     (also after the session ended); a retry while it is still running
//     joins it. Only completed commits are recorded — a refused one changed
//     nothing, so retrying it simply tries again.
//   - A pending commit freezes the session. From the moment a commit is
//     accepted until it settles, every other call answers 'commit-pending'
//     (ops queued ahead of it still run first).
//   - Ending is a signal, not a queued call. end() (the agent's
//     shim_end_session, or the sidebar's stop), a preemption and the idle
//     timeout take the same path, exempt from the queue and the freeze:
//       1. the session's signal aborts — the backend binds every card it
//          raises (commit, consent, replay confirm) to it, so each closes as
//          a deny;
//       2. queued ops answer 'session-ended' at once; the in-flight op's
//          result is dropped and it answers 'session-ended' too — except a
//          commit whose transaction completed, which stays committed and
//          answers its result;
//       3. once the in-flight op has settled (bounded), the backend's finish
//          tears down (previews, the composition journal, the finish-turn
//          step) and the lease is released — last, always.
//     end() resolves with the last committed versionId, if any.
//   - Idle timeout. No call for idleTimeoutMs (10 minutes) while nothing is
//     queued or running ends the session; the discard is the backend's
//     finish with uncommitted changes.
//   - Sessions never touch the user's API key: nothing here, or in a
//     backend's contract, takes a model client.
import type { Lease, LeaseRegistry } from '../authoring/artifact-lease';
import { isLeaseTimeout } from '../authoring/artifact-lease';

export type SessionArtifactKind = 'shim' | 'composition';

// 'ended': the agent ended it (or the endpoint was turned off); 'stopped':
// the human pressed stop in Shim's sidebar. Both take the same signal path.
export type EndReason = 'ended' | 'stopped' | 'preempted' | 'idle';

export type VersionId = string | number;

export const IDLE_TIMEOUT_MS = 10 * 60_000;
// How long open() waits for the artifact's current owner before answering
// 'artifact-busy'. A session never preempts, so this is a short wait for an
// owner already winding down, not for a running turn.
export const OPEN_LEASE_TIMEOUT_MS = 5_000;
// How long ending waits for the in-flight op to notice the abort before
// tearing down anyway.
export const END_SETTLE_TIMEOUT_MS = 10_000;

// Error codes a session call can answer with. A backend may answer others
// (its own refusals, passed through as `error`).
export type SessionErrorCode =
  | 'unknown-session'
  | 'unknown-kind'
  | 'session-ended'
  | 'commit-pending'
  | 'stale-revision'
  | 'nothing-to-commit'
  | 'artifact-busy'
  | 'begin-failed'
  | 'target-changed'
  | 'invalid-request';

// A backend's begin throws this when the artifact is busy with something the
// session must not stop (one of Shim's own turns on it): open() answers
// 'artifact-busy', as it does when the lease itself is held.
export class ArtifactBusyError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ArtifactBusyError';
  }
}

// A backend's begin throws this when the target no longer matches the scope
// the human approved (`approvedScope`): open() answers 'target-changed', so
// the caller asks again for the new target.
export class TargetChangedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'TargetChangedError';
  }
}

export interface SessionError {
  ok: false;
  error: SessionErrorCode | string;
  detail?: string;
}

export interface OpenRequest {
  kind: SessionArtifactKind;
  artifactId: string;
  // The page the session works against (a tab), passed through to the
  // backend; its shape is the backend's.
  target?: unknown;
  // The consent scope the human approved for this session (the shim's host,
  // `composition:<uid>`). begin runs after the lease wait, so the target may
  // have moved since it was approved: a backend binding to something else
  // throws TargetChangedError.
  approvedScope?: string;
  // Who is driving (shown on Shim's cards), and what they set out to do.
  agent: string;
  intent: string;
  // The artifact was created for this session (after its attach consent):
  // the backend's finish removes it again when nothing was committed.
  created?: boolean;
  // A new composition the backend's begin creates under the session's lease
  // (artifactId is its freshly minted uid; nothing exists yet): the name it
  // was given and the mount the human chose on the attach card. Implies
  // created.
  mint?: SessionMint;
}

// A begin that refuses for a reason the agent can act on (a new
// composition's mount went to another while it waited): answered as its own
// error code rather than 'begin-failed'.
export class BeginRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BeginRefusal';
    this.code = code;
  }
}

export interface SessionMint {
  name: string;
  mount: string;
}

export interface BeginArgs {
  sessionId: string;
  artifactId: string;
  target: unknown;
  approvedScope?: string;
  agent: string;
  intent: string;
  // See OpenRequest.created.
  created: boolean;
  // See OpenRequest.mint; null when the artifact already exists.
  mint: SessionMint | null;
  // The artifact's 'turn' lease, held for the session's life.
  lease: Lease;
  // Aborts when the session ends, for any reason.
  signal: AbortSignal;
}

export type BackendPreview =
  | { applied: true; evidence: unknown }
  | { applied: false; evidence: unknown };

export type BackendCheckout =
  | { ok: true; files: unknown }
  | { ok: false; error: string; detail?: string };

export type BackendCommit =
  | { ok: true; versionId: VersionId }
  | { ok: false; error: string; detail?: string };

export interface FinishInfo {
  reason: EndReason;
  // A preview applied after the last completed commit (or with no commit):
  // there is work to discard.
  dirty: boolean;
  // At least one commit completed in this session.
  committed: boolean;
}

// One artifact kind's session work. `H` is the backend's own per-session
// state. preview / call / commit run strictly one at a time per session,
// never after finish has started.
export interface SessionBackend<H = unknown> {
  // Sets up exactly what an internal turn sets up (the kind's "begin"),
  // under the already-held lease. A throw fails open() with 'begin-failed'
  // ('artifact-busy' for an ArtifactBusyError, 'target-changed' for a
  // TargetChangedError, its own code for a BeginRefusal).
  begin(args: BeginArgs): Promise<H>;
  // The session's working copy as files (design D10), as of the latest
  // applied revision. Optional: a kind without one answers
  // 'checkout-unavailable'.
  checkout?(handle: H, signal: AbortSignal): Promise<BackendCheckout>;
  preview(handle: H, input: unknown, signal: AbortSignal): Promise<BackendPreview>;
  call(handle: H, name: string, input: unknown, signal: AbortSignal): Promise<unknown>;
  // Must check `signal` before its (atomic) commit transaction and never
  // after: a commit either completed or changed nothing.
  commit(handle: H, req: { revision: number; summary: string; signal: AbortSignal }): Promise<BackendCommit>;
  // The kind's "finish": teardown that must happen while the session still
  // owns the artifact. `release` releases the lease; a backend whose finish
  // has post-release work (reloads that must see the artifact free) calls it
  // itself, otherwise the registry releases right after finish returns.
  finish(handle: H, info: FinishInfo, release: () => void): Promise<void>;
}

export interface SessionInfo {
  sessionId: string;
  kind: SessionArtifactKind;
  artifactId: string;
  agent: string;
  intent: string;
  revision: number;
  committedRevision: number;
  lastVersionId: VersionId | null;
  state: 'open' | 'ending';
  commitPending: boolean;
}

export type OpenResult = { ok: true; sessionId: string } | SessionError;
export type CheckoutResult = { ok: true; revision: number; files: unknown } | SessionError;
export type PreviewResult = { ok: true; applied: boolean; revision: number; evidence: unknown } | SessionError;
export type CallResult = { ok: true; result: unknown } | SessionError;
export type CommitResult = { ok: true; versionId: VersionId; revision: number } | SessionError;
export type EndResult = { ok: true; reason: EndReason; versionId: VersionId | null } | SessionError;

export interface CommitRequest {
  revision: number;
  commitId: string;
  summary: string;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SessionRegistryOptions {
  leases: Record<SessionArtifactKind, LeaseRegistry>;
  // The lease key for an artifact (the shim id, the composition uid).
  leaseKey?(kind: SessionArtifactKind, artifactId: string): string;
  backends: Partial<Record<SessionArtifactKind, SessionBackend<unknown>>>;
  idleTimeoutMs?: number;
  openLeaseTimeoutMs?: number;
  endSettleTimeoutMs?: number;
  timers?: Timers;
  newId?(): string;
  // Ended sessions whose commit records are kept for idempotent retries.
  keepEnded?: number;
  // Told whenever the live list changes: a session opened, started ending,
  // ended, or a commit started or settled (the sidebar's session strip).
  onChange?(): void;
  // Told whenever a session ends, after its lease is released.
  onEnded?(info: { sessionId: string; kind: SessionArtifactKind; artifactId: string; reason: EndReason; versionId: VersionId | null }): void;
  onError?(label: string, err: unknown): void;
}

export interface SessionRegistry {
  open(req: OpenRequest): Promise<OpenResult>;
  checkout(sessionId: string): Promise<CheckoutResult>;
  preview(sessionId: string, input: unknown): Promise<PreviewResult>;
  call(sessionId: string, name: string, input: unknown): Promise<CallResult>;
  commit(sessionId: string, req: CommitRequest): Promise<CommitResult>;
  end(sessionId: string, reason?: EndReason): Promise<EndResult>;
  get(sessionId: string): SessionInfo | null;
  // The live session holding an artifact, if any.
  sessionFor(kind: SessionArtifactKind, artifactId: string): SessionInfo | null;
  list(): SessionInfo[];
}

// --- internals --------------------------------------------------------------

type OpResult = CheckoutResult | PreviewResult | CallResult | CommitResult;

interface QueuedOp {
  run(signal: AbortSignal): Promise<OpResult>;
  // Answers the caller. Called exactly once.
  settle(result: OpResult): void;
  settled: boolean;
  // A commit op: its completed result survives the session ending.
  isCommit: boolean;
}

interface CommitRecord {
  state: 'running' | 'done';
  promise: Promise<CommitResult>;
  result?: CommitResult;
}

interface Session {
  info: SessionInfo;
  backend: SessionBackend<unknown>;
  handle: unknown;
  lease: Lease;
  controller: AbortController;
  queue: QueuedOp[];
  inFlight: { op: QueuedOp; done: Promise<void> } | null;
  commits: Map<string, CommitRecord>;
  idleTimer: unknown;
  ending: Promise<EndResult> | null;
  offLeaseAbort: () => void;
}

interface EndedSession {
  info: SessionInfo;
  commits: Map<string, CommitRecord>;
  result: EndResult;
}

const SESSION_ENDED: SessionError = { ok: false, error: 'session-ended' };
const COMMIT_PENDING: SessionError = { ok: false, error: 'commit-pending' };
const UNKNOWN_SESSION: SessionError = { ok: false, error: 'unknown-session' };

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

let idCounter = 0;
function defaultId(): string {
  idCounter += 1;
  return `s${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function snapshot(info: SessionInfo): SessionInfo {
  return { ...info };
}

export function createSessionRegistry(opts: SessionRegistryOptions): SessionRegistry {
  const timers = opts.timers ?? realTimers;
  const idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const openLeaseTimeoutMs = opts.openLeaseTimeoutMs ?? OPEN_LEASE_TIMEOUT_MS;
  const endSettleTimeoutMs = opts.endSettleTimeoutMs ?? END_SETTLE_TIMEOUT_MS;
  const keepEnded = opts.keepEnded ?? 50;
  const newId = opts.newId ?? defaultId;
  const leaseKey = opts.leaseKey ?? ((_kind: SessionArtifactKind, id: string) => id);

  const live = new Map<string, Session>();
  const ended = new Map<string, EndedSession>();

  function report(label: string, err: unknown): void {
    try {
      opts.onError?.(label, err);
    } catch {
      // reporting is best-effort
    }
  }

  function changed(): void {
    try {
      opts.onChange?.();
    } catch (e) {
      report('session onChange', e);
    }
  }

  // --- idle timer -----------------------------------------------------------

  function armIdle(s: Session): void {
    if (s.idleTimer !== null) timers.clearTimeout(s.idleTimer);
    s.idleTimer = timers.setTimeout(() => {
      s.idleTimer = null;
      if (s.ending) return;
      // Not idle while work is queued or running: a commit card waiting on
      // the human is the session's own business. Re-armed when it settles.
      if (s.inFlight || s.queue.length > 0) return;
      void endSession(s, 'idle');
    }, idleTimeoutMs);
  }

  function disarmIdle(s: Session): void {
    if (s.idleTimer !== null) {
      timers.clearTimeout(s.idleTimer);
      s.idleTimer = null;
    }
  }

  // --- queue ----------------------------------------------------------------

  function pump(s: Session): void {
    if (s.ending || s.inFlight) return;
    const op = s.queue.shift();
    if (!op) {
      armIdle(s);
      return;
    }
    const done = (async () => {
      let result: OpResult;
      try {
        result = await op.run(s.controller.signal);
      } catch (e) {
        report('session op', e);
        result = { ok: false, error: 'op-failed', detail: e instanceof Error ? e.message : String(e) };
      }
      if (!op.settled) {
        op.settled = true;
        // An ending session drops the result — except a commit that
        // completed, which is committed whatever happens next.
        const keep = !s.ending || (op.isCommit && result.ok);
        op.settle(keep ? result : SESSION_ENDED);
      }
    })();
    s.inFlight = { op, done };
    void done.finally(() => {
      if (s.inFlight?.op === op) s.inFlight = null;
      pump(s);
    });
  }

  function enqueue<T extends OpResult>(s: Session, isCommit: boolean, run: (signal: AbortSignal) => Promise<T>): Promise<T | SessionError> {
    return new Promise<T | SessionError>((resolve) => {
      const op: QueuedOp = {
        run,
        settle: (r) => resolve(r as T | SessionError),
        settled: false,
        isCommit,
      };
      s.queue.push(op);
      disarmIdle(s);
      pump(s);
    });
  }

  // Common gate for preview / call / a new commit.
  function liveSession(sessionId: string): Session | SessionError {
    const s = live.get(sessionId);
    if (!s) return ended.has(sessionId) ? SESSION_ENDED : UNKNOWN_SESSION;
    if (s.ending) return SESSION_ENDED;
    if (s.info.commitPending) return COMMIT_PENDING;
    return s;
  }

  // --- end ------------------------------------------------------------------

  function endSession(s: Session, reason: EndReason): Promise<EndResult> {
    if (s.ending) return s.ending;
    s.info.state = 'ending';
    changed();
    disarmIdle(s);
    s.offLeaseAbort();
    // 1. Every card bound to the session closes as a deny; the in-flight op
    //    sees its signal abort.
    s.controller.abort();
    // 2. Queued ops answer at once.
    const queued = s.queue.splice(0);
    for (const op of queued) {
      if (!op.settled) {
        op.settled = true;
        op.settle(SESSION_ENDED);
      }
    }
    s.ending = (async (): Promise<EndResult> => {
      // The in-flight op settles first (bounded), so a commit transaction
      // that was running has either completed or not by the time teardown
      // decides what to discard.
      const inFlight = s.inFlight;
      if (inFlight) {
        let timer: unknown = null;
        const timedOut = new Promise<'timeout'>((resolve) => {
          timer = timers.setTimeout(() => resolve('timeout'), endSettleTimeoutMs);
        });
        const outcome = await Promise.race([inFlight.done.then(() => 'settled' as const), timedOut]);
        if (timer !== null) timers.clearTimeout(timer);
        if (outcome === 'timeout' && !inFlight.op.settled) {
          inFlight.op.settled = true;
          inFlight.op.settle(SESSION_ENDED);
        }
      }
      // 3. Teardown while still owning the artifact, then release — last,
      //    always.
      const info: FinishInfo = {
        reason,
        dirty: s.info.revision > s.info.committedRevision,
        committed: s.info.lastVersionId !== null,
      };
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        s.lease.release();
      };
      try {
        await s.backend.finish(s.handle, info, release);
      } catch (e) {
        report('session finish', e);
      } finally {
        release();
      }
      const result: EndResult = { ok: true, reason, versionId: s.info.lastVersionId };
      live.delete(s.info.sessionId);
      changed();
      ended.set(s.info.sessionId, { info: snapshot(s.info), commits: s.commits, result });
      while (ended.size > keepEnded) {
        const oldest = ended.keys().next();
        if (oldest.done) break;
        ended.delete(oldest.value);
      }
      try {
        opts.onEnded?.({ sessionId: s.info.sessionId, kind: s.info.kind, artifactId: s.info.artifactId, reason, versionId: s.info.lastVersionId });
      } catch (e) {
        report('session onEnded', e);
      }
      return result;
    })();
    return s.ending;
  }

  // --- public ---------------------------------------------------------------

  async function open(req: OpenRequest): Promise<OpenResult> {
    if (typeof req.artifactId !== 'string' || req.artifactId === '') return { ok: false, error: 'invalid-request', detail: 'artifactId is required' };
    const backend = opts.backends[req.kind];
    const leases = opts.leases[req.kind] as LeaseRegistry | undefined;
    if (!backend || !leases) return { ok: false, error: 'unknown-kind' };
    const sessionId = newId();
    let lease: Lease;
    try {
      lease = await leases.acquire(leaseKey(req.kind, req.artifactId), 'turn', { owner: sessionId, timeoutMs: openLeaseTimeoutMs });
    } catch (e) {
      if (isLeaseTimeout(e)) return { ok: false, error: 'artifact-busy' };
      throw e;
    }
    // A preempter queued behind us while we waited: it wins.
    if (lease.signal.aborted) {
      lease.release();
      return { ok: false, error: 'artifact-busy' };
    }
    const controller = new AbortController();
    // A preemption during begin aborts the session signal, so begin can stop
    // early; the session is torn down right after.
    const onEarlyAbort = (): void => controller.abort();
    lease.signal.addEventListener('abort', onEarlyAbort);
    let handle: unknown;
    try {
      handle = await backend.begin({
        sessionId, artifactId: req.artifactId, target: req.target, agent: req.agent, intent: req.intent,
        ...(req.approvedScope !== undefined ? { approvedScope: req.approvedScope } : {}),
        created: req.created === true || req.mint !== undefined, mint: req.mint ?? null,
        lease, signal: controller.signal,
      });
    } catch (e) {
      lease.signal.removeEventListener('abort', onEarlyAbort);
      lease.release();
      if (e instanceof ArtifactBusyError) return { ok: false, error: 'artifact-busy', detail: e.message };
      if (e instanceof TargetChangedError) return { ok: false, error: 'target-changed', detail: e.message };
      if (e instanceof BeginRefusal) return { ok: false, error: e.code, detail: e.message };
      return { ok: false, error: 'begin-failed', detail: e instanceof Error ? e.message : String(e) };
    }
    lease.signal.removeEventListener('abort', onEarlyAbort);
    const s: Session = {
      info: {
        sessionId, kind: req.kind, artifactId: req.artifactId, agent: req.agent, intent: req.intent,
        revision: 0, committedRevision: 0, lastVersionId: null, state: 'open', commitPending: false,
      },
      backend,
      handle,
      lease,
      controller,
      queue: [],
      inFlight: null,
      commits: new Map(),
      idleTimer: null,
      ending: null,
      offLeaseAbort: () => undefined,
    };
    live.set(sessionId, s);
    if (lease.signal.aborted || controller.signal.aborted) {
      await endSession(s, 'preempted');
      return { ok: false, error: 'artifact-busy' };
    }
    const onPreempt = (): void => { void endSession(s, 'preempted'); };
    lease.signal.addEventListener('abort', onPreempt);
    s.offLeaseAbort = () => lease.signal.removeEventListener('abort', onPreempt);
    armIdle(s);
    changed();
    return { ok: true, sessionId };
  }

  // Queued like any op, so the files it answers are exactly the revision it
  // names — never a preview's half-applied state.
  async function checkout(sessionId: string): Promise<CheckoutResult> {
    const s = liveSession(sessionId);
    if ('ok' in s) return s;
    return enqueue<CheckoutResult>(s, false, async (signal) => {
      if (!s.backend.checkout) return { ok: false, error: 'checkout-unavailable', detail: `checking out a ${s.info.kind} session is not available in this build` };
      const out = await s.backend.checkout(s.handle, signal);
      if (!out.ok) return { ok: false, error: out.error, ...(out.detail !== undefined ? { detail: out.detail } : {}) };
      return { ok: true, revision: s.info.revision, files: out.files };
    });
  }

  async function preview(sessionId: string, input: unknown): Promise<PreviewResult> {
    const s = liveSession(sessionId);
    if ('ok' in s) return s;
    return enqueue<PreviewResult>(s, false, async (signal) => {
      const out = await s.backend.preview(s.handle, input, signal);
      // Counted even when the session is ending: an applied preview is work
      // the teardown must discard (FinishInfo.dirty). Its result is dropped.
      if (out.applied) s.info.revision += 1;
      return { ok: true, applied: out.applied, revision: s.info.revision, evidence: out.evidence };
    });
  }

  async function call(sessionId: string, name: string, input: unknown): Promise<CallResult> {
    if (typeof name !== 'string' || name === '') return { ok: false, error: 'invalid-request', detail: 'name is required' };
    const s = liveSession(sessionId);
    if ('ok' in s) return s;
    return enqueue<CallResult>(s, false, async (signal) => {
      const result = await s.backend.call(s.handle, name, input, signal);
      return { ok: true, result };
    });
  }

  async function commit(sessionId: string, req: CommitRequest): Promise<CommitResult> {
    if (typeof req.commitId !== 'string' || req.commitId === '') return { ok: false, error: 'invalid-request', detail: 'commitId is required' };
    if (!Number.isInteger(req.revision) || req.revision < 0) return { ok: false, error: 'invalid-request', detail: 'revision must be a non-negative integer' };
    // A retry first: the recorded result, or the running attempt.
    const s0 = live.get(sessionId);
    const records = s0?.commits ?? ended.get(sessionId)?.commits;
    const record = records?.get(req.commitId);
    if (record) return record.result ?? record.promise;
    const s = liveSession(sessionId);
    if ('ok' in s) return s;
    s.info.commitPending = true;
    changed();
    const promise = enqueue<CommitResult>(s, true, async (signal) => {
      if (req.revision !== s.info.revision) return { ok: false, error: 'stale-revision', detail: `latest applied revision is ${s.info.revision}` };
      if (req.revision === s.info.committedRevision) return { ok: false, error: 'nothing-to-commit', detail: `revision ${req.revision} is already committed` };
      const out = await s.backend.commit(s.handle, { revision: req.revision, summary: req.summary, signal });
      if (!out.ok) return { ok: false, error: out.error, ...(out.detail !== undefined ? { detail: out.detail } : {}) };
      // Committed: recorded whatever happens to the session next.
      s.info.committedRevision = req.revision;
      s.info.lastVersionId = out.versionId;
      return { ok: true, versionId: out.versionId, revision: req.revision };
    }).then((result) => {
      s.info.commitPending = false;
      changed();
      if (result.ok) {
        s.commits.set(req.commitId, { state: 'done', promise, result });
      } else {
        s.commits.delete(req.commitId);
      }
      return result;
    });
    s.commits.set(req.commitId, { state: 'running', promise });
    return promise;
  }

  async function end(sessionId: string, reason: EndReason = 'ended'): Promise<EndResult> {
    const s = live.get(sessionId);
    if (s) return endSession(s, reason);
    const done = ended.get(sessionId);
    if (done) return done.result;
    return UNKNOWN_SESSION;
  }

  return {
    open,
    checkout,
    preview,
    call,
    commit,
    end,
    get(sessionId) {
      const s = live.get(sessionId);
      return s ? snapshot(s.info) : null;
    },
    sessionFor(kind, artifactId) {
      for (const s of live.values()) {
        if (s.info.kind === kind && s.info.artifactId === artifactId) return snapshot(s.info);
      }
      return null;
    },
    list() {
      return [...live.values()].map((s) => snapshot(s.info));
    },
  };
}
