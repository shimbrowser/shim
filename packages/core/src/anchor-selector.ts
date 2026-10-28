// The CSS an anchor spec resolves through, and the implicit ARIA roles an
// `aria` anchor's `role` honors.
//
// An `aria` anchor names a role the way the accessibility tree does, so
// `{ kind: "aria", role: "button", label: "Get the app" }` must find a native
// `<button aria-label="Get the app">`, which has no `role` attribute: its role
// is implicit. A role therefore matches an element whose explicit `role` is
// that role, OR a native element whose implicit role (HTML-AAM) is that role
// and that has no `role` attribute (an explicit role overrides the native one:
// `<button role="tab">` is a tab, never a button).
//
// The table is deliberately conservative: only mappings that hold without
// computing anything the selector can't see. Roles that depend on context
// (banner/contentinfo on header/footer, complementary on aside, th's
// row/column header, select's size-dependent listbox), on an accessible name
// (form, region: an empty or dangling label gives none) or on an association
// (an input's `list` → combobox) are left out, so an anchor on one of those
// still needs an explicit `role`.
//
// Pure: no DOM, no dependencies. The output is one selector list, so a
// resolve runs one native querySelectorAll and the same string is what the
// no-match evidence reports.

import type { AnchorSpec } from './types';

// Native element selectors per implicit role. Each entry is suffixed with
// `:not([role])` (and the label filter) by `ariaSelector`, so an entry with a
// combinator constrains its last compound only.
const TEXT_INPUT_TYPES = ['text', 'email', 'tel', 'url'];

export const IMPLICIT_ROLE_SELECTORS: Readonly<Record<string, readonly string[]>> = {
  article: ['article'],
  button: ['button', ...['button', 'submit', 'reset', 'image'].map((t) => `input[type="${t}" i]`)],
  checkbox: ['input[type="checkbox" i]'],
  // An input's combobox role depends on its `list` resolving to a datalist,
  // which a selector can't check: listed inputs need an explicit role (and
  // are left out of textbox / searchbox below, so they never mis-attach).
  combobox: ['select:not([multiple]):not([size])'],
  dialog: ['dialog'],
  figure: ['figure'],
  group: ['fieldset', 'details', 'optgroup'],
  heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  img: ['img:not([alt=""])'],
  link: ['a[href]', 'area[href]'],
  list: ['ul', 'ol', 'menu'],
  listbox: ['select[multiple]', 'datalist'],
  listitem: ['ul > li', 'ol > li', 'menu > li'],
  main: ['main'],
  navigation: ['nav'],
  option: ['select option', 'datalist option'],
  progressbar: ['progress'],
  radio: ['input[type="radio" i]'],
  row: ['tr'],
  searchbox: ['input[type="search" i]:not([list])'],
  separator: ['hr'],
  slider: ['input[type="range" i]'],
  spinbutton: ['input[type="number" i]'],
  table: ['table'],
  textbox: [
    'textarea',
    'input:not([type]):not([list])',
    ...TEXT_INPUT_TYPES.map((t) => `input[type="${t}" i]:not([list])`),
  ],
};

/** The native selectors whose implicit role is `role` (empty when none qualify). */
export function implicitRoleSelectors(role: string): readonly string[] {
  const key = role.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(IMPLICIT_ROLE_SELECTORS, key) ? IMPLICIT_ROLE_SELECTORS[key] ?? [] : [];
}

// Escape a value for inclusion inside a `[attr="..."]` selector. Only `"`
// and `\` need escaping inside double-quoted attr selectors per the CSS
// grammar; everything else (including spaces, hyphens, unicode) is fine.
export function escapeAttrValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * The selector list an `aria` anchor resolves through, or null when it names
 * neither a role nor a label. Role and label are ANDed; a role matches an
 * explicit `role` attribute or a native element with that implicit role and
 * no `role` attribute.
 */
export function ariaSelector(role: string | undefined, label: string | undefined): string | null {
  const r = typeof role === 'string' ? role.trim() : '';
  const l = typeof label === 'string' ? label.trim() : '';
  if (!r && !l) return null;
  const labelPart = l ? `[aria-label="${escapeAttrValue(l)}"]` : '';
  if (!r) return labelPart;
  const explicit = `[role="${escapeAttrValue(r)}"]${labelPart}`;
  const native = implicitRoleSelectors(r).map((s) => `${s}:not([role])${labelPart}`);
  return [explicit, ...native].join(', ');
}

/**
 * What an anchor spec resolves through, for evidence and reports: the CSS
 * selector for `css` / `data-attr` / `aria`, and a `text="…"` description for
 * a text anchor (which has no selector). Never empty for a well-formed spec.
 */
export function anchorSelectorOf(spec: AnchorSpec | undefined | null): string {
  if (!spec) return '';
  switch (spec.kind) {
    case 'css':
      return typeof spec.value === 'string' ? spec.value : '';
    case 'data-attr': {
      const raw = typeof spec.name === 'string' ? spec.name.trim() : '';
      if (!raw) return '';
      const name = raw.startsWith('data-') ? raw : `data-${raw}`;
      return spec.value === undefined || spec.value === null ? `[${name}]` : `[${name}="${escapeAttrValue(String(spec.value))}"]`;
    }
    case 'aria':
      return ariaSelector(spec.role, spec.label) ?? '';
    case 'text': {
      const value = typeof spec.value === 'string' ? spec.value.trim() : '';
      return value ? `text${spec.match === 'contains' ? '~' : ''}="${value}"` : '';
    }
    default:
      return typeof spec.value === 'string' ? spec.value : '';
  }
}
