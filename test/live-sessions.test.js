// Headless unit tests for src/live-sessions.js — no Electron/display needed.
// Mirrors the style of test/parser.test.js: check() helper, tally failures,
// exit with 1 if any fail.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { getLiveSessionIds } = require('../src/live-sessions');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

// ── Temp dir setup ──────────────────────────────────────────────────────────
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenmeter-live-'));
const claudeHome = path.join(tmpBase, 'claude-home');
const sessionsDir = path.join(claudeHome, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

// live.json — pid alive
fs.writeFileSync(path.join(sessionsDir, 'live.json'),
  JSON.stringify({ pid: 1111, sessionId: 'sess-live', cwd: '/tmp', startedAt: 0, kind: 'interactive' }));

// dead.json — pid not alive
fs.writeFileSync(path.join(sessionsDir, 'dead.json'),
  JSON.stringify({ pid: 2222, sessionId: 'sess-dead', cwd: '/tmp', startedAt: 0, kind: 'interactive' }));

// junk.json — malformed JSON
fs.writeFileSync(path.join(sessionsDir, 'junk.json'), '{ not valid json');

// ── Test A ──────────────────────────────────────────────────────────────────
// Sessions dir exists; pid 1111 = alive, 2222 = dead. Agent adds sess-agent.
let resultA;
check('A: does not throw', () => {
  resultA = getLiveSessionIds({
    claudeHome,
    isPidAlive: (pid) => pid === 1111,
    runAgents: () => JSON.stringify([{ pid: 3333, sessionId: 'sess-agent' }]),
  });
});

check('A: ids.has("sess-live") true', () => {
  assert.strictEqual(resultA.ids.has('sess-live'), true);
});

check('A: ids.has("sess-dead") false', () => {
  assert.strictEqual(resultA.ids.has('sess-dead'), false);
});

check('A: ids.has("sess-agent") true (from agents JSON)', () => {
  assert.strictEqual(resultA.ids.has('sess-agent'), true);
});

check('A: malformed junk.json ignored (no throw, no phantom id)', () => {
  // The malformed file must not add anything to ids.
  // We can confirm by checking ids does NOT contain undefined or garbage.
  assert.ok(!resultA.ids.has(undefined));
  assert.ok(!resultA.ids.has(''));
});

check('A: available === true (sessions dir found)', () => {
  assert.strictEqual(resultA.available, true);
});

// ── Test B ──────────────────────────────────────────────────────────────────
// Non-existent claudeHome; runAgents returns empty string → available === false.
let resultB;
check('B: does not throw with non-existent claudeHome', () => {
  resultB = getLiveSessionIds({
    claudeHome: path.join(tmpBase, 'no-such-dir'),
    isPidAlive: () => true,
    runAgents: () => '',
  });
});

check('B: ids.size === 0', () => {
  assert.strictEqual(resultB.ids.size, 0);
});

check('B: available === false', () => {
  assert.strictEqual(resultB.available, false);
});

// ── Test C ──────────────────────────────────────────────────────────────────
// runAgents returns invalid JSON; sessions dir also missing → available false.
let resultC;
check('C: invalid agents JSON + missing dir does not throw', () => {
  resultC = getLiveSessionIds({
    claudeHome: path.join(tmpBase, 'also-missing'),
    isPidAlive: () => true,
    runAgents: () => 'oops',
  });
});

check('C: available === false', () => {
  assert.strictEqual(resultC.available, false);
});

check('C: ids.size === 0', () => {
  assert.strictEqual(resultC.ids.size, 0);
});

// ── Cleanup ─────────────────────────────────────────────────────────────────
fs.rmSync(tmpBase, { recursive: true, force: true });

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\nlive-sessions tests: ${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
