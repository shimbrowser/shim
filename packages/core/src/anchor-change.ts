// api.onAnchorChange — the engine-owned "your anchor's subtree changed" hook.
//
// A `script` / `replace-root` handler runs once per matched anchor. Sites keep
// changing what is INSIDE a mounted anchor (a virtualized feed unit renders its
// content late, tablesorter re-orders rows, a result list re-renders), and
// handlers used to notice with their own MutationObserver — the loop-prone
// pattern spec-lint warns about. This hub derives the signal from the rule's
// existing childList observer instead: no new observer, nothing at all for a
// rule with no registrations.
//
// Guarantees:
// - Registrations belong to a mount RECORD, never to the anchor. A record in
//   flight (its handler still awaiting) collects changes but delivers nothing
//   until it lands; a killed record is removed from every collection and pins
//   no anchor or closure.
// - Delivery runs in the rule's frame, after its scan, once per record per
//   frame, and only to records the caller judges eligible (connected, still the
//   anchor's current mount, verified by the set witness).
// - Mutations a rule's hooks make synchronously are never delivered back to
//   that rule's hooks (the caller's observer is drained right after the batch
//   and those records discarded). Records inside DOM already registered as
//   shim-owned are never attributed.
// - Frequency controls (not freeze prevention): a per-record token bucket, and
//   per-record serialization of async hooks.
//
// Pure and dependency-free: DOM access comes in through `HubDeps`, so the
// bare-node harness drives it with duck-typed nodes and a fake clock.

export const BUCKET_BURST = 10;
export const BUCKET_REFILL_PER_SEC = 4;

export interface TokenBucket {
  // Spends one token if one is available at `now` (ms).
  take(now: number): boolean;
  // When the next token is available (ms) — `now` if one is available already.
  nextAt(now: number): number;
}

export function makeTokenBucket(burst: number = BUCKET_BURST, perSec: number = BUCKET_REFILL_PER_SEC): TokenBucket {
  let tokens = burst;
  let last: number | null = null;
  const refill = (now: number): void => {
    if (last !== null && now > last) tokens = Math.min(burst, tokens + ((now - last) * perSec) / 1000);
    last = now;
  };
  return {
    take(now) {
      refill(now);
      if (tokens >= 1) { tokens -= 1; return true; }
      return false;
    },
    nextAt(now) {
      refill(now);
      return tokens >= 1 ? now : now + Math.ceil(((1 - tokens) * 1000) / perSec);
    },
  };
}

// The subset of a MutationRecord attribution reads.
export interface ChangeRecordLike<N> {
  target: N;
  addedNodes: ArrayLike<N>;
  removedNodes: ArrayLike<N>;
}

export interface Hook {
  fn: () => unknown;
  handlerName: string;
}

export interface MountRecord<N> {
  readonly anchor: N;
  hooks: Hook[];
  alive: boolean;
  landed: boolean;
  dirty: boolean;
  busy: boolean;
  bucket: TokenBucket;
  throttled: boolean;
}

export interface HubDeps<N> {
  // The parent to continue the attribution walk with (null at the top).
  parentOf(node: N): N | null;
  // O(1): is `node` itself shim-owned DOM (a registered output root, or one of
  // the engine's own-DOM markers)? Ancestry is the walk's job.
  isOwnedNode(node: N): boolean;
  now(): number;
  // Arms a one-shot timer; returns its cancel function.
  setTimer(run: () => void, ms: number): () => void;
  // Ask the rule for its next frame (scan, then deliver).
  requestFrame(): void;
  reportError(err: unknown, handlerName: string): void;
  // A record's bucket ran dry for the first time.
  onThrottle(): void;
}

export interface AnchorChangeHub<N> {
  createRecord(anchor: N): MountRecord<N>;
  register(record: MountRecord<N>, fn: unknown, handlerName: string): () => void;
  land(record: MountRecord<N>): void;
  kill(record: MountRecord<N>): void;
  // True while any live record has ≥1 registration — a rule with none skips
  // attribution entirely.
  hasHooks(): boolean;
  // Attribute observer records to hooked records; requests a frame when any
  // record turned dirty.
  attribute(records: ArrayLike<ChangeRecordLike<N>>): void;
  // Deliver to dirty records. `drain` takes the rule observer's pending
  // records (synchronously); called once before the batch (attributed) and once
  // right after it (discarded — the batch's own synchronous writes).
  deliver(isEligible: (record: MountRecord<N>) => boolean, drain: () => ArrayLike<ChangeRecordLike<N>>): void;
  teardown(): void;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

export function makeAnchorChangeHub<N>(deps: HubDeps<N>): AnchorChangeHub<N> {
  // Every live record of this rule instance.
  const records = new Set<MountRecord<N>>();
  // anchor -> its current hooked record (registered at least once).
  const index = new Map<N, MountRecord<N>>();
  const dirty = new Set<MountRecord<N>>();
  let hookCount = 0;
  let tornDown = false;
  let cancelTimer: (() => void) | null = null;
  let timerAt = Infinity;

  const armTimer = (at: number): void => {
    if (tornDown || at >= timerAt) return;
    if (cancelTimer) cancelTimer();
    timerAt = at;
    cancelTimer = deps.setTimer(() => {
      cancelTimer = null;
      timerAt = Infinity;
      if (!tornDown) deps.requestFrame();
    }, Math.max(0, at - deps.now()));
  };

  const markDirty = (record: MountRecord<N>): boolean => {
    if (!record.alive) return false;
    record.dirty = true;
    dirty.add(record);
    return true;
  };

  const attribute = (list: ArrayLike<ChangeRecordLike<N>>): boolean => {
    if (tornDown || hookCount === 0) return false;
    let any = false;
    const seenTargets = new Set<N>();
    const allOwned = (nodes: ArrayLike<N>): boolean => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n === undefined || !deps.isOwnedNode(n)) return false;
      }
      return true;
    };
    for (let i = 0; i < list.length; i++) {
      const rec = list[i];
      if (!rec) continue;
      const added = rec.addedNodes.length;
      const removed = rec.removedNodes.length;
      if (added + removed > 0 && allOwned(rec.addedNodes) && allOwned(rec.removedNodes)) continue;
      if (seenTargets.has(rec.target)) continue;
      seenTargets.add(rec.target);
      // One walk to the top: collect hooked records, abandon the record the
      // moment an owned ancestor shows up (it changed inside shim DOM).
      const hits: Array<MountRecord<N>> = [];
      let owned = false;
      for (let node: N | null = rec.target; node !== null; node = deps.parentOf(node)) {
        if (deps.isOwnedNode(node)) { owned = true; break; }
        const hit = index.get(node);
        if (hit) hits.push(hit);
      }
      if (owned) continue;
      for (const hit of hits) if (markDirty(hit)) any = true;
    }
    return any;
  };

  const kill = (record: MountRecord<N>): void => {
    if (!record.alive) return;
    record.alive = false;
    records.delete(record);
    dirty.delete(record);
    if (index.get(record.anchor) === record) index.delete(record.anchor);
    hookCount -= record.hooks.length;
    record.hooks = [];
  };

  return {
    createRecord(anchor) {
      const record: MountRecord<N> = {
        anchor, hooks: [], alive: !tornDown, landed: false, dirty: false, busy: false,
        bucket: makeTokenBucket(), throttled: false,
      };
      if (record.alive) records.add(record);
      return record;
    },
    register(record, fn, handlerName) {
      if (!record.alive || typeof fn !== 'function') return () => {};
      const hook: Hook = { fn: fn as () => unknown, handlerName };
      record.hooks.push(hook);
      hookCount += 1;
      // The newest mount of an anchor owns its index slot.
      index.set(record.anchor, record);
      return () => {
        if (!record.alive) return;
        const at = record.hooks.indexOf(hook);
        if (at === -1) return;
        record.hooks.splice(at, 1);
        hookCount -= 1;
      };
    },
    land(record) {
      if (!record.alive) return;
      record.landed = true;
      if (record.dirty) deps.requestFrame();
    },
    kill,
    hasHooks: () => hookCount > 0 && !tornDown,
    attribute(list) {
      if (attribute(list)) deps.requestFrame();
    },
    deliver(isEligible, drain) {
      if (tornDown || hookCount === 0) return;
      attribute(drain());
      if (dirty.size === 0) return;
      let ran = false;
      for (const record of Array.from(dirty)) {
        if (tornDown) return;
        if (!record.alive || !record.landed || record.busy || record.hooks.length === 0) continue;
        if (!isEligible(record)) continue;
        const now = deps.now();
        if (!record.bucket.take(now)) {
          if (!record.throttled) { record.throttled = true; deps.onThrottle(); }
          armTimer(record.bucket.nextAt(now));
          continue;
        }
        record.dirty = false;
        dirty.delete(record);
        ran = true;
        const pending: Array<PromiseLike<unknown>> = [];
        for (const hook of record.hooks.slice()) {
          // An earlier hook can detach the anchor, tear the rule down, or
          // unsubscribe this one.
          if (tornDown || !record.alive || !isEligible(record)) break;
          if (!record.hooks.includes(hook)) continue;
          try {
            const out = hook.fn();
            if (isThenable(out)) {
              pending.push(Promise.resolve(out).then(undefined, (err: unknown) => {
                if (record.alive) deps.reportError(err, hook.handlerName);
              }));
            }
          } catch (err) {
            deps.reportError(err, hook.handlerName);
          }
        }
        if (pending.length > 0 && record.alive) {
          record.busy = true;
          void Promise.all(pending).then(() => {
            record.busy = false;
            if (!tornDown && record.alive && record.dirty) deps.requestFrame();
          });
        }
      }
      // The batch's own synchronous writes: never delivered back to these
      // hooks — but the rule still scans once more, so self-healing sees a
      // hook that removed the rule's own output.
      if (ran && drain().length > 0 && !tornDown) deps.requestFrame();
    },
    teardown() {
      tornDown = true;
      for (const record of Array.from(records)) kill(record);
      index.clear();
      dirty.clear();
      hookCount = 0;
      if (cancelTimer) { cancelTimer(); cancelTimer = null; }
      timerAt = Infinity;
    },
  };
}
