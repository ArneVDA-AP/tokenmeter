// Headless unit test for src/claude-parser.js — no Electron/display needed.
// Generates fixtures with recent timestamps (clock-independent) in a temp dir,
// runs aggregateClaude, and asserts the Phase 1 additions (granular sessions +
// cache-hit metrics) plus a regression guard on the existing recentSessions shape.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { aggregateClaude, SUMMARY_MARKER } = require('../src/claude-parser');

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

// Session 5: MODERN Agent format — assistant block with Agent tool_use, followed by
// a user record with tool_result + top-level toolUseResult.
// Agent usage: input=80, output=40, cacheRead=120, cacheWrite=10.
const agentUsage5 = { input_tokens: 80, output_tokens: 40, cache_read_input_tokens: 120, cache_creation_input_tokens: 10 };
writeSession('C--Users-dev-desktop-projects-demo', 'sess5.jsonl', [
  JSON.stringify({ type: 'summary', summary: 'Modern agent test session', leafUuid: 'ms2' }),
  JSON.stringify({ type: 'user', uuid: 'ms0', parentUuid: null, isSidechain: false, timestamp: iso(now - 500000), message: { content: 'run the modern agent' } }),
  JSON.stringify({ type: 'assistant', uuid: 'ms1', parentUuid: 'ms0', isSidechain: false, timestamp: iso(now - 490000), message: { model: 'claude-opus-4-20250101', usage: { input_tokens: 150, output_tokens: 70, cache_read_input_tokens: 200, cache_creation_input_tokens: 15 }, content: [{ type: 'tool_use', id: 'tu_agent_1', name: 'Agent', input: { subagent_type: 'verifier', description: 'verify modern changes', model: 'sonnet' } }] } }),
  JSON.stringify({ type: 'user', uuid: 'ms2', parentUuid: 'ms1', isSidechain: false, timestamp: iso(now - 480000), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_agent_1', content: [{ type: 'text', text: '✓ all good' }] }] }, toolUseResult: { status: 'completed', agentType: 'verifier', content: '✓ all good — verified', totalDurationMs: 45000, totalTokens: agentUsage5.input_tokens + agentUsage5.output_tokens, totalToolUseCount: 3, usage: agentUsage5 } }),
]);

// Session 4: back-compat SIDECHAIN format (old isSidechain:true records) — verifies
// the parser still falls back to groupSidechains when no Agent tool_use exists.
const u = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
writeSession('C--Users-dev-desktop-projects-demo', 'sess4.jsonl', [
  JSON.stringify({ type: 'summary', summary: 'Refactor the parser end-to-end', leafUuid: 's2' }),
  JSON.stringify({ type: 'user', uuid: 'm1', parentUuid: null, isSidechain: false, timestamp: iso(now - 600000), message: { content: 'refactor the parser' } }),
  JSON.stringify({ type: 'assistant', uuid: 'm2', parentUuid: 'm1', isSidechain: false, timestamp: iso(now - 590000), message: { model: 'claude-opus-4-20250101', usage: u(100, 60, 200, 30), content: [{ type: 'tool_use', name: 'Task', input: { subagent_type: 'verifier', description: 'verify changes' } }] } }),
  JSON.stringify({ type: 'user', uuid: 's1', parentUuid: 'm2', isSidechain: true, timestamp: iso(now - 580000), message: { content: 'verify the refactor' } }),
  JSON.stringify({ type: 'assistant', uuid: 's2', parentUuid: 's1', isSidechain: true, timestamp: iso(now - 570000), message: { model: 'claude-sonnet-4-20250101', usage: u(40, 20, 60, 0), content: [{ type: 'text', text: 'All good' }] } }),
]);

// Tokenmeter's own `claude -p` summary run — must be excluded from the meter.
writeSession('C--Users-dev-desktop-projects-demo', 'meta.jsonl', [
  JSON.stringify({ type: 'user', timestamp: iso(now - 100000), message: { content: `${SUMMARY_MARKER}\nSummarize this session in one line.` } }),
  asst('claude-haiku-4-20250101', now - 90000, 10, 5, 0, 0),
]);

// ── Run ─────────────────────────────────────────────────────────────────────
const r = aggregateClaude(projects);

// ── Assertions ────────────────────────────────────────────────────────────────
check('available', () => assert.strictEqual(r.available, true));

// 5 sessions: sess1, sess2, sess3, sess4, sess5 (meta excluded)
check('totalSessions === 5', () => assert.strictEqual(r.totalSessions, 5));
check('sessions.length === 5 (roots only)', () => assert.strictEqual(r.sessions.length, 5));

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

check('daily entries carry cacheReadTokens (incl. empty days)', () => {
  assert.ok(r.daily.every(d => typeof d.cacheReadTokens === 'number'));
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

// ── Modern Agent format (sess5) ───────────────────────────────────────────────
check('sess5: modern Agent tool_use spawns one isAgent child', () => {
  const s = r.sessions.find(x => x.id === 'sess5');
  assert.ok(s, 'sess5 not found');
  assert.ok(Array.isArray(s.childSessions) && s.childSessions.length === 1,
    `expected 1 child, got ${s.childSessions?.length}`);
  const child = s.childSessions[0];
  assert.strictEqual(child.isAgent, true, 'child.isAgent should be true');
  assert.ok(child.category && typeof child.category === 'string', 'child missing category');
  assert.ok(child.status && typeof child.status === 'string', 'child missing status');
  assert.ok(typeof child.model === 'string' && child.model.length > 0, 'child missing model');
  assert.ok(typeof child.totalTokens === 'number', 'child.totalTokens not a number');
  assert.ok(typeof child.estimatedCostUSD === 'number', 'child.estimatedCostUSD not a number');
  assert.ok(Array.isArray(child.agents) && child.agents[0], 'child missing agents[0] name');
  assert.strictEqual(child.parent, 'sess5', 'child.parent should be sess5');
  assert.strictEqual(child.id, 'sess5~a1', 'child.id should be sess5~a1');
});

check('sess5: child has correct token counts from toolUseResult.usage', () => {
  const s = r.sessions.find(x => x.id === 'sess5');
  const child = s.childSessions[0];
  assert.strictEqual(child.inputTokens, 80);
  assert.strictEqual(child.outputTokens, 40);
  assert.strictEqual(child.cacheReadTokens, 120);
  assert.strictEqual(child.cacheWriteTokens, 10);
  assert.strictEqual(child.totalTokens, 120);
  // cacheHitPct = 120 / (120 + 80 + 10) = 120/210
  assert.ok(approx(child.cacheHitPct, 120 / 210 * 100), `got ${child.cacheHitPct}`);
});

check('sess5: child category=verifier, status=completed', () => {
  const s = r.sessions.find(x => x.id === 'sess5');
  const child = s.childSessions[0];
  assert.strictEqual(child.category, 'verifier');
  assert.strictEqual(child.status, 'completed');
});

check('sess5: child preview ends with cost line', () => {
  const s = r.sessions.find(x => x.id === 'sess5');
  const child = s.childSessions[0];
  assert.ok(Array.isArray(child.preview) && child.preview.length >= 1);
  assert.strictEqual(child.preview[child.preview.length - 1].type, 'cost');
});

check('sess5: child summarySource === "agent"', () => {
  const s = r.sessions.find(x => x.id === 'sess5');
  const child = s.childSessions[0];
  assert.strictEqual(child.summarySource, 'agent');
});

check('sess5: child has workspace set (same as parent)', () => {
  const s = r.sessions.find(x => x.id === 'sess5');
  const child = s.childSessions[0];
  assert.ok(typeof child.workspace === 'number', 'child.workspace should be a number');
  assert.strictEqual(child.workspace, s.workspace);
});

// ── Back-compat sidechain fallback (sess4) ────────────────────────────────────
check('sess4: back-compat sidechain → child via groupSidechains fallback', () => {
  const s = r.sessions.find(x => x.id === 'sess4');
  assert.ok(s, 'sess4 not found');
  assert.ok(Array.isArray(s.childSessions) && s.childSessions.length === 1,
    `expected 1 child via sidechain fallback, got ${s.childSessions?.length}`);
  const child = s.childSessions[0];
  assert.strictEqual(child.parent, 'sess4');
  assert.strictEqual(child.id, 'sess4~a1');
});

check('sess4: sidechain child NOT marked isAgent (legacy path)', () => {
  const s = r.sessions.find(x => x.id === 'sess4');
  const child = s.childSessions[0];
  // Legacy sidechain children use makeSession, which doesn't set isAgent.
  assert.ok(!child.isAgent, 'legacy sidechain child should not have isAgent=true');
});

check('sess4: child agent tokens are split out from the parent (main chain only)', () => {
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

check('sess4 surfaces the Claude-written summary record', () => {
  const s = r.sessions.find(x => x.id === 'sess4');
  assert.strictEqual(s.summary, 'Refactor the parser end-to-end');
});

check('sess4 preview surfaces the spawned Task as an agent line', () => {
  const s = r.sessions.find(x => x.id === 'sess4');
  assert.ok(s.preview.some(l => l.type === 'agent'), 'expected an agent-typed preview line');
});

check('sess1 falls back to first user prompt as summary (no summary record)', () => {
  const s = r.sessions.find(x => x.id === 'sess1');
  assert.strictEqual(s.summary, 'hi');
});

// ── agentBreakdown & headline agent numbers ───────────────────────────────────
check('agentBreakdown is a non-empty array', () => {
  assert.ok(Array.isArray(r.agentBreakdown) && r.agentBreakdown.length > 0,
    `expected agentBreakdown to be non-empty, got ${JSON.stringify(r.agentBreakdown)}`);
});

check('agentBreakdown entries have required fields', () => {
  for (const entry of r.agentBreakdown) {
    assert.ok(typeof entry.category === 'string' && entry.category.length > 0, 'missing category');
    assert.ok(typeof entry.count === 'number' && entry.count >= 1, 'count < 1');
    assert.ok(typeof entry.totalTokens === 'number' && entry.totalTokens >= 0, 'totalTokens invalid');
    assert.ok(typeof entry.estimatedCostUSD === 'number' && entry.estimatedCostUSD >= 0, 'estimatedCostUSD invalid');
    assert.ok(typeof entry.topModel === 'string' && entry.topModel.length > 0, 'topModel missing');
  }
});

check('agentBreakdown sorted by totalTokens desc', () => {
  for (let i = 1; i < r.agentBreakdown.length; i++) {
    assert.ok(r.agentBreakdown[i - 1].totalTokens >= r.agentBreakdown[i].totalTokens,
      `not sorted at index ${i}`);
  }
});

check('totalAgentTokens > 0', () => {
  assert.ok(typeof r.totalAgentTokens === 'number' && r.totalAgentTokens > 0,
    `totalAgentTokens=${r.totalAgentTokens}`);
});

check('totalAgentInvocations matches sum of childSessions across all sessions', () => {
  const expected = r.sessions.reduce((sum, s) => sum + (s.childSessions ? s.childSessions.length : 0), 0);
  assert.strictEqual(r.totalAgentInvocations, expected,
    `totalAgentInvocations=${r.totalAgentInvocations} expected=${expected}`);
});

check('totalAgentTokens matches sum of child totalTokens', () => {
  const expected = r.sessions.reduce((sum, s) => {
    return sum + (s.childSessions || []).reduce((cs, c) => cs + c.totalTokens, 0);
  }, 0);
  assert.strictEqual(r.totalAgentTokens, expected,
    `totalAgentTokens=${r.totalAgentTokens} expected=${expected}`);
});

check('global totalTokens includes child tokens (main-chain + agents)', () => {
  // Main-chain tokens only (from parsed.records usage fields).
  // sess1: 300+130=430, sess2: 0, sess3: 75, sess4 main: 100+60=160
  // sess5 main: 150+70=220
  // Sidechain child of sess4 (via sidechain records, NOT counted in parsed.records for main):
  //   but wait — sidechain records ARE in parsed.records (isSidechain doesn't exclude them
  //   from the records array). Let's just assert r.totalTokens >= main + agents.
  const childTok = r.sessions.reduce((sum, s) =>
    sum + (s.childSessions || []).reduce((cs, c) => cs + c.totalTokens, 0), 0);
  assert.ok(r.totalTokens >= childTok, `totalTokens ${r.totalTokens} should include ${childTok} child tokens`);
  assert.ok(r.totalAgentTokens === childTok, `totalAgentTokens ${r.totalAgentTokens} !== childTok ${childTok}`);
});

// ── Misc regressions ──────────────────────────────────────────────────────────
check('every session carries a preview ending in a cost summary', () => {
  for (const s of r.sessions) {
    assert.ok(Array.isArray(s.preview) && s.preview.length >= 1, `no preview for ${s.id}`);
    assert.strictEqual(s.preview[s.preview.length - 1].type, 'cost');
  }
});

check('tokenmeter summary-gen sessions are excluded from the meter', () => {
  assert.strictEqual(r.sessions.find(x => x.id === 'meta'), undefined, 'marker session leaked in');
  assert.strictEqual(r.totalSessions, 5, 'marker session counted in totals');
});

check('workspaces map projects to ids, sessions carry workspace', () => {
  assert.ok(Array.isArray(r.workspaces) && r.workspaces.length > 0);
  assert.ok(r.workspaces.every(w => typeof w.id === 'number' && w.name && w.icon));
  assert.ok(r.sessions.every(s => typeof s.workspace === 'number'));
});

check('projectBreakdown carries finite cacheHitPct', () => {
  const demo = r.projectBreakdown.find(p => p.name === 'demo');
  assert.ok(Number.isFinite(demo.cacheHitPct));
});

// ── pricer: bidirectional alias matching ──────────────────────────────────────
const { getClaudePrice, calcClaudeCost } = require('../src/pricer');

check('pricer: short alias "sonnet" resolves to claude-sonnet-4 pricing', () => {
  const price = getClaudePrice('sonnet');
  assert.ok(price && price.pattern !== 'default', `expected sonnet to match a specific entry, got pattern=${price?.pattern}`);
  assert.strictEqual(price.input, 3.00, `expected input=3.00, got ${price.input}`);
});

check('pricer: short alias "opus" resolves to claude-opus-4 pricing', () => {
  const price = getClaudePrice('opus');
  assert.ok(price && price.pattern !== 'default', `expected opus to match a specific entry`);
  assert.strictEqual(price.input, 15.00, `expected input=15.00, got ${price.input}`);
});

check('pricer: short alias "haiku" resolves to claude-haiku-4 pricing', () => {
  const price = getClaudePrice('haiku');
  assert.ok(price && price.pattern !== 'default', `expected haiku to match a specific entry`);
  assert.strictEqual(price.input, 0.80, `expected input=0.80, got ${price.input}`);
});

check('pricer: full id "claude-sonnet-4-20250514" still matches claude-sonnet-4 (longest wins)', () => {
  const price = getClaudePrice('claude-sonnet-4-20250514');
  assert.ok(price, 'no price returned');
  assert.strictEqual(price.input, 3.00, `expected input=3.00, got ${price.input}`);
});

check('pricer: calcClaudeCost with alias model is non-negative', () => {
  const cost = calcClaudeCost('sonnet', 1000, 500, 200, 50);
  assert.ok(cost >= 0, `expected non-negative cost, got ${cost}`);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
fs.rmSync(root, { recursive: true, force: true });

console.log(failures === 0 ? '\nAll parser tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
