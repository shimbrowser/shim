// How the MCP server reaches Shim (shim-core design D6): the discovery file
// `<userData>/control.json` names a Unix socket (a named pipe on Windows) and
// a bearer token; every request is HTTP over that socket. Nothing here
// listens, and nothing here is reachable from a web page.
//
// Where userData is: Electron names it after the app — package.json's
// `productName` when there is one (`Shim`), before `name` (`shim`). Both are
// final, so it is fixed per platform; the case matters on Linux
// (~/.config/Shim). SHIM_CONTROL_FILE (the discovery file itself) or
// SHIM_USER_DATA (the folder) override it, for a dev profile or a harness.

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

export const DISCOVERY_FORMAT = 'shim-control/1';
export const DISCOVERY_FILE = 'control.json';
// Electron's app.getPath('userData') folder name: package.json's
// `productName` (mcp-launch-harness pins it to the app's package.json).
export const APP_DIR_NAME = 'Shim';

export interface ControlInfo {
  socketPath: string;
  token: string;
  pid: number;
  appVersion: string;
  startedAt: number;
}

export interface PathEnv {
  platform: string;
  env: Record<string, string | undefined>;
  homedir: string;
}

export function defaultEnv(): PathEnv {
  return { platform: process.platform, env: process.env, homedir: os.homedir() };
}

export function userDataDir(input: PathEnv): string {
  const override = input.env.SHIM_USER_DATA;
  if (override) return override;
  if (input.platform === 'darwin') return path.join(input.homedir, 'Library', 'Application Support', APP_DIR_NAME);
  if (input.platform === 'win32') {
    return path.join(input.env.APPDATA || path.join(input.homedir, 'AppData', 'Roaming'), APP_DIR_NAME);
  }
  return path.join(input.env.XDG_CONFIG_HOME || path.join(input.homedir, '.config'), APP_DIR_NAME);
}

export function discoveryFilePath(input: PathEnv): string {
  return input.env.SHIM_CONTROL_FILE || path.join(userDataDir(input), DISCOVERY_FILE);
}

/** The discovery file's contents, or null when it is missing or not ours. */
export function readControlInfo(file: string): ControlInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  if (r.format !== DISCOVERY_FORMAT) return null;
  if (typeof r.socketPath !== 'string' || typeof r.token !== 'string' || typeof r.pid !== 'number') return null;
  return {
    socketPath: r.socketPath,
    token: r.token,
    pid: r.pid,
    appVersion: typeof r.appVersion === 'string' ? r.appVersion : 'unknown',
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
  };
}

export interface ControlReply {
  status: number;
  body: Record<string, unknown>;
}

export interface RequestOptions {
  // How long to wait for the whole reply. Opening a session pends on the
  // human's answer in Shim (up to two minutes), so the default is generous.
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ControlClient {
  info: ControlInfo;
  request(method: string, urlPath: string, body?: unknown, opts?: RequestOptions): Promise<ControlReply>;
}

/** A transport failure: Shim wasn't there, or the reply never came. */
export class ControlTransportError extends Error {
  readonly code: 'shim-not-running' | 'control-timeout' | 'control-failed';
  constructor(code: ControlTransportError['code'], message: string) {
    super(message);
    this.name = 'ControlTransportError';
    this.code = code;
  }
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000;

export function socketClient(info: ControlInfo): ControlClient {
  return {
    info,
    request(method, urlPath, body, opts = {}) {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { authorization: `Bearer ${info.token}` };
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(payload));
      }
      return new Promise<ControlReply>((resolve, reject) => {
        const req = http.request({ socketPath: info.socketPath, method, path: urlPath, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            clearTimeout(timer);
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = { ok: false, error: 'invalid-reply', detail: text.slice(0, 200) };
            }
            const replyBody = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
              ? parsed as Record<string, unknown>
              : { ok: false, error: 'invalid-reply' };
            resolve({ status: res.statusCode ?? 0, body: replyBody });
          });
          res.on('error', (e) => {
            clearTimeout(timer);
            reject(new ControlTransportError('control-failed', e.message));
          });
        });
        const timer = setTimeout(() => {
          req.destroy();
          reject(new ControlTransportError('control-timeout', 'Shim did not answer in time'));
        }, opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
        const onAbort = (): void => {
          clearTimeout(timer);
          req.destroy();
          reject(new ControlTransportError('control-failed', 'the request was cancelled'));
        };
        if (opts.signal) {
          if (opts.signal.aborted) {
            onAbort();
            return;
          }
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
        req.on('error', (e: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          const gone = e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'EPIPE';
          reject(new ControlTransportError(gone ? 'shim-not-running' : 'control-failed', e.message));
        });
        if (payload !== undefined) req.write(payload);
        req.end();
      });
    },
  };
}
