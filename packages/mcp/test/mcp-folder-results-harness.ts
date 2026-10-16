// Harness for the MCP server's disk and result handling
// (packages/mcp/src/folder.ts, results.ts).
//
// folder: a read takes every non-hidden file, bounded; a checkout writes only
// into an empty folder or an earlier checkout, replaces shim.json and the
// handler files (removing ones the checkout dropped), leaves other files
// alone, and never writes outside the folder; a composition re-checkout
// replaces a folder it emptied with the file now at that path, and refuses
// (changing nothing) when that folder holds hidden content no checkout
// wrote.
// results: Shim's tool_result content (string / Anthropic blocks) becomes MCP
// content; PNG and JPEG sizes are read from their headers; a result over
// the tool-result budget truncates text and swaps an image for a note.
//
//   node out/packages/mcp/test/mcp-folder-results-harness.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readWorkingCopy, writeCheckout, writeCompositionCheckout, checkoutKind, folderKind, COMPOSITION_MARKER, FolderError } from '../src/folder';
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
  // The folder format accepts a 252-character handler name: a 255-byte
  // `<name>.js`, the most a filesystem name may be. The temp file a write
  // goes through must not be any longer.
  const longName = 'h'.repeat(252);
  const longDir = path.join(root, 'long');
  let longErr = '';
  try { writeCheckout(longDir, { 'shim.json': '{}', [`handlers/${longName}.js`]: 'x' }); } catch (e) { longErr = String(e); }
  check('a maximum-length handler name checks out', longErr === '' && fs.readFileSync(path.join(longDir, 'handlers', `${longName}.js`), 'utf8') === 'x', longErr);
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

  // A target that is a hard link to a file outside the folder must lose only
  // its link: writing through it would truncate the shared inode.
  const hardOutside = path.join(root, 'hard-outside');
  fs.mkdirSync(hardOutside);
  fs.writeFileSync(path.join(hardOutside, 'spec.txt'), 'keep-spec');
  fs.writeFileSync(path.join(hardOutside, 'handler.txt'), 'keep-handler');
  const hardLinked = path.join(root, 'hard-linked');
  fs.mkdirSync(path.join(hardLinked, 'handlers'), { recursive: true });
  let canHardLink = true;
  try {
    fs.linkSync(path.join(hardOutside, 'spec.txt'), path.join(hardLinked, 'shim.json'));
    fs.linkSync(path.join(hardOutside, 'handler.txt'), path.join(hardLinked, 'handlers', 'x.js'));
  } catch {
    canHardLink = false;
    console.log('  - hard-link cases skipped: this system cannot create hard links');
  }
  if (canHardLink) {
    const hw = writeCheckout(hardLinked, { 'shim.json': '{"b":1}', 'handlers/x.js': 'x-new' });
    check('hard-linked targets are replaced in the folder', hw.written.length === 2
      && fs.readFileSync(path.join(hardLinked, 'shim.json'), 'utf8') === '{"b":1}'
      && fs.readFileSync(path.join(hardLinked, 'handlers', 'x.js'), 'utf8') === 'x-new');
    check('…and the files they were linked to outside are untouched',
      fs.readFileSync(path.join(hardOutside, 'spec.txt'), 'utf8') === 'keep-spec'
      && fs.readFileSync(path.join(hardOutside, 'handler.txt'), 'utf8') === 'keep-handler');
    check('…with no temp files left behind', fs.readdirSync(hardLinked).every((n) => !n.endsWith('.tmp'))
      && fs.readdirSync(path.join(hardLinked, 'handlers')).every((n) => !n.endsWith('.tmp')));

    // A composition checkout replaces its files and its marker the same way.
    const markerJson = JSON.stringify({ format: 'shim-composition-checkout/1', hidden: [] });
    fs.writeFileSync(path.join(hardOutside, 'page.txt'), 'keep-page');
    fs.writeFileSync(path.join(hardOutside, 'marker.txt'), markerJson);
    const compHard = path.join(root, 'comp-hard-linked');
    fs.mkdirSync(compHard);
    fs.linkSync(path.join(hardOutside, 'page.txt'), path.join(compHard, 'index.html'));
    fs.linkSync(path.join(hardOutside, 'marker.txt'), path.join(compHard, COMPOSITION_MARKER));
    const cw = writeCompositionCheckout(compHard, { 'manifest.json': '{"c":1}', 'index.html': 'page-new' });
    check('a composition checkout replaces hard-linked files in the folder', cw.written.length === 2
      && fs.readFileSync(path.join(compHard, 'index.html'), 'utf8') === 'page-new'
      && JSON.parse(fs.readFileSync(path.join(compHard, COMPOSITION_MARKER), 'utf8')).format === 'shim-composition-checkout/1');
    check('…leaving the files and marker they were linked to outside untouched',
      fs.readFileSync(path.join(hardOutside, 'page.txt'), 'utf8') === 'keep-page'
      && fs.readFileSync(path.join(hardOutside, 'marker.txt'), 'utf8') === markerJson);
    check('…with no temp files left behind', fs.readdirSync(compHard).every((n) => !n.endsWith('.tmp')));
  }

  // Symlinks in a crafted or stale folder must not carry a write or a removal
  // outside it. (Windows without Developer Mode can't create symlinks: skip.)
  let canLink = true;
  try {
    fs.symlinkSync(root, path.join(root, 'probe-link'));
  } catch {
    canLink = false;
    console.log('  - symlink cases skipped: this system cannot create symlinks');
  }
  if (canLink) {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'victim.txt'), 'keep');
    fs.writeFileSync(path.join(outside, 'old.js'), 'keep');
    const linkedSpec = path.join(root, 'linked-spec');
    fs.mkdirSync(linkedSpec);
    fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(linkedSpec, 'shim.json'));
    throwsCode('a shim.json that is a symlink is refused', 'unsafe-path', () => writeCheckout(linkedSpec, { 'shim.json': '{}' }));
    check('…and its target is untouched', fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8') === 'keep');
    const linkedHandlers = path.join(root, 'linked-handlers');
    fs.mkdirSync(linkedHandlers);
    fs.writeFileSync(path.join(linkedHandlers, 'shim.json'), '{}');
    fs.symlinkSync(outside, path.join(linkedHandlers, 'handlers'));
    throwsCode('a handlers folder that is a symlink is refused', 'unsafe-path', () => writeCheckout(linkedHandlers, { 'shim.json': '{}', 'handlers/x.js': 'x' }));
    check('…and nothing outside was written or removed', fs.existsSync(path.join(outside, 'old.js')) && !fs.existsSync(path.join(outside, 'x.js')));
    throwsCode('…even when the checkout writes no handler', 'unsafe-path', () => writeCheckout(linkedHandlers, { 'shim.json': '{}' }));
    check('…which would have removed old.js through the link', fs.existsSync(path.join(outside, 'old.js')));
    const linkedHandler = path.join(root, 'linked-handler');
    fs.mkdirSync(path.join(linkedHandler, 'handlers'), { recursive: true });
    fs.writeFileSync(path.join(linkedHandler, 'shim.json'), '{}');
    fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(linkedHandler, 'handlers', 'x.js'));
    throwsCode('a handler file that is a symlink is refused', 'unsafe-path', () => writeCheckout(linkedHandler, { 'shim.json': '{}', 'handlers/x.js': 'x' }));
    check('…and its target is untouched', fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8') === 'keep');
    const realRoot = path.join(root, 'real-root');
    fs.mkdirSync(realRoot);
    const viaLink = path.join(root, 'via-link');
    fs.symlinkSync(realRoot, viaLink);
    check('the root itself may be a symlink (like /tmp on macOS)', writeCheckout(viaLink, { 'shim.json': '{}' }).written.length === 1 && fs.existsSync(path.join(realRoot, 'shim.json')));

    // A composition checkout is held to the same rule.
    const linkedFile = path.join(root, 'comp-linked-file');
    fs.mkdirSync(linkedFile);
    fs.writeFileSync(path.join(linkedFile, COMPOSITION_MARKER), JSON.stringify({ format: 'shim-composition-checkout/1', hidden: [] }));
    fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(linkedFile, 'index.html'));
    throwsCode('a composition file that is a symlink is refused', 'unsafe-path', () => writeCompositionCheckout(linkedFile, { 'manifest.json': '{}', 'index.html': 'x' }));
    check('…before anything was written', !fs.existsSync(path.join(linkedFile, 'manifest.json')) && fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8') === 'keep');
    const linkedDir = path.join(root, 'comp-linked-dir');
    fs.mkdirSync(linkedDir);
    fs.writeFileSync(path.join(linkedDir, COMPOSITION_MARKER), JSON.stringify({ format: 'shim-composition-checkout/1', hidden: [] }));
    fs.symlinkSync(outside, path.join(linkedDir, 'assets'));
    throwsCode('a composition folder that is a symlink is refused', 'unsafe-path', () => writeCompositionCheckout(linkedDir, { 'manifest.json': '{}', 'assets/old.js': 'x' }));
    check('…and its target is untouched', fs.readFileSync(path.join(outside, 'old.js'), 'utf8') === 'keep');
    const linkedHidden = path.join(root, 'comp-linked-hidden');
    fs.mkdirSync(linkedHidden);
    fs.writeFileSync(path.join(linkedHidden, COMPOSITION_MARKER), JSON.stringify({ format: 'shim-composition-checkout/1', hidden: ['.well-known/old.js'] }));
    fs.symlinkSync(outside, path.join(linkedHidden, '.well-known'));
    throwsCode('an earlier hidden path behind a symlink is refused', 'unsafe-path', () => writeCompositionCheckout(linkedHidden, { 'manifest.json': '{}' }));
    check('…which would have removed old.js through the link', fs.existsSync(path.join(outside, 'old.js')));
    const linkedMarker = path.join(root, 'comp-linked-marker');
    fs.mkdirSync(linkedMarker);
    fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(linkedMarker, COMPOSITION_MARKER));
    throwsCode('a marker that is a symlink is refused', 'unsafe-path', () => writeCompositionCheckout(linkedMarker, { 'manifest.json': '{}' }));
    check('…and its target is untouched', fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8') === 'keep');
  }
}

console.log('composition checkout, paths a case-insensitive disk folds together:');
{
  // An earlier checkout, to prove a refused one leaves it untouched.
  const dir = tmp();
  writeCompositionCheckout(dir, { 'manifest.json': '{}', 'index.html': 'page', 'A.js': 'upper' });
  const before = JSON.stringify(readWorkingCopy(dir));
  throwsCode('two files differing only in case are refused', 'unsafe-path',
    () => writeCompositionCheckout(dir, { 'manifest.json': '{}', 'A.js': 'upper', 'a.js': 'lower' }));
  throwsCode('…and two folders differing only in case', 'unsafe-path',
    () => writeCompositionCheckout(dir, { 'manifest.json': '{}', 'Lib/x.js': 'x', 'lib/y.js': 'y' }));
  throwsCode('…and a file named like a folder in another case', 'unsafe-path',
    () => writeCompositionCheckout(dir, { 'manifest.json': '{}', 'App': 'x', 'app/y.js': 'y' }));
  throwsCode('…and a case variant of the checkout marker', 'unsafe-path',
    () => writeCompositionCheckout(dir, { 'manifest.json': '{}', [COMPOSITION_MARKER.toUpperCase()]: 'x' }));
  throwsCode('…and two Unicode normalizations of one name', 'unsafe-path',
    () => writeCompositionCheckout(dir, { 'manifest.json': '{}', 'café.js': 'nfc', 'café.js': 'nfd' }));
  throwsCode('…and one name as both a file and a folder', 'unsafe-path',
    () => writeCompositionCheckout(dir, { 'manifest.json': '{}', 'app': 'x', 'app/x.js': 'y' }));
  throwsCode('…and a file under the checkout marker', 'unsafe-path',
    () => writeCompositionCheckout(dir, { 'manifest.json': '{}', [`${COMPOSITION_MARKER}/x.js`]: 'x' }));
  check('a refused checkout leaves the earlier one as it was', JSON.stringify(readWorkingCopy(dir)) === before);
  check('distinct names still check out', writeCompositionCheckout(tmp(), { 'manifest.json': '{}', 'a.js': 'x', 'ab.js': 'y', 'lib/a.js': 'z' }).written.length === 4);
}

console.log('composition re-checkout, folder → file:');
{
  // An earlier checkout had app.js/util.js (and a hidden file it wrote under
  // that folder); the composition now has a top-level app.js.
  const dir = tmp();
  writeCompositionCheckout(dir, { 'manifest.json': '{}', 'app.js/util.js': 'old-util', 'app.js/.cfg/x.json': '{}', 'index.html': 'page' });
  const cw = writeCompositionCheckout(dir, { 'manifest.json': '{}', 'app.js': 'new-app', 'index.html': 'page' });
  check('a folder the composition now has as a file is replaced by it',
    fs.lstatSync(path.join(dir, 'app.js')).isFile() && fs.readFileSync(path.join(dir, 'app.js'), 'utf8') === 'new-app', JSON.stringify(cw));
  check('…removing what the earlier checkout wrote under it', cw.removed.includes('app.js/util.js') && cw.removed.includes('app.js/.cfg/x.json'), JSON.stringify(cw.removed));
  check('…and the checkout reads back as the composition', JSON.stringify(Object.keys(readWorkingCopy(dir)).sort()) === JSON.stringify(['app.js', 'index.html', 'manifest.json']));
  check('…and a second checkout of it is a plain replace', writeCompositionCheckout(dir, { 'manifest.json': '{}', 'app.js': 'newer', 'index.html': 'page' }).removed.length === 0
    && fs.readFileSync(path.join(dir, 'app.js'), 'utf8') === 'newer');

  // Nested: a folder under a folder, both emptied.
  const nested = tmp();
  writeCompositionCheckout(nested, { 'manifest.json': '{}', 'lib/a/b.js': 'b', 'lib/c.js': 'c' });
  writeCompositionCheckout(nested, { 'manifest.json': '{}', 'lib': 'now a file' });
  check('a nested folder tree emptied by the checkout is removed deepest first', fs.readFileSync(path.join(nested, 'lib'), 'utf8') === 'now a file');

  // A visible file the earlier checkout didn't write is still the
  // composition's (the folder IS the composition: a re-checkout removes every
  // visible file it no longer has), so it doesn't hold the folder up.
  const visible = tmp();
  writeCompositionCheckout(visible, { 'manifest.json': '{}', 'app.js/util.js': 'old-util' });
  fs.writeFileSync(path.join(visible, 'app.js', 'notes.txt'), 'scratch');
  writeCompositionCheckout(visible, { 'manifest.json': '{}', 'app.js': 'new-app' });
  check('a visible stray in that folder goes with it, as any visible file the composition lacks does',
    fs.readFileSync(path.join(visible, 'app.js'), 'utf8') === 'new-app');

  // Hidden content no checkout wrote is never removed, so it keeps the
  // folder: refused before anything changes.
  const strays: Array<[string, (folder: string) => void]> = [
    ['a hidden file no checkout wrote', (folder) => { fs.writeFileSync(path.join(folder, '.DS_Store'), 'mine'); }],
    ['a hidden folder no checkout wrote', (folder) => { fs.mkdirSync(path.join(folder, '.git')); fs.writeFileSync(path.join(folder, '.git', 'HEAD'), 'mine'); }],
  ];
  for (const [label, plant] of strays) {
    const kept = tmp();
    writeCompositionCheckout(kept, { 'manifest.json': '{"v":1}', 'app.js/util.js': 'old-util', 'index.html': 'old-page', 'gone.js': 'old-gone' });
    plant(path.join(kept, 'app.js'));
    throwsCode(`a folder where a file goes that holds ${label} is refused`, 'not-a-working-copy',
      () => writeCompositionCheckout(kept, { 'manifest.json': '{"v":2}', 'app.js': 'new-app', 'index.html': 'new-page' }));
    check(`…leaving the earlier checkout intact (${label})`,
      fs.readFileSync(path.join(kept, 'app.js', 'util.js'), 'utf8') === 'old-util'
      && fs.readFileSync(path.join(kept, 'index.html'), 'utf8') === 'old-page'
      && fs.readFileSync(path.join(kept, 'gone.js'), 'utf8') === 'old-gone'
      && fs.readFileSync(path.join(kept, 'manifest.json'), 'utf8') === '{"v":1}');
    throwsCode(`…and repeating it refuses the same way (${label})`, 'not-a-working-copy',
      () => writeCompositionCheckout(kept, { 'manifest.json': '{"v":2}', 'app.js': 'new-app', 'index.html': 'new-page' }));
  }
}

console.log('kind:');
{
  check('a checkout with manifest.json is a composition, even holding a shim.json', checkoutKind({ 'manifest.json': '{}', 'shim.json': '{}' }) === 'composition');
  check('a checkout with shim.json and no manifest is a shim', checkoutKind({ 'shim.json': '{}', 'handlers/a.js': 'x' }) === 'shim');
  const comp = tmp();
  writeCompositionCheckout(comp, { 'manifest.json': '{}', 'shim.json': '{}' });
  check('a composition checkout holding a shim.json is a composition folder', folderKind(comp) === 'composition');
  const shimDir = tmp();
  fs.writeFileSync(path.join(shimDir, 'shim.json'), '{}');
  check('a folder with shim.json is a shim folder', folderKind(shimDir) === 'shim');
  check('an empty folder is neither', folderKind(tmp()) === null);
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
