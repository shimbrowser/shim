// Pins min-chrome (scripts/min-chrome.js): its download retry (a fetch that
// rejects or a body cut off mid-read is tried again, the last failure
// surfaces after the given tries, an HTTP error answers at once) and its zip
// extraction (stored and deflated entries, Unix modes, directories, symlinks,
// and an entry outside the folder refused).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

type Read<T> = (res: Response) => Promise<T>;
type GetWithRetry = <T>(url: string, read: Read<T>, tries?: number, delayMs?: number) => Promise<T>;
type Unzip = (zip: Buffer, dir: string) => void;

const loaded: unknown = require(path.join(__dirname, '..', '..', '..', '..', 'packages', 'extension', 'scripts', 'min-chrome.js'));
function exported(name: string): unknown {
  return typeof loaded === 'object' && loaded !== null ? Reflect.get(loaded, name) : undefined;
}
const retryFn = exported('getWithRetry');
const unzipFn = exported('unzip');
if (typeof retryFn !== 'function' || typeof unzipFn !== 'function') throw new Error('min-chrome.js must export getWithRetry and unzip');
const getWithRetry = retryFn as GetWithRetry;
const unzip = unzipFn as Unzip;

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

// ---- the zip extraction ----

interface Entry { name: string; data?: string; mode: number; deflate?: boolean }

/** A zip of `entries`, laid out the way zip(1) writes one made on Unix. */
function makeZip(entries: Entry[]): Buffer {
  let parts: Buffer[] = [];
  let centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const plain = Buffer.from(e.data ?? '');
    const body = e.deflate ? zlib.deflateRawSync(plain) : plain;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((e.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    parts = [...parts, local, name, body];
    centrals = [...centrals, central, name];
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

function errorOf(run: () => void): string {
  try { run(); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

function unzipChecks(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'min-chrome-unzip-'));
  try {
    const out = path.join(dir, 'out');
    const script = '#!/bin/sh\necho chrome\n'.repeat(50);
    unzip(makeZip([
      { name: 'chrome-linux64/', mode: 0o040755 },
      { name: 'chrome-linux64/chrome', data: script, mode: 0o100755, deflate: true },
      { name: 'chrome-linux64/locales/en-US.pak', data: 'pak', mode: 0o100644 },
      { name: 'chrome-linux64/lib.so', data: 'target', mode: 0o120777 },
    ]), out);
    const chrome = path.join(out, 'chrome-linux64', 'chrome');
    check('a deflated entry comes out whole', fs.readFileSync(chrome, 'utf8') === script);
    const mode = fs.statSync(chrome).mode & 0o777;
    check('and keeps its executable mode', mode === 0o755, mode.toString(8));
    check('a stored entry lands in a folder the zip never listed', fs.readFileSync(path.join(out, 'chrome-linux64', 'locales', 'en-US.pak'), 'utf8') === 'pak');
    const link = path.join(out, 'chrome-linux64', 'lib.so');
    check('a symlink stays a symlink', fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === 'target');

    let err = errorOf(() => { unzip(makeZip([{ name: '../escaped', data: 'x', mode: 0o100644 }]), path.join(dir, 'slip')); });
    check('an entry outside the folder is refused', err.includes('outside the folder') && !fs.existsSync(path.join(dir, 'escaped')), err);

    err = errorOf(() => { unzip(Buffer.from('not a zip at all, just some bytes that go on for a while'), path.join(dir, 'bad')); });
    check('something that is not a zip is refused', err.includes('not a zip'), err);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the download retry ----

/** Replaces fetch with one answering each call from `answers` in turn, and counts calls. */
function fakeFetch(answers: Array<() => Response>): { calls: () => number } {
  let n = 0;
  globalThis.fetch = (async () => {
    const answer = answers[Math.min(n, answers.length - 1)];
    n++;
    if (!answer) throw new Error('no answers');
    return answer();
  }) as typeof fetch;
  return { calls: () => n };
}
const ok = (body: string): Response => new Response(body, { status: 200 });
const dns = (): Response => { throw new TypeError('fetch failed: getaddrinfo EAI_AGAIN'); };
/** Headers arrive, then the body errors part-way, like a download cut off. */
const cutOff = (): Response => new Response(new ReadableStream({
  start(c) { c.enqueue(new TextEncoder().encode('partial')); c.error(new TypeError('terminated')); },
}), { status: 200 });
const text: Read<string> = (res) => res.text();

async function retryChecks(): Promise<void> {
  const realFetch = globalThis.fetch;
  const quiet = console.error;
  console.error = () => { /* the retry's own progress lines */ };
  try {
    let f = fakeFetch([() => ok('hi')]);
    let got = await getWithRetry('https://x.test/a', text, 4, 0);
    check('a first success answers at once', got === 'hi' && f.calls() === 1, `${got} ${f.calls()}`);

    f = fakeFetch([dns, dns, () => ok('back')]);
    got = await getWithRetry('https://x.test/a', text, 4, 0);
    check('a fetch that rejects is tried again', got === 'back' && f.calls() === 3, `${got} ${f.calls()}`);

    f = fakeFetch([cutOff, () => ok('whole')]);
    got = await getWithRetry('https://x.test/a', text, 4, 0);
    check('a body cut off mid-read is fetched again', got === 'whole' && f.calls() === 2, `${got} ${f.calls()}`);

    f = fakeFetch([dns]);
    let err = '';
    try { await getWithRetry('https://x.test/a', text, 3, 0); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    check('it gives up after the tries and throws the last failure', f.calls() === 3 && err.includes('EAI_AGAIN'), `${f.calls()} ${err}`);

    f = fakeFetch([() => new Response('gone', { status: 404 }), () => ok('never')]);
    err = '';
    try { await getWithRetry('https://x.test/a', text, 4, 0); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    check('an HTTP error answers at once, untried', f.calls() === 1 && err.includes('HTTP 404'), `${f.calls()} ${err}`);
  } finally {
    globalThis.fetch = realFetch;
    console.error = quiet;
  }
}

console.log('\n=== min-chrome harness ===\n');
unzipChecks();
void retryChecks().then(() => {
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log(`  ✓ ${passes} checks passed`);
});
