// Framework-component-identity — the strongest anchor signal (CLAUDE.md §8).
//
// React/Vue/Angular attach the component instance that rendered a DOM node to
// the node as an expando (React: `__reactFiber$<rand>` / `__reactInternalInstance$<rand>`).
// The identity it yields — the chain of component names that produced an
// element, plus the prop keys passed to the nearest one — is far more stable
// across a site's deploys than class names, which content-hash on every build
// (Tailwind/CSS-modules churn). That makes it the rung the css/data/aria/text
// ladder has been missing on framework SPAs, which is most of Shim's surface.
//
// World boundary (proven by scripts/fiber-isolation-spike.js): these expandos
// are visible ONLY from the page's main world, never the engine's isolated
// world (contextIsolation). So identity is extracted by a main-world helper
// (FIBER_WALK_SRC, injected into the page by page-preload) and only the
// resulting plain-JSON descriptor crosses back to the engine. Everything in
// THIS module is pure / world-agnostic:
//   - FIBER_WALK_SRC + buildHelperSrc() are STRINGS run in the main world.
//   - componentScore / matchComponent compare two plain descriptors and run
//     in the isolated world (and bare-node tests). componentScore is also
//     injected into the main world (via .toString()) so `find` can match
//     there — one source of truth for the scoring.
//
// Descriptor shape (what crosses the boundary, embedded in the witness):
//   { v: 1, path: ["TrackRow", "TrackList", "App"], propKeys: ["onPlay", "trackId"] }
// `path` is nearest-composite-component first, capped in depth; `propKeys` are
// the sorted own prop-keys of the nearest composite (minus `children`).

const COMPONENT_ID_VERSION = 1;

// Main-world fiber walk. Defined as a string because it must execute in the
// page's main world (where the expandos live). React-first; the structure
// (walk `.return`, read `.type`/`.memoizedProps`) is React's, but the null
// returns keep it harmless on any non-React node.
const FIBER_WALK_SRC = `
function __shimComponentIdentity(el) {
  if (!el || el.nodeType !== 1) return null;
  var key = null;
  for (var k in el) {
    if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) { key = k; break; }
  }
  if (!key) return null;
  var node = el[key];
  var path = [];
  var propKeys = null;
  var DEPTH = 6;
  while (node && path.length < DEPTH) {
    var t = node.type;
    if (t && typeof t !== 'string') {
      var name = null;
      if (typeof t === 'function') {
        name = t.displayName || t.name || null;
      } else if (typeof t === 'object') {
        // memo()/forwardRef() wrap the real component in an object.
        name = t.displayName ||
          (t.render && (t.render.displayName || t.render.name)) ||
          (t.type && (t.type.displayName || t.type.name)) || null;
      }
      if (name && name !== 'Unknown') {
        path.push(name);
        if (propKeys === null && node.memoizedProps && typeof node.memoizedProps === 'object') {
          propKeys = Object.keys(node.memoizedProps)
            .filter(function (p) { return p !== 'children'; })
            .sort();
        }
      }
    }
    node = node.return;
  }
  if (!path.length) return null;
  return { v: ${COMPONENT_ID_VERSION}, path: path, propKeys: propKeys || [] };
}
`;

// Pure scoring of a captured descriptor against a freshly-read one. NO external
// references — it is also stringified into the main-world helper, so it must
// stand alone. Returns a number in [0, 1].
//
// Weighting rationale: the nearest component name is the dominant identity
// signal (0.5); deeper ancestry adds confidence (0.2); prop-key overlap
// distinguishes two instances of the same component type (0.3). Name equality
// is correct for Stage A's uses — verify (same page) and same-deploy recovery.
// Cross-deploy minification renames (TrackRow→Wc→Xd) are Stage C's rename-map,
// not this comparison.
function componentScore(expected, actual) {
  if (!expected || !actual) return 0;
  var ep = expected.path || [];
  var ap = actual.path || [];
  if (!ep.length || !ap.length) return 0;

  var score = 0;
  if (ep[0] === ap[0]) score += 0.5;

  var prefix = 0;
  var lim = Math.min(ep.length, ap.length);
  for (var i = 0; i < lim; i++) {
    if (ep[i] === ap[i]) prefix++;
    else break;
  }
  score += 0.2 * (prefix / ep.length);

  var a = expected.propKeys || [];
  var b = actual.propKeys || [];
  if (!a.length && !b.length) {
    score += 0.3; // neither carries prop keys → no disagreement
  } else {
    var bset = {};
    for (var j = 0; j < b.length; j++) bset[b[j]] = true;
    var inter = 0;
    for (var m = 0; m < a.length; m++) if (bset[a[m]]) inter++;
    var union = {};
    for (var n = 0; n < a.length; n++) union[a[n]] = true;
    for (var q = 0; q < b.length; q++) union[b[q]] = true;
    var unionN = Object.keys(union).length;
    score += 0.3 * (unionN ? inter / unionN : 1);
  }
  return score;
}

// Pass threshold for verification. Mirrors the witness module's 0.5 — a clean
// nearest-name match alone clears it; a nearest-name mismatch (score ≤ 0.2 + a
// little prop overlap) does not.
const MATCH_THRESHOLD = 0.5;
// A touch higher for RECOVERY — finding the target by identity in a large scan
// pool wants more margin against a coincidental match (mirrors anchors.js
// RECOVER_MIN_SCORE).
const RECOVER_THRESHOLD = 0.6;

// Compare a captured component descriptor (witness.component) against a freshly
// read one. `applicable: false` means "no fiber data to judge on" — a non-React
// page, React internals stripped, or the bare-node harness — and the caller
// must SKIP the signal (treat as absent), never fail the candidate. This graceful
// degradation is what lets the component signal only ever strengthen
// verification where readable and never weaken it where not.
function matchComponent(expected, actual) {
  if (!expected || !Array.isArray(expected.path) || !expected.path.length) {
    return { applicable: false, pass: true, score: 1 };
  }
  if (!actual || !Array.isArray(actual.path) || !actual.path.length) {
    return { applicable: false, pass: true, score: 1 };
  }
  const score = componentScore(expected, actual);
  return { applicable: true, score, pass: score >= MATCH_THRESHOLD };
}

// Build the main-world helper source string injected by page-preload (once per
// frame, lazily on first use). It exposes the fiber walk and answers two ops
// driven entirely through SHARED DOM STATE — the only channel proven reliable
// across the isolated/main world boundary (spike: CustomEvents only carried
// main→isolated; a MutationObserver, watching real DOM mutations, is world-
// agnostic in both directions). Attributes on <html> carry the request/result
// payload; the main-world helper watches `data-shim-cid-req` via a
// MutationObserver and signals completion by setting `data-shim-cid-res`.
//   - verify: read [data-shim-cid-q="<reqId>"], return its identity as JSON
//   - find:   scan the tree for nodes matching the expected descriptor and
//             stamp each with data-shim-cid-found="<reqId>" so the isolated
//             world can re-resolve them via querySelectorAll in its own world.
function buildHelperSrc() {
  return `(function () {
  if (window.__shimCidHelper) return;
  window.__shimCidHelper = true;
  ${FIBER_WALK_SRC}
  var componentScore = ${componentScore.toString()};
  var RECOVER_THRESHOLD = ${RECOVER_THRESHOLD};
  var root = document.documentElement;
  var lastReq = null;
  function handle() {
    var op = root.getAttribute('data-shim-cid-op');
    var reqId = root.getAttribute('data-shim-cid-req');
    if (!op || !reqId || reqId === lastReq) return;
    lastReq = reqId;
    try {
      if (op === 'verify') {
        var el = document.querySelector('[data-shim-cid-q="' + reqId + '"]');
        var id = el ? __shimComponentIdentity(el) : null;
        root.setAttribute('data-shim-cid-result', JSON.stringify(id));
      } else if (op === 'find') {
        var expected = null;
        try { expected = JSON.parse(root.getAttribute('data-shim-cid-expected') || 'null'); } catch (e) {}
        if (expected) {
          var all = document.getElementsByTagName('*');
          var count = 0;
          for (var i = 0; i < all.length && i < 8000 && count < 10; i++) {
            var cid = __shimComponentIdentity(all[i]);
            if (cid && componentScore(expected, cid) >= RECOVER_THRESHOLD) {
              all[i].setAttribute('data-shim-cid-found', reqId);
              count++;
            }
          }
        }
      }
    } catch (e) { /* best-effort — isolated side times out and resolves empty */ }
    root.setAttribute('data-shim-cid-res', reqId);
  }
  var mo = new MutationObserver(handle);
  mo.observe(root, { attributes: true, attributeFilter: ['data-shim-cid-req'] });
  handle(); // in case a request is already pending when we install
})();`;
}

module.exports = {
  COMPONENT_ID_VERSION,
  FIBER_WALK_SRC,
  buildHelperSrc,
  componentScore,
  matchComponent,
  MATCH_THRESHOLD,
  RECOVER_THRESHOLD,
};
