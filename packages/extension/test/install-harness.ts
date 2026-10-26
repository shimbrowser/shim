// Pins the install path up to the write (src/install.ts): a good `.shim`
// file prepares (name, hosts, patterns, kinds, opt-in user data, the
// envelope's other fields), and every refusal is atomic with its code and
// problems: bad JSON, another format, a global shim, a lint error, bad
// hosts, and the D15 preflight against each mode's constant. Also the two
// constants themselves.

import { prepareInstall, mintShimId } from '../src/install';
import {
  EXTENSION_CAPABILITIES, EXTENSION_DECLARATIVE_CAPABILITIES, HANDLER_KINDS, USER_SCRIPTS_REASON, capabilitiesFor, currentMode,
} from '../src/capabilities';
import { preflightSpec } from '@shimbrowser/core/capability-preflight';
import { CONFORMANCE_CAPABILITIES } from '@shimbrowser/core/page-host-conformance';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

const HIDE = { id: 'hide-banner', anchor: { primary: { kind: 'css', value: '.banner' } }, mutations: [{ kind: 'hide' }] };
const RESTYLE = { id: 'tint', anchor: { primary: { kind: 'css', value: '.price' } }, mutations: [{ kind: 'restyle', css: 'color: red' }] };
const SCRIPT = {
  id: 'badge',
  anchor: { primary: { kind: 'css', value: 'body' } },
  mutations: [{ kind: 'script', handler: 'badge' }],
};
const BADGE_SRC = 'module.exports = function badge({ anchor }) { const el = document.createElement("i"); anchor.appendChild(el); return el; };';

function file(overrides: Record<string, unknown> = {}, rules: unknown[] = [HIDE, RESTYLE], handlers: Record<string, string> = {}): string {
  return JSON.stringify({
    format: 'shim/1',
    name: 'Tidy example',
    spec: { id: 'tidy-example', version: 3, match: { hosts: ['example.com', '*.example.com'] }, rules, ...(overrides.spec as object ?? {}) },
    handlers,
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'spec')),
  });
}

console.log('\n=== install harness ===\n');

console.log('the constants:');
check('declarative advertises no handler kind', !EXTENSION_DECLARATIVE_CAPABILITIES.mutationKinds.some((k) => HANDLER_KINDS.includes(k)));
check('full adds script and replace-root', ['script', 'replace-root'].every((k) => EXTENSION_CAPABILITIES.mutationKinds.includes(k)));
check('full is a superset of declarative', EXTENSION_DECLARATIVE_CAPABILITIES.mutationKinds.every((k) => EXTENSION_CAPABILITIES.mutationKinds.includes(k)));
check('every advertised kind is one the conformance suite names',
  EXTENSION_CAPABILITIES.mutationKinds.every((k) => (CONFORMANCE_CAPABILITIES as readonly string[]).includes(k)));
check('neither claims iframes, component identity or inspection',
  [EXTENSION_CAPABILITIES, EXTENSION_DECLARATIVE_CAPABILITIES].every((c) => !c.iframeRules && !c.componentIdentity && !c.engineInspection));
check('both install the spec stylesheet', EXTENSION_CAPABILITIES.specCss && EXTENSION_DECLARATIVE_CAPABILITIES.specCss);
check('the constants are frozen', Object.isFrozen(EXTENSION_CAPABILITIES) && Object.isFrozen(EXTENSION_CAPABILITIES.mutationKinds));
check('capabilitiesFor maps each mode', capabilitiesFor('full') === EXTENSION_CAPABILITIES && capabilitiesFor('declarative') === EXTENSION_DECLARATIVE_CAPABILITIES);
check('this version runs declarative', currentMode() === 'declarative');

console.log('a good file:');
{
  const out = prepareInstall(file({ userData: [{ origin: 'https://example.com', key: 'seen', value: [1, 2] }], intent: 'tidy the shop' }), EXTENSION_DECLARATIVE_CAPABILITIES, 'declarative');
  check('prepares', out.ok, out.ok ? '' : JSON.stringify(out));
  if (out.ok) {
    check('name', out.name === 'Tidy example');
    check('hosts', JSON.stringify(out.hosts) === JSON.stringify(['example.com', '*.example.com']));
    check('match patterns', JSON.stringify(out.matchPatterns) === JSON.stringify(['*://example.com/*', '*://*.example.com/*']));
    check('rule count', out.ruleCount === 2);
    check('distinct kinds in order', JSON.stringify(out.mutationKinds) === JSON.stringify(['hide', 'restyle']));
    check('the spec keeps its version', out.spec.version === 3);
    check('the spec id is the file\'s (the install mints its own)', out.spec.id === 'tidy-example');
    check('user data rows', out.userData.length === 1 && out.userData[0]?.key === 'seen');
    check('envelope keeps intent', out.envelope.intent === 'tidy the shop');
    check('envelope drops the fields with their own place', !('spec' in out.envelope) && !('handlers' in out.envelope) && !('userData' in out.envelope) && !('name' in out.envelope) && !('format' in out.envelope));
  }
}
{
  const out = prepareInstall('﻿' + file(), EXTENSION_DECLARATIVE_CAPABILITIES, 'declarative');
  check('a BOM is fine', out.ok);
}

console.log('refusals:');
{
  const out = prepareInstall('{not json', EXTENSION_DECLARATIVE_CAPABILITIES, 'declarative');
  check('bad JSON', !out.ok && out.error === 'malformed-shim-file' && out.problems.length === 1);
}
{
  const out = prepareInstall('[1,2]', EXTENSION_DECLARATIVE_CAPABILITIES, 'declarative');
  check('not an object', !out.ok && out.error === 'malformed-shim-file');
}
for (const [format, word] of [['shim-pack/1', 'pack'], ['shim/global-1', 'global'], ['shim/composition-1', 'composition'], ['nope/9', 'unsupported']] as const) {
  const out = prepareInstall(JSON.stringify({ format, name: 'x', spec: {} }), EXTENSION_DECLARATIVE_CAPABILITIES, 'declarative');
  check(`${format} is refused and named`, !out.ok && out.error === 'unsupported-format' && (out.problems[0] ?? '').includes(word), JSON.stringify(out));
}
{
  const out = prepareInstall(file({ spec: { global: true } }), EXTENSION_CAPABILITIES, 'full');
  check('a global shim in a shim/1 envelope', !out.ok && out.error === 'global-shim');
}
{
  const out = prepareInstall(JSON.stringify({ format: 'shim/1', name: 'x', spec: { id: '' , rules: [] }, handlers: {} }), EXTENSION_CAPABILITIES, 'full');
  check('an empty spec id is the reader\'s refusal', !out.ok && out.error === 'malformed-shim-file', JSON.stringify(out));
}
{
  const out = prepareInstall(file({}, [{ ...HIDE, mutations: [{ kind: 'teleport' }] }]), EXTENSION_CAPABILITIES, 'full');
  check('an invented kind is refused by the preflight, naming the rule and the kind',
    !out.ok && out.error === 'unsupported' && out.unsupported?.[0]?.ruleId === 'hide-banner' && out.unsupported[0].kind === 'teleport', JSON.stringify(out));
}
{
  const out = prepareInstall(file({}, [{ ...HIDE, mutations: [{ kind: 'inject-html', placement: 'after' }] }]), EXTENSION_CAPABILITIES, 'full');
  check('a lint error (inject-html without html) is spec-lint', !out.ok && out.error === 'spec-lint' && (out.problems[0] ?? '').includes('inject-html'), JSON.stringify(out));
}
{
  const out = prepareInstall(file({ spec: { match: { hosts: 'example.com' } } }), EXTENSION_CAPABILITIES, 'full');
  check('match.hosts that is not an array', !out.ok && out.error === 'malformed-shim-folder', JSON.stringify(out));
}
{
  const out = prepareInstall(file({ spec: { match: { hosts: ['https://example.com', 'ok.test'] } } }), EXTENSION_CAPABILITIES, 'full');
  check('a host pattern that cannot register', !out.ok && out.error === 'bad-hosts' && out.problems.length === 1, JSON.stringify(out));
}
{
  const out = prepareInstall(file({ spec: { match: { hosts: [] } } }), EXTENSION_CAPABILITIES, 'full');
  check('no hosts at all', !out.ok && out.error === 'bad-hosts', JSON.stringify(out));
}
{
  const out = prepareInstall(file({ userData: { not: 'rows' } }), EXTENSION_CAPABILITIES, 'full');
  check('malformed userData', !out.ok && out.error === 'malformed-shim-file' && (out.problems[0] ?? '').includes('userData'));
}
{
  const out = prepareInstall(file({ userData: [{ origin: 'https://example.com' }] }), EXTENSION_CAPABILITIES, 'full');
  check('a userData row without a key', !out.ok && out.problems.some((p) => p.includes('userData[0]')));
}

console.log('the preflight gate (D15):');
{
  const withScript = file({}, [HIDE, SCRIPT], { badge: BADGE_SRC });
  const declarative = prepareInstall(withScript, EXTENSION_DECLARATIVE_CAPABILITIES, 'declarative');
  check('a script rule is refused in declarative mode', !declarative.ok && declarative.error === 'unsupported');
  if (!declarative.ok) {
    check('the refusal names the rule and the kind', declarative.unsupported?.some((u) => u.ruleId === 'badge' && u.kind === 'script') === true);
    check('and names user scripts as the reason', declarative.problems[declarative.problems.length - 1] === USER_SCRIPTS_REASON);
  }
  // The preflight runs before the handler-module check: an extension page
  // cannot run core's syntax probe (its CSP permits no eval), so a shim the
  // mode refuses anyway is refused for the mode, never for the probe.
  const broken = prepareInstall(file({}, [HIDE, SCRIPT], { badge: 'module.exports = function (' }), EXTENSION_DECLARATIVE_CAPABILITIES, 'declarative');
  check('a mode refusal wins over a handler-module problem', !broken.ok && broken.error === 'unsupported', JSON.stringify(broken));
  const brokenFull = prepareInstall(file({}, [HIDE, SCRIPT], { badge: 'module.exports = function (' }), EXTENSION_CAPABILITIES, 'full');
  check('in full mode the handler-module problem is reported', !brokenFull.ok && brokenFull.error === 'malformed-shim-folder', JSON.stringify(brokenFull));
  const full = prepareInstall(withScript, EXTENSION_CAPABILITIES, 'full');
  check('the same shim installs in full mode', full.ok, full.ok ? '' : JSON.stringify(full));
  if (full.ok) check('with its handler module', full.handlers.badge === BADGE_SRC && full.mutationKinds.includes('script'));
}
{
  const out = prepareInstall(file({ spec: { settings: [{ key: 'token', type: 'string' }] } }), EXTENSION_CAPABILITIES, 'full');
  check('a settings declaration is refused (no api.settings yet)', !out.ok && out.error === 'unsupported' && out.unsupported?.[0]?.feature === 'settings');
  if (!out.ok) check('without the user-scripts line', !out.problems.includes(USER_SCRIPTS_REASON));
}
{
  const out = prepareInstall(file({}, [{ ...HIDE, anchor: { ...HIDE.anchor, iframe: 'iframe.pay' } }]), EXTENSION_CAPABILITIES, 'full');
  check('an iframe rule is refused', !out.ok && out.error === 'unsupported' && out.unsupported?.[0]?.feature === 'iframe-rule');
}
{
  const out = prepareInstall(file({ spec: { css: '.x { color: red }' } }), EXTENSION_DECLARATIVE_CAPABILITIES, 'declarative');
  check('a spec stylesheet is fine on this host', out.ok);
}
check('the gate is the shared preflight', preflightSpec({ id: 'x', rules: [SCRIPT] } as never, EXTENSION_DECLARATIVE_CAPABILITIES).ok === false);

console.log('ids:');
check('mintShimId is a prefixed, dash-free slice', mintShimId('3b241101-e2bb-4255-8caf-4136c566a962') === 'shim-3b241101e2bb4255');
check('two uuids mint two ids', mintShimId('3b241101-e2bb-4255-8caf-4136c566a962') !== mintShimId('9b241101-e2bb-4255-8caf-4136c566a962'));

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log(`all install checks passed (${passes})`);
