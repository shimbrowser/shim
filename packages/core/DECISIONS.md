# Design decisions

Comments in `@shimbrowser/core` and `@shimbrowser/mcp` cite these as `D1`…`D16`. Each is a
decision the two packages are built around; the comment that cites one says how it applies
there.

| # | Decision |
|---|---|
| D1 | An authoring session reuses the host's own authoring turn: begin, drive, finish. The agent (Claude Code, through `@shimbrowser/mcp`) is the loop; the host has no model of its own in a session. |
| D2 | The tool contract is public and static. Every tool is registered up front, with no mid-session `list_changed`; a tool a host can't serve answers `requires-shim-browser`. |
| D3 | Compositions (pages Shim builds from scratch): the file format is public, the runtime stays in the Shim browser, and sessions on them are attach-only. |
| D4 | No Node in the engine. It runs anywhere there is a DOM; each host compiles handler source into functions and hands them in. The deploy fingerprint (`deploy-id`, pure-JS `sha256`) stays in core. |
| D5 | The cut line: the engine, spec format, lint, delta, folder format, differ, page-host contract and page tools are public; the browser's storage, consent UI and turn machinery are not. |
| D6 | The Shim browser's control endpoint: a Unix socket plus a bearer token, off by default, and an attach card in Shim for every session. |
| D7 | One public authoring guide, shipped as a Claude Code skill (`packages/mcp/skills/shim-authoring/SKILL.md`). |
| D8 | Workspace packages first, a public repository at launch. |
| D9 | Headless mode runs the engine in an isolated world of a Playwright Chromium page (Chromium only), so handlers get the same isolated-world semantics as in the Shim browser. |
| D10 | The working copy is a folder (`shim.json` + `handlers/`, or a composition's files): checkout, edit, preview, commit. |
| D11 | Every preview returns evidence: per-rule matches and boxes, handler errors, anchors that matched nothing, console, and an optional screenshot. Both hosts return the same shape. |
| D12 | Handler execution under a strict page CSP was proven by a real-browser spike first; the shared conformance suite (`page-host-conformance`) is the gate every host passes. |
| D13 | The API map (what Shim recorded of a site's API): the list of site names is one permission, each site's content another, and every lookup is checked against the resolved endpoint's host. |
| D14 | One ordered queue per session, numbered revisions, an idempotent commit, and ending a session takes effect immediately. |
| D15 | Headless supports a stated subset of shim features and refuses the rest up front; each rule's result is `full` or `partial` verification. |
| D16 | A session is trusted while it authors (and never spends the user's AI key); anything sensitive a commit would grant is approved once, on a card, at commit. |
