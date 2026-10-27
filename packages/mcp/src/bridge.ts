// `shim bridge`: the process Chrome starts when Shim for Chrome connects its
// native messaging port, and the way an MCP client reaches the extension.
// It is a relay: an HTTP request on its socket (bridge-server.ts, the
// control endpoint's transport) becomes one message to the extension on
// stdout, the extension's reply on stdin becomes the HTTP response. The
// routes and their answers are the extension's; nothing here reads a body.
//
//   - One bridge owns the endpoint: before it listens it takes
//     `<userData>/bridge/owner` (file-lock.ts: atomic, a dead holder taken
//     over under a mutex, released only by its own token). A second bridge
//     (another browser, another profile) exits with a message on stderr.
//   - Lifetime is the port's: when Chrome closes it (the extension's setting
//     turned off, the worker gone), stdin ends; every pending request is
//     answered, the socket and the discovery file are removed while the
//     file still names this run's token, the lock is dropped, and the
//     process exits.
//   - stdout carries frames only; everything else goes to stderr.
//   - A client that goes away sends the extension an abort for its request.

import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Readable, Writable } from 'stream';
import { userDataDir, chromeDiscoveryFilePath, defaultEnv, type PathEnv } from './control-client';
import { startBridgeServer, bridgeSocketPath, newBridgeToken, ensurePrivateDir, type BridgeResponse } from './bridge-server';
import { encodeFrame, FrameReader, chunkRequest, isReply, isHello, type BridgeRequest } from './bridge-frames';
import { tryLockFile, type FileLock } from './file-lock';
import { VERSION } from './version';

export const OWNER_LOCK_NAME = 'owner';

export interface BridgeOptions {
  /** The extension's messages arrive here (Chrome's end of the port). */
  stdin: Readable;
  /** Messages to the extension go here. */
  stdout: Writable;
  log(line: string): void;
  userData: string;
  socketPath: string;
  discoveryPath: string;
  pid?: number;
  appVersion?: string;
  chunkBytes?: number;
}

export interface Bridge {
  socketPath: string;
  /** Resolves once the port is closed and everything is cleaned up. */
  closed: Promise<void>;
  /** Close from this side (a signal). */
  close(): Promise<void>;
}

export type BridgeStart = { ok: true; bridge: Bridge } | { ok: false; error: 'bridge-busy' | 'bridge-failed'; detail: string };

export async function startBridge(opts: BridgeOptions): Promise<BridgeStart> {
  const pid = opts.pid ?? process.pid;
  const bridgeDir = path.dirname(opts.socketPath);
  let lock: FileLock;
  try {
    ensurePrivateDir(bridgeDir);
    const taken = tryLockFile(path.join(bridgeDir, OWNER_LOCK_NAME), { pid });
    if (!taken.ok) return { ok: false, error: 'bridge-busy', detail: `another browser holds the bridge: ${taken.detail}` };
    lock = taken.lock;
  } catch (e) {
    return { ok: false, error: 'bridge-failed', detail: e instanceof Error ? e.message : String(e) };
  }

  const pending = new Map<string, { resolve(out: BridgeResponse): void }>();
  const reader = new FrameReader();
  let ended = false;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const write = (message: unknown): void => {
    if (ended) return;
    try {
      opts.stdout.write(encodeFrame(message));
    } catch (e) {
      opts.log(`[shim bridge] write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const token = newBridgeToken();
  let server: Awaited<ReturnType<typeof startBridgeServer>>;
  try {
    server = await startBridgeServer({
      socketPath: opts.socketPath,
      discoveryPath: opts.discoveryPath,
      token,
      pid,
      appVersion: opts.appVersion ?? VERSION,
      onError: (label, err) => opts.log(`[shim bridge] ${label}: ${err instanceof Error ? err.message : String(err)}`),
      handle(req) {
        if (ended) return Promise.resolve({ status: 503, body: { ok: false, error: 'bridge-closing', detail: 'the bridge is shutting down' } });
        const id = randomUUID();
        const request: BridgeRequest = { id, method: req.method, url: req.url, ...(req.body !== undefined ? { body: req.body } : {}) };
        return new Promise<BridgeResponse>((resolve) => {
          pending.set(id, { resolve });
          for (const message of chunkRequest(request, opts.chunkBytes)) write(message);
          req.signal.addEventListener('abort', () => {
            if (!pending.has(id)) return;
            pending.delete(id);
            write({ id, abort: true });
            resolve({ status: 499, body: { ok: false, error: 'client-gone', detail: 'the client went away' } });
          }, { once: true });
        });
      },
    });
  } catch (e) {
    lock.release();
    return { ok: false, error: 'bridge-failed', detail: e instanceof Error ? e.message : String(e) };
  }

  const finish = async (): Promise<void> => {
    if (ended) return;
    ended = true;
    for (const [id, p] of [...pending]) {
      pending.delete(id);
      p.resolve({ status: 503, body: { ok: false, error: 'bridge-closing', detail: 'the extension closed the bridge' } });
    }
    // Let those answers be written before the server closes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await server.close();
    lock.release();
    resolveClosed();
  };

  opts.stdin.on('data', (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = reader.feed(chunk);
    } catch (e) {
      opts.log(`[shim bridge] bad frame: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const message of messages) {
      if (isHello(message)) {
        opts.log(`[shim bridge] connected to Shim for Chrome ${message.version}`);
        continue;
      }
      if (!isReply(message)) continue;
      const p = pending.get(message.id);
      if (!p) continue;
      pending.delete(message.id);
      p.resolve({ status: message.status, body: message.body });
    }
  });
  opts.stdin.on('end', () => { void finish(); });
  opts.stdin.on('error', () => { void finish(); });

  opts.log(`[shim bridge] listening on ${opts.socketPath}`);
  return { ok: true, bridge: { socketPath: opts.socketPath, closed, close: finish } };
}

/** Where this user's bridge lives: the socket, the discovery file and the owner lock, under the Shim user data directory. */
export function bridgePaths(pathEnv: PathEnv): { userData: string; socketPath: string; discoveryPath: string } {
  const userData = userDataDir(pathEnv);
  return {
    userData,
    socketPath: bridgeSocketPath({ platform: pathEnv.platform, userData, tmpdir: os.tmpdir(), uid: process.getuid?.() ?? null }),
    discoveryPath: chromeDiscoveryFilePath(pathEnv),
  };
}

/** `shim bridge`, as Chrome runs it: stdio is the port; exits when the port closes. */
export async function runBridge(pathEnv: PathEnv = defaultEnv()): Promise<number> {
  const paths = bridgePaths(pathEnv);
  const started = await startBridge({
    stdin: process.stdin,
    stdout: process.stdout,
    log: (line) => process.stderr.write(`${line}\n`),
    ...paths,
  });
  if (!started.ok) {
    process.stderr.write(`[shim bridge] ${started.error}: ${started.detail}\n`);
    return started.error === 'bridge-busy' ? 3 : 1;
  }
  const stop = (): void => { void started.bridge.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await started.bridge.closed;
  return 0;
}
