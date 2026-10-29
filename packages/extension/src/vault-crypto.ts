// The vault's cryptography and formats: what a secret setting is stored as
// in Shim for Chrome. WebCrypto only, no storage, so a harness pins every
// format and refusal.
//
// A vault is a random id and a random 256-bit AES-GCM data key. The data key
// is wrapped (AES-GCM) by a key-encryption key derived from the passphrase:
// PBKDF2-HMAC-SHA256 over the NFC-normalized passphrase, a random 16-byte
// salt and 600,000 iterations, parameters versioned and bounded. GCM
// authenticates the unwrap, so a wrong passphrase fails it and there is no
// separate verifier. Each secret value is encrypted under the data key with
// a fresh random IV and length-delimited additional data naming the format,
// the vault, the shim, the field and the placement the value was entered
// for, so a row moved to another shim, field, placement or vault fails to
// decrypt instead of answering for it.
//
// Everything persisted is checked against its format before use; a record
// out of bounds is corrupt, never interpreted.

/** The vault record's format; a record naming another is refused. */
export const VAULT_FORMAT = 1;
/** A secret row's ciphertext format. */
export const SECRET_FORMAT = 1;
export const KDF_ITERATIONS = 600_000;
/** Bounds on a stored KDF: below the floor is downgraded, above the ceiling a denial of service. */
export const KDF_MIN_ITERATIONS = 600_000;
export const KDF_MAX_ITERATIONS = 10_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const DATA_KEY_BYTES = 32;
/** A wrapped data key: 32 bytes plus GCM's 16-byte tag. */
const WRAPPED_BYTES = DATA_KEY_BYTES + 16;
const VAULT_ID_BYTES = 16;
/** The longest passphrase accepted, in characters (PBKDF2 hashes it anyway; this bounds the work). */
export const PASSPHRASE_MAX_CHARS = 1024;
export const PASSPHRASE_MIN_CHARS = 12;
/** The longest secret value, in UTF-8 bytes (core's CREDENTIAL_MAX_VALUE_BYTES). */
export const SECRET_MAX_BYTES = 8 * 1024;

export interface KdfParams {
  name: 'PBKDF2-SHA256';
  iterations: number;
  /** base64url */
  salt: string;
}

/** `prefs.vault`: everything needed to unlock, nothing usable without the passphrase. */
export interface VaultRecord {
  format: typeof VAULT_FORMAT;
  /** base64url, 16 random bytes. */
  vaultId: string;
  kdf: KdfParams;
  /** The data key, AES-GCM-wrapped by the KEK. base64url. */
  wrapped: { iv: string; ct: string };
}

/** One encrypted value (a secret row's `ct` and `iv`). */
export interface SealedValue {
  format: typeof SECRET_FORMAT;
  iv: string;
  ct: string;
}

/** What a sealed value is bound to; every field goes into the additional data. */
export interface SecretBinding {
  vaultId: string;
  shimId: string;
  key: string;
  /** The placement it was entered for (core's credentialUseBinding). */
  placement: string;
}

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64(text: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function random(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
}

function utf8(s: string): Uint8Array<ArrayBuffer> {
  const e = new TextEncoder().encode(s);
  const out = new Uint8Array(new ArrayBuffer(e.length));
  out.set(e);
  return out;
}

/**
 * Length-delimited additional data: each part as a 4-byte big-endian length
 * and its UTF-8 bytes, so no two different bindings serialize alike.
 */
export function additionalData(parts: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoded = parts.map(utf8);
  const out = new Uint8Array(new ArrayBuffer(encoded.reduce((n, p) => n + 4 + p.length, 0)));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const p of encoded) {
    view.setUint32(at, p.length);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}

function secretAad(b: SecretBinding): Uint8Array<ArrayBuffer> {
  return additionalData(['shim-secret', String(SECRET_FORMAT), b.vaultId, b.shimId, b.key, b.placement]);
}

function wrapAad(vaultId: string): Uint8Array<ArrayBuffer> {
  return additionalData(['shim-vault-key', String(VAULT_FORMAT), vaultId]);
}

/** A passphrase as the KDF reads it: NFC, so the same words typed on two keyboards unlock alike. */
export function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize('NFC');
}

/** The vault record if it is exactly the format, else null (corrupt: refuse, offer reset). */
export function parseVaultRecord(value: unknown): VaultRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'format,kdf,vaultId,wrapped') return null;
  if (v.format !== VAULT_FORMAT) return null;
  if (fromB64(v.vaultId)?.length !== VAULT_ID_BYTES) return null;
  const kdf = v.kdf as Record<string, unknown> | null;
  if (typeof kdf !== 'object' || kdf === null || Object.keys(kdf).sort().join(',') !== 'iterations,name,salt') return null;
  if (kdf.name !== 'PBKDF2-SHA256') return null;
  if (typeof kdf.iterations !== 'number' || !Number.isInteger(kdf.iterations) || kdf.iterations < KDF_MIN_ITERATIONS || kdf.iterations > KDF_MAX_ITERATIONS) return null;
  if (fromB64(kdf.salt)?.length !== SALT_BYTES) return null;
  const w = v.wrapped as Record<string, unknown> | null;
  if (typeof w !== 'object' || w === null || Object.keys(w).sort().join(',') !== 'ct,iv') return null;
  if (fromB64(w.iv)?.length !== IV_BYTES || fromB64(w.ct)?.length !== WRAPPED_BYTES) return null;
  return value as VaultRecord;
}

/** A sealed value if it is exactly the format, else null. */
export function parseSealed(value: unknown): SealedValue | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'ct,format,iv') return null;
  if (v.format !== SECRET_FORMAT) return null;
  const iv = fromB64(v.iv);
  const ct = fromB64(v.ct);
  // At least GCM's tag; at most the largest value plus the tag.
  if (iv?.length !== IV_BYTES || !ct || ct.length < 17 || ct.length > SECRET_MAX_BYTES + 16) return null;
  return value as SealedValue;
}

async function deriveKek(passphrase: string, kdf: KdfParams): Promise<CryptoKey> {
  const salt = fromB64(kdf.salt);
  if (!salt) throw new Error('corrupt salt');
  const base = await crypto.subtle.importKey('raw', utf8(normalizePassphrase(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: kdf.iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** The data key as the worker holds it while unlocked: raw bytes (for the session record) and a non-extractable key. */
export interface DataKey {
  raw: Uint8Array<ArrayBuffer>;
  key: CryptoKey;
}

export async function importDataKey(raw: Uint8Array<ArrayBuffer>): Promise<DataKey> {
  if (raw.length !== DATA_KEY_BYTES) throw new Error('a data key is 32 bytes');
  return { raw, key: await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']) };
}

async function wrapWith(kek: CryptoKey, vaultId: string, raw: Uint8Array<ArrayBuffer>): Promise<{ iv: string; ct: string }> {
  const iv = random(IV_BYTES);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: wrapAad(vaultId) }, kek, raw));
  return { iv: toB64(iv), ct: toB64(ct) };
}

function freshKdf(iterations: number): KdfParams {
  return { name: 'PBKDF2-SHA256', iterations, salt: toB64(random(SALT_BYTES)) };
}

/**
 * A new vault for `passphrase`: a new id and data key, wrapped. `iterations`
 * is for harnesses only and still bounded by the floor.
 */
export async function createVault(passphrase: string, iterations = KDF_ITERATIONS): Promise<{ record: VaultRecord; dataKey: DataKey }> {
  if (iterations < KDF_MIN_ITERATIONS || iterations > KDF_MAX_ITERATIONS) throw new Error('KDF iterations out of bounds');
  const vaultId = toB64(random(VAULT_ID_BYTES));
  const dataKey = await importDataKey(random(DATA_KEY_BYTES));
  const kdf = freshKdf(iterations);
  const wrapped = await wrapWith(await deriveKek(passphrase, kdf), vaultId, dataKey.raw);
  return { record: { format: VAULT_FORMAT, vaultId, kdf, wrapped }, dataKey };
}

/** The data key the passphrase unwraps, or null (a wrong passphrase, or a record that does not authenticate). */
export async function unwrapDataKey(record: VaultRecord, passphrase: string): Promise<DataKey | null> {
  const iv = fromB64(record.wrapped.iv);
  const ct = fromB64(record.wrapped.ct);
  if (!iv || !ct) return null;
  try {
    const kek = await deriveKek(passphrase, record.kdf);
    const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: wrapAad(record.vaultId) }, kek, ct));
    return await importDataKey(raw);
  } catch {
    return null;
  }
}

/** The same vault and data key under a new passphrase (fresh salt and IV). */
export async function rewrapVault(record: VaultRecord, dataKey: DataKey, passphrase: string): Promise<VaultRecord> {
  const kdf = freshKdf(Math.max(record.kdf.iterations, KDF_ITERATIONS));
  return { format: VAULT_FORMAT, vaultId: record.vaultId, kdf, wrapped: await wrapWith(await deriveKek(passphrase, kdf), record.vaultId, dataKey.raw) };
}

/** The same vault id and passphrase with a new data key: answers the record and the key, for re-encrypting every row. */
export async function rotateVaultKey(record: VaultRecord, passphrase: string): Promise<{ record: VaultRecord; dataKey: DataKey } | null> {
  const old = await unwrapDataKey(record, passphrase);
  if (!old) return null;
  const dataKey = await importDataKey(random(DATA_KEY_BYTES));
  const kdf = freshKdf(Math.max(record.kdf.iterations, KDF_ITERATIONS));
  return { record: { format: VAULT_FORMAT, vaultId: record.vaultId, kdf, wrapped: await wrapWith(await deriveKek(passphrase, kdf), record.vaultId, dataKey.raw) }, dataKey };
}

export async function sealSecret(dataKey: DataKey, binding: SecretBinding, value: string): Promise<SealedValue> {
  const bytes = utf8(value);
  if (bytes.length === 0 || bytes.length > SECRET_MAX_BYTES) throw new Error('a secret is 1 to 8192 bytes');
  const iv = random(IV_BYTES);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: secretAad(binding) }, dataKey.key, bytes));
  return { format: SECRET_FORMAT, iv: toB64(iv), ct: toB64(ct) };
}

/** The value, or null when it does not authenticate under this key and binding (moved, tampered, another vault). */
export async function openSecret(dataKey: DataKey, binding: SecretBinding, sealed: unknown): Promise<string | null> {
  const s = parseSealed(sealed);
  if (!s) return null;
  const iv = fromB64(s.iv);
  const ct = fromB64(s.ct);
  if (!iv || !ct) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: secretAad(binding) }, dataKey.key, ct);
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}

// --- passphrases ----------------------------------------------------------------

// The most common passwords and the obvious variations a user reaches for; a
// passphrase that is one of these (or one of these repeated) is refused.
const COMMON = new Set([
  'password', 'passw0rd', 'password1', 'password12', 'password123', 'password1234', '123456', '1234567', '12345678', '123456789',
  '1234567890', '12345678910', 'qwerty', 'qwertyuiop', 'qwerty123', 'qwerty123456', 'letmein', 'letmeinplease', 'iloveyou',
  'iloveyou123', 'admin', 'administrator', 'welcome', 'welcome123', 'monkey', 'dragon', 'football', 'baseball', 'sunshine',
  'princess', 'trustno1', 'abc123', 'abcdefg', 'abcdefgh', 'abcdefghijkl', 'abcd1234', '1q2w3e4r', '1q2w3e4r5t6y', 'zaq12wsx',
  'asdfghjkl', 'asdfasdfasdf', 'changeme', 'changeme123', 'secret', 'secretpassword', 'mypassword', 'masterpassword',
  'correcthorsebatterystaple', 'opensesame', 'shimshimshim', 'shimpassword', 'shimforchrome', 'passphrase', 'mypassphrase',
  'thisismypassword', 'thisismypassphrase', 'superman', 'batman', 'starwars', 'whatever', 'qazwsxedc', 'qazwsxedcrfv',
  '000000000000', '111111111111', '123123123123', '121212121212', '987654321', '9876543210', 'aaaaaaaaaaaa', 'loveyou',
]);

/** Why a passphrase is refused, or null when it may be used. */
export function passphraseProblem(passphrase: unknown): string | null {
  if (typeof passphrase !== 'string') return 'a passphrase is text';
  const p = normalizePassphrase(passphrase);
  if ([...p].length < PASSPHRASE_MIN_CHARS) return `use at least ${PASSPHRASE_MIN_CHARS} characters (a few unrelated words work well)`;
  if (p.length > PASSPHRASE_MAX_CHARS) return `use at most ${PASSPHRASE_MAX_CHARS} characters`;
  const folded = p.toLowerCase().replace(/[\s\-_.]+/g, '');
  if (new Set(folded).size <= 2) return 'that passphrase repeats too little to be hard to guess';
  if (COMMON.has(folded)) return 'that is one of the most common passwords; choose something else';
  for (const c of COMMON) {
    if (c.length >= 4 && folded.length % c.length === 0 && c.repeat(folded.length / c.length) === folded) return 'that is a common password repeated; choose something else';
  }
  return null;
}

const CONSONANTS = 'bdfghjklmnprstvz';
const VOWELS = 'aeiou';

/** One unbiased index below `n`, from the CSPRNG. */
function pick(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const x = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
    if (x < limit) return x % n;
  }
}

/**
 * A generated passphrase: five pronounceable five-letter words
 * (consonant-vowel-consonant-vowel-consonant, 16·5·16·5·16 = 102,400 each,
 * about 16.6 bits), about 83 bits in all.
 */
export function suggestPassphrase(words = 5): string {
  const out: string[] = [];
  for (let w = 0; w < words; w++) {
    let s = '';
    for (let i = 0; i < 5; i++) s += i % 2 === 0 ? CONSONANTS[pick(CONSONANTS.length)] : VOWELS[pick(VOWELS.length)];
    out.push(s);
  }
  return out.join('-');
}
