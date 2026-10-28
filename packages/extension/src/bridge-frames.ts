// The messages between Shim for Chrome's bridge process and this worker
// (the mcp package's bridge-frames.ts, the half a worker needs: Chrome
// frames the port's messages itself): Chrome's native messaging framing on stdio, and the
// messages the two exchange over it. Pure: a harness drives it with buffers.
//
// Framing (Chrome's): each message is a 32-bit length in the host's native
// byte order, then that many bytes of UTF-8 JSON. Chrome caps a message
// from the host to the extension at 1 MB; the other direction is far larger.
// A request whose JSON would exceed CHUNK_BYTES travels as ordered chunks the
// worker reassembles by id, so a shim working copy (up to 8 MB) fits.
//
// Messages, host → extension:
//   { id, method, url, body? }            one request, whole
//   { id, chunk: n, of: total, part }     a request in pieces: `part` is a
//                                         slice of the JSON of the whole message
//   { id, abort: true }                   the client went away
// Messages, extension → host:
//   { id, status, body }                  the reply
//   { hello: true, version }              the worker's greeting on connect

export interface BridgeRequest {
  id: string;
  method: string;
  url: string;
  body?: unknown;
}

export interface BridgeReply {
  id: string;
  status: number;
  body: Record<string, unknown>;
}

export type HostToExtension =
  | BridgeRequest
  | { id: string; chunk: number; of: number; part: string }
  | { id: string; abort: true };

export type ExtensionToHost = BridgeReply | { hello: true; version: string };

/** Puts chunked requests back together, by id, as their last chunk arrives. */
export class RequestAssembler {
  private readonly parts = new Map<string, { of: number; got: Map<number, string> }>();

  /** Answers the whole request when `message` completes one (or is one), else null. */
  take(message: unknown): BridgeRequest | null {
    if (!isRecord(message) || typeof message.id !== 'string') return null;
    if (typeof message.method === 'string' && typeof message.url === 'string') {
      return { id: message.id, method: message.method, url: message.url, ...('body' in message ? { body: message.body } : {}) };
    }
    if (typeof message.chunk !== 'number' || typeof message.of !== 'number' || typeof message.part !== 'string') return null;
    const entry = this.parts.get(message.id) ?? { of: message.of, got: new Map<number, string>() };
    if (entry.of !== message.of) return null;
    entry.got.set(message.chunk, message.part);
    this.parts.set(message.id, entry);
    if (entry.got.size < entry.of) return null;
    this.parts.delete(message.id);
    let json = '';
    for (let i = 0; i < entry.of; i++) json += entry.got.get(i) ?? '';
    try {
      const whole: unknown = JSON.parse(json);
      if (!isRecord(whole) || typeof whole.method !== 'string' || typeof whole.url !== 'string') return null;
      return { id: message.id, method: whole.method, url: whole.url, ...('body' in whole ? { body: whole.body } : {}) };
    } catch {
      return null;
    }
  }

  /** Forgets an id's chunks (the request was aborted before it completed). */
  drop(id: string): void {
    this.parts.delete(id);
  }
}

export function isAbort(message: unknown): message is { id: string; abort: true } {
  return isRecord(message) && typeof message.id === 'string' && message.abort === true;
}

export function isReply(message: unknown): message is BridgeReply {
  return isRecord(message) && typeof message.id === 'string' && typeof message.status === 'number' && isRecord(message.body);
}

export function isHello(message: unknown): message is { hello: true; version: string } {
  return isRecord(message) && message.hello === true && typeof message.version === 'string';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
