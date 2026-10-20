// Set witnesses — the verification layer for a rule whose anchor matches
// several elements (a result list, every nameplate in a thread).
//
// One element witness can't describe N different elements: members are
// content (a product tile's ASIN and title differ from its neighbour's). A set
// witness instead fingerprints what EVERY observed member shares — the tag,
// constant attributes, attribute names, child shape, parent tag, a common text
// prefix — and filters each match at resolve time against that ("is this still
// one of the things I meant"). Its first job is the per-member veto; its
// second is making a break visible (quarantine instead of a silent no-match).
//
// Design constraints, as for witness.ts:
//   - Pure. Members are read through snapshots (snapshotMember) taken before
//     the engine mutates them, and aggregation (buildSetWitness) reads only
//     snapshots — never the mutated DOM. Everything works on anything
//     element-shaped, so it runs in bare node (set-witness-harness).
//   - Bounded. Text is a prefix walk that stops at TEXT_STEM_LEN normalized
//     characters (never `textContent` of a comment tree); attribute values
//     are capped; at most MAX_SET_MEMBERS members are aggregated.
//   - DOM only. No layout, no visibility: both are layout-dependent and our
//     own `hide` zeroes them.
//   - Shim-owned DOM is invisible. Capture and verification both skip
//     children and text inside DOM the engine created, so a mount can't change
//     the member's own fingerprint.

import type { SetWitness } from './types';

export const SET_WITNESS_VERSION = 1;

// More observed members than this and no set witness is captured: the
// aggregate is too costly to keep and too broad to mean anything.
export const MAX_SET_MEMBERS = 1000;

const WEIGHTS = {
  attr: 3, // per constant attribute value
  attrNamesMax: 3, // attrNames total, split evenly across the names
  textStem: 2,
  childTags: 1,
  parentTag: 1,
};

export const SET_PASS_THRESHOLD = 0.5;

const TEXT_STEM_LEN = 40;
// A common text prefix shorter than this isn't identity (two different
// labels share a few letters by chance).
const STEM_SHARED_PREFIX_MIN = 12;
// The text walk reads at most this much raw text and visits at most this many
// nodes, whatever the normalized length (a subtree of whitespace and digits).
const TEXT_WALK_MAX_RAW = 2000;
const TEXT_WALK_MAX_NODES = 400;
// An attribute value longer than this is never a constant (it's content, or
// serialized state); its name still counts toward attrNames.
const MAX_ATTR_VALUE_LEN = 200;
const CHILD_TAGS_MAX = 8;

const SKIP_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

/** Whether a node is DOM the engine created (own-dom.ts), supplied by the caller. */
export type OwnedPredicate = (node: Element) => boolean;
const notOwned: OwnedPredicate = () => false;

/** One member's signals, read before the engine mutates it. */
export interface SetMemberSnapshot {
  tag: string;
  // Every attribute that can carry identity (not class / style / on* /
  // data-shim*), value capped: over-long values are kept as null.
  attrs: Record<string, string | null>;
  childTags: string[];
  parentTag: string | null;
  textStem: string;
}

// Attributes worth comparing at all. class churns per build, style is
// layout, on* is behaviour, data-shim* is our own stamp (it differs between a
// preview and a committed load).
function isComparableAttr(name: string): boolean {
  if (name === 'class' || name === 'style') return false;
  if (name.startsWith('on')) return false;
  if (name.startsWith('data-shim')) return false;
  return true;
}

// Attributes whose constant VALUE is identity: role, aria-label, site data-*.
// Never id: an id shared by every member is a site bug, and a unique one is
// content.
function isStableValueAttr(name: string): boolean {
  return name === 'role' || name === 'aria-label' || (name.startsWith('data-') && !name.startsWith('data-shim'));
}

function normalizeStemText(s: string): string {
  return s.toLowerCase().replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
}

function sharedPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

interface WalkNode {
  nodeType?: number;
  data?: string;
  nodeValue?: string | null;
  tagName?: string;
  childNodes?: ArrayLike<WalkNode>;
}

// The first TEXT_STEM_LEN normalized characters of an element's text, read
// in document order and stopping as soon as that many are in hand. Skips
// script / style / template / noscript subtrees and shim-owned subtrees.
export function textStemPrefix(el: Element, isOwned: OwnedPredicate = notOwned): string {
  let raw = '';
  let visited = 0;
  let done = false;
  const walk = (node: WalkNode): void => {
    if (done) return;
    if (++visited > TEXT_WALK_MAX_NODES) { done = true; return; }
    if (node.nodeType === 3) {
      // Never read past the raw budget, even inside one huge text node.
      const piece = node.data ?? node.nodeValue ?? '';
      raw += piece.slice(0, TEXT_WALK_MAX_RAW - raw.length);
      if (raw.length >= TEXT_WALK_MAX_RAW || normalizeStemText(raw).length >= TEXT_STEM_LEN) done = true;
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.tagName && SKIP_TEXT_TAGS.has(node.tagName.toUpperCase())) return;
    if (node !== (el as unknown as WalkNode) && isOwned(node as unknown as Element)) return;
    const kids = node.childNodes;
    if (!kids) return;
    for (let i = 0; i < kids.length && !done; i++) {
      const kid = kids[i];
      if (kid) walk(kid);
    }
  };
  walk(el as unknown as WalkNode);
  return normalizeStemText(raw).slice(0, TEXT_STEM_LEN);
}

function childTagsOf(el: Element, isOwned: OwnedPredicate): string[] {
  const tags: string[] = [];
  for (const child of Array.from(el.children || [])) {
    if (!child.tagName || isOwned(child)) continue;
    tags.push(child.tagName.toLowerCase());
    if (tags.length >= CHILD_TAGS_MAX) break;
  }
  return tags;
}

/** Read one member's signals. Bounded; never mutates. */
export function snapshotMember(el: Element, isOwned: OwnedPredicate = notOwned): SetMemberSnapshot {
  const attrs: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  for (const attr of Array.from(el.attributes || [])) {
    if (!isComparableAttr(attr.name)) continue;
    attrs[attr.name] = attr.value.length > MAX_ATTR_VALUE_LEN ? null : attr.value;
  }
  return {
    tag: (el.tagName || '').toLowerCase(),
    attrs,
    childTags: childTagsOf(el, isOwned),
    parentTag: el.parentElement?.tagName ? el.parentElement.tagName.toLowerCase() : null,
    textStem: textStemPrefix(el, isOwned),
  };
}

export type BuildSetWitnessResult =
  | { ok: true; setWitness: SetWitness }
  | { ok: false; reason: 'too-few' | 'mixed-tags' | 'too-many' };

/**
 * Aggregate member snapshots into a set witness. Needs ≥2 members (one member
 * is not a set: fingerprinting it would overfit to that member's content), at
 * most MAX_SET_MEMBERS, and one tag across all of them.
 */
export function buildSetWitness(snapshots: readonly SetMemberSnapshot[], opts: { nested: boolean }): BuildSetWitnessResult {
  const n = snapshots.length;
  if (n < 2) return { ok: false, reason: 'too-few' };
  if (n > MAX_SET_MEMBERS) return { ok: false, reason: 'too-many' };
  const first = snapshots[0];
  if (!first || !first.tag) return { ok: false, reason: 'mixed-tags' };
  for (const s of snapshots) if (s.tag !== first.tag) return { ok: false, reason: 'mixed-tags' };

  // Constant stable values.
  const attrs: Record<string, string> = {};
  for (const [name, value] of Object.entries(first.attrs)) {
    if (!isStableValueAttr(name) || value === null) continue;
    if (snapshots.every((s) => Object.hasOwn(s.attrs, name) && s.attrs[name] === value)) attrs[name] = value;
  }
  // Names on every member, minus the ones already constant.
  const attrNames: string[] = [];
  for (const name of Object.keys(first.attrs)) {
    if (Object.hasOwn(attrs, name)) continue;
    if (snapshots.every((s) => Object.hasOwn(s.attrs, name))) attrNames.push(name);
  }
  attrNames.sort();
  // Multiset intersection of child tags.
  let childTags = [...first.childTags];
  for (const s of snapshots) {
    const pool = [...s.childTags];
    const kept: string[] = [];
    for (const t of childTags) {
      const i = pool.indexOf(t);
      if (i >= 0) { kept.push(t); pool.splice(i, 1); }
    }
    childTags = kept;
    if (!childTags.length) break;
  }
  const parentTag = first.parentTag && snapshots.every((s) => s.parentTag === first.parentTag) ? first.parentTag : null;
  // A common text prefix of meaningful length.
  let stem = first.textStem;
  for (const s of snapshots) {
    stem = stem.slice(0, sharedPrefixLen(stem, s.textStem));
    if (stem.length < STEM_SHARED_PREFIX_MIN) break;
  }

  const setWitness: SetWitness = { v: SET_WITNESS_VERSION, tag: first.tag, count: n, nested: opts.nested };
  if (Object.keys(attrs).length) setWitness.attrs = attrs;
  if (attrNames.length) setWitness.attrNames = attrNames;
  if (childTags.length) setWitness.childTags = childTags;
  if (parentTag) setWitness.parentTag = parentTag;
  if (stem.length >= STEM_SHARED_PREFIX_MIN) setWitness.textStem = stem;
  return { ok: true, setWitness };
}

export interface SetMatchResult {
  pass: boolean;
  score: number;
  detail: string[];
}

/**
 * Score one member snapshot against a set witness. Unknown versions pass (an
 * older engine meeting a newer witness must not reject healthy members); the
 * tag is a hard gate; score = matched / total weight over the signals the
 * witness carries; pass at SET_PASS_THRESHOLD. No lenient-text rescue.
 */
export function matchSetSnapshot(sw: SetWitness, snap: SetMemberSnapshot): SetMatchResult {
  if (sw.v !== SET_WITNESS_VERSION) return { pass: true, score: 1, detail: ['set witness of unknown version — skipped'] };
  if (snap.tag !== sw.tag) {
    return { pass: false, score: 0, detail: [`tag mismatch: expected <${sw.tag}>, saw <${snap.tag || 'none'}>`] };
  }
  let total = 0;
  let matched = 0;
  const detail: string[] = [];
  for (const [name, expected] of Object.entries(sw.attrs || {})) {
    total += WEIGHTS.attr;
    const actual = Object.hasOwn(snap.attrs, name) ? snap.attrs[name] : undefined;
    if (actual === expected) matched += WEIGHTS.attr;
    else detail.push(`attr ${name}: expected ${JSON.stringify(expected)}, saw ${actual === undefined ? 'none' : JSON.stringify(actual)}`);
  }
  const names = sw.attrNames || [];
  if (names.length) {
    const share = Math.min(WEIGHTS.attrNamesMax, names.length) / names.length;
    const missing: string[] = [];
    for (const name of names) {
      total += share;
      if (Object.hasOwn(snap.attrs, name)) matched += share;
      else missing.push(name);
    }
    if (missing.length) detail.push(`attributes missing: ${missing.join(', ')}`);
  }
  if (sw.textStem) {
    total += WEIGHTS.textStem;
    const shared = sharedPrefixLen(snap.textStem, sw.textStem);
    if (snap.textStem && (shared === Math.min(snap.textStem.length, sw.textStem.length) || shared >= STEM_SHARED_PREFIX_MIN)) {
      matched += WEIGHTS.textStem;
    } else {
      detail.push(`text: expected "${sw.textStem}…", saw "${snap.textStem ? snap.textStem + '…' : '(empty)'}"`);
    }
  }
  if (sw.childTags && sw.childTags.length) {
    total += WEIGHTS.childTags;
    const pool = [...snap.childTags];
    let overlap = 0;
    for (const t of sw.childTags) {
      const i = pool.indexOf(t);
      if (i >= 0) { overlap++; pool.splice(i, 1); }
    }
    if (overlap * 2 >= sw.childTags.length) matched += WEIGHTS.childTags;
    else detail.push(`children: expected [${sw.childTags.join(', ')}], saw [${snap.childTags.join(', ')}]`);
  }
  if (sw.parentTag) {
    total += WEIGHTS.parentTag;
    if (snap.parentTag === sw.parentTag) matched += WEIGHTS.parentTag;
    else detail.push(`parent: expected <${sw.parentTag}>, saw <${snap.parentTag || 'none'}>`);
  }
  if (total === 0) return { pass: true, score: 1, detail: [] };
  const score = matched / total;
  return { pass: score >= SET_PASS_THRESHOLD, score, detail };
}

/** Score a live element against a set witness (snapshots it first, bounded). */
export function matchSetWitness(sw: SetWitness | null | undefined, el: Element | null | undefined, isOwned: OwnedPredicate = notOwned): SetMatchResult {
  if (!sw || sw.v !== SET_WITNESS_VERSION) return { pass: true, score: 1, detail: ['set witness missing or unknown version — skipped'] };
  if (!el || !el.tagName) return { pass: false, score: 0, detail: ['no element'] };
  return matchSetSnapshot(sw, snapshotMember(el, isOwned));
}

// --- Identity predicate (D8) -------------------------------------------------
//
// The constant site data-* values of a set, plus its tag, as one CSS selector:
// `div[data-component-type="s-search-result"]`. The recovery query after a
// deploy kills the authored selector. Only values that carry identity count:
// non-empty, not boolean-like, not purely numeric (`data-index="2"` is a
// position, and a set whose members all say "2" is a coincidence).

const BOOLEAN_LIKE = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', 'undefined']);
// Names that are valid unescaped CSS identifiers only (no `.` or `:`, which a
// selector would read as a class or pseudo-class): anything else is left out.
const SAFE_ATTR_NAME = /^data-[a-z0-9_-]+$/i;

function isIdentityValue(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (BOOLEAN_LIKE.has(v.toLowerCase())) return false;
  if (/^[-+]?\d+(\.\d+)?$/.test(v)) return false;
  return true;
}

function cssString(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ').replace(/\r/g, '\\d ')}"`;
}

/** The set's identity-predicate selector, or null when it has none. */
export function identityPredicateFor(sw: SetWitness): string | null {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(sw.attrs || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!name.startsWith('data-') || name.startsWith('data-shim')) continue;
    if (!SAFE_ATTR_NAME.test(name) || !isIdentityValue(value)) continue;
    parts.push(`[${name}=${cssString(value)}]`);
  }
  if (!parts.length || !/^[a-z][a-z0-9-]*$/.test(sw.tag)) return null;
  return `${sw.tag}${parts.join('')}`;
}

/**
 * The recovery-equivalence check: the identity predicate is stored only when
 * its complete result (own DOM excluded) equals the anchor's complete result,
 * member for member. An author's deliberately narrower selector
 * (`.organic [data-kind="product"]` beside sponsored tiles sharing the same
 * data-*) fails it, so recovery can never broaden the rule.
 */
export function identityEquivalent(predicateResult: readonly Element[], anchorResult: readonly Element[]): boolean {
  if (predicateResult.length !== anchorResult.length) return false;
  const members = new Set(anchorResult);
  return predicateResult.every((el) => members.has(el));
}

/** Whether any member contains another (a nested comment tree). */
export function membersNested(members: readonly Element[]): boolean {
  if (members.length < 2) return false;
  const set = new Set(members);
  for (const el of members) {
    let p = el.parentElement;
    while (p) {
      if (set.has(p)) return true;
      p = p.parentElement;
    }
  }
  return false;
}
