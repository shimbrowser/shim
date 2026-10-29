// Vault shims' worlds and tokens (vault.ts, vault-sync.ts), without a browser:
// classification, Chrome-pattern overlap, admission under the per-page world
// cap, the boot code's lexical token, and the reconcile state machine over
// fake Chrome and storage: tokens saved before scripts exist, revoked before
// registrations change, rotation only when asked or needed, and an
// interrupted reconcile recovered fail closed.
//
//   node out/packages/extension/test/vault-harness.js

import vm from 'vm';
import {
  declaresSecret, patternsCouldOverlap, admitVaultShims, vaultBootCode, vaultRegistrationFor, worldIdFor, mintToken,
  MAX_VAULT_WORLDS_PER_PAGE, VAULT_SCRIPT_PREFIX, type VaultCandidate, type VaultUserScriptRegistration,
} from '../src/vault';
import { reconcileVault, principalForToken, emptyVaultState, type VaultState, type VaultSyncDeps } from '../src/vault-sync';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { passes++; console.log(`  ✓ ${label}`); return; }
  failures++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
}

console.log('classification');
check('a spec with a secret field is a vault shim', declaresSecret({ settings: [{ key: 'k', type: 'secret', label: 'Key' }] }));
check('one with only plain fields is not', !declaresSecret({ settings: [{ key: 'k', type: 'string', label: 'K' }] }));
check('nor one with no settings', !declaresSecret({}) && !declaresSecret(null));
check('a declaration that does not validate is still classified by its secret', declaresSecret({ settings: [{ key: 'k', type: 'secret' }, { nonsense: true }] }));

console.log('overlap, by Chrome\'s matching');
const P = (h: string): string => `*://${h}/*`;
check('the same host overlaps', patternsCouldOverlap(P('a.com'), P('a.com')));
check('different hosts do not', !patternsCouldOverlap(P('a.com'), P('b.com')));
check('a wildcard covers its apex', patternsCouldOverlap(P('*.a.com'), P('a.com')));
check('and its subdomains', patternsCouldOverlap(P('x.a.com'), P('*.a.com')));
check('but not a look-alike', !patternsCouldOverlap(P('*.a.com'), P('xa.com')));
check('nested wildcards overlap', patternsCouldOverlap(P('*.a.com'), P('*.x.a.com')));
check('a port-less pattern overlaps every port', patternsCouldOverlap(P('localhost'), P('localhost:5173')));
check('two different ports do not', !patternsCouldOverlap(P('localhost:5173'), P('localhost:8080')));
check('host case does not matter', patternsCouldOverlap(P('A.com'), P('a.com')));
check('an unreadable pattern overlaps everything', patternsCouldOverlap('<all_urls>', P('a.com')) && patternsCouldOverlap('https://a.com/x', P('b.com')));

console.log('admission');
const cand = (id: string, hosts: string[]): VaultCandidate => ({ id, name: `name-${id}`, matches: hosts.map(P) });
{
  const nine = Array.from({ length: 9 }, (_, i) => cand(`s${i + 1}`, ['shop.example']));
  const a = admitVaultShims(nine);
  check(`${MAX_VAULT_WORLDS_PER_PAGE} vault shims on one host are admitted`, a.admitted.length === MAX_VAULT_WORLDS_PER_PAGE && a.admitted.join() === nine.slice(0, 8).map((c) => c.id).join(), a);
  check('the 9th is refused, naming the 8 it overlaps', a.refused.length === 1 && a.refused[0]?.id === 's9' && a.refused[0].overlapping.length === 8 && a.refused[0].overlapping[0] === 'name-s1', a.refused);
  const spread = Array.from({ length: 12 }, (_, i) => cand(`d${i}`, [`site${i}.example`]));
  check('vault shims on different sites are all admitted', admitVaultShims(spread).admitted.length === 12);
  const viaWildcard = [cand('w', ['*.example.com']), ...Array.from({ length: 8 }, (_, i) => cand(`l${i}`, [`a${i}.example.com`]))];
  const w = admitVaultShims(viaWildcard);
  check('a wildcard shim counts against every subdomain shim: hub + 7 admitted, the 8th refused (conservative)', w.admitted.length === 8 && w.refused.length === 1 && w.refused[0]?.id === 'l7', w);
  const order = admitVaultShims([cand('old', ['x.example']), ...Array.from({ length: 8 }, (_, i) => cand(`new${i}`, ['x.example']))]);
  check('the earlier shim keeps its world; the newcomer is refused', order.admitted[0] === 'old' && order.refused[0]?.id === 'new7');
  // No URL is ever matched by more than the cap among the admitted.
  const mixed = [
    ...Array.from({ length: 6 }, (_, i) => cand(`m${i}`, ['x.example', `own${i}.example`])),
    ...Array.from({ length: 6 }, (_, i) => cand(`n${i}`, ['*.x.example'])),
    cand('o', ['y.x.example']),
  ];
  const m = admitVaultShims(mixed);
  const urls = ['x.example', 'y.x.example', 'z.x.example'];
  const worst = Math.max(...urls.map((u) => m.admitted.filter((id) => mixed.find((c) => c.id === id)?.matches.some((p) => patternsCouldOverlap(p, P(u)))).length));
  check('in a mixed set no URL matches more admitted shims than the cap', worst <= MAX_VAULT_WORLDS_PER_PAGE, { worst, admitted: m.admitted });
}

console.log('the boot code');
{
  const boot = { shimId: 'shim-a', generation: 3, token: mintToken() };
  const code = vaultBootCode('globalThis.seen = __SHIM_VAULT__.shimId + ":" + __SHIM_VAULT__.generation + ":" + __SHIM_VAULT__.token.length;', boot);
  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(code, sandbox);
  check('the runtime reads its boot from the closure', sandbox.seen === `shim-a:3:${boot.token.length}`, sandbox.seen);
  check('and no global names the boot or the token', !('__SHIM_VAULT__' in sandbox) && !Object.values(sandbox).some((v) => typeof v === 'string' && v.includes(boot.token)));
  const reg = vaultRegistrationFor({ id: 'shim-a', matches: [P('a.com')] }, 'var ShimCore = {};', code);
  check('the registration is one code entry, the engine then the closure, in the shim\'s own world at document_start',
    reg.id === `${VAULT_SCRIPT_PREFIX}shim-a` && reg.worldId === worldIdFor('shim-a') && reg.worldId === 'v-shim-a' && reg.js.length === 1
    && reg.js[0].code.startsWith('var ShimCore = {};') && reg.js[0].code.endsWith(code) && reg.runAt === 'document_start' && reg.world === 'USER_SCRIPT' && reg.allFrames === false, reg);
  const world: Record<string, unknown> = {};
  vm.runInNewContext(reg.js[0].code.replace('globalThis.seen = ', 'globalThis.seen = typeof ShimCore + ":" + '), world);
  check('the engine\'s global is the world\'s, visible to the runtime in the closure', String(world.seen).startsWith('object:shim-a'), world.seen);
  const t1 = mintToken();
  const t2 = mintToken();
  check('tokens are 256 bits, base64url, and fresh', t1.length === 43 && /^[A-Za-z0-9_-]+$/.test(t1) && t1 !== t2, t1);
}

console.log('reconcile');
interface Fake {
  deps: VaultSyncDeps;
  log: string[];
  saved: () => VaultState | undefined;
  chrome: Map<string, VaultUserScriptRegistration>;
  failNext: { register?: boolean };
}
function fake(initial?: VaultState): Fake {
  let stored = initial;
  const chrome = new Map<string, VaultUserScriptRegistration>();
  const log: string[] = [];
  const failNext: Fake['failNext'] = {};
  let n = 0;
  const deps: VaultSyncDeps = {
    load: () => Promise.resolve(stored === undefined ? undefined : (JSON.parse(JSON.stringify(stored)) as VaultState)),
    save: (s) => {
      stored = JSON.parse(JSON.stringify(s)) as VaultState;
      log.push(`save:${s.phase}:${Object.keys(s.records).sort().join(',')}`);
      return Promise.resolve();
    },
    registeredIds: () => Promise.resolve([...chrome.keys()]),
    unregister: (ids) => { for (const id of ids) chrome.delete(id); log.push(`unregister:${ids.join(',')}`); return Promise.resolve(); },
    register: (regs) => {
      if (failNext.register) { failNext.register = false; log.push('register:fail'); return Promise.reject(new Error('register refused')); }
      for (const r of regs) chrome.set(r.id, r);
      log.push(`register:${regs.map((r) => r.id).join(',')}`);
      return Promise.resolve();
    },
    configureWorld: (worldId) => { log.push(`configure:${worldId}`); return Promise.resolve(); },
    runtimeSource: () => Promise.resolve('/* runtime */'),
    engineSource: () => Promise.resolve('/* engine */'),
    token: () => `token-${String(++n).padStart(40, '0')}`,
  };
  return { deps, log, saved: () => stored, chrome, failNext };
}
const tokenOf = (s: VaultState | undefined, id: string): string => s?.records[id]?.token ?? '';

void (async () => {
  const a = cand('a', ['a.example']);
  const b = cand('b', ['b.example']);
  {
    const f = fake();
    const s1 = await reconcileVault(f.deps, { candidates: [a, b] });
    check('first reconcile: both registered at generation 1, idle', s1.phase === 'idle' && s1.records.a?.generation === 1 && s1.records.b?.generation === 1 && f.chrome.size === 2, s1);
    const saveIdx = f.log.findIndex((l) => l === 'save:running:a,b');
    const regIdx = f.log.findIndex((l) => l.startsWith('register:'));
    check('the tokens are saved before the scripts exist', saveIdx >= 0 && regIdx > saveIdx, f.log);
    check('each world is configured before its script is registered', f.log.indexOf('configure:v-a') < regIdx && f.log.indexOf('configure:v-b') < regIdx, f.log);
    check('each script carries its own token in its code', f.chrome.get('shimv:a')?.js[0].code.includes(tokenOf(s1, 'a')) === true && !f.chrome.get('shimv:a')?.js[0].code.includes(tokenOf(s1, 'b')));
    check('a current token proves its shim and generation', JSON.stringify(principalForToken(s1, tokenOf(s1, 'a'))) === JSON.stringify({ shimId: 'a', generation: 1 }));
    check('an unknown, short or non-string token proves nothing', principalForToken(s1, 'x'.repeat(43)) === null && principalForToken(s1, 'short') === null && principalForToken(s1, 42) === null);

    f.log.length = 0;
    const s2 = await reconcileVault(f.deps, { candidates: [a, b] });
    check('a reconcile with nothing to change touches nothing (no rotation on an ordinary wake)', f.log.length === 0 && tokenOf(s2, 'a') === tokenOf(s1, 'a'), f.log);

    f.log.length = 0;
    const s3 = await reconcileVault(f.deps, { candidates: [a, b], rotate: ['a'] });
    check('rotating one shim gives it generation 2 and a new token', s3.records.a?.generation === 2 && tokenOf(s3, 'a') !== tokenOf(s1, 'a'), s3.records.a);
    check('and leaves the other alone', tokenOf(s3, 'b') === tokenOf(s1, 'b') && s3.records.b?.generation === 1);
    check('the old token is revoked before its registration changes', f.log[0] === 'save:running:b' && f.log[1] === 'unregister:shimv:a', f.log);
    check('the old generation\'s token is refused', principalForToken(s3, tokenOf(s1, 'a')) === null);

    f.log.length = 0;
    await reconcileVault(f.deps, { candidates: [a, b], configure: true });
    check('a configure-only pass re-sends every admitted world\'s configuration and registers nothing', f.log.join() === 'configure:v-a,configure:v-b', f.log);

    const a2 = cand('a', ['a.example', 'a2.example']);
    const s4 = await reconcileVault(f.deps, { candidates: [a2, b] });
    check('new patterns rotate the shim', s4.records.a?.generation === 3 && JSON.stringify(f.chrome.get('shimv:a')?.matches) === JSON.stringify(a2.matches));

    f.chrome.delete('shimv:b');
    const s5 = await reconcileVault(f.deps, { candidates: [a2, b] });
    check('a registration missing from Chrome is registered again under a new token', s5.records.b?.generation === 2 && f.chrome.has('shimv:b'));

    f.log.length = 0;
    const s6 = await reconcileVault(f.deps, { candidates: [b] });
    check('a shim that leaves is unregistered and its token revoked', !s6.records.a && !f.chrome.has('shimv:a') && principalForToken(s6, tokenOf(s5, 'a')) === null, f.log);
    check('its generation is kept, so a later admission never reuses one', s6.generations.a === 3);
    const s7 = await reconcileVault(f.deps, { candidates: [a, b] });
    check('readmitted, it continues from the next generation', s7.records.a?.generation === 4);

    f.chrome.set('shimv:ghost', vaultRegistrationFor({ id: 'ghost', matches: [P('g.example')] }, '', ''));
    await reconcileVault(f.deps, { candidates: [a, b] });
    check('a stray vault registration no record names is unregistered', !f.chrome.has('shimv:ghost'));

    const nine = Array.from({ length: 9 }, (_, i) => cand(`s${i}`, ['crowd.example']));
    const s8 = await reconcileVault(f.deps, { candidates: nine });
    check('admission refuses the 9th, and the refusal is saved for the popup', !s8.records.s8 && (s8.refused.s8?.length ?? 0) === 8 && !f.chrome.has('shimv:s8'), s8.refused);
  }
  {
    const f = fake();
    const s1 = await reconcileVault(f.deps, { candidates: [a, b] });
    f.failNext.register = true;
    let threw = false;
    try { await reconcileVault(f.deps, { candidates: [a, b], rotate: 'all' }); } catch { threw = true; }
    const mid = f.saved();
    check('a reconcile that fails midway throws and leaves the state running', threw && mid?.phase === 'running', mid?.phase);
    check('with the changed shims\' old tokens already revoked', principalForToken(mid, tokenOf(s1, 'a'), true) === null && principalForToken(mid, tokenOf(s1, 'b'), true) === null);
    check('and, loaded by the next worker, a running state answers no token at all', principalForToken(mid, tokenOf(mid, 'a')) === null);
    check('the failed run unregistered before it failed: Chrome holds no vault script', f.chrome.size === 0, [...f.chrome.keys()]);
    f.log.length = 0;
    const s2 = await reconcileVault(f.deps, { candidates: [a, b] });
    check('the next reconcile recovers: every token revoked first', f.log[0] === 'save:running:', f.log);
    check('then every shim registered under a new generation, idle again', s2.phase === 'idle' && (s2.records.a?.generation ?? 0) > 1 && (s2.records.b?.generation ?? 0) > 1 && f.chrome.size === 2, s2);
    check('no token from before the interruption is honored', principalForToken(s2, tokenOf(s1, 'a')) === null && principalForToken(s2, tokenOf(mid, 'a')) === null);
  }
  {
    const prior: VaultState = { ...emptyVaultState(), phase: 'running', records: { a: { generation: 5, token: 'p'.repeat(43), matches: a.matches.slice() } }, generations: { a: 5 } };
    const f = fake(prior);
    f.chrome.set('shimv:a', vaultRegistrationFor(a, '', ''));
    f.chrome.set('shimv:zombie', vaultRegistrationFor({ id: 'zombie', matches: [] }, '', ''));
    check('a state found running answers no token, even a recorded one', principalForToken(prior, 'p'.repeat(43)) === null);
    const s = await reconcileVault(f.deps, { candidates: [a] });
    check('recovering from it unregisters everything Chrome holds, re-registers the admitted at a new generation', !f.chrome.has('shimv:zombie') && f.chrome.has('shimv:a') && s.records.a?.generation === 6 && tokenOf(s, 'a') !== 'p'.repeat(43), s);
  }
  {
    // A store that keeps what it is given by reference (as a worker's cache
    // would) and refuses the final save: the state it holds must stay running.
    let held: VaultState | undefined;
    let saves = 0;
    let failAt = 0;
    const chrome = new Set<string>();
    let n = 100;
    const deps: VaultSyncDeps = {
      load: () => Promise.resolve(held),
      save: (st) => {
        saves++;
        if (saves === failAt) return Promise.reject(new Error('store refused'));
        held = st;
        return Promise.resolve();
      },
      registeredIds: () => Promise.resolve([...chrome]),
      unregister: (ids) => { for (const id of ids) chrome.delete(id); return Promise.resolve(); },
      register: (regs) => { for (const r of regs) chrome.add(r.id); return Promise.resolve(); },
      configureWorld: () => Promise.resolve(),
      runtimeSource: () => Promise.resolve(''),
      engineSource: () => Promise.resolve(''),
      token: () => `token-${String(++n).padStart(40, '0')}`,
    };
    const s1 = await reconcileVault(deps, { candidates: [a] });
    saves = 0;
    failAt = 3; // revoke, tokens, then the idle transition
    let threw = false;
    try { await reconcileVault(deps, { candidates: [a], rotate: 'all' }); } catch { threw = true; }
    check('a refused final save throws', threw);
    check('and what the store kept by reference is still running, not idle', held?.phase === 'running', held?.phase);
    check('so no token is honored, the new generation\'s included', principalForToken(held, tokenOf(held, 'a')) === null && principalForToken(held, tokenOf(s1, 'a')) === null);
    failAt = 0;
    const s2 = await reconcileVault(deps, { candidates: [a] });
    check('the next reconcile recovers to idle under a newer generation', s2.phase === 'idle' && s2.records.a?.generation === 3 && principalForToken(s2, tokenOf(s2, 'a')) !== null, s2);
  }
  {
    const f = fake();
    await reconcileVault(f.deps, { candidates: [] });
    check('with no vault shim nothing is registered or saved', f.chrome.size === 0 && f.saved() === undefined, f.log);
  }

  if (failures) { console.error(`\n${failures} vault check(s) failed`); process.exit(1); }
  console.log(`\nall vault checks passed (${passes})`);
})();
