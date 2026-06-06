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

// ── Run ─────────────────────────────────────────────────────────────────────
const r = aggregateClaude(projects);

// ── Assertions ────────────────────────────────────────────────────────────────
check('available', () => assert.strictEqual(r.available, true));

check('totalSessions === 3', () => assert.strictEqual(r.totalSessions, 3));
check('sessions.length === 3', () => assert.strictEqual(r.sessions.length, 3));

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
  // cacheHitPct = 400 / (400 + 300) * 100
  assert.ok(approx(s.cacheHitPct, 400 / 700 * 100), `got ${s.cacheHitPct}`);
});

check('sess2: zero usage → cacheHitPct === 0 (no NaN)', () => {
  const s = r.sessions.find(x => x.id === 'sess2');
  assert.strictEqual(s.cacheHitPct, 0);
});

check('globalCacheHitPct = 450/(450+350)*100 = 56.25', () => {
  assert.ok(approx(r.globalCacheHitPct, 56.25), `got ${r.globalCacheHitPct}`);
});

check('projectBreakdown carries finite cacheHitPct', () => {
  const demo = r.projectBreakdown.find(p => p.name === 'demo');
  assert.ok(Number.isFinite(demo.cacheHitPct));
  assert.ok(approx(demo.cacheHitPct, 400 / 700 * 100), `got ${demo.cacheHitPct}`);
});

check('daily entries carry cacheReadTokens (incl. empty days)', () => {
  assert.ok(r.daily.every(d => typeof d.cacheReadTokens === 'number'));
  const totalDailyCacheRead = r.daily.reduce((s, d) => s + d.cacheReadTokens, 0);
  assert.strictEqual(totalDailyCacheRead, 450); // all records fall in the 14-day window
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
fs.rmSync(root, { recursive: true, force: true });

console.log(failures === 0 ? '\nAll parser tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
