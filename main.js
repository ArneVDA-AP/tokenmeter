const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const Store = require('electron-store');
const { scan } = require('./src/scanner');
const { SUMMARY_MARKER } = require('./src/claude-parser');
const { getLiveSessionIds } = require('./src/live-sessions');

const store = new Store({ name: 'tokenmeter-config' });

let mainWindow = null;
let tray = null;
let refreshTimer = null;
let lastUsageData = null;
let liveCache = { t: 0, ids: new Set(), available: false };

const DEFAULT_SETTINGS = {
  refreshInterval: 60,
  lookbackDays: 14,
  claudePath: '',
  geminiPath: '',
  idleTimeout: 60,
  openAtLogin: false,
  dailyCostAlert: 0,
  appTheme: 'tokenmeter',    // App-level UI theme
  sessionTheme: 'nord',      // Hyprland theme for the Sessions overview surface
  sessionsShowClosed: false, // Sessions view: show ended sessions too (default: live only)
  sessionSummaries: true,    // Generate closed-session summaries via the local `claude -p` CLI
};

function fmtTokensTray(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

function createTrayImage() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4 + 0] = 232;
    buf[i * 4 + 1] = 101;
    buf[i * 4 + 2] = 10;
    buf[i * 4 + 3] = 255;
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(createTrayImage());
  tray.setToolTip('Tokenmeter');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Tokenmeter', click: () => mainWindow?.show() },
    { label: 'Refresh', click: () => runScan() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => mainWindow?.show());
}

function getSettings() {
  const stored = store.get('settings', {});
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  if (!stored.appTheme && stored.sessionTheme) merged.appTheme = stored.sessionTheme;
  return merged;
}

function createWindow() {
  const saved = store.get('windowBounds');
  const boundsOpts = {};
  if (saved) {
    if (Number.isFinite(saved.width) && saved.width >= 720) boundsOpts.width = saved.width;
    if (Number.isFinite(saved.height) && saved.height >= 560) boundsOpts.height = saved.height;
    if (Number.isFinite(saved.x)) boundsOpts.x = saved.x;
    if (Number.isFinite(saved.y)) boundsOpts.y = saved.y;
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    ...boundsOpts,
    frame: false,
    backgroundColor: '#07070d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    titleBarStyle: 'hidden',
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  let boundsTimer = null;
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMaximized()) {
        store.set('windowBounds', mainWindow.getBounds());
      }
    }, 400);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);
  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMaximized()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

async function runScan() {
  const settings = getSettings();
  try {
    const data = await scan(settings);

    // Annotate sessions with live (running) detection — cached ~5s
    try {
      const userProfile = process.env.USERPROFILE || os.homedir();
      const claudeHome = settings.claudePath
        ? path.dirname(settings.claudePath)
        : path.join(userProfile, '.claude');
      if (Date.now() - liveCache.t > 5000) {
        try {
          liveCache = { t: Date.now(), ...getLiveSessionIds({ claudeHome }) };
        } catch (_) {}
      }
      if (data && data.claude && data.claude.available !== false) {
        data.claude.runningDetection = liveCache.available;
        for (const s of (data.claude.sessions || [])) {
          s.running = liveCache.ids.has(s.id);
          for (const c of (s.childSessions || [])) c.running = s.running;
        }
      }
    } catch (_) {}

    lastUsageData = data;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('usage-updated', data);
    }
    if (tray) {
      const todayTokens = data.claude?.daily?.[data.claude.daily.length - 1]?.totalTokens || 0;
      tray.setToolTip(`Tokenmeter · Today: ${fmtTokensTray(todayTokens)} tokens`);
    }
    return data;
  } catch (e) {
    console.error('Scan error:', e);
    return lastUsageData;
  }
}

function startRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  const settings = getSettings();
  const intervalMs = (settings.refreshInterval || 60) * 1000;
  refreshTimer = setInterval(runScan, intervalMs);
}

// IPC handlers
ipcMain.handle('get-usage-data', async () => {
  return await runScan();
});

ipcMain.handle('get-settings', () => getSettings());

ipcMain.handle('save-settings', (_e, newSettings) => {
  store.set('settings', { ...getSettings(), ...newSettings });
  startRefreshTimer();
  return true;
});

ipcMain.handle('window-minimize', () => mainWindow?.minimize());
ipcMain.handle('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle('window-close', () => mainWindow?.close());
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

ipcMain.handle('show-notification', (_e, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});

// ── Closed-session summaries via the local Claude Code CLI (`claude -p`) ───────
// Uses the user's already-authenticated Claude Code install — no API key, no
// network config. Results are cached per session file (id:mtime) forever, and
// the prompts are marked so the parser excludes these throwaway runs.
let claudeCliState; // undefined = unchecked, true/false once probed

function ensureClaudeCli() {
  if (claudeCliState !== undefined) return Promise.resolve(claudeCliState);
  return new Promise(resolve => {
    execFile('claude', ['--version'], { shell: true, timeout: 8000 }, err => {
      claudeCliState = !err;
      resolve(claudeCliState);
    });
  });
}

function runClaudeSummary(digest) {
  // Static argv (no user content) + prompt via stdin — safe even with shell:true
  // (needed on Windows where `claude` is a .cmd shim).
  const prompt =
    `${SUMMARY_MARKER}\n` +
    `Summarize this Claude Code session in ONE short line (max 12 words), ` +
    `describing what was worked on. Output only the summary — no quotes, no preamble.\n\n` +
    `Task: ${digest.firstPrompt || '(unknown)'}\n` +
    `Activity:\n${(digest.lines || []).slice(0, 8).join('\n')}`;
  return new Promise((resolve, reject) => {
    let out = '', errOut = '';
    const child = spawn('claude', ['-p', '--model', 'haiku'], { shell: true, cwd: os.tmpdir() });
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 30000);
    child.stdout.on('data', d => { out += d; if (out.length > (1 << 20)) child.kill(); });
    child.stderr.on('data', d => { errOut += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !out) return reject(new Error(errOut.trim() || ('exit ' + code)));
      let s = out.split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
      s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
      if (s.length > 140) s = s.slice(0, 139) + '…';
      resolve(s);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

ipcMain.handle('summarize-session', async (_e, digest) => {
  if (!digest || !digest.id) return { available: false };
  if (getSettings().sessionSummaries === false) return { available: false };

  const key = `${digest.id}:${digest.mtime}`;
  const cache = store.get('summaryCache', {});
  if (cache[key]) return { summary: cache[key], cached: true };

  if (!(await ensureClaudeCli())) return { available: false };
  try {
    const summary = await runClaudeSummary(digest);
    if (summary) {
      cache[key] = summary;
      store.set('summaryCache', cache);
      return { summary };
    }
    return { summary: null };
  } catch (e) {
    return { error: String(e && e.message || e), available: claudeCliState };
  }
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  startRefreshTimer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
