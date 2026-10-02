// playwright-conformance-harness — the PageHost conformance suite
// (@shimbrowser/core/page-host-conformance; shim-core design D12 gate, D15)
// against the headless host: Playwright's Chromium driven by
// attachPlaywrightPageHost (CDP isolated world + binding, the path the A5
// spike proved). Its twin, scripts/electron-conformance-harness.ts, runs the
// same cases against the Shim browser; a capability is "yes" for headless only
// while its cases pass on both.
//
// After the shared suite, the checks only the headless host has: D15's
// unsupported members failing in their own shape (with an `unsupported-api`
// event each), the engine's world staying invisible to the page, attaching to
// a page that is already loaded, the view_page downscale, and detach.
//
// Needs a downloaded Chromium, so it is excluded from `npm test` and runs in
// its own tests.yml job under plain Node:
//
//   npx playwright install chromium
//   npm run build && node out/packages/mcp/test/playwright-conformance-harness.js
//
// SHIM_HEADED=1 runs it in a visible window; SHIM_CONFORMANCE_ONLY=apply,teardown
// runs a subset of the shared cases.

import http from 'http';
import type { AddressInfo } from 'net';
import { chromium } from 'playwright';
import {
  runConformance, conformanceFixture, formatConformanceResults, coveredCapabilities, CONFORMANCE_CASES,
} from '@shimbrowser/core/page-host-conformance';
import type { FixtureDeploy } from '@shimbrowser/core/page-host-conformance';
import { viewPageOnHost, MAX_SHOT_WIDTH } from '@shimbrowser/core/page-host-tools';
import type { PageRuntimeEvent } from '@shimbrowser/core/page-host';
import { attachPlaywrightPageHost, HEADLESS_CAPABILITIES, REQUIRES_SHIM_BROWSER } from '../src/playwright-page-host';
import { openHeadlessPage } from '../src/playwright-launch';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  const d = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !d ? '' : `  — ${d}`}`);
  if (!ok) failures++;
}

async function until<T>(probe: () => Promise<T | null | undefined> | T | null | undefined, timeoutMs = 6000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// A handler that touches every member the headless host lacks and records
// what each answered.
const PROBE_UNSUPPORTED = `async function probeUnsupported({ anchor, api }) {
  const out = {};
  out.fetch = await api.fetch('https://example.com/');
  out.ai = await api.ai.complete({ prompt: 'hi' });
  out.modules = await api.modules.invoke('m', 'p', []);
  out.settingsGet = await api.settings.get('enabled');
  out.settingsGetAll = await api.settings.getAll();
  out.db = api.db === undefined ? 'absent' : 'present';
  out.pack = api.storage.pack === undefined ? 'absent' : 'present';
  out.global = api.storage.global === undefined ? 'absent' : 'present';
  out.shared = api.shared === undefined ? 'absent' : 'present';
  out.forward = api.bridge.forwardRule('https://example.com', {}, 'x') === undefined ? 'nothing' : 'something';
  out.guarded = (api.db && 'ran') || 'skipped';
  anchor.setAttribute('data-conf-unsupported', JSON.stringify(out));
}`;

async function main(): Promise<void> {
  const state: { deploy: FixtureDeploy } = { deploy: 1 };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const r = conformanceFixture(pathname, state);
    res.writeHead(r.status, { ...r.headers, 'Content-Type': r.contentType });
    res.end(r.body);
  });
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: process.env.SHIM_HEADED !== '1' });

  try {
    // ── the shared suite ──
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const host = await attachPlaywrightPageHost(page);
    const only = process.env.SHIM_CONFORMANCE_ONLY ? process.env.SHIM_CONFORMANCE_ONLY.split(',') : undefined;
    const results = await runConformance({ host, origin, setDeploy: (d) => { state.deploy = d; } }, { only });
    const report = formatConformanceResults('playwright host', results);
    console.log(report.lines.join('\n'));
    failures += report.failed;
    if (!only) check('ran every shared case', results.length === CONFORMANCE_CASES.length, `${results.length}/${CONFORMANCE_CASES.length}`);

    // ── D15: every advertised capability is covered by a shared case ──
    console.log('\n── headless-only checks');
    const covered = coveredCapabilities();
    const uncovered = HEADLESS_CAPABILITIES.mutationKinds.filter((k) => !(covered as Set<string>).has(k));
    check('every mutation kind the headless host advertises has a conformance case', uncovered.length === 0, uncovered);

    // ── D15: unsupported members fail in their own shape ──
    const events: PageRuntimeEvent[] = [];
    const off = host.onRuntimeEvent((e) => { events.push(e); });
    {
      const loaded = host.waitForLoad({ timeoutMs: 10000 });
      host.reload(`${origin}/apply`);
      check('reload to /apply finished', (await loaded).kind === 'finished');
      const ruleKey = 'preview:conformance:unsupported';
      host.applyPreview({
        patchId: 'conformance', ruleKey,
        rule: { id: 'unsupported', anchor: { primary: { kind: 'css', value: '#storage-target' } }, mutations: [{ kind: 'script', handler: 'probeUnsupported' }], handlers: { probeUnsupported: PROBE_UNSUPPORTED } },
      });
      const raw = await until(async () => {
        const v = await host.evaluate(`document.querySelector('#storage-target').getAttribute('data-conf-unsupported')`, 'main');
        return typeof v === 'string' ? v : null;
      });
      const out: unknown = raw ? JSON.parse(raw) : null;
      const o: Record<string, unknown> = isRecord(out) ? out : {};
      const refusal = JSON.stringify({ ok: false, error: REQUIRES_SHIM_BROWSER });
      check('api.fetch resolves { ok: false, error: requires-shim-browser }', JSON.stringify(o.fetch) === refusal, o.fetch);
      check('api.ai.complete resolves the same refusal', JSON.stringify(o.ai) === refusal, o.ai);
      check('api.modules.invoke resolves the same refusal', JSON.stringify(o.modules) === refusal, o.modules);
      check('api.settings.get resolves undefined (the unconfigured answer)', !('settingsGet' in o), o.settingsGet);
      check('api.settings.getAll resolves {}', JSON.stringify(o.settingsGetAll) === '{}', o.settingsGetAll);
      check('api.db reads as absent', o.db === 'absent', o.db);
      check('api.storage.pack reads as absent', o.pack === 'absent', o.pack);
      check('api.storage.global reads as absent', o.global === 'absent', o.global);
      check('api.shared reads as absent', o.shared === 'absent', o.shared);
      check('api.bridge.forwardRule does nothing', o.forward === 'nothing', o.forward);
      check('an `api.db &&` guard behaves as in the browser', o.guarded === 'skipped', o.guarded);
      const want = ['fetch', 'ai.complete', 'modules.invoke', 'settings.get', 'settings.getAll', 'db', 'storage.pack', 'storage.global', 'shared', 'bridge.forwardRule'];
      const seen = new Set(events.filter((e) => e.kind === 'unsupported-api' && e.specId === ruleKey).map((e) => String(e.member)));
      const missing = want.filter((m) => !seen.has(m));
      check('every unsupported member recorded an unsupported-api event naming the preview', missing.length === 0, { missing, seen: [...seen] });
      host.removePreview(ruleKey);
    }
    off();

    // ── isolation: the engine is invisible to the page ──
    check('ShimCore is not visible in the page\'s main world', (await host.evaluate('typeof window.ShimCore', 'main')) === 'undefined');
    check('the engine runtime is not visible in the page\'s main world', (await host.evaluate('typeof window.__shimCoreRuntime', 'main')) === 'undefined');
    check('the engine world has the engine', (await host.evaluate('typeof ShimCore.run', 'engine')) === 'function');
    check('capabilities: the D15 headless set', !HEADLESS_CAPABILITIES.iframeRules && !HEADLESS_CAPABILITIES.componentIdentity
      && HEADLESS_CAPABILITIES.apiMembers.length === 0 && host.inspection === undefined);

    // ── view_page downscales a wide viewport ──
    await page.setViewportSize({ width: 1600, height: 900 });
    const wide = await viewPageOnHost(host, undefined, 'main');
    check(`view_page downscales a 1600px viewport to ${MAX_SHOT_WIDTH}px`, wide.width === MAX_SHOT_WIDTH && typeof wide.height === 'number' && Math.abs(wide.height - 720) <= 2, { width: wide.width, height: wide.height, error: wide.error });
    await page.setViewportSize({ width: 1280, height: 800 });

    // ── a selector crop on a scrolled page shoots the element, not the document top ──
    // The crop rect is viewport CSS px (getBoundingClientRect); Playwright's
    // non-fullPage clip is viewport-relative too (it adds the scroll offset
    // itself), so the host passes the rect through unchanged. A green target
    // 2000px down a red page, scrolled into view: the crop's centre is green.
    {
      const loaded = host.waitForLoad({ timeoutMs: 10000 });
      host.reload(`${origin}/apply`);
      check('reload to /apply finished (scrolled crop)', (await loaded).kind === 'finished');
      await host.evaluate(`(() => {
        document.body.replaceChildren();
        document.body.style.margin = '0';
        document.body.style.background = 'rgb(255, 0, 0)';
        document.body.style.height = '4000px';
        const t = document.createElement('div');
        t.id = 'scrolled-target';
        t.style.position = 'absolute';
        t.style.left = '100px';
        t.style.top = '2000px';
        t.style.width = '200px';
        t.style.height = '200px';
        t.style.background = 'rgb(0, 255, 0)';
        document.body.appendChild(t);
        window.scrollTo(0, 1900);
        return window.scrollY;
      })()`, 'main');
      const crop = await viewPageOnHost(host, { selector: '#scrolled-target' }, 'main');
      let centre: unknown = crop.error ?? null;
      if (crop.dataBase64 && crop.width && crop.height) {
        const decoder = await browser.newPage();
        try {
          centre = await decoder.evaluate(async ({ b64, w, h }) => {
            const img = new Image();
            img.src = 'data:image/png;base64,' + b64;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const g = c.getContext('2d');
            if (!g) return null;
            g.drawImage(img, 0, 0);
            return Array.from(g.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data.slice(0, 3));
          }, { b64: crop.dataBase64, w: crop.width, h: crop.height });
        } finally {
          await decoder.close();
        }
      }
      check('view_page crops a scrolled-into-view element at its viewport position', JSON.stringify(centre) === JSON.stringify([0, 255, 0]), centre);
    }

    // ── load failures read like the browser's ──
    {
      // A port nothing listens on: bind one, then let it go.
      const closed = http.createServer();
      const deadPort = await new Promise<number>((resolve) => closed.listen(0, '127.0.0.1', () => resolve((closed.address() as AddressInfo).port)));
      await new Promise<void>((resolve) => closed.close(() => resolve()));
      const loaded = host.waitForLoad({ timeoutMs: 10000 });
      host.reload(`http://127.0.0.1:${deadPort}/`);
      const outcome = await loaded;
      check('a refused connection settles the load wait as failed with the net error', outcome.kind === 'failed' && outcome.code === -102, outcome);
    }

    // ── detach ──
    await host.detach();
    check('a detached host reads as closed', host.isClosed());
    await context.close();

    // ── attaching to a page that is already loaded ──
    {
      const ctx2 = await browser.newContext();
      const page2 = await ctx2.newPage();
      await page2.goto(`${origin}/apply`);
      const late = await attachPlaywrightPageHost(page2);
      const lateEvents: PageRuntimeEvent[] = [];
      late.onRuntimeEvent((e) => { lateEvents.push(e); });
      late.applyPreview({ patchId: 'conformance', ruleKey: 'preview:conformance:late', rule: { id: 'late', anchor: { primary: { kind: 'css', value: '#ad' } }, mutations: [{ kind: 'hide' }] } });
      const hidden = await until(async () => (await late.evaluate(`getComputedStyle(document.querySelector('#ad')).display`, 'main')) === 'none' ? true : null);
      check('a host attached after the page loaded applies previews without a reload', hidden === true);
      check('…and streams its runtime events', lateEvents.some((e) => e.kind === 'rule-status' && e.specId === 'preview:conformance:late'));
      await late.detach();
      await ctx2.close();
    }

    // ── openHeadlessPage: launch + attach + first load in one call ──
    {
      const opened = await openHeadlessPage({ url: `${origin}/apply`, visible: process.env.SHIM_HEADED === '1' });
      try {
        check('openHeadlessPage loads the URL it was given', opened.host.url() === `${origin}/apply`, opened.host.url());
        opened.host.applyPreview({ patchId: 'conformance', ruleKey: 'preview:conformance:opened', rule: { id: 'opened', anchor: { primary: { kind: 'css', value: '#lead' } }, mutations: [{ kind: 'restyle', properties: { color: 'rgb(0, 0, 255)' } }] } });
        const blue = await until(async () => (await opened.host.evaluate(`getComputedStyle(document.querySelector('#lead')).color`, 'main')) === 'rgb(0, 0, 255)' ? true : null);
        check('…and its host applies previews', blue === true);
      } finally {
        await opened.close();
      }
      check('close() closes the page', opened.page.isClosed());
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (failures) {
    console.error(`\n✗ playwright-conformance: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ playwright-conformance: all checks passed');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
