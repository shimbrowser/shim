// Witness fingerprints — the verification layer of the anchor ladder
// (CLAUDE.md §8, §14).
//
// A witness is a small shape-snapshot of the element a rule anchored to,
// captured at authoring time (the agentic loop's live preview is the
// capture point — the engine fingerprints what the anchor actually
// resolved to and the loop attaches it to the rule before commit). At
// runtime, resolution verifies candidates against the witness before
// applying: "this is still the thing I meant." A selector that resolves
// to a *different* element after a site redesign fails the witness and
// the ladder falls through — never silently mis-attaches.
//
// Design constraints:
//   - Tolerant by default. Sites churn text ("3 items" → "4 items"),
//     rotate classes, and re-render attributes. A witness that demands
//     exact equality quarantines healthy rules; scoring is N-of-M over
//     whichever signals the witness captured, with the tag as the only
//     hard gate.
//   - Deterministic + pure. No DOM mutation, no engine state — both
//     functions work on anything element-shaped, which keeps them
//     testable in bare node (scripts/witness-harness.js) with stub
//     objects.
//   - Versioned. `v: 1` is stamped into every witness so a future shape
//     change can re-fingerprint old rules instead of mis-scoring them.

const WITNESS_VERSION = 1;

// Signals weigh differently because they differ in entropy: an id or
// data-* attribute matching is near-proof, a parent tag matching is
// weak circumstance. Scoring = (matched weight) / (total weight of
// signals PRESENT in the witness) — absent signals don't count against
// a candidate, so a witness captured from a sparse element (no id, no
// text) still verifies on what it has.
//
// NOTE: framework-component-identity (`witness.component`, §8) is NOT scored
// here. It can't be read synchronously (it lives in the page's main world,
// reachable only via the async bridge), and it's a *veto* signal — a confident
// component mismatch means the wrong element, full stop, even if a data-testid
// coincidentally matches, which this tolerant N-of-M average would dilute. So
// the engine verifies it directly via component-id.matchComponent at settle
// time. buildWitness still stores it (it travels on the spec); matchWitness
// just doesn't fold it into the soft score.
const WEIGHTS = {
  attr: 3, // per stable attribute (id / role / aria-label / data-*)
  textStem: 2,
  childTags: 1,
  parentTag: 1,
};

const PASS_THRESHOLD = 0.5;

// Attributes worth remembering — same set the picker treats as stable
// (page-preload's extractElementInfo), minus our own: the engine stamps
// `data-shim-css` / `data-shim-replace-root` / etc. tokens onto anchors
// it mutates, and those tokens differ between the preview apply (where
// the witness is captured) and every committed load (where it's
// verified) — capturing them would make witnesses self-mismatch.
// class is deliberately EXCLUDED too: utility-CSS class lists (Tailwind
// et al) churn on every build, which is exactly the deploy-noise a
// witness must survive.
function isStableAttr(name) {
  if (name.startsWith('data-shim')) return false;
  return name === 'id' || name === 'role' || name === 'aria-label' || name.startsWith('data-');
}

// First ~40 chars of whitespace-normalized text. A stem, not the full
// text: leading content (a label, a heading) is the part humans treat
// as identity; trailing content (counts, timestamps) is the part that
// churns.
//
// Digit runs are stripped BEFORE slicing: numbers inside a stem are live data
// (badge counts, quantities, dates), not identity — a card captured as
// "estimates needing attention94colin's pal…" bakes a badge count and row data
// into the signal, and the prefix tolerance below can't save it once the count
// ticks (the divergence lands mid-stem, so neither side is a prefix of the
// other). Found live: exactly that stem cost witnessRecover a heal it should
// have made, dropping the repair to the LLM tier. Stripping digits keeps the
// stable words and buys 40 chars of actual identity.
const TEXT_STEM_LEN = 40;
// Minimum shared-prefix length for a partial stem match (see matchWitness) —
// long enough that two DIFFERENT normalized labels virtually never share it,
// short enough that a real heading ("estimates needing attention…") clears it.
const STEM_SHARED_PREFIX_MIN = 12;
function normalizeStemText(s) {
  return s.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
}
function sharedPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
function textStemOf(el) {
  const raw = (el.textContent || '').trim().replace(/\s+/g, ' ');
  if (!raw) return '';
  return normalizeStemText(raw.toLowerCase()).slice(0, TEXT_STEM_LEN);
}

// Build a witness from a live element. Returns a plain-JSON object safe
// to embed in the spec. `opts.component` (a descriptor from the main-world
// fiber bridge — §8) is attached when supplied; the isolated world can't read
// fibers itself, so the engine fetches it via api.componentId and passes it in
// here at capture time. Omitted on non-React pages (bridge resolves null).
function buildWitness(el, opts: any = {}) {
  if (!el || !el.tagName) return null;
  const attrs = {};
  for (const attr of el.attributes || []) {
    if (isStableAttr(attr.name)) attrs[attr.name] = attr.value;
  }
  const childTags = [];
  for (const child of el.children || []) {
    if (child.tagName) childTags.push(child.tagName.toLowerCase());
    if (childTags.length >= 8) break; // shape, not census
  }
  const witness: any = {
    v: WITNESS_VERSION,
    tag: el.tagName.toLowerCase(),
  };
  if (Object.keys(attrs).length) witness.attrs = attrs;
  const stem = textStemOf(el);
  if (stem) witness.textStem = stem;
  if (childTags.length) witness.childTags = childTags;
  const parentTag = el.parentElement?.tagName;
  if (parentTag) witness.parentTag = parentTag.toLowerCase();
  if (opts.component && Array.isArray(opts.component.path) && opts.component.path.length) {
    witness.component = opts.component;
  }
  return witness;
}

// Score a candidate element against a witness. Returns
// { pass, score, detail } — `detail` is a per-signal breakdown used in
// quarantine reports ("expected data-testid=cart, saw none").
//
// Unknown witness versions pass unconditionally: an old engine meeting
// a newer witness must not quarantine healthy rules over a shape it
// can't read.
//
function matchWitness(witness, el) {
  if (!witness || witness.v !== WITNESS_VERSION) {
    return { pass: true, score: 1, detail: ['witness missing or unknown version — skipped'] };
  }
  if (!el || !el.tagName) return { pass: false, score: 0, detail: ['no element'] };

  // Hard gate: the tag. A rule anchored to a <button> must never verify
  // against a <section> no matter how the soft signals shake out.
  if (el.tagName.toLowerCase() !== witness.tag) {
    return { pass: false, score: 0, detail: [`tag mismatch: expected <${witness.tag}>, saw <${el.tagName.toLowerCase()}>`] };
  }

  let total = 0;
  let matched = 0;
  const detail = [];

  if (witness.attrs) {
    for (const [name, expected] of Object.entries(witness.attrs)) {
      total += WEIGHTS.attr;
      const actual = el.getAttribute ? el.getAttribute(name) : null;
      if (actual === expected) {
        matched += WEIGHTS.attr;
      } else {
        detail.push(`attr ${name}: expected ${JSON.stringify(expected)}, saw ${actual === null ? 'none' : JSON.stringify(actual)}`);
      }
    }
  }

  // The STORED stem is normalized too: witnesses captured before digit-
  // stripping carry counts/dates in the stem, and comparing them raw against a
  // digit-free live stem would fail every pre-existing witness. Normalizing
  // both sides makes the generations compatible. A stem that normalizes to
  // empty was ALL volatile content (a bare count) — no stable identity signal,
  // so it contributes nothing rather than penalizing the candidate.
  const expectedStem = witness.textStem ? normalizeStemText(witness.textStem) : '';
  if (expectedStem) {
    total += WEIGHTS.textStem;
    const stem = textStemOf(el);
    // Two ways to match:
    //   - containment (one stem is a prefix of the other): "my notes" vs
    //     "my notes (extra)" — the original tolerance.
    //   - a MEANINGFUL SHARED PREFIX: container elements concatenate a stable
    //     heading with volatile body content ("estimates needing attention" +
    //     whatever rows render today), so the two stems diverge mid-string and
    //     neither contains the other — but the long shared head IS the
    //     identity. ≥12 shared chars is far beyond coincidence for normalized
    //     lowercase text, while sibling headings ("estimates …" vs "expenses
    //     …") diverge within a word or two and still fail.
    const shared = sharedPrefixLen(stem, expectedStem);
    if (stem && (shared === Math.min(stem.length, expectedStem.length) || shared >= STEM_SHARED_PREFIX_MIN)) {
      matched += WEIGHTS.textStem;
    } else {
      detail.push(`text: expected "${expectedStem}…", saw "${stem ? stem + '…' : '(empty)'}"`);
    }
  }

  if (witness.childTags) {
    total += WEIGHTS.childTags;
    const tags = [];
    for (const child of el.children || []) {
      if (child.tagName) tags.push(child.tagName.toLowerCase());
      if (tags.length >= 8) break;
    }
    // Multiset overlap ≥ half the expected shape counts as a match —
    // children get added/removed; wholesale replacement is the signal.
    const expected = [...witness.childTags];
    let overlap = 0;
    for (const t of tags) {
      const i = expected.indexOf(t);
      if (i >= 0) { overlap++; expected.splice(i, 1); }
    }
    if (overlap * 2 >= witness.childTags.length) {
      matched += WEIGHTS.childTags;
    } else {
      detail.push(`children: expected [${witness.childTags.join(', ')}], saw [${tags.join(', ')}]`);
    }
  }

  if (witness.parentTag) {
    total += WEIGHTS.parentTag;
    const parentTag = el.parentElement?.tagName?.toLowerCase() || '';
    if (parentTag === witness.parentTag) {
      matched += WEIGHTS.parentTag;
    } else {
      detail.push(`parent: expected <${witness.parentTag}>, saw <${parentTag || 'none'}>`);
    }
  }

  // Tag-only witness (sparse element, nothing else captured): the hard
  // gate above is the entire test.
  if (total === 0) return { pass: true, score: 1, detail: [] };

  const score = matched / total;
  return { pass: score >= PASS_THRESHOLD, score, detail };
}

export { buildWitness, matchWitness, WITNESS_VERSION };
