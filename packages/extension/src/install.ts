// The one install path, up to the write: a `.shim` file's text becomes a
// prepared install (what the review page shows and the worker stores), or a
// refusal with every problem found. Pure: the page that reads the file calls
// it, the worker trusts only what it writes itself, and a harness pins it.
//
// Order: parse the envelope (core's reader: format, spec, handlers, state),
// refuse formats and kinds of shim this host does not take, check the hosts
// are registrable and the settings declaration is valid, preflight against
// the mode in force (D15: a secret setting is refused there, since this host
// has no encrypted store), and only then pack the canonical file (lint and
// the handler-module check). The preflight
// comes before the module check on purpose: an extension page's CSP permits
// no eval, so core's syntax probe cannot run here and reports every handler
// module as unparseable; a shim the mode refuses anyway must be refused for
// that reason, not for a check this page cannot make. Every refusal is
// atomic: nothing is written for a shim with one problem.

import {
  unpackShim, readShimFolder, packShim, matchHostsProblem, ShimFolderError, SHIM_FILE_FORMAT, type ShimFolderErrorCode,
} from '@shimbrowser/core/shim-folder';
import { preflightSpec, UNSUPPORTED, type UnsupportedFeature } from '@shimbrowser/core/capability-preflight';
import { settingsSchemaProblems } from '@shimbrowser/core/settings-schema';
import type { Spec } from '@shimbrowser/core/types';
import type { PageHostCapabilities } from '@shimbrowser/core/page-host';
import { matchPatternsForHosts } from './match-patterns';
import { HANDLER_KINDS, USER_SCRIPTS_REASON, type ExtensionMode } from './capabilities';

/** Where a shim came from. `file` today; `session` is a bridge commit; `marketplace` a fetched, signed listing. */
export interface InstallProvenance {
  source: 'file' | 'session' | 'marketplace';
  url?: string;
  publisher?: string;
}

/** One opt-in `api.storage` row the file carries. */
export interface UserDataRow {
  origin: string;
  key: string;
  value: unknown;
}

export interface PreparedInstall {
  ok: true;
  /** The file's display name. */
  name: string;
  /** The spec as the file holds it (version and witnesses restored); the id is the file's, the install mints its own. */
  spec: Spec;
  handlers: Record<string, string>;
  hosts: string[];
  /** The Chrome match patterns to register and to ask access for. */
  matchPatterns: string[];
  ruleCount: number;
  /** Distinct mutation kinds, in rule order. */
  mutationKinds: string[];
  userData: UserDataRow[];
  /** The envelope's other fields (intent, authoringHistory, …), kept for export. */
  envelope: Record<string, unknown>;
}

export type InstallRefusalCode =
  | ShimFolderErrorCode
  | 'unsupported-format'
  | 'global-shim'
  | 'bad-hosts'
  | typeof UNSUPPORTED;

export interface InstallRefusal {
  ok: false;
  error: InstallRefusalCode;
  /** One line each, for the review page. */
  problems: string[];
  /** The preflight's list, when `error` is `unsupported`. */
  unsupported?: UnsupportedFeature[];
}

const ENVELOPE_OWN_FIELDS = new Set(['format', 'name', 'spec', 'handlers', 'userData']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function refuse(error: InstallRefusalCode, problems: string[], unsupported?: UnsupportedFeature[]): InstallRefusal {
  return unsupported ? { ok: false, error, problems, unsupported } : { ok: false, error, problems };
}

function formatProblem(format: unknown): string {
  const name = typeof format === 'string' ? format : 'missing';
  switch (name) {
    case 'shim-pack/1': return 'this file is a shim pack; Shim for Chrome installs single shims (packs come later)';
    case 'shim/global-1':
    case 'shim/global-collection/1':
      return 'this file holds a global shim, which runs per host with its own implementation on each; Shim for Chrome runs single-site shims';
    case 'shim/composition-1': return 'this file is a composition (a page Shim serves itself), which runs only in the Shim browser';
    default: return `unsupported file format "${name}" (Shim for Chrome installs ${SHIM_FILE_FORMAT} files)`;
  }
}

function userDataRows(raw: unknown): { rows: UserDataRow[]; problems: string[] } {
  if (raw === undefined || raw === null) return { rows: [], problems: [] };
  if (!Array.isArray(raw)) return { rows: [], problems: ['"userData" is not an array'] };
  const rows: UserDataRow[] = [];
  const problems: string[] = [];
  raw.forEach((row: unknown, i) => {
    if (!isRecord(row) || typeof row.origin !== 'string' || typeof row.key !== 'string') {
      problems.push(`userData[${i}] is not a { origin, key, value } row`);
      return;
    }
    rows.push({ origin: row.origin, key: row.key, value: row.value });
  });
  return { rows, problems };
}

function distinctKinds(spec: Spec): string[] {
  const kinds: string[] = [];
  for (const rule of spec.rules ?? []) {
    for (const mutation of rule.mutations ?? []) {
      if (typeof mutation.kind === 'string' && !kinds.includes(mutation.kind)) kinds.push(mutation.kind);
    }
  }
  return kinds;
}

/**
 * Parse, check and preflight a `.shim` file against `capabilities` (the
 * mode's constant). `mode` only shapes the refusal: a shim refused for a
 * handler kind in declarative mode names user scripts as the reason.
 */
export function prepareInstall(fileText: string, capabilities: PageHostCapabilities, mode: ExtensionMode): PreparedInstall | InstallRefusal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText.charCodeAt(0) === 0xfeff ? fileText.slice(1) : fileText);
  } catch (err) {
    return refuse('malformed-shim-file', [`not valid JSON (${err instanceof Error ? err.message : String(err)})`]);
  }
  if (!isRecord(parsed)) return refuse('malformed-shim-file', ['the file is not a JSON object']);
  if (parsed.format !== SHIM_FILE_FORMAT) return refuse('unsupported-format', [formatProblem(parsed.format)]);
  if (isRecord(parsed.spec) && parsed.spec.global === true) {
    return refuse('global-shim', ['this shim is a global shim (a shared identity with one implementation per host); Shim for Chrome runs single-site shims']);
  }

  // The envelope through core's reader: unpack validates the file and splits
  // out its state; the folder read gives the authored spec for the checks
  // that need no eval (hosts, preflight).
  let files;
  let authored: Spec;
  try {
    files = unpackShim(parsed);
    authored = readShimFolder(files).spec;
  } catch (err) {
    if (err instanceof ShimFolderError) return refuse(err.code, err.problems);
    throw err;
  }

  const hostsProblem = matchHostsProblem(authored);
  if (hostsProblem) return refuse('malformed-shim-folder', [hostsProblem]);
  const hosts = [...(authored.match?.hosts ?? [])];
  const { patterns, problems: hostProblems } = matchPatternsForHosts(hosts);
  if (hostProblems.length) return refuse('bad-hosts', hostProblems);
  if (patterns.length === 0) return refuse('bad-hosts', ['match.hosts names no site']);

  // The settings declaration, checked by the reader every Shim host uses: a
  // malformed one would leave the settings page nothing it can show.
  const settingsProblems = settingsSchemaProblems(authored);
  if (settingsProblems.length) return refuse('malformed-shim-folder', settingsProblems);

  const pre = preflightSpec(authored, capabilities);
  if (!pre.ok) {
    const problems = pre.unsupported.map((u) => u.message);
    const needsHandlers = pre.unsupported.some((u) => u.feature === 'mutation-kind' && u.kind !== undefined && HANDLER_KINDS.includes(u.kind));
    if (mode === 'declarative' && needsHandlers) problems.push(USER_SCRIPTS_REASON);
    return refuse(UNSUPPORTED, problems, pre.unsupported);
  }

  // The canonical file: pack restores version, bundle hash and witnesses
  // from the state, lints, and checks the handler modules.
  let file;
  try {
    file = packShim(files);
  } catch (err) {
    if (err instanceof ShimFolderError) return refuse(err.code, err.problems);
    throw err;
  }
  const { spec, handlers } = file;

  const { rows, problems: dataProblems } = userDataRows(file.userData);
  if (dataProblems.length) return refuse('malformed-shim-file', dataProblems);

  const envelope: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(file)) {
    if (ENVELOPE_OWN_FIELDS.has(key)) continue;
    Object.defineProperty(envelope, key, { value, enumerable: true, writable: true, configurable: true });
  }

  return {
    ok: true,
    name: file.name,
    spec,
    handlers: { ...handlers },
    hosts,
    matchPatterns: patterns,
    ruleCount: (spec.rules ?? []).length,
    mutationKinds: distinctKinds(spec),
    userData: rows,
    envelope,
  };
}

/** A fresh id for an installed shim: import mints one, the file's never collides with another install's. */
export function mintShimId(uuid: string): string {
  return `shim-${uuid.replace(/-/g, '').slice(0, 16)}`;
}
