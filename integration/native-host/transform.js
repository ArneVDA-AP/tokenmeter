// Pure transform: mirror payload (from the forked extension) → web-usage.json
// schema (consumed by src/webusage-parser.js). Kept separate so it can be unit
// tested without spawning the native-messaging host.
//
// Incoming payload shape (sent by integration/extension-mirror/mirror.js):
//   {
//     generatedAt: <epoch ms>,
//     usage: [ { orgId, orgName, cookieStoreId, usageData: UsageData.toJSON() } ],
//     conversations: [ ConversationData.toJSON(), ... ]
//   }

function buildSnapshot(payload = {}, now = Date.now()) {
  const orgs = (Array.isArray(payload.usage) ? payload.usage : [])
    .filter(o => o && o.usageData && o.orgId && !o.error)
    .map(o => ({
      orgId: o.orgId,
      orgName: o.orgName || null,
      subscriptionTier: o.usageData.subscriptionTier || 'unknown',
      limits: o.usageData.limits || {},
      extraUsage: o.usageData.extraUsage || null,
      creditBalance: o.usageData.creditBalance ?? null,
    }));

  const conversations = (Array.isArray(payload.conversations) ? payload.conversations : [])
    .filter(Boolean)
    .map(c => ({
      conversationId: c.conversationId,
      model: c.model || 'unknown',
      modelVersion: c.modelVersion || null,
      length: c.length || 0,
      cost: c.cost || 0,
      uncachedCost: c.uncachedCost || 0,
      conversationIsCachedUntil: c.conversationIsCachedUntil || null,
      projectUuid: c.projectUuid || null,
      lastMessageTimestamp: c.lastMessageTimestamp || null,
      orgId: c.orgId || null,
    }));

  return {
    schemaVersion: 1,
    generatedAt: payload.generatedAt || now,
    source: 'claude-usage-extension-mirror',
    orgs,
    conversations,
  };
}

module.exports = { buildSnapshot };
