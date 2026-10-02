#!/usr/bin/env node
// build — bundles @shimbrowser/mcp into ONE self-contained file,
// dist/shim-mcp.js: the MCP SDK and @shimbrowser/core inlined, only Node
// builtins (and the optional Playwright peer) left external. One file because the Claude Code plugin runs it
// from wherever the plugin is installed, with no node_modules beside it.
//
//   npm run build -w @shimbrowser/mcp
//
// @shimbrowser/core is bundled from its TypeScript source (the
// "shim-source" export condition), so this needs no prior core build. The
// headless driver also injects core's browser page bundle into every page it
// drives (D9); that bundle is built here from the same source and embedded as
// a string (SHIM_CORE_PAGE_BUNDLE), so the one-file plugin needs no
// node_modules to run headless either.

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const PKG_ROOT = path.join(__dirname, '..');
const DIST = path.join(PKG_ROOT, 'dist');
const OUT_FILE = path.join(DIST, 'shim-mcp.js');

// @shimbrowser/core's page bundle (its scripts/build.js pageBundleOptions:
// one browser-platform IIFE, global ShimCore), built in memory.
async function corePageBundle() {
  const coreRoot = path.dirname(require.resolve('@shimbrowser/core/package.json'));
  const out = await esbuild.build({
    entryPoints: [path.join(coreRoot, 'src', 'index.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'ShimCore',
    platform: 'browser',
    target: 'es2022',
    sourcemap: false,
    write: false,
    logLevel: 'warning',
  });
  const file = out.outputFiles && out.outputFiles[0];
  if (!file) throw new Error('@shimbrowser/mcp: the core page bundle build produced no output');
  return file.text;
}

async function buildMcp() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  const pageBundle = await corePageBundle();
  fs.rmSync(DIST, { recursive: true, force: true });
  await esbuild.build({
    entryPoints: [path.join(PKG_ROOT, 'src', 'cli.ts')],
    outfile: OUT_FILE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    conditions: ['shim-source'],
    // Playwright is an optional peer (the headless PageHost, D9): never
    // inlined, loaded at runtime only when a headless page is opened.
    // `@shimbrowser/core/page` is only a fallback lookup: this bundle embeds
    // the page bundle (SHIM_CORE_PAGE_BUNDLE).
    external: ['playwright', 'playwright-core', '@shimbrowser/core/page'],
    define: { SHIM_MCP_VERSION: JSON.stringify(pkg.version), SHIM_CORE_PAGE_BUNDLE: JSON.stringify(pageBundle) },
    legalComments: 'inline',
    logLevel: 'warning',
  });
  fs.chmodSync(OUT_FILE, 0o755);
  return OUT_FILE;
}

module.exports = { buildMcp, OUT_FILE };

if (require.main === module) {
  buildMcp().then((file) => console.log(`built ${path.relative(process.cwd(), file)}`), (e) => {
    console.error(e);
    process.exit(1);
  });
}
