// Bare-node harness for src/patch-engine/inject-kinds.ts (CLAUDE.md §6).
// DOM-free: builder/strip/placement run against minimal structural stubs.
import {
  INJECT_PLACEMENTS, INJECT_MAX_DEPTH, INJECT_MAX_NODES, INJECT_HTML_MAX_CHARS,
  validateInjectTree, scanHtmlForActiveContent, buildElement, stripActiveContent,
  resolvePlacement, isEngineInjected,
} from '../src/patch-engine/inject-kinds';
import type { InjectNode } from '../src/patch-engine/types';

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) { console.log(`  ok  ${label}`); return; }
  failures += 1;
  console.error(`  FAIL ${label}`);
}

// ---- stub DOM ----------------------------------------------------------
interface StubNode {
  nodeType: number;
  tagName?: string;
  data?: string;
  attrs: Map<string, string>;
  childNodes: StubNode[];
  parent: StubNode | null;
  content?: StubNode; // template
  setAttribute(n: string, v: string): void;
  getAttribute(n: string): string | null;
  getAttributeNames(): string[];
  removeAttribute(n: string): void;
  appendChild(c: StubNode): StubNode;
  remove(): void;
}
function elStub(tag: string): StubNode {
  const node: StubNode = {
    nodeType: 1, tagName: tag.toUpperCase(), attrs: new Map(), childNodes: [], parent: null,
    setAttribute(n, v) { node.attrs.set(n, v); },
    getAttribute(n) { const v = node.attrs.get(n); return v === undefined ? null : v; },
    getAttributeNames() { return [...node.attrs.keys()]; },
    removeAttribute(n) { node.attrs.delete(n); },
    appendChild(c) { c.parent = node; node.childNodes.push(c); return c; },
    remove() {
      if (!node.parent) return;
      node.parent.childNodes = node.parent.childNodes.filter((c) => c !== node);
      node.parent = null;
    },
  };
  // isEngineInjected walks Element.parentElement (not Element.closest, so
  // this bare-node stub can exercise it) — mirror the mutable `parent` field
  // as a getter so appendChild-established parentage is visible that way too.
  Object.defineProperty(node, 'parentElement', { get: () => node.parent, configurable: true });
  return node;
}
function textStub(data: string): StubNode {
  const node = elStub('#text');
  node.nodeType = 3; node.data = data; delete node.tagName;
  return node;
}
const docStub = {
  createElement: (tag: string) => elStub(tag),
  createTextNode: (data: string) => textStub(data),
} as unknown as Document;

// ---- validateInjectTree ------------------------------------------------
function tValidate(): void {
  console.log('validateInjectTree:');
  assert(validateInjectTree({ tag: 'span', text: 'hi' }).length === 0, 'minimal valid tree');
  assert(validateInjectTree({ text: 'hi' }).length > 0, 'root without tag rejected');
  assert(validateInjectTree('x').length > 0, 'non-object rejected');
  assert(validateInjectTree({ tag: 'span', bogus: 1 }).length > 0, 'unknown field rejected');
  assert(validateInjectTree({ tag: 'a', attrs: { onclick: 'x()' } }).length > 0, 'on* attr is an error');
  assert(validateInjectTree({ tag: 'a', attrs: { href: 'javascript:x()' } }).length > 0, 'javascript: href is an error');
  assert(validateInjectTree({ tag: 'a', attrs: { href: ' JaVaScRiPt\t:x()' } }).length > 0, 'obfuscated javascript: caught');
  assert(validateInjectTree({ tag: 'a', attrs: { href: '/notes' } }).length === 0, 'plain href fine');
  assert(validateInjectTree({ tag: 'div', children: [{ text: 'ok' }, { tag: 'b', text: 'bold' }] }).length === 0, 'text-only child fine');
  assert(validateInjectTree({ tag: 'div', children: [{}] }).length > 0, 'empty child (no tag, no text) rejected');
  // depth cap: build a chain of depth INJECT_MAX_DEPTH+1
  let deep: InjectNode = { tag: 'i', text: 'x' };
  for (let i = 0; i < INJECT_MAX_DEPTH; i += 1) deep = { tag: 'div', children: [deep] };
  assert(validateInjectTree(deep).length > 0, 'depth cap enforced');
  // depth cap, at the boundary: a tree exactly INJECT_MAX_DEPTH deep is fine
  let atCapDepth: InjectNode = { tag: 'i', text: 'x' };
  for (let i = 0; i < INJECT_MAX_DEPTH - 1; i += 1) atCapDepth = { tag: 'div', children: [atCapDepth] };
  assert(validateInjectTree(atCapDepth).length === 0, 'depth exactly at cap validates clean');
  // node cap
  const wide: InjectNode = { tag: 'div', children: Array.from({ length: INJECT_MAX_NODES }, () => ({ text: 'x' })) };
  assert(validateInjectTree(wide).length > 0, 'node-count cap enforced');
  // node cap, at the boundary: root + (INJECT_MAX_NODES - 1) children = exactly INJECT_MAX_NODES total nodes
  const atCapNodes: InjectNode = { tag: 'div', children: Array.from({ length: INJECT_MAX_NODES - 1 }, () => ({ text: 'x' })) };
  assert(validateInjectTree(atCapNodes).length === 0, 'node count exactly at cap validates clean');
  assert(validateInjectTree({ tag: 'span', style: { fontSize: '12px' } }).length === 0, 'camelCase style key fine');
  assert(validateInjectTree({ tag: 'span', attrs: { class: 'site-btn' } }).length === 0, 'class attr allowed');
}

// ---- scanHtmlForActiveContent ------------------------------------------
function tScanHtml(): void {
  console.log('scanHtmlForActiveContent:');
  assert(scanHtmlForActiveContent('<span>hi</span>').length === 0, 'clean html silent');
  assert(scanHtmlForActiveContent('<script>x()</script>').length === 1, 'script flagged');
  assert(scanHtmlForActiveContent('<a onclick="x()">y</a>').length === 1, 'on* flagged');
  assert(scanHtmlForActiveContent('<a href="javascript:x()">y</a>').length === 1, 'javascript: flagged');
  assert(scanHtmlForActiveContent('<i data-online="1">contains the letters o-n</i>').length === 0, 'no false positive on data-online');
}

// ---- buildElement ------------------------------------------------------
function tBuild(): void {
  console.log('buildElement:');
  const built = buildElement({
    tag: 'a',
    text: 'lead',
    attrs: { href: '/x', class: 'c' },
    style: { fontSize: '12px', color: 'red' },
    children: [{ tag: 'b', text: 'kid' }, { text: 'tail' }],
  }, docStub) as unknown as StubNode;
  assert(built.tagName === 'A', 'root tag');
  assert(built.getAttribute('href') === '/x', 'attrs set');
  const style = built.getAttribute('style') || '';
  assert(style.includes('font-size: 12px') && style.includes('color: red'), 'style camelCase→kebab inline');
  assert(built.childNodes.length === 3, 'text-first + two children');
  const [builtChild0, builtChild1, builtChild2] = built.childNodes;
  assert(builtChild0 !== undefined && builtChild0.nodeType === 3 && builtChild0.data === 'lead', 'text becomes first text node');
  assert(builtChild1 !== undefined && builtChild1.tagName === 'B', 'element child built');
  assert(builtChild2 !== undefined && builtChild2.nodeType === 3 && builtChild2.data === 'tail', 'text-only child = text node');
  // defensive: builder skips active attrs even if validation was bypassed
  const sneaky = buildElement({ tag: 'a', attrs: { onclick: 'x()', href: 'javascript:y()' } }, docStub) as unknown as StubNode;
  assert(sneaky.getAttribute('onclick') === null, 'builder drops on* defensively');
  assert(sneaky.getAttribute('href') === null, 'builder drops javascript: URL defensively');
}

// ---- stripActiveContent ------------------------------------------------
function tStrip(): void {
  console.log('stripActiveContent:');
  const root = elStub('div');
  const s = elStub('script'); root.appendChild(s);
  const a = elStub('a'); a.setAttribute('onclick', 'x()'); a.setAttribute('onMouseOver', 'y()');
  a.setAttribute('href', 'javascript:z()'); root.appendChild(a);
  const tpl = elStub('template'); tpl.content = elStub('div');
  const nested = elStub('script'); tpl.content.appendChild(nested); root.appendChild(tpl);
  const ok = elStub('a'); ok.setAttribute('href', '/fine'); root.appendChild(ok);
  const n = stripActiveContent(root as unknown as Element);
  assert(n === 5, `strip count 5 (got ${n})`);
  assert(root.childNodes.every((c) => c.tagName !== 'SCRIPT'), 'script removed');
  assert(a.getAttribute('onclick') === null && a.getAttribute('onMouseOver') === null, 'on* removed case-insensitively');
  assert(a.getAttribute('href') === null, 'javascript: href removed');
  assert(tpl.content !== undefined && tpl.content.childNodes.length === 0, 'template-nested script removed');
  assert(ok.getAttribute('href') === '/fine', 'benign href kept');
}

// ---- resolvePlacement --------------------------------------------------
function tPlacement(): void {
  console.log('resolvePlacement:');
  const parent = elStub('div');
  const anchor = elStub('p'); const sib = elStub('p');
  parent.appendChild(anchor); parent.appendChild(sib);
  const kid = elStub('i'); anchor.appendChild(kid);
  // stubs need parentNode/nextSibling/firstChild for this test
  const withDom = (node: StubNode): Element => {
    Object.defineProperty(node, 'parentNode', { get: () => node.parent, configurable: true });
    Object.defineProperty(node, 'nextSibling', {
      get: () => {
        if (!node.parent) return null;
        const i = node.parent.childNodes.indexOf(node);
        return node.parent.childNodes[i + 1] || null;
      }, configurable: true,
    });
    Object.defineProperty(node, 'firstChild', { get: () => node.childNodes[0] || null, configurable: true });
    return node as unknown as Element;
  };
  const el = withDom(anchor);
  const before = resolvePlacement(el, 'before');
  assert(before !== null && before.parent === (parent as unknown as Node) && before.before === (anchor as unknown as Node), 'before → parent + anchor');
  const after = resolvePlacement(el, undefined);
  assert(after !== null && after.before === (sib as unknown as Node), 'default after → nextSibling');
  const prep = resolvePlacement(el, 'prepend');
  assert(prep !== null && prep.parent === (anchor as unknown as Node) && prep.before === (kid as unknown as Node), 'prepend → firstChild');
  const app = resolvePlacement(el, 'append');
  assert(app !== null && app.parent === (anchor as unknown as Node) && app.before === null, 'append → null');
  const orphan = withDom(elStub('p'));
  assert(resolvePlacement(orphan, 'after') === null, 'no-parent before/after → null');
  assert(resolvePlacement(orphan, 'append') !== null, 'no-parent append still fine');
}

function tConstants(): void {
  console.log('constants:');
  assert(INJECT_PLACEMENTS.has('before') && INJECT_PLACEMENTS.has('after')
    && INJECT_PLACEMENTS.has('prepend') && INJECT_PLACEMENTS.has('append')
    && INJECT_PLACEMENTS.size === 4, 'placement enum');
  assert(INJECT_HTML_MAX_CHARS === 32768, 'html cap');
}

// ---- isEngineInjected (self-injection-runaway guard) -------------------
// Engine-injected nodes (and their subtrees) must never be treated as anchor
// candidates by the scan loop (engine.ts) — see the header comment on
// isEngineInjected in inject-kinds.ts for why (unbounded DOM growth when an
// injected root matches its own rule's anchor selector).
function tInjectedGuard(): void {
  console.log('isEngineInjected:');
  const injected = elStub('div');
  injected.setAttribute('data-shim-injected', 'tok-1');
  assert(isEngineInjected(injected as unknown as Element) === true, 'element carrying data-shim-injected is flagged');

  const plain = elStub('div');
  assert(isEngineInjected(plain as unknown as Element) === false, 'plain element (no ancestor injected) is not flagged');

  const child = elStub('span');
  injected.appendChild(child);
  assert(isEngineInjected(child as unknown as Element) === true, 'descendant of an injected element is flagged (walks up via parentElement)');
}

tValidate(); tScanHtml(); tBuild(); tStrip(); tPlacement(); tConstants(); tInjectedGuard();
if (failures) { console.error(`\n${failures} failure(s)`); process.exitCode = 1; }
else console.log('\nall inject-kinds checks passed');
