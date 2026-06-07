// Headless unit test for src/webusage-parser.js. Writes a web-usage.json
// fixture to a temp file and asserts the parsed/aggregated shape.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { aggregateWebUsage } = require('../src/webusage-parser');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

const now = Date.now();
const H = 3600000, D = 86400000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-web-'));
const file = path.join(dir, 'web-usage.json');

const fixture = {
  schemaVersion: 1,
  generatedAt: now - 5 * 60000, // 5 min old → fresh
  source: 'claude-usage-extension-mirror',
  orgs: [
    {
      orgId: 'org-A', orgName: 'Personal', subscriptionTier: 'claude_max_20x',
      limits: {
        session: { percentage: 42, resetsAt: now + 3 * H },
        weekly: { percentage: 70, resetsAt: now + 3 * D },
        sonnetWeekly: { percentage: 55, resetsAt: now + 3 * D },
        opusWeekly: { percentage: 188, resetsAt: now + 3 * D }, // clamps to 100
      },
      extraUsage: { isEnabled: true, monthlyLimit: 5000, usedCredits: 1200 },
      creditBalance: 8000,
    },
    {
      orgId: 'org-B', orgName: 'Work', subscriptionTier: 'claude_pro',
      limits: { session: { percentage: 10, resetsAt: now + 2 * H }, weekly: null, sonnetWeekly: null, opusWeekly: null },
    },
  ],
  conversations: [
    { conversationId: 'c1', model: 'claude-opus-4', length: 120000, cost: 5000, uncachedCost: 8000, conversationIsCachedUntil: now + 10 * 60000, lastMessageTimestamp: now - H, orgId: 'org-A' },
    { conversationId: 'c2', model: 'claude-sonnet-4', length: 30000, cost: 1000, uncachedCost: 1500, conversationIsCachedUntil: now - 10 * 60000, lastMessageTimestamp: now - 2 * H, orgId: 'org-A' },
    { conversationId: 'c3', model: 'claude-haiku-4', length: 5000, cost: 100, uncachedCost: 120, conversationIsCachedUntil: null, orgId: 'org-B' },
  ],
};
fs.writeFileSync(file, JSON.stringify(fixture));

const r = aggregateWebUsage(file);

check('available', () => assert.strictEqual(r.available, true));
check('fresh snapshot not stale', () => assert.strictEqual(r.stale, false));
check('two orgs parsed', () => assert.strictEqual(r.orgs.length, 2));
check('primary org = the one with most limits (org-A)', () => {
  assert.strictEqual(r.primaryOrg.orgId, 'org-A');
  assert.strictEqual(r.primaryOrg.limits.length, 4);
});
check('limit percentage clamped to 100', () => {
  const opus = r.primaryOrg.limits.find(l => l.key === 'opusWeekly');
  assert.strictEqual(opus.percentage, 100);
  assert.ok(opus.label.length > 0);
});
check('org-B has only the session limit', () => {
  const b = r.orgs.find(o => o.orgId === 'org-B');
  assert.strictEqual(b.limits.length, 1);
  assert.strictEqual(b.limits[0].key, 'session');
});
check('conversation aggregates', () => {
  assert.strictEqual(r.totalConversations, 3);
  assert.strictEqual(r.conversationTokens, 155000);
  assert.strictEqual(r.cachedConversations, 1); // only c1 still cached
});
check('topConversations sorted by cost desc, cached flag set', () => {
  assert.deepStrictEqual(r.topConversations.map(c => c.conversationId), ['c1', 'c2', 'c3']);
  assert.strictEqual(r.topConversations[0].cached, true);
});

// Missing file → graceful unavailable
check('missing file → available:false with note', () => {
  const m = aggregateWebUsage(path.join(dir, 'nope.json'));
  assert.strictEqual(m.available, false);
  assert.ok(/mirror/i.test(m.dataNote));
});

// Stale snapshot → flagged
check('stale snapshot flagged', () => {
  const sf = path.join(dir, 'stale.json');
  fs.writeFileSync(sf, JSON.stringify({ ...fixture, generatedAt: now - 3 * H }));
  const s = aggregateWebUsage(sf);
  assert.strictEqual(s.stale, true);
  assert.ok(/hour old/i.test(s.dataNote));
});

// Corrupt JSON → graceful
check('corrupt JSON → available:false', () => {
  const cf = path.join(dir, 'bad.json');
  fs.writeFileSync(cf, '{ not json');
  const c = aggregateWebUsage(cf);
  assert.strictEqual(c.available, false);
});

fs.rmSync(dir, { recursive: true, force: true });

// ── Aggregate assertions using the genWebUsage fixture ────────────────────────
// Build a realistic ~32-conversation snapshot and assert derived fields.

const { genWebUsage } = require('./lib/genFixtures');
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-web2-'));
const file2 = path.join(dir2, 'web-usage.json');
const fixedNow = Date.now();
genWebUsage(file2, { now: fixedNow });
const g = aggregateWebUsage(file2);

// daily
check('daily length === 14', () => assert.strictEqual(g.daily.length, 14));
check('daily entries have correct shape', () => {
  for (const entry of g.daily) {
    assert.strictEqual(typeof entry.date, 'string', `date should be string, got ${typeof entry.date}`);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `date should be YYYY-MM-DD, got ${entry.date}`);
    assert.strictEqual(typeof entry.tokens, 'number', `tokens should be number`);
    assert.strictEqual(typeof entry.estimatedCostUSD, 'number', `estimatedCostUSD should be number`);
    assert.strictEqual(typeof entry.conversations, 'number', `conversations should be number`);
  }
});
check('daily is chronologically ordered (oldest → newest)', () => {
  for (let i = 1; i < g.daily.length; i++) {
    assert.ok(g.daily[i].date >= g.daily[i - 1].date,
      `day[${i}].date ${g.daily[i].date} < day[${i - 1}].date ${g.daily[i - 1].date}`);
  }
});

// hourly
check('hourly length === 24', () => assert.strictEqual(g.hourly.length, 24));
check('hourly all numbers', () => {
  for (let i = 0; i < 24; i++) {
    assert.strictEqual(typeof g.hourly[i], 'number', `hourly[${i}] should be number`);
  }
});
check('hourly sum > 0 (conversations with timestamps contribute)', () => {
  const total = g.hourly.reduce((a, b) => a + b, 0);
  assert.ok(total > 0, `hourly sum should be > 0, got ${total}`);
});

// modelBreakdown
check('modelBreakdown non-empty', () => assert.ok(g.modelBreakdown.length > 0));
check('modelBreakdown sorted by tokens desc', () => {
  for (let i = 1; i < g.modelBreakdown.length; i++) {
    assert.ok(g.modelBreakdown[i].tokens <= g.modelBreakdown[i - 1].tokens,
      `modelBreakdown not sorted at index ${i}`);
  }
});
check('modelBreakdown entries have correct shape', () => {
  for (const entry of g.modelBreakdown) {
    assert.strictEqual(typeof entry.model, 'string', 'model should be string');
    assert.strictEqual(typeof entry.count, 'number', 'count should be number');
    assert.strictEqual(typeof entry.tokens, 'number', 'tokens should be number');
    assert.strictEqual(typeof entry.estimatedCostUSD, 'number', 'estimatedCostUSD should be number');
  }
});

// estimatedCostUSD + totalTokens
check('estimatedCostUSD > 0', () => assert.ok(g.estimatedCostUSD > 0, `estimatedCostUSD should be > 0, got ${g.estimatedCostUSD}`));
check('totalTokens === conversationTokens', () => assert.strictEqual(g.totalTokens, g.conversationTokens));

// cacheSavingsUSD
check('cacheSavingsUSD >= 0', () => assert.ok(g.cacheSavingsUSD >= 0, `cacheSavingsUSD should be >= 0, got ${g.cacheSavingsUSD}`));
check('cacheSavingsUSD <= estimatedCostUSD', () => assert.ok(g.cacheSavingsUSD <= g.estimatedCostUSD,
  `cacheSavingsUSD ${g.cacheSavingsUSD} > estimatedCostUSD ${g.estimatedCostUSD}`));

// topConversations enriched with estimatedCostUSD
check('each topConversations entry has numeric estimatedCostUSD', () => {
  assert.ok(g.topConversations.length > 0, 'topConversations should be non-empty');
  for (const c of g.topConversations) {
    assert.strictEqual(typeof c.estimatedCostUSD, 'number',
      `topConversations entry missing numeric estimatedCostUSD: ${JSON.stringify(c)}`);
  }
});

fs.rmSync(dir2, { recursive: true, force: true });

console.log(failures === 0 ? '\nAll web-usage tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
