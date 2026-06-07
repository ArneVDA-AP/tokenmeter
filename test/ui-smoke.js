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

const settings = { refreshInterval: 0, lookbackDays: 14, claudePath: claudeProjects, geminiPath: '', webPath: webUsageFile, idleTimeout: 0, dailyCostAlert: 0 };
ipcMain.handle('get-usage-data', async () => scan(settings));
ipcMain.handle('get-settings', () => settings);
for (const c of ['save-settings', 'window-minimize', 'window-maximize', 'window-close', 'open-external', 'show-notification']) {
  ipcMain.handle(c, () => true);
}

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
  rec('overview sessions count = 67',
    (await $(win, "document.getElementById('ov-combined-sessions').textContent")) === '67');

  // 2. Claude page cache-hit metrics
  await $(win, "navigate('claude');1"); await wait(600);
  rec('cache hit rate shows a %',
    /%$/.test((await $(win, "document.getElementById('cl-cache-hit').textContent")).trim()));
  rec('project table has a Cache column header',
    (await $(win, "[...document.querySelectorAll('#page-claude th')].some(t=>/cache/i.test(t.textContent))")) === true);
  rec('cache trend chart canvas present',
    (await $(win, "!!document.getElementById('chart-cache-trend')")) === true);

  // 3. Sessions tab — defaults to live (active) sessions only
  await $(win, "navigate('sessions');1"); await wait(500);
  const liveWins = await $(win, "document.querySelectorAll('#hypr-root .hypr-win').length");
  rec('default view renders live sessions', liveWins > 0, `${liveWins} live`);
  rec('default view shows only active sessions',
    (await $(win, "[...document.querySelectorAll('#hypr-root .hypr-win')].every(w=>w.classList.contains('active'))")) === true);
  rec('waybar present',
    (await $(win, "!!document.querySelector('#hypr-root .hypr-bar')")) === true);
  rec('spawned sub-agent renders as a child window',
    (await $(win, "document.querySelectorAll('#hypr-root .hypr-child').length")) > 0, '');

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

  // 4b. Theme switcher repaints the scoped palette.
  const themed = await $(win, `(function(){
    var sel=document.getElementById('hypr-theme-sel'); sel.value='gruvbox'; sel.dispatchEvent(new Event('change',{bubbles:true}));
    return document.getElementById('hypr-root').dataset.hyprTheme==='gruvbox';
  })()`);
  rec('theme switcher applies a theme', themed === true);

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

  // 6. Web tab renders limit gauges + conversations from the fixture snapshot
  await $(win, "navigate('web');1"); await wait(500);
  const webLimits = await $(win, "document.querySelectorAll('#web-limits .web-limit').length");
  rec('web tab renders limit gauges', webLimits === 4, `${webLimits} gauges`);
  rec('web tab content visible (not empty state)',
    (await $(win, "getComputedStyle(document.getElementById('web-content')).display")) !== 'none');
  rec('web tab lists top conversations',
    (await $(win, "document.querySelectorAll('#web-convos tr').length")) > 0);
  rec('over-90% limit flagged as warn',
    (await $(win, "!!document.querySelector('#web-limits .web-limit-pct.warn')")) === true);

  rec('no console errors during run', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '');

  fs.rmSync(fixHome, { recursive: true, force: true });
  console.log(failed === 0 ? '\nUI smoke test passed.' : `\n${failed} UI check(s) failed.`);
  app.exit(failed === 0 ? 0 : 1);
});

app.on('window-all-closed', () => app.exit(failed === 0 ? 0 : 1));
