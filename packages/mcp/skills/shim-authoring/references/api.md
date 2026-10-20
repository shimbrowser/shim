# The runtime `api`

Part of the shim-authoring guide (read `SKILL.md` first). Read this before writing a handler that uses `api`. The database members (`api.db`, remote connections) are in `references/databases.md`.

Handlers get `api`. Every call that can fail resolves `{ ok: false, error }` instead of
throwing — always branch on it and render a usable state.

**While previewing, handlers get a preview `api`, not the shim's.** `api.storage` reads and
writes a scratch bucket apart from the shim's saved data: what the shim already saved isn't
visible to the handler (read it with `inspect_storage`, `references/site-data.md`), and what a preview stores
never reaches the shim. That bucket is one per site, shared by every preview there (other
shims' and earlier sessions' too) and never cleared, so it may already hold keys — don't read
a value you didn't just write as evidence, and prefer keys unique to this shim.
`api.settings` has no values, `api.ai` calls are refused (below), and `api.db`,
`api.storage.pack`, `api.storage.global` and `api.shared` are absent. Handlers must render a
usable state in every one of those cases anyway, and say in your summary what you could only
verify after a commit.

**After `shim_commit`, the committed rules run on the session's tab with the shim's real
`api`**: `api.db`, its saved `api.storage` and settings (`api.ai` stays refused). So check
the data path in the same session: commit, `reload_page`, use the feature, then read what
landed with `query_db` / `inspect_storage` and look with `view_page`. Previewing again
puts the preview `api` back for the rules you change.

**`api.ai` is refused while your session is open.** On the session's tab, every `api.ai`
call from a previewed handler — and from the shim's committed rules there — resolves
`{ ok: false, error: "ai-unavailable-in-external-session" }`: Shim never spends the user's
key for your session. Make sure the handler renders that failure. The preview evidence (or
the next tool result) carries an `aiUnavailable` note when a handler called it. **The first
time, tell the user once, in these words:**

> Shim can't use your Claude Code subscription, so AI features in this shim won't run while Claude Code builds it. Once the session ends, reload the page in Shim (with an API key set) to see them work.

Don't repeat it.

- **`api.cleanup(fn)`** — teardown for side effects (`references/handlers.md`).
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
- **`api.onRouteChange(fn)`** — for `mount-route` pages (`references/handlers.md`) only. A `script`
  handler's `api` has no `onRouteChange`: to follow in-site navigation, see `references/handlers.md`.
- **`api.modules.invoke(id, fnPath, args)`** — for modules an `intercept` declared.

**Never hammer the site.** One request per row (a 100-call burst on mount) gets the user
rate-limited and their account throttled. Prefer fields already in a list response, cache
per item in `api.storage`, fetch lazily for what the user interacts with, and back off on
4xx/5xx instead of retrying. Every preview of a composition reloads its page, so a page
that caches nothing re-sends all its requests each time: Shim warns
(`requestWarnings`, `references/compositions.md`) when one site gets more than 20 requests in a minute or answers
like a rate limit (429, 503, or a 206 to a request that asked for no range). When you see
one, stop previewing against that site for a while and cache before you go on.
