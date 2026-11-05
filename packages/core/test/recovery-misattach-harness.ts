// Witness-driven recovery must never re-point a rule onto the wrong element.
// Bare node, stub DOM: the reconciler runs on a "new build" where the rule's
// selector matches nothing, and the checks read the events it reports.
//
//   node out/packages/core/test/recovery-misattach-harness.js
//
// Covers:
//   - a late-rendering popup's witness shares only a leading publication name
//     with the page's navbar, and the navbar's title holds that name alone:
//     the scan finds nothing (neither a shared head nor a fragment of the
//     stored stem is identity in recovery), and the reconciler quarantines
//     instead of re-pointing the hide rule at the navbar
//   - the same, with a stable attribute the navbar shares: a missed stored
//     stem fails the candidate outright in recovery, whatever else matches
//   - a target the scan does find, whose every synthesized rung also matches
//     other elements: no recovery (a single-element rule never recovers onto
//     a crowd selector), quarantine with the reason recorded
//   - a target with a unique rung still recovers, and every synthesized rung
//     on the new anchor resolves to exactly that element
//   - resolve-time verification keeps the shared-prefix tolerance (a
//     container whose body rows churn under a stable heading still verifies)

import { witnessRecoverDetail, positionalPath } from '../src/anchors';
import { matchWitness, buildWitness, WITNESS_VERSION } from '../src/witness';
import { makeReconciler } from '../src/rule-reconcile';
import { makeRuleState } from '../src/rule-state';
import type { RuntimeSpec } from '../src/engine-internal';
import type { CoreApi } from '../src/api';
import type { Anchor, AnchorSpec, Rule, Witness } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean, detail: unknown = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}

// Element stub: the subset of Element the witness, synthesis and recovery code
// read (tagName, attributes, getAttribute, children, childNodes with text
// nodes, parentElement, textContent).
interface StubEl {
  nodeType: 1;
  tagName: string;
  attributes: Array<{ name: string; value: string }>;
  children: StubEl[];
  childNodes: Array<StubEl | { nodeType: 3; data: string }>;
  parentElement: StubEl | null;
  getAttribute(n: string): string | null;
  readonly textContent: string;
}
function h(tag: string, attrs: Record<string, string> = {}, kids: StubEl[] = [], text = ''): StubEl {
  const e: StubEl = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    children: [],
    childNodes: text ? [{ nodeType: 3, data: text }] : [],
    parentElement: null,
    getAttribute(n: string) { const a = this.attributes.find((x) => x.name === n); return a ? a.value : null; },
    get textContent(): string { return (text || '') + this.children.map((c) => c.textContent).join(''); },
  };
  for (const k of kids) { k.parentElement = e; e.children.push(k); e.childNodes.push(k); }
  return e;
}
const asEl = (e: StubEl): Element => e as unknown as Element;
function walk(root: StubEl, out: StubEl[] = []): StubEl[] {
  out.push(root);
  for (const c of root.children) walk(c, out);
  return out;
}

// A stub document: tag scans walk the tree, selector queries answer from a
// table (anything not listed matches nothing).
function stubDocument(root: StubEl, selectors: Record<string, StubEl[]>) {
  const all = walk(root);
  return {
    getElementsByTagName: (tag: string) => (tag === '*' ? all : all.filter((e) => e.tagName === tag.toUpperCase())).map(asEl),
    querySelectorAll: (sel: string) => (selectors[sel] ?? []).map(asEl),
  };
}

interface Ev { kind: string; payload: Record<string, unknown> }
function reconcileAfterDeploy(anchor: Anchor, doc: ReturnType<typeof stubDocument>): Promise<Ev[]> {
  return new Promise((resolve) => {
    const events: Ev[] = [];
    (globalThis as unknown as { document: unknown }).document = doc;
    const api = {
      origin: 'x', host: 'x', patchId: 's', bridge: { forwardRule() {} },
      componentId: { verify: () => Promise.resolve(null), find: () => Promise.resolve([]), symbols: () => Promise.resolve(null) },
      reportEvent(kind: string, payload: Record<string, unknown> = {}) { events.push({ kind, payload }); },
      onReady() {},
    } as CoreApi;
    const rule: Rule = { id: 'hide-intro-popup', anchor, mutations: [{ kind: 'hide' }] };
    const spec = { id: 's', rules: [rule], bundleHash: 'b1', __bundleHashFn: () => 'b2' } as RuntimeSpec;
    const r = makeReconciler(rule, spec, api, makeRuleState(), new Set());
    r.start();
    setTimeout(() => { r.stop(); resolve(events); }, 4600);
  });
}

// --- the publication page, popup not rendered yet --------------------------
// #entry > #main > [navbar wrapper] > navbar (publication name, subscribe,
// sign in) + a feed of post cards + a footer, every one of them
// `div.pencraft.pc-display-flex` with a few div children.
const CARD = 'div.pencraft.pc-display-flex';
function card(texts: string[], attrs: Record<string, string> = {}): StubEl {
  return h('div', { class: 'pencraft pc-display-flex', ...attrs }, texts.map((t) => h('div', {}, [], t)));
}
function publicationPage(extra: StubEl[] = []) {
  const navbar = card(['Marcus on AI', 'Subscribe', 'Sign in']);
  const navWrap = h('div', { 'data-testid': 'navbar' }, [navbar]);
  const posts = Array.from({ length: 20 }, (_, i) => card([`Post ${i} headline`, 'Gary Marcus', 'Nov 3']));
  const footer = card(['© 2026 Gary Marcus', 'Privacy', 'Terms']);
  const feed = h('div', {}, [...posts, ...extra]);
  const main = h('div', { id: 'main' }, [navWrap, feed, footer]);
  const entry = h('div', { id: 'entry' }, [main]);
  const body = h('body', {}, [entry]);
  const crowd = [navbar, ...posts, footer, ...extra.filter((e) => e.getAttribute('class') === 'pencraft pc-display-flex')];
  return { body, navbar, posts, crowd };
}
// What every rung synthesis emits for a crowd member resolves to: the crowd.
function crowdSelectors(members: StubEl[], navbar: StubEl): Record<string, StubEl[]> {
  const table: Record<string, StubEl[]> = {
    [CARD]: members,
    'div.pencraft': members,
    '[data-testid="navbar"] div.pencraft': [navbar],
    '#main div.pencraft': members,
    '#entry .intro-popup': [],
  };
  for (const m of members) table[positionalPath(asEl(m))] = members;
  return table;
}

// The witness the popup rule committed with (the live one, component dropped).
const popupWitness: Witness = {
  v: WITNESS_VERSION, tag: 'div',
  textStem: 'marcus on ai"marcus has become one of ou', textStemFrom: 'visible',
  childTags: ['div'], parentTag: 'div',
};

async function tSharedPrefixIsNotIdentity() {
  console.log('late-rendering popup, navbar shares the publication name:');
  const { body, navbar, crowd } = publicationPage();
  // The navbar's stem shares exactly the publication name with the popup's.
  const navStem = buildWitness(asEl(navbar))?.textStem ?? '';
  check('fixture: navbar stem shares only the 12-char publication name', navStem.startsWith('marcus on ai') && !popupWitness.textStem?.startsWith(navStem), navStem);
  const doc = stubDocument(body, crowdSelectors(crowd, navbar));
  const title = navbar.children[0];
  if (!title) throw new Error('fixture: navbar has no title');
  const textMissed = (e: StubEl) => matchWitness(popupWitness, asEl(e), { fullStem: true }).detail.some((d) => d.startsWith('text:'));
  check('recovery matching misses the navbar\'s text (shared head only)', textMissed(navbar), matchWitness(popupWitness, asEl(navbar), { fullStem: true }));
  check('recovery matching misses the bare title\'s text (a fragment of the stem)', textMissed(title), matchWitness(popupWitness, asEl(title), { fullStem: true }));
  const grown = h('div', {}, [h('div', {}, [], 'Marcus on AI"Marcus has become one of our most important voices, now with more')]);
  h('div', {}, [grown]);
  check('recovery matching still accepts the popup with trailing text added', matchWitness(popupWitness, asEl(grown), { fullStem: true }).pass, matchWitness(popupWitness, asEl(grown), { fullStem: true }));
  const scan = witnessRecoverDetail(popupWitness, doc);
  check('the recovery scan finds nothing', scan.el === null, scan.el ? `picked <${scan.el.tagName}> "${(scan.el.textContent || '').slice(0, 40)}"` : '');

  const events = await reconcileAfterDeploy({ primary: { kind: 'css', value: '#entry .intro-popup' }, witness: popupWitness }, doc);
  const rebase = events.find((e) => e.kind === 'rule-rebase');
  check('no rule-rebase: the hide rule is never re-pointed at the navbar', !rebase, rebase?.payload);
  check('the break quarantines (needs review)', events.some((e) => e.kind === 'rule-quarantined'), events.map((e) => e.kind));
}

async function tSharedAttrDoesNotOutweighText() {
  console.log('popup witness with a role the navbar shares:');
  const { body, navbar, crowd } = publicationPage();
  navbar.attributes.push({ name: 'role', value: 'region' });
  const w: Witness = { ...popupWitness, attrs: { role: 'region' } };
  const table = crowdSelectors(crowd, navbar);
  table['[role="region"]'] = [navbar];
  const doc = stubDocument(body, table);
  const verdict = matchWitness(w, asEl(navbar), { fullStem: true });
  check('recovery matching fails the navbar outright (text missed, role matched)', !verdict.pass, verdict);
  const scan = witnessRecoverDetail(w, doc);
  check('the recovery scan finds nothing', scan.el === null, scan.reason);
  const events = await reconcileAfterDeploy({ primary: { kind: 'css', value: '#entry .intro-popup' }, witness: w }, doc);
  const rebase = events.find((e) => e.kind === 'rule-rebase');
  check('no rule-rebase onto the navbar\'s unique role selector', !rebase, rebase?.payload);
  check('the break quarantines', events.some((e) => e.kind === 'rule-quarantined'), events.map((e) => e.kind));
}

async function tCrowdOnlyLadderRefuses() {
  console.log('found target whose every rung matches a crowd:');
  // A real upsell card the scan can find (its stem contains the witness's),
  // but with nothing on it that selects it alone.
  const upsell = card(['Upgrade to paid', 'Get every post', 'Cancel anytime']);
  const { body, navbar, crowd } = publicationPage([upsell]);
  const w = buildWitness(asEl(upsell));
  if (!w) throw new Error('fixture: no witness');
  const doc = stubDocument(body, crowdSelectors(crowd, navbar));
  const scan = witnessRecoverDetail(w, doc);
  check('fixture: the scan does find the upsell card', scan.el === asEl(upsell), scan.reason);

  const events = await reconcileAfterDeploy({ primary: { kind: 'css', value: '.upsell-old' }, witness: w }, doc);
  const rebase = events.find((e) => e.kind === 'rule-rebase');
  check('no rule-rebase onto a selector matching many elements', !rebase, rebase?.payload);
  const q = events.find((e) => e.kind === 'rule-quarantined');
  check('quarantines, recording why recovery refused', !!q && /no anchor selects only/.test(String(q.payload.recovery)), q?.payload);
}

async function tUniqueRungRecovers() {
  console.log('found target with a unique rung:');
  const upsell = card(['Upgrade to paid', 'Get every post', 'Cancel anytime'], { 'data-testid': 'upsell' });
  const { body, navbar, crowd } = publicationPage([upsell]);
  const w = buildWitness(asEl(upsell));
  if (!w) throw new Error('fixture: no witness');
  const table = crowdSelectors(crowd, navbar);
  table['[data-testid="upsell"]'] = [upsell];
  const doc = stubDocument(body, table);

  const events = await reconcileAfterDeploy({ primary: { kind: 'css', value: '.upsell-old' }, witness: w }, doc);
  const rebase = events.find((e) => e.kind === 'rule-rebase');
  const anchor = rebase?.payload.anchor as Anchor | undefined;
  check('recovers (strategy recover, via witness)', rebase?.payload.strategy === 'recover' && rebase.payload.via === 'witness', events.map((e) => e.kind));
  const resolvesToTarget = (spec: AnchorSpec) => {
    const sel = spec.kind === 'data-attr' ? `[${spec.name}="${spec.value}"]` : spec.value ?? '';
    const found = doc.querySelectorAll(sel);
    return found.length === 1 && found[0] === asEl(upsell);
  };
  check('the new primary selects exactly the recovered element', !!anchor && resolvesToTarget(anchor.primary), anchor?.primary);
  const synthesized = (anchor?.fallbacks ?? []).filter((f) => !(f.kind === 'css' && f.value === '.upsell-old'));
  check('every synthesized fallback selects exactly the recovered element', synthesized.every(resolvesToTarget), synthesized);
}

function tResolveTimeKeepsPrefixTolerance() {
  console.log('resolve-time verification is unchanged:');
  const w: Witness = { v: WITNESS_VERSION, tag: 'div', textStem: 'estimates needing attentioncolin\'s pala', textStemFrom: 'visible' };
  const later = h('div', {}, [], 'Estimates Needing Attention97Beacon Tower Phase 2');
  check('a churned container under a stable heading still verifies at resolve time', matchWitness(w, asEl(later)).pass, matchWitness(w, asEl(later)));
}

async function main() {
  console.log('\n=== recovery-misattach harness ===\n');
  await tSharedPrefixIsNotIdentity();
  await tSharedAttrDoesNotOutweighText();
  await tCrowdOnlyLadderRefuses();
  await tUniqueRungRecovers();
  tResolveTimeKeepsPrefixTolerance();
  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall recovery-misattach checks passed');
}
void main();
