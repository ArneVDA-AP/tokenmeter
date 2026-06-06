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
  idleTimeout: 0, dailyCostAlert: 0,
};

// Minimal IPC stand-ins matching preload.js / main.js.
ipcMain.handle('get-usage-data', async () => scan(settings));
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('save-settings', () => true);
ipcMain.handle('window-minimize', () => {});
ipcMain.handle('window-maximize', () => {});
ipcMain.handle('window-close', () => {});
ipcMain.handle('open-external', () => {});
ipcMain.handle('show-notification', () => {});

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
  await go('sessions'); await wait(800); await shot('3-sessions');
  await go('web');      await wait(700); await shot('5-web');

  // Resize to a normal window for a readable, prominent modal capture.
  win.setContentSize(900, 760);
  await wait(400);
  await go('sessions'); await wait(500);
  // Open the detail for the most recent session that used multiple models.
  const state = await win.webContents.executeJavaScript(`(function(){
    var ss = (usageData && usageData.claude && usageData.claude.sessions) || [];
    var s = ss.find(function(x){ return Object.keys(x.models||{}).length > 1; }) || ss[0];
    if (!s) return { ok:false, reason:'no sessions' };
    try { renderSessionDetail(s); }
    catch (e) { return { ok:false, reason:String(e) }; }
    return { ok: document.getElementById('session-detail-overlay').classList.contains('visible'), id: s.id };
  })();`);
  console.log('detail state:', JSON.stringify(state));
  await wait(900); await shot(state && state.ok ? '4-session-detail' : '4-session-detail-FAIL');

  fs.rmSync(fixHome, { recursive: true, force: true });
  app.quit();
});

app.on('window-all-closed', () => app.quit());
