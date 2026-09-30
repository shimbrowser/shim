// Harness for the handler-name collision lint (src/main/authoring/spec-lint.ts).
//
// Handlers are authored rule-local (`rule.handlers`), but everything that
// stores or ships them is keyed by NAME alone: patch_files, the `.shim`
// file's `handlers` map, a promoted global impl. extractHandlers flattens
// rule-local handlers into that one map, so two rules defining the same name
// with DIFFERENT source leave only the later rule's source in it. The running
// shim is unaffected (the engine prefers a rule's own inline source), but
// export strips rule-local handlers — the exported file runs the later rule's
// code for both rules. The lint rejects the collision where it is authored.
//
//   node scripts/handler-name-collision-harness.js
//
// Bare node — no db, no Electron.

import { lintSpec, assertNoSpecErrors } from '../src/main/authoring/spec-lint';
import { extractHandlers } from '../src/main/shims/internal';

let failures = 0;
function check(label: string, cond: unknown, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const anchor = (value: string) => ({ primary: { kind: 'css', value } });
const scriptRule = (id: string, handler: string, source: string) => ({
  id, anchor: anchor(`.${id}`), mutations: [{ kind: 'script', handler }], handlers: { [handler]: source },
});

const NOTES = 'function mount({ anchor }) { anchor.dataset.kind = "notes"; }';
const BADGE = 'function mount({ anchor }) { anchor.dataset.kind = "badge"; }';

console.log('why it matters: the flattened map keeps one source per name');
const colliding = { id: 's', rules: [scriptRule('notes', 'mount', NOTES), scriptRule('badge', 'mount', BADGE)] };
const flat = extractHandlers(colliding as unknown as Parameters<typeof extractHandlers>[0]);
check('two rules, one name → one entry', Object.keys(flat).length === 1, JSON.stringify(Object.keys(flat)));
check("the earlier rule's source is gone from it", !String(flat.mount).includes('"notes"'), String(flat.mount));

console.log('same name, different source → error');
let res = lintSpec(colliding);
const collision = res.errors.find((e) => /handler "mount"/.test(e) && e.includes('rule "notes"') && e.includes('rule "badge"'));
check('flagged as an error', !!collision, JSON.stringify(res.errors));
check('the error says how to fix it', !!collision && /name/i.test(collision), collision);
let threw = false;
try { assertNoSpecErrors(colliding); } catch { threw = true; }
check('assertNoSpecErrors rejects it (commit + import path)', threw);

console.log('three rules, one name → one error per name, naming every rule');
res = lintSpec({ id: 's', rules: [
  scriptRule('a', 'mount', NOTES), scriptRule('b', 'mount', BADGE), scriptRule('c', 'mount', 'function mount() {}'),
] });
const forMount = res.errors.filter((e) => /handler "mount"/.test(e));
check('exactly one error for the name', forMount.length === 1, JSON.stringify(res.errors));
check('it names all three rules', forMount.length === 1 && ['rule "a"', 'rule "b"', 'rule "c"'].every((r) => String(forMount[0]).includes(r)), forMount[0]);

console.log('the advice names the field that actually holds the reference');
check('script rules → "handler"', !!collision && collision.includes('("handler")'), collision);
const rewriteRule = (id: string, source: string) => ({
  id, mutations: [{ kind: 'rewrite-response', endpoint: { method: 'GET', path: `/api/${id}` }, transform: 'shape' }], handlers: { shape: source },
});
res = lintSpec({ id: 's', rules: [rewriteRule('tracks', '(json) => json'), rewriteRule('albums', '(json) => ({ ...json })')] });
const rewriteCollision = res.errors.find((e) => /handler "shape"/.test(e));
check('rewrite-response rules → "transform"', !!rewriteCollision && rewriteCollision.includes('("transform")'), JSON.stringify(res.errors));
const interceptRule = (id: string, source: string) => ({
  id, mutations: [{ kind: 'intercept', module: { loader: 'amd', id: `mod/${id}` }, wrap: 'wrapIt' }], handlers: { wrapIt: source },
});
res = lintSpec({ id: 's', rules: [interceptRule('a', '(orig) => orig'), interceptRule('b', '(orig) => (orig)')] });
const interceptCollision = res.errors.find((e) => /handler "wrapIt"/.test(e));
check('intercept rules → "wrap"', !!interceptCollision && interceptCollision.includes('("wrap")'), JSON.stringify(res.errors));
res = lintSpec({ id: 's', rules: [scriptRule('a', 'go', NOTES), rewriteRule('b', BADGE)].map((r, i) => (i === 1 ? { ...r, mutations: [{ ...r.mutations[0], transform: 'go' }], handlers: { go: BADGE } } : r)) });
const mixedCollision = res.errors.find((e) => /handler "go"/.test(e));
check('mixed kinds → every field in use', !!mixedCollision && mixedCollision.includes('("handler" / "transform")'), JSON.stringify(res.errors));
res = lintSpec({ id: 's', rules: [
  { id: 'a', anchor: anchor('.a'), mutations: [{ kind: 'hide' }], handlers: { spare: NOTES } },
  { id: 'b', anchor: anchor('.b'), mutations: [{ kind: 'hide' }], handlers: { spare: BADGE } },
] });
const unreferenced = res.errors.find((e) => /handler "spare"/.test(e));
check('defined but referenced nowhere → lists all three fields', !!unreferenced && unreferenced.includes('("handler" / "transform" / "wrap")'), JSON.stringify(res.errors));

console.log('the spec-level handlers map is a definition too (import-carried / legacy specs)');
// extractHandlers lets the spec-level source WIN over a rule's own, while the
// running rule uses its inline source — so this pair changes behavior on export.
const specLevel = { id: 's', handlers: { mount: `module.exports = ${BADGE};\n` }, rules: [scriptRule('notes', 'mount', NOTES)] };
const flatSpecLevel = extractHandlers(specLevel as unknown as Parameters<typeof extractHandlers>[0]);
check('why: the spec-level source is the one that gets stored', String(flatSpecLevel.mount).includes('"badge"'), String(flatSpecLevel.mount));
res = lintSpec(specLevel);
const specCollision = res.errors.find((e) => /handler "mount"/.test(e));
check('rule vs spec-level, different source → error', !!specCollision, JSON.stringify(res.errors));
check('it names both places', !!specCollision && specCollision.includes('rule "notes"') && specCollision.includes('spec-level "handlers" map'), specCollision);
check('the rename example uses the rule, not the map', !!specCollision && specCollision.includes('"mountNotes"'), specCollision);
res = lintSpec({ id: 's', handlers: { mount: `module.exports = ${NOTES};\n` }, rules: [scriptRule('notes', 'mount', NOTES)] });
check('rule vs spec-level, same handler in module form → allowed', !res.errors.some((e) => /handler "mount"/.test(e)), JSON.stringify(res.errors));
res = lintSpec({ id: 's', handlers: { mount: `  module.exports = ${NOTES}\n\n` }, rules: [scriptRule('notes', 'mount', `${NOTES}  `)] });
check('whitespace / trailing-semicolon differences are not a collision', !res.errors.some((e) => /handler "mount"/.test(e)), JSON.stringify(res.errors));
res = lintSpec({ id: 's', handlers: { mount: `module.exports = ${NOTES};\n` }, rules: [{ id: 'a', anchor: anchor('.a'), mutations: [{ kind: 'script', handler: 'mount' }] }] });
check('spec-level only (the imported shape) → allowed', !res.errors.some((e) => /handler "mount"/.test(e)), JSON.stringify(res.errors));
res = lintSpec({ id: 's', handlers: { mount: 7, other: null }, rules: [scriptRule('notes', 'mount', NOTES)] });
check('non-string spec-level values are ignored', !res.errors.some((e) => /handler "mount"/.test(e)), JSON.stringify(res.errors));
res = lintSpec({ id: 's', handlers: 'nope', rules: [scriptRule('notes', 'mount', NOTES)] });
check('a malformed spec-level map never throws', !res.errors.some((e) => /handler "mount"/.test(e)), JSON.stringify(res.errors));

console.log("the import gate: a .shim file's top-level handlers map");
// importFromShim writes the file's map to patch_files as-is and stores the
// spec with whatever rule.handlers it carried, so a hand-written file pairing
// the two with different source runs one handler now and the other after a
// re-export. A canonical export has no rule.handlers left, so it never trips.
const fileSpec = { id: 's', rules: [scriptRule('notes', 'mount', NOTES)] };
res = lintSpec(fileSpec, { mount: `module.exports = ${BADGE};\n` });
const fileCollision = res.errors.find((e) => /handler "mount"/.test(e));
check("rule vs the file's map, different source → error", !!fileCollision && fileCollision.includes('the file\'s "handlers" map'), JSON.stringify(res.errors));
threw = false;
try { assertNoSpecErrors(fileSpec, { mount: `module.exports = ${BADGE};\n` }); } catch { threw = true; }
check('assertNoSpecErrors rejects it when handed the map', threw);
res = lintSpec(fileSpec, { mount: `module.exports = ${NOTES};\n` });
check("rule vs the file's map, same handler → allowed", !res.errors.some((e) => /handler "mount"/.test(e)), JSON.stringify(res.errors));
res = lintSpec({ id: 's', rules: [{ id: 'a', anchor: anchor('.a'), mutations: [{ kind: 'script', handler: 'mount' }] }] }, { mount: `module.exports = ${NOTES};\n` });
check('a canonical export (no rule-local handlers) → allowed', res.errors.length === 0, JSON.stringify(res.errors));
res = lintSpec(fileSpec);
check('no map handed over → the spec alone is judged', res.errors.length === 0, JSON.stringify(res.errors));

console.log('same name, identical source → allowed (the flatten loses nothing)');
res = lintSpec({ id: 's', rules: [scriptRule('a', 'mount', NOTES), scriptRule('b', 'mount', NOTES)] });
check('no error', res.errors.length === 0, JSON.stringify(res.errors));

console.log('different names → allowed');
res = lintSpec({ id: 's', rules: [scriptRule('a', 'mountNotes', NOTES), scriptRule('b', 'mountBadge', BADGE)] });
check('no error', res.errors.length === 0, JSON.stringify(res.errors));

console.log('malformed handlers never throw out of the lint');
res = lintSpec({ id: 's', rules: [
  { id: 'a', anchor: anchor('.a'), mutations: [{ kind: 'hide' }], handlers: { mount: 42 } },
  { id: 'b', anchor: anchor('.b'), mutations: [{ kind: 'hide' }], handlers: 'nope' },
  scriptRule('c', 'mount', NOTES),
] });
check('a non-string source is not counted as a definition', !res.errors.some((e) => /handler "mount"/.test(e)), JSON.stringify(res.errors));

console.log('');
if (failures) { console.error(`✗ ${failures} check(s) failed`); process.exit(1); }
console.log('✓ all handler-name-collision checks passed');
