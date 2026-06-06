const fs = require('fs');
const path = require('path');
const { calcClaudeCost, calcCacheSavings } = require('./pricer');

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
const LOOKBACK_DAYS = 90;

function decodeProjectName(folderName) {
  // Claude encodes a project's cwd as the folder name, replacing path separators
  // with "-", e.g. "C--Users-<user>-desktop-projects-burnlink" → "burnlink".
  if (folderName.includes('-desktop-projects-')) {
    const parts = folderName.split('-desktop-projects-');
    return parts[parts.length - 1] || folderName;
  }
  // Bare home directory (drive + Users + a single username segment) → "Home".
  if (/^[A-Za-z]--Users-[^-]+$/.test(folderName)) {
    return 'Home';
  }
  // Otherwise fall back to the deepest path segment as the project name.
  if (/^[A-Za-z]--/.test(folderName)) {
    const segments = folderName.split('-').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last.length > 1) return last;
  }
  return folderName;
}

// Fraction of prompt (non-output) tokens served from cache, as a percentage.
// cacheWriteTokens is deliberately excluded: cache creation is first-time
// ingestion, not a hit/miss of an existing entry. Guards divide-by-zero.
function cacheHitPct(cacheRead, input) {
  const denom = cacheRead + input;
  return denom > 0 ? (cacheRead / denom) * 100 : 0;
}

function parseClaudeJsonl(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) return null;

  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  if (stat.mtimeMs < cutoff) return null;

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const records = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    if (obj.type !== 'assistant') continue;
    const msg = obj.message;
    if (!msg || !msg.usage) continue;

    const usage = msg.usage;
    const model = msg.model || 'unknown';
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : stat.mtimeMs;

    records.push({
      model,
      ts,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheWriteTokens: usage.cache_creation_input_tokens || 0,
    });
  }

  return { records, mtime: stat.mtimeMs };
}

function aggregateClaude(claudeDir) {
  if (!fs.existsSync(claudeDir)) {
    return { available: false };
  }

  const projectDirs = fs.readdirSync(claudeDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const projectMap = new Map(); // project name → aggregated
  const modelMap = new Map();   // model name → aggregated
  const dailyMap = new Map();   // "YYYY-MM-DD" → aggregated
  const allSessions = [];
  const hourlyMap = new Array(24).fill(0);
  const projectDailyMap = new Map();

  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
  let totalCost = 0, totalSessions = 0, totalCacheSavings = 0;

  for (const projectFolder of projectDirs) {
    const projectPath = path.join(claudeDir, projectFolder);
    const jsonlFiles = fs.readdirSync(projectPath)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(projectPath, f));

    const projectName = decodeProjectName(projectFolder);
    let projInput = 0, projOutput = 0, projCacheRead = 0, projCacheWrite = 0;
    let projCost = 0, projSessions = 0;

    for (const filePath of jsonlFiles) {
      let parsed;
      try { parsed = parseClaudeJsonl(filePath); } catch { continue; }
      if (!parsed) continue;

      projSessions++;
      totalSessions++;

      const sessionId = path.basename(filePath, '.jsonl');
      let sessionInput = 0, sessionOutput = 0, sessionCacheRead = 0, sessionCacheWrite = 0;
      let lastModel = 'unknown';
      let sessionStart = Infinity, sessionEnd = 0, recordCount = 0;
      // model → { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, estimatedCostUSD }
      const sessionModelMap = new Map();

      for (const rec of parsed.records) {
        sessionInput += rec.inputTokens;
        sessionOutput += rec.outputTokens;
        sessionCacheRead += rec.cacheReadTokens;
        sessionCacheWrite += rec.cacheWriteTokens;
        lastModel = rec.model;
        recordCount++;
        if (rec.ts < sessionStart) sessionStart = rec.ts;
        if (rec.ts > sessionEnd) sessionEnd = rec.ts;

        const recTokens = rec.inputTokens + rec.outputTokens;
        const recCost = calcClaudeCost(rec.model, rec.inputTokens, rec.outputTokens, rec.cacheReadTokens, rec.cacheWriteTokens);

        // hourly bucketing
        hourlyMap[new Date(rec.ts).getHours()] += recTokens;

        // daily bucketing (local time)
        const dateKey = new Date(rec.ts).toLocaleDateString('en-CA'); // YYYY-MM-DD
        if (!dailyMap.has(dateKey)) {
          dailyMap.set(dateKey, { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUSD: 0, cacheReadTokens: 0 });
        }
        const day = dailyMap.get(dateKey);
        day.inputTokens += rec.inputTokens;
        day.outputTokens += rec.outputTokens;
        day.totalTokens += recTokens;
        day.estimatedCostUSD += recCost;
        day.cacheReadTokens += rec.cacheReadTokens;

        // per-project daily for sparklines
        if (!projectDailyMap.has(projectName)) projectDailyMap.set(projectName, new Map());
        const pdm = projectDailyMap.get(projectName);
        pdm.set(dateKey, (pdm.get(dateKey) || 0) + recTokens);

        // accurate per-record cache savings
        totalCacheSavings += calcCacheSavings(rec.model, rec.cacheReadTokens);

        // model breakdown (global)
        if (!modelMap.has(rec.model)) {
          modelMap.set(rec.model, { inputTokens: 0, outputTokens: 0, estimatedCostUSD: 0 });
        }
        const m = modelMap.get(rec.model);
        m.inputTokens += rec.inputTokens;
        m.outputTokens += rec.outputTokens;
        m.estimatedCostUSD += recCost;

        // model breakdown (within this session)
        if (!sessionModelMap.has(rec.model)) {
          sessionModelMap.set(rec.model, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUSD: 0 });
        }
        const sm = sessionModelMap.get(rec.model);
        sm.inputTokens += rec.inputTokens;
        sm.outputTokens += rec.outputTokens;
        sm.cacheReadTokens += rec.cacheReadTokens;
        sm.cacheWriteTokens += rec.cacheWriteTokens;
        sm.estimatedCostUSD += recCost;
      }

      // Session cost = sum of per-model record costs (accurate even when a
      // session switches models mid-stream, unlike a single whole-session calc).
      let sessionCost = 0;
      for (const sm of sessionModelMap.values()) sessionCost += sm.estimatedCostUSD;

      projInput += sessionInput;
      projOutput += sessionOutput;
      projCacheRead += sessionCacheRead;
      projCacheWrite += sessionCacheWrite;
      projCost += sessionCost;

      allSessions.push({
        id: sessionId,
        project: projectName,
        mtime: parsed.mtime,
        startTime: sessionStart === Infinity ? parsed.mtime : sessionStart,
        endTime: parsed.mtime,
        durationMs: (sessionStart !== Infinity && sessionEnd > sessionStart) ? (sessionEnd - sessionStart) : 0,
        recordCount,
        inputTokens: sessionInput,
        outputTokens: sessionOutput,
        cacheReadTokens: sessionCacheRead,
        cacheWriteTokens: sessionCacheWrite,
        totalTokens: sessionInput + sessionOutput,
        estimatedCostUSD: sessionCost,
        cacheHitPct: cacheHitPct(sessionCacheRead, sessionInput),
        model: lastModel,
        models: Object.fromEntries(sessionModelMap),
      });
    }

    if (projInput + projOutput > 0) {
      if (!projectMap.has(projectName)) {
        projectMap.set(projectName, { name: projectName, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, estimatedCostUSD: 0, sessionCount: 0 });
      }
      const p = projectMap.get(projectName);
      p.inputTokens += projInput;
      p.outputTokens += projOutput;
      p.cacheReadTokens += projCacheRead;
      p.totalTokens += projInput + projOutput;
      p.estimatedCostUSD += projCost;
      p.sessionCount += projSessions;
    }

    totalInput += projInput;
    totalOutput += projOutput;
    totalCacheRead += projCacheRead;
    totalCacheWrite += projCacheWrite;
    totalCost += projCost;
  }

  // Build daily array for last 14 days
  const daily = buildDailyArray(dailyMap, 14);

  // Build heatmap (90 days) and cost projection
  const heatmap = buildDailyArray(dailyMap, 90);
  const last7 = heatmap.slice(-7);
  const avg7Cost = last7.reduce((s, d) => s + d.estimatedCostUSD, 0) / 7;
  const costProjection30d = avg7Cost * 30;

  // Sort projects by total tokens, attach sparklines
  const projectBreakdown = Array.from(projectMap.values())
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map(proj => ({
      ...proj,
      cacheHitPct: cacheHitPct(proj.cacheReadTokens, proj.inputTokens),
      sparkline: buildSparkline(projectDailyMap.get(proj.name) || new Map(), 14),
    }));

  // Full session list (recency-sorted) for the Sessions tab; top 10 for the Claude page.
  const allSessionsByRecency = allSessions.slice().sort((a, b) => b.mtime - a.mtime);
  const sortedSessions = allSessionsByRecency.slice(0, 10);

  const modelBreakdown = {};
  for (const [name, data] of modelMap.entries()) {
    modelBreakdown[name] = data;
  }

  // Check for stats-cache.json
  const statsCachePath = path.join(path.dirname(claudeDir), 'stats-cache.json');
  const dataNote = fs.existsSync(statsCachePath) ? 'stats-cache.json also found' : null;

  return {
    available: true,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
    totalCacheWriteTokens: totalCacheWrite,
    totalTokens: totalInput + totalOutput,
    estimatedCostUSD: totalCost,
    totalSessions,
    globalCacheHitPct: cacheHitPct(totalCacheRead, totalInput),
    modelBreakdown,
    projectBreakdown,
    daily,
    heatmap,
    hourly: hourlyMap,
    cacheSavingsUSD: totalCacheSavings,
    costProjection30d,
    recentSessions: sortedSessions,
    sessions: allSessionsByRecency,
    dataNote,
  };
}

function buildDailyArray(dailyMap, days) {
  const result = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateKey = d.toLocaleDateString('en-CA');
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    const data = dailyMap.get(dateKey) || { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUSD: 0, cacheReadTokens: 0 };
    result.push({ date: dateKey, label, ...data });
  }
  return result;
}

function buildSparkline(projDailyTokens, days) {
  const now = new Date();
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    result.push(projDailyTokens.get(d.toLocaleDateString('en-CA')) || 0);
  }
  return result;
}

module.exports = { aggregateClaude };
