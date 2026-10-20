// The rule-status reporter for an anchored rule: emits `rule-status` events to
// the inspector/authoring channel when the matched-anchor count, the resolving
// source, or the diagnostic `note` changes — plus the media/large-cover hide
// guard and the layout-kind precondition notes that ride that event. Factored
// out of applyRule; owns its own report-dedupe + large-cover state, reads the
// shared RuleRuntimeState (state map, matchedSource, relativeReorderNote) back.

import { reorderNote, reshapeNote } from './layout-kinds';
import { injectStripNotes } from './dispatch-mutation';
import type { RuleRuntimeState } from './rule-state';
import type { Rule, Spec } from './types';
import type { CoreApi } from './api';

export interface StatusReporter {
  // Measure viewport coverage BEFORE mountOn stamps display:none / detaches the
  // node — post-apply the box is 0x0 (see mediaHideKind's comment).
  noteLargeCoverAtMount(el: Element): void;
  reportStatusIfChanged(): void;
}

export function makeStatusReporter(rule: Rule, spec: Spec, api: CoreApi, rs: RuleRuntimeState): StatusReporter {
  // Apply-time precondition notes for the layout kinds: computed-style
  // checks whose failure means the compiled CSS silently does nothing (reorder
  // under a block parent, grid templates on a flex container). Joined into the
  // rule-status `note` so the authoring loop sees them mid-turn and
  // self-corrects. Diagnostics only — never behavior changes.
  const hasLayoutKind = (rule.mutations || []).some((m) => m.kind === 'reorder' || m.kind === 'reshape');
  // A hide/remove rule whose matched element IS the main media element
  // (<video>/<audio>) or is the single wrapper of one, or blankets most of
  // the viewport, silently
  // blanks the player — audio keeps playing, picture goes white. Live-caught: a
  // ".video-stream" hide meant for Shorts nuked YouTube's own player, and
  // nothing warned. Rides the rule-status `note` into authoring feedback
  // so the model self-corrects mid-turn; never changes runtime behavior.
  const hasHideOrRemoveKind = (rule.mutations || []).some((m) => m.kind === 'hide' || m.kind === 'remove');

  const layoutNote = (el: Element | undefined): string | null => {
    const notes: string[] = [];
    if (el && hasLayoutKind) {
      const win = el.ownerDocument.defaultView;
      if (win) {
        for (const mut of rule.mutations || []) {
          if (mut.kind === 'reorder') {
            const parent = el.parentElement;
            const n = reorderNote(parent ? win.getComputedStyle(parent).display : null);
            if (n) notes.push(n);
          } else if (mut.kind === 'reshape') {
            const n = reshapeNote(mut, win.getComputedStyle(el).display);
            if (n) notes.push(n);
          }
        }
      }
    }
    if (rs.relativeReorderNote) notes.push(rs.relativeReorderNote);
    const stripNote = injectStripNotes.get(`${spec.id}/${rule.id}`);
    if (stripNote) notes.push(stripNote);
    return notes.length ? notes.join('; ') : null;
  };

  // Media / large-cover guard (see hasHideOrRemoveKind above). Pure reads, fully
  // guarded — never throws. Rides the rule-status event as `mediaHide` so main
  // can persist a durable, browsing-time "hiding the video player" warning
  //; the human `note` below is derived from the same verdict.
  //
  // Two detectors, because the two signals have different physics:
  //  - MEDIA is layout-independent (matches/querySelector), so it's checked LIVE
  //    across EVERY matched element on each report. A selector resolving
  //    [harmless, <video>] still warns (not just the first match), and it
  //    self-clears the instant the media element leaves the matched set.
  //    CONTAINING media only counts for a single match — the player's own
  //    container. Among many matches (18 sponsored tiles, one with an
  //    autoplay preview) a media descendant is just one tile's content, not
  //    the page's player; live-caught on Amazon as a false warning.
  //  - COVER can only be read BEFORE `hide` stamps display:none — post-apply
  //    getBoundingClientRect() is 0x0 and `remove` has detached the node, so a
  //    large-container hide is invisible to a post-apply measurement. It's
  //    captured once at MOUNT time (noteLargeCoverAtMount, called before
  //    mountOn) into `sawLargeCover`, which is sticky: a hidden container stays
  //    hidden until teardown/re-apply builds a fresh closure. Accepted residual:
  //    a container removed from the DOM without a re-commit keeps the cover
  //    warning until the next reload — a hidden thing doesn't un-hide itself.
  const MEDIA_COVER_FRACTION = 0.55;
  const isMedia = (el: Element): boolean => {
    try { return typeof el.matches === 'function' && el.matches('video, audio'); } catch { return false; }
  };
  const containsMedia = (el: Element): boolean => {
    try { return typeof el.querySelector === 'function' && el.querySelector('video, audio') !== null; } catch { return false; }
  };
  const isMediaEl = (el: Element): boolean => isMedia(el) || containsMedia(el);
  let sawLargeCover = false;
  const noteLargeCoverAtMount = (el: Element): void => {
    if (!hasHideOrRemoveKind || sawLargeCover || isMedia(el)) return;
    try {
      const win = el.ownerDocument?.defaultView;
      const r = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      if (win && r && win.innerWidth > 0 && win.innerHeight > 0
        && (r.width * r.height) / (win.innerWidth * win.innerHeight) >= MEDIA_COVER_FRACTION) {
        sawLargeCover = true;
      }
    } catch { /* box / viewport read failed — no cover verdict */ }
  };
  const mediaHideKind = (): 'media' | 'cover' | null => {
    if (!hasHideOrRemoveKind) return null;
    const single = rs.state.size === 1;
    for (const el of rs.state.keys()) { if (single ? isMediaEl(el) : isMedia(el)) return 'media'; }
    return sawLargeCover ? 'cover' : null;
  };
  const mediaHideNote = (kind: 'media' | 'cover' | null): string | null => {
    if (kind === 'media') {
      return 'this hide/remove targets the main media element (<video>/<audio>) — it blanks the '
        + 'player while audio may keep playing; if you meant something else, use a more specific anchor';
    }
    if (kind === 'cover') {
      return 'this hide/remove covers most of the viewport — if you meant to hide a specific '
        + 'region, anchor on it instead of a full-page container';
    }
    return null;
  };

  // We only emit when the current anchor count changes (transitioned from N → M,
  // where N ≠ M), not on every scan — most scans are no-ops because the DOM
  // churns around the rule's anchor without affecting it. `lastReportedCount`
  // starts at -1 so the first scan always emits, even if it resolves 0 anchors
  // (the inspector wants to know "rule is mounted but not yet matching" which is
  // distinct from "rule hasn't run"). `matchedVia` is tracked separately because
  // a rule can keep its match count steady while sliding from primary to a
  // fallback.
  let lastReportedCount = -1;
  let lastReportedSource: string | null = '__unset__';
  let lastReportedNote: string | null = null;
  const reportStatusIfChanged = () => {
    const first: Element | undefined = rs.state.size ? rs.state.keys().next().value : undefined;
    const mediaHide = mediaHideKind();
    const note = [layoutNote(first), mediaHideNote(mediaHide)]
      .filter((n): n is string => Boolean(n)).join('; ') || null;
    if (rs.state.size === lastReportedCount && rs.matchedSource === lastReportedSource
      && note === lastReportedNote) return;
    lastReportedCount = rs.state.size;
    lastReportedSource = rs.matchedSource;
    lastReportedNote = note;
    if (typeof api.reportEvent !== 'function') return;
    // Measured box of the first matched anchor (viewport CSS px, post-apply —
    // tier-1 stamps land synchronously in mountOn, and mountOn's .finally
    // re-report runs after handler mounts too). This is the deterministic half
    // of authoring-time visual verification: "make X the same size as Y" is a
    // numbers problem, and the authoring feedback loop reads this straight out
    // of the rule-status event instead of eyeballing a screenshot. Zero matches
    // → no box. Multi-match → the first VISIBLE match's box plus a `visible`
    // count: the first DOM-order match is often hidden (by the site, or by this
    // very rule), and its 0×0 box told the agent nothing — live-caught on
    // Amazon. With nothing visible the box stays the first match's.
    let box: { x: number; y: number; w: number; h: number } | undefined;
    let visible: number | undefined;
    if (first) {
      const toBox = (r: DOMRect) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      box = toBox(first.getBoundingClientRect());
      if (rs.state.size > 1) {
        visible = 0;
        let firstVisible: typeof box | undefined;
        for (const el of rs.state.keys()) {
          const b = toBox(el.getBoundingClientRect());
          if (b.w > 0 && b.h > 0) { visible++; firstVisible ??= b; }
        }
        if (firstVisible) box = firstVisible;
      }
    }
    api.reportEvent('rule-status', {
      specId: spec.id,
      ruleId: rule.id,
      matched: rs.state.size,
      matchedVia: rs.matchedSource,
      ...(box ? { box } : {}),
      ...(visible !== undefined ? { visible } : {}),
      ...(note ? { note } : {}),
      // Structured twin of the media half of `note` — main persists it as a
      // durable browsing-time "hiding the video player" warning. Absent
      // when the matched element is neither media nor a viewport-blanketing
      // cover; its ABSENCE on a later rule-status self-clears any prior row.
      ...(mediaHide ? { mediaHide } : {}),
    });
  };

  return { noteLargeCoverAtMount, reportStatusIfChanged };
}
