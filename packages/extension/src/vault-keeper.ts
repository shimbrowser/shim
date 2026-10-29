// The vault's state machine: none → locked → unlocked, and the operations
// that move it (setup, unlock, lock, reset, change passphrase, rotate the
// data key, expiry). Formats and cryptography are vault-crypto.ts; storage is
// the deps, so a harness drives every interleaving.
//
// Generations. Every operation that changes what may be decrypted (setup,
// unlock, lock, reset, change passphrase, rotate, expiry) moves the
// generation, synchronously, at the moment it is asked. Every continuation of
// an operation checks the generation it started under before it writes, and
// the broker's final check before a secret-bearing fetch (isCurrent) is
// synchronous: a lock acknowledged means no dispatch under the old
// generation. A request already sent cannot be recalled.
//
// Lock is never queued behind another operation: its generation move and the
// dropped key happen when it is called. Every other operation runs one at a
// time.
//
// The unlocked key lives in chrome.storage.session (memory only, extension
// pages and the worker only, gone with the browser), with the time it was
// unlocked, an absolute expiry 12 hours on, and an idle window (a setting,
// at most 12 hours) renewed only by the user's own activity in the
// extension's pages (touch), never by a shim using a secret. Both are
// checked before every use and on every worker wake; an alarm only cleans up
// on time.

import {
  createVault, unwrapDataKey, rewrapVault, rotateVaultKey, sealSecret, openSecret, importDataKey, parseVaultRecord, passphraseProblem,
  fromB64, toB64, type DataKey, type VaultRecord, type SealedValue, type SecretBinding,
} from './vault-crypto';

export const UNLOCK_MAX_MS = 12 * 60 * 60 * 1000;
/** The idle windows a user may choose ("lock after"); the longest is the absolute expiry. */
export const LOCK_AFTER_CHOICES: readonly number[] = Object.freeze([15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000, UNLOCK_MAX_MS]);
export const DEFAULT_LOCK_AFTER_MS = UNLOCK_MAX_MS;
export const LOCK_AFTER_KEY = 'vault.lockAfterMs';
export const VAULT_SESSION_KEY = 'vault.unlocked';

export type VaultStatus = 'none' | 'locked' | 'unlocked' | 'corrupt';

/** One stored secret: which shim and field, the placement it was entered for, and the sealed value. */
export interface SecretRow {
  shimId: string;
  key: string;
  classification: 'secret';
  placement: string;
  sealed: SealedValue;
  updatedAt: number;
}

/** What chrome.storage.session holds while unlocked. */
interface SessionRecord {
  vaultId: string;
  key: string;
  unlockedAt: number;
  expiresAt: number;
  idleMs: number;
  lastActivity: number;
}

export interface VaultKeeperDeps {
  /** prefs.vault as stored (undefined when there is none). */
  loadRecord(): Promise<unknown>;
  /** Replace the record alone (a new passphrase over the same data key). */
  saveRecord(record: VaultRecord): Promise<void>;
  /** In one transaction: the new record (or none), every secret row and every credential grant cleared. */
  resetAll(record: VaultRecord | null): Promise<void>;
  /** In one transaction: the new record, and exactly these rows in place of every row. */
  replaceAll(record: VaultRecord, rows: SecretRow[]): Promise<void>;
  listRows(): Promise<SecretRow[]>;
  getRow(shimId: string, key: string): Promise<SecretRow | undefined>;
  putRow(row: SecretRow): Promise<void>;
  deleteRow(shimId: string, key: string): Promise<boolean>;
  session: { get(): Promise<unknown>; set(value: SessionRecord): Promise<void>; remove(): Promise<void> };
  lockAfterMs(): Promise<unknown>;
  setLockAfterMs(ms: number): Promise<void>;
  now(): number;
  /** Arrange a cleanup at `at` (ms), or none. Proactive only: every use checks the expiry itself. */
  schedule?(at: number | null): void;
  /** Harnesses only: PBKDF2 iterations for a new vault (still at least the floor). */
  iterations?: number;
}

export type VaultResult = { ok: true } | { ok: false; error: string };

export const VAULT_ERRORS = {
  locked: 'the vault is locked: unlock it in Shim for Chrome\'s popup or settings',
  none: 'no vault yet: set one up in Shim for Chrome\'s settings',
  corrupt: 'the vault record cannot be read: reset the vault in Shim for Chrome\'s settings (secrets will need entering again)',
  wrong: 'that passphrase does not unlock this vault',
  exists: 'a vault is already set up',
  interrupted: 'the vault changed while this was in progress; try again',
} as const;

interface Unlocked {
  gen: number;
  dataKey: DataKey;
  vaultId: string;
  session: SessionRecord;
}

function parseSession(v: unknown): SessionRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const s = v as Record<string, unknown>;
  const nums = ['unlockedAt', 'expiresAt', 'idleMs', 'lastActivity'] as const;
  if (typeof s.vaultId !== 'string' || typeof s.key !== 'string') return null;
  if (!nums.every((k) => typeof s[k] === 'number' && Number.isFinite(s[k]))) return null;
  if (fromB64(s.key)?.length !== 32) return null;
  return s as unknown as SessionRecord;
}

function deadline(s: SessionRecord): number {
  return Math.min(s.expiresAt, s.unlockedAt + UNLOCK_MAX_MS, s.lastActivity + Math.min(s.idleMs, UNLOCK_MAX_MS));
}

function chosenLockAfter(v: unknown): number {
  return typeof v === 'number' && LOCK_AFTER_CHOICES.includes(v) ? v : DEFAULT_LOCK_AFTER_MS;
}

export class VaultKeeper {
  private gen = 0;
  private unlocked: Unlocked | null = null;
  /** True once this worker has looked at the session record (a wake reads it once). */
  private sessionRead = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: VaultKeeperDeps) {}

  /** The generation now. */
  generation(): number {
    return this.gen;
  }

  /**
   * Synchronous: is `gen` still the generation, with the vault unlocked and
   * not past its deadline? The broker's last check before it dispatches.
   */
  isCurrent(gen: number): boolean {
    const u = this.unlocked;
    if (!u || u.gen !== gen || gen !== this.gen) return false;
    if (this.deps.now() >= deadline(u.session)) {
      this.dropKey();
      return false;
    }
    return true;
  }

  private dropKey(): void {
    this.gen += 1;
    this.unlocked = null;
    void this.deps.session.remove().catch(() => undefined);
    this.deps.schedule?.(null);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async record(): Promise<{ status: 'none' } | { status: 'corrupt' } | { status: 'ok'; record: VaultRecord }> {
    const raw = await this.deps.loadRecord();
    if (raw === undefined || raw === null) return { status: 'none' };
    const record = parseVaultRecord(raw);
    return record ? { status: 'ok', record } : { status: 'corrupt' };
  }

  /**
   * The unlocked key, reading the session record once per worker life (a
   * wake), checking the deadline every time. Null while locked.
   */
  private async current(): Promise<Unlocked | null> {
    const gen = this.gen;
    if (!this.unlocked && !this.sessionRead) {
      const [raw, rec] = await Promise.all([this.deps.session.get(), this.record()]);
      // Locked (or anything else) meanwhile: what was read belongs to before it.
      if (gen !== this.gen || this.unlocked) return this.current();
      this.sessionRead = true;
      const session = parseSession(raw);
      if (session && rec.status === 'ok' && session.vaultId === rec.record.vaultId && this.deps.now() < deadline(session)) {
        const raw32 = fromB64(session.key);
        if (raw32) {
          const dataKey = await importDataKey(raw32);
          if (gen !== this.gen) return this.current();
          this.unlocked = { gen: this.gen, dataKey, vaultId: session.vaultId, session };
          this.deps.schedule?.(deadline(session));
        }
      } else if (raw !== undefined) {
        // Expired, for another vault, or unreadable: gone.
        await this.deps.session.remove().catch(() => undefined);
      }
    }
    const u = this.unlocked;
    if (!u) return null;
    if (this.deps.now() >= deadline(u.session)) {
      this.dropKey();
      return null;
    }
    return u;
  }

  async status(): Promise<{ state: VaultStatus; expiresAt: number | null; lockAfterMs: number }> {
    const lockAfterMs = chosenLockAfter(await this.deps.lockAfterMs());
    const rec = await this.record();
    if (rec.status !== 'ok') return { state: rec.status, expiresAt: null, lockAfterMs };
    const u = await this.current();
    return u ? { state: 'unlocked', expiresAt: deadline(u.session), lockAfterMs } : { state: 'locked', expiresAt: null, lockAfterMs };
  }

  private async open(dataKey: DataKey, vaultId: string): Promise<Unlocked> {
    const now = this.deps.now();
    const idleMs = chosenLockAfter(await this.deps.lockAfterMs());
    const session: SessionRecord = { vaultId, key: toB64(dataKey.raw), unlockedAt: now, expiresAt: now + UNLOCK_MAX_MS, idleMs, lastActivity: now };
    return { gen: this.gen, dataKey, vaultId, session };
  }

  /** Persist a newly unlocked state, unless the generation moved meanwhile; then undo the write. */
  private async commitUnlocked(gen: number, next: Unlocked): Promise<boolean> {
    if (gen !== this.gen) return false;
    await this.deps.session.set(next.session);
    if (gen !== this.gen) {
      await this.deps.session.remove().catch(() => undefined);
      return false;
    }
    this.gen += 1;
    this.unlocked = { ...next, gen: this.gen };
    this.sessionRead = true;
    this.deps.schedule?.(deadline(next.session));
    return true;
  }

  /** A first vault, left unlocked. */
  setup(passphrase: unknown): Promise<VaultResult> {
    const gen = this.gen;
    return this.serial(async () => {
      const problem = passphraseProblem(passphrase);
      if (problem) return { ok: false, error: problem };
      const rec = await this.record();
      if (rec.status === 'ok') return { ok: false, error: VAULT_ERRORS.exists };
      if (rec.status === 'corrupt') return { ok: false, error: VAULT_ERRORS.corrupt };
      const { record, dataKey } = await createVault(passphrase as string, this.deps.iterations);
      if (gen !== this.gen) return { ok: false, error: VAULT_ERRORS.interrupted };
      // A new vault starts with no secret row. Grants are the user's
      // approvals, not values, and with no vault before this one any grant
      // was approved under no other vault (the install review, or the
      // settings page before setup): they stay. A reset clears both.
      await this.deps.replaceAll(record, []);
      const next = await this.open(dataKey, record.vaultId);
      return (await this.commitUnlocked(gen, next)) ? { ok: true } : { ok: false, error: VAULT_ERRORS.interrupted };
    });
  }

  /** A wrong passphrase changes nothing. */
  unlock(passphrase: unknown): Promise<VaultResult> {
    const gen = this.gen;
    return this.serial(async () => {
      if (typeof passphrase !== 'string' || passphrase.length > 1024) return { ok: false, error: VAULT_ERRORS.wrong };
      const rec = await this.record();
      if (rec.status === 'none') return { ok: false, error: VAULT_ERRORS.none };
      if (rec.status === 'corrupt') return { ok: false, error: VAULT_ERRORS.corrupt };
      const dataKey = await unwrapDataKey(rec.record, passphrase);
      if (!dataKey) return { ok: false, error: VAULT_ERRORS.wrong };
      const next = await this.open(dataKey, rec.record.vaultId);
      return (await this.commitUnlocked(gen, next)) ? { ok: true } : { ok: false, error: VAULT_ERRORS.interrupted };
    });
  }

  /** Immediate: the generation moves and the key is dropped before this returns; the session record goes after. */
  lock(): Promise<void> {
    this.gen += 1;
    this.unlocked = null;
    this.sessionRead = true;
    this.deps.schedule?.(null);
    return this.deps.session.remove().catch(() => undefined);
  }

  /** Called by the alarm and on wake: lock when the deadline passed. */
  async expireIfDue(): Promise<void> {
    await this.current();
  }

  /** The user acted in the extension's own pages: the idle window starts again (never past the absolute expiry). */
  async touch(): Promise<void> {
    const u = await this.current();
    if (!u || u.gen !== this.gen) return;
    const session = { ...u.session, lastActivity: this.deps.now() };
    this.unlocked = { ...u, session };
    await this.deps.session.set(session);
    this.deps.schedule?.(deadline(session));
  }

  setLockAfter(ms: unknown): Promise<VaultResult> {
    return this.serial(async () => {
      if (typeof ms !== 'number' || !LOCK_AFTER_CHOICES.includes(ms)) return { ok: false, error: 'not one of the lock-after choices' };
      await this.deps.setLockAfterMs(ms);
      const u = await this.current();
      if (u) {
        const session = { ...u.session, idleMs: ms };
        this.unlocked = { ...u, session };
        await this.deps.session.set(session);
        this.deps.schedule?.(deadline(session));
      }
      return { ok: true };
    });
  }

  /**
   * Forgot the passphrase: a new vault id and data key under `passphrase`,
   * and every secret row and grant cleared, in one transaction. Also the way
   * out of a corrupt record. Leaves the new vault unlocked.
   */
  reset(passphrase: unknown): Promise<VaultResult> {
    const gen = ++this.gen;
    this.unlocked = null;
    return this.serial(async () => {
      const problem = passphraseProblem(passphrase);
      if (problem) return { ok: false, error: problem };
      const { record, dataKey } = await createVault(passphrase as string, this.deps.iterations);
      if (gen !== this.gen) return { ok: false, error: VAULT_ERRORS.interrupted };
      await this.deps.session.remove().catch(() => undefined);
      await this.deps.resetAll(record);
      const next = await this.open(dataKey, record.vaultId);
      return (await this.commitUnlocked(gen, next)) ? { ok: true } : { ok: false, error: VAULT_ERRORS.interrupted };
    });
  }

  /** The same data key under a new passphrase; needs the current one. */
  changePassphrase(current: unknown, next: unknown): Promise<VaultResult> {
    const gen = this.gen;
    return this.serial(async () => {
      if (typeof current !== 'string') return { ok: false, error: VAULT_ERRORS.wrong };
      const problem = passphraseProblem(next);
      if (problem) return { ok: false, error: problem };
      const rec = await this.record();
      if (rec.status !== 'ok') return { ok: false, error: rec.status === 'none' ? VAULT_ERRORS.none : VAULT_ERRORS.corrupt };
      const dataKey = await unwrapDataKey(rec.record, current);
      if (!dataKey) return { ok: false, error: VAULT_ERRORS.wrong };
      const record = await rewrapVault(rec.record, dataKey, next as string);
      if (gen !== this.gen) return { ok: false, error: VAULT_ERRORS.interrupted };
      await this.deps.saveRecord(record);
      const opened = await this.open(dataKey, record.vaultId);
      return (await this.commitUnlocked(gen, opened)) ? { ok: true } : { ok: false, error: VAULT_ERRORS.interrupted };
    });
  }

  /**
   * After a suspected exposure: a new data key, every row re-encrypted under
   * it, in one transaction. A row that no longer decrypts is dropped (it
   * could never be used). Needs the passphrase.
   */
  rotateDataKey(passphrase: unknown): Promise<VaultResult & { dropped?: number }> {
    const gen = this.gen;
    return this.serial(async () => {
      if (typeof passphrase !== 'string') return { ok: false, error: VAULT_ERRORS.wrong };
      const rec = await this.record();
      if (rec.status !== 'ok') return { ok: false, error: rec.status === 'none' ? VAULT_ERRORS.none : VAULT_ERRORS.corrupt };
      const old = await unwrapDataKey(rec.record, passphrase);
      if (!old) return { ok: false, error: VAULT_ERRORS.wrong };
      const rotated = await rotateVaultKey(rec.record, passphrase);
      if (!rotated) return { ok: false, error: VAULT_ERRORS.wrong };
      const rows: SecretRow[] = [];
      let dropped = 0;
      for (const row of await this.deps.listRows()) {
        const binding: SecretBinding = { vaultId: rec.record.vaultId, shimId: row.shimId, key: row.key, placement: row.placement };
        const value = await openSecret(old, binding, row.sealed);
        if (value === null) { dropped++; continue; }
        rows.push({ ...row, sealed: await sealSecret(rotated.dataKey, binding, value) });
      }
      if (gen !== this.gen) return { ok: false, error: VAULT_ERRORS.interrupted };
      // The old key goes before the rows change: rotation keeps the vault id,
      // so a session record still holding the old key would look current to
      // a worker that wakes after the commit below and before the new key is
      // saved. Locked in between; a failure here leaves the vault locked.
      this.gen += 1;
      const mine = this.gen;
      this.unlocked = null;
      this.deps.schedule?.(null);
      await this.deps.session.remove();
      if (mine !== this.gen) return { ok: false, error: VAULT_ERRORS.interrupted };
      await this.deps.replaceAll(rotated.record, rows);
      const opened = await this.open(rotated.dataKey, rotated.record.vaultId);
      return (await this.commitUnlocked(mine, opened)) ? { ok: true, dropped } : { ok: false, error: VAULT_ERRORS.interrupted };
    });
  }

  /** Store a value for a shim's placed secret, sealed to that shim, field and placement. Needs the vault unlocked. */
  setSecret(shimId: string, key: string, placement: string, value: string): Promise<VaultResult> {
    return this.serial(async () => {
      const u = await this.current();
      if (!u) return { ok: false, error: await this.closedReason() };
      const sealed = await sealSecret(u.dataKey, { vaultId: u.vaultId, shimId, key, placement }, value);
      if (!this.isCurrent(u.gen)) return { ok: false, error: VAULT_ERRORS.interrupted };
      await this.deps.putRow({ shimId, key, classification: 'secret', placement, sealed, updatedAt: this.deps.now() });
      return { ok: true };
    });
  }

  clearSecret(shimId: string, key: string): Promise<boolean> {
    return this.serial(() => this.deps.deleteRow(shimId, key));
  }

  private async closedReason(): Promise<string> {
    const rec = await this.record();
    return rec.status === 'none' ? VAULT_ERRORS.none : rec.status === 'corrupt' ? VAULT_ERRORS.corrupt : VAULT_ERRORS.locked;
  }

  /**
   * Decrypt one placed secret for a dispatch: the value with the generation
   * it was read under, which the broker checks again (isCurrent) with
   * nothing awaited before it calls fetch. Not queued: a dispatch never
   * waits behind an unlock. A row entered for another placement, or one that
   * does not authenticate, answers `unreadable`.
   */
  async reveal(shimId: string, key: string, placement: string): Promise<{ ok: true; value: string; gen: number } | { ok: false; error: string; code: 'locked' | 'unset' | 'unreadable' }> {
    const u = await this.current();
    if (!u) return { ok: false, error: await this.closedReason(), code: 'locked' };
    const row = await this.deps.getRow(shimId, key);
    if (!row) return { ok: false, error: `"${key}" is not set`, code: 'unset' };
    if (row.placement !== placement) return { ok: false, error: `"${key}" was entered for a different destination; enter it again in the shim's settings`, code: 'unreadable' };
    const value = await openSecret(u.dataKey, { vaultId: u.vaultId, shimId, key, placement }, row.sealed);
    if (value === null) return { ok: false, error: `"${key}" cannot be read; enter it again in the shim's settings`, code: 'unreadable' };
    return { ok: true, value, gen: u.gen };
  }
}
