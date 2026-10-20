// What the `shim` command does (shim-cli.ts parses the command line and calls
// these). Every one works on files the user named, in the user's own process;
// none talks to the Shim browser except `launch` (shim-cli.ts).
//
//   packFolder     shim folder → `.shim` file (@shimbrowser/core packShim:
//                  witnesses restored from .shim-state.json while their
//                  anchors are unchanged, then spec-lint)
//   unpackFile     `.shim` file → shim folder with .shim-state.json (unpackShim)
//   lintTarget     a folder or a `.shim` file → spec-lint's errors and warnings;
//                  `headless` adds the D15 preflight and source scan
//   previewFolder  a folder against a url, headless: a fresh Chromium, the
//                  folder's rules (with their .shim-state.json witnesses)
//                  applied through the same headless session a
//                  `shim-mcp --headless` agent drives, the evidence (D11) and
//                  optionally a screenshot. Nothing is committed and nothing
//                  of the session is kept.
//
// The folder rules are the MCP server's (folder.ts): hidden files are not
// part of a working copy, and writing a folder (unpack) only replaces an
// empty folder or an earlier shim folder.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  packShim, unpackShim, readShimFolder, matchHostsProblem, scriptModuleProblems, ShimFolderError, SHIM_STATE_FILE, SHIM_FILE_FORMAT,
  type FolderInput, type ShimFile, type RuleState, type SetWitnessState,
} from '@shimbrowser/core/shim-folder';
import { lintSpec } from '@shimbrowser/core/spec-lint';
import { preflightSpec, scanRuleHandlers } from '@shimbrowser/core/capability-preflight';
import { encodeWorkingCopy } from '@shimbrowser/core/working-copy-wire';
import { previewKey } from '@shimbrowser/core/preview-evidence';
import type { Spec } from '@shimbrowser/core/types';
import { readWorkingCopy, writeCheckout, FolderError } from './folder';
import { createHeadlessControl } from './headless-control';
import type { HeadlessSessionPage } from './headless-session';
import { HEADLESS_CAPABILITIES, REQUIRES_SHIM_BROWSER, type HeadlessStorage } from './playwright-page-host';

/** A command that could not do its job: a stable code, a message, and every problem found. */
export class CliError extends Error {
  readonly code: string;
  readonly problems: string[];
  constructor(code: string, message: string, problems: string[] = []) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.problems = problems;
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Node's errno codes for a path that can't be written. A screenshot that
// fails for any other reason (no such selector, page closed) is not one.
const FILE_SYSTEM_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EISDIR', 'ENOTDIR', 'ENOENT', 'ENAMETOOLONG', 'EEXIST']);

function isFileSystemError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null || !('code' in e)) return false;
  const code: unknown = e.code;
  return typeof code === 'string' && FILE_SYSTEM_CODES.has(code);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// FolderError / ShimFolderError → CliError, everything else rethrown.
function asCliError(e: unknown): never {
  if (e instanceof ShimFolderError) throw new CliError(e.code, e.code === 'spec-lint' ? 'spec-lint found errors' : 'not a valid shim', e.problems);
  if (e instanceof FolderError) throw new CliError(e.code, e.message);
  throw e;
}

// A path as one shell word, so a suggested command still runs when pasted:
// bare when it holds only safe characters, else single-quoted ('\'' for a quote).
export function shellQuote(p: string): string {
  return /^[A-Za-z0-9_/.,:@%+=-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}

// What a path handed to the wrong command actually is, so the refusal can name
// the command that takes it: a `.shim` file (it carries a `format`), a shim
// folder's shim.json (a spec: rules and no format), or a folder.
type InputKind = 'folder' | 'shim-file' | 'spec' | 'other';

const SNIFF_MAX_BYTES = 8 * 1024 * 1024;

function sniffInput(abs: string): InputKind {
  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) return 'folder';
    if (!st.isFile() || st.size > SNIFF_MAX_BYTES) return 'other';
    const parsed: unknown = JSON.parse(fs.readFileSync(abs, 'utf8'));
    if (!isRecord(parsed)) return 'other';
    if (typeof parsed.format === 'string') return 'shim-file';
    return Array.isArray(parsed.rules) ? 'spec' : 'other';
  } catch {
    return 'other';
  }
}

// One line pointing at the command that takes `abs`, or '' when it is neither
// a `.shim` file nor a folder's shim.json.
function wrongInputHint(abs: string): string {
  const kind = sniffInput(abs);
  if (kind === 'shim-file') return ` It is a .shim file; to turn it into a shim folder, run: shim unpack ${shellQuote(abs)}`;
  if (kind === 'spec') return ` It is a shim folder's shim.json; pass the folder instead: ${shellQuote(path.dirname(abs))}`;
  return '';
}

function requireFolder(dir: string): string {
  const abs = path.resolve(dir);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new CliError('folder-missing', `${abs} does not exist`);
  }
  if (!st.isDirectory()) throw new CliError('folder-missing', `${abs} is not a folder.${wrongInputHint(abs)}`);
  return abs;
}

// A file the user named, written whole or not at all. A filesystem failure
// (unwritable folder, full disk, a failed rename) is the user's environment,
// not the shim: a CliError ('write-failed'), so it exits 2 like an unreadable
// file rather than 1.
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* the folder itself is the problem */ }
    throw new CliError('write-failed', `could not write ${file}: ${errMessage(e)}`);
  }
}

/** A shim folder as `pack` needs it: the working copy plus the tool-managed .shim-state.json. */
export function readFolderWithState(dir: string): FolderInput {
  const abs = requireFolder(dir);
  let files: FolderInput;
  try {
    files = readWorkingCopy(abs);
  } catch (e) {
    // A refused folder keeps its own code; anything else (an unreadable
    // file or subfolder) is the user's environment, so it exits 2.
    if (e instanceof FolderError || e instanceof ShimFolderError) asCliError(e);
    throw new CliError('read-failed', `could not read ${abs}: ${errMessage(e)}`);
  }
  const statePath = path.join(abs, SHIM_STATE_FILE);
  if (fs.existsSync(statePath)) {
    try {
      files[SHIM_STATE_FILE] = fs.readFileSync(statePath, 'utf8');
    } catch (e) {
      throw new CliError('file-missing', `could not read ${statePath}: ${errMessage(e)}`);
    }
  }
  return files;
}

/** `<folder>.shim` beside the folder. */
export function defaultShimFileFor(dir: string): string {
  return `${path.resolve(dir)}.shim`;
}

/** The folder a `.shim` unpacks into by default: its path without the extension. */
export function defaultFolderFor(file: string): string {
  const abs = path.resolve(file);
  // The basename, not the resolved path: a file literally named `.shim` has
  // no stem, and stripping the extension from its path would unpack into
  // its parent folder (the current directory, say).
  const base = path.basename(abs);
  if (!base.endsWith('.shim') || base.length === '.shim'.length) {
    throw new CliError('invalid-arguments', `${abs} has no .shim extension: name the folder to unpack into with --out`);
  }
  return abs.slice(0, -'.shim'.length);
}

export interface PackResult {
  file: string;
  shim: ShimFile;
}

/** Pack a shim folder into a `shim/1` file (`out`, default `<folder>.shim`). */
export function packFolder(dir: string, out?: string): PackResult {
  const files = readFolderWithState(dir);
  let shim: ShimFile;
  try {
    shim = packShim(files);
  } catch (e) {
    asCliError(e);
  }
  const file = out ? path.resolve(out) : defaultShimFileFor(dir);
  writeAtomic(file, `${JSON.stringify(shim, null, 2)}\n`);
  return { file, shim };
}

export interface UnpackResult {
  dir: string;
  written: string[];
  removed: string[];
}

function readText(file: string): string {
  const abs = path.resolve(file);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (e) {
    throw new CliError('file-missing', `could not read ${abs}: ${errMessage(e)}`);
  }
}

/** Unpack a `shim/1` file into a folder (`out`, default the file's path without `.shim`). */
export function unpackFile(file: string, out?: string): UnpackResult {
  // A folder, or a folder's shim.json, is what `pack` takes: say so instead of
  // a format error about a file that was never meant to be a `.shim`.
  const abs = path.resolve(file);
  const kind = sniffInput(abs);
  if (kind === 'folder') {
    throw new CliError('invalid-arguments', `${abs} is a folder; unpack takes a .shim file. To make one from a shim folder, run: shim pack ${shellQuote(abs)}`);
  }
  if (kind === 'spec') {
    throw new CliError('invalid-arguments',
      `${abs} is a shim folder's shim.json, not a .shim file. To make a .shim file from its folder, run: shim pack ${shellQuote(path.dirname(abs))}`);
  }
  const text = readText(file);
  const dir = out ? path.resolve(out) : defaultFolderFor(file);
  let files: FolderInput;
  try {
    files = unpackShim(text);
  } catch (e) {
    asCliError(e);
  }
  try {
    return writeCheckout(dir, files);
  } catch (e) {
    // A refused folder (not a working copy, a symlink) is the user's
    // arguments; any other failure (unwritable folder, full disk, a stale
    // handler that won't delete) is their environment. Both exit 2.
    if (e instanceof FolderError && e.code === 'not-a-working-copy' && isDirectory(dir)) {
      // Why, and what to do: unpack replaces the folder's shim files (and
      // deletes handlers the file doesn't carry), so it never mixes into a
      // folder of something else.
      const stem = path.basename(abs).replace(/\.shim$/, '') || 'shim';
      throw new CliError('not-a-working-copy',
        `${dir} already holds other files and no shim.json. unpack writes a whole shim folder and removes handlers the file `
        + `doesn't carry, so it only writes into an empty folder or one it unpacked before. Name a new folder, e.g. --out ${shellQuote(path.join(dir, stem))}`);
    }
    if (e instanceof FolderError || e instanceof ShimFolderError) asCliError(e);
    throw new CliError('write-failed', `could not write ${dir}: ${errMessage(e)}`);
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface LintReport {
  target: string;
  kind: 'folder' | 'file';
  errors: string[];
  warnings: string[];
}

/**
 * Lint a shim folder or a `.shim` file: the folder format, `match.hosts`,
 * spec-lint and the `script` handler modules — exactly what `pack` (and a
 * preview) would refuse — plus
 * spec-lint's warnings. With `headless`, also D15's preflight (as errors: a
 * headless preview would apply nothing) and its handler source scan (as
 * warnings: a heuristic).
 */
export function lintTarget(target: string, opts: { headless?: boolean } = {}): LintReport {
  const abs = path.resolve(target);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new CliError('file-missing', `${abs} does not exist`);
  }
  const kind: LintReport['kind'] = st.isDirectory() ? 'folder' : 'file';
  if (kind === 'file' && sniffInput(abs) === 'spec') {
    throw new CliError('invalid-arguments',
      `${abs} is a shim folder's shim.json; lint takes the folder or a .shim file. Run: shim lint ${shellQuote(path.dirname(abs))}`);
  }
  const report: LintReport = { target: abs, kind, errors: [], warnings: [] };
  let folder: FolderInput;
  if (kind === 'folder') {
    folder = readFolderWithState(abs);
  } else {
    try {
      folder = unpackShim(readText(abs));
    } catch (e) {
      if (!(e instanceof ShimFolderError)) throw e;
      report.errors.push(...e.problems);
      return report;
    }
  }
  let spec: Spec;
  let handlers: Record<string, string>;
  try {
    ({ spec, handlers } = readShimFolder(folder));
  } catch (e) {
    if (!(e instanceof ShimFolderError)) throw e;
    report.errors.push(...e.problems);
    return report;
  }
  const hostsProblem = matchHostsProblem(spec);
  if (hostsProblem) report.errors.push(hostsProblem);
  // The handler modules ride as the spec-level map, as pack lints them.
  const lint = lintSpec({ ...spec, handlers });
  report.errors.push(...lint.errors);
  report.warnings.push(...lint.warnings);
  // The handler-module check pack runs after spec-lint (a `script` module
  // that can't export a function), so lint blesses nothing pack refuses.
  report.errors.push(...scriptModuleProblems(spec, handlers));
  if (opts.headless) {
    const pre = preflightSpec(spec, HEADLESS_CAPABILITIES);
    if (!pre.ok) report.errors.push(...pre.unsupported.map((u) => `headless: ${u.message}`));
    const scan = scanRuleHandlers(spec.rules || [], HEADLESS_CAPABILITIES, handlers, REQUIRES_SHIM_BROWSER);
    report.warnings.push(...scan.map((f) => `headless: ${f.message}`));
  }
  return report;
}

// --- preview --------------------------------------------------------------------

/** A page `shim preview` drives: a headless session page that can also save a screenshot. */
export interface PreviewPage extends HeadlessSessionPage {
  screenshot(file: string, opts: { selector?: string; fullPage?: boolean }): Promise<void>;
}

export interface PreviewDeps {
  version: string;
  /** A fresh page that has loaded `url`, its api.storage backed by `storage`. Throws when it can't. */
  openPage(url: string, storage: HeadlessStorage, opts: { visible: boolean }): Promise<PreviewPage>;
  /** How long the page gets to react before the evidence is read (default: the session's). */
  settleMs?: number;
  /**
   * Called once the preview has settled and its evidence is read, before the
   * screenshot and before the page closes: a caller inspecting the previewed
   * page (its own checks, input) does it here. A throw ends the preview.
   */
  whileOpen?(page: PreviewPage): Promise<void>;
}

export interface PreviewOptions {
  dir: string;
  url: string;
  /** Save the page (after the preview settles) as this PNG / JPEG. */
  screenshot?: string;
  /** Only this element (the first match). */
  selector?: string;
  fullPage?: boolean;
  visible?: boolean;
  /** The api.storage file to use (format shim-headless-storage/1). Default: a throwaway one. */
  storageFile?: string;
}

export interface PreviewOutcome {
  /** The preview applied, and nothing in its evidence needs fixing. */
  ok: boolean;
  /** The preview reached the page. */
  applied: boolean;
  url: string;
  /** Why nothing was applied (a refusal code), when it wasn't. */
  error?: string;
  detail?: string;
  /** The preview's evidence (D11), as a headless session returns it. */
  evidence?: Record<string, unknown>;
  /** Opening the session: e.g. match.hosts doesn't cover the url. */
  warnings: string[];
  /**
   * Rules the engine never reported on any element during the preview, and
   * that no other evidence (noMatch, quarantined) already names. A preview
   * with any is not ok.
   */
  unapplied?: string[];
  screenshot?: { file: string } | { error: string };
}

function listOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Preview a shim folder on `url` in a fresh headless Chromium.
 *
 * The folder must pack (the folder format, `match.hosts`, spec-lint): a
 * preview never blesses what `shim pack` would refuse. The session starts
 * from the packed spec with no rules (written to a throwaway `.shim`), so the
 * preview adds every rule and the evidence covers all of them; each rule
 * whose anchor is unchanged gets back the witness .shim-state.json kept for
 * it (and the spec its bundleHash), so a selector that now lands on the wrong
 * element quarantines as it would in Shim instead of being re-fingerprinted.
 * A rule whose anchor still matches its committed digest (a witness's, or
 * for a rule with none, the state's `anchors`) runs behind that bundleHash,
 * as the committed shim does; an edited anchor runs behind none.
 * The page closes and the throwaway file is removed before this resolves.
 */
export async function previewFolder(opts: PreviewOptions, deps: PreviewDeps): Promise<PreviewOutcome> {
  const withState = readFolderWithState(opts.dir);
  let packed: ShimFile;
  let seedWitnesses: Record<string, RuleState> | undefined;
  let seedAnchors: Record<string, string> | undefined;
  let seedSetWitnesses: Record<string, SetWitnessState> | undefined;
  try {
    packed = packShim(withState);
    const state = readShimFolder(withState).state;
    seedWitnesses = state?.rules;
    seedAnchors = state?.anchors;
    seedSetWitnesses = state?.setWitnesses;
  } catch (e) {
    asCliError(e);
  }
  // The working copy the session diffs: the folder without the tool-managed state.
  const files: FolderInput = { ...withState };
  delete files[SHIM_STATE_FILE];
  const spec: Spec = packed.spec;
  let parsed: URL;
  try {
    parsed = new URL(opts.url);
  } catch {
    throw new CliError('invalid-arguments', `"${opts.url}" is not a url: pass an http(s) url`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError('invalid-arguments', `"${opts.url}" is not an http(s) url`);
  }

  // The throwaway file the session opens. A temp folder that can't be made
  // or written is the user's environment (exit 2), and is never left behind.
  let tmp: string;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-preview-'));
  } catch (e) {
    throw new CliError('write-failed', `could not create a temporary folder in ${os.tmpdir()}: ${errMessage(e)}`);
  }
  const removeTmp = (): void => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort: it is in the temp folder */ }
  };
  const shimFile = path.join(tmp, 'preview.shim');
  const base = { ...JSON.parse(JSON.stringify(spec)) as Spec, rules: [] };
  try {
    fs.writeFileSync(shimFile, JSON.stringify({ format: SHIM_FILE_FORMAT, name: packed.name, spec: base, handlers: {} }));
  } catch (e) {
    removeTmp();
    throw new CliError('write-failed', `could not write ${shimFile}: ${errMessage(e)}`);
  }

  // Set by openPage below; a holder, so the narrowing survives the awaits.
  const held: { page: PreviewPage | null } = { page: null };
  // The most elements each rule's anchor resolved, from the engine's own
  // rule-status events. Success needs positive evidence: the evidence lists
  // a no-match or a quarantine only once the engine reports one, and a saved
  // witness's quarantine lands after the session has already settled (the
  // reconciler waits for the page to settle first). A rule that never
  // reported a match did not apply, whatever the lists say.
  const peakMatched = new Map<string, number>();
  const storageFile = opts.storageFile ? path.resolve(opts.storageFile) : null;
  const control = createHeadlessControl({
    version: deps.version,
    async openPage(url, storage) {
      const page = await deps.openPage(url, storage, { visible: opts.visible === true });
      held.page = page;
      // Live for the page's life; closeAll closes the page.
      page.host.onRuntimeEvent((e) => {
        if (e.kind !== 'rule-status' || typeof e.specId !== 'string' || typeof e.matched !== 'number') return;
        peakMatched.set(e.specId, Math.max(peakMatched.get(e.specId) ?? 0, e.matched));
      });
      return page;
    },
    ...(storageFile ? { storageFileFor: () => storageFile } : {}),
    backend: {
      ...(deps.settleMs !== undefined ? { settleMs: deps.settleMs } : {}),
      ...(seedWitnesses ? { seedWitnesses } : {}),
      ...(seedAnchors ? { seedAnchors } : {}),
      ...(seedSetWitnesses ? { seedSetWitnesses } : {}),
    },
  });

  const outcome: PreviewOutcome = { ok: false, applied: false, url: parsed.href, warnings: [] };
  try {
    const opened = (await control.request('POST', '/sessions', {
      kind: 'shim',
      target: { url: parsed.href },
      shimFile,
      agent: 'shim CLI',
      intent: 'shim preview',
    })).body;
    if (opened.ok !== true) {
      outcome.error = typeof opened.error === 'string' ? opened.error : 'open-failed';
      if (typeof opened.detail === 'string') outcome.detail = opened.detail;
      return outcome;
    }
    const sessionId = String(opened.sessionId);
    if (typeof opened.url === 'string') outcome.url = opened.url;
    outcome.warnings.push(...listOf(opened.warnings).filter((w): w is string => typeof w === 'string'));

    const reply = (await control.request('POST', `/sessions/${encodeURIComponent(sessionId)}/preview`, {
      workingCopy: encodeWorkingCopy(files),
    })).body;
    if (reply.ok !== true) {
      outcome.error = typeof reply.error === 'string' ? reply.error : 'preview-failed';
      if (typeof reply.detail === 'string') outcome.detail = reply.detail;
      return outcome;
    }
    const evidence = isRecord(reply.evidence) ? reply.evidence : {};
    outcome.evidence = evidence;
    outcome.applied = reply.applied === true;
    if (!outcome.applied) {
      if (evidence.unchanged === true) {
        // A folder with no rules: nothing to apply, nothing wrong.
        outcome.ok = true;
      } else {
        outcome.error = typeof evidence.error === 'string' ? evidence.error : evidence.rejected !== undefined ? 'spec-lint' : 'not-applied';
        const why = typeof evidence.detail === 'string' ? evidence.detail : typeof evidence.rejected === 'string' ? evidence.rejected : undefined;
        if (why !== undefined) outcome.detail = why;
      }
    } else {
      const named = new Set([...listOf(evidence.noMatch), ...listOf(evidence.quarantined)]
        .filter(isRecord).map((x) => x.ruleId));
      const unapplied = (spec.rules || [])
        .filter((rule) => (peakMatched.get(previewKey(spec.id, rule.id)) ?? 0) === 0 && !named.has(rule.id))
        .map((rule) => rule.id);
      if (unapplied.length) outcome.unapplied = unapplied;
      outcome.ok = listOf(evidence.errors).length === 0
        && listOf(evidence.noMatch).length === 0
        && listOf(evidence.quarantined).length === 0
        && unapplied.length === 0;
    }

    const current = held.page;
    if (deps.whileOpen && current) await deps.whileOpen(current);
    if (opts.screenshot && current) {
      const file = path.resolve(opts.screenshot);
      // A file the CLI can't write is a usage problem (exit 2), like pack and
      // unpack; a page or selector that can't be captured is a preview
      // problem (exit 1).
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      } catch (e) {
        throw new CliError('write-failed', `could not write ${file}: ${errMessage(e)}`);
      }
      try {
        await current.screenshot(file, {
          ...(opts.selector ? { selector: opts.selector } : {}),
          ...(opts.fullPage ? { fullPage: true } : {}),
        });
        outcome.screenshot = { file };
      } catch (e) {
        if (isFileSystemError(e)) throw new CliError('write-failed', `could not write ${file}: ${errMessage(e)}`);
        outcome.screenshot = { error: errMessage(e) };
        outcome.ok = false;
      }
    }
    return outcome;
  } finally {
    await control.closeAll();
    removeTmp();
  }
}

function indent(text: string, by = '    '): string {
  return text.split('\n').map((line) => `${by}${line}`).join('\n');
}

/** A preview outcome for a terminal. */
export function formatPreview(o: PreviewOutcome): string {
  const lines: string[] = [`preview of ${o.url}`];
  for (const w of o.warnings) lines.push(`  warning: ${w}`);
  const ev = o.evidence ?? {};
  if (o.error) {
    lines.push(`  nothing applied: ${o.error}${o.detail ? `\n${indent(o.detail)}` : ''}`);
    for (const p of listOf(ev.problems)) lines.push(`    - ${String(p)}`);
    for (const u of listOf(ev.unsupported)) lines.push(`    - ${String(u)}`);
  } else if (!o.applied) {
    lines.push('  the folder has no rules: nothing to apply');
  }
  const rules = listOf(ev.rules).filter(isRecord);
  if (rules.length) {
    lines.push('  rules:');
    for (const r of rules) lines.push(`    ${String(r.ruleId)} [${String(r.verification)}]: ${String(r.status)}`);
  }
  const errors = listOf(ev.errors).filter(isRecord);
  if (errors.length) {
    lines.push('  handler errors:');
    for (const e of errors) {
      lines.push(`    ${String(e.ruleId)}${e.handler ? ` (${String(e.handler)})` : ''}: ${String(e.message)}`);
      if (typeof e.stack === 'string' && e.stack) lines.push(indent(e.stack, '      '));
    }
  }
  const noMatch = listOf(ev.noMatch).filter(isRecord);
  if (noMatch.length) {
    lines.push('  no match:');
    for (const n of noMatch) lines.push(`    ${String(n.ruleId)}${n.selector ? ` (${String(n.selector)})` : ''}`);
  }
  const quarantined = listOf(ev.quarantined).filter(isRecord);
  if (quarantined.length) {
    lines.push('  quarantined (the witness did not verify):');
    for (const q of quarantined) lines.push(`    ${String(q.ruleId)}`);
  }
  if (o.unapplied?.length) {
    lines.push('  not applied (the engine never reported a matched element; a saved witness that no longer verifies reads this way too):');
    for (const id of o.unapplied) lines.push(`    ${id}`);
  }
  for (const [label, key] of [['warnings', 'warnings'], ['notes', 'notes']] as const) {
    const items = listOf(ev[key]);
    if (items.length) {
      lines.push(`  ${label}:`);
      for (const w of items) lines.push(`    - ${String(w)}`);
    }
  }
  if (typeof ev.console === 'string' && ev.console) {
    lines.push('  console:');
    lines.push(indent(ev.console));
  }
  if (o.screenshot) {
    lines.push('file' in o.screenshot ? `  screenshot: ${o.screenshot.file}` : `  screenshot failed: ${o.screenshot.error}`);
  }
  return lines.join('\n');
}

/** A lint report for a terminal. */
export function formatLint(r: LintReport): string {
  const lines: string[] = [];
  for (const e of r.errors) lines.push(`error: ${e}`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  lines.push(`${r.target}: ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}, ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}`);
  return lines.join('\n');
}
