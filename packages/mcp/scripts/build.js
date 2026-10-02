#!/usr/bin/env node
// build — bundles @shimbrowser/mcp into ONE self-contained file,
// dist/shim-mcp.js: the MCP SDK and @shimbrowser/core inlined, only Node
// builtins (and the optional Playwright peer) left external. One file because the Claude Code plugin runs it
// from wherever the plugin is installed, with no node_modules beside it.
//
//   npm run build -w @shimbrowser/mcp
//
// @shimbrowser/core is bundled from its TypeScript source (the
// "shim-source" export condition), so this needs no prior core build.

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const PKG_ROOT = path.join(__dirname, '..');
const DIST = path.join(PKG_ROOT, 'dist');
const OUT_FILE = path.join(DIST, 'shim-mcp.js');

async function buildMcp() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
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
    external: ['playwright', 'playwright-core'],
    define: { SHIM_MCP_VERSION: JSON.stringify(pkg.version) },
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
