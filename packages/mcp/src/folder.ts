// The working copy on disk (shim-core design D10). The agent edits a folder;
// this reads the whole folder for a preview and writes a checkout into it.
// Shim never sees a path: the server sends bytes (working-copy-wire), and
// these reads and writes happen in the agent's own process, in a folder the
// agent named.
//
// Rules:
//   - Hidden entries (any segment starting with ".") are skipped on read:
//     editors' and VCS litter, and the tool-managed .shim-state.json, which
//     an attached host ignores anyway.
//   - A checkout writes only into an empty folder or an earlier checkout (a
//     folder holding shim.json), so pointing it at a project directory can't
//     scatter files through it. It replaces shim.json and handlers/*.js and
//     removes handler files the checkout no longer has; anything else in the
//     folder is left alone (and a preview then reports it as unknown).
//   - Every path written is checked against the folder root, and no
//     existing file or folder below the root on the way to it may be a
//     symlink (a crafted or stale folder could otherwise redirect a write
//     or a removal outside it).
//   - A file is replaced, never written in place: the content goes to a new
//     hidden temp file that is renamed over the entry, so a target that is a
//     hard link to a file outside the folder only loses its link here — the
//     shared inode is never truncated or rewritten.

import * as fs from 'fs';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { workingCopyPathProblem, SHIM_WIRE_LIMITS, type WireLimits } from '@shimbrowser/core/working-copy-wire';
import type { FolderInput } from '@shimbrowser/core/shim-folder';

export const SHIM_JSON = 'shim.json';
export const HANDLERS_DIR = 'handlers';

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

/** Every non-hidden file under `dir`, keyed by forward-slashed relative path. */
export function readWorkingCopy(dir: string, limits: WireLimits = SHIM_WIRE_LIMITS): FolderInput {
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
  const walk = (abs: string, rel: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (isHidden(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
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
  walk(dir, '');
  return out;
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

// Replaces the directory entry at `abs` with a fresh file. The temp file is
// created exclusively (so nothing already at that name, link or not, is
// followed) next to the target (so the rename never crosses a device), and is
// hidden (so a leftover from a crash never reads as part of the working copy).
// Its name is short and fixed-length, not derived from the target's: a
// handler file can use the whole 255-byte name a filesystem allows.
function replaceFile(abs: string, content: string | Uint8Array): void {
  const temp = path.join(path.dirname(abs), `.shim-${randomBytes(8).toString('hex')}.tmp`);
  fs.writeFileSync(temp, content, { flag: 'wx' });
  try {
    fs.renameSync(temp, abs);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Already gone: nothing to clean up.
    }
    throw err;
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
    replaceFile(abs, content);
    written.push(rel);
  }
  return { dir: root, written, removed };
}
