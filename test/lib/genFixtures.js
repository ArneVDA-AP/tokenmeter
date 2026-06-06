// Deterministic fixture generator: writes a realistic .claude/projects tree
// (multiple projects, many sessions, several models, varied cache rates, spread
// over days/hours) into the given directory. Shared by the screenshot harness
// and available for tests. Seeded RNG → reproducible output.

const fs = require('fs');
const path = require('path');

function gen(claudeProjectsDir, opts = {}) {
  let s = (opts.seed || 42) >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const ri = (a, b) => Math.floor(a + rnd() * (b - a + 1));

  const projects = [
    { folder: 'C--Users-arne-desktop-projects-tokenmeter', sessions: 28 },
    { folder: 'C--Users-arne-desktop-projects-burnlink',   sessions: 16 },
    { folder: 'C--Users-arne-desktop-projects-api-gateway', sessions: 11 },
    { folder: 'C--Users-arne-Documents-scripts',           sessions: 7 },
    { folder: 'C--Users-arne',                             sessions: 5 }, // → "Home"
  ];
  const models = [
    'claude-opus-4-20250514',
    'claude-sonnet-4-20250514',
    'claude-haiku-4-20250101',
  ];
  const now = Date.now();

  for (const p of projects) {
    const dir = path.join(claudeProjectsDir, p.folder);
    fs.mkdirSync(dir, { recursive: true });

    for (let i = 0; i < p.sessions; i++) {
      const daysAgo = ri(0, 18);
      const start = new Date(now - daysAgo * 86400000);
      start.setHours(ri(8, 23), ri(0, 59), 0, 0);

      const recs = ri(2, 14);
      const primary = models[ri(0, models.length - 1)];
      const lines = [];
      let t = start.getTime();

      for (let r = 0; r < recs; r++) {
        t += ri(20, 240) * 1000;
        const model = rnd() < 0.15 ? models[ri(0, models.length - 1)] : primary;
        lines.push(JSON.stringify({
          type: 'assistant',
          timestamp: new Date(t).toISOString(),
          message: { model, usage: {
            input_tokens: ri(200, 4000),
            output_tokens: ri(100, 2500),
            cache_read_input_tokens: ri(0, 40000),
            cache_creation_input_tokens: ri(0, 3000),
          } },
        }));
      }
      lines.push(JSON.stringify({ type: 'user', message: { content: '…' } })); // noise

      const fp = path.join(dir, `sess-${i}-${Math.floor(rnd() * 1e6)}.jsonl`);
      fs.writeFileSync(fp, lines.join('\n') + '\n');
      const end = new Date(t);          // mtime = session end → realistic recency
      fs.utimesSync(fp, end, end);
    }
  }
}

// Write a realistic web-usage.json snapshot (the contract Tokenmeter reads).
function genWebUsage(filePath, opts = {}) {
  const now = opts.now || Date.now();
  const H = 3600000, D = 86400000;
  const snapshot = {
    schemaVersion: 1,
    generatedAt: now - 4 * 60000,
    source: 'claude-usage-extension-mirror',
    orgs: [{
      orgId: 'org-personal', orgName: 'Personal', subscriptionTier: 'claude_max_20x',
      limits: {
        session: { percentage: 47, resetsAt: now + 2 * H },
        weekly: { percentage: 68, resetsAt: now + 4 * D },
        sonnetWeekly: { percentage: 52, resetsAt: now + 4 * D },
        opusWeekly: { percentage: 93, resetsAt: now + 4 * D },
      },
      extraUsage: { isEnabled: true, monthlyLimit: 5000, usedCredits: 1800 },
      creditBalance: 7200,
    }],
    conversations: [
      { conversationId: 'a1b2c3d4e5', model: 'claude-opus-4', length: 142000, cost: 5200, uncachedCost: 8100, conversationIsCachedUntil: now + 9 * 60000, lastMessageTimestamp: now - 30 * 60000, orgId: 'org-personal' },
      { conversationId: 'f6g7h8i9j0', model: 'claude-sonnet-4', length: 64000, cost: 1400, uncachedCost: 2100, conversationIsCachedUntil: null, lastMessageTimestamp: now - 3 * H, orgId: 'org-personal' },
      { conversationId: 'k1l2m3n4o5', model: 'claude-opus-4', length: 38000, cost: 900, uncachedCost: 1300, conversationIsCachedUntil: now + 4 * 60000, lastMessageTimestamp: now - 5 * H, orgId: 'org-personal' },
    ],
  };
  require('fs').writeFileSync(filePath, JSON.stringify(snapshot));
}

module.exports = { gen, genWebUsage };
