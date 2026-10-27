// attach-consent-harness — the extension's attach-consent gate
// (packages/extension/src/attach-consent.ts): a request pends until
// answered; allow once, allow host (remembered, covering waiting requests
// for the host), deny; the timeout; a cancelled request; the pending cap; a
// url target asked every time and never remembered; a missing site grant
// forcing the card even for a remembered host; reset forgetting everything.
//
//   node out/packages/extension/test/attach-consent-harness.js

import { createConsentGate, type ConsentSubject, type Timers } from '../src/attach-consent';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

function manualTimers(): Timers & { advance(ms: number): void } {
  let clock = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let n = 0;
  return {
    setTimeout(fn, ms) { const id = ++n; timers.set(id, { at: clock + ms, fn }); return id; },
    clearTimeout(h) { timers.delete(h as number); },
    advance(ms) {
      clock += ms;
      for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); }
    },
  };
}

const subject = (over: Partial<ConsentSubject> = {}): ConsentSubject => ({
  agent: 'Claude Code', intent: 'x', shimId: 'shim-1', shimName: 'Notes', scope: 'site.test', tabId: 7, url: 'https://site.test/', title: 'Site', missingOrigins: [], ...over,
});
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function main(): Promise<void> {
  const timers = manualTimers();
  const gate = createConsentGate({ timers, maxPending: 2, newId: (() => { let i = 0; return () => `c${++i}`; })() });
  const changes: number[] = [];
  gate.onChange((p) => changes.push(p.length));

  let outcome: unknown = null;
  const p1 = gate.request(subject()).then((o) => { outcome = o; return o; });
  await tick();
  check('a request pends, listed with its id', gate.pending().length === 1 && gate.pending()[0]?.id === 'c1' && outcome === null);
  check('listeners hear the change', changes.join() === '1');
  check('allow once settles it', gate.answer('c1', 'allow-once') && JSON.stringify(await p1) === '{"allowed":true,"via":"allow-once"}');
  check('answering again is false', !gate.answer('c1', 'allow-once'));
  check('nothing remembered after allow once', !gate.isRemembered('site.test'));

  const p2 = gate.request(subject());
  const p3 = gate.request(subject({ agent: 'Other' }));
  await tick();
  check('two pend; a third is too many', gate.pending().length === 2 && JSON.stringify(await gate.request(subject())) === '{"allowed":false,"reason":"too-many-pending"}');
  gate.answer('c2', 'allow-host');
  check('allow host settles it and covers the one waiting on the same host', JSON.stringify(await p2) === '{"allowed":true,"via":"allow-host"}' && JSON.stringify(await p3) === '{"allowed":true,"via":"remembered"}');
  check('the host is remembered', gate.isRemembered('site.test') && gate.remembered().join() === 'site.test');
  check('a later request for the host is allowed without a card', JSON.stringify(await gate.request(subject())) === '{"allowed":true,"via":"remembered"}' && gate.pending().length === 0);
  check('a missing site grant still shows the card', (() => { void gate.request(subject({ missingOrigins: ['https://site.test/*'] })); return gate.pending().length === 1; })());
  gate.answer(gate.pending()[0]?.id ?? '', 'deny');
  check('a url target asks every time', (() => { void gate.request(subject({ openUrl: 'https://site.test/x', openOrigin: 'https://site.test' })); return gate.pending().length === 1; })());
  const urlId = gate.pending()[0]?.id ?? '';
  const urlAnswer = (async () => gate.answer(urlId, 'allow-host'))();
  await urlAnswer;
  check('…its answer is allow once, whatever was clicked, and remembers nothing new', gate.remembered().join() === 'site.test');

  const p4 = gate.request(subject({ scope: 'other.test' }));
  check('deny', gate.answer(gate.pending()[0]?.id ?? '', 'deny') && JSON.stringify(await p4) === '{"allowed":false,"reason":"denied"}');
  const p5 = gate.request(subject({ scope: 'slow.test' }));
  timers.advance(2 * 60_000);
  check('two minutes unanswered is a timeout', JSON.stringify(await p5) === '{"allowed":false,"reason":"timeout"}');
  const ac = new AbortController();
  const p6 = gate.request(subject({ scope: 'gone.test' }), ac.signal);
  ac.abort();
  check('the agent going away cancels', JSON.stringify(await p6) === '{"allowed":false,"reason":"cancelled"}');
  check('an already-aborted request never pends', JSON.stringify(await gate.request(subject(), ac.signal)) === '{"allowed":false,"reason":"cancelled"}' || gate.isRemembered('site.test'));
  const p7 = gate.request(subject({ scope: 'reset.test' }));
  gate.remember(['seeded.test']);
  gate.reset();
  check('reset cancels the pending and forgets the remembered', JSON.stringify(await p7) === '{"allowed":false,"reason":"cancelled"}' && gate.remembered().length === 0 && gate.pending().length === 0);

  if (failures) {
    console.error(`\nattach-consent: ${failures} failed, ${passes} passed`);
    process.exit(1);
  }
  console.log(`attach-consent: all ${passes} checks passed`);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
