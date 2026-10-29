// Shim for Chrome's secret-bearing api.fetch (credential-fetch.ts) with its
// grants (credential-grants.ts), session lease (credential-lease.ts) and a
// real vault keeper over in-memory storage, without a browser: placement
// exactly as declared, grants bound to the placement and the code (and
// re-bound only by an anchor-only rebase), the lease refusing while a
// session holds a tab and for every document it could touch, the request
// policy, the public url, redaction and fixed errors, per-shim budgets, and
// the adversarial part: a lock, a revoke, a session taking the tab or a
// shim change at every await of the dispatch path, none of which may let
// the request go out.
//
//   node out/packages/extension/test/credential-fetch-harness.js

import type { Spec } from '@shimbrowser/core/types';
import { credentialUseBinding, CREDENTIAL_ERRORS, CREDENTIAL_REDACTED } from '@shimbrowser/core/credential-placement';
import { runCredentialFetch, CredentialBudget, SECRETS_NOT_AVAILABLE_IN_SESSION, CREDENTIAL_CONCURRENCY, type CredentialFetchDeps } from '../src/credential-fetch';
import { grantViews, checkApproval, rebindDigest, manifestDigest, placedFields, type GrantRow } from '../src/credential-grants';
import { CredentialLeases, TAINT_CAP } from '../src/credential-lease';
import { VaultKeeper, type SecretRow, type VaultKeeperDeps } from '../src/vault-keeper';
import type { HandlerFetchResult } from '@shimbrowser/core/fetch-policy';

let failures = 0;
let passes = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { passes++; console.log(`  ✓ ${label}`); return; }
  failures++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
}

const PASS = 'tavor-mikel-dusan-pobit-zelur';
const ORIGIN = 'https://api.example.com';
const HEADER_USE = { origin: ORIGIN, header: 'Authorization', format: 'Bearer {}' };
const QUERY_USE = { origin: 'https://maps.example.com', query: 'key', format: '{}' };

function spec(extraRule = ''): Spec {
  return {
    id: 's1', version: 1, match: { hosts: ['site.example'] },
    settings: [
      { key: 'apiKey', type: 'secret', label: 'API key', use: HEADER_USE },
      { key: 'mapsKey', type: 'secret', label: 'Maps key', use: QUERY_USE },
      { key: 'units', type: 'select', label: 'Units', options: ['a', 'b'] },
    ],
    rules: [{ id: 'r1', anchor: { primary: { kind: 'css', value: '#x' } }, mutations: [{ kind: 'script', handler: 'go' + extraRule }] }],
  } as unknown as Spec;
}
const HANDLERS = { go: 'module.exports = () => {}' };

interface Rig {
  deps: CredentialFetchDeps;
  vault: VaultKeeper;
  leases: CredentialLeases;
  grants: Map<string, GrantRow>;
  shim: { spec: Spec; handlers: Record<string, string>; enabled: boolean };
  epoch: { n: number };
  sent: Array<{ url: string; init: RequestInit }>;
  /** Run at named await points of the broker's deps. */
  hook: { at?: (name: string) => void | Promise<void> };
  respond: { fn: (url: string, init: RequestInit) => Promise<Response> };
  budget: CredentialBudget;
}

async function rig(): Promise<Rig> {
  const rows = new Map<string, SecretRow>();
  let record: unknown;
  let session: unknown;
  const hook: Rig['hook'] = {};
  const at = async (n: string): Promise<void> => { await hook.at?.(n); };
  const vdeps: VaultKeeperDeps = {
    loadRecord: async () => { await at('vault.record'); return record; },
    saveRecord: async (r) => { record = r; },
    resetAll: async (r) => { record = r; rows.clear(); },
    replaceAll: async (r, next) => { record = r; rows.clear(); for (const x of next) rows.set(`${x.shimId}/${x.key}`, x); },
    listRows: async () => [...rows.values()],
    getRow: async (s, k) => { await at('vault.getRow'); return rows.get(`${s}/${k}`); },
    putRow: async (r) => { rows.set(`${r.shimId}/${r.key}`, r); },
    deleteRow: async (s, k) => rows.delete(`${s}/${k}`),
    session: { get: async () => { await at('vault.session'); return session; }, set: async (v) => { session = v; }, remove: async () => { session = undefined; } },
    lockAfterMs: async () => undefined,
    setLockAfterMs: async () => undefined,
    now: () => Date.now(),
  };
  const setupVault = new VaultKeeper(vdeps);
  await setupVault.setup(PASS);
  await setupVault.setSecret('s1', 'apiKey', credentialUseBinding(HEADER_USE), 'sk-live-ABCDEF123456');
  await setupVault.setSecret('s1', 'mapsKey', credentialUseBinding(QUERY_USE), 'maps~key 12345678');
  // The broker runs in a worker that woke after the unlock: its keeper reads the session record on first use.
  const vault = new VaultKeeper(vdeps);
  let stored: unknown;
  const leases = new CredentialLeases({ load: async () => stored, save: async (s) => { stored = structuredClone(s); } });
  await leases.ready;
  const grants = new Map<string, GrantRow>();
  const shim = { spec: spec(), handlers: { ...HANDLERS }, enabled: true };
  const epoch = { n: 0 };
  const sent: Rig['sent'] = [];
  const respond: Rig['respond'] = {
    fn: async (url) => new Response(`echo ${url} sk-live-ABCDEF123456`, { status: 200, headers: { 'x-echo': 'Bearer sk-live-ABCDEF123456', 'content-type': 'text/plain' } }),
  };
  const deps: CredentialFetchDeps = {
    shim: async () => { await at('shim'); return shim.enabled ? { spec: shim.spec, handlers: shim.handlers } : null; },
    grant: async (_s, k) => { await at('grant'); return grants.get(k); },
    reveal: async (s, k, p) => { await at('reveal'); return vault.reveal(s, k, p); },
    vaultCurrent: (g) => vault.isCurrent(g),
    leaseReady: leases.ready,
    leaseAllows: (t, d) => leases.allows(t, d),
    epoch: () => epoch.n,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => { sent.push({ url: String(url), init: init ?? {} }); return respond.fn(String(url), init ?? {}); }) as typeof fetch,
  };
  return { deps, vault, leases, grants, shim, epoch, sent, hook, respond, budget: new CredentialBudget() };
}

function approve(r: Rig, key: string): void {
  const views = grantViews({ spec: r.shim.spec, handlers: r.shim.handlers }, r.grants, new Map());
  const view = views.find((v) => v.key === key);
  const c = checkApproval({ id: 's1', spec: r.shim.spec, handlers: r.shim.handlers }, key, view?.review);
  if (!c.ok) throw new Error(c.error);
  r.grants.set(key, { ...c.row, grantedAt: 1 });
}

const TAB = 7;
const DOC = 'DOC-A';
const call = (url: string, opts: Record<string, unknown>) => ({ shimId: 's1', tabId: TAB, documentId: DOC, url, opts });
const run = (r: Rig, url: string, opts: Record<string, unknown>): Promise<HandlerFetchResult> => runCredentialFetch(call(url, opts), r.deps, r.budget);
const err = (x: HandlerFetchResult): string => ('error' in x && typeof x.error === 'string' ? x.error : '');

async function main(): Promise<void> {
  console.log('\n=== credential fetch harness ===\n');

  console.log('grants');
  {
    const r = await rig();
    const v = grantViews({ spec: r.shim.spec, handlers: r.shim.handlers }, r.grants, new Map([['apiKey', credentialUseBinding(HEADER_USE)]]));
    check('placed fields only, in order', v.map((x) => x.key).join() === 'apiKey,mapsKey' && placedFields(r.shim.spec).length === 2);
    check('none granted at first; set state is per placement', v.every((x) => x.state === 'none') && v[0]?.isSet === true && v[1]?.isSet === false);
    check('the header grant names where it goes', v[0]?.description === 'to https://api.example.com in the Authorization header', v[0]?.description);
    check('the query grant names the logs and the report collector', (v[1]?.description ?? '').includes('logs') && (v[1]?.description ?? '').includes('error-report collector'));
    check('an approval with a stale review is refused', !checkApproval({ id: 's1', ...r.shim }, 'apiKey', 'nope').ok);
    check('an approval for a non-placed key is refused', !checkApproval({ id: 's1', ...r.shim }, 'units', 'x').ok);
    approve(r, 'apiKey');
    const after = grantViews({ spec: r.shim.spec, handlers: r.shim.handlers }, r.grants, new Map());
    check('approved', after[0]?.state === 'granted');
    r.shim.handlers = { go: 'module.exports = () => { /* changed */ }' };
    check('a handler change suspends it', grantViews(r.shim, r.grants, new Map())[0]?.state === 'suspended');
    r.shim.handlers = { ...HANDLERS };
    r.shim.spec = { ...spec(), settings: [{ key: 'apiKey', type: 'secret', label: 'API key', use: { ...HEADER_USE, format: 'Token {}' } }] } as unknown as Spec;
    check('a placement change suspends it', grantViews(r.shim, r.grants, new Map())[0]?.state === 'suspended');
    const base = spec();
    const moved = { ...base, version: 2, rules: [{ ...(base.rules ?? [])[0], anchor: { primary: { kind: 'css', value: '#y' } } }] } as unknown as Spec;
    const rb = rebindDigest(base, moved, HANDLERS);
    check('an anchor-only rebase re-binds', rb !== null && rb.from === manifestDigest(base, HANDLERS) && rb.to === manifestDigest(moved, HANDLERS));
    const changed = { ...moved, rules: [{ ...(moved.rules ?? [])[0], mutations: [{ kind: 'hide' }] }] } as unknown as Spec;
    check('a rebase that changed anything else does not', rebindDigest(base, changed, HANDLERS) === null);
  }

  console.log('placement and policy');
  {
    const r = await rig();
    approve(r, 'apiKey');
    approve(r, 'mapsKey');
    const res = await run(r, `${ORIGIN}/v1/me?x=1#frag`, { headers: { Accept: 'application/json' }, secrets: ['apiKey'] });
    const sent = r.sent[0];
    const h = (sent?.init.headers ?? {}) as Record<string, string>;
    check('it is sent', res.ok === true && r.sent.length === 1, res);
    check('the header is placed exactly as declared', h.Authorization === 'Bearer sk-live-ABCDEF123456' && h.Accept === 'application/json');
    check('the fragment is dropped', sent?.url === `${ORIGIN}/v1/me?x=1`);
    check('the request policy: no redirects, no cache, no cookies, no referrer',
      sent?.init.redirect === 'error' && sent.init.cache === 'no-store' && sent.init.credentials === 'omit' && sent.init.referrer === '' && sent.init.referrerPolicy === 'no-referrer');
    check('the answer carries the handler\'s url', 'url' in res && res.url === `${ORIGIN}/v1/me?x=1`);
    check('the body echo is redacted', 'text' in res && !res.text.includes('sk-live-ABCDEF123456') && res.text.includes(CREDENTIAL_REDACTED));
    check('a header echo is redacted', 'headers' in res && !String(res.headers['x-echo']).includes('sk-live'));
    check('statusText is fixed', 'statusText' in res && res.statusText === '');
    const q = await run(r, 'https://maps.example.com/geo?q=paris', { secrets: ['mapsKey'] });
    const qurl = r.sent[1]?.url ?? '';
    check('a query secret is appended, encoded', q.ok === true && qurl.startsWith('https://maps.example.com/geo?q=paris&key=maps%7Ekey+12345678'), qurl);
    check('the answer url never carries it', 'url' in q && q.url === 'https://maps.example.com/geo?q=paris');
    check('the echoed query url is redacted', 'text' in q && !q.text.includes('maps%7Ekey+12345678') && !q.text.includes('maps~key 12345678'), 'text' in q ? q.text : '');
    const n = r.sent.length;
    check('another origin is refused', err(await run(r, 'https://evil.example/x', { secrets: ['apiKey'] })).includes('may be sent only to'));
    check('http is refused', err(await run(r, 'http://api.example.com/x', { secrets: ['apiKey'] })).includes('https'));
    check('the handler setting the header itself is refused', err(await run(r, `${ORIGIN}/x`, { headers: { authorization: 'mine' }, secrets: ['apiKey'] })).includes('sets the'));
    check('a url already carrying the parameter (any spelling) is refused', err(await run(r, 'https://maps.example.com/geo?K%65Y=1', { secrets: ['mapsKey'] })).includes('already carries'));
    check('userinfo is refused', err(await run(r, `https://u:p@api.example.com/x`, { secrets: ['apiKey'] })).includes('credentials'));
    check('a non-placed key is refused', err(await run(r, `${ORIGIN}/x`, { secrets: ['units'] })).includes('declared'));
    check('another shim\'s key is refused (only the caller\'s own fields)', err(await run(r, `${ORIGIN}/x`, { secrets: ['otherShimKey'] })).includes('declared'));
    check('none of those went out', r.sent.length === n);
    r.respond.fn = async () => { throw new TypeError(`failed to fetch ${ORIGIN}/?key=maps~key`); };
    const failed = await run(r, `${ORIGIN}/x`, { secrets: ['apiKey'] });
    check('a network error is a fixed string', err(failed) === CREDENTIAL_ERRORS.failed);
    // Like fetch: an abort rejects it.
    r.respond.fn = (_u, init) => new Promise<Response>((_res, rej) => { init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); });
    const slow = await runCredentialFetch(call(`${ORIGIN}/x`, { secrets: ['apiKey'] }), { ...r.deps, timeoutMs: 30 }, r.budget);
    check('a timeout is a fixed string', err(slow) === CREDENTIAL_ERRORS.timedOut);
  }

  console.log('grants gate the dispatch');
  {
    const r = await rig();
    check('ungranted is refused', err(await run(r, `${ORIGIN}/x`, { secrets: ['apiKey'] })).includes('approve'));
    approve(r, 'apiKey');
    r.shim.handlers = { go: 'module.exports = () => fetchEverything()' };
    check('suspended (the code changed) is refused', err(await run(r, `${ORIGIN}/x`, { secrets: ['apiKey'] })).includes('approve') && r.sent.length === 0);
    r.shim.handlers = { ...HANDLERS };
    r.shim.enabled = false;
    check('a disabled shim is refused', err(await run(r, `${ORIGIN}/x`, { secrets: ['apiKey'] })).includes('turned off'));
    r.shim.enabled = true;
    await r.vault.lock();
    check('a locked vault is refused', err(await run(r, `${ORIGIN}/x`, { secrets: ['apiKey'] })).includes('locked') && r.sent.length === 0);
  }

  console.log('the session lease');
  {
    const r = await rig();
    approve(r, 'apiKey');
    check('no lease: allowed', (await run(r, `${ORIGIN}/x`, { secrets: ['apiKey'] })).ok === true);
    await r.leases.hold(TAB, async () => DOC);
    check('while a session holds the tab: refused', err(await run(r, `${ORIGIN}/x`, { secrets: ['apiKey'] })) === SECRETS_NOT_AVAILABLE_IN_SESSION);
    r.leases.committed(TAB, 'DOC-B');
    await r.leases.release(TAB);
    check('after it ends, the document it held stays refused', !r.leases.allows(TAB, DOC));
    check('and so does one loaded during it', !r.leases.allows(TAB, 'DOC-B'));
    r.leases.committed(TAB, 'DOC-C');
    check('a fresh document loaded after it is allowed', r.leases.allows(TAB, 'DOC-C'));
    check('another tab is unaffected', r.leases.allows(8, DOC));
    check('a request whose document Chrome did not name is refused', !r.leases.allows(TAB, undefined) && !r.leases.allows(undefined, DOC));
    // A worker that wakes to a lease left held (its session died with the last worker).
    let stored: unknown = { [String(TAB)]: { held: true, tainted: ['DOC-X'], sealed: false } };
    const woke = new CredentialLeases({ load: async () => stored, save: async (s) => { stored = s; } });
    check('nothing is answered before the stored leases are read', !woke.allows(9, 'DOC-Z'));
    await woke.ready;
    check('a lease left held wakes refusing every document that existed (some writes may be lost)', !woke.allows(TAB, 'DOC-X') && !woke.allows(TAB, 'DOC-Y'));
    woke.committed(TAB, 'DOC-NEW');
    check('and answers one committed after the wake', woke.allows(TAB, 'DOC-NEW') && !woke.allows(TAB, 'DOC-Y'));
    check('which survives another wake', await (async () => {
      await new Promise((r) => setTimeout(r, 5));
      const again = new CredentialLeases({ load: async () => stored, save: async () => undefined });
      await again.ready;
      return again.allows(TAB, 'DOC-NEW') && !again.allows(TAB, 'DOC-Y');
    })());

    console.log('the lease: acquisition and lost writes');
    {
      // A navigation that commits while the current document is being named is tainted too.
      const l = new CredentialLeases({ load: async () => undefined, save: async () => undefined });
      await l.ready;
      await l.hold(5, async () => { l.committed(5, 'NAV-B'); return 'NAV-A'; });
      await l.release(5);
      check('a commit during the hold\'s own sampling is tainted', !l.allows(5, 'NAV-A') && !l.allows(5, 'NAV-B'));
      // A hold that cannot be persisted refuses (the caller must not attach).
      let fail = true;
      let saved: unknown;
      const f = new CredentialLeases({ load: async () => undefined, save: async (st) => { if (fail) throw new Error('quota'); saved = structuredClone(st); } });
      await f.ready;
      check('a hold whose write fails rejects', await f.hold(6, async () => 'D').then(() => false, () => true));
      check('and the tab is refused meanwhile', !f.allows(6, 'D'));
      // A lost write after a persisted hold cannot open a document on the next wake.
      fail = false;
      await f.hold(7, async () => 'H1');
      fail = true;
      f.committed(7, 'H2');
      await f.release(7);
      await new Promise((r) => setTimeout(r, 5));
      const next = new CredentialLeases({ load: async () => saved, save: async () => undefined });
      await next.ready;
      check('lost taint and release writes: the next worker refuses what the session could touch', !next.allows(7, 'H1') && !next.allows(7, 'H2'));
      check('and a release written cleanly ends held-only refusal', await (async () => {
        let st: unknown;
        const ok = new CredentialLeases({ load: async () => undefined, save: async (x) => { st = structuredClone(x); } });
        await ok.ready;
        await ok.hold(8, async () => 'K1');
        await ok.release(8);
        const w = new CredentialLeases({ load: async () => st, save: async () => undefined });
        await w.ready;
        return !w.allows(8, 'K1') && w.allows(8, 'K-LATER');
      })());
    }
    const broken = new CredentialLeases({ load: async () => { throw new Error('unreadable'); }, save: async () => undefined });
    await broken.ready;
    check('unreadable lease state refuses every tab', !broken.allows(1, 'D'));
    const many = new CredentialLeases({ load: async () => undefined, save: async () => undefined });
    await many.ready;
    await many.hold(3, async () => 'D0');
    for (let i = 1; i <= TAINT_CAP; i++) many.committed(3, `D${i}`);
    await many.release(3);
    check('past the taint cap, the tab is refused outright', !many.allows(3, 'FRESH'));
    const noDoc = new CredentialLeases({ load: async () => undefined, save: async () => undefined });
    await noDoc.ready;
    await noDoc.hold(4, async () => undefined);
    await noDoc.release(4);
    check('a hold whose document Chrome could not name seals the tab', !noDoc.allows(4, 'ANY'));
    many.closed(3);
    check('a closed tab forgets its lease', many.allows(3, 'FRESH'));
  }

  console.log('adversarial: a change at every await of the dispatch path');
  {
    const points = ['shim', 'grant', 'reveal', 'vault.session', 'vault.record', 'vault.getRow'];
    const attacks: Array<[string, (r: Rig) => void | Promise<void>, (res: HandlerFetchResult) => boolean]> = [
      ['a lock', (r) => { void r.vault.lock(); }, (res) => err(res).includes('locked')],
      ['a session taking the tab', (r) => { void r.leases.hold(TAB, async () => DOC); }, (res) => err(res) === SECRETS_NOT_AVAILABLE_IN_SESSION],
      ['a revoke', (r) => { r.grants.delete('apiKey'); r.epoch.n++; }, (res) => err(res).includes('approve')],
      ['a code change', (r) => { r.shim.handlers = { go: 'module.exports = () => steal()' }; r.epoch.n++; }, (res) => err(res).includes('approve')],
      ['the shim turned off', (r) => { r.shim.enabled = false; r.epoch.n++; }, (res) => err(res).includes('turned off')],
    ];
    for (const [what, attack, refused] of attacks) {
      for (const point of points) {
        const r = await rig();
        approve(r, 'apiKey');
        // A fresh worker: the vault reads its session record, so vault.session is an await too.
        let fired = false;
        r.hook.at = async (n) => { if (n === point && !fired) { fired = true; await attack(r); } };
        const res = await run(r, `${ORIGIN}/x`, { secrets: ['apiKey'] });
        r.hook.at = undefined;
        if (!fired) continue;
        check(`${what} at ${point}: nothing sent, refused`, r.sent.length === 0 && res.ok === false && refused(res), { res, sent: r.sent.length });
      }
    }
    // The epoch moving for an unrelated write (a witness capture) retries instead of refusing.
    const r = await rig();
    approve(r, 'apiKey');
    let bumps = 0;
    r.hook.at = (n) => { if (n === 'reveal' && bumps < 1) { bumps++; r.epoch.n++; } };
    const res = await run(r, `${ORIGIN}/x`, { secrets: ['apiKey'] });
    r.hook.at = undefined;
    check('an unrelated write while waiting re-reads and sends once', res.ok === true && r.sent.length === 1);
    r.hook.at = (n) => { if (n === 'reveal') r.epoch.n++; };
    const churn = await run(r, `${ORIGIN}/x`, { secrets: ['apiKey'] });
    r.hook.at = undefined;
    check('ceaseless change gives up, sending nothing', churn.ok === false && r.sent.length === 1);
  }

  console.log('budgets');
  {
    const r = await rig();
    approve(r, 'apiKey');
    const hold: Array<() => void> = [];
    r.respond.fn = () => new Promise<Response>((resolve) => { hold.push(() => resolve(new Response('ok'))); });
    const inflight = Array.from({ length: CREDENTIAL_CONCURRENCY }, () => run(r, `${ORIGIN}/x`, { secrets: ['apiKey'] }));
    await new Promise((res) => setTimeout(res, 20));
    const over = await run(r, `${ORIGIN}/x`, { secrets: ['apiKey'] });
    check(`past ${CREDENTIAL_CONCURRENCY} in flight, a request is refused`, err(over).includes('in flight'));
    for (const h of hold) h();
    await Promise.all(inflight);
    r.respond.fn = async () => new Response('ok');
    check('once they finish, another goes', (await run(r, `${ORIGIN}/x`, { secrets: ['apiKey'] })).ok === true);
    let t = 0;
    const b = new CredentialBudget(() => t);
    let refused = 0;
    for (let i = 0; i < 130; i++) { const e = b.take('s'); if (e) refused++; else b.give('s'); }
    check('at most 120 a minute', refused === 10);
    t += 60_000;
    check('the minute rolls over', b.take('s') === null);
  }

  console.log('');
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log(`all credential fetch checks passed (${passes})`);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
