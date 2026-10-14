// Harness for the page tools' page-side work over a PageHost
// (packages/core/src/page-host-tools.ts, shim-core design §5 / D5): view_page,
// evaluate_in_page and the self-contained query_page / inspect_element reads,
// run against a scripted in-memory host — the point being that they need
// nothing but the PageHost interface, so any driver can run them.
//
//   node out/packages/core/test/page-host-tools-harness.js
//
// Bare node. The Shim browser's own preview-tools-harness pins the same
// behavior end to end through its Electron host.

import {
  viewPageOnHost, evaluateOnHost, queryPageByScript, inspectElementByScript, expressionProblem,
  withTimeout, MAX_SHOT_WIDTH, MAX_EXPRESSION, MAX_RESULT,
} from '../src/page-host-tools';
import { PAGE_HOST_API_MEMBERS } from '../src/page-host';
import type { PageHost, PageWorld, ScreenshotOptions, ScreenshotResult } from '../src/page-host';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

interface ScriptedHost extends PageHost {
  evals: Array<{ code: string; world: PageWorld }>;
  shots: Array<ScreenshotOptions | undefined>;
}

// A host whose page is a function of the script it is asked to run.
function scriptedHost(
  answer: (code: string, world: PageWorld) => unknown,
  shot: (opts: ScreenshotOptions | undefined) => ScreenshotResult = (opts) => ({
    mediaType: 'image/png', dataBase64: 'cG5n', sizeBytes: 3,
    width: opts?.clip ? opts.clip.width * 2 : 1280, height: opts?.clip ? opts.clip.height * 2 : 800,
  }),
): ScriptedHost {
  const evals: Array<{ code: string; world: PageWorld }> = [];
  const shots: Array<ScreenshotOptions | undefined> = [];
  return {
    evals,
    shots,
    capabilities: {
      mutationKinds: ['hide'], iframeRules: false, apiMembers: [], componentIdentity: false, engineInspection: false,
    },
    url: () => 'https://example.com/a',
    isClosed: () => false,
    evaluate(code, world) {
      evals.push({ code, world });
      try { return Promise.resolve(answer(code, world)); } catch (err) { return Promise.reject(err); }
    },
    screenshot(opts) { shots.push(opts); return Promise.resolve(shot(opts)); },
    applyPreview() { /* not exercised */ },
    removePreview() { /* not exercised */ },
    onRuntimeEvent: () => () => undefined,
    onConsole: () => () => undefined,
    reload() { /* not exercised */ },
    waitForLoad: () => Promise.resolve({ kind: 'finished' }),
  };
}

const MEASURE = { x: 10, y: 20, w: 120.6, h: 39.4, vw: 1440, vh: 900 };
const isMeasure = (code: string) => code.includes('getBoundingClientRect') && code.includes('innerWidth') && !code.includes('querySelectorAll');

async function testViewPage(): Promise<void> {
  console.log('view_page:');
  const host = scriptedHost((code) => (isMeasure(code) ? MEASURE : null));
  const full = await viewPageOnHost(host, undefined, 'main');
  check('a full shot asks the host for the viewport, capped at MAX_SHOT_WIDTH, without a clip',
    host.shots.length === 1 && host.shots[0]?.maxWidth === MAX_SHOT_WIDTH && host.shots[0]?.clip === undefined,
    JSON.stringify(host.shots));
  check('a full shot measures nothing', host.evals.length === 0);
  check('the result carries the host url and the shot',
    full.url === 'https://example.com/a' && full.dataBase64 === 'cG5n' && full.mediaType === 'image/png'
    && full.sizeBytes === 3 && full.width === 1280 && full.height === 800 && !('croppedTo' in full),
    JSON.stringify(full));
  check('the result keeps its field order', Object.keys(full).join(',') === 'dataBase64,mediaType,url,sizeBytes,width,height', Object.keys(full).join(','));

  const crop = await viewPageOnHost(host, { selector: ' .card  ' }, 'engine');
  const clip = host.shots[1]?.clip;
  check('a crop measures in the given world', host.evals[0]?.world === 'engine' && isMeasure(host.evals[0]?.code ?? ''));
  check('a crop clips to the padded element rect with no width cap',
    clip !== undefined && clip.x === 0 && clip.y === 0 && clip.width === 191 && clip.height === 140 && host.shots[1]?.maxWidth === undefined,
    JSON.stringify(host.shots[1]));
  check('a crop names the trimmed selector and the rounded element box',
    crop.croppedTo === '.card' && crop.elementBox?.w === 121 && crop.elementBox?.h === 39, JSON.stringify(crop));

  const miss = await viewPageOnHost(scriptedHost(() => null), { selector: '.nope' }, 'main');
  check('a crop selector matching nothing is an actionable error', /^crop selector matched nothing: \.nope/.test(miss.error ?? ''), miss.error);
  const offscreen = await viewPageOnHost(scriptedHost(() => ({ x: 5000, y: 5000, w: 10, h: 10, vw: 1440, vh: 900 })), { selector: '.far' }, 'main');
  check('a crop outside the viewport is an error, never a capture', /outside the visible viewport/.test(offscreen.error ?? ''), offscreen.error);
  const throws = await viewPageOnHost(scriptedHost(() => { throw new Error('nope'); }), { selector: '.x' }, 'main');
  check('a failed measurement is an error', throws.error === 'crop measurement failed: nope', throws.error);
  const failedShot = await viewPageOnHost(scriptedHost(() => null, () => ({ error: 'capture broke' })), undefined, 'main');
  check('a host screenshot error passes through as the result', failedShot.error === 'capture broke' && Object.keys(failedShot).length === 1, JSON.stringify(failedShot));
}

async function testEvaluate(): Promise<void> {
  console.log('evaluate_in_page:');
  check('an empty expression is refused', expressionProblem('   ') === 'empty expression' && expressionProblem(42) === 'empty expression');
  check('an over-long expression is refused', expressionProblem('x'.repeat(MAX_EXPRESSION + 1)) === `expression too long (${MAX_EXPRESSION} char max)`);
  check('an ordinary expression may run', expressionProblem('document.title') === null);

  const host = scriptedHost((code) => {
    if (code.includes('BIG')) return JSON.stringify({ result: 'x'.repeat(MAX_RESULT + 10) });
    if (code.includes('THROWS')) return JSON.stringify({ error: 'nope' });
    if (code.includes('GARBAGE')) return 'not json';
    return JSON.stringify({ result: { n: 2 } });
  });
  const ok = await evaluateOnHost(host, '1 + 1', 100, 'engine');
  check('the result is the page-serialized JSON', 'result' in ok && ok.result === '{"n":2}', JSON.stringify(ok));
  check('the expression runs awaited inside the wrapper, in the given world',
    host.evals[0]?.world === 'engine' && (host.evals[0]?.code ?? '').includes('await (1 + 1)'));
  const big = await evaluateOnHost(host, 'BIG', 100, 'main');
  check('a long result is truncated', 'result' in big && big.result.length === MAX_RESULT + '\n... (truncated)'.length);
  check('a page-side throw is an error', (await evaluateOnHost(host, 'THROWS', 100, 'main') as { error?: string }).error === 'nope');
  check('a non-JSON answer is an error',
    /^page returned non-JSON: not json/.test((await evaluateOnHost(host, 'GARBAGE', 100, 'main') as { error?: string }).error ?? ''));
  const hung = scriptedHost(() => new Promise(() => { /* never settles */ }));
  check('a hung page times out', (await evaluateOnHost(hung, '1', 20, 'main') as { error?: string }).error === 'evaluateInPage timeout');
}

async function testQueryInspect(): Promise<void> {
  console.log('query_page / inspect_element:');
  const hits = [{ selector: 'div#a', tag: 'div', text: 'Hi', rect: { x: 0, y: 0, w: 1, h: 1 } }];
  const host = scriptedHost((code) => {
    if (code.includes('scored.sort')) return hits;
    if (code.includes('matchCount')) return { found: true, tag: 'div', matchCount: 1 };
    return null;
  });
  const q = await queryPageByScript(host, 'the hi box', 100, 'engine');
  check('query returns the candidates', 'candidates' in q && q.candidates.length === 1, JSON.stringify(q));
  check('query embeds the description as a JSON literal, in the given world',
    host.evals[0]?.world === 'engine' && (host.evals[0]?.code ?? '').includes('"the hi box"'));
  const i = await inspectElementByScript(host, 'div#a', 100, 'main');
  check('inspect returns the element', 'element' in i && (i.element as { found?: boolean }).found === true);
  const before = host.evals.length;
  const empty = await inspectElementByScript(host, '', 100, 'main');
  check('an empty selector reads found:false without touching the page',
    'element' in empty && (empty.element as { found?: boolean }).found === false && host.evals.length === before);
  const broken = scriptedHost(() => { throw new Error('boom'); });
  const qb = await queryPageByScript(broken, 'x', 100, 'main');
  check('a page-side query failure is an error result', 'error' in qb && qb.error === 'query failed: boom', JSON.stringify(qb));
  const ib = await inspectElementByScript(broken, 'div', 100, 'main');
  check('a page-side inspect failure is an error result', 'error' in ib && ib.error === 'inspect failed: boom', JSON.stringify(ib));
  const slow = scriptedHost(() => new Promise(() => { /* never settles */ }));
  const qt = await queryPageByScript(slow, 'x', 20, 'main');
  check('an unanswered query times out', 'error' in qt && qt.error === 'query failed: queryPage timeout', JSON.stringify(qt));
}

async function testHelpers(): Promise<void> {
  console.log('helpers:');
  check('withTimeout passes a settled value through', (await withTimeout(Promise.resolve(7), 50, 'late')) === 7);
  const late = await withTimeout(new Promise(() => { /* never */ }), 10, 'late').then(() => 'resolved', (err: unknown) => (err instanceof Error ? err.message : 'other'));
  check('withTimeout rejects with its message', late === 'late');
  check('the api member list covers every D15 host-only member',
    ['db', 'ai', 'settings', 'fetch', 'storage.pack', 'storage.global', 'shared', 'modules'].every((m) => (PAGE_HOST_API_MEMBERS as readonly string[]).includes(m)));
}

async function main(): Promise<void> {
  await testViewPage();
  await testEvaluate();
  await testQueryInspect();
  await testHelpers();
}

main().then(() => {
  if (failures) { console.error(`\n${failures} page-host-tools check(s) failed`); process.exit(1); }
  console.log('\npage-host-tools-harness: all checks passed');
}).catch((err: unknown) => {
  console.error('page-host-tools-harness threw:', err);
  process.exit(1);
});
