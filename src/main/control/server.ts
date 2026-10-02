// control/server.ts — the control endpoint's transport (design D6): an HTTP
// server on a Unix domain socket (a named pipe on Windows), gated by a
// bearer token, advertised by a 0600 discovery file. Electron-free (node's
// http, net, fs and crypto only), so control-endpoint-harness runs it for
// real on a temp socket.
//
// Why a socket and not loopback TCP: any web page can reach a loopback port
// with fetch(); none can reach a socket. Why a token as well: the socket's
// 0600 mode keeps other users out, the token keeps out anything of this
// user's that never read the discovery file.
//
// Invariants:
//   - The socket lives in a directory this user owns, mode 0700, and is
//     chmod'ed 0600 once bound; a pre-existing directory that is a symlink
//     or owned by someone else is refused, never adopted.
//   - Only a stale socket is ever unlinked before binding (the app holds
//     the single-instance lock, so a socket at our path is a crashed run's);
//     any other file there is an error.
//   - The discovery file is written 0600 to a fresh temp file and renamed
//     into place, so it never exists with a wider mode or half-written.
//     Stopping removes it only while it still names this run's token.
//   - Every request is authenticated before its body is read. The token is
//     compared in constant time.
//   - Bodies are capped (maxBodyBytes); a larger one answers 413.
//   - A request whose client goes away aborts its signal (the router
//     cancels a pending consent request with it).
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { routeControlRequest, errorResponse, type ControlDeps, type ControlResponse } from './router';
import { isNamedPipe } from './paths';

// A composition working copy is up to 50MB of files (D10); JSON-encoded
// bytes need headroom on top.
export const MAX_BODY_BYTES = 96 * 1024 * 1024;

export const DISCOVERY_FORMAT = 'shim-control/1';

export interface DiscoveryInfo {
  format: typeof DISCOVERY_FORMAT;
  socketPath: string;
  token: string;
  pid: number;
  appVersion: string;
  startedAt: number;
}

export interface ControlServerOptions {
  socketPath: string;
  discoveryPath: string;
  token: string;
  pid: number;
  appVersion: string;
  deps: ControlDeps;
  maxBodyBytes?: number;
  now?(): number;
  onError?(label: string, err: unknown): void;
}

export interface ControlServer {
  socketPath: string;
  // Stops accepting connections, drops open ones, removes the socket and
  // the discovery file. Idempotent.
  close(): Promise<void>;
  // The same, synchronously — for app quit, where nothing can be awaited.
  closeSync(): void;
}

export function newControlToken(): string {
  return randomBytes(32).toString('base64url');
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

// `Authorization: Bearer <token>`, compared in constant time.
export function tokenMatches(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string' || token === '') return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m?.[1]) return false;
  return timingSafeEqual(digest(m[1]), digest(token));
}

// Creates `dir` 0700 if missing; refuses one that isn't a plain directory
// this user owns. Tightens its mode either way.
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`control endpoint: ${dir} is not a directory`);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && st.uid !== uid) throw new Error(`control endpoint: ${dir} is owned by another user`);
  fs.chmodSync(dir, 0o700);
}

function removeStaleSocket(socketPath: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(socketPath);
  } catch {
    return;
  }
  if (!st.isSocket()) throw new Error(`control endpoint: ${socketPath} exists and is not a socket`);
  fs.unlinkSync(socketPath);
}

export function writeDiscoveryFile(file: string, info: DiscoveryInfo): void {
  const tmp = `${file}.${info.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(info, null, 2) + '\n');
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

export function readDiscoveryFile(file: string): DiscoveryInfo | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    if (r.format !== DISCOVERY_FORMAT || typeof r.socketPath !== 'string' || typeof r.token !== 'string'
      || typeof r.pid !== 'number' || typeof r.appVersion !== 'string' || typeof r.startedAt !== 'number') return null;
    return { format: DISCOVERY_FORMAT, socketPath: r.socketPath, token: r.token, pid: r.pid, appVersion: r.appVersion, startedAt: r.startedAt };
  } catch {
    return null;
  }
}

// Removes the discovery file only while it is still this run's.
export function removeDiscoveryFile(file: string, token: string): void {
  const current = readDiscoveryFile(file);
  if (current === null || current.token !== token) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

function send(res: http.ServerResponse, out: ControlResponse): void {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(out.body);
  res.writeHead(out.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

type BodyResult = { ok: true; body: unknown } | { ok: false; response: ControlResponse };

function readBody(req: http.IncomingMessage, max: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
      resolve({ ok: false, response: errorResponse('payload-too-large') });
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: BodyResult): void => {
      if (done) return;
      done = true;
      resolve(r);
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        finish({ ok: false, response: errorResponse('payload-too-large') });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return finish({ ok: true, body: undefined });
      try {
        finish({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
      } catch {
        finish({ ok: false, response: errorResponse('invalid-json', 'the body is not valid JSON') });
      }
    });
    req.on('error', () => finish({ ok: false, response: errorResponse('invalid-request', 'the request body could not be read') }));
  });
}

export async function startControlServer(opts: ControlServerOptions): Promise<ControlServer> {
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const report = (label: string, err: unknown): void => {
    try { opts.onError?.(label, err); } catch { /* best effort */ }
  };
  const pipe = isNamedPipe(opts.socketPath);

  const server = http.createServer((req, res) => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    if (!tokenMatches(req.headers.authorization, opts.token)) {
      req.resume();
      send(res, errorResponse('unauthorized', 'a valid bearer token is required'));
      return;
    }
    void (async () => {
      const body = await readBody(req, maxBody);
      if (!body.ok) {
        send(res, body.response);
        return;
      }
      let out: ControlResponse;
      try {
        out = await routeControlRequest(opts.deps, {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          body: body.body,
          signal: controller.signal,
        });
      } catch (e) {
        report('control request', e);
        out = errorResponse('internal-error', e instanceof Error ? e.message : String(e));
      }
      send(res, out);
    })();
  });
  // Consent waits up to two minutes and a preview can take a while; the
  // request-receive bound stays (a slow sender is cut off), the response
  // side has none.
  server.requestTimeout = 5 * 60_000;

  if (!pipe) {
    ensurePrivateDir(path.dirname(opts.socketPath));
    removeStaleSocket(opts.socketPath);
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => reject(e);
    server.once('error', onError);
    server.listen(opts.socketPath, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  server.on('error', (e) => report('control server', e));

  let closed = false;
  const cleanupFiles = (): void => {
    if (!pipe) {
      try {
        const st = fs.lstatSync(opts.socketPath);
        if (st.isSocket()) fs.unlinkSync(opts.socketPath);
      } catch { /* already gone */ }
    }
    removeDiscoveryFile(opts.discoveryPath, opts.token);
  };

  try {
    if (!pipe) fs.chmodSync(opts.socketPath, 0o600);
    writeDiscoveryFile(opts.discoveryPath, {
      format: DISCOVERY_FORMAT,
      socketPath: opts.socketPath,
      token: opts.token,
      pid: opts.pid,
      appVersion: opts.appVersion,
      startedAt: (opts.now ?? Date.now)(),
    });
  } catch (e) {
    server.close();
    cleanupFiles();
    throw e;
  }

  return {
    socketPath: opts.socketPath,
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      // Files first: once close() is called no new agent can find us.
      cleanupFiles();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
    closeSync() {
      if (closed) return;
      closed = true;
      cleanupFiles();
      server.close();
      server.closeAllConnections();
    },
  };
}
