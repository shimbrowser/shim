// Path scope for a shim (D18): which pages of its hosts a shim runs on.
//
// A shim's `match.paths` is a list of entries. Each is a glob, or a regex when
// it starts with `re:`; a leading `!` makes it an exclude. A URL is in scope
// when an include matches (or there are none) and no exclude matches. A list
// with any entry that doesn't compile is out of scope everywhere: a pattern
// the person can't see working must never widen a shim to the whole site.
//
// Globs see the pathname, and the hash too when the glob contains `#`; they
// never see the query. `*` matches within one segment, a whole `**` segment
// matches any number of segments (none included), `{a,b}` is a choice, `\`
// escapes the next character, and a trailing `/` is ignored on both sides.
//
// Regexes see pathname + query + hash as the URL serializes them, and agree
// with `new RegExp(source).test(subject)`, no flags. They never run on
// `RegExp`, which has no time limit: they compile here to an automaton whose
// size is computed from the syntax tree before anything expands, and match in
// one Thompson pass. Globs compile to the same automaton. So matching a list
// costs at most subject length × total states, both capped below.
//
// Zero dependencies, no Node: hosts call it wherever they decide scope.

export const PATH_SCOPE_LIMITS = {
  entries: 50,
  entryChars: 200,
  patternStates: 2000,
  listStates: 4000,
  depth: 10,
  repeatCount: 1000,
  subjectChars: 2048,
} as const;

export interface UrlParts {
  pathname: string;
  search: string;
  hash: string;
}

export type PathEntryKind = 'glob' | 'regex';

export interface PathEntry {
  text: string;
  kind: PathEntryKind;
  exclude: boolean;
}

export type PathEntryResult =
  | { ok: true; entry: PathEntry; states: number }
  | { ok: false; text: string; error: string };

// ─── Automaton ───────────────────────────────────────────────────────────────

// A set of UTF-16 code units: sorted inclusive ranges, optionally negated.
interface CharSet { ranges: Array<[number, number]>; negate: boolean }

type Node =
  | { t: 'char'; set: CharSet }
  | { t: 'cat'; items: Node[] }
  | { t: 'alt'; items: Node[] }
  | { t: 'rep'; item: Node; min: number; max: number } // max -1: unbounded
  | { t: 'bol' }
  | { t: 'eol' };

const EMPTY: Node = { t: 'cat', items: [] };

const enum S { Char, Split, Bol, Eol, Match }

interface Program {
  kind: Int8Array;
  out: Int32Array;
  out2: Int32Array;
  sets: Array<CharSet | null>;
  start: number;
}

// States the node expands to, saturating at cap + 1 so nested counts never
// overflow or allocate. Mirrors `emit` exactly: char 1, alt n-1 splits,
// bol/eol 1, rep min copies + (unbounded ? one copy + a split : (max-min)
// copies + a split each).
function stateCount(n: Node, cap: number): number {
  const sat = (v: number) => (v > cap ? cap + 1 : v);
  switch (n.t) {
    case 'char': case 'bol': case 'eol': return 1;
    case 'cat': {
      let s = 0;
      for (const i of n.items) { s = sat(s + stateCount(i, cap)); if (s > cap) return s; }
      return s;
    }
    case 'alt': {
      let s = n.items.length - 1;
      for (const i of n.items) { s = sat(s + stateCount(i, cap)); if (s > cap) return s; }
      return s;
    }
    case 'rep': {
      const one = stateCount(n.item, cap);
      if (one > cap) return one;
      const copies = n.max === -1 ? n.min + 1 : n.max;
      const splits = n.max === -1 ? 1 : n.max - n.min;
      return sat(one * copies + splits);
    }
  }
}

class Builder {
  kind: number[] = [];
  out: number[] = [];
  out2: number[] = [];
  sets: Array<CharSet | null> = [];
  add(k: S, set: CharSet | null = null): number {
    this.kind.push(k); this.out.push(-1); this.out2.push(-1); this.sets.push(set);
    return this.kind.length - 1;
  }
}

// A fragment: its entry state and the dangling exits to patch.
interface Frag { start: number; exits: Array<[number, 1 | 2]> }

function patch(b: Builder, exits: Array<[number, 1 | 2]>, to: number): void {
  for (const [s, which] of exits) { if (which === 1) b.out[s] = to; else b.out2[s] = to; }
}

// Returns null for an empty fragment (no states: an empty match).
function emit(b: Builder, n: Node): Frag | null {
  switch (n.t) {
    case 'char': { const s = b.add(S.Char, n.set); return { start: s, exits: [[s, 1]] }; }
    case 'bol': { const s = b.add(S.Bol); return { start: s, exits: [[s, 1]] }; }
    case 'eol': { const s = b.add(S.Eol); return { start: s, exits: [[s, 1]] }; }
    case 'cat': {
      let first: Frag | null = null;
      let exits: Array<[number, 1 | 2]> = [];
      for (const item of n.items) {
        const f = emit(b, item);
        if (!f) continue;
        if (!first) first = f; else patch(b, exits, f.start);
        exits = f.exits;
      }
      return first ? { start: first.start, exits } : null;
    }
    case 'alt': {
      // Right-nested splits: n-1 of them for n branches.
      const frags = n.items.map((i) => emit(b, i));
      return altOf(b, frags);
    }
    case 'rep': {
      const parts: Array<Frag | null> = [];
      for (let i = 0; i < n.min; i++) parts.push(emit(b, n.item));
      if (n.max === -1) parts.push(star(b, n.item));
      else for (let i = n.min; i < n.max; i++) parts.push(optional(b, n.item));
      return catOf(b, parts);
    }
  }
}

function catOf(b: Builder, frags: Array<Frag | null>): Frag | null {
  let first: Frag | null = null;
  let exits: Array<[number, 1 | 2]> = [];
  for (const f of frags) {
    if (!f) continue;
    if (!first) first = f; else patch(b, exits, f.start);
    exits = f.exits;
  }
  return first ? { start: first.start, exits } : null;
}

function altOf(b: Builder, frags: Array<Frag | null>): Frag | null {
  if (frags.length === 1) return frags[0] ?? null;
  const [head, ...rest] = frags;
  const tail = altOf(b, rest);
  const s = b.add(S.Split);
  const exits: Array<[number, 1 | 2]> = [];
  if (head) { b.out[s] = head.start; exits.push(...head.exits); } else exits.push([s, 1]);
  if (tail) { b.out2[s] = tail.start; exits.push(...tail.exits); } else exits.push([s, 2]);
  return { start: s, exits };
}

function optional(b: Builder, item: Node): Frag {
  const f = emit(b, item);
  const s = b.add(S.Split);
  if (!f) return { start: s, exits: [[s, 1], [s, 2]] };
  b.out[s] = f.start;
  return { start: s, exits: [...f.exits, [s, 2]] };
}

function star(b: Builder, item: Node): Frag {
  const f = emit(b, item);
  const s = b.add(S.Split);
  if (!f) return { start: s, exits: [[s, 1], [s, 2]] };
  b.out[s] = f.start;
  patch(b, f.exits, s);
  return { start: s, exits: [[s, 2]] };
}

// Collapses every part that expands to no states, so building does no more
// work than the state count says: `(((){1000}){1000}){1000}` is zero states,
// and without this it would still make a billion empty copies.
function prune(n: Node, cap: number): Node {
  if (stateCount(n, cap) === 0) return EMPTY;
  switch (n.t) {
    case 'cat': return { t: 'cat', items: n.items.map((i) => prune(i, cap)) };
    case 'alt': return { t: 'alt', items: n.items.map((i) => prune(i, cap)) };
    case 'rep': return { t: 'rep', item: prune(n.item, cap), min: n.min, max: n.max };
    default: return n;
  }
}

// Only for a node whose state count is within the cap.
function compileNode(node: Node): Program {
  const n = prune(node, PATH_SCOPE_LIMITS.patternStates);
  const b = new Builder();
  const f = emit(b, n);
  const m = b.add(S.Match);
  let start = m;
  if (f) { patch(b, f.exits, m); start = f.start; }
  return {
    kind: Int8Array.from(b.kind),
    out: Int32Array.from(b.out),
    out2: Int32Array.from(b.out2),
    sets: b.sets,
    start,
  };
}

function inSet(set: CharSet, c: number): boolean {
  let hit = false;
  for (const [lo, hi] of set.ranges) { if (c >= lo && c <= hi) { hit = true; break; } }
  return hit !== set.negate;
}

// Unanchored search, as RegExp.prototype.test: a match starting anywhere.
// Each step's closure visits a state at most once, so a nullable loop can't
// spin, and the whole run is at most (length + 1) × states.
function run(p: Program, input: string): boolean {
  const n = p.kind.length;
  const mark = new Int32Array(n).fill(-1);
  let clist: number[] = [];
  const stack: number[] = [];
  const len = input.length;
  const close = (list: number[], from: number, pos: number, gen: number): boolean => {
    stack.push(from);
    while (stack.length) {
      const s = stack.pop() as number;
      if (s < 0 || mark[s] === gen) continue;
      mark[s] = gen;
      switch (p.kind[s]) {
        case S.Match: return true;
        case S.Char: list.push(s); break;
        case S.Split: stack.push(p.out2[s] ?? -1, p.out[s] ?? -1); break;
        case S.Bol: if (pos === 0) stack.push(p.out[s] ?? -1); break;
        case S.Eol: if (pos === len) stack.push(p.out[s] ?? -1); break;
      }
    }
    return false;
  };
  for (let pos = 0; pos <= len; pos++) {
    // States carried from the last step were closed under generation `pos`
    // already; the fresh start joins the same generation.
    if (close(clist, p.start, pos, pos)) { stack.length = 0; return true; }
    if (pos === len) break;
    const c = input.charCodeAt(pos);
    const nlist: number[] = [];
    for (const s of clist) {
      const set = p.sets[s];
      if (set && inSet(set, c) && close(nlist, p.out[s] ?? -1, pos + 1, pos + 1)) { stack.length = 0; return true; }
    }
    clist = nlist;
  }
  return false;
}

// ─── Regex parser ────────────────────────────────────────────────────────────

class Refused extends Error {}

const DIGIT: Array<[number, number]> = [[0x30, 0x39]];
const WORD: Array<[number, number]> = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];
// ECMAScript WhiteSpace and LineTerminator.
const SPACE: Array<[number, number]> = [
  [0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff],
];
const LINE_TERMINATORS: Array<[number, number]> = [[0x0a, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]];

// The code units outside sorted, disjoint ranges.
function complement(ranges: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let next = 0;
  for (const [lo, hi] of ranges) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= 0xffff) out.push([next, 0xffff]);
  return out;
}

const ch = (c: number): Node => ({ t: 'char', set: { ranges: [[c, c]], negate: false } });
const cls = (ranges: Array<[number, number]>, negate: boolean): Node => ({ t: 'char', set: { ranges, negate } });

const SYNTAX = '^$\\.*+?()[]{}|/-';

class RegexParser {
  private i = 0;
  private depth = 0;
  constructor(private readonly src: string) {}

  parse(): Node {
    const n = this.alt();
    if (this.i < this.src.length) {
      // Only an unmatched `)` stops alt() early.
      throw new Refused(`unmatched ")" at position ${this.i + 1}`);
    }
    return n;
  }

  private peek(): string | undefined { return this.src[this.i]; }

  private alt(): Node {
    const items = [this.seq()];
    while (this.peek() === '|') { this.i++; items.push(this.seq()); }
    return items.length === 1 ? (items[0] ?? EMPTY) : { t: 'alt', items };
  }

  private seq(): Node {
    const items: Node[] = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === '|' || c === ')') break;
      const atomAt = this.i;
      const atom = this.atom();
      items.push(this.quantified(atom, atomAt));
    }
    return items.length === 1 ? (items[0] ?? EMPTY) : { t: 'cat', items };
  }

  private quantified(atom: Node, atomAt: number): Node {
    const q = this.quantifier();
    if (!q) return atom;
    if (atom.t === 'bol' || atom.t === 'eol') {
      throw new Refused(`nothing to repeat at position ${atomAt + 1}`);
    }
    if (this.peek() === '?') this.i++; // lazy: the same boolean answer
    const c = this.peek();
    if (c === '*' || c === '+' || c === '?' || (c === '{' && this.looksLikeCount())) {
      throw new Refused(`nothing to repeat at position ${this.i + 1}`);
    }
    return { t: 'rep', item: atom, min: q.min, max: q.max };
  }

  private looksLikeCount(): boolean {
    return /^\{\d+(,\d*)?\}/.test(this.src.slice(this.i));
  }

  private quantifier(): { min: number; max: number } | null {
    const c = this.peek();
    if (c === '*') { this.i++; return { min: 0, max: -1 }; }
    if (c === '+') { this.i++; return { min: 1, max: -1 }; }
    if (c === '?') { this.i++; return { min: 0, max: 1 }; }
    if (c !== '{') return null;
    const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i));
    if (!m) throw new Refused(`a "{" that isn't a count like {2} or {1,3} — escape it as \\{ (position ${this.i + 1})`);
    const min = this.count(m[1] ?? '');
    const max = m[2] === undefined ? min : (m[3] === '' || m[3] === undefined) ? -1 : this.count(m[3]);
    if (max !== -1 && max < min) throw new Refused(`the count ${m[0]} is out of order`);
    this.i += m[0].length;
    return { min, max };
  }

  private count(digits: string): number {
    if (digits.length > 4 || Number(digits) > PATH_SCOPE_LIMITS.repeatCount) {
      throw new Refused(`a count above ${PATH_SCOPE_LIMITS.repeatCount}`);
    }
    return Number(digits);
  }

  private atom(): Node {
    const at = this.i;
    const c = this.src[this.i++] ?? '';
    switch (c) {
      case '^': return { t: 'bol' };
      case '$': return { t: 'eol' };
      case '.': return cls(LINE_TERMINATORS, true);
      case '(': return this.group(at);
      case '[': return this.charClass(at);
      case '\\': return this.escape(at);
      case '*': case '+': case '?': throw new Refused(`nothing to repeat at position ${at + 1}`);
      case '{':
        this.i = at;
        if (this.looksLikeCount()) throw new Refused(`nothing to repeat at position ${at + 1}`);
        throw new Refused(`a "{" that isn't a count like {2} or {1,3} — escape it as \\{ (position ${at + 1})`);
      default: return ch(c.charCodeAt(0));
    }
  }

  private group(at: number): Node {
    if (this.src.startsWith('?', this.i)) {
      if (this.src.startsWith('?:', this.i)) this.i += 2;
      else if (/^\?<?[=!]/.test(this.src.slice(this.i))) throw new Refused(`lookarounds aren't supported (position ${at + 1})`);
      else if (this.src.startsWith('?<', this.i)) throw new Refused(`named groups aren't supported — use (…) or (?:…) (position ${at + 1})`);
      else throw new Refused(`"(?" at position ${at + 1} isn't supported — only (?:…) is`);
    }
    if (++this.depth > PATH_SCOPE_LIMITS.depth) throw new Refused(`groups nest more than ${PATH_SCOPE_LIMITS.depth} deep`);
    const inner = this.alt();
    this.depth--;
    if (this.peek() !== ')') throw new Refused(`unclosed "(" at position ${at + 1}`);
    this.i++;
    return inner;
  }

  private escape(at: number): Node {
    const c = this.src[this.i++];
    if (c === undefined) throw new Refused('a pattern can\'t end with "\\"');
    switch (c) {
      case 'd': return cls(DIGIT, false);
      case 'D': return cls(DIGIT, true);
      case 'w': return cls(WORD, false);
      case 'W': return cls(WORD, true);
      case 's': return cls(SPACE, false);
      case 'S': return cls(SPACE, true);
      case 'b': case 'B': throw new Refused(`word boundaries (\\${c}) aren't supported (position ${at + 1})`);
      case 'p': case 'P': throw new Refused(`Unicode property escapes aren't supported (position ${at + 1})`);
      case 'k': throw new Refused(`named backreferences aren't supported (position ${at + 1})`);
    }
    if (c >= '1' && c <= '9') throw new Refused(`backreferences aren't supported (position ${at + 1})`);
    return ch(this.escapedUnit(c, at));
  }

  // The code unit of a single-character escape (after the backslash), shared
  // by atoms and classes.
  private escapedUnit(c: string, at: number): number {
    switch (c) {
      case 'n': return 0x0a;
      case 'r': return 0x0d;
      case 't': return 0x09;
      case 'v': return 0x0b;
      case 'f': return 0x0c;
      case '0': {
        const next = this.peek();
        if (next !== undefined && next >= '0' && next <= '9') throw new Refused(`octal escapes aren't supported (position ${at + 1})`);
        return 0;
      }
      case 'x': return this.hex(2, at);
      case 'u': {
        if (this.peek() === '{') throw new Refused(`\\u{…} needs the u flag, which isn't supported (position ${at + 1})`);
        return this.hex(4, at);
      }
    }
    if (SYNTAX.includes(c)) return c.charCodeAt(0);
    throw new Refused(`"\\${c}" isn't a supported escape (position ${at + 1})`);
  }

  private hex(digits: number, at: number): number {
    const h = this.src.slice(this.i, this.i + digits);
    if (h.length !== digits || !/^[0-9a-fA-F]+$/.test(h)) {
      throw new Refused(`an incomplete hex escape at position ${at + 1}`);
    }
    this.i += digits;
    return parseInt(h, 16);
  }

  private charClass(at: number): Node {
    let negate = false;
    if (this.peek() === '^') { negate = true; this.i++; }
    const ranges: Array<[number, number]> = [];
    // `[\d]` and friends add their ranges to the class.
    for (;;) {
      const c = this.peek();
      if (c === undefined) throw new Refused(`unclosed "[" at position ${at + 1}`);
      if (c === ']') { this.i++; break; }
      const lo = this.classUnit(at);
      if (lo.ranges) { ranges.push(...lo.ranges); continue; }
      if (this.peek() === '-' && this.src[this.i + 1] !== undefined && this.src[this.i + 1] !== ']') {
        this.i++;
        const hi = this.classUnit(at);
        if (hi.ranges) throw new Refused(`a class escape can't end a range (position ${at + 1})`);
        if (hi.unit < lo.unit) throw new Refused(`the range at position ${at + 1} is out of order`);
        ranges.push([lo.unit, hi.unit]);
      } else ranges.push([lo.unit, lo.unit]);
    }
    return cls(ranges, negate);
  }

  private classUnit(at: number): { unit: number; ranges?: Array<[number, number]> } {
    const c = this.src[this.i++] ?? '';
    if (c !== '\\') return { unit: c.charCodeAt(0) };
    const e = this.src[this.i++];
    if (e === undefined) throw new Refused(`unclosed "[" at position ${at + 1}`);
    switch (e) {
      case 'd': return { unit: -1, ranges: DIGIT };
      case 'w': return { unit: -1, ranges: WORD };
      case 's': return { unit: -1, ranges: SPACE };
      case 'D': return { unit: -1, ranges: complement(DIGIT) };
      case 'W': return { unit: -1, ranges: complement(WORD) };
      case 'S': return { unit: -1, ranges: complement(SPACE) };
      case 'b': case 'B': throw new Refused(`\\${e} inside [ ] isn't supported (position ${at + 1})`);
      case 'p': case 'P': throw new Refused(`Unicode property escapes aren't supported (position ${at + 1})`);
      case 'c': throw new Refused(`control escapes (\\c) aren't supported (position ${at + 1})`);
    }
    if (e >= '1' && e <= '9') throw new Refused(`octal escapes aren't supported (position ${at + 1})`);
    if (e === ']') return { unit: 0x5d };
    return { unit: this.escapedUnit(e, at) };
  }
}

// ─── Glob → regex syntax tree ────────────────────────────────────────────────

const NOT_SLASH: Node = cls([[0x2f, 0x2f]], true);
const ANY_SEGMENTS: Node = { t: 'rep', item: { t: 'cat', items: [ch(0x2f), { t: 'rep', item: NOT_SLASH, min: 0, max: -1 }] }, min: 0, max: -1 };

function literal(s: string): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < s.length; i++) out.push(ch(s.charCodeAt(i)));
  return out;
}

// One segment's text (no `/`): literals, `*`, `{a,b}`, `\x`.
function segmentNode(seg: string, where: string): Node {
  const items: Node[] = [];
  let lit = '';
  const flush = () => { if (lit) { items.push(...literal(lit)); lit = ''; } };
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i] ?? '';
    if (c === '\\') {
      const n = seg[i + 1];
      if (n === undefined) throw new Refused(`${where} can't end with "\\"`);
      lit += n; i++;
    } else if (c === '*') {
      if (seg[i + 1] === '*') throw new Refused(`"**" has to be a whole segment, like /a/**/b`);
      flush(); items.push({ t: 'rep', item: NOT_SLASH, min: 0, max: -1 });
    } else if (c === '{') {
      const close = seg.indexOf('}', i);
      if (close === -1) throw new Refused(`an unclosed "{" in ${where}`);
      const body = seg.slice(i + 1, close);
      if (body.includes('{')) throw new Refused(`choices can't nest`);
      flush();
      items.push({ t: 'alt', items: body.split(',').map((alt) => segmentNode(alt, where)) });
      i = close;
    } else if (c === '}') {
      throw new Refused(`an unmatched "}" in ${where}`);
    } else if (c === '?' || c === '[' || c === ']') {
      throw new Refused(`"${c}" has no meaning in a glob — globs never see the query; use re: for more`);
    } else lit += c;
  }
  flush();
  return items.length === 1 ? (items[0] ?? EMPTY) : { t: 'cat', items };
}

// A glob over a slash-separated string, anchored at both ends. A trailing `/`
// is dropped, so `/a/` and `/a` are the same; `/` alone matches the root.
function slashGlob(glob: string, where: string): Node {
  if (glob.includes('{') && /\{[^}]*\//.test(glob)) throw new Refused(`a choice can't contain "/"`);
  const trimmed = glob.length > 1 && glob.endsWith('/') ? glob.slice(0, -1) : glob === '/' ? '' : glob;
  const parts = trimmed.split('/');
  const items: Node[] = [{ t: 'bol' }];
  parts.forEach((part, idx) => {
    if (idx === 0) {
      if (part === '**') items.push({ t: 'rep', item: NOT_SLASH, min: 0, max: -1 }, ANY_SEGMENTS);
      else if (part) items.push(segmentNode(part, where));
      return;
    }
    if (part === '**') items.push(ANY_SEGMENTS);
    else items.push(ch(0x2f), segmentNode(part, where));
  });
  items.push({ t: 'eol' });
  return { t: 'cat', items };
}

// The string a glob's path part is tested against: the pathname with any
// trailing `/` dropped (the root becomes "").
function normalizeSlashes(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

// ─── Entries and lists ───────────────────────────────────────────────────────

interface Compiled {
  entry: PathEntry;
  path: Program;
  hash: Program | null; // a glob with `#`
  states: number;
}

function parseEntry(raw: unknown): { entry: PathEntry; body: string } | { error: string; text: string } {
  if (typeof raw !== 'string') {
    // Never coerce the value: a JSON object's own `toString` could throw.
    const shape = raw === null ? 'null' : Array.isArray(raw) ? 'a list' : typeof raw;
    return { error: `must be text, got ${shape}`, text: `(${shape})` };
  }
  const text = raw;
  if (text.length === 0) return { error: 'is empty', text };
  if (text.length > PATH_SCOPE_LIMITS.entryChars) return { error: `is longer than ${PATH_SCOPE_LIMITS.entryChars} characters`, text };
  let body = text;
  const exclude = body.startsWith('!');
  if (exclude) body = body.slice(1);
  if (body.startsWith('re:')) return { entry: { text, kind: 'regex', exclude }, body: body.slice(3) };
  return { entry: { text, kind: 'glob', exclude }, body };
}

function compileEntry(raw: unknown): { ok: true; compiled: Compiled } | { ok: false; text: string; error: string } {
  const parsed = parseEntry(raw);
  if ('error' in parsed) return { ok: false, text: parsed.text, error: parsed.error };
  const { entry, body } = parsed;
  try {
    let pathNode: Node;
    let hashNode: Node | null = null;
    if (entry.kind === 'regex') {
      if (body.length === 0) throw new Refused('has an empty regex');
      pathNode = new RegexParser(body).parse();
    } else {
      if (!body.startsWith('/')) throw new Refused('has to start with "/" (it matches the path), or "re:" for a regex');
      const hashAt = body.indexOf('#');
      const pathGlob = hashAt === -1 ? body : body.slice(0, hashAt);
      pathNode = slashGlob(pathGlob, 'a glob');
      if (hashAt !== -1) hashNode = slashGlob(body.slice(hashAt + 1), 'the part after "#"');
    }
    const cap = PATH_SCOPE_LIMITS.patternStates;
    const states = stateCount(pathNode, cap) + (hashNode ? stateCount(hashNode, cap) : 0);
    if (states > cap) throw new Refused(`is too large to match safely (over ${cap} states once its repeats expand)`);
    return {
      ok: true,
      compiled: { entry, path: compileNode(pathNode), hash: hashNode ? compileNode(hashNode) : null, states },
    };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, text: entry.text, error: e.message };
    throw e;
  }
}

// One entry on its own: for an editor validating as the person types.
export function checkPathEntry(raw: unknown): PathEntryResult {
  const r = compileEntry(raw);
  return r.ok ? { ok: true, entry: r.compiled.entry, states: r.compiled.states } : r;
}

export interface PathScope {
  // Out of scope everywhere when false; `errors` says why.
  ok: boolean;
  errors: string[];
  entries: Compiled[];
}

// Compiles a whole `match.paths` value. Undefined or empty means every page.
export function compilePathScope(paths: unknown): PathScope {
  if (paths === undefined) return { ok: true, errors: [], entries: [] };
  if (!Array.isArray(paths)) return { ok: false, errors: ['match.paths must be a list'], entries: [] };
  const errors: string[] = [];
  if (paths.length > PATH_SCOPE_LIMITS.entries) errors.push(`match.paths has more than ${PATH_SCOPE_LIMITS.entries} entries`);
  const entries: Compiled[] = [];
  let total = 0;
  paths.slice(0, PATH_SCOPE_LIMITS.entries).forEach((raw, i) => {
    const r = compileEntry(raw);
    if (!r.ok) { errors.push(`match.paths[${i}] ${JSON.stringify(r.text)} ${r.error}`); return; }
    total += r.compiled.states;
    entries.push(r.compiled);
  });
  if (total > PATH_SCOPE_LIMITS.listStates) {
    errors.push(`match.paths is too large to match safely together (over ${PATH_SCOPE_LIMITS.listStates} states)`);
  }
  return { ok: errors.length === 0, errors, entries: errors.length ? [] : entries };
}

// What each kind of entry is tested against, for a settings view to show.
export function pathSubjects(url: UrlParts): { glob: string; globWithHash: string; regex: string } {
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  return { glob: url.pathname || '/', globWithHash: `${url.pathname || '/'}#${hash}`, regex: `${url.pathname}${url.search}${url.hash}` };
}

function entryMatches(c: Compiled, url: UrlParts): boolean {
  if (c.entry.kind === 'regex') return run(c.path, `${url.pathname}${url.search}${url.hash}`);
  if (!run(c.path, normalizeSlashes(url.pathname))) return false;
  if (!c.hash) return true;
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  return run(c.hash, normalizeSlashes(hash));
}

// Which entries match this URL, for a settings view to highlight. Empty when
// the subject is too long to test.
export function matchingEntries(scope: PathScope, url: UrlParts): PathEntry[] {
  if (!scope.ok || tooLong(url)) return [];
  return scope.entries.filter((c) => entryMatches(c, url)).map((c) => c.entry);
}

function tooLong(url: UrlParts): boolean {
  return url.pathname.length + url.search.length + url.hash.length > PATH_SCOPE_LIMITS.subjectChars;
}

// The decision. Fails closed: a list that didn't compile, or a URL too long to
// test against a list that has entries, is out of scope.
export function inPathScope(scope: PathScope, url: UrlParts): boolean {
  if (!scope.ok) return false;
  if (scope.entries.length === 0) return true;
  if (tooLong(url)) return false;
  let anyInclude = false;
  let included = false;
  for (const c of scope.entries) {
    if (c.entry.exclude) {
      if (entryMatches(c, url)) return false;
    } else {
      anyInclude = true;
      if (!included && entryMatches(c, url)) included = true;
    }
  }
  return anyInclude ? included : true;
}
