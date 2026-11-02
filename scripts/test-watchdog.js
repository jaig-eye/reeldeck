// Proves electron/watchdog.js against stand-in players. Run: npm run test:watchdog
//
// An "app" page on 127.0.0.1:47011 frames one stand-in player at a time from another origin
// (*.test, mapped to 127.0.0.1 inside Chromium; nothing reaches the internet). Each case loads,
// waits, and asks watchdog.check() what test-guards.js's window would be told. The cases are the
// screens people actually get: a player, a poster, a black page, a white page, an HTTP error,
// a dead domain, a refused port, a Cloudflare check, and a wrapper whose inner player is dead.
const { app, BrowserWindow, session } = require('electron');
const http = require('http');
const guards = require('../electron/guards');
const watchdog = require('../electron/watchdog');

app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.test 127.0.0.1');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const APP = 'http://127.0.0.1:47011', P = 'http://www.player-one.test:47012';
// A real (tiny) video so "playing" is measured, not assumed: one second of silence-free black,
// generated as a WebM by the page itself from a canvas stream.
const videoPage = `<!doctype html><body style="margin:0;background:#000"><video id="v" muted autoplay playsinline style="width:100%;height:100%"></video>
<script>const c = document.createElement('canvas'); c.width = 64; c.height = 36; const g = c.getContext('2d');
setInterval(() => { g.fillStyle = '#' + Math.floor(Math.random() * 4096).toString(16).padStart(3, '0'); g.fillRect(0, 0, 64, 36); }, 50);
const v = document.getElementById('v'); v.srcObject = c.captureStream(20); v.play().catch(() => {});</script>`;
const pages = {
  '/video.html': videoPage,
  '/video-paused.html': '<!doctype html><body style="margin:0;background:#000"><video style="width:100%;height:100%"></video>',
  '/poster.html': '<!doctype html><body style="margin:0"><div style="position:absolute;inset:0;background:#111 url(/poster.png) center/cover"></div>',
  '/button.html': '<!doctype html><body style="margin:0;background:#000"><button style="width:120px;height:120px">Play</button>',
  '/black.html': '<!doctype html><body style="margin:0;background:#000">',
  '/white.html': '<!doctype html><body>',
  '/black-script.html': '<!doctype html><body style="margin:0;background:#000"><script>window.playerConfig = { autoplay: true, servers: ["one", "two", "three"], retries: 3 };</script>',
  '/challenge.html': '<!doctype html><title>Just a moment...</title><body><h1>Verify you are human by completing the action below.</h1>',
  '/late.html': '<!doctype html><body style="margin:0;background:#000"><script>setTimeout(() => { document.body.innerHTML = \'<video style="width:100%;height:100%"></video>\'; }, 1500)</script>',
  '/shadow-open.html': '<!doctype html><body style="margin:0;background:#000"><media-box style="display:block;width:100%;height:300px"></media-box><script>document.querySelector("media-box").attachShadow({ mode: "open" }).innerHTML = "<video style=width:100%;height:100%></video>";</script>',
  '/shadow-closed.html': '<!doctype html><body style="margin:0;background:#000"><media-box style="display:block;width:100%;height:300px"></media-box><script>document.querySelector("media-box").attachShadow({ mode: "closed" }).innerHTML = "<div style=width:100%;height:100%;background:#123></div>";</script>',
  '/body-poster.html': '<!doctype html><body style="margin:0;background:#000 url(/poster.png) center/cover">',
  '/icon-bg.html': '<!doctype html><body style="margin:0;background:#000"><div style="position:absolute;left:300px;top:150px;width:80px;height:80px;background:url(/poster.png)"></div>',
  '/icon-glyph.html': '<!doctype html><style>#pl_but::before{content:"\\25B6";color:#fff;font-size:60px}</style><body style="margin:0;background:#000"><div id="pl_but" style="position:absolute;left:300px;top:150px;width:80px;height:80px"></div>',
  '/click-overlay.html': '<!doctype html><body style="margin:0;background:#000"><div style="position:absolute;inset:0;cursor:pointer"></div>',
  '/wrap-busy.html': '<!doctype html><body style="margin:0;background:#000"><iframe src="http://busy.video-host.test:47012/busy.html" style="border:0;width:100%;height:100%"></iframe>',
  '/busy.html': '<!doctype html><body style="margin:0;background:#000"><video style="width:100%;height:100%"></video><script>setInterval(() => { const t = Date.now(); while (Date.now() - t < 2500) {} }, 10)</script>',
  '/wrap-dead.html': '<!doctype html><body style="margin:0;background:#000"><iframe src="http://dead.invalid/embed" style="border:0;width:100%;height:100%"></iframe>',
  '/wrap-video.html': '<!doctype html><body style="margin:0;background:#000"><iframe src="http://cdn.video-host.test:47012/video.html" allow="autoplay" style="border:0;width:100%;height:100%"></iframe>',
  '/wrap-black.html': '<!doctype html><body style="margin:0;background:#000"><iframe src="http://cdn.video-host.test:47012/black.html" style="border:0;width:100%;height:100%"></iframe>',
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const serve = (port, fn) => new Promise((ok) => http.createServer(fn).listen(port, '127.0.0.1', ok));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// name -> [src, after ms, what the report must say]
const CASES = [
  ['playing video', P + '/video.html', 2500, (r) => r.found && !r.failed && r.playing && r.content],
  ['paused video', P + '/video-paused.html', 1500, (r) => r.found && !r.failed && !r.playing && r.videos === 1 && r.content],
  ['poster (background image)', P + '/poster.html', 1500, (r) => r.found && !r.failed && r.content],
  ['play button only', P + '/button.html', 1500, (r) => r.found && !r.failed && r.content],
  ['black page', P + '/black.html', 1500, (r) => r.found && !r.failed && r.complete && !r.content],
  ['black page with an inline script (its source is not text)', P + '/black-script.html', 1500, (r) => r.found && !r.failed && r.complete && !r.content],
  ['white page', P + '/white.html', 1500, (r) => r.found && !r.failed && r.complete && !r.content],
  ['Cloudflare-style check (403)', P + '/challenge.html?status=403', 1500, (r) => r.found && r.status === 403 && r.content],
  ['HTTP 404', P + '/gone.html', 1500, (r) => r.found && r.status === 404],
  ['HTTP 500', P + '/boom.html?status=500', 1500, (r) => r.found && r.status === 500],
  ['dead domain', 'http://nowhere.invalid/embed/1', 3000, (r) => r.found && !!r.failed],
  ['refused port', 'http://www.player-one.test:47099/embed', 3000, (r) => r.found && !!r.failed],
  ['late content, early look', P + '/late.html', 300, (r) => r.found && !r.failed && !r.content],
  ['late content, later look', P + '/late.html', 2500, (r) => r.found && !r.failed && r.content],
  ['web component, open shadow root', P + '/shadow-open.html', 1500, (r) => r.found && !r.failed && r.videos === 1 && r.content],
  ['web component, closed shadow root', P + '/shadow-closed.html', 1500, (r) => r.found && !r.failed && r.content],
  ['poster painted on the body', P + '/body-poster.html', 1500, (r) => r.found && !r.failed && r.content],
  ['small background-image play icon', P + '/icon-bg.html', 1500, (r) => r.found && !r.failed && r.content],
  ['::before glyph play button', P + '/icon-glyph.html', 1500, (r) => r.found && !r.failed && r.content],
  ['click-to-load overlay (cursor: pointer)', P + '/click-overlay.html', 1500, (r) => r.found && !r.failed && r.content],
  ['wrapper, inner player too busy to answer', P + '/wrap-busy.html', 3000, (r) => r.found && !r.failed && r.frames === 2 && !r.complete],
  ['wrapper, inner player dead', P + '/wrap-dead.html', 3000, (r) => r.found && !r.failed && r.frames === 2 && r.complete && !r.content],
  ['wrapper, inner player playing', P + '/wrap-video.html', 3000, (r) => r.found && !r.failed && r.playing],
  ['wrapper, inner page black', P + '/wrap-black.html', 2000, (r) => r.found && !r.failed && r.frames === 2 && r.complete && !r.content],
];

app.whenReady().then(async () => {
  await serve(47011, (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>app</title><body>'); });
  await serve(47012, (req, res) => {
    const [p, q] = req.url.split('?');
    if (p === '/poster.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    const status = +(new URLSearchParams(q || '').get('status') || 0) || (pages[p] ? 200 : 404);
    res.writeHead(status, { 'Content-Type': 'text/html' });
    res.end(pages[p] || '<!doctype html><title>error</title><body><h1>' + status + '</h1>');
  });
  await session.defaultSession.setProxy({ mode: 'direct' });
  // main.js's window and its guards: the watchdog must work behind the same fences.
  guards.hardenSession(session.defaultSession, () => {});
  guards.hardenApp(() => {});
  guards.setAppOrigin(APP + '/');
  const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { ...guards.WEB_PREFERENCES } });
  watchdog.attach(win.webContents);
  await win.loadURL(APP + '/');
  const results = [];
  let seq = 0;
  for (const [label, src, after, ok] of CASES) {
    const name = 'rd-player-' + (++seq);
    await win.webContents.executeJavaScript(`(() => { document.body.innerHTML = '';
      const f = document.createElement('iframe'); f.name = ${JSON.stringify(name)}; f.allow = 'autoplay';
      f.style.cssText = 'width:640px;height:360px;border:0'; f.src = ${JSON.stringify(src)}; document.body.appendChild(f); return 1; })()`);
    await wait(after);
    const r = await watchdog.check(win.webContents, win.webContents.mainFrame, name);
    const pass = !!ok(r);
    results.push({ label, pass, report: r });
  }
  // The page can only ever be told about its own frames: a name that is not there, with two
  // frames up, finds nothing rather than guessing.
  await win.webContents.executeJavaScript(`document.body.innerHTML = '<iframe name="a" src="${P}/black.html"></iframe><iframe name="b" src="${P}/black.html"></iframe>'; 1`);
  await wait(1200);
  const none = await watchdog.check(win.webContents, win.webContents.mainFrame, 'not-there');
  results.push({ label: 'unknown name with two frames', pass: none.found === false, report: none });
  const passed = results.filter((x) => x.pass).length;
  for (const x of results) if (!x.pass) console.log('FAIL', x.label, JSON.stringify(x.report));
  console.log(JSON.stringify({ passed, failed: results.length - passed }, null, 2));
  app.exit(results.length === passed ? 0 : 1);
});
