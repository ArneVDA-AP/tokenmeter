# Tokenmeter fork — progress log

Personal fork of [DewashishCodes/tokenmeter](https://github.com/DewashishCodes/tokenmeter).
Work happens on branch `claude/nice-mayer-zY4Du`. This log is so I (Arne) can follow
along from mobile.

## Goals
1. Granular per-session overview (more detail per Claude Code session) — **done (Phase 1)**
2. Cache hit % metrics — **done (Phase 1)**
3. Integration with the lugia19 Claude-Usage-Extension (web-UI usage) — **designed, Phase 2**

## Status

### ✅ Phase 1 — granular sessions + cache-hit metrics (complete & tested)
- **Cache hit %** (`cacheRead / (cacheRead + input)`): global stat card, per-project
  table column, per-session value, and a 14-day cache-hit trend chart.
- **Sessions tab** (tmux-style): full sortable/filterable session list with a
  drill-down detail pane (per-session stats + per-model breakdown + token-split chart).
  Rich per-session data that the parser used to compute and discard is now retained.
- **Accuracy fix**: session cost is now the sum of per-model record costs (correct
  when a session switches models mid-stream).
- **Generic project-name decoding** (no hardcoded username).

### ✅ Real bugs found & fixed while testing
- **Offline regression**: the app claimed "entirely offline" but loaded Chart.js and
  fonts from CDNs at runtime. Vendored both locally (`renderer/vendor/`) and tightened
  the CSP to `'self'`. Now genuinely offline.
- **Charts on hidden pages rendered mis-sized**: charts built while their page was
  `display:none` measured width 0. `navigate()` now re-renders a page's content when
  it becomes visible. (Affected the original app too.)

### ✅ Testing infrastructure (so I can verify autonomously)
- `npm test` — headless parser unit tests (fast, no display).
- `npm run test:ui` — automated UI smoke test in Electron under xvfb (drives the UI,
  asserts overview/cache-hit/sessions/row-click/filtering, fails on console errors).
- `npm run screenshots` — captures `test/shots/*.png` for visual/UX review.
- Curated screenshots committed in `docs/screenshots/` for mobile review.
- Shared fixture generator: `test/lib/genFixtures.js`.

### ✅ Personalization (license-aware)
- Added `LICENSE` (was missing) preserving the original author's MIT copyright.
- Repointed README to the fork; credited the original project.

### 🔜 Phase 2 — lugia19 web-UI integration (next)
- Vendored the extension at `vendor/claude-usage-extension/` (GPL-3.0 — see
  `vendor/README.md` for the licensing boundary).
- Plan: a GPL fork of the extension adds a small "mirror" module that pushes its
  `browser.storage.local` snapshot over **Native Messaging** to a tiny local host,
  which writes `web-usage.json`. Tokenmeter reads that as a third source (MIT side
  never imports GPL code — separate process boundary).
- Needs a short on-machine spike (Zen profile path, extension id) before building.

## How to run locally (Windows)
```
npm install
npm test            # parser tests
npm start           # launch the app
```
