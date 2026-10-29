// The vault registrations and their tokens, kept in step (vault.ts has the
// pure parts). One record per admitted vault shim: its registration
// generation, the token planted in that generation's world, and the match
// patterns it was registered for. A token answers for its shim only while it
// is that shim's current generation; every other token is refused, never
// read as the default world.
//
// Tokens live in the worker's IndexedDB (the store's prefs), out of every
// content script's reach: chrome.storage.local is readable by content scripts
// and Chrome 135 cannot restrict it.
//
// A reconcile that changes anything is bracketed by a persisted state: it
// marks itself running first, revokes the tokens of every shim it is about to
// change before touching a registration, and marks itself idle last. A
// reconcile found running (the worker died midway) means the accounting is
// unknown: every vault registration is unregistered and every token revoked
// before anything is registered again. So a failure leaves fewer worlds and
// fewer tokens than before, never more.
//
// Rotation (a new generation and token) happens when a shim is first
// admitted, when its patterns change, when its registration is missing from
// Chrome, and when asked: on browser start, on install or update (which
// clear user scripts), on enable, and on a grant change. Not on an ordinary
// worker wake, and never into a document already open: a world is created
// only at load, so a document booted on an old token reloads to get the new.

import {
  admitVaultShims, mintToken, vaultBootCode, vaultRegistrationFor, vaultScriptIdFor, worldIdFor, shimIdForVaultScript, VAULT_WORLD_CSP,
  type VaultCandidate, type VaultUserScriptRegistration,
} from './vault';

export const VAULT_STATE_KEY = 'vault.state';

export interface VaultRecord {
  generation: number;
  token: string;
  matches: string[];
}

export interface VaultState {
  /** 'running' while a reconcile that changes something is in flight; found so at the next one, it was interrupted. */
  phase: 'idle' | 'running';
  /** The last generation each shim was given, kept after it leaves so a later admission never reuses one. */
  generations: Record<string, number>;
  /** The admitted shims as registered. */
  records: Record<string, VaultRecord>;
  /** Shims refused at the last admission, with the admitted shims (by name) they overlap. */
  refused: Record<string, string[]>;
}

export function emptyVaultState(): VaultState {
  return { phase: 'idle', generations: {}, records: {}, refused: {} };
}

export interface VaultSyncDeps {
  load(): Promise<VaultState | undefined>;
  save(state: VaultState): Promise<void>;
  /** Ids of the user scripts registered now. */
  registeredIds(): Promise<string[]>;
  unregister(ids: string[]): Promise<void>;
  register(registrations: VaultUserScriptRegistration[]): Promise<void>;
  configureWorld(worldId: string, csp: string): Promise<void>;
  runtimeSource(): Promise<string>;
  engineSource(): Promise<string>;
  token?: () => string;
}

export interface VaultSyncRequest {
  /** The vault shims that should run (enabled, granted, fitting full mode), in list order. */
  candidates: readonly VaultCandidate[];
  /** Rotate these shims' tokens, or every one. */
  rotate?: 'all' | readonly string[];
  /** Send every admitted world's configuration again (the user-scripts toggle cleared the renderers' copy). */
  configure?: boolean;
}

function sameMatches(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

function copyState(s: VaultState): VaultState {
  return { phase: s.phase, generations: { ...s.generations }, records: { ...s.records }, refused: { ...s.refused } };
}

/**
 * Brings the vault registrations and tokens in line with `request`.
 * Answers the state as saved. Throws when Chrome or the store refuses midway;
 * the state is then left 'running' (with the changed shims' tokens already
 * revoked), and the next call starts from nothing.
 */
export async function reconcileVault(deps: VaultSyncDeps, request: VaultSyncRequest): Promise<VaultState> {
  const token = deps.token ?? (() => mintToken());
  const loaded = (await deps.load()) ?? emptyVaultState();
  const interrupted = loaded.phase === 'running';
  const state = copyState(loaded);
  const admission = admitVaultShims(request.candidates);
  const byId = new Map(request.candidates.map((c) => [c.id, c]));
  const registered = new Set((await deps.registeredIds()).map(shimIdForVaultScript).filter((id): id is string => id !== null));
  const rotateAll = interrupted || request.rotate === 'all';
  const rotateSome = new Set(request.rotate === 'all' || request.rotate === undefined ? [] : request.rotate);

  const admitted = new Set(admission.admitted);
  const leaving = Object.keys(state.records).filter((id) => !admitted.has(id));
  const changing = admission.admitted.filter((id) => {
    const record = state.records[id];
    const candidate = byId.get(id);
    if (!record || !candidate) return true;
    return rotateAll || rotateSome.has(id) || !registered.has(id) || !sameMatches(record.matches, candidate.matches);
  });
  // A registration Chrome holds that no record names (left by an interrupted run, or not ours to keep).
  const strays = [...registered].filter((id) => !state.records[id] || !admitted.has(id));
  const refused: Record<string, string[]> = {};
  for (const r of admission.refused) refused[r.id] = r.overlapping;
  const refusedChanged = JSON.stringify(refused) !== JSON.stringify(state.refused);

  if (!interrupted && !leaving.length && !changing.length && !strays.length) {
    if (request.configure) for (const id of admission.admitted) await deps.configureWorld(worldIdFor(id), VAULT_WORLD_CSP);
    if (refusedChanged) {
      state.refused = refused;
      await deps.save(state);
    }
    return state;
  }

  // Revoke first: from here on, no document holding a token of a shim that is
  // leaving or changing is answered as that shim. An interrupted run revokes
  // everything.
  state.phase = 'running';
  const revoke = interrupted ? Object.keys(state.records) : [...leaving, ...changing];
  for (const id of revoke) delete state.records[id];
  await deps.save(state);

  const unregisterIds = interrupted
    ? [...registered]
    : [...new Set([...leaving, ...changing, ...strays])].filter((id) => registered.has(id));
  if (unregisterIds.length) await deps.unregister(unregisterIds.map(vaultScriptIdFor));

  const toRegister = interrupted ? admission.admitted : changing;
  if (toRegister.length) {
    const source = await deps.runtimeSource();
    const engine = await deps.engineSource();
    const registrations: VaultUserScriptRegistration[] = [];
    for (const id of toRegister) {
      const candidate = byId.get(id);
      if (!candidate) continue;
      const generation = (state.generations[id] ?? 0) + 1;
      const record: VaultRecord = { generation, token: token(), matches: [...candidate.matches] };
      state.generations[id] = generation;
      state.records[id] = record;
      registrations.push(vaultRegistrationFor(candidate, engine, vaultBootCode(source, { shimId: id, generation, token: record.token })));
    }
    // The tokens are saved before the scripts exist: a script never runs with a token the worker does not know.
    await deps.save(state);
    for (const r of registrations) await deps.configureWorld(r.worldId, VAULT_WORLD_CSP);
    if (registrations.length) await deps.register(registrations);
  }
  if (request.configure) {
    for (const id of admission.admitted) if (!toRegister.includes(id)) await deps.configureWorld(worldIdFor(id), VAULT_WORLD_CSP);
  }
  state.refused = refused;
  state.phase = 'idle';
  await deps.save(state);
  return state;
}

/**
 * The principal a token proves under `state`: its shim and generation while
 * that is the shim's current record, else null. Never logged. A state found
 * 'running' that this worker did not write itself (`ownRun`) is an
 * interrupted reconcile: nothing is answered until the next one recovers.
 * During this worker's own reconcile, the shims it has not revoked still answer.
 */
export function principalForToken(state: VaultState | undefined, token: unknown, ownRun = false): { shimId: string; generation: number } | null {
  if (!state || typeof token !== 'string' || token.length < 32) return null;
  if (state.phase !== 'idle' && !ownRun) return null;
  for (const [shimId, record] of Object.entries(state.records)) {
    if (constantTimeEqual(record.token, token)) return { shimId, generation: record.generation };
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
