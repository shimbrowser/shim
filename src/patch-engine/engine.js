const anchors = require('./anchors');

function injectStyle(id, css) {
  if (!css || document.querySelector(`style[data-shim="${id}"]`)) return;
  const style = document.createElement('style');
  style.setAttribute('data-shim', id);
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
}

function collectMutationKinds(spec, mutations) {
  const direct = new Set();
  for (const rule of spec.rules || []) {
    for (const mut of rule.mutations || []) direct.add(mut.kind);
  }
  const resolved = new Set();
  const walk = (kind) => {
    if (resolved.has(kind)) return;
    resolved.add(kind);
    const handler = mutations[kind];
    if (handler?.deps) for (const d of handler.deps) walk(d);
  };
  for (const k of direct) walk(k);
  return resolved;
}

function collectCssForSpec(spec, mutations) {
  const chunks = [];
  for (const kind of collectMutationKinds(spec, mutations)) {
    const handler = mutations[kind];
    if (handler?.css) chunks.push({ id: `mutation-${kind}`, css: handler.css });
  }
  if (spec.css) chunks.push({ id: `patch-${spec.id}`, css: spec.css });
  return chunks;
}

const mounted = new Map();

function isMounted(ruleId, el) {
  return mounted.get(ruleId)?.has(el) ?? false;
}

function markMounted(ruleId, el) {
  if (!mounted.has(ruleId)) mounted.set(ruleId, new WeakSet());
  mounted.get(ruleId).add(el);
}

function applyRule(rule, spec, api, mutations) {
  const scan = () => {
    const matches = anchors.resolveAll(rule.anchor);
    for (const el of matches) {
      if (isMounted(rule.id, el)) continue;
      markMounted(rule.id, el);
      for (const mut of rule.mutations || []) {
        const handler = mutations[mut.kind];
        if (!handler) {
          console.warn(`[shim] unknown mutation kind: ${mut.kind}`);
          continue;
        }
        try {
          handler.mount(el, mut, rule, spec, api);
        } catch (err) {
          console.error(`[shim] mount failed for ${rule.id}/${mut.kind}`, err);
        }
      }
    }
  };
  scan();
  new MutationObserver(scan).observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function run(spec, api, mutations) {
  for (const { id, css } of collectCssForSpec(spec, mutations)) {
    const inject = () => injectStyle(id, css);
    if (document.head) inject();
    else document.addEventListener('DOMContentLoaded', inject, { once: true });
  }

  api.onReady(() => {
    for (const rule of spec.rules || []) {
      applyRule(rule, spec, api, mutations);
    }
  });
}

module.exports = { run };
