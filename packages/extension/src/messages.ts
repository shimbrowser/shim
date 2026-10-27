// The messages between the extension's parts: the page runtime, the popup
// and the install page send; the service worker answers. Every answer is
// `{ ok: true, … }` or `{ ok: false, error }`, and the worker never acts on
// a message it cannot narrow. A message names no page of its own: the
// worker takes the sender's host and origin from the sender Chrome attaches
// (sender.ts), and answers each type only to the kind of sender it expects.
//
// A runtime in the user-script world (full mode) sends the same messages;
// they arrive on the worker's onUserScriptMessage. It cannot receive one,
// so it holds a port (RUNTIME_PORT) the worker nudges instead.

import type { Spec } from '@shimbrowser/core/types';
import type { PreparedInstall, InstallProvenance } from './install';
import type { ExtensionMode } from './capabilities';
import type { VersionRecord } from './store';

export type StorageMethod = 'get' | 'set' | 'delete' | 'list';

export type ToWorker =
  /** The page runtime, at document_start: which shims run on the sender's host and port. */
  | { type: 'bundle' }
  /** A handler's `api.storage` call, on the sender's origin. */
  | { type: 'storage'; method: StorageMethod; shimId: string; key?: string; value?: unknown }
  /** An engine event the page reports (rule status, rebases, errors). */
  | { type: 'event'; shimId: string; kind: string; payload: Record<string, unknown> }
  /** The install page: the mode in force, to prepare against. */
  | { type: 'mode' }
  | { type: 'shims.list' }
  | { type: 'shims.setEnabled'; id: string; enabled: boolean }
  | { type: 'shims.uninstall'; id: string }
  /** The shim as a `.shim` file (its spec as rebased, its handlers, its saved data): repair in Shim, or keep. */
  | { type: 'shims.export'; id: string }
  /** The shim's restorable snapshots. */
  | { type: 'shims.versions'; id: string }
  /** A restore is a forward change: the current spec is snapshotted, the chosen one becomes the next version. */
  | { type: 'shims.restore'; id: string; version: number }
  /** The install page, after the user granted the hosts: write and register. */
  | { type: 'install.commit'; prepared: PreparedInstall; provenance: InstallProvenance };

/**
 * One shim as the page runtime receives it: the spec with the installed id,
 * its cascade priority, and its handler modules (source, by name) for the
 * runtime to compile. The worker sends handlers only to a runtime in the
 * user-script world, where they compile; an isolated-world runtime gets
 * only the shims that run without one, and an empty map.
 */
export interface BundledShim {
  id: string;
  /** The spec, with the deploy baseline of the page's own kind in `bundleHash`. */
  spec: Spec;
  priority: number;
  /** The stored spec's version: a shim whose version moved (a rebase, a restore) boots again. */
  version: number;
  handlers: Record<string, string>;
}

export interface BundleAnswer {
  ok: true;
  mode: ExtensionMode;
  shims: BundledShim[];
  /**
   * The rules a session on this tab holds, by shim: each booted suppressed.
   * Apart from the list, since a held shim the list leaves out (disabled
   * under the preview) keeps its hold for when it is back.
   */
  held?: Record<string, string[]>;
  /** The hold sequence `held` is current as of; an older hold nudge arriving later is stale. */
  holdSeq?: number;
}

/** One installed shim as the popup lists it. */
export interface ShimSummary {
  id: string;
  name: string;
  enabled: boolean;
  hosts: string[];
  installedAt: number;
  ruleCount: number;
  /** Installed under a mode this browser no longer runs: it stays, disabled, until that mode is back. */
  needsFullMode: boolean;
  /** The stored spec's version, bumped by every rebase and restore. */
  version: number;
  /** Rules held for review: the ladder could not re-find their target after a site change. */
  review: ReviewItem[];
}

export interface ReviewItem {
  ruleId: string;
  reason: string;
  occurredAt: number;
}

/** One snapshot as the popup lists it. */
export type VersionSummary = Pick<VersionRecord, 'version' | 'at' | 'reason'>;

export type WorkerAnswer =
  | BundleAnswer
  | { ok: true; value: unknown }
  | { ok: true; mode: ExtensionMode; shims: ShimSummary[] }
  | { ok: true; mode: ExtensionMode }
  | { ok: true; id: string }
  | { ok: true; file: string; fileName: string }
  | { ok: true; versions: VersionSummary[] }
  | { ok: true }
  | { ok: false; error: string };

/**
 * What the worker sends a page runtime: look again at what runs here
 * (`sync`); start every shim afresh (`reboot`: the other world's runtime
 * on this page was just retired and its teardown may have removed
 * stylesheets this one shares); or leave the document to a runtime in
 * the other world (`retire`: tear everything down, drop the mark, hold no
 * port). Retire goes to an isolated-world runtime once full mode is on,
 * so the user-script runtime the worker then injects can take the page
 * over, and to whichever of two runtimes on one page does not fit the mode.
 */
export type ToRuntime =
  | { type: 'sync' }
  | { type: 'reboot' }
  | { type: 'retire' }
  /**
   * A session on this tab holds these rules of this shim (the whole set, not
   * a change): each is previewed, so the committed one stays down while the
   * hold lasts, through a reboot of the shim too. `seq` orders holds against
   * one another and against the bundle's `holdSeq`; the runtime acks it.
   */
  | { type: 'hold'; patchId: string; ruleIds: string[]; seq?: number }
  /** The session's connection to the page is gone: drop its previews (the DOM event) and release every hold. */
  | { type: 'session-closed'; seq?: number };

/**
 * The DOM event the page runtime dispatches when a session's connection
 * is gone: the session's own world, which the extension cannot reach any
 * other way then, drops every preview on it before the held rules come back.
 */
export const SESSION_CLOSE_EVENT = 'shim-core:session-closed';

/** The port a full-mode runtime opens to the worker, which nudges it there. */
export const RUNTIME_PORT = 'shim-runtime';

/**
 * What a runtime posts on its port: as it retires, whether it had run any
 * shim, so the worker reboots a surviving rival only when the teardown
 * can have taken something the survivor shares; and the ack of a hold.
 */
export type FromRuntime =
  | { type: 'retiring'; booted: boolean }
  /** A hold or session-closed nudge with `seq` was seen: applied, or ignored as older than what the runtime has. */
  | { type: 'ack'; seq: number; applied: boolean };

export function isFromRuntime(msg: unknown): msg is FromRuntime {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as { type?: unknown; booted?: unknown; seq?: unknown; applied?: unknown };
  if (m.type === 'retiring') return typeof m.booted === 'boolean';
  return m.type === 'ack' && typeof m.seq === 'number' && typeof m.applied === 'boolean';
}

export function isToRuntime(msg: unknown): msg is ToRuntime {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as { type?: unknown; patchId?: unknown; ruleIds?: unknown; seq?: unknown };
  if (m.type === 'sync' || m.type === 'reboot' || m.type === 'retire') return true;
  if (m.seq !== undefined && typeof m.seq !== 'number') return false;
  if (m.type === 'session-closed') return true;
  return m.type === 'hold' && typeof m.patchId === 'string' && Array.isArray(m.ruleIds) && m.ruleIds.every((r) => typeof r === 'string');
}

export function isToWorker(msg: unknown): msg is ToWorker {
  return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string';
}
