// Headless UI screenshot harness. Launches the real renderer in Electron (under
// xvfb), feeds it generated fixture data through the same IPC surface main.js
// exposes, then captures a PNG of each page + a session-detail pane.
//
//   xvfb-run -a npm run screenshots   →   test/shots/*.png
//
// Used for manual/agent UX review since the renderer can't run in a plain
// headless container without a display.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { scan } = require('../src/scanner');
const { gen, genWebUsage } = require('./lib/genFixtures');

app.commandLine.appendSwitch('no-sandbox');

// Build fixtures in a temp HOME and point the scanner at them.
const fixHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-uifix-'));
const claudeProjects = path.join(fixHome, '.claude', 'projects');
fs.mkdirSync(claudeProjects, { recursive: true });
gen(claudeProjects);
const webUsageFile = path.join(fixHome, 'web-usage.json');
genWebUsage(webUsageFile);

const settings = {
  refreshInterval: 0, lookbackDays: 14,
  claudePath: claudeProjects, geminiPath: '', webPath: webUsageFile,
  idleTimeout: 0, dailyCostAlert: 0, appTheme: 'tokenmeter',
};

// Minimal IPC stand-ins matching preload.js / main.js. Annotate running sessions
// (mimic main.js) so the live view shows the active fixtures.
ipcMain.handle('get-usage-data', async () => {
  const data = await scan(settings);
  if (data.claude && Array.isArray(data.claude.sessions)) {
    data.claude.runningDetection = true;
    const now = Date.now();
    for (const s of data.claude.sessions) {
      s.running = (now - Math.max(s.mtime || 0, s.endTime || 0)) < 10 * 60 * 1000;
      for (const c of (s.childSessions || [])) c.running = s.running;
    }
  }
  return data;
});
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('save-settings', () => true);
ipcMain.handle('window-minimize', () => {});
ipcMain.handle('window-maximize', () => {});
ipcMain.handle('window-close', () => {});
ipcMain.handle('open-external', () => {});
ipcMain.handle('show-notification', () => {});
ipcMain.handle('summarize-session', () => ({ available: false }));

const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 860, height: 2000, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Show (without focus) so the document is visible — Chromium freezes CSS
  // transitions in hidden documents, which would leave overlays at opacity 0.
  win.showInactive();
  await wait(4000); // local Chart.js + fonts + initial scan + creature intro

  async function shot(name) {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    console.log('captured', name);
  }
  const go = (page) => win.webContents.executeJavaScript(`navigate('${page}');1`);

  await go('overview'); await wait(800); await shot('1-overview');
  await go('claude');   await wait(1100); await shot('2-claude');
  await go('sessions'); await wait(700); await shot('3-sessions-live'); // default: live only
  await win.webContents.executeJavaScript("hyprShowClosed=true; renderSessions(usageData);1");
  await wait(600); await shot('3-sessions'); // toggled: all sessions + summaries
  await go('web');      await wait(700); await shot('5-web');

  // Resize to a normal window for a readable, prominent modal capture.
  win.setContentSize(900, 760);
  await wait(400);
  await go('sessions'); await wait(500);
  // Open the detail for a recent session that spawned a sub-agent (richest panel).
  const state = await win.webContents.executeJavaScript(`(function(){
    var ss = (usageData && usageData.claude && usageData.claude.sessions) || [];
    var s = ss.find(function(x){ return (x.childSessions||[]).length>0; })
         || ss.find(function(x){ return Object.keys(x.models||{}).length>1; }) || ss[0];
    if (!s) return { ok:false, reason:'no sessions' };
    hyprDetailId = s.id; hyprFocused = s.id;
    try { renderSessions(usageData); }
    catch (e) { return { ok:false, reason:String(e) }; }
    return { ok: document.getElementById('hypr-detail').classList.contains('open'), id: s.id };
  })();`);
  console.log('detail state:', JSON.stringify(state));
  await wait(900); await shot(state && state.ok ? '4-session-detail' : '4-session-detail-FAIL');

  // Expo (workspace overview) capture.
  await win.webContents.executeJavaScript(`(function(){ hyprDetailId=null; hyprExpo=false; renderSessions(usageData); })();`);
  await win.webContents.executeJavaScript(`(function(){ hyprExpo=true; renderSessions(usageData); })();`);
  await wait(700); await shot('3b-expo');

  // Themed capture — verify app-wide theming recolors chrome, charts AND heatmap.
  win.setContentSize(860, 2000); await wait(300);
  await win.webContents.executeJavaScript("hyprExpo=false; window.applyTheme('nord');1");
  await go('overview'); await wait(800); await shot('6-overview-nord');
  await go('claude');   await wait(1000); await shot('7-claude-nord');

  fs.rmSync(fixHome, { recursive: true, force: true });
  app.quit();
});

app.on('window-all-closed', () => app.quit());
