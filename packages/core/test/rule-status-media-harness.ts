// Harness for the rule-status media guard (packages/core/src/rule-status.ts,
// `mediaHideKind`). Bare node — elements are duck-typed stubs shaped like the
// subset of Element the reporter reads (`matches`, `querySelector`,
// `getBoundingClientRect`, `ownerDocument`).
//
//   node out/packages/core/test/rule-status-media-harness.js
//
// The verdict 'media' means "this hide/remove blanks the page's player". It
// holds when a matched element IS a <video>/<audio>, or when the rule matched a
// single element that wraps one. A multi-match hide where one of many matches
// merely contains a media element (a sponsored tile with an autoplay preview
// among 18 tiles) is not the player and must not warn.

import { makeStatusReporter } from '../src/rule-status';
import { makeRuleState } from '../src/rule-state';
import type { CoreApi } from '../src/api';
import type { RuleMountEntry } from '../src/engine-internal';
import type { Rule, Spec } from '../src/types';
import { describeRuleStatus } from '../src/preview-evidence';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const win = { innerWidth: 1000, innerHeight: 1000, getComputedStyle: () => ({ display: 'block' }) };
const doc: { defaultView: typeof win; documentElement?: { scrollWidth: number; scrollHeight: number } } = { defaultView: win };

interface Stub {
  tag: string;
  children: Stub[];
  ownerDocument: typeof doc;
  matches(sel: string): boolean;
  querySelector(sel: string): Stub | null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}

function el(tag: string, children: Stub[] = []): Stub {
  const node: Stub = {
    tag,
    children,
    ownerDocument: doc,
    matches: (sel) => sel === 'video, audio' && (tag === 'video' || tag === 'audio'),
    querySelector: (sel) => {
      for (const c of node.children) {
        if (c.matches(sel)) return c;
        const deep = c.querySelector(sel);
        if (deep) return deep;
      }
      return null;
    },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  };
  return node;
}

const rule: Rule = { id: 'hide-sponsored', anchor: { primary: { kind: 'css', value: '.s' } }, mutations: [{ kind: 'hide' }] };
const spec = { id: 'shim-x', version: 1, match: { hosts: ['example.com'] }, rules: [rule] } as Spec;

function verdict(matched: Stub[], r: Rule = rule, mounted: Stub[] = []): { mediaHide?: unknown; note?: unknown; box?: { x: number; y: number; w: number; h: number }; boxBeforeApply?: unknown } {
  const events: Record<string, unknown>[] = [];
  const api = { reportEvent: (_k: string, d: Record<string, unknown>) => { events.push(d); } } as unknown as CoreApi;
  const rs = makeRuleState();
  for (const m of matched) rs.state.set(m as unknown as Element, {} as RuleMountEntry);
  rs.matchedSource = 'primary';
  const reporter = makeStatusReporter(r, spec, api, rs);
  for (const m of mounted) reporter.noteLargeCoverAtMount(m as unknown as Element);
  reporter.reportStatusIfChanged();
  return events[events.length - 1] || {};
}

console.log('media verdict');
const tiles = Array.from({ length: 18 }, (_, i) => (i === 7 ? el('div', [el('div', [el('video')])]) : el('div')));
let v = verdict(tiles);
check('18-match hide where one tile contains a <video> does not warn', v.mediaHide === undefined, JSON.stringify(v));
check('…and its note does not claim the main media element', !/main media element/.test(String(v.note ?? '')), String(v.note));

v = verdict([el('div', [el('div', [el('video')])])]);
check('a single matched wrapper of a <video> warns (the player container)', v.mediaHide === 'media', JSON.stringify(v));
check('…with the note', /main media element/.test(String(v.note ?? '')), String(v.note));

v = verdict([el('div'), el('video'), el('div')]);
check('a matched element that IS a <video> warns even among many', v.mediaHide === 'media', JSON.stringify(v));

v = verdict([el('audio')]);
check('a single matched <audio> warns', v.mediaHide === 'media', JSON.stringify(v));

v = verdict([el('div', [el('span')])]);
check('a single match with no media does not warn', v.mediaHide === undefined, JSON.stringify(v));

v = verdict([el('div', [el('video')])], { ...rule, mutations: [{ kind: 'restyle', properties: { color: 'red' } }] });
check('a non-hide/remove rule never warns', v.mediaHide === undefined, JSON.stringify(v));

const bigTile = el('div', [el('video')]);
bigTile.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1000, height: 900 });
v = verdict([bigTile, el('div'), el('div')], rule, [bigTile]);
check('a multi-match whose media-holding tile blankets the viewport reads as cover, not media', v.mediaHide === 'cover', JSON.stringify(v));

// Cover means a page-level container, not merely a tall block.
type Rect = { x: number; y: number; width: number; height: number };
// Measured at mount (pre-hide), then display:none → 0x0 by report time.
function hidden(pre: Rect): Stub {
  const node = el('div');
  let calls = 0;
  node.getBoundingClientRect = () => (calls++ === 0 ? pre : { x: 0, y: 0, width: 0, height: 0 });
  return node;
}
function withDoc<T>(w: number, h: number, vw: number, vh: number, fn: () => T): T {
  const saved = { iw: win.innerWidth, ih: win.innerHeight, de: doc.documentElement };
  win.innerWidth = vw; win.innerHeight = vh; doc.documentElement = { scrollWidth: w, scrollHeight: h };
  try { return fn(); } finally { win.innerWidth = saved.iw; win.innerHeight = saved.ih; doc.documentElement = saved.de; }
}

console.log('cover verdict');
// google.com: AI Overview, one tall card in the results column of a 791px-wide viewport.
const aio = hidden({ x: 20, y: 140, width: 652, height: 1378 });
v = withDoc(791, 6200, 791, 860, () => verdict([aio], rule, [aio]));
check('a tall block in the results column is not a cover', v.mediaHide === undefined, JSON.stringify(v));
check('…and its note does not call it a full-page container', !/covers most of the viewport/.test(String(v.note ?? '')), String(v.note));
check('…its box is the pre-hide box, flagged', v.box?.w === 652 && v.box?.h === 1378 && v.boxBeforeApply === true, JSON.stringify(v));
const line = describeRuleStatus(rule, { matched: 1, matchedVia: 'primary', box: v.box, boxBeforeApply: true });
check('…and the status line labels it as measured before the rule applied',
  /anchor box 652×1378px at \(20, 140\) before the rule applied/.test(line), line);

const app = hidden({ x: 0, y: 0, width: 1280, height: 5000 });
v = withDoc(1280, 5000, 1280, 800, () => verdict([app], rule, [app]));
check('hiding the page\'s app root (body > div#app) is a cover', v.mediaHide === 'cover', JSON.stringify(v));
check('…with the note', /covers most of the viewport/.test(String(v.note ?? '')), String(v.note));

const main = hidden({ x: 360, y: 80, width: 1200, height: 4800 });
v = withDoc(1920, 5000, 1920, 1000, () => verdict([main], rule, [main]));
check('hiding a centered <main> spanning the page is a cover', v.mediaHide === 'cover', JSON.stringify(v));

const below = hidden({ x: 0, y: 900, width: 1280, height: 4000 });
v = withDoc(1280, 6000, 1280, 800, () => verdict([below], rule, [below]));
check('a big block entirely below the fold is not a cover', v.mediaHide === undefined, JSON.stringify(v));

const visibleBox = el('div');
visibleBox.getBoundingClientRect = () => ({ x: 1, y: 2, width: 30, height: 40 });
v = verdict([visibleBox], { ...rule, mutations: [{ kind: 'restyle', properties: { color: 'red' } }] }, [visibleBox]);
check('a match that still measures a box reports it unflagged', v.box?.w === 30 && v.boxBeforeApply === undefined, JSON.stringify(v));

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall green');
