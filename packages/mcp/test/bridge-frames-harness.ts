// bridge-frames-harness — the stdio framing between Shim for Chrome's
// bridge and the extension (packages/mcp/src/bridge-frames.ts): frames
// encode and read back across split and joined chunks, a request above the
// chunk size travels as ordered pieces and reassembles, pieces out of order
// or for a different total are handled, surrogate pairs survive the split,
// an aborted id is dropped, and the message guards hold.
//
//   node out/packages/mcp/test/bridge-frames-harness.js

import { encodeFrame, FrameReader, chunkRequest, RequestAssembler, isAbort, isReply, isHello, type BridgeRequest } from '../src/bridge-frames';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

{
  const a = encodeFrame({ id: '1', method: 'GET', url: '/status' });
  const b = encodeFrame({ id: '2', status: 200, body: { ok: true, ünïcödé: '✓' } });
  check('a frame is a 4-byte little-endian length and the JSON', a.readUInt32LE(0) === a.length - 4 && a.subarray(4).toString('utf8') === '{"id":"1","method":"GET","url":"/status"}');
  const reader = new FrameReader();
  const joined = Buffer.concat([a, b]);
  const got: unknown[] = [];
  // Every split point: the reader must answer the same two messages.
  for (let cut = 0; cut <= joined.length; cut++) {
    const r = new FrameReader();
    const out = [...r.feed(joined.subarray(0, cut)), ...r.feed(joined.subarray(cut))];
    if (out.length !== 2) { failures++; console.error(`  ✗ split at ${cut} gave ${out.length} messages`); break; }
    if (cut === 0) got.push(...out);
  }
  check('two frames read back whole however the bytes arrive', got.length === 2 && JSON.stringify(got[1]) === '{"id":"2","status":200,"body":{"ok":true,"ünïcödé":"✓"}}', JSON.stringify(got));
  check('an incomplete frame waits', reader.feed(a.subarray(0, 5)).length === 0 && reader.feed(a.subarray(5)).length === 1);
}

{
  const small: BridgeRequest = { id: 'r1', method: 'POST', url: '/sessions', body: { kind: 'shim' } };
  check('a request that fits travels whole', chunkRequest(small, 1024).length === 1 && chunkRequest(small, 1024)[0] === small);
  const big: BridgeRequest = { id: 'r2', method: 'POST', url: '/sessions/x/preview', body: { text: 'é😀'.repeat(2000) } };
  const chunks = chunkRequest(big, 1000);
  check('a request above the chunk size travels in ordered pieces', chunks.length > 1 && chunks.every((c, i) => 'chunk' in c && c.chunk === i && c.of === chunks.length && c.id === 'r2'), String(chunks.length));
  check('each piece\'s JSON stays under the chunk size', chunks.every((c) => Buffer.byteLength(JSON.stringify(c), 'utf8') <= 1000 + 200));
  const asm = new RequestAssembler();
  const shuffled = [...chunks].reverse();
  let whole: BridgeRequest | null = null;
  for (const c of shuffled) {
    const out = asm.take(c);
    if (out) whole = out;
  }
  check('the pieces reassemble, in any order, to the request (surrogate pairs intact)', whole !== null && JSON.stringify(whole) === JSON.stringify(big));
  check('a whole request passes the assembler through', JSON.stringify(asm.take(small)) === JSON.stringify(small));
  const other = new RequestAssembler();
  const first = chunks[0];
  check('a piece for another total is ignored', first !== undefined && 'chunk' in first && other.take({ ...first, of: 99 }) === null && other.take(first) === null);
  other.drop('r2');
  const rest = chunks.slice(1);
  let done: BridgeRequest | null = null;
  for (const c of rest) { const out = other.take(c); if (out) done = out; }
  check('after a drop the remaining pieces do not complete the request', done === null);
  check('a message with no id is nothing', asm.take({ method: 'GET', url: '/' }) === null && asm.take('x') === null);
}

{
  check('isAbort', isAbort({ id: 'a', abort: true }) && !isAbort({ id: 'a' }) && !isAbort({ abort: true }));
  check('isReply', isReply({ id: 'a', status: 200, body: {} }) && !isReply({ id: 'a', status: '200', body: {} }) && !isReply({ id: 'a', status: 200, body: [] }));
  check('isHello', isHello({ hello: true, version: '0.7.0' }) && !isHello({ hello: true }));
}

if (failures) {
  console.error(`\nbridge-frames: ${failures} failed, ${passes} passed`);
  process.exit(1);
}
console.log(`bridge-frames: all ${passes} checks passed`);
