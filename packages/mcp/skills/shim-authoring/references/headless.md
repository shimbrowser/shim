# Headless mode

Part of the shim-authoring guide (read `SKILL.md` first). Read this when `shim_status` offers only headless, when an open answers `mode: "headless"`, or when the user wants a standalone `.shim` file.

A session runs headless when you open it on a `url` and no Shim browser is reachable, or
when you pass `mode: "headless"`, or when the server runs as `shim-mcp --headless`. The
session opens its own Chromium page (a fresh profile, no logins, never Shim's). The
`shim_open_session` answer always says `mode` and `modeReason`: tell the user which one you
are in, because what a commit saves differs. With Shim running, a bare `url` opens an
attach session on a new Shim tab (`SKILL.md`, section 1, step 3) unless you pass `mode: "headless"`:
do that only when the user wants a standalone `.shim` file.

Headless needs Playwright. If it is missing, opening answers `playwright-missing` (or
`chromium-missing`, or `system-deps-missing` on Linux) with the exact command to run. Give the user that command; don't run
installs on their machine without asking.

The loop is the same, with three differences:

- **Open on a url and a file.** `shim_open_session { url, intent, shimFile, dir }` works on
  the `.shim` file `shimFile`: an existing one is loaded and its rules run on the page at
  once; with `newShimName` a new shim starts there (default `<dir>.shim`). A headless
  session has no tabs and no shim library, so `shimId` answers `requires-shim-browser`,
  and so do `verify_across_pages`, `interact_page`, compositions and their
  tools, the API map tools and the data tools (`references/site-data.md`). A headless-only server also
  refuses `shim_list_tabs` and `shim_launch`.
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
- **Requests from a handler, headless.** Since `api.fetch` is refused, a handler's plain
  `fetch` is the only way out, and it runs under the page's CORS. It reaches the page's
  own site, and a third-party API only if that API sends CORS headers for the page's
  origin. The fresh profile has no logins, so the site answers as it would a logged-out
  visitor. In the Shim browser, keep `api.fetch` for third-party APIs (no CORS, no
  cookies) and the page's `fetch` for the site's own endpoints. A handler written around
  headless's limits should still use `api.fetch` once it runs in Shim.
