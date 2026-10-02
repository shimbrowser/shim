// The working copy on the wire (shim-core design D10): an attached session
// sends its WHOLE folder as bytes, and a checkout answers one the same way.
// This is the one encoding both ends share — the MCP server reads a folder
// from disk and encodes it, the host decodes it and hands the result to the
// kind's differ (working-copy-diff.ts for a shim). The host never reads a
// path an agent named: every byte it sees came in this envelope.
//
//   { "format": "shim-working-copy/1",
//     "files": [ { "path": "shim.json", "text": "…" },
//                { "path": "logo.png", "base64": "…" } ] }
//
// A file that is valid UTF-8 travels as `text`, anything else as `base64`.
// Paths are folder-relative, forward-slashed, with no empty, `.` or `..`
// segment and no leading slash — checked on decode, so a hostile envelope
// can't name anything outside the folder it describes.
//
// Pure and Node-free (TextEncoder / TextDecoder / atob / btoa only).

import type { FolderInput } from './shim-folder';

export const WORKING_COPY_FORMAT = 'shim-working-copy/1';

export interface WireFile {
  path: string;
  text?: string;
  base64?: string;
}

export interface WireWorkingCopy {
  format: typeof WORKING_COPY_FORMAT;
  files: WireFile[];
}

export interface WireLimits {
  /** Most files a working copy may hold. */
  maxFiles: number;
  /** Most bytes (decoded) all files together may hold. */
  maxBytes: number;
}

/** A shim folder: shim.json plus its handlers, generously bounded. */
export const SHIM_WIRE_LIMITS: WireLimits = { maxFiles: 500, maxBytes: 8 * 1024 * 1024 };

/**
 * A composition folder: manifest.json plus at most 200 files and 50MB (the
 * composition's own bounds, which the host checks exactly), with headroom
 * for the manifest.
 */
export const COMPOSITION_WIRE_LIMITS: WireLimits = { maxFiles: 201, maxBytes: 51 * 1024 * 1024 };

export class WorkingCopyWireError extends Error {
  readonly code = 'malformed-working-copy';
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`malformed-working-copy: ${problems.join('; ')}`);
    this.name = 'WorkingCopyWireError';
    this.problems = problems;
  }
}

const MAX_PATH_LENGTH = 512;

/** Why a folder-relative path is unsafe, or null when it is fine. */
export function workingCopyPathProblem(path: string): string | null {
  if (typeof path !== 'string' || path === '') return 'a file has no path';
  if (path.length > MAX_PATH_LENGTH) return `path "${path.slice(0, 40)}…" is longer than ${MAX_PATH_LENGTH} characters`;
  if (path.includes('\\')) return `path "${path}" uses a backslash (use "/")`;
  if (path.includes('\0')) return `path "${path}" contains a NUL byte`;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return `path "${path}" is absolute`;
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return `path "${path}" has an empty, "." or ".." segment`;
    // The folder is a plain object keyed by path.
    if (segment === '__proto__') return `path "${path}" has a "__proto__" segment`;
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Encodes a folder for the wire, paths sorted so the bytes are deterministic. */
export function encodeWorkingCopy(folder: FolderInput): WireWorkingCopy {
  const files: WireFile[] = [];
  for (const path of Object.keys(folder).sort()) {
    const content = folder[path];
    if (typeof content === 'string') {
      files.push({ path, text: content });
      continue;
    }
    if (!(content instanceof Uint8Array)) continue;
    let text: string | null;
    try {
      text = strictUtf8.decode(content);
    } catch {
      text = null;
    }
    files.push(text !== null ? { path, text } : { path, base64: bytesToBase64(content) });
  }
  return { format: WORKING_COPY_FORMAT, files };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const encoder = new TextEncoder();

/**
 * Decodes and validates a wire working copy into a folder. Throws
 * WorkingCopyWireError listing every problem found.
 */
export function decodeWorkingCopy(body: unknown, limits: WireLimits = SHIM_WIRE_LIMITS): FolderInput {
  if (!isRecord(body)) throw new WorkingCopyWireError(['the working copy must be a JSON object']);
  if (body.format !== WORKING_COPY_FORMAT) throw new WorkingCopyWireError([`format must be "${WORKING_COPY_FORMAT}"`]);
  if (!Array.isArray(body.files)) throw new WorkingCopyWireError(['files must be an array']);
  if (body.files.length > limits.maxFiles) {
    throw new WorkingCopyWireError([`${body.files.length} files is more than the ${limits.maxFiles} a working copy may hold`]);
  }
  const problems: string[] = [];
  const folder: FolderInput = {};
  let total = 0;
  for (const raw of body.files as unknown[]) {
    if (!isRecord(raw)) {
      problems.push('a file entry is not an object');
      continue;
    }
    const path = raw.path;
    if (typeof path !== 'string') {
      problems.push('a file has no path');
      continue;
    }
    const pathProblem = workingCopyPathProblem(path);
    if (pathProblem) {
      problems.push(pathProblem);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(folder, path)) {
      problems.push(`path "${path}" appears twice`);
      continue;
    }
    const hasText = typeof raw.text === 'string';
    const hasBase64 = typeof raw.base64 === 'string';
    if (hasText === hasBase64) {
      problems.push(`file "${path}" must carry exactly one of text or base64`);
      continue;
    }
    if (hasText) {
      const text = raw.text as string;
      total += encoder.encode(text).length;
      folder[path] = text;
    } else {
      const bytes = base64ToBytes(raw.base64 as string);
      if (bytes === null) {
        problems.push(`file "${path}" is not valid base64`);
        continue;
      }
      total += bytes.length;
      folder[path] = bytes;
    }
    if (total > limits.maxBytes) {
      throw new WorkingCopyWireError([`the working copy is larger than ${limits.maxBytes} bytes`]);
    }
  }
  if (problems.length) throw new WorkingCopyWireError(problems);
  return folder;
}
