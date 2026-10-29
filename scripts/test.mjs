// Runs every package's harnesses (packages/*/test/*-harness.ts), the way the
// packages are tested before each release. `npm test` builds the packages
// first; this compiles each package's src/ and test/ file by file into out/
// (CommonJS, the same layout), so `@shimbrowser/core/<module>` resolves to
// the built packages/core/dist through the workspace link, then runs each
// harness with Node and exits non-zero if any fails.
//
//   node scripts/test.mjs             every harness that needs no browser
//   node scripts/test.mjs --browser   also the ones that drive Chromium
//                                     (first: npx playwright install chromium)
//   node scripts/test.mjs --browser-only   only those
//   node scripts/test.mjs <name>...   only harnesses whose file name contains <name>

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');
const PACKAGES = ['core', 'mcp', 'extension'];

// Harnesses that drive a real Chromium through Playwright (the extension
// loaded unpacked, the headless host, the CLI and plugin end to end).
const BROWSER = new Set([
  'extension-smoke-harness', 'extension-chrome-facts-harness', 'extension-full-mode-harness', 'extension-vault-worlds-harness', 'extension-vault-harness', 'extension-vault-enable-harness', 'extension-conformance-harness', 'extension-session-harness',
  'playwright-conformance-harness', 'headless-session-e2e-harness', 'shim-cli-e2e-harness', 'plugin-install-e2e-harness',
]);

const args = process.argv.slice(2);
const browserOnly = args.includes('--browser-only');
const withBrowser = browserOnly || args.includes('--browser');
const only = args.filter((a) => !a.startsWith('--'));

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

fs.rmSync(OUT, { recursive: true, force: true });
const files = PACKAGES.flatMap((pkg) => ['src', 'test'].flatMap((dir) => walk(path.join(ROOT, 'packages', pkg, dir))));
const sources = files.filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.ts'));
await esbuild.build({
  entryPoints: sources,
  outdir: OUT,
  outbase: ROOT,
  format: 'cjs',
  platform: 'node',
  target: 'node26',
  sourcemap: 'inline',
  logLevel: 'warning',
});
// Fixtures and other files a harness reads next to itself.
for (const f of files.filter((x) => !/\.ts$/.test(x))) {
  const to = path.join(OUT, path.relative(ROOT, f));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(f, to);
}

const harnesses = PACKAGES.flatMap((pkg) => walk(path.join(OUT, 'packages', pkg, 'test')))
  .filter((f) => f.endsWith('-harness.js'))
  .sort();
const failed = [];
let ran = 0;
for (const file of harnesses) {
  const name = path.basename(file, '.js');
  const rel = path.relative(ROOT, file);
  if (only.length && !only.some((o) => name.includes(o))) continue;
  if (BROWSER.has(name) && !withBrowser) {
    console.log(`↷ skip ${rel} (drives Chromium: npm run test:browser)`);
    continue;
  }
  if (browserOnly && !BROWSER.has(name)) continue;
  console.log(`── ${rel} ──`);
  const result = spawnSync(process.execPath, ['--enable-source-maps', file], { stdio: 'inherit', cwd: ROOT });
  ran += 1;
  if (result.status !== 0) failed.push(rel);
}

if (failed.length) {
  console.error(`\n✗ ${failed.length}/${ran} harnesses failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\n✓ ${ran} harnesses passed`);
