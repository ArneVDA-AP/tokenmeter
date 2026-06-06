# vendor/

Third-party code, vendored into this repository so both halves of the
Tokenmeter ↔ web-usage integration can be developed and tracked together.

## claude-usage-extension/

A snapshot of [lugia19/Claude-Usage-Extension](https://github.com/lugia19/Claude-Usage-Extension)
(commit `64aeb01a8330aa730a10e650d7d8ed84fc4528ec`), the browser extension that
tracks claude.ai **web-UI** usage (token caps, per-conversation cost/cache).

### Licensing — important

This extension is licensed **GPL-3.0** (see `claude-usage-extension/LICENSE`),
which is different from Tokenmeter's own MIT license. To keep the two cleanly
separated and avoid any copyleft conflict:

- The vendored extension keeps its **own GPL-3.0 LICENSE**, unmodified. Any
  changes we make *inside* `claude-usage-extension/` are also GPL-3.0.
- Tokenmeter's own code (MIT) must **never `require()`/`import` extension code**.
  The integration boundary is a **separate process** talking over a plain JSON
  file written via Native Messaging (planned Phase 2). Communicating at arm's
  length across a process boundary is "mere aggregation" — the GPL does not
  propagate across it, so Tokenmeter stays MIT and the extension stays GPL.

This is exactly why the integration uses the Native-Messaging / file-snapshot
design rather than reading the extension's storage in-process.

This vendored copy is for reference and for building a GPL-3.0 fork that adds a
small "mirror" module; it is not bundled into Tokenmeter's build.
