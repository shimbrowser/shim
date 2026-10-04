// Strict-CSP fallback for the engine's <style> sheets.
//
// The engine writes all shim CSS as text inside <style data-shim=…> elements
// (css-sheets.ts). A page whose CSP sets `style-src` without 'unsafe-inline'
// refuses those elements: Chromium never builds their `sheet`, so every
// hide / restyle / reorder / replace-root rule silently does nothing.
// Constructable stylesheets are not subject to that check — a
// `new CSSStyleSheet()` + `replaceSync()` adopted via `adoptedStyleSheets`
// applies under any `style-src` (measured in Electron, from the preload's
// isolated world: the sheet is shared with the main world and its
// `@layer shim` rules beat the site's un-layered `!important` rules exactly as
// the <style> path does). It is DOM-standard, so the engine stays
// host-agnostic (Electron preload, Playwright init script, anything else).
//
// Design: the <style> element stays the single source of truth. Every
// ordering / in-place-update / teardown decision is still made on its text
// nodes (css-sheets.ts is unchanged in that respect), and after each change
// the caller asks this module to re-sync. If the element is connected but has
// no `sheet` — the browser refused it — we mirror its exact textContent into
// one constructed sheet per element. Because the mirror IS the element's text,
// every invariant the text-node path keeps (priority order inside the tier-1
// sheet, in-place update, teardown removing exactly one rule) holds for the
// mirror by construction. Mirrors are adopted after any sheets the page itself
// adopted, ordered among themselves by their source elements' document order —
// the same relative order the <style> elements would have had.
//
// On a page that accepts the <style> (no strict CSP) `sheet` is non-null, so
// this module never constructs anything and the page is byte-for-byte what it
// was before. Nothing here may throw into the engine.
//
// `@import`: `replaceSync()` drops every `@import` rule, so a whole-patch
// `spec.css` that opens with one would lose the imported sheet on exactly the
// pages this fallback serves. The mirror loads each leading import through a
// `<link rel="stylesheet" data-shim-import>` inserted just before the refused
// <style> — a `<link>` passes the same `style-src` check the `@import` would
// have. A document `<link>` alone would cascade before EVERY adopted mirror,
// though, letting an earlier mirrored <style> beat a later one's import; so
// once the link loads, its rules are copied into a constructed sheet (based
// at the link's URL, so relative `url()`s still resolve) adopted right before
// its importing mirror — the slot the `@import` had — and the link is
// disabled. When the loaded sheet can't be copied (cross-origin without CORS,
// or it has nested `@import`s a copy would drop again) the link keeps applying
// from its document slot. `layer(…)` / `supports(…)` imports can't be
// expressed on a `<link>` and are skipped (css-imports.ts).

import { leadingImports } from './css-imports';

type StyleRoot = Document | ShadowRoot;

interface Mirror {
  sheet: CSSStyleSheet;
  root: StyleRoot;
  // The `<link>`s standing in for the element's leading `@import`s, and the
  // serialized import list they were built from (rebuilt only on change).
  links: HTMLLinkElement[];
  importKey: string;
  // Constructed copies of the loaded imports, index-aligned with `links`
  // (null until that link loads, or when it can't be copied). Adopted just
  // before `sheet`.
  importCopies: Array<CSSStyleSheet | null>;
}

// Source element → its mirror. Only populated on pages that refused a sheet.
const mirrors = new Map<HTMLStyleElement, Mirror>();
// Every sheet this module ever constructed, so a reconcile can strip ours
// out of `adoptedStyleSheets` (including mirrors already dropped from the map)
// while leaving the page's own adopted sheets untouched.
const ownSheets = new WeakSet<CSSStyleSheet>();

function canConstruct(): boolean {
  return typeof CSSStyleSheet === 'function'
    && typeof CSSStyleSheet.prototype.replaceSync === 'function';
}

function adoptingRoot(style: HTMLStyleElement): StyleRoot | null {
  if (!style.isConnected) return null;
  const root = style.getRootNode();
  if (!('adoptedStyleSheets' in root)) return null;
  if (typeof Document !== 'undefined' && root instanceof Document) return root;
  if (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) return root;
  return null;
}

// A connected <style> without a `sheet` is one the browser refused (CSP). An
// accepted element always has one, even when empty.
function isRefused(style: HTMLStyleElement): boolean {
  return style.sheet === null;
}

function construct(cssText: string): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(cssText);
  ownSheets.add(sheet);
  return sheet;
}

function removeLinks(m: Mirror): void {
  for (const link of m.links) link.remove();
  m.links = [];
  m.importCopies = [];
  m.importKey = '';
}

// A link finished loading: move its rules into the mirror's cascade slot.
function adoptImportCopy(style: HTMLStyleElement, m: Mirror, link: HTMLLinkElement, idx: number, media: string): void {
  try {
    if (mirrors.get(style) !== m || m.links[idx] !== link) return; // superseded
    const loaded = link.sheet;
    if (!loaded) return;
    const rules = Array.from(loaded.cssRules); // SecurityError: cross-origin without CORS
    if (rules.some((r) => r instanceof CSSImportRule)) return;
    const copy = new CSSStyleSheet(media ? { baseURL: link.href, media } : { baseURL: link.href });
    copy.replaceSync(rules.map((r) => r.cssText).join('\n'));
    ownSheets.add(copy);
    m.importCopies[idx] = copy;
    link.disabled = true;
    reconcile(m.root);
  } catch {
    /* uncopyable: the link keeps applying from its document slot */
  }
}

// Bring the mirror's import `<link>`s in line with the element's current
// leading `@import`s. Rebuilt only when the list changed, so an in-place
// text update elsewhere in the sheet never reloads an imported stylesheet.
function syncImportLinks(style: HTMLStyleElement, m: Mirror, cssText: string): void {
  const { imports } = leadingImports(cssText);
  const key = JSON.stringify(imports);
  if (key === m.importKey && m.links.every((l) => l.isConnected)) return;
  removeLinks(m);
  imports.forEach((imp, idx) => {
    const link = style.ownerDocument.createElement('link');
    link.rel = 'stylesheet';
    link.setAttribute('data-shim-import', style.getAttribute('data-shim') || '');
    link.href = imp.href;
    if (imp.media) link.media = imp.media;
    link.addEventListener('load', () => adoptImportCopy(style, m, link, idx, imp.media), { once: true });
    style.before(link);
    m.links.push(link);
    m.importCopies.push(null);
  });
  m.importKey = key;
}

function documentOrder(a: HTMLStyleElement, b: HTMLStyleElement): number {
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

// Rewrite `root.adoptedStyleSheets` to [page's own sheets…, our mirrors in
// document order, each preceded by its loaded import copies]. Assigns only
// when something changed, so a no-op sync never churns the page's style recalc.
function reconcile(root: StyleRoot): void {
  const ours = [...mirrors.entries()]
    .filter(([, m]) => m.root === root)
    .sort(([a], [b]) => documentOrder(a, b))
    .flatMap(([, m]) => [...m.importCopies.filter((c): c is CSSStyleSheet => c !== null), m.sheet]);
  const current = root.adoptedStyleSheets;
  const desired = [...current.filter((s) => !ownSheets.has(s)), ...ours];
  if (desired.length === current.length && desired.every((s, i) => s === current[i])) return;
  root.adoptedStyleSheets = desired;
}

// Re-sync one engine-owned <style> after its text changed (or after it was
// inserted). Mirrors it when the browser refused it, drops the mirror when the
// element now applies on its own, and prunes mirrors whose element left the
// document (a removed engine sheet stops applying on strict pages exactly as
// it does elsewhere).
export function syncStyleMirror(style: HTMLStyleElement): void {
  try {
    if (!canConstruct()) return;
    const touched = new Set<StyleRoot>();
    for (const [el, m] of mirrors) {
      if (!el.isConnected) {
        removeLinks(m);
        mirrors.delete(el);
        touched.add(m.root);
      }
    }
    const root = adoptingRoot(style);
    const existing = mirrors.get(style);
    if (root && isRefused(style)) {
      const text = style.textContent || '';
      let mirror: Mirror;
      if (existing && existing.root === root) {
        existing.sheet.replaceSync(text);
        mirror = existing;
      } else {
        if (existing) {
          removeLinks(existing);
          touched.add(existing.root);
        }
        mirror = { sheet: construct(text), root, links: [], importKey: '', importCopies: [] };
        mirrors.set(style, mirror);
      }
      syncImportLinks(style, mirror, text);
      touched.add(root);
    } else if (existing) {
      removeLinks(existing);
      mirrors.delete(style);
      touched.add(existing.root);
    }
    for (const r of touched) reconcile(r);
  } catch {
    /* a fallback must never break the page or the engine */
  }
}

// Sync the <style> that owns a rule's text node (no-op when the node isn't
// inside one — e.g. it was just removed and the caller passes the old parent).
export function syncStyleOwner(parent: Node | null): void {
  if (parent && typeof HTMLStyleElement !== 'undefined' && parent instanceof HTMLStyleElement) {
    syncStyleMirror(parent);
  }
}

// One-shot variant for an engine-owned <style> whose text never changes and
// whose root is engine-owned too (the route host's shadow-root base sheet):
// once adopted on the shadow root the mirror travels with it across
// detach / re-append, so no bookkeeping is needed. Call after the element is
// connected — refusal is only observable then.
export function adoptIfRefused(style: HTMLStyleElement): void {
  try {
    if (!canConstruct()) return;
    const root = adoptingRoot(style);
    if (!root || !isRefused(style)) return;
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, construct(style.textContent || '')];
  } catch {
    /* a fallback must never break the page or the engine */
  }
}
