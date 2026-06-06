# Web-usage integration (Phase 2)

Brings claude.ai **web-UI** usage (from the lugia19 Claude-Usage-Extension) into
Tokenmeter, without Tokenmeter ever touching the extension's GPL code.

```
 forked extension (GPL)            native host (MIT/this repo)        Tokenmeter (MIT)
 ──────────────────────            ───────────────────────────        ────────────────
 extension-mirror/mirror.js  ──►   native-host/tokenmeter-host.js ──► web-usage.json ──► src/webusage-parser.js
   reads its own storage,            writes %APPDATA%\Tokenmeter\        read as a third
   posts snapshot via                web-usage.json (atomic)            data source
   Native Messaging
```

The only thing crossing the MIT/GPL boundary is a plain JSON file over a
separate-process Native Messaging pipe — "mere aggregation", so the licenses
don't conflict (see `../vendor/README.md`).

## Components (built, tested where possible)
- `native-host/transform.js` — pure mirror-payload → `web-usage.json` transform (unit-tested).
- `native-host/tokenmeter-host.js` — Node native-messaging host; writes the snapshot atomically.
- `native-host/tokenmeter-host.bat` — Windows launcher (Firefox runs an executable, not a .js).
- `native-host/tokenmeter_host.json` — native manifest template.
- `extension-mirror/mirror.js` — GPL module to add to a fork of the extension.

## On-machine spike checklist (do when back at the PC)
1. **Confirm the extension's gecko id** in `vendor/claude-usage-extension/manifest_firefox.json`
   → currently `claude_usage_tracker@lugia19.com`. If you fork with a new id, update
   `allowed_extensions` in `tokenmeter_host.json` to match.
2. **Fork & load the extension** in Zen (about:debugging → Load Temporary Add-on, or a
   signed build). Copy `extension-mirror/mirror.js` into the extension as
   `tokenmeter-mirror/mirror.js`, add to `background.js`:
   ```js
   import { startTokenmeterMirror } from './tokenmeter-mirror/mirror.js';
   startTokenmeterMirror({ getUsage: getPopupUsageData });
   ```
   and add `"nativeMessaging"` to the manifest `permissions`.
3. **Install the native host** (one command):
   ```powershell
   powershell -ExecutionPolicy Bypass -File integration\native-host\install.ps1
   ```
   This checks for Node, writes `tokenmeter_host.json` with the correct launcher path,
   and registers it under `HKCU\Software\Mozilla\NativeMessagingHosts\com.tokenmeter.host`.
   Ensure Node.js is on PATH (the .bat calls `node`). Undo with `uninstall.ps1`.
   If Zen uses a vendor-specific registry path instead of Mozilla's, adjust `$regKey`.
4. **Verify**: open claude.ai in Zen so the extension refreshes; check that
   `%APPDATA%\Tokenmeter\web-usage.json` appears and updates. Then open Tokenmeter —
   `scan()` will pick it up as `data.web`.

## What still needs doing after the spike
- A Tokenmeter UI surface for `data.web` (limits gauges + top conversations). The data
  layer (`src/webusage-parser.js`, scanner wiring, tests) is already in place and green.
