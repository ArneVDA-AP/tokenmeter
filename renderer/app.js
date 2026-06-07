// Tokenmeter renderer — UI logic, routing, chart rendering

const tm = window.tokenmeter;

// ── State ──────────────────────────────────────────────────────────────────
let usageData = null;
let charts = {};
let idleTimer = null;
let idleTimeout = 60000;
let isIdle = false;
let currentSettings = null;
let alertFiredForDate = '';

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

function updateStatus(msg) {
  const el = document.getElementById('status-text');
  if (el) el.textContent = msg;
}

// ── Formatting Helpers ─────────────────────────────────────────────────────
function fmtTokens(n) {
  if (n == null || isNaN(n)) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtCost(n) {
  if (n == null || isNaN(n)) return '~$0.00';
  return '~$' + n.toFixed(2);
}

function fmtRelTime(mtime) {
  const diff = Date.now() - mtime;
  const min  = Math.floor(diff / 60000);
  const hr   = Math.floor(diff / 3600000);
  const day  = Math.floor(diff / 86400000);
  if (min < 1)   return 'just now';
  if (min < 60)  return `${min}m ago`;
  if (hr < 24)   return `${hr}h ago`;
  return `${day}d ago`;
}

function fmtTimestamp(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtClock(ts) {
  const d = new Date(ts);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const min = Math.round(ms / 60000);
  if (min < 1)  return '<1m';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `${hr}h ${rem}m` : `${hr}h`;
}

function pct(val, total) {
  if (!total) return 0;
  return Math.min(100, (val / total) * 100);
}

// ── Navigation ─────────────────────────────────────────────────────────────
function navigate(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`page-${pageId}`)?.classList.add('active');
  document.querySelector(`.nav-tab[data-page="${pageId}"]`)?.classList.add('active');
  // Charts created while their page was display:none measure a width of 0 and
  // render too small. Re-render the page's content now that it's visible so its
  // charts are built against the real layout width.
  if (usageData) {
    if (pageId === 'claude')        renderClaude(usageData);
    else if (pageId === 'overview') renderOverview(usageData);
    else if (pageId === 'sessions') renderSessions(usageData);
    else if (pageId === 'web')      renderWeb(usageData);
  }
}

// ── Chart Helpers ──────────────────────────────────────────────────────────
const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: true,
  animation: { duration: 400 },
  plugins: { legend: { display: false }, tooltip: {
    backgroundColor: '#1e1e1e',
    borderColor: '#3d3d3d',
    borderWidth: 1,
    titleFont: { family: "'Space Mono', monospace", size: 9 },
    bodyFont:  { family: "'Space Mono', monospace", size: 10 },
    callbacks: { label: ctx => ` ${fmtTokens(ctx.raw)} tokens` },
  }},
  scales: {
    x: {
      stacked: true,
      grid: { color: '#2e2e2e' },
      ticks: { color: '#525252', font: { family: "'Space Mono', monospace", size: 9 } },
    },
    y: {
      stacked: true,
      grid: { color: '#2e2e2e' },
      ticks: {
        color: '#525252',
        font: { family: "'Space Mono', monospace", size: 9 },
        callback: v => fmtTokens(v),
      },
    },
  },
};

function makeBarChart(canvasId, labels, datasets) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  if (charts[canvasId]) { charts[canvasId].destroy(); }
  charts[canvasId] = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: JSON.parse(JSON.stringify(CHART_DEFAULTS)),
  });
  return charts[canvasId];
}

function dailyLabels(daily) { return daily.map(d => d.label); }

// Line chart for a 0–100% series (e.g. cache hit rate). Built explicitly rather
// than via CHART_DEFAULTS so the %-axis tick + tooltip callbacks survive.
function makeCacheTrendChart(canvasId, labels, data) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  if (charts[canvasId]) charts[canvasId].destroy();
  const mono10 = { family: "'Space Mono', monospace", size: 10 };
  const mono9  = { family: "'Space Mono', monospace", size: 9 };
  charts[canvasId] = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [{
      data,
      borderColor: 'rgba(232,101,10,0.85)',
      backgroundColor: 'rgba(232,101,10,0.12)',
      fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
      spanGaps: false, // idle days are null → render as gaps, not a dive to 0%
    }] },
    options: {
      responsive: true, maintainAspectRatio: true,
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e1e1e', borderColor: '#3d3d3d', borderWidth: 1,
          titleFont: mono9, bodyFont: mono10,
          callbacks: { label: ctx => ` ${(+ctx.raw).toFixed(1)}% cached` },
        },
      },
      scales: {
        x: { grid: { color: '#2e2e2e' }, ticks: { color: '#525252', font: mono9 } },
        y: { min: 0, max: 100, grid: { color: '#2e2e2e' },
             ticks: { color: '#525252', font: mono9, callback: v => v + '%' } },
      },
    },
  });
  return charts[canvasId];
}

// ── Heatmap ────────────────────────────────────────────────────────────────
function renderHeatmap(heatmap) {
  const grid = document.getElementById('heatmap-grid');
  if (!grid || !heatmap || !heatmap.length) return;

  const maxTokens = Math.max(...heatmap.map(d => d.totalTokens), 1);
  grid.innerHTML = '';

  // Pad front so column 0 starts on the right day-of-week (Mon=0)
  const firstDow = (new Date(heatmap[0].date).getDay() + 6) % 7;
  for (let i = 0; i < firstDow; i++) {
    const pad = document.createElement('div');
    pad.className = 'heatmap-cell';
    grid.appendChild(pad);
  }

  for (const day of heatmap) {
    const cell = document.createElement('div');
    cell.className = 'heatmap-cell';
    const t = day.totalTokens;
    if (t > 0) {
      const ratio = t / maxTokens;
      const level = ratio < 0.15 ? 1 : ratio < 0.40 ? 2 : ratio < 0.70 ? 3 : 4;
      cell.setAttribute('data-level', level);
    }
    cell.title = `${day.date}: ${fmtTokens(t)} tokens`;
    grid.appendChild(cell);
  }
}

// ── Peak Hours ─────────────────────────────────────────────────────────────
function renderPeakHours(hourly) {
  const canvas = document.getElementById('chart-peak-hours');
  if (!canvas || !hourly) return;
  if (charts['chart-peak-hours']) charts['chart-peak-hours'].destroy();

  const maxH = Math.max(...hourly, 1);
  charts['chart-peak-hours'] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: hourly.map((_, i) => i % 6 === 0 ? `${i}h` : ''),
      datasets: [{
        data: hourly,
        backgroundColor: hourly.map(v => `rgba(232,101,10,${(0.15 + (v / maxH) * 0.75).toFixed(2)})`),
        borderRadius: 2, borderSkipped: false,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e1e1e', borderColor: '#3d3d3d', borderWidth: 1,
          titleFont: { family: "'Space Mono', monospace", size: 9 },
          bodyFont:  { family: "'Space Mono', monospace", size: 10 },
          callbacks: {
            title: ctx => `${ctx[0].dataIndex}:00 – ${ctx[0].dataIndex + 1}:00`,
            label: ctx => ` ${fmtTokens(ctx.raw)} tokens`,
          },
        },
      },
      scales: {
        x: { grid: { color: '#2e2e2e' }, ticks: { color: '#525252', font: { family: "'Space Mono', monospace", size: 9 } } },
        y: { grid: { color: '#2e2e2e' }, ticks: { color: '#525252', font: { family: "'Space Mono', monospace", size: 9 }, callback: v => fmtTokens(v) } },
      },
    },
  });
}

// ── Sparkline ──────────────────────────────────────────────────────────────
function drawSparkline(canvas, data) {
  if (!canvas || !data || data.length < 2) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const max = Math.max(...data, 1);
  const step = w / (data.length - 1);

  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = i * step;
    const y = h - (data[i] / max) * h * 0.88 - 1;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(232,101,10,0.8)';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.lineTo((data.length - 1) * step, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(232,101,10,0.12)';
  ctx.fill();
}

// ── Cost Alert ─────────────────────────────────────────────────────────────
function checkCostAlert(data) {
  if (!currentSettings) return;
  const threshold = parseFloat(currentSettings.dailyCostAlert) || 0;
  if (threshold <= 0) return;
  const daily = data.claude?.daily || [];
  if (!daily.length) return;
  const todayEntry = daily[daily.length - 1];
  const todayCost = todayEntry?.estimatedCostUSD || 0;
  if (todayCost >= threshold && alertFiredForDate !== todayEntry.date) {
    alertFiredForDate = todayEntry.date;
    showToast(`Daily cost alert: ~$${todayCost.toFixed(2)} (threshold: $${threshold})`);
    tm.showNotification?.('Tokenmeter Alert',
      `Today's Claude cost ~$${todayCost.toFixed(2)} exceeded $${threshold} threshold`);
  }
}

// ── Render Overview ────────────────────────────────────────────────────────
function renderOverview(data) {
  const { claude } = data;
  const clTotal = claude.totalTokens || 0;
  const todayEntry = (claude.daily || []).find(d => d.date === new Date().toLocaleDateString('en-CA'));

  document.getElementById('ov-total-tokens').textContent      = fmtTokens(clTotal);
  document.getElementById('ov-total-cost').textContent        = fmtCost(claude.estimatedCostUSD);
  document.getElementById('ov-today').textContent             = fmtTokens(todayEntry?.totalTokens || 0);
  document.getElementById('ov-combined-sessions').textContent = claude.totalSessions || 0;

  // Claude row
  const clStatus = document.getElementById('ov-claude-status');
  if (claude.available) {
    clStatus.className = 'cli-status-pill active';
    clStatus.textContent = 'Active';
  } else {
    clStatus.className = 'cli-status-pill inactive';
    clStatus.textContent = 'Not Detected';
  }
  document.getElementById('ov-claude-bar').style.width        = claude.available ? '100%' : '0%';
  document.getElementById('ov-claude-tokens').textContent     = fmtTokens(clTotal);
  document.getElementById('ov-claude-cost').textContent       = fmtCost(claude.estimatedCostUSD);
  document.getElementById('ov-claude-sessions').textContent   = claude.totalSessions || 0;
  document.getElementById('ov-claude-input-val').textContent  = fmtTokens(claude.totalInputTokens);
  document.getElementById('ov-claude-output-val').textContent = fmtTokens(claude.totalOutputTokens);

  const claudeNote = document.getElementById('ov-claude-note');
  if (!claude.available) {
    claudeNote.textContent = 'No Claude Code data found. Expected: %USERPROFILE%\\.claude\\projects\\**\\*.jsonl';
    claudeNote.style.display = 'block';
  } else {
    claudeNote.style.display = 'none';
  }

  // Daily chart (Claude only)
  const daily = claude.daily || [];
  makeBarChart('chart-combined-daily', dailyLabels(daily), [
    { label: 'Input',  data: daily.map(d => d.inputTokens),  backgroundColor: 'rgba(212,162,122,0.5)',  borderRadius: 3, borderSkipped: false },
    { label: 'Output', data: daily.map(d => d.outputTokens), backgroundColor: 'rgba(212,162,122,0.85)', borderRadius: 3, borderSkipped: false },
  ]);
}

// ── Render Claude Detail ───────────────────────────────────────────────────
function renderClaude(data) {
  const cl = data.claude;
  if (!cl) return;

  document.getElementById('cl-header-sub').textContent =
    `${cl.totalSessions || 0} sessions · ${fmtCost(cl.estimatedCostUSD)} estimated`;

  // Last active session card
  const sessions = cl.recentSessions || [];
  const lastActiveCard = document.getElementById('cl-last-active');
  if (sessions.length > 0) {
    const s = sessions[0];
    document.getElementById('cl-last-project').textContent = s.project;
    document.getElementById('cl-last-time').textContent    = fmtRelTime(s.mtime);
    document.getElementById('cl-last-tokens').textContent  = fmtTokens(s.totalTokens) + ' tokens';
    document.getElementById('cl-last-model').textContent   = s.model.length > 30 ? s.model.slice(0, 28) + '…' : s.model;
    lastActiveCard.style.display = 'flex';
  } else {
    lastActiveCard.style.display = 'none';
  }

  // Insight cards
  document.getElementById('cl-cache-savings-total').textContent = fmtCost(cl.cacheSavingsUSD || 0);
  document.getElementById('cl-cost-projection').textContent     = fmtCost(cl.costProjection30d || 0);

  // Usage summary
  document.getElementById('cl-input').textContent       = fmtTokens(cl.totalInputTokens);
  document.getElementById('cl-output').textContent      = fmtTokens(cl.totalOutputTokens);
  document.getElementById('cl-cache-read').textContent  = fmtTokens(cl.totalCacheReadTokens);
  document.getElementById('cl-cache-write').textContent = fmtTokens(cl.totalCacheWriteTokens);
  document.getElementById('cl-cache-hit').textContent   = (cl.globalCacheHitPct || 0).toFixed(1) + '%';
  document.getElementById('cl-cache-savings').textContent =
    `saved ${fmtCost(cl.cacheSavingsUSD || 0)} vs uncached`;

  // Daily chart
  const daily = cl.daily || [];
  makeBarChart('chart-claude-daily', dailyLabels(daily), [
    { label: 'Input',  data: daily.map(d => d.inputTokens),  backgroundColor: 'rgba(212,162,122,0.5)',  borderRadius: 3, borderSkipped: false },
    { label: 'Output', data: daily.map(d => d.outputTokens), backgroundColor: 'rgba(212,162,122,0.85)', borderRadius: 3, borderSkipped: false },
  ]);

  // Cache hit trend: cacheRead / (cacheRead + input + cacheWrite) per day.
  // Days with no prompt tokens become null so the line shows a gap instead of
  // sawtoothing down to 0%.
  makeCacheTrendChart('chart-cache-trend', dailyLabels(daily),
    daily.map(d => {
      const denom = d.cacheReadTokens + d.inputTokens + (d.cacheWriteTokens || 0);
      return denom > 0 ? (d.cacheReadTokens / denom) * 100 : null;
    }));

  // Heatmap and peak hours
  renderHeatmap(cl.heatmap);
  renderPeakHours(cl.hourly);

  // Model breakdown table
  const modelBreakdown = cl.modelBreakdown || {};
  const totalClTokens = cl.totalTokens || 1;
  const tbody = document.getElementById('cl-model-tbody');
  tbody.innerHTML = '';
  const models = Object.entries(modelBreakdown).sort((a, b) =>
    (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens)
  );
  for (const [model, stats] of models) {
    const tokens = stats.inputTokens + stats.outputTokens;
    const share = pct(tokens, totalClTokens);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${model}">
        ${model.length > 28 ? model.slice(0, 26) + '…' : model}
      </td>
      <td class="mono dim">${fmtTokens(tokens)}</td>
      <td class="mono dim">${fmtCost(stats.estimatedCostUSD)}</td>
      <td>
        <div class="table-bar-track">
          <div class="table-bar-fill claude" style="width:${share}%"></div>
        </div>
        <span style="font-size:9px;color:var(--text-dim);font-family:var(--font-mono)">${share.toFixed(1)}%</span>
      </td>
    `;
    tbody.appendChild(tr);
  }

  // Project breakdown table with sparklines
  const projects = cl.projectBreakdown || [];
  const ptbody = document.getElementById('cl-project-tbody');
  ptbody.innerHTML = '';
  for (const proj of projects) {
    const share = pct(proj.totalTokens, totalClTokens);
    const tr = document.createElement('tr');
    const canvasId = `spark-${proj.name.replace(/\W/g, '_')}`;
    tr.innerHTML = `
      <td class="mono">${proj.name}</td>
      <td class="mono dim">${proj.sessionCount}</td>
      <td class="mono dim">${fmtTokens(proj.totalTokens)}</td>
      <td class="mono dim">${fmtCost(proj.estimatedCostUSD)}</td>
      <td class="mono dim">${(proj.cacheHitPct || 0).toFixed(1)}%</td>
      <td><canvas id="${canvasId}" class="sparkline-canvas" width="58" height="20"></canvas></td>
      <td>
        <div class="table-bar-track">
          <div class="table-bar-fill claude" style="width:${share}%"></div>
        </div>
        <span style="font-size:9px;color:var(--text-dim);font-family:var(--font-mono)">${share.toFixed(1)}%</span>
      </td>
    `;
    ptbody.appendChild(tr);
    if (proj.sparkline) {
      drawSparkline(document.getElementById(canvasId), proj.sparkline);
    }
  }

  // Recent sessions
  const sessionsList = document.getElementById('cl-sessions-list');
  sessionsList.innerHTML = '';
  for (const s of sessions) {
    const div = document.createElement('div');
    div.className = 'session-item';
    div.innerHTML = `
      <div class="session-project">${s.project}</div>
      <div class="session-time">${fmtRelTime(s.mtime)}</div>
      <div class="session-tokens">${fmtTokens(s.totalTokens)}</div>
      <div class="session-model">${s.model}</div>
    `;
    sessionsList.appendChild(div);
  }
}


// ── Render Sessions (Hyprland-style compositor overview) ─────────────────────
// "Workspaces" = projects; each session is a terminal window; sub-agents spawned
// inside a session (sidechains) render as indented child windows. Active = the
// session wrote to its log within HYPR_ACTIVE_MS (a running Claude Code terminal).
const HYPR_ACTIVE_MS = 10 * 60 * 1000;
let hyprFilter = 'all';   // 'all' or a workspace id
let hyprFocused = null;   // focused/selected session id
let hyprDetailId = null;  // session id whose detail panel is open
let hyprExpo = false;     // expo (workspace overview) open?
let hyprTheme = 'nord';
let hyprShowClosed = false; // false → only live sessions; true → also show ended ones

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function hyprIsActive(s) {
  // Use the file's last write (mtime), not just the last usage record: a session
  // mid-long-generation hasn't written a new assistant/usage record yet, but its
  // .jsonl is still being appended to, so mtime is the truer "is it running" signal.
  return (Date.now() - Math.max(s.mtime || 0, s.endTime || 0)) < HYPR_ACTIVE_MS;
}
function hyprShortId(id) {
  const base = String(id || '').replace(/~a\d+$/, '');
  const seg = base.split(/[-_/]/).pop() || base;
  return seg.length > 8 ? seg.slice(-8) : seg;
}
function hyprModelFamilies(models) {
  const fams = [];
  for (const name of Object.keys(models || {})) {
    const fam = /opus/i.test(name) ? 'opus' : /sonnet/i.test(name) ? 'sonnet'
      : /haiku/i.test(name) ? 'haiku' : 'other';
    if (!fams.includes(fam)) fams.push(fam);
  }
  return fams;
}
function hyprAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000), h = Math.floor(diff / 3600000), d = Math.floor(diff / 86400000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  if (h < 24) return h + 'h';
  return d + 'd';
}
function hyprAll(cl) {
  const out = [];
  for (const s of (cl?.sessions || [])) { out.push(s); for (const c of (s.childSessions || [])) out.push(c); }
  return out;
}
function hyprFind(cl, id) { return hyprAll(cl).find(s => s.id === id); }
function hyprWsHasActive(roots, wsId) {
  return roots.some(s => s.workspace === wsId &&
    (hyprIsActive(s) || (s.childSessions || []).some(hyprIsActive)));
}
// A root is shown when "live only" unless it (or one of its sub-agents) is active.
function hyprEligible(s) {
  return hyprShowClosed || hyprIsActive(s) || (s.childSessions || []).some(hyprIsActive);
}
const noTilde = (n) => fmtCost(n).replace('~', '');

// ── Closed-session summaries via the local `claude -p` CLI (main process) ─────
// Throttled, cached client-side (key id:mtime) so they don't re-flash or
// re-request across refreshes. Only closed cards get upgraded; real Claude
// summary records (summarySource==='claude') are shown as-is.
const hyprSummaryCache = {};
const hyprSummaryInflight = new Set();
let hyprSummariesAvailable = true;
let hyprSummaryQueue = [];
let hyprSummaryActive = 0;
const HYPR_SUMMARY_CONCURRENCY = 3;

function hyprDisplaySummary(s) {
  if (s.summarySource === 'claude') return s.summary;
  return hyprSummaryCache[`${s.id}:${s.mtime}`] || s.summary;
}
function hyprQueueSummaries(roots) {
  if (!hyprSummariesAvailable) return;
  if (currentSettings && currentSettings.sessionSummaries === false) return;
  for (const s of roots) {
    if (hyprIsActive(s) || s.summarySource === 'claude') continue;
    const key = `${s.id}:${s.mtime}`;
    if (hyprSummaryCache[key] || hyprSummaryInflight.has(key)) continue;
    hyprSummaryQueue.push(s);
  }
  hyprPumpSummaries();
}
function hyprPumpSummaries() {
  while (hyprSummaryActive < HYPR_SUMMARY_CONCURRENCY && hyprSummaryQueue.length) {
    const s = hyprSummaryQueue.shift();
    const key = `${s.id}:${s.mtime}`;
    if (hyprSummaryCache[key] || hyprSummaryInflight.has(key)) continue;
    hyprSummaryInflight.add(key);
    hyprSummaryActive++;
    tm.summarizeSession({ id: s.id, mtime: s.mtime, firstPrompt: s.summary, lines: (s.preview || []).map(l => l.text) })
      .then(res => {
        if (res && res.available === false) { hyprSummariesAvailable = false; hyprSummaryQueue = []; return; }
        if (res && res.summary) { hyprSummaryCache[key] = res.summary; hyprUpdateSummaryDOM(s.id, res.summary); }
      })
      .catch(() => {})
      .finally(() => { hyprSummaryInflight.delete(key); hyprSummaryActive--; hyprPumpSummaries(); });
  }
}
// Generate a summary for one specific session (e.g. the one whose detail just
// opened) — works for active sessions too, which the grid batch skips.
function hyprRequestSummary(s) {
  if (!s || !hyprSummariesAvailable) return;
  if (currentSettings && currentSettings.sessionSummaries === false) return;
  if (s.summarySource === 'claude') return;
  const key = `${s.id}:${s.mtime}`;
  if (hyprSummaryCache[key] || hyprSummaryInflight.has(key)) return;
  hyprSummaryQueue.unshift(s); // prioritise the opened session
  hyprPumpSummaries();
}
function hyprUpdateSummaryDOM(id, text) {
  const el = document.querySelector(`#hypr-root .hypr-win[data-sid="${CSS.escape(id)}"] .hypr-summary`);
  if (el) { el.textContent = text; el.title = text; }
  if (hyprDetailId === id) {
    const s = hyprFind(usageData?.claude, id);
    if (s) hyprOpenDetail(s, usageData?.claude?.workspaces || []);
  }
}

function renderSessions(data) {
  const cl = data?.claude;
  const rootEl = document.getElementById('hypr-root');
  if (!rootEl) return;
  applyHyprTheme(rootEl, hyprTheme);

  const roots = cl?.sessions || [];
  const workspaces = cl?.workspaces || [];
  const activeCount = hyprAll(cl).filter(hyprIsActive).length;
  const eligible = roots.filter(hyprEligible);
  const visibleRoots = hyprFilter === 'all' ? eligible : eligible.filter(s => s.workspace === hyprFilter);

  rootEl.innerHTML =
    hyprWaybar(workspaces, roots, cl, activeCount) +
    hyprStrip(workspaces, roots) +
    hyprGrid(visibleRoots, workspaces) +
    `<div id="hypr-detail" class="hypr-detail"></div>` +
    (hyprExpo ? hyprExpoView(workspaces, roots) : '');

  if (hyprDetailId) {
    const s = hyprFind(cl, hyprDetailId);
    if (s) { hyprOpenDetail(s, workspaces); hyprRequestSummary(s); }
    else hyprDetailId = null;
  }

  hyprQueueSummaries(visibleRoots); // upgrade closed-card summaries via claude -p
}

function hyprWaybar(workspaces, roots, cl, activeCount) {
  const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const pills = workspaces.map(ws => `
    <div class="hypr-ws ${hyprFilter === ws.id ? 'active' : ''}" data-ws="${ws.id}">
      <span class="ix">${ws.id}</span>${escHtml(ws.name)}
      ${hyprWsHasActive(roots, ws.id) ? '<span class="hypr-pulse"></span>' : ''}
    </div>`).join('');
  const themeOpts = HYPR_THEME_ORDER.map(k =>
    `<option value="${k}" ${k === hyprTheme ? 'selected' : ''}>${HYPR_THEMES[k].label}</option>`).join('');
  return `
    <div class="hypr-bar">
      <div style="display:flex;gap:2px;align-items:center">${pills}</div>
      <div class="hypr-bar-title"><b>tokenmeter</b><span class="sep">—</span>session overview</div>
      <div class="hypr-bar-right">
        <select class="hypr-theme-sel" id="hypr-theme-sel" title="Theme">${themeOpts}</select>
        <div class="hypr-mod btn ${hyprShowClosed ? '' : 'on'}" data-toggle-closed="1" title="${hyprShowClosed ? 'Showing all sessions — click for live only' : 'Showing live sessions only — click to include closed'}"><span>${hyprShowClosed ? '◌' : '◉'}</span><span>${hyprShowClosed ? 'all' : 'live only'}</span></div>
        <div class="hypr-mod btn ${hyprExpo ? 'on' : ''}" data-expo="1" title="Workspace overview (\`)"><span>▦</span><span>expo</span></div>
        <div class="hypr-mod"><span class="tok">◆</span><span>${cl?.totalSessions || 0} sessions</span><span class="cost">${noTilde(cl?.estimatedCostUSD || 0)}</span></div>
        ${activeCount > 0 ? `<div class="hypr-mod active-mod"><span style="color:var(--h-green)">●</span><span>${activeCount} active</span></div>` : ''}
        <div class="hypr-mod"><span class="clk">${time}</span></div>
      </div>
    </div>`;
}

function hyprStrip(workspaces, roots) {
  const btns = workspaces.map(ws => {
    const count = roots.filter(s => s.workspace === ws.id && hyprEligible(s)).length;
    return `
      <div class="hypr-strip-btn ${hyprFilter === ws.id ? 'active' : ''}" data-ws="${ws.id}">
        <span class="n">${ws.id}</span><span>${escHtml(ws.name)}</span><span class="c">${count}</span>
        ${hyprWsHasActive(roots, ws.id) ? '<span class="hypr-pulse"></span>' : ''}
      </div>`;
  }).join('');
  return `<div class="hypr-strip">
    <div class="hypr-strip-btn ${hyprFilter === 'all' ? 'active' : ''}" data-ws="all">ALL</div>${btns}
  </div>`;
}

function hyprGrid(visibleRoots, workspaces) {
  if (!visibleRoots.length) {
    if (!hyprShowClosed) {
      return `<div class="hypr-grid-wrap"><div class="hypr-empty">No live sessions right now.<br><span class="hypr-empty-cta" data-showclosed="1">▦ show recent sessions</span></div></div>`;
    }
    return `<div class="hypr-grid-wrap"><div class="hypr-empty">no sessions in the last 90 days.</div></div>`;
  }
  if (hyprFilter === 'all') {
    const groups = {};
    for (const s of visibleRoots) (groups[s.workspace] = groups[s.workspace] || []).push(s);
    const ids = Object.keys(groups).map(Number).sort((a, b) => a - b);
    const sections = ids.map(wsId => {
      const ws = workspaces.find(w => w.id === wsId);
      const list = groups[wsId];
      const act = hyprWsHasActive(list, wsId);
      return `<div>
        <div class="hypr-section-head">
          <span class="ix">${wsId}</span>
          <span class="nm">${escHtml(ws ? ws.name : 'workspace ' + wsId)}</span>
          <span class="rule"></span>
          ${act ? '<span class="act"><span class="hypr-pulse"></span>active</span>' : ''}
        </div>
        <div class="hypr-grid">${list.map(hyprBranch).join('')}</div>
      </div>`;
    }).join('');
    return `<div class="hypr-grid-wrap">${sections}</div>`;
  }
  const single = visibleRoots.length <= 2;
  return `<div class="hypr-grid-wrap"><div class="hypr-grid ${single ? 'single' : ''}">${visibleRoots.map(hyprBranch).join('')}</div></div>`;
}

function hyprBranch(root) {
  const kids = (root.childSessions || []).map(c => `<div class="hypr-child">${hyprWin(c, true)}</div>`).join('');
  return `<div class="hypr-branch">${hyprWin(root, false)}${kids}</div>`;
}

function hyprWin(s, isChild) {
  const active = hyprIsActive(s);
  const cls = ['hypr-win'];
  if (active) cls.push('active');
  if (hyprFocused === s.id) cls.push('focused');
  const lines = (s.preview || []).map(l => `<div class="ln l-${l.type}">${escHtml(l.text)}</div>`).join('');
  const dots = hyprModelFamilies(s.models).map(f => `<span class="hypr-mdot m-${f}"></span>`).join('');
  return `
    <div class="${cls.join(' ')}" data-sid="${escHtml(s.id)}">
      <div class="hypr-win-inner">
        <div class="hypr-wtitle">
          <div class="hypr-lights"><span class="hypr-dot ${active ? 'run' : ''}"></span><span class="hypr-dot"></span><span class="hypr-dot"></span></div>
          <div class="hypr-wname">${isChild ? '<span class="agentmark">⊳</span>' : ''}<b>${escHtml((s.agents && s.agents[0]) || 'main')}</b><span class="sep"> · </span>${escHtml(hyprShortId(s.id))}</div>
          <div class="hypr-wago">${hyprAgo(Math.max(s.mtime || 0, s.endTime || 0))}${active ? '<span class="hypr-pulse"></span>' : ''}</div>
        </div>
        <div class="hypr-term">
          ${!active && hyprDisplaySummary(s) ? `<div class="hypr-summary" title="${escHtml(hyprDisplaySummary(s))}">${escHtml(hyprDisplaySummary(s))}</div>` : ''}
          ${lines}
          ${active ? '<div><span class="hypr-cursor"></span></div>' : ''}
          <div class="fade"></div>
        </div>
        <div class="hypr-wstatus">
          <div class="left"><span>${s.recordCount || 0}msg</span><span class="tok">${fmtTokens(s.totalTokens)}</span><span class="cost">${noTilde(s.estimatedCostUSD)}</span></div>
          <div class="right">${dots}<span>cache ${Math.round(s.cacheHitPct || 0)}%</span></div>
        </div>
      </div>
    </div>`;
}

function hyprDetailHTML(s, workspaces) {
  const cl = usageData?.claude;
  const active = hyprIsActive(s);
  const stats = [
    ['TOKENS', fmtTokens(s.totalTokens), ''],
    ['COST', noTilde(s.estimatedCostUSD), 'cost'],
    ['CACHE', Math.round(s.cacheHitPct || 0) + '%', 'cache'],
    ['MSGS', s.recordCount || 0, ''],
    ['TIME', fmtDuration(s.durationMs), ''],
    ['STATUS', active ? 'ACTIVE' : 'ENDED', active ? 'cache' : ''],
  ];
  const statCards = stats.map(([l, v, c]) =>
    `<div class="hypr-stat"><div class="lbl">${l}</div><div class="val ${c}">${escHtml(String(v))}</div></div>`).join('');

  const modelRows = Object.entries(s.models || {})
    .sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens))
    .map(([m, st]) => {
      const fam = hyprModelFamilies({ [m]: st })[0];
      return `<div class="hypr-drow"><span class="hypr-mdot m-${fam}"></span><span class="grow">${escHtml(m)}</span><span class="tk">${fmtTokens(st.inputTokens + st.outputTokens)}</span><span class="ct">${noTilde(st.estimatedCostUSD)}</span></div>`;
    }).join('') || '<div class="hypr-drow"><span class="grow" style="color:var(--h-fg-meta)">no model usage</span></div>';

  let rel = '';
  if (s.parent) {
    const p = hyprFind(cl, s.parent);
    if (p) rel += `<div class="hypr-dgroup"><div class="hypr-dgroup-lbl">PARENT SESSION</div>
      <div class="hypr-drow card" data-sid="${escHtml(p.id)}" style="cursor:pointer"><span class="agentmark">⊳</span><span class="grow">${escHtml(p.agents[0])}</span><span class="tk">${escHtml(hyprShortId(p.id))}</span></div></div>`;
  }
  if (s.childSessions && s.childSessions.length) {
    rel += `<div class="hypr-dgroup"><div class="hypr-dgroup-lbl">SPAWNED AGENTS</div>${s.childSessions.map(c =>
      `<div class="hypr-drow card" data-sid="${escHtml(c.id)}" style="cursor:pointer"><span class="hypr-dot ${hyprIsActive(c) ? 'run' : ''}"></span><span class="grow">${escHtml(c.agents[0])}</span><span class="tk">${fmtTokens(c.totalTokens)}</span><span class="ct">${noTilde(c.estimatedCostUSD)}</span></div>`).join('')}</div>`;
  }

  const out = (s.preview || []).map(l => `<div class="ln l-${l.type}">${escHtml(l.text)}</div>`).join('');
  const summaryText = hyprDisplaySummary(s);
  // Honest label: only call it a SUMMARY when it's a real Claude summary record
  // or a generated one — otherwise it's just the opening prompt (the TASK).
  const summaryIsReal = s.summarySource === 'claude' || !!hyprSummaryCache[`${s.id}:${s.mtime}`];
  const summaryLabel = summaryIsReal ? 'SUMMARY' : 'TASK';
  return `
    <div class="hypr-detail-head"><div class="hypr-detail-head-in">
      <div>
        <div class="hypr-detail-title">${escHtml((s.agents && s.agents[0]) || 'main')}<span class="sub"> · ${escHtml(hyprShortId(s.id))}</span></div>
        <div class="hypr-detail-ws">${escHtml(s.project)} · workspace ${s.workspace}</div>
      </div>
      <button class="hypr-x" id="hypr-detail-x" title="Close">✕</button>
    </div></div>
    <div class="hypr-detail-body">
      <div class="hypr-stats">${statCards}</div>
      ${summaryText ? `<div class="hypr-dgroup"><div class="hypr-dgroup-lbl">${summaryLabel}</div><div class="hypr-doutput"><div class="ln" style="white-space:normal">${escHtml(summaryText)}</div></div></div>` : ''}
      <div class="hypr-dgroup"><div class="hypr-dgroup-lbl">MODELS</div>${modelRows}</div>
      ${rel}
      <div class="hypr-dgroup"><div class="hypr-dgroup-lbl">SESSION OUTPUT</div><div class="hypr-doutput">${out}</div></div>
    </div>`;
}

function hyprOpenDetail(s, workspaces) {
  const el = document.getElementById('hypr-detail');
  if (!el) return;
  el.classList.remove('open');
  el.innerHTML = hyprDetailHTML(s, workspaces);
  void el.offsetWidth; // force reflow so the slide-in transition runs from off-screen
  el.classList.add('open');
}

function closeSessionDetail() {
  hyprDetailId = null;
  hyprFocused = null;
  const el = document.getElementById('hypr-detail');
  if (el) el.classList.remove('open');
  document.querySelectorAll('.hypr-win.focused').forEach(w => w.classList.remove('focused'));
}

function hyprExpoView(workspaces, roots) {
  const tiles = workspaces.map(ws => {
    const list = roots.filter(s => s.workspace === ws.id);
    const act = hyprWsHasActive(list, ws.id);
    const totalCost = list.reduce((a, s) =>
      a + (s.estimatedCostUSD || 0) + (s.childSessions || []).reduce((b, c) => b + (c.estimatedCostUSD || 0), 0), 0);
    const minis = list.length
      ? list.map(root => {
          const kids = root.childSessions || [];
          return `<div style="flex:1 1 ${kids.length ? '100%' : '46%'};display:flex;flex-wrap:wrap;gap:4px;min-width:0">${hyprMini(root, false)}${kids.map(c => hyprMini(c, true)).join('')}</div>`;
        }).join('')
      : '<div class="hypr-mini-empty">empty</div>';
    return `<div class="hypr-expo-tile" data-ws="${ws.id}">
      <div class="hypr-expo-label"><span class="badge">${ws.id}</span><span class="nm">${escHtml(ws.name)}</span><span class="c">${list.length}</span><span class="grow"></span>${act ? '<span class="hypr-pulse"></span>' : ''}<span class="ct">$${totalCost.toFixed(2)}</span></div>
      <div class="hypr-mini-desk ${act ? 'act' : ''}">${minis}</div>
    </div>`;
  }).join('');
  return `<div class="hypr-expo" id="hypr-expo">
    <div class="hypr-expo-head"><div class="t">WORKSPACES</div><div class="s">click a workspace to enter · <b>esc to close</b></div></div>
    <div class="hypr-expo-grid">${tiles}</div>
  </div>`;
}

function hyprMini(s, isChild) {
  const active = hyprIsActive(s);
  const lines = (s.preview || []).slice(0, 4).map((l, i) => {
    const w = [70, 90, 55, 80][i % 4];
    return `<div class="l l-${l.type}" style="width:${w}%;background:currentColor"></div>`;
  }).join('');
  return `<div class="hypr-mini ${active ? 'run' : ''} ${isChild ? 'child' : ''}"><div class="hypr-mini-in">
    <div class="hypr-mini-bar"><span class="d ${active ? 'run' : ''}"></span><span class="ln"></span>${active ? '<span class="d run"></span>' : ''}</div>
    <div class="hypr-mini-lines">${lines}</div>
  </div></div>`;
}

// Click delegation for the whole sessions surface (rebuilt on every render).
function hyprHandleClick(e) {
  const cl = usageData?.claude;
  if (e.target.closest('#hypr-detail-x')) { closeSessionDetail(); return; }

  const expoBtn = e.target.closest('[data-expo]');
  if (expoBtn) { hyprExpo = !hyprExpo; renderSessions(usageData); return; }

  if (e.target.closest('[data-toggle-closed]')) {
    hyprShowClosed = !hyprShowClosed;
    tm.saveSettings({ sessionsShowClosed: hyprShowClosed }).catch(() => {});
    renderSessions(usageData);
    return;
  }
  if (e.target.closest('[data-showclosed]')) {
    hyprShowClosed = true;
    tm.saveSettings({ sessionsShowClosed: true }).catch(() => {});
    renderSessions(usageData);
    return;
  }

  // A spawned-agent / parent row inside the detail panel.
  const drow = e.target.closest('.hypr-drow.card[data-sid]');
  if (drow) {
    const s = hyprFind(cl, drow.dataset.sid);
    if (s) { hyprDetailId = s.id; hyprFocused = s.id; hyprOpenDetail(s, cl?.workspaces || []); hyprRequestSummary(s); }
    return;
  }

  const wsBtn = e.target.closest('[data-ws]');
  if (wsBtn) {
    const v = wsBtn.dataset.ws;
    hyprFilter = v === 'all' ? 'all' : Number(v);
    hyprExpo = false;
    renderSessions(usageData);
    return;
  }

  // Clicking the expo backdrop (not a tile) closes it.
  if (e.target.id === 'hypr-expo') { hyprExpo = false; renderSessions(usageData); return; }

  const win = e.target.closest('.hypr-win');
  if (win) {
    const sid = win.dataset.sid;
    if (hyprDetailId === sid) { closeSessionDetail(); return; }
    const s = hyprFind(cl, sid);
    if (!s) return;
    document.querySelectorAll('.hypr-win.focused').forEach(w => w.classList.remove('focused'));
    win.classList.add('focused');
    hyprDetailId = sid;
    hyprFocused = sid;
    hyprOpenDetail(s, cl?.workspaces || []);
    hyprRequestSummary(s);
  }
}

// Keyboard for the sessions surface: backtick toggles expo, Esc closes overlays.
function hyprKeydown(e) {
  if (!document.getElementById('page-sessions')?.classList.contains('active')) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === '`' && !typing) {
    e.preventDefault();
    hyprExpo = !hyprExpo;
    renderSessions(usageData);
  } else if (e.key === 'Escape') {
    if (hyprExpo) { hyprExpo = false; renderSessions(usageData); }
    else if (hyprDetailId) { closeSessionDetail(); }
  }
}

// ── Render Web Usage (claude.ai, via the Claude Usage extension mirror) ───────
function fmtResetIn(resetsAt) {
  if (!resetsAt) return '';
  const diff = resetsAt - Date.now();
  if (diff <= 0) return 'resetting now';
  const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`;
  if (h >= 1)  return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

function renderWeb(data) {
  const web = data?.web;
  const emptyEl = document.getElementById('web-empty');
  const contentEl = document.getElementById('web-content');
  if (!emptyEl || !contentEl) return;

  if (!web || !web.available) {
    contentEl.style.display = 'none';
    emptyEl.style.display = 'block';
    emptyEl.textContent = (web && web.dataNote) ||
      'No web-usage data found. See integration/README.md to connect the Claude Usage extension.';
    return;
  }
  emptyEl.style.display = 'none';
  contentEl.style.display = 'block';

  const org = web.primaryOrg || web.orgs[0];
  document.getElementById('web-org-name').textContent = org.orgName || org.orgId || 'Organization';
  document.getElementById('web-tier').textContent = (org.subscriptionTier || '').replace(/_/g, ' ');
  document.getElementById('web-header-sub').textContent =
    `claude.ai · ${web.totalConversations} conversations · ${fmtTokens(web.conversationTokens)} tokens`;

  // Limit gauges
  const limitsEl = document.getElementById('web-limits');
  limitsEl.innerHTML = '';
  for (const lim of org.limits) {
    const warn = lim.percentage >= 90;
    const div = document.createElement('div');
    div.className = 'web-limit';
    div.innerHTML = `
      <div class="web-limit-head">
        <span class="web-limit-label">${lim.label}</span>
        <span class="web-limit-pct${warn ? ' warn' : ''}">${lim.percentage.toFixed(0)}%</span>
      </div>
      <div class="web-bar"><div class="web-bar-fill${warn ? ' warn' : ''}" style="width:${lim.percentage}%"></div></div>
      <div class="web-limit-reset">${fmtResetIn(lim.resetsAt)}</div>
    `;
    limitsEl.appendChild(div);
  }

  // Top conversations
  const tbody = document.getElementById('web-convos');
  tbody.innerHTML = '';
  for (const c of web.topConversations) {
    const id = (c.conversationId || '').slice(0, 8);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono dim" title="${c.conversationId || ''}">${id || '—'}</td>
      <td class="mono dim">${(c.model || '').replace('claude-', '')}</td>
      <td class="mono dim">${fmtTokens(c.length)}</td>
      <td class="mono dim">${c.cost || 0}</td>
      <td class="mono dim">${c.cached ? 'cached' : '—'}</td>
    `;
    tbody.appendChild(tr);
  }

  const staleEl = document.getElementById('web-stale');
  if (web.stale && web.dataNote) { staleEl.style.display = 'block'; staleEl.textContent = web.dataNote; }
  else staleEl.style.display = 'none';
}

// ── Render All ─────────────────────────────────────────────────────────────
function render(data) {
  usageData = data;
  renderOverview(data);
  renderClaude(data);
  renderSessions(data);
  renderWeb(data);
  checkCostAlert(data);

  const ts = new Date(data.timestamp);
  document.getElementById('last-updated').textContent =
    `Updated ${ts.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`;

  const total = data.claude?.totalTokens || 0;
  const cost  = data.claude?.estimatedCostUSD || 0;
  updateStatus(`* ${fmtTokens(total)} tokens · ${fmtCost(cost)}`);
}

// ── Idle ────────────────────────────────────────────────────────────────────
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (isIdle) dismissIdle();
  if (idleTimeout <= 0) return;
  idleTimer = setTimeout(showIdle, idleTimeout);
}

function showIdle() {
  isIdle = true;
  document.body.classList.add('app-idle');
  window.claudepix?.setCreatureState('idle');
}

function dismissIdle() {
  isIdle = false;
  document.body.classList.remove('app-idle');
  window.claudepix?.setCreatureState('idle');
}

// ── Settings ───────────────────────────────────────────────────────────────
async function openSettings() {
  const settings = await tm.getSettings();
  document.getElementById('s-refresh').value      = settings.refreshInterval || 60;
  document.getElementById('s-lookback').value     = settings.lookbackDays || 14;
  document.getElementById('s-claude-path').value  = settings.claudePath || '';
  document.getElementById('s-gemini-path').value  = settings.geminiPath || '';
  document.getElementById('s-idle-timeout').value = settings.idleTimeout || 60;
  document.getElementById('s-cost-alert').value   = settings.dailyCostAlert || 0;
  document.getElementById('s-session-summaries').value = settings.sessionSummaries === false ? '0' : '1';
  document.getElementById('settings-overlay').classList.add('visible');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('visible');
}

async function saveSettings() {
  const settings = {
    refreshInterval: parseInt(document.getElementById('s-refresh').value),
    lookbackDays:    parseInt(document.getElementById('s-lookback').value),
    claudePath:      document.getElementById('s-claude-path').value.trim(),
    geminiPath:      document.getElementById('s-gemini-path').value.trim(),
    idleTimeout:     parseInt(document.getElementById('s-idle-timeout').value),
    dailyCostAlert:  parseFloat(document.getElementById('s-cost-alert').value) || 0,
    sessionSummaries: document.getElementById('s-session-summaries').value === '1',
  };
  await tm.saveSettings(settings);
  currentSettings = { ...currentSettings, ...settings };
  if (settings.sessionSummaries) hyprSummariesAvailable = true; // re-probe if re-enabled
  idleTimeout = (settings.idleTimeout || 60) * 1000;
  resetIdleTimer();
  closeSettings();
  await refresh();
}

// ── Refresh ─────────────────────────────────────────────────────────────────
async function refresh() {
  const btn = document.getElementById('btn-refresh');
  btn.classList.add('spinning');
  updateStatus('* Scanning sessions…');
  window.claudepix?.setCreatureState('working');
  try {
    const data = await tm.getUsageData();
    if (data) {
      render(data);
      window.claudepix?.setCreatureState('idle');
    }
  } finally {
    btn.classList.remove('spinning');
  }
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  // Navigation (bottom nav + any data-page buttons)
  document.querySelectorAll('[data-page]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.page));
  });

  // Title bar controls
  document.getElementById('btn-close').addEventListener('click', () => tm.windowClose());
  document.getElementById('btn-minimize').addEventListener('click', () => tm.windowMinimize());
  document.getElementById('btn-maximize').addEventListener('click', () => tm.windowMaximize());
  document.getElementById('btn-refresh').addEventListener('click', refresh);

  // Settings
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('s-cancel').addEventListener('click', closeSettings);
  document.getElementById('s-save').addEventListener('click', saveSettings);
  document.getElementById('settings-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('settings-overlay')) closeSettings();
  });

  // Sessions surface (Hyprland overview) — delegated clicks + theme switch.
  const hyprRootEl = document.getElementById('hypr-root');
  hyprRootEl.addEventListener('click', hyprHandleClick);
  hyprRootEl.addEventListener('change', e => {
    if (e.target.id === 'hypr-theme-sel') {
      hyprTheme = e.target.value;
      applyHyprTheme(hyprRootEl, hyprTheme);
      tm.saveSettings({ sessionTheme: hyprTheme }).catch(() => {});
    }
  });

  // Dismiss idle on click anywhere in content
  document.getElementById('main-content').addEventListener('click', () => { if (isIdle) dismissIdle(); });
  document.addEventListener('mousemove', resetIdleTimer);
  document.addEventListener('keydown', e => {
    resetIdleTimer();
    if ((e.ctrlKey || e.metaKey) && e.key === 'r') { e.preventDefault(); refresh(); }
    hyprKeydown(e);
  });

  // Push updates from main process
  tm.onUsageUpdated(data => { render(data); });

  // Load settings
  try {
    const settings = await tm.getSettings();
    currentSettings = settings;
    idleTimeout = (settings.idleTimeout || 60) * 1000;
    if (settings.sessionTheme && HYPR_THEMES[settings.sessionTheme]) hyprTheme = settings.sessionTheme;
    if (typeof settings.sessionsShowClosed === 'boolean') hyprShowClosed = settings.sessionsShowClosed;
  } catch { /* use default */ }

  // Initial data load
  updateStatus('* Scanning sessions…');
  const loadingOverlay = document.getElementById('loading-overlay');
  try {
    const data = await tm.getUsageData();
    if (data) {
      render(data);
      window.claudepix?.setCreatureState('dance');
    }
  } finally {
    loadingOverlay.classList.add('hidden');
    setTimeout(() => { loadingOverlay.style.display = 'none'; }, 400);
  }

  // Start roaming creature after content loads
  setTimeout(() => window.claudepix?.initCreature(), 600);

  resetIdleTimer();
}

init();
