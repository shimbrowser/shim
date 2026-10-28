// Harness for @shimbrowser/core/capability-preflight:
//
//   - preflight lists every declared feature a host lacks — mutation kinds,
//     anchor.iframe, and the settings / permissions / storage / connections
//     declarations — and passes a spec inside the set (empty declarations
//     count as none);
//   - a secret settings field is refused, once and naming each key, on a host
//     that serves settings but cannot encrypt them (secretSettings false),
//     and kept where it can;
//   - the source scan flags the unsupported api members a handler mentions,
//     in every spelling the scan claims (dot, optional chain, bracket), and
//     not look-alikes (`myapi.fetch`, `api.fetchAll`, a supported member);
//   - scanRuleHandlers reads inline and stored (module-form) handlers;
//   - the verification level is `partial` for an unsupported-api use or a
//     component-identity witness on a host without component identity, and
//     `full` otherwise;
//   - the evidence helpers (preview-evidence.ts) word a rule status and a
//     view_page caption as the Shim browser always has, and build noMatch[]
//     from the engine's events plus every rule whose status matched 0;
//   - a rule that matched nothing is `none`, never `full`.
//
//   node out/packages/core/test/capability-preflight-harness.js

import {
  preflightSpec, scanHandlerSource, scanRuleHandlers, unsupportedApiMembers, verificationLevel, UNSUPPORTED,
} from '../src/capability-preflight';
import type { PageHostCapabilities } from '../src/page-host';
import { describeRuleStatus, previewKey, previewNoMatch, previewMatchedNothing, shimViewPageCaption } from '../src/preview-evidence';
import type { Spec, Rule } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const HEADLESS: PageHostCapabilities = {
  mutationKinds: ['hide', 'restyle', 'reorder', 'reshape', 'script', 'inject-element', 'inject-html', 'remove', 'replace-root'],
  iframeRules: false,
  specCss: false,
  apiMembers: [],
  secretSettings: false,
  componentIdentity: false,
  engineInspection: false,
  trustedInput: true,
};
const BROWSER: PageHostCapabilities = {
  mutationKinds: [...HEADLESS.mutationKinds, 'mount-route', 'redirect', 'rewrite-response', 'intercept'],
  iframeRules: true,
  specCss: true,
  apiMembers: ['db', 'ai', 'settings', 'fetch', 'storage.pack', 'storage.global', 'shared', 'modules'],
  secretSettings: true,
  componentIdentity: true,
  engineInspection: true,
  trustedInput: true,
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
  check('a whitespace-only spec css is none', preflightSpec({ ...ok, css: '  \n' }, HEADLESS).ok);
  const cssOnly = preflightSpec({ ...ok, css: 'body { color: red }' }, HEADLESS);
  check('a spec css block is refused where the host does not install it', !cssOnly.ok
    && cssOnly.unsupported.length === 1 && cssOnly.unsupported[0]?.feature === 'css' && cssOnly.unsupported[0].message.includes('"css"'), JSON.stringify(cssOnly));

  const bad: Spec = {
    id: 's', match: { hosts: ['a.test'] },
    css: '.promo { display: none }',
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
    '-:settings:', '-:permissions:', '-:storage:', '-:connections:', '-:css:',
    'route:mutation-kind:mount-route', 'redir:mutation-kind:redirect', 'rw:mutation-kind:rewrite-response',
    'icpt:mutation-kind:intercept', 'frame:iframe-rule:',
  ];
  check('every declared unsupported feature is listed once, in spec order', JSON.stringify(features) === JSON.stringify(want), features.join(' | '));
  check('each entry carries a message naming it', list.every((u) => u.message.length > 0) && (list[5]?.message.includes('mount-route') ?? false));
  check('the Shim browser\'s capabilities pass the same spec', preflightSpec(bad, BROWSER).ok);
}

console.log('secret settings');
{
  // Shim for Chrome's shape: settings served, no encrypted store.
  const NO_SECRETS: PageHostCapabilities = { ...HEADLESS, apiMembers: ['settings', 'fetch'], secretSettings: false };
  const spec = (settings: unknown[]): Spec => ({ id: 's', match: { hosts: ['a.test'] }, settings, rules: [] });
  check('plain settings pass where the host serves settings',
    preflightSpec(spec([{ key: 'units', type: 'select', options: ['metric'] }, { key: 'n', type: 'number' }, { key: 'note' }]), NO_SECRETS).ok);
  const r = preflightSpec(spec([{ key: 'units' }, { key: 'token', type: 'secret' }, { key: 'pass', type: 'secret' }]), NO_SECRETS);
  const only = r.ok ? null : r.unsupported;
  check('secret fields are refused where the host cannot encrypt them: one entry naming each secret key, not the others',
    only !== null && only.length === 1 && only[0]?.feature === 'settings'
      && only[0].message.includes('"token"') && only[0].message.includes('"pass"') && !only[0].message.includes('"units"'), JSON.stringify(r));
  check('the Shim browser keeps secrets (secretSettings)', preflightSpec(spec([{ key: 'token', type: 'secret' }]), BROWSER).ok);
  const none = preflightSpec(spec([{ key: 'token', type: 'secret' }]), HEADLESS);
  check('a host without settings refuses the declaration once, with no second secret entry',
    !none.ok && none.unsupported.length === 1 && none.unsupported[0]?.message.includes('api.settings') === true, JSON.stringify(none));
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
  const plain = { witness: { v: 1, tag: 'div' } };
  const component = { witness: { v: 1, tag: 'div', component: { v: 1, path: ['TrackRow'], propKeys: [] } } };
  const set = { setWitness: { v: 1, tag: 'li', count: 3, nested: false } };
  check('full: a plain witness, no unsupported use', verificationLevel(plain, HEADLESS, false) === 'full');
  check('full: no witness at all', verificationLevel(undefined, HEADLESS, false) === 'full' && verificationLevel({}, HEADLESS, false) === 'full');
  check('partial: an unsupported-api event fired', verificationLevel(plain, HEADLESS, true) === 'partial');
  check('partial: component identity the host cannot check', verificationLevel(component, HEADLESS, false) === 'partial');
  check('full: component identity on a host that checks it', verificationLevel(component, BROWSER, false) === 'full');
  check('none: the rule matched nothing, whatever else holds', verificationLevel(plain, HEADLESS, true, true) === 'none'
    && verificationLevel(component, BROWSER, false, true) === 'none');
  check('partial: an element witness of an unknown version', verificationLevel({ witness: { v: 9, tag: 'div' } }, BROWSER, false) === 'partial');
  check('full: a set witness, verified per member on every host', verificationLevel(set, BROWSER, false) === 'full' && verificationLevel(set, HEADLESS, false) === 'full');
  check('partial: a set witness of an unknown version', verificationLevel({ setWitness: { v: 9, tag: 'li', count: 3, nested: false } }, BROWSER, false) === 'partial');
  check('partial: conflicted (both kinds)', verificationLevel({ ...plain, ...set }, BROWSER, false) === 'partial');
}

console.log('noMatch evidence');
{
  const hide = (id: string, value: string): Rule => ({ id, anchor: css(value), mutations: [{ kind: 'hide' }] });
  const dead = hide('dead', '.gone');
  const live = hide('live', '.here');
  const ids = (list: Array<{ ruleId: string | undefined }>): string => list.map((n) => n.ruleId).join(',');
  check('a 0-match status lands in noMatch with no event (the late-timer case)',
    JSON.stringify(previewNoMatch([], [{ rule: dead, status: { matched: 0 } }, { rule: live, status: { matched: 2 } }]))
      === JSON.stringify([{ ruleId: 'dead', selector: '.gone' }]));
  check('the engine\'s event and the status count once',
    ids(previewNoMatch([{ ruleId: 'dead', selector: '.gone' }], [{ rule: dead, status: { matched: 0 } }])) === 'dead');
  check('a duplicate event counts once', ids(previewNoMatch([{ ruleId: 'dead', selector: '.gone' }, { ruleId: 'dead', selector: '.gone' }], [])) === 'dead');
  check('an event for a rule matching now is dropped (it rendered after the engine looked)',
    ids(previewNoMatch([{ ruleId: 'live', selector: '.here' }], [{ rule: live, status: { matched: 1 } }])) === '');
  check('an event for a rule this preview has no status for is kept',
    ids(previewNoMatch([{ ruleId: 'other', selector: '.x' }], [{ rule: live, status: { matched: 1 } }])) === 'other');
  check('no status yet is not a verdict', ids(previewNoMatch([], [{ rule: dead, status: undefined }])) === '' && !previewMatchedNothing({ rule: dead, status: undefined }));
  const removed: Rule = { id: 'rm', anchor: css('.ad'), mutations: [{ kind: 'remove' }] };
  check('a rule that matched earlier in the preview (a remove) is not a no-match',
    ids(previewNoMatch([], [{ rule: removed, status: { matched: 0 }, peakMatched: 1 }])) === '');
  check('…even when the engine\'s timer saw it gone and reported a miss',
    ids(previewNoMatch([{ ruleId: 'rm', selector: '.ad' }], [{ rule: removed, status: { matched: 0 }, peakMatched: 1 }])) === '');
  const witnessed: Rule = { id: 'w', anchor: { ...css('.promo'), witness: { v: 1, tag: 'div' } }, mutations: [{ kind: 'hide' }] } as Rule;
  check('a witnessed rule at 0 waits for the engine\'s verdict (no-match or quarantine)',
    ids(previewNoMatch([], [{ rule: witnessed, status: { matched: 0 } }])) === ''
      && ids(previewNoMatch([{ ruleId: 'w', selector: '.promo' }], [{ rule: witnessed, status: { matched: 0 } }])) === 'w');
  check('a quarantined rule is left to quarantined[]', ids(previewNoMatch([], [{ rule: dead, status: { matched: 0 } }], new Set(['dead']))) === '');
  const zeroIsNormal: Rule[] = [
    { id: 'route', anchor: css('body'), mutations: [{ kind: 'mount-route', path: '/x', handler: 'h' }] },
    { id: 'redirect', mutations: [{ kind: 'redirect' }] },
    { id: 'rewrite', mutations: [{ kind: 'rewrite-response' }] },
    { id: 'intercept', mutations: [{ kind: 'intercept' }] },
    { id: 'framed', anchor: { ...css('.in-frame'), iframe: { kind: 'css', value: 'iframe' } }, mutations: [{ kind: 'hide' }] },
  ] as Rule[];
  check('routes, network / module kinds and iframe rules never infer a no-match from a 0',
    ids(previewNoMatch([], zeroIsNormal.map((rule) => ({ rule, status: { matched: 0 } })))) === '');
  check('a selector-less anchor reads as an empty selector', JSON.stringify(previewNoMatch([], [{ rule: { id: 'n', anchor: { primary: { kind: 'aria', role: 'button' } }, mutations: [{ kind: 'hide' }] } as Rule, status: { matched: 0 } }]))
    === JSON.stringify([{ ruleId: 'n', selector: '' }]));
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
