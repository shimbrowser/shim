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

function resolveAll(anchor, root = document) {
  const primary = anchor?.primary;
  if (!primary) return [];
  return resolveOne(primary, root);
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
