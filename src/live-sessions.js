// Detect which Claude Code sessions correspond to a currently-running `claude`
// process. Two sources: per-pid JSON files in <claudeHome>/sessions/ and the
// `claude agents --json` CLI command. Never throws — all paths are defensive.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// Default liveness check: send signal 0 (existence probe).
// EPERM = process exists but not ours = alive; ESRCH = dead.
function defaultIsPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// Default agents runner: shells out to `claude agents --json`.
function defaultRunAgents() {
  try {
    const result = spawnSync('claude', ['agents', '--json'], {
      shell: true,
      timeout: 5000,
      cwd: os.tmpdir(),
      encoding: 'utf8',
    });
    return result.stdout || '';
  } catch (e) {
    return '';
  }
}

/**
 * getLiveSessionIds({ claudeHome, isPidAlive, runAgents })
 *
 * Returns { ids: Set<string>, available: boolean }.
 * - ids: sessionIds of Claude Code sessions whose process is still alive.
 * - available: true if at least one data source (sessions dir or agents CLI)
 *   was reachable, meaning the result is meaningful rather than empty by default.
 */
function getLiveSessionIds({ claudeHome, isPidAlive, runAgents } = {}) {
  const home = claudeHome || path.join(process.env.USERPROFILE || os.homedir(), '.claude');
  const alive = typeof isPidAlive === 'function' ? isPidAlive : defaultIsPidAlive;
  const agents = typeof runAgents === 'function' ? runAgents : defaultRunAgents;

  const ids = new Set();
  let sawSessionsDir = false;

  // ── 1. Read per-pid session files ──────────────────────────────────────────
  try {
    const sessionsDir = path.join(home, 'sessions');
    const entries = fs.readdirSync(sessionsDir); // throws if not found
    sawSessionsDir = true;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(sessionsDir, entry), 'utf8');
        const rec = JSON.parse(raw);
        if (typeof rec.pid === 'number' &&
            typeof rec.sessionId === 'string' && rec.sessionId &&
            alive(rec.pid) === true) {
          ids.add(rec.sessionId);
        }
      } catch (_) {
        // unreadable or malformed — skip silently
      }
    }
  } catch (_) {
    // dir missing or unreadable — not an error
  }

  // ── 2. Query `claude agents --json` ────────────────────────────────────────
  let agentsOk = false;
  try {
    const stdout = agents();
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      agentsOk = true;
      for (const entry of parsed) {
        if (typeof entry.sessionId === 'string' && entry.sessionId) {
          ids.add(entry.sessionId);
        }
      }
    }
  } catch (_) {
    // parse error or bad output — ignore
  }

  const available = sawSessionsDir || agentsOk;
  return { ids, available };
}

module.exports = { getLiveSessionIds };
