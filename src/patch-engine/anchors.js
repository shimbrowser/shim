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
// The rebase engine (§8) will later layer witness-fingerprint validation
// on top — "primary resolved, but the matched element doesn't look like
// what we anchored to at commit time, fall through anyway." Today there's
// no fingerprint so primary is trusted whenever it returns ≥1 match.
function resolveAll(anchor, root = document) {
  const primary = anchor?.primary;
  if (!primary) return [];
  const head = resolveOne(primary, root);
  if (head.length > 0) return head;
  const fallbacks = Array.isArray(anchor.fallbacks) ? anchor.fallbacks : [];
  for (const fb of fallbacks) {
    const next = resolveOne(fb, root);
    if (next.length > 0) return next;
  }
  return [];
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

module.exports = { resolveAll };
