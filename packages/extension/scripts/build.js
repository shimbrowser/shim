#!/usr/bin/env node
// build — bundles @shimbrowser/extension into dist/, the folder Chrome loads
// ("Load unpacked") and the Web Store zip is made from:
//
//   dist/manifest.json       the manifest (static/manifest.json, version stamped)
//   dist/sw.js               the service worker
//   dist/content.js          the page runtime, registered per shim after
//   dist/shim-core.page.js   the engine: @shimbrowser/core's page bundle,
//                            built here from the same source with the same
//                            options, so it is the bundle the other hosts run
//   dist/popup.html|js       the popup
//   dist/install.html|js     the install page
//   dist/prepare.html|js     the install check, a sandboxed page (its CSP permits the syntax probe)
//   dist/attach.html|js      the attach card: a session asks, the user answers here
//   dist/ui.css              their stylesheet
//   dist/icons/              the toolbar icon, the browser's, in the manifest's sizes
//
// Every script is one self-contained IIFE for the browser platform (an
// extension page's <script> and a content script resolve no imports).
// @shimbrowser/core is bundled from its TypeScript source (the "shim-source"
// export condition), so this needs no prior core build.
//
//   npm run build -w @shimbrowser/extension

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const PKG_ROOT = path.join(__dirname, '..');
const SRC = path.join(PKG_ROOT, 'src');
const STATIC = path.join(PKG_ROOT, 'static');
const DIST = path.join(PKG_ROOT, 'dist');

const ENTRIES = {
  sw: 'sw.ts',
  content: 'content.ts',
  popup: 'popup.ts',
  install: 'install-page.ts',
  prepare: 'prepare.ts',
  attach: 'attach-page.ts',
};

function coreBuild() {
  const coreRoot = path.dirname(require.resolve('@shimbrowser/core/package.json'));
  return require(path.join(coreRoot, 'scripts', 'build.js'));
}

// A manifest version is up to four dot-separated integers: "0.7.0-dev" → "0.7.0".
function manifestVersion(version) {
  return String(version).replace(/[-+].*$/, '');
}

async function buildExtension() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  await esbuild.build({
    entryPoints: Object.fromEntries(Object.entries(ENTRIES).map(([name, file]) => [name, path.join(SRC, file)])),
    outdir: DIST,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    conditions: ['shim-source'],
    define: { SHIM_EXTENSION_VERSION: JSON.stringify(pkg.version) },
    sourcemap: false,
    legalComments: 'inline',
    logLevel: 'warning',
  });

  // The engine, from core's own bundle options (one IIFE, global ShimCore,
  // no Node builtin): the same bytes core's dist/ holds.
  const core = coreBuild();
  await esbuild.build(core.pageBundleOptions({ outfile: path.join(DIST, core.PAGE_BUNDLE_FILE) }));

  // Everything static as it is (icons/ included), then the manifest with
  // the package version stamped in.
  fs.cpSync(STATIC, DIST, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(STATIC, 'manifest.json'), 'utf8'));
  manifest.version = manifestVersion(pkg.version);
  fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return DIST;
}

module.exports = { buildExtension, manifestVersion, ENTRIES, DIST };

if (require.main === module) {
  buildExtension().then((dist) => {
    console.log(`@shimbrowser/extension: built → ${path.relative(process.cwd(), dist) || '.'}`);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
