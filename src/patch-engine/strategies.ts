// Mount strategies: where a handler's output attaches to the DOM.
//
//   inline   — handler already appended it somewhere; we don't touch it.
//   portal   — move to a floating layer in document.body; position near the
//              anchor via getBoundingClientRect + scroll/resize sync.
//   overlay  — same as portal but sized to cover the anchor's rect.
//   shadow   — wrap in a shadow-hosted host element appended to the anchor;
//              framework sees an opaque <div>, site styles can't leak in.
//
// Strategies are applied after the handler returns, so existing handlers that
// appendChild into the anchor still work — the engine just re-parents when
// a non-inline strategy is declared on the mutation spec.

import type { Mutation } from './types';

let portalRoot: HTMLElement | null = null;
function ensurePortalRoot(): HTMLElement {
  if (portalRoot && document.contains(portalRoot)) return portalRoot;
  portalRoot = document.createElement('div');
  portalRoot.setAttribute('data-shim', 'portal-root');
  Object.assign(portalRoot.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    pointerEvents: 'none',
    zIndex: '2147483646',
  });
  (document.body || document.documentElement).appendChild(portalRoot);
  return portalRoot;
}

function applyFloatPositioning(nodes: HTMLElement[], anchor: HTMLElement, mutation: Mutation, strategy: string) {
  for (const n of nodes) {
    n.style.position = 'fixed';
    n.style.pointerEvents = 'auto';
  }
  const align = mutation.mount?.align || 'below';
  const reposition = () => {
    const rect = anchor.getBoundingClientRect();
    for (const n of nodes) {
      if (strategy === 'overlay') {
        n.style.top = `${rect.top}px`;
        n.style.left = `${rect.left}px`;
        n.style.width = `${rect.width}px`;
        n.style.height = `${rect.height}px`;
      } else {
        const height = n.offsetHeight || 0;
        const top = align === 'above' ? rect.top - height - 4 : rect.bottom + 4;
        n.style.top = `${top}px`;
        n.style.left = `${rect.left}px`;
      }
    }
  };

  let rafId: number | null = null;
  const schedule = () => {
    if (rafId != null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      reposition();
    });
  };

  reposition();
  const ro = new ResizeObserver(schedule);
  ro.observe(anchor);
  const onScroll = () => schedule();
  const onResize = () => schedule();
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', onResize, { passive: true });

  return () => {
    ro.disconnect();
    window.removeEventListener('scroll', onScroll, { capture: true });
    window.removeEventListener('resize', onResize);
    if (rafId != null) cancelAnimationFrame(rafId);
  };
}

function applyStrategy(nodes: HTMLElement[], anchor: HTMLElement, mutation: Mutation) {
  const strategy = mutation.mount?.strategy || 'inline';
  if (nodes.length === 0 || strategy === 'inline') {
    return { placed: nodes, cleanup: null };
  }
  if (strategy === 'portal' || strategy === 'overlay') {
    const root = ensurePortalRoot();
    for (const n of nodes) root.appendChild(n);
    const cleanup = applyFloatPositioning(nodes, anchor, mutation, strategy);
    return { placed: nodes, cleanup };
  }
  if (strategy === 'shadow') {
    const host = document.createElement('div');
    host.setAttribute('data-shim', 'shadow-host');
    const root = host.attachShadow({ mode: 'open' });
    for (const n of nodes) root.appendChild(n);
    anchor.appendChild(host);
    return { placed: [host], cleanup: null };
  }
  console.warn(`[shim] unknown mount strategy: ${strategy}`);
  return { placed: nodes, cleanup: null };
}

export { applyStrategy };
