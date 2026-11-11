#!/usr/bin/env node
// min-chrome — downloads Chrome for Testing at the manifest's
// minimum_chrome_version (the oldest Chrome Shim for Chrome supports) and
// prints the executable's path, for the harnesses' SHIM_CHROME_EXECUTABLE:
//
//   SHIM_CHROME_EXECUTABLE="$(node packages/extension/scripts/min-chrome.js <dir>)" \
//     node out/packages/extension/test/extension-vault-worlds-harness.js
//
// Chrome for Testing still loads unpacked extensions from the command line
// (branded Chrome stopped in 137). The milestone's newest build comes from
// Google's Chrome for Testing index; the zip is extracted here, with no
// system tool (a CI container may have no `unzip`).
// Only the path goes to stdout.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

/**
 * Extracts a zip held in `zip` into `dir`, keeping each entry's Unix mode
 * (Chrome's binaries must stay executable) and symlinks. Stored and deflated
 * entries only, no zip64; an entry naming a path outside `dir` throws.
 */
function unzip(zip, dir) {
  const root = path.resolve(dir);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end of central directory');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error('zip64 archives are not supported');
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central directory entry ${n}`);
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const next = at + 46 + nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const mode = zip.readUInt32LE(at + 38) >>> 16;
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLen);
    at = next;

    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`zip entry outside the folder: ${name}`);
    const type = mode & 0o170000;
    if (name.endsWith('/') || type === 0o040000) { fs.mkdirSync(target, { recursive: true }); continue; }

    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + packed);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`zip entry ${name} uses compression method ${method}`);
    if (data.length !== size) throw new Error(`zip entry ${name} is ${data.length} bytes, not ${size}`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (type === 0o120000) { fs.symlinkSync(data.toString('utf8'), target); continue; }
    fs.writeFileSync(target, data, { mode: (mode & 0o777) || 0o644 });
  }
}

/**
 * GETs `url` and reads the whole body, trying again when the network fails
 * mid-way: a CI runner can lose DNS or have a download cut off for a minute.
 * An HTTP error status answers at once; it won't change on a retry.
 */
async function getWithRetry(url, read, tries = 4, delayMs = 15_000) {
  for (let i = 1; ; i++) {
    let res;
    try {
      res = await fetch(url);
      if (res.ok) return await read(res);
    } catch (err) {
      if (i >= tries) throw err;
      console.error(`min-chrome: ${url}: ${err instanceof Error ? err.message : String(err)}; try ${i} of ${tries}, again in ${delayMs / 1000}s`);
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
      continue;
    }
    throw new Error(`${url}: HTTP ${res.status}`);
  }
}

const INDEX = 'https://googlechromelabs.github.io/chrome-for-testing/latest-versions-per-milestone-with-downloads.json';

/** Chrome for Testing's platform name and the executable inside its zip, for this machine. */
function platform() {
  const arch = os.arch();
  switch (process.platform) {
    case 'linux': if (arch === 'x64') return { name: 'linux64', exe: ['chrome-linux64', 'chrome'] }; break;
    case 'darwin': {
      const name = arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
      return { name, exe: [`chrome-${name}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'] };
    }
    case 'win32': if (arch === 'x64') return { name: 'win64', exe: ['chrome-win64', 'chrome.exe'] }; break;
    default: break;
  }
  throw new Error(`no Chrome for Testing build for ${process.platform}/${arch}`);
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'static', 'manifest.json'), 'utf8'));
  const milestone = String(manifest.minimum_chrome_version);
  const dir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'shim-min-chrome'));
  const plat = platform();

  const index = await getWithRetry(INDEX, (res) => res.json());
  const entry = index.milestones && index.milestones[milestone];
  const download = entry && (entry.downloads.chrome || []).find((d) => d.platform === plat.name);
  if (!entry || !download) throw new Error(`no Chrome for Testing ${milestone} for ${plat.name} in the index`);

  const home = path.join(dir, `${plat.name}-${entry.version}`);
  const executable = path.join(home, ...plat.exe);
  if (!fs.existsSync(executable)) {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { recursive: true });
    const body = await getWithRetry(download.url, async (res) => Buffer.from(await res.arrayBuffer()));
    unzip(body, home);
  }
  if (!fs.existsSync(executable)) throw new Error(`the Chrome for Testing ${entry.version} zip has no ${plat.exe.join('/')}`);
  process.stdout.write(executable + '\n');
}

module.exports = { getWithRetry, unzip };

if (require.main === module) {
  main().catch((err) => {
    console.error(`min-chrome: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
