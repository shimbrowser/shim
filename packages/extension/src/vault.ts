// Vault shims and their worlds: where a shim that keeps secrets runs. A
// vault shim is one whose spec declares a `secret` settings field. It never
// shares the default user-script world, where every other shim's handlers
// run and could read or forge its traffic: it gets a world of its own,
// created only by a document_start registration (never injected into an
// open document), and a per-registration token planted in that world, which
// is the only way the worker tells its messages apart. Chrome's message
// sender names no world.
//
// Chrome holds at most 10 user-script worlds in one document over its
// lifetime, the default included, and an eleventh silently runs in the
// default world: overflow fails open. So the number of vault registrations
// that could match one URL is bounded at admission (MAX_VAULT_WORLDS_PER_PAGE)
// over Chrome's own match patterns, conservatively: a shim is refused
// rather than risk a document past the cap.
//
// Pure, so a harness pins it; vault-sync.ts applies it.

import { secretSettingKeys } from '@shimbrowser/core/settings-schema';
import type { SettingsDeclarer } from '@shimbrowser/core/settings-schema';
import { USER_SCRIPT_WORLD_CSP } from './registration';

/** Registration ids of vault scripts: never `shim:` ones, which the default-world sync owns. */
export const VAULT_SCRIPT_PREFIX = 'shimv:';
/** At most this many vault worlds in one document, so the default world plus these stays under Chrome's 10. */
export const MAX_VAULT_WORLDS_PER_PAGE = 8;
/** The configuration every vault world gets: the default world's CSP, and messaging. */
export const VAULT_WORLD_CSP = USER_SCRIPT_WORLD_CSP;

/** Does the spec declare a secret? Read raw and defensively: a declaration that does not validate is still classified. */
export function declaresSecret(spec: SettingsDeclarer | null | undefined): boolean {
  return secretSettingKeys(spec).length > 0;
}

export function worldIdFor(shimId: string): string {
  return `v-${shimId}`;
}

export function vaultScriptIdFor(shimId: string): string {
  return VAULT_SCRIPT_PREFIX + shimId;
}

/** The shim a vault registration id names, or null for any other id. */
export function shimIdForVaultScript(scriptId: string): string | null {
  return scriptId.startsWith(VAULT_SCRIPT_PREFIX) ? scriptId.slice(VAULT_SCRIPT_PREFIX.length) : null;
}

interface ParsedHost {
  wildcard: boolean;
  name: string;
  port: string | null;
}

/** `*://<host>/*` as registration.ts writes it; null for anything else. */
function parsePattern(pattern: string): ParsedHost | null {
  const m = /^\*:\/\/(\*\.)?([^/:*]+)(?::(\d{1,5}))?\/\*$/.exec(pattern);
  if (!m || m[2] === undefined) return null;
  return { wildcard: m[1] !== undefined, name: m[2].toLowerCase(), port: m[3] ?? null };
}

function covers(wild: string, name: string): boolean {
  return name === wild || name.endsWith(`.${wild}`);
}

/**
 * Could one URL match both patterns, by Chrome's matching? Errs toward yes:
 * a pattern it cannot read overlaps everything. A pattern without a port
 * matches every port; `*.a` matches `a` and every subdomain of it.
 */
export function patternsCouldOverlap(a: string, b: string): boolean {
  const pa = parsePattern(a);
  const pb = parsePattern(b);
  if (!pa || !pb) return true;
  if (pa.port !== null && pb.port !== null && pa.port !== pb.port) return false;
  if (!pa.wildcard && !pb.wildcard) return pa.name === pb.name;
  if (pa.wildcard && pb.wildcard) return covers(pa.name, pb.name) || covers(pb.name, pa.name);
  return pa.wildcard ? covers(pa.name, pb.name) : covers(pb.name, pa.name);
}

export interface VaultCandidate {
  id: string;
  name: string;
  matches: readonly string[];
}

export interface VaultAdmission {
  /** Admitted ids, in candidate order. */
  admitted: string[];
  /** Refused ids with the admitted shims (by name) they overlap. */
  refused: { id: string; overlapping: string[] }[];
}

function overlaps(a: VaultCandidate, b: VaultCandidate): boolean {
  return a.matches.some((x) => b.matches.some((y) => patternsCouldOverlap(x, y)));
}

/**
 * Admission over candidates in list order (the earlier shim keeps its world;
 * the newcomer is refused). Each admitted shim overlaps at most `max - 1`
 * other admitted ones, so no set of mutually overlapping vault shims (the
 * only way one URL matches several) exceeds `max`. Conservative: two
 * overlapping pairs that no single URL matches together still count.
 */
export function admitVaultShims(candidates: readonly VaultCandidate[], max = MAX_VAULT_WORLDS_PER_PAGE): VaultAdmission {
  const admitted: VaultCandidate[] = [];
  const neighbors = new Map<string, number>();
  const refused: VaultAdmission['refused'] = [];
  for (const c of candidates) {
    const near = admitted.filter((a) => overlaps(a, c));
    const fits = near.length + 1 <= max && near.every((n) => (neighbors.get(n.id) ?? 0) + 2 <= max);
    if (!fits) {
      refused.push({ id: c.id, overlapping: near.map((n) => n.name) });
      continue;
    }
    for (const n of near) neighbors.set(n.id, (neighbors.get(n.id) ?? 0) + 1);
    neighbors.set(c.id, near.length);
    admitted.push(c);
  }
  return { admitted: admitted.map((a) => a.id), refused };
}

/** What a vault world's runtime is planted with: its shim, its registration generation, and the token that proves both. */
export interface VaultBoot {
  shimId: string;
  generation: number;
  token: string;
}

/** The identifier the vault runtime's bundle reads its boot from (vault-content.ts); the registration binds it. */
export const VAULT_BOOT_PARAM = '__SHIM_VAULT__';

/**
 * The vault runtime's source with its boot bound lexically: the token is a
 * parameter of the closure the runtime runs in, never a global another
 * script in the world could read before the runtime captured it.
 */
export function vaultBootCode(runtimeSource: string, boot: VaultBoot): string {
  const literal = JSON.stringify({ shimId: boot.shimId, generation: boot.generation, token: boot.token });
  return `((${VAULT_BOOT_PARAM}) => {\n${runtimeSource}\n})(${literal});\n`;
}

/**
 * A vault registration: the shim's own world, and one code entry holding the
 * engine's source, then the runtime with its boot bound. Not the engine as a
 * file: Chrome injects only one of several user-script registrations that
 * share a file into a document (measured: two registrations with
 * `shim-core.page.js` in different worlds, and only the first runs), so a
 * vault world would silently get nothing beside the default world's.
 */
export interface VaultUserScriptRegistration {
  id: string;
  matches: string[];
  js: [{ code: string }];
  runAt: 'document_start';
  world: 'USER_SCRIPT';
  worldId: string;
  allFrames: false;
}

export function vaultRegistrationFor(shim: { id: string; matches: readonly string[] }, engineSource: string, code: string): VaultUserScriptRegistration {
  return {
    id: vaultScriptIdFor(shim.id),
    matches: [...shim.matches],
    // The engine first, at the world's top level (its `var ShimCore` is the world's global), then the closure.
    js: [{ code: `${engineSource}\n;\n${code}` }],
    runAt: 'document_start',
    world: 'USER_SCRIPT',
    worldId: worldIdFor(shim.id),
    allFrames: false,
  };
}

/** A fresh token: 256 random bits, base64url. A bearer credential: never logged, never in an error or an answer. */
export function mintToken(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(new ArrayBuffer(32)));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
