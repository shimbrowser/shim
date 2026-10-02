// Diagnostic harness for the spec linter (packages/core/src/spec-lint.ts) — the guard
// that turns hallucinated engine features (a fabricated `cspRelax` directive,
// an invented mutation kind) from silent no-ops into loud feedback.
//
//   node out/packages/core/test/spec-lint-harness.js
//
// Unknown KINDS are errors (reject the emit); unknown FIELDS are warnings
// (surfaced to the model + chat). Bare node — no db, no Electron.

import { lintSpec, assertNoSpecErrors, observerLoopWarning } from '../src/spec-lint';

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

console.log('media-hide warnings (hide/remove targeting <video>/<audio> or a player class)');
res = lintSpec({ rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.video-stream' } }, mutations: [{ kind: 'hide' }] }] });
check('hide on .video-stream (the YouTube incident) warns', res.warnings.some((w) => /media element/.test(w)), JSON.stringify(res.warnings));

res = lintSpec({ rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: 'video' } }, mutations: [{ kind: 'hide' }] }] });
check('hide on a bare video type selector warns', res.warnings.some((w) => /media element/.test(w)), JSON.stringify(res.warnings));

res = lintSpec({ rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.player-wrap > video' } }, mutations: [{ kind: 'remove' }] }] });
check('remove on a descendant video type selector warns', res.warnings.some((w) => /media element/.test(w)), JSON.stringify(res.warnings));

res = lintSpec({ rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.foo' }, fallbacks: [{ kind: 'css', value: '.html5-main-video' }] }, mutations: [{ kind: 'hide' }] }] });
check('media selector in a FALLBACK warns', res.warnings.some((w) => /media element/.test(w)), JSON.stringify(res.warnings));

res = lintSpec({ rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.video-card' } }, mutations: [{ kind: 'hide' }] }] });
check('hide on .video-card (a utility class, not the player) does NOT warn', !res.warnings.some((w) => /media element/.test(w)), JSON.stringify(res.warnings));

// Player-class alternatives are token-bounded: a class that CONTAINS a player
// class name but isn't it must not draw a false warning (Codex #316 feedback).
for (const sel of ['.video-stream-thumbnail', '.video-js-poster', '.html5-video-preview', '[data-id="video-stream-preview"]']) {
  res = lintSpec({ rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: sel } }, mutations: [{ kind: 'hide' }] }] });
  check(`hide on "${sel}" (contains but does not select a player class) does NOT warn`,
    !res.warnings.some((w) => /media element/.test(w)), JSON.stringify(res.warnings));
}
// ...but the real player classes still warn as tokens.
for (const sel of ['.video-stream', '.player > .html5-main-video', '.video-js']) {
  res = lintSpec({ rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: sel } }, mutations: [{ kind: 'hide' }] }] });
  check(`hide on the real player class "${sel}" still warns`,
    res.warnings.some((w) => /media element/.test(w)), JSON.stringify(res.warnings));
}

res = lintSpec({ rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.video-stream' } }, mutations: [{ kind: 'restyle', properties: { opacity: '0.5' } }] }] });
check('restyle on .video-stream does NOT warn (only hide/remove blank the player)', !res.warnings.some((w) => /media element/.test(w)), JSON.stringify(res.warnings));

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

console.log('inject lint (§6): payload-shape errors, static-only enforcement');
function tInjectLint(): void {
  const mk = (mut: Record<string, unknown>) => lintSpec({
    id: 's', match: { hosts: ['x.test'] },
    rules: [{ id: 'r', anchor: { primary: { kind: 'css', value: '.a' } }, mutations: [mut] }],
  });
  check('valid inject-element clean', mk({ kind: 'inject-element', element: { tag: 'span', text: 'hi' } }).errors.length === 0);
  check('missing element errors', mk({ kind: 'inject-element' }).errors.length > 0);
  check('html on inject-element errors', mk({ kind: 'inject-element', html: '<b>x</b>' }).errors.length > 0);
  check('on* attr is an emit error', mk({ kind: 'inject-element', element: { tag: 'a', attrs: { onclick: 'x()' } } }).errors.length > 0);
  check('bad placement errors', mk({ kind: 'inject-element', element: { tag: 'span' }, placement: 'inside' }).errors.length > 0);
  check('valid inject-html clean', mk({ kind: 'inject-html', html: '<span>ok</span>' }).errors.length === 0);
  check('missing html errors', mk({ kind: 'inject-html' }).errors.length > 0);
  check('element on inject-html errors', mk({ kind: 'inject-html', element: { tag: 'span' } }).errors.length > 0);
  check('over-cap html errors', mk({ kind: 'inject-html', html: 'x'.repeat(40000) }).errors.length > 0);
  const w = mk({ kind: 'inject-html', html: '<a onclick="x()">y</a>' });
  check('active html warns (not errors)', w.errors.length === 0 && w.warnings.some((s) => s.includes('stripped')), JSON.stringify(w.warnings));
  check('unknown mutation field still warns', mk({ kind: 'inject-element', element: { tag: 'span' }, bogusField: 1 }).warnings.length > 0);
}
tInjectLint();

console.log('rewrite-response lint (§6, docs/2026-08-04-rewrite-response-design.md)');
function tRewriteLint(): void {
  const VALID_MUT = { kind: 'rewrite-response', endpoint: { method: 'GET', path: '/list/tracks' }, transform: 'filterHeard' };
  const CLEAN_SRC = 'function filterHeard(json, ctx) { json.tracks = json.tracks.filter(function (t) { return !t.heard; }); return json; }';
  const mk = (mut: Record<string, unknown>, ruleHandlers?: Record<string, string>) => lintSpec({
    id: 's', match: { hosts: ['x.test'] },
    rules: [{ id: 'r', mutations: [mut], handlers: ruleHandlers }],
  });

  const clean = mk(VALID_MUT, { filterHeard: CLEAN_SRC });
  check('valid rewrite mutation: no errors', clean.errors.length === 0, JSON.stringify(clean.errors));
  check('valid rewrite mutation: no warnings', clean.warnings.length === 0, JSON.stringify(clean.warnings));

  const missingEndpoint = mk({ kind: 'rewrite-response', transform: 'filterHeard' }, { filterHeard: CLEAN_SRC });
  check('missing endpoint → error', missingEndpoint.errors.length > 0, JSON.stringify(missingEndpoint.errors));

  const badPath = mk({ kind: 'rewrite-response', endpoint: { path: '/' }, transform: 'filterHeard' }, { filterHeard: CLEAN_SRC });
  check('bad path → error', badPath.errors.some((e) => /does not parse/.test(e)), JSON.stringify(badPath.errors));

  const missingTransform = mk({ kind: 'rewrite-response', endpoint: { path: '/list/tracks' } }, { filterHeard: CLEAN_SRC });
  check('missing transform → error', missingTransform.errors.some((e) => /transform/.test(e)), JSON.stringify(missingTransform.errors));

  const unboundTransform = mk(VALID_MUT, {});
  check('unbound transform name → error', unboundTransform.errors.some((e) => /not bound/.test(e)), JSON.stringify(unboundTransform.errors));
  const unboundTransformNoHandlers = mk(VALID_MUT);
  check('unbound transform name (no handlers field at all) → error', unboundTransformNoHandlers.errors.some((e) => /not bound/.test(e)), JSON.stringify(unboundTransformNoHandlers.errors));

  const patchLevelBound = lintSpec({
    id: 's', match: { hosts: ['x.test'] },
    handlers: { filterHeard: CLEAN_SRC },
    rules: [{ id: 'r', mutations: [VALID_MUT] }],
  });
  check(
    'transform bound via the patch-level handler set (not rule.handlers): no errors',
    patchLevelBound.errors.length === 0,
    JSON.stringify(patchLevelBound.errors),
  );

  const apiSrc = mk(VALID_MUT, { filterHeard: 'function filterHeard(json) { var x = api.storage.get("x"); return json; }' });
  check(
    'transform source referencing api. → warning',
    apiSrc.warnings.some((w) => /transform runs in the page's main world — api\.\* does not exist there/.test(w)),
    JSON.stringify(apiSrc.warnings),
  );
  check('…as a warning, not an error', apiSrc.errors.length === 0);

  const asyncSrc = mk(VALID_MUT, { filterHeard: 'async function filterHeard(json) { await Promise.resolve(); return json; }' });
  check(
    'transform source with async/await → warning',
    asyncSrc.warnings.some((w) => /transform must be synchronous — async transforms are not supported/.test(w)),
    JSON.stringify(asyncSrc.warnings),
  );

  const domSrc = mk(VALID_MUT, { filterHeard: 'function filterHeard(json) { document.title = "x"; return json; }' });
  check(
    'transform source touching document. → warning',
    domSrc.warnings.some((w) => /transform should be a pure data function — DOM access is a script-handler job/.test(w)),
    JSON.stringify(domSrc.warnings),
  );
  const windowSrc = mk(VALID_MUT, { filterHeard: 'function filterHeard(json) { window.foo = 1; return json; }' });
  check(
    'transform source touching window. → warning',
    windowSrc.warnings.some((w) => /DOM access is a script-handler job/.test(w)),
    JSON.stringify(windowSrc.warnings),
  );

  const bogusField = mk({ ...VALID_MUT, bogusField: 1 }, { filterHeard: CLEAN_SRC });
  check('unknown extra field on the mutation still warns', bogusField.warnings.some((w) => /bogusField/.test(w)), JSON.stringify(bogusField.warnings));

  // Fix 1a: syntax-check the bound transform source itself. A malformed
  // source (missing brace) previously passed lint/commit untouched, then
  // poisoned rewrite-install.ts's ONE shared generated wrapper script at
  // install time — one bad rule's syntax error killed every rewrite rule on
  // the host. Deliberately fails BOTH the expr probe (`(` + src + `)`) AND
  // the module probe (src as bare statements) — missing the final closing
  // brace for `filterHeard`'s own body.
  const MALFORMED_SRC = 'function filterHeard(json, ctx) { json.tracks = json.tracks.filter(function (t) { return !t.heard; });';
  const malformed = mk(VALID_MUT, { filterHeard: MALFORMED_SRC });
  check(
    'malformed transform source (fails both expr and module form) → error',
    malformed.errors.some((e) => /does not parse as JavaScript/.test(e)),
    JSON.stringify(malformed.errors),
  );
  check(
    'malformed transform error names the rule and the transform',
    malformed.errors.some((e) => /rule "r"/.test(e) && /"filterHeard"/.test(e)),
    JSON.stringify(malformed.errors),
  );

  // Valid MODULE-form source (an imported/exported shim's convention —
  // shims.ts's export path wraps as `module.exports = <source>;\n`, TRAILING
  // SEMICOLON included) must not trip the syntax check. The semicolon is
  // load-bearing for detection: WITHOUT it, `module.exports = fn` also
  // parses as a valid parenthesized ASSIGNMENT EXPRESSION (`module` being
  // undeclared doesn't matter to a syntax-only probe), so the expr probe
  // would wrongly claim it first — matching the real wrapped-export shape
  // here is what actually exercises the module branch.
  const MODULE_SRC = 'module.exports = function filterHeard(json, ctx) { json.tracks = json.tracks.filter(function (t) { return !t.heard; }); return json; };';
  const validModule = mk(VALID_MUT, { filterHeard: MODULE_SRC });
  check(
    'valid MODULE-form transform source: no syntax error',
    !validModule.errors.some((e) => /does not parse as JavaScript/.test(e)),
    JSON.stringify(validModule.errors),
  );
  check('valid MODULE-form transform source: no errors at all', validModule.errors.length === 0, JSON.stringify(validModule.errors));
}
tRewriteLint();

console.log('intercept lint (§6, docs/2026-08-04-intercept-design.md)');
function tInterceptLint(): void {
  const mk = (mut: Record<string, unknown>, ruleHandlers?: Record<string, string>) => lintSpec({
    id: 's', match: { hosts: ['x.test'] },
    rules: [{ id: 'r', mutations: [mut], handlers: ruleHandlers }],
  });

  const VALID_MUT = { kind: 'intercept', module: { loader: 'amd', id: 'player' }, symbol: 'playTrack', wrap: 'w' };
  const CLEAN_WRAP = 'function w(original, ctx) { return function () { return original.apply(this, arguments); }; }';

  const clean = mk(VALID_MUT, { w: CLEAN_WRAP });
  check('valid intercept mutation: no errors', clean.errors.length === 0, JSON.stringify(clean.errors));
  check('valid intercept mutation: no warnings', clean.warnings.length === 0, JSON.stringify(clean.warnings));

  // Payload validation delegates to validateInterceptMutation — one source of
  // truth shared with the runtime table builder (collectInterceptEntries).
  const badLoader = mk({ kind: 'intercept', module: { loader: 'webpack', id: 'x' }, symbol: 's', wrap: 'w' }, { w: CLEAN_WRAP });
  check('intercept unknown loader is an error', badLoader.errors.some((e) => e.includes('loader')), JSON.stringify(badLoader.errors));

  const symbolNoWrap = mk({ kind: 'intercept', module: { loader: 'amd', id: 'player' }, symbol: 'playTrack' });
  check('intercept symbol without wrap is an error', symbolNoWrap.errors.some((e) => e.includes('symbol')), JSON.stringify(symbolNoWrap.errors));

  const unboundWrap = mk({ kind: 'intercept', module: { loader: 'amd', id: 'player' }, symbol: 'playTrack', wrap: 'nope' });
  check('intercept unbound wrap is an error', unboundWrap.errors.some((e) => e.includes('nope')), JSON.stringify(unboundWrap.errors));

  const unparsable = mk(VALID_MUT, { w: 'function w(original { BROKEN' });
  check(
    'intercept unparsable wrap source is an error',
    unparsable.errors.some((e) => /does not parse as JavaScript/.test(e)),
    JSON.stringify(unparsable.errors),
  );

  const apiReach = mk(VALID_MUT, { w: 'function w(o) { return function () { api.storage.set("k", 1); return o.apply(this, arguments); }; }' });
  check('intercept wrap touching api.* warns', apiReach.warnings.some((w) => w.includes('api.')), JSON.stringify(apiReach.warnings));
  check('…as a warning, not an error', apiReach.errors.length === 0);

  const exposeOnly = mk({ kind: 'intercept', module: { loader: 'amd', id: 'player' } });
  check('intercept expose-only is clean', exposeOnly.errors.length === 0, JSON.stringify(exposeOnly.errors));

  // Deliberate asymmetry from rewrite-response's transform lint: a wrap's
  // REPLACEMENT function may legitimately be async (the page just calls it —
  // whether it returns a promise is the page's business), so async/await in
  // a wrap source must NOT trip the "must be synchronous" warning the
  // rewrite-response transform lint carries.
  const asyncWrap = mk(VALID_MUT, { w: 'function w(o) { return async function () { return await o.apply(this, arguments); }; }' });
  check(
    'intercept wrap with async/await does not warn (unlike rewrite-response transforms)',
    !asyncWrap.warnings.some((w) => /synchronous/.test(w)),
    JSON.stringify(asyncWrap.warnings),
  );

  const bogusField = mk({ ...VALID_MUT, bogusField: 1 }, { w: CLEAN_WRAP });
  check('unknown extra field on the mutation still warns', bogusField.warnings.some((w) => /bogusField/.test(w)), JSON.stringify(bogusField.warnings));

  const patchLevelBound = lintSpec({
    id: 's', match: { hosts: ['x.test'] },
    handlers: { w: CLEAN_WRAP },
    rules: [{ id: 'r', mutations: [VALID_MUT] }],
  });
  check(
    'wrap bound via the patch-level handler set (not rule.handlers): no errors',
    patchLevelBound.errors.length === 0,
    JSON.stringify(patchLevelBound.errors),
  );
}
tInterceptLint();

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

console.log('spec.connections — engine-enum ERROR (shim-db remote-transport §8, cheap same-turn feedback)');
res = lintSpec({ connections: [{ name: 'warehouse', engine: 'oracle' }], rules: [] });
check('unknown engine flagged as error', res.errors.length === 1 && /connections\[0\]/.test(res.errors[0] || '') && /oracle/.test(res.errors[0] || ''), JSON.stringify(res.errors));
check('error names the supported engines', /postgres.*mysql.*mariadb.*mssql.*sqlite-remote/.test(res.errors[0] || ''), JSON.stringify(res.errors));
res = lintSpec({ connections: [{ name: 'warehouse', engine: 'postgres' }], rules: [] });
check('known engine: no error', res.errors.length === 0, JSON.stringify(res.errors));
check('known engine: no warnings either', res.warnings.length === 0, JSON.stringify(res.warnings));
res = lintSpec({ connections: [{ name: 'a', engine: 'postgres' }, { name: 'b', engine: 'not-a-real-engine' }], rules: [] });
check('one bad engine among several: exactly 1 error, names the right index', res.errors.length === 1 && /connections\[1\]/.test(res.errors[0] || ''), JSON.stringify(res.errors));

console.log('spec.connections — malformed engine (missing/non-string) is left to the full validator, not duplicated here');
res = lintSpec({ connections: [{ name: 'warehouse' }], rules: [] });
check('missing engine: lintSpec itself raises no engine-enum error', res.errors.length === 0, JSON.stringify(res.errors));
res = lintSpec({ connections: [{ name: 'warehouse', engine: 42 }], rules: [] });
check('non-string engine: lintSpec itself raises no engine-enum error', res.errors.length === 0, JSON.stringify(res.errors));

console.log('spec.connections — supabase with no nested storage.tables → WARNING, not an error (task-5)');
res = lintSpec({ connections: [{ name: 'proj', engine: 'supabase' }], rules: [] });
check('no declared tables: a warning fires', res.warnings.length === 1, JSON.stringify(res.warnings));
check('…never an error (this shape is legitimate)', res.errors.length === 0, JSON.stringify(res.errors));
check('…names the connection index', /connections\[0\]/.test(res.warnings[0] || ''), JSON.stringify(res.warnings));
check('…names the connection by name', /"proj"/.test(res.warnings[0] || ''), JSON.stringify(res.warnings));
check('…mentions the paste door / existing project', /paste door/i.test(res.warnings[0] || ''), JSON.stringify(res.warnings));
check('…mentions the declared-table allowlist staying inactive', /allowlist/i.test(res.warnings[0] || ''), JSON.stringify(res.warnings));

res = lintSpec({ connections: [{ name: 'proj', engine: 'supabase', storage: { tables: [] } }], rules: [] });
check('empty tables array: same warning fires', res.warnings.length === 1, JSON.stringify(res.warnings));

res = lintSpec({
  connections: [{
    name: 'proj',
    engine: 'supabase',
    storage: { tables: [{ name: 'notes', columns: [{ name: 'id', type: 'integer', primaryKey: true }] }] },
  }],
  rules: [],
});
check('declared ≥1 table: silent', res.warnings.length === 0, JSON.stringify(res.warnings));

res = lintSpec({ connections: [{ name: 'wh', engine: 'postgres' }], rules: [] });
check('non-supabase engine with no storage: silent (the warning is supabase-only)', res.warnings.length === 0, JSON.stringify(res.warnings));

res = lintSpec({
  connections: [
    { name: 'a', engine: 'supabase' },
    { name: 'b', engine: 'not-a-real-engine' },
  ],
  rules: [],
});
check('bad-engine ERROR and supabase-no-tables WARNING coexist independently', res.errors.length === 1 && res.warnings.length === 1, JSON.stringify({ errors: res.errors, warnings: res.warnings }));

console.log('api.db.connection("x") referencing an undeclared connection → warning');
const DB_CONN_HANDLER = "async function tag({ anchor, api }) { const r = await api.db.connection('nope').query('SELECT 1'); }";
res = lintSpec({
  rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.row' } }, mutations: [{ kind: 'script', handler: 'tag' }], handlers: { tag: DB_CONN_HANDLER } }],
});
check('undeclared connection name warns', res.warnings.some((w) => /api\.db\.connection\("nope"\)/.test(w) && /not.*declared/.test(w)), JSON.stringify(res.warnings));
check('…as a warning, not an error', res.errors.length === 0, JSON.stringify(res.errors));

res = lintSpec({
  connections: [{ name: 'nope', engine: 'postgres' }],
  rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.row' } }, mutations: [{ kind: 'script', handler: 'tag' }], handlers: { tag: DB_CONN_HANDLER } }],
});
check('DECLARED connection name is silent', res.warnings.length === 0, JSON.stringify(res.warnings));

const DB_CONN_DOUBLE_QUOTED = 'function tag({ api }) { api.db.connection("warehouse").run("DELETE FROM x"); }';
res = lintSpec({
  connections: [{ name: 'warehouse', engine: 'mysql' }],
  rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.row' } }, mutations: [{ kind: 'script', handler: 'tag' }], handlers: { tag: DB_CONN_DOUBLE_QUOTED } }],
});
check('double-quoted form, declared: silent', res.warnings.length === 0, JSON.stringify(res.warnings));

res = lintSpec({
  rules: [{ id: 'a', anchor: { primary: { kind: 'css', value: '.row' } }, mutations: [{ kind: 'script', handler: 'tag' }], handlers: { tag: 'function tag() { /* no db connection here */ }' } }],
});
check('handler without api.db.connection is silent', res.warnings.length === 0, JSON.stringify(res.warnings));

console.log('');
if (failures) { console.error(`✗ ${failures} check(s) failed`); process.exit(1); }
console.log('✓ all spec-lint checks passed');
