const anchors = require('./anchors');
const { applyStrategy } = require('./strategies');

function injectStyle(id, css) {
  if (!css || document.querySelector(`style[data-shim="${id}"]`)) return;
  const style = document.createElement('style');
  style.setAttribute('data-shim', id);
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
}

// Tier-1 CSS built-ins (`hide`, `restyle`) target elements via a shared
// `data-shim-css` attribute. Each rule owns a CSS fragment keyed by a token
// (e.g. `shim-<patchId>-<ruleId>-<kind>`); the engine stamps that token onto
// the resolved anchor and appends the fragment to a shared <style> tag. React
// (and other reconcilers) don't touch data-* attributes they didn't declare,
// so styling survives re-renders without needing self-healing.
const tier1RulesInjected = new Set();
function ensureTier1Sheet() {
  let sheet = document.querySelector('style[data-shim="tier1-css"]');
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.setAttribute('data-shim', 'tier1-css');
    (document.head || document.documentElement).appendChild(sheet);
  }
  return sheet;
}
function injectTier1Rule(token, cssBody) {
  if (tier1RulesInjected.has(token)) return;
  tier1RulesInjected.add(token);
  ensureTier1Sheet().appendChild(
    document.createTextNode(`[data-shim-css~="${token}"] { ${cssBody} }\n`),
  );
}
function tagElement(el, token) {
  const current = el.getAttribute('data-shim-css') || '';
  const tokens = current.split(/\s+/).filter(Boolean);
  if (tokens.includes(token)) return;
  tokens.push(token);
  el.setAttribute('data-shim-css', tokens.join(' '));
}
const toKebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
function cssBodyFromProps(props) {
  return Object.entries(props || {})
    .map(([k, v]) => `${toKebab(k)}: ${v} !important;`)
    .join(' ');
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

  if (mut.kind === 'hide') {
    const token = `shim-${spec.id}-${rule.id}-hide`;
    injectTier1Rule(token, 'display: none !important;');
    tagElement(el, token);
    return Promise.resolve([]);
  }

  if (mut.kind === 'restyle') {
    const body = cssBodyFromProps(mut.properties);
    if (!body) return Promise.resolve([]);
    const token = `shim-${spec.id}-${rule.id}-restyle`;
    injectTier1Rule(token, body);
    tagElement(el, token);
    return Promise.resolve([]);
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
  // anchor -> { outputs: Node[], cleanups: Function[] }
  // Map (not WeakMap) so we can iterate and prune anchors that left the DOM,
  // tearing down their portal/overlay listeners and removing nodes we parked
  // in document.body.
  const state = new Map();
  const inFlight = new WeakSet();

  async function mountOn(el) {
    const outputs = [];
    const cleanups = [];
    for (const mut of rule.mutations || []) {
      const raw = await dispatchMutation(el, mut, rule, spec, api, mutations, handlers);
      const { placed, cleanup } = applyStrategy(raw, el, mut);
      outputs.push(...placed);
      if (cleanup) cleanups.push(cleanup);
    }
    state.set(el, { outputs, cleanups });
  }

  function teardown(entry) {
    for (const fn of entry.cleanups) {
      try { fn(); } catch (err) { console.error('[shim] cleanup failed', err); }
    }
    for (const node of entry.outputs) node.remove();
  }

  const scan = () => {
    // Prune anchors that are no longer in the DOM. Without this, portal-mounted
    // widgets (which live in document.body, unrelated to the anchor's parent)
    // would leak when the anchor unmounts.
    for (const [anchor, entry] of state) {
      if (!document.contains(anchor)) {
        teardown(entry);
        state.delete(anchor);
      }
    }

    for (const el of anchors.resolveAll(rule.anchor)) {
      if (inFlight.has(el)) continue;
      const existing = state.get(el);
      if (existing) {
        // Opted out of self-healing (no outputs returned) — never re-mount.
        if (existing.outputs.length === 0) continue;
        // All outputs still attached — mounted state is healthy.
        if (existing.outputs.every((n) => document.contains(n))) continue;
        // Something got stomped: tear down and re-mount.
        teardown(existing);
        state.delete(el);
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

// A rule whose anchor declares `iframe: { kind: 'css', value }` targets elements
// inside a child iframe instead of this frame. Resolve the iframe(s) locally,
// derive each one's origin from its `src`, then ask main to deliver the rule
// (with the iframe field stripped) to every frame of that origin. The iframe's
// own engine receives it via bridge:rule and applies it locally.
function bridgeRule(rule, spec, api) {
  if (!api.bridge?.forwardRule) {
    console.warn('[shim] anchor.iframe set but api.bridge unavailable');
    return;
  }
  const sel = rule.anchor?.iframe;
  if (sel?.kind !== 'css') {
    console.warn('[shim] anchor.iframe currently only supports kind:"css"');
    return;
  }

  const innerRule = { ...rule, anchor: { ...rule.anchor } };
  delete innerRule.anchor.iframe;

  // iframe element → last origin we forwarded to. When an iframe navigates
  // cross-origin (src changes) we re-forward to the new origin.
  const forwardedTo = new Map();

  const scan = () => {
    for (const el of forwardedTo.keys()) {
      if (!document.contains(el)) forwardedTo.delete(el);
    }
    for (const el of document.querySelectorAll(sel.value)) {
      const src = el.getAttribute('src');
      if (!src) continue;
      let origin;
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

  scan();
  new MutationObserver(scan).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
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
      if (rule.anchor?.iframe) bridgeRule(rule, spec, api);
      else applyRule(rule, spec, api, mutations, handlers);
    }
  });

  // Apply a rule that wasn't declared in this patch — used by the preload to
  // run rules forwarded from a parent frame. `specIdOverride` namespaces CSS
  // tokens so forwarded rules can't collide with this frame's own tokens.
  return {
    applyExtraRule(rule, specIdOverride) {
      const effectiveSpec = specIdOverride ? { ...spec, id: specIdOverride } : spec;
      api.onReady(() => applyRule(rule, effectiveSpec, api, mutations, handlers));
    },
  };
}

module.exports = { run };
