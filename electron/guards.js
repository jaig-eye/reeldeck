// Reeldeck desktop -- what a framed player is allowed to do to this machine: nothing.
//
// The players are third-party pages full of ads, and on the desktop they are NOT sandboxed
// (most refuse to play in a sandboxed frame). So every way out of the frame is closed here,
// at the browser layer, where a page cannot detect or undo it:
//
//   files          no download ever starts                         will-download
//   other apps     no link to a non-web scheme is followed, in ANY frame -- ms-appinstaller:,
//                  search-ms:, ms-msdt:, file:, steam:, ... are how a web page gets Windows
//                  to install or run something                     will-frame-navigate,
//                                                                   will-redirect, openExternal
//   windows        no window.open / target=_blank, from any frame  setWindowOpenHandler
//   the app        no frame may navigate the top document away     will-frame-navigate
//   permissions    only OUR top frame gets fullscreen and clipboard-write; camera, mic,
//                  location, notifications, MIDI, USB, HID, serial, Bluetooth, screen
//                  capture and openExternal are refused for everyone
//   <webview>      never attached
//
// Kept in its own module so electron/test-guards.js can run this exact code against a
// hostile page. Every refusal is reported through `log`.

const { app } = require('electron');

// Schemes a frame may navigate to. Everything else would leave the browser.
const WEB_SCHEMES = new Set(['http:', 'https:', 'about:', 'blob:', 'data:']);
const schemeOf = (u) => { try { return new URL(u).protocol; } catch (e) { return ''; } };

/** The app's own origin, e.g. http://127.0.0.1:43110 -- set once the window knows it. */
let appOrigin = '';
function setAppOrigin(url) {
  try { appOrigin = new URL(url).origin; } catch (e) { appOrigin = ''; }
  if (url && url.startsWith('file:')) appOrigin = 'file://';
}
const isOurs = (u) => typeof u === 'string' && !!appOrigin &&
  (appOrigin === 'file://' ? u.startsWith('file://') : (() => { try { return new URL(u).origin === appOrigin; } catch (e) { return false; } })());

function hardenSession(ses, log) {
  const say = log || (() => {});
  ses.on('will-download', (e, item) => {
    e.preventDefault();
    say('download', item && item.getURL ? item.getURL() : '');
  });
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const d = details || {};
    // Only our own top frame, and only these two. 'openExternal' is how Chromium asks before
    // handing a link to another program; it is never granted.
    const ok = (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') &&
               d.isMainFrame !== false && isOurs(d.requestingUrl || (wc && wc.getURL && wc.getURL()));
    if (!ok) say('permission', permission + (d.externalURL ? ' ' + d.externalURL : '') + ' from ' + (d.requestingUrl || ''));
    cb(ok);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
    (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') && isOurs(requestingOrigin));
  if (ses.setDevicePermissionHandler) ses.setDevicePermissionHandler(() => false);
  // Device pickers: answered "no device" before a chooser could ever appear.
  ses.on('select-hid-device', (e, details, cb) => { e.preventDefault(); say('device', 'hid'); cb(); });
  ses.on('select-serial-port', (e, ports, wc, cb) => { e.preventDefault(); say('device', 'serial'); cb(''); });
  ses.on('select-usb-device', (e, details, cb) => { e.preventDefault(); say('device', 'usb'); cb(); });
}

function hardenContents(contents, log) {
  const say = log || (() => {});
  contents.setWindowOpenHandler((d) => { say('window', d && d.url); return { action: 'deny' }; });
  contents.on('will-attach-webview', (e) => { e.preventDefault(); say('webview', ''); });
  const guard = (e, url, isMainFrame) => {
    const scheme = schemeOf(url);
    if (!WEB_SCHEMES.has(scheme)) { e.preventDefault(); say('scheme', url); return; }
    // The top document stays ours. A player may navigate ITSELF (its stream, its own pages).
    if (isMainFrame && !isOurs(url)) { e.preventDefault(); say('top', url); }
  };
  contents.on('will-frame-navigate', (e) => guard(e, e.url, e.isMainFrame));
  contents.on('will-navigate', (e, url) => guard(e, e.url || url, true));
  contents.on('will-redirect', (e, url, isInPlace, isMainFrame) => guard(e, e.url || url, e.isMainFrame !== undefined ? e.isMainFrame : isMainFrame));
  contents.on('select-bluetooth-device', (e, devices, cb) => { e.preventDefault(); say('device', 'bluetooth'); cb(''); });
}

/** Every webContents the app will ever create, not just the main window. */
function hardenApp(log) {
  app.on('web-contents-created', (e, contents) => hardenContents(contents, log));
}

module.exports = { hardenSession, hardenContents, hardenApp, setAppOrigin, WEB_SCHEMES };
