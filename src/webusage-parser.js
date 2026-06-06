// Parses the web-usage.json snapshot written by the Tokenmeter mirror (a small
// GPL module added to a fork of the lugia19 Claude-Usage-Extension, delivered
// via Native Messaging — see vendor/README.md and integration/). This file only
// ever reads a plain JSON file, so Tokenmeter's MIT code never touches the GPL
// extension code: the boundary is the file/process, not an import.
//
// web-usage.json schema (schemaVersion 1):
// {
//   "schemaVersion": 1,
//   "generatedAt": <epoch ms>,
//   "source": "claude-usage-extension-mirror",
//   "orgs": [{
//     "orgId": str, "orgName": str|null,
//     "subscriptionTier": str,
//     "limits": {
//       "session"|"weekly"|"sonnetWeekly"|"opusWeekly":
//         { "percentage": num, "resetsAt": <epoch ms> } | null
//     },
//     "extraUsage": { isEnabled, monthlyLimit, usedCredits } | null,  // cents
//     "creditBalance": <cents> | null
//   }],
//   "conversations": [{
//     "conversationId": str, "model": str, "modelVersion": str,
//     "length": <tokens>, "cost": num, "uncachedCost": num,
//     "conversationIsCachedUntil": <epoch ms>|null,
//     "projectUuid": str|null, "lastMessageTimestamp": <epoch ms>|null,
//     "orgId": str
//   }]
// }

const fs = require('fs');

const LIMIT_KEYS = ['session', 'weekly', 'sonnetWeekly', 'opusWeekly'];
const LIMIT_LABELS = {
  session: 'Session (5h)',
  weekly: 'Weekly',
  sonnetWeekly: 'Weekly · Sonnet',
  opusWeekly: 'Weekly · Opus',
};
const STALE_MS = 60 * 60 * 1000; // snapshot older than 1h is flagged stale

function normalizeLimits(limits) {
  const out = [];
  if (!limits) return out;
  for (const key of LIMIT_KEYS) {
    const l = limits[key];
    if (!l || typeof l.percentage !== 'number') continue;
    out.push({
      key,
      label: LIMIT_LABELS[key] || key,
      percentage: Math.max(0, Math.min(100, l.percentage)),
      resetsAt: l.resetsAt || null,
    });
  }
  return out;
}

function aggregateWebUsage(webUsagePath) {
  if (!webUsagePath || !fs.existsSync(webUsagePath)) {
    return {
      available: false,
      dataNote: 'No web-usage data found. Install the Tokenmeter mirror in the Claude Usage extension to track claude.ai web usage.',
    };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(webUsagePath, 'utf8'));
  } catch (e) {
    return { available: false, dataNote: `Could not read web-usage.json: ${e.message}` };
  }

  const generatedAt = raw.generatedAt || null;
  const ageMs = generatedAt ? Date.now() - generatedAt : null;
  const stale = ageMs != null && ageMs > STALE_MS;

  const orgs = (Array.isArray(raw.orgs) ? raw.orgs : []).map(o => ({
    orgId: o.orgId || null,
    orgName: o.orgName || null,
    subscriptionTier: o.subscriptionTier || 'unknown',
    limits: normalizeLimits(o.limits),
    extraUsage: o.extraUsage || null,
    creditBalance: o.creditBalance ?? null,
  }));

  // Primary org = the one exposing the most limits (Max accounts have more).
  const primaryOrg = orgs.slice().sort((a, b) => b.limits.length - a.limits.length)[0] || null;

  // Conversation aggregates.
  const conversations = Array.isArray(raw.conversations) ? raw.conversations : [];
  const now = Date.now();
  let totalTokens = 0, cachedCount = 0;
  for (const c of conversations) {
    totalTokens += c.length || 0;
    if (c.conversationIsCachedUntil && c.conversationIsCachedUntil > now) cachedCount++;
  }
  const topConversations = conversations
    .slice()
    .sort((a, b) => (b.cost || 0) - (a.cost || 0))
    .slice(0, 10)
    .map(c => ({
      conversationId: c.conversationId,
      model: c.model || 'unknown',
      length: c.length || 0,
      cost: c.cost || 0,
      cached: !!(c.conversationIsCachedUntil && c.conversationIsCachedUntil > now),
      lastMessageTimestamp: c.lastMessageTimestamp || null,
    }));

  return {
    available: orgs.length > 0,
    schemaVersion: raw.schemaVersion || 1,
    generatedAt,
    ageMs,
    stale,
    orgs,
    primaryOrg,
    totalConversations: conversations.length,
    conversationTokens: totalTokens,
    cachedConversations: cachedCount,
    topConversations,
    dataNote: stale
      ? 'Web-usage snapshot is over an hour old — open claude.ai with the extension to refresh.'
      : (orgs.length === 0 ? 'Web-usage snapshot contained no organizations.' : null),
  };
}

module.exports = { aggregateWebUsage, normalizeLimits, LIMIT_KEYS, LIMIT_LABELS };
