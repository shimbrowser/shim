// The session lease: while an authoring session holds a tab, no secret is
// sent for any shim on it, and once the session ends, the documents that
// existed while it held the tab stay refused until the tab loads a fresh
// one. So an agent can never drive an installed shim into spending a key,
// then or later, from a document it could touch.
//
// Taking a lease marks the tab held first, so every top-frame commit from
// then on is tainted, then names the document the tab has now, and persists
// all of it; only a lease that persisted lets the session's host attach. The
// refusal is by document: a document that is not on the tainted list and
// committed while no session held the tab is answered; any other is refused,
// and so is a request whose document Chrome did not name. Past TAINT_CAP
// documents a tab is refused outright until it closes.
//
// The state lives in chrome.storage.session (it lasts as long as the tabs do)
// and is mirrored in memory, where every check is synchronous: the broker
// checks it once before it starts and again with nothing awaited before it
// dispatches. A held lease is persisted as held before the host attaches, and
// only a successful release write clears that mark, so a write lost after it
// (a commit's taint, the release) can never let a document through: a worker
// that wakes to a lease still marked held answers only documents committed
// on that tab after it woke.

export const LEASE_KEY = 'credential.leases';
export const TAINT_CAP = 256;

interface TabLease {
  /** A session holds the tab now. */
  held: boolean;
  /** Top-frame documents that existed while a session held the tab. */
  tainted: string[];
  /** Past the cap, or a document Chrome could not name: every document on the tab is refused until it closes. */
  sealed: boolean;
  /**
   * Set when a worker woke to this lease still marked held: only documents
   * committed after the wake (listed here) are answered.
   */
  fresh?: string[];
}

export interface LeaseDeps {
  load(): Promise<unknown>;
  save(state: Record<string, TabLease>): Promise<void>;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string') : [];
}

function parse(v: unknown): Map<number, TabLease> {
  const out = new Map<number, TabLease>();
  if (typeof v !== 'object' || v === null) return out;
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const tabId = Number(k);
    if (!Number.isInteger(tabId) || typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const tainted = strings(r.tainted);
    // A lease left held: its session died with the last worker, and what it
    // touched may not all have been written. Only what commits from now on.
    const fresh = r.held === true ? [] : Array.isArray(r.fresh) ? strings(r.fresh) : undefined;
    out.set(tabId, { held: false, tainted, sealed: r.sealed === true || tainted.length > TAINT_CAP, ...(fresh ? { fresh } : {}) });
  }
  return out;
}

export class CredentialLeases {
  private tabs = new Map<number, TabLease>();
  /** The stored state could not be read: every tab refuses until the browser restarts. */
  private unknown = false;
  /** Nothing is answered before the stored state is read. */
  private loaded = false;
  readonly ready: Promise<void>;
  /** Writes in order; each answers its own outcome. */
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LeaseDeps) {
    this.ready = deps.load().then((v) => {
      // Anything recorded before the load finished wins over what was loaded.
      for (const [tabId, lease] of parse(v)) if (!this.tabs.has(tabId)) this.tabs.set(tabId, lease);
      this.loaded = true;
    }, () => {
      this.unknown = true;
      this.loaded = true;
    });
  }

  /** The whole state as it is now, written after every write before it. Rejects when this write fails. */
  private persist(): Promise<void> {
    const snapshot: Record<string, TabLease> = {};
    for (const [tabId, lease] of this.tabs) {
      snapshot[String(tabId)] = { ...lease, tainted: [...lease.tainted], ...(lease.fresh ? { fresh: [...lease.fresh] } : {}) };
    }
    const write = this.writes.catch(() => undefined).then(() => this.deps.save(snapshot));
    this.writes = write.catch(() => undefined);
    return write;
  }

  private taint(lease: TabLease, documentId: string | undefined): void {
    if (documentId === undefined) { lease.sealed = true; return; }
    if (lease.tainted.includes(documentId)) return;
    lease.tainted.push(documentId);
    if (lease.tainted.length > TAINT_CAP) lease.sealed = true;
  }

  /**
   * A session takes the tab. Held at once (a commit from here on is
   * tainted), then `current` names the tab's document now, then the lease is
   * persisted. Rejects when it could not be persisted: the caller must not
   * attach (and releases).
   */
  async hold(tabId: number, current: () => Promise<string | undefined>): Promise<void> {
    if (!this.loaded) await this.ready;
    const lease = this.tabs.get(tabId) ?? { held: false, tainted: [], sealed: false };
    lease.held = true;
    this.tabs.set(tabId, lease);
    let documentId: string | undefined;
    try {
      documentId = await current();
    } catch {
      documentId = undefined;
    }
    this.taint(lease, documentId);
    await this.persist();
  }

  /** The session let go of the tab: what it could touch stays tainted. The held mark clears durably only if this write succeeds. */
  async release(tabId: number): Promise<void> {
    await this.ready;
    const lease = this.tabs.get(tabId);
    if (!lease) return;
    lease.held = false;
    await this.persist().catch(() => undefined);
  }

  /** A top-frame document committed on the tab. */
  committed(tabId: number, documentId: string | undefined): void {
    const lease = this.tabs.get(tabId);
    if (!lease) return;
    if (lease.held) {
      this.taint(lease, documentId);
    } else if (lease.fresh && documentId !== undefined && !lease.tainted.includes(documentId) && !lease.fresh.includes(documentId)) {
      lease.fresh.push(documentId);
      if (lease.fresh.length > TAINT_CAP) lease.fresh.shift();
    } else {
      return;
    }
    // A lost write cannot open anything: the stored lease stays held (or fresh-only).
    void this.persist().catch(() => undefined);
  }

  /** The tab closed: its documents are gone with it. */
  closed(tabId: number): void {
    if (!this.tabs.delete(tabId)) return;
    void this.persist().catch(() => undefined);
  }

  /** Synchronous: may a secret be sent for a request from this document on this tab? */
  allows(tabId: number | undefined, documentId: string | undefined): boolean {
    if (!this.loaded || this.unknown || tabId === undefined || documentId === undefined) return false;
    const lease = this.tabs.get(tabId);
    if (!lease) return true;
    if (lease.held || lease.sealed || lease.tainted.includes(documentId)) return false;
    return lease.fresh ? lease.fresh.includes(documentId) : true;
  }
}
