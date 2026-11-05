// Harness for the page tools' page-side work over a PageHost
// (packages/core/src/page-host-tools.ts): view_page,
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
  withTimeout, cropMeasureSource, cropMovedSource, MAX_SHOT_WIDTH, MAX_EXPRESSION, MAX_RESULT,
  evaluateTimeoutOf, EVALUATE_TIMEOUT_MS, EVALUATE_MAX_TIMEOUT_MS, EVALUATE_SESSION_ENDED,
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
  // The post-capture check (cropMovedSource): did the page scroll away? No, by default.
  moved: () => unknown = () => false,
): ScriptedHost {
  const evals: Array<{ code: string; world: PageWorld }> = [];
  const shots: Array<ScreenshotOptions | undefined> = [];
  return {
    evals,
    shots,
    capabilities: {
      mutationKinds: ['hide'], iframeRules: false, specCss: false, pathScope: false, apiMembers: [], componentIdentity: false, engineInspection: false, trustedInput: false,
      secretSettings: 'none',
    },
    url: () => 'https://example.com/a',
    isClosed: () => false,
    evaluate(code, world) {
      evals.push({ code, world });
      if (code.includes('l.positions')) return Promise.resolve(moved());
      try { return Promise.resolve(answer(code, world)); } catch (err) { return Promise.reject(err); }
    },
    screenshot(opts) { shots.push(opts); return Promise.resolve(shot(opts)); },
    applyPreview() { /* not exercised */ },
    removePreview() { /* not exercised */ },
    onRuntimeEvent: () => () => undefined,
    onConsole: () => () => undefined,
    reload() { /* not exercised */ },
    waitForLoad: () => Promise.resolve({ kind: 'finished' }),
    documentToken: () => Promise.resolve(null),
  };
}

const MEASURE = { x: 10, y: 20, w: 120.6, h: 39.4, vw: 1440, vh: 900 };
const isMeasure = (code: string) => code.includes('getBoundingClientRect') && code.includes('innerWidth') && code.includes('noneVisible');

async function testViewPage(): Promise<void> {
  console.log('view_page:');
  const host = scriptedHost((code) => (isMeasure(code) ? MEASURE : null));
  const full = await viewPageOnHost(host, undefined, 'main');
  check('a full shot asks the host for the viewport, capped at MAX_SHOT_WIDTH, without a clip',
    host.shots.length === 1 && host.shots[0]?.maxWidth === MAX_SHOT_WIDTH && host.shots[0]?.clip === undefined,
    JSON.stringify(host.shots));
  check('a full shot measures nothing, only takes the view lease',
    host.evals.length === 1 && (host.evals[0]?.code ?? '').includes('return __token') && !isMeasure(host.evals[0]?.code ?? ''));
  check('the result carries the host url and the shot',
    full.url === 'https://example.com/a' && full.dataBase64 === 'cG5n' && full.mediaType === 'image/png'
    && full.sizeBytes === 3 && full.width === 1280 && full.height === 800 && !('croppedTo' in full),
    JSON.stringify(full));
  check('the result keeps its field order', Object.keys(full).join(',') === 'dataBase64,mediaType,url,sizeBytes,width,height', Object.keys(full).join(','));

  const crop = await viewPageOnHost(host, { selector: ' .card  ' }, 'engine');
  const clip = host.shots[1]?.clip;
  check('a crop measures in the given world', host.evals[1]?.world === 'engine' && isMeasure(host.evals[1]?.code ?? ''));
  check('a crop clips to the padded element rect with no width cap',
    clip !== undefined && clip.x === 0 && clip.y === 0 && clip.width === 191 && clip.height === 140 && host.shots[1]?.maxWidth === undefined,
    JSON.stringify(host.shots[1]));
  check('a crop names the trimmed selector and the rounded element box',
    crop.croppedTo === '.card' && crop.elementBox?.w === 121 && crop.elementBox?.h === 39, JSON.stringify(crop));

  const miss = await viewPageOnHost(scriptedHost(() => null), { selector: '.nope' }, 'main');
  check('a crop selector matching nothing is an actionable error', /^crop selector matched nothing: \.nope/.test(miss.error ?? ''), miss.error);
  const hiddenHost = scriptedHost((code) => (isMeasure(code) ? { noneVisible: true, count: 3 } : null));
  const hidden = await viewPageOnHost(hiddenHost, { selector: '.ghost' }, 'main');
  check('a crop selector whose matches are all hidden says so, with no capture',
    /^crop selector matched 3 elements, none visible .*: \.ghost/.test(hidden.error ?? '') && hidden.dataBase64 === undefined && hiddenHost.shots.length === 0, hidden.error);
  const measureSrc = cropMeasureSource('.card');
  check('the measure script crops to the first rendered match, skipping hidden ones',
    measureSrc.includes('querySelectorAll(".card")') && measureSrc.includes("cs.display !== 'none'") && measureSrc.includes("cs.visibility !== 'hidden'") && measureSrc.includes('r.width > 0 && r.height > 0'));
  const offscreen = await viewPageOnHost(scriptedHost(() => ({ x: 5000, y: 5000, w: 10, h: 10, vw: 1440, vh: 900 })), { selector: '.far' }, 'main');
  check('a crop that scrolling could not bring into the viewport is an error, never a capture', /outside the viewport and scrolling did not bring it in/.test(offscreen.error ?? ''), offscreen.error);

  // The measure script took the lease (and scrolled the target in): the crop
  // is of the scrolled-in rect, and the lease is released — its scroll put
  // back — after the capture, by its own token.
  const isRelease = (code: string): boolean => code.includes('l.token !== ') && !code.includes('l.expires = Date.now()');
  const order: string[] = [];
  const scrolledHost = scriptedHost(
    (code) => {
      if (isRelease(code)) { order.push(code.includes('"t1"') ? 'release:t1' : 'release:?'); return true; }
      order.push('measure');
      return { x: 10, y: 300, w: 100, h: 400, vw: 1440, vh: 900, token: 't1', scrolled: true };
    },
    (opts) => { order.push('shot'); return { mediaType: 'image/png', dataBase64: 'cG5n', sizeBytes: 3, width: (opts?.clip?.width ?? 0) * 2, height: (opts?.clip?.height ?? 0) * 2 }; },
  );
  const scrolled = await viewPageOnHost(scrolledHost, { selector: '.tall' }, 'engine');
  const sclip = scrolledHost.shots[0]?.clip;
  check('a scrolled-in target is cropped whole', scrolled.error === undefined && sclip?.y === 240 && sclip?.height === 520, JSON.stringify(sclip));
  check('the lease is released by its token after the capture, in the same world',
    order.join(',') === 'measure,shot,release:t1' && scrolledHost.evals.every((e) => e.world === 'engine'), order.join(','));
  order.length = 0;
  const failingShot = scriptedHost(
    (code) => (isRelease(code) ? (order.push('release'), true) : { x: 10, y: 300, w: 100, h: 100, vw: 1440, vh: 900, token: 't2', scrolled: true }),
    () => ({ error: 'capture broke' }),
  );
  const failed = await viewPageOnHost(failingShot, { selector: '.tall' }, 'main');
  check('a failed capture still releases the lease', failed.error === 'capture broke' && order.join(',') === 'release', order.join(','));
  // The page scrolled away from the crop during the capture (a scroll lock
  // putting its scroll back): measured and captured again, and after a second
  // move an error, never the image; each attempt releases its own lease.
  order.length = 0;
  let movedTimes = 1;
  const movingHost = scriptedHost(
    (code) => {
      if (isRelease(code)) { order.push('release'); return true; }
      order.push('measure');
      return { x: 10, y: 300, w: 100, h: 100, vw: 1440, vh: 900, token: 't7', scrolled: true };
    },
    (opts) => { order.push('shot'); return { mediaType: 'image/png', dataBase64: 'cG5n', sizeBytes: 3, width: (opts?.clip?.width ?? 0) * 2, height: (opts?.clip?.height ?? 0) * 2 }; },
    () => movedTimes-- > 0,
  );
  const movedOnce = await viewPageOnHost(movingHost, { selector: '.locked' }, 'main');
  check('a crop the page scrolled away from is measured and captured again', movedOnce.error === undefined && movedOnce.croppedTo === '.locked'
    && order.join(',') === 'measure,shot,release,measure,shot,release', `${JSON.stringify(movedOnce.error)} ${order.join(',')}`);
  order.length = 0;
  movedTimes = Infinity;
  const movedAlways = await viewPageOnHost(movingHost, { selector: '.locked' }, 'main');
  check('a page that keeps scrolling away answers an error after two attempts, never the image',
    /scrolled away from \.locked while it was captured/.test(movedAlways.error ?? '') && movedAlways.dataBase64 === undefined
    && order.join(',') === 'measure,shot,release,measure,shot,release', `${JSON.stringify(movedAlways.error)} ${order.join(',')}`);
  order.length = 0;
  movedTimes = 0;
  const unknownHost = scriptedHost(
    (code) => (isRelease(code) ? true : { x: 10, y: 300, w: 100, h: 100, vw: 1440, vh: 900, token: 't8', scrolled: true }),
    undefined,
    () => null,
  );
  const unknown = await viewPageOnHost(unknownHost, { selector: '.lost' }, 'main');
  check('a check that can\'t tell (lease gone) keeps the shot', unknown.error === undefined && unknownHost.shots.length === 1, unknown.error);
  const movedSrc = cropMovedSource('t9');
  check('the check compares the scroll offsets the measurement held, not the target\'s box (an animated target is not a move)',
    movedSrc.includes('l.positions') && movedSrc.includes('scrollTop') && !movedSrc.includes('getBoundingClientRect') && cropMeasureSource('.x').includes('.positions = pos'));
  order.length = 0;
  const unplaced = scriptedHost((code) => (isRelease(code) ? (order.push('release'), true) : { x: 5000, y: 5000, w: 10, h: 10, vw: 1440, vh: 900, token: 't3' }));
  const unplacedShot = await viewPageOnHost(unplaced, { selector: '.far' }, 'main');
  check('a crop that cannot be placed releases the lease without a capture', typeof unplacedShot.error === 'string' && unplaced.shots.length === 0 && order.join(',') === 'release', order.join(','));
  order.length = 0;
  const fullLeased = scriptedHost((code) => (isRelease(code) ? (order.push(code.includes('"t4"') ? 'release:t4' : 'release:?'), true) : 't4'));
  await viewPageOnHost(fullLeased, undefined, 'main');
  check('a full shot releases its lease after the capture', order.join(',') === 'release:t4', order.join(','));
  order.length = 0;
  let renewals = 0;
  const slowShot = scriptedHost(
    (code) => {
      if (isRelease(code)) { order.push('release'); return true; }
      if (code.includes('l.expires = Date.now()')) { if (code.includes('"t5"')) renewals++; return true; }
      return { x: 10, y: 300, w: 100, h: 100, vw: 1440, vh: 900, token: 't5', scrolled: true };
    },
    () => { order.push('shot'); return { mediaType: 'image/png', dataBase64: 'cG5n', sizeBytes: 3, width: 1, height: 1 }; },
  );
  const realShot = slowShot.screenshot.bind(slowShot);
  slowShot.screenshot = (opts) => new Promise((r) => setTimeout(() => { void realShot(opts).then(r); }, 80));
  const slow = await viewPageOnHost(slowShot, { selector: '.slow' }, 'main', { leaseRenewMs: 15 });
  check('a slow capture still returns its picture, renewing its lease meanwhile, then releases',
    slow.error === undefined && renewals >= 2 && order.join(',') === 'shot,release', `${JSON.stringify(slow)} renewals=${renewals} ${order.join(',')}`);
  const before = renewals;
  await new Promise((r) => setTimeout(r, 50));
  check('…and stops renewing once the capture is done', renewals === before, `${before} -> ${renewals}`);
  // The page answers busy (another view_page held the lease past the wait):
  // an error, never a capture without the lease.
  const busyFull = scriptedHost(() => ({ busy: true }));
  const busyFullShot = await viewPageOnHost(busyFull, undefined, 'main');
  check('a full shot the page answers busy is an error, with no capture', /held the page for too long/.test(busyFullShot.error ?? '') && busyFull.shots.length === 0, JSON.stringify(busyFullShot));
  const busyCrop = scriptedHost(() => ({ busy: true }));
  const busyCropShot = await viewPageOnHost(busyCrop, { selector: '.x' }, 'main');
  check('a crop the page answers busy is an error, with no capture', /held the page for too long/.test(busyCropShot.error ?? '') && busyCrop.shots.length === 0, JSON.stringify(busyCropShot));
  check('the wait is the page\'s own deadline', (busyFull.evals[0]?.code ?? '').includes('__deadline') && (busyCrop.evals[0]?.code ?? '').includes('__deadline'));
  // The page never answers inside the wait: busy, no capture, and a token
  // that lands afterwards is released at once.
  order.length = 0;
  const lateLease = scriptedHost((code) => {
    if (isRelease(code)) { order.push(code.includes('"t6"') ? 'release:t6' : 'release:?'); return true; }
    return new Promise((r) => setTimeout(() => r('t6'), 2100));
  });
  const lateShot = await viewPageOnHost(lateLease, undefined, 'main', { leaseWaitMs: 10 });
  check('a lease that never comes inside the wait is busy, with no capture', /held the page for too long/.test(lateShot.error ?? '') && lateLease.shots.length === 0, JSON.stringify(lateShot));
  await new Promise((r) => setTimeout(r, 150));
  check('…and a token that lands after the caller gave up is released at once', order.join(',') === 'release:t6', order.join(','));
  const noScripts = scriptedHost(() => { throw new Error('no scripts here'); });
  const unleased = await viewPageOnHost(noScripts, undefined, 'main');
  check('a full shot of a page whose scripts fail still captures', unleased.error === undefined && noScripts.shots.length === 1, JSON.stringify(unleased));
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
  check('the form is decided host-side: one evaluate, the wrapper, in the given world (no in-page probe)',
    host.evals.length === 1 && host.evals[0]?.world === 'engine'
    && !(host.evals[0]?.code ?? '').includes('__shimNeverCalled') && (host.evals[0]?.code ?? '').includes('await (1 + 1'),
    JSON.stringify(host.evals));
  const big = await evaluateOnHost(host, 'BIG', 100, 'main');
  check('a long result is truncated', 'result' in big && big.result.length === MAX_RESULT + '\n... (truncated)'.length);
  check('a page-side throw is an error', (await evaluateOnHost(host, 'THROWS', 100, 'main') as { error?: string }).error === 'nope');
  check('a non-JSON answer is an error',
    /^page returned non-JSON: not json/.test((await evaluateOnHost(host, 'GARBAGE', 100, 'main') as { error?: string }).error ?? ''));
  const hung = scriptedHost(() => new Promise(() => { /* never settles */ }));
  check('a hung page times out', (await evaluateOnHost(hung, '1', 20, 'main') as { error?: string }).error === 'evaluateInPage timeout');

  // A host that really compiles and runs what it is given (this process's
  // JS engine stands in for the page's): a syntax error rejects, as a page's
  // compile failure does on every host.
  let ran = 0;
  const g = globalThis as { __evalRan?: () => void };
  g.__evalRan = () => { ran++; };
  const real = scriptedHost((code) => (0, eval)(code) as unknown);
  const expr = await evaluateOnHost(real, '[1, 2].map((n) => n * 2)', 500, 'main');
  check('a bare expression returns its value', 'result' in expr && expr.result === '[2,4]', JSON.stringify(expr));
  const awaited = await evaluateOnHost(real, 'await Promise.resolve(7)', 500, 'main');
  check('an expression can await', 'result' in awaited && awaited.result === '7', JSON.stringify(awaited));
  const body = await evaluateOnHost(real, 'const x = 1; return x + 1', 500, 'main');
  check('a statement body runs and returns its value', 'result' in body && body.result === '2', JSON.stringify(body));
  const awaitBody = await evaluateOnHost(real, 'const v = await Promise.resolve(3);\nif (v > 2) { return { v }; }\nreturn null;', 500, 'main');
  check('a multi-statement body can await and branch', 'result' in awaitBody && awaitBody.result === '{"v":3}', JSON.stringify(awaitBody));
  const commented = await evaluateOnHost(real, '40 + 2 // the answer', 500, 'main');
  check('a trailing line comment does not swallow the wrapper', 'result' in commented && commented.result === '42', JSON.stringify(commented));
  const noReturn = await evaluateOnHost(real, 'let y = 5; y++', 500, 'main');
  check('a body without return answers null', 'result' in noReturn && noReturn.result === 'null', JSON.stringify(noReturn));
  const bodyThrow = await evaluateOnHost(real, "const e = 'conf'; throw new Error(e)", 500, 'main');
  check('a body\'s throw is an error value', 'error' in bodyThrow && bodyThrow.error === 'conf', JSON.stringify(bodyThrow));
  const broken = await evaluateOnHost(real, 'const = ;', 500, 'main');
  check('input that compiles as neither is an error, not a throw', 'error' in broken && /SyntaxError|Unexpected/.test(broken.error), JSON.stringify(broken));

  // Nothing that fails to compile ever reaches the page: an in-page compile
  // failure lands in the page console as `Uncaught SyntaxError`, which the
  // session reports as the site's error (the in-page expression probe did exactly that).
  const compiles = (code: string): boolean => { try { new Function(code); return true; } catch { return false; } };
  const watched = scriptedHost((code) => (0, eval)(code) as unknown);
  for (const input of ['const x = 1; return x + 1', 'return 5', 'document.title', 'const = ;', 'let a = await Promise.resolve(1);\nreturn a']) {
    watched.evals.length = 0;
    await evaluateOnHost(watched, input, 500, 'main');
    check(`${JSON.stringify(input)} sends the page only code that compiles`, watched.evals.every((e) => compiles(`return async () => { return ${e.code}\n}`)),
      JSON.stringify(watched.evals.map((e) => e.code.slice(0, 80))));
  }
  check('input that compiles as neither never reaches the page', await (async () => {
    watched.evals.length = 0;
    await evaluateOnHost(watched, 'const = ;', 500, 'main');
    return watched.evals.length === 0;
  })());
  ran = 0;
  await evaluateOnHost(real, '__evalRan()', 500, 'main');
  check('the probe never runs the input: an expression runs once', ran === 1, String(ran));
  ran = 0;
  await evaluateOnHost(real, '__evalRan(); return 1', 500, 'main');
  check('a body runs once', ran === 1, String(ran));
  delete g.__evalRan;

  // A probe that answers only after the timeout must not start the run.
  let late = 0;
  const slowProbe = scriptedHost((code) => {
    if (code.includes('__shimNeverCalled')) return new Promise((r) => setTimeout(() => r('ok'), 40));
    late++;
    return JSON.stringify({ result: 1 });
  });
  // (Only a host whose parser is unavailable probes in the page.)
  const noParser = (): { ok: false; error: string } => ({ ok: false, error: 'syntax check unavailable in this host (no eval)' });
  const slow = await evaluateOnHost(slowProbe, '1', 10, 'main', { probe: noParser });
  await new Promise((r) => setTimeout(r, 80));
  check('a run never starts after its timeout', 'error' in slow && slow.error === 'evaluateInPage timeout' && late === 0, `${JSON.stringify(slow)} late=${late}`);

  // timeoutMs: the default when absent, a whole number in 1..ceiling, else refused (never clamped).
  check('timeoutMs absent: the default', JSON.stringify(evaluateTimeoutOf(undefined)) === JSON.stringify({ timeoutMs: EVALUATE_TIMEOUT_MS }));
  check('timeoutMs at the bounds is taken as given', JSON.stringify(evaluateTimeoutOf(1)) === '{"timeoutMs":1}'
    && JSON.stringify(evaluateTimeoutOf(EVALUATE_MAX_TIMEOUT_MS)) === `{"timeoutMs":${EVALUATE_MAX_TIMEOUT_MS}}`);
  check('the ceiling is 10 seconds', EVALUATE_MAX_TIMEOUT_MS === 10_000);
  for (const bad of [EVALUATE_MAX_TIMEOUT_MS + 1, 0, -5, 1.5, '5000', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = evaluateTimeoutOf(bad);
    check(`timeoutMs ${String(bad)} is refused with the range`, 'error' in r && r.error.includes(`1 to ${EVALUATE_MAX_TIMEOUT_MS}`), JSON.stringify(r));
  }

  // A wait longer than the default resolves when the caller allows it.
  const waits = scriptedHost(() => new Promise((r) => setTimeout(() => r(JSON.stringify({ result: 'late' })), 60)));
  check('a wait shorter than the timeout answers its value', JSON.stringify(await evaluateOnHost(waits, '1', 200, 'main')) === '{"result":"\\"late\\""}');
  check('the same wait over a shorter timeout times out', (await evaluateOnHost(waits, '1', 20, 'main') as { error?: string }).error === 'evaluateInPage timeout');

  // The session's signal: aborted before, the page is never touched;
  // aborted while the page works, the call answers at once.
  const untouched = scriptedHost(() => JSON.stringify({ result: 1 }));
  const pre = new AbortController();
  pre.abort();
  const preR = await evaluateOnHost(untouched, '1', 1000, 'main', { signal: pre.signal });
  check('an aborted session never reaches the page', 'error' in preR && preR.error === EVALUATE_SESSION_ENDED && untouched.evals.length === 0, JSON.stringify(preR));
  const forever = scriptedHost(() => new Promise(() => { /* never settles */ }));
  const mid = new AbortController();
  const started = Date.now();
  setTimeout(() => mid.abort(), 20);
  const midR = await evaluateOnHost(forever, '1', EVALUATE_MAX_TIMEOUT_MS, 'main', { signal: mid.signal });
  check('an abort mid-wait answers at once, not at the timeout', 'error' in midR && midR.error === EVALUATE_SESSION_ENDED && Date.now() - started < 1000,
    `${JSON.stringify(midR)} after ${Date.now() - started}ms`);

  // An abort while the in-page form probe is pending: whether the probe then
  // resolves or rejects, the input never runs.
  for (const outcome of ['resolves', 'rejects'] as const) {
    let ranAfter = 0;
    const pendingProbe = scriptedHost((code) => {
      if (code.includes('__shimNeverCalled')) {
        return new Promise((res, rej) => setTimeout(() => (outcome === 'resolves' ? res('ok') : rej(new Error('SyntaxError'))), 40));
      }
      ranAfter++;
      return JSON.stringify({ result: 1 });
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const r = await evaluateOnHost(pendingProbe, '1', 5000, 'main', { probe: noParser, signal: ac.signal });
    await new Promise((res) => setTimeout(res, 80));
    check(`an abort while the probe is pending (it then ${outcome}) never runs the input`, 'error' in r && r.error === EVALUATE_SESSION_ENDED && ranAfter === 0,
      `${JSON.stringify(r)} ran=${ranAfter}`);
  }
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
