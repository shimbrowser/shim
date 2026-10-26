// Pins the pure part of rebase persistence (src/rebase.ts): a rebase rewrites
// the rule's anchor and bumps the version (and not for the same primary at
// the same bundle hash); a baseline refresh advances the bundle hash only
// when it moved; a captured witness lands only on a rule without one; page
// memory and the escalation gate; the quarantine reason in main's words.

import { rebasedSpec, refreshedSpec, capturedSpec, reportedAnchor, rememberPath, escalationAllowed, quarantineFrom, PAGE_MEMORY_CAP } from '../src/rebase';
import { anchorDigest } from '@shimbrowser/core/managed-anchor';
import type { Spec } from '@shimbrowser/core/types';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

console.log('\n=== rebase harness ===\n');

const spec: Spec = {
  id: 'shim-1', version: 3, bundleHash: 'b1', match: { hosts: ['example.com'] },
  rules: [
    { id: 'buy', anchor: { primary: { kind: 'css', value: 'button.buy-v1' }, fallbacks: [{ kind: 'css', value: 'button[data-sku="42"]' }] }, mutations: [{ kind: 'hide' }] },
    { id: 'ad', anchor: { primary: { kind: 'css', value: '#ad' } }, mutations: [{ kind: 'hide' }] },
  ],
};
const promoted = { primary: { kind: 'css', value: 'button[data-sku="42"]' }, fallbacks: [{ kind: 'css', value: 'button.buy-v1' }] };

console.log('a rebase:');
{
  const out = rebasedSpec(spec, 'buy', promoted, 'b2');
  check('rewrites the rule\'s anchor', out !== null && out.spec.rules?.[0]?.anchor?.primary.value === 'button[data-sku="42"]');
  check('bumps the version', out?.version === 4 && out.spec.version === 4);
  check('advances the bundle hash', out?.spec.bundleHash === 'b2');
  check('leaves the other rule alone', out?.spec.rules?.[1] === spec.rules?.[1]);
  check('answers the anchors before and after', out?.before?.primary.value === 'button.buy-v1' && out.after.primary.value === 'button[data-sku="42"]');
  check('does not touch the input', spec.version === 3 && spec.rules?.[0]?.anchor?.primary.value === 'button.buy-v1');
  check('an unknown rule: nothing', rebasedSpec(spec, 'nope', promoted, 'b2') === null);
  check('no anchor: nothing', rebasedSpec(spec, 'buy', { fallbacks: [] }, 'b2') === null);
  const same = { primary: { kind: 'css', value: 'button.buy-v1' } };
  check('the same primary at the same bundle hash: nothing (two documents reported one recovery)', rebasedSpec(spec, 'buy', same, 'b1') === null);
  const sameNewBuild = rebasedSpec(spec, 'buy', same, 'b2');
  check('the same primary at a new bundle hash still proceeds, so the gate stays honest', sameNewBuild !== null && sameNewBuild.spec.bundleHash === 'b2' && sameNewBuild.version === 4);
  const unversioned = rebasedSpec({ ...spec, version: undefined }, 'buy', promoted, 'b2');
  check('a spec without a version counts as version 1', unversioned?.version === 2);
}

console.log('a reported anchor is kept to the core\'s shape:');
{
  const ok = reportedAnchor({ primary: { kind: 'aria', role: 'button', label: 'Buy', match: 'contains' }, fallbacks: [{ kind: 'text', value: 'Buy the record' }], witness: { v: 1, tag: 'button' }, extra: 1 });
  check('a known kind with its fields, fallbacks and fingerprint', ok !== null && ok.primary.kind === 'aria' && ok.primary.label === 'Buy' && ok.fallbacks?.[0]?.kind === 'text' && ok.witness?.tag === 'button');
  check('and nothing else', ok !== null && !('extra' in ok) && Object.keys(ok).sort().join() === 'fallbacks,primary,witness');
  check('an unknown kind is no anchor', reportedAnchor({ primary: { kind: 'xpath', value: '//a' } }) === null);
  check('a non-string field is no anchor', reportedAnchor({ primary: { kind: 'css', value: 42 } }) === null);
  check('an unknown match is no anchor', reportedAnchor({ primary: { kind: 'text', value: 'x', match: 'regex' } }) === null);
  check('a fallback of an unknown kind is no anchor', reportedAnchor({ primary: { kind: 'css', value: 'a' }, fallbacks: [{ kind: 'js', value: '1' }] }) === null);
  check('a fingerprint without a tag is no anchor', reportedAnchor({ primary: { kind: 'css', value: 'a' }, witness: { v: 1 } }) === null);
  check('an oversized value is no anchor', reportedAnchor({ primary: { kind: 'css', value: 'x'.repeat(5000) } }) === null);
  check('so a rebase to such an anchor is nothing', rebasedSpec(spec, 'buy', { primary: { kind: 'xpath', value: '//a' } }, 'b2') === null);
  check('a primary field of a prototype\'s name is a field', reportedAnchor({ primary: { kind: 'css', value: 'a', __proto__: { polluted: true } } })?.primary.value === 'a');
}

console.log('a baseline refresh:');
{
  check('advances the bundle hash', refreshedSpec(spec, 'b2')?.bundleHash === 'b2');
  check('nothing when it already is', refreshedSpec(spec, 'b1') === null);
  check('nothing for no hash', refreshedSpec(spec, undefined) === null && refreshedSpec(spec, '') === null);
}

console.log('a rebase keeps the authored anchor fields:');
{
  const many: Spec = { ...spec, rules: [{ id: 'rows', anchor: { primary: { kind: 'css', value: 'li.row-v1' }, fallbacks: [{ kind: 'css', value: 'li[data-row]' }], cardinality: 'many', iframe: { kind: 'css', value: 'iframe#list' } }, mutations: [{ kind: 'hide' }] }] };
  // The engine's promotion of a `many` rule: the ladder rotated, no element witness, cardinality retained.
  const out = rebasedSpec(many, 'rows', { primary: { kind: 'css', value: 'li[data-row]' }, fallbacks: [{ kind: 'css', value: 'li.row-v1' }], cardinality: 'many' }, 'b2');
  const a = out?.spec.rules?.[0]?.anchor;
  check('the promoted ladder', a?.primary.value === 'li[data-row]' && a.fallbacks?.[0]?.value === 'li.row-v1');
  check('cardinality stays many, with no element witness', a?.cardinality === 'many' && a.witness === undefined);
  check('the iframe target stays the rule\'s own', a?.iframe?.value === 'iframe#list');
  check('a reported anchor validates cardinality', reportedAnchor({ primary: { kind: 'css', value: 'a' }, cardinality: 'many' })?.cardinality === 'many' && reportedAnchor({ primary: { kind: 'css', value: 'a' }, cardinality: 'few' }) === null);
  const withOld = rebasedSpec({ ...spec, rules: [{ id: 'buy', anchor: { primary: { kind: 'css', value: 'a' }, witness: { v: 1, tag: 'a' } }, mutations: [{ kind: 'hide' }] }] }, 'buy', { primary: { kind: 'css', value: 'b' } }, 'b2');
  check('a report without a fingerprint replaces the old one with none (the managed state is replaced as a whole)', withOld !== null && withOld.spec.rules?.[0]?.anchor?.witness === undefined);
}

console.log('a captured fingerprint follows the engine\'s contract:');
{
  const bare: Spec = { ...spec, rules: [{ id: 'buy', anchor: { primary: { kind: 'css', value: 'button' } }, mutations: [{ kind: 'hide' }] }] };
  const digest = anchorDigest({ primary: { kind: 'css', value: 'button' } });
  const w = { v: 1, tag: 'button' };
  const sw = { v: 1, members: 3, tag: 'li' };
  const first = capturedSpec(bare, 'buy', undefined, { witness: w, setWitness: null, documentId: 'doc-a', anchorDigest: digest, rev: 1 });
  check('a rule without a fingerprint takes a capture', first?.spec.rules?.[0]?.anchor?.witness?.tag === 'button' && first.capture.rev === 1 && first.capture.documentId === 'doc-a');
  const grown = first && capturedSpec(first.spec, 'buy', first.capture, { witness: null, setWitness: sw, documentId: 'doc-a', anchorDigest: digest, rev: 2 });
  check('a later rev in the same document replaces it: element to set', grown?.spec.rules?.[0]?.anchor?.setWitness !== undefined && grown.spec.rules?.[0]?.anchor?.witness === undefined && grown.capture.rev === 2);
  check('a lower rev in the same document is ignored', grown !== null && grown !== undefined && capturedSpec(grown.spec, 'buy', grown.capture, { witness: w, setWitness: null, documentId: 'doc-a', anchorDigest: digest, rev: 1 }) === null);
  const withdrawn = grown && capturedSpec(grown.spec, 'buy', grown.capture, { witness: null, setWitness: null, documentId: 'doc-a', anchorDigest: digest, rev: 3, captureNote: 'mixed-tags' });
  check('an explicit none withdraws the fingerprint', withdrawn?.spec.rules?.[0]?.anchor?.witness === undefined && withdrawn?.spec.rules?.[0]?.anchor?.setWitness === undefined && withdrawn?.capture.rev === 3);
  const later = withdrawn && capturedSpec(withdrawn.spec, 'buy', withdrawn.capture, { witness: w, setWitness: null, documentId: 'doc-b', anchorDigest: digest, rev: 1 });
  check('a later document replaces, whatever its rev', later?.spec.rules?.[0]?.anchor?.witness?.tag === 'button' && later.capture.documentId === 'doc-b');
  check('a capture for another anchor (digest) is ignored', first !== null && capturedSpec(first.spec, 'buy', first.capture, { witness: w, setWitness: null, documentId: 'doc-c', anchorDigest: 'other', rev: 1 }) === null);
  check('a committed fingerprint (no capture record) is never captured over', capturedSpec(spec, 'buy', undefined, { witness: w, setWitness: null, documentId: 'doc-a', anchorDigest: anchorDigest(spec.rules?.[0]?.anchor), rev: 1 }) === null || !spec.rules?.[0]?.anchor?.witness);
  const committed: Spec = { ...spec, rules: [{ id: 'buy', anchor: { primary: { kind: 'css', value: 'button' }, witness: { v: 1, tag: 'em' } }, mutations: [{ kind: 'hide' }] }] };
  check('…truly: a rule with a fingerprint and no capture record keeps it', capturedSpec(committed, 'buy', undefined, { witness: w, setWitness: null, documentId: 'doc-a', anchorDigest: digest, rev: 9 }) === null);
  check('an event from an engine without a rev reads as rev -1, and is taken when nothing is held', capturedSpec(bare, 'buy', undefined, { witness: w })?.capture.rev === -1);
  check('an unknown rule is nothing', capturedSpec(bare, 'nope', undefined, { witness: w, documentId: 'doc-a', anchorDigest: digest, rev: 1 }) === null);
}

console.log('page memory and the gate:');
{
  const m1 = rememberPath({}, '/projects/123/estimates?x=1', 1000);
  check('remembers the page kind, coarse', JSON.stringify(m1) === JSON.stringify({ '/projects/*': 1000 }));
  const m2 = rememberPath(m1, '/projects/456', 2000);
  check('the same kind again updates its time', JSON.stringify(m2) === JSON.stringify({ '/projects/*': 2000 }));
  check('no memory at all: escalate', escalationAllowed(undefined, '/anything') && escalationAllowed({}, '/anything'));
  check('a known kind: escalate', escalationAllowed(m2, '/projects/789'));
  check('an unknown kind with memory: a wrong-page miss, do not escalate', !escalationAllowed(m2, '/login'));
  check('no path: escalate', escalationAllowed(m2, undefined));
  const global: Record<string, number> = {};
  for (let i = 0; i < PAGE_MEMORY_CAP; i++) Object.defineProperty(global, `/k${i}`, { value: i, enumerable: true });
  check('a rule known on many kinds is global: escalate anywhere', escalationAllowed(global, '/somewhere/else'));
  check('a prototype-shaped key is data', escalationAllowed(rememberPath({}, '/__proto__', 1), '/__proto__'));
}

console.log('the quarantine reason:');
{
  check('nothing found after a deploy', quarantineFrom({ seen: [] }, 5).reason === 'the target could not be found after a site update');
  const q = quarantineFrom({ seen: ['tag: expected button, saw em'], expected: { tag: 'button' } }, 5);
  check('a wrong element names what was seen', q.reason.startsWith('anchor resolves, but the match no longer looks like the original target') && q.seen.length === 1 && q.occurredAt === 5);
  check('and keeps what was expected', JSON.stringify(q.expected) === '{"tag":"button"}');
  check('a set', quarantineFrom({ fingerprint: 'set', seen: [] }, 5).reason === 'the set of elements could not be found after a site update');
  check('a conflicted fingerprint', quarantineFrom({ fingerprint: 'conflicted' }, 5).reason.includes('conflicting fingerprints'));
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log(`all rebase checks passed (${passes})`);
