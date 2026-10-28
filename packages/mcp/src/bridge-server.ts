// The bridge's socket: an HTTP server on a Unix domain socket (a named pipe
// on Windows), gated by a bearer token and advertised by a 0600 discovery
// file. The same transport the Shim browser's control endpoint uses, with
// the same rules, so an MCP client reaches either host the same way; what
// differs is what answers a request (`handle`), which here is the extension
// over stdio (bridge.ts).
//
// Why a socket and not loopback TCP: any web page can reach a loopback port
// with fetch(); none can reach a socket. Why a token as well: the socket's
// 0600 mode keeps other users out, the token keeps out anything of this
// user's that never read the discovery file.
//
//   - The socket lives in a directory this user owns, mode 0700, and is
//     chmod'ed 0600 once bound; a directory that is a symlink or owned by
//     someone else is refused, never adopted.
//   - Only a stale socket is unlinked before binding (the caller holds the
//     bridge's owner lock, so a socket at the path is a dead bridge's); any
//     other file there is an error.
//   - The discovery file is written 0600 to a fresh temp file and renamed
//     into place; stopping removes it only while it still names this run's
//     token.
//   - Every request is authenticated before its body is read; the token is
//     compared in constant time. Bodies are capped. A request whose client
//     goes away aborts its signal.

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'crypto';
import { DISCOVERY_FORMAT, CHROME_HOST } from './control-client';

// A shim working copy is up to 8 MB (SHIM_WIRE_LIMITS); JSON needs headroom.
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
// sun_path is 104 bytes on macOS, NUL included.
export const MAX_SOCKET_PATH_BYTES = 103;
export const BRIDGE_DIR = 'bridge';
// How long a response in flight gets to reach its client at close.
const CLOSE_GRACE_MS = 250;
export const SOCKET_NAME = 'chrome.sock';

export interface BridgeResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface BridgeServerRequest {
  method: string;
  url: string;
  body: unknown;
  signal: AbortSignal;
}

export interface BridgeServerOptions {
  socketPath: string;
  discoveryPath: string;
  token: string;
  pid: number;
  appVersion: string;
  handle(req: BridgeServerRequest): Promise<BridgeResponse>;
  maxBodyBytes?: number;
  now?(): number;
  onError?(label: string, err: unknown): void;
}

export interface BridgeServer {
  socketPath: string;
  /** Stops accepting, drops open connections, removes the socket and the discovery file. Idempotent. */
  close(): Promise<void>;
}

export function newBridgeToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isNamedPipe(socketPath: string): boolean {
  return socketPath.startsWith('\\\\.\\pipe\\');
}

/** Where the bridge listens: `<userData>/bridge/chrome.sock`, or a per-user temp directory when that path is too long for a socket; a named pipe on Windows. */
export function bridgeSocketPath(input: { platform: string; userData: string; tmpdir: string; uid: number | null }): string {
  const hash = createHash('sha256').update(input.userData).digest('hex').slice(0, 12);
  if (input.platform === 'win32') return `\\\\.\\pipe\\shim-chrome-${hash}`;
  const preferred = path.join(input.userData, BRIDGE_DIR, SOCKET_NAME);
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
  const owner = input.uid === null ? 'user' : String(input.uid);
  return path.join(input.tmpdir, `shim-chrome-${owner}-${hash}`, SOCKET_NAME);
}

export function tokenMatches(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string' || token === '') return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m?.[1]) return false;
  const key = randomBytes(32);
  const digest = (s: string): Buffer => createHmac('sha256', key).update(s).digest();
  return timingSafeEqual(digest(m[1]), digest(token));
}

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`bridge: ${dir} is not a directory`);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && st.uid !== uid) throw new Error(`bridge: ${dir} is owned by another user`);
  fs.chmodSync(dir, 0o700);
}

function removeStaleSocket(socketPath: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(socketPath);
  } catch {
    return;
  }
  if (!st.isSocket()) throw new Error(`bridge: ${socketPath} exists and is not a socket`);
  fs.unlinkSync(socketPath);
}

export interface BridgeDiscovery {
  format: typeof DISCOVERY_FORMAT;
  host: typeof CHROME_HOST;
  socketPath: string;
  token: string;
  pid: number;
  appVersion: string;
  startedAt: number;
}

export function writeDiscoveryFile(file: string, info: BridgeDiscovery): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${info.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(info, null, 2)}\n`);
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

export function readDiscoveryFile(file: string): BridgeDiscovery | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    if (r.format !== DISCOVERY_FORMAT || r.host !== CHROME_HOST || typeof r.socketPath !== 'string' || typeof r.token !== 'string'
      || typeof r.pid !== 'number' || typeof r.appVersion !== 'string' || typeof r.startedAt !== 'number') return null;
    return { format: DISCOVERY_FORMAT, host: CHROME_HOST, socketPath: r.socketPath, token: r.token, pid: r.pid, appVersion: r.appVersion, startedAt: r.startedAt };
  } catch {
    return null;
  }
}

/** Removes the discovery file only while it is still this run's. */
export function removeDiscoveryFile(file: string, token: string): void {
  const current = readDiscoveryFile(file);
  if (current === null || current.token !== token) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

const STATUS_BY_ERROR: Record<string, number> = {
  'invalid-request': 400,
  'invalid-json': 400,
  unauthorized: 401,
  'payload-too-large': 413,
  'internal-error': 500,
};

export function errorResponse(error: string, detail?: string): BridgeResponse {
  return { status: STATUS_BY_ERROR[error] ?? 422, body: { ok: false, error, ...(detail !== undefined ? { detail } : {}) } };
}

function send(res: http.ServerResponse, out: BridgeResponse): void {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(out.body);
  res.writeHead(out.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

type BodyResult = { ok: true; body: unknown } | { ok: false; response: BridgeResponse };

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

export async function startBridgeServer(opts: BridgeServerOptions): Promise<BridgeServer> {
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
      let out: BridgeResponse;
      try {
        out = await opts.handle({ method: req.method ?? 'GET', url: req.url ?? '/', body: body.body, signal: controller.signal });
      } catch (e) {
        report('bridge request', e);
        out = errorResponse('internal-error', e instanceof Error ? e.message : String(e));
      }
      send(res, out);
    })();
  });
  // A consent waits up to two minutes and a preview can take a while: the
  // receive bound stays, the response side has none.
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
  server.on('error', (e) => report('bridge server', e));

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
      host: CHROME_HOST,
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
      cleanupFiles();
      return new Promise<void>((resolve) => {
        // Idle connections go now; one still carrying a response gets a
        // moment to deliver it before it is cut.
        server.closeIdleConnections();
        server.close(() => resolve());
        setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS).unref();
      });
    },
  };
}
