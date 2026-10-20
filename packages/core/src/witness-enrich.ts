// Bounded component-identity enrichment for a freshly captured witness.
//
// apply-rule builds a witness from the DOM synchronously, then asks the host
// for the element's framework component identity (api.componentId.verify) and
// the deploy's symbol map (api.componentId.symbols) so the stored identity is
// in original-name space. Both are async; the symbol map can wait on a cold
// Bundle Discovery run with no time limit. A host reads a preview's events
// once, at its settle boundary, so a witness emitted after it is lost and the
// rule commits without one.
//
// So capture waits at most ENRICH_BUDGET_MS for BOTH calls and resolves once:
// with `component` when both finished, without it otherwise. Resolving once
// (not "now, then again when enriched") matters while hosts keep the first
// witness they see.

import * as componentId from './component-id';
import { ENRICH_BUDGET_MS, withinBudget, readSymbols } from './engine-internal';
import type { CoreApi } from './api';
import type { ComponentDescriptor, Witness } from './types';

export async function enrichWitness(
  el: Element,
  witness: Witness,
  api: CoreApi,
  budgetMs: number = ENRICH_BUDGET_MS,
): Promise<Witness> {
  const verifyFn = api && api.componentId && api.componentId.verify;
  if (typeof verifyFn !== 'function') return witness;
  const verify = Promise.resolve()
    .then(() => verifyFn(el))
    .catch((): ComponentDescriptor | null => null);
  // Both run concurrently, each bounded by the same budget, so the whole wait
  // is at most `budgetMs`.
  const [syms, cidRead] = await Promise.all([
    readSymbols(api, budgetMs),
    withinBudget(verify, budgetMs),
  ]);
  if (!cidRead.done || syms.state === 'timed-out') return witness;
  const cid = cidRead.value;
  if (!cid || !Array.isArray(cid.path) || !cid.path.length) return witness;
  // Store the identity in ORIGINAL-name space when the deploy's symbol map is
  // available (sourcemap Stage B): `Wc` → `TrackRow`. That's what makes the
  // witness deploy-durable — the next build renames Wc to Xd, but both
  // translate back to TrackRow. No map → raw names.
  const map = syms.state === 'ready' ? syms.symbols : null;
  const t = componentId.translateComponent(cid, map);
  // `mapped: true` marks a witness whose names only exist through a symbol map
  // (translation actually renamed them): the verify veto then refuses to score
  // it raw against minified fibers when no map is available (matchComponent).
  if (t) witness.component = t !== cid ? { ...t, mapped: true } : t;
  return witness;
}
