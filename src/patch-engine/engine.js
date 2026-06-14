const vm = require('vm');
const anchors = require('./anchors');
const witnessMod = require('./witness');
const { applyStrategy } = require('./strategies');
const routeMatch = require('./route-match');

// All shim CSS lives inside one named cascade layer, `shim`. This is what
// makes "your local layer wins over the site" a guarantee rather than a
// specificity gamble (CLAUDE.md §6). The load-bearing CSS rule: for
// `!important` declarations, a *layered* style beats an *un-layered* style —
// regardless of selector specificity or source order. Virtually every real
// site ships un-layered CSS, so a shim `!important` rule in `@layer shim`
// wins against the site's `!important` rules even when the site's selector is
// far more specific. Multiple `@layer shim { … }` blocks merge by name into
// the one layer, so each rule keeps its own removable text node (teardown is
// unchanged) while all of them share the layer's precedence.
const SHIM_LAYER = 'shim';
function layered(cssText) {
  return `@layer ${SHIM_LAYER} { ${cssText} }\n`;
}

// Cross-shim cascade priority (higher wins). Stamped onto the runtime spec by
// `run()` from the patch's `priority` (assigned in main: user shims above
// platform fixtures; among user shims, sidebar list order). Read here rather
// than threaded through every rule-processing signature. Previews / forwarded
// rules that shallow-copy the spec inherit it.
function cssPriorityOf(spec) {
  return Number.isFinite(spec && spec.__cssPriority) ? spec.__cssPriority : 0;
}

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
// remove it from the sheet during rule teardown. Each entry stores the text
// node plus its `priority` so cross-shim conflicts resolve deterministically
// (see injectTier1Rule).
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
// All tier-1 rules share one `@layer shim` (so they all beat the site), which
// means a conflict between two shims on the same element+property is decided
// by SOURCE ORDER within the layer — later wins. Blind append makes that
// order depend on apply timing (which shim's rule resolved first, whether a
// rule self-healed late), so the winner flips between reload and toggle. We
// instead insert each rule at a position keyed by `priority` (higher wins):
// the sheet stays sorted low→high, so the highest-priority shim's rule is
// always last and always wins, regardless of when it resolved. Priority is
// assigned in main (user shims > platform fixtures; among user shims, the
// one higher in the sidebar list) and threaded in via the spec.
function injectTier1Rule(token, cssBody, priority = 0) {
  const text = layered(`[data-shim-css~="${token}"] { ${cssBody} }`);
  const existing = tier1RuleNodes.get(token);
  if (existing) {
    existing.node.nodeValue = text;
    existing.priority = priority;
    return;
  }
  const node = document.createTextNode(text);
  const sheet = ensureTier1Sheet();
  // Keep the sheet ordered ascending by priority: insert before the first
  // already-placed node whose priority is strictly higher. Ties (same
  // priority — e.g. two rules of one shim) fall to append-after, preserving
  // intra-shim authoring order. Walking childNodes (DOM order) keeps the
  // position correct even as nodes are added and removed over time.
  const children = Array.from(sheet.childNodes);
  const priorities = children.map((c) => {
    const entry = nodeToEntry(c);
    return entry ? entry.priority : -Infinity; // untracked nodes sort first
  });
  const idx = firstGreaterIndex(priorities, priority);
  sheet.insertBefore(node, children[idx] || null); // out-of-range → append
  tier1RuleNodes.set(token, { node, priority });
}
// First index whose value is strictly greater than `priority`, else the
// array length (append). Pure — exported for scripts/css-priority-harness.js.
function firstGreaterIndex(priorities, priority) {
  for (let i = 0; i < priorities.length; i++) {
    if (priorities[i] > priority) return i;
  }
  return priorities.length;
}
// Reverse lookup (text node → its tracked entry) for the ordered insert.
// The rule set is small (a handful per page), so the linear scan is cheap.
function nodeToEntry(node) {
  for (const entry of tier1RuleNodes.values()) {
    if (entry.node === node) return entry;
  }
  return null;
}
function removeTier1Rule(token) {
  const entry = tier1RuleNodes.get(token);
  if (!entry) return;
  entry.node.remove();
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

// Tier-4 `replace-root` machinery. Distinct attr + sheet from Tier-1 because
// the rule shape differs: Tier-1 styles the anchor; replace-root styles the
// anchor's direct children (hiding them so the handler's mounted DOM can
// occupy the space). Same token-per-rule discipline so teardown can pull
// just this rule's CSS out of the sheet.
const replaceRootRuleNodes = new Map();
function ensureReplaceRootSheet() {
  let sheet = document.querySelector('style[data-shim="replace-root"]');
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.setAttribute('data-shim', 'replace-root');
    (document.head || document.documentElement).appendChild(sheet);
  }
  return sheet;
}
function injectReplaceRootRule(token) {
  if (replaceRootRuleNodes.has(token)) return;
  // The `:not([data-shim-mounted~="..."])` clause keeps the handler's own
  // mounted output visible; without it the children-hide rule would also
  // hit the node the handler appended to the anchor. The handler tags its
  // returned roots with a matching `data-shim-mounted` token (see the
  // dispatch path) so the rule excludes them.
  const text = layered(`[data-shim-replace-root~="${token}"] > *:not([data-shim-mounted~="${token}"]) { display: none !important; }`);
  const node = document.createTextNode(text);
  ensureReplaceRootSheet().appendChild(node);
  replaceRootRuleNodes.set(token, node);
}
function removeReplaceRootRule(token) {
  const node = replaceRootRuleNodes.get(token);
  if (!node) return;
  node.remove();
  replaceRootRuleNodes.delete(token);
}

// Route-only environment pinning. The shadow root isolates a route page's
// CONTENTS, but the page still sits inside the host document's <html>/<body>
// — and those differ per entry path: soft nav keeps the site's stylesheet
// (body max-width / margins / html font-size, which rem resolves against),
// hard load is a bare shell with UA defaults. Pinning both to a neutral state
// while a route is mounted is what makes the two paths render identically.
// NOT applied for the `replace-root` kind — an in-place region replacement is
// supposed to live in the site's layout context; a route page replaces it.
function injectRouteEnvRule(token) {
  const key = `${token}::env`;
  if (replaceRootRuleNodes.has(key)) return;
  const text =
    layered(`html:has(> body[data-shim-replace-root~="${token}"]) { margin: 0 !important; padding: 0 !important; font-size: 16px !important; background: #fff !important; }`) +
    layered(`body[data-shim-replace-root~="${token}"] { margin: 0 !important; padding: 0 !important; max-width: none !important; width: auto !important; min-height: 100vh !important; background: #fff !important; display: block !important; }`);
  const node = document.createTextNode(text);
  ensureReplaceRootSheet().appendChild(node);
  replaceRootRuleNodes.set(key, node);
}
function removeRouteEnvRule(token) {
  removeReplaceRootRule(`${token}::env`);
}
function tagReplaceRootAnchor(el, token) {
  const current = el.getAttribute('data-shim-replace-root') || '';
  const tokens = current.split(/\s+/).filter(Boolean);
  if (tokens.includes(token)) return;
  tokens.push(token);
  el.setAttribute('data-shim-replace-root', tokens.join(' '));
}
function stripReplaceRootToken(el, token) {
  const current = el.getAttribute('data-shim-replace-root') || '';
  const tokens = current.split(/\s+/).filter((t) => t && t !== token);
  if (tokens.length) el.setAttribute('data-shim-replace-root', tokens.join(' '));
  else el.removeAttribute('data-shim-replace-root');
}
function tagMountedNode(node, token) {
  if (!(node instanceof Element)) return;
  const current = node.getAttribute('data-shim-mounted') || '';
  const tokens = current.split(/\s+/).filter(Boolean);
  if (tokens.includes(token)) return;
  tokens.push(token);
  node.setAttribute('data-shim-mounted', tokens.join(' '));
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
    injectTier1Rule(token, 'display: none !important;', cssPriorityOf(spec));
    tagElement(el, token);
    return Promise.resolve([]);
  }

  if (mut.kind === 'restyle') {
    const body = cssBodyFromProps(mut.properties);
    if (!body) return Promise.resolve([]);
    const token = `shim-${spec.id}-${rule.id}-restyle`;
    injectTier1Rule(token, body, cssPriorityOf(spec));
    tagElement(el, token);
    return Promise.resolve([]);
  }

  // Tier 3 — delete the anchor outright. Hostile to reconcilers by design:
  // the engine's scan loop catches re-rendered nodes and re-removes them.
  // Irreversible by nature — toggle-off can't restore a deleted node; the
  // user reloads, or the framework re-renders, to recover. Prefer `hide`
  // unless the parent's layout actually depends on child count / structural
  // selectors (`:nth-child`, flex/grid count, etc.).
  if (mut.kind === 'remove') {
    el.remove();
    return Promise.resolve([]);
  }

  // Tier 4 `replace-root` — mount handler-returned DOM inside the anchor and
  // hide the anchor's original children via CSS. Reversible: toggle-off
  // strips the token, the CSS rule comes out of the sheet, original children
  // reappear. Handler contract mirrors `script`: it returns the node(s) it
  // mounted; the engine tags each with `data-shim-mounted="<token>"` so the
  // children-hide rule's `:not(...)` clause spares them. Self-healing comes
  // for free from the scan loop — if the framework reconciles our mount
  // away, the next scan re-runs the handler.
  if (mut.kind === 'replace-root') {
    const fn = handlers[mut.handler];
    if (!fn) {
      console.warn(`[shim] replace-root: unknown handler "${mut.handler}"`);
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
    const token = `shim-${spec.id}-${rule.id}-replace-root`;
    injectReplaceRootRule(token);
    tagReplaceRootAnchor(el, token);
    return safe(`replace-root handler "${mut.handler}"`, mut.handler, () =>
      fn({ anchor: el, mutation: mut, rule, spec, api }),
    ).then((nodes) => {
      for (const n of nodes) tagMountedNode(n, token);
      return nodes;
    });
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
  // Witness state: capture fires at most once per lifecycle; the latest
  // rejection verdict feeds the settle-delayed unresolved reporter.
  let witnessCaptured = false;
  let lastWitnessRejection = null;

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

    const { nodes, source, witnessRejected, rejectedSample } =
      anchors.resolveAllWithSource(rule.anchor);
    // Track which spec carried the rule this scan. When state.size goes
    // to 0 (no match), we keep the last source for context — the inspector
    // can still show "previously via fallback:0" if useful, though today
    // we just null it. The matchedVia is most informative right when
    // mounts exist; on no-match it's redundant with `state.size === 0`.
    lastMatchedSource = source;
    // Remember the latest witness verdict so the settle-delayed reporter
    // can tell quarantine ("selector found something that isn't the
    // thing") apart from plain no-match ("selector found nothing").
    lastWitnessRejection = witnessRejected ? (rejectedSample || { detail: [] }) : null;

    // Witness capture (§8): a rule without a witness that resolves to
    // exactly ONE element gets fingerprinted, and the fingerprint is
    // reported up. During authoring previews the loop attaches it to the
    // rule before commit; for committed rules the event is groundwork for
    // the rebase pass to backfill. Once per applyRule lifecycle — the
    // shape doesn't change scan-to-scan, and re-emitting on churn would
    // be noise. Multi-match rules skip capture: one witness can't
    // describe N different elements (§8 v1 scope).
    if (!witnessCaptured && !rule.anchor?.witness && nodes.length === 1) {
      witnessCaptured = true;
      const w = witnessMod.buildWitness(nodes[0]);
      if (w && typeof api.reportEvent === 'function') {
        api.reportEvent('rule-witness', {
          specId: spec.id,
          ruleId: rule.id,
          witness: w,
        });
      }
    }
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

  // Unresolved-rule feedback for the authoring flow: if a rule is applied
  // and resolves zero anchors, give the page a beat to settle (React
  // hydration, late-arriving content) and then phone the signal back so
  // the LLM / inspector knows. Two flavors, decided at fire time by the
  // latest scan's witness verdict:
  //   - rule-quarantined — the selector DID resolve elements, but none
  //     passed the witness. The dangerous case (§14): something matches,
  //     and it isn't the thing the rule anchored to. Carries the
  //     expected witness + the best-scoring rejected candidate's diff.
  //   - rule-no-match   — the selector resolved nothing at all.
  // Fired at most once per applyRule lifecycle — re-emitting on subtree
  // churn would be too noisy. Cleared inside scan() on first match,
  // scrapped at teardown.
  const NO_MATCH_DELAY_MS = 1500;
  const maybeReportNoMatch = () => {
    noMatchTimer = 0;
    if (state.size > 0 || noMatchReported) return;
    noMatchReported = true;
    if (typeof api.reportEvent !== 'function') return;
    if (lastWitnessRejection) {
      api.reportEvent('rule-quarantined', {
        specId: spec.id,
        ruleId: rule.id,
        selector: rule.anchor?.primary?.value || '',
        expected: rule.anchor?.witness || null,
        seen: lastWitnessRejection.detail || [],
        rejectedVia: lastWitnessRejection.source || null,
      });
      return;
    }
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
        } else if (mut.kind === 'replace-root') {
          stripReplaceRootToken(anchor, `shim-${spec.id}-${rule.id}-replace-root`);
        }
      }
    }
    state.clear();
    for (const mut of rule.mutations || []) {
      if (mut.kind === 'hide' || mut.kind === 'restyle') {
        removeTier1Rule(`shim-${spec.id}-${rule.id}-${mut.kind}`);
      } else if (mut.kind === 'replace-root') {
        removeReplaceRootRule(`shim-${spec.id}-${rule.id}-replace-root`);
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

// A rule carrying a `mount-route` mutation registers a virtual route: a URL
// path pattern (`/budgets`, `/budgets/:id`) plus a handler that renders the
// page for matching navigations. Two entry paths converge here:
//
//   - Soft nav: the user clicks an <a> whose path matches, or back/forward
//     lands on a matching path. We intercept clicks (preventDefault +
//     history.pushState) and listen for popstate. No server round-trip.
//   - Hard load: the user types the URL or reloads. Main serves a same-origin
//     local shell for registered routes (see src/main/route-protocol.js), so
//     the document loads at the real URL with the site's session intact; the
//     engine boots and `evaluate()` below sees the path already matches.
//
// Both reduce to one question — does `location.pathname` match the pattern? —
// so mounting is identical regardless of how the path was reached. The page
// itself is mounted at `document.body` and the site's own body children are
// hidden, reusing the Tier-4 `replace-root` token machinery.
function routeRule(rule, spec, api, handlers) {
  const effectiveHandlers = rule.handlers
    ? { ...handlers, ...compileInlineHandlers(rule.handlers, spec) }
    : handlers;

  const mut = (rule.mutations || []).find((m) => m.kind === 'mount-route');
  if (!mut || !mut.pattern) {
    console.warn('[shim] mount-route rule missing `pattern`');
    return () => {};
  }

  const reportHandlerError = (err) => {
    if (typeof api.reportEvent !== 'function') return;
    api.reportEvent('handler-error', {
      specId: spec.id,
      handlerName: mut.handler || '(anonymous)',
      ruleId: rule.id,
      message: err?.message || String(err),
      stack: trimStackForEvent(err?.stack || ''),
    });
  };

  const handlerFn = effectiveHandlers[mut.handler];
  if (!handlerFn) {
    console.warn(`[shim] mount-route: unknown handler "${mut.handler}"`);
    reportHandlerError(new Error(`unknown handler "${mut.handler}" — the rule references a handler name that wasn't compiled with this shim`));
    return () => {};
  }

  const match = routeMatch.matcher(mut.pattern);
  const token = `shim-${spec.id}-${rule.id}-mount-route`;

  let lastReportedMatched = -1;
  const reportStatus = (matched) => {
    if (matched === lastReportedMatched) return;
    lastReportedMatched = matched;
    if (typeof api.reportEvent !== 'function') return;
    api.reportEvent('rule-status', {
      specId: spec.id,
      ruleId: rule.id,
      matched,
      matchedVia: matched ? 'route' : null,
    });
  };

  // { outputs: Node[], cleanups: Function[], path: string } while a route is
  // mounted; null when the current path doesn't match.
  let mounted = null;

  function mountRoute(m) {
    const cleanups = [];
    const mountApi = Object.assign(Object.create(api), {
      cleanup(fn) { if (typeof fn === 'function') cleanups.push(fn); },
    });
    let outputs = [];
    try {
      const raw = handlerFn({
        match: { path: routeMatch.normalizePath(location.pathname), params: m.params },
        mutation: mut,
        rule,
        spec,
        api: mountApi,
      });
      outputs = normalizeOutputs(raw);
    } catch (err) {
      console.error('[shim] mount-route handler failed', err);
      reportHandlerError(err);
      return;
    }
    const body = document.body;
    if (!body) return;
    injectReplaceRootRule(token);
    injectRouteEnvRule(token);
    tagReplaceRootAnchor(body, token);
    // The page mounts inside a shadow root so soft nav and hard load render
    // IDENTICALLY. The two paths live in different CSS universes — soft nav
    // keeps the site's stylesheets loaded, hard load is a bare shell — and
    // without isolation the same handler output looks different per path
    // (site h1 sizing, fonts, even site-targeting Tier-1 rules leak in).
    // `all: initial` severs inherited properties (font, color) from the host
    // document for the same reason. Route pages are self-contained by
    // contract: they style themselves via inline styles or their own <style>.
    const host = document.createElement('div');
    host.setAttribute('data-shim', 'route-host');
    tagMountedNode(host, token);
    const shadow = host.attachShadow({ mode: 'open' });
    const base = document.createElement('style');
    base.textContent = ':host { all: initial; display: block; }';
    shadow.appendChild(base);
    for (const n of outputs) shadow.appendChild(n);
    body.appendChild(host);
    // Tab title: the hard-load shell has an empty <title> and on soft nav the
    // site's own title would linger. `mutation.title` declares the route's;
    // the previous value is restored on unmount either way (handlers that set
    // document.title themselves are unwound by the same restore).
    const prevTitle = document.title;
    if (typeof mut.title === 'string') document.title = mut.title;
    // Match real-navigation behavior: a fresh route view starts at the top.
    try { window.scrollTo(0, 0); } catch { /* jsdom / detached */ }
    mounted = { outputs: [host], cleanups, path: routeMatch.normalizePath(location.pathname), prevTitle };
    reportStatus(1);
  }

  function unmountRoute() {
    if (!mounted) return;
    for (const fn of mounted.cleanups) {
      try { fn(); } catch (err) { console.error('[shim] route cleanup failed', err); }
    }
    for (const node of mounted.outputs) node.remove();
    if (document.body) stripReplaceRootToken(document.body, token);
    removeReplaceRootRule(token);
    removeRouteEnvRule(token);
    document.title = mounted.prevTitle;
    mounted = null;
    reportStatus(0);
  }

  // The single source of truth: reconcile mounted-state against the current
  // path. Called on init (covers hard load), on every click we intercept,
  // and on popstate (back/forward). A path that still matches but changed
  // params (`/budgets/1` → `/budgets/2`) re-mounts so the handler re-renders
  // with the new params.
  function evaluate() {
    const here = routeMatch.normalizePath(location.pathname);
    const m = match(here);
    if (m && !mounted) mountRoute(m);
    else if (m && mounted && mounted.path !== here) { unmountRoute(); mountRoute(m); }
    else if (!m && mounted) unmountRoute();
  }

  function onClick(e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let the browser open new tab/window
    // composedPath()[0], not e.target: clicks inside the route page's shadow
    // root retarget to the host element at the document level, which would
    // hide the actual <a>. composedPath sees through the shadow boundary, so
    // route-to-route links inside a mounted page keep getting intercepted.
    const rawTarget = e.composedPath ? e.composedPath()[0] : e.target;
    const el = rawTarget instanceof Element ? rawTarget : rawTarget?.parentElement;
    const a = el?.closest?.('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    let url;
    try { url = new URL(a.href, location.href); } catch { return; }
    if (url.origin !== location.origin) return; // external link — real navigation
    if (!match(routeMatch.normalizePath(url.pathname))) return; // not one of our routes
    e.preventDefault();
    if (url.href !== location.href) {
      history.pushState({}, '', url.pathname + url.search + url.hash);
    }
    evaluate();
  }

  function onPopState() { evaluate(); }
  // bfcache restores can land a frozen document on a different history entry
  // WITHOUT firing popstate (only pageshow with persisted=true). Re-evaluate
  // so a doc frozen on /notes and restored on / unmounts, and vice versa.
  function onPageShow(e) { if (e.persisted) evaluate(); }

  // Light self-heal: if a framework re-render detaches our mounted root while
  // the route is still active, re-attach it. The replace-root CSS keeps the
  // site's own (re-rendered) body children hidden on its own, so this only
  // has to worry about our own node going missing.
  let healHandle = 0;
  const observer = new MutationObserver(() => {
    if (!mounted || healHandle) return;
    healHandle = requestAnimationFrame(() => {
      healHandle = 0;
      if (!mounted || !document.body) return;
      tagReplaceRootAnchor(document.body, token);
      for (const n of mounted.outputs) {
        if (!document.contains(n)) document.body.appendChild(n);
      }
    });
  });

  document.addEventListener('click', onClick, true); // capture, so we beat the site's own handlers
  window.addEventListener('popstate', onPopState);
  window.addEventListener('pageshow', onPageShow);
  if (document.body) observer.observe(document.body, { childList: true });
  evaluate(); // hard-load / initial-path case

  return function teardownRouteRule() {
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener('pageshow', onPageShow);
    observer.disconnect();
    if (healHandle) { cancelAnimationFrame(healHandle); healHandle = 0; }
    unmountRoute();
  };
}

// Pick the right setup path for a rule. Route rules and iframe-bridge rules
// take dedicated lifecycles; everything else is a normal anchored rule.
function setupRule(rule, spec, api, mutations, handlers) {
  if (rule.anchor?.iframe) return bridgeRule(rule, spec, api);
  if ((rule.mutations || []).some((m) => m.kind === 'mount-route')) {
    return routeRule(rule, spec, api, handlers);
  }
  return applyRule(rule, spec, api, mutations, handlers);
}

function run(patch, api) {
  const { mutations = {}, handlers = {} } = patch;
  // Stamp the cross-shim cascade priority onto the runtime spec so the
  // tier-1 injector can read it without threading a param through every
  // rule-processing function. Shallow copy — the authored spec is untouched,
  // and the preview/forwarded paths that spread `spec` inherit the field.
  const spec = {
    ...patch.spec,
    __cssPriority: Number.isFinite(patch.priority) ? patch.priority : 0,
  };

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
      ruleTeardowns.push(setupRule(rule, spec, api, mutations, handlers));
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
        const teardown = setupRule(rule, effectiveSpec, api, mutations, handlers);
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

// firstGreaterIndex exported for scripts/css-priority-harness.js (the cross-
// shim ordering policy); not used elsewhere at runtime.
module.exports = { run, firstGreaterIndex };
