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

function normalizeOutputs(r) {
  if (!r) return [];
  if (Array.isArray(r)) return r.filter(Boolean);
  return [r];
}

// Invokes one mutation against the anchor and returns a Promise<Node[]> of the
// nodes the handler produced. Handlers enable self-healing by returning the
// root node(s) they mounted; handlers that return nothing opt out (we never
// re-mount them, matching the pre-self-healing behavior).
function dispatchMutation(el, mut, rule, spec, api, mutations, handlers) {
  const safe = (label, work) => {
    try {
      return Promise.resolve(work()).then(normalizeOutputs, (err) => {
        console.error(`[shim] ${label} failed`, err);
        return [];
      });
    } catch (err) {
      console.error(`[shim] ${label} failed`, err);
      return Promise.resolve([]);
    }
  };

  if (mut.kind === 'script') {
    const fn = handlers[mut.handler];
    if (!fn) {
      console.warn(`[shim] script: unknown handler "${mut.handler}"`);
      return Promise.resolve([]);
    }
    return safe(`script handler "${mut.handler}"`, () =>
      fn({ anchor: el, mutation: mut, rule, spec, api }),
    );
  }
  const handler = mutations[mut.kind];
  if (!handler) {
    console.warn(`[shim] unknown mutation kind: ${mut.kind}`);
    return Promise.resolve([]);
  }
  return safe(`mount ${rule.id}/${mut.kind}`, () =>
    handler.mount(el, mut, rule, spec, api),
  );
}

function applyRule(rule, spec, api, mutations, handlers) {
  const mountedOutputs = new WeakMap(); // anchor -> Node[]
  const inFlight = new WeakSet();

  async function mountOn(el) {
    const outputs = [];
    for (const mut of rule.mutations || []) {
      const out = await dispatchMutation(el, mut, rule, spec, api, mutations, handlers);
      outputs.push(...out);
    }
    mountedOutputs.set(el, outputs);
  }

  const scan = () => {
    for (const el of anchors.resolveAll(rule.anchor)) {
      if (inFlight.has(el)) continue;
      const existing = mountedOutputs.get(el);
      if (existing !== undefined) {
        // Opted out of self-healing (no outputs returned) — never re-mount.
        if (existing.length === 0) continue;
        // All outputs still attached — mounted state is healthy.
        if (existing.every((n) => document.contains(n))) continue;
        // Something got stomped: drop the record and fall through to re-mount.
        mountedOutputs.delete(el);
      }
      inFlight.add(el);
      mountOn(el).finally(() => inFlight.delete(el));
    }
  };

  scan();
  new MutationObserver(scan).observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function run(patch, api) {
  const { spec, mutations = {}, handlers = {} } = patch;

  for (const { id, css } of collectCssForSpec(spec, mutations)) {
    const inject = () => injectStyle(id, css);
    if (document.head) inject();
    else document.addEventListener('DOMContentLoaded', inject, { once: true });
  }

  api.onReady(() => {
    for (const rule of spec.rules || []) {
      applyRule(rule, spec, api, mutations, handlers);
    }
  });
}

module.exports = { run };
