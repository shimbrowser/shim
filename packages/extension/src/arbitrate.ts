// One runtime per page. Two can meet when a handover and a reconnect
// cross: a holder's port down for the moment, the other world's runtime
// injected beside it, and the holder reconnecting later. The worker,
// which sees every runtime's port per tab and world, settles it: the
// runtime that does not fit the mode is retired, and the survivor
// reboots if the loser had run anything, because the loser's teardown
// removes stylesheets the two share by id and strips per-rule tokens the
// survivor's rules use (a reconnecting runtime has its controls; a
// newcomer retired at once has none, and the survivor is left alone).
// Pure, so a harness pins every case; the worker applies it.

export type RuntimeWorld = 'isolated' | 'user-script';
export type ExtensionModeName = 'full' | 'declarative';

/** The world a page's one runtime belongs in: the mode's. */
export function worldFor(mode: ExtensionModeName): RuntimeWorld {
  return mode === 'full' ? 'user-script' : 'isolated';
}

export interface Arbitration {
  /** Which runtime leaves. */
  retire: 'incoming' | 'existing';
  /** Which runtime stays, and starts its shims afresh if the other had run any. */
  survivor: 'incoming' | 'existing';
}

/**
 * A runtime in `incoming` connects for a page that already has one in
 * `existing`, in `mode`. Null when they share a world (the same runtime
 * reconnecting, or a second copy in one world, which the runtime itself
 * folds into the first).
 */
export function arbitrate(existing: RuntimeWorld, incoming: RuntimeWorld, mode: ExtensionModeName): Arbitration | null {
  if (existing === incoming) return null;
  return worldFor(mode) === incoming
    ? { retire: 'existing', survivor: 'incoming' }
    : { retire: 'incoming', survivor: 'existing' };
}
