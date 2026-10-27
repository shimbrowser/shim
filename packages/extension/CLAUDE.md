# Shim for Chrome

The extension runs shims authored elsewhere. The repository root's guidance applies;
this file adds what is specific to working in this package.

## The Chrome extension skill

`.claude/skills/chrome-extensions/` is Google's Chrome extension authoring skill, copied
unmodified. Load it for any change to the manifest, the worker, the content runtime, the
popup or the install page. Three of its rules are wrong for this extension and are overridden
here:

- **Code execution.** The skill offers blob: and srcdoc iframes as ways around the extension
  CSP. They are not: a local document inherits the CSP of the page that created it, so an
  inline script in such a frame is blocked. The only place extension pages run code they did
  not ship is the manifest-declared sandbox (`prepare.html`, the handler syntax check).
  Code that runs on a site goes through `chrome.userScripts`, never through a frame.
- **Tab URLs.** The skill says reading a tab's URL needs the `tabs` permission. It does not:
  a host permission for the site already exposes the matching tab's URL and title. The
  extension holds site access per installed shim and never asks for `tabs`, which would
  expose every tab's URL and title. Keep it that way.
- **What keeps the worker alive.** The skill's service-worker reference says an open port
  keeps the worker alive. Since Chrome 114 opening a port does nothing: only message traffic
  on it resets the idle timer, and a quiet port lets the worker end after thirty seconds.
  What does keep it alive is a native messaging connection (Chrome 105) and an active
  `chrome.debugger` session (Chrome 118), so an open authoring session keeps its worker, and
  a session's bridge connection does too. Durable state lives in IndexedDB and per-instance
  state in `chrome.storage.session` regardless, and the content runtime reconnects when the
  worker has gone, as it does today.
