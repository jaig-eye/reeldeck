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
//   dialogs        no alert/confirm/prompt from any frame -- WEB_PREFERENCES.disableDialogs;
//                  no beforeunload "Leave site?" veto either        will-prevent-unload
//   the player     a few seconds after its first load, the player frame itself may only
//                  navigate within its committed site (eTLD+1)      will-frame-navigate,
//                                                                   will-redirect
//                  This stops the frame being REPLACED by another site. It does not stop
//                  what the mirror's own scripts draw inside it (a full-size ad iframe is
//                  just page content); only the ad blocker touches that.
//
// Kept in its own module so scripts/test-guards.js can run this exact code against a
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

// webPreferences every window of ours is created with (main.js adds its preload; the test
// window uses exactly this). disableDialogs is the only switch for JS dialogs: Electron has
// no main-process hook that can cancel one, and an unsandboxed ad page's "Your PC is
// infected -- OK?" alert is a native modal over the app. It applies to every frame of the
// window. It cannot be turned on for a webContents after creation, so the other ways to get
// one are closed instead: window.open is denied and <webview> never attaches (below).
const WEB_PREFERENCES = Object.freeze({
  contextIsolation: true, nodeIntegration: false, sandbox: true, disableDialogs: true,
});

// Registrable domain ("site"), for pinning the player. tldts-experimental is already in the
// package as a dependency of the ad blocker (@ghostery/adblocker-electron), so it ships; it
// is required defensively because nothing here declares it. Without it: the last two labels,
// or three under a few common two-part suffixes -- an approximation that treats e.g.
// a.github.io and b.github.io as one site (looser, never stricter, than the real list).
let tld = null;
try { tld = require('tldts-experimental'); } catch (e) {}
const TWO_PART = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au',
  'co.nz', 'co.jp', 'co.in', 'co.za', 'co.kr', 'com.br', 'com.mx', 'com.tr', 'com.cn', 'com.tw', 'com.hk', 'com.sg']);
/** Site of a web URL, or null for one without a host (about:, data:, junk). */
function siteOf(u) {
  let x;
  try { x = new URL(u); } catch (e) { return null; }
  if (x.protocol === 'blob:') return siteOf(x.origin);   // blob:https://host/uuid belongs to host
  if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
  const host = x.hostname.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return host;   // an IP is its own site
  const d = tld && tld.getDomain(host, { allowPrivateDomains: true });
  if (d) return d;
  const l = host.split('.');
  return l.slice(TWO_PART.has(l.slice(-2).join('.')) && l.length > 2 ? -3 : -2).join('.');
}

// How long after its first load starts the player frame may still change site (see
// hardenContents). Long enough for a landing page to load and bounce; settable so the
// test does not have to sit through it.
let pinGraceMs = 8000;
function setPinGrace(ms) { pinGraceMs = ms; }

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
  contents.on('will-attach-webview', (e, prefs) => {
    if (prefs) prefs.disableDialogs = true;   // in case the refusal below is ever relaxed
    e.preventDefault(); say('webview', '');
  });
  // A beforeunload handler in any frame (an ad in the unsandboxed player, after one click)
  // would otherwise silently cancel closing or reloading the window: Electron's default for
  // this event is to honour the veto, and disableDialogs does not cover it. The app itself
  // never vetoes an unload, so the veto is always ignored.
  contents.on('will-prevent-unload', (e) => { e.preventDefault(); say('unload', contents.getURL()); });
  // Player pinning. A frame whose parent is our top frame (the player or trailer) gets a
  // grace period from the start of its first load (we just set src or inserted it): any web
  // navigation goes, because mirrors bounce to a numbered host, often on another domain, by
  // 302 chains AND from a committed landing page (location.replace, meta refresh, a
  // balancer page). After that the frame may navigate itself only within the site of the
  // last web destination it was allowed -- an ad script swapping the whole player for a
  // scam page is a navigation of that frame to another site. The pin is taken from what
  // the guard ALLOWS, not only from the committed document: a mirror that hopped to data:
  // or about:blank inside the grace period sat on a document with no site when the grace
  // ended, so no pin was ever recorded and the frame could later go anywhere. Those hops
  // have no site and leave the pin on the mirror. A hijack inside the grace period still
  // gets through; that is the price of not breaking bouncing mirrors. Navigations OUR top
  // frame starts (switching source) restart the grace period. Frames nested inside the
  // player are not pinned: the real video host is usually another domain in a nested frame,
  // and an ad script could draw the same overlay without navigating anything. Keyed by
  // frameTreeNodeId, which survives the frame's own navigations (the WebFrameMain object
  // may not); the pin outlives an about:blank hop, so blanking the frame first does not
  // reset it. A frame first seen already on a web document (an event we missed) gets no
  // grace. Entries for removed frames are never reused and are small, so not pruned.
  const pins = new Map();   // frameTreeNodeId -> { since: ms, site: string|null }
  const pinned = (e, url) => {
    let frame, parent, id, committed, ini;
    try {
      frame = e.frame;
      if (!frame) { say('frame-pin', 'unidentified frame, allowed: ' + url); return true; }
      parent = frame.parent;
      if (!parent || parent.parent || !isOurs(parent.url)) return true;   // not the player
      id = frame.frameTreeNodeId; committed = frame.url; ini = e.initiator;
    } catch (err) { say('frame-pin', 'frame gone, allowed: ' + url); return true; }
    const now = Date.now();
    let fromUs = false;
    try { fromUs = !!ini && !ini.parent && isOurs(ini.url); } catch (err) {}
    let p = pins.get(id);
    if (fromUs || (!p && !siteOf(committed))) { pins.set(id, { since: now, site: siteOf(url) }); return true; }
    if (!p) pins.set(id, p = { since: 0, site: null });
    if (now - p.since < pinGraceMs) { const s = siteOf(url); if (s) p.site = s; return true; }
    const site = siteOf(committed);
    if (site) p.site = site;
    const pin = p.site;
    if (!pin) return true;
    const dest = siteOf(url);
    // about: carries no content of its own; data: has no site, so it is foreign.
    if (dest === pin || (dest === null && schemeOf(url) === 'about:')) return true;
    e.preventDefault(); say('frame-pin', pin + ' -> ' + url);
    return false;
  };
  const guard = (e, url, isMainFrame) => {
    const scheme = schemeOf(url);
    if (!WEB_SCHEMES.has(scheme)) { e.preventDefault(); say('scheme', url); return; }
    // The top document stays ours. A player may navigate ITSELF, within its own site.
    if (isMainFrame) { if (!isOurs(url)) { e.preventDefault(); say('top', url); } return; }
    pinned(e, url);
  };
  // All three hand over the frame as e.frame (and will-frame-navigate/will-redirect the
  // initiator); will-navigate fires for the main frame only.
  contents.on('will-frame-navigate', (e) => guard(e, e.url, e.isMainFrame));
  contents.on('will-navigate', (e, url) => guard(e, e.url || url, true));
  contents.on('will-redirect', (e, url, isInPlace, isMainFrame) => guard(e, e.url || url, e.isMainFrame !== undefined ? e.isMainFrame : isMainFrame));
  contents.on('select-bluetooth-device', (e, devices, cb) => { e.preventDefault(); say('device', 'bluetooth'); cb(''); });
}

/** Every webContents the app will ever create, not just the main window. */
function hardenApp(log) {
  app.on('web-contents-created', (e, contents) => hardenContents(contents, log));
}

module.exports = { hardenSession, hardenContents, hardenApp, setAppOrigin, setPinGrace, siteOf, WEB_SCHEMES, WEB_PREFERENCES };
