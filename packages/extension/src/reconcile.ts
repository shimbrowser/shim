// What a document does when the worker's answer changes: stop the shims it
// runs that are no longer wanted or whose cascade priority changed, start
// the wanted ones it does not run yet (a moved one again, with its new
// priority), update in place the ones whose spec moved (a rebase, a
// restore: the changed rules alone are swapped under the running control,
// so the other rules keep their lifecycle, deploy gate and all), leave the
// rest alone. Pure, so a harness pins it; content.ts applies it with the
// engine's controls.
//
// A priority and a version are stamped on a control when it boots or is
// updated, so a shim whose priority moved can only take it by booting
// again, and one whose spec moved is updated once per version.

export interface WantedShim {
  id: string;
  priority: number;
  version: number;
}

/** What a document stamps on a running shim's control. */
export interface RunningShim {
  priority: number;
  version: number;
}

export interface Reconciliation<T extends WantedShim> {
  /** Ids running now that the answer no longer lists, or lists at another priority: tear down. */
  stop: string[];
  /** Listed shims not running (any more), in answer order: boot. */
  start: T[];
  /** Running shims listed at the same priority but another version, in answer order: swap their changed rules. */
  update: T[];
}

export function reconcileShims<T extends WantedShim>(running: ReadonlyMap<string, RunningShim>, wanted: readonly T[]): Reconciliation<T> {
  const wantedBy = new Map(wanted.map((s) => [s.id, s]));
  const stop = [...running].filter(([id, r]) => {
    const w = wantedBy.get(id);
    return !w || w.priority !== r.priority;
  }).map(([id]) => id);
  const stopped = new Set(stop);
  return {
    stop,
    start: wanted.filter((s) => !running.has(s.id) || stopped.has(s.id)),
    update: wanted.filter((s) => {
      const r = running.get(s.id);
      return r !== undefined && !stopped.has(s.id) && r.version !== s.version;
    }),
  };
}
