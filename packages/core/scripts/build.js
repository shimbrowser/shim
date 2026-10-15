#!/usr/bin/env node
// build — compiles @shimbrowser/core's src/ into dist/.
//
// Three outputs, all under dist/:
//   dist/<module>.js        CommonJS, one file per src/<module>.ts — what the
//                           package's `exports` map serves to Node (the Shim
//                           browser's main process and page preload load the
//                           engine this way).
//   dist/<module>.d.ts      declarations, emitted by tsc from tsconfig.json.
//   dist/shim-core.page.js  the whole engine bundled for the BROWSER platform
//                           as one IIFE (global `ShimCore`, no externals) — the
//                           script a driver injects into a page. Its build
//                           fails on any Node builtin (the page
//                           bundle imports no Node builtins), even one an npm
//                           polyfill could satisfy.
//
// Zero runtime dependencies: esbuild and typescript are build tools only.
// Run standalone (`npm run build -w @shimbrowser/core`) or through the
// Shim browser's build, which calls buildCore() before compiling the app.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { builtinModules } = require('module');
const esbuild = require('esbuild');

const PKG_ROOT = path.join(__dirname, '..');
const SRC = path.join(PKG_ROOT, 'src');
const DIST = path.join(PKG_ROOT, 'dist');

const PAGE_BUNDLE_FILE = 'shim-core.page.js';
const PAGE_BUNDLE_GLOBAL = 'ShimCore';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// esbuild's browser platform already refuses an unpolyfilled builtin, but it
// resolves a bare `events`/`buffer`/`util` to an npm polyfill if one happens
// to be installed. Reject every Node builtin name up front so the page bundle
// fails the same way whatever node_modules holds.
const NODE_BUILTINS = new Set(builtinModules);
function isNodeBuiltin(spec) {
  if (spec.startsWith('node:')) return true;
  return NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(spec.split('/')[0]);
}
const nodeBuiltinGuard = {
  name: 'shim-core-no-node-builtins',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point' || !isNodeBuiltin(args.path)) return undefined;
      return {
        errors: [{
          text: `Node builtin "${args.path}" in the @shimbrowser/core page bundle (the engine imports no Node builtin; do host-specific work in the host)`,
        }],
      };
    });
  },
};

/** esbuild options for the browser-platform page bundle. */
function pageBundleOptions(overrides = {}) {
  return {
    entryPoints: [path.join(SRC, 'index.ts')],
    outfile: path.join(DIST, PAGE_BUNDLE_FILE),
    bundle: true,
    format: 'iife',
    globalName: PAGE_BUNDLE_GLOBAL,
    platform: 'browser',
    target: 'es2022',
    external: [],
    plugins: [nodeBuiltinGuard],
    sourcemap: false,
    logLevel: 'silent',
    ...overrides,
  };
}

function emitDeclarations() {
  const tsc = require.resolve('typescript/bin/tsc');
  const res = spawnSync(process.execPath, [tsc, '-p', path.join(PKG_ROOT, 'tsconfig.json')], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (res.status !== 0) throw new Error(`@shimbrowser/core: tsc declaration emit failed (exit ${res.status})`);
}

async function buildCore({ declarations = true } = {}) {
  fs.rmSync(DIST, { recursive: true, force: true });
  const entryPoints = walk(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));

  await esbuild.build({
    entryPoints,
    outdir: DIST,
    outbase: SRC,
    format: 'cjs',
    platform: 'neutral',
    target: 'es2022',
    // inline, matching the app's own per-file build: the browser turns on
    // source-mapped stacks at runtime and inline maps survive asar packaging.
    sourcemap: 'inline',
    logLevel: 'warning',
  });

  await esbuild.build(pageBundleOptions());

  if (declarations) emitDeclarations();

  return { modules: entryPoints.length, pageBundle: path.join(DIST, PAGE_BUNDLE_FILE) };
}

module.exports = { buildCore, pageBundleOptions, nodeBuiltinGuard, isNodeBuiltin, PAGE_BUNDLE_FILE, PAGE_BUNDLE_GLOBAL, DIST, SRC };

if (require.main === module) {
  buildCore().then(({ modules }) => {
    console.log(`@shimbrowser/core: built ${modules} modules + ${PAGE_BUNDLE_FILE} + declarations → dist/`);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
