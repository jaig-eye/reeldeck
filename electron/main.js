// Reeldeck — Electron main process.
// Serves the static app over a private loopback origin (better embed
// compatibility than file://) and hosts it in a hardened BrowserWindow.
// Because it's its own process/executable, Surfshark "Bypasser"
// (split tunneling) can route ONLY this app through the VPN.

const { app, BrowserWindow, shell, Menu, session, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
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

// Memoised. On macOS, closing the window does NOT quit the app (window-all-closed
// deliberately skips app.quit() on darwin, which is the platform convention), so
// clicking the dock icon later fires 'activate' -> createWindow() -> startServer().
// Without this cache that second call finds 43110 still bound, falls through to 43111,
// and the app reopens on a DIFFERENT ORIGIN -- at which point localStorage is empty and
// the watchlist, history, resume points and the signed-in account have all apparently
// vanished. The comment above about a fixed port preserving localStorage is exactly
// what that path defeats.
let serverPromise = null;
function startServer() {
  if (serverPromise) return serverPromise;
  serverPromise = new Promise((resolve, reject) => {
    // A throw out of a request listener is an UNCAUGHT exception: Node does not turn
    // it into a 500, and Electron's default handler pops a MODAL error box that
    // freezes the window until it is dismissed. Both inputs below are attacker
    // reachable -- the loopback port is one of 30 fixed values and the framed players
    // are deliberately not sandboxed -- so every one of them is guarded, and the whole
    // handler is wrapped as a backstop.
    const serveFile = (req, res) => {
      let rel;
      try { rel = decodeURIComponent((req.url || '/').split('?')[0]); }
      catch (e) { res.writeHead(400); return res.end('Bad request'); }   // e.g. GET /%
      // path.join/normalize preserve NUL, and fs.readFile throws synchronously on it.
      if (rel.indexOf('\0') >= 0) { res.writeHead(400); return res.end('Bad request'); }
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.normalize(path.join(ROOT, rel));
      // startsWith(ROOT) is string containment, not path containment: it also admits
      // SIBLINGS, so "<root>-backup/notes.txt" passed. Compare as a path.
      const inside = path.relative(ROOT, file);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
        res.writeHead(403); return res.end('Forbidden');
      }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
      });
    };
    const server = http.createServer((req, res) => {
      try { serveFile(req, res); }
      catch (e) { try { res.writeHead(500); res.end('Server error'); } catch (e2) {} }
    });
    let idx = 0;
    server.on('error', (e) => {
      // ANY bind failure advances the ladder, not just EADDRINUSE. EACCES is the one
      // that actually bites: a reserved port range or a security product blocks the
      // bind, the ladder gave up on the first one, and the app silently dropped to
      // file:// -- a DIFFERENT ORIGIN, where localStorage is empty and the watchlist,
      // history and signed-in account all appear to have vanished.
      if (idx < PREFERRED_PORTS.length - 1) { idx++; server.listen(PREFERRED_PORTS[idx], '127.0.0.1'); }
      else reject(e);
    });
    server.on('listening', () => resolve(PREFERRED_PORTS[idx]));
    server.listen(PREFERRED_PORTS[idx], '127.0.0.1');
  });
  // A failed bind must not be cached: the fallback is file://, and retrying on the
  // next activate is better than pinning the app to a rejected promise forever.
  serverPromise.catch(() => { serverPromise = null; });
  return serverPromise;
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
  // Deny-all also denied 'fullscreen', which is a permission -- so NO frame could ever
  // go fullscreen, and the request never settled (it hung rather than rejecting, so
  // the .catch() in app.js never fired and one denial poisoned the document's
  // fullscreen state until reload). Clipboard-write was collateral: the Get-app screen
  // said "Copied" while the write rejected asynchronously. Grant exactly these two;
  // camera, mic, geolocation, notifications, MIDI, USB and downloads stay denied, and
  // neither grant gives a framed player any reach into the machine.
  ses.setPermissionRequestHandler((wc, permission, cb) =>
    cb(permission === 'fullscreen' || permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler(() => false);
  if (ses.setDevicePermissionHandler) ses.setDevicePermissionHandler(() => false);
}

// Auto-update via the GitHub Releases we publish to. Only runs in an installed
// build; downloads in the background and applies on quit. Renderer shows a toast.
/** Deliver to the renderer once it EXISTS. setupUpdater runs immediately after
 *  createWindow, which returns as soon as loadURL is called -- the page has not parsed
 *  its preload bridge yet, so a send() here goes nowhere. Both early-return branches
 *  below (portable, macOS) relied on it, so their "there is a new version, download it"
 *  notice was silently dropped every time. */
function tellRenderer(payload) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', () => {
    if (win && !win.isDestroyed()) win.webContents.send('reeldeck:update', payload);
  });
  else wc.send('reeldeck:update', payload);
}

// Whether setupUpdater actually wired the autoUpdater. The two early returns below
// (portable, macOS) leave it with NO listeners and default settings, while the
// 'Check for updates' menu item and its IPC handler are registered unconditionally --
// so pressing it called checkForUpdates() into a void and the UI sat on "Checking for
// updates…" for ever, with no event able to clear it.
let updaterLive = false;
function setupUpdater() {
  if (!app.isPackaged) return;
  // electron-builder sets this only for the PORTABLE build. Its update feed points at
  // the NSIS web installer, so "Restart & update" would install a SECOND, installed
  // copy and leave the portable exe running and stale. A portable build is meant to be
  // replaced by downloading a new one, so say that instead of pretending.
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    tellRenderer({ state: 'portable' });
    return;
  }
  // Squirrel.Mac refuses to apply an update to an app without a valid code signature,
  // and these builds are unsigned. Left alone the updater still DETECTS the release,
  // fires update-available, then fails the handoff and fires error -- an
  // available-then-failed pair every six hours, for ever, that the user can do nothing
  // about. Reuse the same honest state the portable build uses: there is a new
  // version, go and download it. Delete this the day the build is signed.
  if (process.platform === 'darwin') {
    tellRenderer({ state: 'portable' });
    return;
  }
  updaterLive = true;
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
    // pathToFileURL, not string concatenation. The drive letter and spaces both
    // survive concatenation (the URL parser normalises them), but '#' and '?' do not:
    // an install under a path containing either -- a Windows username may contain '#'
    // -- has everything after it swallowed as a fragment or query, so the one route
    // that exists to rescue a failed bind loads the wrong file. Measured, not assumed:
    //   concat  file:///C:/Users/bob/reel#deck\index.html   <- truncated at '#'
    //   proper  file:///C:/Users/bob/reel%23deck/index.html
    url = pathToFileURL(path.join(ROOT, 'index.html')).href;
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

  // On Windows and Linux the menu bar is pure chrome and removing it is right. On
  // macOS the menu bar is where the standard key equivalents actually LIVE -- with no
  // menu there is no Edit menu, and therefore no Cmd+C, Cmd+V, Cmd+X, Cmd+A, and no
  // Cmd+Q to quit. Give macOS the minimum that restores them.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },      // About / Hide / Quit  -> Cmd+Q, Cmd+H
      { role: 'editMenu' },     // Cut / Copy / Paste / Select All -> Cmd+X/C/V/A
      { role: 'windowMenu' },   // Minimise / Zoom / Close -> Cmd+M, Cmd+W
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
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
ipcMain.handle('reeldeck:check-update', () => {
  // On a build where the updater was never wired, answer the way that build already
  // answers at startup -- there may be a new version, go and download it -- instead of
  // starting a check that can never report anything.
  if (!updaterLive) { tellRenderer({ state: 'portable' }); return; }
  try { autoUpdater.checkForUpdates(); } catch (e) {}
});

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
