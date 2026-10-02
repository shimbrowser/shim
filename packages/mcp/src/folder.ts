// The working copy on disk (shim-core design D10). The agent edits a folder;
// this reads the whole folder for a preview and writes a checkout into it —
// a shim's (shim.json + handlers/) or a composition's (manifest.json + its
// flat files).
// Shim never sees a path: the server sends bytes (working-copy-wire), and
// these reads and writes happen in the agent's own process, in a folder the
// agent named.
//
// Rules:
//   - Hidden entries (any segment starting with ".") are skipped on read:
//     editors' and VCS litter, and the tool-managed .shim-state.json, which
//     an attached host ignores anyway. The one exception: a composition may
//     hold hidden files of its own (an internal turn can write .config.js or
//     .well-known/x.json). Its checkout lists the hidden paths it wrote in
//     the marker file, and a composition read takes exactly those back — so
//     they round-trip instead of reading as deleted, and editor litter still
//     never reaches Shim.
//   - A checkout writes only into an empty folder or an earlier checkout (a
//     folder holding shim.json), so pointing it at a project directory can't
//     scatter files through it. It replaces shim.json and handlers/*.js and
//     removes handler files the checkout no longer has; anything else in the
//     folder is left alone (and a preview then reports it as unknown).
//   - A composition checkout writes only into an empty folder or an earlier
//     composition checkout (one holding the hidden marker file it leaves),
//     because the folder IS the composition: a re-checkout removes every
//     visible file the composition no longer has. A folder that merely holds
//     a manifest.json (a web app, an extension) is never treated as one.
//   - Every path written is checked against the folder root, and no
//     existing file or folder below the root on the way to it may be a
//     symlink (a crafted or stale folder could otherwise redirect a write
//     or a removal outside it). A composition holding a file named like the
//     marker can't be checked out (the checkout would overwrite it) and says so.

import * as fs from 'fs';
import * as path from 'path';
import { workingCopyPathProblem, SHIM_WIRE_LIMITS, type WireLimits } from '@shimbrowser/core/working-copy-wire';
import type { FolderInput } from '@shimbrowser/core/shim-folder';

export const SHIM_JSON = 'shim.json';
export const HANDLERS_DIR = 'handlers';
export const MANIFEST_JSON = 'manifest.json';
/** The hidden file that marks a folder as a composition checkout. */
export const COMPOSITION_MARKER = '.shim-composition';

export type WorkingCopyKind = 'shim' | 'composition';

export class FolderError extends Error {
  readonly code: 'folder-missing' | 'folder-too-large' | 'not-a-working-copy' | 'unsafe-path';
  constructor(code: FolderError['code'], message: string) {
    super(message);
    this.name = 'FolderError';
    this.code = code;
  }
}

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

function hasHiddenSegment(rel: string): boolean {
  return rel.split('/').some(isHidden);
}

/**
 * Every non-hidden file under `dir`, keyed by forward-slashed relative path,
 * plus the hidden-path files `keepHidden` names (a composition checkout's).
 */
export function readWorkingCopy(dir: string, limits: WireLimits = SHIM_WIRE_LIMITS, keepHidden: ReadonlySet<string> = new Set()): FolderInput {
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    throw new FolderError('folder-missing', `${dir} does not exist — check the session out first (shim_checkout)`);
  }
  if (!st.isDirectory()) throw new FolderError('folder-missing', `${dir} is not a folder`);
  const out: FolderInput = {};
  let count = 0;
  let bytes = 0;
  const keptDirs = new Set<string>();
  for (const p of keepHidden) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i += 1) keptDirs.add(parts.slice(0, i).join('/'));
  }
  // `hidden`: the folder being walked is (under) a hidden segment, so only
  // what keepHidden names is read from it.
  const walk = (abs: string, rel: string, hidden: boolean): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childHidden = hidden || isHidden(entry.name);
      if (entry.isDirectory()) {
        if (!childHidden || keptDirs.has(childRel)) walk(childAbs, childRel, childHidden);
        continue;
      }
      if (childHidden && !keepHidden.has(childRel)) continue;
      // Symlinks and other non-files are not part of a working copy.
      if (!entry.isFile()) continue;
      count += 1;
      if (count > limits.maxFiles) {
        throw new FolderError('folder-too-large', `${dir} holds more than ${limits.maxFiles} files`);
      }
      const content = fs.readFileSync(childAbs);
      bytes += content.length;
      if (bytes > limits.maxBytes) {
        throw new FolderError('folder-too-large', `${dir} holds more than ${limits.maxBytes} bytes`);
      }
      out[childRel] = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    }
  };
  walk(dir, '', false);
  return out;
}

/** The hidden paths a composition checkout in `dir` wrote (its marker's list). */
export function checkoutHiddenPaths(dir: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, COMPOSITION_MARKER), 'utf8'));
  } catch {
    return new Set();
  }
  const list = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as { hidden?: unknown }).hidden : undefined;
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter((p): p is string => typeof p === 'string' && p !== COMPOSITION_MARKER
    && hasHiddenSegment(p) && workingCopyPathProblem(p) === null));
}

/** A composition working copy: every visible file plus the hidden files its checkout wrote. */
export function readCompositionWorkingCopy(dir: string, limits: WireLimits): FolderInput {
  return readWorkingCopy(dir, limits, checkoutHiddenPaths(dir));
}

function resolveInside(root: string, rel: string): string {
  const problem = workingCopyPathProblem(rel);
  if (problem) throw new FolderError('unsafe-path', problem);
  const abs = path.resolve(root, ...rel.split('/'));
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new FolderError('unsafe-path', `path "${rel}" leaves the folder`);
  return abs;
}

// Every existing component of `abs` below `root` (and `abs` itself) must be
// a real file or folder: a symlink there would carry a write or a removal
// out of the folder that resolveInside only proved lexically. The root is
// the agent's own choice and may itself sit behind a symlink (/tmp on macOS).
function refuseSymlinksBelow(root: string, abs: string): void {
  const rel = path.relative(root, abs);
  if (!rel) return;
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch {
      return; // Doesn't exist yet: nothing below it can either.
    }
    if (st.isSymbolicLink()) {
      throw new FolderError('unsafe-path', `${path.relative(root, current) || current} is a symlink — check out into a folder without links`);
    }
  }
}

function visibleEntries(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => !isHidden(n));
  } catch {
    return [];
  }
}

export interface CheckoutWrite {
  dir: string;
  written: string[];
  removed: string[];
}

/** Writes a checkout (folder-relative path → contents) into `dir`. */
export function writeCheckout(dir: string, files: FolderInput): CheckoutWrite {
  const root = path.resolve(dir);
  if (fs.existsSync(root)) {
    if (!fs.statSync(root).isDirectory()) throw new FolderError('not-a-working-copy', `${root} exists and is not a folder`);
    const entries = visibleEntries(root);
    if (entries.length > 0 && !entries.includes(SHIM_JSON)) {
      throw new FolderError(
        'not-a-working-copy',
        `${root} is not empty and holds no ${SHIM_JSON} — check out into an empty folder (or an earlier checkout)`,
      );
    }
  }
  // Validate every path before touching the disk.
  const targets = Object.keys(files).sort().map((rel) => [rel, resolveInside(root, rel)] as const);
  const handlersDir = path.join(root, HANDLERS_DIR);
  for (const [, abs] of targets) refuseSymlinksBelow(root, abs);
  refuseSymlinksBelow(root, handlersDir);
  fs.mkdirSync(root, { recursive: true });
  const removed: string[] = [];
  for (const name of visibleEntries(handlersDir)) {
    const rel = `${HANDLERS_DIR}/${name}`;
    if (!name.endsWith('.js') || rel in files) continue;
    const abs = path.join(handlersDir, name);
    if (fs.lstatSync(abs).isFile()) {
      fs.unlinkSync(abs);
      removed.push(rel);
    }
  }
  const written: string[] = [];
  for (const [rel, abs] of targets) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const content = files[rel];
    if (content === undefined) continue;
    fs.writeFileSync(abs, content);
    written.push(rel);
  }
  return { dir: root, written, removed };
}

function visibleFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isHidden(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(abs, entry.name), childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk(root, '');
  return out;
}

function isRegularFile(abs: string): boolean {
  try {
    return fs.lstatSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Writes a composition checkout (manifest.json + its files) into `dir`. */
export function writeCompositionCheckout(dir: string, files: FolderInput): CheckoutWrite {
  const root = path.resolve(dir);
  if (fs.existsSync(root)) {
    if (!fs.statSync(root).isDirectory()) throw new FolderError('not-a-working-copy', `${root} exists and is not a folder`);
    if (visibleEntries(root).length > 0 && !fs.existsSync(path.join(root, COMPOSITION_MARKER))) {
      throw new FolderError(
        'not-a-working-copy',
        `${root} is not empty and is not an earlier composition checkout — check out into an empty folder`,
      );
    }
  }
  // The checkout owns the marker's name: a composition file by that name
  // would be overwritten by it and then read back as missing. Refuse before
  // touching the disk rather than corrupt the working copy.
  if (COMPOSITION_MARKER in files) {
    throw new FolderError(
      'unsafe-path',
      `the composition holds a file named "${COMPOSITION_MARKER}", the name a checkout reserves for its marker — ` +
        'ask the user to rename or remove it in Shim, then check out again',
    );
  }
  const targets = Object.keys(files).sort().map((rel) => [rel, resolveInside(root, rel)] as const);
  // The composition's own hidden files.
  const hidden = Object.keys(files).filter(hasHiddenSegment).sort();
  const previousHidden = checkoutHiddenPaths(root);
  fs.mkdirSync(root, { recursive: true });
  // The folder is the composition: what it no longer has goes — visible
  // files, and hidden ones an earlier checkout wrote.
  const removed: string[] = [];
  for (const rel of [...visibleFilesUnder(root), ...previousHidden]) {
    if (rel in files) continue;
    const abs = resolveInside(root, rel);
    if (!isRegularFile(abs)) continue;
    fs.unlinkSync(abs);
    removed.push(rel);
  }
  const written: string[] = [];
  for (const [rel, abs] of targets) {
    const content = files[rel];
    if (content === undefined) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    written.push(rel);
  }
  fs.writeFileSync(path.join(root, COMPOSITION_MARKER), `${JSON.stringify({ format: 'shim-composition-checkout/1', hidden })}\n`);
  return { dir: root, written, removed };
}

/** Which kind of working copy a checkout's files are. */
export function checkoutKind(files: FolderInput): WorkingCopyKind {
  return SHIM_JSON in files ? 'shim' : 'composition';
}

/** Which kind of working copy a folder on disk holds (null: neither). */
export function folderKind(dir: string): WorkingCopyKind | null {
  if (fs.existsSync(path.join(dir, SHIM_JSON))) return 'shim';
  if (fs.existsSync(path.join(dir, COMPOSITION_MARKER)) || fs.existsSync(path.join(dir, MANIFEST_JSON))) return 'composition';
  return null;
}
