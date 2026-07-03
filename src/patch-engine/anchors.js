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
      // for `value` as a substring.
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
      const norm = (s) => (s || '').trim().replace(/\s+/g, ' ');
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

// Best single stable anchor spec for an element, strongest kind first:
// id → site data-* → aria(role/label) → label-like text → positional CSS
// path (last resort). Mirrors the picker's `suggestAnchors` ranking but
// returns one spec, since a rebase needs a single new `primary`. The witness
// re-verifies whatever this produces, so even the positional fallback is safe
// (a wrong-but-resolving anchor fails the witness and re-quarantines).
function suggestAnchorFor(el) {
  if (!el || !el.tagName) return null;
  const tag = el.tagName.toLowerCase();

  const id = el.getAttribute && el.getAttribute('id');
  if (id && /^[A-Za-z][\w-]*$/.test(id)) {
    return { kind: 'css', value: `#${id}` };
  }

  for (const attr of el.attributes || []) {
    if (isSiteDataAttr(attr.name) && /^[a-zA-Z][\w-]*$/.test(attr.name)) {
      return { kind: 'data-attr', name: attr.name, value: attr.value };
    }
  }

  const role = el.getAttribute && el.getAttribute('role');
  const label = el.getAttribute && el.getAttribute('aria-label');
  if ((role && role.trim()) || (label && label.trim())) {
    const a = { kind: 'aria' };
    if (role && role.trim()) a.role = role.trim();
    if (label && label.trim()) a.label = label.trim();
    return a;
  }

  const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
  const labelLike = /^(button|a|label|h[1-6])$/.test(tag) ||
    role === 'button' || role === 'link';
  if (labelLike && text && text.length <= 60 && !text.includes('\n')) {
    return { kind: 'text', value: text };
  }

  // Last resort: a short positional CSS path. Walk up to 3 levels, using
  // :nth-of-type so the path survives sibling text/attribute churn better
  // than a bare tag. Anchored at an id'd ancestor if one is close.
  return { kind: 'css', value: positionalPath(el) };
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
function witnessRecover(w, root = document) {
  if (!w || !w.tag) return null;
  const scope = root.getElementsByTagName ? root : document;
  const candidates = scope.getElementsByTagName(w.tag);
  const strong = [];
  for (let i = 0; i < candidates.length && i < 5000; i++) {
    const el = candidates[i];
    const verdict = witness.matchWitness(w, el);
    if (verdict.pass && verdict.score >= RECOVER_MIN_SCORE) {
      strong.push({ el, score: verdict.score });
      if (strong.length > RECOVER_MAX_STRONG) return null; // a page full of look-alikes — don't guess
    }
  }
  if (!strong.length) return null;
  if (strong.length === 1) return strong[0].el;
  // Multiple strong matches: only safe when they form ONE containment chain.
  for (let i = 0; i < strong.length; i++) {
    for (let j = i + 1; j < strong.length; j++) {
      if (!containsNode(strong[i].el, strong[j].el) && !containsNode(strong[j].el, strong[i].el)) {
        return null; // disjoint strong candidates — genuinely ambiguous
      }
    }
  }
  let pick = strong[0];
  for (const c of strong.slice(1)) {
    if (c.score > pick.score + 1e-9) pick = c;
    else if (Math.abs(c.score - pick.score) <= 1e-9 && containsNode(pick.el, c.el)) pick = c;
  }
  return pick.el;
}

module.exports = {
  resolveAll,
  resolveAllWithSource,
  suggestAnchorFor,
  witnessRecover,
};
