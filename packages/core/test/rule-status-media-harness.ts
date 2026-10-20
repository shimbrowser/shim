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

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const win = { innerWidth: 1000, innerHeight: 1000, getComputedStyle: () => ({ display: 'block' }) };
const doc = { defaultView: win };

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

function verdict(matched: Stub[], r: Rule = rule, mounted: Stub[] = []): { mediaHide?: unknown; note?: unknown } {
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

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall green');
