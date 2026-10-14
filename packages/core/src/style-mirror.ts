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
// once the links load, their rules are copied into constructed sheets (with
// relative `url()`s made absolute against the imported sheet's URL — Chromium
// resolves a constructed sheet's URLs against the document and ignores its
// `baseURL` option) adopted right before
// the importing mirror — the slot the `@import`s had — and the links are
// disabled. The element's `@layer` order statements that precede its imports
// go into a sheet adopted ahead of the copies, so the layer order they fix
// still holds. A loaded sheet's own nested `@import`s are copied too, each into
// its own run of sheets (URLs resolved against its own URL, its media / layer / supports
// conditions re-expressed as wrapping at-rules) in rule order. A cross-origin
// import is first requested with CORS (`crossorigin="anonymous"`) so its rules
// are readable when the server allows it; if that load fails it is retried
// without, as an `@import` would have loaded it. That is all-or-none per
// element: if any import still can't be read (cross-origin without CORS),
// every link keeps applying from its document slot, since mixing the two
// would reverse the imports' source order. That sheet then cascades before
// every mirror — the one ordering a page script cannot restore, because no
// API exposes the rules of an opaque cross-origin sheet. `layer(…)` /
// `supports(…)` top-level imports can't be expressed on a `<link>` and are
// skipped (css-imports.ts).

import { absolutizeUrls, leadingImports } from './css-imports';
import type { CssImport } from './css-imports';

type StyleRoot = Document | ShadowRoot;

interface Mirror {
  sheet: CSSStyleSheet;
  root: StyleRoot;
  // The `<link>`s standing in for the element's leading `@import`s, and the
  // serialized import list they were built from (rebuilt only on change).
  links: HTMLLinkElement[];
  importKey: string;
  // Per-link load outcome, index-aligned with `links`: its constructed
  // copies, or why there are none. See slotCopies for how they're adopted.
  importCopies: ImportState[];
  // The element's `@layer` statements that precede its imports, adopted
  // ahead of the import copies (null when there are none, or no imports).
  layerSheet: CSSStyleSheet | null;
}

// A loaded import's copies (one or more sheets, see copySheet), or why there
// are none. 'failed': the link didn't load — a failed @import contributes
// nothing either. 'uncopyable': loaded, but its rules can't be read or copied
// whole.
type ImportState = CSSStyleSheet[] | 'pending' | 'failed' | 'uncopyable';

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
  m.layerSheet = null;
}

// The import copies to adopt in the mirror's slot — all or none. Null while
// any import is pending or uncopyable: the links then keep applying from
// their document slot, in their own source order.
function slotCopies(m: Mirror): CSSStyleSheet[] | null {
  const out: CSSStyleSheet[] = [];
  for (const st of m.importCopies) {
    if (Array.isArray(st)) out.push(...st);
    else if (st !== 'failed') return null;
  }
  return out;
}

// Nested-import depth past which a sheet counts as uncopyable (the browser
// stops cycles itself; this only bounds our recursion).
const MAX_IMPORT_DEPTH = 16;

// `@import url(…) layer(x) supports(c) m` → the at-rules that wrap the
// imported rules to the same effect, outermost first.
function importWrappers(rule: CSSImportRule): string[] {
  const out: string[] = [];
  if (rule.supportsText) out.push(`@supports (${rule.supportsText})`);
  const media = rule.media.mediaText;
  if (media && media !== 'all') out.push(`@media ${media}`);
  if (rule.layerName !== null) out.push(rule.layerName ? `@layer ${rule.layerName}` : '@layer');
  return out;
}

function wrap(text: string, wrappers: string[]): string {
  return wrappers.reduceRight((inner, w) => `${w} {\n${inner}\n}`, text);
}

// Copy `sheet` into constructed sheets appended to `out`, in rule order: the
// rules between nested `@import`s go into one sheet, and each nested import
// recurses — its rules' relative `url()`s resolve against its own URL, so
// each level absolutizes against its own `baseURL`. `media` is the top-level
// link's media (applied to every copy as the sheet's own condition). False
// when anything can't be read (SecurityError on an opaque cross-origin sheet)
// or expressed.
function copySheet(sheet: CSSStyleSheet, baseURL: string, media: string, wrappers: string[], out: CSSStyleSheet[], depth: number): boolean {
  if (depth > MAX_IMPORT_DEPTH) return false;
  const rules = Array.from(sheet.cssRules); // SecurityError: cross-origin without CORS
  let buf: string[] = [];
  const flush = (): void => {
    if (!buf.length) return;
    const copy = new CSSStyleSheet(media ? { media } : {});
    copy.replaceSync(wrap(buf.join('\n'), wrappers));
    ownSheets.add(copy);
    out.push(copy);
    buf = [];
  };
  for (const rule of rules) {
    if (rule instanceof CSSImportRule) {
      flush();
      const nested = rule.styleSheet;
      if (!nested) continue; // didn't load: contributes nothing, as natively
      if (!copySheet(nested, nested.href || rule.href, media, [...wrappers, ...importWrappers(rule)], out, depth + 1)) return false;
      continue;
    }
    // `@namespace` is only valid at a sheet's top level, never inside a block,
    // and its url() is a namespace name, not a resource to resolve.
    if (rule instanceof CSSNamespaceRule) {
      if (wrappers.length) return false;
      buf.push(rule.cssText);
      continue;
    }
    buf.push(absolutizeUrls(rule.cssText, baseURL));
  }
  flush();
  return true;
}

function copyLoaded(link: HTMLLinkElement, media: string): ImportState {
  try {
    const loaded = link.sheet;
    if (!loaded) return 'uncopyable';
    const out: CSSStyleSheet[] = [];
    return copySheet(loaded, link.href, media, [], out, 0) ? out : 'uncopyable';
  } catch {
    return 'uncopyable';
  }
}

// A link loaded or failed. Once every import of the element has settled and
// all are copyable, the copies take the mirror's slot and the links go quiet.
function settleImport(style: HTMLStyleElement, m: Mirror, link: HTMLLinkElement, idx: number, state: () => ImportState): void {
  try {
    if (mirrors.get(style) !== m || m.links[idx] !== link) return; // superseded
    m.importCopies[idx] = state();
    if (!slotCopies(m)) return;
    for (const l of m.links) l.disabled = true;
    reconcile(m.root);
  } catch {
    /* a fallback must never break the page or the engine */
  }
}

function isCrossOrigin(style: HTMLStyleElement, href: string): boolean {
  try {
    return new URL(href, style.baseURI).origin !== new URL(style.ownerDocument.URL).origin;
  } catch {
    return false;
  }
}

// One import's `<link>`. `cors`: request it with `crossorigin="anonymous"` so
// a cross-origin sheet's rules are readable (copyable) when the server allows
// it; if that load fails, the link is replaced by a plain one — how the
// `@import` itself would have loaded it — which may then only apply from its
// document slot.
function importLink(style: HTMLStyleElement, m: Mirror, imp: CssImport, idx: number, cors: boolean): HTMLLinkElement {
  const link = style.ownerDocument.createElement('link');
  link.rel = 'stylesheet';
  link.setAttribute('data-shim-import', style.getAttribute('data-shim') || '');
  if (cors) link.crossOrigin = 'anonymous';
  link.href = imp.href;
  if (imp.media) link.media = imp.media;
  link.addEventListener('load', () => settleImport(style, m, link, idx, () => copyLoaded(link, imp.media)), { once: true });
  link.addEventListener('error', () => {
    if (cors) retryWithoutCors(style, m, link, imp, idx);
    else settleImport(style, m, link, idx, () => 'failed');
  }, { once: true });
  return link;
}

function retryWithoutCors(style: HTMLStyleElement, m: Mirror, failed: HTMLLinkElement, imp: CssImport, idx: number): void {
  try {
    if (mirrors.get(style) !== m || m.links[idx] !== failed) return; // superseded
    const link = importLink(style, m, imp, idx, false);
    m.links[idx] = link;
    failed.replaceWith(link);
  } catch {
    /* a fallback must never break the page or the engine */
  }
}

// Bring the mirror's import `<link>`s in line with the element's current
// leading `@import`s. Rebuilt only when the list changed, so an in-place
// text update elsewhere in the sheet never reloads an imported stylesheet.
function syncImportLinks(style: HTMLStyleElement, m: Mirror, cssText: string): void {
  const { imports, layerStatements } = leadingImports(cssText);
  const key = JSON.stringify([imports, layerStatements]);
  if (key === m.importKey && m.links.every((l) => l.isConnected)) return;
  removeLinks(m);
  // `@layer b, a; @import "x.css";` fixes b before a even when x.css declares
  // a first. The statements stay in the mirror too, but the copies are
  // adopted before it, so they'd establish the order first without this.
  if (imports.length && layerStatements.length) m.layerSheet = construct(layerStatements.join('\n'));
  imports.forEach((imp, idx) => {
    const link = importLink(style, m, imp, idx, isCrossOrigin(style, imp.href));
    m.links.push(link);
    m.importCopies.push('pending');
    style.before(link);
  });
  m.importKey = key;
}

function documentOrder(a: HTMLStyleElement, b: HTMLStyleElement): number {
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

// Rewrite `root.adoptedStyleSheets` to [page's own sheets…, our mirrors in
// document order, each preceded by its leading `@layer` statements and its
// import copies (slotCopies)]. Assigns only
// when something changed, so a no-op sync never churns the page's style recalc.
function reconcile(root: StyleRoot): void {
  const ours = [...mirrors.entries()]
    .filter(([, m]) => m.root === root)
    .sort(([a], [b]) => documentOrder(a, b))
    .flatMap(([, m]) => [...(m.layerSheet ? [m.layerSheet] : []), ...(slotCopies(m) ?? []), m.sheet]);
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
        mirror = { sheet: construct(text), root, links: [], importKey: '', importCopies: [], layerSheet: null };
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
