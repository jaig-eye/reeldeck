// Reeldeck — Electron main process.
// Serves the static app over a private loopback origin (better embed
// compatibility than file://) and hosts it in a hardened BrowserWindow.
// Because it's its own process/executable, Surfshark "Bypasser"
// (split tunneling) can route ONLY this app through the VPN.

const { app, BrowserWindow, shell, Menu, session, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.join(__dirname, '..'); // the moviestream folder (index.html, app.js, styles.css)

// Silence the harmless GPU shader-cache warnings on Windows.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2'
};

// Tiny static file server bound to 127.0.0.1. Uses a STABLE port so the origin
// (and therefore localStorage: watchlist + settings) persists across launches.
// Falls back to the next port only if one is already taken.
const PREFERRED_PORTS = Array.from({ length: 30 }, (_, i) => 43110 + i);

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent((req.url || '/').split('?')[0]);
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.normalize(path.join(ROOT, rel));
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
      });
    });
    let idx = 0;
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && idx < PREFERRED_PORTS.length - 1) { idx++; server.listen(PREFERRED_PORTS[idx], '127.0.0.1'); }
      else reject(e);
    });
    server.on('listening', () => resolve(PREFERRED_PORTS[idx]));
    server.listen(PREFERRED_PORTS[idx], '127.0.0.1');
  });
}

// Network-layer ad blocking (EasyList/uBlock filters via Ghostery's engine).
// This is what actually removes the pop-under/redirect ads: their requests are
// dropped before they load. The video stream comes from a different (non-ad)
// host, so playback is unaffected — and because we DON'T sandbox the iframe,
// providers don't throw "Iframe Sandbox Detected".
async function setupAdblock() {
  try {
    const { ElectronBlocker } = await import('@ghostery/adblocker-electron');
    const cachePath = path.join(app.getPath('userData'), 'adblocker-engine.bin');
    const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cachePath,
      read: fs.promises.readFile,
      write: fs.promises.writeFile
    });
    blocker.enableBlockingInSession(session.defaultSession);
    console.log('[reeldeck] ad blocker active');
  } catch (e) {
    console.warn('[reeldeck] ad blocker unavailable (video still works):', e && e.message);
  }
}

// Security hardening around the third-party embeds. They already run in a
// sandboxed, context-isolated renderer (no Node, no filesystem access). On top:
//  - block EVERY download so an embed can't drop a file on disk (no drive-by installs)
//  - deny every permission request (camera, mic, geolocation, notifications, USB…)
// Combined with the ad/tracker/malware-domain blocker, this is what keeps embed
// junk from reaching the machine.
function setupSecurity() {
  const ses = session.defaultSession;
  ses.on('will-download', (e) => { e.preventDefault(); });                 // no downloads, ever
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(false));      // deny all requests
  ses.setPermissionCheckHandler(() => false);
  if (ses.setDevicePermissionHandler) ses.setDevicePermissionHandler(() => false);
}

// Auto-update via the GitHub Releases we publish to. Only runs in an installed
// build; downloads in the background and applies on quit. Renderer shows a toast.
function setupUpdater() {
  if (!app.isPackaged) return;
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const send = (data) => { if (win && !win.isDestroyed()) win.webContents.send('reeldeck:update', data); };
    autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
    autoUpdater.on('update-available', (i) => send({ state: 'available', version: i && i.version }));
    autoUpdater.on('update-not-available', () => send({ state: 'none' }));
    autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (i) => send({ state: 'ready', version: i && i.version }));
    autoUpdater.on('error', (err) => { send({ state: 'error', message: err && err.message }); console.warn('[reeldeck] updater:', err && err.message); });
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  } catch (e) { console.warn('[reeldeck] updater unavailable:', e && e.message); }
}

let win;

async function createWindow() {
  let url;
  try {
    const port = await startServer();
    url = `http://127.0.0.1:${port}/`;
  } catch (e) {
    // Fallback: load straight from disk if the loopback server can't bind.
    url = 'file://' + path.join(ROOT, 'index.html');
  }

  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'Reeldeck',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // DENY every window.open — no exceptions, nothing opened externally.
  // With the iframe sandbox off (so providers play), clicking the player can
  // trigger window.open to an ad page; this is what stops that page from ever
  // opening. The app's own "Open in browser" uses the trusted IPC path below,
  // NOT window.open, so it is unaffected.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Block the other click-ad vector: a framed player navigating the whole app
  // to an ad URL. Keep navigation inside our origin; drop anything else silently
  // (do NOT open it externally).
  const guardNav = (e, target) => { if (target && !target.startsWith(url)) e.preventDefault(); };
  win.webContents.on('will-navigate', guardNav);
  if (win.webContents.on) win.webContents.on('will-frame-navigate', (e) => {
    // Allow the player iframe's own navigations (its stream/CDN), but block it
    // from navigating the TOP frame away from the app.
    if (e.isMainFrame && e.url && !e.url.startsWith(url)) e.preventDefault();
  });

  Menu.setApplicationMenu(null);
  win.loadURL(url);
}

// Trusted external-open channel — only the app's own top-frame code can call it
// (the cross-origin player iframe never gets the preload bridge).
ipcMain.handle('reeldeck:open-external', (e, target) => {
  if (typeof target === 'string' && /^https?:\/\//i.test(target)) shell.openExternal(target);
});

// Renderer asks to apply a downloaded update now.
ipcMain.handle('reeldeck:install-update', () => { try { autoUpdater.quitAndInstall(); } catch (e) {} });
// Renderer asks to check for updates now (Settings button).
ipcMain.handle('reeldeck:check-update', () => { try { autoUpdater.checkForUpdates(); } catch (e) {} });

// Single instance: focus the existing window instead of launching a second copy
// (also avoids cache/port contention).
if (!app.requestSingleInstanceLock()) {
  app.quit();  // another Reeldeck instance already running
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    try {
      setupSecurity();  // set session handlers before any content loads
      setupAdblock();   // runs in parallel; ready well before the user opens a player
      await createWindow();
      setupUpdater();   // needs the window for update toasts
    } catch (e) {
      console.error('[reeldeck] startup error:', (e && e.stack) || e);
    }
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
