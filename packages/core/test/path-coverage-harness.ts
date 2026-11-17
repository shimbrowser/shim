// Path coverage (packages/core/src/path-coverage.ts): whether a paths change
// widens, how a set of known pages fares under it, in-page hops, and the
// plain-words summary.
//
//   node out/packages/core/test/path-coverage-harness.js

import {
  PATH_COVERAGE_LIMITS, canonicalPaths, changedHops, diffPathLists, pathCoverage, pathVerdict, pathsWiden,
  summarizePathChange,
} from '../src/path-coverage';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

console.log('canonical form');
check('absent is []', JSON.stringify(canonicalPaths(undefined)) === '[]');
check('a list is copied', JSON.stringify(canonicalPaths(['/a'])) === '["/a"]');
check('not a list of text is null', canonicalPaths('x') === null && canonicalPaths([1]) === null && canonicalPaths(null) === null);

console.log('widening');
check('a new shim never widens', !pathsWiden(null, ['/a']) && !pathsWiden(null, []));
check('every page to a list narrows', !pathsWiden([], ['/a']) && !pathsWiden(undefined, ['/a']));
check('every page to every page is no change', !pathsWiden([], undefined));
check('clearing a list widens', pathsWiden(['/a'], []) && pathsWiden(['/a'], undefined));
check('an exclude removed widens', pathsWiden(['/a/*', '!/a/private'], ['/a/*']));
check('an exclude removed beside others widens', pathsWiden(['!/x', '!/y'], ['!/x']));
check('an include added widens', pathsWiden(['/a'], ['/a', '/b']));
check('a changed include widens', pathsWiden(['/a'], ['/b']));
check('a changed re: widens (never compared for containment)', pathsWiden(['re:^/a$'], ['re:^/a'] ));
check('repairing a list that did not compile widens', pathsWiden(['/history', 'history'], ['/history']));
check('an unchanged list that does not compile is no change', !pathsWiden(['history'], ['history']));
check('same list reordered does not widen', !pathsWiden(['/a', '!/b'], ['!/b', '/a']));
check('an include dropped narrows', !pathsWiden(['/a', '/b'], ['/a']));
check('an exclude added narrows', !pathsWiden(['/a'], ['/a', '!/a/x']));
check('includes dropped to excludes only widens', pathsWiden(['/a'], ['!/x']));
check('an include added to an excludes-only list is not proved narrower', pathsWiden(['!/x'], ['/a']));
check('excludes only, an exclude added, narrows', !pathsWiden(['!/x'], ['!/x', '!/y']));
check('a malformed list counts as widening', pathsWiden(['/a'], 'x') && pathsWiden(7, ['/a']));
const changes = diffPathLists(['/a', '!/b'], ['/c', '!/d']);
check('diffPathLists names what moved',
  changes.addedIncludes.join() === '/c' && changes.removedIncludes.join() === '/a'
  && changes.addedExcludes.join() === '!/d' && changes.removedExcludes.join() === '!/b');

console.log('verdicts');
check('glob in', pathVerdict(['/recipes/*'], 'https://e.com/recipes/1') === 'in');
check('glob out', pathVerdict(['/recipes/*'], 'https://e.com/search') === 'out');
check('exclude', pathVerdict(['!/account/**'], 'https://e.com/account/x') === 'out' && pathVerdict(['!/account/**'], 'https://e.com/') === 'in');
check('re: sees the query', pathVerdict(['re:^/s\\?q=1$'], 'https://e.com/s?q=1') === 'in');
check('hash glob', pathVerdict(['/app#/inbox'], 'https://e.com/app#/inbox') === 'in' && pathVerdict(['/app#/inbox'], 'https://e.com/app#/sent') === 'out');
check('an unparseable URL is unknown', pathVerdict(['/a'], 'not a url') === 'unknown');
check('a list that does not compile runs nowhere', pathVerdict(['nope'], 'https://e.com/nope') === 'out');

console.log('coverage');
const pagesSeen = [
  { group: 'recipe', pathname: '/recipes/1', search: '', hash: '' },
  { group: 'recipe', pathname: '/recipes/2', search: '', hash: '' },
  { group: 'search', pathname: '/search', search: '', hash: '' },
  { group: 'home', pathname: '/', search: '', hash: '' },
];
{
  const r = pathCoverage([], ['/recipes/*'], pagesSeen);
  const g = (name: string) => r.groups.find((x) => x.group === name);
  check('narrowing: recipes stay in', g('recipe')?.staysIn === 2 && g('recipe')?.total === 2 && !g('recipe')?.mixed);
  check('narrowing: search and home stop', g('search')?.stops === 1 && g('home')?.stops === 1);
  check('per-entry verdicts', r.entries[0]?.before === 'in' && r.entries[0]?.after === 'in' && r.entries[2]?.change === 'stops');
  const w = pathCoverage(['/recipes/*'], [], pagesSeen);
  check('widening: search and home start', w.groups.find((x) => x.group === 'search')?.starts === 1 && w.groups.find((x) => x.group === 'home')?.starts === 1);
  const same = pathCoverage(['/x'], ['/y'], [{ group: 'g', pathname: '/z', search: '', hash: '' }]);
  check('staying out is counted', same.groups[0]?.staysOut === 1);
}
{
  const r = pathCoverage([], ['/recipes/1'], pagesSeen);
  check('a group whose pages end differently is mixed', r.groups.find((x) => x.group === 'recipe')?.mixed === true);
}
{
  const r = pathCoverage(null, ['/a'], [{ group: 'g', pathname: '/a', search: '', hash: '' }]);
  check('a null before is every page', r.entries[0]?.before === 'in' && r.entries[0]?.change === 'stays-in');
}
{
  const r = pathCoverage([], ['re:^/s\\?q=1$'], [{ group: 's', pathname: '/s' }, { group: 's', pathname: '/s', search: '?q=1', hash: '' }]);
  check('missing search is unknown, never guessed', r.entries[0]?.after === 'unknown' && r.entries[0]?.change === 'unknown' && r.groups[0]?.unknown === 1);
  check('…and a group with an unknown is mixed', r.groups[0]?.mixed === true);
  const h = pathCoverage([], ['/a#/b'], [{ group: 'h', pathname: '/a' }]);
  check('missing hash is unknown for a hash glob', h.entries[0]?.after === 'unknown');
  const p = pathCoverage([], ['/a'], [{ group: 'h', pathname: '/a', search: '', hash: '' }]);
  check('a plain glob needs only the path', p.entries[0]?.after === 'in');
  const o = pathCoverage([], ['/a'], [{ group: 'h', pathname: '/b' }]);
  check('a sure no needs only the path', o.entries[0]?.after === 'out');
  const len = pathCoverage([], ['/a'], [{ group: 'h', pathname: '/a' }]);
  check('a yes with a left-out part is unknown (the length cap counts it)', len.entries[0]?.after === 'unknown');
}
{
  const many = Array.from({ length: PATH_COVERAGE_LIMITS.entries + 5 }, (_, i) => ({ group: 'g', pathname: `/p${i}` }));
  const r = pathCoverage([], ['/p*'], many);
  check('input is capped and says so', r.truncated && r.entries.length === PATH_COVERAGE_LIMITS.entries);
}

console.log('work budget');
{
  const heavy = Array.from({ length: 300 }, (_, i) => ({ group: 'g', pathname: `/${'a'.repeat(1500)}${i}`, search: `?${'b'.repeat(400)}`, hash: '' }));
  const big = ['re:^/(a|aa|b)*a{1,900}c'];
  const r = pathCoverage([], big, heavy);
  check('costly pages against a large list stop at the budget', r.truncated && r.entries.length < heavy.length, `${r.entries.length}`);
  check('ordinary pages keep the page limit',
    !pathCoverage([], ['/a/*'], Array.from({ length: PATH_COVERAGE_LIMITS.entries }, (_, i) => ({ group: 'g', pathname: `/a/${i}`, search: '', hash: '' }))).truncated);
}

{
  const over = Array.from({ length: 30 }, () => ({ pathname: `/${'a'.repeat(2100)}`, search: '?q', hash: '' }));
  const ok = [{ group: 'g', pathname: '/a/1', search: '', hash: '' }];
  const r = pathCoverage([], ['re:^/(a|aa|b)*a{1,900}c', '/x/*'], [...over.map((o) => ({ group: 'long', ...o })), ...ok]);
  check('a URL past the length limit costs no matching, so later pages are still judged', !r.truncated && r.entries.length === 31);
  const s = summarizePathChange([], ['/a/*'], { ...pathCoverage([], ['/a/*'], ok), truncated: true });
  check('a work-capped summary gives no count', s.includes('Not every page was checked.') && !s.some((x) => /first \d+/.test(x)), s.join(' | '));
}

console.log('hops');
{
  const costly = { from: `https://e.com/${'a'.repeat(1500)}?${'b'.repeat(400)}`, to: `https://e.com/${'a'.repeat(1500)}?${'b'.repeat(400)}` };
  const list = [...Array.from({ length: 150 }, () => costly), { from: 'https://e.com/a/1', to: 'https://e.com/b' }];
  const r = changedHops(['re:^/(a|aa|b)*a{1,900}c'], list);
  check('a budget cut in hops is reported', r.truncated && r.hops.length === 0);
}
{
  const hops = [
    { from: 'https://e.com/recipes/1', to: 'https://e.com/search' },
    { from: 'https://e.com/recipes/1', to: 'https://e.com/recipes/2' },
    { from: 'https://e.com/a', to: 'bad' },
  ];
  const { hops: out, truncated: hopsCut } = changedHops(['/recipes/*'], hops);
  check('a small hop list is fully judged', !hopsCut);
  check('only a hop whose ends differ is reported', out.length === 1 && out[0]?.to === 'https://e.com/search' && out[0]?.fromVerdict === 'in' && out[0]?.toVerdict === 'out');
  check('no paths, no changed hops', changedHops([], hops).hops.length === 0);
}

console.log('summary');
{
  const before: string[] = [];
  const after = ['/recipes/*'];
  const s = summarizePathChange(before, after, pathCoverage(before, after, pagesSeen));
  check('narrowing reads as pages', s.join(' ') === "Runs only on recipe (2 pages you've visited). Stops running on search and home.", s.join(' '));
  check('never the field name', !s.join(' ').includes('match.paths'));
  const wb = ['/recipes/*', '!/recipes/private'];
  const wa = ['/recipes/*'];
  const w = summarizePathChange(wb, wa, pathCoverage(wb, wa, [{ group: 'private', pathname: '/recipes/private', search: '', hash: '' }, { group: 'recipe', pathname: '/recipes/1', search: '', hash: '' }]));
  check('widening names what starts and the exclude lifted',
    w.includes('Will now also run on private.') && w.includes('Stops excluding /recipes/private.'), w.join(' | '));
  const cleared = summarizePathChange(['/a'], [], pathCoverage(['/a'], [], [{ group: 'x', pathname: '/b', search: '', hash: '' }]));
  check('clearing says every page', cleared[0] === 'Runs on every page of its sites again.' && cleared.includes('Will now also run on x.'), cleared.join(' | '));
  const none = summarizePathChange([], ['/zzz'], pathCoverage([], ['/zzz'], [{ group: 'x', pathname: '/b', search: '', hash: '' }]));
  check('none visited', none[0] === "Runs on none of the pages you've visited." && none[1] === 'Stops running on x.', none.join(' | '));
  const bare = summarizePathChange([], ['/zzz'], pathCoverage([], ['/zzz'], []));
  check('no history', bare.join(' ') === 'Runs only on the pages it lists.');
  const mixedIn = summarizePathChange([], ['/recipes/1'], pathCoverage([], ['/recipes/1'], pagesSeen));
  check('a mixed group is "some"', mixedIn[0]?.startsWith('Runs only on some recipe (1 page you\'ve visited).') === true, mixedIn.join(' | '));
  const lots = Array.from({ length: 7 }, (_, i) => ({ group: `g${i}`, pathname: `/g${i}`, search: '', hash: '' }));
  const capped = summarizePathChange([], ['/nothing'], pathCoverage([], ['/nothing'], lots));
  check('long group lists fold into "and N more"', capped.some((x) => x === 'Stops running on g0, g1, g2, g3 and 3 more.'), capped.join(' | '));
  const unk = summarizePathChange([], ['re:^/a$'], pathCoverage([], ['re:^/a$'], [{ group: 'x', pathname: '/a' }]));
  check('unchecked pages are said', unk.includes("1 page couldn't be checked."), unk.join(' | '));
  const split = summarizePathChange(['/recipes/1'], ['/search'], pathCoverage(['/recipes/1'], ['/search'], pagesSeen));
  check('a group where only some pages stop is named as some', split.some((x) => x === 'Stops running on some recipe.'), split.join(' | '));
  const part = summarizePathChange([], ['/recipes/1', '/recipes/2', '/search'], pathCoverage([], ['/recipes/1', '/recipes/2', '/search'], pagesSeen));
  check('a group whose pages all stop is named whole', part.some((x) => x === 'Stops running on home.'), part.join(' | '));
  const unkNone = summarizePathChange(['re:^/history$'], ['/history'], pathCoverage(['re:^/history$'], ['/history'], [{ group: 'h', pathname: '/history', search: '', hash: '' }, { group: 'u', pathname: '/x' }]));
  check('the summary follows the new verdicts, and says what could not be checked', unkNone[0] === "Runs on h (1 page checked)." && unkNone.includes("1 page couldn't be checked."), unkNone.join(' | '));
  const cut = Array.from({ length: PATH_COVERAGE_LIMITS.entries + 1 }, (_, i) => ({ group: 'g', pathname: i === PATH_COVERAGE_LIMITS.entries ? '/hit' : `/p${i}`, search: '', hash: '' }));
  const cutS = summarizePathChange([], ['/hit'], pathCoverage([], ['/hit'], cut));
  check('a capped check never claims none, and says it was capped', !cutS.some((x) => x.includes('none')) && cutS.some((x) => x === 'Not every page was checked.'), cutS.join(' | '));
  const conservative = summarizePathChange(['/**'], ['/history'], pathCoverage(['/**'], ['/history'], pagesSeen));
  check('a conservative widening with nothing newly covered says so honestly',
    conservative.includes("Couldn't confirm that every page it was kept off stays off.") && !conservative.some((x) => x.startsWith('Will now')), conservative.join(' | '));
  const edit = summarizePathChange(['/old', '!/old/private'], ['/other'], pathCoverage(['/old', '!/old/private'], ['/other'], [{ group: 'p', pathname: '/old/private', search: '', hash: '' }]));
  check('a dropped exclude is an edit, not a claim of reach', edit.includes('Stops excluding /old/private.') && !edit.some((x) => x.startsWith('Will now')), edit.join(' | '));
  const cut2 = Array.from({ length: PATH_COVERAGE_LIMITS.entries + 1 }, (_, i) => ({ group: i === 0 ? 'recipes' : 'search', pathname: i === 0 ? '/recipes/1' : i === PATH_COVERAGE_LIMITS.entries ? '/search' : `/x${i}`, search: '', hash: '' }));
  const cutP = summarizePathChange([], ['/recipes/*', '/search'], pathCoverage([], ['/recipes/*', '/search'], cut2));
  check('a capped check never says "only"', !cutP.some((x) => x.includes('only')) && cutP.some((x) => x.startsWith('Runs on recipes')), cutP.join(' | '));
  const free = pathCoverage([], ['/history'], [{ group: 's', pathname: '/search' }]);
  check('an unrestricted baseline is a sure yes from the path alone', free.entries[0]?.before === 'in' && free.entries[0]?.after === 'out' && free.entries[0]?.change === 'stops', JSON.stringify(free.entries));
  const bad = summarizePathChange(['/history'], null, pathCoverage(['/history'], null, [{ group: 'h', pathname: '/history', search: '', hash: '' }]));
  check('an invalid proposal is never the every-page message',
    bad.length === 1 && !bad[0]?.includes('every page') && pathCoverage(['/history'], null, [{ group: 'h', pathname: '/history', search: '', hash: '' }]).entries[0]?.after === 'out', bad.join(' | '));
  check('no change says nothing', summarizePathChange([], [], pathCoverage([], [], pagesSeen)).length === 0);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
