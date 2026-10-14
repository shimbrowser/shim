// Pure classifier for a mount-route path change (CLAUDE.md §6 nested
// sub-routes). The engine's evaluate() reconciles mounted-state against the
// current path by asking this what to do; extracted from the closure so it is
// bare-node testable (routeRule itself needs a DOM). No dependencies, no
// side effects.
//
//   prevPath  — the mounted route's path, or null when nothing is mounted
//   nextPath  — normalized location.pathname
//   matches   — does nextPath still match the route pattern?
//   canUpdate — has the handler registered ≥1 onRouteChange callback?
//
// 'mount' on an ALREADY-mounted route means remount (the caller unmounts
// first) — kept as one value so the engine's existing two mount calls don't
// multiply. 'update' is the in-place inner-nav path; it only ever fires when
// the handler opted in (canUpdate), so a shim that never registers a callback
// gets exactly today's remount behavior.

export type RouteTransition = 'mount' | 'unmount' | 'update' | 'noop';

export function routeTransition(
  prevPath: string | null,
  nextPath: string,
  matches: boolean,
  canUpdate: boolean,
): RouteTransition {
  const mounted = prevPath !== null;
  if (matches && !mounted) return 'mount';
  if (!matches && mounted) return 'unmount';
  if (matches && mounted) {
    if (prevPath === nextPath) return 'noop';   // redundant re-eval (e.g. a popstate to the same path)
    return canUpdate ? 'update' : 'mount';      // 'mount' = remount; caller unmounts first
  }
  return 'noop';                                 // !matches && !mounted
}
