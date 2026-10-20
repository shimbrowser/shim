// The page tools: the authoring tools that only
// need a page — screenshot, query, inspect, evaluate, console, reload,
// verify, interact. ONE definition per tool, here, for every caller:
//
//   SHIM_PAGE_TOOLS         what the Shim browser's shim worker offers
//   COMPOSITION_PAGE_TOOLS  what its composition worker offers
//   SESSION_PAGE_TOOLS      what @shimbrowser/mcp registers statically for an
//                           external agent (Claude Code) driving a session
//
// The worker wordings are load-bearing: they are part of every internal
// authoring request, and the browser's golden-request harness pins the shim
// roster byte for byte. Each export is a fixed object, so a tool list built
// from them is stable across rounds (the worker compares tool lists by name,
// and the prompt cache by bytes).
//
// The session wording is the same tool for an agent that edits a folder and
// previews it with `shim_preview` instead of emitting deltas: one static
// definition covers both session kinds (D2: no mid-session list_changed), so
// its input schema is the union of the kinds' schemas — a harness pins that
// every property a worker schema has, the session schema has too.
//
// Pure data. No Node, no SDK types: the shape below is structurally an
// Anthropic tool and an MCP tool's (name, description, inputSchema).

/** A JSON-schema object for a tool's input. */
// Type aliases, not interfaces: an alias gets an implicit index signature, so
// it stays assignable to SDK tool types that declare one.
export type ToolInputSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
};

/** One tool as a model sees it. */
export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
};

export type PageToolKind = 'shim' | 'composition';

/** Every page tool, in the order a session registers them. */
export const PAGE_TOOL_NAMES = [
  'view_page',
  'query_page',
  'inspect_element',
  'evaluate_in_page',
  'read_console',
  'reload_page',
  'verify_across_pages',
  'interact_page',
] as const;
export type PageToolName = (typeof PAGE_TOOL_NAMES)[number];

// --- evaluate_in_page ---------------------------------------------------------
//
// Read-only-by-convention JS REPL, for questions the structured tools can't
// answer. A shim's runs in the page's main world — not a new privilege: its
// handlers already run there. A composition's runs in an ISOLATED world over
// the same DOM (the browser's preview-tools.ts isolatedWorldId): the page's
// main world carries `window.api`, whose settings answer decrypted secrets,
// and those must never reach a tool result.
// `lead` is the target-specific opening (what the other tools are, and what
// the page is); the rest is shared.
function makeEvaluateTool(lead: string, emitToolName: string): ToolDefinition {
  return {
    name: 'evaluate_in_page',
    description:
      lead +
      "Pass a single expression, or a statement body that `return`s its " +
      "value (`const els = document.querySelectorAll('a'); return els.length`); " +
      "either runs inside an async function, so `await` works. Return " +
      "primitives or plain objects, NOT " +
      "DOM nodes — DOM nodes JSON-stringify to `{}` and won't help. Use " +
      "`el.textContent`, `el.tagName.toLowerCase()`, `Array.from(NodeList).map(...)` " +
      "etc. instead. DO NOT use this to mutate the page — that's what " +
      `${emitToolName} is for. Capped at 5000 chars input, 8000 chars result, ` +
      "3 seconds wall clock.",
    input_schema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description:
            'A JavaScript expression, or a statement body that `return`s its value. Examples: ' +
            '`document.querySelectorAll(".foo").length` — count, ' +
            '`getComputedStyle(document.querySelector("h1")).color` — read style, ' +
            '`Array.from(document.querySelectorAll("[role=button]")).map(b => b.textContent.trim()).slice(0, 10)` — sample.',
        },
      },
      required: ['expression'],
    },
  };
}

// --- the shim worker's page tools ---------------------------------------------

// query_page is the escape hatch for when the pre-baked page outline doesn't
// cover the element the user described (visual cue, position, name not in
// outline). The model calls it, the page-preload runs a scored DOM scan, and
// returns candidates. The model picks the right one on the next round and
// emits the delta.
const SHIM_QUERY_PAGE: ToolDefinition = {
  name: 'query_page',
  description:
    'Search the current page for elements matching a natural-language ' +
    'description. Use this when the page outline does not show the element ' +
    'the user is asking about — for instance when they describe something ' +
    'by visual cue ("the pink banner"), by position ("the third card"), or ' +
    'by a name that is not in the outline. Returns up to ~25 visible ' +
    'elements ranked by relevance, each with selectors, markup, bounding ' +
    'rect, and computed style. You decide which candidate is the right ' +
    'target and then emit the delta.',
  input_schema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description:
          'Natural-language description of the element to find. Be specific ' +
          'but brief (e.g. "pink promo banner at top", "footer links section").',
      },
    },
    required: ['description'],
  },
};

// Read the page console captured during this turn. The emit feedback
// already carries errors/warnings since the last apply automatically; this is
// the on-demand deeper pull — info-level logs, full repetition, longer
// history. Read-only, main-side; no page interaction.
const SHIM_READ_CONSOLE: ToolDefinition = {
  name: 'read_console',
  description:
    'Read the browser console messages captured since this turn started. ' +
    'Use when diagnosing breakage — failed network requests (site rate ' +
    'limiting shows up here as 4xx/5xx resource errors), uncaught ' +
    'exceptions, or a widget silently not updating. Lines are tagged ' +
    '[site] or [shim <handler>]. The emit feedback already includes ' +
    'errors/warnings automatically — call this for info-level output or ' +
    'full detail.',
  input_schema: {
    type: 'object',
    properties: {
      level: { type: 'string', enum: ['error', 'warning', 'all'], description: 'Minimum severity filter. Default all.' },
      limit: { type: 'number', description: 'Max lines, newest kept. Default 50.' },
    },
  },
};

// Inspect a single element by CSS selector mid-turn. The page outline +
// query_page give breadth (lots of candidates by description); this gives
// depth (everything about one element): the first match, the total count,
// and the full extractElementInfo payload — the same `descendants` +
// `boundingRect` + computed style as the picker, so the model can see what's
// nested inside before deciding the rule's anchor.
const SHIM_INSPECT_ELEMENT: ToolDefinition = {
  name: 'inspect_element',
  description:
    "Get rich detail about one element on the current page by CSS selector. " +
    "Returns its tag, all stable attributes, computed style, bounding rect, " +
    "ancestry, descendants (2-level outline of children), and how many " +
    "other elements match the same selector. Use this when the page outline " +
    "shows a hint of the element but you need to see its real attributes / " +
    "structure / computed style before writing the rule — for example, to " +
    "see what's nested inside a list container, or to confirm a class name " +
    "you saw in the outline still matches. If the selector matches multiple, " +
    "returns the first + total count. Returns `found: false` when nothing " +
    "matches — call query_page or ask the user to pick.",
  input_schema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description:
          'CSS selector to inspect (e.g. `[data-testid="cart"]`, `#sidebar > h2`). ' +
          'Should resolve to one specific element or a small list of identical ones.',
      },
    },
    required: ['selector'],
  },
};

const SHIM_EVALUATE_IN_PAGE: ToolDefinition = makeEvaluateTool(
  "Evaluate a JavaScript expression in the page's main world and return " +
  "its value. Use sparingly, only when other tools (page outline, " +
  "query_page, inspect_element) can't answer the question — examples: " +
  "count of elements matching a computed criterion, getComputedStyle of a " +
  "specific property, the text of a deep descendant, sampling site " +
  "globals to understand the page. ",
  'emit_shim_delta',
);

// Last-resort lookup for purely visual targets the structured tools can't pin
// down — icon-only buttons, image-heavy layouts, position descriptions like
// "the third card" — and the visual check after a visual change. The browser
// captures the tab's viewport, downscales it to ~1280px wide (a typical
// authoring window is 1440), and returns it as an image block.
const SHIM_VIEW_PAGE: ToolDefinition = {
  name: 'view_page',
  description:
    "Take a screenshot of the current page and view it directly. Two jobs: " +
    "(1) VISUAL VERIFICATION — after applying a change whose intent is " +
    "visual (size, alignment, spacing, color, position, 'make X look like " +
    "Y'), screenshot the result BEFORE ending the turn and judge it with " +
    "your own eyes; a clean apply proves the rule attached, not that it " +
    "looks right. Pass `selector` (CSS, the element you changed or its " +
    "container) to crop to that element plus context margin — a zoomed " +
    "crop is far more legible than the full viewport for fine judgments " +
    "and much cheaper. (2) LAST-RESORT visual lookup when the outline, " +
    "query_page, and inspect_element can't pin down what the user is " +
    "referring to (icon-only buttons, 'the third card', branded wordmarks). " +
    "Omit `selector` for the full visible viewport (scrolled-out content " +
    "isn't included). After a lookup, ALWAYS write the rule using a " +
    "structural tool (query_page / inspect_element / picker suggestion) — " +
    "never emit selectors based on pixel positions.",
  input_schema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description:
          'Optional CSS selector to crop the screenshot to (element + context margin, native resolution). ' +
          'Use for verifying a specific element you just changed. Omit for the full viewport.',
      },
    },
  },
};

// Recovery, not an info-gathering primitive: get the bound tab back to a
// state the other tools can verify against. It takes NO destination — the
// reload only ever reloads in place or returns to the target's own page.
// Bounded at 3 uses per turn.
const SHIM_RELOAD_PAGE: ToolDefinition = {
  name: 'reload_page',
  description:
    'Reload the page to recover a known-broken state, then re-establish ' +
    'this turn\'s live previews on the fresh page. Two uses: (1) RECOVERY ' +
    'after a destructive mistake — e.g. a handler moved or removed live ' +
    'site DOM and teardown broke the page; a reload restores the site\'s ' +
    'own content, and the result tells you how many of your previews were ' +
    're-applied. (2) RETURN after a `page-away` error — the user navigated ' +
    'this tab off the shim\'s site mid-turn; this brings the tab back to ' +
    'the page the turn started on. It never navigates anywhere else. ' +
    'Result: { ok, url, reapplied } — `url` is the page you are now ' +
    'looking at, `reapplied` counts the preview rules pushed back. After a ' +
    'reload, re-verify with the usual tools before ending the turn. Limit ' +
    '3 per turn — it is a recovery tool, not part of the normal apply loop.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

// Multi-page verification: a checklist, not a crawl. It never navigates
// anywhere new — it replays the CURRENT shim's rules (the working spec,
// including not-yet-committed edits) against routes the user has ALREADY
// visited on this host, offscreen, and reports per-route / per-rule match
// verdicts.
const SHIM_VERIFY_ACROSS_PAGES: ToolDefinition = {
  name: 'verify_across_pages',
  description:
    "verify the current shim's rules across the OTHER page-types you've " +
    'visited on this site (feed, search, profile, …) — a checklist over ' +
    'already-visited routes, never a crawl. Use after a change whose ' +
    'target recurs across views, to confirm coverage before reporting ' +
    'done.',
  input_schema: {
    type: 'object',
    properties: {
      routes: {
        type: 'array',
        description:
          'Optional list of specific path templates to check (as seen in ' +
          'the page outline / your own knowledge of this site\'s routes, ' +
          'e.g. "/user/:id", "/search"). Omit to check every route you ' +
          'have visited on this host, up to a small cap.',
        items: { type: 'string' },
      },
    },
  },
};

export const SHIM_PAGE_TOOLS = {
  query_page: SHIM_QUERY_PAGE,
  inspect_element: SHIM_INSPECT_ELEMENT,
  evaluate_in_page: SHIM_EVALUATE_IN_PAGE,
  view_page: SHIM_VIEW_PAGE,
  reload_page: SHIM_RELOAD_PAGE,
  verify_across_pages: SHIM_VERIFY_ACROSS_PAGES,
  read_console: SHIM_READ_CONSOLE,
} as const satisfies Partial<Record<PageToolName, ToolDefinition>>;

// --- the composition worker's page tools --------------------------------------
//
// The same jobs against the composition's own live preview instead of a live
// site tab.

const COMPOSITION_QUERY_PAGE: ToolDefinition = {
  name: 'query_page',
  description:
    'Search the composition preview for elements matching a natural-language ' +
    'description. Use this when you need to find something on the page you ' +
    'are building without guessing selectors by hand — for instance a ' +
    'specific card, button, or section by its text, id, class, aria-label, ' +
    'placeholder or alt text. Returns up to 25 visible elements ranked by ' +
    'how many of your words they match, each with a CSS selector, its tag, ' +
    'its text (first 200 chars) and its bounding rect.',
  input_schema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Natural-language description of the element to find.',
      },
    },
    required: ['description'],
  },
};

const COMPOSITION_INSPECT_ELEMENT: ToolDefinition = {
  name: 'inspect_element',
  description:
    'Get rich detail about one element in the composition preview by CSS ' +
    'selector: tag, attributes, bounding rect, a few computed style values ' +
    '(display, position, color, background, font size, width, height), up ' +
    'to 8 ancestors, its child count, and how many elements match the ' +
    'selector. Use ' +
    'this to confirm structure/style before editing a file, or to debug why ' +
    'something does not look right. Returns `found: false` when nothing ' +
    'matches.',
  input_schema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector to inspect.',
      },
    },
    required: ['selector'],
  },
};

const COMPOSITION_INTERACT_PAGE: ToolDefinition = {
  name: 'interact_page',
  description:
    'Use the composition preview the way the user would: click, type into a ' +
    'field, pick an option in a <select>, or press a key. Clicks and typing ' +
    'are real (trusted) input. Up to 10 actions run in order; each selector ' +
    'must match exactly one visible, enabled, uncovered element, or that ' +
    'action fails and the rest do not run. A navigation ends the batch. The ' +
    'result reports each action, how many DOM changes followed, new console ' +
    'errors, the calls the page made, and any link it tried to open (link ' +
    'clicks open no tab during a build). Afterwards check the outcome with ' +
    'query_page / inspect_element and view_page — the report says what ' +
    'happened, not whether it was right. While you build, the page\'s ' +
    'api.storage / api.db writes are refused (authoring-read-only), ' +
    'so a save shows the page\'s failure path; network writes are refused too ' +
    '(api.ai runs, and may wait on the user\'s consent card). ' +
    'In documents loaded during the build, localStorage / sessionStorage are ' +
    'in-memory copies of the real ones and indexedDB refuses to open. Every ' +
    'such document is replaced when the build ends, so nothing you do here ' +
    'reaches the user\'s data.',
  input_schema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        description: 'The actions, in order (1–10). Each is exactly one of: {"click": selector}, {"type": selector, "text": string, "clear"?: boolean}, {"select": selector, "value": option value or label}, {"press": "Enter"|"Escape"|"Tab"|"Backspace"|"Delete"|"Space"|"ArrowUp"|"ArrowDown"|"ArrowLeft"|"ArrowRight"}.',
        items: { type: 'object' },
      },
      settleMs: {
        type: 'number',
        description: 'How long to wait after each action before the next (default 300, max 3000).',
      },
    },
    required: ['actions'],
  },
};

const COMPOSITION_READ_CONSOLE: ToolDefinition = {
  name: 'read_console',
  description:
    'Read the composition preview\'s console messages captured since this ' +
    'turn started. Use when diagnosing breakage — failed fetches, uncaught ' +
    'exceptions, a widget silently not updating.',
  input_schema: {
    type: 'object',
    properties: {
      level: { type: 'string', enum: ['error', 'warning', 'all'], description: 'Minimum severity filter. Default all.' },
      limit: { type: 'number', description: 'Max lines, newest kept. Default 50.' },
    },
  },
};

const COMPOSITION_EVALUATE_IN_PAGE: ToolDefinition = makeEvaluateTool(
  "Evaluate a JavaScript expression against the composition preview's " +
  "DOM and return its value. It runs in an isolated world: the DOM is " +
  "shared, but the page's own JS globals and `window.api` are NOT visible " +
  "— read runtime state through what the page renders (a rendered list's " +
  "length, a data-* attribute your code sets). Use when query_page / " +
  "inspect_element / read_file can't answer the question — examples: count " +
  "of elements matching a computed criterion, getComputedStyle of a " +
  "specific property, the text of a deep descendant. ",
  'emit_composition_delta',
);

const COMPOSITION_RELOAD_PAGE: ToolDefinition = {
  name: 'reload_page',
  description:
    'Reload the composition preview to recover a known-broken state. Two ' +
    'uses: (1) RECOVERY when the running page is stuck in a state a fresh ' +
    'load would clear — a runaway script, a half-initialized widget, stale ' +
    'in-memory state from an earlier version of your files; a reload runs ' +
    'the composition\'s current files from scratch (every applied emit is ' +
    'already saved, so nothing is lost). (2) RETURN after a `page-away` ' +
    'error — the preview tab was navigated off the composition mid-turn; ' +
    'this brings it back to the composition. It never navigates anywhere ' +
    'else. Result: { ok, url } — `url` is the page you are now looking at. ' +
    'After a reload, re-verify with the usual tools before ending the turn. ' +
    'Limit 3 per turn — it is a recovery tool, not part of the normal ' +
    'apply loop (every emit already reloads the preview).',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

const COMPOSITION_VIEW_PAGE: ToolDefinition = {
  name: 'view_page',
  description:
    'Take a screenshot of the composition preview and view it directly. Use ' +
    'this to visually verify a change whose intent is visual (layout, ' +
    'spacing, color, "make X look like Y") — a clean apply proves the files ' +
    'changed, not that it looks right. Pass `selector` to crop to one ' +
    'element plus context; omit for the full visible viewport.',
  input_schema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'Optional CSS selector to crop the screenshot to. Omit for the full viewport.',
      },
    },
  },
};

// The composition meaning of the shim's verify_across_pages: load the
// composition's OWN pages and report load + console errors.
const COMPOSITION_VERIFY_ACROSS_PAGES: ToolDefinition = {
  name: 'verify_across_pages',
  description:
    "Load each of this composition's HTML pages in the preview, one after " +
    'another, and report per page whether it loaded and the console ' +
    'errors/warnings it logged while loading; the preview is returned to ' +
    'where it was afterwards. Use after a change that more than one page ' +
    'depends on (a shared script or stylesheet, the manifest) to confirm the ' +
    'OTHER pages still work before reporting done. A load check, not a ' +
    'visual one — view_page for anything visual. Up to 6 pages per call, ' +
    'twice per turn.',
  input_schema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        description:
          'Optional: specific HTML files to check (e.g. "settings.html"). Omit ' +
          'to check every HTML page, the entry first.',
        items: { type: 'string' },
      },
    },
  },
};

export const COMPOSITION_PAGE_TOOLS = {
  query_page: COMPOSITION_QUERY_PAGE,
  inspect_element: COMPOSITION_INSPECT_ELEMENT,
  interact_page: COMPOSITION_INTERACT_PAGE,
  read_console: COMPOSITION_READ_CONSOLE,
  evaluate_in_page: COMPOSITION_EVALUATE_IN_PAGE,
  reload_page: COMPOSITION_RELOAD_PAGE,
  view_page: COMPOSITION_VIEW_PAGE,
  verify_across_pages: COMPOSITION_VERIFY_ACROSS_PAGES,
} as const satisfies Record<PageToolName, ToolDefinition>;

// --- the session (external agent) wording ---------------------------------------
//
// An external agent works in a folder: it edits files and calls `shim_preview`,
// which applies the whole working copy to the session's page and answers with
// evidence. It has no page outline and no picker. One description per tool
// covers both session kinds; where the kinds differ, the description says so.

const SESSION_VIEW_PAGE: ToolDefinition = {
  name: 'view_page',
  description:
    "Take a screenshot of the session's page (the site tab for a shim session, " +
    'the composition preview for a composition session) and view it directly. ' +
    'Two jobs: (1) VISUAL VERIFICATION — after a shim_preview whose intent is ' +
    "visual (size, alignment, spacing, color, position, 'make X look like Y'), " +
    'screenshot the result BEFORE you report done and judge it with your own ' +
    'eyes; a clean preview proves the rule attached, not that it looks right. ' +
    'Pass `selector` (CSS, the element you changed or its container) to crop ' +
    'to that element plus context margin — far more legible for fine ' +
    'judgments, and smaller. (2) LAST-RESORT visual lookup when query_page and ' +
    "inspect_element can't pin down the target (icon-only buttons, 'the third " +
    "card'). Omit `selector` for the visible viewport (scrolled-out content " +
    'is not included; full-viewport shots are downscaled to 1280px wide). ' +
    'After a lookup, write anchors from a structural tool (query_page / ' +
    'inspect_element) — never from pixel positions.',
  input_schema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description:
          'Optional CSS selector to crop the screenshot to (element + context margin, native resolution). ' +
          'Use for verifying a specific element you just changed. Omit for the full viewport.',
      },
    },
  },
};

const SESSION_QUERY_PAGE: ToolDefinition = {
  name: 'query_page',
  description:
    "Search the session's page for elements matching a natural-language " +
    'description — by text, visual cue ("the pink banner"), position ("the ' +
    'third card"), id, class, aria-label, placeholder or alt text. Returns up ' +
    'to ~25 visible elements ranked by relevance, each with selectors and a ' +
    'bounding rect (on a site page also markup and computed style). Pick the ' +
    'right candidate, confirm it with inspect_element, then write the anchor.',
  input_schema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description:
          'Natural-language description of the element to find. Be specific ' +
          'but brief (e.g. "pink promo banner at top", "footer links section").',
      },
    },
    required: ['description'],
  },
};

const SESSION_INSPECT_ELEMENT: ToolDefinition = {
  name: 'inspect_element',
  description:
    "Get rich detail about one element on the session's page by CSS selector: " +
    'its tag, stable attributes, computed style, bounding rect, ancestry, ' +
    'descendants, and how many other elements match the same selector. Use ' +
    'it before writing an anchor, to see the real attributes and structure ' +
    '(what is nested inside a list container, whether a class still matches). ' +
    'If the selector matches several, returns the first plus the total ' +
    'count. Returns `found: false` when nothing matches — try query_page.',
  input_schema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description:
          'CSS selector to inspect (e.g. `[data-testid="cart"]`, `#sidebar > h2`). ' +
          'Should resolve to one specific element or a small list of identical ones.',
      },
    },
    required: ['selector'],
  },
};

const SESSION_EVALUATE_IN_PAGE: ToolDefinition = makeEvaluateTool(
  "Evaluate a JavaScript expression in the session's page and return its " +
  "value. On a shim session it runs in the page's main world, as the " +
  'logged-in user — anything it does to the site is real and is not undone ' +
  "when the session ends. On a composition session it runs in an isolated " +
  "world over the preview's DOM: the page's own globals and `window.api` are " +
  'not visible. Use sparingly, only when query_page / inspect_element ' +
  "can't answer the question — examples: count of elements matching a " +
  'computed criterion, getComputedStyle of a specific property, sampling ' +
  'site globals to understand the page. ',
  'shim_preview',
);

const SESSION_READ_CONSOLE: ToolDefinition = {
  name: 'read_console',
  description:
    "Read the console messages the session's page logged since the session " +
    'started. Use when diagnosing breakage — failed network requests, ' +
    'uncaught exceptions, a widget silently not updating. On a site page, ' +
    'lines are tagged [site] or [shim <handler>]. shim_preview evidence ' +
    'already carries the errors and warnings since the previous preview — ' +
    'call this for info-level output or full detail.',
  input_schema: {
    type: 'object',
    properties: {
      level: { type: 'string', enum: ['error', 'warning', 'all'], description: 'Minimum severity filter. Default all.' },
      limit: { type: 'number', description: 'Max lines, newest kept. Default 50.' },
    },
  },
};

const SESSION_RELOAD_PAGE: ToolDefinition = {
  name: 'reload_page',
  description:
    "Reload the session's page to recover a known-broken state, then " +
    're-establish the previewed work on the fresh page. Two uses: (1) ' +
    'RECOVERY after a destructive mistake (a handler moved or removed live ' +
    'site DOM and teardown broke the page; a runaway script in a ' +
    'composition). (2) RETURN after a `page-away` error — the tab was ' +
    'navigated off the session\'s site; this brings it back to the page the ' +
    'session started on. It never navigates anywhere else. Re-verify with ' +
    'the usual tools afterwards. Limited to a few uses per session — it is ' +
    'a recovery tool, not part of the normal preview loop.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

const SESSION_VERIFY_ACROSS_PAGES: ToolDefinition = {
  name: 'verify_across_pages',
  description:
    "Check the previewed work beyond the current page. Shim session: replays " +
    "the working shim's rules against the OTHER page-types already visited " +
    'on this site (feed, search, profile, …), offscreen, and reports per ' +
    'route and per rule whether each matched — a checklist over visited ' +
    'routes, never a crawl. Composition session: loads each of the ' +
    "composition's HTML pages and reports whether it loaded and the console " +
    'errors it logged. Use after a change whose target recurs across views, ' +
    'before reporting done.',
  input_schema: {
    type: 'object',
    properties: {
      routes: {
        type: 'array',
        description:
          'Shim sessions: optional list of path templates to check (e.g. ' +
          '"/user/:id", "/search"). Omit to check every visited route on ' +
          'this host, up to a small cap.',
        items: { type: 'string' },
      },
      paths: {
        type: 'array',
        description:
          'Composition sessions: optional list of HTML files to check (e.g. ' +
          '"settings.html"). Omit to check every HTML page, the entry first.',
        items: { type: 'string' },
      },
    },
  },
};

const SESSION_INTERACT_PAGE: ToolDefinition = {
  name: 'interact_page',
  description:
    'Composition sessions only (a shim session answers that the tool is not ' +
    'offered). Use the composition preview the way the user would: click, ' +
    'type into a field, pick an option in a <select>, or press a key. Clicks ' +
    'and typing are real (trusted) input. Up to 10 actions run in order; each ' +
    'selector must match exactly one visible, enabled, uncovered element, or ' +
    'that action fails and the rest do not run. A navigation ends the batch. ' +
    'The result reports each action, how many DOM changes followed, new ' +
    'console errors, the calls the page made, and any link it tried to open. ' +
    'Afterwards check the outcome with query_page / inspect_element and ' +
    'view_page — the report says what happened, not whether it was right. ' +
    "While a session holds the composition, the page's storage, database and " +
    'network writes are refused, and so are its api.ai calls; nothing you do ' +
    "here reaches the user's data.",
  input_schema: COMPOSITION_INTERACT_PAGE.input_schema,
};

export const SESSION_PAGE_TOOLS = {
  view_page: SESSION_VIEW_PAGE,
  query_page: SESSION_QUERY_PAGE,
  inspect_element: SESSION_INSPECT_ELEMENT,
  evaluate_in_page: SESSION_EVALUATE_IN_PAGE,
  read_console: SESSION_READ_CONSOLE,
  reload_page: SESSION_RELOAD_PAGE,
  verify_across_pages: SESSION_VERIFY_ACROSS_PAGES,
  interact_page: SESSION_INTERACT_PAGE,
} as const satisfies Record<PageToolName, ToolDefinition>;

export function isPageToolName(name: string): name is PageToolName {
  return (PAGE_TOOL_NAMES as readonly string[]).includes(name);
}
