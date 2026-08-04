// Diagnostic harness for the spec linter (src/main/spec-lint.js) — the guard
// that turns hallucinated engine features (a fabricated `cspRelax` directive,
// an invented mutation kind) from silent no-ops into loud feedback.
//
//   node scripts/spec-lint-harness.js
//
// Unknown KINDS are errors (reject the emit); unknown FIELDS are warnings
// (surfaced to the model + chat). Bare node — no db, no Electron.

import { lintSpec, assertNoSpecErrors, observerLoopWarning } from '../src/main/spec-lint';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

console.log('clean spec — no errors, no warnings');
const clean = {
  rules: [
    { id: 'a', anchor: { primary: { kind: 'css', value: '.x' } }, mutations: [{ kind: 'hide' }] },
    { id: 'b', anchor: { primary: { kind: 'css', value: '.y' } }, mutations: [{ kind: 'restyle', properties: { color: 'red' } }] },
    { id: 'c', anchor: { primary: { kind: 'css', value: '.z' }, fallbacks: [], witness: { v: 1 } }, mutations: [{ kind: 'script', handler: 'h', mount: { strategy: 'portal' } }], handlers: { h: 'function h(){}' } },
    { id: 'd', mutations: [{ kind: 'redirect', from: 'a.com', to: 'b.com', exceptPaths: ['/x'] }] },
    { id: 'e', mutations: [{ kind: 'mount-route', handler: 'r', pattern: '/p', title: 'P' }], handlers: { r: 'function r(){}' } },
  ],
};
let res = lintSpec(clean);
check('clean: no errors', res.errors.length === 0, JSON.stringify(res.errors));
check('clean: no warnings', res.warnings.length === 0, JSON.stringify(res.warnings));

console.log('unknown mutation kind → error');
res = lintSpec({ rules: [{ id: 'a', mutations: [{ kind: 'cspRelax' }] }] });
const [cspError] = res.errors;
check('unknown kind flagged as error', res.errors.length === 1 && !!cspError && /cspRelax/.test(cspError));
check('error names the supported kinds', !!cspError && /hide.*restyle.*script/.test(cspError));

console.log('missing kind → error');
res = lintSpec({ rules: [{ id: 'a', mutations: [{ handler: 'h' }] }] });
const [missingKindError] = res.errors;
check('missing kind flagged', res.errors.length === 1 && !!missingKindError && /missing/.test(missingKindError));

console.log('the cspRelax-as-rule-field case → warning, not silent');
res = lintSpec({
  rules: [{ id: 'reading-time-badge', cspRelax: ['connect-src', 'frame-src'], anchor: { primary: { kind: 'css', value: '.x' } }, mutations: [{ kind: 'hide' }] }],
});
check('unknown rule field warns', res.warnings.some((w) => /cspRelax/.test(w)));
check('unknown rule field is NOT an error', res.errors.length === 0);

console.log('unknown mutation field → warning');
res = lintSpec({ rules: [{ id: 'a', mutations: [{ kind: 'script', handler: 'h', cspRelax: [] }] }] });
check('unknown mutation field warns', res.warnings.some((w) => /cspRelax/.test(w)));
check('no error for unknown mutation field', res.errors.length === 0);

console.log('unknown anchor field → warning');
res = lintSpec({ rules: [{ id: 'a', anchor: { primary: {}, bogus: 1 }, mutations: [{ kind: 'hide' }] }] });
check('unknown anchor field warns', res.warnings.some((w) => /bogus/.test(w)));

console.log('per-patch declarative kind is allowed');
res = lintSpec({ mutations: { 'my-custom': {} }, rules: [{ id: 'a', mutations: [{ kind: 'my-custom' }] }] });
check('declared custom kind: no error', res.errors.length === 0, JSON.stringify(res.errors));

console.log('anchor-quality warnings (positional / generated-class primaries)');
res = lintSpec({ rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: 'div > div:nth-child(3) span' } }, mutations: [{ kind: 'hide' }] }] });
check('positional primary warns', res.warnings.some((w) => /positional/.test(w)), JSON.stringify(res.warnings));
check('positional primary is NOT an error', res.errors.length === 0);
res = lintSpec({ rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.css-1a2b3c4' } }, mutations: [{ kind: 'hide' }] }] });
check('generated-class primary warns', res.warnings.some((w) => /generated/.test(w)), JSON.stringify(res.warnings));
res = lintSpec({
  rules: [{
    id: 'a',
    anchor: {
      primary: { kind: 'data-attr', name: 'data-testid', value: 'cart' },
      fallbacks: [{ kind: 'css', value: 'main > div:nth-of-type(2)' }],
    },
    mutations: [{ kind: 'hide' }],
  }],
});
check('positional FALLBACK does not warn (legit ladder tail)', res.warnings.length === 0, JSON.stringify(res.warnings));
res = lintSpec({ rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: 'main .track-row' } }, mutations: [{ kind: 'hide' }] }] });
check('human-named class primary does not warn', res.warnings.length === 0, JSON.stringify(res.warnings));

console.log('api.ai without the "ai" permission declared (§19)');
const AI_HANDLER = 'async function tag({ anchor, api }) { const r = await api.ai.complete({ prompt: "x" }); }';
res = lintSpec({
  rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.row' } }, mutations: [{ kind: 'script', handler: 'tag' }], handlers: { tag: AI_HANDLER } }],
});
check('api.ai without declaration warns', res.warnings.some((w) => /set-permissions/.test(w)), JSON.stringify(res.warnings));
check('…as a warning, not an error', res.errors.length === 0);
res = lintSpec({
  permissions: ['ai'],
  rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.row' } }, mutations: [{ kind: 'script', handler: 'tag' }], handlers: { tag: AI_HANDLER } }],
});
check('api.ai WITH declaration is silent', res.warnings.length === 0, JSON.stringify(res.warnings));
res = lintSpec({
  rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.row' } }, mutations: [{ kind: 'script', handler: 'tag' }], handlers: { tag: 'function tag() { /* no ai here */ }' } }],
});
check('handler without api.ai is silent', res.warnings.length === 0, JSON.stringify(res.warnings));

console.log('reorder/reshape — valid payloads pass');
res = lintSpec({ rules: [
  { id: 'r1', anchor: { primary: { kind: 'css', value: '.x' } }, mutations: [{ kind: 'reorder', position: 'first' }] },
  { id: 'r2', anchor: { primary: { kind: 'css', value: '.x' } }, mutations: [{ kind: 'reorder', position: 2 }] },
  { id: 'r3', anchor: { primary: { kind: 'css', value: '.x' } }, mutations: [{ kind: 'reorder', before: { kind: 'text', value: 'Now Playing' } }] },
  { id: 'r4', anchor: { primary: { kind: 'css', value: '.x' } }, mutations: [{ kind: 'reshape', layout: 'grid', columns: 3, gap: '1rem' }] },
  { id: 'r5', anchor: { primary: { kind: 'css', value: '.x' } }, mutations: [{ kind: 'reshape', columns: '240px 1fr' }] },
] });
check('valid layout kinds: no errors', res.errors.length === 0, JSON.stringify(res.errors));
check('valid layout kinds: no warnings', res.warnings.length === 0, JSON.stringify(res.warnings));

console.log('reorder/reshape — malformed payloads error');
res = lintSpec({ rules: [{ id: 'a', mutations: [{ kind: 'reorder' }] }] });
check('reorder with no mode → error', res.errors.length === 1 && /exactly one/.test(res.errors[0] || ''));
res = lintSpec({ rules: [{ id: 'a', mutations: [{ kind: 'reorder', position: 'first', before: { kind: 'css', value: '.x' } }] }] });
check('reorder with two modes → error', res.errors.length === 1 && /exactly one/.test(res.errors[0] || ''));
res = lintSpec({ rules: [{ id: 'a', mutations: [{ kind: 'reorder', position: 'top' }] }] });
check('bad position enum → error', res.errors.length === 1 && /first.*last.*number/.test(res.errors[0] || ''));
res = lintSpec({ rules: [{ id: 'a', mutations: [{ kind: 'reorder', before: 'the sidebar' }] }] });
check('before not an anchor spec → error', res.errors.length === 1 && /anchor spec/.test(res.errors[0] || ''));
res = lintSpec({ rules: [{ id: 'a', mutations: [{ kind: 'reshape' }] }] });
check('reshape with no fields → error', res.errors.length === 1 && /at least one/.test(res.errors[0] || ''));
res = lintSpec({ rules: [{ id: 'a', mutations: [{ kind: 'reshape', layout: 'table' }] }] });
check('bad layout enum → error', res.errors.length === 1 && /"flex" or "grid"/.test(res.errors[0] || ''));
res = lintSpec({ rules: [{ id: 'a', mutations: [{ kind: 'reshape', layout: 'flex', justify: 'middle' }] }] });
check('bad justify enum → error', res.errors.length === 1 && /justify/.test(res.errors[0] || ''));
res = lintSpec({ rules: [{ id: 'a', mutations: [{ kind: 'reshape', columns: true }] }] });
check('bad columns type → error', res.errors.length === 1 && /columns/.test(res.errors[0] || ''));

console.log('reorder — at most one reorder mutation per rule');
res = lintSpec({
  rules: [{
    id: 'r',
    mutations: [
      { kind: 'reorder', position: 'first' },
      { kind: 'reorder', before: { kind: 'css', value: '.x' } },
    ],
  }],
});
// Each mutation individually satisfies the exactly-one-of-mode check, so the
// only error should be the new per-rule "at most one reorder" check.
check('two reorder mutations on one rule → exactly 1 error', res.errors.length === 1 && /at most one reorder/.test(res.errors[0] || ''), JSON.stringify(res.errors));

console.log('reorder — before/after target anchor-quality lint');
res = lintSpec({
  rules: [{
    id: 'r',
    mutations: [{ kind: 'reorder', before: { kind: 'css', value: '.item:nth-child(3)' } }],
  }],
});
check('positional reorder target warns', res.warnings.some((w) => /positional/.test(w)), JSON.stringify(res.warnings));
check('positional reorder target is NOT an error', res.errors.length === 0, JSON.stringify(res.errors));

console.log('assertNoSpecErrors');
let threw = false;
try { assertNoSpecErrors({ rules: [{ id: 'a', mutations: [{ kind: 'fake' }] }] }); } catch (_) { threw = true; }
check('throws on unknown kind', threw);
threw = false;
try { assertNoSpecErrors({ rules: [{ id: 'a', bogusField: 1, mutations: [{ kind: 'hide' }] }] }); } catch (_) { threw = true; }
check('does NOT throw on warning-only spec', !threw);

console.log('observer-loop heuristic (freeze prevention)');
const LOOP_HANDLER = `function decorate({ anchor, api }) {
  function decorateAll() {
    anchor.querySelectorAll('tr').forEach(function (row) {
      row.querySelectorAll('[data-x]').forEach(function (el) { el.remove(); });
      row.insertBefore(document.createElement('span'), row.firstChild);
    });
  }
  decorateAll();
  var observer = new MutationObserver(function () { decorateAll(); });
  observer.observe(anchor, { childList: true, subtree: true });
  api.cleanup(function () { observer.disconnect(); });
}`;
const SAFE_HANDLER = `function decorate({ anchor, api }) {
  var opts = { childList: true, subtree: true };
  var observer = new MutationObserver(function () {
    observer.disconnect();
    anchor.appendChild(document.createElement('span'));
    observer.observe(anchor, opts);
  });
  observer.observe(anchor, opts);
  api.cleanup(function () { observer.disconnect(); });
}`;
const scriptRule = (src: string) => ({
  rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.row' } }, mutations: [{ kind: 'script', handler: 'decorate' }], handlers: { decorate: src } }],
});
res = lintSpec(scriptRule(LOOP_HANDLER));
check('observer + DOM writes + 1 disconnect warns', res.warnings.some((w) => /MutationObserver/.test(w) && /disconnect/i.test(w)), JSON.stringify(res.warnings));
check('…as a warning, not an error', res.errors.length === 0);
res = lintSpec(scriptRule(SAFE_HANDLER));
check('disconnect-while-mutating pattern (2 disconnects) is silent', res.warnings.length === 0, JSON.stringify(res.warnings));
res = lintSpec(scriptRule('function decorate({ anchor }) { var o = new MutationObserver(function () { console.log("hi"); }); o.observe(anchor, { childList: true }); }'));
check('observer without DOM writes is silent', res.warnings.length === 0, JSON.stringify(res.warnings));
res = lintSpec(scriptRule('function decorate({ anchor }) { anchor.appendChild(document.createElement("b")); return anchor.lastChild; }'));
check('DOM writes without observer is silent', res.warnings.length === 0, JSON.stringify(res.warnings));

console.log('observer-loop heuristic — widened regexes (§ finding 2/3)');
res = lintSpec(scriptRule(`function decorate({ anchor }) {
  var o = new MutationObserver(function () { anchor.setAttribute('data-x', String(Date.now())); });
  o.observe(anchor, { attributes: true });
}`));
check('setAttribute-based loop now warns', res.warnings.some((w) => /MutationObserver/.test(w)), JSON.stringify(res.warnings));
res = lintSpec(scriptRule(`function decorate({ anchor }) {
  var o = new MutationObserver(function () { anchor.textContent = String(Date.now()); });
  o.observe(anchor, { childList: true, characterData: true, subtree: true });
}`));
check('textContent-assignment loop warns', res.warnings.some((w) => /MutationObserver/.test(w)), JSON.stringify(res.warnings));
res = lintSpec(scriptRule(`function decorate({ anchor }) {
  var o = new MutationObserver(function () { anchor.replaceWith(document.createElement('div')); });
  o.observe(anchor.parentNode, { childList: true });
}`));
check('replaceWith-based loop warns', res.warnings.some((w) => /MutationObserver/.test(w)), JSON.stringify(res.warnings));
res = lintSpec(scriptRule(`function decorate({ anchor }) {
  var o = new MutationObserver(function () { anchor.insertAdjacentElement('beforeend', document.createElement('span')); });
  o.observe(anchor, { childList: true, subtree: true });
}`));
check('insertAdjacentElement-based loop warns', res.warnings.some((w) => /MutationObserver/.test(w)), JSON.stringify(res.warnings));
res = lintSpec(scriptRule(`function decorate({ anchor }) {
  var o = new window.MutationObserver(function () { anchor.appendChild(document.createElement('span')); });
  o.observe(anchor, { childList: true, subtree: true });
}`));
check('window.MutationObserver form is detected', res.warnings.some((w) => /MutationObserver/.test(w)), JSON.stringify(res.warnings));

console.log('observer-loop heuristic — accepted limit: two guard-less observers, 2 unrelated cleanup disconnects');
// Neither observer disconnects-before-mutating; the ONLY two `.disconnect(`
// calls in the source are the api.cleanup teardown registrations, one per
// observer. The heuristic counts disconnect() occurrences in the whole
// source text, not which observer each belongs to — so 2 total reads as
// "the safe disconnect/re-observe pattern" and stays silent, even though
// BOTH observers loop indefinitely (obsB's attribute write is the more
// obviously self-triggering one). This is a documented heuristic limit, not
// a bug to fix here — pinning it so a future regex tweak that accidentally
// "fixes" it is a deliberate choice, not a surprise.
const TWO_UNGUARDED_OBSERVERS = `function decorate({ anchor, api }) {
  var obsA = new MutationObserver(function () { anchor.appendChild(document.createElement('span')); });
  obsA.observe(anchor, { childList: true, subtree: true });
  api.cleanup(function () { obsA.disconnect(); });

  var obsB = new MutationObserver(function () { anchor.setAttribute('data-x', '1'); });
  obsB.observe(anchor, { attributes: true });
  api.cleanup(function () { obsB.disconnect(); });
}`;
res = lintSpec(scriptRule(TWO_UNGUARDED_OBSERVERS));
check(
  'two guard-less observers w/ 2 unrelated cleanup disconnects: silent (accepted false negative)',
  res.warnings.length === 0,
  JSON.stringify(res.warnings),
);

console.log('observerLoopWarning — exported helper (single source of truth)');
check('flags a guard-less observer+write, no rule prefix', (() => {
  const w = observerLoopWarning('decorate', LOOP_HANDLER);
  return w !== null && /^handler "decorate"/.test(w) && !/^rule /.test(w);
})());
check('null on the safe disconnect/re-observe pattern', observerLoopWarning('decorate', SAFE_HANDLER) === null);
check('null on plain code', observerLoopWarning('h', 'function h() { return 1; }') === null);

console.log('');
if (failures) { console.error(`✗ ${failures} check(s) failed`); process.exit(1); }
console.log('✓ all spec-lint checks passed');
