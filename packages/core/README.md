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

```sh
npm run build -w @shimbrowser/core      # dist/: CJS, .d.ts, page bundle
npm run typecheck -w @shimbrowser/core  # src/ with DOM types only, no Node types
```

The harnesses in `test/` run from the repo root with `npm test`.

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
