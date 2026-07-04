// Diagnostic harness for the spec linter (src/main/spec-lint.js) — the guard
// that turns hallucinated engine features (a fabricated `cspRelax` directive,
// an invented mutation kind) from silent no-ops into loud feedback.
//
//   node scripts/spec-lint-harness.js
//
// Unknown KINDS are errors (reject the emit); unknown FIELDS are warnings
// (surfaced to the model + chat). Bare node — no db, no Electron.

const { lintSpec, assertNoSpecErrors } = require('../src/main/spec-lint');

let failures = 0;
function check(label, cond, detail) {
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
check('unknown kind flagged as error', res.errors.length === 1 && /cspRelax/.test(res.errors[0]));
check('error names the supported kinds', /hide.*restyle.*script/.test(res.errors[0]));

console.log('missing kind → error');
res = lintSpec({ rules: [{ id: 'a', mutations: [{ handler: 'h' }] }] });
check('missing kind flagged', res.errors.length === 1 && /missing/.test(res.errors[0]));

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

console.log('assertNoSpecErrors');
let threw = false;
try { assertNoSpecErrors({ rules: [{ id: 'a', mutations: [{ kind: 'fake' }] }] }); } catch (_) { threw = true; }
check('throws on unknown kind', threw);
threw = false;
try { assertNoSpecErrors({ rules: [{ id: 'a', bogusField: 1, mutations: [{ kind: 'hide' }] }] }); } catch (_) { threw = true; }
check('does NOT throw on warning-only spec', !threw);

console.log('');
if (failures) { console.error(`✗ ${failures} check(s) failed`); process.exit(1); }
console.log('✓ all spec-lint checks passed');
