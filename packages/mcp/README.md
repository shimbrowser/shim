# @shimbrowser/mcp

Change any website from your coding agent. Describe the change you want ("hide the upsell
banner", "add a notes field to every track", "put the columns I use first"), and the agent
writes a **shim**, applies it to the live page, takes a screenshot, checks the result and
keeps iterating until the page looks right. Then it saves the shim.

That loop is the product. This package provides it:

- **an MCP server** (`shim-mcp`) that gives any MCP agent the session, preview and page
  tools: Claude Code through its plugin, Codex, or any other MCP client;
- **an authoring guide** that teaches the agent the shim format and the loop: Claude Code
  loads it as the `shim-authoring` skill, and every other agent reads it through the
  `shim_guide` tool;
- **a command line** (`shim`) for packing, linting and previewing shims yourself, and
  reading the guide (`shim guide`).

A shim is a small, declarative patch: anchors that find elements on a page, plus
mutations to apply to them (hide, restyle, inject, run a script handler). It runs as a
layer that only you see. The site is never modified, and "see original site" always shows
it untouched. The engine that applies shims is
[`@shimbrowser/core`](../core/README.md).

In the Shim browser the same tools also author **compositions**: small local web apps
Shim serves at `compose://<mount>`, which read the sites' APIs with your session. A
composition is a folder of its own files plus a `manifest.json` that declares the hosts it
reads. Compositions run only in the Shim browser.

> **Beta.** Nothing is on npm yet: the plugin installs from this repository's marketplace,
> and the CLI from a [GitHub release](https://github.com/shimbrowser/shim/releases).

## Install (beta)

### The Claude Code plugin

```sh
claude plugin marketplace add shimbrowser/shim
claude plugin install shim@shimbrowser
```

(In a Claude Code session, the same is `/plugin marketplace add shimbrowser/shim` and
`/plugin install shim@shimbrowser`.) If you have no SSH key on GitHub, run
`export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` first: Claude Code clones over SSH by default.

The plugin is self-contained: the MCP server is one bundled file, so there is nothing to
build or install with it. To update, run `claude plugin marketplace update shimbrowser`,
which fetches the newest release's plugin (or turn on auto-update for the marketplace in
`/plugin`).

### The `shim` CLI and `shim-mcp`

```sh
npm install -g https://github.com/shimbrowser/shim/releases/latest/download/shimbrowser-mcp.tgz
shim --help
```

It installs `shim` (pack, lint, preview, the guide, and the bridge for Shim for Chrome:
`shim extension install-host`) and `shim-mcp` (the MCP server, for agents other than
Claude Code). Run the same command again to update.

### Codex and other MCP agents

`shim-mcp` is a standard stdio MCP server. Install the CLI (above), then add it to your
agent. Codex:

```sh
codex mcp add shim -- shim-mcp
```

Any client that reads an `mcpServers` config (Cursor, Windsurf, Claude Desktop, …):

```json
{
  "mcpServers": {
    "shim": { "command": "shim-mcp" }
  }
}
```

The server tells the agent to read the authoring guide with the `shim_guide` tool before its
first session; the guide is the same one the Claude Code plugin ships as a skill. Then ask
for a change, the same way as in Claude Code. To read the guide yourself: `shim guide`, or
`shim guide handlers` for one of its reference files.

### From a checkout

```sh
git clone https://github.com/shimbrowser/shim.git && cd shim
npm ci
npm run build                     # writes packages/mcp/dist/shim-mcp.js and dist/shim.js
claude --plugin-dir packages/mcp  # the plugin, for this session
```

### What your agent can author on

The server works with or without a Shim host; there is nothing to configure:

- **The Shim browser** ([shimbrowser.com](https://shimbrowser.com)), with its control
  endpoint on: the agent works in its tabs.
- **Shim for Chrome** ([`@shimbrowser/extension`](../extension/README.md)), once you've run
  `shim extension install-host` and turned on **let coding agents author here** in its popup:
  the agent works in your Chrome tabs.
- **Neither:** the agent opens the page in a headless Chromium (below).

Then ask for a change, for example: *"On news.example.com, hide the cookie banner and make
the article text wider."* The guide tells the agent how to open a session, edit the shim,
preview it and verify the result.

`shim_status` tells the agent which hosts are reachable and why.

**Headless needs Playwright**, which downloads the Chromium that headless mode drives.
Shim doesn't bundle a browser. Install it once:

```sh
npm install -g playwright && playwright install chromium
```

Or install it in the project you run your agent in
(`npm install -D playwright && npx playwright install chromium`). If Playwright is missing
when a session opens, the tool answer gives the exact command. In a checkout of this
repository Playwright is already a dev dependency, so `npx playwright install chromium` is
enough.

Each bundle is a single file with its dependencies inlined: the MCP SDK, `@shimbrowser/core`
and the core page bundle that headless mode injects into every page. Playwright is the only
exception. It is an optional peer dependency, loaded only when a headless session opens, and
looked for in this order: the folder `SHIM_PLAYWRIGHT_DIR` names, the plugin's own folder
and `NODE_PATH`, the working directory, `CLAUDE_PROJECT_DIR`, then the global npm install.

## Two modes: attach and headless

The tools and the loop are the same in both modes. Only the page changes.

| | Attach | Headless |
|---|---|---|
| The page | a tab in the running [Shim browser](https://shimbrowser.com), with your logins | a fresh Chromium that Playwright drives (`--visible` shows it) |
| Who can use it | anyone with Shim | anyone: no Shim needed |
| What a commit saves | a new version of the shim in Shim's library | the `.shim` file the session names |
| Consent | Shim asks you to allow each session, and asks again at commit if the work grants something sensitive | none: the agent drives its own browser, with no logins, on a page it named |
| Features | everything Shim supports | a stated subset (next section) |
| When | a session opened on a Shim tab (`tabId`), or on a `url` while Shim is reachable (a new tab you allow) | a session opened on a `url` while no Shim browser is reachable, or with `mode: "headless"` |
| Only this mode | `shim-mcp --attach`, or `SHIM_MCP_MODE=attach` | `shim-mcp --headless`, or `SHIM_MCP_MODE=headless` |

**Attach** talks to Shim over its **control endpoint**: a Unix socket (a named pipe on
Windows) plus a bearer token, both named in `<userData>/control.json`. The endpoint is off by
default. Turn it on in Shim's Settings, or let `shim_launch` start Shim with it on for one
run. Turning it on grants nothing by itself: every session waits until you allow it in
Shim's sidebar. On a site tab, code the agent previews runs in the page as you, logged in,
and discarding the session doesn't undo actions it already took. The attach card tells you
this before you allow the session.

**Auto** (the default, and what the plugin runs) holds both. A session on a Shim tab
attaches. A session on a `url` runs headless when no Shim browser is reachable, meaning
there is no `control.json` or the process it names is gone. The mode never switches
silently. Every `shim_open_session` answer names its mode and why. With Shim running, a bare
`url` attaches: Shim's card always asks you to let it open a new tab at that exact URL (a
site you allowed until quit included), the tab opens only once you allow it, and a page that
lands on another origin opens no session and its tab is closed. Pass `mode: "headless"` to
open the url headless instead. A session
keeps its mode until it ends, even if Shim starts in the meantime.

**Two attach hosts.** [Shim for Chrome](../extension/README.md), the extension, serves the
same routes through its bridge (`shim bridge`, a native messaging host this package
provides; `shim extension install-host` sets it up), named in `<userData>/control-chrome.json`.
The server reads both files: `shim_status` reports each host, `shim_list_tabs` lists every
reachable host's tabs with `host: "shim"` or `host: "chrome"`, and a session goes to the
host that listed its `tabId`. The two number their tabs separately, so a number both
listed asks for `target: "shim"` or `"chrome"`, as does a `url` while both are reachable;
`shim-mcp --target` (or `SHIM_MCP_TARGET`) sets the default. Every later call on a session
goes to the host that opened it.

**Headless** never reads the Shim browser's profile. Every session starts a new,
non-persistent Chromium. The artifact is a `.shim` file. You can import it into Shim later,
or share it.

## What headless supports

Headless mode supports a stated subset and rejects anything outside it. A rejected shim is
never applied with different behavior.

| Capability | Shim browser | Headless |
|---|---|---|
| `hide`, `restyle`, `reorder`, `reshape` | yes | yes |
| `script`, `inject-element`, `inject-html`, `remove`, `replace-root` | yes | yes |
| Mount strategies, self-healing re-mounts | yes | yes |
| Witness capture and verification, deterministic rebase | yes | yes |
| `api.storage`, `api.cleanup` | yes | yes (`api.storage` is backed by a file) |
| `mount-route`, `redirect`, `rewrite-response`, `intercept` | yes | no |
| Rules targeting an iframe (`anchor.iframe`) | yes | no |
| `api.db`, `api.ai`, `api.settings`, `api.fetch`, pack / global storage, `api.shared`, `api.modules` | yes | no |
| Framework component identity | yes | not checked: lowers the rule to `partial` |

- **Declared features are checked before anything runs.** If a preview uses an unsupported
  mutation kind, `anchor.iframe`, or a `settings` / `permissions` / `storage` /
  `connections` declaration, nothing is applied. The preview answers `unsupported` with the
  list.
- **Undeclared use is caught at runtime.** A handler that calls a member headless doesn't
  provide gets the answer an unconfigured shim gets in Shim:
  - `api.fetch` resolves `{ ok: false, error: 'requires-shim-browser' }`.
  - `api.settings.get` resolves `undefined`.
  - `api.db` reads as absent.

  The preview lists the call under `unsupportedApi`, and the rule's verification drops to
  `partial`.
- **Every rule's evidence carries a verification level.** `full` means every check the rule
  carries ran on this host, so the rule behaves the same in Shim. `partial` means something
  went unchecked. Treat a `partial` rule as unverified until you try it in Shim. `none` means
  the rule matched nothing (it is also in `noMatch`), so there was nothing to verify.

Tools that need the Shim browser answer `requires-shim-browser` in a headless session:
opening a shim from Shim's library, compositions and their tools (`probe_request`,
`read_calls`, `verify_mint`), `verify_across_pages`, the API map tools and the data tools.
A headless-only server (`--headless`) also refuses `shim_launch` and `shim_list_tabs`.
`interact_page` and `navigate` work headless too; there `interact_page` may drive the whole
page (`scope: "page"`), while in an attach session it drives only the held shim's own
controls (`scope: "shim-dom"`).

## The loop, tool by tool

1. **Find a page.**
   - Attach: `shim_launch` (or `shim_status`), then `shim_list_tabs` for a site tab's
     `tabId`, or name a `url` no tab shows.
   - Headless: name a `url`.
2. **Open a session.**
   - Attach: `shim_open_session { tabId | url, intent, shimId | newShimName, dir }`. A `url`
     answers the new tab's `tabId`.
   - Headless: `shim_open_session { url, intent, shimFile | newShimName, dir }`. The file
     defaults to `<dir>.shim`.

   With `dir`, the shim is checked out into a folder at once: `shim.json` (the spec, with
   handlers referenced by name) and `handlers/<name>.js`.
3. **Edit the folder.** `shim_preview` sends the whole folder, which is diffed against the
   session's working state. The difference is applied to the live page, and the reply is a
   revision plus **evidence**:
   - per-rule match counts, measured boxes and verification level;
   - handler errors with stacks;
   - rules that matched nothing, and quarantined rules;
   - lint findings;
   - new console output.

   Pass `screenshot: true` (and optionally `selector`) to get the page back as an image.
4. **Look.** `view_page`, `query_page`, `inspect_element`, `evaluate_in_page`,
   `read_console` and `reload_page` work on the session's page. A clean apply isn't proof
   that the change worked; the screenshot is.
5. **Commit.** `shim_commit { summary }` saves the latest preview as a new version. Every
   commit carries a `commitId`, so a retry after a lost reply returns the first result
   instead of committing twice.
6. **End.** `shim_end_session` discards anything that wasn't committed.

A composition session (attach mode only) opens with `compositionId` instead, and `tabId`
is optional. It checks out `manifest.json` plus the composition's files, in a flat folder.
A preview saves the changed files and reloads the composition's page. If the manifest adds
a host, Shim asks you first. `newCompositionName` (with an optional proposed `mount`)
starts a new composition instead: Shim's card lets you change its `compose://` address
before allowing, and the composition is kept only if the session commits. A commit that
grants a composition a write to a site waits for your approval in Shim. While a session holds a composition, its page's `api.ai` calls are
refused, so a session never spends your API key.

When the work needs a site's own API, the API map tools (attach mode only) read what Shim
recorded of it. The agent sees only the sites you grant, and Shim asks you on its own card
for each level of access.

All tools are registered when the server starts:

| Group | Tools |
|---|---|
| Session | `shim_status`, `shim_launch`, `shim_list_tabs`, `shim_open_session`, `shim_checkout`, `shim_preview`, `shim_commit`, `shim_end_session` |
| Page | `view_page`, `query_page`, `inspect_element`, `evaluate_in_page`, `read_console`, `reload_page`, `verify_across_pages`, `interact_page` (a composition's preview; in a shim session, the held shim's own controls — the whole page headless), `navigate` (shim sessions: another page on the session's start origin) |
| API map | `list_discovered_hosts`, `request_sources`, `search_discovered_api`, `inspect_endpoint`, `replay_endpoint` |
| Data | `inspect_storage`, `query_db` (read-only), `read_sibling_shim` (shim sessions only; the shim's own pack) |
| Composition | `probe_request`, `read_calls`, `verify_mint` (composition sessions only) |

The page tools are defined in `@shimbrowser/core/page-tools`, the same module Shim's
built-in authoring uses, and both hosts run them with the same implementation. The data
tools are defined in `@shimbrowser/core/data-tools`, which Shim's own worker uses too; they
need the Shim browser.

## The `shim` command line

```
shim pack <folder> [--out <file.shim>]
shim unpack <file.shim> [--out <folder>]
shim lint <folder | file.shim> [--headless] [--json]
shim preview <folder> --url <url> [--screenshot <file.png>] [--selector <css>]
             [--full-page] [--visible] [--storage <file.json>] [--json]
shim launch [--timeout <seconds>] [--json]
shim mcp [--attach | --headless] [--visible]
```

| Command | What it does |
|---|---|
| `pack` | A shim folder to a `.shim` file (default `<folder>.shim`). Witnesses saved by `unpack` come back for every rule whose anchor is unchanged. Refuses a folder with lint errors. |
| `unpack` | A `.shim` file to a shim folder (default: the file's path without `.shim`). Writes only into an empty folder or an earlier shim folder. `unpack` then `pack` reproduces the file. |
| `lint` | The checks `pack` and a preview apply, plus lint warnings. `--headless` adds the headless capability check (errors) and a handler source scan (warnings). |
| `preview` | Applies the folder to `url` in a fresh headless Chromium and prints the evidence. `--screenshot` saves the page after it settles; `--selector` captures one element instead. Nothing is saved; `--storage` names a file to back `api.storage`. |
| `launch` | Attaches to the running Shim browser, or starts it with its control endpoint on. |
| `mcp` | Starts the MCP server on stdio, the same server as `shim-mcp`: auto by default, one mode with `--attach` or `--headless`. |

Exit codes: `0` success. `1` the command found a problem: lint errors, a preview that
applied nothing, reported handler errors / unmatched / quarantined rules, or has a rule
that never matched an element, a failed screenshot or launch. `2` a usage error, or a file that couldn't be read or written.

`shim.json` holds only what you author. Witnesses (the fingerprints that keep a rule from
attaching to the wrong element), `version` and `bundleHash` are managed by the tools. `unpack`
keeps them in `.shim-state.json` beside the folder so a round trip loses nothing, along with
a digest of each rule's committed anchor, so `preview` can tell an unchanged rule (it runs
behind the committed `bundleHash`, as in Shim) from one you re-anchored. Leave that file alone.

## Environment

| Variable | Effect |
|---|---|
| `SHIM_MCP_MODE` | `auto` (the default), `attach` (same as `--attach`) or `headless` (same as `--headless`). |
| `SHIM_HEADLESS_VISIBLE` | `1` shows headless mode's Chromium windows (same as `--visible`). |
| `SHIM_CONTROL_FILE` | The discovery file to read (default `<userData>/control.json`). |
| `SHIM_USER_DATA` | Shim's userData folder, when it isn't the platform default. |
| `SHIM_APP` | The Shim app (macOS) or executable that `shim_launch` / `shim launch` starts. |
| `SHIM_DEV_CHECKOUT` | A Shim repository checkout: launching runs `npm start` there. |
| `SHIM_AGENT_NAME` | The agent name Shim's cards show (default: from the MCP client). |
| `MAX_MCP_OUTPUT_TOKENS` | The tool-result budget results are fitted to (default 25000). |
| `SHIM_PLAYWRIGHT_DIR` | A folder whose `node_modules` has Playwright, searched first (then the server's own install and `NODE_PATH`, the working directory, `CLAUDE_PROJECT_DIR` and the global npm install). |

## Build and test

```sh
npm run build -w @shimbrowser/mcp   # dist/shim-mcp.js and dist/shim.js (the root's npm run build does this too)
npm test                            # from the repository root: every harness
```

The harnesses that need a real Chromium (`playwright-conformance`,
`headless-session-e2e`, `shim-cli-e2e`, `plugin-install-e2e`) run in their own CI jobs.
`plugin-install-e2e` copies the built plugin to a temp folder outside the repository and
starts it from its `.mcp.json` with only Playwright reachable, so it fails if the bundle
needs anything else at runtime:

```sh
npx playwright install chromium
npm run build && node out/packages/mcp/test/shim-cli-e2e-harness.js
node out/packages/mcp/test/plugin-install-e2e-harness.js
```

## Design decisions

Comments cite the design decisions they rest on as `D1`…`D16`; they are listed in
[`@shimbrowser/core`'s DECISIONS.md](../core/DECISIONS.md).

## License

Licensed under the Apache License 2.0. Copyright Artificial Apps, LLC. See
[LICENSE](LICENSE).
