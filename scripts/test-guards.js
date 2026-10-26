// Proves electron/guards.js against a hostile player. Run: npm run test:guards
//
// Starts two loopback servers -- the "app" (127.0.0.1:47001) and a "player" on another
// origin (127.0.0.1:47002) -- loads the app in a hidden window with exactly the guards the
// desktop app uses, and has the framed player try every way out, each with a user gesture.
// Nothing here can reach the internet or another program: the scheme used for the
// "open another app" attempt is registered to nothing, and the window is never shown.
const { app, BrowserWindow, session } = require('electron');
const http = require('http');
const guards = require('../electron/guards');

const APP = 'http://127.0.0.1:47001', PLAYER = 'http://127.0.0.1:47002';
const blocked = [];
const log = (kind, detail) => blocked.push({ kind, detail: String(detail || '') });

const appPage = `<!doctype html><title>app</title>
  <iframe id="p" src="${PLAYER}/player.html" style="width:600px;height:300px"></iframe>`;
const playerPage = `<!doctype html><title>player</title><a id="dl" href="/payload.exe" download>x</a>`;
const serve = (port, pages) => new Promise((ok) => http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/payload.exe') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(Buffer.alloc(64)); }
  if (pages[p]) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(pages[p]); }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', ok));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await serve(47001, { '/': appPage });
  await serve(47002, { '/player.html': playerPage, '/next.html': '<!doctype html><title>next</title>' });
  guards.hardenSession(session.defaultSession, log);
  guards.hardenApp(log);
  guards.setAppOrigin(APP + '/');
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL(APP + '/');
  await wait(800);
  const player = win.webContents.mainFrame.frames[0];
  // An escape passes if a guard logged it, OR Chromium refused it first and the outcome shows
  // it: the frame is still on its own page and the call reported a refusal.
  const tryIn = async (label, code) => {
    const before = blocked.length;
    let value;
    try { value = await player.executeJavaScript(code, true); } catch (e) { value = 'threw'; }
    await wait(700);
    const f = win.webContents.mainFrame.frames[0];
    const stayed = !!f && f.url === PLAYER + '/player.html';
    const logs = blocked.slice(before).map((b) => b.kind + ': ' + b.detail.slice(0, 70));
    return { label, blocked: logs, frameStayed: stayed, value: value === undefined ? null : value,
             ok: logs.length > 0 || (stayed && value !== 'granted') };
  };
  const results = [];
  results.push(await tryIn('pop-up window', `window.open('https://example.com/ad')`));
  results.push(await tryIn('link to another program', `location.href = 'reeldeck-test-unregistered:install?pkg=evil'`));
  results.push(await tryIn('file: navigation', `location.href = 'file:///C:/Windows/'`));
  results.push(await tryIn('hijack the app page', `top.location.href = 'https://example.com/scam'`));
  results.push(await tryIn('forced download (.exe)', `document.getElementById('dl').click()`));
  results.push(await tryIn('notification permission', `Notification.requestPermission().then(r => r)`));
  results.push(await tryIn('fullscreen from the player', `document.documentElement.requestFullscreen().then(() => 'granted', () => 'refused')`));
  // What must still work
  const topStillOurs = win.webContents.getURL().startsWith(APP);
  let ownFullscreen = 'n/a';
  try {
    ownFullscreen = await win.webContents.executeJavaScript(
      `document.documentElement.requestFullscreen().then(() => { document.exitFullscreen(); return 'granted'; }, () => 'refused')`, true);
  } catch (e) { ownFullscreen = 'error ' + e.message; }
  try { await player.executeJavaScript(`location.href = '${PLAYER}/next.html'`, true); } catch (e) {}
  await wait(800);
  const f = win.webContents.mainFrame.frames[0];
  const playerSelfNav = !!f && f.url === PLAYER + '/next.html';
  const out = {
    escapes: results,
    allEscapesBlocked: results.every((r) => r.ok),
    stillWorks: { topStillOurs, ownFullscreen, playerSelfNav },
  };
  console.log(JSON.stringify(out, null, 2));
  app.exit(out.allEscapesBlocked && topStillOurs && playerSelfNav ? 0 : 1);
});
