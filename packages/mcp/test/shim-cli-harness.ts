// Harness for the `shim` command line (packages/mcp/src/shim-cli.ts,
// cli-commands.ts) — no browser, no Shim:
// the launcher and the preview page are fakes. Covers:
//
//   - the command line: help / version, unknown commands, missing and extra
//     arguments, and per-command flag checks all exit 2 with a message;
//   - pack / unpack: defaults (<folder>.shim, the file's path without .shim),
//     unpack → pack is lossless, a witness survives an unrelated edit and is
//     dropped when its anchor changes, a lint error or a malformed folder
//     exits 1 with every problem, unpack never writes into a folder that
//     isn't empty or a shim folder, a pack it can't write exits 2;
//   - lint on a folder and on a .shim file, --json, and --headless adding
//     D15's preflight (errors) and source scan (warnings); a script handler
//     module pack would refuse (invalid syntax, a non-function export) is a
//     lint error for both;
//   - launch: attached / launched / failed, --timeout, --json never printing
//     the endpoint token;
//   - mcp: forwards its two flags to the server, refuses anything else;
//   - preview over a scripted PageHost: every rule's evidence, the
//     screenshot written, exit 1 for handler errors / no match / an
//     unsupported kind (nothing applied), exit 1 for a rule the engine never
//     reported a match for (a saved witness refused before its quarantine
//     is reported), a folder without rules, a folder
//     pack would refuse (no match.hosts, a lint error) refused before a page
//     opens, .shim-state.json witnesses (and the deploy baseline) restored
//     for unchanged anchors, --storage backing api.storage, and nothing left
//     behind (page closed, temp gone).
//
// The real-browser run of `shim preview` is shim-cli-e2e-harness.ts (the
// playwright-conformance CI job).
//
//   node out/packages/mcp/test/shim-cli-harness.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PageHost, PreviewRule, PageRuntimeEvent, PageConsoleMessage, PageLoadOutcome } from '@shimbrowser/core/page-host';
import { runShimCli, USAGE, EXIT_OK, EXIT_PROBLEM, EXIT_USAGE, type ShimCliContext } from '../src/shim-cli';
import { SHIM_FOR_CHROME_ID } from '../src/bridge-install';
import { shellQuote, type PreviewPage } from '../src/cli-commands';
import type { LaunchOutcome } from '../src/launch';
import { HEADLESS_CAPABILITIES, type HeadlessStorage } from '../src/playwright-page-host';
import { stableStringify } from '@shimbrowser/core/shim-folder';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    const d = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail);
    console.error(`  ✗ ${label}${d ? ` — ${d}` : ''}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-cli-'));
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const css = (value: string): { primary: { kind: 'css'; value: string } } => ({ primary: { kind: 'css', value } });
const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

// --- a scripted preview page -------------------------------------------------------

interface FakePage extends PreviewPage {
  applied: PreviewRule[];
  closed: boolean;
  shots: Array<{ file: string; selector?: string; fullPage?: boolean }>;
}

type OnApply = (p: PreviewRule, emit: (e: PageRuntimeEvent) => void) => void;

const matchOne: OnApply = (p, emit) => {
  emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: 1, matchedVia: 'primary', box: { x: 0, y: 0, w: 10, h: 20 } });
};

function fakePage(startUrl: string, onApply: OnApply, shotError: () => Error | null = () => null): FakePage {
  const runtime = new Set<(e: PageRuntimeEvent) => void>();
  const consoleL = new Set<(m: PageConsoleMessage) => void>();
  const emit = (e: PageRuntimeEvent): void => { for (const l of [...runtime]) l(e); };
  const page: FakePage = {
    applied: [],
    closed: false,
    shots: [],
    host: null as unknown as PageHost,
    async close() { page.closed = true; },
    async screenshot(file, opts) {
      const fail = shotError();
      if (fail) throw fail;
      page.shots.push({ file, ...opts });
      fs.writeFileSync(file, 'PNG');
    },
  };
  const host: PageHost = {
    capabilities: HEADLESS_CAPABILITIES,
    url: () => startUrl,
    isClosed: () => page.closed,
    async evaluate() { return null; },
    async screenshot() { return { error: 'no screenshots here' }; },
    applyPreview(p) { page.applied.push(p); onApply(p, emit); },
    removePreview() { /* nothing to undo */ },
    onRuntimeEvent(l) { runtime.add(l); return () => { runtime.delete(l); }; },
    onConsole(l) { consoleL.add(l); return () => { consoleL.delete(l); }; },
    reload() { /* stays put */ },
    async waitForLoad(): Promise<PageLoadOutcome> { return { kind: 'finished' }; },
    async documentToken() { return null; },
  };
  page.host = host;
  return page;
}

interface Rig {
  ctx: ShimCliContext;
  out: string[];
  err: string[];
  pages: FakePage[];
  storages: HeadlessStorage[];
  launches: Array<{ timeoutMs?: number }>;
  mcp: string[][];
  bridges: number;
  home: string;
  launchOutcome: LaunchOutcome;
  onApply: OnApply;
  // When set, the fake page's screenshot throws this instead of writing.
  shotError: Error | null;
}

function rig(): Rig {
  const r: Rig = {
    ctx: null as unknown as ShimCliContext,
    out: [],
    err: [],
    pages: [],
    storages: [],
    launches: [],
    mcp: [],
    bridges: 0,
    home: fs.mkdtempSync(path.join(tmp, 'home-')),
    launchOutcome: { ok: false, error: 'launch-unavailable', detail: 'no way to start Shim' },
    onApply: matchOne,
    shotError: null,
  };
  r.ctx = {
    out: (t) => r.out.push(t),
    err: (t) => r.err.push(t),
    async launch(opts) { r.launches.push(opts); return r.launchOutcome; },
    async openPreviewPage(url, storage) {
      const page = fakePage(url, r.onApply, () => r.shotError);
      r.pages.push(page);
      r.storages.push(storage);
      return page;
    },
    async runMcp(argv) { r.mcp.push(argv); },
    async runBridge() { r.bridges += 1; return 0; },
    extension: {
      platform: 'darwin',
      homedir: r.home,
      env: {},
      nodePath: '/opt/node/bin/node',
      bundlePath: '/opt/shim/dist/shim.js',
      bridgeDir: path.join(r.home, 'ud', 'bridge'),
      discoveryPath: path.join(r.home, 'ud', 'control-chrome.json'),
      isAlive: () => true,
      fs: {
        exists: (p) => fs.existsSync(p),
        mkdir: (p) => { fs.mkdirSync(p, { recursive: true }); },
        write: (p, text, mode) => { fs.writeFileSync(p, text, { mode }); },
        read: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
      },
    },
    previewSettleMs: 5,
  };
  return r;
}

async function cli(r: Rig, ...argv: string[]): Promise<number> {
  r.out.length = 0;
  r.err.length = 0;
  return runShimCli(argv, r.ctx);
}

function writeFolder(dir: string, spec: Record<string, unknown>, handlers: Record<string, string> = {}): string {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'handlers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shim.json'), json(spec));
  for (const [name, source] of Object.entries(handlers)) fs.writeFileSync(path.join(dir, 'handlers', `${name}.js`), source);
  return dir;
}

const BASE_SPEC = {
  id: 'demo-tracks',
  match: { hosts: ['site.test'] },
  rules: [
    { id: 'hide-promo', anchor: css('.promo'), mutations: [{ kind: 'hide' }] },
    { id: 'mark', anchor: css('.tracks'), mutations: [{ kind: 'script', handler: 'markTracks' }] },
  ],
};
const MARK = 'module.exports = function markTracks({ anchor }) {\n  anchor.dataset.marked = "1";\n};\n';

function tempPreviewDirs(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('shim-preview-'));
}

async function main(): Promise<void> {
  console.log('the command line');
  {
    const r = rig();
    check('no command prints usage and exits 2', (await cli(r)) === EXIT_USAGE && r.out[0] === USAGE);
    check('help exits 0', (await cli(r, 'help')) === EXIT_OK && r.out[0] === USAGE);
    check('--help exits 0', (await cli(r, '--help')) === EXIT_OK);
    check('--version prints a version', (await cli(r, '--version')) === EXIT_OK && /\d+\.\d+\.\d+/.test(r.out[0] ?? ''));
    check('an unknown command exits 2', (await cli(r, 'frob')) === EXIT_USAGE && /unknown command "frob"/.test(r.err[0] ?? ''));
    check('pack without a folder exits 2', (await cli(r, 'pack')) === EXIT_USAGE && /expected a shim folder/.test(r.err[0] ?? ''));
    check('pack with two folders exits 2', (await cli(r, 'pack', 'a', 'b')) === EXIT_USAGE);
    check('an unknown flag exits 2', (await cli(r, 'lint', 'x', '--frob')) === EXIT_USAGE && /frob/.test(r.err[0] ?? ''));
    check('preview without --url exits 2', (await cli(r, 'preview', tmp)) === EXIT_USAGE && /--url is required/.test(r.err[0] ?? ''));
    check('--selector without --screenshot exits 2', (await cli(r, 'preview', tmp, '--url', 'https://site.test/', '--selector', 'h1')) === EXIT_USAGE);
    check('a missing folder exits 2', (await cli(r, 'pack', path.join(tmp, 'nope'))) === EXIT_USAGE && /folder-missing/.test(r.err[0] ?? ''));
  }

  console.log('pack and unpack');
  {
    const r = rig();
    const dir = writeFolder(path.join(tmp, 'demo'), BASE_SPEC, { markTracks: MARK });
    check('pack exits 0', (await cli(r, 'pack', dir)) === EXIT_OK, r.err);
    const packed = `${dir}.shim`;
    check('it defaults to <folder>.shim', fs.existsSync(packed));
    const file = readJson(packed);
    check('a shim/1 file named after the spec, the handler as a module', file.format === 'shim/1' && file.name === 'demo-tracks'
      && (file.handlers as Record<string, string>).markTracks === MARK);
    check('pack reports what it packed', /2 rules, 1 handler/.test(r.out[0] ?? ''), r.out);

    // A file as the browser exports it: witnesses, version, bundleHash, history.
    const exported = {
      format: 'shim/1',
      name: 'Demo tracks',
      spec: {
        id: 'demo-tracks',
        version: 4,
        bundleHash: 'deploy-1',
        match: { hosts: ['site.test'] },
        rules: [
          { id: 'hide-promo', anchor: { ...css('.promo'), witness: { v: 1, tag: 'div', cls: ['promo'] } }, mutations: [{ kind: 'hide' }] },
          { id: 'mark', anchor: { ...css('.tracks'), witness: { v: 1, tag: 'ul' } }, mutations: [{ kind: 'script', handler: 'markTracks' }] },
        ],
      },
      handlers: { markTracks: MARK },
      authoringHistory: [{ role: 'user', content: 'hide the promo' }],
    };
    const exportedFile = path.join(tmp, 'exported.shim');
    fs.writeFileSync(exportedFile, json(exported));
    check('unpack exits 0', (await cli(r, 'unpack', exportedFile)) === EXIT_OK, r.err);
    const unpacked = path.join(tmp, 'exported');
    check('it defaults to the file\'s path without .shim', fs.existsSync(path.join(unpacked, 'shim.json')));
    check('the folder has the state file and the handler', fs.existsSync(path.join(unpacked, '.shim-state.json'))
      && fs.readFileSync(path.join(unpacked, 'handlers', 'markTracks.js'), 'utf8') === MARK);
    const shimJson = fs.readFileSync(path.join(unpacked, 'shim.json'), 'utf8');
    check('shim.json carries no witness, version or bundleHash', !/witness|bundleHash|"version"/.test(shimJson));

    const repacked = path.join(tmp, 'repacked.shim');
    check('pack --out exits 0', (await cli(r, 'pack', unpacked, '--out', repacked)) === EXIT_OK, r.err);
    // Deep-equal (key order aside): pack restores version / bundleHash after the authored fields.
    check('unpack → pack is lossless', stableStringify(readJson(repacked)) === stableStringify(exported), { got: readJson(repacked) });

    // An unrelated edit keeps the witness; an anchor edit drops it.
    const spec = JSON.parse(shimJson) as { rules: Array<{ id: string; anchor: unknown; mutations: unknown[] }> };
    const [promo, mark] = spec.rules;
    if (promo && mark) {
      promo.mutations = [{ kind: 'restyle', css: 'opacity: 0.2' }];
      mark.anchor = css('ul.tracks');
    }
    fs.writeFileSync(path.join(unpacked, 'shim.json'), json(spec));
    check('pack -o after an edit exits 0', (await cli(r, 'pack', unpacked, '-o', repacked)) === EXIT_OK, r.err);
    const edited = readJson(repacked) as { spec: { version: number; bundleHash: string; rules: Array<{ id: string; anchor: { witness?: unknown } }> } };
    const witnessOf = (id: string): unknown => edited.spec.rules.find((x) => x.id === id)?.anchor.witness;
    check('a rule whose anchor is unchanged keeps its witness', witnessOf('hide-promo') !== undefined);
    check('a rule whose anchor changed loses its witness', witnessOf('mark') === undefined);
    check('version and bundleHash come back from the state', edited.spec.version === 4 && edited.spec.bundleHash === 'deploy-1');

    check('unpack into the same folder again (an earlier shim folder) exits 0', (await cli(r, 'unpack', exportedFile)) === EXIT_OK, r.err);
    const busy = path.join(tmp, 'project');
    fs.mkdirSync(busy, { recursive: true });
    fs.writeFileSync(path.join(busy, 'README.md'), 'mine');
    check('unpack refuses a folder that is not empty and not a shim folder', (await cli(r, 'unpack', exportedFile, '-o', busy)) === EXIT_USAGE
      && /not-a-working-copy/.test(r.err[0] ?? '') && fs.readdirSync(busy).length === 1);
    const plain = path.join(tmp, 'plain.json');
    fs.copyFileSync(exportedFile, plain);
    check('unpack of a file without .shim needs --out', (await cli(r, 'unpack', plain)) === EXIT_USAGE && /--out/.test(r.err[0] ?? ''));
    // A file literally named `.shim` has no stem: stripping the extension
    // from its path would unpack into its parent folder.
    const bareDir = path.join(tmp, 'bare');
    fs.mkdirSync(bareDir);
    const bare = path.join(bareDir, '.shim');
    fs.copyFileSync(exportedFile, bare);
    check('unpack of a file named just .shim needs --out, writing nothing beside it', (await cli(r, 'unpack', bare)) === EXIT_USAGE
      && /--out/.test(r.err[0] ?? '') && fs.readdirSync(bareDir).join(',') === '.shim', fs.readdirSync(bareDir));
    const pack = path.join(tmp, 'pack.shim');
    fs.writeFileSync(pack, json({ format: 'shim-pack/1', name: 'p', shims: [] }));
    check('unpack refuses another .shim format', (await cli(r, 'unpack', pack, '-o', path.join(tmp, 'pack-out'))) === EXIT_PROBLEM
      && /shim-pack\/1/.test(r.err.join('\n')));
    // The wrong input for the command: each refusal names the command that takes it.
    const unpackedSpec = path.join(unpacked, 'shim.json');
    check('unpack of a folder\'s shim.json suggests pack on its folder', (await cli(r, 'unpack', unpackedSpec, '-o', path.join(tmp, 'spec-out'))) === EXIT_USAGE
      && /shim folder's shim\.json/.test(r.err[0] ?? '') && (r.err[0] ?? '').includes(`shim pack ${unpacked}`)
      && !fs.existsSync(path.join(tmp, 'spec-out')), r.err);
    check('unpack of a folder suggests pack', (await cli(r, 'unpack', unpacked)) === EXIT_USAGE
      && /is a folder; unpack takes a \.shim file/.test(r.err[0] ?? '') && (r.err[0] ?? '').includes(`shim pack ${unpacked}`), r.err);
    check('pack of a .shim file suggests unpack', (await cli(r, 'pack', exportedFile)) === EXIT_USAGE
      && (r.err[0] ?? '').includes(`shim unpack ${exportedFile}`), r.err);
    check('pack of a folder\'s shim.json points at the folder', (await cli(r, 'pack', unpackedSpec)) === EXIT_USAGE
      && (r.err[0] ?? '').includes(`pass the folder instead: ${unpacked}`), r.err);
    check('lint of a folder\'s shim.json points at the folder', (await cli(r, 'lint', unpackedSpec)) === EXIT_USAGE
      && (r.err[0] ?? '').includes(`shim lint ${unpacked}`), r.err);
    // A path with spaces and a quote stays one shell word in the suggestion.
    const oddDir = path.join(tmp, "Joel's shims");
    fs.mkdirSync(oddDir);
    const oddFile = path.join(oddDir, 'my shim.shim');
    fs.copyFileSync(exportedFile, oddFile);
    check('a suggested command quotes a path with spaces and a quote', (await cli(r, 'pack', oddFile)) === EXIT_USAGE
      && (r.err[0] ?? '').includes(`shim unpack ${shellQuote(oddFile)}`) && shellQuote(oddFile).startsWith("'"), r.err);
    check('shellQuote leaves a plain path bare and escapes a quote',
      shellQuote('/tmp/a-b_c.shim') === '/tmp/a-b_c.shim' && shellQuote("/tmp/x'y z") === "'/tmp/x'\\''y z'");
    check('unpack into an unrelated folder says why and suggests a subfolder', (await cli(r, 'unpack', exportedFile, '-o', busy)) === EXIT_USAGE
      && /only writes into an empty folder or one it unpacked before/.test(r.err[0] ?? '')
      && (r.err[0] ?? '').includes(`--out ${path.join(busy, 'exported')}`) && fs.readdirSync(busy).length === 1, r.err);

    const blocker = path.join(tmp, 'not-a-folder');
    fs.writeFileSync(blocker, 'a file');
    check('a pack it cannot write exits 2 (write-failed), no temp file left', (await cli(r, 'pack', unpacked, '--out', path.join(blocker, 'x.shim'))) === EXIT_USAGE
      && /write-failed/.test(r.err[0] ?? '') && fs.readFileSync(blocker, 'utf8') === 'a file', r.err);
    check('an unpack it cannot write exits 2 (write-failed)', (await cli(r, 'unpack', exportedFile, '-o', path.join(blocker, 'sub'))) === EXIT_USAGE
      && /write-failed/.test(r.err[0] ?? '') && fs.readFileSync(blocker, 'utf8') === 'a file', r.err);
    const numericHosts = writeFolder(path.join(tmp, 'numeric-hosts'), { ...BASE_SPEC, match: { hosts: [42] } }, { markTracks: MARK });
    check('pack exits 1 on a non-string host and writes nothing', (await cli(r, 'pack', numericHosts)) === EXIT_PROBLEM
      && /match\.hosts/.test(r.err.join('\n')) && !fs.existsSync(`${numericHosts}.shim`), r.err);

    // An unreadable file in the folder is the environment, not the shim (root reads anything).
    if (process.getuid?.() !== 0) {
      const unreadable = writeFolder(path.join(tmp, 'unreadable'), BASE_SPEC, { markTracks: MARK });
      const locked = path.join(unreadable, 'handlers', 'markTracks.js');
      fs.chmodSync(locked, 0o000);
      try {
        check('a folder with an unreadable file exits 2 (read-failed) for pack and lint', (await cli(r, 'pack', unreadable)) === EXIT_USAGE
          && /read-failed/.test(r.err[0] ?? '') && (await cli(r, 'lint', unreadable)) === EXIT_USAGE && /read-failed/.test(r.err[0] ?? ''), r.err);
      } finally {
        fs.chmodSync(locked, 0o644);
      }
    }

    const bad = writeFolder(path.join(tmp, 'bad'), { ...BASE_SPEC, rules: [{ id: 'x', anchor: css('.x'), mutations: [{ kind: 'sparkle' }] }] });
    check('pack exits 1 on a lint error and writes nothing', (await cli(r, 'pack', bad)) === EXIT_PROBLEM
      && /spec-lint/.test(r.err[0] ?? '') && /sparkle/.test(r.err[0] ?? '') && !fs.existsSync(`${bad}.shim`), r.err);
    const broken = writeFolder(path.join(tmp, 'broken'), { ...BASE_SPEC, version: 3 });
    check('pack exits 1 on a malformed folder, every problem listed', (await cli(r, 'pack', broken)) === EXIT_PROBLEM
      && /"version" is managed by Shim/.test(r.err[0] ?? '') && /markTracks\.js is missing/.test(r.err[0] ?? ''), r.err);
  }

  console.log('lint');
  {
    const r = rig();
    const dir = writeFolder(path.join(tmp, 'lint-ok'), BASE_SPEC, { markTracks: MARK });
    check('a clean folder exits 0', (await cli(r, 'lint', dir)) === EXIT_OK && /0 errors, 0 warnings/.test(r.out[0] ?? ''), r.out);
    check('--json reports the shape', (await cli(r, 'lint', dir, '--json')) === EXIT_OK && (() => {
      const rep = JSON.parse(r.out[0] ?? '{}') as Record<string, unknown>;
      return rep.kind === 'folder' && Array.isArray(rep.errors) && Array.isArray(rep.warnings);
    })());
    const bad = writeFolder(path.join(tmp, 'lint-bad'), { ...BASE_SPEC, rules: [{ id: 'x', anchor: css('.x'), mutations: [{ kind: 'sparkle' }] }] });
    check('an invented kind exits 1', (await cli(r, 'lint', bad)) === EXIT_PROBLEM && /^error: .*sparkle/m.test(r.out[0] ?? ''), r.out);
    const noHosts = writeFolder(path.join(tmp, 'lint-hosts'), { id: 'h', rules: [] });
    check('a missing match.hosts is an error', (await cli(r, 'lint', noHosts)) === EXIT_PROBLEM && /match\.hosts/.test(r.out[0] ?? ''));
    const numericHosts = writeFolder(path.join(tmp, 'lint-numeric-hosts'), { ...BASE_SPEC, match: { hosts: [42] } }, { markTracks: MARK });
    check('a non-string host is an error, as a headless session would refuse it', (await cli(r, 'lint', numericHosts)) === EXIT_PROBLEM
      && /match\.hosts/.test(r.out[0] ?? ''), r.out);

    const redirect = writeFolder(path.join(tmp, 'lint-redirect'), {
      ...BASE_SPEC,
      rules: [{ id: 'go', anchor: css('body'), mutations: [{ kind: 'redirect', from: '/a', to: '/b' }] }],
    });
    const plainCode = await cli(r, 'lint', redirect);
    check('a browser-only kind passes plain lint', plainCode === EXIT_OK, r.out);
    check('--headless reports it as an error', (await cli(r, 'lint', redirect, '--headless')) === EXIT_PROBLEM
      && /error: headless: .*redirect/.test(r.out[0] ?? ''), r.out);
    const fetches = writeFolder(path.join(tmp, 'lint-fetch'), {
      ...BASE_SPEC,
      rules: [{ id: 'f', anchor: css('.tracks'), mutations: [{ kind: 'script', handler: 'load' }] }],
    }, { load: 'module.exports = async function load({ api }) {\n  await api.fetch("https://x.test/a");\n};\n' });
    check('--headless warns on a handler using an unsupported member', (await cli(r, 'lint', fetches, '--headless')) === EXIT_OK
      && /warning: headless: .*fetch/.test(r.out[0] ?? ''), r.out);

    await cli(r, 'pack', dir);
    check('lint reads a .shim file too', (await cli(r, 'lint', `${dir}.shim`, '--json')) === EXIT_OK
      && (JSON.parse(r.out[0] ?? '{}') as Record<string, unknown>).kind === 'file');
    const notShim = path.join(tmp, 'not.shim');
    fs.writeFileSync(notShim, '{ nope');
    check('a file that isn\'t JSON exits 1', (await cli(r, 'lint', notShim)) === EXIT_PROBLEM && /not valid JSON/.test(r.out[0] ?? ''));
    check('a missing target exits 2', (await cli(r, 'lint', path.join(tmp, 'gone'))) === EXIT_USAGE);

    // The handler-module check pack runs: a `script` module that can't
    // export a function is a lint error too, for a folder and a .shim file.
    const badModules: Array<[string, string, RegExp]> = [
      ['a non-function export', 'module.exports = 42;\n', /handlers\/markTracks\.js/],
      ['invalid syntax', 'module.exports = function markTracks({ anchor ) {\n', /handlers\/markTracks\.js/],
    ];
    for (const [label, source, pattern] of badModules) {
      const slug = label.replace(/\W+/g, '-');
      const folder = writeFolder(path.join(tmp, `lint-module-${slug}`), BASE_SPEC, { markTracks: source });
      const packCode = await cli(r, 'pack', folder);
      check(`pack refuses ${label}`, packCode === EXIT_PROBLEM, r.err);
      check(`lint reports ${label} in a folder as an error`, (await cli(r, 'lint', folder)) === EXIT_PROBLEM
        && new RegExp(`^error: ${pattern.source}`, 'm').test(r.out[0] ?? ''), r.out);
      check(`lint --headless reports ${label} too`, (await cli(r, 'lint', folder, '--headless')) === EXIT_PROBLEM
        && new RegExp(`^error: ${pattern.source}`, 'm').test(r.out[0] ?? ''), r.out);
      const file = path.join(tmp, `lint-module-${slug}.shim`);
      fs.writeFileSync(file, json({ format: 'shim/1', name: 'demo', spec: BASE_SPEC, handlers: { markTracks: source } }));
      check(`lint reports ${label} in a .shim file as an error`, (await cli(r, 'lint', file)) === EXIT_PROBLEM
        && new RegExp(`^error: ${pattern.source}`, 'm').test(r.out[0] ?? ''), r.out);
    }
  }

  console.log('launch');
  {
    const r = rig();
    check('a failed launch exits 1 with the reason', (await cli(r, 'launch')) === EXIT_PROBLEM && /launch-unavailable/.test(r.err[0] ?? ''));
    r.launchOutcome = {
      ok: true, how: 'attached', detail: 'Shim 0.7.0 is running (pid 42)',
      info: { socketPath: '/tmp/shim.sock', token: 'secret-token', pid: 42, appVersion: '0.7.0', startedAt: 1 },
    };
    check('attaching exits 0', (await cli(r, 'launch')) === EXIT_OK && /^attached: Shim 0\.7\.0/.test(r.out[0] ?? ''));
    check('--timeout is seconds', (await cli(r, 'launch', '--timeout', '2.5')) === EXIT_OK && r.launches.at(-1)?.timeoutMs === 2500);
    check('a bad --timeout exits 2', (await cli(r, 'launch', '--timeout', 'soon')) === EXIT_USAGE);
    check('--json never prints the token', (await cli(r, 'launch', '--json')) === EXIT_OK
      && !(r.out[0] ?? '').includes('secret-token') && (JSON.parse(r.out[0] ?? '{}') as Record<string, unknown>).pid === 42);
    check('launch takes no arguments', (await cli(r, 'launch', 'now')) === EXIT_USAGE);
  }

  console.log('mcp');
  {
    const r = rig();
    check('mcp starts the server', (await cli(r, 'mcp')) === EXIT_OK && JSON.stringify(r.mcp.at(-1)) === '[]');
    check('--headless --visible pass through', (await cli(r, 'mcp', '--headless', '--visible')) === EXIT_OK
      && JSON.stringify(r.mcp.at(-1)) === '["--headless","--visible"]');
    check('anything else exits 2 without starting', (await cli(r, 'mcp', '--port', '1')) === EXIT_USAGE && r.mcp.length === 2);
    check('--attach passes through', (await cli(r, 'mcp', '--attach')) === EXIT_OK && JSON.stringify(r.mcp.at(-1)) === '["--attach"]');
    check('--attach with --headless exits 2 without starting', (await cli(r, 'mcp', '--attach', '--headless')) === EXIT_USAGE && r.mcp.length === 3);
    check('--target shim|chrome passes through', (await cli(r, 'mcp', '--target', 'chrome')) === EXIT_OK && JSON.stringify(r.mcp.at(-1)) === '["--target","chrome"]');
    check('a bad --target exits 2', (await cli(r, 'mcp', '--target', 'edge')) === EXIT_USAGE);
  }

  console.log('bridge and extension');
  {
    const r = rig();
    check('bridge runs the host', (await cli(r, 'bridge', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/')) === EXIT_OK && r.bridges === 1);
    check('bridge with a stray argument is a usage error', (await cli(r, 'bridge', 'now')) === EXIT_USAGE && r.bridges === 1);
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    check('install-host takes only a valid id', (await cli(r, 'extension', 'install-host', '--extension-id', 'nope')) === EXIT_USAGE);
    const chrome = path.join(r.home, 'Library', 'Application Support', 'Google', 'Chrome');
    fs.mkdirSync(chrome, { recursive: true });
    check('install-host writes the wrapper and a manifest for the browser that is there', (await cli(r, 'extension', 'install-host', '--extension-id', id)) === EXIT_OK
      && fs.existsSync(path.join(r.home, 'ud', 'bridge', 'shim-bridge'))
      && fs.readFileSync(path.join(chrome, 'NativeMessagingHosts', 'com.shimbrowser.bridge.json'), 'utf8').includes(id)
      && r.out.some((l) => /Chromium: not found/.test(l)) && r.out.some((l) => /let Claude Code author here/.test(l)), r.out.join('\n'));
    check('the wrapper execs the Node and bundle the context named', fs.readFileSync(path.join(r.home, 'ud', 'bridge', 'shim-bridge'), 'utf8').includes(`'/opt/node/bin/node' '/opt/shim/dist/shim.js' bridge`));
    check('--json reports the files', (await cli(r, 'extension', 'install-host', '--extension-id', id, '--json')) === EXIT_OK && (JSON.parse(r.out[0] ?? '{}') as { manifests: unknown[] }).manifests.length === 1);
    const custom = path.join(r.home, 'profile');
    check('--user-data-dir installs for one directory', (await cli(r, 'extension', 'install-host', '--extension-id', id, '--user-data-dir', custom)) === EXIT_OK && fs.existsSync(path.join(custom, 'NativeMessagingHosts', 'com.shimbrowser.bridge.json')));
    check('status reports the wrapper, the manifests and no bridge', (await cli(r, 'extension', 'status')) === EXIT_OK && r.out.some((l) => /wrapper: .*present/.test(l)) && r.out.some((l) => new RegExp(`Chrome: .*allows ${id}`).test(l)) && r.out.some((l) => /bridge: not running/.test(l)), r.out.join('\n'));
    fs.writeFileSync(path.join(r.home, 'ud', 'control-chrome.json'), JSON.stringify({ format: 'shim-control/1', host: 'chrome-extension', socketPath: '/s', token: 't', pid: 4242, appVersion: '0.7.0', startedAt: 1 }));
    check('status sees a bridge whose discovery file names a live process', (await cli(r, 'extension', 'status', '--json')) === EXIT_OK && (JSON.parse(r.out[0] ?? '{}') as { bridge: { up: boolean; pid: number } }).bridge.pid === 4242);
    const pinned = path.join(r.home, 'pinned-profile');
    check('with no --extension-id, install-host allows Shim for Chrome\'s own id', (await cli(r, 'extension', 'install-host', '--user-data-dir', pinned)) === EXIT_OK
      && fs.readFileSync(path.join(pinned, 'NativeMessagingHosts', 'com.shimbrowser.bridge.json'), 'utf8').includes(`chrome-extension://${SHIM_FOR_CHROME_ID}/`));
    check('an unknown subcommand is a usage error', (await cli(r, 'extension', 'frobnicate')) === EXIT_USAGE);
  }

  console.log('preview');
  {
    const tempBefore = tempPreviewDirs();
    const r = rig();
    const dir = writeFolder(path.join(tmp, 'preview'), BASE_SPEC, { markTracks: MARK });
    const shot = path.join(tmp, 'shots', 'page.png');
    const code = await cli(r, 'preview', dir, '--url', 'https://site.test/tracks', '--screenshot', shot, '--json');
    const o = JSON.parse(r.out[0] ?? '{}') as { ok?: boolean; applied?: boolean; evidence?: { rules?: Array<{ ruleId: string; verification: string }> }; screenshot?: { file?: string } };
    check('a clean preview exits 0', code === EXIT_OK, r.out);
    check('every rule is in the evidence, verified full', o.ok === true && o.applied === true
      && JSON.stringify((o.evidence?.rules ?? []).map((x) => `${x.ruleId}:${x.verification}`)) === '["hide-promo:full","mark:full"]', o);
    const page = r.pages[0];
    check('the handler reached the page inlined', page?.applied.some((p) => p.rule.id === 'mark' && typeof p.rule.handlers?.markTracks === 'string') === true);
    check('the screenshot was written', o.screenshot?.file === shot && fs.existsSync(shot) && page?.shots[0]?.file === shot);
    check('the page is closed afterwards', page?.closed === true);
    check('no temp files are left behind', JSON.stringify(tempPreviewDirs()) === JSON.stringify(tempBefore), tempPreviewDirs());

    // A screenshot path the CLI can't write exits 2 (like pack / unpack);
    // a capture the page can't make stays a preview problem (exit 1).
    const blocker = path.join(tmp, 'shots-blocker');
    fs.writeFileSync(blocker, 'a file, not a folder');
    check('a screenshot whose folder cannot be created exits 2',
      (await cli(r, 'preview', dir, '--url', 'https://site.test/tracks', '--screenshot', path.join(blocker, 'page.png'))) === EXIT_USAGE
      && /could not write/.test(r.err.join('\n')), r.err);
    r.shotError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    check('a screenshot file the CLI cannot write exits 2',
      (await cli(r, 'preview', dir, '--url', 'https://site.test/tracks', '--screenshot', shot)) === EXIT_USAGE, r.err);
    r.shotError = new Error('no element matches .missing');
    check('a capture the page cannot make exits 1',
      (await cli(r, 'preview', dir, '--url', 'https://site.test/tracks', '--screenshot', shot, '--selector', '.missing')) === EXIT_PROBLEM, r.out);
    r.shotError = null;

    const textCode = await cli(r, 'preview', dir, '--url', 'https://site.test/tracks');
    check('the text report lists each rule', textCode === EXIT_OK && /hide-promo \[full\]: matched 1/.test(r.out[0] ?? '') && /^ {4}mark \[full\]/m.test(r.out[0] ?? ''), r.out);

    r.onApply = (p, emit) => {
      if (p.rule.id === 'mark') emit({ kind: 'handler-error', specId: p.ruleKey, ruleId: p.rule.id, handlerName: 'markTracks', message: 'boom', stack: 'Error: boom\n    at markTracks' });
      else emit({ kind: 'rule-no-match', specId: p.ruleKey, ruleId: p.rule.id, selector: '.promo' });
    };
    check('handler errors and no-match exit 1', (await cli(r, 'preview', dir, '--url', 'https://site.test/tracks')) === EXIT_PROBLEM
      && /handler errors:\n {4}mark \(markTracks\): boom/.test(r.out[0] ?? '') && /no match:\n {4}hide-promo \(\.promo\)/.test(r.out[0] ?? ''), r.out);
    r.onApply = matchOne;

    const unsupported = writeFolder(path.join(tmp, 'preview-redirect'), {
      ...BASE_SPEC,
      rules: [{ id: 'go', anchor: css('body'), mutations: [{ kind: 'redirect', from: '/a', to: '/b' }] }],
    });
    const before = r.pages.length;
    check('an unsupported kind exits 1, nothing applied', (await cli(r, 'preview', unsupported, '--url', 'https://site.test/')) === EXIT_PROBLEM
      && /nothing applied: unsupported/.test(r.out[0] ?? '') && (r.pages[before]?.applied.length ?? 0) === 0, r.out);
    const declares = writeFolder(path.join(tmp, 'preview-ai'), { ...BASE_SPEC, rules: [], permissions: ['ai'] });
    check('an unsupported declaration is refused before a page opens', (await cli(r, 'preview', declares, '--url', 'https://site.test/')) === EXIT_PROBLEM
      && /unsupported/.test(r.out[0] ?? '') && r.pages.length === before + 1, r.out);

    const empty = writeFolder(path.join(tmp, 'preview-empty'), { ...BASE_SPEC, rules: [] });
    check('a folder with no rules exits 0 and says so', (await cli(r, 'preview', empty, '--url', 'https://site.test/')) === EXIT_OK
      && /no rules/.test(r.out[0] ?? ''), r.out);

    const other = await cli(r, 'preview', dir, '--url', 'https://elsewhere.test/');
    check('a url outside match.hosts is a warning, not a failure', other === EXIT_OK && /warning: .*doesn't include elsewhere\.test/.test(r.out[0] ?? ''), r.out);

    check('a non-http url exits 2', (await cli(r, 'preview', dir, '--url', 'file:///etc/hosts')) === EXIT_USAGE);
    const savedTmp = process.env.TMPDIR;
    const notATempDir = path.join(tmp, 'tmp-is-a-file');
    fs.writeFileSync(notATempDir, 'x');
    process.env.TMPDIR = notATempDir;
    let tmpCode: number;
    try {
      tmpCode = await cli(r, 'preview', dir, '--url', 'https://site.test/');
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
    }
    check('a temp folder it cannot create exits 2 (write-failed)', tmpCode === EXIT_USAGE && /write-failed/.test(r.err[0] ?? ''), r.err);
    check('a malformed folder exits 1', (await cli(r, 'preview', path.join(tmp, 'broken'), '--url', 'https://site.test/')) === EXIT_PROBLEM);
    const opened = r.pages.length;
    const hostless = writeFolder(path.join(tmp, 'preview-hostless'), { id: 'demo-tracks', rules: BASE_SPEC.rules }, { markTracks: MARK });
    check('a folder without match.hosts exits 1 before a page opens, as pack does', (await cli(r, 'preview', hostless, '--url', 'https://site.test/')) === EXIT_PROBLEM
      && /match\.hosts/.test(r.err.join('\n')) && r.pages.length === opened, r.err);
    const linty = writeFolder(path.join(tmp, 'preview-lint'), { ...BASE_SPEC, rules: [{ id: 'x', anchor: css('.x'), mutations: [{ kind: 'sparkle' }] }] });
    check('a spec-lint error exits 1 before a page opens', (await cli(r, 'preview', linty, '--url', 'https://site.test/')) === EXIT_PROBLEM
      && /sparkle/.test(r.err.join('\n')) && r.pages.length === opened, r.err);

    // An unpacked folder: .shim-state.json keeps each rule's witness.
    const witnessed = {
      format: 'shim/1',
      name: 'Demo tracks',
      spec: {
        ...BASE_SPEC,
        version: 4,
        bundleHash: 'deploy-1',
        rules: [
          { id: 'hide-promo', anchor: { ...css('.promo'), witness: { v: 1, tag: 'div', cls: ['promo'] } }, mutations: [{ kind: 'hide' }] },
          { id: 'mark', anchor: { ...css('.tracks'), witness: { v: 1, tag: 'ul' } }, mutations: [{ kind: 'script', handler: 'markTracks' }] },
        ],
      },
      handlers: { markTracks: MARK },
    };
    const witnessedFile = path.join(tmp, 'witnessed.shim');
    fs.writeFileSync(witnessedFile, json(witnessed));
    await cli(r, 'unpack', witnessedFile);
    const wdir = path.join(tmp, 'witnessed');
    const wspec = readJson(path.join(wdir, 'shim.json')) as { rules: Array<{ id: string; anchor: unknown }> };
    const wmark = wspec.rules.find((x) => x.id === 'mark');
    if (wmark) wmark.anchor = css('ul.tracks');
    fs.writeFileSync(path.join(wdir, 'shim.json'), json(wspec));
    // The engine quarantines a rule whose witness no longer verifies.
    r.onApply = (p, emit) => {
      if (p.rule.anchor?.witness) emit({ kind: 'rule-quarantined', specId: p.ruleKey, ruleId: p.rule.id, selector: '.promo' });
      else matchOne(p, emit);
    };
    const wcode = await cli(r, 'preview', wdir, '--url', 'https://site.test/');
    const wpage = r.pages.at(-1);
    const sent = (id: string): PreviewRule | undefined => wpage?.applied.find((p) => p.rule.id === id);
    check('an unchanged anchor previews with its saved witness and the deploy baseline', stableStringify(sent('hide-promo')?.rule.anchor?.witness)
      === stableStringify({ v: 1, tag: 'div', cls: ['promo'] }) && sent('hide-promo')?.bundleHash === 'deploy-1', wpage?.applied);
    check('a changed anchor previews without one', sent('mark') !== undefined && sent('mark')?.rule.anchor?.witness === undefined
      && sent('mark')?.bundleHash === undefined);
    check('the witness that no longer verifies quarantines: exit 1', wcode === EXIT_PROBLEM && /quarantined[^\n]*\n {4}hide-promo/.test(r.out[0] ?? ''), r.out);

    // Witness-less rules (a multi-match rule never captures one): the state's
    // anchors say which are unchanged since the commit.
    const rowsFile = path.join(tmp, 'rows.shim');
    fs.writeFileSync(rowsFile, json({
      format: 'shim/1',
      name: 'Rows',
      spec: {
        ...BASE_SPEC,
        version: 2,
        bundleHash: 'deploy-1',
        rules: [
          { id: 'rows', anchor: { primary: { kind: 'css', value: '.track' }, fallbacks: [{ kind: 'css', value: '[data-track]' }] }, mutations: [{ kind: 'restyle', properties: { color: 'red' } }] },
          { id: 'moved', anchor: css('.old-row'), mutations: [{ kind: 'hide' }] },
        ],
      },
      handlers: {},
    }));
    await cli(r, 'unpack', rowsFile);
    const rdir = path.join(tmp, 'rows');
    const rspec = readJson(path.join(rdir, 'shim.json')) as { rules: Array<{ id: string; anchor: unknown }> };
    const moved = rspec.rules.find((x) => x.id === 'moved');
    if (moved) moved.anchor = css('.new-row');
    fs.writeFileSync(path.join(rdir, 'shim.json'), json(rspec));
    r.onApply = matchOne;
    await cli(r, 'preview', rdir, '--url', 'https://site.test/');
    const rpage = r.pages.at(-1);
    const rsent = (id: string): PreviewRule | undefined => rpage?.applied.find((p) => p.rule.id === id);
    check('an unchanged witness-less rule previews behind the deploy baseline', rsent('rows')?.bundleHash === 'deploy-1', rpage?.applied);
    check('a re-anchored witness-less rule previews behind none', rsent('moved') !== undefined && rsent('moved')?.bundleHash === undefined, rpage?.applied);
    const rstate = readJson(path.join(rdir, '.shim-state.json')) as Record<string, unknown>;
    delete rstate.anchors;
    fs.writeFileSync(path.join(rdir, '.shim-state.json'), json(rstate));
    await cli(r, 'preview', rdir, '--url', 'https://site.test/');
    check('an older state file without anchors previews witness-less rules behind none, as before',
      r.pages.at(-1)?.applied.find((p) => p.rule.id === 'rows')?.bundleHash === undefined, r.pages.at(-1)?.applied);
    // A saved witness the engine refuses before its quarantine is reported:
    // the selector now resolves, the witness filters it to zero, and the
    // reconciler's quarantine lands after the session settles. No error, no
    // no-match, no quarantine yet: the preview still fails.
    r.onApply = (p, emit) => {
      if (p.rule.anchor?.witness) emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: 0, matchedVia: 'primary' });
      else matchOne(p, emit);
    };
    const early = await cli(r, 'preview', wdir, '--url', 'https://site.test/', '--json');
    const eo = JSON.parse(r.out[0] ?? '{}') as { ok?: boolean; unapplied?: string[]; evidence?: { quarantined?: unknown } };
    check('a rule that matched nothing, quarantine not yet reported, exits 1', early === EXIT_PROBLEM && eo.ok === false
      && JSON.stringify(eo.unapplied) === '["hide-promo"]' && eo.evidence?.quarantined === undefined, r.out);
    check('the text report names it', (await cli(r, 'preview', wdir, '--url', 'https://site.test/')) === EXIT_PROBLEM
      && /not applied[^\n]*\n {4}hide-promo/.test(r.out[0] ?? ''), r.out);
    // No status at all for a rule is not success either.
    r.onApply = (p, emit) => { if (p.rule.id !== 'mark') matchOne(p, emit); };
    check('a rule the engine never reported on exits 1', (await cli(r, 'preview', dir, '--url', 'https://site.test/')) === EXIT_PROBLEM
      && /not applied[^\n]*\n {4}mark/.test(r.out[0] ?? ''), r.out);
    // A rule that matched once (a remove, say) then dropped to 0 did apply.
    r.onApply = (p, emit) => {
      matchOne(p, emit);
      emit({ kind: 'rule-status', specId: p.ruleKey, ruleId: p.rule.id, matched: 0, matchedVia: 'primary' });
    };
    check('a rule that matched and then lost its element still counts as applied', (await cli(r, 'preview', dir, '--url', 'https://site.test/')) === EXIT_OK, r.out);
    r.onApply = matchOne;

    const storageFile = path.join(tmp, 'store.json');
    await cli(r, 'preview', dir, '--url', 'https://site.test/', '--storage', storageFile);
    const storage = r.storages.at(-1);
    await storage?.set({ patchId: 'demo-tracks', origin: 'https://site.test' }, 'k', 1);
    check('--storage backs api.storage with that file', fs.existsSync(storageFile)
      && (readJson(storageFile).format === 'shim-headless-storage/1'));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall shim CLI checks passed');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
