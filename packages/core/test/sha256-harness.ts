// Pins the engine's pure-JS SHA-256 (packages/core/src/sha256.ts) to Node's
// crypto output, byte for byte. Stored `spec.bundleHash` values were minted by
// `crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)`; if the
// pure-JS path ever disagrees, every committed shim reads as deployed-over at
// once (design D4). Also checks computeDeployId end to end against the old
// Node formula, so a change to how deploy-id joins URLs is caught too.

import crypto from 'crypto';
import { sha256Hex } from '../src/sha256';
import { computeDeployId } from '../src/deploy-id';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

function nodeHex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function same(label: string, s: string): void {
  const got = sha256Hex(s);
  const want = nodeHex(s);
  check(label, got === want, `pure ${got} vs node ${want}`);
}

// Deterministic PRNG (mulberry32) so a failure reproduces exactly.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('\n=== sha256 harness ===\n');

console.log('known vectors (FIPS 180-4 / NIST):');
check('empty string', sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
check('"abc"', sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
check('448-bit two-block vector',
  sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')
    === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
console.log(`  ✓ ${passes} vector(s)`);

console.log('equality with Node crypto:');
const before = passes;
same('empty', '');
same('ascii', 'hello world');
same('newline only', '\n');
same('unicode (latin/cjk)', 'café — 日本語のテキスト');
same('emoji (astral, surrogate pairs)', '🎧🎶 track notes 👍🏽 🏳️‍🌈');
same('lone high surrogate', 'a\ud800b');
same('lone low surrogate', '\udc00');
same('NUL and control chars', '\u0000\u0001\u001f\u007f');
same('multi-KB ascii', 'x'.repeat(5000));
same('multi-KB unicode', 'ü🎵'.repeat(3000));

// Every length around the padding boundaries (55/56/63/64 bytes and their
// multiples) — the classic place a hand-rolled sha256 goes wrong.
for (let n = 0; n <= 260; n++) same(`length ${n}`, 'a'.repeat(n));
// Multi-byte characters straddling the boundaries: byte length ≠ string length.
for (let n = 0; n <= 70; n++) same(`é × ${n}`, 'é'.repeat(n));

// Realistic deploy-id inputs: sorted, de-duplicated URL lists joined by '\n'.
const urlSets: string[][] = [
  ['https://app.example.com/assets/index-C18nbkrQ.js'],
  ['https://app.example.com/assets/index-C18nbkrQ.js', 'https://app.example.com/assets/vendor-9f8e7d.js'],
  ['https://cdn.jquery.com/jquery.min.js', 'https://legacy.example.org/site-v1.css'],
  Array.from({ length: 120 }, (_, i) => `https://static.example.com/_next/static/chunks/${i}-${(i * 2654435761 >>> 0).toString(36)}.js`),
  ['https://例え.jp/スクリプト.js', 'https://xn--r8jz45g.jp/a.js'],
];
for (const [i, urls] of urlSets.entries()) same(`url list #${i}`, [...urls].sort().join('\n'));

// Random strings: mixed ASCII, BMP and astral code points, lengths 0–4096.
const rand = rng(0x5eed);
const pool = ['a', 'Z', '0', '/', '\n', ' ', 'é', 'ß', '中', 'ア', '€', '🎧', '😀', '\u0000', '\ud83c'];
for (let i = 0; i < 400; i++) {
  const len = Math.floor(rand() * (i < 300 ? 200 : 4096));
  let s = '';
  for (let j = 0; j < len; j++) s += pool[Math.floor(rand() * pool.length)];
  same(`random #${i} (len ${len})`, s);
}
console.log(`  ✓ ${passes - before} input(s) match crypto.createHash('sha256')`);

console.log('computeDeployId matches the pre-D4 Node formula:');
{
  const urls = [
    'https://app.example.com/assets/index-C18nbkrQ.js?v=3',
    'https://app.example.com/assets/vendor-9f8e7d.js#x',
    'https://app.example.com/assets/index-C18nbkrQ.js',
  ];
  const got = computeDeployId({ scriptUrls: urls, pageHost: 'app.example.com' });
  const cleaned = [...new Set(urls.map((u) => { const p = new URL(u); return p.origin + p.pathname; }))].sort();
  const want = nodeHex(cleaned.join('\n')).slice(0, 16);
  check('16-hex deploy id identical', got === want, `${String(got)} vs ${want}`);
  if (got === want) console.log(`  ✓ ${got}`);
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log(`all sha256 checks passed (${passes})`);
