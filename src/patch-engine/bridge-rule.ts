// A rule whose anchor declares `iframe: { kind: 'css', value }` targets elements
// inside a child iframe instead of this frame. Resolve the iframe(s) locally,
// derive each one's origin from its `src`, then ask main to deliver the rule
// (with the iframe field stripped) to every frame of that origin. The iframe's
// own engine receives it via bridge:rule and applies it locally.
//
// Returns a teardown fn that disconnects the observer and cancels any pending
// rAF. Forwarded rules already applied in child frames aren't recalled —
// teardown-by-source is a separate bridge concern not wired yet.

import type { Rule, Spec, Anchor } from './types';
import type { ShimApiBase } from '../preload/shim-api-types';

export function bridgeRule(rule: Rule, spec: Spec, api: ShimApiBase): () => void {
  if (!api.bridge?.forwardRule) {
    console.warn('[shim] anchor.iframe set but api.bridge unavailable');
    return () => {};
  }
  const sel = rule.anchor?.iframe;
  if (sel?.kind !== 'css') {
    console.warn('[shim] anchor.iframe currently only supports kind:"css"');
    return () => {};
  }

  // `sel` is only ever derived from `rule.anchor?.iframe`, so having reached
  // here (past the `sel?.kind !== 'css'` check) means `rule.anchor` itself is
  // necessarily defined too.
  const anchor = rule.anchor as Anchor;
  const innerRule = { ...rule, anchor: { ...anchor } };
  delete innerRule.anchor.iframe;

  // iframe element → last origin we forwarded to. When an iframe navigates
  // cross-origin (src changes) we re-forward to the new origin.
  const forwardedTo = new Map<Element, string>();

  const scan = () => {
    for (const el of forwardedTo.keys()) {
      if (!document.contains(el)) forwardedTo.delete(el);
    }
    for (const el of document.querySelectorAll(sel.value)) {
      const src = el.getAttribute('src');
      if (!src) continue;
      let origin: string;
      try {
        origin = new URL(src, location.href).origin;
      } catch {
        continue;
      }
      if (forwardedTo.get(el) === origin) continue;
      forwardedTo.set(el, origin);
      api.bridge.forwardRule(origin, innerRule, spec.id);
    }
  };

  let scanHandle = 0;
  const scheduleScan = () => {
    if (scanHandle) return;
    scanHandle = requestAnimationFrame(() => {
      scanHandle = 0;
      scan();
    });
  };

  scan();
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  return function teardownBridgeRule() {
    observer.disconnect();
    if (scanHandle) {
      cancelAnimationFrame(scanHandle);
      scanHandle = 0;
    }
  };
}
