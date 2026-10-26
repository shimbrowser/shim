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
- Enable, disable and remove shims from the popup. Removing a shim releases the site
  access it asked for.

What is next: rules with handlers (`script`, `replace-root`) through Chrome's user
scripts API, persisted rebases and the needs-review badge, the `PageHost` for authoring
sessions, and the native messaging bridge so Claude Code can author on a real Chrome
tab.

## Modes

Chrome extensions cannot compile code in a content script. The engine needs compiled
handler functions, so rules with handlers run only in **full mode**, where the engine
runs in a user-script world that permits `eval` (Chrome 120+ with developer mode, or
Chrome 138+ with the per-extension "Allow user scripts" toggle). Without that, the
extension runs in **declarative mode** and refuses a shim with handler rules at install,
naming the reason. Everything declarative works in both.

Each mode is one `PageHostCapabilities` constant (`EXTENSION_CAPABILITIES`,
`EXTENSION_DECLARATIVE_CAPABILITIES`), and every install preflights against the one in
force. A capability is advertised only while its conformance case passes.

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
| `src/match-patterns.ts` | `match.hosts` to Chrome match patterns. Pure. |
| `src/registration.ts` | Which content scripts to register for which shims. Pure. |
| `src/capabilities.ts` | The two capability constants and the mode. |
| `src/sender.ts` | Who may send what to the worker: its own pages, or the runtime on a site. Pure. |
| `src/reconcile.ts` | What an open document stops and starts when the worker's answer changes. Pure. |
| `test/extension-smoke-harness.ts` | The built extension in a real Chromium: install, apply, strict CSP, priority, live toggles, removal, a refusal. |
| `src/popup.ts`, `src/install-page.ts` | The popup and the install page. |

## License

Apache-2.0. See `LICENSE`.
