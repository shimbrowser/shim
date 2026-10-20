# Handlers: `script`, `replace-root`, `mount-route`

Part of the shim-authoring guide (read `SKILL.md` first). Read this before writing any handler. What a handler's `api` offers is in `references/api.md`.

## Handlers: `script`

```json
{ "kind": "script", "handler": "mountBadge", "mount": { "strategy": "portal", "align": "below" } }
```

The handler receives `{ anchor, mutation, rule, spec, api }` and returns the DOM node (or
nodes) it created. Returning them opts into **self-healing**: if the site's re-render
removes them, the engine runs the handler again.

A handler may be `async` (return a Promise). The engine awaits it and mounts what it
resolves to, and a rejection is reported as a handler error, as a throw is. Until it
settles, that element doesn't count in the rule's match count and isn't handled again. So
a handler that awaits `api.db` or `api.fetch` before building anything shows nothing, and
can read as `matched 0` in a preview that settles first. Build and return the root
synchronously (a placeholder), then fill it in from an un-awaited async step that checks
the root is still connected. Mount strategies:

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

### A page-level script, and in-site navigation

**Anchor a page-level script on `html` or `body`.** Use this for a script that runs once
per page and has no element to decorate: a keyboard shortcut, a controller over the whole
list, a floating panel. Write `{ "kind": "css", "value": "body" }` (or `"html"`). Each
matches exactly one element, the lint accepts it, and sites almost never replace it. As a
result, **the handler runs once per document load, not once per in-site page.**

**In-site (SPA) navigation reuses the anchor, so the handler does not run again.** On a
single-page site, clicking a link changes the URL and swaps the content, but `body`, a
header or a sidebar the handler anchored stays in place. The handler's work goes stale
and nothing calls it again. `api.onRouteChange` doesn't help: only a `mount-route`
handler's `api` has it. A `script` handler has to notice the change itself and refresh:

```js
module.exports = function trackPage({ anchor, api }) {
  let lastUrl = location.href;
  let retry = null;
  // Re-read the page and update what you built. The new page may not be rendered
  // yet: if what you need is missing, try again shortly (bounded).
  const update = (tries = 0) => {
    clearTimeout(retry);
    const ready = true; // e.g. document.querySelector('<something the page renders>')
    if (!ready && tries < 20) { retry = setTimeout(() => update(tries + 1), 250); return; }
    // … update from the current page …
  };
  // A URL change is a hint; the content may still be the old page or a placeholder.
  const checkUrl = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    update();
  };
  // The site's own "navigation finished" event, if it has one (look for it in the
  // site's code or with evaluate_in_page), means the new page is in place: always
  // update. YouTube, for one, fires yt-navigate-finish on document. Re-read the
  // page; don't rely on event.detail.
  const onNavigated = () => { lastUrl = location.href; update(); };
  document.addEventListener('yt-navigate-finish', onNavigated);
  window.addEventListener('popstate', checkUrl); // back / forward
  const poll = setInterval(checkUrl, 500);       // any site: a cheap location check
  api.cleanup(() => {
    document.removeEventListener('yt-navigate-finish', onNavigated);
    window.removeEventListener('popstate', checkUrl);
    clearInterval(poll);
    clearTimeout(retry);
  });
  update();
};
```

Don't wrap `history.pushState` to catch navigations. Handlers run in an isolated world, so
the site's own calls never go through your wrapper. After the change, verify a second
in-site page: navigate in the tab, then `query_page` or `view_page` again.

### Recipe: a page-wide sort or filter

To sort or filter the site's list (cards in a grid, rows in a feed), anchor one
controller on the list's container (or `body`), not one rule per item. Then follow these
rules so the framework that owns the list keeps working:

- **Sort with CSS `order`, never by moving nodes.** Set `item.style.order` on each item.
  Re-appending the site's nodes fights the framework's own bookkeeping and breaks when it
  re-renders. `order` works only among the children of one flex or grid container. When
  the items sit in per-row wrappers, give the wrappers `display: contents` (a `restyle`
  rule, or a style you set) so every item becomes a child of the same container. **Filter**
  with `display: none` the same way.
- **Write only the values that changed.** Frameworks reset `style` when they re-render an
  item, so your controller must re-apply. But writing every value on every pass churns
  layout and can loop. Compare first, as in
  `if (el.style.order !== want) el.style.order = want`.
- **Guard the observer against its own writes.** New items arrive as the user scrolls,
  and a re-render can reset an item's `style` without adding a node. So the controller
  does need a `MutationObserver` on the container, watching `childList` and the `style`
  attribute across the subtree (`{ childList: true, subtree: true, attributes: true,
  attributeFilter: ['style'] }`). Batch the work into one `requestAnimationFrame`,
  `disconnect()` before you write and re-`observe()` after, so your own writes are never
  observed, and add `api.cleanup(() => observer.disconnect())`.
- Put the control (the sort menu, the filter box) in the same handler's returned DOM, and
  refresh on in-site navigation as above.

## Replacing a region: `replace-root`

```json
{ "kind": "replace-root", "handler": "mountBudgetPanel" }
```

Hides the anchor's children and mounts your handler's tree in their place; reversible.
Same contract as `script`, except the handler must `anchor.appendChild(root)` and return
the root. Use it to turn a region (or `<body>`) into a new mini-app; use `script` to add
UI alongside the site's.

## A new page: `mount-route`

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
