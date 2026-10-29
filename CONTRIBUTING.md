# Contributing

Thanks for your interest in Shim's open-source packages. This repository holds three of them:

- [`@shimbrowser/core`](packages/core/README.md): the engine, the spec format and its lint, deterministic rebase, and the page-tool contract.
- [`@shimbrowser/mcp`](packages/mcp/README.md): the MCP server and `shim` CLI an agent such as Claude Code authors shims through (the Claude Code plugin), and the Playwright driver for headless mode.
- [`@shimbrowser/extension`](packages/extension/README.md): Shim for Chrome, which runs shims in Chrome and hosts authoring sessions there.

All three are licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).

## Before you start

For anything larger than a small fix, open an issue first to describe the problem and the change you have in mind, so we can agree on the approach before you spend time on it.

## Build and test

Node 26 or later (`.nvmrc` names the version CI uses):

```sh
npm ci
npm run build        # every package, in dependency order
npm run typecheck
npm test             # every harness that needs no browser
```

`npm run test:browser` adds the harnesses that drive a real Chromium (run
`npx playwright install chromium` once first); CI runs both. `node scripts/test.mjs <name>`
runs only the harnesses whose file name contains `<name>`. Each package's tests are the
`test/*-harness.ts` files beside its source: plain scripts that exit non-zero on a failure.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Make your change. New behavior comes with a test (a harness in the package's `test/`), and `npm run typecheck` and `npm test` keep passing.
3. Open a pull request against `main` describing what changed and why.

## Contributor License Agreement

Before we can merge your first pull request, you need to sign the [Contributor License Agreement](CLA.md). You keep the copyright to your contribution; the agreement gives Artificial Apps, LLC, which maintains Shim, a license to use and distribute it, including in the Shim browser, and a patent license. You sign once, and it covers all your future contributions.

To sign, a bot comments on your first pull request with a link to the agreement. Read it, then reply on the pull request with this exact comment:

> I have read the CLA Document and I hereby sign the CLA

The bot records your signature and the check on your pull request turns green. If you contribute on behalf of your employer, make sure you have their permission first (see section 4 of the agreement).
