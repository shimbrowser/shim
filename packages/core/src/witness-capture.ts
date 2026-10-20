// Witness capture for one rule lifecycle: decides which fingerprint the rule
// gets from what the preview OBSERVED, and reports it as `rule-witness`
// events (capture-event.ts describes how hosts read them).
//
//   - Every member a scan resolves is snapshotted the first time it is seen,
//     BEFORE the engine mounts anything on it (apply-rule calls observe()
//     ahead of its mount loop), so aggregation never reads mutated DOM.
//   - One member observed → an element witness (witness.ts), enriched with
//     component identity inside a bounded wait (witness-enrich.ts). An
//     authored `cardinality: 'many'` never gets one: it reports "none" with
//     the note `one-member` instead.
//   - Two or more → a set witness over every observed member (set-witness.ts),
//     re-emitted whenever the aggregate changes (frame-coalesced). It
//     supersedes an earlier element witness and cancels a pending one. A set
//     that can't be fingerprinted — mixed tags, more than MAX_SET_MEMBERS, a
//     rule with a `remove` mutation (its own success empties the resolution)
//     — reports "none" with the reason, withdrawing anything reported before.
//   - The identity predicate is kept only while its complete result equals
//     the anchor's (identityEquivalent).
//
// Each event replaces the whole managed state ({ witness, setWitness }) and
// carries { documentId, anchorDigest, rev }; `rev` is minted when the work is
// scheduled. A rule that already carries a fingerprint captures nothing.

import * as witnessMod from './witness';
import {
  snapshotMember, buildSetWitness, identityPredicateFor, identityEquivalent, membersNested, MAX_SET_MEMBERS,
} from './set-witness';
import type { SetMemberSnapshot, OwnedPredicate } from './set-witness';
import { enrichWitness } from './witness-enrich';
import { fingerprintKind, anchorDigest, stableStringify } from './managed-anchor';
import type { CaptureNote } from './capture-event';
import type { CoreApi } from './api';
import type { Rule, Witness, SetWitness } from './types';

// One id per document the engine runs in (the engine loads once per
// document), so a host can tell a capture from a replaced document apart.
const DOCUMENT_ID = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let lastRev = 0;
// Strictly increasing within this document, across every rule.
function mintRev(): number {
  lastRev += 1;
  return lastRev;
}

export function captureDocumentId(): string {
  return DOCUMENT_ID;
}

interface CaptureState {
  witness: Witness | null;
  setWitness: SetWitness | null;
  note: CaptureNote | null;
}

export interface CaptureDeps {
  isOwned: OwnedPredicate;
  /** Schedule `run` on the next frame; returns a cancel. */
  schedule(run: () => void): () => void;
  /** Every element matching a CSS selector in the document (the identity predicate's complete query). */
  queryAll(selector: string): Element[];
}

export interface CaptureController {
  /**
   * Called by each scan with its verified, own-DOM-filtered matches, before
   * anything is mounted on them.
   */
  observe(nodes: readonly Element[]): void;
  /** Stop: cancel pending work, emit nothing more. */
  stop(): void;
}

const NOOP: CaptureController = { observe() {}, stop() {} };

export function makeCaptureController(rule: Rule, specId: string, api: CoreApi, deps: CaptureDeps): CaptureController {
  const anchor = rule.anchor;
  if (!anchor || anchor.iframe || fingerprintKind(anchor) !== 'none' || typeof api.reportEvent !== 'function') return NOOP;
  const many = anchor.cardinality === 'many';
  const removes = (rule.mutations || []).some((m) => m.kind === 'remove');
  const digest = anchorDigest(anchor);

  const observed = new Map<Element, SetMemberSnapshot>();
  let overflow = false;
  let nested = false;
  let latestResult: readonly Element[] = [];
  let maxConcurrent = 0;
  let lastEmitted: string | null = null; // stableStringify of the last state reported
  let elementScheduled = false;
  let elementRev = 0; // the rev of a pending element capture, 0 when none / cancelled
  let cancelFrame: (() => void) | null = null;
  let pendingRev = 0;
  let pendingKind: 'set' | 'one-member' = 'set';
  let stopped = false;

  const emit = (state: CaptureState, rev: number, extra: Record<string, unknown> = {}): void => {
    if (stopped) return;
    lastEmitted = stableStringify(state);
    api.reportEvent('rule-witness', {
      specId,
      ruleId: rule.id,
      witness: state.witness,
      setWitness: state.setWitness,
      documentId: DOCUMENT_ID,
      anchorDigest: digest,
      rev,
      ...(state.note ? { captureNote: state.note } : {}),
      ...extra,
    });
  };

  // The state the observed members call for, once ≥2 (or `many`) decide it.
  const setState = (): CaptureState => {
    if (removes) return { witness: null, setWitness: null, note: 'remove-rule' };
    if (overflow) return { witness: null, setWitness: null, note: 'too-many' };
    const built = buildSetWitness([...observed.values()], { nested });
    if (!built.ok) return { witness: null, setWitness: null, note: built.reason === 'too-many' ? 'too-many' : 'mixed-tags' };
    const sw = built.setWitness;
    const predicate = identityPredicateFor(sw);
    if (predicate) {
      let complete: Element[];
      try { complete = deps.queryAll(predicate).filter((el) => !deps.isOwned(el)); } catch { complete = []; }
      if (complete.length && identityEquivalent(complete, latestResult)) sw.identity = predicate;
    }
    return { witness: null, setWitness: sw, note: null };
  };

  // Frame-coalesced: the rev is minted now, the state read when it fires.
  const scheduleSet = (): void => {
    elementRev = 0; // a set decision cancels any pending element enrichment
    if (cancelFrame && pendingKind === 'set') return;
    if (cancelFrame) cancelFrame(); // a pending one-member note is moot now
    pendingKind = 'set';
    pendingRev = mintRev();
    const rev = pendingRev;
    cancelFrame = deps.schedule(() => {
      cancelFrame = null;
      const state = setState();
      if (stableStringify(state) !== lastEmitted) emit(state, rev);
    });
  };

  const scheduleElement = (el: Element): void => {
    elementScheduled = true;
    const w = witnessMod.buildWitness(el);
    if (!w) return;
    const rev = mintRev();
    elementRev = rev;
    // Document singletons (<html>/<head>/<body>) verify by tag alone
    // (witness.ts) and are never enriched: a component identity would
    // re-scope a page-level rule to the page type it was captured on.
    const enrichment = witnessMod.isDocumentSingletonTag(w.tag) ? Promise.resolve(w) : enrichWitness(el, w, api);
    // `legacyTextStem` rides the EVENT only (never the stored witness): the
    // textContent stem pre-visible-text witnesses were built with, so the auto
    // re-anchor's content check compares like with like. Sent only when it
    // differs from the visible stem.
    const legacyTextStem = witnessMod.legacyTextStemOf(el);
    void enrichment.then((enriched) => {
      // Superseded meanwhile (a second member showed up) or stopped.
      if (elementRev !== rev) return;
      elementRev = 0;
      emit({ witness: enriched, setWitness: null, note: null }, rev,
        legacyTextStem && legacyTextStem !== (enriched.textStem || '') ? { legacyTextStem } : {});
    });
  };

  return {
    observe(nodes) {
      if (stopped) return;
      const resultChanged = nodes.length !== latestResult.length || nodes.some((el, i) => latestResult[i] !== el);
      latestResult = nodes;
      maxConcurrent = Math.max(maxConcurrent, nodes.length);
      let added = false;
      for (const el of nodes) {
        if (observed.has(el)) continue;
        if (observed.size >= MAX_SET_MEMBERS) { overflow = true; break; }
        observed.set(el, snapshotMember(el, deps.isOwned));
        added = true;
      }
      if (added && !nested && observed.size > 1) nested = membersNested([...observed.keys()]);
      if (maxConcurrent === 0) return;
      // Cardinality is what the preview showed at once: a single element the
      // page re-rendered (old node gone, new one in) is still one element.
      if (maxConcurrent === 1) {
        if (many) {
          if (lastEmitted === null && !cancelFrame) {
            pendingKind = 'one-member';
            pendingRev = mintRev();
            const rev = pendingRev;
            cancelFrame = deps.schedule(() => {
              cancelFrame = null;
              if (maxConcurrent === 1) emit({ witness: null, setWitness: null, note: 'one-member' }, rev);
            });
          }
          return;
        }
        const [only] = nodes;
        if (!elementScheduled && only) scheduleElement(only);
        return;
      }
      // Two or more at once: the set aggregate (or its refusal) decides, and
      // only new members or a changed result can change it.
      if (added || resultChanged || overflow || lastEmitted === null) scheduleSet();
    },
    stop() {
      stopped = true;
      elementRev = 0;
      if (cancelFrame) { cancelFrame(); cancelFrame = null; }
    },
  };
}
