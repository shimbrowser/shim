// What a preview's evidence says about each rule and screenshot (both
// hosts return the same shape). The Shim browser's emit
// feedback and the headless session (@shimbrowser/mcp)
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
  // `rewrite-response` rules are anchorless (Tier-5) — their status
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
  // `intercept` rules are also anchorless (Tier-5) — status arrives
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
