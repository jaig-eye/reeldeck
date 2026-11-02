// Proves electron/guards.js against a hostile player. Run: npm run test:guards
//
// Starts two loopback servers -- the "app" (127.0.0.1:47001) and a "player" on another
// origin (port 47002) -- loads the app in a hidden window with exactly the guards and
// webPreferences the desktop app uses, and has the framed player try every way out, each
// with a user gesture. Nothing here can reach the internet or another program: every *.test
// host below is mapped to 127.0.0.1 inside Chromium (host-resolver-rules, no proxy), the
// scheme used for the "open another app" attempt is registered to nothing, and the window is
// never shown. *.test hostnames rather than bare IPs so the player pin sees real sites:
// www./cdn./balance.mirror-one.test are one site, mirror-two.test and other.test others.
const { app, BrowserWindow, session } = require('electron');
const http = require('http');
const guards = require('../electron/guards');

app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.test 127.0.0.1');

const APP = 'http://127.0.0.1:47001', PLAYER = 'http://www.mirror-one.test:47002';
const EVIL = 'http://evil.other.test:47002/next.html';
// The pin's grace period, shortened from the app's so the test does not sit through it.
const GRACE = 1500;
const FOUR = 'http://s9.mirror-four.test:47002/player.html', FIVE = 'http://s3.mirror-five.test:47002/player.html';
const blocked = [];
const log = (kind, detail) => blocked.push({ kind, detail: String(detail || '') });

const appPage = `<!doctype html><title>app</title>
  <iframe id="p" src="${PLAYER}/player.html" style="width:600px;height:300px"></iframe>`;
// The nested frame stands in for the real video host: another domain, inside the player.
const playerPage = `<!doctype html><title>player</title><a id="dl" href="/payload.exe" download>x</a>
  <iframe id="n" src="http://video.cdn-host.test:47002/inner.html"></iframe>`;
const serve = (port, pages) => new Promise((ok) => http.createServer((req, res) => {
  const [p, q] = req.url.split('?');
  if (p === '/payload.exe') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(Buffer.alloc(64)); }
  // A mirror's bounce: /redir?to=<url> answers 302 to it (chains by nesting).
  if (p === '/redir') { res.writeHead(302, { Location: new URLSearchParams(q).get('to') }); return res.end(); }
  if (pages[p]) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(pages[p]); }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', ok));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const redir = (to, via) => via + '/redir?to=' + encodeURIComponent(to);

app.whenReady().then(async () => {
  await serve(47001, { '/': appPage });
  await serve(47002, { '/player.html': playerPage, '/next.html': '<!doctype html><title>next</title>',
                       '/inner.html': '<!doctype html><title>inner</title>',
                       // Landing pages that commit, then move the frame to another domain.
                       '/bounce-js.html': `<!doctype html><title>landing</title><script>setTimeout(() => location.replace(${JSON.stringify(FOUR)}), 300)</script>`,
                       '/bounce-meta.html': `<!doctype html><title>landing</title><meta http-equiv="refresh" content="0;url=${FIVE}">` });
  await session.defaultSession.setProxy({ mode: 'direct' });
  guards.hardenSession(session.defaultSession, log);
  guards.hardenApp(log);
  guards.setAppOrigin(APP + '/');
  guards.setPinGrace(GRACE);
  // main.js's window minus its preload: the same object, so the test cannot drift from it.
  const win = new BrowserWindow({ show: false, webPreferences: { ...guards.WEB_PREFERENCES } });
  await win.loadURL(APP + '/');
  await wait(800);
  let player = win.webContents.mainFrame.frames[0];
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
  // A JS dialog in a hidden window would block the call for ever, so a timeout is a failure.
  // disableDialogs answers them at once: alert -> undefined, confirm -> false, prompt -> null.
  {
    const before = blocked.length;
    const value = await Promise.race([
      player.executeJavaScript(`[alert('Your PC is infected'), confirm('Install the fix?'), prompt('Card number')]`, true)
        .catch(() => 'threw'),
      wait(4000).then(() => 'dialog shown (timed out)'),
    ]);
    const ok = Array.isArray(value) && value[0] == null && value[1] === false && value[2] == null;
    results.push({ label: 'alert/confirm/prompt from the player', blocked: blocked.slice(before).map((b) => b.kind), value, ok });
  }

  // Player pinning. Each case starts from a freshly inserted iframe, the way the app swaps
  // sources, and judges by where the player frame ended up plus what the guard logged.
  const fresh = async (src) => {
    await win.webContents.executeJavaScript(`(() => { const o = document.getElementById('p');
      const n = document.createElement('iframe'); n.id = 'p'; n.src = ${JSON.stringify(src)};
      n.style.cssText = o.style.cssText; o.replaceWith(n); })()`, true);
    await wait(900);
    player = win.webContents.mainFrame.frames[0];
  };
  const urlNow = () => { const f = win.webContents.mainFrame.frames[0]; return f ? f.url : ''; };
  const pinCase = async (label, run, expectUrl, expectPinLog) => {
    const before = blocked.length;
    try { await run(); } catch (e) {}
    await wait(900);
    const pinLogs = blocked.slice(before).filter((b) => b.kind === 'frame-pin').map((b) => b.detail.slice(0, 90));
    const url = urlNow();
    return { label, url, pinLogs, ok: url === expectUrl && (pinLogs.length > 0) === expectPinLog };
  };
  const nav = (frame, to) => frame.executeJavaScript(`location.href = ${JSON.stringify(to)}`, true);
  const pinning = [];
  // Inside the grace period a committed landing page may still move the frame elsewhere.
  pinning.push(await pinCase('landing page bounces by location.replace inside the grace period (allowed)',
    () => fresh('http://www.mirror-one.test:47002/bounce-js.html'), FOUR, false));
  pinning.push(await pinCase('landing page bounces by meta refresh inside the grace period (allowed)',
    () => fresh('http://www.mirror-one.test:47002/bounce-meta.html'), FIVE, false));
  await fresh(PLAYER + '/player.html');
  await wait(GRACE);
  pinning.push(await pinCase('player navigates itself to another site (blocked)',
    () => nav(player, EVIL), PLAYER + '/player.html', true));
  pinning.push(await pinCase('player navigates itself to data: (blocked)',
    () => nav(player, 'data:text/html,<h1>Call support now</h1>'), PLAYER + '/player.html', true));
  pinning.push(await pinCase('nested frame inside the player loads another site (allowed)',
    () => nav(win.webContents.mainFrame.frames[0].frames[0], EVIL), PLAYER + '/player.html', false));
  {
    const nested = win.webContents.mainFrame.frames[0].frames[0];
    pinning[pinning.length - 1].nestedUrl = nested ? nested.url : '';
    pinning[pinning.length - 1].ok = pinning[pinning.length - 1].ok && !!nested && nested.url === EVIL;
  }
  pinning.push(await pinCase('player navigates itself within its site (allowed)',
    () => nav(player, 'http://cdn.mirror-one.test:47002/next.html'), 'http://cdn.mirror-one.test:47002/next.html', false));
  pinning.push(await pinCase('blank hop does not reset the pin (about:blank allowed, then blocked)',
    async () => {
      await nav(win.webContents.mainFrame.frames[0], 'about:blank'); await wait(700);
      await nav(win.webContents.mainFrame.frames[0], EVIL);
    }, 'about:blank', true));
  const TWO = 'http://s7.mirror-two.test:47002/player.html';
  pinning.push(await pinCase('initial load redirects across sites (allowed)',
    () => fresh(redir(redir(TWO, 'http://s2.mirror-one.test:47002'), 'http://balance.mirror-one.test:47002')), TWO, false));
  await wait(GRACE);
  pinning.push(await pinCase('same-site navigation that redirects to another site (blocked)',
    () => nav(win.webContents.mainFrame.frames[0], redir(EVIL, 'http://s7.mirror-two.test:47002')), TWO, true));
  const THREE = 'http://x.mirror-three.test:47002/player.html';
  pinning.push(await pinCase('the app switches the player source in place (allowed)',
    () => win.webContents.executeJavaScript(`document.getElementById('p').src = ${JSON.stringify(THREE)}`, true), THREE, false));
  // A frame left on a site-less document (data:) when the grace period ends must still be
  // pinned to the mirror it came from, or it could later be swapped to any site.
  const HOP = 'data:text/html,hop';
  pinning.push(await pinCase('data: hop inside the grace period, then another site after it (blocked)',
    async () => {
      await fresh(PLAYER + '/player.html');
      await nav(win.webContents.mainFrame.frames[0], HOP); await wait(GRACE);
      await nav(win.webContents.mainFrame.frames[0], EVIL);
    }, HOP, true));

  // A beforeunload veto from the player (it has had a click) must not cancel a reload.
  await fresh(PLAYER + '/player.html');
  {
    const before = blocked.length;
    await win.webContents.executeJavaScript('window.__beforeReload = 1', true);
    try {
      await player.executeJavaScript(`addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; }); 1`, true);
    } catch (e) {}
    win.webContents.reload();
    await wait(1500);
    const reloaded = (await win.webContents.executeJavaScript('window.__beforeReload', true)) === undefined;
    const logs = blocked.slice(before).filter((b) => b.kind === 'unload').map((b) => b.kind);
    results.push({ label: 'beforeunload veto from the player', reloaded, blocked: logs, ok: reloaded && logs.length > 0 });
  }

  // What must still work
  await fresh(PLAYER + '/player.html');
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
  const all = results.concat(pinning);
  const out = {
    escapes: results,
    pinning,
    allEscapesBlocked: results.every((r) => r.ok),
    pinningHolds: pinning.every((r) => r.ok),
    stillWorks: { topStillOurs, ownFullscreen, playerSelfNav },
    passed: all.filter((r) => r.ok).length + [topStillOurs, playerSelfNav].filter(Boolean).length,
    failed: all.filter((r) => !r.ok).length + [topStillOurs, playerSelfNav].filter((x) => !x).length,
  };
  console.log(JSON.stringify(out, null, 2));
  app.exit(out.failed === 0 ? 0 : 1);
});
