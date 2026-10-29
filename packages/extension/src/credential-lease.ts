// The session lease: while an authoring session holds a
// tab, no secret is sent for any shim on it, and once the session ends, the
// documents that existed while it held the tab stay refused until the tab
// loads a fresh one. So an agent can never drive an installed shim into
// spending a key, then or later, from a document it could touch.
//
// A lease is taken (and persisted) before the session's host attaches, and
// records every top-frame document the tab had or committed while it was
// held. The refusal is by document: a document that is not on the tainted
// list and committed while no session held the tab is answered; any other is
// refused, and so is a request whose document Chrome did not name. Past
// TAINT_CAP documents a tab is refused outright until it closes (fail closed).
//
// The state lives in chrome.storage.session (it lasts as long as the tabs do)
// and is mirrored in memory, where every check is synchronous: the broker
// checks it once before it starts and again with nothing awaited before it
// dispatches. A worker that wakes to a lease still marked held (its session
// died with the last worker) keeps it as tainted, never as released clean.

export const LEASE_KEY = 'credential.leases';
export const TAINT_CAP = 256;

interface TabLease {
  /** A session holds the tab now. */
  held: boolean;
  /** Top-frame documents that existed while a session held the tab. */
  tainted: string[];
  /** Past the cap: every document on the tab is refused until it closes. */
  sealed: boolean;
}

export interface LeaseDeps {
  load(): Promise<unknown>;
  save(state: Record<string, TabLease>): Promise<void>;
}

function parse(v: unknown): Map<number, TabLease> {
  const out = new Map<number, TabLease>();
  if (typeof v !== 'object' || v === null) return out;
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const tabId = Number(k);
    if (!Number.isInteger(tabId) || typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const tainted = Array.isArray(r.tainted) ? r.tainted.filter((d): d is string => typeof d === 'string') : [];
    // A lease the last worker left held is a session that died with it: still tainted.
    out.set(tabId, { held: false, tainted, sealed: r.sealed === true || tainted.length > TAINT_CAP });
  }
  return out;
}

export class CredentialLeases {
  private tabs = new Map<number, TabLease>();
  /** Moves on every change, so a broker that read before an await can tell. */
  private epoch = 0;
  readonly ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LeaseDeps) {
    this.ready = deps.load().then((v) => {
      // Anything recorded before the load finished wins over what was loaded.
      for (const [tabId, lease] of parse(v)) if (!this.tabs.has(tabId)) this.tabs.set(tabId, lease);
      this.loaded = true;
    }, () => {
      // Unreadable: nothing is known about which documents a session touched.
      this.unknown = true;
    });
  }

  /** The stored state could not be read: every tab refuses until the browser restarts. */
  private unknown = false;
  /** Nothing is answered before the stored state is read. */
  private loaded = false;

  currentEpoch(): number {
    return this.epoch;
  }

  private persist(): Promise<void> {
    const snapshot: Record<string, TabLease> = {};
    for (const [tabId, lease] of this.tabs) snapshot[String(tabId)] = { ...lease, tainted: [...lease.tainted] };
    this.writes = this.writes.then(() => this.deps.save(snapshot)).catch(() => undefined);
    return this.writes;
  }

  private taint(lease: TabLease, documentId: string | undefined): void {
    if (documentId === undefined || lease.tainted.includes(documentId)) return;
    lease.tainted.push(documentId);
    if (lease.tainted.length > TAINT_CAP) lease.sealed = true;
  }

  /**
   * A session takes the tab; `documentId` is its top frame's document now.
   * Resolves once the lease is persisted, so the caller attaches after.
   */
  async hold(tabId: number, documentId: string | undefined): Promise<void> {
    await this.ready;
    const lease = this.tabs.get(tabId) ?? { held: false, tainted: [], sealed: false };
    lease.held = true;
    // A tab whose document Chrome cannot name is refused for good.
    if (documentId === undefined) lease.sealed = true;
    this.taint(lease, documentId);
    this.tabs.set(tabId, lease);
    this.epoch++;
    await this.persist();
  }

  /** The session let go of the tab: what it could touch stays tainted. */
  async release(tabId: number): Promise<void> {
    await this.ready;
    const lease = this.tabs.get(tabId);
    if (!lease) return;
    lease.held = false;
    this.epoch++;
    await this.persist();
  }

  /** A top-frame document committed on the tab: tainted while a session holds it. */
  committed(tabId: number, documentId: string | undefined): void {
    const lease = this.tabs.get(tabId);
    if (!lease?.held) return;
    if (documentId === undefined) lease.sealed = true;
    this.taint(lease, documentId);
    this.epoch++;
    void this.persist();
  }

  /** The tab closed: its documents are gone with it. */
  closed(tabId: number): void {
    if (!this.tabs.delete(tabId)) return;
    this.epoch++;
    void this.persist();
  }

  /** Synchronous: may a secret be sent for a request from this document on this tab? */
  allows(tabId: number | undefined, documentId: string | undefined): boolean {
    if (!this.loaded || this.unknown || tabId === undefined || documentId === undefined) return false;
    const lease = this.tabs.get(tabId);
    if (!lease) return true;
    return !lease.held && !lease.sealed && !lease.tainted.includes(documentId);
  }
}
