// Pins who may send what to the worker (src/sender.ts): the extension's own
// pages change what is installed, the page runtime on a site only asks and
// stores for that site, and anything else is answered nothing.

import { senderContext, allowedFrom, PAGE_MESSAGES, CONTENT_MESSAGES } from '../src/sender';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const BASE = `chrome-extension://${ID}/`;
const ctx = (sender: Parameters<typeof senderContext>[0]) => senderContext(sender, ID, BASE);

console.log('\n=== sender harness ===\n');

console.log('who is who:');
check('the popup is a page', ctx({ id: ID, url: `${BASE}popup.html`, tab: { id: 3 } }).kind === 'page');
check('the install page is a page', ctx({ id: ID, url: `${BASE}install.html?x=1` }).kind === 'page');
{
  const c = ctx({ id: ID, url: 'https://app.example.com:8443/path?q#h', tab: { id: 4 } });
  check('a content script is content with its host, port and origin',
    c.kind === 'content' && c.hostname === 'app.example.com' && c.port === '8443' && c.origin === 'https://app.example.com:8443', JSON.stringify(c));
}
check('a default port reads as an empty port', (() => { const c = ctx({ id: ID, url: 'http://example.com/', tab: {} }); return c.kind === 'content' && c.port === ''; })());
check('another extension is unknown', ctx({ id: 'other', url: `${BASE}popup.html` }).kind === 'unknown');
check('another extension\'s page url is unknown', ctx({ id: ID, url: 'chrome-extension://zzzz/popup.html' }).kind === 'unknown');
check('no sender is unknown', ctx(undefined).kind === 'unknown');
check('no url is unknown', ctx({ id: ID }).kind === 'unknown');
check('a content sender without a tab is unknown', ctx({ id: ID, url: 'https://example.com/' }).kind === 'unknown');
check('a non-http url with a tab is unknown', ctx({ id: ID, url: 'file:///tmp/x.html', tab: {} }).kind === 'unknown');
check('an unparseable url is unknown', ctx({ id: ID, url: 'not a url', tab: {} }).kind === 'unknown');

console.log('what each may send:');
const page = { kind: 'page' } as const;
const content = { kind: 'content', hostname: 'example.com', port: '', origin: 'https://example.com', pathname: '/' } as const;
const unknown = { kind: 'unknown' } as const;
for (const t of PAGE_MESSAGES) check(`a page may ${t}`, allowedFrom(t, page));
for (const t of CONTENT_MESSAGES) check(`a page may not ${t}`, !allowedFrom(t, page));
for (const t of CONTENT_MESSAGES) check(`content may ${t}`, allowedFrom(t, content));
for (const t of PAGE_MESSAGES) check(`content may not ${t}`, !allowedFrom(t, content));
check('unknown may send nothing', [...PAGE_MESSAGES, ...CONTENT_MESSAGES].every((t) => !allowedFrom(t, unknown)));
check('an unknown type is allowed to nobody', !allowedFrom('reset', page) && !allowedFrom('reset', content));
// Phase 7's boundary: a site reads its shims' settings and fetches through the
// broker, but only the extension's own settings page writes a value.
check('content may read settings and fetch', allowedFrom('settings', content) && allowedFrom('fetch', content));
check('content may never write or list a shim\'s settings', !allowedFrom('settings.set', content) && !allowedFrom('settings.clear', content) && !allowedFrom('settings.fields', content));
check('the settings page may set, clear and list, never fetch as a handler', allowedFrom('settings.set', page) && allowedFrom('settings.clear', page) && allowedFrom('settings.fields', page) && !allowedFrom('fetch', page) && !allowedFrom('settings', page));

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log(`all sender checks passed (${passes})`);
