// Anchor resolution. The engine asks `resolveAll(rule.anchor)` every scan;
// we walk `primary` and return whatever it resolves to (the rebase engine
// will later layer fallbacks + witness fingerprints on top — CLAUDE.md §8).
//
// Today three kinds are supported:
//   - `css`        — raw CSS selector. `{ kind: "css", value: "[data-foo]" }`.
//   - `data-attr`  — single data-* attribute, optional value. Cleaner than
//                    a CSS selector when the LLM is targeting "this element
//                    because it's the data-testid='cart' one" — the intent
//                    is preserved in the spec, and a future ladder can
//                    weight strong-attr matches differently than a generic
//                    CSS selector.
//   - `aria`       — accessibility-tree match by role and/or aria-label.
//                    Often the most resilient anchor on framework-rewritten
//                    sites, because the a11y tree is the layer the site
//                    cares to keep stable.
//
// The new kinds are sugar over CSS attribute selectors today, but the kind
// metadata is what matters: the rebase engine will read `kind` to decide
// witness-fingerprint shape, fallback ordering, and quarantine reasons.

const witness = require('./witness');

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
// Witness-fingerprint validation (§8, §14): when the anchor carries a
// `witness`, every rung's matches are filtered through it before being
// trusted — "primary resolved, but the matched element doesn't look like
// what we anchored to at commit time, fall through anyway." Anchors
// without a witness keep the original behavior: trusted whenever they
// return ≥1 match.
function resolveAll(anchor, root = document) {
  return resolveAllWithSource(anchor, root).nodes;
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
function resolveAllWithSource(anchor, root = document) {
  const primary = anchor?.primary;
  if (!primary) return { nodes: [], source: null, witnessRejected: false };
  const w = anchor.witness || null;
  let witnessRejected = false;
  let rejectedSample = null;

  const tryRung = (spec, source) => {
    const found = resolveOne(spec, root);
    if (found.length === 0) return null;
    if (!w) return { nodes: found, source, witnessRejected: false };
    const passing = [];
    for (const el of found) {
      const verdict = witness.matchWitness(w, el);
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
  for (let i = 0; i < fallbacks.length; i++) {
    const next = tryRung(fallbacks[i], `fallback:${i}`);
    if (next) return next;
  }
  return { nodes: [], source: null, witnessRejected, rejectedSample };
}

function resolveOne(spec, root) {
  switch (spec.kind) {
    case 'css':
      if (typeof spec.value !== 'string' || !spec.value.trim()) return [];
      try {
        return Array.from(root.querySelectorAll(spec.value));
      } catch (err) {
        console.warn(`[shim] invalid css selector "${spec.value}":`, err?.message || err);
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
        console.warn(`[shim] data-attr resolve failed for "${sel}":`, err?.message || err);
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
      const norm = (s) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
      const target = norm(value);
      const test = mode === 'contains'
        ? (txt) => txt.includes(target)
        : (txt) => txt === target;

      const all = (root.getElementsByTagName
        ? root.getElementsByTagName('*')
        : root.querySelectorAll('*')) || [];
      const MAX_SCAN = 10000;
      const matched = [];
      const matchedSet = new Set();
      for (let i = 0; i < all.length && i < MAX_SCAN; i++) {
        const el = all[i];
        if (test(norm(el.textContent))) {
          matched.push(el);
          matchedSet.add(el);
        }
      }
      if (!matched.length) return [];
      // Drop any element whose descendant is also in the set — keeps
      // only the deepest text-bearing matchers.
      return matched.filter((el) => {
        const descendants = el.querySelectorAll ? el.querySelectorAll('*') : [];
        for (const d of descendants) {
          if (matchedSet.has(d)) return false;
        }
        return true;
      });
    }

    case 'aria': {
      // Compose `[role="..."][aria-label="..."]` from whichever fields are
      // present. At least one of role/label is required — without either,
      // an aria anchor has no signal and would silently match every
      // element on the page.
      const parts = [];
      if (typeof spec.role === 'string' && spec.role.trim()) {
        parts.push(`[role="${escapeAttrValue(spec.role.trim())}"]`);
      }
      if (typeof spec.label === 'string' && spec.label.trim()) {
        parts.push(`[aria-label="${escapeAttrValue(spec.label.trim())}"]`);
      }
      if (!parts.length) {
        console.warn('[shim] aria anchor needs at least `role` or `label`');
        return [];
      }
      const sel = parts.join('');
      try {
        return Array.from(root.querySelectorAll(sel));
      } catch (err) {
        console.warn(`[shim] aria resolve failed for "${sel}":`, err?.message || err);
        return [];
      }
    }

    default:
      console.warn(`[shim] unsupported anchor kind: ${spec.kind}`);
      return [];
  }
}

// Escape a value for inclusion inside a `[attr="..."]` selector. Only `"`
// and `\` need escaping inside double-quoted attr selectors per the CSS
// grammar; everything else (including spaces, hyphens, unicode) is fine.
function escapeAttrValue(v) {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// --- Auto-rebase support (§14): synthesize a fresh anchor + find a drifted
// element by its witness. Used by the engine's rebase pass to re-point a rule
// whose primary selector died, deterministically (no LLM). ---

// `data-shim*` are Shim's own stamped tokens (ephemeral, apply-order-
// dependent) — never anchor to them (mirrors page-preload's picker exclusion
// and the witness module). A site `data-shimmer` would also be skipped; it
// still has tag/text/other signals.
function isSiteDataAttr(name) {
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

function suggestAnchorLadder(el, root) {
  if (!el || !el.tagName) return [];
  const scope = root || (typeof document !== 'undefined' ? document : null);
  const verifiable = !!(scope && typeof scope.querySelectorAll === 'function');
  const tag = el.tagName.toLowerCase();

  const candidates = [];

  const id = el.getAttribute && el.getAttribute('id');
  if (id && /^[A-Za-z][\w-]*$/.test(id)) {
    candidates.push({ kind: 'css', value: `#${id}` });
  }

  for (const attr of el.attributes || []) {
    if (isSiteDataAttr(attr.name) && /^[a-zA-Z][\w-]*$/.test(attr.name)) {
      candidates.push({ kind: 'data-attr', name: attr.name, value: attr.value });
    }
  }

  const role = el.getAttribute && el.getAttribute('role');
  const label = el.getAttribute && el.getAttribute('aria-label');
  if ((role && role.trim()) || (label && label.trim())) {
    const a = { kind: 'aria' };
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
  let ranked;
  if (!verifiable) {
    ranked = candidates;
  } else {
    const unique = [];
    const crowd = [];
    for (const spec of candidates) {
      let found;
      try {
        found = resolveOne(spec, scope);
      } catch (_) {
        continue;
      }
      if (!found.includes(el)) continue;
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
function suggestAnchorFor(el, root) {
  const ladder = suggestAnchorLadder(el, root);
  return ladder.length ? ladder[0] : null;
}

// Class tokens that look authored rather than generated by a build tool.
// Generated patterns excluded: css-in-js prefixes (`css-1a2b3c`), hash-y
// hex runs, long digit runs, css-modules `Block_elem__x7Kd2` suffixes,
// 1-2-letter+digit minified names (`x9`). BEM (`card__title`) and plain
// utilities survive the filter — a broad utility combo just loses the
// uniqueness ranking instead.
function looksGeneratedClass(cls) {
  if (!/^[A-Za-z_][\w-]*$/.test(cls)) return true; // needs escaping → skip
  if (cls.length < 3) return true;
  if (/^(css|jss|jsx|sc|svelte|emotion|chakra)-/i.test(cls)) return true;
  if (/\d{3,}/.test(cls)) return true;
  if (/[0-9a-f]{6,}/i.test(cls)) return true;
  if (/^[A-Za-z]{1,2}\d/.test(cls)) return true;
  if (/__[\w-]*\d[\w-]*$/.test(cls)) return true;
  return false;
}

function stableClassesOf(el) {
  const raw = el.getAttribute && el.getAttribute('class');
  if (!raw || typeof raw !== 'string') return [];
  return raw.trim().split(/\s+/).filter((c) => c && !looksGeneratedClass(c));
}

// Nearest ancestor (within 5 levels) carrying an id or a site data-*
// attribute — a stable scope to hang a descendant selector off.
function stableAncestorSelector(el) {
  let cur = el.parentElement;
  for (let depth = 0; cur && cur.tagName && depth < 5; depth++, cur = cur.parentElement) {
    const aid = cur.getAttribute && cur.getAttribute('id');
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

function positionalPath(el) {
  const parts = [];
  let cur = el;
  for (let depth = 0; cur && cur.tagName && depth < 3; depth++) {
    const tag = cur.tagName.toLowerCase();
    const cid = cur.getAttribute && cur.getAttribute('id');
    if (cid && /^[A-Za-z][\w-]*$/.test(cid)) {
      parts.unshift(`#${cid}`);
      break; // an id'd ancestor is a stable enough root
    }
    const parent = cur.parentElement;
    if (parent) {
      const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
      const idx = sibs.indexOf(cur) + 1;
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
function containsNode(a, b) {
  for (let n = b && b.parentElement; n; n = n.parentElement) {
    if (n === a) return true;
  }
  return false;
}
// Detail-returning form: `{ el, reason }` where a null `el` carries WHY the
// scan refused — surfaced through the quarantine event/diagnostics so a
// failed recovery is debuggable after the fact (live-caught: a recovery
// failure escalated to an LLM turn and nothing recorded which veto fired).
function witnessRecoverDetail(w, root = document) {
  if (!w || !w.tag) return { el: null, reason: 'no witness to scan with' };
  const scope = root.getElementsByTagName ? root : document;
  const candidates = scope.getElementsByTagName(w.tag);
  const strong = [];
  for (let i = 0; i < candidates.length && i < 5000; i++) {
    const el = candidates[i];
    const verdict = witness.matchWitness(w, el);
    if (verdict.pass && verdict.score >= RECOVER_MIN_SCORE) {
      strong.push({ el, score: verdict.score });
      if (strong.length > RECOVER_MAX_STRONG) {
        // a page full of look-alikes — don't guess
        return { el: null, reason: `>${RECOVER_MAX_STRONG} strong matches — page full of look-alikes` };
      }
    }
  }
  if (!strong.length) {
    return { el: null, reason: `0 of ${Math.min(candidates.length, 5000)} <${w.tag}> candidates matched strongly` };
  }
  if (strong.length === 1) return { el: strong[0].el, reason: null };
  // Multiple strong matches: only safe when they form ONE containment chain.
  for (let i = 0; i < strong.length; i++) {
    for (let j = i + 1; j < strong.length; j++) {
      if (!containsNode(strong[i].el, strong[j].el) && !containsNode(strong[j].el, strong[i].el)) {
        // disjoint strong candidates — genuinely ambiguous
        return { el: null, reason: `ambiguous — ${strong.length} disjoint strong matches` };
      }
    }
  }
  let pick = strong[0];
  for (const c of strong.slice(1)) {
    if (c.score > pick.score + 1e-9) pick = c;
    else if (Math.abs(c.score - pick.score) <= 1e-9 && containsNode(pick.el, c.el)) pick = c;
  }
  return { el: pick.el, reason: null };
}

function witnessRecover(w, root = document) {
  return witnessRecoverDetail(w, root).el;
}

module.exports = {
  resolveAll,
  resolveAllWithSource,
  suggestAnchorFor,
  suggestAnchorLadder,
  witnessRecover,
  witnessRecoverDetail,
};
