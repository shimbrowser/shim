// Bot walls: a page a CDN or bot-protection service serves in place of the
// site (a challenge, or a block page). Nothing a session sees on one is the
// site: an anchor that misses there says nothing about the real page, and a
// rule that matches the wall's own markup is a rule against the wrong page.
//
// This module only DETECTS. It never evades: no user-agent change, no
// automation flag hidden, no challenge answered. The honest answer to a wall
// is to say so, and to send the author to a browser the site lets in.
//
// CONSERVATIVE BY DESIGN. A false positive (a real page taken for a wall)
// would refuse a session or hide a shim's evidence on a page that is fine,
// so every signal below is one the services' own templates carry and a
// site's content does not: an element id or a script / frame source unique
// to the template, together with the template's wording, on a short page.
// A page that merely talks about Cloudflare, embeds a Turnstile widget, or
// shows its own "access denied" message matches none of them.
//
// One wall carries no template: a site's edge refusing the browser with a
// bare 403 or 429 (the status and a line, nothing else). Markup can't tell
// that from a page that says "403", so it is judged only with the HTTP
// status the HOST's network layer reported for the document (PageHost
// documentStatus) on a page with almost no text and no script, form or
// link; a host that can't report a status never sees this wall. The same
// holds for an empty challenge: an edge (AWS WAF's, for one) answering 202
// with no body at all, which renders as an empty document.
//
// Two forms of one check:
//   - isCloudflareInterstitial(doc): the Cloudflare challenge check a host
//     runs before booting shims: the same-origin challenge runner AND a
//     challenge-only container (the older template), or the challenge page's
//     own chl_page runner AND its inline `_cf_chl_opt` config or its
//     Turnstile response input (the current one, whose ids are random);
//   - detectBotWall(doc) / classifyBotWall(signals): every wall below, over
//     a document or over the signals BOT_WALL_SCRIPT reads in a page.
// Pure, dependency-free; the signal reader is self-contained so it also
// runs as page script.

/** Cloudflare's same-origin challenge runner: the interstitial's own orchestrator. A standalone Turnstile widget loads from challenges.cloudflare.com instead. */
import { isRecord } from './is-record';
import type { DocumentStatus } from './page-host';

export const RUNNER_SELECTOR = 'script[src*="/cdn-cgi/challenge-platform/"]';

/** Containers unique to Cloudflare's full-page interstitial (not an embedded widget): the older template's fixed ids. */
export const CONTAINER_SELECTOR = [
  '#challenge-running',
  '#cf-please-wait',
  '#challenge-stage',
  '#challenge-form',
  '#trk_jschal_js',
  '#challenge-error-text',
].join(', ');

/**
 * The challenge page's own runner (`/cdn-cgi/challenge-platform/h/<x>/orchestrate/chl_page/v1`),
 * which only the full-page challenge loads: Cloudflare's invisible JS
 * detection loads `/cdn-cgi/challenge-platform/scripts/jsd/` instead, and a
 * Turnstile widget loads from challenges.cloudflare.com. The current
 * template randomizes every id and class, so this runner plus one of the two
 * markers below is what tells it.
 */
export const CHL_PAGE_RUNNER_SELECTOR = 'script[src*="/cdn-cgi/challenge-platform/"][src*="/chl_page/"]';
/** The challenge's Turnstile response input. A site's own widget carries the same id, so it counts only beside the chl_page runner. */
export const CHL_WIDGET_SELECTOR = 'input[name="cf-turnstile-response"][id^="cf-chl-widget-"]';
/** The challenge's inline config (`window._cf_chl_opt = {…}`), server-rendered, so present at DOMContentLoaded. */
export const CHL_CONFIG_MARKER = '_cf_chl_opt';
/** Where the inline config is looked for. */
export const INLINE_SCRIPT_SELECTOR = 'script:not([src])';
/** How many inline scripts are read for it (the challenge page has a handful). */
export const MAX_INLINE_SCRIPTS = 20;

/** The slice of a `document` the check needs. Optional, so a stub without it answers false. */
export interface DocumentLike {
  querySelector?: (selector: string) => unknown;
  querySelectorAll?: (selector: string) => ArrayLike<{ textContent?: string | null }>;
}

function hasChallengeConfig(doc: DocumentLike): boolean {
  if (typeof doc.querySelectorAll !== 'function') return false;
  const scripts = doc.querySelectorAll(INLINE_SCRIPT_SELECTOR);
  const n = Math.min(scripts.length, MAX_INLINE_SCRIPTS);
  for (let i = 0; i < n; i++) {
    if (String(scripts[i]?.textContent ?? '').includes(CHL_CONFIG_MARKER)) return true;
  }
  return false;
}

/**
 * A Cloudflare full-page challenge: the runner script AND a challenge-only
 * container (the older template), or the chl_page runner AND the inline
 * config or the challenge's Turnstile input (the current one). Markup that
 * is text (inside `<noscript>`, with script on) is not markup and counts for
 * nothing.
 */
export function isCloudflareInterstitial(doc: DocumentLike | null | undefined): boolean {
  if (!doc || typeof doc.querySelector !== 'function') return false;
  try {
    if (!doc.querySelector(RUNNER_SELECTOR)) return false;
    if (doc.querySelector(CONTAINER_SELECTOR)) return true;
    if (!doc.querySelector(CHL_PAGE_RUNNER_SELECTOR)) return false;
    return !!doc.querySelector(CHL_WIDGET_SELECTOR) || hasChallengeConfig(doc);
  } catch (_) {
    return false;
  }
}

// --- every wall ---------------------------------------------------------------

/** What a page shows that a wall can be told by. Read in the page by BOT_WALL_SCRIPT. */
export interface BotWallSignals {
  /** document.title, trimmed (at most 300 characters). */
  title: string;
  /** The body's visible text, whitespace collapsed (at most TEXT_SAMPLE characters). */
  text: string;
  /** The visible text's full length, collapsed. */
  textLength: number;
  /** Cloudflare's challenge runner script (RUNNER_SELECTOR). */
  cfChallengeRunner: boolean;
  /** A Cloudflare challenge-only container (CONTAINER_SELECTOR). */
  cfChallengeContainer: boolean;
  /** The challenge page's chl_page runner (CHL_PAGE_RUNNER_SELECTOR). */
  cfChallengePageRunner: boolean;
  /** The challenge's inline `_cf_chl_opt` config or its Turnstile response input (CHL_CONFIG_MARKER, CHL_WIDGET_SELECTOR). */
  cfChallengeMarker: boolean;
  /** Cloudflare's error-page template (#cf-error-details). */
  cfErrorTemplate: boolean;
  /** PerimeterX / HUMAN's challenge element (#px-captcha). */
  pxCaptcha: boolean;
  /** A DataDome challenge frame or script (served from captcha-delivery.com). */
  ddCaptcha: boolean;
  /** An Imperva / Incapsula challenge resource frame. */
  incapsulaResource: boolean;
  /** The document has any script element (an app shell renders a page; a bare refusal has none). */
  scripts: boolean;
  /** The document has a form control or a link (a site's own page offers a way on; a bare refusal offers none). */
  interactive: boolean;
  /** The body holds any element (an empty challenge response renders a body with none). */
  bodyElements: boolean;
  /**
   * The HTTP status of the response that delivered the document, as the
   * host's network layer reported it (botWallOnHost sets it). Never read
   * from the page: the reader leaves it out and asBotWallSignals drops it.
   */
  httpStatus?: number | null;
}

export type BotWallKind = 'challenge' | 'block';
/** `unknown`: a bare refusal no vendor template names (judged by the host's HTTP status). */
export type BotWallVendor = 'cloudflare' | 'akamai' | 'datadome' | 'perimeterx' | 'imperva' | 'unknown';

/** A page judged to be a wall: who served it, which kind, and what gave it away. */
export interface BotWall {
  vendor: BotWallVendor;
  kind: BotWallKind;
  /** The page's title, for the message (may be empty). */
  title: string;
  /** The signals that matched, in words. */
  reason: string;
  /** The host-reported HTTP status, when the wall was judged by it. */
  status?: number;
}

/** How much visible text the reader keeps. */
export const TEXT_SAMPLE = 4000;
/**
 * Walls are short: a page with more visible text than this is the site,
 * whatever it says. (Cloudflare's challenge, judged by template markup only,
 * is exempt, as the boot check always was.)
 */
export const MAX_WALL_TEXT = 3000;
/**
 * A bare refusal is a status line and maybe a server name: nginx's and
 * Apache's defaults are well under this, a site's own error page (a
 * sentence or two of its own, navigation, a footer) is over it.
 */
export const BARE_BLOCK_TEXT = 120;
/** The statuses a bare refusal answers with: forbidden, and too many requests. */
const BARE_BLOCK_STATUSES: ReadonlySet<number> = new Set([403, 429]);
/**
 * The status an edge answers with when it serves an empty challenge in place
 * of the page (202 Accepted, no body). Judged only on a wholly empty document.
 */
const EMPTY_CHALLENGE_STATUS = 202;

/**
 * Reads BotWallSignals from a document. Self-contained (no outer names), so
 * BOT_WALL_SCRIPT can run it as page script; the selectors repeat the
 * constants above, and the bot-wall harness holds them equal.
 */
export function readBotWallSignals(doc: Document): BotWallSignals {
  const has = (sel: string): boolean => {
    try { return !!doc.querySelector(sel); } catch (_) { return false; }
  };
  const read = (fn: () => unknown): string => {
    try { return String(fn() ?? ''); } catch (_) { return ''; }
  };
  const title = read(() => doc.title).replace(/\s+/g, ' ').trim().slice(0, 300);
  // innerText is the visible text (no script / style / hidden subtrees);
  // textContent is the fallback where layout is unavailable.
  const full = read(() => {
    const body = doc.body;
    return body ? ((body as HTMLElement).innerText ?? body.textContent) : '';
  }).replace(/\s+/g, ' ').trim();
  return {
    title,
    text: full.slice(0, 4000),
    textLength: full.length,
    cfChallengeRunner: has('script[src*="/cdn-cgi/challenge-platform/"]'),
    cfChallengeContainer: has('#challenge-running, #cf-please-wait, #challenge-stage, #challenge-form, #trk_jschal_js, #challenge-error-text'),
    cfChallengePageRunner: has('script[src*="/cdn-cgi/challenge-platform/"][src*="/chl_page/"]'),
    cfChallengeMarker: has('input[name="cf-turnstile-response"][id^="cf-chl-widget-"]') || (() => {
      try {
        const scripts = doc.querySelectorAll('script:not([src])');
        const n = Math.min(scripts.length, 20);
        for (let i = 0; i < n; i++) {
          if (String(scripts[i]?.textContent ?? '').includes('_cf_chl_opt')) return true;
        }
      } catch (_) { /* unreadable: no marker */ }
      return false;
    })(),
    cfErrorTemplate: has('#cf-error-details'),
    pxCaptcha: has('#px-captcha'),
    ddCaptcha: has('iframe[src*="captcha-delivery.com"], script[src*="captcha-delivery.com"]'),
    incapsulaResource: has('iframe[src*="_Incapsula_Resource"]'),
    scripts: has('script'),
    interactive: has('form, input, button, select, textarea, a[href]'),
    bodyElements: has('body *'),
  };
}

/** A page-script expression whose value is the document's BotWallSignals (run in any world that sees the DOM). */
export const BOT_WALL_SCRIPT = `(${readBotWallSignals.toString()})(document)`;

/** Signals from an untrusted value (an evaluate result), or null when it isn't their shape. */
export function asBotWallSignals(v: unknown): BotWallSignals | null {
  if (!isRecord(v)) return null;
  if (typeof v.title !== 'string' || typeof v.text !== 'string' || typeof v.textLength !== 'number') return null;
  const flag = (k: string): boolean => v[k] === true;
  return {
    title: v.title,
    text: v.text,
    textLength: v.textLength,
    cfChallengeRunner: flag('cfChallengeRunner'),
    cfChallengeContainer: flag('cfChallengeContainer'),
    cfChallengePageRunner: flag('cfChallengePageRunner'),
    cfChallengeMarker: flag('cfChallengeMarker'),
    cfErrorTemplate: flag('cfErrorTemplate'),
    pxCaptcha: flag('pxCaptcha'),
    ddCaptcha: flag('ddCaptcha'),
    incapsulaResource: flag('incapsulaResource'),
    // Unknown reads as having scripts, the side that never makes a wall.
    // No httpStatus: a page's own answer never carries one.
    scripts: v.scripts !== false,
    interactive: v.interactive !== false,
    bodyElements: v.bodyElements !== false,
  };
}

// Cloudflare's error template blocks with one of these: the firewall's
// "you have been blocked", or a 10xx access-denied / rate-limit code.
const CF_BLOCK_TEXT = /sorry, you have been blocked|you are unable to access|error\s*10(?:06|07|08|09|10|12|15|20)\b/i;
// Akamai's edge "Access Denied": its reference id is dotted hex, e.g.
// "Reference #18.4f3c1702.1730000000.1a2b3c4d".
const AKAMAI_REFERENCE = /reference\s*#\s*\d+\.[0-9a-f]+\.\d+\.[0-9a-f]+/i;

/** The wall a page's signals show, or null. Pure. */
export function classifyBotWall(s: BotWallSignals): BotWall | null {
  const title = s.title;
  const wall = (vendor: BotWallVendor, kind: BotWallKind, reason: string): BotWall => ({ vendor, kind, title, reason });
  // Cloudflare's challenge: template markup alone, as the boot check judges it.
  if (s.cfChallengeRunner && s.cfChallengeContainer) {
    return wall('cloudflare', 'challenge', 'Cloudflare\'s challenge runner and challenge container');
  }
  if (s.cfChallengeRunner && s.cfChallengePageRunner && s.cfChallengeMarker) {
    return wall('cloudflare', 'challenge', 'Cloudflare\'s challenge-page runner and its challenge config');
  }
  if (s.textLength > MAX_WALL_TEXT) return null;
  const text = s.text;
  // Cloudflare's block page ("Attention Required! | Cloudflare"): the error
  // template, its Ray ID footer, and block wording.
  if (s.cfErrorTemplate && /ray id/i.test(text) && (CF_BLOCK_TEXT.test(text) || /^attention required!/i.test(title))) {
    return wall('cloudflare', 'block', 'Cloudflare\'s error template with a Ray ID and its block wording');
  }
  // Akamai's edge block: the bare "Access Denied" page with its reference id.
  if (/^access denied$/i.test(title) && /you don'?t have permission to access/i.test(text) &&
      (AKAMAI_REFERENCE.test(text) || /errors\.edgesuite\.net/i.test(text))) {
    return wall('akamai', 'block', 'Akamai\'s "Access Denied" page with its reference id');
  }
  // PerimeterX / HUMAN's press-and-hold challenge.
  if (s.pxCaptcha && (/access to this page has been denied/i.test(title) || /press\s*&\s*hold/i.test(text))) {
    return wall('perimeterx', 'challenge', 'the #px-captcha challenge and its wording');
  }
  // DataDome: the challenge served from captcha-delivery.com in place of the page.
  if (s.ddCaptcha && s.textLength < 1000) {
    return wall('datadome', 'challenge', 'a DataDome challenge (captcha-delivery.com) on a near-empty page');
  }
  // Imperva / Incapsula: its challenge resource frame on a near-empty page,
  // or its block page, which is that one sentence and the incident's numeric
  // id (a page that only mentions an incident id is neither).
  if (s.incapsulaResource && s.textLength < 200) {
    return wall('imperva', 'challenge', 'Imperva\'s challenge resource frame on a near-empty page');
  }
  if (s.textLength < 300 && /^request unsuccessful\.\s*incapsula incident id:\s*[\d-]{6,}/i.test(text)) {
    return wall('imperva', 'block', 'Imperva\'s "Request unsuccessful" page with its incident id');
  }
  // A bare refusal: the host saw 403 / 429 for a document with next to no
  // text, no script, and nothing to do. A site's own error page has more to
  // say or a way on (a sign-in form, a link home), and an app shell served
  // with that status renders the page from its scripts.
  const status = s.httpStatus;
  if (typeof status === 'number' && BARE_BLOCK_STATUSES.has(status) && !s.scripts && !s.interactive && s.textLength < BARE_BLOCK_TEXT) {
    return { ...wall('unknown', 'block', `HTTP ${status} with a bare page (${s.textLength} characters of text, no script, form or link)`), status };
  }
  // An empty challenge: the host saw 202 for a document with nothing in it
  // at all (no text, no element in the body, no script). A 202 that renders
  // anything, or an app shell whose scripts will, is the site.
  if (status === EMPTY_CHALLENGE_STATUS && s.textLength === 0 && !s.bodyElements && !s.scripts && !s.interactive) {
    return { ...wall('unknown', 'block', `HTTP ${status} with an empty document (no text, no element, no script)`), status };
  }
  return null;
}

/** The wall a document shows, or null (also for a stub without the DOM it reads). */
export function detectBotWall(doc: Document | null | undefined): BotWall | null {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  try {
    return classifyBotWall(readBotWallSignals(doc));
  } catch (_) {
    return null;
  }
}

const VENDOR_NAMES: Record<BotWallVendor, string> = {
  cloudflare: 'Cloudflare', akamai: 'Akamai', datadome: 'DataDome', perimeterx: 'PerimeterX', imperva: 'Imperva', unknown: '',
};

/**
 * The wall in a few words: `a Cloudflare block page ("Attention Required! | Cloudflare")`,
 * for a bare refusal `a block page (HTTP 403, "403 Forbidden")`, and for an
 * empty challenge `an empty challenge response (HTTP 202)`.
 */
export function describeBotWall(w: BotWall): string {
  if (w.vendor === 'unknown') {
    if (w.status === EMPTY_CHALLENGE_STATUS) return `an empty challenge response (HTTP ${w.status})`;
    const status = w.status !== undefined ? `HTTP ${w.status}` : 'no vendor named';
    return `a block page (${w.title ? `${status}, "${w.title.slice(0, 80)}"` : status})`;
  }
  const what = `${w.vendor === 'akamai' || w.vendor === 'imperva' ? 'an' : 'a'} ${VENDOR_NAMES[w.vendor]} ${w.kind === 'challenge' ? 'challenge' : 'block page'}`;
  return w.title ? `${what} ("${w.title.slice(0, 80)}")` : what;
}

/** What a result carries while the page is a wall (the `botWall` field). */
export interface BotWallNote {
  code: 'bot-wall';
  vendor: BotWallVendor;
  kind: BotWallKind;
  message: string;
}

/**
 * The note for a wall. `advice` is the host's next step (how to get past it
 * honestly: a browser the site lets in, or solving the challenge yourself).
 */
export function botWallNote(w: BotWall, advice: string): BotWallNote {
  return {
    code: 'bot-wall',
    vendor: w.vendor,
    kind: w.kind,
    message: `The page is ${describeBotWall(w)}, served in place of the site: nothing seen here is the site's own page, ` +
      `so no rule is verified beyond partial and a rule that matches nothing says nothing about the site. ${advice}`.trim(),
  };
}

function isContentBlock(v: unknown): boolean {
  return isRecord(v) && (v.type === 'text' || v.type === 'image');
}

/**
 * A tool result with the note added: a `botWall` field on a JSON object
 * (a string result is parsed when it is one), else one more text block.
 */
export function withBotWallNote(result: unknown, note: BotWallNote | null): unknown {
  if (note === null) return result;
  if (typeof result === 'string') {
    try {
      const parsed: unknown = JSON.parse(result);
      if (isRecord(parsed)) return JSON.stringify({ ...parsed, botWall: note });
    } catch (_) { /* not JSON: a block below */ }
    return [{ type: 'text', text: result }, { type: 'text', text: JSON.stringify({ botWall: note }) }];
  }
  if (Array.isArray(result) && result.every(isContentBlock)) return [...result, { type: 'text', text: JSON.stringify({ botWall: note }) }];
  if (isRecord(result)) return { ...result, botWall: note };
  return { result, botWall: note };
}

/**
 * Preview evidence on a wall: the note as `botWall`, its message among the
 * warnings, and every rule's verification capped at `partial` (`full`
 * drops, `none` stays). Never an upgrade. Pure.
 */
export function withBotWallEvidence(evidence: unknown, note: BotWallNote | null): unknown {
  if (note === null || !isRecord(evidence)) return evidence;
  const warnings = Array.isArray(evidence.warnings) ? [...(evidence.warnings as unknown[])] : [];
  warnings.push(note.message);
  const out: Record<string, unknown> = { ...evidence, warnings, botWall: note };
  if (Array.isArray(evidence.rules)) {
    out.rules = evidence.rules.map((r: unknown) => (isRecord(r) && r.verification === 'full' ? { ...r, verification: 'partial' } : r));
  }
  return out;
}

/**
 * The page tools whose answer is about the page as it is now: on a wall,
 * each carries the note (as every preview's evidence does).
 */
export const BOT_WALL_TOOLS: ReadonlySet<string> = new Set([
  'view_page', 'query_page', 'inspect_element', 'evaluate_in_page', 'interact_page', 'reload_page', 'navigate',
]);

/** The PageHost members reading a page's wall uses: `evaluate`, and `documentStatus` where the host has it. */
export interface BotWallReader {
  evaluate(code: string, world: 'main' | 'engine'): Promise<unknown>;
  documentStatus?(): DocumentStatus;
}

/** How long reading a page's signals may take before the page counts as no wall. */
export const BOT_WALL_READ_TIMEOUT_MS = 2000;

/**
 * The wall the host's page shows now, or null: also when the page can't be
 * read (gone, mid-navigation, too slow), since a wall is only ever reported
 * on positive evidence. Read in the page's main world by default, as
 * query_page reads; a host that keeps main-world work off a challenge page
 * passes its isolated world.
 */
export async function botWallOnHost(host: BotWallReader, timeoutMs: number = BOT_WALL_READ_TIMEOUT_MS, world: 'main' | 'engine' = 'main'): Promise<BotWall | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The status is the read document's only when no document committed
    // while the page was read.
    const before = host.documentStatus?.();
    const raw = await Promise.race([
      host.evaluate(BOT_WALL_SCRIPT, world),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    const after = host.documentStatus?.();
    const signals = asBotWallSignals(raw);
    if (!signals) return null;
    const httpStatus = before && after && before.commit === after.commit ? after.status : null;
    return classifyBotWall({ ...signals, httpStatus });
  } catch (_) {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What a session remembers of the last wall it saw: the document it was on, and its note. */
export interface BotWallMemory {
  last: { token: string; note: BotWallNote } | null;
}

/** A BotWallReader that can also name the document it reads (PageHost.documentToken). */
export interface BotWallDocumentReader extends BotWallReader {
  documentToken(): Promise<string | null>;
}

/**
 * The note for the host's page, remembered per document: a wall seen on a
 * document stays that document's wall even once the session's own output
 * (a replace-root over the block page, say) has covered the signals. So a
 * caller reads it before it applies anything to a fresh document, and again
 * after. Null when no wall was seen on the current document.
 */
export async function rememberedBotWall(
  host: BotWallDocumentReader, memory: BotWallMemory, advice: string,
  world: 'main' | 'engine' = 'main', timeoutMs: number = BOT_WALL_READ_TIMEOUT_MS,
): Promise<BotWallNote | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const token = await Promise.race([
    host.documentToken().catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  const wall = await botWallOnHost(host, timeoutMs, world);
  if (wall) {
    const note = botWallNote(wall, advice);
    if (token !== null) memory.last = { token, note };
    return note;
  }
  return token !== null && memory.last?.token === token ? memory.last.note : null;
}
