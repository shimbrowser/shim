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
// Google's Chrome for Testing index; the zip is extracted with `unzip`.
// Only the path goes to stdout.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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

  const index = await (await fetch(INDEX)).json();
  const entry = index.milestones && index.milestones[milestone];
  const download = entry && (entry.downloads.chrome || []).find((d) => d.platform === plat.name);
  if (!entry || !download) throw new Error(`no Chrome for Testing ${milestone} for ${plat.name} in the index`);

  const home = path.join(dir, `${plat.name}-${entry.version}`);
  const executable = path.join(home, ...plat.exe);
  if (!fs.existsSync(executable)) {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { recursive: true });
    const zip = path.join(home, 'chrome.zip');
    const res = await fetch(download.url);
    if (!res.ok) throw new Error(`${download.url}: HTTP ${res.status}`);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    execFileSync('unzip', ['-q', zip, '-d', home], { stdio: ['ignore', 2, 2] });
    fs.rmSync(zip);
  }
  if (!fs.existsSync(executable)) throw new Error(`the Chrome for Testing ${entry.version} zip has no ${plat.exe.join('/')}`);
  process.stdout.write(executable + '\n');
}

main().catch((err) => {
  console.error(`min-chrome: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
