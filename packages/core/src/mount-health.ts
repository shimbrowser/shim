// Self-healing verdict for one mount's returned output roots. Pure and
// duck-typed (only `isConnected` is read) so a bare-node harness covers it;
// apply-rule.ts calls it on every scan.
//
// The stomp signal is "an output root that was on the page is no longer
// connected": the site (or a framework re-render) removed it, so the mount is
// torn down and the handler re-run. A root the handler returned but NEVER put
// on the page is a different thing. The default `inline` strategy places
// nothing (the handler inserts its own output), so such a root was never
// connected, and reading it as stomped re-ran the handler on every body
// mutation, forever (a busy page churned with nothing reported). Roots that are
// unconnected once the handler settles are recorded at mount as `unattached`
// and excluded from the stomp check until they are first seen connected (a
// handler may insert a returned root later, from a timer); from then on they
// self-heal like any other root.

export interface OutputRoot {
  readonly isConnected: boolean;
}

export type MountHealth =
  // Every tracked root is connected: nothing to do.
  | 'healthy'
  // A tracked root that was on the page has left it: tear down and re-mount.
  | 'stomped'
  // No tracked root (nothing returned, or only roots never on the page): never re-mount.
  | 'untracked';

/** The roots of `outputs` that are not on the page. Called once the handler settled. */
export function unattachedRoots<T extends OutputRoot>(outputs: readonly T[]): Set<T> {
  const out = new Set<T>();
  for (const n of outputs) if (!n.isConnected) out.add(n);
  return out;
}

/**
 * Judge a mount on a scan. `unattached` is updated in place: a root seen
 * connected leaves it and is tracked from then on.
 */
export function judgeMount<T extends OutputRoot>(outputs: readonly T[], unattached: Set<T> | undefined): MountHealth {
  if (unattached) {
    for (const n of unattached) if (n.isConnected) unattached.delete(n);
  }
  let tracked = 0;
  for (const n of outputs) {
    if (unattached?.has(n)) continue;
    tracked += 1;
    if (!n.isConnected) return 'stomped';
  }
  return tracked === 0 ? 'untracked' : 'healthy';
}

/** The rule-status note for `count` returned roots that never reached the page. */
export function unattachedNote(count: number): string | null {
  if (count <= 0) return null;
  return `a handler returned ${count} node(s) it never put on the page: with the default inline mount the engine `
    + 'places nothing, so insert your output yourself (e.g. anchor.appendChild(el)) before returning it, or set '
    + 'mount.strategy to portal / overlay / shadow, which the engine places. Until then those nodes are not shown '
    + 'and get no self-healing';
}
