# @shimbrowser/mcp

An MCP server that lets Claude Code (or any MCP client) author Shim shims against the
running Shim browser: open a session on a site tab, check the shim out into a folder,
edit it, preview it on the live page, look at the result, commit.

It talks to Shim over Shim's **control endpoint**: a Unix socket (a named pipe on
Windows) plus a bearer token, both named in `<userData>/control.json`. The endpoint is
off by default; turn it on in Shim's Settings, or let `shim_launch` start Shim with it on
for one run. Every session still waits for you to allow it in Shim's sidebar, and a
commit that grants something sensitive (a redirect target, a remote database
connection) waits for your approval there too.

## Tools

Registered once, at startup:

| Group | Tools |
|---|---|
| Session | `shim_status`, `shim_launch`, `shim_list_tabs`, `shim_open_session`, `shim_checkout`, `shim_preview`, `shim_commit`, `shim_end_session` |
| Page | `view_page`, `query_page`, `inspect_element`, `evaluate_in_page`, `read_console`, `reload_page`, `verify_across_pages`, `interact_page` (composition sessions only) |

The page tools' definitions come from `@shimbrowser/core/page-tools`, the same module
Shim's own authoring worker uses, and Shim runs them with the same implementation.

## The loop

1. `shim_launch` (or `shim_status`), then `shim_list_tabs` for a site tab's `tabId`.
2. `shim_open_session { tabId, intent, shimId | newShimName, dir }`. Shim asks you to
   allow it. With `dir`, the shim is checked out at once:
   `shim.json` (the spec, handlers referenced by name) and `handlers/<name>.js`.
3. Edit the folder. `shim_preview` sends the **whole folder** to Shim, which diffs it
   against the session's working state, applies the difference to the live page, and
   answers with a revision and evidence (per-rule matches and boxes, handler errors,
   lint, console). Pass `screenshot: true` (optionally `selector`) to get the page back
   as an image.
4. `shim_commit { summary }` saves the latest preview as a new version. It carries a
   `commitId`; a retry after a lost reply returns the first result.
5. `shim_end_session` discards anything uncommitted.

## Headless mode

`shim-mcp --headless` (or `SHIM_MCP_MODE=headless`) needs no Shim browser: each session
opens its own Chromium through Playwright (an optional peer dependency: `npm install
playwright && npx playwright install chromium` in your project — the plugin looks there,
or set `SHIM_PLAYWRIGHT_DIR`) and works on a `.shim` file instead of a
shim in Shim's library. `--visible` (or `SHIM_HEADLESS_VISIBLE=1`) shows the window.

- `shim_open_session { url, intent, shimFile | newShimName, dir }`: the page to open, and
  the `.shim` file to load (if it exists) and commit to — for a new shim it defaults to
  `<dir>.shim`. Every session gets a fresh browser profile; the Shim browser's profile is
  never read.
- Previews, the page tools and commits behave as in attach mode; `shim_commit` writes the
  `.shim` file (a new version, witnesses, the session's history entry). `api.storage`
  persists to `<shimFile>.storage.json`.
- Headless supports a stated subset (shim-core design D15): `hide`, `restyle`, `reorder`,
  `reshape`, `script`, `inject-element`, `inject-html`, `remove`, `replace-root`, with
  `api.storage` and `api.cleanup`. A preview that declares anything else applies nothing
  and answers `unsupported` with the list. A handler that uses a member headless lacks
  gets that member's unconfigured answer (`{ ok: false, error: 'requires-shim-browser' }`,
  `undefined`, or an absent member) and its rule's evidence says `verification: partial`.
- `shim_launch`, `shim_list_tabs`, compositions, `verify_across_pages` and
  `interact_page` answer `requires-shim-browser`.

## Claude Code plugin

This package is also a Claude Code plugin: `.claude-plugin/plugin.json`, `.mcp.json`
(which starts `dist/shim-mcp.js`) and the `shim-authoring` skill
(`skills/shim-authoring/SKILL.md`) — the public authoring guide: the session loop, the
folder format, every mutation kind, anchors, the runtime `api`, and the evidence each
preview returns. From a checkout:

```sh
npm run build -w @shimbrowser/mcp
claude --plugin-dir packages/mcp
```

## Environment

| Variable | Effect |
|---|---|
| `SHIM_CONTROL_FILE` | The discovery file to read (default `<userData>/control.json`). |
| `SHIM_USER_DATA` | Shim's userData folder, when it isn't the platform default. |
| `SHIM_APP` | The Shim app (macOS) or executable that `shim_launch` starts. |
| `SHIM_DEV_CHECKOUT` | A Shim repo checkout: `shim_launch` runs `npm start` there. |
| `SHIM_AGENT_NAME` | The name Shim's cards show (default: from the MCP client). |
| `MAX_MCP_OUTPUT_TOKENS` | The tool-result budget results are fitted to (default 25000). |
| `SHIM_MCP_MODE` | `headless` runs headless mode (same as `--headless`). |
| `SHIM_HEADLESS_VISIBLE` | `1` shows headless mode's Chromium windows (same as `--visible`). |
| `SHIM_PLAYWRIGHT_DIR` | A folder whose `node_modules` has Playwright, searched first (then the server's own install, the working directory and `CLAUDE_PROJECT_DIR`). |

## Build

```sh
npm run build -w @shimbrowser/mcp   # dist/shim-mcp.js: one file, dependencies inlined
```

The harnesses in `test/` run from the repo root with `npm test`. Not published yet.

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
