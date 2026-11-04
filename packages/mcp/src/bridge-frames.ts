// The bridge's half of the wire to Shim for Chrome's service worker:
// Chrome's native messaging framing on stdio, and the chunking of a request
// too large for one message. The messages themselves, and their reassembly
// on the worker's side, are core's (`@shimbrowser/core/bridge-frames`), which
// both ends share. Pure: a harness drives it with buffers.
//
// Framing (Chrome's): each message is a 32-bit length in the host's native
// byte order, then that many bytes of UTF-8 JSON. Chrome caps a message
// from the host to the extension at 1 MB; the other direction is far larger.
// A request whose JSON would exceed CHUNK_BYTES travels as ordered chunks the
// worker reassembles by id, so a shim working copy (up to 8 MB) fits.

import type { BridgeRequest, HostToExtension } from '@shimbrowser/core/bridge-frames';

export const CHUNK_BYTES = 512 * 1024;
export const MAX_HOST_MESSAGE_BYTES = 1024 * 1024;

/** One message as the bytes Chrome reads: native-endian length, then UTF-8 JSON. */
export function encodeFrame(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length, 0);
  return Buffer.concat([head, json]);
}

/**
 * Reads frames out of a byte stream as they complete. Feed it every chunk
 * stdin delivers; it answers the whole messages that became readable.
 */
export class FrameReader {
  private pending: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer): unknown[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: unknown[] = [];
    for (;;) {
      if (this.pending.length < 4) break;
      const length = this.pending.readUInt32LE(0);
      if (this.pending.length < 4 + length) break;
      const text = this.pending.subarray(4, 4 + length).toString('utf8');
      this.pending = this.pending.subarray(4 + length);
      out.push(JSON.parse(text));
    }
    return out;
  }
}

/** A request as the messages that carry it: itself when it fits, else ordered chunks of its JSON. */
export function chunkRequest(request: BridgeRequest, chunkBytes: number = CHUNK_BYTES): HostToExtension[] {
  const json = JSON.stringify(request);
  if (Buffer.byteLength(json, 'utf8') <= chunkBytes) return [request];
  // Slice by code units, so a surrogate pair is never split: each part is
  // valid UTF-16 and re-joins to the same string.
  const parts: string[] = [];
  let at = 0;
  while (at < json.length) {
    let end = Math.min(json.length, at + Math.floor(chunkBytes / 4));
    if (end < json.length && json.charCodeAt(end - 1) >= 0xd800 && json.charCodeAt(end - 1) <= 0xdbff) end -= 1;
    parts.push(json.slice(at, end));
    at = end;
  }
  return parts.map((part, i) => ({ id: request.id, chunk: i, of: parts.length, part }));
}
