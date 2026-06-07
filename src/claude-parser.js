const fs = require('fs');
const path = require('path');
const { calcClaudeCost, calcCacheSavings } = require('./pricer');

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
const LOOKBACK_DAYS = 90;
const MAX_PREVIEW_LINES = 8;
const WS_ICONS = ['◆', '◇', '◈', '⌂', '⚙', '▣', '◉', '✦', '❖', '⬡'];
// Marker prefixing Tokenmeter's own `claude -p` summary prompts, so those
// throwaway sessions are excluded from the meter (they'd otherwise show up as
// tiny sessions and inflate totals).
const SUMMARY_MARKER = '[[tokenmeter-summary]]';

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

// Cache hit %: reads / (reads + writes + input). Cache *writes* are first-time
// cache misses (the context being ingested and stored) and plain input is
// uncached, so both belong in the denominator. Counting only reads+input pins
// the metric at ~100% in real logs, because once a session's context is cached
// Claude reports a near-zero input_tokens per turn. Guards divide-by-zero.
function cacheHitPct(cacheRead, input, cacheWrite) {
  const denom = cacheRead + input + (cacheWrite || 0);
  return denom > 0 ? (cacheRead / denom) * 100 : 0;
}

// ── Preview helpers (turn raw JSONL content into terminal-style lines) ────────
function firstLine(s) {
  if (!s || typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t || t.startsWith('<')) return ''; // skip system-reminder / command meta
  return t.length > 72 ? t.slice(0, 71) + '…' : t;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b && b.type === 'text').map(b => b.text).join(' ');
  }
  return '';
}

function toolLine(block) {
  const name = block.name || 'tool';
  const a = block.input || {};
  const arg = a.file_path || a.path || a.command || a.pattern || a.query ||
              a.url || a.description || '';
  const shortArg = firstLine(typeof arg === 'string' ? arg : '');
  return `⚡ ${name}${shortArg ? ' ' + shortArg : ''}`;
}

function fmtTok(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// Collapse whitespace and clamp to a short single-string summary.
function clamp(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// First real user prompt in a record list — the task the session was about.
// Used as a summary fallback when the file has no Claude-written summary record.
function firstPromptText(recs) {
  for (const r of recs) {
    if (r.type !== 'user') continue;
    const c = r.content;
    let t = '';
    if (typeof c === 'string') t = c;
    else if (Array.isArray(c)) { const tb = c.find(b => b && b.type === 'text'); if (tb) t = tb.text; }
    t = (t || '').replace(/\s+/g, ' ').trim();
    if (t && !t.startsWith('<')) return clamp(t, 160);
  }
  return '';
}

// Build up to MAX_PREVIEW_LINES terminal-style lines from a record list,
// keeping the most recent activity and ending with a synthesized cost summary.
function buildPreview(recs, sum) {
  const lines = [];
  for (const r of recs) {
    const c = r.content;
    if (r.type === 'user') {
      if (typeof c === 'string') {
        const t = firstLine(c);
        if (t) lines.push({ type: 'prompt', text: '> ' + t });
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (!b) continue;
          if (b.type === 'text' && b.text) {
            const t = firstLine(b.text);
            if (t) lines.push({ type: 'prompt', text: '> ' + t });
          } else if (b.type === 'tool_result') {
            const t = firstLine(toolResultText(b.content));
            if (t) lines.push({ type: b.is_error ? 'error' : 'ok', text: (b.is_error ? '✗ ' : '✓ ') + t });
          }
        }
      }
    } else if (r.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (!b) continue;
        if (b.type === 'text' && b.text) {
          const t = firstLine(b.text);
          if (t) lines.push({ type: 'output', text: t });
        } else if (b.type === 'tool_use') {
          lines.push({ type: b.name === 'Task' ? 'agent' : 'tool', text: toolLine(b) });
        }
      }
    }
  }
  const kept = lines.slice(-(MAX_PREVIEW_LINES - 1));
  kept.push({
    type: 'cost',
    text: `↳ ${fmtTok(sum.input + sum.output)} tok · $${sum.cost.toFixed(2)} · cache ${Math.round(cacheHitPct(sum.cacheRead, sum.input, sum.cacheWrite))}%`,
  });
  return kept;
}

function parseClaudeJsonl(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) return null;

  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  if (stat.mtimeMs < cutoff) return null;

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const records = [];
  const summaries = []; // Claude-written session summaries (the resume-picker titles)

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    const type = obj.type;
    // Claude Code writes {type:"summary",summary,leafUuid} records when it titles
    // or compacts a session — a ready-made short summary we can surface for free.
    if (type === 'summary') {
      if (obj.summary) summaries.push({ summary: String(obj.summary), leafUuid: obj.leafUuid || null });
      continue;
    }
    if (type !== 'assistant' && type !== 'user') continue;
    const msg = obj.message;
    if (!msg) continue;

    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : stat.mtimeMs;
    // Skip our own summary-generation sessions entirely.
    if (type === 'user') {
      const c = msg.content;
      const txt = typeof c === 'string' ? c
        : (Array.isArray(c) ? (c.find(b => b && b.type === 'text')?.text || '') : '');
      if (typeof txt === 'string' && txt.startsWith(SUMMARY_MARKER)) return null;
    }
    records.push({
      type,
      ts,
      uuid: obj.uuid || null,
      parentUuid: obj.parentUuid || null,
      isSidechain: !!obj.isSidechain,
      model: msg.model || null,
      usage: (type === 'assistant' && msg.usage) ? msg.usage : null,
      content: msg.content,
      toolUseResult: obj.toolUseResult || null,
    });
  }

  return { records, mtime: stat.mtimeMs, summaries };
}

// Reduce a list of records to token/cost/model/duration totals.
function summarize(recs) {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
  let start = Infinity, end = 0, assistantCount = 0, lastModel = 'unknown';
  const modelMap = new Map();
  for (const r of recs) {
    if (!r.usage) continue;
    // Duration spans usage (assistant) records only; these always carry a real
    // timestamp, unlike some noise records that fall back to the file mtime.
    if (r.ts < start) start = r.ts;
    if (r.ts > end) end = r.ts;
    assistantCount++;
    const u = r.usage;
    const i = u.input_tokens || 0, o = u.output_tokens || 0;
    const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
    input += i; output += o; cacheRead += cr; cacheWrite += cw;
    const model = r.model || 'unknown';
    lastModel = model;
    if (!modelMap.has(model)) {
      modelMap.set(model, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUSD: 0 });
    }
    const m = modelMap.get(model);
    m.inputTokens += i; m.outputTokens += o;
    m.cacheReadTokens += cr; m.cacheWriteTokens += cw;
    m.estimatedCostUSD += calcClaudeCost(model, i, o, cr, cw);
  }
  let cost = 0;
  for (const m of modelMap.values()) cost += m.estimatedCostUSD;
  return { input, output, cacheRead, cacheWrite, start, end, assistantCount, lastModel, modelMap, cost };
}

function makeSession(id, project, mtime, recs, agents, parent) {
  const sum = summarize(recs);
  return {
    id, project, mtime,
    startTime: sum.start === Infinity ? mtime : sum.start,
    endTime: sum.end || mtime,
    durationMs: (sum.start !== Infinity && sum.end > sum.start) ? (sum.end - sum.start) : 0,
    recordCount: sum.assistantCount,
    inputTokens: sum.input,
    outputTokens: sum.output,
    cacheReadTokens: sum.cacheRead,
    cacheWriteTokens: sum.cacheWrite,
    totalTokens: sum.input + sum.output,
    estimatedCostUSD: sum.cost,
    cacheHitPct: cacheHitPct(sum.cacheRead, sum.input, sum.cacheWrite),
    model: sum.lastModel,
    models: Object.fromEntries(sum.modelMap),
    agents,
    parent,
    summary: firstPromptText(recs), // fallback; overridden by a Claude summary if present
    preview: buildPreview(recs, sum),
  };
}

// Collect modern Agent/Task tool_use invocations from the main-chain records.
// Returns an ordered array of { id, input, ts } objects (the assistant tool_use blocks)
// and a resultsById Map (tool_use_id → { toolUseResult, ts }) built from user records
// that carry a tool_result block paired with a toolUseResult top-level field.
function collectAgentUses(records) {
  // Build a map from tool_use_id → { toolUseResult, ts } from user records
  // that have both a tool_result content block and a top-level toolUseResult.
  const resultsById = new Map();
  for (const rec of records) {
    if (rec.type !== 'user') continue;
    if (!rec.toolUseResult) continue;
    const c = rec.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b && b.type === 'tool_result' && b.tool_use_id) {
        resultsById.set(b.tool_use_id, { toolUseResult: rec.toolUseResult, ts: rec.ts });
      }
    }
  }

  // Collect Agent/Task tool_use blocks from assistant records.
  const uses = [];
  for (const rec of records) {
    if (rec.type !== 'assistant') continue;
    const c = rec.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b && b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && b.id) {
        uses.push({ id: b.id, input: b.input || {}, ts: rec.ts });
      }
    }
  }

  return { uses, resultsById };
}

// Build a child session object from a single Agent/Task tool_use invocation.
// Sub-agent input.model is often a short alias ('sonnet'/'opus'/'haiku') that
// doesn't pin a generation. Normalize bare aliases to a canonical current-gen id
// so they price correctly (no ambiguous reverse-match) and read cleanly in the
// model table; leave real model ids untouched.
function canonicalModel(m) {
  const s = String(m || '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('claude-') || s.includes('gemini-')) return s;
  if (s.includes('opus'))   return 'claude-opus-4';
  if (s.includes('sonnet')) return 'claude-sonnet-4';
  if (s.includes('haiku'))  return 'claude-haiku-4';
  return s;
}

function makeAgentChild(fileBase, projectName, mtime, idx, use, resultsById, parentModel) {
  const tur = (resultsById.get(use.id) || {}).toolUseResult || {};
  const rawUsage = tur.usage || {};

  let i = rawUsage.input_tokens || 0;
  let o = rawUsage.output_tokens || 0;
  let cr = rawUsage.cache_read_input_tokens || 0;
  let cw = rawUsage.cache_creation_input_tokens || 0;

  // If usage has no token fields but totalTokens is available, use it as output proxy.
  if (i === 0 && o === 0 && cr === 0 && cw === 0 && tur.totalTokens) {
    o = tur.totalTokens;
  }

  const model = canonicalModel(use.input.model || parentModel || 'unknown');
  const cost = calcClaudeCost(model, i, o, cr, cw);
  const name = clamp(use.input.description || use.input.subagent_type || 'agent', 80);
  const category = use.input.subagent_type || tur.agentType || 'agent';
  const status = tur.status || 'running';
  const toolUseCount = tur.totalToolUseCount || 0;
  const durationMs = tur.totalDurationMs || 0;
  const ts = use.ts || mtime;
  const result = clamp(toolResultText(tur.content), 200);

  const preview = [
    { type: 'agent', text: `⊳ ${category} · ${name}` },
    result ? { type: 'output', text: firstLine(result) } : null,
    { type: 'cost', text: `↳ ${fmtTok(i + o)} tok · $${cost.toFixed(2)} · ${status}` },
  ].filter(Boolean);

  return {
    id: `${fileBase}~a${idx + 1}`,
    project: projectName,
    mtime,
    startTime: ts,
    endTime: ts + durationMs,
    durationMs,
    recordCount: toolUseCount,
    inputTokens: i,
    outputTokens: o,
    cacheReadTokens: cr,
    cacheWriteTokens: cw,
    totalTokens: i + o,
    estimatedCostUSD: cost,
    cacheHitPct: cacheHitPct(cr, i, cw),
    model,
    models: {
      [model]: {
        inputTokens: i, outputTokens: o,
        cacheReadTokens: cr, cacheWriteTokens: cw,
        estimatedCostUSD: cost,
      },
    },
    agents: [name],
    parent: fileBase,
    category,
    status,
    toolUseCount,
    result,
    ts,
    isAgent: true,
    summary: name,
    summarySource: 'agent',
    preview,
  };
}

// Group sidechain (sub-agent / Task) records into connected runs. Each run is a
// distinct spawned agent; the run's root is the topmost sidechain record whose
// parent is NOT itself a sidechain (i.e. it descends from the main chain).
function groupSidechains(sideRecs) {
  const byUuid = new Map();
  for (const r of sideRecs) if (r.uuid) byUuid.set(r.uuid, r);
  const rootFor = (r) => {
    let cur = r;
    const seen = new Set();
    while (cur && cur.parentUuid && byUuid.has(cur.parentUuid) && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      cur = byUuid.get(cur.parentUuid);
    }
    return cur.uuid || `t${cur.ts}`;
  };
  const groups = new Map();
  for (const r of sideRecs) {
    const root = rootFor(r);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  }
  return [...groups.values()];
}

// Build a root session (main chain) plus one child session per spawned agent.
function buildFileSessions(fileBase, projectName, parsed) {
  const main = parsed.records.filter(r => !r.isSidechain);
  const side = parsed.records.filter(r => r.isSidechain);

  const root = makeSession(fileBase, projectName, parsed.mtime, main, ['main'], null);
  // Prefer Claude's own summary (last one wins — most recent title) over the
  // first-prompt fallback already set by makeSession. `summarySource` tells the
  // renderer whether this is a real summary or a placeholder it should upgrade
  // via `claude -p`.
  root.summarySource = 'prompt';
  if (parsed.summaries && parsed.summaries.length) {
    const last = parsed.summaries[parsed.summaries.length - 1].summary;
    if (last) { root.summary = clamp(last, 160); root.summarySource = 'claude'; }
  }

  // Modern path: detect Agent/Task tool_use blocks + paired toolUseResult.
  const { uses: agentUses, resultsById } = collectAgentUses(parsed.records);

  let childSessions;
  if (agentUses.length > 0) {
    // Modern Agent format: synthesize one child per invocation from tool_use + toolUseResult.
    childSessions = agentUses.map((u, idx) =>
      makeAgentChild(fileBase, projectName, parsed.mtime, idx, u, resultsById, root.model));
  } else {
    // Back-compat: old logs that store sub-agents as inline isSidechain records.
    const groups = groupSidechains(side);
    childSessions = groups
      .map((g, idx) => makeSession(`${fileBase}~a${idx + 1}`, projectName, parsed.mtime, g, ['agent'], fileBase))
      .filter(c => c.recordCount > 0);
  }

  root.children = childSessions.map(c => c.id);
  root.childSessions = childSessions;
  return root;
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

      // Global/daily/hourly/model aggregations over every usage record in the file.
      for (const rec of parsed.records) {
        if (!rec.usage) continue;
        const u = rec.usage;
        const i = u.input_tokens || 0, o = u.output_tokens || 0;
        const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
        const recTokens = i + o;
        const recCost = calcClaudeCost(rec.model, i, o, cr, cw);

        projInput += i; projOutput += o; projCacheRead += cr; projCacheWrite += cw;
        projCost += recCost;

        hourlyMap[new Date(rec.ts).getHours()] += recTokens;

        const dateKey = new Date(rec.ts).toLocaleDateString('en-CA'); // YYYY-MM-DD
        if (!dailyMap.has(dateKey)) {
          dailyMap.set(dateKey, { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUSD: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
        }
        const day = dailyMap.get(dateKey);
        day.inputTokens += i;
        day.outputTokens += o;
        day.totalTokens += recTokens;
        day.estimatedCostUSD += recCost;
        day.cacheReadTokens += cr;
        day.cacheWriteTokens += cw;

        if (!projectDailyMap.has(projectName)) projectDailyMap.set(projectName, new Map());
        const pdm = projectDailyMap.get(projectName);
        pdm.set(dateKey, (pdm.get(dateKey) || 0) + recTokens);

        totalCacheSavings += calcCacheSavings(rec.model, cr);

        if (!modelMap.has(rec.model)) {
          modelMap.set(rec.model, { inputTokens: 0, outputTokens: 0, estimatedCostUSD: 0 });
        }
        const m = modelMap.get(rec.model);
        m.inputTokens += i; m.outputTokens += o; m.estimatedCostUSD += recCost;
      }

      allSessions.push(buildFileSessions(sessionId, projectName, parsed));
    }

    if (projInput + projOutput > 0) {
      if (!projectMap.has(projectName)) {
        projectMap.set(projectName, { name: projectName, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, estimatedCostUSD: 0, sessionCount: 0 });
      }
      const p = projectMap.get(projectName);
      p.inputTokens += projInput;
      p.outputTokens += projOutput;
      p.cacheReadTokens += projCacheRead;
      p.cacheWriteTokens += projCacheWrite;
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

  // Fold child (Agent) tokens into all global aggregations.
  // Children are NOT in parsed.records, so this is the only place they get counted.
  const agentMap = new Map(); // category → aggregated breakdown
  for (const root of allSessions) {
    for (const c of (root.childSessions || [])) {
      if (!c.isAgent) continue; // legacy sidechain children are already counted by the main records loop
      const projectName = c.project;
      // project-level accumulators
      if (projectMap.has(projectName)) {
        const p = projectMap.get(projectName);
        p.inputTokens += c.inputTokens;
        p.outputTokens += c.outputTokens;
        p.cacheReadTokens += c.cacheReadTokens;
        p.cacheWriteTokens += c.cacheWriteTokens;
        p.totalTokens += c.totalTokens;
        p.estimatedCostUSD += c.estimatedCostUSD;
      } else {
        projectMap.set(projectName, {
          name: projectName,
          inputTokens: c.inputTokens, outputTokens: c.outputTokens,
          cacheReadTokens: c.cacheReadTokens, cacheWriteTokens: c.cacheWriteTokens,
          totalTokens: c.totalTokens, estimatedCostUSD: c.estimatedCostUSD, sessionCount: 0,
        });
      }
      // global accumulators
      totalInput += c.inputTokens;
      totalOutput += c.outputTokens;
      totalCacheRead += c.cacheReadTokens;
      totalCacheWrite += c.cacheWriteTokens;
      totalCost += c.estimatedCostUSD;

      // hourly
      hourlyMap[new Date(c.ts).getHours()] += c.totalTokens;

      // daily
      const dateKey = new Date(c.ts).toLocaleDateString('en-CA');
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUSD: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      }
      const day = dailyMap.get(dateKey);
      day.inputTokens += c.inputTokens;
      day.outputTokens += c.outputTokens;
      day.totalTokens += c.totalTokens;
      day.estimatedCostUSD += c.estimatedCostUSD;
      day.cacheReadTokens += c.cacheReadTokens;
      day.cacheWriteTokens += c.cacheWriteTokens;

      // project daily sparkline
      if (!projectDailyMap.has(projectName)) projectDailyMap.set(projectName, new Map());
      const pdm = projectDailyMap.get(projectName);
      pdm.set(dateKey, (pdm.get(dateKey) || 0) + c.totalTokens);

      // cache savings
      totalCacheSavings += calcCacheSavings(c.model, c.cacheReadTokens);

      // model breakdown
      if (!modelMap.has(c.model)) {
        modelMap.set(c.model, { inputTokens: 0, outputTokens: 0, estimatedCostUSD: 0 });
      }
      const mm = modelMap.get(c.model);
      mm.inputTokens += c.inputTokens;
      mm.outputTokens += c.outputTokens;
      mm.estimatedCostUSD += c.estimatedCostUSD;

      // agent category breakdown
      const cat = c.category || 'agent';
      if (!agentMap.has(cat)) {
        agentMap.set(cat, {
          category: cat, count: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          totalTokens: 0, estimatedCostUSD: 0, durationMs: 0,
          models: new Map(),
        });
      }
      const agg = agentMap.get(cat);
      agg.count++;
      agg.inputTokens += c.inputTokens;
      agg.outputTokens += c.outputTokens;
      agg.cacheReadTokens += c.cacheReadTokens;
      agg.cacheWriteTokens += c.cacheWriteTokens;
      agg.totalTokens += c.totalTokens;
      agg.estimatedCostUSD += c.estimatedCostUSD;
      agg.durationMs += c.durationMs || 0;
      if (!agg.models.has(c.model)) agg.models.set(c.model, { inputTokens: 0, outputTokens: 0, estimatedCostUSD: 0 });
      const am = agg.models.get(c.model);
      am.inputTokens += c.inputTokens;
      am.outputTokens += c.outputTokens;
      am.estimatedCostUSD += c.estimatedCostUSD;
    }
  }

  // Build agent breakdown (sorted by totalTokens desc).
  const agentBreakdown = Array.from(agentMap.values())
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map(agg => {
      // Convert models Map → plain object; find topModel by most tokens.
      let topModel = 'unknown', topTok = -1;
      const modelsObj = {};
      for (const [mname, mdata] of agg.models.entries()) {
        modelsObj[mname] = mdata;
        if (mdata.inputTokens + mdata.outputTokens > topTok) {
          topTok = mdata.inputTokens + mdata.outputTokens;
          topModel = mname;
        }
      }
      return {
        category: agg.category,
        count: agg.count,
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        cacheReadTokens: agg.cacheReadTokens,
        cacheWriteTokens: agg.cacheWriteTokens,
        totalTokens: agg.totalTokens,
        estimatedCostUSD: agg.estimatedCostUSD,
        durationMs: agg.durationMs,
        models: modelsObj,
        topModel,
      };
    });

  let totalAgentTokens = 0, totalAgentCostUSD = 0, totalAgentInvocations = 0;
  for (const agg of agentBreakdown) {
    totalAgentTokens += agg.totalTokens;
    totalAgentCostUSD += agg.estimatedCostUSD;
    totalAgentInvocations += agg.count;
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
      cacheHitPct: cacheHitPct(proj.cacheReadTokens, proj.inputTokens, proj.cacheWriteTokens),
      sparkline: buildSparkline(projectDailyMap.get(proj.name) || new Map(), 14),
    }));

  // Workspaces = projects (Hyprland-style), id'd by token rank, with an icon.
  const workspaces = projectBreakdown.map((p, idx) => ({
    id: idx + 1,
    name: p.name,
    icon: WS_ICONS[idx % WS_ICONS.length],
  }));
  const wsIdByName = new Map(workspaces.map(w => [w.name, w.id]));
  for (const s of allSessions) {
    s.workspace = wsIdByName.get(s.project) || 0;
    for (const c of (s.childSessions || [])) c.workspace = s.workspace;
  }

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
    globalCacheHitPct: cacheHitPct(totalCacheRead, totalInput, totalCacheWrite),
    modelBreakdown,
    projectBreakdown,
    workspaces,
    daily,
    heatmap,
    hourly: hourlyMap,
    cacheSavingsUSD: totalCacheSavings,
    costProjection30d,
    recentSessions: sortedSessions,
    sessions: allSessionsByRecency,
    dataNote,
    agentBreakdown,
    totalAgentTokens,
    totalAgentCostUSD,
    totalAgentInvocations,
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
    const data = dailyMap.get(dateKey) || { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUSD: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
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

module.exports = { aggregateClaude, SUMMARY_MARKER };
