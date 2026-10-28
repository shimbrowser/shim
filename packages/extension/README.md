# @shimbrowser/extension

**Shim for Chrome** runs shims in the Chrome you already use. A shim is a set of personal
changes to a website (hide this, restyle that, add a field here), authored in the Shim
browser or with Claude Code through `@shimbrowser/mcp`, saved as a `.shim` file, and
applied here as a local layer on the live site.

The extension is a runtime host, not a second authoring product: no chat, no model, no
key. It runs the same engine as the Shim browser (`@shimbrowser/core`, the page bundle,
byte for byte) and tells you honestly what it can run.

## Install (beta)

Shim for Chrome isn't on the Chrome Web Store yet. Install it from a GitHub release; it needs
Chrome 120 or later (or another Chromium-based browser: Brave, Edge, Chromium).

1. **Download** [`shim-for-chrome.zip`](https://github.com/shimbrowser/shim/releases/latest/download/shim-for-chrome.zip)
   and unzip it into a folder you will keep. Chrome runs the extension from that folder, so
   don't delete or move it later.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder. Shim for Chrome appears with the
   ID `cihnpejdfdhimjfkegngpndfpiecjhoe`. Every install has this same ID.
4. Pin it: open the extensions menu (the puzzle piece in the toolbar) and pin Shim for Chrome.
5. **Allow user scripts.** On the extension's card, click **Details** and turn on **Allow user
   scripts** (Chrome 138 and later; on Chrome 120 to 137, Developer mode alone does this).
   Shims with script handlers need it. Without it, the extension runs only declarative rules
   (hide, restyle, inject and the like), refuses to install a shim that has handlers, and its
   popup says how to turn them on.
6. **Install a shim.** Click the toolbar icon, then **install a .shim file**, and choose one
   (a `.shim` file is a shim exported from the Shim browser or saved by Claude Code). The page
   lists what the shim does and the sites it runs on. Install it, and Chrome asks for access
   to exactly those sites: allow it. The shim now runs on those sites, including in tabs
   already open.

Chrome may warn about extensions in developer mode when it starts. That warning is about
every unpacked extension: keep Shim for Chrome enabled.

### A shim's settings

A shim can ask for settings (a name, a choice, a number). Its card in the popup then has a
**settings** button, and says **needs setup** while a required one has no value. Values stay
in this browser and are never part of an export. A shim that asks for a secret (an API key,
a token) can't be installed here: Chrome gives extensions no encrypted storage, so such a
shim runs only in the Shim browser for now.

### Let Claude Code author on your Chrome tabs (optional)

With this on, Claude Code can open a session on a tab here, preview changes on the live page
and save them as a new version of the installed shim.

1. Install the `shim` CLI and the Claude Code plugin
   ([instructions](../mcp/README.md#install-beta)).
2. Register the bridge once (Chrome starts it when the extension asks for it):

   ```sh
   shim extension install-host
   ```

   This writes a native messaging host manifest for every Chromium-based browser it finds,
   allowing only Shim for Chrome's ID, and the small wrapper script it runs. `shim extension
   status` checks it.
3. In the extension's popup, turn on **let Claude Code author here**. It says *connected*.

Each session Claude opens waits on an attach card first: who is asking, for which shim and
site. Nothing runs on the tab until you allow it. While a session holds a tab, Chrome shows a
bar saying that Shim for Chrome is debugging the browser (the session's previews and
screenshots use Chrome's debugger API). The bar goes away when the session ends. Turning the
setting off ends every session at once.

### Update

Download the new `shim-for-chrome.zip`, replace the folder's contents with it, and click the
reload icon on the extension's card in `chrome://extensions`. Your shims, their settings and
saved data stay. If you set up the bridge with `shim extension install-host`, update the CLI
too.

### Remove

Remove it on `chrome://extensions`. That deletes every installed shim, its settings and
saved data; export the shims you want to keep from the popup first. The bridge's files stay
until you delete them (`shim extension status` shows where they are).

## Permissions

Shim for Chrome asks for what it uses and nothing more. Site access comes one shim at a
time.

| Permission | What it is for |
|---|---|
| Site access (`optional_host_permissions`) | Asked when you install a shim, for exactly the sites it names, and given back when you remove it. Never all sites at once. |
| `userScripts` | Runs shims with script handlers in Chrome's user-script world, where a site's own security policy can't block them. Needs **Allow user scripts**. |
| `scripting` | Runs declarative shims as content scripts, and applies a change to tabs already open. |
| `storage` | The extension's own bookkeeping between restarts. Your shims live in the extension's database, which is removed with it. |
| `webNavigation` | Notices page loads, to re-check whether user scripts are allowed and to wait for a tab Claude opened to finish loading. |
| `debugger` | Only during a Claude Code session, only on that session's tab: previews, screenshots and the page tools. Chrome shows its bar while it's attached. |
| `nativeMessaging` | Talks to Claude Code through the bridge you register, only while **let Claude Code author here** is on. |

It never asks for `tabs`, cookies, history or downloads. A shim's `api.fetch` sends no
cookies, can't reach your local network, and reads directly only the shim's own sites;
anywhere else a site must allow cross-origin reads.

## Status

Beta. What works today:

- Install a `.shim` file from the popup. Installing asks Chrome for access to exactly
  the sites the shim names, and nothing else.
- Declarative rules run on every matching page: `hide`, `restyle`, `reorder`, `reshape`,
  `remove`, `inject-element`, `inject-html`, plus the shim's own stylesheet.
- With user scripts allowed (full mode, below), rules with handlers run too: `script`
  and `replace-root`, with `api.storage`, `api.settings`, `api.fetch` and `api.cleanup`.
  Handlers compile in Chrome's user-script world, so a site's own CSP cannot block them.
- A shim that declares settings gets a settings page, opened from the popup, and its
  handlers read the values with `api.settings`. Saving a value re-runs the shim on the
  pages already open. Values stay in this browser and never travel with an export. A
  `secret` field is refused at install: the extension has no encrypted store, so a shim
  that needs a credential runs in the Shim browser.
- `api.fetch` is brokered by the extension's worker with the Shim browser's bounds:
  cookie-less, http(s) only, no loopback, private or link-local address, at most 5 MB
  read and 15 s. A shim's handlers read its own sites directly, but never a site the
  extension holds for another shim; anywhere else a site must allow cross-origin reads
  (CORS). A request redirected onto a private address, or onto another shim's site, is
  refused before its body is read. The extension cannot resolve DNS, so a name that
  resolves to a private address is not refused here as it is in the Shim browser; its
  response is readable only on the shim's own sites, which it runs on anyway.
- Enable, disable and remove shims from the popup; changes reach the pages already open,
  no reload. Removing a shim releases the site access it asked for.
- When a site changes, the engine's deterministic rebase ladder runs in the page and the
  extension keeps the result: a healed anchor becomes a new version of the shim (every
  earlier version is restorable from the popup), a rule the ladder could not re-find is
  held for review and shown in the popup, never silently re-pointed. Repair means
  exporting the `.shim` file and fixing it in the Shim browser or with Claude Code.

- The extension is a `PageHost` (`src/page-host.ts`): what an authoring session needs
  from one tab, over the Chrome DevTools Protocol through `chrome.debugger`. Previews,
  evaluate in the engine world and the page's, screenshots, trusted input, loads, runtime
  events and the engine's console lines, under the same conformance suite the Shim
  browser and the headless host run (below).
- Claude Code can author on a real Chrome tab: the popup's "let Claude Code author here"
  connects the extension to `shim bridge`, a native messaging host that serves the Shim
  browser's control endpoint over a socket, and each session the agent opens waits for
  you on the attach card. Commits land as new versions of the installed shim (below).

Not yet: the Chrome Web Store, and secret settings (they need an encrypted store first).

## Modes

Chrome extensions cannot compile code in a content script or an extension page. The
engine needs compiled handler functions, so rules with handlers run only in **full
mode**, where the engine runs in a user-script world whose CSP permits `eval`. Full mode
is on while the user allows user scripts for the extension: the "Allow user scripts"
toggle on the extension's card at `chrome://extensions` (Chrome 138 and later), or
developer mode there (Chrome 120 to 137). The popup says which mode is on and opens that
page. Without it, the extension runs in **declarative mode** and refuses a shim with
handler rules at install, naming the toggle. Everything declarative works in both.

Flipping the toggle fires no event and reloads nothing, so the extension measures the
mode again on every page load and every message, and re-syncs when it changed. Every
installed shim is checked against the mode in force: one that needs full mode stops
while user scripts are disallowed (on open pages too, at their next sync), stays
installed, and shows "needs user scripts" in the popup until they are allowed again.

Each mode is one `PageHostCapabilities` constant (`EXTENSION_CAPABILITIES`,
`EXTENSION_DECLARATIVE_CAPABILITIES`), and every install preflights against the one in
force. A capability is advertised only while its real-browser case passes
(`test/extension-smoke-harness.ts` for declarative mode, `test/extension-full-mode-harness.ts`
for full mode).

The install check itself (parse, lint, the handler syntax probe) runs in a sandboxed
extension page (`prepare.html`), the one kind of extension page whose CSP permits `eval`,
so a handler that does not parse is refused before anything is written.

## Sessions

An authoring session does not depend on the mode. Its `PageHost` attaches Chrome's
debugger to the tab and creates an isolated world of its own there (`shim-core`), where
it evaluates the engine and compiles each preview's handlers: the protocol's evaluate is
subject to neither the site's CSP nor the user-scripts toggle. The session's capabilities
are a third constant (`SESSION_CAPABILITIES`): every mutation kind including `script` and
`replace-root`, trusted input, and `api.storage`, `api.settings` (the installed shim's
values, read against the session's working declaration, so a field just declared reads
its default), `api.fetch` (the same broker) and `api.cleanup`; `api.ai` and the rest
answer `not-available-in-shim-for-chrome` in their own shape. A preview of a committed rule holds that rule for the preview's duration and
gives it back after: the host tells the page's runtime the whole set of rules it holds of
each shim and waits for the ack before the preview goes up (a hold the page does not
confirm in time is no hold: the preview stays down and the session is told in its
console; whether a runtime is there to ask is the install registry's word, not the
channel's, so a runtime between ports is waited for; the hold sequence outlives the
worker, kept in session storage and seeded no lower than the clock, and a runtime
answers a hold that fell behind as not applied, which is no hold), and removes the preview before it releases the hold, so the two forms of one
rule never run side by side; a preview key that moves to another rule takes its old
preview down before the old twin comes back. A hold
is a claim the runtime keeps through the shim's reboot (disabled and enabled again under
the preview) and takes from the worker's bundle answer when it boots after the hold; a
rule the rebase ladder already swapped for a healed form is held and released in that
form. Chrome shows its own "is debugging this browser" bar on the tab for as long as the
session lasts, and the `debugger` permission is the one this asks for. A session ended
from that bar, or by the tab closing, is cleaned up: the page's runtime drops the
session's previews (a DOM event into the session's own world, the one way left to reach
it) before the held rules come back, and a page with no runtime drops them itself once
the host stops answering its pings.

`test/extension-conformance-harness.ts` runs the shared suite
(`@shimbrowser/core/page-host-conformance`) against the built extension's host, the way
the Electron and Playwright hosts run it: a session capability is advertised only while
its cases pass here too. `test/extension-session-harness.ts` runs a session beside an
installed shim: the hold through every path above, and the session ended from outside.
Both drive the worker's host through the worker's own handle on it (`shimPageHosts`),
one member call at a time (`test/host-proxy.ts`).

## Authoring through the bridge

With the popup's "let Claude Code author here" on, the service worker holds a native
messaging port to `shim bridge` (`@shimbrowser/mcp`), which Chrome starts for it. The
bridge listens on a Unix socket under Shim's user data directory (`bridge/chrome.sock`,
0600 in a 0700 directory, a bearer token compared in constant time) and writes
`control-chrome.json` beside the Shim browser's `control.json`, the same discovery
format with `host: "chrome-extension"`. The MCP server reads both files, so
`shim_list_tabs` lists this Chrome's tabs with `host: "chrome"` beside the Shim
browser's, and a session opened on one of them runs here. Set it up once:

```
shim extension install-host
```

That writes the host manifest for every Chromium found (Chrome, Chromium, Brave, Edge on
macOS and Linux; `--user-data-dir` for one profile) and the wrapper it runs, in a private
directory under Shim's user data. The manifest allows only Shim for Chrome's ID, which the
extension's manifest pins with its public key (`--extension-id` for a build without it). `shim extension status` reads it back and says whether a
bridge is up. One bridge owns the endpoint at a time: a second browser's bridge exits.

Every request the bridge relays reaches the worker over that one port, and every route
the Shim browser's endpoint serves is served here (`src/control.ts`) from the same session
registry (`@shimbrowser/core/session-registry`, over core's shim session). What differs:

- **Consent.** Each open waits on the attach card (`attach.html`, a small window of the
  extension's own): who is asking, for which shim, on which site, and that the agent will
  run code in the page as you. Allow once, allow this site until Chrome restarts, or deny;
  two minutes to answer. Allowing also asks Chrome for the site permission the session
  still needs, since only a click can; a remembered site shows the card again when its
  permission is gone. Nothing on a route answers a card.
- **The artifact.** A session works on the installed shim: begin applies nothing, since
  the committed rules already run (a disabled shim, or one the mode in force does not run,
  opens too, and the agent is told its rules are not up). A removed rule is held down with
  no preview to show. A commit replays the session's changes onto the shim as stored now,
  so what other tabs learned meanwhile on untouched rules survives, and answers at once;
  the page is then brought to the new version (previews off while their committed twins
  stay held, the tab synced, the holds released), and the next answer says so. A rule the
  rebase ladder moved since the session began is a conflict: the session is reset to the
  shim as it is now, and the agent checks out again. A commit that needs full mode while
  user scripts are off is refused before anything is written.
- **A new shim** for a session is a draft the first commit settles; a session that ends
  without one removes it, and a worker that boots and finds one sweeps it.
- **Turning the setting off** aborts the opens in flight, ends every session, forgets every
  remembered answer and drops the port, which ends the bridge. An uninstall or restore of a
  shim a session holds ends that session first.
- **Not here.** `interact_page` (its input policy is the Shim browser's), compositions,
  the API map and the data tools answer `requires-shim-browser`.

The repository's end-to-end harness runs it under Playwright: the bridge installed into
the profile as the host, the mcp control client over its socket, a session opened on the
card, previewed, committed as a version, and the setting turned off.

## Build from source

From the repository root (it builds the engine first):

```
npm ci
npm run build
```

Then load `packages/extension/dist` as in [Install](#install-beta), steps 2 to 5. It has the
same ID as a release, so it replaces a release install's place (remove one before loading
the other).

## Layout

| Path | What it is |
|---|---|
| `src/sw.ts` | The service worker: the store, per-shim script registration, the message router. |
| `src/content.ts` | The page runtime: asks the worker for this host's shims and runs the engine. |
| `src/store.ts` | IndexedDB: `shims`, `versions`, `user_data`, `rule_state`, `prefs`. |
| `src/install.ts` | `prepareInstall`: parse, lint and preflight a `.shim` file. Pure. |
| `src/prepare.ts` | The sandboxed page that runs `prepareInstall` for the install page. |
| `src/compile.ts` | The full-mode handler compile, in the user-script world. |
| `src/rebase.ts` | What the worker keeps of the engine's rebase ladder: anchors, versions, baselines, page memory, reviews. Pure. |
| `src/arbitrate.ts` | Which of two runtimes on one page stays. Pure. |
| `src/match-patterns.ts` | `match.hosts` to Chrome match patterns. Pure. |
| `src/registration.ts` | Which content scripts to register for which shims. Pure. |
| `src/page-host.ts` | The `PageHost` for authoring sessions, over `chrome.debugger`. |
| `src/sessions.ts` | The session registry here: core's shim session over the host and the store; the commit's merge and activation. |
| `src/control.ts` | The control routes, as the bridge relays them. Pure. |
| `src/attach-consent.ts` | The attach-consent gate. Pure. |
| `src/bridge-port.ts` | The native messaging port to `shim bridge`. |
| `src/attach-page.ts` | The attach card. |
| `src/capabilities.ts` | The three capability constants (two modes, the session) and the mode. |
| `src/sender.ts` | Who may send what to the worker: its own pages, or the runtime on a site. Pure. |
| `src/reconcile.ts` | What an open document stops and starts when the worker's answer changes. Pure. |
| `test/extension-smoke-harness.ts` | The built extension in a real Chromium: install, apply, strict CSP, priority, live toggles, removal, a refusal. |
| `test/extension-conformance-harness.ts` | The shared `PageHost` conformance suite against the extension's host. |
| `test/extension-session-harness.ts` | A session beside an installed shim: holds, reboots, a rebased rule, the session ended from outside. |
| `test/control-harness.ts`, `test/attach-consent-harness.ts` | The routes and the consent gate over fakes. |
| `src/popup.ts`, `src/install-page.ts` | The popup and the install page. |
| `.claude/skills/chrome-extensions/` | Google's Chrome extension authoring skill (`GoogleChrome/modern-web-guidance`, unmodified). Nested here so an agent loads it only while working in this package. Refresh it by rerunning the installer and copying the skill folder over. |

## License

Apache-2.0. See `LICENSE`.
