# @shimbrowser/core

The engine behind [Shim](https://shimbrowser.com). It takes a declarative patch spec (a
**shim**), applies it to any page that has a DOM, and keeps it applied as the page
re-renders and redeploys.

Shim lets you change any website: hide what you never use, add the column you're missing,
put a notes field next to every track. The change is a personal layer that the site never
sees, and "see original site" always shows the page untouched. You describe the change; an
agent writes the shim, applies it to the live page, screenshots the result and iterates
until it looks right. That live loop runs in Claude Code through
[`@shimbrowser/mcp`](../mcp/README.md). This package is the part that runs on every page:
it is deterministic, contains no LLM, and makes no network calls.

> **Status:** pre-release (`0.7.0-dev`), not published to npm yet. It is developed as an npm
> workspace package inside the Shim repository and will move to its own public repository
> at launch.

## What's in it

- **The engine.** It resolves anchors, applies mutations, re-mounts what a framework
  re-render removed, and tears everything down cleanly.
- **Anchors and witnesses.** Each anchor resolves through a ladder: stable `data-*`
  attributes, then role / aria, then visible text, then CSS as a last resort. A
  **witness** fingerprint is captured automatically for every anchored element. A
  candidate that fails its witness is never used; the rule is **quarantined** instead.
  Worst case, a rule needs re-verification; it never silently attaches to the wrong
  element.
- **Deterministic rebase.** When the site deploys, a rule recovers with no LLM: a baseline
  refresh, a fallback promotion, or a witness-driven search. Every recovered target must
  pass the witness.
- **The spec format.** Types, the `shim/1` file, the shim folder, spec-lint, and the
  working-copy differ.
- **The authoring host contract.** `PageHost` (what an authoring session needs from a
  page), the page tools, a conformance suite every host must pass, the session registry,
  and the headless capability contract.

No Node and no dependencies: the engine imports no Node builtin, no package, and nothing
outside this folder. The host it runs in compiles handler source and passes the engine
functions, so the same code runs in Shim's Electron preload and in a page a Playwright
driver injects it into.

## A shim at a glance

```json
{
  "id": "quiet-news",
  "match": { "hosts": ["news.example.com"] },
  "rules": [
    {
      "id": "hide-cookie-banner",
      "anchor": { "primary": { "kind": "css", "value": "[data-testid='cookie-banner']" } },
      "mutations": [{ "kind": "hide" }]
    },
    {
      "id": "reading-time",
      "anchor": { "primary": { "kind": "css", "value": "article h1" } },
      "mutations": [{ "kind": "script", "handler": "readingTime" }]
    }
  ]
}
```

On disk, an agent edits a shim as a **folder**:

```
quiet-news/
  shim.json              the spec above: handlers named, never inlined
  handlers/
    readingTime.js       module.exports = function readingTime({ anchor, api }) { … };
```

Mutation kinds, from least to most invasive:

- CSS and layout: `hide`, `restyle`, `reorder`, `reshape`
- additive DOM: `script`, `inject-element`, `inject-html`
- deletion: `remove`
- region replacement and virtual routes: `replace-root`, `mount-route`
- network: `redirect`, `rewrite-response`, `intercept`

The network kinds need host integration, so only the Shim browser runs them. A `script`
handler gets `{ anchor, mutation, rule, spec, api }`. It registers teardown with
`api.cleanup(fn)` and can return the nodes it created to have them re-mounted after a
re-render. The full guide, covering every kind, anchors and the runtime `api`, is the
`shim-authoring` skill in `@shimbrowser/mcp`.

## Running the engine

```ts
import { run } from '@shimbrowser/core';

const control = run(
  { spec, handlers: { readingTime } },   // handlers: functions your host compiled
  api,                                    // satisfies CoreApi
);
// later
control.teardownAll();
```

- **Compile handlers yourself.** The engine never turns source into functions, because the
  CSP-safe way to do that differs per host. Pass compiled functions in `handlers` (or per
  rule, in `ruleHandlers`).
- **`api` must satisfy `CoreApi`:** `origin`, `host`, `patchId`, `reportEvent(kind,
  payload)`, `onReady(fn)`, and the `bridge` / `componentId` members, which may be stubs.
  Everything else you put on `api` (storage, for example) is passed to handlers untouched.
  Rule status, witnesses, no-match and quarantine events all arrive through `reportEvent`.
- **The page bundle.** `@shimbrowser/core/page` (`dist/shim-core.page.js`) is the whole
  engine as one browser-platform script that defines the global `ShimCore`. Use it to inject
  the engine into a page you drive. `@shimbrowser/mcp`'s Playwright driver injects it into a
  CDP isolated world.

## Modules

The root export is the page-side runtime: `run`, anchors, witnesses, component identity,
the deploy fingerprint, route and host matching. Every module is also available on its own
subpath, `@shimbrowser/core/<module>`. The authoring pieces are subpath-only and not in the
page bundle:

| Subpath | What it is |
|---|---|
| `spec-lint` | The spec linter: `lintSpec`, `assertNoSpecErrors`. It rejects invented mutation kinds and warns on brittle anchors. |
| `spec-delta` | `applyDelta` and the `DeltaOp` type: pure edits to a spec. |
| `shim-folder` | The shim folder: `checkoutShim`, `unpackShim`, `packShim`, `readShimFolder`. |
| `working-copy-diff` | `diffWorkingCopy`: an edited folder to the `DeltaOp`s that reproduce it. |
| `working-copy-wire` | `encodeWorkingCopy` / `decodeWorkingCopy`: a folder as bytes on the wire (`shim-working-copy/1`). |
| `page-host` | The `PageHost` interface: evaluate per world, screenshot, preview apply / remove, runtime-event and console streams, reload, capabilities. |
| `page-host-tools` | The page tools' page-side bodies, run over any `PageHost`. |
| `page-tools` | The page tools' one definition (`view_page`, `query_page`, `inspect_element`, …). |
| `data-tools` | The data tools' one definition (`inspect_storage`, `query_db`, `read_sibling_shim`). |
| `page-host-conformance` | The conformance cases every `PageHost` must pass. |
| `session-registry` | Authoring sessions: one owner per artifact, revisions, idempotent commit, idle timeout. |
| `capability-preflight` | The headless capability contract: `preflightSpec`, `scanRuleHandlers`, `verificationLevel`. |
| `preview-evidence`, `console-feed` | The wording and console handling a preview's evidence shares across hosts. |

## Hosts

A host runs the engine on a page and, for authoring, implements `PageHost`. Two exist
today: the Shim browser's Electron host (private) and the headless Playwright host in
`@shimbrowser/mcp` (public). Both run the same conformance suite. A capability counts as
supported on the headless host only while its cases pass on both.

| Capability | Shim browser | Headless |
|---|---|---|
| `hide`, `restyle`, `reorder`, `reshape`, `script`, `inject-element`, `inject-html`, `remove`, `replace-root` | yes | yes |
| Mount strategies, self-healing, witnesses, deterministic rebase | yes | yes |
| `api.storage`, `api.cleanup` | yes | yes |
| `mount-route`, `redirect`, `rewrite-response`, `intercept`, `anchor.iframe` | yes | no |
| `api.db`, `api.ai`, `api.settings`, `api.fetch`, `api.shared`, `api.modules` | yes | no |

## Build and test

```sh
npm run build -w @shimbrowser/core      # dist/: CommonJS, .d.ts, the page bundle
npm run typecheck -w @shimbrowser/core  # src/ with DOM types only, no Node types
npm test                                # from the repository root: every harness
```

The build fails if anything in the page bundle imports a Node builtin.

## Design decisions

Comments in both packages cite the design decisions they rest on as `D1`…`D16`;
[DECISIONS.md](DECISIONS.md) lists them.

## License

Licensed under the Apache License 2.0. Copyright Artificial Apps, LLC. See
[LICENSE](LICENSE).
