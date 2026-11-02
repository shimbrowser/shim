// Pure logic for the Tier-2 declarative injection kinds — `inject-element`
// and `inject-html`. Static-only by contract: nothing that executes, embeds
// another document, or changes where the page navigates or submits —
// behavior belongs in `script` handlers where api.cleanup + self-healing
// apply. One policy (blockedTagReason + activeAttrReason) backs the lint
// validation, the html scan, the builder and the strip, so they can't
// disagree. Validation/scan run in main (spec-lint) with no DOM;
// builder/strip/placement run in the page's isolated world.
// Everything is bare-node testable (packages/core/test/inject-kinds-harness.ts).
import type { InjectNode } from './types';
import { isRecord } from './is-record';

const INJECT_PLACEMENTS = new Set(['before', 'after', 'prepend', 'append']);
const INJECT_MAX_DEPTH = 8;
const INJECT_MAX_NODES = 50;
const INJECT_HTML_MAX_CHARS = 32768;

const NODE_KEYS = new Set(['tag', 'text', 'attrs', 'style', 'children']);

// Elements that run script or load another document, or that change how the
// surrounding page resolves, refreshes or fetches. A <style> element stays:
// CSS is a shim's own capability (restyle reaches the same page).
const BLOCKED_TAGS = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'portal', 'fencedframe', 'base', 'meta', 'link',
]);
const FORM_TARGET_ATTRS = new Set(['action', 'formaction']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'data', 'poster', 'background', 'cite', 'srcset']);
// SMIL can write an attribute after every static check has run, so an
// animation may not target a URL attribute or an event handler.
const ANIMATION_TAGS = new Set(['animate', 'set', 'animatemotion', 'animatetransform']);
const ANIMATED_ACTIVE_ATTR = /^(?:href|xlink:href|src|on.*)$/i;
// data: stays only where it's plain media: an inline image on an <img>.
const DATA_URL_TAGS = new Set(['img', 'image', 'source', 'video', 'audio', 'input']);
const DATA_URL_ATTRS = new Set(['src', 'href', 'xlink:href', 'poster', 'srcset']);
const DATA_MEDIA_URL = /^data:(?:image|audio|video)\//;

// Browsers strip ASCII whitespace and control chars from a URL's scheme before
// matching, so "  JavaScript\t:" executes — normalize the same way before
// comparing (the classic bypass). A char-code filter (not a regex control-char
// range) sidesteps ESLint's no-control-regex rule while doing the identical strip.
function normalizeUrl(value: string): string {
  let stripped = '';
  for (const ch of value) {
    if (ch.charCodeAt(0) > 0x20) stripped += ch;
  }
  return stripped.toLowerCase();
}

function isEventAttr(name: string): boolean {
  return /^on/i.test(name);
}

function normalizeTag(tag: unknown): string {
  return typeof tag === 'string' ? tag.trim().toLowerCase() : '';
}

function isBlockedTag(tag: unknown): boolean {
  return BLOCKED_TAGS.has(normalizeTag(tag));
}

// Why an attribute can't appear on `tag`, or null when it's static.
function activeAttrReason(tag: string, name: string, value: string): string | null {
  const attr = name.toLowerCase();
  if (isEventAttr(attr)) return 'an event handler';
  if (attr === 'srcdoc') return 'inline frame content';
  if (FORM_TARGET_ATTRS.has(attr)) return 'a form submission target';
  if (attr === 'ping') return 'a click beacon';
  if (ANIMATION_TAGS.has(tag) && attr === 'attributename' && ANIMATED_ACTIVE_ATTR.test(value.trim())) {
    return 'an animation of a URL or event attribute';
  }
  if (!URL_ATTRS.has(attr)) return null;
  const url = normalizeUrl(value);
  if (url.startsWith('javascript:')) return 'a javascript: URL';
  if (url.startsWith('vbscript:')) return 'a vbscript: URL';
  if (url.startsWith('data:')
    && !(DATA_URL_TAGS.has(tag) && DATA_URL_ATTRS.has(attr) && DATA_MEDIA_URL.test(url))) {
    return 'a data: URL outside an inline image, audio or video';
  }
  if (tag === 'use' && (attr === 'href' || attr === 'xlink:href') && !url.startsWith('#')) {
    return 'an external <use> reference';
  }
  return null;
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
    if (isBlockedTag(tag)) {
      problems.push(`tag "${normalizeTag(tag)}" is active content — inject kinds are static-only; use a script handler for behavior`);
    }
    if (node.text !== undefined && typeof node.text !== 'string') {
      problems.push('"text" must be a string');
    }
    if (node.attrs !== undefined) {
      if (!isRecord(node.attrs)) problems.push('"attrs" must be an object of string values');
      else {
        for (const [name, value] of Object.entries(node.attrs)) {
          if (typeof value !== 'string') { problems.push(`attr "${name}" must be a string`); continue; }
          const reason = activeAttrReason(normalizeTag(tag), name, value);
          if (reason) {
            problems.push(`attr "${name}" is ${reason} — inject kinds are static-only; use a script handler for behavior`);
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

const NAMED_ENTITIES: Record<string, string> = {
  colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')', amp: '&', quot: '"', apos: "'",
};

// Enough entity decoding for the scan to read a value the way the parser will
// ("java&#115;cript&colon;x"). Numeric references don't need their semicolon.
function decodeEntities(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));?/gi, (whole, hex, dec, named) => {
    if (named !== undefined) return NAMED_ENTITIES[String(named).toLowerCase()] ?? whole;
    const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

// Heuristic active-content scan for an inject-html string — spec-lint runs in
// main with no DOM, so this tokenizes tags by regex and is warning-grade only
// (the runtime strip pass is the authoritative belt). It reads only the prefix
// the runtime parses, and applies the same policy to what it finds.
function scanHtmlForActiveContent(html: string): string[] {
  const found = new Set<string>();
  const markup = html.slice(0, INJECT_HTML_MAX_CHARS).replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const element of markup.matchAll(/<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)/g)) {
    const tag = (element[1] ?? '').toLowerCase();
    if (isBlockedTag(tag)) found.add(`the html contains a <${tag}> element`);
    for (const attr of (element[2] ?? '').matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const name = (attr[1] ?? '').toLowerCase();
      const reason = activeAttrReason(tag, name, decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? ''));
      if (reason) found.add(`the html contains ${reason} (${name})`);
    }
  }
  return [...found];
}

const toKebab = (s: string): string => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

// Build a validated InjectNode tree into real DOM. createElement/textContent
// only — never innerHTML. Defensively skips active tags and attrs even though
// validation already rejected them (belt for hand-edited specs): a blocked
// root builds an empty span, a blocked child builds nothing.
function buildElement(node: InjectNode, doc: Document): HTMLElement {
  if (isBlockedTag(node.tag)) return doc.createElement('span');
  const el = doc.createElement(typeof node.tag === 'string' && node.tag.trim() ? node.tag : 'span');
  const tag = normalizeTag(el.tagName);
  for (const [name, value] of Object.entries(node.attrs || {})) {
    if (typeof value !== 'string') continue;
    if (activeAttrReason(tag, name, value)) continue;
    el.setAttribute(name, value);
  }
  const styleEntries = Object.entries(node.style || {}).filter(([, v]) => typeof v === 'string');
  if (styleEntries.length) {
    el.setAttribute('style', styleEntries.map(([k, v]) => `${toKebab(k)}: ${v}`).join('; '));
  }
  if (typeof node.text === 'string' && node.text) el.appendChild(doc.createTextNode(node.text));
  for (const child of node.children || []) {
    if (child && typeof child.tag === 'string') {
      if (!isBlockedTag(child.tag)) el.appendChild(buildElement(child, doc));
    }
    else if (child && typeof child.text === 'string') el.appendChild(doc.createTextNode(child.text));
  }
  return el;
}

// Remove active content from a parsed tree in place; returns how many things
// were stripped (elements + attributes). Recurses into <template> content.
function stripActiveContent(root: Element): number {
  let stripped = 0;
  const visit = (el: Element): void => {
    const tag = (el.tagName || '').toLowerCase();
    if (BLOCKED_TAGS.has(tag)) { el.remove(); stripped += 1; return; }
    if (typeof (el as { getAttributeNames?: unknown }).getAttributeNames === 'function') {
      for (const name of [...el.getAttributeNames()]) {
        if (activeAttrReason(tag, name, el.getAttribute(name) ?? '')) {
          el.removeAttribute(name);
          stripped += 1;
        }
      }
    }
    const kids = [...(el.childNodes as unknown as ArrayLike<Node> & Iterable<Node>)];
    for (const child of kids) {
      if ((child as { nodeType?: number }).nodeType === 1) visit(child as Element);
    }
    const content = (el as { content?: Element }).content;
    if (tag === 'template' && content) {
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
