// Handler-fetch budget — the engine-level backstop against a shim hammering
// its host site (CLAUDE.md §13; live-caught: a row-hydration handler fired
// ~100 `/tracks/status/:id` requests per mount, soundeo rate-limited the
// burst with 503s, and the failed hydrations killed the whole mount).
//
// A token bucket, pure and clock-injected so it's bare-node harnessable
// (scripts/fetch-budget-harness.js): a mount may burst up to `burst`
// same-site requests immediately; beyond that, requests queue FIFO at
// `refillPerSec`. The wrapper in page-preload DELAYS rather than rejects —
// handlers are already fragile against failed fetches (that fragility is
// what turned the 503s into a blank page), so the backstop must never
// introduce failures of its own, only pacing.
//
// This is deliberately per-frame, not per-shim: handler code calls the bare
// global `fetch`, so there is no call-site attribution — and the host
// server doesn't care which shim the burst came from either.

interface FetchBudgetOpts {
  burst?: number;
  refillPerSec?: number;
}

interface FetchBudgetTake {
  delayMs: number;
  throttled: boolean;
}

interface FetchBudget {
  take(nowMs: number): FetchBudgetTake;
  throttledCount(): number;
}

const DEFAULT_BURST = 30;
const DEFAULT_REFILL_PER_SEC = 5;

function createFetchBudget({ burst = DEFAULT_BURST, refillPerSec = DEFAULT_REFILL_PER_SEC }: FetchBudgetOpts = {}): FetchBudget {
  let tokens = burst;
  let lastRefillAt = 0;
  // FIFO tail for queued (throttled) requests — each throttled take reserves
  // the next refill slot after the previous one, so a burst of 100 spreads
  // into an orderly refillPerSec stream instead of a thundering retry herd.
  let queueTailAt = 0;
  let throttled = 0;

  return {
    take(nowMs: number): FetchBudgetTake {
      if (lastRefillAt === 0) lastRefillAt = nowMs;
      tokens = Math.min(burst, tokens + ((nowMs - lastRefillAt) / 1000) * refillPerSec);
      lastRefillAt = nowMs;
      if (tokens >= 1 && queueTailAt <= nowMs) {
        tokens -= 1;
        return { delayMs: 0, throttled: false };
      }
      const intervalMs = 1000 / refillPerSec;
      queueTailAt = Math.max(queueTailAt, nowMs) + intervalMs;
      // Queued slots consume the refill stream — drain the fractional token
      // pool so a long queue doesn't double-spend (queue AND bucket both
      // fed by the same refill would briefly exceed refillPerSec).
      tokens = 0;
      throttled += 1;
      return { delayMs: queueTailAt - nowMs, throttled: true };
    },
    throttledCount() {
      return throttled;
    },
  };
}

export { createFetchBudget, DEFAULT_BURST, DEFAULT_REFILL_PER_SEC };
export type { FetchBudget, FetchBudgetOpts, FetchBudgetTake };
