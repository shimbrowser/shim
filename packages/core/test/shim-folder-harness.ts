// Harness for the shim folder format (packages/core/src/shim-folder.ts,
// shim-core design D10): unpack → pack is lossless, a witness survives pack
// only while its rule's anchor digest still matches, checkout writes what an
// attached session edits, and a malformed folder or file is rejected with
// every problem named.
//
//   node out/packages/core/test/shim-folder-harness.js
//
// Bare node. `vm` only evaluates moduleToExpression's output as a check.

import * as vm from 'vm';
import {
  unpackShim, packShim, checkoutShim, readShimFolder, anchorDigest, stableStringify,
  ShimFolderError, SHIM_JSON, SHIM_STATE_FILE, referencedHandlerNames,
} from '../src/shim-folder';
import type { FolderInput, ShimState, ShimFolderErrorCode } from '../src/shim-folder';
import { moduleToExpression, expressionToModule, moduleForExpression } from '../src/handler-source';
import type { Spec, Rule, Anchor, Witness } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

function rejects(label: string, code: ShimFolderErrorCode, fn: () => unknown, mentions: string): void {
  try {
    fn();
    check(label, false, 'did not throw');
  } catch (err) {
    const ok = err instanceof ShimFolderError && err.code === code && err.problems.some((p) => p.includes(mentions));
    check(label, ok, err instanceof ShimFolderError ? `${err.code}: ${err.problems.join(' | ')}` : String(err));
  }
}

const witness = (text: string): Witness => ({ v: 1, tag: 'div', attrs: { 'data-testid': text }, textStem: text });
const NOTES_MODULE = 'module.exports = function notes({ anchor, api }) {\n  anchor.dataset.notes = "1";\n};\n';
const TRANSFORM_MODULE = 'module.exports = function strip(body) { return { ...body, ads: [] }; };\n';
const ROUTE_MODULE = 'const TITLE = "Notes";\nmodule.exports = function page({ root }) { root.textContent = TITLE; };\n';

// A canonical export: what the browser's exportToShim writes.
const EXPORT = {
  format: 'shim/1',
  name: 'Track notes',
  spec: {
    id: 'shim-1',
    version: 7,
    match: { hosts: ['example.com'] },
    rules: [
      {
        id: 'hide-upsell',
        anchor: { primary: { kind: 'css', value: '[data-testid="upsell"]' }, witness: witness('upsell') },
        mutations: [{ kind: 'hide' }],
      },
      {
        id: 'notes',
        anchor: {
          primary: { kind: 'data-attr', name: 'data-track', value: 'row' },
          fallbacks: [{ kind: 'css', value: '.track-row' }],
          witness: witness('row'),
        },
        mutations: [{ kind: 'script', handler: 'notes', mount: { strategy: 'portal' } }],
      },
      { id: 'strip-ads', mutations: [{ kind: 'rewrite-response', endpoint: { path: '/api/feed' }, transform: 'strip' }] },
      { id: 'notes-page', mutations: [{ kind: 'mount-route', handler: 'page', pattern: '/notes', title: 'Notes' }] },
    ],
    settings: [{ key: 'color', type: 'string', label: 'Color' }],
    permissions: ['ai'],
    intent: 'Keep notes per track.',
    bundleHash: 'abc123',
  },
  handlers: { notes: NOTES_MODULE, strip: TRANSFORM_MODULE, page: ROUTE_MODULE },
  userData: [{ origin: 'https://example.com', key: 'k', value: 'v' }],
  authoringHistory: [{ role: 'user', content: 'add notes' }],
  validatedRoutes: [{ ruleId: 'notes', pathTemplate: '/tracks/:id' }],
};

const parseJson = (text: string | undefined): unknown => JSON.parse(text ?? 'null');

console.log('unpack writes the folder');
const folder = unpackShim(JSON.stringify(EXPORT, null, 2));
const shimJson = parseJson(folder[SHIM_JSON]) as Spec & Record<string, unknown>;
const state = parseJson(folder[SHIM_STATE_FILE]) as ShimState;
check('shim.json, three handler files and the state file', Object.keys(folder).sort().join() === [
  '.shim-state.json', 'handlers/notes.js', 'handlers/page.js', 'handlers/strip.js', 'shim.json',
].join(), Object.keys(folder).join());
check('handler files hold the module source verbatim',
  folder['handlers/notes.js'] === NOTES_MODULE && folder['handlers/page.js'] === ROUTE_MODULE);
check('shim.json carries no witness', !JSON.stringify(shimJson).includes('witness'));
check('shim.json carries no version / bundleHash', !('version' in shimJson) && !('bundleHash' in shimJson));
check('shim.json carries no handler source', !('handlers' in shimJson) && !JSON.stringify(shimJson).includes('module.exports'));
check('shim.json keeps the authored rest', shimJson.intent === EXPORT.spec.intent && shimJson.rules?.length === 4);
check('state keeps version, bundleHash and name', state.version === 7 && state.bundleHash === 'abc123' && state.name === 'Track notes');
check('state keeps both witnesses with their anchor digests',
  Object.keys(state.rules).sort().join() === 'hide-upsell,notes'
  && state.rules.notes?.anchorDigest === anchorDigest(EXPORT.spec.rules[1]?.anchor as unknown as Anchor));
check('state keeps the rest of the envelope, in order',
  Object.keys(state.file || {}).join() === 'userData,authoringHistory,validatedRoutes');

console.log('unpack → pack is lossless');
const packed = packShim(folder);
check('deep-equal to the original file', stableStringify(packed) === stableStringify(EXPORT),
  `${stableStringify(packed)}\n  vs\n  ${stableStringify(EXPORT)}`);
check('envelope field order is the export\'s', Object.keys(packed).join() === Object.keys(EXPORT).join(), Object.keys(packed).join());
check('a parsed (not text) file unpacks the same', stableStringify(unpackShim(EXPORT)) === stableStringify(folder));
const asBytes: FolderInput = {};
for (const [path, text] of Object.entries(folder)) asBytes[path] = new TextEncoder().encode(text);
check('a folder read as bytes packs the same', stableStringify(packShim(asBytes)) === stableStringify(EXPORT));
const twice = packShim(unpackShim(packed));
check('a second round trip is still identical', stableStringify(twice) === stableStringify(EXPORT));

console.log('unpack → edit → pack: witnesses follow the anchor digest');
const edit = (mutate: (spec: Spec) => void, extra: Record<string, string> = {}): FolderInput => {
  const spec = parseJson(folder[SHIM_JSON]) as Spec;
  mutate(spec);
  return { ...folder, [SHIM_JSON]: JSON.stringify(spec, null, 2), ...extra };
};
const ruleOf = (spec: Spec, id: string) => {
  const rule = spec.rules?.find((r) => r.id === id);
  if (!rule) throw new Error(`no rule ${id}`);
  return rule;
};
let out = packShim(edit((spec) => { const a = ruleOf(spec, 'notes').anchor; if (a) a.primary = { kind: 'css', value: '.row-v2' }; }));
check('an edited primary drops that rule\'s witness', ruleOf(out.spec, 'notes').anchor?.witness === undefined);
check('…and keeps the untouched rule\'s', stableStringify(ruleOf(out.spec, 'hide-upsell').anchor?.witness) === stableStringify(witness('upsell')));
out = packShim(edit((spec) => { const a = ruleOf(spec, 'notes').anchor; if (a) a.fallbacks = []; }));
check('an edited fallback list drops it too', ruleOf(out.spec, 'notes').anchor?.witness === undefined);
out = packShim(edit((spec) => { ruleOf(spec, 'notes').mutations = [{ kind: 'script', handler: 'notes', mount: { strategy: 'overlay' } }]; },
  { 'handlers/notes.js': NOTES_MODULE.replace('"1"', '"2"') }));
check('a mutation or handler edit keeps it (anchor unchanged)', stableStringify(ruleOf(out.spec, 'notes').anchor?.witness) === stableStringify(witness('row')));
check('…and the edited handler ships', out.handlers.notes?.includes('"2"') === true);
out = packShim(edit((spec) => {
  const anchor = ruleOf(spec, 'notes').anchor;
  if (anchor) ruleOf(spec, 'notes').anchor = { fallbacks: anchor.fallbacks, primary: anchor.primary };
}));
check('reordering an anchor\'s keys is not an edit', ruleOf(out.spec, 'notes').anchor?.witness !== undefined);
out = packShim(edit((spec) => { ruleOf(spec, 'notes').id = 'notes-renamed'; }));
check('a renamed rule has no witness (state is keyed by rule id)', ruleOf(out.spec, 'notes-renamed').anchor?.witness === undefined);
const noState = { ...folder };
delete noState[SHIM_STATE_FILE];
out = packShim(noState);
check('without .shim-state.json: no witnesses, no version, name = spec id',
  !JSON.stringify(out).includes('"witness"') && out.spec.version === undefined && out.name === 'shim-1');
check('…and no envelope extras', !('userData' in out));
out = packShim({ ...folder, '.DS_Store': 'x', 'handlers/.notes.js.swp': 'x' });
check('hidden files are ignored', stableStringify(out) === stableStringify(EXPORT));

console.log('checkout (attach mode) writes the working copy');
const working: Spec = {
  id: 'w', version: 3, bundleHash: 'h', priority: 2, match: { hosts: ['example.com'] },
  rules: [
    { id: 'a', anchor: { primary: { kind: 'css', value: '.a' }, witness: witness('a') }, mutations: [{ kind: 'script', handler: 'mountA' }], handlers: { mountA: 'function mountA() {}' } },
    { id: 'b', anchor: { primary: { kind: 'css', value: '.b' } }, mutations: [{ kind: 'script', handler: 'imported' }] },
  ],
};
const checkout = checkoutShim({ spec: working, handlers: { imported: 'const X = 1;\nmodule.exports = () => X;\n', stale: 'x' } });
const checkedSpec = parseJson(checkout[SHIM_JSON]) as Spec & Record<string, unknown>;
check('inline handler → module file', checkout['handlers/mountA.js'] === expressionToModule('function mountA() {}'));
check('a stored module a rule names → its file', checkout['handlers/imported.js'] === 'const X = 1;\nmodule.exports = () => X;\n');
check('a stored module no rule names is not written', !('handlers/stale.js' in checkout));
check('no state file, no witness, no version / bundleHash / priority',
  !(SHIM_STATE_FILE in checkout) && !checkout[SHIM_JSON]?.includes('witness')
  && !('version' in checkedSpec) && !('bundleHash' in checkedSpec) && !('priority' in checkedSpec));
check('the working spec is not mutated', working.rules?.[0]?.anchor?.witness !== undefined && working.rules?.[0]?.handlers !== undefined);
check('the checkout reads back as a folder', readShimFolder(checkout).spec.id === 'w');

console.log('handler names that are Object.prototype keys');
const protoSpec: Spec = {
  id: 'p', match: { hosts: ['example.com'] },
  rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.a' } }, mutations: [{ kind: 'script', handler: 'constructor' }] }],
};
const protoCheckout = checkoutShim({ spec: protoSpec, handlers: { constructor: 'module.exports = function constructor() {};\n' } });
check('a stored handler named constructor is checked out', protoCheckout['handlers/constructor.js'] === 'module.exports = function constructor() {};\n', Object.keys(protoCheckout).join(','));
// A hand-written shim.json can carry any JSON in a rule's mutations: a
// non-array is a reported folder problem, never a thrown TypeError.
{
  let err: unknown = null;
  try {
    readShimFolder({ [SHIM_JSON]: JSON.stringify({ id: 'm', match: { hosts: ['a.test'] }, rules: [{ id: 'r', anchor: { primary: { kind: 'css', value: '.x' } }, mutations: {} }] }) });
  } catch (e) { err = e; }
  check('a non-array "mutations" is a folder problem, not a crash',
    err instanceof ShimFolderError && err.problems.some((p) => /"mutations" must be an array/.test(p)), String(err));
  check('referencedHandlerNames tolerates a non-array mutations value',
    referencedHandlerNames({ id: 'r', mutations: {} } as unknown as Parameters<typeof referencedHandlerNames>[0]).length === 0);
}
const protoRead = readShimFolder(protoCheckout);
const CTOR: string = 'constructor';
check('…and reads back as that handler', protoRead.handlers[CTOR] === 'module.exports = function constructor() {};\n');
let missingProblems: string[] = [];
try {
  readShimFolder({ [SHIM_JSON]: JSON.stringify({ ...protoSpec, rules: [{ ...protoSpec.rules?.[0], mutations: [{ kind: 'script', handler: 'toString' }] }] }) });
} catch (err) {
  missingProblems = err instanceof ShimFolderError ? err.problems : [String(err)];
}
check('a rule naming toString with no file is reported missing', missingProblems.some((p) => p.includes('handlers/toString.js is missing')), missingProblems.join(' | '));
let protoNameProblems: string[] = [];
try {
  readShimFolder({ [SHIM_JSON]: JSON.stringify(protoSpec), 'handlers/__proto__.js': 'module.exports = function x() {};\n' });
} catch (err) {
  protoNameProblems = err instanceof ShimFolderError ? err.problems : [String(err)];
}
check('__proto__ is not a valid handler name', protoNameProblems.some((p) => p.includes('"__proto__" is not a valid handler name')), protoNameProblems.join(' | '));

console.log('module ↔ expression');
const expr = 'function h({ anchor }) {\n  return anchor;\n}\n';
check('expression → module → expression is the identity', moduleToExpression(expressionToModule(expr)) === expr);
check('a hand-tidied wrapper still unwraps', moduleToExpression('module.exports=function h(){}') === 'function h(){}');
const iife = moduleToExpression(ROUTE_MODULE);
check('a module with helpers becomes an IIFE', iife.startsWith('(function () {'));
const evaluated: unknown = vm.runInNewContext(`(${iife})`);
check('…that evaluates to the module\'s export', typeof evaluated === 'function');
const assigned: unknown = vm.runInNewContext(`var module = { exports: {} }; ${expressionToModule(iife)} module.exports`);
check('…and survives the module wrap the browser compiles', typeof assigned === 'function');
// CommonJS runs a module with `this === module.exports`; the IIFE keeps that,
// so a strict module that writes through `this` still works.
{
  const thisModule = '"use strict";\nconst self = this;\nself.helper = function helper() { return 7; };\nmodule.exports = function h() { return self.helper(); };\n';
  const viaThis = moduleToExpression(thisModule);
  let result: unknown;
  try {
    const fn = vm.runInNewContext(`(${viaThis})`) as unknown;
    result = typeof fn === 'function' ? (fn as () => unknown)() : 'not a function';
  } catch (e) { result = String(e); }
  check('a module using top-level `this` keeps CommonJS semantics in the IIFE', result === 7, String(result));
  check('…and still round-trips byte for byte', moduleForExpression(viaThis) === thisModule);
}
check('moduleForExpression undoes the IIFE byte for byte', moduleForExpression(iife) === ROUTE_MODULE);
check('…and wraps any other expression', moduleForExpression(expr) === expressionToModule(expr));
// A bare expression runs inline (the preload's `(<expr>)` compile) with no
// CommonJS wrapper, so an export that uses one of its bindings keeps the IIFE,
// and runs the way the module itself does.
{
  const selfRef = 'module.exports = function h() { return module.exports === h; };\n';
  const asExpr = moduleToExpression(selfRef);
  check('an export that reads `module` keeps the IIFE', asExpr.startsWith('(function () {'));
  const inline = vm.runInNewContext(`(${asExpr})`) as unknown;
  check('…and inline it sees its own module, as the module does', typeof inline === 'function' && (inline as () => unknown)() === true);
  for (const binding of ['exports', 'this', 'arguments', 'require']) {
    check(`an export that mentions \`${binding}\` keeps the IIFE`,
      moduleToExpression(`module.exports = function h() { return typeof ${binding}; };\n`).startsWith('(function () {'));
  }
  const escaped = 'module.exports = function h() { return m\\u006fdule.\\u0065xports === h; };\n';
  const asEscaped = moduleToExpression(escaped);
  check('an export spelling `module` with an escape keeps the IIFE', asEscaped.startsWith('(function () {'));
  const viaEscape = vm.runInNewContext(`(${asEscaped})`) as unknown;
  check('…and inline it still sees its own module', typeof viaEscape === 'function' && (viaEscape as () => unknown)() === true);
  // The browser's module compile passes (module, exports, require,
  // __filename, __dirname); the IIFE forwards the same, in order, from the
  // scope it is compiled in.
  const viaArgs = moduleToExpression('module.exports = function h() { return [typeof arguments, h.length]; };\nconst grab = arguments;\nmodule.exports.args = grab;\n');
  const fakeRequire = () => 'required';
  const scoped = vm.runInNewContext(`(function (require, __filename, __dirname) { return ${viaArgs}; })`)(fakeRequire, 'shim://x/handlers/h.js', '') as { args?: unknown[] };
  const args = Array.from((scoped.args ?? []) as ArrayLike<unknown>);
  check('the IIFE passes the module compile\'s five arguments in its order',
    args.length === 5 && args[2] === fakeRequire && args[3] === 'shim://x/handlers/h.js' && args[4] === '', JSON.stringify(args.map((a) => typeof a)));
  const unscoped = vm.runInNewContext(`(${viaArgs})`) as { args?: unknown[] };
  check('…and still compiles where no require is in scope', Array.from((unscoped.args ?? []) as ArrayLike<unknown>).length === 5);
  const commented = 'module.exports = function h() { return 3; } // explanation\n';
  const asCommented = moduleToExpression(commented);
  check('an export ending in a // comment keeps the IIFE', asCommented.startsWith('(function () {'));
  let compiled: unknown;
  try { compiled = vm.runInNewContext(`(${asCommented})`); } catch (e) { compiled = String(e); }
  check('…which compiles inline with the closer on the comment\'s line', typeof compiled === 'function' && (compiled as () => unknown)() === 3, String(compiled));
}
check('module.exports = a; extra(); is not a bare expression', moduleToExpression('module.exports = a;\nextra();\n').startsWith('(function () {'));

console.log('malformed folders');
const good = (): FolderInput => ({ ...folder });
rejects('no shim.json', 'malformed-shim-folder', () => packShim({ 'handlers/notes.js': NOTES_MODULE }), 'shim.json is missing');
rejects('shim.json not JSON', 'malformed-shim-folder', () => packShim({ ...good(), [SHIM_JSON]: '{ nope' }), 'not valid JSON');
rejects('shim.json not an object', 'malformed-shim-folder', () => packShim({ ...good(), [SHIM_JSON]: '[]' }), 'not a JSON object');
rejects('rules not an array', 'malformed-shim-folder', () => packShim(edit((spec) => { (spec as unknown as Record<string, unknown>).rules = {}; })), '"rules" must be an array');
rejects('a rule without an id', 'malformed-shim-folder', () => packShim(edit((spec) => { spec.rules?.push({ mutations: [] } as unknown as Rule); })), 'needs a non-empty string "id"');
rejects('duplicate rule ids', 'malformed-shim-folder', () => packShim(edit((spec) => { spec.rules?.push({ id: 'notes', mutations: [{ kind: 'hide' }] }); })), 'appears twice');
rejects('inline rule handlers', 'malformed-shim-folder', () => packShim(edit((spec) => { ruleOf(spec, 'notes').handlers = { notes: 'function(){}' }; })), 'inline "handlers" are not allowed');
rejects('a top-level handlers map', 'malformed-shim-folder', () => packShim(edit((spec) => { (spec as unknown as Record<string, unknown>).handlers = {}; })), 'top-level "handlers"');
rejects('a witness in shim.json', 'malformed-shim-folder', () => packShim(edit((spec) => { const a = ruleOf(spec, 'notes').anchor; if (a) a.witness = witness('x'); })), 'witness');
rejects('version in shim.json', 'malformed-shim-folder', () => packShim(edit((spec) => { spec.version = 9; })), '"version" is managed by Shim');
rejects('a named handler with no file', 'malformed-shim-folder', () => { const f = good(); delete f['handlers/notes.js']; return packShim(f); }, 'handlers/notes.js is missing');
rejects('an unexpected file', 'malformed-shim-folder', () => packShim({ ...good(), 'README.md': '# hi' }), 'unexpected file README.md');
rejects('a nested handler file', 'malformed-shim-folder', () => packShim({ ...good(), 'handlers/sub/x.js': '' }), 'unexpected file handlers/sub/x.js');
rejects('a path that leaves the folder', 'malformed-shim-folder', () => packShim({ ...good(), '../shim.json': '{}' }), 'not a relative path');
rejects('an absolute path', 'malformed-shim-folder', () => packShim({ ...good(), '/etc/passwd': '' }), 'not a relative path');
rejects('a handler file name that isn\'t a handler name', 'malformed-shim-folder', () => packShim({ ...good(), 'handlers/a.b.js': '' }), 'not a valid handler name');
rejects('a handler file that isn\'t UTF-8', 'malformed-shim-folder', () => packShim({ ...good(), 'handlers/notes.js': new Uint8Array([0xff, 0xfe, 0x00]) }), 'not valid UTF-8');
rejects('match.hosts missing at pack', 'malformed-shim-folder', () => packShim(edit((spec) => { delete spec.match; })), 'match.hosts');
rejects('a non-string host at pack', 'malformed-shim-folder', () => packShim(edit((spec) => { (spec as unknown as { match: unknown }).match = { hosts: [42] }; })), 'match.hosts');
rejects('a lint error at pack', 'spec-lint', () => packShim(edit((spec) => { spec.rules?.push({ id: 'x', mutations: [{ kind: 'cspRelax' }] }); })), 'unknown mutation kind "cspRelax"');
rejects('a transform that does not parse', 'spec-lint', () => packShim({ ...good(), 'handlers/strip.js': 'module.exports = function (b) { return b;' }), 'does not parse as JavaScript');
// The script handler modules import would refuse (assertHandlersBound runs
// them and wants a function at module.exports).
rejects('a script handler module that does not parse', 'malformed-shim-folder',
  () => packShim({ ...good(), 'handlers/notes.js': 'module.exports = function (ctx) {' }), 'handlers/notes.js does not parse as JavaScript');
rejects('a script handler module exporting a number', 'malformed-shim-folder',
  () => packShim({ ...good(), 'handlers/notes.js': 'module.exports = 42;\n' }), 'handlers/notes.js exports 42, not a function');
rejects('a script handler module exporting a string', 'malformed-shim-folder',
  () => packShim({ ...good(), 'handlers/notes.js': 'module.exports = "notes"' }), 'not a function');
rejects('a script handler file that is a bare function declaration', 'malformed-shim-folder',
  () => packShim({ ...good(), 'handlers/notes.js': 'function notes({ anchor }) { anchor.dataset.n = "1"; }\n' }), 'handlers/notes.js never assigns module.exports');
for (const [label, src] of [
  ['through the wrapper\'s arguments', 'arguments[0].exports = function notes() {};\n'],
  ['through an escaped identifier', 'm\\u006fdule.exports = function notes() {};\n'],
  ['through a direct eval', 'eval("module").exports = function notes() {};\n'],
] as const) {
  let packed: string;
  try { packShim({ ...good(), 'handlers/notes.js': src }); packed = 'ok'; } catch (err) { packed = err instanceof Error ? err.message : String(err); }
  check(`a module that assigns its export ${label} packs`, packed === 'ok', packed);
}
rejects('a script handler module exporting an object', 'malformed-shim-folder',
  () => packShim({ ...good(), 'handlers/notes.js': 'module.exports = {};\n' }), 'handlers/notes.js exports an object, not a function');
rejects('…an object of handlers', 'malformed-shim-folder',
  () => packShim({ ...good(), 'handlers/notes.js': 'module.exports = {\n  notes({ anchor }) { anchor.title = "}"; },\n};\n' }), 'exports an object');
rejects('…or an array', 'malformed-shim-folder',
  () => packShim({ ...good(), 'handlers/notes.js': 'module.exports = [function notes() {}, "]"];\n' }), 'exports an array');
rejects('an empty script handler file', 'malformed-shim-folder',
  () => packShim({ ...good(), 'handlers/notes.js': '  \n' }), 'handlers/notes.js is empty');
for (const [label, source] of [
  ['an arrow', 'module.exports = ({ anchor }) => { anchor.hidden = true; };\n'],
  ['a module with helpers', 'const K = 1;\nmodule.exports = function notes() { return K; };\n'],
  ['a computed export', 'module.exports = (() => function notes() {})();\n'],
  ['module["exports"]', 'module["exports"] = function notes() {};\n'],
  ['Object.defineProperty(module, "exports")', 'Object.defineProperty(module, "exports", { value: function notes() {} });\n'],
  ['Object.assign(module, { exports })', 'Object.assign(module, { exports: function notes() {} });\n'],
  ['an element of an array literal', 'module.exports = [function notes() {}][0];\n'],
  ['a member of an object literal', 'module.exports = { notes() {} }.notes;\n'],
  ['a choice between object members', 'module.exports = {}.x ? {}.y : { f() {} }.f;\n'],
] as const) {
  let ok = true;
  try { packShim({ ...good(), 'handlers/notes.js': source }); } catch (err) { ok = false; console.error(err); }
  check(`a script handler that exports a function packs (${label})`, ok);
}

rejects('a corrupt state file', 'malformed-shim-state', () => packShim({ ...good(), [SHIM_STATE_FILE]: '{' }), 'not valid JSON');
rejects('a state file of another format', 'malformed-shim-state', () => packShim({ ...good(), [SHIM_STATE_FILE]: '{"format":"x"}' }), 'not a shim-state/1 file');
rejects('a state rule without a digest', 'malformed-shim-state', () => packShim({ ...good(), [SHIM_STATE_FILE]: JSON.stringify({ format: 'shim-state/1', rules: { a: { witness: {} } } }) }), 'anchorDigest');
let all: ShimFolderError | null = null;
try { packShim({ 'README.md': '', 'handlers/x.y.js': '' }); } catch (err) { if (err instanceof ShimFolderError) all = err; }
check('every problem is reported at once', (all?.problems.length ?? 0) >= 3, all?.problems.join(' | '));

console.log('handler names that differ only in case, or are Windows device names');
const caseSpec = {
  id: 'k', match: { hosts: ['example.com'] },
  rules: [
    { id: 'a', anchor: { primary: { kind: 'css', value: '.a' } }, mutations: [{ kind: 'script', handler: 'Foo', mount: { strategy: 'portal' } }] },
    { id: 'b', anchor: { primary: { kind: 'css', value: '.b' } }, mutations: [{ kind: 'script', handler: 'foo', mount: { strategy: 'portal' } }] },
  ],
};
rejects('a folder with handlers/Foo.js and handlers/foo.js', 'malformed-shim-folder',
  () => readShimFolder({ [SHIM_JSON]: JSON.stringify(caseSpec), 'handlers/Foo.js': expressionToModule('function a() {}'), 'handlers/foo.js': expressionToModule('function b() {}') }),
  'handler names "Foo" and "foo" differ only in case');
for (const device of ['CON', 'nul', 'Com1', 'LPT9', 'aux', 'prn']) {
  rejects(`a handlers/${device}.js file (a Windows device name)`, 'malformed-shim-folder',
    () => readShimFolder({ [SHIM_JSON]: JSON.stringify({ id: 'd', match: { hosts: ['example.com'] }, rules: [] }), [`handlers/${device}.js`]: expressionToModule('function d() {}') }),
    `"${device}" is not a valid handler name`);
}
// `<name>.js` must fit a 255-byte file-name component.
{
  const longest = 'h'.repeat(252);
  check('a 252-character handler name is accepted', (() => {
    try { readShimFolder({ [SHIM_JSON]: JSON.stringify({ id: 'l', match: { hosts: ['example.com'] }, rules: [] }), [`handlers/${longest}.js`]: expressionToModule('function l() {}') }); return true; } catch { return false; }
  })());
  rejects('a 253-character handler name', 'malformed-shim-folder',
    () => readShimFolder({ [SHIM_JSON]: JSON.stringify({ id: 'l', match: { hosts: ['example.com'] }, rules: [] }), [`handlers/${longest}h.js`]: expressionToModule('function l() {}') }),
    'at most 252 characters');
}
rejects('a .shim whose handlers map names CON', 'malformed-shim-file',
  () => unpackShim({ format: 'shim/1', name: 'd', spec: { id: 'd', match: { hosts: ['example.com'] }, rules: [] }, handlers: { CON: expressionToModule('function d() {}') } }),
  'handler name "CON" can\'t be a file name');
check('names that only start like a device name are fine', (() => {
  try { readShimFolder({ [SHIM_JSON]: JSON.stringify({ id: 'd', match: { hosts: ['example.com'] }, rules: [] }), 'handlers/console.js': 'module.exports = function c() {};', 'handlers/com10.js': 'module.exports = function c() {};', 'handlers/nul_check.js': 'module.exports = function c() {};' }); return true; } catch { return false; }
})());
rejects('a .shim whose handlers map has Foo and foo', 'malformed-shim-file',
  () => unpackShim({ format: 'shim/1', name: 'k', spec: caseSpec, handlers: { Foo: expressionToModule('function a() {}'), foo: expressionToModule('function b() {}') } }),
  'differ only in case');
rejects('checking out a spec whose rules define Foo and foo', 'malformed-shim-folder',
  () => checkoutShim({ spec: { ...caseSpec, rules: caseSpec.rules.map((r, i) => ({ ...r, handlers: { [i ? 'foo' : 'Foo']: 'function h() {}' } })) } as unknown as Spec }),
  'differ only in case');

console.log('malformed .shim files');
rejects('not JSON', 'malformed-shim-file', () => unpackShim('{'), 'not valid JSON');
rejects('another format', 'malformed-shim-file', () => unpackShim({ ...EXPORT, format: 'shim-pack/1' }), 'unsupported format "shim-pack/1"');
rejects('no spec', 'malformed-shim-file', () => unpackShim({ format: 'shim/1' }), '"spec" is missing');
rejects('a non-string handler', 'malformed-shim-file', () => unpackShim({ ...EXPORT, handlers: { notes: 1 } }), 'not a source string');
rejects('a handler name that can\'t be a file', 'malformed-shim-file', () => unpackShim({ ...EXPORT, handlers: { ...EXPORT.handlers, '../evil': 'x' } }), 'can\'t be a file name');
rejects('handler names that differ only in case', 'malformed-shim-file', () => unpackShim({ ...EXPORT, handlers: { ...EXPORT.handlers, Notes: NOTES_MODULE } }), 'differ only in case');
rejects('a Windows-reserved handler name', 'malformed-shim-file', () => unpackShim({ ...EXPORT, handlers: { ...EXPORT.handlers, Aux: 'x' } }), 'handler name "Aux" can\'t be a file name');

console.log('portable handler file names');
// On the default macOS / Windows filesystems foo.js and Foo.js are one file:
// a checkout that emitted both would silently keep only the last one.
const portableSpec: Spec = {
  id: 'case', match: { hosts: ['example.com'] },
  rules: [
    { id: 'a', anchor: { primary: { kind: 'css', value: '.a' } }, mutations: [{ kind: 'script', handler: 'mark' }], handlers: { mark: 'function mark() {}' } },
    { id: 'b', anchor: { primary: { kind: 'css', value: '.b' } }, mutations: [{ kind: 'script', handler: 'Mark' }], handlers: { Mark: 'function Mark() {}' } },
  ],
};
rejects('a checkout refuses handler names that differ only in case', 'malformed-shim-folder', () => checkoutShim({ spec: portableSpec }), '"mark" and "Mark" differ only in case');
const reservedSpec: Spec = {
  id: 'reserved', match: { hosts: ['example.com'] },
  rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.a' } }, mutations: [{ kind: 'script', handler: 'con' }], handlers: { con: 'function con() {}' } }],
};
rejects('a checkout refuses a Windows device name', 'malformed-shim-folder', () => checkoutShim({ spec: reservedSpec }), 'handler name "con" can\'t be a file name');
rejects('a folder read from a case-sensitive disk refuses both', 'malformed-shim-folder',
  () => readShimFolder({ ...good(), 'handlers/NOTES.js': NOTES_MODULE }), 'differ only in case');
check('distinct names that only share a prefix still check out', (() => {
  const files = checkoutShim({ spec: { ...portableSpec, rules: [portableSpec.rules?.[0] as Rule, { ...(portableSpec.rules?.[1] as Rule), mutations: [{ kind: 'script', handler: 'markAll' }], handlers: { markAll: 'function markAll() {}' } }] } });
  return typeof files['handlers/mark.js'] === 'string' && typeof files['handlers/markAll.js'] === 'string';
})());
const inline = JSON.parse(JSON.stringify(EXPORT)) as typeof EXPORT & { spec: Spec };
const inlineRule = inline.spec.rules?.[1];
if (inlineRule) inlineRule.handlers = { notes: 'function other() {}' };
rejects('an inline handler colliding with the file\'s map', 'malformed-shim-file', () => unpackShim(inline), 'different source');
const legacy = JSON.parse(JSON.stringify(EXPORT)) as { spec: Spec; handlers: Record<string, string> };
legacy.handlers = { strip: TRANSFORM_MODULE, page: ROUTE_MODULE };
const legacyRule = legacy.spec.rules?.[1];
if (legacyRule) legacyRule.handlers = { notes: 'function notes() {}' };
const folded = unpackShim(legacy);
check('inline rule handlers fold into handlers/ (canonical on the way back)',
  folded['handlers/notes.js'] === expressionToModule('function notes() {}') && !folded[SHIM_JSON]?.includes('function notes'));

console.log('handler names that are Object.prototype keys');
// `constructor` is a legal handler name (HANDLER_NAME_RE); a plain-object map
// would see an inherited `constructor` as present. `__proto__` is refused as
// a handler name: a plain object's assignment swallows it, so the browser's
// stored-handler bag (and the spec's plain handlers maps) would drop it.
{
  const protoSpec = {
    id: 'p', match: { hosts: ['example.com'] },
    rules: [
      { id: 'c', anchor: { primary: { kind: 'css', value: '.c' } }, mutations: [{ kind: 'script', handler: 'constructor', mount: { strategy: 'portal' } }] },
    ],
  };
  const protoFolder: FolderInput = {
    [SHIM_JSON]: JSON.stringify(protoSpec),
    'handlers/constructor.js': expressionToModule('function ctor() {}'),
  };
  rejects('a rule naming "constructor" with no file', 'malformed-shim-folder',
    () => readShimFolder({ [SHIM_JSON]: JSON.stringify(protoSpec) }),
    'handlers/constructor.js is missing');
  const protoRead = readShimFolder(protoFolder);
  check('the constructor handler file is read', Object.keys(protoRead.handlers).join(',') === 'constructor'
    && Object.getOwnPropertyDescriptor(protoRead.handlers, 'constructor')?.value === expressionToModule('function ctor() {}'));
  const protoPacked = packShim(protoFolder);
  check('…and packs as an own handler entry',
    Object.keys(protoPacked.handlers).join(',') === 'constructor'
    && Object.getPrototypeOf(protoPacked.handlers) === Object.prototype);
  const protoUnpacked = unpackShim(JSON.parse(JSON.stringify(protoPacked)) as unknown);
  check('…and unpacks back to its file', protoUnpacked['handlers/constructor.js'] === expressionToModule('function ctor() {}'));
  rejects('a handlers/__proto__.js file', 'malformed-shim-folder',
    () => readShimFolder({ ...protoFolder, 'handlers/__proto__.js': expressionToModule('function proto() {}') }),
    '"__proto__" is not a valid handler name');
  rejects('a .shim whose handlers map names __proto__', 'malformed-shim-file',
    () => unpackShim(JSON.parse('{"format":"shim/1","name":"n","spec":{"id":"e","match":{"hosts":["example.com"]},"rules":[]},"handlers":{"__proto__":"module.exports = function p() {};"}}') as unknown),
    '__proto__');
  const protoEnvelope = JSON.parse('{"format":"shim/1","name":"n","spec":{"id":"e","match":{"hosts":["example.com"]},"rules":[]},"handlers":{},"__proto__":{"x":1}}') as unknown;
  const protoRepacked = packShim(unpackShim(protoEnvelope));
  check('an envelope field named __proto__ round-trips as a field',
    Object.hasOwn(protoRepacked, '__proto__') && Object.getPrototypeOf(protoRepacked) === Object.prototype
    && stableStringify(JSON.parse(JSON.stringify(protoRepacked)) as unknown) === stableStringify(protoEnvelope));
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
