// What a preview tells the agent about a pending change to `match.paths`:
// only pages the session itself saw (session-urls.ts), judged by core's own
// matcher, so each verdict is the one runtime would reach. Pure.
//
// Privacy invariant: nothing here takes or reveals a stored history or route
// inventory. The agent's evidence about a path change is the current document,
// the URLs this session observed, and the in-page moves it saw; counts or
// groupings over the person's own history stay on the person's side (a probing
// agent could otherwise ask "did they visit X" by trying patterns).
//
// A verdict a URL's missing parts make unjudgeable reads `unknown`, never a
// guess (path-coverage.ts).
import { canonicalPaths, changedHops, pathCoverage, pathVerdict, pathsWiden, type CoverageInput, type Hop, type PathVerdict } from './path-coverage';

export const PATH_EVIDENCE_LIMITS = {
  // Observed URLs listed in one block; those whose verdict changes come first.
  listed: 20,
} as const;

export interface PathsEvidenceInput {
  committed: unknown;
  working: unknown;
  /** The current document's URL as it committed (a full load), if known. */
  documentUrl: string | null;
  /** The URL the tab shows now. */
  shownUrl: string | null;
  observed: readonly string[];
  hops: readonly Hop[];
}

export interface PathsVerdicts { committed: PathVerdict; working: PathVerdict }

export interface PathsEvidence {
  /** The `paths` block of a preview's evidence. */
  block: Record<string, unknown>;
  /** Set when the working list keeps the shim off the current document: the preview caps rule verification at partial. */
  offScopeWarning: string | null;
}

/** Whether the working list is a different value from the committed one. A value that isn't a list of text always differs. */
export function pathsDiffer(committed: unknown, working: unknown): boolean {
  const was = canonicalPaths(committed);
  const next = canonicalPaths(working);
  if (was === null || next === null) return true;
  return was.length !== next.length || was.some((p, i) => p !== next[i]);
}

function verdicts(committed: unknown, working: unknown, url: string): PathsVerdicts {
  return { committed: pathVerdict(committed, url), working: pathVerdict(working, url) };
}

const LOAD_RULE = 'the shim starts or stops only when a page loads in full (or when a shim is committed); moving between pages inside the site does not change it';

export function pathsEvidence(input: PathsEvidenceInput): PathsEvidence {
  const { committed, working } = input;
  const warnings: string[] = [];
  const block: Record<string, unknown> = {
    widens: pathsWiden(committed, working),
    committed: canonicalPaths(committed) ?? [],
    working: canonicalPaths(working) ?? [],
  };

  let offScopeWarning: string | null = null;
  const current: Record<string, unknown> = {};
  let shownDiffers = false;
  if (input.documentUrl !== null) {
    const atLoad = verdicts(committed, working, input.documentUrl);
    current.documentUrl = input.documentUrl;
    current.atLoad = atLoad;
    if (atLoad.working === 'out') {
      offScopeWarning = `the working match.paths would not run the shim on this page (${input.documentUrl}): in Shim it would not run here, ` +
        'so no rule here is verified beyond partial. If it should run here, widen match.paths';
    }
  }
  if (input.documentUrl === null) {
    // The URL the document loaded at isn't known (too long to keep, or a commit
    // not yet seen): whether the shim would run here can't be said, so no rule
    // is verified beyond partial.
    offScopeWarning = 'the URL this page loaded at isn\'t known, so whether the working match.paths would run the shim on this page can\'t be judged: ' +
      'no rule here is verified beyond partial. Reload the page and preview again';
  }
  if (input.shownUrl !== null && input.shownUrl !== input.documentUrl) {
    const shown = verdicts(committed, working, input.shownUrl);
    current.shownUrl = input.shownUrl;
    current.shown = shown;
    const atLoad = current.atLoad as PathsVerdicts | undefined;
    shownDiffers = atLoad !== undefined && shown.working !== 'unknown' && atLoad.working !== 'unknown' && shown.working !== atLoad.working;
  }
  block.currentPage = current;

  // Observed URLs go through the bounded coverage evaluator (each list compiled
  // once, matcher work capped), not one unbounded judgement per URL.
  const parsed: Array<{ url: string; input: CoverageInput | null }> = input.observed.map((url) => {
    try {
      const u = new URL(url);
      return { url, input: { group: '', pathname: u.pathname, search: u.search, hash: u.hash } };
    } catch {
      return { url, input: null };
    }
  });
  const judgeable = parsed.flatMap((p) => (p.input ? [p.input] : []));
  const coverage = pathCoverage(committed, working, judgeable);
  let at = 0;
  let unjudged = 0;
  const rows: Array<{ url: string } & PathsVerdicts> = parsed.map(({ url, input: parts }) => {
    if (parts === null) return { url, committed: 'unknown', working: 'unknown' };
    const entry = coverage.entries[at];
    at += 1;
    if (!entry) { unjudged += 1; return { url, committed: 'unknown', working: 'unknown' }; }
    return { url, committed: entry.before, working: entry.after };
  });
  const moved = (r: PathsVerdicts): boolean => r.committed !== r.working;
  const listed = [...rows.filter(moved), ...rows.filter((r) => !moved(r))].slice(0, PATH_EVIDENCE_LIMITS.listed);
  block.observed = listed;
  if (rows.length > listed.length) block.observedNotListed = rows.length - listed.length;
  if (unjudged > 0) block.observedNotJudged = unjudged;

  const { hops: changed } = changedHops(working, input.hops);
  if (changed.length > 0 || shownDiffers) {
    const examples = changed.slice(0, 3).map((h) => `${h.from} (${h.fromVerdict === 'in' ? 'runs' : 'doesn\'t run'}) to ${h.to} (${h.toVerdict === 'in' ? 'runs' : 'doesn\'t run'})`);
    const seen = examples.length > 0 ? `this session saw the page move ${examples.join('; ')} without a full load` : 'the page now shown differs from the document that loaded';
    warnings.push(
      `${seen}. Under the working match.paths those pages are on different sides, but ${LOAD_RULE}. ` +
      'A site that navigates in the page is better scoped by anchors than by paths',
    );
  }
  if (warnings.length > 0) block.warnings = warnings;
  return { block, offScopeWarning };
}
