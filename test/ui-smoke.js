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

  // 4b. Detail pane title reflects the clicked session, and close hides it.
  rec('detail title shows project / id',
    /\w+\s*\/\s*\w+/.test(await $(win, "document.getElementById('sd-title').textContent")));
  const closed = await $(win, "closeSessionDetail(); !document.getElementById('session-detail-overlay').classList.contains('visible')");
  rec('closeSessionDetail hides the overlay', closed === true);

  // 4c. Sorting by tokens puts the highest-token session first.
  const sortOk = await $(win, `(function(){
    var sessions = usageData.claude.sessions || [];
    var maxId = sessions.slice().sort((a,b)=>b.totalTokens-a.totalTokens)[0].id;
    var sel=document.getElementById('se-sort'); sel.value='tokens'; sel.dispatchEvent(new Event('change'));
    var first=document.querySelector('#se-list .tmux-row');
    return first && first.dataset.sessionId === maxId;
  })()`);
  rec('sort by tokens orders highest first', sortOk === true);
  await $(win, "document.getElementById('se-sort').value='recent'; document.getElementById('se-sort').dispatchEvent(new Event('change')); 1");

  // 4d. Text filter narrows to matching projects.
  const textOk = await $(win, `(function(){
    var inp=document.getElementById('se-filter-text'); inp.value='burnlink'; inp.dispatchEvent(new Event('input'));
    var names=[...document.querySelectorAll('#se-list .tmux-row .tmux-name')];
    var ok = names.length>0 && names.every(n=>n.textContent.toLowerCase().includes('burnlink'));
    inp.value=''; inp.dispatchEvent(new Event('input'));
    return ok;
  })()`);
  rec('text filter narrows to matching project', textOk === true);

  // 5. Filtering narrows the list
  const narrowed = await $(win, `(function(){
    var sel=document.getElementById('se-project');
    var opt=[...sel.options].find(o=>o.value==='Home'); if(!opt) return false;
    sel.value='Home'; sel.dispatchEvent(new Event('change'));
    var rows=[...document.querySelectorAll('#se-list .tmux-row .tmux-name')];
    return rows.length>0 && rows.every(n=>n.textContent.trim()==='Home');
  })()`);
  rec('project filter narrows to selected project', narrowed === true);

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
