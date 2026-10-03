# @shimbrowser/core

The patch engine behind [Shim](https://shimbrowser.com): it applies a declarative
patch spec (anchors, mutations, handlers) to any page that has a DOM, and keeps it
attached as the page re-renders.

Not published yet (`0.7.0-dev`). It lives in the Shim repo as an npm workspace
package and is split into its own public repo at launch.

- **No Node, no dependencies.** The engine imports no Node builtin, no package, and
  nothing outside this folder. The host it runs in compiles handler source and
  passes the engine functions.
- **CommonJS + types.** `@shimbrowser/core` and `@shimbrowser/core/<module>` serve
  `dist/*.js` with `dist/*.d.ts`.
- **Page bundle.** `@shimbrowser/core/page` (`dist/shim-core.page.js`) is the whole
  engine as one browser-platform script that defines the global `ShimCore`. The build
  fails if anything in it imports a Node builtin.

- **Authoring pieces.** Not in the page bundle; import them by subpath:
  - `@shimbrowser/core/spec-lint`: the spec linter (`lintSpec`, `assertNoSpecErrors`).
  - `@shimbrowser/core/spec-delta`: `applyDelta` and the `DeltaOp` type.
  - `@shimbrowser/core/shim-folder`: the working-copy folder (`shim.json`,
    `handlers/<name>.js`, the tool-managed `.shim-state.json`). Exports `checkoutShim`,
    `unpackShim` and `packShim`.
  - `@shimbrowser/core/working-copy-diff`: `diffWorkingCopy`, which turns an edited
    folder into the `DeltaOp`s that reproduce it.
  - `@shimbrowser/core/working-copy-wire`: the working copy on the wire
    (`shim-working-copy/1`): `encodeWorkingCopy` and `decodeWorkingCopy`, the bytes
    an attached session sends for a preview and receives on checkout.
  - `@shimbrowser/core/page-tools`: the page tools' one definition (`view_page`,
    `query_page`, `inspect_element`, `evaluate_in_page`, `read_console`,
    `reload_page`, `verify_across_pages`, `interact_page`): the Shim browser's shim
    and composition workers offer `SHIM_PAGE_TOOLS` / `COMPOSITION_PAGE_TOOLS`, and
    `@shimbrowser/mcp` registers `SESSION_PAGE_TOOLS`.
  - `@shimbrowser/core/data-tools`: the data tools' one definition (`inspect_storage`,
    `query_db`, `read_sibling_shim`): the browser's workers offer `WORKER_DATA_TOOLS`,
    and `@shimbrowser/mcp` registers `SESSION_DATA_TOOLS`.

```sh
npm run build -w @shimbrowser/core      # dist/: CJS, .d.ts, page bundle
npm run typecheck -w @shimbrowser/core  # src/ with DOM types only, no Node types
```

The harnesses in `test/` run from the repo root with `npm test`.

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
