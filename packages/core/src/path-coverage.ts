// What a change to a shim's `match.paths` does, judged with core's own matcher
// (path-match.ts) so every verdict here is the one runtime would reach. Pure:
// lists and URL parts in, verdicts, counts and plain sentences out. A host
// groups the pages it knows about (core knows no route templates) and decides
// where to show the result.
//
// Widening rule (`pathsWiden`). Lists are canonicalized first (absent and `[]`
// are one value: every page). A change widens, meaning the shim can now run on
// a URL the old list kept it off, unless it is provably not:
//   - the new list is empty and the old one wasn't: widens;
//   - the old list is empty (every page): nothing can widen;
//   - the old list doesn't compile (it runs nowhere, so its entries say nothing
//     about where the shim ran): any different list widens;
//   - otherwise it does not widen only when the new list has at least one
//     include, every include in it is string-identical to an include in the
//     old list, and every exclude (`!` entry) of the old list is still in it.
// Anything else widens, including a changed `re:` entry, because two patterns
// are never compared for containment. A list that is not a list of text is
// treated as widening. A new shim, with nothing committed to widen, passes
// `before = null` and never widens.

import { PATH_SCOPE_LIMITS, compilePathScope, inPathScope, type PathScope, type UrlParts } from './path-match';

// Bounds on what one call judges; entries past a bound are not judged and the
// result says so.
export const PATH_COVERAGE_LIMITS = {
  entries: 2000,
  hops: 200,
  listedGroups: 4,
  // Matcher work across one call, in (URL characters x list states): matching
  // costs at most that per list, so a few huge URLs against a huge list stop
  // the call early where thousands of ordinary pages never do.
  work: 40_000_000,
} as const;

export type PathVerdict = 'in' | 'out' | 'unknown';

// A stored or proposed `match.paths` as a list of text, with absent and `[]`
// the same value. Null when the value is not a list of text.
export function canonicalPaths(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (!value.every((p): p is string => typeof p === 'string')) return null;
  return [...value];
}

const isExclude = (p: string): boolean => p.startsWith('!');

export function pathsWiden(before: unknown, after: unknown): boolean {
  if (before === null) return false;
  const was = canonicalPaths(before);
  const next = canonicalPaths(after);
  if (was === null || next === null) return true;
  if (was.length === 0) return false;
  if (next.length === 0) return true;
  if (!compilePathScope(was).ok) return was.length !== next.length || was.some((p, i) => p !== next[i]);
  const wasIncludes = new Set(was.filter((p) => !isExclude(p)));
  const nextIncludes = next.filter((p) => !isExclude(p));
  const nextExcludes = new Set(next.filter(isExclude));
  // No include means every page bar the excludes.
  if (nextIncludes.length === 0) return wasIncludes.size > 0 || was.filter(isExclude).some((p) => !nextExcludes.has(p));
  if (!nextIncludes.every((p) => wasIncludes.has(p))) return true;
  return was.filter(isExclude).some((p) => !nextExcludes.has(p));
}

// The entries a change added and dropped, by kind, for words that name them.
export interface PathListChanges {
  addedIncludes: string[];
  removedIncludes: string[];
  addedExcludes: string[];
  removedExcludes: string[];
}

export function diffPathLists(before: unknown, after: unknown): PathListChanges {
  const was = canonicalPaths(before) ?? [];
  const next = canonicalPaths(after) ?? [];
  const wasSet = new Set(was);
  const nextSet = new Set(next);
  return {
    addedIncludes: next.filter((p) => !isExclude(p) && !wasSet.has(p)),
    removedIncludes: was.filter((p) => !isExclude(p) && !nextSet.has(p)),
    addedExcludes: next.filter((p) => isExclude(p) && !wasSet.has(p)),
    removedExcludes: was.filter((p) => isExclude(p) && !nextSet.has(p)),
  };
}

// ─── Verdicts ────────────────────────────────────────────────────────────────

interface Judge { scope: PathScope; needsSearch: boolean; needsHash: boolean; states: number }

function judgeFor(paths: unknown): Judge {
  const list = canonicalPaths(paths);
  // Not a list of text: runtime compiles it to nothing and runs nowhere.
  const scope = compilePathScope(list ?? paths);
  let needsSearch = false;
  let needsHash = false;
  let states = 0;
  for (const e of scope.entries) {
    states += e.states;
    if (e.entry.kind === 'regex') { needsSearch = true; needsHash = true; }
    else if (e.entry.text.includes('#')) needsHash = true;
  }
  return { scope, needsSearch, needsHash, states };
}

function verdictOf(j: Judge, e: { pathname?: unknown; search?: unknown; hash?: unknown }): PathVerdict {
  if (typeof e.pathname !== 'string') return 'unknown';
  if (j.needsSearch && typeof e.search !== 'string') return 'unknown';
  if (j.needsHash && typeof e.hash !== 'string') return 'unknown';
  const parts: UrlParts = {
    pathname: e.pathname,
    search: typeof e.search === 'string' ? e.search : '',
    hash: typeof e.hash === 'string' ? e.hash : '',
  };
  if (!inPathScope(j.scope, parts)) return 'out';
  // No list, or an empty one, takes every URL before any length check.
  if (j.scope.ok && j.scope.entries.length === 0) return 'in';
  // The matcher caps pathname + query + fragment together, so a page whose
  // query or fragment wasn't given may still be too long: not a sure yes. A
  // caller that knows a page has none passes ''.
  return typeof e.search === 'string' && typeof e.hash === 'string' ? 'in' : 'unknown';
}

// Whether `paths` lets the shim run at a URL; unknown when the URL doesn't parse.
// A URL carries all its parts, so only parse failures are unknown.
export function pathVerdict(paths: unknown, url: string): PathVerdict {
  return verdictOf(judgeFor(paths), partsOf(url) ?? {});
}

// The matcher work judging one page against these lists can take, at most.
function workFor(lists: readonly Judge[], e: { pathname?: unknown; search?: unknown; hash?: unknown }): number {
  const chars = [e.pathname, e.search, e.hash].reduce<number>((n, v) => n + (typeof v === 'string' ? v.length : 0), 0);
  // A URL past the matcher's own length limit is refused before any matching.
  if (chars > PATH_SCOPE_LIMITS.subjectChars) return lists.length;
  return lists.reduce((n, j) => n + Math.max(1, j.states), 0) * Math.max(1, chars);
}

function partsOf(url: string): UrlParts | null {
  try {
    const u = new URL(url);
    return { pathname: u.pathname, search: u.search, hash: u.hash };
  } catch {
    return null;
  }
}

// ─── Coverage ────────────────────────────────────────────────────────────────

// One known page. `search` and `hash` are given when known, '' when the page is
// known to have none; a left-out part can make a page unknown (a regex reads
// them, and the matcher's length cap counts them), and an unknown part never
// reads as empty.
export interface CoverageInput { group: string; pathname: string; search?: string; hash?: string }

export type CoverageChange = 'stays-in' | 'stays-out' | 'starts' | 'stops' | 'unknown';

export interface EntryCoverage {
  group: string;
  before: PathVerdict;
  after: PathVerdict;
  change: CoverageChange;
}

export interface GroupCoverage {
  group: string;
  total: number;
  staysIn: number;
  staysOut: number;
  starts: number;
  stops: number;
  unknown: number;
  // Verdicts under the new list alone, whatever they were before.
  afterIn: number;
  afterOut: number;
  afterUnknown: number;
  // The group's entries end with different verdicts under the new list
  // (unknown counts as its own verdict).
  mixed: boolean;
}

export interface CoverageResult {
  groups: GroupCoverage[];
  entries: EntryCoverage[];
  // Inputs past PATH_COVERAGE_LIMITS.entries were not judged.
  truncated: boolean;
}

function changeOf(before: PathVerdict, after: PathVerdict): CoverageChange {
  if (before === 'unknown' || after === 'unknown') return 'unknown';
  if (before === 'in') return after === 'in' ? 'stays-in' : 'stops';
  return after === 'in' ? 'starts' : 'stays-out';
}

// How each known page fares under `after` against `before`. A null `before`
// (a shim with nothing committed) is the every-page list.
export function pathCoverage(before: unknown, after: unknown, inputs: readonly CoverageInput[]): CoverageResult {
  const was = judgeFor(before === null ? [] : before);
  const next = judgeFor(after);
  let truncated = inputs.length > PATH_COVERAGE_LIMITS.entries;
  let work = 0;
  const entries: EntryCoverage[] = [];
  const groups = new Map<string, GroupCoverage & { seen: Set<PathVerdict> }>();
  for (const input of inputs.slice(0, PATH_COVERAGE_LIMITS.entries)) {
    work += workFor([was, next], input);
    if (work > PATH_COVERAGE_LIMITS.work) { truncated = true; break; }
    const b = verdictOf(was, input);
    const a = verdictOf(next, input);
    const change = changeOf(b, a);
    entries.push({ group: input.group, before: b, after: a, change });
    let g = groups.get(input.group);
    if (!g) {
      g = { group: input.group, total: 0, staysIn: 0, staysOut: 0, starts: 0, stops: 0, unknown: 0, afterIn: 0, afterOut: 0, afterUnknown: 0, mixed: false, seen: new Set() };
      groups.set(input.group, g);
    }
    g.total++;
    g.seen.add(a);
    if (a === 'in') g.afterIn++;
    else if (a === 'out') g.afterOut++;
    else g.afterUnknown++;
    if (change === 'stays-in') g.staysIn++;
    else if (change === 'stays-out') g.staysOut++;
    else if (change === 'starts') g.starts++;
    else if (change === 'stops') g.stops++;
    else g.unknown++;
  }
  const out: GroupCoverage[] = [];
  for (const g of groups.values()) {
    const { seen, ...rest } = g;
    out.push({ ...rest, mixed: seen.size > 1 });
  }
  return { groups: out, entries, truncated };
}

// ─── In-page navigation ──────────────────────────────────────────────────────

export interface Hop { from: string; to: string }
export interface ChangedHop extends Hop { fromVerdict: PathVerdict; toVerdict: PathVerdict }

// The in-page moves whose two ends get different verdicts under `paths`: the
// shim is decided once per document, so such a move doesn't start or stop it.
// A hop with an end that doesn't parse is not reported. At most
// PATH_COVERAGE_LIMITS.hops are judged, within the same work budget as coverage;
// `truncated` says some were left unjudged.
export function changedHops(paths: unknown, hops: readonly Hop[]): { hops: ChangedHop[]; truncated: boolean } {
  const j = judgeFor(paths);
  const out: ChangedHop[] = [];
  let truncated = hops.length > PATH_COVERAGE_LIMITS.hops;
  let work = 0;
  for (const hop of hops.slice(0, PATH_COVERAGE_LIMITS.hops)) {
    const from = partsOf(hop.from);
    const to = partsOf(hop.to);
    if (!from || !to) continue;
    work += workFor([j], from) + workFor([j], to);
    if (work > PATH_COVERAGE_LIMITS.work) { truncated = true; break; }
    const fromVerdict = verdictOf(j, from);
    const toVerdict = verdictOf(j, to);
    if (fromVerdict !== 'unknown' && toVerdict !== 'unknown' && fromVerdict !== toVerdict) {
      out.push({ ...hop, fromVerdict, toVerdict });
    }
  }
  return { hops: out, truncated };
}

// ─── Words ───────────────────────────────────────────────────────────────────

function pages(n: number): string {
  return `${n} page${n === 1 ? '' : 's'}`;
}

function listGroups(labels: string[], max: number): string {
  const shown = labels.slice(0, max);
  const rest = labels.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length > 1) return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return shown.join('');
}

// A group is named "some" of it when only part of its checked pages change.
function label(g: GroupCoverage, affected: number, base: number): string {
  return affected < base ? `some ${g.group}` : g.group;
}

export interface PathSummaryOptions { maxGroups?: number }

// Short sentences saying what the change does in terms of pages, never the
// settings' field names. Every claim is about pages that were checked: a page
// that couldn't be, or that was past the cap, is said, and blocks "none".
// Empty when nothing changes in a way worth saying.
export function summarizePathChange(
  before: unknown,
  after: unknown,
  result: Pick<CoverageResult, 'groups'> & { truncated?: boolean },
  options: PathSummaryOptions = {},
): string[] {
  const max = options.maxGroups ?? PATH_COVERAGE_LIMITS.listedGroups;
  const was = canonicalPaths(before) ?? [];
  const nextList = canonicalPaths(after);
  // A value that isn't a list of text runs the shim nowhere, which isn't the
  // same as no list.
  if (nextList === null) return ["That isn't a valid list of pages, so the shim would run on none."];
  const next = nextList;
  const sentences: string[] = [];
  const groups = result.groups;
  const widens = pathsWiden(before, after);
  const changes = diffPathLists(before, after);
  const hasIncludes = next.some((p) => !isExclude(p));
  const unknown = groups.reduce((sum, g) => sum + g.unknown, 0);
  const complete = !result.truncated && unknown === 0;

  if (next.length === 0) {
    if (was.length > 0) sentences.push('Runs on every page of its sites again.');
  } else if (hasIncludes) {
    const running = groups.filter((g) => g.afterIn > 0);
    const n = running.reduce((sum, g) => sum + g.afterIn, 0);
    if (running.length > 0) {
      const names = listGroups(running.map((g) => label(g, g.afterIn, g.total)), max);
      // "Only" is a claim about every page, so it needs every page checked.
      sentences.push(complete ? `Runs only on ${names} (${pages(n)} you've visited).` : `Runs on ${names} (${pages(n)} checked).`);
    } else if (groups.length > 0 && complete) sentences.push("Runs on none of the pages you've visited.");
    else if (groups.length === 0) sentences.push('Runs only on the pages it lists.');
  }

  const stops = groups.filter((g) => g.stops > 0);
  if (stops.length > 0) sentences.push(`Stops running on ${listGroups(stops.map((g) => label(g, g.stops, g.total)), max)}.`);

  if (widens) {
    const starts = groups.filter((g) => g.starts > 0);
    if (starts.length > 0) sentences.push(`Will now also run on ${listGroups(starts.map((g) => label(g, g.starts, g.total)), max)}.`);
    else sentences.push("Couldn't confirm that every page it was kept off stays off.");
    if (changes.removedExcludes.length > 0) {
      sentences.push(`Stops excluding ${listGroups(changes.removedExcludes.map((p) => p.slice(1)), max)}.`);
    }
  }

  if (unknown > 0) sentences.push(`${pages(unknown)} couldn't be checked.`);
  if (result.truncated) sentences.push('Not every page was checked.');
  return sentences;
}
