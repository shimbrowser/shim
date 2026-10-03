---
name: shim-authoring
description: How to author Shim shims — modifications to a live website, applied by the Shim browser — from Claude Code through the shim MCP tools. Use whenever the user asks to change, hide, restyle, add to or rebuild part of a website in Shim, or to work on an existing shim. Covers the session loop (open, check out, edit the folder, preview, verify, commit), the shim folder format, every mutation kind, anchors, the runtime api handlers get, and the evidence each preview returns.
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

## 1. The session loop

1. **Pick a mode.** `shim_status` says which modes are available, why, and what to do
   next. **Attach** works in a tab of the running Shim browser, with the user's logins, and
   commits to Shim's library. **Headless** needs no Shim: it opens the page in its own
   Chromium and commits to a `.shim` file (section 9). If the user has Shim but it isn't
   reachable, `shim_launch` starts it. Shim's control endpoint is off by default; launching
   turns it on for this run, and the user can also turn it on in Shim's Settings. If
   neither mode is available, give the user the install command `shim_status` names.
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
  `$`, `-`, not starting with `-`. Two rules can share one handler by naming it.
- **Rule ids** are short kebab-case slugs, unique within the shim (`hide-sidebar`,
  `teal-underline-h1`).
- **What you may change:** `rules`, and the declarations `intent`, `settings`,
  `permissions`, `storage`, `connections`. `id` and `match` are fixed for a session; changing
  them is refused as `not-editable`.
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
- `interact_page` is for composition sessions; a shim session answers that it isn't
  offered.

The API-map tools (the site's recorded API), storage and database inspection are not
available to sessions in this build.

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

### Network and module rules

**`redirect`** — swap the host of top-level navigations before the page loads (no anchor,
no handler):

```json
{ "kind": "redirect", "from": "www.reddit.com", "to": "old.reddit.com",
  "exceptPaths": ["/media", "/gallery", "/poll", "/settings", "/notifications", "/coins", "/premium", "/message", "/wiki"] }
```

`match.hosts` must include `from` (and `match` can't change in a session, so `from` must
already be one of its hosts); `from` and `to` must share a registrable domain; only
top-level navigations are redirected; path, query and hash are kept. Each new redirect
target asks the user at commit.

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
`original`. Omit `symbol` and `wrap` to only expose the module to
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
writes a scratch bucket apart from the shim's saved data — what a preview stores is gone
after commit, and what the shim already saved isn't visible — `api.settings` has no values,
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
  truncated? }`, capped at 5,000 rows / 1 MB) and `await api.db.run(sql, params)` (writes
  and DDL; `{ ok, changes, lastInsertRowid }`). Parameterized (`?`) only, one statement per
  call. Destructive DDL waits on the user's approval. Errors to handle: `not-declared`,
  `approval-required`, `denied`, `classification: …`, `rejected: …`, `sqlite: …`,
  `bad-params: …`. **`api.db` is absent while previewing** — your preview shows the
  handler's `api.db &&` fallback; the data path works after commit.
- **Remote databases** — `connections: [{ "name": "warehouse", "engine": "postgres" }]`
  (`postgres | mysql | mariadb | mssql | sqlite-remote | supabase`) names a database the
  user already runs; they paste its URL into the shim's Settings, never you. Reach it with
  `api.db.connection("warehouse").query(…)` / `.run(…)`; unconfigured, calls answer
  `not-configured`. `supabase` takes a supabase-js-like builder
  (`.from("notes").select("*").eq(…)`), answering `{ ok, rows, changes }`. A new
  connection asks the user at commit. Treat remote data as shared: additive changes only,
  and say so before writing.
- **`api.settings`** — values the user supplies (API keys, preferences). Declare the fields
  in `settings`: `[{ "key": "openaiKey", "label": "OpenAI API key", "type": "secret",
  "required": true }]` (types `text | secret | number | boolean | select`; `select` needs
  `options`; optional `help`, `default`). Read with `await api.settings.get('openaiKey')`
  — `undefined` until the user fills it in, so render "add your key in Settings" — or all
  of them at once with `await api.settings.getAll()` (`{ key: value }` for every declared
  field). Values never travel with the shim; the schema does.
- **`api.fetch(url, { method, headers, body })`** — a request from Shim's main process,
  outside the page's CSP and CORS: `{ ok, status, url, headers, text, truncated }` (no
  `.json()` — `JSON.parse(res.text)`). Cookie-less: public content only. For the site's own
  authenticated endpoints, use the page's `fetch(url, { credentials: 'include' })`.
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

## 9. Headless mode

A session runs headless when you open it on a `url` and no Shim browser is reachable, or
when you pass `mode: "headless"`, or when the server runs as `shim-mcp --headless`. The
session opens its own Chromium page (a fresh profile, no logins, never Shim's). The
`shim_open_session` answer always says `mode` and `modeReason`: tell the user which one you
are in, because what a commit saves differs. With Shim running, a bare `url` answers
`shim-running`: work in the user's Shim tab (`shim_list_tabs`, then `tabId`) unless they
want a standalone `.shim` file, in which case pass `mode: "headless"`.

Headless needs Playwright. If it is missing, opening answers `playwright-missing` (or
`chromium-missing`) with the exact command to run. Give the user that command; don't run
installs on their machine without asking.

The loop is the same, with three differences:

- **Open on a url and a file.** `shim_open_session { url, intent, shimFile, dir }` works on
  the `.shim` file `shimFile`: an existing one is loaded and its rules run on the page at
  once; with `newShimName` a new shim starts there (default `<dir>.shim`). A headless
  session has no tabs and no shim library, so `shimId` answers `requires-shim-browser`,
  and so do `verify_across_pages` and `interact_page`. A headless-only server also
  refuses `shim_list_tabs` and `shim_launch`.
- **`shim_commit` writes the file**: a new version, with its history and what the session
  verified. `api.storage` lives in `<shimFile>.storage.json`. Hand the `.shim` file to the
  user; they import it into Shim.
- **A subset of features.** Headless runs `hide`, `restyle`, `reorder`, `reshape`, `script`,
  `inject-element`, `inject-html`, `remove` and `replace-root`, with `api.storage` and
  `api.cleanup`. A preview that uses anything else — the network and route kinds,
  `anchor.iframe`, or a `settings` / `permissions` / `storage` / `connections`
  declaration — applies nothing and answers `error: "unsupported"` with the list: drop it,
  or author that shim in the Shim browser. A handler that calls a member headless lacks gets
  the answer the browser gives an unconfigured shim (`api.fetch` resolves
  `{ ok: false, error: "requires-shim-browser" }`, `api.settings.get` resolves `undefined`,
  `api.db` reads as absent), the preview lists it under `unsupportedApi`, and its rule is
  **`verification: partial`** — tell the user that rule is unverified until they try it in
  Shim. Only a `full` rule behaves the same in Shim.
