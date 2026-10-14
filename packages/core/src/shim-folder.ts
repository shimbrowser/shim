// The shim folder — the working copy an agent edits (shim-core design D10).
//
//   shim.json            the spec, minus everything the tool manages: handler
//                        source (rules name their handlers; the source is in
//                        handlers/), anchor witnesses, `version`, `bundleHash`.
//   handlers/<name>.js   one handler per file, in module form
//                        (`module.exports = <expr>;`, handler-source.ts).
//   .shim-state.json     tool-managed, written by `unpack` only: per rule the
//                        witness plus a digest of the anchor it was captured
//                        for, the spec's `bundleHash` and `version`, and the
//                        rest of the `.shim` envelope (name, opt-in data, …).
//
// Three conversions:
//   checkoutShim  working spec (+ stored handler modules) → folder, no state.
//                 What an attached session writes; the host keeps witnesses.
//   unpackShim    `shim/1` .shim file → folder with state.
//   packShim      folder → `shim/1` .shim file. A witness comes back only when
//                 its rule's anchor digest still matches — an edited anchor
//                 loses it and the engine re-captures one on the next apply.
//                 A script handler module that can't export a function is
//                 refused, as import would refuse the file.
// unpack → pack is lossless for a canonical export (deep-equal file). A file
// whose rules still carry inline `handlers` is folded into handlers/ on
// unpack, so it packs back in canonical form.
//
// Pure and Node-free: a folder is a map of relative path → contents (UTF-8
// text or bytes). Reading and writing disk is the caller's job.

import type { Spec, Rule, Anchor, Witness } from './types';
import { sha256Hex } from './sha256';
import { moduleForExpression, handlerModuleProblem } from './handler-source';
import { lintSpec, canonicalModule, HANDLER_REF_FIELDS } from './spec-lint';

export const SHIM_JSON = 'shim.json';
export const SHIM_STATE_FILE = '.shim-state.json';
export const HANDLERS_DIR = 'handlers';
export const SHIM_STATE_FORMAT = 'shim-state/1';
export const SHIM_FILE_FORMAT = 'shim/1';

/** A folder as the caller read it: relative path → UTF-8 text or raw bytes. */
export type FolderInput = Record<string, string | Uint8Array>;
/** A folder to write: relative path → UTF-8 text. */
export type FolderFiles = Record<string, string>;

export type ShimFolderErrorCode =
  | 'malformed-shim-folder'
  | 'malformed-shim-file'
  | 'malformed-shim-state'
  | 'spec-lint'
  | 'not-editable';

/** Every rejection in this module and the differ: one code, every problem found. */
export class ShimFolderError extends Error {
  readonly code: ShimFolderErrorCode;
  readonly problems: string[];
  constructor(code: ShimFolderErrorCode, problems: string[]) {
    super(`${code}: ${problems.join('; ')}`);
    this.name = 'ShimFolderError';
    this.code = code;
    this.problems = problems;
  }
}

export interface RuleState {
  /** anchorDigest() of the anchor the witness was captured for. */
  anchorDigest: string;
  witness: Witness;
}

export interface ShimState {
  format: typeof SHIM_STATE_FORMAT;
  name?: string;
  version?: number;
  bundleHash?: string;
  /** Keyed by rule id. */
  rules: Record<string, RuleState>;
  /** The `.shim` envelope's other fields (userData, authoringHistory, …), in file order. */
  file?: Record<string, unknown>;
}

/** A `shim/1` file: the browser's export payload, plus any extra envelope fields. */
export interface ShimFile {
  format: typeof SHIM_FILE_FORMAT;
  name: string;
  spec: Spec;
  handlers: Record<string, string>;
  [field: string]: unknown;
}

/** A parsed folder: the spec exactly as shim.json holds it, the handler modules, the state if any. */
export interface ShimFolderContents {
  spec: Spec;
  handlers: Record<string, string>;
  state: ShimState | null;
}

// Spec fields the tool owns: never in shim.json. `version` and `bundleHash`
// travel in .shim-state.json; a checkout also drops the registry's runtime
// priority stamps, which no export carries.
const STATE_SPEC_FIELDS = ['version', 'bundleHash'] as const;
const RUNTIME_SPEC_FIELDS = ['priority', '__cssPriority'] as const;

// A handler name is its file name, so it must be a safe one: no separators,
// no dots (so no `..` and no hidden files), not empty.
// `__proto__` is excluded: as a key it can't be an own property of the
// spec's plain `handlers` objects (nor of the browser's stored-handler bag,
// which would drop it on import).
const HANDLER_NAME_RE = /^(?!__proto__$)[A-Za-z0-9_$][A-Za-z0-9_$-]*$/;
// Windows device names, reserved in any case and with any extension
// (`handlers/CON.js` can't be created there).
const WINDOWS_DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

// `<name>.js` must fit a file-name component: 255 bytes on common
// filesystems, and names are ASCII, so 252 characters plus `.js`.
export const MAX_HANDLER_NAME_CHARS = 252;

function isHandlerName(name: string): boolean {
  return name.length <= MAX_HANDLER_NAME_CHARS && HANDLER_NAME_RE.test(name) && !WINDOWS_DEVICE_NAME_RE.test(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A map keyed by handler (or rule) name. Names come from the folder or the
 * file, so they can be `__proto__` or `constructor`: on a plain object the
 * first assignment is swallowed by the prototype setter and `in` / `[name]`
 * see Object.prototype for the second. No prototype, no inherited keys.
 */
export function nameMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Deterministic JSON: object keys sorted, arrays kept in order, undefined
 * dropped. Used for digests and for "did this change" comparisons.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** sha256 of the anchor without its witness — what a stored witness is pinned to. */
export function anchorDigest(anchor: Anchor | undefined): string {
  if (!anchor) return sha256Hex('null');
  const { witness: _witness, ...rest } = anchor;
  return sha256Hex(stableStringify(rest));
}

/** The handler names a rule's mutations reference (handler / transform / wrap). */
export function referencedHandlerNames(rule: Rule): string[] {
  const names: string[] = [];
  // A hand-written shim.json can carry any JSON here; a non-array is reported
  // by the folder check, never thrown from here.
  const mutations: unknown = rule.mutations;
  if (!Array.isArray(mutations)) return names;
  for (const mutation of mutations) {
    if (!isRecord(mutation)) continue;
    for (const field of HANDLER_REF_FIELDS) {
      const name = mutation[field];
      if (typeof name === 'string' && name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

export function handlerPath(name: string): string {
  return `${HANDLERS_DIR}/${name}.js`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// shim.json's spec: a deep copy without handler source and witnesses.
function authoredSpec(spec: Spec, dropFields: readonly string[]): Spec {
  const out = clone(spec) as Spec & Record<string, unknown>;
  delete out.handlers;
  for (const field of dropFields) delete out[field];
  for (const rule of out.rules || []) {
    if (!isRecord(rule)) continue;
    delete (rule as Rule).handlers;
    const anchor = (rule as Rule).anchor;
    if (isRecord(anchor)) delete anchor.witness;
  }
  return out;
}

// Every handler name must be its own portable file: a valid name, not a
// Windows device name, and unique ignoring case (checkCaseCollisions).
function checkHandlerNames(names: Iterable<string>, problems: string[]): void {
  const list = [...names];
  for (const name of list) {
    if (!isHandlerName(name)) {
      problems.push(`handler name "${name}" can't be a file name (use letters, digits, _, $ and -, at most 252 characters; not a Windows device name like CON or NUL)`);
    }
  }
  checkCaseCollisions(list, problems);
}

// Handler names are case-sensitive, but the default macOS and Windows
// filesystems are not: `Foo` and `foo` would be one handlers/ file, so one
// source would overwrite the other. Names are ASCII (HANDLER_NAME_RE), so
// lower-casing is the filesystem's folding.
function checkCaseCollisions(names: readonly string[], problems: string[]): void {
  const byFolded = new Map<string, string>();
  for (const name of names) {
    const folded = name.toLowerCase();
    const other = byFolded.get(folded);
    if (other === undefined) byFolded.set(folded, name);
    else problems.push(`handler names "${other}" and "${name}" differ only in case — on a case-insensitive filesystem they'd be one file (${handlerPath(name)})`);
  }
}

/**
 * Check out a working spec as a folder (no .shim-state.json — an attached
 * host keeps witnesses itself). `handlers` is the stored module map
 * (patch_files) for handlers a rule references but doesn't carry inline; a
 * rule's own inline source wins over it.
 */
export function checkoutShim(input: { spec: Spec; handlers?: Record<string, string> }): FolderFiles {
  const { spec } = input;
  const stored = input.handlers || {};
  const modules = nameMap<string>();
  const problems: string[] = [];
  for (const rule of spec.rules || []) {
    for (const name of referencedHandlerNames(rule)) {
      const stash = Object.prototype.hasOwnProperty.call(stored, name) ? stored[name] : undefined;
      if (!(name in modules) && typeof stash === 'string') modules[name] = stash;
    }
  }
  for (const rule of spec.rules || []) {
    for (const [name, source] of Object.entries(rule.handlers || {})) {
      if (typeof source === 'string') modules[name] = moduleForExpression(source);
    }
  }
  checkHandlerNames(Object.keys(modules), problems);
  if (problems.length) throw new ShimFolderError('malformed-shim-folder', problems);
  const files: FolderFiles = {
    [SHIM_JSON]: json(authoredSpec(spec, [...STATE_SPEC_FIELDS, ...RUNTIME_SPEC_FIELDS])),
  };
  for (const name of Object.keys(modules).sort()) files[handlerPath(name)] = modules[name] as string;
  return files;
}

/** Unpack a `shim/1` file (JSON text or parsed) into a folder with its state. */
export function unpackShim(fileContent: string | unknown): FolderFiles {
  let parsed: unknown = fileContent;
  if (typeof fileContent === 'string') {
    try {
      parsed = JSON.parse(stripBom(fileContent));
    } catch (err) {
      throw new ShimFolderError('malformed-shim-file', [`not valid JSON (${err instanceof Error ? err.message : String(err)})`]);
    }
  }
  const problems: string[] = [];
  if (!isRecord(parsed)) throw new ShimFolderError('malformed-shim-file', ['the file is not a JSON object']);
  if (parsed.format !== SHIM_FILE_FORMAT) {
    throw new ShimFolderError('malformed-shim-file', [
      `unsupported format "${typeof parsed.format === 'string' ? parsed.format : 'missing'}" (only ${SHIM_FILE_FORMAT} unpacks to a shim folder)`,
    ]);
  }
  const spec = parsed.spec;
  if (!isRecord(spec)) throw new ShimFolderError('malformed-shim-file', ['"spec" is missing or not an object']);
  if (typeof spec.id !== 'string' || !spec.id) problems.push('spec.id must be a non-empty string');
  if (spec.rules !== undefined && !Array.isArray(spec.rules)) problems.push('spec.rules is not an array');
  const rules: unknown[] = Array.isArray(spec.rules) ? spec.rules : [];

  // Handler modules: the file's top-level map, then any inline rule source
  // (a non-canonical file) folded in. A name defined twice with different
  // source can't be one file — the same collision spec-lint rejects.
  const modules = nameMap<string>();
  const fileHandlers = parsed.handlers;
  if (fileHandlers !== undefined && !isRecord(fileHandlers)) problems.push('"handlers" is not an object');
  for (const [name, source] of Object.entries(isRecord(fileHandlers) ? fileHandlers : {})) {
    if (typeof source !== 'string') problems.push(`handlers["${name}"] is not a source string`);
    else modules[name] = source;
  }
  if (isRecord(spec.handlers)) {
    for (const [name, source] of Object.entries(spec.handlers)) {
      if (typeof source !== 'string') problems.push(`spec.handlers["${name}"] is not a source string`);
      else defineModule(modules, name, source, 'spec.handlers', problems);
    }
  }
  const state: ShimState = { format: SHIM_STATE_FORMAT, rules: nameMap<RuleState>() };
  const seen = new Set<string>();
  rules.forEach((ruleValue, index) => {
    if (!isRecord(ruleValue)) { problems.push(`spec.rules[${index}] is not an object`); return; }
    const id = ruleValue.id;
    if (typeof id !== 'string' || !id) { problems.push(`spec.rules[${index}] has no id`); return; }
    if (seen.has(id)) problems.push(`rule id "${id}" appears twice`);
    seen.add(id);
    if (isRecord(ruleValue.handlers)) {
      for (const [name, source] of Object.entries(ruleValue.handlers)) {
        if (typeof source !== 'string') problems.push(`rule "${id}": handlers["${name}"] is not a source string`);
        else defineModule(modules, name, moduleForExpression(source), `rule "${id}"`, problems);
      }
    }
    const anchor = ruleValue.anchor;
    if (isRecord(anchor) && anchor.witness !== undefined) {
      state.rules[id] = { anchorDigest: anchorDigest(anchor as unknown as Anchor), witness: anchor.witness as Witness };
    }
  });
  checkHandlerNames(Object.keys(modules), problems);
  if (problems.length) throw new ShimFolderError('malformed-shim-file', problems);

  if (typeof parsed.name === 'string') state.name = parsed.name;
  if (typeof spec.version === 'number') state.version = spec.version;
  if (typeof spec.bundleHash === 'string') state.bundleHash = spec.bundleHash;
  const envelope = nameMap<unknown>();
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'format' || key === 'name' || key === 'spec' || key === 'handlers') continue;
    envelope[key] = value;
  }
  if (Object.keys(envelope).length) state.file = envelope;

  const files: FolderFiles = {
    [SHIM_JSON]: json(authoredSpec(spec as unknown as Spec, STATE_SPEC_FIELDS)),
    [SHIM_STATE_FILE]: json(state),
  };
  for (const name of Object.keys(modules)) files[handlerPath(name)] = modules[name] as string;
  return files;
}

function defineModule(
  modules: Record<string, string>,
  name: string,
  moduleSource: string,
  where: string,
  problems: string[],
): void {
  const existing = modules[name];
  if (existing !== undefined && canonicalModule(existing) !== canonicalModule(moduleSource)) {
    problems.push(`handler "${name}" is defined with different source in ${where} and elsewhere — a shim keeps one source per handler name`);
    return;
  }
  if (existing === undefined) modules[name] = moduleSource;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function decode(path: string, content: string | Uint8Array, problems: string[]): string | null {
  if (typeof content === 'string') return content;
  try {
    // fatal: malformed UTF-8 is an error, not U+FFFD; the BOM is stripped.
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    problems.push(`${path} is not valid UTF-8`);
    return null;
  }
}

// `./a/b` → `a/b`; null for anything that isn't a plain relative path.
function normalizePath(raw: string): string | null {
  if (!raw || raw.includes('\\') || raw.startsWith('/') || raw.includes('\0')) return null;
  const segments = raw.split('/').filter((segment, index) => !(index === 0 && segment === '.'));
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

/**
 * Parse a folder into its spec, handler modules and state, rejecting anything
 * that isn't a shim folder. Hidden files (a path segment starting with ".")
 * other than .shim-state.json are ignored — editors and OSes leave them.
 */
export function readShimFolder(input: FolderInput): ShimFolderContents {
  const problems: string[] = [];
  let sawSpec = false;
  let specText: string | null = null;
  let stateText: string | null = null;
  const handlers = nameMap<string>();
  for (const [rawPath, content] of Object.entries(input)) {
    const path = normalizePath(rawPath);
    if (path === null) { problems.push(`"${rawPath}" is not a relative path inside the folder`); continue; }
    if (path === SHIM_STATE_FILE) { stateText = decode(path, content, problems); continue; }
    if (path.split('/').some((segment) => segment.startsWith('.'))) continue;
    if (path === SHIM_JSON) { sawSpec = true; specText = decode(path, content, problems); continue; }
    const handler = /^handlers\/([^/]+)\.js$/.exec(path);
    const name = handler?.[1];
    if (name !== undefined) {
      if (!isHandlerName(name)) { problems.push(`${path}: "${name}" is not a valid handler name (use letters, digits, _, $ and -, at most 252 characters; not a Windows device name like CON or NUL)`); continue; }
      const text = decode(path, content, problems);
      if (text !== null) handlers[name] = text;
      continue;
    }
    problems.push(`unexpected file ${path} — a shim folder holds ${SHIM_JSON} and ${HANDLERS_DIR}/<name>.js only`);
  }
  // A case-sensitive filesystem can hold both; it couldn't be unpacked or
  // checked out again on a case-insensitive one.
  checkCaseCollisions(Object.keys(handlers), problems);

  let spec: Spec | null = null;
  if (!sawSpec) problems.push(`${SHIM_JSON} is missing`);
  if (specText !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripBom(specText));
    } catch (err) {
      problems.push(`${SHIM_JSON} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    if (parsed !== undefined) {
      if (isRecord(parsed)) spec = checkAuthoredSpec(parsed, handlers, problems);
      else problems.push(`${SHIM_JSON} is not a JSON object`);
    }
  }

  if (problems.length || !spec) throw new ShimFolderError('malformed-shim-folder', problems);
  return { spec, handlers, state: stateText === null ? null : parseState(stateText) };
}

// shim.json's own rules: an object spec with an id, rules with unique ids,
// handlers named rather than inlined, nothing the tool manages.
function checkAuthoredSpec(raw: Record<string, unknown>, handlers: Record<string, string>, problems: string[]): Spec {
  if (typeof raw.id !== 'string' || !raw.id) problems.push(`${SHIM_JSON}: "id" must be a non-empty string`);
  if ('handlers' in raw) problems.push(`${SHIM_JSON}: a top-level "handlers" map is not allowed — handler source goes in ${HANDLERS_DIR}/<name>.js`);
  for (const field of STATE_SPEC_FIELDS) {
    if (field in raw) problems.push(`${SHIM_JSON}: "${field}" is managed by Shim — remove it`);
  }
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) problems.push(`${SHIM_JSON}: "rules" must be an array`);
  const rules: unknown[] = Array.isArray(raw.rules) ? raw.rules : [];
  const seen = new Set<string>();
  rules.forEach((ruleValue, index) => {
    if (!isRecord(ruleValue)) { problems.push(`${SHIM_JSON}: rules[${index}] is not an object`); return; }
    const id = ruleValue.id;
    if (typeof id !== 'string' || !id) { problems.push(`${SHIM_JSON}: rules[${index}] needs a non-empty string "id"`); return; }
    if (seen.has(id)) problems.push(`${SHIM_JSON}: rule id "${id}" appears twice`);
    seen.add(id);
    if ('handlers' in ruleValue) {
      problems.push(`rule "${id}": inline "handlers" are not allowed in ${SHIM_JSON} — put each handler in ${HANDLERS_DIR}/<name>.js and name it from the mutation`);
    }
    if (isRecord(ruleValue.anchor) && 'witness' in ruleValue.anchor) {
      problems.push(`rule "${id}": anchor "witness" is managed by Shim — remove it`);
    }
    if (ruleValue.mutations !== undefined && !Array.isArray(ruleValue.mutations)) {
      problems.push(`rule "${id}": "mutations" must be an array`);
      return;
    }
    for (const name of referencedHandlerNames(ruleValue as unknown as Rule)) {
      if (!Object.hasOwn(handlers, name)) problems.push(`rule "${id}" names handler "${name}" but ${handlerPath(name)} is missing`);
    }
  });
  return raw as unknown as Spec;
}

// Import (parseShimFile → assertHandlersBound) compiles and runs every
// `script` mutation's handler module and refuses the file unless it exports a
// function; lint only syntax-checks transforms and wraps. So pack refuses
// what can be told without running the code (handlerModuleProblem) rather
// than write a file the browser won't import.
/**
 * Every `script` handler module that can't export a function, one problem
 * per file — what `packShim` refuses after spec-lint. `shim lint` reports
 * the same list.
 */
export function scriptModuleProblems(spec: Spec, handlers: Record<string, string>): string[] {
  const problems: string[] = [];
  const checked = new Set<string>();
  for (const rule of spec.rules || []) {
    for (const mutation of rule.mutations || []) {
      if (!isRecord(mutation) || mutation.kind !== 'script') continue;
      const name = mutation.handler;
      if (typeof name !== 'string' || !name || checked.has(name)) continue;
      checked.add(name);
      // readShimFolder already refused a named handler with no file.
      const source = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
      if (source === undefined) continue;
      const problem = handlerModuleProblem(source);
      if (problem) problems.push(`${handlerPath(name)} ${problem}`);
    }
  }
  return problems;
}

function checkScriptModules(spec: Spec, handlers: Record<string, string>): void {
  const problems = scriptModuleProblems(spec, handlers);
  if (problems.length) throw new ShimFolderError('malformed-shim-folder', problems);
}

function parseState(text: string): ShimState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (err) {
    throw new ShimFolderError('malformed-shim-state', [`${SHIM_STATE_FILE} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — it is written by \`shim unpack\`; delete it to pack without witnesses`]);
  }
  const problems: string[] = [];
  if (!isRecord(parsed) || parsed.format !== SHIM_STATE_FORMAT) {
    throw new ShimFolderError('malformed-shim-state', [`${SHIM_STATE_FILE} is not a ${SHIM_STATE_FORMAT} file`]);
  }
  if (parsed.name !== undefined && typeof parsed.name !== 'string') problems.push('"name" must be a string');
  if (parsed.version !== undefined && typeof parsed.version !== 'number') problems.push('"version" must be a number');
  if (parsed.bundleHash !== undefined && typeof parsed.bundleHash !== 'string') problems.push('"bundleHash" must be a string');
  if (parsed.file !== undefined && !isRecord(parsed.file)) problems.push('"file" must be an object');
  if (!isRecord(parsed.rules)) problems.push('"rules" must be an object');
  else {
    for (const [id, entry] of Object.entries(parsed.rules)) {
      if (!isRecord(entry) || typeof entry.anchorDigest !== 'string' || !isRecord(entry.witness)) {
        problems.push(`rules["${id}"] needs an "anchorDigest" string and a "witness" object`);
      }
    }
  }
  if (problems.length) throw new ShimFolderError('malformed-shim-state', problems.map((p) => `${SHIM_STATE_FILE}: ${p}`));
  return parsed as unknown as ShimState;
}

/**
 * Why a spec's `match.hosts` is unusable, or null: it must be an array of
 * host-pattern strings — what import and a headless session require — so
 * pack and lint never bless a folder whose file those then refuse.
 */
export function matchHostsProblem(spec: { match?: unknown }): string | null {
  const match = spec.match;
  if (!isRecord(match) || !Array.isArray(match.hosts) || !match.hosts.every((h: unknown) => typeof h === 'string')) {
    return `${SHIM_JSON}: "match.hosts" must be an array of host patterns (strings)`;
  }
  return null;
}

/**
 * Pack a folder into a `shim/1` file. Restores `version` / `bundleHash` and
 * each witness whose anchor digest still matches from .shim-state.json (when
 * present), checks `match.hosts` as import does, and runs spec-lint — a lint
 * error is a ShimFolderError('spec-lint'). A `script` handler module that
 * can't export a function (handlerModuleProblem) is a
 * ShimFolderError('malformed-shim-folder').
 */
export function packShim(input: FolderInput): ShimFile {
  const { spec: authored, handlers, state } = readShimFolder(input);
  const spec = clone(authored) as Spec & Record<string, unknown>;
  if (state?.version !== undefined) spec.version = state.version;
  if (state?.bundleHash !== undefined) spec.bundleHash = state.bundleHash;
  for (const rule of spec.rules || []) {
    const entry = state && Object.hasOwn(state.rules, rule.id) ? state.rules[rule.id] : undefined;
    if (!entry || !rule.anchor || anchorDigest(rule.anchor) !== entry.anchorDigest) continue;
    rule.anchor = { ...rule.anchor, witness: clone(entry.witness) };
  }

  const hostsProblem = matchHostsProblem(spec);
  if (hostsProblem) throw new ShimFolderError('malformed-shim-folder', [hostsProblem]);
  // The handler modules ride as the spec-level map, so a rewrite transform
  // or intercept wrap resolves its name the way it will after import.
  const { errors } = lintSpec({ ...spec, handlers });
  if (errors.length) throw new ShimFolderError('spec-lint', errors);
  checkScriptModules(spec, handlers);

  const file: ShimFile = {
    format: SHIM_FILE_FORMAT,
    name: state?.name ?? spec.id,
    spec,
    handlers: { ...handlers },
  };
  for (const [key, value] of Object.entries(state?.file || {})) {
    // defineProperty, so an envelope field named `__proto__` stays a field.
    if (!Object.hasOwn(file, key)) Object.defineProperty(file, key, { value: clone(value), enumerable: true, writable: true, configurable: true });
  }
  return file;
}
