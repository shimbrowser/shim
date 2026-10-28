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
// Two forms of one check:
//   - isCloudflareInterstitial(doc): the selector-only Cloudflare challenge
//     check a host runs before booting shims (unchanged in meaning: the
//     same-origin challenge runner AND a challenge-only container);
//   - detectBotWall(doc) / classifyBotWall(signals): every wall below, over
//     a document or over the signals BOT_WALL_SCRIPT reads in a page.
// Pure, dependency-free; the signal reader is self-contained so it also
// runs as page script.

/** Cloudflare's same-origin challenge runner: the interstitial's own orchestrator. A standalone Turnstile widget loads from challenges.cloudflare.com instead. */
export const RUNNER_SELECTOR = 'script[src*="/cdn-cgi/challenge-platform/"]';

/** Containers unique to Cloudflare's full-page interstitial (not an embedded widget). */
export const CONTAINER_SELECTOR = [
  '#challenge-running',
  '#cf-please-wait',
  '#challenge-stage',
  '#challenge-form',
  '#trk_jschal_js',
  '#challenge-error-text',
].join(', ');

/** The slice of a `document` the selector check needs. Optional, so a stub without it answers false. */
export interface DocumentLike {
  querySelector?: (selector: string) => unknown;
}

/** A Cloudflare full-page challenge: the runner script AND a challenge-only container. */
export function isCloudflareInterstitial(doc: DocumentLike | null | undefined): boolean {
  if (!doc || typeof doc.querySelector !== 'function') return false;
  try {
    if (!doc.querySelector(RUNNER_SELECTOR)) return false;
    return !!doc.querySelector(CONTAINER_SELECTOR);
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
  /** Cloudflare's error-page template (#cf-error-details). */
  cfErrorTemplate: boolean;
  /** PerimeterX / HUMAN's challenge element (#px-captcha). */
  pxCaptcha: boolean;
  /** A DataDome challenge frame or script (served from captcha-delivery.com). */
  ddCaptcha: boolean;
  /** An Imperva / Incapsula challenge resource frame. */
  incapsulaResource: boolean;
}

export type BotWallKind = 'challenge' | 'block';
export type BotWallVendor = 'cloudflare' | 'akamai' | 'datadome' | 'perimeterx' | 'imperva';

/** A page judged to be a wall: who served it, which kind, and what gave it away. */
export interface BotWall {
  vendor: BotWallVendor;
  kind: BotWallKind;
  /** The page's title, for the message (may be empty). */
  title: string;
  /** The signals that matched, in words. */
  reason: string;
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
    cfErrorTemplate: has('#cf-error-details'),
    pxCaptcha: has('#px-captcha'),
    ddCaptcha: has('iframe[src*="captcha-delivery.com"], script[src*="captcha-delivery.com"]'),
    incapsulaResource: has('iframe[src*="_Incapsula_Resource"]'),
  };
}

/** A page-script expression whose value is the document's BotWallSignals (run in any world that sees the DOM). */
export const BOT_WALL_SCRIPT = `(${readBotWallSignals.toString()})(document)`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

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
    cfErrorTemplate: flag('cfErrorTemplate'),
    pxCaptcha: flag('pxCaptcha'),
    ddCaptcha: flag('ddCaptcha'),
    incapsulaResource: flag('incapsulaResource'),
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
  // Imperva / Incapsula: its incident id, or its challenge resource frame.
  if (/incapsula incident id/i.test(text) || (s.incapsulaResource && s.textLength < 200)) {
    return wall('imperva', s.incapsulaResource ? 'challenge' : 'block', 'Imperva\'s incident id or challenge frame');
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
  cloudflare: 'Cloudflare', akamai: 'Akamai', datadome: 'DataDome', perimeterx: 'PerimeterX', imperva: 'Imperva',
};

/** The wall in a few words: `a Cloudflare block page ("Attention Required! | Cloudflare")`. */
export function describeBotWall(w: BotWall): string {
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

/** The one PageHost member reading a page's wall needs. */
export interface BotWallReader {
  evaluate(code: string, world: 'main' | 'engine'): Promise<unknown>;
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
    const raw = await Promise.race([
      host.evaluate(BOT_WALL_SCRIPT, world),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    const signals = asBotWallSignals(raw);
    return signals ? classifyBotWall(signals) : null;
  } catch (_) {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
