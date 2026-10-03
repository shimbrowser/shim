// A `.shim` file's cross-process claim for headless sessions (shim-core
// design D14: one session per file). The in-process lease only covers the
// sessions of one `shim-mcp --headless` process; two processes on the same
// file would both load it and the last commit's rename would silently drop
// the other's work. This lock is what spans processes.
//
// The lock is a `<file>.lock` beside the `.shim`, created atomically with its
// content (written to a unique temp file, then hard-linked into place: the
// link fails with EEXIST when the lock exists, so no reader ever sees a
// half-written lock). It records the holding process and a per-claimant
// token, so `release` only removes a lock it still owns.
//
// A lock left by a process that died (a crash; a clean shutdown releases) is
// stale: one on this machine whose pid is gone, or one that isn't a lock at
// all, is taken over. A lock from another machine (a shared filesystem) is
// never judged stale — its holder can't be checked from here.

import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'crypto';

export const FILE_LOCK_FORMAT = 'shim-mcp-lock/1';

export interface FileLockOwner {
  pid: number;
  hostname: string;
}

export interface FileLock {
  readonly path: string;
  release(): void;
}

export type FileLockResult =
  | { ok: true; lock: FileLock }
  | { ok: false; holder: FileLockOwner | null; detail: string };

export interface FileLockOptions {
  pid?: number;
  hostname?: string;
  /** Whether a process on this machine is running. Default: signal 0. */
  isAlive?(pid: number): boolean;
}

interface LockContent extends FileLockOwner {
  format: typeof FILE_LOCK_FORMAT;
  token: string;
  at: number;
}

export function lockFileFor(file: string): string {
  return `${file}.lock`;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it just isn't ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

function readLock(lockPath: string): LockContent | null | 'missing' {
  let text: string;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return 'missing';
    throw e;
  }
  try {
    const parsed = JSON.parse(text) as Partial<LockContent> | null;
    if (
      parsed && parsed.format === FILE_LOCK_FORMAT && typeof parsed.pid === 'number' &&
      typeof parsed.hostname === 'string' && typeof parsed.token === 'string'
    ) {
      return { format: FILE_LOCK_FORMAT, pid: parsed.pid, hostname: parsed.hostname, token: parsed.token, at: typeof parsed.at === 'number' ? parsed.at : 0 };
    }
  } catch {
    // not JSON: not a lock
  }
  return null;
}

// Create the lock with its content in one step: false when one exists.
function link(lockPath: string, content: string): boolean {
  const tmp = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, content, { flag: 'wx' });
  try {
    fs.linkSync(tmp, lockPath);
    return true;
  } catch (e) {
    if (errCode(e) === 'EEXIST') return false;
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Claim `file` for this process, or report who holds it. Throws only on an unexpected filesystem error. */
export function tryLockFile(file: string, options: FileLockOptions = {}): FileLockResult {
  const lockPath = lockFileFor(file);
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname ?? os.hostname();
  const isAlive = options.isAlive ?? processAlive;
  const token = randomUUID();
  const content: LockContent = { format: FILE_LOCK_FORMAT, pid, hostname, token, at: Date.now() };
  const text = `${JSON.stringify(content)}\n`;

  const acquired = (): FileLockResult => {
    let released = false;
    return {
      ok: true,
      lock: {
        path: lockPath,
        release() {
          if (released) return;
          released = true;
          // Only our own lock: one taken over after we lost it stays.
          let current: LockContent | null | 'missing';
          try {
            current = readLock(lockPath);
          } catch {
            return;
          }
          if (current !== 'missing' && current !== null && current.token === token) {
            try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
          }
        },
      },
    };
  };

  // Two tries: the second only after removing a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (link(lockPath, text)) return acquired();
    const held = readLock(lockPath);
    if (held === 'missing') continue; // released between the link and the read
    const stale = held === null || (held.hostname === hostname && !isAlive(held.pid));
    if (!stale) {
      return {
        ok: false,
        holder: { pid: held.pid, hostname: held.hostname },
        detail: `another shim-mcp process (pid ${held.pid}${held.hostname === hostname ? '' : ` on ${held.hostname}`}) holds ${file}: end its session first`,
      };
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw e;
    }
  }
  const held = readLock(lockPath);
  const holder = held !== 'missing' && held !== null ? { pid: held.pid, hostname: held.hostname } : null;
  return { ok: false, holder, detail: `another process claimed ${file} at the same moment: try again` };
}
