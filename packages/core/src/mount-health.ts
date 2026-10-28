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
// unconnected once the handler settles, with no sign they were ever on the page
// while it ran (the insertion log below), are recorded at mount as `unattached`
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

// --- insertion evidence -----------------------------------------------------
//
// One log per rule, shared by every mount of it in flight: a single childList
// observer on the document runs while at least one mount's handlers are
// running (refcounted), and each node it sees added or removed is stamped with
// a sequence number. A mount remembers the sequence at its start; at settle a
// returned root off the page counts as inserted when it, or any ancestor it
// still has, was seen after that start (a root the site removed is inside the
// removed node, or is it). One observer and one record per page change
// however many anchors mount at once, so a 1,000-row rule costs what one does.
// Past `cap` distinct nodes the log gives up until no mount is in flight:
// nothing is judged never-inserted meanwhile (the old behavior).

export interface InsertionLogDeps<N> {
  cap: number;
  parentOf(node: N): N | null;
  /** Start observing; `flush` returns what it saw since the last call. */
  connect(): void;
  disconnect(): void;
  flush(): N[];
}

export interface InsertionLog<N> {
  /** A mount's handlers start: returns its start mark. */
  begin(): number;
  /** Nodes the observer delivered. */
  record(nodes: Iterable<N>): void;
  /** Returned roots never on the page since `start` (empty once the log gave up). */
  unattached<T extends N & OutputRoot>(roots: readonly T[], start: number): Set<T>;
  /** A mount's handlers are done (idempotent per mount is the caller's job). */
  end(): void;
  /** The rule tears down: stop observing and drop every node held. */
  stop(): void;
  /** Mounts in flight, and nodes held (for the harness). */
  readonly active: number;
  readonly held: number;
}

export function makeInsertionLog<N>(deps: InsertionLogDeps<N>): InsertionLog<N> {
  let active = 0;
  let seq = 0;
  let overflow = false;
  let stopped = false;
  const seen = new Map<N, number>();
  const record = (nodes: Iterable<N>): void => {
    if (overflow || stopped || active === 0) return;
    for (const n of nodes) {
      seq += 1;
      seen.set(n, seq);
    }
    if (seen.size > deps.cap) { overflow = true; seen.clear(); deps.disconnect(); }
  };
  return {
    begin() {
      if (!stopped && active === 0) { seen.clear(); overflow = false; deps.connect(); }
      active += 1;
      return seq;
    },
    record,
    unattached<T extends N & OutputRoot>(roots: readonly T[], start: number): Set<T> {
      const out = new Set<T>();
      if (!overflow && !stopped) record(deps.flush());
      if (overflow) return out;
      for (const root of roots) {
        if (root.isConnected) continue;
        let inserted = false;
        for (let n: N | null = root; n; n = deps.parentOf(n)) {
          const at = seen.get(n);
          if (at !== undefined && at > start) { inserted = true; break; }
        }
        if (!inserted) out.add(root);
      }
      return out;
    },
    end() {
      if (active === 0) return;
      active -= 1;
      if (active === 0) { if (!stopped && !overflow) deps.disconnect(); seen.clear(); }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (active > 0 && !overflow) deps.disconnect();
      seen.clear();
    },
    get active() { return active; },
    get held() { return seen.size; },
  };
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
