// Tokenmeter mirror module — GPL-3.0.
//
// This file is part of the *forked* Claude-Usage-Extension (GPL-3.0), NOT of
// Tokenmeter (MIT). It runs inside the extension's background context, where it
// can legitimately read the extension's own browser.storage.local and call its
// usage fetcher. It pushes a snapshot to the Tokenmeter native-messaging host,
// which writes web-usage.json. Tokenmeter reads only that file — it never
// imports this code. See vendor/README.md for the licensing boundary.
//
// Wiring (in the forked extension's background.js):
//   import { startTokenmeterMirror } from './tokenmeter-mirror/mirror.js';
//   startTokenmeterMirror({ getUsage: getPopupUsageData });
// and add "nativeMessaging" to the manifest permissions.

/* global browser */

export function startTokenmeterMirror({
  getUsage,                       // async () => [{ orgId, orgName, usageData }]
  hostName = 'com.tokenmeter.host',
  debounceMs = 4000,
  periodicMinutes = 5,
} = {}) {
  let port = null;

  function connect() {
    try {
      port = browser.runtime.connectNative(hostName);
      port.onDisconnect.addListener(() => { port = null; });
    } catch (e) {
      port = null;
    }
  }

  async function readConversations() {
    try {
      const r = await browser.storage.local.get('conversationCache');
      const arr = r.conversationCache || []; // [[id, storedValue], ...]
      return arr
        .map(([, sv]) => (sv && typeof sv === 'object' && 'value' in sv && 'expires' in sv) ? sv.value : sv)
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  async function push() {
    try {
      if (!port) connect();
      if (!port) return;
      const usage = typeof getUsage === 'function' ? await getUsage() : [];
      const conversations = await readConversations();
      port.postMessage({ generatedAt: Date.now(), usage, conversations });
    } catch (e) {
      // Mirroring is best-effort; never break the host extension.
    }
  }

  let timer = null;
  function debounced() { clearTimeout(timer); timer = setTimeout(push, debounceMs); }

  browser.storage.onChanged.addListener((_changes, area) => { if (area === 'local') debounced(); });

  if (browser.alarms) {
    browser.alarms.create('tokenmeterMirror', { periodInMinutes: periodicMinutes });
    browser.alarms.onAlarm.addListener((a) => { if (a.name === 'tokenmeterMirror') push(); });
  }

  push(); // initial snapshot
  return { push };
}
