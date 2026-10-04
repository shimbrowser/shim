// Leading `@import` rules of a stylesheet's text, for the strict-CSP mirror
// (style-mirror.ts). Pure and DOM-free — covered by scripts/css-imports-harness.
//
// The mirror re-creates a refused <style> as a constructable sheet, but
// `replaceSync()` drops every `@import` rule (CSSOM: constructed sheets can't
// import). A whole-patch `spec.css` may legitimately open with
// `@import url(…)`, so the mirror carries each one over as a
// `<link rel="stylesheet">` — subject to the same `style-src` check the
// `@import` itself would have been. This module only finds them.
//
// Grammar followed (CSS Cascade 5): `@import` rules must precede every other
// rule except `@charset` and `@layer` *statements*; anything else ends the
// import block, and a later `@import` is invalid CSS the browser ignores too.
// A `<link>` can express a URL plus a media query list, but not the
// `layer(…)` / `layer` or `supports(…)` conditions — those imports are
// reported as `unsupported` rather than linked with the wrong semantics.

export interface CssImport {
  href: string;
  media: string;
}

export interface LeadingImports {
  imports: CssImport[];
  unsupported: number;
}

function skipTrivia(css: string, i: number): number {
  for (;;) {
    while (i < css.length && /\s/.test(css.charAt(i))) i++;
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) return css.length;
      i = end + 2;
      continue;
    }
    return i;
  }
}

// Index just past the `;` ending the statement at `i` (quote- and
// paren-aware), or -1 when a `{` comes first / the text ends — i.e. the
// at-rule is a block, not a statement.
function statementEnd(css: string, i: number): number {
  let depth = 0;
  let quote = '';
  for (; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '\\') i++;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === '{' && depth === 0) return -1;
    else if (c === ';' && depth === 0) return i + 1;
  }
  return -1;
}

function atKeyword(css: string, i: number, name: string): boolean {
  if (css.slice(i, i + name.length + 1).toLowerCase() !== `@${name}`) return false;
  const next = css[i + name.length + 1];
  return next === undefined || !/[\w-]/.test(next);
}

function unescapeCss(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

// `"…"` / `'…'` at the start of `s` → [value, rest], else null.
function readString(s: string): [string, string] | null {
  const q = s[0];
  if (q !== '"' && q !== "'") return null;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === q) return [unescapeCss(s.slice(1, i)), s.slice(i + 1)];
  }
  return null;
}

// The prelude of one `@import` (between the keyword and the `;`).
function parsePrelude(prelude: string): CssImport | 'unsupported' | null {
  let s = prelude.trim();
  let href: string;
  const asString = readString(s);
  if (asString) {
    [href, s] = asString;
  } else if (/^url\(/i.test(s)) {
    s = s.slice(4).trim();
    const inner = readString(s);
    if (inner) {
      [href, s] = inner;
      s = s.trim();
      if (s[0] !== ')') return null;
      s = s.slice(1);
    } else {
      const close = s.indexOf(')');
      if (close < 0) return null;
      href = unescapeCss(s.slice(0, close).trim());
      s = s.slice(close + 1);
    }
  } else {
    return null;
  }
  if (!href) return null;
  const media = s.replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  if (/^layer\b/i.test(media) || /^supports\s*\(/i.test(media)) return 'unsupported';
  return { href, media };
}

export function leadingImports(css: string): LeadingImports {
  const out: LeadingImports = { imports: [], unsupported: 0 };
  let i = 0;
  for (;;) {
    i = skipTrivia(css, i);
    if (atKeyword(css, i, 'charset') || atKeyword(css, i, 'layer')) {
      const end = statementEnd(css, i);
      if (end < 0) return out; // `@layer x { … }` block: imports are over
      i = end;
      continue;
    }
    if (!atKeyword(css, i, 'import')) return out;
    const start = i + '@import'.length;
    const end = statementEnd(css, start);
    if (end < 0) return out;
    const parsed = parsePrelude(css.slice(start, end - 1));
    if (parsed === 'unsupported') out.unsupported++;
    else if (parsed) out.imports.push(parsed);
    i = end;
  }
}
