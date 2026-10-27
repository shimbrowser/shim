# Shim for Chrome

The extension runs shims authored elsewhere. The repository root's guidance applies;
this file adds what is specific to working in this package.

## The Chrome extension skill

`.claude/skills/chrome-extensions/` is Google's Chrome extension authoring skill, copied
unmodified. Load it for any change to the manifest, the worker, the content runtime, the
popup or the install page. Two of its rules are wrong for this extension and are overridden
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

## Worker lifetime

Chrome ends an idle worker after about thirty seconds, and an open `chrome.debugger`
session dies with it. Durable state lives in IndexedDB, the per-instance state in
`chrome.storage.session`, and anything that must outlast a quiet half minute, such as an
authoring session, has to hold a port open for as long as it lives.
