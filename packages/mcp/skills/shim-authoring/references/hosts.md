# Two attach hosts: the Shim browser and Shim for Chrome

Part of the shim-authoring guide (read `SKILL.md` first). Read this when `shim_status`
reports a `chrome` host, when a tab from `shim_list_tabs` carries `host`, or when an open
answers `ambiguous-target` or `multiple-targets`.

An attach session can run against two hosts: the Shim browser (its control endpoint) and
Shim for Chrome, the extension, through its bridge. Both serve the same session routes, so
every tool works the same; what differs is where the tab lives and where a commit lands
(the browser's library, or the extension's installed shims).

- `shim_status` reports each host: `attach` is the Shim browser, `chrome` the extension's
  bridge, each `available` or not and why.
- `shim_list_tabs` lists the tabs of every reachable host, each tab with `host: "shim"` or
  `host: "chrome"`. The two hosts number their tabs separately, so the same `tabId` can
  appear under both.
- `shim_open_session` goes to the host that listed the `tabId`. When both listed that
  number, or neither did, the answer is `ambiguous-target`: pass `target: "shim"` or
  `target: "chrome"` with the `tabId`. A `url` while both hosts are reachable answers
  `multiple-targets`: pass `target` to say which opens it. With one host reachable, nothing
  extra is needed. Compositions always go to the Shim browser.
- The open's answer carries `host`, and every later call on that session goes to that
  host. A host that stops answering fails that session with `shim-not-running`; the other
  host is never tried in its place.
- Shim for Chrome serves no compositions, no API map and no `interact_page` in this
  version; those answer `requires-shim-browser`.
- On Shim for Chrome a handler gets `api.storage`, `api.settings` and `api.fetch`;
  `api.ai`, `api.db` and the shared code-space answer `not-available-in-shim-for-chrome`
  in their own shape. A `secret` field must declare `use` there (a plain `secret` is
  refused at preview and at commit): the extension keeps the value in its passphrase
  vault and places it on the request itself. A preview reads it as unset and a preview's
  fetch naming `secrets` answers `secrets-not-available-in-session`, so verify the
  "add your key in Settings" state, not the keyed call; the user enters the key and
  approves it in the extension after the commit. `api.fetch` has the browser's bounds (cookie-less, http(s), no local-network
  address, 5 MB, 15 s), but it reads directly only the shim's own sites, never a site
  Shim for Chrome holds for another shim, and anywhere else only a site that allows
  cross-origin reads (CORS), including a placed secret's destination when the call
  names no `secrets`: prefer endpoints that send `Access-Control-Allow-Origin`, or
  the shim's own site.
- A preview on Shim for Chrome does not get the browser's isolated preview `api`: when the
  shim is installed and runs on the page, `api.storage` reads and writes its saved data
  (a preview's write persists), and `api.settings` reads the values the user saved,
  against the working declaration (a field you just declared reads its default).
