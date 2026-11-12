# Page driving: `interact_page` and `navigate` (shim sessions)

Use these to test what you built and to move between pages of the site. Never dispatch
events, call `click()` or set `location` from `evaluate_in_page`, and never drive the page
from outside (AppleScript, another browser).

- **`interact_page { actions, settleMs? }`** — use your shim's own UI the way the user
  would: up to 10 actions, each `{ "click": selector }`, `{ "type": selector, "text",
  "clear"? }`, `{ "select": selector, "value" }`, `{ "press": key }` or
  `{ "scroll": { "by": px } }` (the viewport, positive down, at most 1500 per step). Clicks,
  typing, keys and scrolls are real (trusted) input; a `<select>` is set through the DOM.
  Each selector must match exactly one visible, enabled, uncovered element, so a control
  your handler injects once per matched element (a filter box above every table) needs
  something that tells the copies apart: give each a `data-*` attribute naming its
  instance (`data-for="t3"`) when you create it. In an attach
  session (the user's logged-in tab) it touches **only your shim's own output** — what your
  previews and committed rules put on the page — in the top frame, outside shadow roots
  (`scope: "shim-dom"`). Your output is what a `script` handler **returns** (and an inject
  rule's root), with everything inside it; DOM a handler appends anywhere else — an editor
  or menu it adds to `document.body` on a click — is not, so open such controls inside the
  returned root. Anything else is refused before any input, with a code:
  `not-shim-dom` (the site's own controls), `other-shim-dom` (another installed shim's),
  `site-activation` (your control sits in a site form, inside a site link or button, or in
  a label for a site control), `frame-unsupported`, `shadow-unsupported`, and
  `focus-not-shim` (a key or text while your shim's field doesn't have focus). The target
  and focus are re-checked right before every press and keystroke; an overlay or a focus
  change stops the batch. A `press` whose key-down your own handler acts on by closing the
  field (save on Enter, then remove the input) is reported delivered, with a `note`: the
  rest of that key (its character, its key-up) is withheld from whatever has focus
  afterwards, and the batch goes on. The tab need not be the selected one in its Shim window: Shim
  keeps it painting for the batch without showing it (the site may see the tab as focused
  meanwhile), and the batch goes on if the user selects or leaves the tab. While the window
  is minimized or hidden, or Shim can't keep the tab painting, nothing is sent: the call
  answers `tab-not-visible`, or a step stops with it when that happens mid-batch (input to
  a tab that isn't painting can be reported as sent without reaching the page). Ask the
  user to restore the window.
  Scroll steps may happen anywhere, and can make the site load or
  mark things. When the user touches the tab (keyboard or mouse) the batch stops
  (`interrupted: "user"`); so does a navigation to a new document (a fragment or
  pushState change on the same page doesn't). What your control does when clicked is
  real: your handler acts as the user. The result lists each step (a scroll: `requested`,
  `sent` and `observed` movement), DOM changes, console errors and any window the page
  tried to open (not opened). A shim session's site requests are **not observed**:
  `calls: null`, `traffic: "not observed"` — never read that as "the page made no
  requests". Check the outcome with `query_page` / `inspect_element` and `view_page`. To
  test the site's own controls (an SPA link, a site toggle), use a headless session.
- **`navigate { url }`** — load another page of the site in the session's tab: a comment
  page from a listing, a search, a profile. The url must be on the origin the session
  started on — same scheme, host and port — or a path on it; anything else answers
  `off-origin` before loading. Up to 20 per session. The site's own redirects are contained,
  not prevented: the answer says where the page landed (`url`, `redirected` — a fragment the
  page adds by itself isn't a redirect); when the
  site sent it off the site (a sign-in page) `onSite` is false and the page tools refuse
  with `page-away` until it is back (navigate again, or `reload_page`). On the site your
  previews are re-applied (`reapplied`). In an attach session a page load is a GET as the
  signed-in user, like following a link: never navigate to logout or action URLs.
- **Re-testing a fresh page load** (after a commit, or to see a rule on first paint):
  `navigate` to the page's current URL. It loads a new document, as following a link
  does, and costs one of the 20 navigations. Leave off any `#fragment`: a URL with one, on
  the page already shown, moves within the same document and loads nothing. Keep `reload_page` for recovery; it allows only a few uses, and once they are
  spent it answers `reload limit … reached`.

## `verify_across_pages`

It replays the working shim's rules against the *other* page-types the user has already
visited on this site (feed, search, profile, …), offscreen. It is a checklist over visited
routes, never a crawl. Report it honestly: matched → verified there; your rule no-match →
it does not apply there (likely different markup); unvisited page-types → unverified. A
route is replayed by its path alone, so a view that depends on the query string may not be
the one you previewed. Sign-in, session, account-action and checkout pages are never
replayed (the result counts them in `skippedSensitive`), so a view of that kind stays
unverified.

### A rule meant for several page types

The rule's fingerprint follows what your preview showed on *this* page, and every other
page type is checked against it:

- **A selector that matches one element here can still be a set.** A class that recurs
  across the site (a story card that appears once on one section page and many times on
  another) gets an element witness from a one-match preview, and on pages where it means
  other elements the rule is held for review instead of applying. Preview where it matches
  two or more, or declare `"cardinality": "many"` on the anchor.
- **Don't union different tags in one anchor** (`ytd-reel-shelf-renderer,
  ytd-rich-shelf-renderer` style lists). Where both show, the rule gets no fingerprint;
  where only one shows, it gets that tag's, and pages showing the other tag fail it. Write
  one rule per tag.

## Pages that hide what you're building on

- **A paywall.** A paywalled article often renders only the paywall: no comments, no
  recommendations, none of the page around the text. Rules for those parts can't be seen
  there, so their previews prove nothing. Build and verify on a page the site serves in
  full (a free post), opening the session there or using `navigate`. A site's own listing
  may say which posts are free (Substack's archive API, `/api/v1/archive`, marks them
  `audience: "everyone"`).
- **A popup shown once per visit** (a sign-up modal, an intro popup). The site
  usually remembers that it showed it, so it may not come back after a reload or on a
  later visit, and the committed rule may never be seen firing. Take the evidence where it
  does appear: the preview's match and box for the rule, and a `view_page` screenshot.
  Then say in the commit summary and to the user that the rule was verified in the
  preview only.

## Waiting for the site

`evaluate_in_page` waits 3 seconds for its answer, and that includes anything your
expression awaits. Pass `timeoutMs` (up to 10000) when the expression has to await
something the page is doing:

- **A short chain of reads**: two or three same-origin requests in sequence, each using the
  last one's answer, then return what you need. This is for reading. A request that changes
  the user's data is still a real action, whatever the timeout.
- **State about to render** after an SPA route change or a click through `interact_page`:
  poll against a deadline inside the expression, shorter than `timeoutMs`, and return an
  explicit answer when it isn't met:

  ```js
  const end = Date.now() + 6000;
  while (!document.querySelector('.next-item') && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return { found: !!document.querySelector('.next-item') };
  ```

  with `timeoutMs: 8000`. Never count iterations instead of time: sleeps alone can use up
  the whole budget.

A timeout stops the wait, not the page: what the expression started keeps running, a
request it sent completes, nothing is undone, and it can still be running during your next
call. Retrying a timed-out expression can repeat what it did. In a background tab of a
browser that throttles timers, a poll can wake late, so the tool's timeout may answer
before your own deadline does.

To wait longer than 10 seconds for the site to change (replies to arrive before a "since
your last visit" revisit, a feed to refresh), wait outside the page tools, e.g. a
background `sleep`, then look again. A session ends after 10 idle minutes, so keep each wait shorter than that.
