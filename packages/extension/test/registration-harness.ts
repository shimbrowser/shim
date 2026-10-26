// Pins which scripts the worker registers (src/registration.ts): one per
// enabled shim for exactly its hosts, the engine before the runtime, as a
// content script (declarative mode) or a user script (full mode), and which
// host access a removal releases (none that a remaining shim needs).

import {
  registrationsFor, userScriptRegistrationsFor, originsToRelease, scriptIdFor, shimIdFor, patternsFor, RUNTIME_FILES, SCRIPT_ID_PREFIX,
  USER_SCRIPT_WORLD_CSP,
} from '../src/registration';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passes++; return; }
  failures++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

console.log('\n=== registration harness ===\n');

const shim = (id: string, hosts: string[] | undefined, enabled = true) => ({ id, enabled, spec: hosts ? { match: { hosts } } : {} });

console.log('ids:');
check('script id carries the prefix', scriptIdFor('shim-abc') === `${SCRIPT_ID_PREFIX}shim-abc`);
check('round-trips', shimIdFor(scriptIdFor('shim-abc')) === 'shim-abc');
check('a foreign id is not ours', shimIdFor('other:thing') === null);

console.log('registrations:');
{
  const regs = registrationsFor([
    shim('a', ['example.com', '*.example.com']),
    shim('b', ['other.test'], false),
    shim('c', []),
    shim('d', undefined),
    shim('e', ['localhost:5173']),
  ]);
  check('one per enabled shim with a host', regs.length === 2, JSON.stringify(regs.map((r) => r.id)));
  const [a, e] = regs;
  check('in list order', a?.id === 'shim:a' && e?.id === 'shim:e');
  check('matches are the shim\'s patterns', JSON.stringify(a?.matches) === JSON.stringify(['*://example.com/*', '*://*.example.com/*']));
  check('engine before runtime', JSON.stringify(a?.js) === JSON.stringify([...RUNTIME_FILES]) && RUNTIME_FILES[0] === 'shim-core.page.js' && RUNTIME_FILES[1] === 'content.js');
  check('document_start, isolated world, top frame, persisted',
    a?.runAt === 'document_start' && a.world === 'ISOLATED' && a.allFrames === false && a.persistAcrossSessions === true);
  check('a disabled shim registers nothing', !regs.some((r) => r.id === 'shim:b'));
  check('a shim with no registrable host registers nothing', !regs.some((r) => r.id === 'shim:c' || r.id === 'shim:d'));
}
check('a shim whose hosts all fail maps to no patterns', patternsFor(shim('x', ['https://nope', ''])).length === 0);

console.log('user-script registrations (full mode):');
{
  const shims = [shim('a', ['example.com', '*.example.com']), shim('b', ['other.test'], false), shim('c', []), shim('e', ['localhost:5173'])];
  const regs = userScriptRegistrationsFor(shims);
  const content = registrationsFor(shims);
  check('the same selection as the content scripts, in the same order', JSON.stringify(regs.map((r) => r.id)) === JSON.stringify(content.map((r) => r.id)));
  const [a] = regs;
  check('the same matches', JSON.stringify(a?.matches) === JSON.stringify(content[0]?.matches));
  check('the same files, as script sources, engine before runtime', JSON.stringify(a?.js) === JSON.stringify(RUNTIME_FILES.map((file) => ({ file }))));
  check('document_start, the user-script world, top frame', a?.runAt === 'document_start' && a.world === 'USER_SCRIPT' && a.allFrames === false);
  check('no persistAcrossSessions field (user scripts persist on their own)', a !== undefined && !('persistAcrossSessions' in a));
  check('the world\'s CSP permits the extension\'s files and eval, nothing else', USER_SCRIPT_WORLD_CSP === "script-src 'self' 'unsafe-eval'");
}

console.log('releasing host access:');
{
  const removed = patternsFor(shim('a', ['example.com', 'shared.test', 'only-a.test']));
  const remaining = [shim('b', ['shared.test']), shim('c', ['example.com'], false)];
  const release = originsToRelease(removed, remaining);
  check('a host no remaining shim uses is released', release.includes('*://only-a.test/*'));
  check('a host another shim uses is kept', !release.includes('*://shared.test/*'));
  check('a disabled shim still keeps its hosts', !release.includes('*://example.com/*'));
  check('nothing else', release.length === 1, JSON.stringify(release));
  check('no remaining shim releases everything', originsToRelease(removed, []).length === 3);
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log(`all registration checks passed (${passes})`);
