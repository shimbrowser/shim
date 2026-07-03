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
// distinguishes two instances of the same component type (0.3). The comparison
// itself is name-equality; cross-deploy minification renames (TrackRow→Wc→Xd)
// are handled ABOVE it by translating descriptors into original-name space via
// the deploy's sourcemap-symbol map (translateComponent / the symbols arg to
// matchComponent) before scoring — where no map exists, raw names compare
// exactly as before.
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

// --- Sourcemap-symbol translation (§8, Stage B "consume the map") -----------
//
// Component names read from a fiber are the CURRENT deploy's minified names
// (`Wc`); the durable, legible identity is the ORIGINAL name (`TrackRow`).
// Bundle Discovery caches a per-(host, bundleHash) `{ minified: original }`
// map; these helpers move descriptors between the two name spaces. Both are
// pure and null-tolerant: no map (or no entry for a name) → the name passes
// through unchanged, so an unmapped site behaves exactly as before.

// Return a copy of `desc` with every path name looked up through `symbols`
// (minified→original). Names without an entry stay as-is. Returns `desc`
// itself when nothing changed (cheap identity for the common no-map case).
function translateComponent(desc, symbols) {
  if (!desc || !Array.isArray(desc.path) || !desc.path.length) return desc;
  if (!symbols || typeof symbols !== 'object') return desc;
  let changed = false;
  const path = desc.path.map((n) => {
    const orig = symbols[n];
    if (typeof orig === 'string' && orig && orig !== n) { changed = true; return orig; }
    return n;
  });
  return changed ? { ...desc, path } : desc;
}

// Invert a {minified: original} map into {original: minified} for the reverse
// translation (a stored ORIGINAL-space descriptor → the CURRENT deploy's
// minified names, so the main-world find scan can match live fibers). An
// original claimed by several minified tokens (memo/forwardRef aliases like
// `StyledMenuOption$1/$2/$3` → `StyledMenuOption`) is AMBIGUOUS — dropped, not
// guessed; the untranslated name rides along as the raw fallback descriptor.
function invertSymbols(symbols) {
  if (!symbols || typeof symbols !== 'object') return null;
  const inv = {};
  const dupes = {};
  for (const [min, orig] of Object.entries(symbols)) {
    if (typeof orig !== 'string' || !orig) continue;
    if (dupes[orig]) continue;
    if (orig in inv) { delete inv[orig]; dupes[orig] = true; continue; }
    inv[orig] = min;
  }
  return inv;
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
//
// `symbols` (optional): the CURRENT deploy's {minified: original} map. When
// present, the actual descriptor is ALSO scored after translating its names to
// original space, and the max of the two scores wins. The dual scoring is the
// back-compat contract: a NEW witness (stored in original space) passes via the
// translated comparison, while a PRE-EXISTING witness (stored minified names)
// keeps passing via the raw one — translating unconditionally would false-
// quarantine every witness captured before the symbol map existed.
//
// `expected.mapped` (stamped at capture when translation actually renamed the
// stored path) says the witness can ONLY match through a map — its names are
// originals that never appear raw in a minified fiber tree. For such a witness
// the veto refuses to judge on uninterpretable evidence:
//   - no map at all (Discovery raced/failed, shims paused during it, site
//     stopped shipping maps) → applicable:false, NOT a fail — scoring raw
//     original-vs-minified would false-quarantine a healthy shim on the first
//     load after every deploy;
//   - a map that can't express the expected nearest name (ambiguity-dropped
//     alias, component renamed at source) → applicable:false for the same
//     reason: "the map doesn't know this name" is indistinguishable from a
//     rename, and never-false-quarantine outranks catching one more mis-attach
//     (matchWitness's other signals still guard the anchor).
function matchComponent(expected, actual, symbols) {
  if (!expected || !Array.isArray(expected.path) || !expected.path.length) {
    return { applicable: false, pass: true, score: 1 };
  }
  if (!actual || !Array.isArray(actual.path) || !actual.path.length) {
    return { applicable: false, pass: true, score: 1 };
  }
  if (expected.mapped) {
    if (!symbols) return { applicable: false, pass: true, score: 1 };
    let known = false;
    for (const orig of Object.values(symbols)) {
      if (orig === expected.path[0]) { known = true; break; }
    }
    if (!known) return { applicable: false, pass: true, score: 1 };
  }
  let score = componentScore(expected, actual);
  if (symbols) {
    const translated = translateComponent(actual, symbols);
    if (translated !== actual) {
      score = Math.max(score, componentScore(expected, translated));
    }
  }
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
        // Accept one descriptor or an ARRAY of them (a candidate matches if any
        // scores). The engine passes [translated-to-minified, raw-original] so a
        // stored original-space identity matches live minified fibers when the
        // deploy ships a symbol map, and unmapped names still match raw.
        var expectedList = Array.isArray(expected) ? expected : (expected ? [expected] : []);
        if (expectedList.length) {
          var all = document.getElementsByTagName('*');
          var count = 0;
          for (var i = 0; i < all.length && i < 8000 && count < 10; i++) {
            var cid = __shimComponentIdentity(all[i]);
            if (!cid) continue;
            for (var x = 0; x < expectedList.length; x++) {
              if (expectedList[x] && componentScore(expectedList[x], cid) >= RECOVER_THRESHOLD) {
                all[i].setAttribute('data-shim-cid-found', reqId);
                count++;
                break;
              }
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
  translateComponent,
  invertSymbols,
  MATCH_THRESHOLD,
  RECOVER_THRESHOLD,
};
