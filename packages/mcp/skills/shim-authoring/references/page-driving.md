# Page driving: `interact_page` and `navigate` (shim sessions)

Use these to test what you built and to move between pages of the site. Never dispatch
events, call `click()` or set `location` from `evaluate_in_page`, and never drive the page
from outside (AppleScript, another browser).

- **`interact_page { actions, settleMs? }`** — use your shim's own UI the way the user
  would: up to 10 actions, each `{ "click": selector }`, `{ "type": selector, "text",
  "clear"? }`, `{ "select": selector, "value" }`, `{ "press": key }` or
  `{ "scroll": { "by": px } }` (the viewport, positive down, at most 1500 per step). Clicks,
  typing, keys and scrolls are real (trusted) input; a `<select>` is set through the DOM.
  Each selector must match exactly one visible, enabled, uncovered element. In an attach
  session (the user's logged-in tab) it touches **only your shim's own output** — what your
  previews and committed rules put on the page — in the top frame, outside shadow roots
  (`scope: "shim-dom"`). Anything else is refused before any input, with a code:
  `not-shim-dom` (the site's own controls), `other-shim-dom` (another installed shim's),
  `site-activation` (your control sits in a site form, inside a site link or button, or in
  a label for a site control), `frame-unsupported`, `shadow-unsupported`, and
  `focus-not-shim` (a key or text while your shim's field doesn't have focus). The target
  and focus are re-checked right before every press and keystroke; an overlay or a focus
  change stops the batch. While the tab is not the selected one in its Shim window, or the
  window is minimized or hidden, nothing is sent: the call answers `tab-not-visible`, or
  a step stops with it when the user switches away mid-batch (input to an off-screen tab
  can be reported as sent without reaching the page). Ask the user to select the tab.
  Scroll steps may happen anywhere, and can make the site load or
  mark things. When the user touches the tab (keyboard or mouse) the batch stops
  (`interrupted: "user"`); so does any navigation. What your control does when clicked is
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
  not prevented: the answer says where the page landed (`url`, `redirected`); when the
  site sent it off the site (a sign-in page) `onSite` is false and the page tools refuse
  with `page-away` until it is back (navigate again, or `reload_page`). On the site your
  previews are re-applied (`reapplied`). In an attach session a page load is a GET as the
  signed-in user, like following a link: never navigate to logout or action URLs.
