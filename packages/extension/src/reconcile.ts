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
// again, and one whose spec moved is updated once per version. The
// handler modules are stamped too (as one key): compiled once at boot, a
// change to them (a session's commit) is a reboot, never an in-place
// update that would leave old code resident under an unchanged rule. So
// are the shim's settings values (as a digest): a handler that read them at
// boot sees a changed value only by running again, as the Shim browser
// re-applies a shim when a setting is saved.

export interface WantedShim {
  id: string;
  priority: number;
  version: number;
  /** The handler modules as one comparable key (their JSON); absent on both sides: not compared. */
  handlersKey?: string;
  /** The shim's settings values as one digest; present when it declares settings, compared like handlersKey. */
  settingsKey?: string;
}

/** What a document stamps on a running shim's control. */
export interface RunningShim {
  priority: number;
  version: number;
  handlersKey?: string;
  settingsKey?: string;
}

export interface Reconciliation<T extends WantedShim> {
  /** Ids running now that the answer no longer lists, or lists at another priority, other handler modules or other settings values: tear down. */
  stop: string[];
  /** Listed shims not running (any more), in answer order: boot. */
  start: T[];
  /** Running shims listed at the same priority and handlers but another version, in answer order: swap their changed rules. */
  update: T[];
}

export function reconcileShims<T extends WantedShim>(running: ReadonlyMap<string, RunningShim>, wanted: readonly T[]): Reconciliation<T> {
  const wantedBy = new Map(wanted.map((s) => [s.id, s]));
  const stop = [...running].filter(([id, r]) => {
    const w = wantedBy.get(id);
    if (!w || w.priority !== r.priority) return true;
    if (w.settingsKey !== undefined && r.settingsKey !== undefined && w.settingsKey !== r.settingsKey) return true;
    return w.handlersKey !== undefined && r.handlersKey !== undefined && w.handlersKey !== r.handlersKey;
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
