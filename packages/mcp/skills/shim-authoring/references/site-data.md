# The site's API and the shim's saved data

Part of the shim-authoring guide (read `SKILL.md` first). Read this when a shim needs the site's own data or API, or when the ask depends on what a shim has already saved.

## The site's own API: the API map tools

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
`too-many-pending`, `discovery-off` (Discovery is off in Shim: there is no map to read —
`request_sources` still asks and grants, with every site under `noApiMap`, and in a
composition session that grant is all `probe_request` needs). Don't re-ask for what the
user declined; a timeout or a full queue of cards is not a no, so those can be retried. In the handler, call the
endpoint with the page's `fetch(url, { credentials: 'include' })` (`references/api.md`).

## What the shim has saved: the data tools

All three only read, and only this shim's own data (and its pack's).

- **`inspect_storage`** — everything the shim has saved: one row per (origin, key) of
  `api.storage` with the parsed value, plus `packRows` for a shim in a pack, `globalRows`
  for a global shim, and `dbSchema` (the live tables and row counts) when it declares
  `storage`. This is the committed data — a preview's scratch bucket (`references/api.md`) is not in
  it. Use it when the ask depends on what is already saved ("the counter is wrong").
- **`query_db { sql, connection? }`** — a read-only SQL query against the shim's own
  database (its `storage` tables) or a declared remote connection. SELECT only: anything
  else is refused before it reaches the database. Results are capped; add `LIMIT`. A
  remote connection whose declared tables haven't been set up on it yet answers
  `schema-not-ready`: a session never creates them — the shim's own next use of the
  connection on its page does, so ask the user to open it and try again.
- **`read_sibling_shim { name }`** — another shim in this shim's pack, in full: its spec,
  handler source and last few exchanges. Use it before building on a sibling's data or
  conventions (storage keys, class prefixes). A shim in no pack answers that it has no
  siblings; a wrong name answers the valid ones.
