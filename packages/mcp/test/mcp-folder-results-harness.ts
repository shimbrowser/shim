// Harness for the MCP server's disk and result handling
// (packages/mcp/src/folder.ts, results.ts).
//
// folder: a read takes every non-hidden file, bounded; a checkout writes only
// into an empty folder or an earlier checkout, replaces shim.json and the
// handler files (removing ones the checkout dropped), leaves other files
// alone, and never writes outside the folder.
// results: Shim's tool_result content (string / Anthropic blocks) becomes MCP
// content; PNG and JPEG sizes are read from their headers; a result over
// the tool-result budget truncates text and swaps an image for a note.
//
//   node out/packages/mcp/test/mcp-folder-results-harness.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readWorkingCopy, writeCheckout, FolderError } from '../src/folder';
import { toMcpContent, imageSize, estimateTokens, fitToBudget, maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS } from '../src/results';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

function throwsCode(label: string, code: string, fn: () => unknown): void {
  try {
    fn();
    check(label, false, 'did not throw');
  } catch (e) {
    check(label, e instanceof FolderError && e.code === code, e instanceof Error ? e.message : String(e));
  }
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shim-folder-'));
}

console.log('read:');
{
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'handlers'));
  fs.writeFileSync(path.join(dir, 'shim.json'), '{}');
  fs.writeFileSync(path.join(dir, 'handlers', 'a.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(dir, '.shim-state.json'), '{}');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'config'), 'x');
  fs.writeFileSync(path.join(dir, 'handlers', '.a.js.swp'), 'x');
  fs.symlinkSync(path.join(dir, 'shim.json'), path.join(dir, 'link.json'));
  const folder = readWorkingCopy(dir);
  check('every non-hidden regular file, forward-slashed', JSON.stringify(Object.keys(folder).sort()) === JSON.stringify(['handlers/a.js', 'shim.json']), Object.keys(folder).join(','));
  check('contents are the file bytes', new TextDecoder().decode(folder['handlers/a.js'] as Uint8Array) === 'module.exports = 1;');
  throwsCode('too many files', 'folder-too-large', () => readWorkingCopy(dir, { maxFiles: 1, maxBytes: 1000 }));
  throwsCode('too many bytes', 'folder-too-large', () => readWorkingCopy(dir, { maxFiles: 10, maxBytes: 5 }));
  throwsCode('a missing folder', 'folder-missing', () => readWorkingCopy(path.join(dir, 'nope')));
  throwsCode('a file, not a folder', 'folder-missing', () => readWorkingCopy(path.join(dir, 'shim.json')));
}

console.log('checkout:');
{
  const root = tmp();
  const fresh = path.join(root, 'new', 'deep');
  const w = writeCheckout(fresh, { 'shim.json': '{"a":1}', 'handlers/x.js': 'x', 'handlers/y.js': 'y' });
  check('creates a missing folder and writes every file', w.written.length === 3 && fs.readFileSync(path.join(fresh, 'handlers', 'y.js'), 'utf8') === 'y');
  fs.writeFileSync(path.join(fresh, 'notes.md'), 'mine');
  fs.writeFileSync(path.join(fresh, 'handlers', 'README'), 'mine');
  const again = writeCheckout(fresh, { 'shim.json': '{"a":2}', 'handlers/x.js': 'x2' });
  check('an earlier checkout is replaced', fs.readFileSync(path.join(fresh, 'shim.json'), 'utf8') === '{"a":2}' && fs.readFileSync(path.join(fresh, 'handlers', 'x.js'), 'utf8') === 'x2');
  check('a handler the checkout dropped is removed', !fs.existsSync(path.join(fresh, 'handlers', 'y.js')) && JSON.stringify(again.removed) === JSON.stringify(['handlers/y.js']));
  check('other files are left alone', fs.existsSync(path.join(fresh, 'notes.md')) && fs.existsSync(path.join(fresh, 'handlers', 'README')));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  throwsCode('a non-empty folder without shim.json is refused', 'not-a-working-copy', () => writeCheckout(project, { 'shim.json': '{}' }));
  check('…and nothing was written into it', !fs.existsSync(path.join(project, 'shim.json')));
  const hiddenOnly = path.join(root, 'hidden-only');
  fs.mkdirSync(hiddenOnly);
  fs.writeFileSync(path.join(hiddenOnly, '.DS_Store'), '');
  check('a folder holding only hidden files counts as empty', writeCheckout(hiddenOnly, { 'shim.json': '{}' }).written.length === 1);
  const safe = path.join(root, 'safe');
  throwsCode('a path leaving the folder is refused', 'unsafe-path', () => writeCheckout(safe, { 'shim.json': '{}', '../escape.js': 'x' }));
  check('…before anything was written', !fs.existsSync(safe) && !fs.existsSync(path.join(root, 'escape.js')));
  throwsCode('a file where the folder should be', 'not-a-working-copy', () => writeCheckout(path.join(project, 'package.json'), { 'shim.json': '{}' }));
}

console.log('content:');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
check('a string is one text block', JSON.stringify(toMcpContent('{"a":1}')) === JSON.stringify([{ type: 'text', text: '{"a":1}' }]));
const blocks = toMcpContent([{ type: 'text', text: 'cap' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } }, { type: 'weird' }]);
check('Anthropic blocks become MCP blocks', JSON.stringify(blocks) === JSON.stringify([{ type: 'text', text: 'cap' }, { type: 'image', data: 'AAA', mimeType: 'image/jpeg' }]));
check('an object is JSON text', toMcpContent({ x: 1 })[0]?.type === 'text');
check('nothing usable is a placeholder', toMcpContent([])[0]?.type === 'text');

// A synthetic PNG header for 1280×800 and a JPEG with an APP0 then SOF0 at 640×480.
function pngHeader(w: number, h: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString('base64');
}
function jpegHeader(w: number, h: number): string {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03, ...Buffer.alloc(9)]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]).toString('base64');
}
check('PNG size from the header', JSON.stringify(imageSize(pngHeader(1280, 800))) === JSON.stringify({ width: 1280, height: 800 }));
check('a real 1×1 PNG', JSON.stringify(imageSize(PNG)) === JSON.stringify({ width: 1, height: 1 }));
check('JPEG size from the SOF segment', JSON.stringify(imageSize(jpegHeader(640, 480))) === JSON.stringify({ width: 640, height: 480 }));
check('unknown bytes have no size', imageSize(Buffer.from('hello world').toString('base64')) === null);
check('a 1280×800 shot is ~1366 tokens', estimateTokens({ type: 'image', data: pngHeader(1280, 800), mimeType: 'image/png' }) === 1366);

console.log('budget:');
const big = { type: 'image' as const, data: pngHeader(6000, 6000), mimeType: 'image/png' };
const small = { type: 'image' as const, data: pngHeader(1280, 800), mimeType: 'image/png' };
const fitted = fitToBudget([{ type: 'text', text: 'caption' }, small], 25_000);
check('within budget, nothing changes', fitted.length === 2 && fitted[1] === small);
const over = fitToBudget([{ type: 'text', text: 'caption' }, big], 25_000);
check('an image over budget becomes a note naming the fix', over.length === 2 && over[1]?.type === 'text'
  && /6000×6000[\s\S]*selector[\s\S]*MAX_MCP_OUTPUT_TOKENS/.test((over[1] as { text: string }).text));
const long = fitToBudget([{ type: 'text', text: 'x'.repeat(200_000) }], 25_000);
const kept = (long[0] as { text: string }).text;
check('long text is cut to the budget and says so', kept.length < 100_000 && /more characters cut/.test(kept));
check('MAX_MCP_OUTPUT_TOKENS sets the budget', maxOutputTokens({ MAX_MCP_OUTPUT_TOKENS: '50000' }) === 50_000);
check('a bad or missing value falls back', maxOutputTokens({ MAX_MCP_OUTPUT_TOKENS: 'lots' }) === DEFAULT_MAX_OUTPUT_TOKENS && maxOutputTokens({}) === DEFAULT_MAX_OUTPUT_TOKENS);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
