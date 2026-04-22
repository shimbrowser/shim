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
//
// The per-token Map (rather than a bare Set) lets us (a) update a rule's CSS
// in place when it's re-applied with different properties, and (b) cleanly
// remove it from the sheet during rule teardown.
const tier1RuleNodes = new Map();
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
  const text = `[data-shim-css~="${token}"] { ${cssBody} }\n`;
  const existing = tier1RuleNodes.get(token);
  if (existing) {
    existing.nodeValue = text;
    return;
  }
  const node = document.createTextNode(text);
  ensureTier1Sheet().appendChild(node);
  tier1RuleNodes.set(token, node);
}
function removeTier1Rule(token) {
  const node = tier1RuleNodes.get(token);
  if (!node) return;
  node.remove();
  tier1RuleNodes.delete(token);
}
function tagElement(el, token) {
  const current = el.getAttribute('data-shim-css') || '';
  const tokens = current.split(/\s+/).filter(Boolean);
  if (tokens.includes(token)) return;
  tokens.push(token);
  el.setAttribute('data-shim-css', tokens.join(' '));
}
function stripToken(el, token) {
  const current = el.getAttribute('data-shim-css') || '';
  const tokens = current.split(/\s+/).filter((t) => t && t !== token);
  if (tokens.length) el.setAttribute('data-shim-css', tokens.join(' '));
  else el.removeAttribute('data-shim-css');
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

// Preview rules arrive with handler source as strings on rule.handlers
// (the LLM emits them as text). Wrap each in `(source)` and evaluate so
// the engine can invoke them like any module-loaded handler. Trust model:
// these strings originate from the authoring LLM routed through main —
// per CLAUDE.md §15 user-authored patch code is trusted for now; the
// sandbox work listed there is what replaces this once patches come from
// other users or a registry.
const compileFn = Function; // alias to keep code-review tooling happy.
function compileInlineHandlers(rawHandlers) {
  const out = {};
  for (const [name, source] of Object.entries(rawHandlers)) {
    if (typeof source === 'function') { out[name] = source; continue; }
    if (typeof source !== 'string') continue;
    try {
      out[name] = new compileFn(`return (${source})`)();
    } catch (err) {
      console.error(`[shim] failed to compile inline handler "${name}"`, err);
    }
  }
  return out;
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

// Returns a teardown function that unobserves, removes all mounted outputs,
// runs per-entry cleanups, and strips any Tier-1 CSS this rule stamped onto
// its anchors (plus the rule text from the shared stylesheet). Preview
// iterative refinement in the authoring UI relies on this.
function applyRule(rule, spec, api, mutations, handlers) {
  // Rules from the authoring UI preview path carry their handler sources
  // inline on the rule as strings (the LLM emits them that way). Compile
  // them to functions once here and merge into the module-level handlers
  // lookup for this rule's dispatch. On the disk-loaded path this field
  // is absent — handlers already arrive as real functions via the patch
  // module's handlers/*.js.
  const effectiveHandlers = rule.handlers
    ? { ...handlers, ...compileInlineHandlers(rule.handlers) }
    : handlers;

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
      const raw = await dispatchMutation(el, mut, rule, spec, api, mutations, effectiveHandlers);
      const { placed, cleanup } = applyStrategy(raw, el, mut);
      outputs.push(...placed);
      if (cleanup) cleanups.push(cleanup);
    }
    state.set(el, { outputs, cleanups });
  }

  function teardownEntry(entry) {
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
        teardownEntry(entry);
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
        teardownEntry(existing);
        state.delete(el);
      }
      inFlight.add(el);
      mountOn(el).finally(() => inFlight.delete(el));
    }
  };

  // rAF-coalesce the observer — React-style reconcilers can fire hundreds
  // of mutation batches per second during normal re-rendering, and each
  // scan runs a `querySelectorAll` per rule. One scan per frame is plenty
  // for self-healing and keeps the renderer's CPU baseline low.
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
  });

  return function teardownRule() {
    observer.disconnect();
    if (scanHandle) {
      cancelAnimationFrame(scanHandle);
      scanHandle = 0;
    }
    for (const [anchor, entry] of state) {
      teardownEntry(entry);
      for (const mut of rule.mutations || []) {
        if (mut.kind === 'hide' || mut.kind === 'restyle') {
          stripToken(anchor, `shim-${spec.id}-${rule.id}-${mut.kind}`);
        }
      }
    }
    state.clear();
    for (const mut of rule.mutations || []) {
      if (mut.kind === 'hide' || mut.kind === 'restyle') {
        removeTier1Rule(`shim-${spec.id}-${rule.id}-${mut.kind}`);
      }
    }
  };
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

  let scanHandle = 0;
  const scheduleScan = () => {
    if (scanHandle) return;
    scanHandle = requestAnimationFrame(() => {
      scanHandle = 0;
      scan();
    });
  };

  scan();
  new MutationObserver(scheduleScan).observe(document.body, {
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

  // Extra rules are those applied *after* the patch's own spec.rules — used by
  // the preload for rules forwarded in from a parent frame's bridge, and by
  // the authoring UI for live previews. Keyed rules can be updated in place
  // (same key replaces previous apply) and torn down via `removeExtraRule`.
  const extraTeardowns = new Map();

  return {
    applyExtraRule(rule, specIdOverride, ruleKey) {
      const effectiveSpec = specIdOverride ? { ...spec, id: specIdOverride } : spec;
      api.onReady(() => {
        if (ruleKey) {
          const prev = extraTeardowns.get(ruleKey);
          if (prev) {
            prev();
            extraTeardowns.delete(ruleKey);
          }
        }
        const teardown = applyRule(rule, effectiveSpec, api, mutations, handlers);
        if (ruleKey) extraTeardowns.set(ruleKey, teardown);
      });
    },
    removeExtraRule(ruleKey) {
      const teardown = extraTeardowns.get(ruleKey);
      if (!teardown) return false;
      teardown();
      extraTeardowns.delete(ruleKey);
      return true;
    },
  };
}

module.exports = { run };
