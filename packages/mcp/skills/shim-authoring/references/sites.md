# Where a shim runs: `match.hosts` and `match.paths`

Part of the shim-authoring guide (read `SKILL.md` first). Read this before you add, remove or
change a site in `shim.json`'s `match.hosts`, or limit the shim to some pages with `match.paths`.

A shim runs on every page whose host one of its `match.hosts` patterns covers:

- `example.com`: that host on any port; never its subdomains.
- `localhost:5173`: that host on that port only.
- `*.example.com`: every subdomain (`www.`, `old.`, `a.b.`), never `example.com` itself. Add
  both when you mean both.

**Changing it in a session.** On any shim that isn't global, edit `match` in `shim.json`
(`{ "hosts": [ … ] }`, nothing else under `match`) and preview. Rules for a pattern you add:
lowercase, the hostname as a browser shows it (an internationalized name in its `xn--`
form), no scheme, path, trailing dot or IPv6 address; a port only on an exact host; a
wildcard on a name with at least two parts (`*.com` is refused) and never with a port. A
preview may add at most 20 patterns that cover something new compared with what is
committed. The list can't be empty, and in a Shim browser session it must still cover the
page you are on. A global shim (`"global": true`) runs wherever it has a per-site
implementation, so its `match` stays `not-editable`.

**Nothing widens until a commit, and the person decides.** A preview runs your rules only
on the session's own tab, whatever `match.hosts` says. When you commit, the Shim browser's
commit card lists every new site (a wildcard spelled out as "every subdomain of …"), says
whether your rules were tried there, and the person approves or denies. A deny commits
nothing and leaves the session open: drop the site, or ask the user, and commit again. A
site that's already committed is never asked about again, and narrowing never asks.

**An existing shim on a site it doesn't cover.** In the Shim browser,
`shim_open_session` for a shim on a page outside its `match.hosts` answers
`target-not-allowed` (`this shim doesn't run on <host>`). Open the session on a page the
shim already runs on, add the new host to `match.hosts` there, and commit (the person
approves the new site on the commit card); then open a session on the new site.

**A new site is untried.** Your session's evidence covers only the pages it previewed on:
a wildcard is never verified by one subdomain. The commit's `notes` name every pattern
your rules weren't tried on in this session; a site an earlier session tried is listed
too, because the rules you just changed weren't checked there. To try a new site, commit first, then open a session on a
page of that site (`shim_open_session` with its `url`; the person allows that tab too).
In that session the shim's committed rules run there, and you can preview and fix rules
for that site. Tell the user which sites you didn't try.

**Headless.** There is no Shim to ask, and the `.shim` file is the user's to install, so a
headless session writes a widened `match.hosts` as it stands. Its preview and commit notes
say that nobody approved the new sites. Pass that on: Shim's import lists every site before
it installs the file. On a page `match.hosts` doesn't cover, every headless preview warns
and reports no rule better than `partial`. Add the page's host to `match.hosts`, then
preview a rule change there to get `full`. A preview that changes only `match` runs no rule
and says so.

## Limiting a shim to some pages: `match.paths`

`match.paths` limits a shim to some pages of its hosts: `{ "hosts": ["example.com"], "paths":
["/recipes/*", "!/recipes/print"] }`. Entries are globs on the path, or `re:` regexes; an entry
starting with `!` excludes. With no include entry, every page runs except the excludes. A list
with an entry that doesn't compile runs the shim nowhere, and the preview refuses it. At most 50
entries. An absent list and `[]` are the same: every page.

**Only in a Shim browser session.** Headless refuses a `match.paths` edit (`malformed-shim-folder`):
it writes a file nobody approves. A global shim, or one with a virtual route (`mount-route`), can't
be limited by paths. Shim for Chrome refuses it too.

**Paths or anchors?** Use paths when the whole shim belongs to some page types (a notes field only
on track pages), or to keep shim code off account, sign-in and checkout pages. Use anchor scoping
when the page types are one single-page app that navigates without loading: paths are decided once
per page load, from the URL it loaded at, so moving between pages inside the site never starts or
stops the shim. A rule whose anchor simply isn't there on other pages needs no path at all.

**What the preview tells you.** While the working paths differ from the committed ones, every
preview, an unchanged folder's included, carries a `paths` block: `widens` (will the commit ask
the person), the current page's verdict under the committed and the working list at the URL it
loaded at (`currentPage.atLoad`) and, after an in-page move, at the URL shown now; and every
page this session's tab has shown (loads and in-page moves) with `committed` and `working`
verdicts (`in`, `out`, `unknown`: not judgeable, never a guess), the pages that change first.
Judge your patterns against those pages only: you can't see which other pages exist or which
the person visits. If the working list keeps the shim off the page you are on, every rule is
capped at `partial`; preview on a page it covers. A warning says when the session saw the page
move between two pages the new list puts on different sides: that move doesn't start or stop
the shim, so scope such a site by anchors.

**The person decides a widening.** A change that lets the shim run on pages it was kept off
(an exclude removed, an include added or changed, the list cleared; a changed `re:` entry counts)
is a line on the commit card in plain words about the pages it newly reaches, with the exact
patterns behind a disclosure. A deny commits nothing and leaves the session open. A narrowing,
or paths on a shim you just created, asks nothing: the person reads where the shim now runs in the
chat. If the committed paths change while the card waits, the commit answers `stale-paths`:
preview again, then commit.

**Paths aren't isolation.** Previews, `verify_across_pages`, forwarded iframe rules and a host
redirect aren't limited by paths, and a shim's page code can still read whatever the page it runs
on exposes. Don't rely on paths to keep a rule from running somewhere it would do harm.
