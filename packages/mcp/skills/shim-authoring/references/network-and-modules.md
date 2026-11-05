# Network and module rules

Part of the shim-authoring guide (read `SKILL.md` first). Read this before writing a `redirect`, `rewrite-response` or `intercept` rule.

**`redirect`** — swap the host of top-level navigations before the page loads (no anchor,
no handler):

```json
{ "kind": "redirect", "from": "www.reddit.com", "to": "old.reddit.com",
  "exceptPaths": ["/media", "/gallery", "/poll", "/settings", "/notifications", "/coins", "/premium", "/message", "/wiki"] }
```

`match.hosts` must include `from` (add it there if it isn't: `references/sites.md`); only top-level navigations are redirected; path, query and
hash are kept. `to` may be any site, including another domain (twitter.com → x.com): the
boundary is consent, not domain. Each new redirect target asks the user at commit, and a
target they haven't allowed never redirects. Not on a global shim (see `mount-route`
in `references/handlers.md`).

**`redirect` with `rewrite`** — change the path and query of a full page load before it
leaves, on the same site (add `to`, a bare lowercase hostname, to change host too). Prefer it
to a script calling `location.replace`, which loads the wrong page first:

```json
{ "kind": "redirect", "rewrite": { "drop": ["tl"] } }
{ "kind": "redirect", "rewrite": { "path": "/search", "set": { "udm": "14" }, "unless": ["udm", "tbm"] } }
{ "kind": "redirect", "rewrite": { "path": "/shorts/:id", "toPath": "/watch", "set": { "v": ":id" } } }
```

`path` matches the pathname: literal segments and whole-segment `:name` captures, all
required (no `?`, `*` or regex; omitted = any path). `toPath` is the new pathname from
literals and declared `:name`s (omitted = kept). `set` sets query keys to a literal or a whole
`:name`, `drop` removes keys, `unless` skips the whole rewrite when any listed key is present.
Every other parameter and the fragment are kept byte for byte. It must not match its own
result (give it an `unless`, or a `path` its output leaves): one that would fire again never
runs. It runs on GET full loads only — typed URLs, outside links, reloads, the site's links
and forms that load a new page — never on the site's in-page navigation (`pushState`); for that
the work stays a `script`. It respects `match.paths`; when two shims rewrite the same page the
one higher in the user's list wins alone; a same-site rewrite asks nothing at commit, a `to`
asks like any redirect target. A preview can't run it: the rule's status line simulates it
against the page's current URL. Headless sessions refuse it, like every network rule.

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
when the site fetches again — reload before concluding a rewrite doesn't work. Rules whose
endpoints overlap (in this shim or another on the host) all run, chained in priority order:
each transform gets the previous one's output, the top shim in the sidebar runs last, and a
throw or `undefined` from one passes its input on to the next.

`endpoint.path` is a route template matched against the request's pathname (query and
hash stripped), anchored at both ends and case-sensitive: `/literal`, `/:name` (one
segment, captured into `ctx.params.name`), `/:name?` (an optional segment), `/*` (the
rest, as `ctx.params['*']`). `/i/api/graphql/:queryId/:operation` matches every GraphQL
call and gives you `ctx.params.operation` to branch on — match on stable names like that,
not on a per-deploy hash. `method` is optional (any method when left out).

A preview installs the rewrite live, for fetches that happen after it. Some sites keep
their own reference to the original `fetch` or `XMLHttpRequest` from page load (x.com
does), and those calls bypass a wrapper added later: the stats stay at 0 while the page
clearly keeps fetching. Only a committed, enabled rewrite is installed from the very start
of a page load; a preview is re-applied after the page loads, so `reload_page` alone does
not fix this. Commit, then reload to verify, and tell the user that is how it was checked.

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
