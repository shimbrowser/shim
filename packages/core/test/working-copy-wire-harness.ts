// Harness for the working copy's wire encoding (packages/core/src/
// working-copy-wire.ts): text and binary files round
// trip byte for byte, the encoding is deterministic, and a hostile or
// malformed envelope is refused with every problem named — no path can
// leave the folder it describes.
//
//   node out/packages/core/test/working-copy-wire-harness.js
//
// Bare node.

import {
  encodeWorkingCopy, decodeWorkingCopy, workingCopyPathProblem, WorkingCopyWireError, WORKING_COPY_FORMAT,
} from '../src/working-copy-wire';
import type { FolderInput } from '../src/shim-folder';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

function refuses(label: string, body: unknown, mentions: string, limits?: { maxFiles: number; maxBytes: number }): void {
  try {
    decodeWorkingCopy(body, limits);
    check(label, false, 'did not throw');
  } catch (err) {
    const ok = err instanceof WorkingCopyWireError && err.problems.some((p) => p.includes(mentions));
    check(label, ok, err instanceof Error ? err.message : String(err));
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

console.log('round trip:');
const binary = new Uint8Array(70_000);
for (let i = 0; i < binary.length; i += 1) binary[i] = (i * 31 + 7) & 0xff;
const folder: FolderInput = {
  'shim.json': '{\n  "id": "x"\n}\n',
  'handlers/notes.js': 'module.exports = function notes() { return "é ✓"; };\n',
  'logo.png': binary,
  'utf8-bytes.txt': new TextEncoder().encode('plain ascii in bytes'),
};
const wire = encodeWorkingCopy(folder);
check('the format is stamped', wire.format === WORKING_COPY_FORMAT);
check('paths are sorted', JSON.stringify(wire.files.map((f) => f.path)) === JSON.stringify(Object.keys(folder).sort()));
check('text travels as text', wire.files.find((f) => f.path === 'shim.json')?.text === folder['shim.json']);
check('UTF-8 bytes travel as text', wire.files.find((f) => f.path === 'utf8-bytes.txt')?.text === 'plain ascii in bytes');
check('non-UTF-8 bytes travel as base64', typeof wire.files.find((f) => f.path === 'logo.png')?.base64 === 'string');
const back = decodeWorkingCopy(JSON.parse(JSON.stringify(wire)), { maxFiles: 10, maxBytes: 1_000_000 });
check('text round-trips', back['handlers/notes.js'] === folder['handlers/notes.js']);
const png = back['logo.png'];
check('bytes round-trip exactly', png instanceof Uint8Array && sameBytes(png, binary));
check('encoding is deterministic', JSON.stringify(encodeWorkingCopy(folder)) === JSON.stringify(wire));
{
  // A leading UTF-8 byte-order mark is part of the file: it must survive
  // the trip, for text and for a binary-typed asset that happens to be UTF-8.
  const bomText = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63]);
  const bomBlob = new Uint8Array([0xef, 0xbb, 0xbf, 0x00, 0x01, 0x7f]);
  const bomWire = encodeWorkingCopy({ 'bom.txt': bomText, 'bom.bin': bomBlob, 'bom-string.txt': '\ufeffhi' });
  const bomBack = decodeWorkingCopy(JSON.parse(JSON.stringify(bomWire)));
  const asBytes = (v: string | Uint8Array | undefined): Uint8Array => (typeof v === 'string' ? new TextEncoder().encode(v) : v ?? new Uint8Array());
  check('a BOM-prefixed text file round-trips byte for byte', sameBytes(asBytes(bomBack['bom.txt']), bomText), JSON.stringify(bomWire.files));
  check('…and a BOM-prefixed binary one', sameBytes(asBytes(bomBack['bom.bin']), bomBlob));
  check('…and text that starts with U+FEFF keeps it', bomBack['bom-string.txt'] === '\ufeffhi');
}
check('an empty folder encodes', encodeWorkingCopy({}).files.length === 0 && Object.keys(decodeWorkingCopy(encodeWorkingCopy({}))).length === 0);

console.log('paths:');
for (const bad of ['', '/etc/passwd', 'C:/x', '..', '../x', 'a/../b', 'a//b', './a', 'a/.', 'a\\b', 'a\0b', '__proto__', 'x/__proto__/y', 'a'.repeat(1025)]) {
  check(`refuses ${JSON.stringify(bad.length > 40 ? bad.slice(0, 20) + '…' : bad)}`, workingCopyPathProblem(bad) !== null);
}
for (const good of ['shim.json', 'handlers/notes.js', '.shim-state.json', 'a/b/c.txt', 'name with spaces.js', `${'d/'.repeat(200)}${'a'.repeat(620)}`]) {
  check(`accepts ${JSON.stringify(good)}`, workingCopyPathProblem(good) === null);
}

console.log('malformed envelopes:');
refuses('not an object', 'files', 'JSON object');
refuses('wrong format', { format: 'other', files: [] }, 'format must be');
refuses('files not an array', { format: WORKING_COPY_FORMAT, files: {} }, 'files must be an array');
refuses('a traversal path', { format: WORKING_COPY_FORMAT, files: [{ path: '../evil', text: 'x' }] }, '".." segment');
refuses('a duplicate path', { format: WORKING_COPY_FORMAT, files: [{ path: 'a', text: '1' }, { path: 'a', text: '2' }] }, 'appears twice');
refuses('both text and base64', { format: WORKING_COPY_FORMAT, files: [{ path: 'a', text: '1', base64: 'MQ==' }] }, 'exactly one');
refuses('neither text nor base64', { format: WORKING_COPY_FORMAT, files: [{ path: 'a' }] }, 'exactly one');
refuses('bad base64', { format: WORKING_COPY_FORMAT, files: [{ path: 'a', base64: '!!!' }] }, 'not valid base64');
refuses('too many files', { format: WORKING_COPY_FORMAT, files: [{ path: 'a', text: '' }, { path: 'b', text: '' }] }, 'more than the 1', { maxFiles: 1, maxBytes: 10 });
refuses('too many bytes', { format: WORKING_COPY_FORMAT, files: [{ path: 'a', text: 'x'.repeat(11) }] }, 'larger than 10', { maxFiles: 5, maxBytes: 10 });
try {
  decodeWorkingCopy({ format: WORKING_COPY_FORMAT, files: [{ path: '../a', text: '' }, { path: '/b', text: '' }, 7] });
  check('every problem is named at once', false, 'did not throw');
} catch (err) {
  check('every problem is named at once', err instanceof WorkingCopyWireError && err.problems.length === 3, String(err));
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
