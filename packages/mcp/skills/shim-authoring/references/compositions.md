# Compositions

Part of the shim-authoring guide (read `SKILL.md` first). Read this for any composition session: building or changing a page served at `compose://`.

A **composition** is a small local web app Shim serves at `compose://<mount>`: your own
HTML, CSS and JavaScript, which reads the user's sites through `window.api` with their
signed-in session — a dashboard over two music stores, a budget view over a bank's
transactions. There is no host page to anchor to: you write the whole page. Everything
in `SKILL.md` about the session loop, previews, evidence honesty and visual verification
holds; this file is what differs.

## The session

1. **Pick the composition.** `shim_list_tabs` lists every composition (`compositions[]`:
   `id`, `name`, `mount`) and gives an open composition tab its `compositionId`. To build a
   new one, start it in the session instead (step 2).
2. **Open.** `shim_open_session { compositionId, intent, dir }` — `tabId` is optional (the
   window the preview opens in). The user allows it in Shim; the composition's page opens
   there as your preview.
   For a **new** composition, pass `newCompositionName` instead of `compositionId`, and
   optionally `mount`: the address you propose, `compose://<mount>` — lowercase letters,
   digits and hyphens, not starting with a hyphen, not already in use (`shim_list_tabs`
   lists the mounts taken). Without one, Shim suggests one from the name. The user can
   change the address on the card before allowing, so read the answer: it carries the new
   `compositionId` and the `mount` they chose. A refused mount answers `mount-taken` or
   `invalid-mount` before any card. The new composition starts as a manifest with no
   hosts and an empty `index.html`, and is **kept only if you commit**: end the session
   without a commit and it is deleted, its address freed.
3. **Check out** (with `dir`, or `shim_checkout { dir }`): `manifest.json` plus every file of
   the composition, flat. Use an empty folder, placed like a shim's (`SKILL.md`, section 1): your
   working directory plus the composition's name, never a temp or scratch folder and never
   inside a code project, and tell the user where it is.
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

## The folder

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

## The manifest

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
  searches; the user confirms it on a card in Shim the first time it runs (in a session,
  once per endpoint), and the page's call waits for the answer, so tell the user to look
  at Shim before you preview code that makes it. Declined, it answers
  `read-override-denied`.
- **`mint`** — when a host wants a token rather than the session's cookies: `{ "url", ... }`
  with how to read the token (`tokenPath`, a dot-path into a JSON response, or `token`
  `{ after, chars, length? }`, the text right after a literal prefix, optionally in a page
  the mint page links to via `follow` `{ urlAfter, urlHost }`) and where to send it
  (`header`, with an optional `scheme` such as `"Bearer"`, or `query`). Check it with
  `verify_mint` before you put it in the manifest: it says whether extraction worked.
  `probe_request` shows a JSON mint response, never an HTML page or a script — for a
  token in one, ask the user where it sits, or try candidate prefixes with `verify_mint`.
- **`settings`**, **`permissions`**, **`storage`**, **`connections`** — the same
  declarations a shim makes (`references/api.md`, `references/databases.md`): settings fields (`text | secret | number | boolean
  | select`), `"permissions": ["ai"]`, local tables, remote databases.
- The mount (`compose://<mount>`) is not in the manifest: the user chooses it.

## `window.api`

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
  remote database the user connects in Shim's settings (`references/databases.md`).
- The page can't navigate away from its own `compose://` origin: a real click on an
  http(s) link opens a new tab; scripted navigation and `window.open` elsewhere are
  blocked.

## While you build it

Shim holds the composition for your session exactly as for its own build:

- **`api.storage` is a scratch copy** in the preview: it reads the composition's saved data
  plus what the preview wrote during your session, and its writes never reach the saved
  data — not even when you commit; they're dropped when the session ends. So a cache works
  while you build (a page that stores what it fetched won't fetch it again on every
  preview), but don't take a stored value as proof the real save works.
- **Other writes are refused**: `api.db.run` and any write through `api.fetch` answer
  `authoring-read-only`. Tables you declare are created only when you commit. Verify
  everything up to a database save; say plainly that the save itself could not be
  exercised.
- **Secret settings read `null`**, so the preview shows your unset-value path.
- **`api.ai` is refused**: every call resolves
  `{ ok: false, error: "ai-unavailable-in-external-session" }` — Shim never spends the
  user's key for your session. Make sure the page renders that failure. The preview
  evidence (or the next tool result) carries an `aiUnavailable` note when the page called
  it. **The first time, tell the user once, in these words:**

  > Shim can't use your Claude Code subscription, so AI features in this page won't run while Claude Code builds it. Open the composition in Shim (with an API key set) to see them work.

  Don't repeat it.

## The evidence

A composition preview answers `{ revision, applied, evidence }`:

| Field | What it says |
|---|---|
| `changes` | what the folder changed: `write-file app.js`, `delete-file old.css`, `set-manifest` |
| `changed[]`, `noop[]` | the files written, and those already identical |
| `warnings[]` | lint: an `api.fetch` to an undeclared host, `api.ai` without the permission, a dropped host or changed mint |
| `notes[]` | the user's answers (a host allowed), declined hosts |
| `console` | errors and warnings the page logged since the previous preview |
| `aiUnavailable` | the page called `api.ai` (above) |
| `requestWarnings` | one site got a burst of requests (20 or more in a minute) or answered like a rate limit — slow down and cache (`references/api.md`) |
| `pageAway` | the preview tab left the composition: nothing was written — `reload_page`, then preview again |

A refused preview answers `applied: false` with `error` and `problems`:
`invalid-working-copy` (the manifest, the entry, a subfolder, a binary file, the bounds),
`reach-denied` / `reach-timeout` (the host card), `malformed-working-copy`.

## The tools

- The page tools act on the composition's preview. `evaluate_in_page` runs in an isolated
  world over its DOM (the page's own globals and `window.api` are not visible).
  `verify_across_pages { paths }` loads each of the composition's HTML pages and reports
  load failures and console errors.
- **`interact_page { actions }`** — click, type, select or press in the preview with real
  input (up to 10 actions). Use it to exercise behavior, then check the result with
  `query_page` / `inspect_element` and `view_page`. (`scroll` steps and `navigate` are
  shim-session tools; a composition session answers `navigate` with `shim-only`.)
- **`read_calls { all?, limit? }`** — the requests the page made through `api.fetch`:
  method, host, path template, status — never a body. By default only calls from
  documents running your latest code. **A data feature is verified when its call is here
  with a 2xx status** and the page shows the result (a DOM check plus a screenshot); a
  call that failed, or none at all, means it isn't working yet. Its `warnings`, and
  `interact_page`'s `requestWarnings`, carry the same burst and rate-limit warnings as the
  preview evidence.
- **`probe_request { host, path }`** — one GET of your own through the composition's real
  fetch path, answering the status and, for a JSON or form body, up to 20,000 characters
  of it. Anti-forgery token values in it (CSRF / XSRF fields, Reddit's `modhash`,
  `authenticity_token`, …) read `"[redacted: csrf]"`, counted in `redacted`: the field is
  there, the value is never yours to need — the page's declared writes carry it. A string
  value that names such a token reads `"[redacted: possible csrf]"`. Any other body (HTML,
  a script, text, XML — a block page too) is never shown: you get `withheld`
  `{ format, bytes }` and the status. The host must
  be declared in the manifest, allowed by the user (the preview's card), **and** granted to
  your session with `request_sources` — otherwise it answers `host-not-declared`,
  `host-not-allowed` or `host-not-granted` before any request. GET only. For designing a
  mint or checking a live response shape; it is never evidence that the page works.
- **`verify_mint { config, testEndpoint? }`** — runs a proposed `mint` config end to end
  against the user's real session: Shim first asks the user, on a card, to let the mint
  host be called signed in as them (and the `follow` host, on a second card), and nothing
  is requested before they answer. Declined, or unanswered in two minutes, it answers
  `denied` — ask the user rather than retrying. Otherwise it answers whether the token was
  extracted (`detail` says why not) and, with a `testEndpoint` (a read-only endpoint on the
  mint host's site — same registrable domain, so a mint on `auth.example.com` can test
  `api.example.com` but never `api.example.net` — and either the mint host itself or a host
  `probe_request` may reach; otherwise `test-host-not-allowed` before any card), the status
  it got. It never returns the token or any body. Each call
  asks again, unless the user chose "allow for this session" on that host's card: then
  later calls against it run without a card until they revoke it or the session ends.
  When you expect a card, tell the user to look at Shim first.
- The API map tools (`references/site-data.md`) work the same, except `replay_endpoint` runs GET and HEAD
  only (`read-only`).
- **`inspect_storage`** and **`query_db`** (`references/site-data.md`) read the composition's own saved
  data: its `api.storage` rows, its declared tables (`dbSchema`), and each declared remote
  connection and whether the user configured it. While you build, the page's own writes
  never reach that data (`api.storage` writes go to the preview's scratch copy), so what
  they show is the data as of the last commit. `read_sibling_shim` is
  for shims (`shim-only`).
