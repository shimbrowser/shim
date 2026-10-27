// The attach-consent gate: every session an agent opens through the bridge
// waits here until the user answers on the extension's card (attach.html):
// allow once, allow this host until Chrome restarts, or deny. Unanswered for
// two minutes resolves deny. The browser's gate, minus compositions. Pure,
// with injectable timers, so a harness pins it.
//
//   - A request settles exactly once: allowed, denied, timed out, or
//     cancelled (the agent's request went away, the bridge turned off).
//   - "Allow this host until Chrome restarts" remembers the request's scope
//     (the host) in memory, and the worker mirrors it to session storage,
//     so a later request for the same host is allowed without a card.
//     reset() (the bridge turning off) drops every remembered scope.
//   - A session that opens its own tab at a URL carries `openUrl`: the card
//     always asks, even for a remembered host, and its answer is never
//     remembered.
//   - A remembered host never skips the site grant: the worker asks the gate
//     only once Chrome's permission for the host is in place; otherwise the
//     card is shown so its click can request the grant.
//   - Bounded: at most maxPending requests pend at once.

export const CONSENT_TIMEOUT_MS = 2 * 60_000;
export const MAX_PENDING_CONSENT = 4;

export type ConsentAnswer = 'allow-once' | 'allow-host' | 'deny';

export type ConsentOutcome =
  | { allowed: true; via: 'allow-once' | 'allow-host' | 'remembered' }
  | { allowed: false; reason: 'denied' | 'timeout' | 'cancelled' | 'too-many-pending' };

/** What the card shows: who is asking, for what, against which page. */
export interface ConsentSubject {
  agent: string;
  intent: string;
  /** The installed shim's id, or '' for a new one. */
  shimId: string;
  shimName: string;
  /** What "allow this host" remembers: the target page's hostname. */
  scope: string;
  /** The target tab. */
  tabId: number | null;
  url: string | null;
  title: string | null;
  /** The origin patterns the session needs granted and does not have yet; the card's allow requests them. */
  missingOrigins: string[];
  /** A session on a page no tab shows: the URL a new tab opens at once allowed. */
  openUrl?: string;
  openOrigin?: string;
}

export interface PendingConsent extends ConsentSubject {
  id: string;
  requestedAt: number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ConsentGate {
  request(subject: ConsentSubject, signal?: AbortSignal): Promise<ConsentOutcome>;
  /** The user's answer. False when the request is no longer pending. */
  answer(id: string, answer: ConsentAnswer): boolean;
  pending(): PendingConsent[];
  isRemembered(scope: string): boolean;
  /** Scopes remembered since boot, for the worker to mirror. */
  remembered(): string[];
  /** Seeds remembered scopes (the worker's mirror, at boot). */
  remember(scopes: readonly string[]): void;
  /** Cancels every pending request and forgets every remembered scope. */
  reset(): void;
  onChange(cb: (pending: PendingConsent[]) => void): () => void;
}

export interface ConsentGateOptions {
  timeoutMs?: number;
  maxPending?: number;
  timers?: Timers;
  now?(): number;
  newId?(): string;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Entry {
  info: PendingConsent;
  settle(outcome: ConsentOutcome): void;
}

function askedEachTime(subject: ConsentSubject): boolean {
  return subject.openUrl !== undefined;
}

export function createConsentGate(opts: ConsentGateOptions = {}): ConsentGate {
  const timers = opts.timers ?? realTimers;
  const timeoutMs = opts.timeoutMs ?? CONSENT_TIMEOUT_MS;
  const maxPending = opts.maxPending ?? MAX_PENDING_CONSENT;
  const now = opts.now ?? Date.now;
  let seq = 0;
  const newId = opts.newId ?? (() => `consent-${Date.now().toString(36)}-${(++seq).toString(36)}`);
  const pending = new Map<string, Entry>();
  const remembered = new Set<string>();
  const listeners = new Set<(p: PendingConsent[]) => void>();

  const list = (): PendingConsent[] => [...pending.values()].map((e) => ({ ...e.info }));
  const changed = (): void => {
    const snapshot = list();
    for (const cb of listeners) {
      try { cb(snapshot); } catch { /* a listener never breaks the gate */ }
    }
  };

  return {
    request(subject, signal) {
      if (!askedEachTime(subject) && subject.missingOrigins.length === 0 && remembered.has(subject.scope)) {
        return Promise.resolve({ allowed: true, via: 'remembered' });
      }
      if (signal?.aborted) return Promise.resolve({ allowed: false, reason: 'cancelled' });
      if (pending.size >= maxPending) return Promise.resolve({ allowed: false, reason: 'too-many-pending' });
      const id = newId();
      return new Promise<ConsentOutcome>((resolve) => {
        let timer: unknown = null;
        const onAbort = (): void => entry.settle({ allowed: false, reason: 'cancelled' });
        const entry: Entry = {
          info: { ...subject, id, requestedAt: now() },
          settle(outcome) {
            if (!pending.has(id)) return;
            pending.delete(id);
            if (timer !== null) timers.clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(outcome);
            changed();
          },
        };
        pending.set(id, entry);
        timer = timers.setTimeout(() => entry.settle({ allowed: false, reason: 'timeout' }), timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        changed();
      });
    },
    answer(id, answer) {
      const entry = pending.get(id);
      if (!entry) return false;
      if (answer === 'deny') {
        entry.settle({ allowed: false, reason: 'denied' });
        return true;
      }
      if (entry.info.openUrl !== undefined) {
        entry.settle({ allowed: true, via: 'allow-once' });
        return true;
      }
      entry.settle({ allowed: true, via: answer });
      if (answer === 'allow-host') {
        remembered.add(entry.info.scope);
        for (const other of [...pending.values()]) {
          if (other.info.scope === entry.info.scope && !askedEachTime(other.info) && other.info.missingOrigins.length === 0) {
            other.settle({ allowed: true, via: 'remembered' });
          }
        }
      }
      return true;
    },
    pending: list,
    isRemembered: (scope) => remembered.has(scope),
    remembered: () => [...remembered],
    remember(scopes) {
      for (const s of scopes) remembered.add(s);
    },
    reset() {
      remembered.clear();
      for (const entry of [...pending.values()]) entry.settle({ allowed: false, reason: 'cancelled' });
    },
    onChange(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}
