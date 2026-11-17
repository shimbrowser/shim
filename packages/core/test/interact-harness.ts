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
//   - a session's narrowing: a refused target, a failed boundary check (its
//     reason is the step's error, and the command it guarded never goes
//     out), the user's own input (interrupted: "user")
//   - a scroll step: parsed only where offered, capped, scaled by the host's
//     wheel units, reporting requested / sent / observed
//   - a press is one user action: key-down, character and key-up go out as
//     separate commands; once the key-down went out, a refusal before the
//     rest withholds it but reports the press delivered (with a note), never
//     "not sent"; a refusal before the key-down still fails the step
//   - steps that completed survive a later dispatch failure
//   - a host that doesn't observe the page's requests reports calls: null
//     with traffic "not observed", never an empty list

import {
  runInteract, parseInteractInput, locateScript, selectScript, HIDDEN_BY_ANCESTOR_SOURCE, OBSERVE_START_SCRIPT, OBSERVE_READ_SCRIPT, MAX_SCROLL_PX,
  type InteractDeps, type InteractDocumentPolicy, type CdpCommand, type LocateResult, type InteractStepEvent,
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
    '.far': { count: 1, x: 5, y: -3900, visible: true, offscreen: true, covered: null, disabled: false, tag: 'select' },
    '.gated': { count: 1, x: 5, y: 6, visible: false, covered: null, disabled: false, tag: 'select', hiddenBy: 'div#outer has visibility: hidden' },
    '.ghost': { count: 1, x: 5, y: 6, visible: false, covered: null, disabled: false, tag: 'button', hiddenBy: null },
  };
  f.deps = {
    guard: () => null,
    currentDocument: () => f.doc,
    policy,
    aborted: () => f.aborted,
    locate: async (sel) => targets[sel] ?? { count: 0 },
    selectValue: async () => ({ ok: true }),
    dispatch: over.dispatch ?? (async (commands, pin) => {
      const sent: CdpCommand[] = [];
      for (const [i, c] of commands.entries()) {
        if (!(await pin.before(i))) { f.sent.push(sent); return false; }
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
    // A portal following an anchor scrolled out of view: scrollIntoView
    // can't move a fixed layer, and nothing covers it — say so, not "covered".
    const f = fake();
    const r = await runInteract({ actions: [{ click: '.far' }] }, f.deps);
    const err = 'error' in r ? '' : String(r.steps[0]?.error);
    check('a target left outside the viewport is reported off screen, not covered, nothing sent',
      err.includes('outside the viewport') && err.includes('anchor is on screen') && !err.includes('covered by') && f.sent.length === 0, JSON.stringify(r));
  }
  {
    // The site hides the page behind a gate (a terms prompt): name the
    // ancestor that hides the target, so it doesn't read as the shim's fault.
    const f = fake();
    const r = await runInteract({ actions: [{ select: '.gated', value: 'x' }] }, f.deps);
    const err = 'error' in r ? '' : String(r.steps[0]?.error);
    check('a target an ancestor hides names that ancestor, nothing sent',
      err.startsWith('.gated is not visible: the page hides it') && err.includes('div#outer has visibility: hidden') && f.sent.length === 0, err);
    const r2 = await runInteract({ actions: [{ click: '.ghost' }] }, fake().deps);
    check('a target hidden by itself keeps the plain answer',
      !('error' in r2) && r2.steps[0]?.error === '.ghost is not visible', JSON.stringify(r2));
  }
  {
    // The page-side finder, over stub nodes: the outermost display:none
    // ancestor wins; otherwise the top of the run of hidden ancestors.
    type Stub = { tagName: string; id?: string; className?: string; parentElement: Stub | null; display?: string; visibility?: string };
    const find = new Function(`return (${HIDDEN_BY_ANCESTOR_SOURCE});`)() as (el: Stub, styleOf: (n: Stub) => { display: string; visibility: string }) => string | null;
    const styleOf = (n: Stub) => ({ display: n.display ?? 'block', visibility: n.visibility ?? 'visible' });
    const body: Stub = { tagName: 'BODY', parentElement: null };
    const outer: Stub = { tagName: 'DIV', id: 'outer', parentElement: body, visibility: 'hidden' };
    const inner: Stub = { tagName: 'DIV', className: 'wrapper  main', parentElement: outer, visibility: 'hidden' };
    const btn: Stub = { tagName: 'BUTTON', parentElement: inner, visibility: 'hidden' };
    check('inherited visibility is blamed on the ancestor that set it', find(btn, styleOf) === 'div#outer has visibility: hidden', String(find(btn, styleOf)));
    const self: Stub = { tagName: 'SPAN', parentElement: body, visibility: 'hidden' };
    check('an element hidden by itself blames no ancestor', find(self, styleOf) === null);
    const shown: Stub = { tagName: 'SPAN', parentElement: inner };
    check('a visible element blames no ancestor', find(shown, styleOf) === null);
    const tpl: Stub = { tagName: 'SECTION', className: 'tpl', parentElement: body, display: 'none' };
    const mid: Stub = { tagName: 'DIV', parentElement: tpl, display: 'none' };
    const leaf: Stub = { tagName: 'A', parentElement: mid };
    check('the outermost display:none ancestor is named, by class when it has no id', find(leaf, styleOf) === 'section.tpl has display: none', String(find(leaf, styleOf)));
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

  console.log('a session\'s narrowing:');
  {
    const f = fake();
    const loc = f.deps.locate;
    f.deps.locate = async (sel, action) => ({ ...(await loc(sel, action)), refused: 'not-shim-dom: .go is the site\'s own DOM' });
    const r = await runInteract({ actions: [{ click: '.go' }, { press: 'Enter' }] }, f.deps);
    check('a refused target fails with the session\'s reason, before any input', !('error' in r) && r.steps[0]?.error?.startsWith('not-shim-dom') === true && r.notRun === 1 && f.sent.length === 0, JSON.stringify(r));
  }
  {
    const f = fake();
    const seen: string[] = [];
    f.deps.boundaryCheck = async (c) => { seen.push(String(c.params.type)); return c.params.type === 'mousePressed' ? 'the press would land on div#overlay' : null; };
    const r = await runInteract({ actions: [{ click: '.go' }] }, f.deps);
    check('a failed boundary check stops before the command it guards, with its reason',
      !('error' in r) && r.steps[0]?.error === 'the press would land on div#overlay' && (f.sent[0] ?? []).length === 1 && seen.join() === 'mouseMoved,mousePressed', JSON.stringify({ r, seen }));
  }
  {
    const f = fake();
    let user = false;
    f.deps.interrupted = () => user;
    f.deps.wait = async () => { user = true; };
    const r = await runInteract({ actions: [{ click: '.go' }, { click: '.go' }] }, f.deps);
    check('the user\'s own input stops the batch: interrupted "user", the step says so',
      !('error' in r) && r.interrupted === 'user' && r.steps.length === 2 && r.steps[0]?.ok === true && r.steps[1]?.ok === false && /the user used the page/.test(r.steps[1]?.error ?? '') && f.sent.length === 1, JSON.stringify(r));
  }
  {
    let calls = 0;
    const f = fake({ dispatch: async () => { calls++; if (calls === 2) throw new Error('channel gone'); return true; } });
    const r = await runInteract({ actions: [{ click: '.go' }, { click: '.go' }, { press: 'Enter' }] }, f.deps);
    check('a dispatch failure after a completed step keeps that step in the report',
      !('error' in r) && r.steps.length === 2 && r.steps[0]?.ok === true && /^interaction-unavailable/.test(r.steps[1]?.error ?? '') && r.notRun === 1, JSON.stringify(r));
  }
  {
    const f = fake();
    const events: InteractStepEvent[] = [];
    f.deps.onStep = (e) => { events.push(e); };
    f.deps.callCursor = undefined;
    f.deps.callsSince = undefined;
    f.deps.scope = 'shim-dom';
    const r = await runInteract({ actions: [{ click: '.go' }] }, f.deps);
    check('unobserved traffic is calls: null, traffic "not observed" — never []', !('error' in r) && r.calls === null && r.traffic === 'not observed' && r.scope === 'shim-dom', JSON.stringify(r));
    check('each step streams a start and an end', events.map((e) => `${e.phase}:${e.action}:${e.ok ?? ''}`).join('|') === 'start:click .go:|done:click .go:true', JSON.stringify(events));
  }
  {
    const f = fake();
    const r = await runInteract({ actions: [{ click: '.go' }] }, f.deps);
    check('an observing host keeps calls a list and says nothing of traffic', !('error' in r) && Array.isArray(r.calls) && r.traffic === undefined && r.scope === undefined);
  }

  {
    // The page moves on between two actions — during the next action's own
    // document read — so the second must never run against the new page.
    const f = fake();
    let syncs = 0;
    f.deps.syncDocument = async () => { syncs++; if (syncs === 4) f.doc = 'doc-b'; };
    const r = await runInteract({ actions: [{ click: '.go' }, { click: '.go' }] }, f.deps);
    check('a document change during the next action\'s sync ends the batch: the last step navigated, the rest not run',
      !('error' in r) && r.steps.length === 1 && r.steps[0]?.navigated === true && r.notRun === 1 && f.sent.length === 1, JSON.stringify(r));
  }

  console.log('a press is one user action:');
  {
    const f = fake();
    const types = (i: number): string => (f.sent[i] ?? []).map((c) => String(c.params.type)).join();
    await runInteract({ actions: [{ press: 'Enter' }, { press: 'Escape' }] }, f.deps);
    check('a character key goes out as key-down, character, key-up (each its own command); others without the character',
      types(0) === 'rawKeyDown,char,keyUp' && (f.sent[0]?.[1]?.params.text) === '\r' && types(1) === 'rawKeyDown,keyUp', JSON.stringify(f.sent));
  }
  for (const refusedAt of ['char', 'keyUp'] as const) {
    // The shim's handler closed its focused field on the key-down: the check
    // before the rest of the key refuses.
    const f = fake();
    f.deps.boundaryCheck = async (c) => (c.params.type === refusedAt ? 'focus-not-shim: nothing of this shim\'s has focus' : null);
    const r = await runInteract({ actions: [{ press: 'Enter' }, { click: '.go' }] }, f.deps);
    const sent = (f.sent[0] ?? []).map((c) => String(c.params.type)).join();
    check(`refused before its ${refusedAt}, a press whose key-down went out is delivered, with a note — the batch goes on`,
      !('error' in r) && r.steps[0]?.ok === true && r.steps[0]?.error === undefined && r.steps[0]?.note?.startsWith('the key was delivered') === true
        && r.steps[0]?.note?.includes('focus-not-shim') === true && r.steps[1]?.ok === true && r.notRun === 0, JSON.stringify(r));
    check(`…and nothing from the ${refusedAt} on went out`, sent === (refusedAt === 'char' ? 'rawKeyDown' : 'rawKeyDown,char'), sent);
    const note = 'error' in r ? undefined : r.steps[0]?.note;
    check('…the note names what was withheld', refusedAt === 'char'
      ? note?.includes('its character and its key-up were not sent') === true
      : note?.includes('its key-up was not sent') === true, note);
  }
  {
    const f = fake();
    f.deps.boundaryCheck = async (c) => (c.params.type === 'rawKeyDown' ? 'focus-not-shim: nothing of this shim\'s has focus' : null);
    const r = await runInteract({ actions: [{ press: 'Enter' }, { click: '.go' }] }, f.deps);
    check('refused before its key-down, a press is not sent: the step fails, the rest not run',
      !('error' in r) && r.steps[0]?.ok === false && r.steps[0]?.error?.startsWith('focus-not-shim') === true && r.notRun === 1 && (f.sent[0] ?? []).length === 0, JSON.stringify(r));
  }
  {
    // The user's own input arrives between the key-down and the rest.
    const f = fake();
    let user = false;
    f.deps.interrupted = () => user;
    f.deps.boundaryCheck = async (c) => { if (c.params.type === 'char') user = true; return null; };
    const r = await runInteract({ actions: [{ press: 'Enter' }, { click: '.go' }] }, f.deps);
    check('the user\'s input after the key-down: the press is delivered, the batch stops (interrupted "user")',
      !('error' in r) && r.interrupted === 'user' && r.steps.length === 1 && r.steps[0]?.ok === true && /the user used the page/.test(r.steps[0]?.note ?? '') && r.notRun === 1, JSON.stringify(r));
  }
  {
    // Enter's key-down navigated (a form submitted): the key went; the page moved on.
    const f = fake();
    f.deps.boundaryCheck = async (c) => { if (c.params.type === 'char') f.doc = 'doc-b'; return null; };
    const r = await runInteract({ actions: [{ press: 'Enter' }, { click: '.go' }] }, f.deps);
    check('a key-down that navigates: the press is delivered and marked navigated, the batch ends',
      !('error' in r) && r.steps[0]?.ok === true && r.steps[0]?.navigated === true && r.notRun === 1, JSON.stringify(r));
  }

  console.log('scroll:');
  check('scroll is refused unless the session offers it', 'error' in parseInteractInput({ actions: [{ scroll: { by: 100 } }] }));
  check('a zero or non-number scroll is refused', 'error' in parseInteractInput({ actions: [{ scroll: { by: 0 } }] }, { scroll: true }) && 'error' in parseInteractInput({ actions: [{ scroll: {} }] }, { scroll: true }));
  {
    const f = fake();
    let y = 100;
    f.deps.viewport = async () => ({ width: 800, height: 600, scrollY: y, wheelScale: 1.5 });
    f.deps.dispatch = async (commands) => { f.sent.push(commands); y += 1000; return true; };
    const r = await runInteract({ actions: [{ scroll: { by: 5000 } }] }, f.deps, { scroll: true });
    const wheel = f.sent[0]?.[0];
    check('a scroll is one trusted wheel at the viewport centre, capped and scaled to the host\'s wheel units',
      wheel?.params.type === 'mouseWheel' && wheel.params.x === 400 && wheel.params.y === 300 && wheel.params.deltaY === Math.round(MAX_SCROLL_PX * 1.5), JSON.stringify(wheel));
    check('…reporting requested, sent and observed movement', !('error' in r) && JSON.stringify(r.steps[0]?.scrolled) === JSON.stringify({ requested: 5000, sent: MAX_SCROLL_PX, observed: 1000 }), JSON.stringify(r));
  }
  {
    const f = fake();
    const r = await runInteract({ actions: [{ scroll: { by: -200 } }] }, f.deps, { scroll: true });
    check('a host with no viewport read refuses the scroll step', !('error' in r) && r.steps[0]?.ok === false && /not available/.test(r.steps[0]?.error ?? ''));
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
