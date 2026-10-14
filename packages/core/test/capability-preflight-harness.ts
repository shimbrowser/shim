// Harness for @shimbrowser/core/capability-preflight (shim-core design D15):
//
//   - preflight lists every declared feature a host lacks — mutation kinds,
//     anchor.iframe, and the settings / permissions / storage / connections
//     declarations — and passes a spec inside the set (empty declarations
//     count as none);
//   - the source scan flags the unsupported api members a handler mentions,
//     in every spelling the scan claims (dot, optional chain, bracket), and
//     not look-alikes (`myapi.fetch`, `api.fetchAll`, a supported member);
//   - scanRuleHandlers reads inline and stored (module-form) handlers;
//   - the verification level is `partial` for an unsupported-api use or a
//     component-identity witness on a host without component identity, and
//     `full` otherwise;
//   - the evidence helpers (preview-evidence.ts) word a rule status and a
//     view_page caption as the Shim browser always has.
//
//   node out/packages/core/test/capability-preflight-harness.js

import {
  preflightSpec, scanHandlerSource, scanRuleHandlers, unsupportedApiMembers, verificationLevel, UNSUPPORTED,
} from '../src/capability-preflight';
import type { PageHostCapabilities } from '../src/page-host';
import { describeRuleStatus, previewKey, shimViewPageCaption } from '../src/preview-evidence';
import type { Spec, Rule } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const HEADLESS: PageHostCapabilities = {
  mutationKinds: ['hide', 'restyle', 'reorder', 'reshape', 'script', 'inject-element', 'inject-html', 'remove', 'replace-root'],
  iframeRules: false,
  apiMembers: [],
  componentIdentity: false,
  engineInspection: false,
};
const BROWSER: PageHostCapabilities = {
  mutationKinds: [...HEADLESS.mutationKinds, 'mount-route', 'redirect', 'rewrite-response', 'intercept'],
  iframeRules: true,
  apiMembers: ['db', 'ai', 'settings', 'fetch', 'storage.pack', 'storage.global', 'shared', 'modules'],
  componentIdentity: true,
  engineInspection: true,
};

const css = (value: string) => ({ primary: { kind: 'css' as const, value } });

console.log('preflight');
{
  const ok: Spec = {
    id: 's', match: { hosts: ['a.test'] },
    settings: [], permissions: [], storage: {}, connections: [],
    rules: [
      { id: 'h', anchor: css('.a'), mutations: [{ kind: 'hide' }] },
      { id: 'r', anchor: css('.b'), mutations: [{ kind: 'replace-root', html: '<p>x</p>' }] },
    ],
  };
  check('a spec inside the set passes (empty declarations are none)', preflightSpec(ok, HEADLESS).ok);

  const bad: Spec = {
    id: 's', match: { hosts: ['a.test'] },
    settings: [{ key: 'k', type: 'string' }],
    permissions: ['ai'],
    storage: { tables: { notes: {} } },
    connections: [{ name: 'pg' }],
    rules: [
      { id: 'route', anchor: css('body'), mutations: [{ kind: 'mount-route' }, { kind: 'mount-route' }] },
      { id: 'redir', anchor: css('body'), mutations: [{ kind: 'redirect' }] },
      { id: 'rw', anchor: css('body'), mutations: [{ kind: 'rewrite-response' }] },
      { id: 'icpt', anchor: css('body'), mutations: [{ kind: 'intercept' }] },
      { id: 'frame', anchor: { ...css('.x'), iframe: { kind: 'css', value: 'iframe' } }, mutations: [{ kind: 'hide' }] },
      { id: 'fine', anchor: css('.y'), mutations: [{ kind: 'hide' }] },
    ],
  };
  const r = preflightSpec(bad, HEADLESS);
  check('a spec outside the set is refused as unsupported', !r.ok && r.error === UNSUPPORTED);
  const list = r.ok ? [] : r.unsupported;
  const features = list.map((u) => `${u.ruleId ?? '-'}:${u.feature}:${u.kind ?? ''}`);
  const want = [
    '-:settings:', '-:permissions:', '-:storage:', '-:connections:',
    'route:mutation-kind:mount-route', 'redir:mutation-kind:redirect', 'rw:mutation-kind:rewrite-response',
    'icpt:mutation-kind:intercept', 'frame:iframe-rule:',
  ];
  check('every declared unsupported feature is listed once, in spec order', JSON.stringify(features) === JSON.stringify(want), features.join(' | '));
  check('each entry carries a message naming it', list.every((u) => u.message.length > 0) && (list[4]?.message.includes('mount-route') ?? false));
  check('the Shim browser\'s capabilities pass the same spec', preflightSpec(bad, BROWSER).ok);
}

console.log('source scan');
{
  const src = `async function h({ api, anchor }) {
    const r = await api.fetch('https://x.test');
    const s = await api?.settings.get('k');
    const d = api['db'];
    api.storage.pack.set('a', 1);
    api.bridge.forwardRule('o', {}, 'k');
    await api.storage.set('k', 1);
    api.cleanup(() => {});
  }`;
  const found = scanHandlerSource(src, HEADLESS);
  check('dot, optional-chain and bracket spellings are found', ['fetch', 'settings', 'db', 'storage.pack', 'bridge.forwardRule'].every((m) => found.includes(m as never)), found.join(','));
  check('supported members are not flagged', !found.includes('storage.global' as never) && found.length === 5, found.join(','));
  const lookalikes = 'function h({ api }) { myapi.fetch(); api.fetchAll(); api.aiHelper; x.api_db; }';
  check('look-alikes are not flagged', scanHandlerSource(lookalikes, HEADLESS).length === 0, scanHandlerSource(lookalikes, HEADLESS).join(','));
  check('a host with every member flags nothing', scanHandlerSource(src, BROWSER).length === 0);
  check('the member list is every api member plus forwardRule without iframes',
    unsupportedApiMembers(HEADLESS).length === 9 && unsupportedApiMembers(BROWSER).length === 0);

  const rules: Rule[] = [
    { id: 'a', anchor: css('.a'), mutations: [{ kind: 'script', handler: 'inline' }], handlers: { inline: 'function inline({ api }) { return api.ai.complete({}); }' } },
    { id: 'b', anchor: css('.b'), mutations: [{ kind: 'script', handler: 'stored' }] },
    { id: 'c', anchor: css('.c'), mutations: [{ kind: 'script', handler: 'stored' }] },
    { id: 'd', anchor: css('.d'), mutations: [{ kind: 'script', handler: 'clean' }], handlers: { clean: 'function clean({ api }) { api.storage.get("k"); }' } },
  ];
  const findings = scanRuleHandlers(rules, HEADLESS, { stored: 'module.exports = function stored({ api }) { return api.modules.invoke("m", "f", []); };\n' });
  check('inline and stored handlers are scanned, one finding per handler', findings.length === 2
    && findings[0]?.handler === 'inline' && findings[0].members.join() === 'ai'
    && findings[1]?.handler === 'stored' && findings[1].members.join() === 'modules'
    && findings[1].ruleIds.join() === 'b,c', JSON.stringify(findings.map((f) => [f.handler, f.members, f.ruleIds])));
  check('a finding says what the call does on this host', (findings[0]?.message ?? '').includes("error: 'requires-shim-browser'") && (findings[0]?.message ?? '').includes('partial'));
}

console.log('verification level');
{
  const plain = { v: 1, tag: 'div' };
  const component = { v: 1, tag: 'div', component: { name: 'TrackRow' } };
  check('full: a plain witness, no unsupported use', verificationLevel(plain, HEADLESS, false) === 'full');
  check('full: no witness at all', verificationLevel(undefined, HEADLESS, false) === 'full');
  check('partial: an unsupported-api event fired', verificationLevel(plain, HEADLESS, true) === 'partial');
  check('partial: component identity the host cannot check', verificationLevel(component as never, HEADLESS, false) === 'partial');
  check('full: component identity on a host that checks it', verificationLevel(component as never, BROWSER, false) === 'full');
}

console.log('evidence wording');
{
  const hide: Rule = { id: 'h', anchor: css('.a'), mutations: [{ kind: 'hide' }] };
  check('matched with a box', describeRuleStatus(hide, { matched: 1, matchedVia: 'primary', box: { x: 1, y: 2, w: 3, h: 4 } })
    === 'matched 1 element(s) via primary — anchor box 3×4px at (1, 2)');
  check('matched 0', describeRuleStatus(hide, { matched: 0 }) === 'matched 0 elements — the anchor does not resolve on this page');
  check('no status yet', describeRuleStatus(hide, undefined) === 'no status event received — the engine may not have scanned yet');
  check('the preview key', previewKey('shim-1', 'r') === 'preview:shim-1:r');
  check('the full-viewport caption', shimViewPageCaption({ url: 'https://a.test/', sizeBytes: 2048 }).startsWith('Screenshot of the visible viewport at https://a.test/ (2KB).'));
  check('the crop caption', shimViewPageCaption({ croppedTo: '.a', elementBox: { w: 3, h: 4 } }).startsWith('Cropped screenshot around `.a` (element measures 3×4px) at current page'));
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall capability-preflight checks passed');
