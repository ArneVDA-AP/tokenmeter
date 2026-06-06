// Contract test: mirror payload → host transform → web-usage.json → parser.
// Proves the three pieces agree on the schema end to end.

const assert = require('assert');
const { buildSnapshot } = require('../integration/native-host/transform');
const { aggregateWebUsage } = require('../src/webusage-parser');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

const now = Date.now();

// A payload shaped exactly like extension-mirror/mirror.js posts:
//   usage = getPopupUsageData() result; conversations = ConversationData.toJSON()[]
const payload = {
  generatedAt: now,
  usage: [
    {
      orgId: 'org-1', orgName: 'Personal', cookieStoreId: 'firefox-default',
      usageData: {
        limits: {
          session: { percentage: 33, resetsAt: now + 3600000 },
          weekly: { percentage: 60, resetsAt: now + 86400000 },
          sonnetWeekly: null, opusWeekly: null,
        },
        subscriptionTier: 'claude_pro',
        extraUsage: null,
        creditBalance: null,
        orgId: 'org-1',
      },
    },
    { orgId: 'org-err', error: 'boom' }, // failed org → must be dropped
  ],
  conversations: [
    { conversationId: 'c1', model: 'claude-opus-4', modelVersion: 'claude-opus-4-x',
      length: 90000, cost: 4200, uncachedCost: 7000,
      conversationIsCachedUntil: now + 600000, projectUuid: 'p1',
      lastMessageTimestamp: now - 1000, orgId: 'org-1' },
  ],
};

const snapshot = buildSnapshot(payload);

check('buildSnapshot sets schemaVersion + source', () => {
  assert.strictEqual(snapshot.schemaVersion, 1);
  assert.strictEqual(snapshot.source, 'claude-usage-extension-mirror');
});
check('failed orgs dropped, valid org kept', () => {
  assert.strictEqual(snapshot.orgs.length, 1);
  assert.strictEqual(snapshot.orgs[0].orgId, 'org-1');
});
check('conversation normalized', () => {
  assert.strictEqual(snapshot.conversations.length, 1);
  assert.strictEqual(snapshot.conversations[0].length, 90000);
});

// End-to-end: write snapshot to disk and parse it like Tokenmeter would.
check('snapshot is consumable by webusage-parser', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-xfm-'));
  const f = path.join(dir, 'web-usage.json');
  fs.writeFileSync(f, JSON.stringify(snapshot));
  const r = aggregateWebUsage(f);
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.primaryOrg.orgId, 'org-1');
  assert.strictEqual(r.primaryOrg.limits.length, 2); // session + weekly
  assert.strictEqual(r.totalConversations, 1);
  assert.strictEqual(r.cachedConversations, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(failures === 0 ? '\nIntegration transform tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
