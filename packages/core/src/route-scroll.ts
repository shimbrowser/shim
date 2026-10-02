// Pure scroll-position store for mount-route virtual routes (CLAUDE.md §6). The
// engine keeps one per page and supplies all DOM/history side effects (the
// scroll listener, window.scrollTo, history.replaceState); this module only
// owns key minting + the saved-position map, so it is bare-node testable. No
// dependencies, no globals — keys are an internal counter (deterministic, so
// the harness can assert exact values).
//
// A "key" identifies a history entry a route was mounted on. It lives in
// history.state under __shimScroll; resolveKey reads it or mints a fresh one,
// handing back the state object for the engine to replaceState (any fields the
// site already put on history.state are preserved).

export const SCROLL_STATE_FIELD = '__shimScroll';

export interface RouteScrollStore {
  resolveKey(state: unknown): { key: string; attach: { state: Record<string, unknown> } | null };
  record(key: string, scrollY: number): void;
  has(key: string): boolean;
  targetFor(key: string): number;
}

export function createRouteScrollStore(): RouteScrollStore {
  const saved = new Map<string, number>();
  let counter = 0;

  function asObject(state: unknown): Record<string, unknown> | null {
    return state && typeof state === 'object' ? (state as Record<string, unknown>) : null;
  }

  function resolveKey(state: unknown): { key: string; attach: { state: Record<string, unknown> } | null } {
    const obj = asObject(state);
    const existing = obj ? obj[SCROLL_STATE_FIELD] : undefined;
    if (typeof existing === 'string' && existing) {
      return { key: existing, attach: null };
    }
    const key = `s${counter++}`;
    return { key, attach: { state: { ...(obj ?? {}), [SCROLL_STATE_FIELD]: key } } };
  }

  function record(key: string, scrollY: number): void {
    saved.set(key, scrollY);
  }
  function has(key: string): boolean {
    return saved.has(key);
  }
  function targetFor(key: string): number {
    const v = saved.get(key);
    return typeof v === 'number' ? v : 0;
  }

  return { resolveKey, record, has, targetFor };
}
