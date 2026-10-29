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
const out = execFileSync('npx', ['-y', BROWSERS, 'install', `chrome@${version}`, '--path', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
// The last line is `chrome@<full version> <executable path>`.
const line = out.trim().split('\n').pop() || '';
const executable = line.slice(line.indexOf(' ') + 1).trim();
if (!line.startsWith(`chrome@${version}.`) || !fs.existsSync(executable)) {
  console.error(`min-chrome: no Chrome for Testing ${version} executable in: ${line}`);
  process.exit(1);
}
process.stdout.write(executable + '\n');
