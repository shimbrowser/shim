// Bare-node harness for bot-wall.ts — telling a CDN / bot-protection wall
// from the site. Fixture HTML for each wall the services serve (modelled on
// the pages headless sessions were actually served), and the negatives that
// must never trip: an article about Cloudflare quoting its block page, a
// login form with a Turnstile widget, a site's own "access denied" page, a
// Cloudflare origin-error page (not a bot refusal), a page carrying
// DataDome's ordinary tag. The fixtures go through readBotWallSignals over
// a small stub document (just the selectors the reader asks for), so the
// reader and the classifier are both covered; real Chromium reads the same
// kind of pages in headless-session-e2e.
//
//   node out/packages/core/test/bot-wall-harness.js

import {
  isCloudflareInterstitial, readBotWallSignals, classifyBotWall, detectBotWall, asBotWallSignals, describeBotWall,
  botWallNote, withBotWallNote, withBotWallEvidence, botWallOnHost, rememberedBotWall, type BotWallMemory, BOT_WALL_SCRIPT, RUNNER_SELECTOR, CONTAINER_SELECTOR,
  MAX_WALL_TEXT, type BotWall,
} from '../src/bot-wall';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

// --- a stub document over fixture HTML ------------------------------------------

// The selectors the reader uses: `#id` and `tag[attr*="value"]`, in comma lists.
function matchesSimple(html: string, sel: string): boolean {
  const id = /^#([\w-]+)$/.exec(sel);
  if (id) return new RegExp(`\\sid=["']${id[1]}["']`, 'i').test(html);
  const attr = /^(\w+)\[(\w+)\*="([^"]+)"\]$/.exec(sel);
  if (attr) {
    const [, tag, name, value] = attr;
    const esc = (value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`<${tag}\\b[^>]*\\s${name}=["'][^"']*${esc}`, 'i').test(html);
  }
  throw new Error(`the stub does not know selector ${sel}`);
}

// Visible text, roughly as innerText: no head, script, style, template or
// display:none subtrees, tags dropped, entities decoded.
function visibleText(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html.replace(/<head[\s\S]*?<\/head>/i, '');
  return body
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(\w+)\b[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'');
}

function stubDocument(html: string): Document {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/&amp;/g, '&') ?? '';
  const text = visibleText(html);
  const stub = {
    title,
    body: { innerText: text, textContent: text },
    querySelector: (sel: string) => (sel.split(',').map((p) => p.trim()).some((p) => matchesSimple(html, p)) ? {} : null),
  };
  return stub as unknown as Document;
}

// --- fixtures -------------------------------------------------------------------

const FILLER = 'Paragraph after paragraph of the article itself, the kind of text a real page carries. '.repeat(45);

const CF_BLOCK = `<!DOCTYPE html><html lang="en-US"><head><title>Attention Required! | Cloudflare</title>
<meta name="robots" content="noindex, nofollow"><link rel="stylesheet" href="/cdn-cgi/styles/cf.errors.css"></head>
<body><div id="cf-wrapper"><div class="cf-alert cf-alert-error cf-cookie-error" id="cookie-alert" style="display: none">Please enable cookies.</div>
<div id="cf-error-details" class="cf-error-details-wrapper"><div class="cf-wrapper cf-header cf-error-overview">
<h1 data-translate="block_headline">Sorry, you have been blocked</h1>
<h2 class="cf-subheadline"><span data-translate="unable_to_access">You are unable to access</span> medium.com</h2></div>
<div class="cf-section cf-wrapper"><div class="cf-columns two"><div class="cf-column"><h2>Why have I been blocked?</h2>
<p>This website is using a security service to protect itself from online attacks. The action you just performed triggered the security solution.</p></div>
<div class="cf-column"><h2>What can I do to resolve this?</h2><p>You can email the site owner to let them know you were blocked.</p></div></div></div>
<div class="cf-error-footer cf-wrapper"><p><span class="cf-footer-item">Cloudflare Ray ID: <strong>8d2f1a2b3c4d5e6f</strong></span>
<span class="cf-footer-item">Your IP: <button type="button" id="cf-footer-ip-reveal">Click to reveal</button></span>
<span class="cf-footer-item">Performance &amp; security by Cloudflare</span></p></div></div></div></body></html>`;

const CF_1020 = `<!DOCTYPE html><html><head><title>Access denied | shop.example used Cloudflare to restrict access</title></head>
<body><div id="cf-wrapper"><div id="cf-error-details" class="p-0"><header><h1><span class="cf-error-type">Error</span><span class="cf-error-code">1020</span></h1>
<h2>Access denied</h2></header><section><p>The site owner may have set restrictions that prevent you from accessing the site.</p></section>
<div class="cf-error-footer"><p>Ray ID: 8d2f1a2b3c4d5e70</p></div></div></div></body></html>`;

const CF_CHALLENGE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body>
<div class="main-wrapper" role="main"><div class="main-content"><h1 class="zone-name-title h1">www.example.com</h1>
<div id="challenge-stage"></div><div id="challenge-running">Verifying you are human. This may take a few seconds.</div></div></div>
<script>(function(){window._cf_chl_opt={cvId:'3',cZone:'www.example.com',cType:'managed'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=8d2f';document.getElementsByTagName('head')[0].appendChild(a);})();</script>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=8d2f"></script></body></html>`;

const AKAMAI = `<HTML><HEAD>
<TITLE>Access Denied</TITLE>
</HEAD><BODY>
<H1>Access Denied</H1>

You don't have permission to access "http&#58;&#47;&#47;www&#46;adobe&#46;com&#47;" on this server.<P>
Reference&#32;&#35;18&#46;4f3c1702&#46;1730000000&#46;1a2b3c4d
<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18&#46;4f3c1702&#46;1730000000&#46;1a2b3c4d</P>
</BODY>
</HTML>`;

const DATADOME = `<html lang="en"><head><title>reuters.com</title><style>#cmsg{animation: A 1.5s;}</style></head>
<body style="margin:0"><p id="cmsg">Please enable JS and disable any ad blocker</p>
<script data-cfasync="false">var dd={'rt':'c','cid':'AHrlqAAAAAMA','hsh':'2211F522B61E269B869FA6EAFFB5E1','t':'bv','s':45155,'e':'5d','host':'geo.captcha-delivery.com','cookie':'x'}</script>
<script type="text/plain" data-cfasync="false" src="https://ct.captcha-delivery.com/c.js"></script>
<iframe srcdoc="<p>Access is temporarily restricted</p>" src="https://geo.captcha-delivery.com/captcha/?initialCid=AHrlqAAAAAMA&amp;cid=x" title="DataDome Device Check" width="100%" height="100%" style="height:100vh;" frameborder="0"></iframe></body></html>`;

const PERIMETERX = `<!DOCTYPE html><html lang="en"><head><title>Access to this page has been denied</title></head>
<body><div class="px-container"><div class="px-inner-container"><p class="px-text">Before we continue...</p>
<p>Press &amp; Hold to confirm you are<br>a human (and not a bot).</p><div id="px-captcha"></div>
<p>Reference ID 6b1f3c2e-95a1-11ef-a1b2-0242ac120002</p></div></div></body></html>`;

const IMPERVA = `<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW"></head>
<body style="margin:0px;height:100%"><iframe id="main-iframe" srcdoc="" src="/_Incapsula_Resource?CWUDNSAI=24&amp;xinfo=8-1234" style="width:100%;height:100%" frameborder=0>Request unsuccessful. Incapsula incident ID: 1234000450123456789-123456789012345</iframe></body></html>`;

// Negatives.
const ARTICLE_LONG = `<!doctype html><html><head><title>Why Cloudflare says "Attention Required!" | Tech Blog</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head><body><article>
<h1>Sorry, you have been blocked: what Cloudflare's block page means</h1>
<p>The page reads "Attention Required! | Cloudflare", shows a Cloudflare Ray ID and says you are unable to access the site.
Akamai's version is titled "Access Denied": You don't have permission to access "/" on this server. Reference #18.4f3c1702.1730000000.1a2b3c4d.
PerimeterX asks you to Press &amp; Hold. Imperva shows an Incapsula incident ID.</p><p>${FILLER}</p></article></body></html>`;

const ARTICLE_SHORT = `<!doctype html><html><head><title>Sorry, you have been blocked — a note</title></head><body>
<p>When Cloudflare blocks you it says "Sorry, you have been blocked" and shows a Ray ID. We use Cloudflare too.</p></body></html>`;

const TURNSTILE_LOGIN = `<!doctype html><html><head><title>Sign in</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head><body>
<form id="login-form"><input name="email"><input name="password" type="password">
<div class="cf-turnstile" data-sitekey="0x4AAAAAAA"></div><button>Sign in</button></form></body></html>`;

const SITE_403 = `<!doctype html><html><head><title>Access Denied</title></head><body><main>
<h1>Access Denied</h1><p>You don't have permission to access this page. Please sign in with an account that has access, or contact your administrator.</p>
<p>Error reference #4031</p></main></body></html>`;

const CF_522 = `<!DOCTYPE html><html lang="en-US"><head><title>example.com | 522: Connection timed out</title></head>
<body><div id="cf-wrapper"><div id="cf-error-details" class="p-0"><header><h1><span class="cf-error-type">Error</span><span class="cf-error-code">522</span></h1>
<h2>Connection timed out</h2></header><p>The initial connection between Cloudflare's network and the origin web server timed out.</p>
<div class="cf-error-footer"><p>Cloudflare Ray ID: 8d2f1a2b3c4d5e71</p></div></div></div></body></html>`;

const SUPPORT_PAGE = `<!doctype html><html><head><title>How to report an error to support</title></head><body>
<p>If you see an Incapsula incident ID, include it in your support ticket. Request unsuccessful? Try again later.</p></body></html>`;

const DATADOME_TAG_PAGE = `<!doctype html><html><head><title>News</title>
<script>window.ddjskey = 'ABC'; window.ddoptions = {};</script><script src="https://js.datadome.co/tags.js" async></script></head>
<body><main><h1>Headlines</h1><p>The day's stories.</p></main></body></html>`;

const PX_SITE_ELEMENT = `<!doctype html><html><head><title>Checkout</title></head><body>
<div id="px-captcha"></div><h1>Your basket</h1><p>Two items.</p></body></html>`;

// --- the walls --------------------------------------------------------------------

console.log('\n=== bot-wall harness ===\n');

console.log('walls');
const walls: Array<[string, string, Pick<BotWall, 'vendor' | 'kind'>]> = [
  ['Cloudflare block page ("Sorry, you have been blocked")', CF_BLOCK, { vendor: 'cloudflare', kind: 'block' }],
  ['Cloudflare access denied (Error 1020)', CF_1020, { vendor: 'cloudflare', kind: 'block' }],
  ['Cloudflare challenge ("Just a moment...")', CF_CHALLENGE, { vendor: 'cloudflare', kind: 'challenge' }],
  ['Akamai "Access Denied" with its reference id', AKAMAI, { vendor: 'akamai', kind: 'block' }],
  ['DataDome challenge frame', DATADOME, { vendor: 'datadome', kind: 'challenge' }],
  ['PerimeterX press-and-hold', PERIMETERX, { vendor: 'perimeterx', kind: 'challenge' }],
  ['Imperva challenge frame / incident id', IMPERVA, { vendor: 'imperva', kind: 'challenge' }],
];
for (const [label, html, want] of walls) {
  const got = detectBotWall(stubDocument(html));
  check(`${label} → ${want.vendor} ${want.kind}`, got !== null && got.vendor === want.vendor && got.kind === want.kind, got);
}
const imperva = classifyBotWall({ ...readBotWallSignals(stubDocument('<html><body>Request unsuccessful. Incapsula incident ID: 1234000450123456789-123456789012345</body></html>')) });
check('an Imperva incident id alone is a block page', imperva?.vendor === 'imperva' && imperva.kind === 'block', imperva);
const cfBlock = detectBotWall(stubDocument(CF_BLOCK));
check('the wall carries its title', cfBlock?.title === 'Attention Required! | Cloudflare', cfBlock);
check('described in words', cfBlock !== null && describeBotWall(cfBlock) === 'a Cloudflare block page ("Attention Required! | Cloudflare")', cfBlock && describeBotWall(cfBlock));
const akamai = detectBotWall(stubDocument(AKAMAI));
check('…with the right article', akamai !== null && describeBotWall(akamai).startsWith('an Akamai block page'), akamai && describeBotWall(akamai));

console.log('\nnot walls');
const negatives: Array<[string, string]> = [
  ['a long article quoting every wall\'s wording', ARTICLE_LONG],
  ['a short note quoting Cloudflare\'s block wording (no template)', ARTICLE_SHORT],
  ['a login form with a Turnstile widget', TURNSTILE_LOGIN],
  ['a site\'s own "Access Denied" 403 page', SITE_403],
  ['a Cloudflare origin error (522): the template, but no bot refusal', CF_522],
  ['a short help page mentioning an Incapsula incident ID', SUPPORT_PAGE],
  ['a page carrying DataDome\'s ordinary tag', DATADOME_TAG_PAGE],
  ['a site page that happens to have a #px-captcha element', PX_SITE_ELEMENT],
];
for (const [label, html] of negatives) {
  const got = detectBotWall(stubDocument(html));
  check(`${label} → no wall`, got === null, got);
}
// The template's own markers on a long page: the site, whatever it embeds.
const longBlock = CF_BLOCK.replace('</body>', `<p>${FILLER}</p></body>`);
check(`a block template inside more than ${MAX_WALL_TEXT} characters of text → no wall`, detectBotWall(stubDocument(longBlock)) === null);
// The challenge is judged by markup alone, as the boot check always was.
const longChallenge = CF_CHALLENGE.replace('</body>', `<p>${FILLER}</p></body>`);
check('the Cloudflare challenge is a wall whatever the text length', detectBotWall(stubDocument(longChallenge))?.kind === 'challenge');

console.log('\nthe boot check (isCloudflareInterstitial) agrees');
check('challenge fixture → interstitial', isCloudflareInterstitial(stubDocument(CF_CHALLENGE)) === true);
for (const [label, html] of [['block page', CF_BLOCK], ['Turnstile login', TURNSTILE_LOGIN], ['article', ARTICLE_LONG]] as const) {
  check(`${label} → not an interstitial (boot unchanged)`, isCloudflareInterstitial(stubDocument(html)) === false);
}
check('null / {} / a throwing querySelector → false', isCloudflareInterstitial(null) === false && isCloudflareInterstitial({}) === false &&
  isCloudflareInterstitial({ querySelector: () => { throw new Error('x'); } }) === false);
check('detectBotWall(null) and a stub without querySelector → null', detectBotWall(null) === null && detectBotWall({} as unknown as Document) === null);

console.log('\nthe page script');
const source = readBotWallSignals.toString();
check('the reader repeats the runner selector', source.includes(RUNNER_SELECTOR.replace(/"/g, '\\"')) || source.includes(RUNNER_SELECTOR), source.slice(0, 200));
check('…and the container selector', source.includes(CONTAINER_SELECTOR));
// Runs as a self-contained expression (no outer names) over a document.
const run = new Function('document', `return ${BOT_WALL_SCRIPT};`) as (doc: Document) => unknown;
const scripted = asBotWallSignals(run(stubDocument(CF_BLOCK)));
check('BOT_WALL_SCRIPT evaluates to the signals', scripted !== null && classifyBotWall(scripted)?.vendor === 'cloudflare', scripted);
check('a throwing document reads as no signals of a wall', classifyBotWall(readBotWallSignals({
  get title(): string { throw new Error('x'); }, get body(): never { throw new Error('x'); }, querySelector: () => { throw new Error('x'); },
} as unknown as Document)) === null);
check('asBotWallSignals refuses a non-signal value', asBotWallSignals(null) === null && asBotWallSignals('x') === null && asBotWallSignals({ title: 1 }) === null);

console.log('\nnotes on results');
const note = botWallNote(cfBlock as BotWall, 'Open it in a browser the site lets in.');
check('the note names the wall and the advice', note.code === 'bot-wall' && note.message.includes('Cloudflare block page') && note.message.endsWith('Open it in a browser the site lets in.'), note);
check('no note: the result is untouched', withBotWallNote('{"a":1}', null) === '{"a":1}');
const json = withBotWallNote('{"candidates":[]}', note);
check('a JSON-object string gets a botWall field', typeof json === 'string' && JSON.parse(json).botWall.vendor === 'cloudflare' && Array.isArray(JSON.parse(json).candidates), json);
const plain = withBotWallNote('not json', note);
check('a plain string gets a second text block', Array.isArray(plain) && plain.length === 2, plain);
const blocks = withBotWallNote([{ type: 'text', text: 'caption' }, { type: 'image', source: {} }], note);
check('content blocks get one more text block', Array.isArray(blocks) && blocks.length === 3 && String((blocks[2] as { text: string }).text).includes('botWall'), blocks);
const obj = withBotWallNote({ ok: true }, note) as Record<string, unknown>;
check('an object gets a botWall field', obj.ok === true && (obj.botWall as { code: string }).code === 'bot-wall', obj);
const evidence = withBotWallEvidence({ rules: [{ ruleId: 'a', verification: 'full' }, { ruleId: 'b', verification: 'none' }, { ruleId: 'c', verification: 'partial' }], warnings: ['w0'] }, note) as Record<string, unknown>;
const levels = (evidence.rules as Array<{ verification: string }>).map((r) => r.verification).join(',');
check('evidence: full drops to partial, none and partial stay', levels === 'partial,none,partial', levels);
check('evidence: the message joins the warnings, the note rides as botWall', JSON.stringify(evidence.warnings) === JSON.stringify(['w0', note.message]) && (evidence.botWall as { code: string }).code === 'bot-wall', evidence);
check('evidence that is not an object is untouched', withBotWallEvidence('x', note) === 'x');

async function hostCases(): Promise<void> {
  console.log('\nreading a host');
  const host = (value: unknown) => ({ evaluate: async (code: string, world: string) => (code === BOT_WALL_SCRIPT ? (world === 'engine' ? { engine: true } : value) : null) });
  const signals = readBotWallSignals(stubDocument(AKAMAI));
  check('a host whose page is a wall answers it', (await botWallOnHost(host(signals)))?.vendor === 'akamai');
  check('a host whose page is the site answers null', (await botWallOnHost(host(readBotWallSignals(stubDocument(SITE_403))))) === null);
  check('the world is the caller\'s', (await botWallOnHost(host(signals), 2000, 'engine')) === null);
  check('a throwing evaluate answers null', (await botWallOnHost({ evaluate: async () => { throw new Error('gone'); } })) === null);
  // Remembered per document: the session's own output covering the wall
  // (a replace-root over the block page) doesn't clear it.
  let page = readBotWallSignals(stubDocument(CF_BLOCK)) as unknown;
  let token: string | null = 'doc-1';
  const doc = { evaluate: async () => page, documentToken: async () => token };
  const memory: BotWallMemory = { last: null };
  check('a wall is read and remembered', (await rememberedBotWall(doc, memory, 'x'))?.vendor === 'cloudflare' && memory.last?.token === 'doc-1');
  page = readBotWallSignals(stubDocument('<html><body><div id="cf-error-details"></div><main>My replacement UI</main></body></html>'));
  check('…covered by the session\'s output, the same document is still the wall', (await rememberedBotWall(doc, memory, 'x'))?.vendor === 'cloudflare');
  token = 'doc-2';
  check('a new document without the signals is no wall', (await rememberedBotWall(doc, memory, 'x')) === null);
  token = null;
  check('an unreadable document is never matched to a remembered one', (await rememberedBotWall(doc, memory, 'x')) === null);
  const started = Date.now();
  const hung = await botWallOnHost({ evaluate: () => new Promise(() => {}) }, 50);
  check('a page that never answers counts as no wall, after the timeout', hung === null && Date.now() - started < 1000);
}

hostCases().then(() => {
  console.log(failures === 0 ? '\nall bot-wall checks passed' : `\n${failures} bot-wall check(s) FAILED`);
  if (failures) process.exit(1);
}, (e: unknown) => {
  console.error(e);
  process.exit(1);
});
