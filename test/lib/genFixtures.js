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

  const pick = (arr) => arr[ri(0, arr.length - 1)];
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
  const now = opts.now || Date.now();

  const prompts = ['refactor the session view', 'add cost tracking', 'fix navbar alignment',
    'implement link preview cards', 'setup dotfiles sync', 'add rate limiting middleware',
    'tidy up the parser', 'wire up the settings modal'];
  const files = ['src/parser.js', 'renderer/app.js', 'src/scanner.js', 'renderer/styles.css', 'src/pricer.js', 'main.js'];
  const cmds = ['npm test', 'npm run build', 'git status', 'node test/parser.test.js'];
  const notes = ['Reading project files…', 'Analyzing the module…', 'Applying edits…', 'Checking the diff…', 'Wiring it together…'];
  const subagents = ['verifier', 'general-purpose', 'Explore'];
  const summaries = ['Refactor session view into a compositor overview',
    'Add per-day cost tracking to the dashboard', 'Fix navbar alignment on small windows',
    'Implement link preview cards with caching', 'Sync dotfiles across machines',
    'Add token-bucket rate limiting middleware', 'Tidy and document the JSONL parser',
    'Wire up the settings modal and persistence'];
  const usage = () => ({
    input_tokens: ri(200, 4000), output_tokens: ri(100, 2500),
    cache_read_input_tokens: ri(0, 40000), cache_creation_input_tokens: ri(0, 3000),
  });
  const subUsage = () => ({
    input_tokens: ri(100, 1500), output_tokens: ri(50, 900),
    cache_read_input_tokens: ri(0, 15000), cache_creation_input_tokens: ri(0, 1200),
  });

  for (const p of projects) {
    const dir = path.join(claudeProjectsDir, p.folder);
    fs.mkdirSync(dir, { recursive: true });

    for (let i = 0; i < p.sessions; i++) {
      let uid = 0;
      const nid = () => `u${i}_${uid++}`;
      const active = p.folder.includes('tokenmeter') && i < 2; // 2 live sessions
      const daysAgo = active ? 0 : ri(0, 18);
      const start = new Date(now - daysAgo * 86400000);
      start.setHours(ri(8, 23), ri(0, 59), 0, 0);
      let t = start.getTime();

      const recs = ri(3, 12);
      const primary = pick(models);
      const spawn = active || rnd() < 0.25; // a quarter of sessions spawn a sub-agent
      const spawnAt = spawn ? ri(1, recs - 1) : -1;
      const objs = [];
      let prev = null;
      let pendingAgent = null; // holds { tuId, agentSubtype, agentModel } when an Agent tool_use needs its result record

      const pu = nid();
      objs.push({ type: 'user', uuid: pu, parentUuid: prev, isSidechain: false, timestamp: new Date(t).toISOString(), message: { content: pick(prompts) } });
      prev = pu;

      for (let r = 0; r < recs; r++) {
        t += ri(20, 240) * 1000;
        const model = rnd() < 0.15 ? pick(models) : primary;
        let content;
        if (r === spawnAt) {
          const agentSubtype = pick(subagents);
          const agentModel = pick(['sonnet', 'opus', 'haiku']);
          const tuId = `tu_${i}_${r}`;
          content = [
            { type: 'text', text: 'Spawning a sub-agent to verify.' },
            { type: 'tool_use', id: tuId, name: 'Agent', input: { subagent_type: agentSubtype, description: 'verify the changes', model: agentModel } },
          ];
          // Remember for the paired toolUseResult user record (emitted right after).
          pendingAgent = { tuId, agentSubtype, agentModel };
        } else if (rnd() < 0.55) {
          content = [{ type: 'tool_use', name: pick(['Edit', 'Read', 'Write', 'Grep', 'Bash']),
                       input: rnd() < 0.5 ? { file_path: pick(files) } : { command: pick(cmds) } }];
        } else {
          content = [{ type: 'text', text: pick(notes) }];
        }
        const au = nid();
        objs.push({ type: 'assistant', uuid: au, parentUuid: prev, isSidechain: false, timestamp: new Date(t).toISOString(), message: { model, usage: usage(), content } });
        prev = au;

        if (content[0].type === 'tool_use' && content[0].name !== 'Agent' && rnd() < 0.5) {
          t += ri(2, 20) * 1000;
          const tu = nid();
          objs.push({ type: 'user', uuid: tu, parentUuid: prev, isSidechain: false, timestamp: new Date(t).toISOString(), message: { content: [{ type: 'tool_result', is_error: rnd() < 0.1, content: [{ type: 'text', text: rnd() < 0.5 ? 'Done' : '8 passing' }] }] } });
          prev = tu;
        }

        if (r === spawnAt && pendingAgent) {
          // Modern Agent format: emit the paired toolUseResult user record.
          const { tuId, agentSubtype, agentModel } = pendingAgent;
          pendingAgent = null;
          t += ri(3, 120) * 1000; // sub-agent duration
          const subUsg = subUsage();
          const subTotal = subUsg.input_tokens + subUsg.output_tokens;
          const tu2 = nid();
          objs.push({
            type: 'user',
            uuid: tu2,
            parentUuid: prev,
            isSidechain: false,
            timestamp: new Date(t).toISOString(),
            message: { content: [{ type: 'tool_result', tool_use_id: tuId, content: [{ type: 'text', text: '✓ all good' }] }] },
            toolUseResult: {
              status: 'completed',
              agentType: agentSubtype,
              content: '✓ all good — verified',
              totalDurationMs: ri(3000, 120000),
              totalTokens: subTotal,
              totalToolUseCount: ri(1, 12),
              usage: subUsg,
            },
          });
          prev = tu2;
        }
      }

      // Most sessions carry a Claude-written summary record (the resume title);
      // the rest exercise the first-prompt fallback in the parser.
      if (rnd() < 0.7) objs.unshift({ type: 'summary', summary: pick(summaries), leafUuid: prev });

      // Shift active sessions so their last activity lands a few minutes ago.
      if (active) {
        const offset = now - t - ri(1, 5) * 60000;
        for (const o of objs) if (o.timestamp) o.timestamp = new Date(new Date(o.timestamp).getTime() + offset).toISOString();
        t += offset;
      }

      const fp = path.join(dir, `sess-${i}-${Math.floor(rnd() * 1e6)}.jsonl`);
      fs.writeFileSync(fp, objs.map(o => JSON.stringify(o)).join('\n') + '\n');
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
