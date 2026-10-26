// Which content scripts the worker registers: one per enabled shim, matching
// exactly the shim's hosts, running the engine and the page runtime at
// document_start in the isolated world. Pure, so a harness pins it; the
// worker applies the result through chrome.scripting.
//
// Several shims on one host register the same files several times. The
// runtime guards against that: the first copy in a document boots every
// matching shim and the rest return at once.

import { matchPatternsForHosts } from './match-patterns';

export const SCRIPT_ID_PREFIX = 'shim:';

/** The files a registration runs, in order: the engine, then the runtime. */
export const RUNTIME_FILES: readonly string[] = Object.freeze(['shim-core.page.js', 'content.js']);

export interface RegistrableShim {
  id: string;
  enabled: boolean;
  spec: { match?: { hosts?: string[] } };
}

export interface ScriptRegistration {
  id: string;
  matches: string[];
  js: string[];
  runAt: 'document_start';
  world: 'ISOLATED';
  allFrames: false;
  persistAcrossSessions: true;
}

export function scriptIdFor(shimId: string): string {
  return SCRIPT_ID_PREFIX + shimId;
}

/** The shim a registration id names, or null for an id that is not ours. */
export function shimIdFor(scriptId: string): string | null {
  return scriptId.startsWith(SCRIPT_ID_PREFIX) ? scriptId.slice(SCRIPT_ID_PREFIX.length) : null;
}

/** The match patterns a shim registers for and holds host access to. */
export function patternsFor(shim: { spec: { match?: { hosts?: string[] } } }): string[] {
  return matchPatternsForHosts(shim.spec.match?.hosts ?? []).patterns;
}

/** One registration per enabled shim with at least one registrable host, in list order. */
export function registrationsFor(shims: readonly RegistrableShim[]): ScriptRegistration[] {
  const out: ScriptRegistration[] = [];
  for (const shim of shims) {
    if (!shim.enabled) continue;
    const matches = patternsFor(shim);
    if (matches.length === 0) continue;
    out.push({
      id: scriptIdFor(shim.id),
      matches,
      js: [...RUNTIME_FILES],
      runAt: 'document_start',
      world: 'ISOLATED',
      allFrames: false,
      persistAcrossSessions: true,
    });
  }
  return out;
}

/**
 * The host access a removed shim held that no remaining shim needs: the
 * extension holds no host it has no shim for. Disabled shims keep theirs,
 * so re-enabling never asks again.
 */
export function originsToRelease(removed: readonly string[], remaining: readonly { spec: { match?: { hosts?: string[] } } }[]): string[] {
  const kept = new Set<string>();
  for (const shim of remaining) for (const pattern of patternsFor(shim)) kept.add(pattern);
  return removed.filter((pattern) => !kept.has(pattern));
}
