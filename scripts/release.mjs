// The release steps, run by .github/workflows/release.yml when a `v<version>`
// tag is pushed (and runnable by hand to try them):
//
//   node scripts/release.mjs check <tag>        the tag names the version every package,
//                                               the plugin and the marketplace entry carry
//   node scripts/release.mjs assets <tag>       release/: shim-for-chrome.zip,
//                                               shimbrowser-core.tgz, shimbrowser-mcp.tgz,
//                                               SHA256SUMS, NOTES.md. The names carry no
//                                               version, so .../releases/latest/download/<name>
//                                               always reaches the newest release.
//   node scripts/release.mjs plugin-tag <tag>   commit the built plugin (packages/mcp with
//                                               its dist/) on a commit of its own and
//                                               publish it as the tag `plugin-<tag>`
//
// The plugin tag exists because Claude Code installs a plugin from git without
// building it: the marketplace entry (.claude-plugin/marketplace.json) points at
// packages/mcp on `plugin-v<version>`, the one commit that carries dist/. Only
// that tag is published; no branch moves.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'release');
const read = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function versionOf(tag) {
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(tag)) fail(`"${tag}" is not a v<semver> tag`);
  return tag.slice(1);
}

function check(tag) {
  const version = versionOf(tag);
  const problems = [];
  for (const pkg of ['core', 'mcp', 'extension']) {
    const v = read('packages', pkg, 'package.json').version;
    if (v !== version) problems.push(`packages/${pkg} is ${v}`);
  }
  const plugin = read('packages', 'mcp', '.claude-plugin', 'plugin.json').version;
  if (plugin !== version) problems.push(`the plugin's plugin.json is ${plugin}`);
  const entry = read('.claude-plugin', 'marketplace.json').plugins?.find((p) => p.name === 'shim');
  if (entry?.source?.ref !== `plugin-${tag}`) problems.push(`the marketplace entry's ref is ${entry?.source?.ref}, not plugin-${tag}`);
  if (problems.length) fail(`the tag ${tag} does not match: ${problems.join('; ')}`);
  console.log(`release: ${tag} matches every package, the plugin and the marketplace entry`);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function notes(version, files) {
  return `Shim ${version}, a beta. Install instructions are in the repository's README.

- **Shim for Chrome**: \`shim-for-chrome.zip\`. Unzip it into a folder you will keep, then load it on chrome://extensions with Developer mode on (Load unpacked).
- **The shim CLI and the MCP server**: \`npm install -g https://github.com/shimbrowser/shim/releases/download/v${version}/shimbrowser-mcp.tgz\`
- **The Claude Code plugin**: \`claude plugin marketplace add shimbrowser/shim\`, then \`claude plugin install shim@shimbrowser\` (updating: \`claude plugin marketplace update shimbrowser\`).
- **The engine** (\`@shimbrowser/core\`): \`shimbrowser-core.tgz\`.

Every file's SHA-256 is in SHA256SUMS. Files: ${files.join(', ')}.
`;
}

function assets(tag) {
  check(tag);
  const version = versionOf(tag);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT);
  const dist = path.join(ROOT, 'packages', 'extension', 'dist');
  if (!fs.existsSync(path.join(dist, 'manifest.json'))) fail('packages/extension/dist is not built (npm run build)');
  run('zip', ['-r', '-X', '-q', path.join(OUT, 'shim-for-chrome.zip'), '.'], { cwd: dist });
  run('npm', ['pack', '-w', '@shimbrowser/core', '-w', '@shimbrowser/mcp', '--pack-destination', OUT]);
  // npm names a tarball after its version; the release names it after the package alone.
  for (const pkg of ['core', 'mcp']) {
    fs.renameSync(path.join(OUT, `shimbrowser-${pkg}-${version}.tgz`), path.join(OUT, `shimbrowser-${pkg}.tgz`));
  }
  const files = fs.readdirSync(OUT).sort();
  fs.writeFileSync(path.join(OUT, 'SHA256SUMS'), files.map((f) => `${sha256(path.join(OUT, f))}  ${f}\n`).join(''));
  fs.writeFileSync(path.join(OUT, 'NOTES.md'), notes(version, files));
  console.log(`release: ${files.join(', ')} and SHA256SUMS in release/`);
}

function pluginTag(tag) {
  check(tag);
  if (!fs.existsSync(path.join(ROOT, 'packages', 'mcp', 'dist', 'shim-mcp.js'))) fail('packages/mcp/dist is not built (npm run build)');
  const name = `plugin-${tag}`;
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  const bot = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];
  run('git', ['checkout', '--detach']);
  run('git', ['add', '--force', 'packages/mcp/dist']);
  run('git', [...bot, 'commit', '--quiet', '-m', `The Claude Code plugin for ${tag}, built (packages/mcp/dist)`]);
  // A rerun of a release that failed after this step finds the tag already
  // published. It is reused when it carries exactly this build, and the release
  // stops when it carries anything else: a published tag is never moved.
  if (git('ls-remote', '--tags', 'origin', `refs/tags/${name}`)) {
    run('git', ['fetch', '--quiet', 'origin', `+refs/tags/${name}:refs/tags/${name}`]);
    if (git('rev-parse', `${name}^{tree}`) !== git('rev-parse', 'HEAD^{tree}')) {
      fail(`${name} is already published with different contents; it is never moved`);
    }
    console.log(`release: ${name} is already published with this build`);
    return;
  }
  run('git', ['tag', '--force', name]);
  run('git', ['push', 'origin', `refs/tags/${name}`]);
  console.log(`release: published ${name}`);
}

const [command, tag] = process.argv.slice(2);
if (command === 'check') check(tag);
else if (command === 'assets') assets(tag);
else if (command === 'plugin-tag') pluginTag(tag);
else fail('usage: node scripts/release.mjs check|assets|plugin-tag v<version>');
