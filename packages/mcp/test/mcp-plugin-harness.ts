// Harness for the Claude Code plugin and its authoring guide
// (packages/mcp/.claude-plugin, .mcp.json, skills/shim-authoring/SKILL.md and
// its references/):
// the manifest is well formed and versioned with the
// package; .mcp.json starts exactly the file the build writes; the package
// ships the plugin's files; the guide is a valid skill and stays in step with
// the code — the core links every reference file and stays small, every
// mutation kind spec-lint accepts, every anchor kind, every remote engine and
// every tool the server registers is documented, the
// internal loop's vocabulary (emit ops, edit-handler) is not, and the guide's
// worked example is a folder that packs cleanly.
//
//   node out/packages/mcp/test/mcp-plugin-harness.js

import * as fs from 'fs';
import * as path from 'path';
import { BUILTIN_KINDS } from '@shimbrowser/core/spec-lint';
import { packShim } from '@shimbrowser/core/shim-folder';
import { staticTools } from '../src/contract';
import { AI_UNAVAILABLE_SHIM_USER_MESSAGE, AI_UNAVAILABLE_USER_MESSAGE } from '@shimbrowser/core/composition-session-tools';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// The package's source folder, found from wherever this compiled file runs.
function packageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'packages', 'mcp');
    if (fs.existsSync(path.join(candidate, '.claude-plugin', 'plugin.json'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('packages/mcp not found above ' + __dirname);
}

const ROOT = packageRoot();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
type Rec = Record<string, unknown>;

console.log('manifest:');
const pkg = JSON.parse(read('package.json')) as Rec;
const plugin = JSON.parse(read('.claude-plugin/plugin.json')) as Rec;
check('the plugin is named shim', plugin.name === 'shim');
check('its version is the package\'s', plugin.version === pkg.version, `${String(plugin.version)} vs ${String(pkg.version)}`);
check('it carries a description and license', typeof plugin.description === 'string' && plugin.license === 'Apache-2.0');

console.log('.mcp.json:');
const mcp = JSON.parse(read('.mcp.json')) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
const server = mcp.mcpServers?.shim;
check('one server, named shim, run with node', !!server && server.command === 'node' && Object.keys(mcp.mcpServers ?? {}).length === 1);
// The build script is plain CommonJS beside the package; required by computed path.
const build = require(path.join(ROOT, 'scripts', 'build.js')) as { OUT_FILE: string; CLI_OUT_FILE: string };
const built = path.relative(ROOT, build.OUT_FILE).split(path.sep).join('/');
check('it starts exactly the file the build writes', server?.args?.[0] === `\${CLAUDE_PLUGIN_ROOT}/${built}`, `${server?.args?.[0] ?? ''} vs ${built}`);
const files = pkg.files as string[];
check('the package ships the plugin, its config, the skills and the bundle',
  ['dist', '.claude-plugin', '.mcp.json', 'skills'].every((f) => files.includes(f)), files.join(','));
// No "./" prefix: npm 11 drops such a bin path at publish (npm-pack-harness).
check('the bin is the bundle', (pkg.bin as Rec)['shim-mcp'] === built);
const builtCli = path.relative(ROOT, build.CLI_OUT_FILE).split(path.sep).join('/');
check('the shim bin is the CLI bundle', (pkg.bin as Rec).shim === builtCli, String((pkg.bin as Rec).shim));

console.log('the guide:');
// Normalized: a Windows checkout (core.autocrlf) has CRLF line endings.
const core = read('skills/shim-authoring/SKILL.md').replace(/\r\n/g, '\n');
const refDir = path.join(ROOT, 'skills', 'shim-authoring', 'references');
const refs = fs.readdirSync(refDir).filter((f) => f.endsWith('.md')).sort();
// The guide is the core plus the reference files the agent reads on demand;
// every content check below runs over all of it.
const skill = [core, ...refs.map((f) => read(`skills/shim-authoring/references/${f}`).replace(/\r\n/g, '\n'))].join('\n\n');
const fm = /^---\n([\s\S]*?)\n---\n/.exec(core);
const front = fm?.[1] ?? '';
const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? '';
check('frontmatter names the skill after its folder', name === 'shim-authoring');
check('a description that says when to use it', description.length > 80 && description.length <= 1024 && /Use whenever/.test(description));
check('the guide has reference files', refs.length > 0);
for (const f of refs) {
  check(`the core links references/${f}`, core.includes(`\`references/${f}\``));
}
for (const linked of new Set([...skill.matchAll(/`references\/([\w-]+\.md)`/g)].map((m) => m[1] ?? ''))) {
  check(`links to references/${linked} name a real file`, refs.includes(linked));
}
// The core loads whole on every session; detail belongs in a reference file.
const CORE_BUDGET_BYTES = 32_000;
check(`the core stays under ${CORE_BUDGET_BYTES} bytes`, Buffer.byteLength(core) <= CORE_BUDGET_BYTES, String(Buffer.byteLength(core)));

for (const kind of BUILTIN_KINDS) {
  check(`documents mutation kind "${kind}"`, skill.includes(`"kind": "${kind}"`), kind);
}
for (const anchor of ['data-attr', 'aria', 'text', 'css']) {
  check(`documents anchor kind "${anchor}"`, skill.includes(`{ "kind": "${anchor}"`));
}
check('documents the authored anchor cardinality ("many")', skill.includes('"cardinality": "many"') && /load more items/.test(skill));
for (const engine of ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite-remote', 'supabase']) {
  check(`documents remote engine "${engine}"`, skill.includes(engine));
}
for (const tool of staticTools()) {
  check(`documents tool ${tool.name}`, skill.includes(`\`${tool.name}`), tool.name);
}
// The guide tells the agent that only the api members it names exist, so
// every concrete member a handler can reach must be named.
const API_MEMBERS = [
  'api.origin', 'api.host', 'api.cleanup',
  'api.storage', 'api.storage.pack', 'api.storage.global', 'api.shared',
  'api.db', 'api.db.query', 'api.db.run', 'api.db.connection',
  'api.settings.get(', 'api.settings.getAll(', 'api.fetch(', 'api.ai.complete(',
  'api.onRouteChange(', 'api.modules.invoke(',
];
for (const member of API_MEMBERS) {
  check(`documents ${member}`, skill.includes(member));
}
// In the browser repo, every method of the namespaces the browser's ShimApi
// declares must be in the list above (skipped once the package lives on its own).
const apiTypes = path.join(ROOT, '..', '..', 'src', 'preload', 'shim-api-types.ts');
if (fs.existsSync(apiTypes)) {
  const source = fs.readFileSync(apiTypes, 'utf8').replace(/\r\n/g, '\n');
  for (const ns of ['settings', 'ai', 'modules', 'db']) {
    const block = new RegExp(`\\n  ${ns}\\??: \\{\\n([\\s\\S]*?)\\n  \\}`).exec(source)?.[1];
    check(`ShimApi declares api.${ns}`, block !== undefined);
    for (const m of (block ?? '').matchAll(/^ {4}(\w+)\??\s*[(:]/gm)) {
      check(`the guide names api.${ns}.${m[1]}`, API_MEMBERS.some((a) => a.startsWith(`api.${ns}.${m[1]}`)) && skill.includes(`api.${ns}.${m[1]}`));
    }
  }
}
// The supabase builder is part of that inventory too: every method its chain
// and table builder expose must be named, or a supported write or filter reads
// as unavailable.
const supabaseBuilder = path.join(ROOT, '..', '..', 'src', 'preload', 'db-supabase-builder.ts');
if (fs.existsSync(supabaseBuilder)) {
  const source = fs.readFileSync(supabaseBuilder, 'utf8').replace(/\r\n/g, '\n');
  const methods = new Set<string>();
  for (const iface of ['SupabaseChain', 'SupabaseTableBuilder', 'SupabaseHandlerBuilder']) {
    const body = new RegExp(`\\n(?:export )?interface ${iface}\\b[^{]*\\{\\n([\\s\\S]*?)\\n\\}`).exec(source)?.[1];
    check(`the builder declares ${iface}`, body !== undefined);
    for (const m of (body ?? '').matchAll(/^ {2}(\w+)(?:<[^>]*>)?\(/gm)) {
      if (m[1] && !['then', 'catch', 'finally'].includes(m[1])) methods.add(m[1]);
    }
  }
  check('the builder exposes its write verbs', ['insert', 'upsert', 'update', 'delete'].every((v) => methods.has(v)));
  for (const method of methods) {
    check(`the guide names supabase .${method}(`, skill.includes(`.${method}(`) || new RegExp(`\`\\.${method}\``).test(skill));
  }
}
// A remote connection's nested `storage` is how its tables get created and
// what its allowlist reads — the guide must show the shape, and that a
// supabase connection's creates nothing but still allowlists.
const connBlock = /```json\n\s*("connections": \[[\s\S]*?)\n\s*```/.exec(skill)?.[1];
function showsConnectionStorage(block: string | undefined): boolean {
  try {
    const parsed = JSON.parse(`{${block ?? ''}}`) as { connections?: { engine?: string; storage?: { tables?: unknown[] } }[] };
    return (parsed.connections ?? []).some((c) => c.engine !== 'supabase' && (c.storage?.tables?.length ?? 0) > 0);
  } catch {
    return false;
  }
}
check('shows a remote connection with a nested storage declaration', showsConnectionStorage(connBlock));
check('says nested storage creates tables additively and is the table allowlist', /creates missing tables and columns/.test(skill) && /table allowlist/.test(skill));
check('says a supabase connection\'s storage creates nothing but still allowlists', /supabase connection's\s+`storage` creates nothing/.test(skill));
// Non-secret setting values ride a pack export (packs/core.ts → exportToShim
// includeSettings) — only secret values never travel.
check('does not claim setting values never travel', !/Values never travel with the shim/.test(skill));
check('says non-secret setting values ride a pack export', /`secret` values never do, but non-secret\s+values ride along when the user exports a pack/.test(skill));
// api.fetch omits cookies but forwards the caller's headers (capabilities/
// fetch.ts), so key-authenticated third-party APIs work through it.
check('does not restrict api.fetch to public content', !/public content only/.test(skill));
check('says api.fetch sends the headers you pass (key-authenticated APIs work)', /does send the headers\s+you pass/.test(skill) && /`secret`\s+setting and pass it as `Authorization`/.test(skill));
// The local read caps are defaults a shim can raise via storage.limits, up to
// the transport's hard ceilings (shim-db/transport-sqlite.ts, schema.ts).
check('documents storage.limits and its ceilings', /"limits": \{ "maxRows": \d+,\s+"maxResultBytes": \d+ \}/.test(skill) && /up to 100,000 rows \/ 20 MB/.test(skill));
const sqliteTransport = path.join(ROOT, '..', '..', 'src', 'main', 'shim-db', 'transport-sqlite.ts');
if (fs.existsSync(sqliteTransport)) {
  const source = fs.readFileSync(sqliteTransport, 'utf8');
  check('the guide\'s ceilings match the transport\'s', /HARD_MAX_ROWS = 100_000;/.test(source) && /HARD_MAX_RESULT_BYTES = 20_000_000;/.test(source));
  check('the guide\'s defaults match the transport\'s', /\bMAX_ROWS = 5000;/.test(source) && /\bMAX_RESULT_BYTES = 1_000_000;/.test(source) && /5,000 rows \/ 1 MB/.test(skill));
}
// The preview bucket is one per site and never cleared — the guide must not
// promise it is discarded, and must warn that it may hold earlier keys.
check('does not claim preview storage is gone after commit', !/preview stores is gone/.test(skill));
check('says the preview bucket is shared per site and never cleared', /shared by every preview there/.test(skill) && /never cleared/.test(skill));
check('makes visual verification a duty', /Visual intents require visual verification/.test(skill) && /view_page \{ selector \}/.test(skill));
check('says previews act on the real site', /Your previews act on the real site/.test(skill));
check('says previews run on a preview api (scratch storage, no settings / ai / db)', /handlers get a preview `api`, not the shim's/.test(skill) && /scratch bucket/.test(skill));
check('tells the agent to report partial verification as unverified', /verification: partial/.test(skill) && /unverified/.test(skill));
for (const internal of ['emit_shim_delta', 'emit_composition_delta', 'edit-handler', 'read_handler', 'propose_tasks', 'propose_sources', '# Handler source']) {
  check(`no internal-loop vocabulary: ${internal}`, !skill.includes(internal));
}
check('never asks the agent to write witnesses', !/"witness"\s*:/.test(skill));
// What readShimFolder / diffWorkingCopy enforce must be in the folder rules,
// or an agent following them exactly is refused.
check('states the portable handler-name exclusions (__proto__, device names, case)',
  skill.includes('`__proto__`') && skill.includes('`con`') && /differ only in case/.test(skill));
check('says route and redirect rules do not install on a global shim', /Not on a global shim\.\*\* Route and redirect rules/.test(skill));
check('documents the whole-export intercept wrap and its reload', /give `wrap` without `symbol`[\s\S]{0,200}reload/.test(skill));
check('says api.fetch cannot reach the local network', /cannot reach the local network[\s\S]{0,200}blocked/.test(skill));
// A preview's api.fetch is the real broker (page-preload's makeApi), private-network block included.
// Redirect's boundary is per-target consent (redirect-registry's grant gate), not domain.
check('never says a redirect must stay on one registrable domain', !/`from` and `to` must share a registrable domain/.test(skill));
check('says a redirect may go cross-site once the target is allowed', /`to` may be any site, including another domain/.test(skill) && /boundary is consent/.test(skill));
check('never claims a preview skips api.fetch', !/previews? (?:don't|do not|doesn't|does not|never) (?:exercise|use|reach|run)[^.]{0,60}(?:fetch|this path)/i.test(skill));
check('says a preview makes the same real fetch requests', /preview makes the same real requests/.test(skill));
check('documents sharedHandlers as editable on a global shim', /On a global shim[\s\S]{0,200}`sharedHandlers`/.test(skill) && skill.includes('api.shared.<name>'));

console.log('the composition half:');
check('documents the composition manifest', skill.includes('"format": "composition/1"') && /`hosts\[\]`/.test(skill) && /`mint`/.test(skill));
check('documents the flat folder and its bounds', /Flat\./.test(skill) && /200 files and 50 MB/.test(skill));
for (const member of ['api.fetch(host, path', 'api.storage.get', 'api.settings.get', 'api.db.connection', '/_media/']) {
  check(`documents window.api's ${member}`, skill.includes(member));
}
check('tells the agent to pass the shim api.ai sentence on once, verbatim', skill.includes(`> ${AI_UNAVAILABLE_SHIM_USER_MESSAGE}`)
  && /`aiUnavailable` \| a handler called `api.ai`/.test(skill));
check('tells the agent to pass the api.ai sentence on once, verbatim', skill.includes(`> ${AI_UNAVAILABLE_USER_MESSAGE}`)
  && /ai-unavailable-in-external-session/.test(skill) && /Don't repeat it/.test(skill));

console.log('the worked example:');
const specBlock = /`shim\.json`:\n\n```json\n([\s\S]*?)\n```/.exec(skill)?.[1];
const handlerBlock = /`handlers\/markPlayed\.js`:\n\n```js\n([\s\S]*?)\n```/.exec(skill)?.[1];
check('the guide shows a shim.json and its handler file', !!specBlock && !!handlerBlock);
if (specBlock && handlerBlock) {
  try {
    const packed = packShim({ 'shim.json': specBlock, 'handlers/markPlayed.js': `${handlerBlock}\n` });
    check('the example folder packs cleanly (lint, handlers bound, hosts)', packed.spec.rules?.length === 2);
  } catch (e) {
    check('the example folder packs cleanly (lint, handlers bound, hosts)', false, e instanceof Error ? e.message : String(e));
  }
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
