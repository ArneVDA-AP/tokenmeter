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
const { gen } = require('./lib/genFixtures');

app.commandLine.appendSwitch('no-sandbox');

const fixHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-uismoke-'));
const claudeProjects = path.join(fixHome, '.claude', 'projects');
fs.mkdirSync(claudeProjects, { recursive: true });
gen(claudeProjects);

const settings = { refreshInterval: 0, lookbackDays: 14, claudePath: claudeProjects, geminiPath: '', idleTimeout: 0, dailyCostAlert: 0 };
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

  // 3. Sessions tab
  await $(win, "navigate('sessions');1"); await wait(500);
  const rowCount = await $(win, "document.querySelectorAll('#se-list .tmux-row').length");
  rec('sessions list renders rows', rowCount > 0, `${rowCount} rows`);
  rec('tmux status summary populated',
    /sessions/.test(await $(win, "document.getElementById('se-status-summary').textContent")));

  // 4. Row click opens detail pane
  const opened = await $(win, `(function(){
    var r=document.querySelector('#se-list .tmux-row'); if(!r) return false;
    r.click();
    var ov=document.getElementById('session-detail-overlay');
    return ov.classList.contains('visible')
      && document.getElementById('sd-stats').children.length>0
      && document.getElementById('sd-models').children.length>0;
  })()`);
  rec('row click opens populated detail pane', opened === true);
  await $(win, "closeSessionDetail();1");

  // 5. Filtering narrows the list
  const narrowed = await $(win, `(function(){
    var sel=document.getElementById('se-project');
    var opt=[...sel.options].find(o=>o.value==='Home'); if(!opt) return false;
    sel.value='Home'; sel.dispatchEvent(new Event('change'));
    var rows=[...document.querySelectorAll('#se-list .tmux-row .tmux-name')];
    return rows.length>0 && rows.every(n=>n.textContent.trim()==='Home');
  })()`);
  rec('project filter narrows to selected project', narrowed === true);

  rec('no console errors during run', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '');

  fs.rmSync(fixHome, { recursive: true, force: true });
  console.log(failed === 0 ? '\nUI smoke test passed.' : `\n${failed} UI check(s) failed.`);
  app.exit(failed === 0 ? 0 : 1);
});

app.on('window-all-closed', () => app.exit(failed === 0 ? 0 : 1));
