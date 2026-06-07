// Automated UI smoke test. Launches the real renderer in Electron (run under
// xvfb), feeds generated fixtures via the same IPC surface, then drives the UI
// and asserts the key Phase 1 behaviour: overview populated, cache-hit metrics
// shown, Sessions list renders, row click opens the detail pane, filtering works.
// Exits non-zero on any failure.  Run: xvfb-run -a npm run test:ui

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { scan } = require('../src/scanner');
const { gen, genWebUsage } = require('./lib/genFixtures');

app.commandLine.appendSwitch('no-sandbox');

const fixHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-uismoke-'));
const claudeProjects = path.join(fixHome, '.claude', 'projects');
fs.mkdirSync(claudeProjects, { recursive: true });
gen(claudeProjects);
const webUsageFile = path.join(fixHome, 'web-usage.json');
genWebUsage(webUsageFile);

const settings = { refreshInterval: 0, lookbackDays: 14, claudePath: claudeProjects, geminiPath: '', webPath: webUsageFile, idleTimeout: 0, dailyCostAlert: 0, appTheme: 'tokenmeter' };
// Mimic main.js's live-session annotation: mark ONLY one root session as running.
// Prefer the newest session that has child sessions (so "spawned sub-agent renders
// as a child window" can pass); fall back to the overall newest if none have children.
// This proves "active" is process-driven, not mtime-driven — the second-most-recent
// session also has a fresh mtime but must stay hidden.
ipcMain.handle('get-usage-data', async () => {
  const data = await scan(settings);
  if (data.claude && Array.isArray(data.claude.sessions)) {
    data.claude.runningDetection = true;
    const sorted = data.claude.sessions.slice().sort((a, b) => b.mtime - a.mtime);
    const withKids = sorted.find(s => (s.childSessions || []).length > 0);
    const chosen = withKids || sorted[0];
    const runId = chosen ? chosen.id : null;
    for (const s of data.claude.sessions) {
      s.running = s.id === runId;
      for (const c of (s.childSessions || [])) c.running = s.running;
    }
  }
  return data;
});
ipcMain.handle('get-settings', () => settings);
for (const c of ['save-settings', 'window-minimize', 'window-maximize', 'window-close', 'open-external', 'show-notification']) {
  ipcMain.handle(c, () => true);
}
ipcMain.handle('summarize-session', () => ({ available: false })); // no claude CLI in CI

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const consoleErrors = [];
function rec(name, ok, info) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`);
}
const $ = (win, js) => win.webContents.executeJavaScript(js);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 820, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) consoleErrors.push(message); // 3 = error
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.showInactive(); // visible doc so CSS transitions run
  await wait(3500);

  // 1. Overview populated
  rec('overview total tokens populated',
    /\d/.test(await $(win, "document.getElementById('ov-total-tokens').textContent")));
  rec('overview Claude cost chip contains $',
    /\$/.test(await $(win, "document.getElementById('ov-cost-claude').textContent")));
  rec('overview Web cost chip contains $',
    /\$/.test(await $(win, "document.getElementById('ov-cost-web').textContent")));
  rec('overview Combined cost chip contains $',
    /\$/.test(await $(win, "document.getElementById('ov-cost-total').textContent")));
  rec('overview web row present',
    (await $(win, "!!document.getElementById('ov-web-card')")) === true);

  // 2. Claude page cache-hit metrics
  await $(win, "navigate('claude');1"); await wait(600);
  rec('cache hit rate shows a %',
    /%$/.test((await $(win, "document.getElementById('cl-cache-hit').textContent")).trim()));
  rec('project table has a Cache column header',
    (await $(win, "[...document.querySelectorAll('#page-claude th')].some(t=>/cache/i.test(t.textContent))")) === true);
  rec('cache trend chart canvas present',
    (await $(win, "!!document.getElementById('chart-cache-trend')")) === true);

  // 2b. Sub-agent Usage section on Claude page
  rec('sub-agent usage heading present',
    (await $(win, "[...document.querySelectorAll('#page-claude .section-heading')].some(h=>/sub-agent/i.test(h.textContent))")) === true);
  rec('#cl-agent-tbody exists and has at least one row',
    (await $(win, "document.querySelectorAll('#cl-agent-tbody tr').length > 0")) === true);

  // 3. Sessions tab — defaults to live (active = running process) sessions only
  await $(win, "navigate('sessions');1"); await wait(500);
  const live = await $(win, `(function(){
    return {
      wins: document.querySelectorAll('#hypr-root .hypr-win').length,
      branches: document.querySelectorAll('#hypr-root .hypr-branch').length,
      rootsActive: [...document.querySelectorAll('#hypr-root .hypr-win')].filter(w=>!w.closest('.hypr-child')).every(w=>w.classList.contains('active')),
      children: document.querySelectorAll('#hypr-root .hypr-child').length,
    };
  })()`);
  rec('default view renders the running session', live.wins > 0, `${live.wins} wins`);
  rec('only running sessions shown (recent-but-not-running hidden)', live.branches === 1, `${live.branches} root(s)`);
  rec('every shown root session is marked active', live.rootsActive === true);
  rec('waybar present',
    (await $(win, "!!document.querySelector('#hypr-root .hypr-bar')")) === true);
  rec('spawned sub-agent renders as a child window', live.children > 0, `${live.children}`);

  // 3b. Toggle reveals closed sessions, which carry a short summary line.
  const toggled = await $(win, `(function(){
    var before=document.querySelectorAll('#hypr-root .hypr-win').length;
    document.querySelector('#hypr-root [data-toggle-closed]').click();
    return { before:before,
      after:document.querySelectorAll('#hypr-root .hypr-win').length,
      summaries:document.querySelectorAll('#hypr-root .hypr-summary').length,
      sections:document.querySelectorAll('#hypr-root .hypr-section-head').length };
  })()`);
  rec('toggle reveals closed sessions', toggled.after > toggled.before, `${toggled.before}→${toggled.after}`);
  rec('closed sessions show a short summary', toggled.summaries > 0, `${toggled.summaries} summaries`);
  rec('sessions grouped into workspace sections', toggled.sections > 0);

  // 4. Click a window → detail panel slides in, fully populated (6 stat cards).
  const opened = await $(win, `(function(){
    var w=document.querySelector('#hypr-root .hypr-win'); if(!w) return false;
    w.click();
    var d=document.getElementById('hypr-detail');
    return d.classList.contains('open')
      && !!d.querySelector('.hypr-stats')
      && d.querySelectorAll('.hypr-stat').length===6
      && d.querySelectorAll('.hypr-doutput .ln').length>0;
  })()`);
  rec('window click opens populated detail panel', opened === true);
  const closed = await $(win, "document.getElementById('hypr-detail-x').click(); !document.getElementById('hypr-detail').classList.contains('open')");
  rec('close button hides the detail panel', closed === true);

  // 4b. Theme switch in Settings repaints the WHOLE app via :root vars.
  await $(win, `(function(){
    openSettings();
    document.getElementById('s-theme').value='gruvbox';
    document.getElementById('s-save').click();
  })();1`);
  await wait(600);
  const themeOk = await $(win, `(function(){
    var ds=document.documentElement.dataset.theme;
    var bg=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toLowerCase();
    return ds==='gruvbox' && bg==='#282828';
  })()`);
  rec('Settings theme switch recolors whole app (:root)', themeOk === true);

  // 5. Workspace filter narrows the grid to a single project (section headers drop).
  const narrowed = await $(win, `(function(){
    var btn=document.querySelector('#hypr-root .hypr-strip-btn[data-ws]:not([data-ws="all"])');
    if(!btn) return false;
    btn.click();
    var wins=document.querySelectorAll('#hypr-root .hypr-win[data-sid]').length;
    var noSections=document.querySelectorAll('#hypr-root .hypr-section-head').length===0;
    return wins>0 && noSections;
  })()`);
  rec('workspace filter narrows to one project', narrowed === true);

  // 5b. Expo (workspace overview) opens and is enterable.
  const expoOpen = await $(win, `(function(){
    document.querySelector('#hypr-root [data-expo]').click();
    return !!document.getElementById('hypr-expo')
      && document.querySelectorAll('#hypr-expo .hypr-expo-tile').length>0;
  })()`);
  rec('expo opens with workspace tiles', expoOpen === true);
  const expoEnter = await $(win, `(function(){
    var tile=document.querySelector('#hypr-expo .hypr-expo-tile[data-ws]'); if(!tile) return false;
    tile.click();
    return !document.getElementById('hypr-expo');
  })()`);
  rec('expo tile click enters workspace + closes expo', expoEnter === true);

  // 6. Web tab renders limit gauges + conversations + rich content from the fixture snapshot
  await $(win, "navigate('web');1"); await wait(500);
  const webLimits = await $(win, "document.querySelectorAll('#web-limits .web-limit').length");
  rec('web tab renders limit gauges', webLimits === 4, `${webLimits} gauges`);
  rec('web tab content visible (not empty state)',
    (await $(win, "getComputedStyle(document.getElementById('web-content')).display")) !== 'none');
  rec('web tab lists top conversations',
    (await $(win, "document.querySelectorAll('#web-convos tr').length")) > 0);
  rec('over-90% limit flagged as warn',
    (await $(win, "!!document.querySelector('#web-limits .web-limit-pct.warn')")) === true);
  rec('web daily chart canvas present',
    (await $(win, "!!document.getElementById('chart-web-daily')")) === true);
  rec('web peak hours chart canvas present',
    (await $(win, "!!document.getElementById('chart-web-peak')")) === true);
  rec('web model breakdown table has rows',
    (await $(win, "document.querySelectorAll('#web-model-tbody tr').length > 0")) === true);
  rec('web stat chips populated (conversations)',
    /\d/.test(await $(win, "document.getElementById('web-conversations').textContent")));
  rec('web stat chip Est. Cost contains $',
    /\$/.test(await $(win, "document.getElementById('web-est-cost').textContent")));
  rec('web insight card (cache savings) present',
    (await $(win, "document.querySelectorAll('#page-web .insight-card').length > 0")) === true);

  // 2d. Web UNAVAILABLE path — the common case until the mirror is set up.
  // renderOverview + renderWeb must not throw, the empty state must show, and the
  // overview web row must read "Not Connected". Restores real data afterwards.
  const unavail = await $(win, `(function(){
    try {
      var d = Object.assign({}, usageData);
      d.web = { available:false, dataNote:'No web-usage data found.' };
      d.combined = Object.assign({}, d.combined, { webCost:0, webTokens:0, totalCost:(d.combined.claudeCost||0) });
      renderOverview(d); renderWeb(d);
      var emptyShown = getComputedStyle(document.getElementById('web-empty')).display !== 'none';
      var contentHidden = getComputedStyle(document.getElementById('web-content')).display === 'none';
      var notConnected = /not connected/i.test(document.getElementById('ov-web-status').textContent);
      renderOverview(usageData); renderWeb(usageData); // restore live data
      return emptyShown && contentHidden && notConnected;
    } catch (e) { return 'THREW: ' + e.message; }
  })()`);
  rec('web unavailable path: renderers do not throw + empty state shown', unavail === true,
    typeof unavail === 'string' ? unavail : '');

  rec('no console errors during run', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '');

  fs.rmSync(fixHome, { recursive: true, force: true });
  console.log(failed === 0 ? '\nUI smoke test passed.' : `\n${failed} UI check(s) failed.`);
  app.exit(failed === 0 ? 0 : 1);
});

app.on('window-all-closed', () => app.exit(failed === 0 ? 0 : 1));
