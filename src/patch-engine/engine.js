const vm = require('vm');
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
// (the LLM emits them as text). Evaluate each as a function expression so
// the engine can invoke them like any module-loaded handler. Trust model:
// these strings originate from the authoring LLM routed through main —
// per CLAUDE.md §15 user-authored patch code is trusted for now; the
// sandbox work listed there is what replaces this once patches come from
// other users or a registry.
//
// `vm.runInThisContext` (not the dynamic-code-generation alternative) is
// load-bearing: pages with a strict CSP (reddit, many bank sites) set
// `script-src` without `'unsafe-eval'`, and V8 enforces that by throwing
// `EvalError: Code generation from strings disallowed for this context`
// from the eval/Function path. The preload's Node-equipped isolated
// world sits outside the page's CSP and `vm` works regardless — same
// path `compileBag` in the page-preload uses for committed handlers,
// kept identical here so preview and committed share one trust +
// capability surface.
function compileInlineHandlers(rawHandlers, spec) {
  const out = {};
  const specId = spec?.id || 'inline';
  for (const [name, source] of Object.entries(rawHandlers)) {
    if (typeof source === 'function') { out[name] = source; continue; }
    if (typeof source !== 'string') continue;
    try {
      // Tag dynamically-compiled previews with a virtual sourceURL pragma
      // so DevTools stacktraces — and the page-preload's runtime-error
      // attribution regex — point at this exact handler. Without it,
      // throws from a preview would land in `<anonymous>` and the
      // sidebar would never know which shim caused them.
      //
      // Layout matters: the closing `)` of the inner function expression
      // MUST come BEFORE the `//# sourceURL=...` line. `//` starts a
      // single-line comment that runs to the next newline; if the
      // pragma sat between `${source}` and `)`, the comment would eat
      // the paren and the function expression never closes.
      const sourceURL = `shim://patches/${specId}/handlers/${name}.js`;
      out[name] = vm.runInThisContext(
        `(${source})\n//# sourceURL=${sourceURL}\n`,
        { filename: sourceURL },
      );
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
  // Emit a handler-error event into the authoring channel. Handler throws
  // are caught by the wrapper below (so a buggy handler can't take down
  // the whole engine), which means they never bubble to window.error —
  // we'd only see them in the console without this. Reporting from here
  // is the primary path for synchronous mount-time throws + initial
  // promise rejections; the page-preload's window.error / unhandled-
  // rejection listeners stay the backstop for async throws that escape
  // the wrapper (e.g. event listeners installed by a successful mount
  // that throw later).
  const reportError = (handlerName, err) => {
    if (typeof api.reportEvent !== 'function') return;
    api.reportEvent('handler-error', {
      specId: spec.id,
      handlerName: handlerName || '(anonymous)',
      ruleId: rule.id,
      message: err?.message || String(err),
      stack: trimStackForEvent(err?.stack || ''),
    });
  };

  const safe = (label, handlerName, work) => {
    try {
      return Promise.resolve(work()).then(normalizeOutputs, (err) => {
        console.error(`[shim] ${label} failed`, err);
        if (handlerName) reportError(handlerName, err);
        return [];
      });
    } catch (err) {
      console.error(`[shim] ${label} failed`, err);
      if (handlerName) reportError(handlerName, err);
      return Promise.resolve([]);
    }
  };

  if (mut.kind === 'script') {
    const fn = handlers[mut.handler];
    if (!fn) {
      console.warn(`[shim] script: unknown handler "${mut.handler}"`);
      // Missing handler is a kind of authoring error too — surface it the
      // same way as a throw so the LLM learns the rule emitted a handler
      // name that doesn't exist (probably a typo or stale ref).
      if (typeof api.reportEvent === 'function') {
        api.reportEvent('handler-error', {
          specId: spec.id,
          handlerName: mut.handler,
          ruleId: rule.id,
          message: `unknown handler "${mut.handler}" — the rule references a handler name that wasn't compiled with this shim`,
          stack: '',
        });
      }
      return Promise.resolve([]);
    }
    return safe(`script handler "${mut.handler}"`, mut.handler, () =>
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
  // Custom declarative mutations don't carry a handler-name slot in the
  // event vocabulary; pass null so the throw still hits the console but
  // no event is emitted. (None ship today — see CLAUDE.md §22 step 23.)
  return safe(`mount ${rule.id}/${mut.kind}`, null, () =>
    handler.mount(el, mut, rule, spec, api),
  );
}

// Trim a stack trace to the top 8 frames — enough to see the throwing line
// + immediate callers, not enough to bury the LLM in V8 internals. Mirrors
// the page-preload's `trimStack` (kept local rather than imported because
// the engine is loaded from both Node and the page-preload's vm context,
// and an import cycle would be awkward).
function trimStackForEvent(stack) {
  if (!stack) return '';
  return stack.split('\n').slice(0, 8).join('\n');
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
    ? { ...handlers, ...compileInlineHandlers(rule.handlers, spec) }
    : handlers;

  // anchor -> { outputs: Node[], cleanups: Function[] }
  // Map (not WeakMap) so we can iterate and prune anchors that left the DOM,
  // tearing down their portal/overlay listeners and removing nodes we parked
  // in document.body.
  const state = new Map();
  const inFlight = new WeakSet();

  // Zero-match warning state — declared up here so scan() (defined below)
  // can clear the timer when something finally anchors. Wire-up (timer
  // schedule + teardown clear) happens after scan is defined.
  let noMatchTimer = 0;
  let noMatchReported = false;

  // Rule-status reporting for the inspector panel. We only emit when the
  // current anchor count changes (transitioned from N → M, where N ≠ M),
  // not on every scan — most scans are no-ops because the DOM churns
  // around the rule's anchor without affecting it. `lastReportedCount`
  // starts at -1 so the first scan always emits, even if it resolves 0
  // anchors (the inspector wants to know "rule is mounted but not yet
  // matching" which is distinct from "rule hasn't run").
  let lastReportedCount = -1;
  let lastReportedSource = '__unset__';
  // `matchedVia` carries which anchor spec ended up resolving — `'primary'`,
  // `'fallback:0'`, ..., or `null` when nothing matched. Tracked separately
  // from count because a rule can keep its match count steady while
  // sliding from primary to a fallback (e.g. site renames `data-testid`,
  // primary now zero, fallback aria-role takes over with the same count).
  // Inspector surfaces this so users can spot "rule still works, but the
  // primary I wrote is now wrong."
  let lastMatchedSource = null;
  const reportStatusIfChanged = () => {
    if (state.size === lastReportedCount && lastMatchedSource === lastReportedSource) return;
    lastReportedCount = state.size;
    lastReportedSource = lastMatchedSource;
    if (typeof api.reportEvent !== 'function') return;
    api.reportEvent('rule-status', {
      specId: spec.id,
      ruleId: rule.id,
      matched: state.size,
      matchedVia: lastMatchedSource,
    });
  };

  async function mountOn(el) {
    const outputs = [];
    const cleanups = [];
    // Per-mount api proxy. Handlers call `api.cleanup(fn)` to register
    // tear-down work — event listeners on document, intervals, inner
    // MutationObservers, anything that won't unwind by itself when the
    // handler's returned DOM is removed. The engine runs each fn when
    // the anchor leaves the DOM (scan-time pruning) or the rule itself
    // tears down (toggle-off / shim-delete / patch teardownAll). Cleanups
    // run in registration order, BEFORE the strategy cleanup that
    // unparks portal/overlay nodes — so handler state is gone before
    // the DOM it observed disappears.
    //
    // `Object.create(api)` prototypically inherits storage/bridge/host/
    // reportEvent/etc. from the shared api, then we add `cleanup` as an
    // own property scoped to this mount's `cleanups` array. Concurrent
    // mounts of the same rule on different anchors get distinct proxies
    // — one anchor's cleanup registrations don't leak into another's.
    const mountApi = Object.assign(Object.create(api), {
      cleanup(fn) {
        if (typeof fn === 'function') cleanups.push(fn);
      },
    });
    for (const mut of rule.mutations || []) {
      const raw = await dispatchMutation(el, mut, rule, spec, mountApi, mutations, effectiveHandlers);
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

    const { nodes, source } = anchors.resolveAllWithSource(rule.anchor);
    // Track which spec carried the rule this scan. When state.size goes
    // to 0 (no match), we keep the last source for context — the inspector
    // can still show "previously via fallback:0" if useful, though today
    // we just null it. The matchedVia is most informative right when
    // mounts exist; on no-match it's redundant with `state.size === 0`.
    lastMatchedSource = source;
    for (const el of nodes) {
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
      mountOn(el).finally(() => {
        inFlight.delete(el);
        // mountOn updates state.size as it inserts. Re-report so the
        // inspector sees the bump even when the surrounding scan() found
        // no further changes.
        reportStatusIfChanged();
      });
    }

    // Clear any pending no-match warning the moment something anchors —
    // late-mounting content (React hydration, async-rendered list) is the
    // common false positive otherwise.
    if (noMatchTimer && state.size > 0) {
      clearTimeout(noMatchTimer);
      noMatchTimer = 0;
    }

    reportStatusIfChanged();
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

  // Zero-match feedback for the authoring flow: if a rule is applied and
  // resolves zero anchors, give the page a beat to settle (React hydration,
  // late-arriving content) and then phone the signal back to the sidebar so
  // the LLM's next turn knows the selector missed. Fired at most once per
  // applyRule lifecycle — re-emitting on subtree churn would be too noisy.
  // Cleared inside scan() on first match, scrapped at teardown.
  const NO_MATCH_DELAY_MS = 1500;
  const maybeReportNoMatch = () => {
    noMatchTimer = 0;
    if (state.size > 0 || noMatchReported) return;
    noMatchReported = true;
    if (typeof api.reportEvent !== 'function') return;
    api.reportEvent('rule-no-match', {
      specId: spec.id,
      ruleId: rule.id,
      selector: rule.anchor?.primary?.value || '',
    });
  };
  if (state.size === 0) {
    noMatchTimer = setTimeout(maybeReportNoMatch, NO_MATCH_DELAY_MS);
  }

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
    if (noMatchTimer) {
      clearTimeout(noMatchTimer);
      noMatchTimer = 0;
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
//
// Returns a teardown fn that disconnects the observer and cancels any pending
// rAF. Forwarded rules already applied in child frames aren't recalled —
// teardown-by-source is a separate bridge concern not wired yet.
function bridgeRule(rule, spec, api) {
  if (!api.bridge?.forwardRule) {
    console.warn('[shim] anchor.iframe set but api.bridge unavailable');
    return () => {};
  }
  const sel = rule.anchor?.iframe;
  if (sel?.kind !== 'css') {
    console.warn('[shim] anchor.iframe currently only supports kind:"css"');
    return () => {};
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

function run(patch, api) {
  const { spec, mutations = {}, handlers = {} } = patch;

  for (const { id, css } of collectCssForSpec(spec, mutations)) {
    const inject = () => injectStyle(id, css);
    if (document.head) inject();
    else document.addEventListener('DOMContentLoaded', inject, { once: true });
  }

  // Track teardowns for each rule in spec.rules so the whole patch can be
  // torn down live (sidebar toggle-off). Extra rules (previews + forwarded)
  // have their own lifecycle via extraTeardowns below.
  const ruleTeardowns = [];
  let tornDown = false;
  api.onReady(() => {
    if (tornDown) return;
    for (const rule of spec.rules || []) {
      if (rule.anchor?.iframe) ruleTeardowns.push(bridgeRule(rule, spec, api));
      else ruleTeardowns.push(applyRule(rule, spec, api, mutations, handlers));
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
    // Tears down every rule this patch mounted (observers, mounted outputs,
    // Tier-1 CSS tokens). Leaves injected stylesheets (`mutation-<kind>` /
    // `patch-<id>`) in place — they're idempotent and may be shared with
    // other patches. Does NOT recall rules already forwarded into child
    // iframes via anchor.iframe; those persist in the iframe's stub engine
    // until navigation.
    teardownAll() {
      tornDown = true;
      for (const fn of ruleTeardowns) {
        try { fn(); } catch (err) { console.error('[shim] rule teardown failed', err); }
      }
      ruleTeardowns.length = 0;
      for (const fn of extraTeardowns.values()) {
        try { fn(); } catch (err) { console.error('[shim] extra teardown failed', err); }
      }
      extraTeardowns.clear();
    },
  };
}

module.exports = { run };
