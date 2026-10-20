// Harness for the PageHost conformance suite's own definition
// (packages/core/src/page-host-conformance.ts) —
// the parts that need no browser: the fixture site answers what the cases
// expect (a deploy renames the entry script and moves the rebase targets;
// /strict carries the strict policy), the deploy ids of the two builds
// differ, every case is well-formed, the suite stays a pure module, and the
// input loop drivers share (page-host.ts sendInputCommands) keeps its contract.
// The cases themselves run in real browsers: scripts/electron-conformance-
// harness.ts and packages/mcp/test/playwright-conformance-harness.ts.
//
//   node out/packages/core/test/page-host-conformance-harness.js

import {
  conformanceFixture, fixtureDeployId, CONFORMANCE_CASES, CONFORMANCE_CAPABILITIES, coveredCapabilities,
  conformanceRuleKey, formatConformanceResults,
} from '../src/page-host-conformance';
import type { ConformanceCaseResult } from '../src/page-host-conformance';
import { sendInputCommands, type PageInputCommand } from '../src/page-host';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

console.log('fixture site');
{
  const v1 = conformanceFixture('/deploy', { deploy: 1 });
  const v2 = conformanceFixture('/deploy', { deploy: 2 });
  check('/deploy answers 200 html on both builds', v1.status === 200 && v2.status === 200 && v1.contentType.startsWith('text/html'));
  check('build 1 loads app.v1.js, build 2 app.v2.js', v1.body.includes('/assets/app.v1.js') && v2.body.includes('/assets/app.v2.js') && !v2.body.includes('app.v1.js'));
  check('build 2 renames the buy button but keeps its other signals', v1.body.includes('class="buy-v1"') && v2.body.includes('class="buy-v2"')
    && v2.body.includes('data-sku="42"') && v2.body.includes('aria-label="Buy the record"'));
  check('build 2 drops the legacy link', v1.body.includes('legacy-link') && !v2.body.includes('legacy-link'));
  check('build 2 turns .price into a different element', v1.body.includes('<span class="price"') && v2.body.includes('<em class="price"'));
  check('every page forbids eval and inline script', ['/apply', '/app', '/app/other', '/deploy', '/strict'].every((p) => {
    const csp = conformanceFixture(p, { deploy: 1 }).headers['Content-Security-Policy'] ?? '';
    return csp.includes("script-src 'self'") && !csp.includes('unsafe-eval') && !/script-src[^;]*unsafe-inline/.test(csp);
  }));
  const strictCsp = conformanceFixture('/strict', { deploy: 1 }).headers['Content-Security-Policy'] ?? '';
  check('/strict also forbids inline style', strictCsp.includes("style-src 'self'") && !strictCsp.includes('unsafe-inline'), strictCsp);
  check('/app/other is the same client-rendered shell as /app', conformanceFixture('/app/other', { deploy: 1 }).body === conformanceFixture('/app', { deploy: 1 }).body);
  check('both builds serve the same app script', conformanceFixture('/assets/app.v1.js', { deploy: 1 }).body === conformanceFixture('/assets/app.v2.js', { deploy: 2 }).body);
  check('unknown paths are 404', conformanceFixture('/nope', { deploy: 1 }).status === 404);
  const inputPage = conformanceFixture('/input', { deploy: 1 });
  check('/input loads its recorder script from the site (no inline script)', inputPage.status === 200 && inputPage.body.includes('<script src="/assets/input.js">')
    && conformanceFixture('/assets/input.js', { deploy: 1 }).contentType.startsWith('text/javascript'));
  check('/input has every control the input case drives', ['in-btn', 'in-field', 'in-ro', 'in-disabled', 'in-select', 'in-steal', 'in-other', 'in-hover', 'in-overlay'].every((id) => inputPage.body.includes(`id="${id}"`)));
  const b1 = fixtureDeployId('http://127.0.0.1:4000', 1);
  const b2 = fixtureDeployId('http://127.0.0.1:4000', 2);
  check('the two builds have distinct deploy ids', typeof b1 === 'string' && typeof b2 === 'string' && b1 !== b2, `${b1} ${b2}`);
  check('a deploy id is origin-specific', fixtureDeployId('http://127.0.0.1:4001', 1) !== b1);
}

console.log('cases');
{
  const ids = CONFORMANCE_CASES.map((c) => c.id);
  check('case ids are unique', new Set(ids).size === ids.length, ids.join(','));
  for (const want of ['apply', 're-render', 'spa-navigation', 'deploy-recovery', 'teardown', 'throwing-handler']) {
    check(`D15's "${want}" case exists`, ids.includes(want));
  }
  const known = new Set<string>(CONFORMANCE_CAPABILITIES);
  check('every case covers only declared capabilities', CONFORMANCE_CASES.every((c) => c.covers.length > 0 && c.covers.every((cap) => known.has(cap))));
  const covered = coveredCapabilities();
  const uncovered = CONFORMANCE_CAPABILITIES.filter((cap) => !covered.has(cap));
  check('every declared capability is covered by some case', uncovered.length === 0, uncovered.join(','));
  check('preview keys are namespaced like the browser\'s', conformanceRuleKey('x') === 'preview:conformance:x');
}

console.log('report');
{
  const results: ConformanceCaseResult[] = [
    { id: 'a', title: 'A', covers: ['hide'], checks: [{ label: 'ok', ok: true }], passed: true },
    { id: 'b', title: 'B', covers: ['script'], checks: [{ label: 'bad', ok: false, detail: 'why' }, { label: 'fine', ok: true }], passed: false },
  ];
  const { lines, failed } = formatConformanceResults('test host', results);
  check('counts failed checks', failed === 1);
  check('names the failed case in the summary', lines.at(-1) === 'test host: 1/2 cases passed (failed: b)', lines.at(-1));
  check('prints the failure detail', lines.includes('FAIL  bad  — why'));
}

async function inputLoop(): Promise<void> {
  const sent: string[] = [];
  const cmd = (type: string): PageInputCommand => ({ method: 'Input.dispatchMouseEvent', params: { type } });
  const send = async (c: PageInputCommand): Promise<void> => { if (c.params.type === 'bad') throw new Error('rejected'); sent.push(String(c.params.type)); };
  const done = await sendInputCommands([cmd('a'), cmd('b')], () => true, send);
  check('every command sent: done with the full count', done.outcome === 'done' && done.sent === 2 && sent.join() === 'a,b');
  sent.length = 0;
  const stopped = await sendInputCommands([cmd('a'), cmd('b'), cmd('c')], async (i) => i < 2, send);
  check('a false stillPinned stops before its command', stopped.outcome === 'stopped' && stopped.sent === 2 && sent.join() === 'a,b');
  sent.length = 0;
  const threw = await sendInputCommands([cmd('a'), cmd('b')], (i) => { if (i === 1) throw new Error('x'); return true; }, send);
  check('a throwing stillPinned stops too', threw.outcome === 'stopped' && threw.sent === 1);
  sent.length = 0;
  const failed = await sendInputCommands([cmd('a'), cmd('bad'), cmd('c')], () => true, send);
  check('a failed command ends the batch with the count before it', failed.outcome === 'failed' && failed.sent === 1 && failed.error === 'rejected' && sent.join() === 'a');
}


void (async () => {
  console.log('input loop');
  await inputLoop();
  if (failures) {
    console.error(`\n✗ page-host-conformance: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ page-host-conformance: all checks passed');
})();
