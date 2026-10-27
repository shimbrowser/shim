# @shimbrowser/extension

**Shim for Chrome** runs shims in the Chrome you already use. A shim is a set of personal
changes to a website (hide this, restyle that, add a field here), authored in the Shim
browser or with Claude Code through `@shimbrowser/mcp`, saved as a `.shim` file, and
applied here as a local layer on the live site.

The extension is a runtime host, not a second authoring product: no chat, no model, no
key. It runs the same engine as the Shim browser (`@shimbrowser/core`, the page bundle,
byte for byte) and tells you honestly what it can run.

## Status

Early. What works today:

- Install a `.shim` file from the popup. Installing asks Chrome for access to exactly
  the sites the shim names, and nothing else.
- Declarative rules run on every matching page: `hide`, `restyle`, `reorder`, `reshape`,
  `remove`, `inject-element`, `inject-html`, plus the shim's own stylesheet.
- With user scripts allowed (full mode, below), rules with handlers run too: `script`
  and `replace-root`, with `api.storage` and `api.cleanup`. Handlers compile in Chrome's
  user-script world, so a site's own CSP cannot block them.
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
  browser and the headless host run (below). Nothing drives it yet.

What is next: the native messaging bridge so Claude Code can author on a real Chrome tab.

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
`replace-root`, trusted input, no `api` members beyond `storage` and `cleanup`
(`api.fetch`, `api.ai` and the rest answer `not-available-in-shim-for-chrome` in their
own shape). A preview of a committed rule holds that rule for the preview's duration and
gives it back after: the host tells the page's runtime the whole set of rules it holds of
each shim and waits for the ack before the preview goes up (a hold the page does not
confirm in time is no hold: the preview stays down and the session is told in its
console), and removes the preview before it releases the hold, so the two forms of one
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

## Try it

```
npm run build -w @shimbrowser/extension
```

Then open `chrome://extensions`, turn on developer mode, choose "Load unpacked" and pick
`packages/extension/dist`.

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
| `src/capabilities.ts` | The three capability constants (two modes, the session) and the mode. |
| `src/sender.ts` | Who may send what to the worker: its own pages, or the runtime on a site. Pure. |
| `src/reconcile.ts` | What an open document stops and starts when the worker's answer changes. Pure. |
| `test/extension-smoke-harness.ts` | The built extension in a real Chromium: install, apply, strict CSP, priority, live toggles, removal, a refusal. |
| `test/extension-conformance-harness.ts` | The shared `PageHost` conformance suite against the extension's host. |
| `test/extension-session-harness.ts` | A session beside an installed shim: holds, reboots, a rebased rule, the session ended from outside. |
| `src/popup.ts`, `src/install-page.ts` | The popup and the install page. |

## License

Apache-2.0. See `LICENSE`.
