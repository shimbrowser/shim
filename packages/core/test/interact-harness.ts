// Pins interact_page's batch runner (src/interact.ts) through its document
// policy, independently of any session kind: a policy with string document
// ids and its own refusal wording drives the same loop a composition build
// does. Bare node; fakes stand in for the page and the input channel.
//
//   node out/packages/core/test/interact-harness.js
//
// Pins:
//   - the policy decides which documents take input: a refused document ends
//     the call before any action, with the policy's own answer; one the
//     policy stops accepting mid-batch ends the batch with the policy's
//     wording, the rest not run
//   - the policy's stop and unavailable wording reach the report
//   - document identity is compared by value, so a string token works
//   - the page-side scripts are self-contained expressions

import {
  runInteract, parseInteractInput, locateScript, selectScript, OBSERVE_START_SCRIPT, OBSERVE_READ_SCRIPT,
  type InteractDeps, type InteractDocumentPolicy, type CdpCommand, type LocateResult,
} from '../src/interact';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

console.log('\n=== interact harness ===\n');

interface Fake { deps: InteractDeps; sent: CdpCommand[][]; doc: string; accepted: Set<string>; aborted: boolean }

function fake(over: { dispatch?: InteractDeps['dispatch']; afterDispatch?: (f: Fake) => void } = {}): Fake {
  const f: Fake = { deps: undefined as unknown as InteractDeps, sent: [], doc: 'doc-a', accepted: new Set(['doc-a', 'doc-b']), aborted: false };
  const policy: InteractDocumentPolicy = {
    accepts: (doc) => typeof doc === 'string' && f.accepted.has(doc),
    refused: { error: 'not-our-document', detail: 'reload first' },
    lost: 'the document went away',
    stopped: 'the session ended',
    unavailable: 'no input channel',
  };
  const targets: Record<string, LocateResult> = {
    '.go': { count: 1, x: 5, y: 6, visible: true, covered: null, disabled: false, tag: 'button' },
  };
  f.deps = {
    guard: () => null,
    currentDocument: () => f.doc,
    policy,
    aborted: () => f.aborted,
    locate: async (sel) => targets[sel] ?? { count: 0 },
    selectValue: async () => ({ ok: true }),
    dispatch: over.dispatch ?? (async (commands, stillPinned) => {
      const sent: CdpCommand[] = [];
      for (const c of commands) {
        if (!stillPinned()) { f.sent.push(sent); return false; }
        sent.push(c);
      }
      f.sent.push(sent);
      over.afterDispatch?.(f);
      return true;
    }),
    wait: async () => {},
    startObserving: async () => {},
    readObserved: async () => 2,
    consoleErrorsSince: () => [],
    callCursor: () => 0,
    callsSince: () => [],
    linkCursor: () => 0,
    linksSince: () => [],
    now: () => 0,
    mac: false,
  };
  return f;
}

async function main(): Promise<void> {
  console.log('document policy:');
  {
    const f = fake();
    const r = await runInteract({ actions: [{ click: '.go' }] }, f.deps);
    check('an accepted string document takes input', !('error' in r) && r.steps[0]?.ok === true && f.sent.length === 1, JSON.stringify(r));
  }
  {
    const f = fake();
    f.doc = 'doc-z';
    const r = await runInteract({ actions: [{ click: '.go' }] }, f.deps);
    check('a refused document gets the policy\'s own answer, nothing sent',
      'error' in r && r.error === 'not-our-document' && r.detail === 'reload first' && f.sent.length === 0, JSON.stringify(r));
  }
  {
    const f = fake({ afterDispatch: (x) => { x.accepted.delete('doc-a'); } });
    const r = await runInteract({ actions: [{ click: '.go' }, { press: 'Enter' }] }, f.deps);
    check('a document the policy stops accepting ends the batch with the policy\'s wording',
      !('error' in r) && r.steps[1]?.error === 'the document went away' && r.steps.length === 2 && f.sent.length === 1, JSON.stringify(r));
  }
  {
    const f = fake();
    f.aborted = true;
    const r = await runInteract({ actions: [{ click: '.go' }] }, f.deps);
    check('a stop reads in the policy\'s wording', !('error' in r) && r.steps[0]?.error === 'the session ended');
  }
  {
    const f = fake({ dispatch: async () => { throw new Error('gone'); } });
    const r = await runInteract({ actions: [{ click: '.go' }] }, f.deps);
    check('an unavailable channel carries the policy\'s detail', 'error' in r && r.error === 'interaction-unavailable' && r.detail === 'no input channel');
  }
  {
    const f = fake({ afterDispatch: (x) => { x.doc = 'doc-b'; } });
    const r = await runInteract({ actions: [{ click: '.go' }, { press: 'Enter' }] }, f.deps);
    check('a new (still accepted) document after an action is a navigation: the batch ends',
      !('error' in r) && r.steps[0]?.navigated === true && r.notRun === 1, JSON.stringify(r));
  }

  console.log('input + scripts:');
  check('a valid batch parses', !('error' in parseInteractInput({ actions: [{ click: 'a' }, { select: 's', value: 'v' }] })));
  for (const [name, code] of [
    ['locate', locateScript('a[href="x"]')],
    ['select', selectScript('select', 'it\'s "quoted"')],
    ['observe start', OBSERVE_START_SCRIPT],
    ['observe read', OBSERVE_READ_SCRIPT],
  ] as const) {
    let parses = true;
    try { new Function(`return ${code};`); } catch { parses = false; }
    check(`the ${name} script is one parseable expression`, parses);
  }
}

void main().then(() => {
  console.log('');
  if (failures) { console.error(`${failures} interact check(s) failed`); process.exit(1); }
  console.log(`all ${passes} interact checks passed`);
}, (e: unknown) => { console.error(e); process.exit(1); });
