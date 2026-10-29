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

## Licensing your contribution

This repository is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)). As section 5 of the license says, anything you submit for inclusion, such as a pull request, is licensed under the same terms. Only submit work you have the right to contribute: if you write it as part of your job, make sure your employer is fine with you contributing it.
