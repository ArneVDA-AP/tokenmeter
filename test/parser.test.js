// Headless unit test for src/claude-parser.js — no Electron/display needed.
// Generates fixtures with recent timestamps (clock-independent) in a temp dir,
// runs aggregateClaude, and asserts the Phase 1 additions (granular sessions +
// cache-hit metrics) plus a regression guard on the existing recentSessions shape.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { aggregateClaude } = require('../src/claude-parser');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ── Build fixtures ──────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenmeter-test-'));
const projects = path.join(root, '.claude', 'projects');

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const asst = (model, ts, input, output, cacheRead, cacheWrite) => JSON.stringify({
  type: 'assistant',
  timestamp: iso(ts),
  message: { model, usage: {
    input_tokens: input, output_tokens: output,
    cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
  } },
});

function writeSession(folder, file, lines) {
  const dir = path.join(projects, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), lines.join('\n') + '\n');
}

const t1 = now - 7200000; // -2h
const t2 = now - 3600000; // -1h

// Demo project, session 1: two models, plus a non-assistant line and a malformed line.
writeSession('C--Users-dev-desktop-projects-demo', 'sess1.jsonl', [
  asst('claude-sonnet-4-20250101', t1, 100, 50, 300, 20),
  asst('claude-opus-4-20250101', t2, 200, 80, 100, 0),
  JSON.stringify({ type: 'user', message: { content: 'hi' } }), // skipped (not assistant)
  '{ this is not valid json',                                    // skipped (parse error)
]);

// Demo project, session 2: all-zero usage → exercises divide-by-zero in cacheHitPct.
writeSession('C--Users-dev-desktop-projects-demo', 'sess2.jsonl', [
  asst('claude-haiku-4-20250101', now - 1800000, 0, 0, 0, 0),
]);

// Bare home directory → decodeProjectName should yield "Home".
writeSession('C--Users-dev', 'sess3.jsonl', [
  asst('claude-sonnet-4-20250101', now - 900000, 50, 25, 50, 0),
]);

// Session 4: a main chain that spawns a "verifier" sub-agent (Task tool_use),
// followed by sidechain records → exercises sub-agent grouping + agent naming.
const u = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
writeSession('C--Users-dev-desktop-projects-demo', 'sess4.jsonl', [
  JSON.stringify({ type: 'summary', summary: 'Refactor the parser end-to-end', leafUuid: 's2' }),
  JSON.stringify({ type: 'user', uuid: 'm1', parentUuid: null, isSidechain: false, timestamp: iso(now - 600000), message: { content: 'refactor the parser' } }),
  JSON.stringify({ type: 'assistant', uuid: 'm2', parentUuid: 'm1', isSidechain: false, timestamp: iso(now - 590000), message: { model: 'claude-opus-4-20250101', usage: u(100, 60, 200, 30), content: [{ type: 'tool_use', name: 'Task', input: { subagent_type: 'verifier', description: 'verify changes' } }] } }),
  JSON.stringify({ type: 'user', uuid: 's1', parentUuid: 'm2', isSidechain: true, timestamp: iso(now - 580000), message: { content: 'verify the refactor' } }),
  JSON.stringify({ type: 'assistant', uuid: 's2', parentUuid: 's1', isSidechain: true, timestamp: iso(now - 570000), message: { model: 'claude-sonnet-4-20250101', usage: u(40, 20, 60, 0), content: [{ type: 'text', text: 'All good' }] } }),
]);

// ── Run ─────────────────────────────────────────────────────────────────────
const r = aggregateClaude(projects);

// ── Assertions ────────────────────────────────────────────────────────────────
check('available', () => assert.strictEqual(r.available, true));

check('totalSessions === 4', () => assert.strictEqual(r.totalSessions, 4));
check('sessions.length === 4 (roots only)', () => assert.strictEqual(r.sessions.length, 4));

check('every session has the new granular fields', () => {
  for (const s of r.sessions) {
    for (const f of ['id', 'project', 'startTime', 'endTime', 'durationMs',
      'recordCount', 'cacheReadTokens', 'cacheWriteTokens', 'estimatedCostUSD',
      'cacheHitPct', 'models']) {
      assert.ok(f in s, `session missing field ${f} (id=${s.id})`);
    }
  }
});

check('recentSessions: <=10 and keeps original 6 fields (regression guard)', () => {
  assert.ok(r.recentSessions.length <= 10);
  const s = r.recentSessions[0];
  for (const f of ['project', 'mtime', 'inputTokens', 'outputTokens', 'model', 'totalTokens']) {
    assert.ok(f in s, `recentSession missing legacy field ${f}`);
  }
});

check('decodeProjectName: "Home" + "demo" present', () => {
  const names = new Set(r.sessions.map(s => s.project));
  assert.ok(names.has('Home'), 'expected a "Home" project');
  assert.ok(names.has('demo'), 'expected a "demo" project');
});

check('sess1: tokens, recordCount, duration, models reconcile', () => {
  const s = r.sessions.find(x => x.id === 'sess1');
  assert.strictEqual(s.inputTokens, 300);
  assert.strictEqual(s.outputTokens, 130);
  assert.strictEqual(s.cacheReadTokens, 400);
  assert.strictEqual(s.cacheWriteTokens, 20);
  assert.strictEqual(s.recordCount, 2);
  assert.strictEqual(s.durationMs, t2 - t1);
  assert.strictEqual(Object.keys(s.models).length, 2);
  // cacheHitPct = read / (read + input + write) = 400 / (400 + 300 + 20)
  assert.ok(approx(s.cacheHitPct, 400 / 720 * 100), `got ${s.cacheHitPct}`);
});

check('sess2: zero usage → cacheHitPct === 0 (no NaN)', () => {
  const s = r.sessions.find(x => x.id === 'sess2');
  assert.strictEqual(s.cacheHitPct, 0);
});

check('globalCacheHitPct = 710/(710+490+50)*100 (writes in denom)', () => {
  assert.ok(approx(r.globalCacheHitPct, 710 / 1250 * 100), `got ${r.globalCacheHitPct}`);
});

check('projectBreakdown carries finite cacheHitPct (writes in denom)', () => {
  const demo = r.projectBreakdown.find(p => p.name === 'demo');
  assert.ok(Number.isFinite(demo.cacheHitPct));
  assert.ok(approx(demo.cacheHitPct, 660 / 1150 * 100), `got ${demo.cacheHitPct}`);
});

check('daily entries carry cacheReadTokens (incl. empty days)', () => {
  assert.ok(r.daily.every(d => typeof d.cacheReadTokens === 'number'));
  const totalDailyCacheRead = r.daily.reduce((s, d) => s + d.cacheReadTokens, 0);
  assert.strictEqual(totalDailyCacheRead, 710); // all records (incl. sidechain) in window
});

check('session cost = sum of its per-model costs', () => {
  const s = r.sessions.find(x => x.id === 'sess1');
  const modelSum = Object.values(s.models).reduce((a, m) => a + m.estimatedCostUSD, 0);
  assert.ok(approx(s.estimatedCostUSD, modelSum), `${s.estimatedCostUSD} vs ${modelSum}`);
});

check('single-record session has durationMs 0', () => {
  const s = r.sessions.find(x => x.id === 'sess2'); // one record
  assert.strictEqual(s.recordCount, 1);
  assert.strictEqual(s.durationMs, 0);
});

check('sessions returned sorted by recency (mtime desc)', () => {
  for (let i = 1; i < r.sessions.length; i++) {
    assert.ok(r.sessions[i - 1].mtime >= r.sessions[i].mtime, 'not sorted at index ' + i);
  }
});

check('each session id is the .jsonl filename (no extension)', () => {
  assert.ok(r.sessions.every(s => s.id && !s.id.endsWith('.jsonl')));
});

check('sess4 spawns one child agent named "verifier"', () => {
  const s = r.sessions.find(x => x.id === 'sess4');
  assert.ok(Array.isArray(s.childSessions) && s.childSessions.length === 1, `children=${s.childSessions?.length}`);
  const child = s.childSessions[0];
  assert.strictEqual(child.agents[0], 'verifier');
  assert.strictEqual(child.parent, 'sess4');
  assert.strictEqual(child.id, 'sess4~a1');
});

check('child agent tokens are split out from the parent (main chain only)', () => {
  const s = r.sessions.find(x => x.id === 'sess4');
  // Root counts only main-chain usage (m2): input 100, output 60.
  assert.strictEqual(s.inputTokens, 100);
  assert.strictEqual(s.outputTokens, 60);
  // Child counts only its sidechain usage (s2): input 40, output 20, read 60.
  const child = s.childSessions[0];
  assert.strictEqual(child.inputTokens, 40);
  assert.strictEqual(child.outputTokens, 20);
  assert.ok(approx(child.cacheHitPct, 60 / 100 * 100), `got ${child.cacheHitPct}`);
});

check('every session carries a preview ending in a cost summary', () => {
  for (const s of r.sessions) {
    assert.ok(Array.isArray(s.preview) && s.preview.length >= 1, `no preview for ${s.id}`);
    assert.strictEqual(s.preview[s.preview.length - 1].type, 'cost');
  }
});

check('sess4 preview surfaces the spawned Task as an agent line', () => {
  const s = r.sessions.find(x => x.id === 'sess4');
  assert.ok(s.preview.some(l => l.type === 'agent'), 'expected an agent-typed preview line');
});

check('sess4 surfaces the Claude-written summary record', () => {
  const s = r.sessions.find(x => x.id === 'sess4');
  assert.strictEqual(s.summary, 'Refactor the parser end-to-end');
});

check('sess1 falls back to first user prompt as summary (no summary record)', () => {
  const s = r.sessions.find(x => x.id === 'sess1');
  assert.strictEqual(s.summary, 'hi');
});

check('workspaces map projects to ids, sessions carry workspace', () => {
  assert.ok(Array.isArray(r.workspaces) && r.workspaces.length > 0);
  assert.ok(r.workspaces.every(w => typeof w.id === 'number' && w.name && w.icon));
  assert.ok(r.sessions.every(s => typeof s.workspace === 'number'));
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
fs.rmSync(root, { recursive: true, force: true });

console.log(failures === 0 ? '\nAll parser tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
