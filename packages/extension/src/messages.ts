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
  spec: Spec;
  priority: number;
  handlers: Record<string, string>;
}

export interface BundleAnswer {
  ok: true;
  mode: ExtensionMode;
  shims: BundledShim[];
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
}

export type WorkerAnswer =
  | BundleAnswer
  | { ok: true; value: unknown }
  | { ok: true; mode: ExtensionMode; shims: ShimSummary[] }
  | { ok: true; mode: ExtensionMode }
  | { ok: true; id: string }
  | { ok: true }
  | { ok: false; error: string };

/** What the worker sends a page runtime: look again at what runs here. */
export type ToRuntime = { type: 'sync' };

/** The port a full-mode runtime opens to the worker, which nudges it there. */
export const RUNTIME_PORT = 'shim-runtime';

export function isToRuntime(msg: unknown): msg is ToRuntime {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'sync';
}

export function isToWorker(msg: unknown): msg is ToWorker {
  return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string';
}
