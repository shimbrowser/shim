// sessions/registry.ts — external authoring sessions (design D1, D6, D14) on
// the Shim browser. The registry itself — ownership, the per-session queue,
// revisions, idempotent commit, ending as a signal, the idle timeout — is
// @shimbrowser/core/session-registry, the one implementation every host runs
// (headless sessions in @shimbrowser/mcp use it too). This module binds it to
// the browser's lease type: a backend here is handed the artifact's real
// Lease (the composition backend widens its signal to the session's).
//
// Bare-node harness-pinned (session-registry-harness, against the real
// artifact lease registry).
import type { Lease, LeaseRegistry } from '../authoring/artifact-lease';
import { isLeaseTimeout } from '../authoring/artifact-lease';
import * as core from '@shimbrowser/core/session-registry';

export type {
  SessionArtifactKind, EndReason, VersionId, SessionErrorCode, SessionError, OpenRequest,
  BackendPreview, BackendCheckout, BackendCommit, FinishInfo, SessionInfo, OpenResult, CheckoutResult,
  PreviewResult, CallResult, CommitResult, EndResult, CommitRequest, Timers, SessionRegistry, SessionMint,
} from '@shimbrowser/core/session-registry';
export { IDLE_TIMEOUT_MS, OPEN_LEASE_TIMEOUT_MS, END_SETTLE_TIMEOUT_MS, ArtifactBusyError, BeginRefusal } from '@shimbrowser/core/session-registry';

export type BeginArgs = core.BeginArgs<Lease>;
export type SessionBackend<H = unknown> = core.SessionBackend<H, Lease>;

export interface SessionRegistryOptions extends Omit<core.SessionRegistryOptions<Lease>, 'leases' | 'isLeaseTimeout'> {
  leases: Record<core.SessionArtifactKind, LeaseRegistry>;
}

export function createSessionRegistry(opts: SessionRegistryOptions): core.SessionRegistry {
  return core.createSessionRegistry<Lease>({ ...opts, isLeaseTimeout });
}
