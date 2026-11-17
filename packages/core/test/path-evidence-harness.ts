// Session URL observation (session-urls.ts) and the evidence a preview gives
// about a pending `match.paths` change (path-evidence.ts): only pages the
// session saw, judged by core's matcher.
//
//   node out/packages/core/test/path-evidence-harness.js

import { SESSION_URL_LIMITS, createSessionUrlLog } from '../src/session-urls';
import { PATH_EVIDENCE_LIMITS, pathsDiffer, pathsEvidence } from '../src/path-evidence';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const ORIGIN = 'https://example.com';

console.log('the session URL log');
{
  const log = createSessionUrlLog();
  check('empty before the session starts', log.documentUrl() === null && log.urls().length === 0 && log.hops().length === 0);
  log.start(`${ORIGIN}/a`);
  check('start sets the document and the first URL', log.documentUrl() === `${ORIGIN}/a` && log.urls().join() === `${ORIGIN}/a`);
  log.committed(`${ORIGIN}/a?page=2#top`, true);
  check('an in-page move keeps the document', log.documentUrl() === `${ORIGIN}/a`);
  check('…records the full URL, query and fragment kept', log.urls().includes(`${ORIGIN}/a?page=2#top`));
  check('…and one hop from where it was', JSON.stringify(log.hops()) === JSON.stringify([{ from: `${ORIGIN}/a`, to: `${ORIGIN}/a?page=2#top` }]));
  log.committed(`${ORIGIN}/a?page=2#top`, true);
  check('the same move twice is one hop', log.hops().length === 1);
  log.committed(`${ORIGIN}/b`, false);
  check('a full load moves the document, and is not a hop', log.documentUrl() === `${ORIGIN}/b` && log.hops().length === 1);
  log.committed('shim://library/history', true);
  check('an internal page the host feeds is kept', log.urls().includes('shim://library/history'));
  log.committed('shim://library/history', false);
  log.committed('chrome://settings/', false);
  log.committed('not a url', true);
  log.committed(`${ORIGIN}/${'x'.repeat(SESSION_URL_LIMITS.urlChars)}`, false);
  check('a non-web non-Shim URL, a non-URL and an over-long one are not kept', log.urls().length === 4 && log.hops().length === 2);
  check('…and a full load that cannot be recorded leaves no known document', log.documentUrl() === null);
}
{
  const log = createSessionUrlLog();
  log.start(`${ORIGIN}/first`);
  for (let i = 0; i < SESSION_URL_LIMITS.urls + 30; i++) log.committed(`${ORIGIN}/p${i}`, false);
  check('the URL list is bounded', log.urls().length === SESSION_URL_LIMITS.urls);
  check('…the first URL stays, the oldest after it goes', log.urls()[0] === `${ORIGIN}/first` && !log.urls().includes(`${ORIGIN}/p0`) && log.urls().includes(`${ORIGIN}/p${SESSION_URL_LIMITS.urls + 29}`));
  const moves = createSessionUrlLog();
  moves.start(`${ORIGIN}/`);
  for (let i = 0; i < SESSION_URL_LIMITS.hops + 40; i++) moves.committed(`${ORIGIN}/#h${i}`, true);
  check('the hop list is bounded', moves.hops().length === SESSION_URL_LIMITS.hops);
}

{
  const log = createSessionUrlLog();
  log.start(`${ORIGIN}/checkout`, null);
  check('a tab already moved in-page has no known document URL, not the shown one', log.documentUrl() === null && log.urls().includes(`${ORIGIN}/checkout`));
  log.start(`${ORIGIN}/checkout`, `${ORIGIN}/home`);
  check('a ledger URL seeds the document', log.documentUrl() === `${ORIGIN}/home`);
  log.committed('chrome://x/', false);
  check('a replacement that cannot be recorded clears the document', log.documentUrl() === null);
}

console.log('whether paths differ');
check('absent and [] are the same', !pathsDiffer(undefined, []) && !pathsDiffer([], undefined));
check('a changed list differs', pathsDiffer(['/a'], ['/b']) && pathsDiffer([], ['/a']) && pathsDiffer(['/a'], undefined));
check('a value that is not a list of text always differs', pathsDiffer(['/a'], 'x') && pathsDiffer(undefined, [1]));

console.log('evidence');
{
  const ev = pathsEvidence({
    committed: [], working: ['/recipes/*'],
    documentUrl: `${ORIGIN}/recipes/1`, shownUrl: `${ORIGIN}/recipes/1`,
    observed: [`${ORIGIN}/recipes/1`, `${ORIGIN}/cart`], hops: [],
  });
  const block = ev.block as { widens: boolean; currentPage: { atLoad: { committed: string; working: string }; shown?: unknown }; observed: Array<{ url: string; committed: string; working: string }>; warnings?: string[] };
  check('narrowing from every page does not widen', block.widens === false);
  check('the current document is judged at its committed URL, old and new',
    block.currentPage.atLoad.committed === 'in' && block.currentPage.atLoad.working === 'in');
  check('the shown URL is left out when it is the same', block.currentPage.shown === undefined);
  check('each observed URL has an old and a new verdict',
    block.observed.some((o) => o.url === `${ORIGIN}/cart` && o.committed === 'in' && o.working === 'out'));
  check('URLs whose verdict changes are listed first', block.observed[0]?.url === `${ORIGIN}/cart`);
  check('no cap while the page stays in scope', ev.offScopeWarning === null);
  check('no warning without an in-page hop', block.warnings === undefined);
}
{
  const ev = pathsEvidence({
    committed: ['/a'], working: ['/b'],
    documentUrl: `${ORIGIN}/a`, shownUrl: `${ORIGIN}/a`, observed: [`${ORIGIN}/a`], hops: [],
  });
  check('a working scope that excludes the current document caps verification', ev.offScopeWarning !== null && ev.offScopeWarning.includes('partial'));
  check('a change that can run the shim somewhere new is said to widen', (ev.block as { widens: boolean }).widens === true);
}
{
  const ev = pathsEvidence({
    committed: [], working: ['/list'],
    documentUrl: `${ORIGIN}/list`, shownUrl: `${ORIGIN}/item/9`,
    observed: [`${ORIGIN}/list`, `${ORIGIN}/item/9`], hops: [{ from: `${ORIGIN}/list`, to: `${ORIGIN}/item/9` }],
  });
  const block = ev.block as { currentPage: { shown: { working: string } }; warnings: string[] };
  check('after an in-page move the shown URL is judged too', block.currentPage.shown.working === 'out');
  check('the move between two sides warns, in the load-time wording',
    block.warnings.length === 1 && block.warnings[0]?.includes('only when a page loads in full') === true && block.warnings[0].includes('anchors'), block.warnings?.join('|'));
  check('the document at load is in scope, so no cap', ev.offScopeWarning === null);
}
{
  const ev = pathsEvidence({
    committed: [], working: ['re:^/x$'],
    documentUrl: 'not a url', shownUrl: null, observed: ['not a url'], hops: [],
  });
  const block = ev.block as { currentPage: { atLoad: { working: string } } };
  check('a URL that cannot be judged reads unknown, never a guess', block.currentPage.atLoad.working === 'unknown');
  check('unknown does not cap', ev.offScopeWarning === null);
}
{
  const many = Array.from({ length: 60 }, (_, i) => `${ORIGIN}/p/${i}`);
  const ev = pathsEvidence({ committed: [], working: ['/q/*'], documentUrl: many[0] ?? null, shownUrl: many[0] ?? null, observed: many, hops: [] });
  const block = ev.block as { observed: unknown[]; observedNotListed?: number };
  check('the listed URLs are bounded and the rest counted', block.observed.length === PATH_EVIDENCE_LIMITS.listed && block.observedNotListed === 60 - PATH_EVIDENCE_LIMITS.listed);
}

{
  const ev = pathsEvidence({ committed: [], working: ['/reports'], documentUrl: null, shownUrl: `${ORIGIN}/reports`, observed: [], hops: [] });
  check('an unknown load-time URL caps verification', ev.offScopeWarning !== null && ev.offScopeWarning.includes('partial'));
}
{
  const big = Array.from({ length: 100 }, (_, i) => `${ORIGIN}/${'a'.repeat(2000)}${i}`);
  const list = Array.from({ length: 20 }, (_, i) => `/${'x'.repeat(150)}${i}/**`);
  const ev = pathsEvidence({ committed: list, working: [...list].reverse(), documentUrl: null, shownUrl: null, observed: big, hops: [] });
  const block = ev.block as { observedNotJudged?: number; observed: Array<{ working: string }> };
  check('judging many long URLs against big lists stops at the work bound and says so', typeof block.observedNotJudged === 'number' && block.observedNotJudged > 0);
  check('…and what was not judged reads unknown', block.observed.every((o) => o.working === 'unknown' || o.working === 'out'));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
