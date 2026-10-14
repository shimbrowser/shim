---
name: shim-authoring
description: How to author Shim shims — modifications to a live website, applied by the Shim browser — and Shim compositions — small local web apps over the user's sites — from Claude Code through the shim MCP tools. Use whenever the user asks to change, hide, restyle, add to or rebuild part of a website in Shim, to work on an existing shim, or to build or change a composition. Covers the session loop (open, check out, edit the folder, preview, verify, commit), the shim folder format, every mutation kind, anchors, the runtime api handlers get, the composition manifest, folder and window.api, and the evidence each preview returns.
---

# Authoring Shim shims

Shim is a browser that applies **shims** — small, declarative modifications — to live
websites, for one user, in their own browser. A shim is a JSON spec of **rules**: each rule
finds an element on the page (its **anchor**) and applies **mutations** to it (hide it,
restyle it, mount a widget beside it, …). Behavior lives in **handlers**: JavaScript
functions the rules name. Shim re-applies shims on every visit and keeps them attached
across the site's own re-renders and deploys.

You author a shim by editing it **as a folder** while Shim applies every saved state of the
folder to the real page, in the user's logged-in tab. The loop is the product: change the
files, preview, look at what actually happened, fix, and commit only what you verified.

Shim also serves **compositions**: whole pages you write from scratch, which read the
user's sites through `window.api`. They use the same session loop with a different folder;
section 9 covers what differs. Section 10 covers headless mode, which runs without the Shim
browser.

## 1. The session loop

1. **Find Shim.** `shim_status`; if it isn't running, `shim_launch`. Shim's control
   endpoint is off by default — launching turns it on for this run; the user can also turn
   it on in Shim's Settings.
2. **Pick the tab.** `shim_list_tabs` lists every open tab with its `tabId`, URL and, for a
   site tab, the shims that already run on its host. Work against the tab showing the page
   the user means.
3. **Open a session.** `shim_open_session { tabId, intent, shimId | newShimName, dir }`.
   - `shimId` refines an existing shim; `newShimName` starts a new one on the tab's site
     (it is kept only if you commit).
   - `intent` is one or two sentences of what you set out to do. The user sees it on the
     card in Shim and it is recorded in the shim's chat when you commit.
   - The user is asked in Shim to allow the session, and the call waits (up to two
     minutes). If they decline, do not retry unless they ask you to.
   - With `dir` (an absolute path to an empty folder, or an earlier checkout) the shim is
     checked out at once. Otherwise call `shim_checkout { dir }`.
4. **Edit the folder** (section 2): `shim.json` and `handlers/<name>.js`.
5. **Preview.** `shim_preview` sends the whole folder; Shim lints it, applies the
   difference to the live page, waits for it to settle and answers with a **revision** and
   **evidence** (section 3). Read the evidence before anything else. Fix what failed and
   preview again — as many times as you need.
6. **Verify visual changes with your own eyes.** For anything about how the page looks
   (section 3), a clean preview is not success: call `view_page` with a `selector`, or pass
   `screenshot: true` (and `selector`) to `shim_preview`, and judge the result.
7. **Commit.** `shim_commit { summary }` saves the latest preview as a new version of the
   shim. `summary` is what changed and why, in a few sentences — it becomes your reply in
   the shim's chat. If the work declares something sensitive (a redirect target, a remote
   database connection) the user approves it in Shim first, and the call waits.
8. **End.** `shim_end_session`. Anything previewed after the last commit is discarded and
   the page returns to the shim as committed.

What to know about a session:

- **The shim is yours alone while it is open**, and only one session or turn can hold a
  shim. Shim ends the session after 10 idle minutes, when the user presses stop, or when
  they start their own turn on that shim in Shim's sidebar; the next call answers
  `session-ended`. Open a new session if there is more to do.
- **Revisions.** Checkout is revision 0; every preview that changed something takes the
  next number; a folder that changes nothing takes none. `shim_commit` commits the latest
  revision by default; naming an older one answers `stale-revision`.
- **Commit is safe to retry.** It carries a `commitId`; a retry with the same id returns
  the first result and never commits twice. A refused commit (declined card, two-minute
  timeout) leaves the session open with your work still previewed.
- **Your previews act on the real site.** Handlers run in the user's logged-in page, and
  `evaluate_in_page` runs there too. Anything they do to the site — a click, a form
  submission, a request that changes data — is real and is not undone when the session
  ends. Read freely; never take actions on the user's account they didn't ask for.
- **Shim never uses your Claude Code login**, and a session never spends the user's own
  Anthropic key.

## 2. The shim folder

```
shim.json              the spec; rules name their handlers
handlers/<name>.js     one handler per file
```

`shim.json`:

```json
{
  "id": "k3j2h1",
  "match": { "hosts": ["example.com"] },
  "intent": "Hides the promo strip and tags each track row the user has already played.",
  "rules": [
    {
      "id": "hide-promo",
      "anchor": { "primary": { "kind": "data-attr", "name": "data-testid", "value": "promo-strip" } },
      "mutations": [{ "kind": "hide" }]
    },
    {
      "id": "mark-played",
      "anchor": { "primary": { "kind": "css", "value": ".track-row" } },
      "mutations": [{ "kind": "script", "handler": "markPlayed", "mount": { "strategy": "portal" } }]
    }
  ]
}
```

`handlers/markPlayed.js`:

```js
module.exports = function markPlayed({ anchor, api }) {
  const badge = document.createElement('span');
  badge.textContent = '✓ played';
  return badge;
};
```

Rules of the folder:

- **Rules name handlers; the source lives in `handlers/<name>.js`.** A mutation names a
  handler with `handler` (`script`, `replace-root`, `mount-route`), `transform`
  (`rewrite-response`) or `wrap` (`intercept`). Each file is `module.exports = <function>;`.
  Helper functions may sit above the export in the same file.
- **Handler names are unique across the shim** and are file names: letters, digits, `_`,
  `$`, `-`, not starting with `-`. Two rules can share one handler by naming it. Names must
  also be portable file names: `__proto__` and the Windows device names (`con`, `prn`,
  `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9`, in any case) are refused, and two names that
  differ only in case (`markPlayed` and `markplayed`) count as the same name.
- **Rule ids** are short kebab-case slugs, unique within the shim (`hide-sidebar`,
  `teal-underline-h1`).
- **What you may change:** `rules`, and the declarations `intent`, `settings`,
  `permissions`, `storage`, `connections`. `id` and `match` are fixed for a session; changing
  them is refused as `not-editable`.
- **On a global shim** (`"global": true`), you may also change `sharedHandlers`: an object
  of function sources (`{ "<name>": "function <name>(…) { … }" }`, never `__proto__`) that
  every site's handlers call as `api.shared.<name>(…)`. It is the one piece of code every
  site shares, so it evolves carefully: **add** a new function for new common logic rather
  than changing an existing one; when you edit one, keep its inputs and outputs the same
  (a parameter-list change draws a warning); when one site needs different behavior, wrap
  the shared function in that site's own handler instead of editing it. Removing or
  renaming a shared function that any site's handlers still call is refused at commit. On
  any other shim `sharedHandlers` is `not-editable`.
- **What never goes in the folder:** `version`, `bundleHash`, anchor `witness` fields and
  inline `handlers` maps — Shim manages those. Writing one is refused as a malformed
  folder. Hidden files (`.git`, `.shim-state.json`, editor swap files) are ignored; any
  other unexpected file is refused.
- **Rules keep the folder's order.** Moving a rule in `shim.json` moves it in the shim.
- **Set `intent`.** Every shim should carry a one-paragraph statement of purpose — the
  goal and what it acts on, in plain language. Write it for a new shim, refresh it when the
  purpose materially changes. Never put secrets or the user's data in it: it travels when
  the shim is shared, and Shim uses it to repair the shim when the site changes.

## 3. The evidence, and the verification duty

Every `shim_preview` answers `{ revision, applied, evidence }`. On an applied preview:

| Field | What it says |
|---|---|
| `changes` | what the folder changed: `add-rule <id>`, `update-rule <id>`, `remove-rule <id>`, `set-settings`, … |
| `rules[]` | per changed rule: `status` — did the anchor resolve, how many elements, via which anchor, and the matched element's **measured box** (`W×Hpx at (x, y)`, viewport CSS px, measured after your mutation applied); and `verification` (`full` or `partial`) |
| `errors[]` | handler exceptions: `{ ruleId, handler, message, stack }` |
| `noMatch[]` | anchors that resolved nothing |
| `warnings[]` | lint warnings (unknown fields, brittle anchors, an observer that watches what it mutates) and unused handler files |
| `notes[]` | outcomes Shim reports about consent and capabilities |
| `console` | errors and warnings the page logged since the previous preview |

A refused preview answers `applied: false` with `rejected` or `error` (and `problems` for a
malformed folder): nothing was applied. Fix and preview again.

Read the evidence, then:

- **A handler threw** → fix the bug in its file.
- **Matched 0 elements** → the anchor is wrong. Re-locate with `query_page` /
  `inspect_element`; never re-send the same anchor hoping for a different result.
- **A `[site]` error storm in `console`** right after your change usually means your handler
  caused it (a fetch burst, broken hydration, a loop) — fix the cause.
- **`verification: partial`** means something in the rule's check couldn't be confirmed on
  this host. Tell the user that rule is unverified. (The Shim browser checks everything, so
  in a Shim session this is rare.)
- **Clean** → stop iterating unless the user asked for something you haven't delivered.

**Visual intents require visual verification — a clean preview is not enough.** When the
ask is about how something looks — size, alignment, spacing, color, position, "make X
match Y", any layout change, a `replace-root` or `mount-route` page — the match count only
proves the rule attached. **Adding a new visible control (a button, link, badge, panel) is
a visual intent even when the ask reads as behavioral.** Before you commit:

1. **Numbers first.** For measurable claims ("same size as", "align with", "25% smaller"),
   compare the measured box in the evidence with `inspect_element`'s `boundingRect` of the
   reference element. 26×26 is not 20×20; you don't need a screenshot to know that.
2. **Then look.** `view_page { selector }` on the element you changed (a crop at native
   resolution, with context) and judge it honestly against the user's words. For an
   element you added, check it against the neighboring site controls in the same shot: does
   it read as native, or bolted on? If it doesn't match, fix and look again.

For non-visual intents (behavior, data, hide-this-element) the evidence numbers are the
whole story; don't screenshot for its own sake. If you say you are going to look, look.

**If the user repeats an ask you already addressed**, your previous attempt probably
landed on the wrong element. Look (`view_page`, or `inspect_element` on your rule's
anchor) before defending it.

## 4. The page tools

All of them act on the session's tab.

- **`query_page { description }`** — natural-language search for elements: by text,
  visual cue ("the pink banner"), position ("the third card"), id, class, aria-label.
  Returns ranked candidates with suggested anchors (strongest first), markup, bounding rect
  and computed style. Use it before writing any anchor you haven't seen on the real page.
  **Never invent class names.**
- **`inspect_element { selector }`** — everything about one element: tag, stable
  attributes, computed style, bounding rect, ancestry, two levels of descendants, and how
  many elements the selector matches. Use it to confirm structure before writing a handler
  that works on descendants, and to measure reference elements.
- **`evaluate_in_page { expression }`** — a read-only JavaScript REPL in the page's main
  world (`await` works). Return primitives or plain objects, not DOM nodes. For counts
  under a computed criterion, `getComputedStyle`, sampling site globals. Never use it to
  change the page — that is what the folder is for — and remember it runs as the user.
  Capped at 5000 characters in, 8000 out, 3 seconds.
- **`view_page { selector? }`** — a screenshot, as an image. With `selector`, a crop of that
  element plus margin at native resolution (the verification shot); without, the visible
  viewport downscaled to 1280px wide (a last-resort visual lookup — for icon-only buttons,
  branded wordmarks, "the one that looks like X"). After a lookup, write the anchor from a
  structural tool, never from pixel positions.
- **`read_console { level?, limit? }`** — the page's console since the session started,
  including info-level lines. Lines are tagged `[site]` or `[shim <handler>]`.
- **`reload_page`** — recovery only: reload the tab and re-apply your previews. Use it
  after a destructive mistake (a handler moved or removed site DOM and teardown broke the
  page — fix the rule first, then reload) or after a `page-away` error (the user navigated
  the tab off the site; every page tool refuses rather than touching the wrong page). It
  never navigates anywhere else, and it is limited to a few uses per session.
- **`verify_across_pages { routes? }`** — replays the working shim's rules against the
  *other* page-types the user has already visited on this site (feed, search, profile, …),
  offscreen, and reports per route and per rule whether each matched. A checklist over
  visited routes, never a crawl. Use it after a clean preview when the target recurs across
  views ("on every post"). Report honestly: matched → verified there; your rule no-match
  → it does not apply there (likely different markup); unvisited page-types → unverified.
- `interact_page` is for composition sessions (section 9); a shim session answers that it
  isn't offered. So are `probe_request` and `read_calls`.

### The site's own API: the API map tools

When the user has Discovery on, Shim records the *shape* of the requests a site's own
pages make — endpoints, query and response schemas, one-line summaries — into a local API
map. When a shim needs the site's data (a column the list doesn't show, a count, a
"favorite" action), read the map instead of guessing URLs. Access is the user's to give,
in two levels, each on a card in Shim (the call waits for the answer):

- **`list_discovered_hosts`** — the *names* of the sites with a recorded map, and which this
  session may already read. The first call in a session asks the user to share the list;
  it reveals nothing about any site. Use it when you need to suggest a source; skip it
  when you already know the site (usually the tab's own host).
- **`request_sources { hosts, why }`** — asks for the named sites' content (up to 10 per
  call). Granted sites last for the session; the user can revoke one at any time from
  Shim, and every later call for it answers `host-not-granted`. The answer lists what was
  granted and which of those have no recorded map yet (`noApiMap`).

Then, for a granted site only — every call names its `host`:

- **`search_discovered_api { description, host? }`** — natural-language search over the
  granted sites' endpoints ("track details", "add to favorites"): up to 10 ranked
  candidates with their `id`, method, path template, summary and sample count. Breadth
  only.
- **`inspect_endpoint { host, endpointId | template, method? }`** — the endpoint's
  inferred query and response schemas (and a GraphQL endpoint's introspected schema).
  **Schema only** — captured bodies never leave Shim. Read it before writing a handler
  that calls the endpoint, and take field names from it, never from the summary.
- **`replay_endpoint { host, endpointId | template, method?, body? }`** — calls the
  endpoint now, signed in as the user, and answers its status, an item count and whether
  the response still matches the recorded shape — never the body. GET and HEAD run at
  once; any other method asks the user first (once per site, method and path) and sends
  the body last observed from the site unless you pass `body`. It acts on the real site:
  only replay a write when the shim's job is that write. In a composition session only
  GET and HEAD replay (`read-only`).

An endpoint id belongs to its site: naming it under another host answers `not-found`.
Refusals come back as `{ ok: false, error, hint }` — `host-not-granted`, `no-sources`,
`sources-denied`, `site-names-denied`, `replay-declined`, `consent-timeout`,
`too-many-pending`, `discovery-off`. Don't re-ask for what the user declined; a
timeout or a full queue of cards is not a no, so those can be retried. In the handler, call the
endpoint with the page's `fetch(url, { credentials: 'include' })` (section 7).

Storage and database inspection are not available to sessions in this build.

## 5. Mutation kinds

**Prefer the lowest tier that solves the ask.** `hide` and `restyle` cover most "remove
this" and "redesign this" asks. Use `script` whenever the ask involves behavior, state,
fetching or non-trivial UI — that is its job. Never describe rules to the user by tier;
say "a hide rule", "a CSS-only change", "a script widget", "rewriting the API response".

Only the kinds, anchor kinds and `api` members in this guide exist. There is no CSP toggle,
no header-rewrite field, no `api.<anything else>`. If a task needs a capability that isn't
here, say so plainly and propose what you can do — an invented kind is refused and an
invented field is ignored, so faking one produces a no-op, never a feature.

### CSS-only (framework-safe, reversible)

**`hide`** — `display: none !important`. `{ "kind": "hide" }`

**`restyle`** — arbitrary CSS properties, applied `!important`:

```json
{ "kind": "restyle", "properties": { "color": "#ff0000", "font-size": "20px", "border": "2px solid teal" } }
```

Recolor a `<canvas>`, `<video>` or image with CSS `filter` (`hue-rotate(180deg)
saturate(1.5)`), never with a handler that touches pixels: cross-origin canvases are
tainted, and pixel writes can't be undone when the shim turns off.

**`reorder`** — move an element among its siblings (CSS `order`; the parent must be flex or
grid — the evidence notes when it isn't; add a `reshape` on the parent):

```json
{ "kind": "reorder", "position": "first" }
{ "kind": "reorder", "before": { "kind": "css", "value": ".sidebar" } }
{ "kind": "reorder", "after": { "kind": "text", "value": "Now Playing" } }
```

Exactly one of `position` (`first`, `last`, or a number used as the order key) / `before` /
`after`. `before`/`after` take an anchor spec that must resolve to exactly one sibling, and
the rule's own anchor must match exactly one element; `position` works with multi-match
anchors. It changes visual order only (not tab order or screen readers), and the
`before`/`after` target has no fallbacks or self-healing — give it a durable anchor.

**`reshape`** — change a container's layout declaratively:

```json
{ "kind": "reshape", "layout": "grid", "columns": 3, "gap": "16px" }
{ "kind": "reshape", "layout": "flex", "direction": "column", "align": "center", "justify": "space-between", "wrap": true }
{ "kind": "reshape", "columns": "240px 1fr" }
```

A number of `columns`/`rows` becomes `repeat(N, minmax(0, 1fr))`; a string is used as the
template. Omit `layout` to adjust an existing flex/grid container. Anything more: add a
`restyle`.

### Static content

**`inject-element`** (prefer) and **`inject-html`** insert static content relative to the
anchor, no handler needed:

```json
{ "kind": "inject-element", "placement": "after",
  "element": { "tag": "a", "text": "my notes", "attrs": { "href": "/notes" }, "style": { "font-size": "12px" },
               "children": [{ "text": "…" }] } }
{ "kind": "inject-html", "html": "<span class=\"tag\">new</span>", "placement": "prepend" }
```

`placement`: `before` | `after` (default) | `prepend` | `append`. A multi-match anchor
injects once per element. Both are **static by contract**: scripts, `on*` attributes and
`javascript:` URLs are stripped or refused. Anything interactive must be a `script` handler.
`mount.strategy` works as on `script`.

### Handlers: `script`

```json
{ "kind": "script", "handler": "mountBadge", "mount": { "strategy": "portal", "align": "below" } }
```

The handler receives `{ anchor, mutation, rule, spec, api }` and returns the DOM node (or
nodes) it created. Returning them opts into **self-healing**: if the site's re-render
removes them, the engine runs the handler again. Mount strategies:

- `inline` (default) — your output goes where you put it. Cheapest; only for static DOM.
- `portal` — the engine parks your output in a floating root positioned at the anchor
  (`align: "below" | "above"`). **Use `portal` or `overlay` for anything inside a
  React/Vue/Angular-rendered region**: inline nodes there get displaced by the framework
  even when they aren't removed.
- `overlay` — a portal sized to cover the anchor (good for tagging).
- `shadow` — your output inside a shadow root (style isolation).

Rules that keep handlers safe — every one learned from real breakage:

- **Decorate repeated elements by anchoring the item, not the container.** The engine runs
  the handler once per matched element and again for matching elements that appear later.
  Anchor the row selector, write the handler for one row, return what you inject. Don't
  iterate a container yourself, and don't write your own MutationObserver to catch new
  rows.
- **Register teardown for every side effect** beyond the returned DOM: `document`/`window`
  listeners, intervals, observers, third-party widgets — `api.cleanup(() => …)`. Without it
  they leak across route changes and toggles.
- **Never move or reparent the site's own DOM into containers you create.** When the rule
  tears down, your container goes and the site's nodes go with it, permanently. Clone
  (`node.cloneNode(true)`) and `hide` the original instead.
- **If you must observe mutations, never observe DOM you also mutate**: `disconnect()` at
  the top of the callback, re-`observe()` at the end, make the work idempotent (a marker
  attribute), and `api.cleanup(() => observer.disconnect())`. An observer that sees its own
  writes freezes the page.
- **A rule can't anchor on DOM a shim created** (a handler's output, a portal host). To
  restyle your widget, style it inside the handler that mounts it.
- **Never anchor to a `data-shim*` attribute** — those exist only after a rule ran.
- **Mount defensively.** Guard every DOM read and fetch result; render a placeholder (`–`)
  for anything missing. One uncaught throw takes down everything the handler builds after
  it.
- **Match the site's visual language.** Before styling a new control, `inspect_element` the
  nearest existing control of the same kind and reuse it: its class (unless obviously
  build-generated, like `.css-1a2b3c`), or its computed `font`, `color`, `background`,
  `border`, `border-radius`, `padding`, `box-shadow`; and the site's CSS custom properties
  (`getComputedStyle(document.documentElement).getPropertyValue('--color-primary')`). A
  default-styled button next to the site's own is a first-preview failure, not polish.

### DOM removal: `remove`

`{ "kind": "remove" }` deletes the anchor; irreversible until reload. **Prefer `hide`**,
and use `remove` only when the parent depends on the child actually being gone
(`:nth-child` styling, a child count in a grid template, JS that reads
`children.length`) or the user explicitly asks to delete it.

### Replacing a region: `replace-root`

```json
{ "kind": "replace-root", "handler": "mountBudgetPanel" }
```

Hides the anchor's children and mounts your handler's tree in their place; reversible.
Same contract as `script`, except the handler must `anchor.appendChild(root)` and return
the root. Use it to turn a region (or `<body>`) into a new mini-app; use `script` to add
UI alongside the site's.

### A new page: `mount-route`

```json
{ "id": "budgets-route",
  "mutations": [{ "kind": "mount-route", "pattern": "/budgets/:id?", "handler": "renderBudgets", "title": "budgets" }] }
```

Registers a virtual URL on the site, rendered locally by your handler (no anchor).
Patterns: `/budgets`, `/budgets/:id`, `/budgets/:id?`, `/files/*` (`match.params['*']`).
The handler gets `{ match, mutation, rule, spec, api }` with `match = { path, params }` and
returns the page root — don't append it anywhere. Links to the pattern are intercepted,
and reload, bookmarks and back/forward work. The page runs on the site's origin, so
`fetch(url, { credentials: 'include' })` reaches the site's authenticated endpoints. Add
the link to it with a separate `script` rule. Route pages render in an isolated shadow
root: **style them fully yourself** (set `font-family`; site CSS does not apply). For a
route that owns sub-paths, build the shell once and register
`api.onRouteChange((match) => { …; return teardown; })` so inner navigation updates in
place.

**Not on a global shim.** Route and redirect rules in a `"global": true` shim's per-site
rules preview but never install after commit (both are built from the shim's shared spec,
which holds no rules). Use a regular shim for them.

### Network and module rules

**`redirect`** — swap the host of top-level navigations before the page loads (no anchor,
no handler):

```json
{ "kind": "redirect", "from": "www.reddit.com", "to": "old.reddit.com",
  "exceptPaths": ["/media", "/gallery", "/poll", "/settings", "/notifications", "/coins", "/premium", "/message", "/wiki"] }
```

`match.hosts` must include `from` (and `match` can't change in a session, so `from` must
already be one of its hosts); only top-level navigations are redirected; path, query and
hash are kept. `to` may be any site, including another domain (twitter.com → x.com): the
boundary is consent, not domain. Each new redirect target asks the user at commit, and a
target they haven't allowed never redirects. Not on a global shim (see `mount-route`
above).

**`rewrite-response`** — reshape the JSON the site's own code fetches, before it reads it
(the right tool for filtering a list the site loads, so its counts and pagination stay
right):

```json
{ "kind": "rewrite-response", "endpoint": { "method": "GET", "path": "/list/tracks" }, "transform": "filterHeard" }
```

`handlers/filterHeard.js` is `module.exports = function filterHeard(json, ctx) { … return json; };`
with `ctx = { url, method, status, params }`. The transform runs in the page's **main
world**, must be pure and synchronous (no `api`, no DOM); a throw or an `undefined` return
ships the original body. Only same-registrable-domain JSON responses are touched, and only
when the site fetches again — reload before concluding a rewrite doesn't work.

**`intercept`** — wrap a function in the site's own AMD/RequireJS module (check first:
`evaluate_in_page('typeof define !== "undefined" && !!define.amd')`):

```json
{ "kind": "intercept", "module": { "loader": "amd", "id": "player" }, "symbol": "playTrack", "wrap": "logPlay" }
```

The wrap `(original, ctx) => replacement` runs in the main world at module registration
(possibly many times — keep state in the returned function) and must call through to
`original`. To wrap the module's **whole export** (the export itself is the function, or
you replace the export object), give `wrap` without `symbol`: it attaches only when the
module registers, so if the page already loaded the module the user must reload — say so
in your reply. Omit `symbol` and `wrap` to only expose the module to
`api.modules.invoke(moduleId, fnPath, args)` from a `script` handler (`{ ok, result }`,
never throws). List module ids with
`evaluate_in_page('Object.keys(require.s.contexts._.defined)')`.

## 6. Anchors

`anchor.primary` says how to find the target; pick the kind that captures *why* this is the
target. Shim fingerprints the matched element on its own (a **witness**) and refuses to
apply a rule whose anchor later resolves to a different-looking element — it holds the rule
for repair instead of mis-attaching. You never write witnesses.

```json
{ "kind": "data-attr", "name": "data-testid", "value": "submit-btn" }
{ "kind": "data-attr", "name": "data-track-id" }
{ "kind": "aria", "role": "button", "label": "Open settings" }
{ "kind": "text", "value": "Add to cart", "match": "contains" }
{ "kind": "css", "value": "main > h1" }
```

- `data-attr`: a stable `data-*` attribute (`data-` prefix optional; omit `value` to match
  presence). Strongest.
- `aria`: `role` and/or `label` (ANDed). Often the most resilient on framework sites.
- `text`: visible text, case-insensitive; `match` is `exact` (default) or `contains`.
  Returns the deepest matching element. Brittle to copy edits; not for sentences.
- `css`: a raw selector, the last resort.

Strongest to weakest: `data-attr` with value → `#id` → `aria` role + label → `data-attr`
name-only / `aria` role-only → `text` on a button, link or heading → a structural selector
with semantic tags → a class combination. **Avoid** positional selectors (`:nth-child(3)`)
and build-generated classes (`.css-1a2b3c4`) as a primary: both break on the next deploy,
and the lint warns. `query_page` gives you ranked suggested anchors with live match counts —
prefer them over guessing; prefer one that matches exactly as many elements as you mean.

**Fallbacks** — `anchor.fallbacks` is an ordered list of further specs, tried when the
primary matches nothing. Strongest first, each strictly broader, of *different* kinds. Most
rules don't need them; add them when the primary hangs on one brittle attribute or the rule
must survive redesigns.

```json
{ "primary": { "kind": "data-attr", "name": "data-testid", "value": "save-btn" },
  "fallbacks": [{ "kind": "aria", "role": "button", "label": "Save changes" },
                { "kind": "css", "value": "form button[type='submit']" }] }
```

`anchor.iframe` (`{ "kind": "css", "value": "iframe#player" }`, the child frame to look
in) targets an element inside that frame. Warn the user before touching payment iframes.

## 7. The runtime `api`

Handlers get `api`. Every call that can fail resolves `{ ok: false, error }` instead of
throwing — always branch on it and render a usable state.

**While previewing, handlers get a preview `api`, not the shim's.** `api.storage` reads and
writes a scratch bucket apart from the shim's saved data: what the shim already saved isn't
visible, and what a preview stores never reaches the shim. That bucket is one per site,
shared by every preview there (other shims' and earlier sessions' too) and never cleared,
so it may already hold keys — don't read a value you didn't just write as evidence, and
prefer keys unique to this shim. `api.settings` has no values,
`api.ai` calls answer `{ ok: false }`, and `api.db`, `api.storage.pack`,
`api.storage.global` and `api.shared` are absent. Handlers must render a usable state in
every one of those cases anyway; check the data path after commit (open the session again
if you need to), and say in your summary what you could only verify that way.

- **`api.cleanup(fn)`** — teardown for side effects (section 5).
- **`api.origin`, `api.host`** — the page's origin and host, as strings.
- **`api.storage`** — per-shim, per-origin key/value: `get(key)` (null when unset),
  `set(key, value)` (any JSON value), `delete(key)`, `list()`. Use it for small state:
  toggles, "played" flags, a cache of per-item data so each item is fetched at most once.
  - **`api.storage.pack`** — the same four methods over a bucket every shim in the
    shim's pack shares. Present only while the shim is in a pack: guard
    `api.storage.pack &&` and treat an empty bucket as normal.
  - **`api.storage.global`** — on a global shim (one shim running on many sites), the
    same four methods over a store shared across all its sites. Present only on a
    global shim: guard `api.storage.global &&`.
- **`api.shared`** — on a global shim that declares shared functions, those functions,
  called as `api.shared.<name>(…)` (never destructured). Present only then: guard
  `api.shared &&`.
- **`api.db`** — the shim's own SQLite database, for data with real shape (many rows to
  filter, sort, count). Declare tables in `storage`:

  ```json
  "storage": { "tables": [{ "name": "plays", "columns": [
    { "name": "id", "type": "integer", "primaryKey": true },
    { "name": "track_id", "type": "text", "notNull": true },
    { "name": "played_at", "type": "integer", "notNull": true }
  ], "indexes": [{ "name": "plays_track_idx", "columns": ["track_id"] }] }] }
  ```

  Names are lowercase `snake_case`; types `text | integer | real | blob`. Additive changes
  apply on commit. Then `await api.db.query(sql, params)` (reads only; `{ ok, rows,
  truncated? }`, capped by default at 5,000 rows / 1 MB; a shim that really needs bigger
  reads raises its own caps with `"storage": { "limits": { "maxRows": 20000,
  "maxResultBytes": 5000000 }, "tables": [...] }`, up to 100,000 rows / 20 MB — prefer
  `LIMIT`/`OFFSET` paging or an aggregate first) and `await api.db.run(sql, params)` (writes
  and DDL; `{ ok, changes, lastInsertRowid }`). Parameterized (`?`) only, one statement per
  call. Destructive DDL waits on the user's approval. Errors to handle: `not-declared`,
  `approval-required`, `denied`, `classification: …`, `rejected: …`, `sqlite: …`,
  `bad-params: …`. **`api.db` is absent while previewing** — your preview shows the
  handler's `api.db &&` fallback; the data path works after commit.
- **Remote databases** — `connections: [{ "name": "warehouse", "engine": "postgres" }]`
  (`postgres | mysql | mariadb | mssql | sqlite-remote | supabase`) names a database the
  user already runs; they paste its URL into the shim's Settings, never you. Each entry
  may nest a `storage` of the same `{ "tables": [...] }` shape as the shim's own:

  ```json
  "connections": [{ "name": "warehouse", "engine": "postgres", "storage": { "tables": [
    { "name": "track_notes", "columns": [
      { "name": "id", "type": "integer", "primaryKey": true },
      { "name": "body", "type": "text" }] }] } }]
  ```

  On the SQL engines Shim creates missing tables and columns from it, additively, when the
  shim first touches the connection — declare the schema there rather than running DDL
  yourself. It is also the table allowlist: once a connection declares a table, a
  statement touching an undeclared one (on `postgres | mysql | mariadb | mssql`) waits on
  the user's approval, so declare every table you use. Omit `storage` to talk to an
  existing schema as is. Reach a connection with
  `api.db.connection("warehouse").query(…)` / `.run(…)`; unconfigured, calls answer
  `not-configured`. A `supabase` connection instead takes a supabase-js-like builder;
  only this subset of it exists:
  - start: `.from(table)` then one of `.select(columns?)`, `.insert(row | rows)`,
    `.upsert(row | rows, { onConflict? })`, `.update(patch)`, `.delete()`;
  - filters: `.eq` `.neq` `.gt` `.gte` `.lt` `.lte` `.like` `.ilike` `(column, value)`,
    `.in(column, values)`, `.is(column, value)`, `.not(column, op, value)`, `.or("a.eq.1,b.gt.2")`;
  - read modifiers: `.order(column, { ascending? })`, `.limit(n)`, `.range(from, to)`,
    `.single()`, `.maybeSingle()`; after a write, `.select(columns?)` returns the
    affected rows. Writes take at most 1,000 rows.

  Columns are plain names (or `*`) — no embedded relations, `->` or `::`. A read answers
  `{ ok, rows, truncated? }`; a write `{ ok, changes }`, plus `rows` when it ends in
  `.select()` — never supabase-js's `{ data, error }`. Row-level security can filter a
  write to nothing and still answer `ok` with `changes: 0`, so check `changes`. An
  `update`/`delete` with no filter waits on the user's approval. A supabase connection's
  `storage` creates nothing — the user makes tables in their Supabase project — but it is
  still the table allowlist, so declare every table the shim touches. A new
  connection asks the user at commit. Treat remote data as shared: additive changes only,
  and say so before writing.
- **`api.settings`** — values the user supplies (API keys, preferences). Declare the fields
  in `settings`: `[{ "key": "openaiKey", "label": "OpenAI API key", "type": "secret",
  "required": true }]` (types `text | secret | number | boolean | select`; `select` needs
  `options`; optional `help`, `default`). Read with `await api.settings.get('openaiKey')`
  — `undefined` until the user fills it in, so render "add your key in Settings" — or all
  of them at once with `await api.settings.getAll()` (`{ key: value }` for every declared
  field). The schema travels with the shim; `secret` values never do, but non-secret
  values ride along when the user exports a pack — keep anything personal in a `secret`
  field (or in `api.storage`) rather than a `text`, `number`, `boolean` or `select` one.
- **`api.fetch(url, { method, headers, body })`** — a request from Shim's main process,
  outside the page's CSP and CORS: `{ ok, status, url, headers, text, truncated }` (no
  `.json()` — `JSON.parse(res.text)`). It sends no cookies, but it does send the headers
  you pass, so a third-party API authenticated by a key works: read the key from a `secret`
  setting and pass it as `Authorization` or the API's key header. Only for the site's own
  endpoints that need the user's logged-in session, use the page's
  `fetch(url, { credentials: 'include' })`. It **cannot reach the local network**: localhost,
  LAN addresses and hostnames resolving to private or link-local addresses answer
  `{ ok: false, error: 'blocked: …' }`. A preview makes the same real requests through
  the same broker and block, so it shows you that answer; don't build an integration
  with a local service on `api.fetch`.
- **`api.ai.complete({ prompt | messages, system?, model?, maxTokens? })`** — Claude, on the
  user's own Anthropic key, which the shim never sees: `{ ok, text }`. Requires
  `"permissions": ["ai"]`; the user grants it in Shim after the commit, and until then calls
  answer `{ ok: false }`. It spends the user's money: batch, cache in `api.storage`, never
  call it from a mutation-driven loop, and don't trigger AI features over and over while
  previewing. Tell the user in your summary that the feature needs their approval.
- **`api.onRouteChange(fn)`** — for `mount-route` pages (section 5).
- **`api.modules.invoke(id, fnPath, args)`** — for modules an `intercept` declared.

**Never hammer the site.** One request per row (a 100-call burst on mount) gets the user
rate-limited and their account throttled. Prefer fields already in a list response, cache
per item in `api.storage`, fetch lazily for what the user interacts with, and back off on
4xx/5xx instead of retrying.

## 8. Committing and reporting

- Commit when the evidence is clean and anything visual has been looked at. Commit more
  than once in a session if the work comes in stages.
- Your `summary` is what the user reads in the shim's chat: what changed and what you
  verified, in 1–3 sentences, for someone who didn't watch you work.
- Be honest about what you didn't verify: a rule that didn't match on another page-type, a
  feature waiting on the user's grant, a data path you could only check after commit.
- When the ask is ambiguous ("make this look better"), propose one concrete change and ask
  whether they want something different.

## 9. Compositions

A **composition** is a small local web app Shim serves at `compose://<mount>`: your own
HTML, CSS and JavaScript, which reads the user's sites through `window.api` with their
signed-in session — a dashboard over two music stores, a budget view over a bank's
transactions. There is no host page to anchor to: you write the whole page. Everything
above about the session loop, previews, evidence honesty and visual verification holds;
this section is what differs.

### The session

1. **Pick the composition.** `shim_list_tabs` lists every composition (`compositions[]`:
   `id`, `name`, `mount`) and gives an open composition tab its `compositionId`. Creating a
   new composition isn't a session action: ask the user to create one in Shim first, then
   open a session on it.
2. **Open.** `shim_open_session { compositionId, intent, dir }` — `tabId` is optional (the
   window the preview opens in). The user allows it in Shim; the composition's page opens
   there as your preview.
3. **Check out** (with `dir`, or `shim_checkout { dir }`): `manifest.json` plus every file of
   the composition, flat. Use an empty folder.
4. **Edit, then `shim_preview`.** Shim validates the folder, saves the changed files onto the
   composition and reloads its page. If the manifest adds a host (or changes a host's
   `mint`), the user is asked in Shim first and the preview waits; allowed, the page can
   read that host at once.
5. **Look.** `view_page`, `query_page`, `inspect_element`, `interact_page`, `read_console`,
   `read_calls` (below).
6. **Commit** with `shim_commit { summary }`: a version of the composition, with your intent
   and summary in its chat. When the work declares a **write** to a site (an endpoint
   whose method changes data) or a new remote database connection, the user approves it
   on a card in Shim first.
7. **End.** `shim_end_session`: anything previewed after the last commit is rolled back.

### The folder

```
manifest.json     the composition/1 manifest
index.html        the entry (the manifest names it)
app.js            any other files, all at the top level
style.css
```

- **Flat.** Top-level files only: a file in a subfolder is refused. Reference files with
  relative URLs (`<script src="app.js">`).
- **Bounds.** At most 200 files and 50 MB together, 10 MB per file.
- **Text files are yours to write** (HTML, CSS, JS, JSON, SVG, text). A binary asset the
  composition already holds (an image, a font) is checked out too: leave it byte for byte
  as it is — a session can't add, change or remove one. Draw icons in SVG; show a site's
  images through the media route (below).
- Hidden files (`.git`, editor files, the `.shim-composition` marker) are ignored, except
  the composition's own hidden files that the checkout wrote (a `.well-known/…` file, say):
  those are part of it, so edit or delete them like any other file. A new hidden file is
  never sent.

### The manifest

```json
{
  "format": "composition/1",
  "name": "Crate digger",
  "entry": "index.html",
  "hosts": [
    {
      "host": "api.example-music.com",
      "endpoints": [
        { "method": "GET", "path": "/v1/tracks" },
        { "method": "POST", "path": "/v1/playlists/{id}/tracks" }
      ]
    }
  ],
  "permissions": ["ai"],
  "settings": [{ "key": "minBpm", "label": "Lowest tempo", "type": "number", "default": 120 }]
}
```

- **`hosts[]`** — every site the page calls. `host` is a canonical lowercase hostname (no
  port, no IP address). The page can reach a host only when the manifest declares it **and**
  the user granted it (the preview's card).
- **`endpoints[]`** — the operations the page makes on that host: `{ method, path }`, with
  `kind` and `operationName` for a GraphQL / JSON-RPC operation. **Declare every write**
  (a method that changes data): the commit asks the user to approve each new one, and an
  undeclared write is refused at runtime. `access: "read"` marks a REST POST that only
  searches; the user confirms it the first time it runs.
- **`mint`** — when a host wants a token rather than the session's cookies: `{ "url", ... }`
  with how to read the token (`tokenPath`, a dot-path into a JSON response, or `token`
  `{ after, chars, length? }`, the text right after a literal prefix, optionally in a page
  the mint page links to via `follow` `{ urlAfter, urlHost }`) and where to send it
  (`header`, with an optional `scheme` such as `"Bearer"`, or `query`). Design one with
  `probe_request` (the page or script the token is in).
- **`settings`**, **`permissions`**, **`storage`**, **`connections`** — the same
  declarations a shim makes (section 7): settings fields (`text | secret | number | boolean
  | select`), `"permissions": ["ai"]`, local tables, remote databases.
- The mount (`compose://<mount>`) is not in the manifest: the user chooses it.

### `window.api`

Page code reaches everything outside its own files through `window.api` (`api` below).
Nothing throws: every call resolves `{ ok: false, error }` on a refusal — render it.

- **`api.fetch(host, path, opts?)`** — `opts`: `method`, `headers`, `body`. Resolves
  `{ ok, status, text, error? }` (`JSON.parse(res.text)`). It is the page's only network:
  `fetch`, `XMLHttpRequest` and WebSockets don't exist, and the CSP blocks scripts, styles
  and images from any other origin — ship every asset as a file. Requests go out with the
  user's session cookies (or the host's minted token); a redirect is followed only on the
  same host, over https, for GET / HEAD.
- **Site media** — audio, video and images from a declared, granted host load through the
  composition's own origin: `<img src="/_media/<host>/<path>">`
  (`<audio src="/_media/media.example.com/preview/1.mp3">`). A direct https URL is blocked.
- **`api.storage.get / set / delete / list`** — a key/value store private to the
  composition (JSON values; `get` is `null` when unset). Use it instead of `localStorage`.
- **`api.settings.get(key)` / `getAll()`** — the user's values for the declared fields;
  handle an unset one with a "configure me" state. Never copy a setting into
  `localStorage` or cookies.
- **`api.ai.complete({ prompt | messages, system?, model?, maxTokens? })`** — a model call on
  the user's own key, with `"permissions": ["ai"]` declared and granted. Resolves
  `{ ok: true, text }` or `{ ok: false, error }`.
- **`api.db.query(sql, params?)` / `api.db.run(sql, params?)`** — the composition's own
  SQLite database (`storage` tables), and **`api.db.connection(name)`** — a declared
  remote database the user connects in Shim's settings (section 7).
- The page can't navigate away from its own `compose://` origin: a real click on an
  http(s) link opens a new tab; scripted navigation and `window.open` elsewhere are
  blocked.

### While you build it

Shim holds the composition for your session exactly as for its own build:

- **Writes are refused**: `api.storage.set / delete`, `api.db.run`, and any write through
  `api.fetch` answer `authoring-read-only`. Tables you declare are created only when you
  commit. Verify everything up to the save; say plainly that the save itself could not be
  exercised.
- **Secret settings read `null`**, so the preview shows your unset-value path.
- **`api.ai` is refused**: every call resolves
  `{ ok: false, error: "ai-unavailable-in-external-session" }` — Shim never spends the
  user's key for your session. Make sure the page renders that failure. The preview
  evidence (or the next tool result) carries an `aiUnavailable` note when the page called
  it. **The first time, tell the user once, in these words:**

  > Shim can't use your Claude Code subscription, so AI features in this page won't run while Claude Code builds it. Open the composition in Shim (with an API key set) to see them work.

  Don't repeat it.

### The evidence

A composition preview answers `{ revision, applied, evidence }`:

| Field | What it says |
|---|---|
| `changes` | what the folder changed: `write-file app.js`, `delete-file old.css`, `set-manifest` |
| `changed[]`, `noop[]` | the files written, and those already identical |
| `warnings[]` | lint: an `api.fetch` to an undeclared host, `api.ai` without the permission, a dropped host or changed mint |
| `notes[]` | the user's answers (a host allowed), declined hosts |
| `console` | errors and warnings the page logged since the previous preview |
| `aiUnavailable` | the page called `api.ai` (above) |
| `pageAway` | the preview tab left the composition: nothing was written — `reload_page`, then preview again |

A refused preview answers `applied: false` with `error` and `problems`:
`invalid-working-copy` (the manifest, the entry, a subfolder, a binary file, the bounds),
`reach-denied` / `reach-timeout` (the host card), `malformed-working-copy`.

### The tools

- The page tools act on the composition's preview. `evaluate_in_page` runs in an isolated
  world over its DOM (the page's own globals and `window.api` are not visible).
  `verify_across_pages { paths }` loads each of the composition's HTML pages and reports
  load failures and console errors.
- **`interact_page { actions }`** — click, type, select or press in the preview with real
  input (up to 10 actions). Use it to exercise behavior, then check the result with
  `query_page` / `inspect_element` and `view_page`.
- **`read_calls { all?, limit? }`** — the requests the page made through `api.fetch`:
  method, host, path template, status — never a body. By default only calls from
  documents running your latest code. **A data feature is verified when its call is here
  with a 2xx status** and the page shows the result (a DOM check plus a screenshot); a
  call that failed, or none at all, means it isn't working yet.
- **`probe_request { host, path }`** — one GET of your own through the composition's real
  fetch path to a declared, granted host, answering the status and up to 20,000 characters
  of the body. For designing a mint or checking a live response shape; it is never
  evidence that the page works.
- The API map tools (section 4) work the same, except `replay_endpoint` runs GET and HEAD
  only (`read-only`).

## 10. Headless mode

When the server runs as `shim-mcp --headless`, there is no Shim browser: `shim_status`
reports `mode: "headless"`, and each session opens its own Chromium page (a fresh profile,
no logins, never Shim's). The loop is the same, with three differences:

- **Open on a url and a file.** `shim_open_session { url, intent, shimFile, dir }` works on
  the `.shim` file `shimFile`: an existing one is loaded and its rules run on the page at
  once; with `newShimName` a new shim starts there (default `<dir>.shim`). There are no
  tabs and no shim library, so `shim_list_tabs`, `shim_launch` and `shimId` answer
  `requires-shim-browser`, and so do `verify_across_pages`, compositions (section 9) and
  their tools, and the API map tools (section 4).
- **`shim_commit` writes the file**: a new version, with its history and what the session
  verified. `api.storage` lives in `<shimFile>.storage.json`. Hand the `.shim` file to the
  user; they import it into Shim.
- **A subset of features.** Headless runs `hide`, `restyle`, `reorder`, `reshape`, `script`,
  `inject-element`, `inject-html`, `remove` and `replace-root`, with `api.storage` and
  `api.cleanup`. A preview that uses anything else — the network and route kinds,
  `anchor.iframe`, a spec-level `css` block, or a `settings` / `permissions` / `storage` /
  `connections` declaration — applies nothing and answers `error: "unsupported"` with the list: drop it,
  or author that shim in the Shim browser. A handler that calls a member headless lacks gets
  the answer the browser gives an unconfigured shim (`api.fetch` resolves
  `{ ok: false, error: "requires-shim-browser" }`, `api.settings.get` resolves `undefined`,
  `api.db` reads as absent), the preview lists it under `unsupportedApi`, and its rule is
  **`verification: partial`** — tell the user that rule is unverified until they try it in
  Shim. Only a `full` rule behaves the same in Shim.
