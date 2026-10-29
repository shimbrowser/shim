# Shim

Change any website. Describe what you want ("hide the upsell banner", "add a notes field to
every track", "put the columns I use first") and an agent writes a **shim**: a small,
declarative patch that runs as a layer only you see. The site is never modified, and the
original page is always one click away. When the site ships a new version, the shim re-finds
what it changes on its own, with no AI involved, or holds the change for your review. It
never silently attaches to the wrong element.

This repository holds Shim's open-source parts. The [Shim browser](https://shimbrowser.com)
is built on them.

> **Beta.** Version 0.7.0 is the first public release. Nothing is on npm or the Chrome Web
> Store yet: everything installs from this repository's
> [releases](https://github.com/shimbrowser/shim/releases) or from source. Expect rough
> edges, and please [open an issue](https://github.com/shimbrowser/shim/issues) when you
> hit one.

## What's here

| Package | What it is |
|---|---|
| [Shim for Chrome](packages/extension) (`@shimbrowser/extension`) | Runs your shims in the Chrome you already use. Installs a `.shim` file, asks Chrome for access to exactly the sites it names, and keeps it applied as the site changes. Claude Code can author on its tabs. |
| [Claude Code plugin and `shim` CLI](packages/mcp) (`@shimbrowser/mcp`) | The authoring loop: Claude opens a session on a tab (in the Shim browser, Shim for Chrome, or a headless Chromium), edits the shim, previews it on the live page, checks a screenshot and iterates, then saves it. The `shim` command line packs, lints and previews shims, and sets up the Chrome bridge. |
| [The engine](packages/core) (`@shimbrowser/core`) | What applies a shim to a page: anchors, the deterministic rebase, the spec format, and the contract every authoring host implements. No dependencies, no network, no AI. |

## Install

Each package's README has the full instructions, including what Shim for Chrome's
permissions are for. In short, from the [latest release](https://github.com/shimbrowser/shim/releases):

**Shim for Chrome.** Download [`shim-for-chrome.zip`](https://github.com/shimbrowser/shim/releases/latest/download/shim-for-chrome.zip) and unzip it into a folder you
will keep. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**
and choose the folder. Then, on the extension's **Details** page, turn on **Allow user
scripts** so shims with script handlers run.
[Full instructions](packages/extension/README.md#install-beta).

**The Claude Code plugin.**

```sh
claude plugin marketplace add shimbrowser/shim
claude plugin install shim@shimbrowser
```

Without a GitHub SSH key, run `export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` first. To author
without the Shim browser or Shim for Chrome, also install Playwright's Chromium
(`npm install -g playwright && playwright install chromium`).
[Full instructions](packages/mcp/README.md#install-beta).

**The `shim` CLI** (also what connects Claude Code to Shim for Chrome):

```sh
npm install -g https://github.com/shimbrowser/shim/releases/latest/download/shimbrowser-mcp.tgz
shim --help
```

**The engine**, as a dependency of your own project:

```sh
npm install https://github.com/shimbrowser/shim/releases/latest/download/shimbrowser-core.tgz
```

Every release file's SHA-256 is in the release's `SHA256SUMS`.

## Build from source

Node 26 or later:

```sh
git clone https://github.com/shimbrowser/shim.git
cd shim
npm ci
npm run build        # every package: packages/*/dist
npm test             # every package's tests that need no browser
```

`npm run test:browser` also runs the tests that drive a real Chromium (Shim for Chrome
loaded unpacked, the headless host, the CLI and the plugin end to end); run
`npx playwright install chromium` once first. After a build:

- Shim for Chrome is unpacked in `packages/extension/dist`: load that folder.
- The Claude Code plugin runs from the checkout: `claude --plugin-dir packages/mcp`.
- The CLI is `node packages/mcp/dist/shim.js` (or `npm link -w @shimbrowser/mcp` for `shim`).

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: the
first pull request asks you to sign the [CLA](CLA.md), once.

## License

[Apache-2.0](LICENSE). © Artificial Apps, LLC.
