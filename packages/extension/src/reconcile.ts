// What a document does when the worker's answer changes: stop the shims it
// runs that are no longer wanted or whose cascade priority changed, start
// the wanted ones it does not run yet (a changed one again, with its new
// priority), leave the rest alone. Pure, so a harness pins it; content.ts
// applies it with the engine's controls.
//
// A priority is stamped on a control when it boots, so a shim whose
// priority moved can only take it by booting again.

export interface WantedShim {
  id: string;
  priority: number;
}

export interface Reconciliation<T extends WantedShim> {
  /** Ids running now that the answer no longer lists, or lists at another priority: tear down. */
  stop: string[];
  /** Listed shims not running (any more), in answer order: boot. */
  start: T[];
}

export function reconcileShims<T extends WantedShim>(running: ReadonlyMap<string, number>, wanted: readonly T[]): Reconciliation<T> {
  const wantedPriority = new Map(wanted.map((s) => [s.id, s.priority]));
  const stop = [...running.keys()].filter((id) => wantedPriority.get(id) !== running.get(id));
  const stopped = new Set(stop);
  return {
    stop,
    start: wanted.filter((s) => !running.has(s.id) || stopped.has(s.id)),
  };
}
