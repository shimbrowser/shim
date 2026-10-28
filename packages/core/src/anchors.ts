// Anchor resolution. The engine asks `resolveAll(rule.anchor)` every scan;
// we walk `primary` and return whatever it resolves to (the rebase engine
// will later layer fallbacks + witness fingerprints on top).
//
// Today three kinds are supported:
//   - `css`        — raw CSS selector. `{ kind: "css", value: "[data-foo]" }`.
//   - `data-attr`  — single data-* attribute, optional value. Cleaner than
//                    a CSS selector when the LLM is targeting "this element
//                    because it's the data-testid='cart' one" — the intent
//                    is preserved in the spec, and a future ladder can
//                    weight strong-attr matches differently than a generic
//                    CSS selector.
//   - `aria`       — accessibility-tree match by role and/or aria-label;
//                    a role also matches a native element's implicit role
//                    (anchor-selector.ts).
//                    Often the most resilient anchor on framework-rewritten
//                    sites, because the a11y tree is the layer the site
//                    cares to keep stable.
//
// The new kinds are sugar over CSS attribute selectors today, but the kind
// metadata is what matters: the rebase engine will read `kind` to decide
// witness-fingerprint shape, fallback ordering, and quarantine reasons.

import * as witness from './witness';
import { matchSetWitness } from './set-witness';
import { errMessage } from './error';
import { isEngineInjected } from './inject-kinds';
import { NON_VISIBLE_TEXT_TAGS, visibleTextOf } from './visible-text';
import { ariaSelector, escapeAttrValue } from './anchor-selector';
import type { Anchor, AnchorSpec, Witness } from './types';

// A DOM-shaped element sufficient for anchor synthesis (suggestAnchorLadder
// / suggestAnchorFor and their helpers). Real DOM Elements satisfy this
// trivially — every member below is always present on a real Element — but
// it's declared with each member OPTIONAL on purpose: the bare-node
// harnesses (packages/core/test/anchor-synthesis-harness.ts, packages/core/test/witness-harness.ts)
// pass minimal duck-typed test doubles that don't implement the full DOM
// Element interface (no NamedNodeMap, no HTMLCollection, etc.), and the
// `el.method && …` / `!el.children || …` feature-detects sprinkled through
// this file exist specifically to tolerate that. Declaring the members
// optional keeps those checks genuine feature-detects rather than "this is
// always defined" (which real, required DOM types would force — see
// ScanRoot below for the same trade-off applied to scan roots).
interface AnchorElement {
  tagName: string;
  attributes?: Iterable<{ name: string; value: unknown }>;
  children?: ArrayLike<AnchorElement>;
  parentElement?: AnchorElement | null;
  textContent?: string | null;
  // `unknown`, not `string | null`: a real Element's getAttribute always
  // returns `string | null`, but the harnesses build their stub elements
  // through an untyped `attrs` object (packages/core/test/anchor-synthesis-harness.ts),
  // which loses string-ness on the way through `Object.entries` and infers
  // as `unknown`. `attrOf` below is the one place that narrows it back down.
  getAttribute?(name: string): unknown;
  querySelectorAll?(selectors: string): ArrayLike<AnchorElement>;
}

// Read a string attribute off an AnchorElement, tolerating both the
// missing-method and non-string-return cases (see AnchorElement.getAttribute
// above) the same way the file's existing `el.getAttribute && …` call sites
// always have: anything that isn't a real string reads as "absent".
function attrOf(el: AnchorElement, name: string): string | null {
  const v = el.getAttribute && el.getAttribute(name);
  return typeof v === 'string' ? v : null;
}

// A root sufficiently DOM-shaped to scan by tag name. getElementsByTagName
// is genuinely optional here — see the resolveOne 'text' case and
// witnessRecoverDetail below, both of which feature-detect it against a
// root that may be a bare-node harness stub lacking it.
type ScanRoot = { getElementsByTagName?(tag: string): ArrayLike<Element> };

// Resolve an anchor's primary spec; if it returns no matches, walk the
// optional `fallbacks` array in order and return the first one that does.
// Empty array (or no fallbacks field) keeps the prior behavior — one shot
// at primary, then nothing.
//
// Why this and not "merge all matches": a rule that mounted via a
// fallback should mount the SAME element across runs. If both primary
// and a fallback resolved on the same page, dedup-by-element would still
// be a hidden surprise the first time the site changes and primary stops
// matching. First-with-matches semantics keep the ladder predictable:
// authors order strongest → weakest, the strongest live one wins, ties
// only happen within the same level (which the resolver doesn't know
// about).
//
// Witness-fingerprint validation: when the anchor carries a
// `witness`, every rung's matches are filtered through it before being
// trusted — "primary resolved, but the matched element doesn't look like
// what we anchored to at commit time, fall through anyway." Anchors
// without a witness keep the original behavior: trusted whenever they
// return ≥1 match.
function resolveAll(anchor: Anchor, root: Document | Element = document): Element[] {
  return resolveAllWithSource(anchor, root).nodes;
}

// Best-scoring rejected candidate's detail, for the quarantine report —
// see the header comment on resolveAllWithSource for what this feeds.
interface RejectedSample {
  score: number;
  detail: string[];
  source: string;
}

// Same as resolveAll but tells the caller WHICH spec actually resolved —
// `'primary'`, `'fallback:0'`, `'fallback:1'`, ... or `null` if nothing
// matched. The engine surfaces this through the `rule-status` event so the
// inspector panel can show "via fallback[0]" when the primary is broken
// and a backup is carrying the rule. Without this, fallbacks would be
// silent magic — a rule "still works" but the user has no signal that
// the primary they wrote is now wrong.
//
// Witness semantics: the witness describes the TARGET ELEMENT, not any
// particular selector, so every rung verifies against the same witness.
// A rung that resolves nodes but has them ALL witness-rejected is
// treated as not-resolved (fall through), and the result carries
// `witnessRejected: true` so the engine can tell "selector dead"
// (rule-no-match) apart from "selector found something that isn't the
// thing" — the quarantine signal. `rejectedSample` carries the best-
// scoring rejected candidate's detail for the quarantine report.
// Set witnesses (set-witness.ts): a rule whose anchor carries a set witness
// and no element witness has EVERY match scored per member against it —
// a member that doesn't verify is dropped, and a rung whose matches all fail
// falls through exactly as for an element witness. An anchor carrying both
// (conflicted: an older engine attached an element witness next to the set
// one) filters with the element witness. `opts.isOwned` keeps shim-owned
// descendants (a mount's own output) out of a member's signals.
interface ResolveOptions {
  isOwned?: (node: Element) => boolean;
}

function resolveAllWithSource(anchor: Anchor, root: Document | Element = document, opts: ResolveOptions = {}) {
  const primary = anchor?.primary;
  if (!primary) return { nodes: [] as Element[], source: null as string | null, witnessRejected: false };
  const w = anchor.witness || null;
  const sw = !w && anchor.setWitness ? anchor.setWitness : null;
  let witnessRejected = false;
  let rejectedSample: RejectedSample | null = null;

  const tryRung = (spec: AnchorSpec, source: string) => {
    const found = resolveOne(spec, root);
    if (found.length === 0) return null;
    if (sw) {
      const members: Element[] = [];
      for (const el of found) {
        const verdict = matchSetWitness(sw, el, opts.isOwned);
        if (verdict.pass) members.push(el);
        else if (!rejectedSample || verdict.score > rejectedSample.score) {
          rejectedSample = { score: verdict.score, detail: verdict.detail, source };
        }
      }
      if (members.length === 0) {
        witnessRejected = true;
        return null;
      }
      return { nodes: members, source, witnessRejected: false };
    }
    if (!w) return { nodes: found, source, witnessRejected: false };
    // Volatile-text leniency (witness.ts MatchWitnessOptions): when a
    // NON-text rung resolves exactly one element, the selector itself
    // carries the identity claim and the element's text is content, not
    // identity — a stem-only witness mismatch is tolerated. Live-caught:
    // a player-bar title rule whose text IS the currently playing track
    // quarantined into an LLM re-anchor loop on every app launch. text-kind
    // rungs stay strict (their text IS the identity), as do multi-match
    // rungs (the stem discriminates candidates) and the recovery scans
    // below (they call matchWitness without opts).
    const lenientText = spec.kind !== 'text' && found.length === 1;
    const passing: Element[] = [];
    for (const el of found) {
      const verdict = witness.matchWitness(w, el, { lenientText });
      if (verdict.pass) {
        passing.push(el);
      } else if (!rejectedSample || verdict.score > rejectedSample.score) {
        rejectedSample = { score: verdict.score, detail: verdict.detail, source };
      }
    }
    if (passing.length === 0) {
      witnessRejected = true;
      return null;
    }
    return { nodes: passing, source, witnessRejected: false };
  };

  const head = tryRung(primary, 'primary');
  if (head) return head;
  const fallbacks = Array.isArray(anchor.fallbacks) ? anchor.fallbacks : [];
  for (const [i, fb] of fallbacks.entries()) {
    const next = tryRung(fb, `fallback:${i}`);
    if (next) return next;
  }
  return { nodes: [] as Element[], source: null as string | null, witnessRejected, rejectedSample };
}

function resolveOne(spec: AnchorSpec, root: Document | Element): Element[] {
  switch (spec.kind) {
    case 'css':
      if (typeof spec.value !== 'string' || !spec.value.trim()) return [];
      try {
        return Array.from(root.querySelectorAll(spec.value));
      } catch (err) {
        console.warn(`[shim] invalid css selector "${spec.value}":`, errMessage(err));
        return [];
      }

    case 'data-attr': {
      // Accept both "testid" and "data-testid"; LLMs sometimes write one,
      // sometimes the other. Normalise to the full attr name once.
      let name = typeof spec.name === 'string' ? spec.name.trim() : '';
      if (!name) {
        console.warn('[shim] data-attr anchor missing `name`');
        return [];
      }
      if (!name.startsWith('data-')) name = 'data-' + name;
      // Attr names that aren't valid CSS identifiers (e.g. contain `:`)
      // would break the selector. data-* names are typically all-ASCII
      // kebab-case, so this is conservative — refuse exotic names rather
      // than escape creatively.
      if (!/^[a-zA-Z][\w-]*$/.test(name)) {
        console.warn(`[shim] data-attr anchor has unsupported attr name "${name}"`);
        return [];
      }
      const sel = spec.value !== undefined && spec.value !== null
        ? `[${name}="${escapeAttrValue(String(spec.value))}"]`
        : `[${name}]`;
      try {
        return Array.from(root.querySelectorAll(sel));
      } catch (err) {
        console.warn(`[shim] data-attr resolve failed for "${sel}":`, errMessage(err));
        return [];
      }
    }

    case 'text': {
      // `{ kind: "text", value: "Save changes", match?: "exact" | "contains" }`
      // Match by visible text content. "exact" (default) compares trimmed,
      // whitespace-normalized textContent for equality; "contains" looks
      // for `value` as a substring. Both are CASE-INSENSITIVE: sites restyle
      // casing freely (CSS text-transform, copy edits), and the authoring
      // model sees case-normalized witness stems in quarantine context —
      // live-caught: an AI re-anchor to "Forgot password?" matched 0 because
      // the page said "Forgot Password?". Case carries no identity here.
      //
      // Deepest-matcher semantics: a `<button>Save</button>` inside `<div>`
      // has BOTH the button and the div with `textContent === "Save"`. We
      // want the button. Filter to elements whose textContent matches AND
      // no descendant's does — this picks the label-bearing leaf rather
      // than every wrapper above it.
      //
      // Capped at 10k element scan; pages bigger than that won't resolve
      // by text. In practice button/link labels live near interactive
      // landmarks well within that cap.
      const value = typeof spec.value === 'string' ? spec.value.trim() : '';
      if (!value) {
        console.warn('[shim] text anchor missing `value`');
        return [];
      }
      const mode = spec.match === 'contains' ? 'contains' : 'exact';
      const norm = (s: string | null | undefined): string => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
      const target = norm(value);
      const test = mode === 'contains'
        ? (txt: string) => txt.includes(target)
        : (txt: string) => txt === target;

      // `root` is a real Document|Element here, whose getElementsByTagName
      // is always defined — but this feature-detect exists for parity with
      // bare-node harness roots that stand in for `root` at call sites one
      // level up (suggestAnchorLadder's verification pass). Widen through a
      // locally-typed view where the method is genuinely optional so the
      // ternary stays a real feature-detect instead of tripping "this
      // condition will always return true" (TS2774).
      const scanRoot: ScanRoot = root;
      const all = (scanRoot.getElementsByTagName
        ? scanRoot.getElementsByTagName('*')
        : root.querySelectorAll('*')) || [];
      const MAX_SCAN = 10000;
      const matched: Element[] = [];
      const matchedSet = new Set<Element>();
      for (const [i, el] of Array.from(all).entries()) {
        if (i >= MAX_SCAN) break;
        // Script/style/template elements are never anchors themselves, and
        // their text must not leak into ANCESTOR matching either — see
        // visibleTextOf (visible-text.ts) for the two live-caught failure modes. The
        // native-textContent containment check first is a cheap prefilter:
        // visible text is a subset of textContent, so a full-text miss is a
        // definitive miss (exact mode still needs containment here, not
        // equality — equality on full text would wrongly reject an element
        // whose visible label matches but which embeds a script). Only the
        // few survivors (ancestor chain + real matches) pay for the
        // visible-text walk.
        if (NON_VISIBLE_TEXT_TAGS.has((el.tagName || '').toUpperCase())) continue;
        if (!norm(el.textContent).includes(target)) continue;
        if (test(norm(visibleTextOf(el)))) {
          matched.push(el);
          matchedSet.add(el);
        }
      }
      if (!matched.length) return [];
      // Drop any element whose descendant is also in the set — keeps
      // only the deepest text-bearing matchers.
      return matched.filter((el) => {
        // Same feature-detect rationale as `scanRoot` above, at element
        // scope: widen to a view where querySelectorAll is optional.
        const scanEl: { querySelectorAll?(selectors: string): Iterable<Element> } = el;
        const descendants = scanEl.querySelectorAll ? scanEl.querySelectorAll('*') : [];
        for (const d of descendants) {
          if (matchedSet.has(d)) return false;
        }
        return true;
      });
    }

    case 'aria': {
      // Role and label ANDed; the role honors native elements' implicit
      // roles (anchor-selector.ts). At least one of role/label is required —
      // without either, an aria anchor has no signal and would silently match
      // every element on the page.
      const sel = ariaSelector(spec.role, spec.label);
      if (!sel) {
        console.warn('[shim] aria anchor needs at least `role` or `label`');
        return [];
      }
      try {
        return Array.from(root.querySelectorAll(sel));
      } catch (err) {
        console.warn(`[shim] aria resolve failed for "${sel}":`, errMessage(err));
        return [];
      }
    }

    default:
      console.warn(`[shim] unsupported anchor kind: ${(spec).kind}`);
      return [];
  }
}

// --- Auto-rebase support: synthesize a fresh anchor + find a drifted
// element by its witness. Used by the engine's rebase pass to re-point a rule
// whose primary selector died, deterministically (no LLM). ---

// `data-shim*` are Shim's own stamped tokens (ephemeral, apply-order-
// dependent) — never anchor to them (mirrors page-preload's picker exclusion
// and the witness module). A site `data-shimmer` would also be skipped; it
// still has tag/text/other signals.
function isSiteDataAttr(name: string): boolean {
  return name.startsWith('data-') && !name.startsWith('data-shim');
}

// Ranked ladder of stable anchor specs for an element, strongest first:
// id → site data-* → aria(role/label) → text → semantic class → ancestor-
// scoped → positional CSS path (true last resort). Mirrors the picker's
// `suggestAnchors` ranking, plus DOM verification: when a real document is
// available each candidate is resolved live, candidates that don't find the
// element are dropped, and candidates that find it UNIQUELY outrank stronger
// kinds that also match a crowd (a `data-testid` shared by 20 rows loses to
// a text anchor that finds exactly this one — the recover paths only ever
// re-point single-target rules, so uniqueness is the right tiebreak). The
// witness re-verifies whatever this produces, so even the positional tail is
// safe (a wrong-but-resolving anchor fails the witness and re-quarantines).
//
// Consumers: `suggestAnchorFor` (head of the ladder — a rebase's new
// `primary`) and the engine's recover paths, which commit the runner-up
// rungs as fresh fallbacks so the NEXT deploy has a ladder to promote from
// instead of a lone primary.
const LADDER_MAX = 4;

function suggestAnchorLadder(el: AnchorElement, root?: Document | Element): AnchorSpec[] {
  if (!el || !el.tagName) return [];
  const scope: Document | Element | null = root || (typeof document !== 'undefined' ? document : null);
  const verifiable = !!(scope && typeof scope.querySelectorAll === 'function');
  const tag = el.tagName.toLowerCase();

  const candidates: AnchorSpec[] = [];

  const id = attrOf(el, 'id');
  if (id && /^[A-Za-z][\w-]*$/.test(id)) {
    candidates.push({ kind: 'css', value: `#${id}` });
  }

  for (const attr of el.attributes || []) {
    if (isSiteDataAttr(attr.name) && /^[a-zA-Z][\w-]*$/.test(attr.name)) {
      candidates.push({ kind: 'data-attr', name: attr.name, value: String(attr.value) });
    }
  }

  const role = attrOf(el, 'role');
  const label = attrOf(el, 'aria-label');
  if ((role && role.trim()) || (label && label.trim())) {
    const a: AnchorSpec = { kind: 'aria' };
    if (role && role.trim()) a.role = role.trim();
    if (label && label.trim()) a.label = label.trim();
    candidates.push(a);
  }

  // Text rung. Label-like tags/roles as before, but ALSO leaf elements of
  // any tag — an attribute-poor `<div>Watchlist</div>` used to fall straight
  // through to a positional path even though its text is the most durable
  // signal it has. Deepest-matcher semantics make leaf-only safe: a wrapper
  // whose text lives in a child wouldn't resolve to itself anyway (the
  // verification pass below catches exactly that and drops the candidate).
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
  const labelLike = /^(button|a|label|h[1-6])$/.test(tag) ||
    role === 'button' || role === 'link';
  const leaf = !el.children || el.children.length === 0;
  if ((labelLike || leaf) && text && text.length <= 60 && !text.includes('\n')) {
    candidates.push({ kind: 'text', value: text });
  }

  // Semantic-class rung: human-named classes (`.login-form`, `.track-row`)
  // survive deploys that reshuffle siblings; generated ones (css-modules /
  // styled-components hashes) churn every build and are excluded.
  const stableClasses = stableClassesOf(el).slice(0, 2);
  if (stableClasses.length === 2) {
    candidates.push({ kind: 'css', value: `${tag}.${stableClasses[0]}.${stableClasses[1]}` });
  }
  if (stableClasses.length >= 1) {
    candidates.push({ kind: 'css', value: `${tag}.${stableClasses[0]}` });
  }

  // Ancestor-scoped rung: `#stable-ancestor tag[.class]` — often unique where
  // the bare tag/class isn't, and still structural-churn-proof above the
  // scope point. Only worth emitting when we can verify it (unverified it's
  // just a guess that would outrank the positional tail on nothing).
  if (verifiable) {
    const anc = stableAncestorSelector(el);
    if (anc) {
      const tail = stableClasses.length ? `${tag}.${stableClasses[0]}` : tag;
      candidates.push({ kind: 'css', value: `${anc} ${tail}` });
    }
  }

  // Verify + rank. Unverifiable scope (bare-node harness stubs): keep the
  // kind order as-is. Verifiable: drop candidates that don't resolve to this
  // element, then stable-partition unique-hitters ahead of crowd-matchers.
  let ranked: AnchorSpec[];
  if (!verifiable || !scope) {
    ranked = candidates;
  } else {
    const unique: AnchorSpec[] = [];
    const crowd: AnchorSpec[] = [];
    for (const spec of candidates) {
      let found: Element[];
      try {
        found = resolveOne(spec, scope);
      } catch (_) {
        continue;
      }
      // `el` is the caller's DOM-shaped element — a real Element in
      // production, a duck-typed test double in the bare-node harnesses.
      // `resolveOne` always hands back real DOM query results, so this is
      // an identity comparison only; safe regardless of which shape `el`
      // actually is at runtime.
      if (!found.includes(el as unknown as Element)) continue;
      (found.length === 1 ? unique : crowd).push(spec);
    }
    ranked = unique.concat(crowd);
  }

  // Positional path: always last (dropped only when the cap is already full
  // of stronger verified rungs) — the ladder must return SOMETHING for a
  // witness-recovered element even when it has no signal at all, and the
  // witness veto keeps a brittle tail from mis-attaching.
  ranked.push({ kind: 'css', value: positionalPath(el) });
  return ranked.slice(0, LADDER_MAX);
}

// Back-compat single-spec form — the strongest rung of the ladder.
function suggestAnchorFor(el: AnchorElement, root?: Document | Element): AnchorSpec | null {
  const [head] = suggestAnchorLadder(el, root);
  return head ?? null;
}

// Class tokens that look authored rather than generated by a build tool.
// Generated patterns excluded: css-in-js prefixes (`css-1a2b3c`), hash-y
// hex runs, long digit runs, css-modules `Block_elem__x7Kd2` suffixes,
// 1-2-letter+digit minified names (`x9`). BEM (`card__title`) and plain
// utilities survive the filter — a broad utility combo just loses the
// uniqueness ranking instead.
function looksGeneratedClass(cls: string): boolean {
  if (!/^[A-Za-z_][\w-]*$/.test(cls)) return true; // needs escaping → skip
  if (cls.length < 3) return true;
  if (/^(css|jss|jsx|sc|svelte|emotion|chakra)-/i.test(cls)) return true;
  if (/\d{3,}/.test(cls)) return true;
  if (/[0-9a-f]{6,}/i.test(cls)) return true;
  if (/^[A-Za-z]{1,2}\d/.test(cls)) return true;
  if (/__[\w-]*\d[\w-]*$/.test(cls)) return true;
  return false;
}

function stableClassesOf(el: AnchorElement): string[] {
  const raw = attrOf(el, 'class');
  if (!raw || typeof raw !== 'string') return [];
  return raw.trim().split(/\s+/).filter((c) => c && !looksGeneratedClass(c));
}

// Bare CSS-property-value class names used 1:1 as atomic/utility classes
// (Tailwind and similar systems: `class="flex items-center w-full"` — the
// class literally IS the display mode or a spacing value, not a name for
// what the element MEANS). `looksGeneratedClass` above deliberately leaves
// these alone — a real BEM/component class stays a useful (if weaker)
// anchor even shared broadly, and single-element authoring just loses the
// uniqueness ranking on a shared utility, which is harmless.
//
// This narrower check exists for exactly one caller: the Shim browser's "hide
// all like this" commits a MULTI-match anchor on purpose, with no witness
// and no pre-commit confirm — so a bare layout utility that also matches
// everything OTHER developers styled with the same class (`.flex` on a
// utility-CSS site can be most of the page) is not "all like this," it's
// "most of the page," and must not be committable.
//
// Two DIFFERENT confidence levels, not one flat denylist:
//
// - Bare keywords (`flex`, `hidden`, `relative`, …) are display/position
//   VALUES, not names — no real component is ever just called "flex" or
//   "hidden." These are rejected UNCONDITIONALLY, regardless of match count.
// - `prefix-value` pairs (`w-full`, `top-bar`, `order-summary`, …) are a
//   shape, not a vocabulary — `top`/`left`/`order`/`content`/`text`/`grid`/
//   `border`/`font` are all common English words that also show up as the
//   first half of a perfectly semantic class name (`.top-bar`, `.left-nav`,
//   `.order-summary`, `.content-wrapper`, `.grid-container`). Rejecting
//   those outright would silently degrade a correct "hide all like this"
//   down to "hide only this" — safe, but the user asked for all of them and
//   silently got one, with no explanation (the exact failure class this
//   whole feature exists to remove). So a `prefix-value` shape is rejected
//   only when the candidate is ALSO broad — a real `.top-bar` matches a
//   handful of times on a page (one header), while a class actually used as
//   a utility matches everywhere. `UTILITY_PREFIX_MATCH_THRESHOLD` is
//   chosen well below the absolute `GROUP_ANCHOR_MAX_MATCHES` cap
//   (the Shim browser's, 500) precisely so this catches the utility case
//   long before the absolute cap would. NOTE: these two numbers live in two
//   different files with no compile-time link between them — there is
//   nothing that fails to build if one changes without the other. The
//   invariant ("prefix threshold well below the absolute cap") is enforced
//   only by this comment and the harness fixtures in
//   packages/core/test/anchor-synthesis-harness.ts and the Shim browser's own; keep
//   them ordered by hand.
//
// Both are deliberately biased toward "reject" over "silently commit
// something too broad" — a false rejection here just falls through to a
// safer anchor (the Shim browser's `pickHideAnchor` degrade path), so
// erring toward "reject" (on the keyword side) costs nothing, and gating
// the prefix side on breadth is what keeps that bias from misfiring on
// genuinely narrow semantic names. Accepted gap: this is NOT an exhaustive
// Tailwind class dictionary — an unlisted BROAD utility outside both shapes
// (`truncate`, `uppercase`, `sr-only`, `container`) isn't caught by name at
// all; `GROUP_ANCHOR_MAX_MATCHES` is the backstop for those.
const UTILITY_CLASS_KEYWORDS = new Set([
  'flex', 'grid', 'block', 'inline', 'contents', 'table', 'hidden',
  'relative', 'absolute', 'fixed', 'sticky', 'static',
]);
const UTILITY_CLASS_PATTERN =
  /^(inline-(flex|grid|block)|flow-root|(w|h|min-w|min-h|max-w|max-h|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|top|left|right|bottom|inset|z|text|bg|border|rounded|items|justify|content|self|space-x|space-y|flex|grid|col|row|order|basis|grow|shrink|aspect|overflow|whitespace|break|cursor|font|leading|tracking|opacity|shadow|ring|outline|divide|translate|rotate|skew|scale|duration|ease|delay|transition|animate)-[\w.%/-]+)$/;
const UTILITY_PREFIX_MATCH_THRESHOLD = 20;

// Public predicate for "is this ONE class name a meaningful, committable
// group anchor at this match count." `cls` is a single class token (no
// leading `.`, no compound selectors); callers resolving a
// `{kind:'css', value:'.foo'}` candidate strip the leading `.` themselves.
// `matchCount` is the live count for THIS candidate (threaded through
// rather than a module-level global, since this is meant to be called once
// per candidate with that candidate's own count).
function isStableGroupClass(cls: string, matchCount: number): boolean {
  if (!cls || looksGeneratedClass(cls)) return false;
  if (UTILITY_CLASS_KEYWORDS.has(cls)) return false;
  if (UTILITY_CLASS_PATTERN.test(cls) && matchCount > UTILITY_PREFIX_MATCH_THRESHOLD) return false;
  return true;
}

// Nearest ancestor (within 5 levels) carrying an id or a site data-*
// attribute — a stable scope to hang a descendant selector off.
function stableAncestorSelector(el: AnchorElement): string | null {
  let cur: AnchorElement | null | undefined = el.parentElement;
  for (let depth = 0; cur && cur.tagName && depth < 5; depth++, cur = cur.parentElement) {
    const aid = attrOf(cur, 'id');
    if (aid && /^[A-Za-z][\w-]*$/.test(aid)) return `#${aid}`;
    for (const attr of cur.attributes || []) {
      if (isSiteDataAttr(attr.name) && /^[a-zA-Z][\w-]*$/.test(attr.name)) {
        const v = attr.value != null ? `="${escapeAttrValue(String(attr.value))}"` : '';
        return `[${attr.name}${v}]`;
      }
    }
  }
  return null;
}

function positionalPath(el: AnchorElement): string {
  const parts: string[] = [];
  let cur: AnchorElement | null | undefined = el;
  for (let depth = 0; cur && cur.tagName && depth < 3; depth++) {
    const curEl: AnchorElement = cur;
    const tag = curEl.tagName.toLowerCase();
    const cid = attrOf(curEl, 'id');
    if (cid && /^[A-Za-z][\w-]*$/.test(cid)) {
      parts.unshift(`#${cid}`);
      break; // an id'd ancestor is a stable enough root
    }
    const parent = curEl.parentElement;
    if (parent) {
      const sibs = Array.from(parent.children || []).filter((c) => c.tagName === curEl.tagName);
      const idx = sibs.indexOf(curEl) + 1;
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
    } else {
      parts.unshift(tag);
    }
    cur = parent;
  }
  return parts.join(' > ');
}

// Scan the page for the element a witness describes — used when a rule's
// selector(s) resolve nothing but the target may have just moved/renamed.
// Returns the single element that matches the witness *strongly and
// unambiguously*, else null. Guards that make a silent re-anchor safe: a bar a
// touch above resolve-time's 0.5 verification (margin against a coincidental
// match in the much larger scan pool — but low enough that real drift, like
// losing one stable attr while keeping another, still recovers), and DISJOINT
// strong candidates mean "ask the LLM/user", not "guess".
//
// NESTED strong candidates are a different story (live-caught: this veto sank
// every witness recovery on a real dashboard). textContent propagates upward,
// so a target's wrapper ancestors — and the grid parent when the target is its
// first child — score nearly as well as the target itself, purely by
// CONTAINING it. A same-tag containment chain of strong matches is therefore
// one finding, not genuine ambiguity: collapse it and take the best-scoring
// element (the real target outscores ancestors on parent/child shape); on a
// score tie prefer the DEEPER one — hiding too deep under-hides, hiding an
// ancestor can take out innocent siblings. Tuning point if recovery proves
// too eager or too shy.
const RECOVER_MIN_SCORE = 0.6;
const RECOVER_MAX_STRONG = 8;
// Stub-friendly containment (harness elements have parentElement, not
// .contains): is `b` inside `a`?
function containsNode(a: Element, b: Element): boolean {
  for (let n = b && b.parentElement; n; n = n.parentElement) {
    if (n === a) return true;
  }
  return false;
}

interface StrongMatch {
  el: Element;
  score: number;
}

// Detail-returning form: `{ el, reason }` where a null `el` carries WHY the
// scan refused — surfaced through the quarantine event/diagnostics so a
// failed recovery is debuggable after the fact (live-caught: a recovery
// failure escalated to an LLM turn and nothing recorded which veto fired).
function witnessRecoverDetail(w: Witness | null | undefined, root: ScanRoot | Document = document) {
  if (!w || !w.tag) return { el: null as Element | null, reason: 'no witness to scan with' as string | null };
  // A document singleton (<html>/<head>/<body>) witness verifies by tag alone,
  // so the scan would always "find" the one body — and re-pointing a selector
  // that deliberately scoped it (`body.home`) onto a page it never matched is a
  // mis-attach. Recovery has no evidence to offer here; decline.
  if (witness.isDocumentSingletonTag(w.tag)) {
    return { el: null as Element | null, reason: `document singleton <${w.tag}> witness carries no identity to recover with` as string | null };
  }
  // Feature-detect inline (rather than via an intermediate `scope` variable)
  // — TS's narrowing of an optional-vs-required method across a
  // `ScanRoot | Document` union doesn't survive being stashed in a variable
  // and dereferenced on a later line, so the guard and both call sites live
  // in the same expression. Same runtime behavior as `root.getElementsByTagName
  // ? root : document` — call on `root` when it has the method, else `document`.
  const candidates = root.getElementsByTagName ? root.getElementsByTagName(w.tag) : document.getElementsByTagName(w.tag);
  const strong: StrongMatch[] = [];
  for (const [i, el] of Array.from(candidates).entries()) {
    if (i >= 5000) break;
    // Engine-injected nodes (and their subtrees) are never recovery targets:
    // without this, a shim's own injected output can satisfy the witness
    // it's sitting next to and get silently re-anchored onto the engine's
    // own DOM. Skip BEFORE scoring so an injected node
    // can't count toward the ambiguity/uniqueness decisions below either.
    if (isEngineInjected(el)) continue;
    const verdict = witness.matchWitness(w, el);
    if (verdict.pass && verdict.score >= RECOVER_MIN_SCORE) {
      strong.push({ el, score: verdict.score });
      if (strong.length > RECOVER_MAX_STRONG) {
        // a page full of look-alikes — don't guess
        return { el: null as Element | null, reason: `>${RECOVER_MAX_STRONG} strong matches — page full of look-alikes` };
      }
    }
  }
  if (!strong.length) {
    return { el: null as Element | null, reason: `0 of ${Math.min(candidates.length, 5000)} <${w.tag}> candidates matched strongly` };
  }
  const [onlyStrong] = strong;
  if (strong.length === 1 && onlyStrong) {
    return { el: onlyStrong.el as Element | null, reason: null as string | null };
  }
  // Multiple strong matches: only safe when they form ONE containment chain.
  for (const [i, si] of strong.entries()) {
    for (const [j, sj] of strong.entries()) {
      if (j <= i) continue;
      if (!containsNode(si.el, sj.el) && !containsNode(sj.el, si.el)) {
        // disjoint strong candidates — genuinely ambiguous
        return { el: null as Element | null, reason: `ambiguous — ${strong.length} disjoint strong matches` };
      }
    }
  }
  const [firstStrong, ...restStrong] = strong;
  if (!firstStrong) {
    // Unreachable: strong.length >= 2 at this point (length 0 and 1 handled above).
    return { el: null as Element | null, reason: 'unexpected empty strong-match list' as string | null };
  }
  let pick = firstStrong;
  for (const c of restStrong) {
    if (c.score > pick.score + 1e-9) pick = c;
    else if (Math.abs(c.score - pick.score) <= 1e-9 && containsNode(pick.el, c.el)) pick = c;
  }
  return { el: pick.el as Element | null, reason: null as string | null };
}

function witnessRecover(w: Witness | null | undefined, root: ScanRoot | Document = document): Element | null {
  return witnessRecoverDetail(w, root).el;
}

// `positionalPath` is exported alongside the ladder for one specific
// consumer: page-preload's computeAnchorLadder appends a
// positional rung itself when `suggestAnchorLadder`'s own LADDER_MAX cap
// sliced it away (an element with ≥4 stronger-but-crowd-matching rungs would
// otherwise have NO unique candidate at all for "hide only this" — the exact
// deflect-to-compose failure the ladder exists to prevent). This does not
// change suggestAnchorLadder's own behavior or its existing callers
// (auto-rebase's promote/recover paths) — it's a separate, opt-in escape
// hatch for a caller that already has the ranked ladder and just needs the
// one rung the cap dropped. NOTE: `positionalPath` caps at 3 ancestor levels
// and produces an UNROOTED descendant-chain selector (e.g.
// `ul > li:nth-of-type(7) > button`) — it is NOT guaranteed unique (it can
// match elsewhere on the page, and resolves to 0 inside a shadow root). The
// caller measures its live match count same as every other rung; this is an
// escape hatch that usually helps, not a guarantee.
//
// `shouldAppendPositional` is the pure decision half of that same fix,
// exported so it's independently harness-testable without a DOM: given a
// ladder already annotated with live match counts, does it need a
// synthesized positional rung appended? True exactly when nothing in it
// resolved to exactly one element. `computeAnchorLadder` (page-preload.ts,
// no bare-node harness — needs a live DOM) calls this before deciding
// whether to synthesize + annotate the extra rung; pinning the decision here
// means a harness catches the append being accidentally removed even though
// the DOM-dependent synthesis itself can't be exercised outside a browser.
function shouldAppendPositional(annotatedLadder: Array<{ matches?: number }>): boolean {
  return !annotatedLadder.some((s) => s.matches === 1);
}

// `looksGeneratedClass` is also exported for one caller outside this file:
// the Shim browser's `selectGroupAnchor` runs it against
// a `data-attr` candidate's ATTRIBUTE NAME (minus the `data-` prefix), not a
// class — a scoped-style attribute like Vue's `data-v-7ba5bd90` is exactly
// the same "generated identifier" shape a hashed class is, and without this
// check `data-attr` candidates bypassed every name-quality filter entirely
// (they never went through `isStableGroupClass`, which only ever looked at
// `css`-kind class candidates).
export {
  resolveAll, resolveAllWithSource, suggestAnchorFor, suggestAnchorLadder, positionalPath,
  shouldAppendPositional, isStableGroupClass, looksGeneratedClass, witnessRecover, witnessRecoverDetail,
};
