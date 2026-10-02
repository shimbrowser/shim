// control/consent.ts — the attach-consent seam (design D6). Every session an
// agent opens through the control endpoint pends here until the human
// answers in Shim's UI: allow once, allow this host until quit, or deny.
// Unanswered for two minutes resolves deny.
//
// Pure and Electron-free. The card that answers a request lands with B3; it
// subscribes through `onChange` and answers through `answer()`, which is
// reachable only from main — never from the control endpoint or anything an
// agent can call (invariant 7: every consent decision is made in Shim's UI).
//
// Invariants:
//   - A request settles exactly once: allowed, denied, timed out, or
//     cancelled (the agent's request went away, or the endpoint stopped).
//   - "Allow this host until quit" remembers the request's scope in memory
//     only; a later request for the same scope is allowed without a card.
//     forgetAll() (the endpoint stopping) drops every remembered scope.
//   - Bounded: at most maxPending requests pend at once, so an agent can't
//     bury the human in cards; the rest answer 'too-many-pending'.
import type { Timers } from '../sessions/registry';

export const CONSENT_TIMEOUT_MS = 2 * 60_000;
export const MAX_PENDING_CONSENT = 4;

export type ConsentAnswer = 'allow-once' | 'allow-host' | 'deny';

export type ConsentOutcome =
  | { allowed: true; via: 'allow-once' | 'allow-host' | 'remembered' }
  | { allowed: false; reason: 'denied' | 'timeout' | 'cancelled' | 'too-many-pending' };

// What the card shows: who is asking, for what, against which page.
export interface ConsentSubject {
  agent: string;
  intent: string;
  kind: 'shim' | 'composition';
  artifactId: string;
  // The artifact's display name.
  artifactName: string;
  // What "allow this host" remembers: the target page's hostname for a shim,
  // the composition for a composition.
  scope: string;
  // The target page, when there is one.
  url: string | null;
  title: string | null;
}

export interface PendingConsent extends ConsentSubject {
  id: string;
  requestedAt: number;
}

export interface ConsentGate {
  request(subject: ConsentSubject, signal?: AbortSignal): Promise<ConsentOutcome>;
  // The human's answer. False when the request is no longer pending.
  answer(id: string, answer: ConsentAnswer): boolean;
  pending(): PendingConsent[];
  isRemembered(scope: string): boolean;
  // Cancels every pending request and forgets every remembered scope.
  reset(): void;
  // Told whenever the pending list changes. Returns an unsubscribe.
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

  function list(): PendingConsent[] {
    return [...pending.values()].map((e) => ({ ...e.info }));
  }

  function changed(): void {
    const snapshot = list();
    for (const cb of listeners) {
      try { cb(snapshot); } catch { /* a listener never breaks the gate */ }
    }
  }

  return {
    request(subject, signal) {
      if (remembered.has(subject.scope)) return Promise.resolve({ allowed: true, via: 'remembered' });
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
      entry.settle({ allowed: true, via: answer });
      if (answer === 'allow-host') {
        remembered.add(entry.info.scope);
        // Other requests already waiting on the same scope are covered too.
        for (const other of [...pending.values()]) {
          if (other.info.scope === entry.info.scope) other.settle({ allowed: true, via: 'remembered' });
        }
      }
      return true;
    },
    pending: list,
    isRemembered: (scope) => remembered.has(scope),
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
