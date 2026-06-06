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

module.exports = { gen };
