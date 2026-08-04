// Pure logic for the Tier-2 declarative injection kinds — `inject-element`
// and `inject-html` (CLAUDE.md §6). Static-only by contract: no event
// handlers, no scripts — behavior belongs in `script` handlers where
// api.cleanup + self-healing apply. Validation/scan run in main (spec-lint)
// with no DOM; builder/strip/placement run in the page's isolated world.
// Everything is bare-node testable (scripts/inject-kinds-harness.js).
import type { InjectNode } from './types';

const INJECT_PLACEMENTS = new Set(['before', 'after', 'prepend', 'append']);
const INJECT_MAX_DEPTH = 8;
const INJECT_MAX_NODES = 50;
const INJECT_HTML_MAX_CHARS = 32768;

const NODE_KEYS = new Set(['tag', 'text', 'attrs', 'style', 'children']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Scheme-normalized javascript:-URL check. Browsers strip ASCII whitespace
// and control chars from the scheme before matching, so "  JavaScript\t:"
// executes — normalize the same way before comparing (the classic bypass).
// A char-code filter (not a regex control-char range) sidesteps ESLint's
// no-control-regex rule while doing the identical strip.
function isJavascriptUrl(value: string): boolean {
  let stripped = '';
  for (const ch of value) {
    if (ch.charCodeAt(0) > 0x20) stripped += ch;
  }
  return stripped.toLowerCase().startsWith('javascript:');
}

function isEventAttr(name: string): boolean {
  return /^on/i.test(name);
}

// Validate an inject-element node tree. Returns human-readable problems
// (empty = valid). Pure JSON walk — no DOM, callable from main (spec-lint).
function validateInjectTree(root: unknown): string[] {
  const problems: string[] = [];
  let count = 0;
  const walk = (node: unknown, depth: number, isRoot: boolean): void => {
    if (!isRecord(node)) { problems.push('element node must be an object'); return; }
    count += 1;
    if (count > INJECT_MAX_NODES) return; // reported once below
    if (depth > INJECT_MAX_DEPTH) return;
    for (const k of Object.keys(node)) {
      if (!NODE_KEYS.has(k)) problems.push(`unknown element-node field "${k}" (allowed: tag, text, attrs, style, children)`);
    }
    const tag = node.tag;
    if (isRoot && (typeof tag !== 'string' || !tag.trim())) {
      problems.push('the root element node must have a "tag"');
    }
    if (!isRoot && tag === undefined && node.text === undefined) {
      problems.push('a child node needs a "tag" or "text"');
    }
    if (tag !== undefined && (typeof tag !== 'string' || !tag.trim())) {
      problems.push('"tag" must be a non-empty string');
    }
    if (node.text !== undefined && typeof node.text !== 'string') {
      problems.push('"text" must be a string');
    }
    if (node.attrs !== undefined) {
      if (!isRecord(node.attrs)) problems.push('"attrs" must be an object of string values');
      else {
        for (const [name, value] of Object.entries(node.attrs)) {
          if (typeof value !== 'string') { problems.push(`attr "${name}" must be a string`); continue; }
          if (isEventAttr(name)) {
            problems.push(`attr "${name}" is an event handler — inject kinds are static-only; use a script handler for behavior`);
          }
          if (URL_ATTRS.has(name.toLowerCase()) && isJavascriptUrl(value)) {
            problems.push(`attr "${name}" is a javascript: URL — inject kinds are static-only; use a script handler for behavior`);
          }
        }
      }
    }
    if (node.style !== undefined) {
      if (!isRecord(node.style)) problems.push('"style" must be an object of string values');
      else for (const [k, v] of Object.entries(node.style)) {
        if (typeof v !== 'string') problems.push(`style "${k}" must be a string`);
      }
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) problems.push('"children" must be an array');
      else for (const child of node.children) walk(child, depth + 1, false);
    }
  };
  walk(root, 1, true);
  if (count > INJECT_MAX_NODES) problems.push(`element tree has ${count} nodes (max ${INJECT_MAX_NODES})`);
  const depthOf = (node: unknown): number => {
    if (!isRecord(node) || !Array.isArray(node.children) || !node.children.length) return 1;
    return 1 + Math.max(...node.children.map(depthOf));
  };
  if (depthOf(root) > INJECT_MAX_DEPTH) problems.push(`element tree is ${depthOf(root)} levels deep (max ${INJECT_MAX_DEPTH})`);
  return problems;
}

// Heuristic active-content scan for an inject-html string — spec-lint runs in
// main with no DOM, so this is regex-based and warning-grade only (the
// runtime strip pass is the authoritative belt).
function scanHtmlForActiveContent(html: string): string[] {
  const found: string[] = [];
  if (/<script\b/i.test(html)) found.push('the html contains a <script> element');
  if (/\son[a-z]+\s*=/i.test(html)) found.push('the html contains inline event-handler attributes (on*)');
  if (/(?:href|src)\s*=\s*["']?\s*javascript:/i.test(html)) found.push('the html contains a javascript: URL');
  return found;
}

const toKebab = (s: string): string => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

// Build a validated InjectNode tree into real DOM. createElement/textContent
// only — never innerHTML. Defensively skips active attrs even though
// validation already rejected them (belt for hand-edited specs).
function buildElement(node: InjectNode, doc: Document): HTMLElement {
  const el = doc.createElement(typeof node.tag === 'string' && node.tag.trim() ? node.tag : 'span');
  for (const [name, value] of Object.entries(node.attrs || {})) {
    if (typeof value !== 'string') continue;
    if (isEventAttr(name)) continue;
    if (URL_ATTRS.has(name.toLowerCase()) && isJavascriptUrl(value)) continue;
    el.setAttribute(name, value);
  }
  const styleEntries = Object.entries(node.style || {}).filter(([, v]) => typeof v === 'string');
  if (styleEntries.length) {
    el.setAttribute('style', styleEntries.map(([k, v]) => `${toKebab(k)}: ${v}`).join('; '));
  }
  if (typeof node.text === 'string' && node.text) el.appendChild(doc.createTextNode(node.text));
  for (const child of node.children || []) {
    if (child && typeof child.tag === 'string') el.appendChild(buildElement(child, doc));
    else if (child && typeof child.text === 'string') el.appendChild(doc.createTextNode(child.text));
  }
  return el;
}

// Remove active content from a parsed tree in place; returns how many things
// were stripped (elements + attributes). Recurses into <template> content.
function stripActiveContent(root: Element): number {
  let stripped = 0;
  const visit = (el: Element): void => {
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'SCRIPT') { el.remove(); stripped += 1; return; }
    if (typeof (el as { getAttributeNames?: unknown }).getAttributeNames === 'function') {
      for (const name of [...el.getAttributeNames()]) {
        if (isEventAttr(name)) { el.removeAttribute(name); stripped += 1; continue; }
        if (URL_ATTRS.has(name.toLowerCase())) {
          const value = el.getAttribute(name);
          if (value !== null && isJavascriptUrl(value)) { el.removeAttribute(name); stripped += 1; }
        }
      }
    }
    const kids = [...(el.childNodes as unknown as ArrayLike<Node> & Iterable<Node>)];
    for (const child of kids) {
      if ((child as { nodeType?: number }).nodeType === 1) visit(child as Element);
    }
    const content = (el as { content?: Element }).content;
    if (tag === 'TEMPLATE' && content) {
      const inner = [...(content.childNodes as unknown as Iterable<Node>)];
      for (const child of inner) {
        if ((child as { nodeType?: number }).nodeType === 1) visit(child as Element);
      }
    }
  };
  visit(root);
  return stripped;
}

// Parse an inject-html string in a detached (inert) template, strip active
// content, and return the top-level elements. Bare top-level text is wrapped
// in a span so every output is an Element (the mount-strategy path expects
// HTMLElements).
function parseInjectHtml(html: string, doc: Document): { nodes: HTMLElement[]; stripped: number } {
  const tpl = doc.createElement('template') as HTMLTemplateElement;
  tpl.innerHTML = html.slice(0, INJECT_HTML_MAX_CHARS);
  const stripped = stripActiveContent(tpl.content as unknown as Element);
  const nodes: HTMLElement[] = [];
  for (const child of [...tpl.content.childNodes]) {
    if (child.nodeType === 1) nodes.push(child as HTMLElement);
    else if (child.nodeType === 3 && (child.textContent || '').trim()) {
      const span = doc.createElement('span');
      span.textContent = child.textContent;
      nodes.push(span);
    }
  }
  return { nodes, stripped };
}

// Insertion coordinates for a placement relative to the anchor. Null when
// impossible (before/after on a parent-less anchor — realistically only the
// document root); callers treat null as a no-op, not a throw.
function resolvePlacement(
  anchor: Element,
  placement: string | undefined,
): { parent: Node; before: Node | null } | null {
  const p = placement && INJECT_PLACEMENTS.has(placement) ? placement : 'after';
  if (p === 'prepend') return { parent: anchor, before: anchor.firstChild };
  if (p === 'append') return { parent: anchor, before: null };
  const parent = anchor.parentNode;
  if (!parent) return null;
  if (p === 'before') return { parent, before: anchor };
  return { parent, before: anchor.nextSibling };
}

// Engine-injected nodes (and their subtrees) are never anchor candidates:
// without this, a rule whose injected output matches its own anchor selector
// re-matches on every rescan and grows the DOM unboundedly (multi-match
// rules have no witness veto to stop it), and two rules can ping-pong the
// same way. Manual parent walk (not Element.closest) so bare-node harness
// stubs can exercise it.
function isEngineInjected(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    if (typeof node.getAttribute === 'function' && node.getAttribute('data-shim-injected') !== null) return true;
    node = node.parentElement;
  }
  return false;
}

export {
  INJECT_PLACEMENTS, INJECT_MAX_DEPTH, INJECT_MAX_NODES, INJECT_HTML_MAX_CHARS,
  validateInjectTree, scanHtmlForActiveContent, buildElement, stripActiveContent,
  parseInjectHtml, resolvePlacement, isEngineInjected,
};
