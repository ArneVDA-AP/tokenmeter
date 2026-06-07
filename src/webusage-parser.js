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
const { calcClaudeCost } = require('./pricer');

const LIMIT_KEYS = ['session', 'weekly', 'sonnetWeekly', 'opusWeekly'];
const LIMIT_LABELS = {
  session: 'Session (5h)',
  weekly: 'Weekly',
  sonnetWeekly: 'Weekly · Sonnet',
  opusWeekly: 'Weekly · Opus',
};
const STALE_MS = 60 * 60 * 1000; // snapshot older than 1h is flagged stale

// Conversations are context-heavy (input-dominant): assume 85% input / 15% output
// of total tokens (context re-sent each turn). Used to estimate equivalent API cost.
const WEB_INPUT_RATIO = 0.85;
// How many days of daily history to compute
const WEB_LOOKBACK_DAYS = 14;

function estConvCostUSD(c) {
  const len = c.length || 0;
  if (!len) return 0;
  return calcClaudeCost(c.model || '', len * WEB_INPUT_RATIO, len * (1 - WEB_INPUT_RATIO), 0, 0);
}

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
  const nowTs = Date.now();
  let totalConvTokens = 0, cachedCount = 0;
  let estimatedCostUSD = 0;
  for (const c of conversations) {
    totalConvTokens += c.length || 0;
    if (c.conversationIsCachedUntil && c.conversationIsCachedUntil > nowTs) cachedCount++;
    estimatedCostUSD += estConvCostUSD(c);
  }

  // ── daily array (WEB_LOOKBACK_DAYS entries, oldest → newest) ─────────────────
  // Build a map from YYYY-MM-DD → { tokens, estimatedCostUSD, conversations }
  const now = new Date();
  // Compute the date key for the oldest day in the window
  const cutoffDate = new Date(now);
  cutoffDate.setDate(cutoffDate.getDate() - (WEB_LOOKBACK_DAYS - 1));
  cutoffDate.setHours(0, 0, 0, 0);
  const cutoffTs = cutoffDate.getTime();

  const dailyMap = new Map();
  for (const c of conversations) {
    if (!c.lastMessageTimestamp) continue;
    const ts = c.lastMessageTimestamp;
    if (ts < cutoffTs) continue;
    const dateKey = new Date(ts).toLocaleDateString('en-CA');
    if (!dailyMap.has(dateKey)) {
      dailyMap.set(dateKey, { tokens: 0, estimatedCostUSD: 0, conversations: 0 });
    }
    const day = dailyMap.get(dateKey);
    day.tokens += c.length || 0;
    day.estimatedCostUSD += estConvCostUSD(c);
    day.conversations += 1;
  }

  const daily = [];
  for (let i = WEB_LOOKBACK_DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateKey = d.toLocaleDateString('en-CA');
    const data = dailyMap.get(dateKey) || { tokens: 0, estimatedCostUSD: 0, conversations: 0 };
    daily.push({ date: dateKey, ...data });
  }

  // ── hourly array (24 elements, indexed by hour of day) ───────────────────────
  const hourly = new Array(24).fill(0);
  for (const c of conversations) {
    if (!c.lastMessageTimestamp) continue;
    const hr = new Date(c.lastMessageTimestamp).getHours();
    hourly[hr] += c.length || 0;
  }

  // ── modelBreakdown (sorted by tokens desc) ───────────────────────────────────
  const modelMap = new Map();
  for (const c of conversations) {
    const key = c.model || 'unknown';
    if (!modelMap.has(key)) {
      modelMap.set(key, { model: key, count: 0, tokens: 0, estimatedCostUSD: 0 });
    }
    const entry = modelMap.get(key);
    entry.count += 1;
    entry.tokens += c.length || 0;
    entry.estimatedCostUSD += estConvCostUSD(c);
  }
  const modelBreakdown = Array.from(modelMap.values()).sort((a, b) => b.tokens - a.tokens);

  // ── cacheSavingsUSD ──────────────────────────────────────────────────────────
  // Use the extension's own cost vs uncachedCost to derive a savings ratio,
  // then scale into our estimated API cost.
  let sumCost = 0, sumUncached = 0;
  for (const c of conversations) {
    sumCost += c.cost || 0;
    sumUncached += c.uncachedCost || 0;
  }
  let cacheSavingsUSD = 0;
  if (sumUncached > 0 && sumUncached >= sumCost) {
    const ratio = 1 - sumCost / sumUncached;
    cacheSavingsUSD = estimatedCostUSD * ratio;
  }

  // ── topConversations (enriched with estimatedCostUSD) ────────────────────────
  const topConversations = conversations
    .slice()
    .sort((a, b) => (b.cost || 0) - (a.cost || 0))
    .slice(0, 10)
    .map(c => ({
      conversationId: c.conversationId,
      model: c.model || 'unknown',
      length: c.length || 0,
      cost: c.cost || 0,
      cached: !!(c.conversationIsCachedUntil && c.conversationIsCachedUntil > nowTs),
      lastMessageTimestamp: c.lastMessageTimestamp || null,
      estimatedCostUSD: estConvCostUSD(c),
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
    conversationTokens: totalConvTokens,
    totalTokens: totalConvTokens,  // alias so renderer can treat it like the Claude tab
    cachedConversations: cachedCount,
    estimatedCostUSD,
    daily,
    hourly,
    modelBreakdown,
    cacheSavingsUSD,
    topConversations,
    dataNote: stale
      ? 'Web-usage snapshot is over an hour old — open claude.ai with the extension to refresh.'
      : (orgs.length === 0 ? 'Web-usage snapshot contained no organizations.' : null),
  };
}

module.exports = { aggregateWebUsage, normalizeLimits, LIMIT_KEYS, LIMIT_LABELS };
