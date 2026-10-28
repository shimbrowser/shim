# Where a shim runs: `match.hosts`

Part of the shim-authoring guide (read `SKILL.md` first). Read this before you add, remove or
change a site in `shim.json`'s `match.hosts`.

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

**A new site is untried.** Your session's evidence covers only the pages it previewed on:
a wildcard is never verified by one subdomain. The commit's `notes` name every pattern
your rules weren't tried on. To try a new site, commit first, then open a session on a
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
