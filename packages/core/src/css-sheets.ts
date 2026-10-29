// Shim CSS-sheet machinery — the token/attribute + <style>-node plumbing behind
// the Tier-1 (`hide`/`restyle`/`reorder`) and Tier-4 (`replace-root`, route-env)
// kinds. Split out of engine.ts as a leaf module: every function here is pure
// DOM manipulation over fully-encapsulated module-level state (`tier1RuleNodes`,
// `replaceRootRuleNodes`), so it has no dependency back on the engine core.
// `firstGreaterIndex` is covered by scripts/css-priority-harness.
//
// More than one engine instance can share a document (one per isolated world,
// each with its own copy of this module). Each instance writes only into
// <style> elements it created, tagged `data-shim-instance` with its own id, so
// no instance updates, mirrors or tears down another's rules. Anything that has
// to agree across instances lives in the DOM, never in this module's memory:
// the tier-1 cascade order is carried by the elements' `data-shim-priority`
// and their document order (see injectTier1Rule). Cooperative correctness
// between engines that share a page, not a security boundary: any script on
// the page can rewrite these elements. Covered by
// scripts/engine-multi-world-harness.
//
// Every write to an engine <style> is followed by a style-mirror sync: on a
// page whose CSP refuses inline <style> (style-src without 'unsafe-inline')
// the element's text is mirrored into an adopted constructable sheet, so the
// text nodes here stay the single source of truth for order, update and
// teardown (style-mirror.ts; scripts/strict-csp-css-harness).
import type { Spec } from './types';
import { syncStyleMirror, syncStyleOwner } from './style-mirror';

// This engine instance's id on the elements it owns. Random per module
// instance: two worlds loading the same bundle get different ids.
const INSTANCE_ID = Math.random().toString(36).slice(2, 10) || '0';

// All shim CSS lives inside one named cascade layer, `shim`. This is what
// makes "your local layer wins over the site" a guarantee rather than a
// specificity gamble. The load-bearing CSS rule: for
// `!important` declarations, a *layered* style beats an *un-layered* style —
// regardless of selector specificity or source order. Virtually every real
// site ships un-layered CSS, so a shim `!important` rule in `@layer shim`
// wins against the site's `!important` rules even when the site's selector is
// far more specific. Multiple `@layer shim { … }` blocks merge by name into
// the one layer, so each rule keeps its own removable text node (teardown is
// unchanged) while all of them share the layer's precedence.
const SHIM_LAYER = 'shim';
function layered(cssText: string): string {
  return `@layer ${SHIM_LAYER} { ${cssText} }\n`;
}

// Cross-shim cascade priority (higher wins). Stamped onto the runtime spec by
// `run()` from the patch's `priority` (assigned in main: user shims above
// platform fixtures; among user shims, sidebar list order). Read here rather
// than threaded through every rule-processing signature. Previews / forwarded
// rules that shallow-copy the spec inherit it.
export function cssPriorityOf(spec: Spec): number {
  return Number.isFinite(spec && spec.__cssPriority) ? (spec.__cssPriority as number) : 0;
}

export function injectStyle(id: string, css: string): void {
  if (!css || document.querySelector(`style[data-shim="${id}"]`)) return;
  const style = document.createElement('style');
  style.setAttribute('data-shim', id);
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
  syncStyleMirror(style);
}

// Tier-1 CSS built-ins (`hide`, `restyle`) target elements via a shared
// `data-shim-css` attribute. Each rule owns a CSS fragment keyed by a token
// (e.g. `shim-<patchId>-<ruleId>-<kind>`); the engine stamps that token onto
// the resolved anchor and appends the fragment to a shared <style> tag. React
// (and other reconcilers) don't touch data-* attributes they didn't declare,
// so styling survives re-renders without needing self-healing.
//
// The per-token Map (rather than a bare Set) lets us (a) update a rule's CSS
// in place when it's re-applied with different properties, and (b) cleanly
// remove it from its sheet during rule teardown. Each entry stores the text
// node plus its `priority` so cross-shim conflicts resolve deterministically
// (see injectTier1Rule).
interface Tier1RuleEntry {
  node: Text;
  priority: number;
}
const tier1RuleNodes = new Map<string, Tier1RuleEntry>();

// The numeric priority a tier-1 <style> carries, or -Infinity when it carries
// none (sorts first, as an untracked rule did).
function sheetPriority(el: Element): number {
  const p = Number(el.getAttribute('data-shim-priority'));
  return el.hasAttribute('data-shim-priority') && Number.isFinite(p) ? p : -Infinity;
}

// This instance's tier-1 <style> for one priority, created at its cascade
// slot: before the first tier-1 sheet (of any instance) with a strictly higher
// priority, else after the last one. Every instance places its sheets by the
// same rule, so the document order of all tier-1 sheets stays ascending by
// priority whichever instance created which, and in whatever order.
function ensureTier1Sheet(priority: number): HTMLStyleElement {
  const sheets = Array.from(document.querySelectorAll('style[data-shim="tier1-css"]'));
  const own = sheets.find((el) => el.getAttribute('data-shim-instance') === INSTANCE_ID && sheetPriority(el) === priority);
  if (own instanceof HTMLStyleElement) return own;
  const sheet = document.createElement('style');
  sheet.setAttribute('data-shim', 'tier1-css');
  sheet.setAttribute('data-shim-instance', INSTANCE_ID);
  sheet.setAttribute('data-shim-priority', String(priority));
  const idx = firstGreaterIndex(sheets.map(sheetPriority), priority);
  const before = sheets[idx];
  const last = sheets[sheets.length - 1];
  if (before && before.parentNode) before.parentNode.insertBefore(sheet, before);
  else if (last && last.parentNode) last.parentNode.insertBefore(sheet, last.nextSibling);
  else (document.head || document.documentElement).appendChild(sheet);
  return sheet;
}
// All tier-1 rules share one `@layer shim` (so they all beat the site), which
// means a conflict between two shims on the same element+property is decided
// by SOURCE ORDER within the layer — later wins. Blind append makes that
// order depend on apply timing (which shim's rule resolved first, whether a
// rule self-healed late), so the winner flips between reload and toggle. We
// instead place each rule by `priority` (higher wins): one <style> per
// priority, the sheets in ascending priority order, so the highest-priority
// shim's rule always comes last and always wins, regardless of when it
// resolved or which engine instance applied it. Within one sheet (one
// priority — e.g. two rules of one shim) rules append, keeping authoring
// order. Priority is assigned in main (user shims > platform fixtures; among
// user shims, the one higher in the sidebar list) and threaded in via the spec.
export function injectTier1Rule(token: string, cssBody: string, priority = 0): void {
  const text = layered(`[data-shim-css~="${token}"] { ${cssBody} }`);
  const existing = tier1RuleNodes.get(token);
  if (existing && existing.priority === priority && existing.node.parentNode) {
    existing.node.nodeValue = text;
    syncStyleOwner(existing.node.parentNode);
    return;
  }
  // New, or re-applied at another priority (moves to that priority's sheet).
  if (existing) removeTier1Rule(token);
  const node = document.createTextNode(text);
  const sheet = ensureTier1Sheet(priority);
  sheet.appendChild(node);
  tier1RuleNodes.set(token, { node, priority });
  syncStyleMirror(sheet);
}
// First index whose value is strictly greater than `priority`, else the
// array length (append). Pure — exported for a harness.
export function firstGreaterIndex(priorities: number[], priority: number): number {
  for (const [i, p] of priorities.entries()) {
    if (p > priority) return i;
  }
  return priorities.length;
}
export function removeTier1Rule(token: string): void {
  const entry = tier1RuleNodes.get(token);
  if (!entry) return;
  const owner = entry.node.parentNode;
  entry.node.remove();
  tier1RuleNodes.delete(token);
  // An emptied sheet goes too: it is this instance's alone, and a later rule
  // at its priority recreates it at the right slot.
  if (owner instanceof HTMLStyleElement && !owner.firstChild) owner.remove();
  syncStyleOwner(owner);
}
export function tagElement(el: Element, token: string): void {
  const current = el.getAttribute('data-shim-css') || '';
  const tokens = current.split(/\s+/).filter(Boolean);
  if (tokens.includes(token)) return;
  tokens.push(token);
  el.setAttribute('data-shim-css', tokens.join(' '));
}
export function stripToken(el: Element, token: string): void {
  const current = el.getAttribute('data-shim-css') || '';
  const tokens = current.split(/\s+/).filter((t) => t && t !== token);
  if (tokens.length) el.setAttribute('data-shim-css', tokens.join(' '));
  else el.removeAttribute('data-shim-css');
}
const toKebab = (s: string): string => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
export function cssBodyFromProps(props?: Record<string, string>): string {
  return Object.entries(props || {})
    .map(([k, v]) => `${toKebab(k)}: ${v} !important;`)
    .join(' ');
}

// Tier-4 `replace-root` machinery. Distinct attr + sheet from Tier-1 because
// the rule shape differs: Tier-1 styles the anchor; replace-root styles the
// anchor's direct children (hiding them so the handler's mounted DOM can
// occupy the space). Same token-per-rule discipline so teardown can pull
// just this rule's CSS out of the sheet.
const replaceRootRuleNodes = new Map<string, Text>();
function ensureReplaceRootSheet(): HTMLStyleElement {
  const found = document.querySelector(`style[data-shim="replace-root"][data-shim-instance="${INSTANCE_ID}"]`);
  if (found instanceof HTMLStyleElement) return found;
  const sheet = document.createElement('style');
  sheet.setAttribute('data-shim', 'replace-root');
  sheet.setAttribute('data-shim-instance', INSTANCE_ID);
  (document.head || document.documentElement).appendChild(sheet);
  return sheet;
}
export function injectReplaceRootRule(token: string): void {
  if (replaceRootRuleNodes.has(token)) return;
  // The `:not([data-shim-mounted~="..."])` clause keeps the handler's own
  // mounted output visible; without it the children-hide rule would also
  // hit the node the handler appended to the anchor. The handler tags its
  // returned roots with a matching `data-shim-mounted` token (see the
  // dispatch path) so the rule excludes them.
  const text = layered(`[data-shim-replace-root~="${token}"] > *:not([data-shim-mounted~="${token}"]) { display: none !important; }`);
  const node = document.createTextNode(text);
  const sheet = ensureReplaceRootSheet();
  sheet.appendChild(node);
  replaceRootRuleNodes.set(token, node);
  syncStyleMirror(sheet);
}
export function removeReplaceRootRule(token: string): void {
  const node = replaceRootRuleNodes.get(token);
  if (!node) return;
  const owner = node.parentNode;
  node.remove();
  replaceRootRuleNodes.delete(token);
  syncStyleOwner(owner);
}

// Route-only environment pinning. The shadow root isolates a route page's
// CONTENTS, but the page still sits inside the host document's <html>/<body>
// — and those differ per entry path: soft nav keeps the site's stylesheet
// (body max-width / margins / html font-size, which rem resolves against),
// hard load is a bare shell with UA defaults. Pinning both to a neutral state
// while a route is mounted is what makes the two paths render identically.
// NOT applied for the `replace-root` kind — an in-place region replacement is
// supposed to live in the site's layout context; a route page replaces it.
export function injectRouteEnvRule(token: string): void {
  const key = `${token}::env`;
  if (replaceRootRuleNodes.has(key)) return;
  const text =
    layered(`html:has(> body[data-shim-replace-root~="${token}"]) { margin: 0 !important; padding: 0 !important; font-size: 16px !important; background: #fff !important; }`) +
    layered(`body[data-shim-replace-root~="${token}"] { margin: 0 !important; padding: 0 !important; max-width: none !important; width: auto !important; min-height: 100vh !important; background: #fff !important; display: block !important; }`);
  const node = document.createTextNode(text);
  const sheet = ensureReplaceRootSheet();
  sheet.appendChild(node);
  replaceRootRuleNodes.set(key, node);
  syncStyleMirror(sheet);
}
export function removeRouteEnvRule(token: string): void {
  removeReplaceRootRule(`${token}::env`);
}
export function tagReplaceRootAnchor(el: Element, token: string): void {
  const current = el.getAttribute('data-shim-replace-root') || '';
  const tokens = current.split(/\s+/).filter(Boolean);
  if (tokens.includes(token)) return;
  tokens.push(token);
  el.setAttribute('data-shim-replace-root', tokens.join(' '));
}
export function stripReplaceRootToken(el: Element, token: string): void {
  const current = el.getAttribute('data-shim-replace-root') || '';
  const tokens = current.split(/\s+/).filter((t) => t && t !== token);
  if (tokens.length) el.setAttribute('data-shim-replace-root', tokens.join(' '));
  else el.removeAttribute('data-shim-replace-root');
}
export function tagMountedNode(node: Node, token: string): void {
  if (!(node instanceof Element)) return;
  const current = node.getAttribute('data-shim-mounted') || '';
  const tokens = current.split(/\s+/).filter(Boolean);
  if (tokens.includes(token)) return;
  tokens.push(token);
  node.setAttribute('data-shim-mounted', tokens.join(' '));
}
