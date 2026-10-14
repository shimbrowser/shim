// Leading `@import` rules of a stylesheet's text, and `url()` absolutizing for
// copied rules, for the strict-CSP mirror (style-mirror.ts). Pure and
// DOM-free — covered by scripts/css-imports-harness.
//
// The mirror re-creates a refused <style> as a constructable sheet, but
// `replaceSync()` drops every `@import` rule (CSSOM: constructed sheets can't
// import). A whole-patch `spec.css` may legitimately open with
// `@import url(…)`, so the mirror carries each one over as a
// `<link rel="stylesheet">` — subject to the same `style-src` check the
// `@import` itself would have been. This module only finds them.
//
// Grammar followed (CSS Cascade 5, as Chromium parses it): `@charset` and
// `@layer` *statements* may precede the `@import`s; anything else — including
// a `@layer` statement after an `@import` — ends the import block, and a later
// `@import` is invalid CSS the browser ignores too. The leading `@layer`
// statements are returned as well: they fix the order of layers the imported
// sheets then declare, so the mirror must keep them ahead of its copies.
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
  // The `@layer a, b;` statements before the first `@import`, as written.
  layerStatements: string[];
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

// At an unquoted `url(` token starting at `i`: the index of its closing `)`
// (escape-aware). Its body is raw — `/*`, `;` and `{` there are URL
// characters, not comments or delimiters (CSS Syntax 4.3.6). -1 when `i`
// isn't such a token (a quoted `url("…")` is an ordinary function).
function unquotedUrlEnd(css: string, i: number): number {
  if (css.slice(i, i + 4).toLowerCase() !== 'url(') return -1;
  if (i > 0 && /[\w-]/.test(css.charAt(i - 1))) return -1;
  let j = i + 4;
  while (j < css.length && /\s/.test(css.charAt(j))) j++;
  if (css[j] === '"' || css[j] === "'") return -1;
  return rawUrlEnd(css, j);
}

// From inside an unquoted url token's body: the index of its closing `)`
// (escape-aware), or `css.length` when it never closes.
function rawUrlEnd(css: string, j: number): number {
  for (; j < css.length; j++) {
    if (css[j] === '\\') j++;
    else if (css[j] === ')') return j;
  }
  return css.length;
}

// Index just past the `;` ending the statement at `i` (quote-, comment- and
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
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
    const urlClose = unquotedUrlEnd(css, i);
    if (urlClose >= 0) {
      i = urlClose;
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

// Decode CSS escapes (CSS Syntax 4.3.7) in a string token's or url token's
// body: `\` + 1–6 hex digits is that code point (one following whitespace is
// part of the escape; 0, surrogates and > U+10FFFF become U+FFFD), `\` +
// newline is a line continuation, and `\` + any other character is that
// character.
function unescapeCss(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c !== '\\') {
      out += c;
      continue;
    }
    const hex = /^[0-9a-fA-F]{1,6}/.exec(s.slice(i + 1));
    if (hex) {
      const cp = parseInt(hex[0], 16);
      out += cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff ? '\uFFFD' : String.fromCodePoint(cp);
      i += hex[0].length;
      if (s.startsWith('\r\n', i + 1)) i += 2;
      else if (/^[ \t\n\r\f]/.test(s.charAt(i + 1))) i += 1;
      continue;
    }
    const next = s.charAt(i + 1);
    if (next === '\r') i += s.charAt(i + 2) === '\n' ? 2 : 1;
    else if (next === '\n' || next === '\f') i += 1;
    else if (next) {
      out += next;
      i += 1;
    }
  }
  return out;
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

// The prelude of one `@import` (between the keyword and the `;`). Comments
// are whitespace to the CSS parser, so they're skipped between components —
// but not inside an unquoted `url(…)`, which is one token (CSS Syntax 4.3.6).
function parsePrelude(prelude: string): CssImport | 'unsupported' | null {
  let s = prelude.slice(skipTrivia(prelude, 0));
  let href: string;
  const asString = readString(s);
  if (asString) {
    [href, s] = asString;
  } else if (/^url\(/i.test(s)) {
    s = s.slice(4).trim();
    const inner = readString(s);
    if (inner) {
      [href, s] = inner;
      s = s.slice(skipTrivia(s, 0));
      if (s[0] !== ')') return null;
      s = s.slice(1);
    } else {
      const close = rawUrlEnd(s, 0);
      if (close >= s.length) return null;
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
  const out: LeadingImports = { imports: [], unsupported: 0, layerStatements: [] };
  let seenImport = false;
  let i = 0;
  for (;;) {
    i = skipTrivia(css, i);
    const layer = atKeyword(css, i, 'layer');
    if (atKeyword(css, i, 'charset') || (layer && !seenImport)) {
      const end = statementEnd(css, i);
      if (end < 0) return out; // `@layer x { … }` block: imports are over
      if (layer) out.layerStatements.push(css.slice(i, end));
      i = end;
      continue;
    }
    if (!atKeyword(css, i, 'import')) return out;
    seenImport = true;
    const start = i + '@import'.length;
    const end = statementEnd(css, start);
    if (end < 0) return out;
    const parsed = parsePrelude(css.slice(start, end - 1));
    if (parsed === 'unsupported') out.unsupported++;
    else if (parsed) out.imports.push(parsed);
    i = end;
  }
}

// Rewrite every relative `url(…)` in `css` to an absolute URL resolved
// against `base` (the URL of the sheet the text came from). The mirror copies
// an imported sheet's rules into constructed sheets, and Chromium resolves a
// constructed sheet's `url()`s against the DOCUMENT — it ignores the
// `baseURL` option — so a copied rule's relative URL would otherwise point
// somewhere else. Strings and comments are skipped (a `url(` inside
// `content: "…"` is text), fragment-only `url(#id)` references are left as
// written (they name the current document), and anything that fails to
// resolve is left untouched.
export function absolutizeUrls(css: string, base: string): string {
  let out = '';
  let i = 0;
  let from = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < css.length && css[i] !== c) i += css[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close < 0 ? css.length : close + 2;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (css.slice(i, i + 4).toLowerCase() !== 'url(' || (i > 0 && /[\w-]/.test(css.charAt(i - 1)))) {
      i++;
      continue;
    }
    const argStart = skipTrivia(css, i + 4);
    let value: string;
    let close: number;
    const quoted = readString(css.slice(argStart));
    if (quoted) {
      value = quoted[0];
      const after = css.length - quoted[1].length;
      close = skipTrivia(css, after);
      if (css[close] !== ')') { i = after; continue; }
    } else {
      close = unquotedUrlEnd(css, i);
      if (close < 0 || close >= css.length) break;
      value = unescapeCss(css.slice(argStart, close).trim());
    }
    let resolved: string | null = null;
    if (value && !value.startsWith('#')) {
      try {
        resolved = new URL(value, base).href;
      } catch {
        resolved = null;
      }
    }
    if (resolved !== null && resolved !== value) {
      out += `${css.slice(from, i)}url(${JSON.stringify(resolved)})`;
      from = close + 1;
    }
    i = close + 1;
  }
  return out + css.slice(from);
}
