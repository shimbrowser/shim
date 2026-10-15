// What a preview's evidence says about each rule and screenshot (shim-core
// design D11: "both hosts return the same shape"). The Shim browser's emit
// feedback (src/main/authoring) and the headless session (@shimbrowser/mcp)
// word every rule status and view_page caption with these, so the agent reads
// the same evidence whichever host it drives.
//
// Pure: no Node, no DOM.

import type { Rule } from './types';

/** The part of a `rule-status` runtime event a status line reads. */
export interface RuleStatusEvent {
  matched?: number;
  matchedVia?: string;
  box?: { x: number; y: number; w: number; h: number };
  note?: unknown;
}

/** The engine-side identity a preview rule runs under (its runtime events' `specId`). */
export function previewKey(patchId: string, ruleId: string): string {
  return `preview:${patchId}:${ruleId}`;
}

// Human-readable per-rule status line from the freshest rule-status event
// this emit produced. mount-route rules report matched: 0 whenever the
// current path isn't the route — that's the normal resting state, not a
// failure, so it gets its own wording.
export function describeRuleStatus(rule: Rule | undefined, status: RuleStatusEvent | undefined): string {
  const isRoute = (rule?.mutations || []).some((m) => m?.kind === 'mount-route');
  // `redirect` rules are handled in main (the network hook rewrites the
  // navigation before the page loads), so the engine never emits a DOM
  // rule-status for them — a missing status is the expected, healthy state.
  const isRedirect = (rule?.mutations || []).some((m) => m?.kind === 'redirect');
  if (isRedirect) {
    return 'redirect registered (applied in main at the network layer — no DOM status; takes effect on the next navigation to the source host)';
  }
  // `rewrite-response` rules are anchorless (§6/§7 Tier-5) — their status
  // arrives from rewrite-install.ts's own reporter, keyed matchedVia:
  // 'rewrite', with `matched` counting applications rather than DOM matches.
  // `matched: 0` is the common resting state (no matching traffic yet), not
  // a broken anchor, so this must never fall into the generic "matched 0
  // elements" text below.
  const isRewrite = (rule?.mutations || []).some((m) => m?.kind === 'rewrite-response');
  if (isRewrite) {
    if (!status) {
      return 'rewrite registered (no status event yet)';
    }
    const note = typeof status.note === 'string' && status.note ? status.note : undefined;
    if (status.matched) {
      return `applied ${status.matched} time(s) via rewrite${note ? ` — NOTE: ${note}` : ''}`;
    }
    return note || 'no matching responses yet — a rewrite applies when the site refetches; reload the page to verify';
  }
  // `intercept` rules are also anchorless (§6/§7 Tier-5) — status arrives
  // from intercept-install.ts's own reporter, keyed matchedVia: 'intercept',
  // with `matched` counting wrapped-call applications rather than DOM
  // matches. `matched: 0` is a common resting state (module not yet
  // registered, or registered but not yet called), not a broken anchor.
  const isIntercept = (rule?.mutations || []).some((m) => m?.kind === 'intercept');
  if (isIntercept) {
    if (!status) return 'intercept registered (no status event yet)';
    const note = typeof status.note === 'string' && status.note ? status.note : undefined;
    if (status.matched) {
      return `wrap ran ${status.matched} time(s)${note ? ` — NOTE: ${note}` : ''}`;
    }
    return note || 'wrap attached — 0 calls observed yet; trigger the wrapped behavior or reload to verify';
  }
  if (!status) {
    return isRoute
      ? 'route registered (no status event yet)'
      : 'no status event received — the engine may not have scanned yet';
  }
  if (isRoute) {
    return status.matched
      ? 'route mounted (current page matches the pattern)'
      : 'route registered; current page does not match the pattern (expected unless you are on the route)';
  }
  if (!status.matched) {
    return 'matched 0 elements — the anchor does not resolve on this page';
  }
  // The box is the anchor's measured viewport rect AFTER the mutation
  // applied — for size/position work the model compares these numbers to
  // the reference element (inspect_element) instead of guessing from a
  // screenshot. First match only when the rule anchored multiple elements.
  const box = status.box
    ? ` — ${status.matched > 1 ? 'first match' : 'anchor'} box ${status.box.w}×${status.box.h}px at (${status.box.x}, ${status.box.y})`
    : '';
  const note = typeof status.note === 'string' && status.note ? ` — NOTE: ${status.note}` : '';
  return `matched ${status.matched} element(s) via ${status.matchedVia || 'primary'}${box}${note}`;
}

/** One `noMatch[]` entry: a rule whose anchor resolved nothing. */
export interface NoMatchEntry {
  ruleId: string | undefined;
  selector: string | undefined;
}

/** A rule this preview applied, with the freshest `rule-status` it reported. */
export interface PreviewedRule {
  rule: Rule;
  status: RuleStatusEvent | undefined;
  /** The most elements any of this preview's statuses for the rule reported. */
  peakMatched?: number;
}

// Rules whose 0 is a dead anchor. The network / module kinds and routes report
// something else in `matched` (or nothing), and an `anchor.iframe` rule
// resolves in a child frame. A rule carrying a witness can read 0 because the
// witness refused what the selector found: whether that is a no-match or a
// quarantine is the engine's call, so it waits for the engine's event.
function reportsDomMatches(rule: Rule): boolean {
  if (rule.anchor?.iframe || rule.anchor?.witness) return false;
  return !(rule.mutations || []).some((m) =>
    m?.kind === 'mount-route' || m?.kind === 'redirect' || m?.kind === 'rewrite-response' || m?.kind === 'intercept');
}

/**
 * Did this previewed rule's anchor resolve nothing? Read off its statuses: the
 * freshest says 0 (the same `state.size === 0` the engine's own settle-delayed
 * `rule-no-match` reads) and none in this preview ever said more (a rule whose
 * element went away, a `remove`, did apply). No status yet is not a verdict.
 */
export function previewMatchedNothing({ rule, status, peakMatched }: PreviewedRule): boolean {
  return reportsDomMatches(rule) && status !== undefined && !status.matched && !(peakMatched && peakMatched > 0);
}

/**
 * A preview's `noMatch[]`. The engine reports `rule-no-match` from a timer
 * 1.5 s after the rule is set up, and a page the user isn't looking at runs
 * that timer late (Chromium throttles a hidden page's timers), so the event
 * can miss the host's settle window while the rule's status already says it
 * matched 0. Both count, once per rule:
 *   - every `reported` entry, unless that rule's freshest status shows it
 *     matching now (it rendered after the engine looked);
 *   - every previewed rule that matched nothing (previewMatchedNothing),
 *     unless the engine quarantined it (that answer belongs to
 *     `quarantined`, not here).
 */
export function previewNoMatch(
  reported: readonly NoMatchEntry[],
  previewed: readonly PreviewedRule[],
  quarantinedRuleIds: ReadonlySet<string> = new Set(),
): NoMatchEntry[] {
  const byId = new Map<string, PreviewedRule>();
  for (const p of previewed) byId.set(p.rule.id, p);
  const out: NoMatchEntry[] = [];
  const seen = new Set<string | undefined>();
  for (const entry of reported) {
    if (seen.has(entry.ruleId)) continue;
    const p = entry.ruleId !== undefined ? byId.get(entry.ruleId) : undefined;
    if (p && !p.rule.anchor?.iframe && p.status?.matched) continue;
    seen.add(entry.ruleId);
    out.push(entry);
  }
  for (const p of previewed) {
    const id = p.rule.id;
    if (seen.has(id) || quarantinedRuleIds.has(id) || !previewMatchedNothing(p)) continue;
    seen.add(id);
    out.push({ ruleId: id, selector: p.rule.anchor?.primary?.value || '' });
  }
  return out;
}

/** What view_page's caption reads: the capture's url, size, and crop. */
export interface ViewPageCaptionInput {
  url?: string;
  sizeBytes?: number;
  croppedTo?: string;
  elementBox?: { w: number; h: number };
}

// view_page's caption for a shim session (a shim writes rules against a
// site). Pinned byte for byte by the browser's golden request snapshot.
export function shimViewPageCaption(result: ViewPageCaptionInput): string {
  return result.croppedTo
    ? `Cropped screenshot around \`${result.croppedTo}\`` +
      (result.elementBox ? ` (element measures ${result.elementBox.w}×${result.elementBox.h}px)` : '') +
      ` at ${result.url || 'current page'}, native resolution with context margin.` +
      ' Judge the visual result honestly — if it does not match the' +
      ' user\'s intent, fix the rule before ending the turn.'
    : `Screenshot of the visible viewport at ${result.url || 'current page'}` +
      (result.sizeBytes ? ` (${Math.round(result.sizeBytes / 1024)}KB).` : '.') +
      ' Use this to identify the user\'s target visually, then write the' +
      ' selector via query_page / inspect_element / the picker — not' +
      ' from pixel positions in this image.';
}
