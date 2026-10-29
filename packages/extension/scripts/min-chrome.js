#!/usr/bin/env node
// min-chrome — downloads Chrome for Testing at the manifest's
// minimum_chrome_version (the oldest Chrome Shim for Chrome supports) and
// prints the executable's path, for the harnesses' SHIM_CHROME_EXECUTABLE:
//
//   SHIM_CHROME_EXECUTABLE="$(node packages/extension/scripts/min-chrome.js <dir>)" \
//     node out/packages/extension/test/extension-vault-worlds-harness.js
//
// Chrome for Testing still loads unpacked extensions from the command line
// (branded Chrome stopped in 137). Downloads with @puppeteer/browsers, pinned.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BROWSERS = '@puppeteer/browsers@2.13.2';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'static', 'manifest.json'), 'utf8'));
const version = String(manifest.minimum_chrome_version);
const dir = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'shim-min-chrome'));
fs.mkdirSync(dir, { recursive: true });
// The CLI's own output goes to stderr: stdout carries only the path.
execFileSync('npx', ['-y', BROWSERS, 'install', `chrome@${version}`, '--path', dir], { stdio: ['ignore', 2, 2] });

// Found on disk rather than read from the CLI's output, which differs by
// platform: <dir>/chrome/<platform>-<version>.<build>/…/<executable>.
const NAMES = new Set(['chrome', 'chrome.exe', 'Google Chrome for Testing']);
function find(at, depth) {
  if (depth > 6) return null;
  let entries;
  try { entries = fs.readdirSync(at, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(at, e.name);
    if (e.isFile() && NAMES.has(e.name) && (e.name !== 'chrome' || path.basename(at).startsWith('chrome-'))) return full;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = find(path.join(at, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}
const root = path.join(dir, 'chrome');
const builds = fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name.includes(`-${version}.`)) : [];
const executable = builds.map((b) => find(path.join(root, b), 0)).find(Boolean);
if (!executable) {
  console.error(`min-chrome: no Chrome for Testing ${version} executable under ${root} (${builds.join(', ') || 'nothing installed'})`);
  process.exit(1);
}
process.stdout.write(executable + '\n');
