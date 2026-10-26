/* ============================================================
   Reeldeck — client-side app logic (no build step, no framework)

   Data: TMDB API v3 (same backend the source site uses).
   Everything routes through CONFIG so you can re-point the app
   at a different base URL / key / player source from Settings.

   ONE file, one IIFE, in this order. Order matters more than usual here:
   route() runs at boot and reaches deep into the file, so anything a view or
   the TV navigation touches must be DECLARED ABOVE IT or it dies in the
   temporal dead zone (this has shipped a blank screen on TV before).

     1. Config + storage keys      the persisted-state schema, below
     2. TV/D-pad module state      declared early, on purpose — see above
     3. Icons, TMDB fetch helpers
     4. Watchlist                  simple id list
     5. Watch progress + history   resume points; see its own header
     6. Card / rail / grid builders
     7. Views                      home, discover, detail, watch, search,
                                   person, watchlist+history, get-app
     8. Settings + updater         incl. Android self-install over the bridge
     9. TV / D-pad navigation      row model, focus, glide-scrolling, pointer
    10. Router + boot

   THE constraint that shapes half of this app: the video mirrors are
   CROSS-ORIGIN iframes. They cannot be scripted, their controls cannot be
   focused, and their playback position cannot be read. Anything that looks
   like a workaround for that (the synthetic-touch pointer, the postMessage
   progress listener, the elapsed-time fallback) is there because the direct
   route does not exist — not because it was the first thing tried.

   PERSISTED STATE  (localStorage — all of it is per-device, none of it syncs)

     reeldeck.config.v5     Settings: theme, region, API key, player sources.
                            Sources are SNAPSHOTTED on first run, so shipping a
                            change to DEFAULT_SOURCES needs the migration in
                            loadConfig() to reach anyone who already has the app.

     reeldeck.watchlist.v1  [ { id, type, title, poster_path, vote_average, date } ]
                            Newest first. Purely user-curated.

     reeldeck.progress.v1   { key: { t, d, pct, at, src } } plus a per-show pointer.
                              key  'movie:<id>'  |  'tv:<id>:<season>:<episode>'
                              t    position in seconds        d    duration in seconds
                              pct  t/d, 0..1                  at   last touched (ms)
                              src  'provider' (the mirror told us — exact) or
                                   'elapsed'  (wall-clock guess — approximate)
                            'tv:<id>' → { s, e, at } is the resume pointer: which
                            episode to drop the viewer back on, and which season the
                            detail page opens to.
                            Episodes persist forever; movies age out after 60 days.

     reeldeck.history.v1    [ { k, id, type, title, poster_path, s, e, pct, at } ]
                            Newest first, capped at 300, one row per key. Drives the
                            history log AND "Continue watching".

     reeldeck.tracked.v1    { '<mirror name>': 1 } — mirrors that have PROVEN they
                            report real playback position. Earned at runtime, not
                            assumed; see the verified-mirror block.
   ============================================================ */
(function () {
  'use strict';

  /* ------------------------------------------------------------
     CONFIG  — the single source of truth. Change the link here
     (or in the Settings panel) and every request follows.
     ------------------------------------------------------------ */
  const CONFIG_KEY = 'reeldeck.config.v5';
  const WATCH_KEY  = 'reeldeck.watchlist.v1';
  const PROG_KEY   = 'reeldeck.progress.v1';
  const HIST_KEY   = 'reeldeck.history.v1';
  const TRACK_KEY  = 'reeldeck.tracked.v1';
  const TOMB_KEY   = 'reeldeck.tomb.v1';
  // Deliberately NOT inside config.v5. Settings' Reset does
  // `cfg = Object.assign({}, DEFAULTS)` and drops every key DEFAULTS does not
  // name, so a uid living there would be destroyed permanently -- with no list
  // endpoint and no recovery -- by a button whose own confirm text promises
  // "Your watchlist is kept". loadConfig() re-merging DEFAULTS on every boot is
  // a hostile place for a credential besides.
  const SYNC_KEY   = 'reeldeck.sync.v1';
  const SYNC_URL   = 'https://reeldeck.disisbo.workers.dev';

  const TOMB_TTL   = 90 * 86400000;     // a deletion is remembered for 90 days
  const TOMB_MAX   = 200;
  const WATCH_MAX  = 1000;
  const PROG_MAX   = 4000;
  const FUTURE_SLACK = 86400000;        // 24h of clock slop tolerated before clamping
  const BODY_MAX   = 480000;            // the Worker rejects at 512K; stop short of it

  // Mirror list lifted verbatim from the source site's own player module.
  // These are third-party embed providers — the app just frames them. Fully
  // editable/removable in Settings. Placeholders resolved by buildSourceUrl().
  // Autoplay: the WebView is started with setMediaPlaybackRequiresUserGesture(false)
  // (Capacitor's Bridge does it) and the player iframe carries allow="autoplay", so a
  // mirror that asks to autoplay is permitted to. Whether it ASKS is per-provider:
  // Each row's autoplay parameter was read from that provider's own docs page or its
  // own shipped player bundle; where a provider publishes nothing we could confirm, no
  // parameter is invented for it, because an unknown query parameter would be ignored
  // and so would our claim to know it. Case matters for several of them. The per-row
  // detail lives with the rows, in the Worker.
  // Caveat worth knowing: at least one family documents click-free autoplay on custom
  // domains only, so on their public hosts a play button still appears first.
  // Ad-free tiers commonly ignore autoplay on purpose, and no parameter overrides a
  // browser's own block on unmuted autoplay — this raises the odds, it is not a promise.
  // EMPTY ON PURPOSE. The mirror list used to live here, which meant it shipped inside
  // the 327KB app.js served to every visitor and inside the APK -- nine hosts, greppable
  // in one command, and a private repository would not have changed that by one byte.
  // It is fetched from the Worker now (see refreshSources) and cached locally.
  //
  // This is not secrecy against a determined user: the browser must be told a URL to
  // load the frame, so DevTools still shows the fetched list and the iframe's src. What
  // it removes is the passive copy sitting in a public repository, a public bundle and a
  // downloadable APK.
  const DEFAULT_SOURCES = [];

  const DEFAULTS = {
    brand:    'Reeldeck',
    tmdbBase: 'https://api.themoviedb.org/3',
    // Demo key extracted from the source site so this works out of the box.
    // Grab your own free key at themoviedb.org/settings/api and paste it in Settings.
    apiKey:   '5c0f02b237bd8226ef5ffa3a86dfdcd5',
    imgBase:  'https://image.tmdb.org/t/p',
    language: 'en-US',
    region:   'US',
    theme:    'midnight',
    accent:   '#f5c518',   // derived from the theme; used for the player {color} placeholder
    // Install-on-TV: where the Android APK lives.
    //
    // apkShortUrl now ships with our own permanent alias rather than starting empty
    // and asking TinyURL for a fresh code. It points at .../releases/latest/download,
    // so it keeps working for every future release without being regenerated -- and
    // "reeldeck" is the difference between typing a word and typing "2acbxg5l" with
    // a D-pad, which is the whole point of this screen.
    // apkShortAuto is still the auto-generated fallback (cached, keyed by
    // apkShortAutoFor) for anyone who clears the alias.
    apkUrl:   'https://github.com/jaig-eye/reeldeck/releases/latest/download/Reeldeck.apk',
    apkShortUrl: 'https://tinyurl.com/reeldeck',
    apkShortAuto: '',
    apkShortAutoFor: '',
    // OFF by default: the iframe sandbox trips "Iframe Sandbox Detected" on most
    // providers (it's their anti-adblock gate). The desktop app blocks pop-under/ad
    // requests at the network layer instead, so video plays AND the ads are gone.
    // null = automatic: guard the player wherever the HOST does not already block
    // pop-ups itself. true/false are explicit user overrides from the player toolbar.
    // Deliberately a new key rather than a new default for blockPlayerAds: loadConfig
    // layers saved values OVER DEFAULTS, so the old stored `false` would have outranked
    // any default forever and nobody already running the app would have seen the change.
    playerGuard: null,
    // Player sources are provider-agnostic templates you control.
    // Placeholders: {id} = TMDB id, {imdb} = IMDb id, {season}, {episode}
    // e.g. { name:'MySource', movie:'https://host/embed/movie/{id}',
    //        tv:'https://host/embed/tv/{id}/{season}/{episode}' }
    sources: DEFAULT_SOURCES,
    activeSource: 0
  };

  // Theme catalog. Values live in CSS ([data-theme=...]); this drives the picker
  // + the accent used for the player {color} param. preview = [bg, surface, accent].
  const THEMES = [
    { id: 'midnight', name: 'Midnight', accent: '#f5c518', preview: ['#0b0d12', '#1f2431', '#f5c518'] },
    { id: 'oled',     name: 'OLED',     accent: '#f5c518', preview: ['#000000', '#151922', '#f5c518'] },
    { id: 'onyx',     name: 'Onyx',     accent: '#22d3ee', preview: ['#000000', '#17171b', '#22d3ee'] },
    { id: 'aurora',   name: 'Aurora',   accent: '#d946ef', preview: ['#0f0a1a', '#251a42', '#d946ef'] },
    { id: 'ocean',    name: 'Ocean',    accent: '#2dd4bf', preview: ['#06121a', '#143240', '#2dd4bf'] },
    { id: 'ember',    name: 'Ember',    accent: '#fb923c', preview: ['#14100d', '#2c211a', '#fb923c'] },
    { id: 'daylight', name: 'Daylight', accent: '#4f46e5', preview: ['#f4f5f7', '#ffffff', '#4f46e5'] }
  ];

  let cfg = loadConfig();

  const SRC_KEY = 'reeldeck.sources.v1';

  // Which mirrors the Worker found not answering (see refreshSources). Names only, cached so
  // a cold start already knows, and ignored once it is six hours old: a stale "down" would
  // hide a mirror that has long since come back.
  const HEALTH_KEY = 'reeldeck.mirror-health.v1';
  function sanitizeHealth(h) {
    const out = {};
    if (!h || typeof h !== 'object' || !Array.isArray(h.down) || !(+h.at > 0)) return out;
    if (Date.now() - h.at > 6 * 3600000) return out;
    const why = (h.why && typeof h.why === 'object') ? h.why : {};
    h.down.slice(0, 40).forEach(n => {
      if (typeof n === 'string' && n.length <= 40) out[n] = /^[a-z]{1,12}$/.test(why[n] || '') ? why[n] : 'down';
    });
    return out;
  }
  let mirrorDown = (() => { try { return sanitizeHealth(JSON.parse(localStorage.getItem(HEALTH_KEY) || 'null')); } catch (e) { return {}; } })();
  let healthFetchedAt = 0;              // when refreshSources last asked; watchView re-asks after 10 minutes
  function isDown(name) { return !!(name && mirrorDown[name]); }
  // What the tile says. A name that no longer resolves is gone; anything else only failed to
  // answer the Worker, which is why the tile stays one press away rather than being deleted.
  function offLabel(name) { return mirrorDown[name] === 'dns' ? 'Domain gone' : 'No response'; }

  /**
   * Validate a mirror table that arrived over the network.
   *
   * These strings become an iframe's src, so a spoofed or compromised response would
   * otherwise be arbitrary-frame injection into the app. https only, strings only, a
   * length cap, and a template has to contain {id} to be a template at all.
   */
  function sanitizeSources(list) {
    if (!Array.isArray(list)) return [];
    const ok = (u) => typeof u === 'string' && u.length <= 400 &&
                      /^https:\/\/[a-z0-9.-]+\//i.test(u) && u.indexOf('{id}') >= 0;
    return list.filter(s => s && typeof s === 'object' &&
                            typeof s.name === 'string' && s.name.length <= 40 &&
                            ok(s.movie) && ok(s.tv))
               .slice(0, 40)
               .map(s => ({
                 name: s.name, movie: s.movie, tv: s.tv,
                 tracked: s.tracked ? 1 : 0,
                 t: 1,             // came from the Worker's table: refreshSources may replace or drop it
                 // Appended to a URL as `&<resume>=<seconds>`, so it is letters only.
                 resume: (typeof s.resume === 'string' && /^[a-zA-Z]{1,24}$/.test(s.resume)) ? s.resume : ''
               }));
  }

  function cachedSources() {
    try {
      const c = JSON.parse(localStorage.getItem(SRC_KEY) || 'null');
      return c && Array.isArray(c.sources) ? c : null;
    } catch (e) { return null; }
  }

  /**
   * Refresh the mirror table from the Worker.
   *
   * Runs after the first paint and never blocks it: an existing install already has the
   * table in its own config, so only a fresh install actually depends on this call. When
   * the revision has not moved, nothing is written -- a refetch must never trample a
   * mirror the user added or reordered themselves.
   */
  async function refreshSources() {
    healthFetchedAt = Date.now();
    const r = await syncCall('/v1/sources', {});
    if (r.err || !r.d) return;
    let redraw = false;
    if (r.d.health !== undefined) {
      const was = JSON.stringify(mirrorDown);
      mirrorDown = sanitizeHealth(r.d.health);
      try { localStorage.setItem(HEALTH_KEY, JSON.stringify(r.d.health || null)); } catch (e) {}
      redraw = was !== JSON.stringify(mirrorDown);
    }
    const list = sanitizeSources(r.d.sources);
    const rev = +r.d.rev || 0;
    const had = cachedSources();
    // An EMPTY table is a real answer when the Worker sends it on purpose (an array, a new
    // revision): its servers are withdrawn, and only mirrors the viewer added survive. An empty
    // result from rows that failed validation is not -- that keeps what this device has.
    const withdrawn = Array.isArray(r.d.sources) && r.d.sources.length === 0 && rev > 0 &&
                      !(had && had.rev === rev);
    if (list.length || withdrawn) {
      try { localStorage.setItem(SRC_KEY, JSON.stringify({ rev: rev, sources: list })); } catch (e) {}
    }
    if ((list.length || withdrawn) && !(had && had.rev === rev && (cfg.sources || []).length)) {
      // Keep anything the user added; refresh ours by name; append rows added since. A row is
      // "ours" if it carries the table mark (`t`, see sanitizeSources) or was in the LAST table
      // (rows saved before the mark existed). Without both, an untracked row later removed from
      // the table looked exactly like one the user had added, and stayed on every device for good.
      const shipped = new Set(((had && had.sources) || []).map(s => s.name));
      const mine = (cfg.sources || []).filter(s => !list.some(d => d.name === s.name) &&
                                                   !s.t && !s.tracked && !shipped.has(s.name));
      cfg.sources = list.concat(mine);
      saveConfig();
      redraw = true;
    }
    // One redraw at most, and only of a watch page still showing its poster -- so it starts on a
    // mirror that answers. A film that is PLAYING is never reloaded for this: the new table and
    // verdict apply from the next title. (The chosen mirror is resolved by name in watchView, so a
    // reordered table cannot switch it.)
    if (redraw && location.hash.indexOf('#/watch/') === 0 && !watchLive) route();
  }

  function loadConfig() {
    let c;
    try { c = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}')); }
    catch (e) { c = Object.assign({}, DEFAULTS); }
    // The table is no longer compiled in, so the fallback chain is: what this install
    // already stored, then whatever the last refresh cached, then nothing at all. An
    // existing install therefore keeps working without the network; only a fresh one
    // waits on refreshSources.
    const cached = cachedSources();
    const base = Array.isArray(c.sources) && c.sources.length ? c.sources
               : (cached ? cached.sources : DEFAULT_SOURCES);
    c.sources = base.map(s => Object.assign({}, s));
    // Sources are snapshotted into localStorage on first run, so a shipped fix to a
    // provider's URL (an autoplay parameter, a moved domain) would never reach anyone
    // who already has the app. Refresh the entries we ship by name and leave anything
    // the user added themselves alone.
    // Refreshing shipped rows by name is refreshSources' job now -- it is the only
    // thing that knows what the current table looks like.
    // Same trap as the source table: a stored empty string is still a stored value,
    // so Object.assign lets it win over a default that arrived in a later release.
    // Anyone who installed before the permanent alias existed has apkShortUrl: '',
    // and would have gone on auto-shortening forever.
    if (!c.apkShortUrl) c.apkShortUrl = DEFAULTS.apkShortUrl || '';
    return c;
  }
  function saveConfig() {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    applyTheme();
  }
  function applyTheme() {
    const t = THEMES.find(x => x.id === cfg.theme) || THEMES[0];
    document.documentElement.setAttribute('data-theme', t.id);
    cfg.accent = t.accent;   // keep the player {color} in sync with the theme
    const b = document.querySelector('.brand .txt'); if (b) b.textContent = cfg.brand;
    document.title = cfg.brand;
    // match the mobile browser chrome + PWA status bar to the theme background
    const mc = document.querySelector('meta[name="theme-color"]');
    if (mc) {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      if (bg) mc.setAttribute('content', bg);
    }
  }

  /* ------------------------------------------------------------
     TMDB client
     ------------------------------------------------------------ */
  /**
   * fetch() with a deadline.
   *
   * Browsers do not time out a hung request in any useful timeframe, so a stalled
   * connection left the caller awaiting a promise that never settled -- which for
   * tmdb() meant the view kept its skeleton for ever, with no error and no retry,
   * because the catch it needed was never reached.
   */
  function fetchTimeout(url, opts, ms) {
    const ac = new AbortController();
    const kill = setTimeout(() => ac.abort(), ms || 10000);
    return fetch(url, Object.assign({}, opts, { signal: ac.signal }))
      .finally(() => clearTimeout(kill));
  }

  // Five minutes, in memory, LIST-sized responses only. Back used to refetch all of Home
  // (seven requests) before it could put you where you were; with this the return is
  // instant. Title pages are not cached: with append_to_response they run to hundreds of
  // kilobytes, and a TV WebView's memory is not ours to spend.
  const tmdbCache = new Map();
  const TMDB_TTL = 5 * 60000, TMDB_CACHE_MAX = 40;
  async function tmdb(path, params) {
    params = params || {};
    const base = cfg.tmdbBase.replace(/\/+$/, '');
    const u = new URL(base + path);
    u.searchParams.set('api_key', cfg.apiKey);
    if (!('language' in params)) u.searchParams.set('language', cfg.language);
    for (const k in params) {
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    }
    // Bare /movie/{id} and /tv/{id} bodies are excluded too: the "New episode" sweep fetches
    // dozens of them, and in a 40-entry insertion-ordered cache they evicted Home's lists
    // before the first Back -- the one thing this cache exists for. Their callers memoise anyway.
    const cacheable = !params.append_to_response && !/\/images$/.test(path) && !/^\/(movie|tv)\/\d+$/.test(path);
    const ckey = u.toString();
    if (cacheable) {
      const hit = tmdbCache.get(ckey);
      // A hit is moved to the young end (its age is unchanged), so what is used survives.
      if (hit && Date.now() - hit.t < TMDB_TTL) { tmdbCache.delete(ckey); tmdbCache.set(ckey, hit); return hit.d; }
    }
    // ONE retry, and only for the failures that are actually transient: a dropped or
    // stalled connection, or a 5xx. A 4xx fails identically the second time -- a bad key
    // stays bad, a missing title stays missing -- and retrying a 429 without backoff
    // makes rate limiting worse rather than better.
    let r = null, netErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise(res => setTimeout(res, 700));
      netErr = null;
      try { r = await fetchTimeout(u.toString(), null, 10000); }
      catch (e) {
        netErr = e;
        // A TIMEOUT is not worth retrying: the request did not fail fast, so the network
        // is slow or hanging, and a second attempt buys another full deadline before the
        // user is told anything at all. Retry only failures that came back quickly.
        if (e && e.name === 'AbortError') break;
        continue;
      }
      if (r.status >= 500) continue;
      break;
    }
    if (netErr) {
      throw new Error(netErr.name === 'AbortError'
        ? 'The network is not responding. Check your connection and try again.'
        : 'No connection. Check your network and try again.');
    }
    if (!r.ok) {
      let msg = 'Request failed (' + r.status + ')';
      try { const j = await r.json(); if (j && j.status_message) msg = j.status_message; } catch (_) {}
      if (r.status === 401) msg = 'TMDB rejected the API key. Add your own free key in Settings.';
      if (r.status === 429) msg = 'TMDB is rate limiting this key. Wait a moment and try again.';
      if (r.status >= 500) msg = 'TMDB is having trouble right now. Try again in a moment.';
      // Carry the endpoint: an error box that says only "could not be found" cannot be
      // diagnosed from a screenshot, and the path is short enough to show.
      const err = new Error(msg); err.path = path; err.status = r.status;
      throw err;
    }
    const data = await r.json();
    if (cacheable) {
      tmdbCache.delete(ckey); tmdbCache.set(ckey, { t: Date.now(), d: data });
      while (tmdbCache.size > TMDB_CACHE_MAX) tmdbCache.delete(tmdbCache.keys().next().value);
    }
    return data;
  }

  /* ------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------ */
  const $  = (s, r) => (r || document).querySelector(s);
  const view = () => $('#view');

  // Desktop (Electron) exposes a trusted bridge; on the web we fall back to window.open.
  const IS_DESKTOP = !!(window.reeldeck && window.reeldeck.desktop);
  const IS_NATIVE = (function () {
    const C = window.Capacitor;
    if (!C) return false;                                   // plain browser tab
    if (typeof C.isNativePlatform === 'function') return !!C.isNativePlatform();
    return !!C.Plugins;                                     // older bridge
  })();
  /**
   * Does the thing hosting us already refuse window.open?
   *
   *   Android  MainActivity sets setSupportMultipleWindows(false) and
   *            setJavaScriptCanOpenWindowsAutomatically(false)
   *   Electron win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
   *   Browser  nothing whatsoever
   *
   * That asymmetry is the entire reason pop-up ads appear on the hosted web build and not
   * in either app. Where the host does the work we leave the player unsandboxed, because
   * the sandbox buys nothing there and some mirrors refuse to run inside one.
   */
  const HOST_BLOCKS_POPUPS = IS_DESKTOP || IS_NATIVE;
  function playerGuardOn() {
    const v = cfg.playerGuard;
    return (v === null || v === undefined) ? !HOST_BLOCKS_POPUPS : !!v;
  }
  // LG's webOS (the webos/ shell opens the hosted app; its browser says Web0S, its window has
  // PalmSystem). A webOS set is a TV: the remote's D-pad sends arrow keys, its Back key 461.
  const IS_WEBOS = /Web0S|webOS/.test(navigator.userAgent || '') || !!window.PalmSystem || location.href.indexOf('webos=1') >= 0;
  const IS_TV = /ReeldeckTV/.test(navigator.userAgent || '') || location.href.indexOf('tv=1') >= 0 || IS_WEBOS;
  // Flex gap arrived in Chromium 84; webOS 6 is 79, which knows gap for grid only. Measured once,
  // so compat.css's margin fallbacks (html.no-flexgap) apply exactly where gap does not.
  (() => {
    const d = document.createElement('div');
    d.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
    d.appendChild(document.createElement('div')); d.appendChild(document.createElement('div'));
    document.documentElement.appendChild(d);
    if (d.scrollHeight !== 1) document.documentElement.classList.add('no-flexgap');
    d.remove();
  })();
  // iPadOS 13+ reports itself as a Mac, so the touch-points test is the only reliable
  // way to tell an iPad from a desktop Safari.
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
                 (/Mac/.test(navigator.userAgent || '') && navigator.maxTouchPoints > 1);
  // Already launched from the home screen: Safari sets standalone, and the display-mode
  // query covers everything else.
  const IS_STANDALONE = !!(window.navigator.standalone) ||
                        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  // Is the window a different thing from the screen? Only on a desktop: the Electron
  // app, or a browser driven by a mouse -- installed as a PWA or not, a desktop PWA is
  // still a resizable window. On a phone, a tablet or a TV the window already IS the
  // screen, so "fill the window" and "fill the screen" are one act and only one button
  // is shown for it. The pointer test is the discriminator: a phone reports hover:none
  // whether or not it is on the home screen.
  const IS_WINDOWED = IS_DESKTOP ||
    (!IS_NATIVE && !IS_TV &&
     !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches));
  const APP_VERSION = '3.2.1';   // bump with each release (matches package.json)
  const REPO = 'jaig-eye/reeldeck';
  // The universal APK the CI attaches to every release — the same file Downloader
  // fetches when installing on a TV by hand.
  const APK_URL = 'https://github.com/' + REPO + '/releases/latest/download/Reeldeck.apk';
  // One state object drives the Settings panel AND the banner, so they can never
  // disagree about whether an update is waiting.
  let updState = { s: 'idle', v: null, pct: 0, msg: '' };

  // TV / D-pad state — declared up here (not next to the nav functions further
  // down) because route() and other render paths call tvFocusFirst()/tvSpatialNav()
  // at boot, BEFORE those later lines would run. Declaring them there left them in
  // the temporal dead zone, so the first call threw "Cannot access 'X' before
  // initialization" and aborted the whole app on TV (blank home, dead D-pad).
  // Exclude tabindex="-1" so the D-pad treats a card as ONE unit and never lands on
  // its inner controls (play overlay, watchlist toggle, rail arrows, billboard dots).
  const TV_FOCUSABLE = '[data-nav]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([type="hidden"]), select, [tabindex="0"]';
  let tvObserver = null, tvTimeout = 0, tvGiveUp = 0;
  let tvGen = 0;            // generation, so a stale cycle's timers can't touch the live one
  let modalSeq = 0;         // ids for aria-labelledby on dialog headings
  let heroStopOnce = null;  // the billboard's one-shot 'user is driving' key listener
  // Bumped on every navigation. Views capture it before their awaits and refuse to write
  // into the DOM if it has moved on — otherwise a slow Home request lands after you have
  // already opened the Watchlist and replaces the page under you. Declared up here with
  // the rest of the module state so no view can reach it in the temporal dead zone.
  let routeSeq = 0;
  let routeKey = null;
  let routePageKey = '';      // identifies the view, to tell a filter change from a navigation
  const routeIs = (n) => n === routeSeq;
  let tvUserMoved = false;  // the user has taken over — stop placing the ring for them
  // Every horizontal scroller in the app. ONE list, used for three separate jobs:
  // grouping a carousel into a single D-pad row, correcting a cached column for the
  // rail's scrollLeft, and scrolling the focused item into view. They drifted apart
  // once already -- the season rail was in none of them, so the ring could sit on a
  // season that was off screen with nothing scrolling to reveal it.
  // The server room is a wrapping grid on the page, but ONE sideways row inside the player's dock.
  const TV_ROW_CONTAINERS = '.track, .cast-track, .ep-list, .season-pills, .ep-strip, body.dock-open .server-room';
  // Where a freshly rendered page should put the ring — the thing the user came to
  // press. This is a PRIORITY ORDER, tried one selector at a time: as a single
  // querySelectorAll it would have returned document order instead, which only
  // happened to agree with the intent on today's markup.
  // NB: the search field is deliberately absent. It is the first focusable in the
  // search page's markup, so the generic fallback still lands on it when there are no
  // results — but once results exist they win, instead of trapping the ring on the box
  // you just typed into and making you press Back to reach what you searched for.
  const TV_LANDING = ['#play-go', '.player-frame[tabindex="0"]', '.bb-slide.on .bb-cta .btn.primary',
                      '.dv-stage .cta .btn.primary', '.grid .card', '.rail .track .card'];
  // Chrome pinned to the VIEWPORT rather than the document. Measured with no scroll
  // offset so its row keeps a fixed place in the order — otherwise the update
  // banner's row slides down through the rails by exactly scrollY on every rebuild.
  const TV_PINNED = 'header.top, #cinema-exit, .toast, #next-up';
  let tvRowSeq = 0;                                  // stable ids for carousel rows
  let tvColX = null;                                 // column held while moving vertically
  let tvLastScope = null;                            // ...within ONE scope: a modal is a new grid
  // Hold-OK state. okLegacy flips on, for the session, the first time a press is seen to
  // have had no keyup -- a WebView that never sends them falls back to press-on-keydown.
  const QA_TARGETS = '.card:not(.more-card), .ep';
  // NOTHING here trusts KeyboardEvent.repeat alone. Chromium on Android does not appear to set
  // it for a held hardware key, so a hold arrives as a stream of ordinary-looking keydowns
  // (first after ~400ms, then every ~50ms). Three defences: the app's native layer swallows
  // OK's repeats and announces a hold itself (key:okhold); a keydown within OK_RAPID of the
  // last one is treated as a repeat whatever its flag says; and a second keydown while a press
  // is still armed only counts as "this WebView sends no keyup" once it is too late to be a repeat.
  const OK_HOLD_MS = 550, OK_RAPID = 180, OK_LEGACY_AFTER = 900;
  let okTarget = null, okTimer = 0, okHeld = false, okUpSeen = true, okSwallow = false, okLegacy = false;
  let okUpEver = false, okDownAt = 0, okLastDown = 0;
  let tvLastPos = null;                              // where the ring was, for re-render recovery
  // Selection movement. The browser's own smooth scroll CANNOT be retargeted: press
  // Down again mid-animation and it starts a second one from wherever the first got
  // to, so a held D-pad reads as lag and then bounce. Ours keeps one animation per
  // scroller and just moves its target. Declared up here for the same reason as
  // everything else in this block — tvFocusEl runs on the boot render.
  const TV_GLIDE_MS = 170;
  const tvScrolls = [];
  let tvScrollRAF = 0;
  // Setting scrollTop/scrollLeft obeys scroll-behavior, so the CSS smooth-scroll on
  // <html> would animate every frame we write. Off on TV; styles.css does the rails.
  if (IS_TV) { try { document.documentElement.style.scrollBehavior = 'auto'; } catch (e) {} }
  /* A view change JUMPS to the top, it does not glide there. <html> is scroll-behavior: smooth,
     so a bare scrollTo(0, 0) starts an animation -- and a restore that lands while one is still
     running does not cancel it: Chromium offsets the running animation by the size of the jump.
     Open a title, go Back within ~300ms, and the page came to rest 770px short of where you
     left it. */
  /* Centre `el` in its own horizontal scroller, and touch nothing else. scrollIntoView also
     scrolls the PAGE when the element is below the fold (block: 'nearest' does not prevent
     that), and on a smooth <html> that is a glide: a show page opened from the top of Home slid
     down to the season pills by itself, and a restored place landed inside the glide, a row
     out. At render it is instant; `glide` is for a press, and defers to the rail's own CSS. */
  function centreIn(sc, el, glide) {
    if (!sc || !el) return;
    const pr = sc.getBoundingClientRect(), br = el.getBoundingClientRect();
    const l = Math.max(0, sc.scrollLeft + (br.left - pr.left) - (pr.width - br.width) / 2);
    try { sc.scrollTo({ left: l, behavior: glide ? 'auto' : 'instant' }); } catch (e) { sc.scrollLeft = l; }
  }
  function jumpTop() {
    try { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); } catch (e) { window.scrollTo(0, 0); }
  }
  let tvDomGen = 0;                                  // bumped whenever measured geometry can have changed
  let tvRowCache = null;                             // { gen, scope, rows } — see tvRowModel
  let tvMarked = null;                               // element currently wearing .tv-focus
  function openExternal(url) {
    if (IS_DESKTOP && window.reeldeck.openExternal) window.reeldeck.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  }

  const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513"><rect width="100%" height="100%" fill="#1a1f2b"/>' +
    '<g fill="#39415a"><path d="M171 210a34 34 0 100 68 34 34 0 000-68zm0 20a14 14 0 110 28 14 14 0 010-28z"/>' +
    '<rect x="96" y="300" width="150" height="10" rx="5"/><rect x="121" y="322" width="100" height="8" rx="4"/></g></svg>'
  );
  // TMDB paths are "/<alnum-or-._->.<ext>" and nothing else -- see any /movie/{id}
  // response. Anything else is not a poster, so it gets the placeholder rather than a
  // chance to break out of the attribute it is about to be interpolated into.
  const RX_IMGPATH = /^\/[A-Za-z0-9._-]{1,72}$/;
  function img(path, size) {
    if (!path || !RX_IMGPATH.test(path)) return PLACEHOLDER;
    return cfg.imgBase.replace(/\/+$/, '') + '/' + size + path;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function year(d) { return d ? String(d).slice(0, 4) : ''; }
  function runtimeStr(m) { if (!m) return ''; const h = Math.floor(m / 60), mm = m % 60; return (h ? h + 'h ' : '') + (mm ? mm + 'm' : ''); }

  /**
   * Runtime, filled in on hover or focus rather than up front.
   *
   * TMDB's LIST endpoints do not carry runtime -- only /movie/{id} and /tv/{id} do --
   * so showing it on every card would mean one request per card on every page. This
   * fetches once for the card actually being looked at, reuses itemCache so the
   * detail page it is probably about to open costs nothing, and writes into whatever
   * slots for that title are on screen.
   */
  const rtPending = {};
  async function fillRuntime(type, id) {
    const slots = document.querySelectorAll('.ch-rt[data-rt="' + type + ':' + id + '"]');
    if (!slots.length) return;
    let d = itemCache[ck(type, id)];
    if (!d || (d.runtime === undefined && d.episode_run_time === undefined)) {
      const key = type + ':' + id;
      if (rtPending[key]) return;                 // one flight per title
      rtPending[key] = 1;
      try { d = await tmdb('/' + type + '/' + id); itemCache[ck(type, id)] = d; }
      catch (e) { return; }
      finally { delete rtPending[key]; }
    }
    const mins = type === 'tv'
      ? ((d.episode_run_time && d.episode_run_time[0]) || 0)
      : (d.runtime || 0);
    const txt = type === 'tv'
      ? ((d.number_of_seasons ? d.number_of_seasons + ' season' + (d.number_of_seasons === 1 ? '' : 's') : '') +
         (mins ? ' \u00b7 ' + runtimeStr(mins) : ''))
      : runtimeStr(mins);
    if (!txt) return;
    document.querySelectorAll('.ch-rt[data-rt="' + type + ':' + id + '"]')
      .forEach(el => { el.textContent = ' \u00b7 ' + txt; });
  }
  function runtimeFor(card) {
    if (!card) return;
    const slot = card.querySelector('.ch-rt');
    if (!slot || slot.textContent) return;        // already filled
    const parts = (slot.dataset.rt || '').split(':');
    if (parts.length === 2) fillRuntime(parts[0], parts[1]);
  }
  // Debounced: walking a rail with a remote would otherwise fire a request per card
  // as the ring passes over it.
  const runtimeSoon = debounce((card) => runtimeFor(card), 350);
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); const a = arguments, c = this; t = setTimeout(() => fn.apply(c, a), ms); }; }

  /**
   * Tell a rail's chrome what the rail can actually do.
   *
   * The arrows and the edge fade used to be unconditional, so a row that fitted on
   * screen still drew both arrows -- the left one over its own first item -- and the
   * fade still dimmed a last card that was already fully visible.
   */
  function railChrome(track) {
    const wrap = track.parentElement;
    if (!wrap) return;
    const max = track.scrollWidth - track.clientWidth;
    const none = max <= 2;                       // nothing to scroll to at all
    wrap.classList.toggle('no-scroll', none);
    wrap.classList.toggle('at-start', none || track.scrollLeft <= 2);
    wrap.classList.toggle('at-end', none || track.scrollLeft >= max - 2);
  }
  const RAILS = '.rail-wrap > .track, .rail-wrap > .ep-strip, .rail-wrap > .season-pills, .rail-wrap > .cast-track, .ep-strip, .season-pills';
  function wireRailChrome() {
    document.querySelectorAll(RAILS).forEach(t => {
      if (t.__railWired) { railChrome(t); return; }
      t.__railWired = 1;
      t.addEventListener('scroll', () => railChrome(t), { passive: true });
      // A rail is usually empty on first paint and fills in when the request lands, so
      // one measurement at render time would be a measurement of nothing.
      // ResizeObserver on the track is NOT enough on its own: the track is the scroll
      // container, so its border box stays the same width when cards are added inside it
      // -- only scrollWidth changes, which RO does not report. It is kept for real size
      // changes (rotation, window resize) and the measurement is re-taken below.
      if (window.ResizeObserver) {
        try { new ResizeObserver(() => railChrome(t)).observe(t); } catch (e) {}
      }
      // Measured three times on purpose. The first can land in the same tick as the
      // insertion, before layout, where clientWidth is still 0 and the rail latches
      // "nothing to scroll" for good. rAF is after layout; the late one catches a rail
      // whose width settles with its images.
      railChrome(t);
      requestAnimationFrame(() => railChrome(t));
      setTimeout(() => railChrome(t), 600);
    });
  }
  const wireRailChromeSoon = debounce(wireRailChrome, 60);
  window.addEventListener('resize', wireRailChromeSoon, { passive: true });

  let toastTimer;
  // role="status" so the confirmation is actually announced — on TV the toast is the
  // only feedback the hero's Save button gives.
  function toast(msg) {
    let t = $('#toast');
    if (!t) {
      t = document.createElement('div'); t.id = 'toast'; t.className = 'toast';
      t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite');
    }
    // Re-homed on every call, not just on creation: the fullscreen element is a top
    // layer, so a toast left on document.body is not painted at all while the player is
    // fullscreened -- and 'Volume 40%' is the only feedback Vol +/-/Mute ever give.
    const host = overlayHost();
    if (t.parentNode !== host) host.appendChild(t);
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // Cache of items we render so watchlist toggles can find full data by id.
  const itemCache = {};
  const ck = (type, id) => type + ':' + id;

  /* ------------------------------------------------------------
     Icons
     ------------------------------------------------------------ */
  // Phosphor Icons (MIT) -- https://phosphoricons.com -- inlined rather than
  // linked: the desktop and Android builds run from a local file, and the
  // published artifact's CSP allows scripts from a short CDN allowlist only, so an
  // icon font or a runtime sprite fetch would fail exactly where the app is meant to
  // work offline. One family on one 256 grid; `fill` weight only where an icon has
  // to read as ON against its own OFF twin.
  const ICON = {
    play: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z"/></svg>',
    bookmark: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M184,32H72A16,16,0,0,0,56,48V224a8,8,0,0,0,12.24,6.78L128,193.43l59.77,37.35A8,8,0,0,0,200,224V48A16,16,0,0,0,184,32Zm0,177.57-51.77-32.35a8,8,0,0,0-8.48,0L72,209.57V48H184Z"/></svg>',
    bookmarkFill: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M184,32H72A16,16,0,0,0,56,48V224a8,8,0,0,0,12.24,6.78L128,193.43l59.77,37.35A8,8,0,0,0,200,224V48A16,16,0,0,0,184,32Z"/></svg>',
    search: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"/></svg>',
    gear: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm109.94-52.79a8,8,0,0,0-3.89-5.4l-29.83-17-.12-33.62a8,8,0,0,0-2.83-6.08,111.91,111.91,0,0,0-36.72-20.67,8,8,0,0,0-6.46.59L128,41.85,97.88,25a8,8,0,0,0-6.47-.6A112.1,112.1,0,0,0,54.73,45.15a8,8,0,0,0-2.83,6.07l-.15,33.65-29.83,17a8,8,0,0,0-3.89,5.4,106.47,106.47,0,0,0,0,41.56,8,8,0,0,0,3.89,5.4l29.83,17,.12,33.62a8,8,0,0,0,2.83,6.08,111.91,111.91,0,0,0,36.72,20.67,8,8,0,0,0,6.46-.59L128,214.15,158.12,231a7.91,7.91,0,0,0,3.9,1,8.09,8.09,0,0,0,2.57-.42,112.1,112.1,0,0,0,36.68-20.73,8,8,0,0,0,2.83-6.07l.15-33.65,29.83-17a8,8,0,0,0,3.89-5.4A106.47,106.47,0,0,0,237.94,107.21Zm-15,34.91-28.57,16.25a8,8,0,0,0-3,3c-.58,1-1.19,2.06-1.81,3.06a7.94,7.94,0,0,0-1.22,4.21l-.15,32.25a95.89,95.89,0,0,1-25.37,14.3L134,199.13a8,8,0,0,0-3.91-1h-.19c-1.21,0-2.43,0-3.64,0a8.08,8.08,0,0,0-4.1,1l-28.84,16.1A96,96,0,0,1,67.88,201l-.11-32.2a8,8,0,0,0-1.22-4.22c-.62-1-1.23-2-1.8-3.06a8.09,8.09,0,0,0-3-3.06l-28.6-16.29a90.49,90.49,0,0,1,0-28.26L61.67,97.63a8,8,0,0,0,3-3c.58-1,1.19-2.06,1.81-3.06a7.94,7.94,0,0,0,1.22-4.21l.15-32.25a95.89,95.89,0,0,1,25.37-14.3L122,56.87a8,8,0,0,0,4.1,1c1.21,0,2.43,0,3.64,0a8.08,8.08,0,0,0,4.1-1l28.84-16.1A96,96,0,0,1,188.12,55l.11,32.2a8,8,0,0,0,1.22,4.22c.62,1,1.23,2,1.8,3.06a8.09,8.09,0,0,0,3,3.06l28.6,16.29A90.49,90.49,0,0,1,222.9,142.12Z"/></svg>',
    star: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M234.29,114.85l-45,38.83L203,211.75a16.4,16.4,0,0,1-24.5,17.82L128,198.49,77.47,229.57A16.4,16.4,0,0,1,53,211.75l13.76-58.07-45-38.83A16.46,16.46,0,0,1,31.08,86l59-4.76,22.76-55.08a16.36,16.36,0,0,1,30.27,0l22.75,55.08,59,4.76a16.46,16.46,0,0,1,9.37,28.86Z"/></svg>',
    film: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M216,104H102.09L210,75.51a8,8,0,0,0,5.68-9.84l-8.16-30a15.93,15.93,0,0,0-19.42-11.13L35.81,64.74a15.75,15.75,0,0,0-9.7,7.4,15.51,15.51,0,0,0-1.55,12L32,111.56c0,.14,0,.29,0,.44v88a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V112A8,8,0,0,0,216,104ZM192.16,40l6,22.07-22.62,6L147.42,51.83Zm-66.69,17.6,28.12,16.24-36.94,9.75L88.53,67.37Zm-79.4,44.62-6-22.08,26.5-7L94.69,89.4ZM208,200H48V120H208v80Z"/></svg>',
    tv: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M216,64H147.31l34.35-34.34a8,8,0,1,0-11.32-11.32L128,60.69,85.66,18.34A8,8,0,0,0,74.34,29.66L108.69,64H40A16,16,0,0,0,24,80V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V80A16,16,0,0,0,216,64Zm0,136H40V80H216V200Z"/></svg>',
    back: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M165.66,202.34a8,8,0,0,1-11.32,11.32l-80-80a8,8,0,0,1,0-11.32l80-80a8,8,0,0,1,11.32,11.32L91.31,128Z"/></svg>',
    chevR: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z"/></svg>',
    info: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm16-40a8,8,0,0,1-8,8,16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40A8,8,0,0,1,144,176ZM112,84a12,12,0,1,1,12,12A12,12,0,0,1,112,84Z"/></svg>',
    plus: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"/></svg>',
    check: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/></svg>',
    x: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/></svg>',
    download: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z"/></svg>',
    user: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24ZM74.08,197.5a64,64,0,0,1,107.84,0,87.83,87.83,0,0,1-107.84,0ZM96,120a32,32,0,1,1,32,32A32,32,0,0,1,96,120Zm97.76,66.41a79.66,79.66,0,0,0-36.06-28.75,48,48,0,1,0-59.4,0,79.66,79.66,0,0,0-36.06,28.75,88,88,0,1,1,131.52,0Z"/></svg>',
    logout: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M120,216a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V40a8,8,0,0,1,8-8h64a8,8,0,0,1,0,16H56V208h56A8,8,0,0,1,120,216Zm109.66-93.66-40-40a8,8,0,0,0-11.32,11.32L204.69,120H112a8,8,0,0,0,0,16h92.69l-26.35,26.34a8,8,0,0,0,11.32,11.32l40-40A8,8,0,0,0,229.66,122.34Z"/></svg>',
    devices: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M224,72H208V64a24,24,0,0,0-24-24H40A24,24,0,0,0,16,64v96a24,24,0,0,0,24,24H152v8a24,24,0,0,0,24,24h48a24,24,0,0,0,24-24V96A24,24,0,0,0,224,72ZM40,168a8,8,0,0,1-8-8V64a8,8,0,0,1,8-8H184a8,8,0,0,1,8,8v8H176a24,24,0,0,0-24,24v72Zm192,24a8,8,0,0,1-8,8H176a8,8,0,0,1-8-8V96a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8Zm-96,16a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16h40A8,8,0,0,1,136,208Zm80-96a8,8,0,0,1-8,8H192a8,8,0,0,1,0-16h16A8,8,0,0,1,216,112Z"/></svg>',
    sync: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M224,48V96a8,8,0,0,1-8,8H168a8,8,0,0,1,0-16h28.69L182.06,73.37a79.56,79.56,0,0,0-56.13-23.43h-.45A79.52,79.52,0,0,0,69.59,72.71,8,8,0,0,1,58.41,61.27a96,96,0,0,1,135,.79L208,76.69V48a8,8,0,0,1,16,0ZM186.41,183.29a80,80,0,0,1-112.47-.66L59.31,168H88a8,8,0,0,0,0-16H40a8,8,0,0,0-8,8v48a8,8,0,0,0,16,0V179.31l14.63,14.63A95.43,95.43,0,0,0,130,222.06h.53a95.36,95.36,0,0,0,67.07-27.33,8,8,0,0,0-11.18-11.44Z"/></svg>',
    warn: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM222.93,203.8a8.5,8.5,0,0,1-7.48,4.2H40.55a8.5,8.5,0,0,1-7.48-4.2,7.59,7.59,0,0,1,0-7.72L120.52,44.21a8.75,8.75,0,0,1,15,0l87.45,151.87A7.59,7.59,0,0,1,222.93,203.8ZM120,144V104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,180Z"/></svg>',
    mail: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM203.43,64,128,133.15,52.57,64ZM216,192H40V74.19l82.59,75.71a8,8,0,0,0,10.82,0L216,74.19V192Z"/></svg>',
    restart: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M224,128a96,96,0,0,1-94.71,96H128A95.38,95.38,0,0,1,62.1,197.8a8,8,0,0,1,11-11.63A80,80,0,1,0,71.43,71.39a3.07,3.07,0,0,1-.26.25L44.59,96H72a8,8,0,0,1,0,16H24a8,8,0,0,1-8-8V56a8,8,0,0,1,16,0V85.8L60.25,60A96,96,0,0,1,224,128Z"/></svg>',
    theater: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,160H40V56H216V200Z"/></svg>',
    fullscreen: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M200,80v32a8,8,0,0,1-16,0V88H160a8,8,0,0,1,0-16h32A8,8,0,0,1,200,80ZM96,168H72V144a8,8,0,0,0-16,0v32a8,8,0,0,0,8,8H96a8,8,0,0,0,0-16ZM232,56V200a16,16,0,0,1-16,16H40a16,16,0,0,1-16-16V56A16,16,0,0,1,40,40H216A16,16,0,0,1,232,56ZM216,200V56H40V200H216Z"/></svg>',
  };

  /* ------------------------------------------------------------
     Watchlist (localStorage)
     ------------------------------------------------------------ */
  // Shape-checked like progAll/histAll/trackedAll: JSON.parse succeeding does not mean
  // an ARRAY came back, and every caller here calls .some/.map/.findIndex on it -- so a
  // single corrupt value would throw through every card render on the page.
  function getWatch() {
    try { const a = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  // Quota is the realistic failure (a big watchlist plus history plus progress); losing
  // the write is survivable, throwing out of a click handler is not.
  function setWatch(a) { try { localStorage.setItem(WATCH_KEY, JSON.stringify(a)); } catch (e) { toast('Could not save \u2014 storage is full'); } }
  function isInWatch(id, type) { return getWatch().some(x => x.id == id && x.type === type); }
  function toggleWatch(item, type) {
    const list = getWatch();
    const i = list.findIndex(x => x.id == item.id && x.type === type);
    if (i >= 0) {
      list.splice(i, 1); setWatch(list);
      // A splice leaves no evidence, so a union merge would hand this straight back
      // from any device that still has it. The tombstone is the evidence.
      tombMark('w:' + type + ':' + item.id);
      toast('Removed from watchlist'); syncFlush('unwatch'); return false;
    }
    list.unshift({
      id: item.id, type,
      title: item.title || item.name,
      poster_path: item.poster_path,
      vote_average: item.vote_average,
      date: item.release_date || item.first_air_date || '',
      at: now()
    });
    setWatch(list); toast('Added to watchlist'); syncFlush('watch'); return true;
  }


  /* ------------------------------------------------------------
     Watch progress + history (localStorage)

     A cross-origin player cannot be scripted, so there is no reading currentTime
     off the <video> inside a mirror. Two tiers instead:

       provider - the mirror POSTS its own position to the parent. Several document a
                  MEDIA_DATA / PLAYER_EVENT message carrying currentTime + duration,
                  and the rest that report at all use the same shape. Exact, and the
                  only real answer available.
       elapsed  - nobody posted, so we count wall-clock seconds the player was open.
                  Enough to say "you were here" and to draw a bar; never shown as an
                  exact timestamp, and never allowed to overwrite a provider value.

     Episodes are kept forever — coming back to a series after a year is the norm.
     A half-watched film is only interesting for a while, so movies age out.
     ------------------------------------------------------------ */
  // 90%, not 100%: credits, next-episode teasers and provider padding mean a
  // finished episode almost never reports 100%, and an episode stuck at "96%
  // watched" in Continue-watching forever is worse than one marked done early.
  const DONE_PCT = 0.9;
  const MOVIE_TTL = 60 * 86400000;      // 60 days
  const HIST_MAX = 300;

  function num(v) {
    const n = (typeof v === 'string') ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : null;
  }
  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s2).padStart(2, '0');
  }
  function progAll() {
    let p; try { p = JSON.parse(localStorage.getItem(PROG_KEY) || '{}'); } catch (e) { p = {}; }
    return (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
  }
  function progSave(p) { try { localStorage.setItem(PROG_KEY, JSON.stringify(p)); } catch (e) {} }
  function progKey(type, id, s2, e2) {
    return type === 'tv' ? ('tv:' + id + ':' + (s2 || 1) + ':' + (e2 || 1)) : ('movie:' + id);
  }
  function progPrune(p) {
    const nowMs = now(); let changed = false;
    for (const k in p) {
      // The TTL is for HALF-watched films: a resume point from March is noise by June. A
      // FINISHED film is a fact about the viewer, and it was expiring on the same clock --
      // mark something watched and sixty days later it quietly said "Mark watched" again.
      if (k.indexOf('movie:') === 0 && !progDone(p[k]) && (nowMs - ((p[k] && p[k].at) || 0)) > MOVIE_TTL) { delete p[k]; changed = true; }
    }
    return changed;
  }
  function progGet(type, id, s2, e2) {
    const p = progAll();
    if (progPrune(p)) progSave(p);
    return p[progKey(type, id, s2, e2)] || null;
  }
  /** Where you left off in a series: { s, e, at }. */
  function progShow(id) { return progAll()['tv:' + id] || null; }
  function progDone(pr) { return !!(pr && pr.pct >= DONE_PCT); }

  function progRecord(o) {
    if (!o || !o.id) return;
    const p = progAll(); progPrune(p);
    const k = progKey(o.type, o.id, o.season, o.episode);
    const prev = p[k] || {};
    const dur = (o.d > 0) ? o.d : (prev.d || 0);
    let t = (num(o.t) != null && o.t >= 0) ? o.t : (prev.t || 0);
    // A wall-clock guess must never walk over a real timestamp from the player. One exception,
    // granted by watchTick (`takeover`): a LEFTOVER from an earlier sitting or an earlier mirror,
    // on a mirror that has had two foreground minutes to report and has not -- forward only, and
    // never over a finished / marked-watched entry. Without it the first mirror that reported
    // pinned the episode for good: nothing watched afterwards on a silent one was recorded.
    if (o.src !== 'provider' && prev.src === 'provider' &&
        !(o.takeover && !progDone(prev) && t > (prev.t || 0))) return;
    const pct = dur > 0 ? Math.max(0, Math.min(1, t / dur)) : (prev.pct || 0);
    p[k] = { t: Math.round(t), d: Math.round(dur), pct: pct, at: now(), src: o.src || prev.src || 'elapsed' };
    // A takeover moves the BAR on; it must not throw away the last moment a mirror actually
    // reported, which is the only thing good enough to seek to. Without this, two foreground
    // minutes on a silent mirror's poster turned "Resume at 1:05:06" into a guess, the next
    // reporting mirror opened at 0:00, and its first report overwrote the lot. A provider write
    // builds a fresh entry, so the field drops out by itself once a mirror speaks again.
    const sk = prev.src === 'provider' ? (prev.t || 0) : (prev.seek || 0);
    if (p[k].src !== 'provider' && sk > 0) p[k].seek = Math.round(sk);
    // Series-level pointer: which episode to drop the user back on.
    if (o.type === 'tv') p['tv:' + o.id] = { s: +o.season || 1, e: +o.episode || 1, at: now() };
    progSave(p);
    histPush(o, pct);
    syncMark();
  }

  /**
   * "I watched this" without a player having said so.
   *
   * Written as a PROVIDER entry on purpose: pickProg ranks provider over elapsed
   * regardless of age, so a deliberate mark survives the wall-clock guess a later
   * rewatch would make -- while a mirror that does report its position still wins by
   * recency, as it should. The series pointer moves forward only, never back.
   * `quiet` keeps a bulk season mark out of the history log, where ten identical rows
   * stamped in the same second would bury everything else.
   */
  function progMarkWatched(o) {
    if (!o || !o.id) return;
    const p = progAll(); progPrune(p);
    const k = progKey(o.type, o.id, o.season, o.episode);
    const dur = Math.max(0, Math.round(o.d || 0));
    p[k] = { t: dur, d: dur, pct: 1, at: now(), src: 'provider' };
    if (o.type === 'tv') {
      const cur = p['tv:' + o.id];
      const s = +o.season || 1, e = +o.episode || 1;
      if (!cur || (s * 1000 + e) >= ((cur.s || 0) * 1000 + (cur.e || 0))) p['tv:' + o.id] = { s: s, e: e, at: now() };
    }
    progSave(p);
    if (!o.quiet) histPush(o, 1);
    syncFlush('mark');
  }

  function histAll() {
    try { const h = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); return Array.isArray(h) ? h : []; }
    catch (e) { return []; }
  }
  function histSave(h) { try { localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, HIST_MAX))); } catch (e) {} }
  // Two epochs rather than several hundred tombstones. Without them, "I cleared my
  // history and it came back" is a guaranteed bug the first time a second device syncs.
  // The epoch is only stamped while signed in. A guest clearing their own history has
  // no account to propagate it to -- and stamping anyway means that epoch is max'd into
  // the account on first sign-in and then deletes rows from devices that had nothing to
  // do with the clear, which is the same class of bug as importing the account's epoch
  // into a guest's local rows.
  function histClear() {
    try { localStorage.removeItem(HIST_KEY); } catch (e) {}
    if (!syncOn()) return;
    const st = syncState(); st.clearedAt.hist = now(); saveSyncState(st);
  }
  function progClear() {
    try { localStorage.removeItem(PROG_KEY); } catch (e) {}
    if (!syncOn()) return;
    const st = syncState(); st.clearedAt.prog = now(); saveSyncState(st);
  }
  function relTime(ms) {
    const sec = Math.max(0, (now() - (ms || 0)) / 1000);
    if (sec < 90) return 'just now';
    const m = sec / 60; if (m < 60) return Math.round(m) + 'm ago';
    const h = m / 60; if (h < 24) return Math.round(h) + 'h ago';
    const dd = h / 24; if (dd < 7) return Math.round(dd) + 'd ago';
    try { return new Date(ms).toLocaleDateString(); } catch (e) { return 'a while ago'; }
  }
  /** "Sep 14" this year, "May 19, 2019" any other -- an air date for a pill or a badge. */
  function shortDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso + 'T12:00:00');
      const o = { month: 'short', day: 'numeric' };
      if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
      return d.toLocaleDateString(undefined, o);
    } catch (e) { return iso; }
  }
  function histPush(o, pct) {
    const h = histAll();
    const k = progKey(o.type, o.id, o.season, o.episode);
    const i = h.findIndex(x => x.k === k);
    const old = i >= 0 ? h[i] : {};
    const row = {
      k: k, id: o.id, type: o.type,
      title: o.title || old.title || '',
      poster_path: o.poster_path || old.poster_path || '',
      s: o.season || null, e: o.episode || null,
      pct: pct, at: now()
    };
    if (i >= 0) h.splice(i, 1);
    h.unshift(row);
    histSave(h);
  }

  /**
   * Where "play this show" should actually go.
   *
   * A series is not a thing you start from episode 1 every time. progShow() remembers
   * the last episode opened for a show, so every Play / Watch now / poster-overlay
   * link resumes there instead of dropping the viewer back on S1E1. Movies have
   * nowhere else to go, and an unwatched show correctly falls through to the default.
   */
  function watchHref(type, id) {
    if (type !== 'tv') return '#/watch/movie/' + id;
    const last = progShow(id);
    return last ? ('#/watch/tv/' + id + '?s=' + (last.s || 1) + '&e=' + (last.e || 1))
                : ('#/watch/tv/' + id);
  }
  /** Start over: episode one, or the beginning of the film. */
  function restartHref(type, id) {
    return type === 'tv' ? ('#/watch/tv/' + id + '?s=1&e=1&restart=1')
                         : ('#/watch/movie/' + id + '?restart=1');
  }
  /** Started at all? Decides whether Restart is worth offering. */
  function hasAnyProgress(type, id) {
    if (type === 'tv') return !!progShow(id);
    const pr = progGet('movie', id);
    return !!(pr && pr.pct > 0.01);
  }

  /** "Watch now" / "Resume S2 E5" — say which it is before they press it. */
  function watchLabel(type, id) {
    if (type !== 'tv') return 'Watch now';
    const last = progShow(id);
    return last ? ('Resume S' + (last.s || 1) + ' \u00b7 E' + (last.e || 1)) : 'Watch now';
  }

  /** Drop one entry from BOTH stores, so a dismissed title stops resurfacing. */
  /**
   * Dismiss an entire title from the shelf.
   *
   * The rail shows one tile per series, so removing it has to take every episode with
   * it. Forgetting only the episode on top would surface the previous one in its place,
   * and the tile would have to be dismissed once per episode ever watched before the
   * show finally went away.
   */
  function progForgetGroup(g) {
    if (!g) return progForget(null);
    const m = /^(movie|tv):(\d+)$/.exec(g);
    if (!m) return progForget(g);
    const type = m[1], id = m[2];
    const keys = histAll().filter(r => r.type === type && String(r.id) === id).map(r => r.k);
    if (!keys.length) return;
    // progForget saves and flushes each time; do the whole set, then let the last call
    // carry the sync. Cheap enough at history size, and it keeps one code path for the
    // pointer cleanup that a series needs.
    keys.forEach(progForget);
  }

  function progForget(key) {
    if (!key) return;
    const p = progAll();
    delete p[key];
    // A series pointer with no episodes left behind it would keep aiming "Resume" at
    // an episode the user has explicitly dismissed.
    const m = /^tv:(\d+):/.exec(key);
    tombMark('p:' + key);
    if (m && !Object.keys(p).some(k => k.indexOf('tv:' + m[1] + ':') === 0)) {
      delete p['tv:' + m[1]];
      tombMark('p:tv:' + m[1]);
    }
    progSave(p);
    histSave(histAll().filter(r => r.k !== key));
    syncFlush('forget');
  }

  /**
   * How far through a title the viewer is, 0..1, for the bar under a poster.
   * For a series this is the LAST EPISODE they opened -- progress through the show
   * as a whole would need every episode's runtime and would read as near-zero for
   * anything long, which tells nobody anything useful.
   */
  function cardProgress(type, id) {
    if (type === 'tv') {
      const last = progShow(id);
      if (!last) return 0;
      const pr = progGet('tv', id, last.s, last.e);
      return pr ? Math.min(1, pr.pct || 0) : 0;
    }
    const pr = progGet('movie', id);
    return pr ? Math.min(1, pr.pct || 0) : 0;
  }

  /**
   * History collapsed to one row per TITLE, newest first.
   *
   * histAll() is per EPISODE, which is right for the history log and wrong for the
   * shelf: four episodes of one show took four of the rail's twenty slots and pushed
   * everything else off it. Since histAll() is already newest-first, the first row seen
   * for a series IS the latest episode watched, so this keeps that one and drops the
   * rest -- no sorting, no date comparison.
   *
   * `n` is how many episodes of that series are behind the tile, so the caller can say
   * so instead of silently hiding them.
   */
  function histByTitle(rows) {
    const seen = Object.create(null);
    const out = [];
    for (const r of (rows || histAll())) {
      const g = r.type + ':' + r.id;          // series, not episode
      if (seen[g]) { seen[g].n++; continue; }
      const row = Object.assign({}, r, { g: g, n: 1 });
      seen[g] = row;
      out.push(row);
    }
    return out;
  }

  /** The shared progress strip: a bar plus an honest label. */
  function progBar(pr) {
    if (!pr || !(pr.pct > 0.01)) return '';
    const done = progDone(pr);
    const pctN = Math.round(Math.min(1, pr.pct) * 100);
    // Only claim a timestamp when the mirror actually gave us one.
    const label = done ? 'Watched'
      : (pr.src === 'provider' && pr.t > 0) ? ('Resume at ' + fmtClock(pr.t))
      : (pctN + '% in');
    return '<div class="prog' + (done ? ' done' : '') + '">' +
      '<div class="prog-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"' +
      ' aria-valuenow="' + pctN + '" aria-label="' + (done ? 'Watched' : 'Watched ' + pctN + ' percent') + '">' +
      '<i style="width:' + pctN + '%"></i></div>' +
      '<span class="prog-lbl">' + label + '</span></div>';
  }

  /* ---- Which mirrors actually report their position -----------------------
     We cannot add a postMessage API to somebody else's player, so "verified" is
     something a mirror demonstrates, not something we can grant it. Seeded with the
     one provider that documents the API, then grown AT RUNTIME: the first time a
     mirror sends us a usable position it is promoted for good on this device. That
     way the badge reflects what actually happened here rather than a claim. */
  // The seed arrives with the rows, and every flagged row was confirmed against a
  // FIRST-PARTY source: the provider's own docs page or, failing that, its own shipped
  // player bundle. Nothing is flagged on resemblance to another provider, and the ones
  // that publish nothing we could confirm are deliberately unflagged -- they can still
  // earn the badge at runtime the first time they report a real position.
  /* ============================================================
     CROSS-DEVICE SYNC
     ------------------------------------------------------------
     The server (worker/reeldeck-sync.js) is a dumb blob store: it holds one JSON
     document per uid and has no merge, no compare-and-swap and no delete. Every
     reconciliation decision therefore lives here, which is deliberate -- it means
     there is exactly one place the logic can be wrong, and it is a place that can
     be tested without a network.

     WHAT IS SYNCED: watchlist, watch progress, history, and the theme id.
     WHAT IS NOT, and why it matters: nothing else from cfg. `sources[].movie` is
     the URL the player frames, and the postMessage origin check validates against
     whatever we chose to frame -- so a rewritten source list defeats that check by
     construction. `tmdbBase` would redirect every search. `apkShortUrl` is painted
     by getAppView() as a QR code and a type-in address under printed instructions
     to allow unknown sources and click past Play Protect. Syncing cfg would turn a
     leaked uid from "they can see what I watched" into "they can install software
     on my television". The theme is whitelisted as a single field, by id, because
     applyTheme() resolves it through THEMES.find(...) || THEMES[0] and an unknown
     value can therefore only fall back, never inject.
     ============================================================ */

  function syncState() {
    let st;
    try { st = JSON.parse(localStorage.getItem(SYNC_KEY) || '{}'); } catch (e) { st = {}; }
    if (!st || typeof st !== 'object' || Array.isArray(st)) st = {};
    if (!st.clearedAt || typeof st.clearedAt !== 'object') st.clearedAt = { prog: 0, hist: 0 };
    return Object.assign({
      on: false, uid: '', kind: '', name: '', pic: '',
      lastSyncAt: 0, skew: 0, dirty: false, migrated: 0,
      themeAt: 0, stall: '', lastErr: ''
    }, st);
  }
  function saveSyncState(st) {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(st)); } catch (e) {}
  }
  function syncOn() { const st = syncState(); return !!(st.on && st.uid); }

  /**
   * Wall clock corrected toward the server.
   *
   * Every `at` in every store is stamped by whichever device wrote it, and a TV with
   * a year-fast clock would otherwise win every last-write-wins comparison forever.
   * The correction is learned from /v1/push, which is the only call that returns the
   * server's CURRENT time -- /v1/pull returns the timestamp of the last push, which
   * is stale by construction and on an empty account is 0.
   */
  function now() { return Date.now() + (syncState().skew || 0); }
  // Set once the server has told us its clock. Session-scoped on purpose: it answers
  // "has THIS run validated the clock", which is the only question the badclock guard
  // needs, and it cannot be poisoned by a stale stored value.
  let skewKnown = false;
  function learnSkew(serverAt, t0, t1) {
    if (!(serverAt > 0)) return;
    // The midpoint estimate assumes the local clock is monotone ACROSS the request. On
    // a TV box with no RTC that is exactly what fails: the app syncs at its build date,
    // Android's NTP client corrects the clock while the request is in flight, and the
    // apparent round trip becomes years. syncCall aborts at 8s, so any legitimate RTT
    // is bounded -- a longer one is a clock jump, not a measurement, and trusting it
    // would put syncNow years ahead, where the same pass expires every tombstone (which
    // resurrects every deletion account-wide) and every movie resume point, then
    // pushes that.
    const rtt = t1 - t0;
    if (!(rtt >= 0 && rtt <= 15000)) return;
    skewKnown = true;                  // the server's clock reached us and was plausible
    const est = serverAt - (t0 + (t1 - t0) / 2);
    const st = syncState();
    // 30s hysteresis. Without it, a couple of hundred milliseconds of network noise
    // changes skew on every sync, which changes every stamp written, which changes
    // the blob, which forces another push -- ping-pong through the back door.
    if (Math.abs(est - (st.skew || 0)) > 30000) { st.skew = est; saveSyncState(st); }
  }

  /* ---- tombstones ---------------------------------------------------------
     Deletion in every one of these stores is invisible: a splice, a `delete`, a
     removeItem. A union merge therefore resurrects everything the user ever removed,
     which reads as the app being broken. A tombstone is the minimum information that
     makes "absent" distinguishable from "deleted": one namespaced key, one timestamp.
     "p:" covers both the progress entry and the history row, which already share a
     key -- progForget deletes both by it.
     ------------------------------------------------------------------------- */
  function tombAll() {
    let t; try { t = JSON.parse(localStorage.getItem(TOMB_KEY) || '{}'); } catch (e) { t = {}; }
    return (t && typeof t === 'object' && !Array.isArray(t)) ? t : {};
  }
  function tombSave(t) { try { localStorage.setItem(TOMB_KEY, JSON.stringify(t)); } catch (e) {} }
  function tombMark(key) {
    const t = tombAll();
    t[key] = now();
    tombSave(t);
  }

  /**
   * One-time migration: give existing watchlist entries a timestamp.
   *
   * The stamp is anchored in the deep past and ordered by array position, because
   * toggleWatch unshifts -- so index 0 is newest and must get the largest value to
   * preserve the order the user already sees. Date.now() would flatten that order into
   * a single millisecond AND rank every legacy entry above genuinely recent remote
   * additions.
   *
   * This cannot cause a mass deletion: the only thing that removes a stamped entry is
   * a tombstone, and no tombstone can predate the release that introduced them. It
   * also cannot cause a mass resurrection, because a resurrection needs a delete that
   * left no trace -- and the deletes that left no trace are exactly the ones made
   * before this code shipped, which are unrecoverable on any design. First sync is a
   * documented union of both devices' pre-upgrade lists.
   */
  const MIG_EPOCH = 1577836800000;                 // 2020-01-01
  function runMigrations() {
    const st = syncState();
    if (st.migrated >= 1) return;
    const list = getWatch();
    let touched = false;
    list.forEach((e, i) => {
      if (!(e.at > 0)) { e.at = MIG_EPOCH + (list.length - i); touched = true; }
    });
    if (touched) setWatch(list);
    st.migrated = 1;
    saveSyncState(st);
  }

  /* ---- the pure merge engine ---------------------------------------------
     No I/O and no Date.now() below this line: `syncNow` is passed in, frozen for the
     whole pass. That is what makes the whole thing unit-testable.
     ------------------------------------------------------------------------- */
  const RX_PROGKEY = /^(movie:\d{1,9}|tv:\d{1,9}(:\d{1,4}:\d{1,4})?)$/;
  const RX_TOMBKEY = /^(w:(movie|tv):\d{1,9}|p:(movie:\d{1,9}|tv:\d{1,9}(:\d{1,4}:\d{1,4})?))$/;

  /** A bad or missing stamp coerces to 0, never to now(). Coercing to now() would make
   *  every malformed remote row the newest thing in the account, so a hostile blob of
   *  `at:"lol"` rows would win every comparison and overwrite the user's whole library.
   *  The upper clamp doubles as the clock-skew defence: it is applied to BOTH sides, so
   *  a device with a wildly fast clock has its own inflated stamps pulled back too. */
  function clampAt(v, ceiling, floorTo) {
    const n = +v;
    if (!isFinite(n) || !(n > 0)) return 0;
    return n > ceiling ? floorTo : n;
  }

  /**
   * The newest stamp anywhere in a blob.
   *
   * This exists because the clamp ceiling cannot be derived from the local clock alone.
   * A cheap Android TV box with no RTC boots at its build date; if it syncs in the
   * seconds before Android's NTP client corrects the clock, every stamp in the ACCOUNT
   * is above `syncNow + 24h` and would be flattened to that wrong value -- and then
   * pushed, permanently destroying the ordering of the whole account, expiring every
   * tombstone at once (resurrecting every deletion) and rolling back both clear epochs.
   * The account's own newest stamp is a far better lower bound on "now" than a clock
   * that has never been set, so it is what the ceiling is built from.
   */
  function blobMaxAt(b) {
    if (!b || typeof b !== 'object') return 0;
    let m = 0;
    const bump = (v) => { const n = +v; if (isFinite(n) && n > m) m = n; };
    (Array.isArray(b.watch) ? b.watch : []).forEach(w => w && bump(w.at));
    (Array.isArray(b.hist) ? b.hist : []).forEach(r => r && bump(r.at));
    if (b.prog && typeof b.prog === 'object') for (const k in b.prog) { const v = b.prog[k]; if (v) bump(v.at); }
    if (b.tomb && typeof b.tomb === 'object') for (const k in b.tomb) bump(b.tomb[k]);
    if (b.clearedAt) { bump(b.clearedAt.prog); bump(b.clearedAt.hist); }
    if (b.theme) bump(b.theme.at);
    return m;
  }

  function sanitize(b, ceiling, floorTo) {
    const out = { v: 1, watch: [], prog: {}, hist: [], tomb: {},
                  clearedAt: { prog: 0, hist: 0 }, theme: { id: '', at: 0 } };
    if (!b || typeof b !== 'object') return out;
    const poster = p => (typeof p === 'string' && RX_IMGPATH.test(p)) ? p : '';
    const str = (v, n) => String(v == null ? '' : v).slice(0, n);

    (Array.isArray(b.watch) ? b.watch : []).slice(0, WATCH_MAX).forEach(w => {
      if (!w || typeof w !== 'object') return;
      const type = (w.type === 'tv' || w.type === 'movie') ? w.type : null;
      const id = parseInt(w.id, 10);
      if (!type || !(id > 0)) return;
      out.watch.push({ id: id, type: type, title: str(w.title, 200),
                       poster_path: poster(w.poster_path),
                       vote_average: (+w.vote_average || 0), date: str(w.date, 10),
                       at: clampAt(w.at, ceiling, floorTo) });
    });

    const p = (b.prog && typeof b.prog === 'object' && !Array.isArray(b.prog)) ? b.prog : {};
    let n = 0;
    for (const k in p) {
      if (++n > PROG_MAX + 1000) break;
      if (!RX_PROGKEY.test(k)) continue;
      const v = p[k];
      if (!v || typeof v !== 'object') continue;
      out.prog[k] = /^tv:\d+$/.test(k)
        ? { s: Math.max(1, parseInt(v.s, 10) || 1), e: Math.max(1, parseInt(v.e, 10) || 1),
            at: clampAt(v.at, ceiling, floorTo) }
        : { t: Math.max(0, Math.round(+v.t) || 0), d: Math.max(0, Math.round(+v.d) || 0),
            pct: Math.max(0, Math.min(1, +v.pct || 0)), at: clampAt(v.at, ceiling, floorTo),
            src: v.src === 'provider' ? 'provider' : 'elapsed' };
      // The seek point under a wall-clock entry (progRecord). Whitelisted HERE or it does nothing:
      // a sync pass sanitises the LOCAL store too, and would strip it on the device that wrote it.
      if (out.prog[k].src === 'elapsed' && +v.seek > 0) out.prog[k].seek = Math.min(out.prog[k].t, Math.round(+v.seek));
    }

    (Array.isArray(b.hist) ? b.hist : []).slice(0, HIST_MAX).forEach(r => {
      if (!r || typeof r !== 'object' || !RX_PROGKEY.test(String(r.k))) return;
      const type = (r.type === 'tv' || r.type === 'movie') ? r.type : null;
      const id = parseInt(r.id, 10);
      if (!type || !(id > 0)) return;
      out.hist.push({ k: String(r.k), id: id, type: type, title: str(r.title, 200),
                      poster_path: poster(r.poster_path),
                      s: r.s == null ? null : (parseInt(r.s, 10) || null),
                      e: r.e == null ? null : (parseInt(r.e, 10) || null),
                      pct: Math.max(0, Math.min(1, +r.pct || 0)),
                      at: clampAt(r.at, ceiling, floorTo) });
    });

    const t = (b.tomb && typeof b.tomb === 'object' && !Array.isArray(b.tomb)) ? b.tomb : {};
    let m = 0;
    for (const k in t) {
      if (++m > TOMB_MAX + 500) break;
      if (!RX_TOMBKEY.test(k)) continue;
      const at = clampAt(t[k], ceiling, floorTo);
      if (at > 0) out.tomb[k] = at;
    }

    const c = (b.clearedAt && typeof b.clearedAt === 'object') ? b.clearedAt : {};
    out.clearedAt = { prog: clampAt(c.prog, ceiling, floorTo), hist: clampAt(c.hist, ceiling, floorTo) };

    // Theme by id against the known list -- the whitelist that makes this one field
    // safe to accept from a server when the object it lives in is not.
    const th = (b.theme && typeof b.theme === 'object') ? b.theme : {};
    const tid = String(th.id == null ? '' : th.id);
    out.theme = { id: THEMES.some(x => x.id === tid) ? tid : '', at: clampAt(th.at, ceiling, floorTo) };
    return out;
  }

  /**
   * Which of two progress entries survives.
   *
   * `src` outranks recency, and that ordering is load-bearing. progRecord() already
   * refuses to let a wall-clock guess overwrite a value the player itself reported, so
   * if the merge preferred newest-`at` the same two viewings would resolve differently
   * depending on whether they happened on one device or two -- a resume position that
   * no local action could produce. The merge has to be a function that COULD have been
   * produced by a sequence of local writes. Secondarily: `src` states measurement
   * quality, which no clock can forge, while `at` states recency, which a bad clock
   * wrecks -- so the field trusted most is the one hardest to get wrong.
   */
  function pickProg(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.s !== undefined || b.s !== undefined) {        // series pointer: no src
      if (a.s === undefined) return b;
      if (b.s === undefined) return a;
      if (a.at !== b.at) return a.at > b.at ? a : b;
      return (a.s * 1000 + a.e) >= (b.s * 1000 + b.e) ? a : b;
    }
    const ap = a.src === 'provider', bp = b.src === 'provider';
    if (ap !== bp) {
      // Provider outranks elapsed -- except that a NEWER elapsed entry moves an UNFINISHED
      // provider one forward, as progRecord now can. Without this every sync put the stale
      // provider entry straight back.
      const P = ap ? a : b, E = ap ? b : a;
      return (!progDone(P) && E.at > P.at && (E.t | 0) > (P.t | 0)) ? E : P;
    }
    if (a.at !== b.at) return a.at > b.at ? a : b;
    if (a.pct !== b.pct) return a.pct > b.pct ? a : b;
    return (a.t | 0) >= (b.t | 0) ? a : b;               // total order, so deterministic
  }
  function pickHist(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.at !== b.at) return a.at > b.at ? a : b;
    if (a.pct !== b.pct) return a.pct > b.pct ? a : b;
    return (a.title <= b.title) ? a : b;
  }

  /** Cap the progress store. Series pointers are exempt -- they are tiny, and dropping
   *  one silently moves where "Resume" lands. */
  function capProg(pg) {
    const eps = Object.keys(pg).filter(k => !/^tv:\d+$/.test(k));
    if (eps.length <= PROG_MAX) return;
    eps.sort((a, b) => (pg[b].at - pg[a].at) || (a < b ? -1 : 1));
    eps.slice(PROG_MAX).forEach(k => { delete pg[k]; });
  }

  /** A series pointer aiming at an episode that no longer exists would send Resume
   *  nowhere. Mirrors what progForget already does locally. */
  function repairPointers(pg) {
    // Rebuild a pointer that went missing. progForget drops the series pointer when the
    // device it ran on has no episodes left for that show -- but ANOTHER device may
    // still hold several, and the tombstone removes the pointer account-wide. Without
    // this the show silently loses its resume position everywhere while its episode
    // progress survives, and nothing ever puts it back.
    const shows = {};
    Object.keys(pg).forEach(k => {
      const m2 = /^tv:(\d+):(\d+):(\d+)$/.exec(k);
      if (m2) shows[m2[1]] = true;
    });
    Object.keys(shows).forEach(id => {
      if (pg['tv:' + id]) return;
      const pre = 'tv:' + id + ':';
      const eps = Object.keys(pg).filter(x => x.indexOf(pre) === 0);
      eps.sort((a, b) => (pg[b].at - pg[a].at) || (a < b ? -1 : 1));
      const best = /^tv:\d+:(\d+):(\d+)$/.exec(eps[0]);
      // Inherit the episode's own stamp, never a fresh one -- a new stamp here would
      // make the merged blob differ from the pulled one on every pass.
      pg['tv:' + id] = { s: +best[1], e: +best[2], at: pg[eps[0]].at };
    });
    Object.keys(pg).forEach(k => {
      const m = /^tv:(\d+)$/.exec(k);
      if (!m) return;
      const pre = 'tv:' + m[1] + ':';
      const eps = Object.keys(pg).filter(x => x.indexOf(pre) === 0);
      if (!eps.length) { delete pg[k]; return; }
      const ptr = pg[k];
      if (pg[pre + ptr.s + ':' + ptr.e]) return;         // still valid
      eps.sort((a, b) => (pg[b].at - pg[a].at) || (a < b ? -1 : 1));
      const best = /^tv:\d+:(\d+):(\d+)$/.exec(eps[0]);
      // KEEP the original `at`. Restamping to now() would make the merged blob differ
      // from the pulled blob on every single pass -- the ping-pong failure mode.
      pg[k] = { s: +best[1], e: +best[2], at: ptr.at };
    });
  }

  /**
   * Merge a pulled blob with local state. Pure.
   *
   * Idempotent by construction: every input is sanitized to a fixed point, every
   * ordering is total, and nothing is restamped with a fresh clock. Running
   * pull-merge-push twice must produce a byte-identical blob the second time, or two
   * devices push at each other forever.
   */
  function mergeBlob(remoteRaw, syncNow) {
    const st = syncState();
    // See blobMaxAt: a device whose clock is behind must not drag the account back.
    // syncNow is server-corrected before this runs (syncCall learns skew from the
    // `now` on every response, and syncOnce takes syncNow after the pull), so the
    // ceiling can be tight. A blob that is nonetheless far ahead of it means the clock
    // could not be validated at all -- syncOnce refuses to merge in that case rather
    // than reaching this line.
    const floorTo = syncNow;
    const ceiling = syncNow + FUTURE_SLACK;
    const R = sanitize(remoteRaw, ceiling, floorTo);
    const L = sanitize({ watch: getWatch(), prog: progAll(), hist: histAll(),
                         tomb: tombAll(), clearedAt: st.clearedAt,
                         theme: { id: cfg.theme, at: st.themeAt } }, ceiling, floorTo);
    const out = { v: 1 };

    /* First contact between THIS device's data and THIS account.
       The account's clear-history epochs are the account's own past, not this
       device's. Applying them to rows that were only ever local would delete a
       guest's entire history at the exact moment they sign in -- everything they
       watched predates a Clear somebody performed on another device months ago.
       So on the first merge after adopting an identity, local rows are exempt from
       the epochs; remote rows still obey them. */
    // An EXPLICIT one-shot flag, not a comparison of uid against boundUid. adoptUid
    // now sets both to the same value before it calls syncOnce -- a later fix, made for
    // its own good reasons -- so "boundUid !== uid" was always false and this whole
    // exemption was dead code. Which means the bug it exists to prevent, a guest's
    // entire history being deleted the moment they sign in to an account that has ever
    // had its history cleared, was silently back.
    const firstAdopt = !!st.adopting;
    const localProg = firstAdopt ? Object.keys(L.prog) : [];
    const localHist = firstAdopt ? L.hist.map(r => r.k) : [];
    const keptLocal = (arr, k) => firstAdopt && arr.indexOf(k) >= 0;

    // 1. monotone scalars
    out.clearedAt = { prog: Math.max(L.clearedAt.prog, R.clearedAt.prog),
                      hist: Math.max(L.clearedAt.hist, R.clearedAt.hist) };

    // 2. theme: newest stamp wins, strict > so local wins a tie
    out.theme = (R.theme.id && R.theme.at > L.theme.at) ? R.theme : L.theme;

    // 3. tombstones: union by max, then age out and cap
    const tomb = {};
    for (const k in L.tomb) tomb[k] = L.tomb[k];
    for (const k in R.tomb) if (R.tomb[k] > (tomb[k] || 0)) tomb[k] = R.tomb[k];
    out.tomb = Object.keys(tomb).map(k => [k, tomb[k]])
      .filter(r => r[1] >= syncNow - TOMB_TTL)
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
      .slice(0, TOMB_MAX)
      .reduce((o, r) => { o[r[0]] = r[1]; return o; }, {});
    // `>=`: a delete wins a same-millisecond tie. A resurrected item is more annoying
    // than a lost one, and re-adding is one tap.
    const dead = (k, at) => { const t = out.tomb[k]; return t !== undefined && t >= at; };

    // 4. watchlist
    const wl = {};
    for (const e of L.watch) wl[e.type + ':' + e.id] = e;
    for (const e of R.watch) {
      const k = e.type + ':' + e.id;
      if (!wl[k] || e.at > wl[k].at) wl[k] = e;
    }
    out.watch = Object.keys(wl).map(k => wl[k])
      .filter(e => !dead('w:' + e.type + ':' + e.id, e.at))
      .sort((a, b) => (b.at - a.at) ||
                      (a.type < b.type ? -1 : a.type > b.type ? 1 : a.id - b.id))
      .slice(0, WATCH_MAX);

    // 5. progress
    const pg = {};
    for (const k in L.prog) pg[k] = L.prog[k];
    for (const k in R.prog) pg[k] = pickProg(pg[k], R.prog[k]);
    Object.keys(pg).forEach(k => {
      const e = pg[k];
      if (dead('p:' + k, e.at)) { delete pg[k]; return; }
      if (e.at <= out.clearedAt.prog && !keptLocal(localProg, k)) { delete pg[k]; return; }
      // Finished films are kept (see progPrune). A device still on an older build will go
      // on pruning its own copy; the entry survives here and is re-unioned on the next sync.
      if (k.indexOf('movie:') === 0 && !(e.pct >= DONE_PCT) && (syncNow - e.at) > MOVIE_TTL) delete pg[k];
    });
    capProg(pg);
    repairPointers(pg);            // MUST run after capProg
    out.prog = pg;

    // 6. history
    const hm = {};
    for (const r of L.hist) hm[r.k] = r;
    for (const r of R.hist) hm[r.k] = pickHist(hm[r.k], r);
    out.hist = Object.keys(hm).map(k => hm[k])
      .filter(r => !dead('p:' + r.k, r.at) &&
                   (r.at > out.clearedAt.hist || keptLocal(localHist, r.k)))
      .sort((a, b) => (b.at - a.at) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
      .slice(0, HIST_MAX);

    return out;
  }

  /** Canonical form: sorted keys and rounded floats. This is the gate that makes push
   *  ping-pong structurally impossible -- if the merged blob canonicalizes identically
   *  to the pulled one, there is nothing to push. */
  function canon(o) {
    return JSON.stringify(o, function (k, v) {
      if (k === 'pct' && typeof v === 'number') return Math.round(v * 10000) / 10000;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const out = {};
        Object.keys(v).sort().forEach(kk => { out[kk] = v[kk]; });
        return out;
      }
      return v;
    });
  }

  /* ---- transport ----------------------------------------------------------
     One wrapper so the three failure classes that actually bite are prevented in a
     single place: a request that never returns, a captive portal answering 200 with
     an HTML login page, and an error body that leaks the upstream URL.
     ------------------------------------------------------------------------- */
  async function syncCall(path, body) {
    const ac = new AbortController();
    const kill = setTimeout(() => ac.abort(), 8000);
    const t0 = Date.now();
    try {
      // The access token rides in the body (the Worker's CORS allows only Content-Type), on
      // every call: the ones that need it use it, the rest ignore it.
      const acc = accessTok();
      const r = await fetch(SYNC_URL + path, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(acc ? Object.assign({}, body, { acc: acc.t }) : body)
      });
      const ct = r.headers.get('content-type') || '';
      // A hotel wifi portal returns 200 with HTML. JSON.parse would then throw from
      // inside a timer, where nothing catches it.
      if (ct.indexOf('application/json') < 0) return { err: 'notjson', status: r.status };
      const d = await r.json();
      // Every response carries the server clock, errors included, so a device with a
      // wrong clock is corrected by its FIRST call -- before anything is merged, and
      // therefore before it can write a single poisoned timestamp.
      if (d && d.now) learnSkew(d.now, t0, Date.now());
      // The Worker says this device has no (valid) access code: lock, and forget the servers.
      if (r.status === 401 && d && d.error === 'locked') { accessLocked(); return { err: 'locked', status: 401 }; }
      if (!r.ok) return { err: d.error || ('http ' + r.status), status: r.status };
      return { ok: true, d: d };
    } catch (e) {
      return { err: e.name === 'AbortError' ? 'timeout' : 'net' };
    } finally { clearTimeout(kill); }
  }

  /* ---- access code = account ------------------------------------------------------
     The only way in. A four-digit code (the Worker's ACCESS_CODES) unlocks the app AND names
     the account its watchlist and history sync to (see adoptUid). A device enters it once and
     keeps a signed token for 90 days, re-issued as it is used. Without a valid token the app
     is the lock screen, the cached server list is wiped, and the Worker refuses the list and
     sync -- it reads the account from the token, never from anything the device says. */
  const ACCESS_KEY = 'reeldeck.access.v1';
  const LK_HINT = 'Four digits. Your code is your account.';
  let accessNeed = false;
  function accessTok() {
    try { const a = JSON.parse(localStorage.getItem(ACCESS_KEY) || 'null'); return (a && typeof a.t === 'string' && a.t) ? a : null; }
    catch (e) { return null; }
  }
  function accessSave(t) {
    const p = String(t || '').split('.');
    try { localStorage.setItem(ACCESS_KEY, JSON.stringify({ t: t, exp: +p[0] || 0, iat: +p[1] || 0 })); } catch (e) {}
  }
  /** Ask whether this device may use the app, and quietly renew a token a day old. */
  async function accessCheck() {
    if (!accessTok()) { accessLocked(); return; }   // no code on this device yet
    const r = await syncCall('/v1/access/check', {});
    if (r.err || !r.d) return;                 // offline: keep going with what this device has
    if (r.d.ok) {
      if (r.d.renew) accessSave(r.d.renew);
      accessNeed = false;
      // A token from before codes were accounts, or an account renamed by its code's label.
      const st = syncState();
      if (r.d.uid && (st.uid !== r.d.uid || !st.on)) adoptUid(r.d.uid, r.d.name);
      return;
    }
    accessLocked();
  }
  function accessLocked() {
    try { localStorage.removeItem(ACCESS_KEY); } catch (e) {}
    const st = syncState();
    if (st.on) { st.on = false; saveSyncState(st); }   // nothing to sync to until a code is in
    if (!accessNeed) { accessNeed = true; accessWipe(); }
    accessShow();
  }
  /** Forget every server this device was given: they belong to the unlocked state. */
  function accessWipe() {
    try { localStorage.removeItem(SRC_KEY); localStorage.removeItem(HEALTH_KEY); } catch (e) {}
    const known = new Set(((cachedSources() || {}).sources || []).map(s => s.name));
    cfg.sources = (cfg.sources || []).filter(s => !(s.t || s.tracked || known.has(s.name)));
    mirrorDown = {};
    try { saveConfig(); } catch (e) {}
  }
  function accessShow() {
    if (!accessNeed || document.getElementById('lock')) return;
    const back = document.createElement('div');
    back.className = 'splash-back lock-back';
    back.id = 'lock';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-labelledby', 'lk-h');
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'clr'];
    back.innerHTML =
      '<div class="lock">' +
        '<div class="splash-brand"><span class="brand-mark" aria-hidden="true"></span>' +
          '<span class="splash-word">' + esc(cfg.brand || 'Reeldeck') + '</span></div>' +
        '<h2 id="lk-h">Enter your code</h2>' +
        '<div class="lk-dots" id="lk-dots" role="img" aria-label="0 of 4 digits entered">' +
          '<i></i><i></i><i></i><i></i></div>' +
        '<p class="lk-msg" id="lk-msg" role="status" aria-live="polite">' + LK_HINT + '</p>' +
        '<div class="lk-pad">' + keys.map((k) =>
          '<button class="lk-key' + (k.length > 1 ? ' lk-fn' : '') + '" data-k="' + k + '">' +
          (k === 'del' ? 'Delete' : k === 'clr' ? 'Clear' : k) + '</button>').join('') + '</div>' +
      '</div>';
    document.body.appendChild(back);
    document.body.classList.add('lock-on');
    let digits = '', busy = false;
    const dots = back.querySelector('#lk-dots'), msg = back.querySelector('#lk-msg');
    const paint = () => {
      [].slice.call(dots.children).forEach((d, i) => d.classList.toggle('on', i < digits.length));
      dots.setAttribute('aria-label', digits.length + ' of 4 digits entered');
    };
    const say = (t, bad) => { msg.textContent = t; msg.classList.toggle('bad', !!bad); };
    const submit = async () => {
      busy = true; say('Checking…');
      const r = await syncCall('/v1/access/enter', { code: digits });
      busy = false;
      if (r.ok && r.d && r.d.acc) {
        accessSave(r.d.acc);
        accessNeed = false;
        document.removeEventListener('keydown', back._keys);
        back.remove(); document.body.classList.remove('lock-on');
        refreshSources().catch(() => {});
        // The code is the account: bind this device to it and pull its library.
        if (r.d.uid) await adoptUid(r.d.uid, r.d.name);
        route();
        if (IS_TV) { tvInvalidate(); tvFocusFirst(false, false); }
        return;
      }
      digits = ''; paint();
      back.classList.remove('shake'); void back.offsetWidth; back.classList.add('shake');
      say(r.err === 'bad code' ? 'That code didn’t work. Try again.'
        : r.err === 'locked out' ? 'Too many tries. Wait 15 minutes and try again.'
        : r.err === 'busy' ? 'Too many wrong codes lately. Try again in a few minutes.'
        : r.err === 'slow down' ? 'Slow down a moment, then try again.'
        : 'Can’t reach the server. Check your connection.', true);
    };
    const press = (k) => {
      if (busy) return;
      if (k === 'del') digits = digits.slice(0, -1);
      else if (k === 'clr') digits = '';
      else if (/^\d$/.test(k) && digits.length < 4) digits += k;
      paint();
      if (digits.length === 4) submit(); else say(LK_HINT);
    };
    back.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) press(b.dataset.k); });
    // A real keyboard, or the number keys on a remote.
    back._keys = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); press('del'); }
    };
    document.addEventListener('keydown', back._keys);
    if (IS_TV) { tvInvalidate(); tvFocusEl(back.querySelector('[data-k="5"]')); }
    else { const f = back.querySelector('[data-k="5"]'); if (f) try { f.focus(); } catch (e) {} }
  }

  /** All four stores in ONE try. On any failure nothing advances and nothing is
   *  pushed -- a half-applied merge that then gets uploaded is how you lose data. */
  function applyMerged(m) {
    try {
      localStorage.setItem(WATCH_KEY, JSON.stringify(m.watch));
      localStorage.setItem(PROG_KEY, JSON.stringify(m.prog));
      localStorage.setItem(HIST_KEY, JSON.stringify(m.hist));
      localStorage.setItem(TOMB_KEY, JSON.stringify(m.tomb));
      return true;
    } catch (e) {
      const st = syncState(); st.stall = 'quota'; saveSyncState(st);
      return false;
    }
  }

  let syncBusy = false, syncStale = false, userActed = false;
  // Monotone counter, bumped by every syncMark/syncFlush. syncOnce records it at the
  // start of a pass and only clears `dirty` if it has not moved -- otherwise an edit
  // made while the pass was in flight would be marked as already-synced and stranded.
  let dirtySeq = 0, retryTimer = null, retryStep = 0;
  /**
   * Retry with backoff and a ceiling.
   *
   * A flat three seconds meant a permanent failure -- no network on a plane, a Worker
   * that is down -- became an indefinite three-second loop: constant radio wake-ups on
   * a phone, and on a metered connection, constant failed requests. Doubling to a cap
   * keeps a transient blip responsive while making a sustained outage cheap.
   */
  function scheduleRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    const delay = Math.min(3000 * Math.pow(2, retryStep++), 300000);   // 3s -> 5min
    retryTimer = setTimeout(() => { retryTimer = null; syncOnce('retry'); }, delay);
  }
  const bootAt = Date.now();
  document.addEventListener('keydown', () => { userActed = true; }, { once: true, capture: true });
  document.addEventListener('click', () => { userActed = true; }, { once: true, capture: true });

  /**
   * One full cycle: pull, merge, apply, push if anything changed.
   *
   * There is no standalone push and no standalone pull, deliberately -- every upload
   * is therefore preceded by a download in the same pass, which is the cheapest
   * mitigation available for the lost-update race on a server with no compare-and-swap.
   */
  async function syncOnce(reason) {
    const st0 = syncState();
    if (!st0.on || !st0.uid || syncBusy) return;
    // A misconfigured server or a rejected uid will not fix itself by being retried
    // every twenty seconds; wait for the user to ask.
    if (st0.stall === 'secrets' || st0.stall === 'notjson' || st0.stall === 'baduid') {
      if (reason !== 'manual' && reason !== 'boot') return;
    }
    syncBusy = true;
    const seqAtStart = dirtySeq;
    // The pull and push take seconds, and the theme picker is live throughout. Without
    // this the merged (pre-choice) theme is written back at the end, reverting what the
    // user just picked AND regressing its stamp, so the other device wins next time.
    const themeAtStart = syncState().themeAt || 0;
    try {
      runMigrations();
      const pulled = await syncCall('/v1/pull', { uid: st0.uid });
      if (pulled.err) return noteSyncFail(pulled.err, reason);
      // AFTER the pull, deliberately: that call is what corrected the clock. Frozen
      // from here on so every comparison in this pass uses one consistent instant.
      const syncNow = now();

      // If the account is still far ahead of our corrected clock, the correction did
      // not happen -- an older Worker that does not send `now`, on a device whose clock
      // is wrong. Merging here would clamp every stamp in the account down to a bad
      // value and then push it, expiring every tombstone at once (resurrecting every
      // deletion) and rolling back both clear epochs. Do nothing instead: a sync that
      // does not happen costs one cycle, a sync computed on a wrong clock costs the
      // account, and it self-heals the moment the clock is right.
      // Symmetric, because every TTL-driven deletion below (the tombstone TTL and
      // MOVIE_TTL) is a one-way destructive decision made entirely from syncNow. A
      // clock far AHEAD of the account is as dangerous as one behind it -- it just
      // fails by quietly expiring things instead of by flattening them.
      const rMax = blobMaxAt(pulled.d.data);
      if (rMax > syncNow + FUTURE_SLACK) return noteSyncFail('badclock', reason);
      // The other direction is only evidence of a bad clock when the clock could NOT be
      // corrected. An account whose newest stamp is older than 24h is simply an account
      // nobody has used since yesterday -- the overwhelmingly common case for a second
      // device -- and treating that as a fault meant signing in on a new phone failed
      // permanently, told the user their date was wrong, and never self-healed because
      // lastSyncAt stayed 0. Only meaningful against a Worker too old to send its own
      // clock; the current one sends it on every response, so skewKnown is true by the
      // time this line runs.
      if (!skewKnown && rMax > 0 && syncNow > rMax + FUTURE_SLACK && !st0.lastSyncAt) {
        return noteSyncFail('badclock', reason);
      }

      const merged = mergeBlob(pulled.d.data, syncNow);
      if (!applyMerged(merged)) return;

      const body = canon(merged);
      if (body !== canon(sanitize(pulled.d.data, syncNow + FUTURE_SLACK, syncNow))) {
        if (body.length > BODY_MAX) return noteSyncFail('toolarge', reason);
        const res = await syncCall('/v1/push', { uid: st0.uid, data: merged });
        if (res.err) return noteSyncFail(res.err, reason);
        // NB: res.d.at is the stored blob's timestamp, NOT the current server time --
        // skew comes from res.d.now, which syncCall has already consumed for us.
      }

      const st = syncState();
      st.lastSyncAt = syncNow; st.stall = ''; st.lastErr = '';
      st.adopting = 0;                 // spent: this device's rows are now in the account
      retryStep = 0;                    // a good pass resets the backoff
      // Re-read, then MAX. A Clear performed while the push was in flight has already
      // written a newer epoch to this same key; assigning the pre-push snapshot back
      // would silently undo it and every cleared row would return on the next pull.
      st.clearedAt = { prog: Math.max(st.clearedAt.prog || 0, merged.clearedAt.prog),
                       hist: Math.max(st.clearedAt.hist || 0, merged.clearedAt.hist) };
      // Only clear `dirty` if nothing was marked dirty AFTER this pass began; otherwise
      // the edit that arrived mid-cycle is stranded with nothing scheduled to push it.
      if (dirtySeq === seqAtStart) st.dirty = false; else scheduleRetry();
      // The theme is the only cfg field that travels. Apply it here rather than in
      // the merge, which is pure.
      // Not while the picker is open: the user is looking at the swatches, and having
      // the theme change under them (and their own stamp overwritten) is worse than
      // being one sync late.
      if (merged.theme.id && merged.theme.id !== cfg.theme && !$('.modal-back') &&
          (st.themeAt || 0) === themeAtStart) {
        cfg.theme = merged.theme.id; st.themeAt = merged.theme.at; saveConfig();
      }
      saveSyncState(st);
      maybeRerender();
    } catch (e) {
      if (reason === 'manual') toast('Sync unavailable \u2014 will retry');
    } finally { syncBusy = false; }
  }

  function noteSyncFail(err, reason) {
    const st = syncState();
    st.lastErr = err;
    // A failed pass leaves `dirty` set with nothing scheduled, so an edit made just
    // before losing signal would sit unsynced until the next unrelated trigger. The
    // transient classes are worth another go on their own.
    if (err === 'net' || err === 'timeout' || err === 'slow down' || err === 'badclock' ||
        (typeof err === 'string' && err.indexOf('http 5') === 0)) {
      scheduleRetry();
    }
    // Only the permanent classes stall. A timeout or a dropped connection is the
    // normal condition of a phone and must not disable sync until the app restarts.
    if (err === 'notjson' || err === 'bad uid' || err === 'toolarge' ||
        (typeof err === 'string' && err.indexOf('missing its') >= 0)) {
      st.stall = err.indexOf('missing its') >= 0 ? 'secrets'
               : err === 'bad uid' ? 'baduid'
               : err === 'toolarge' ? 'toolarge' : 'notjson';
    }
    saveSyncState(st);
    if (reason === 'manual') {
      toast(err === 'net' || err === 'timeout' ? 'No connection \u2014 will retry'
            : err === 'badclock' ? "This device's date looks wrong \u2014 fix it and sync again"
            : 'Sync problem: ' + err);
    }
  }

  /**
   * Re-render only when it cannot steal the user's place.
   *
   * route() runs tvFocusFirst() and scrollTo(0, 0). A pull landing while somebody is
   * three rows into a rail on a TV teleports the focus ring with no way back but
   * re-navigating, which is indistinguishable from a crash. So: repaint freely during
   * the first few seconds of boot, and after that just remember that the next natural
   * navigation should pick the new data up.
   */
  function maybeRerender() {
    // Never while a player is mounted. route() rebuilds the view, which re-creates the
    // iframe and restarts the film from zero -- and during playback a 'beat' sync runs
    // every ten minutes, so this would otherwise be near-certain on any long watch.
    if (watchNow) { syncStale = true; return; }
    if (!userActed && Date.now() - bootAt < 5000) { route(); return; }
    syncStale = true;
  }

  /* ---- when sync runs -----------------------------------------------------
     PUSH_IDLE exceeds the 15s watchTick on purpose: during playback progRecord fires
     every 15 seconds, so a shorter trailing edge would never be reached and a 2h film
     would push ~480 times. PLAYER_BEAT is what actually governs playback, capping the
     same film at about twelve cycles.
     ------------------------------------------------------------------------- */
  const PUSH_IDLE = 20000, PUSH_MAX = 90000, PLAYER_BEAT = 600000;
  let pushTimer = null, firstDirtyAt = 0, lastBeat = 0;

  /** Something changed. Coalesce; do not push yet. */
  function syncMark() {
    if (!syncOn()) return;
    dirtySeq++;
    const st = syncState();
    if (!st.dirty) { st.dirty = true; saveSyncState(st); }
    if (!firstDirtyAt) firstDirtyAt = Date.now();

    if (watchNow) {
      // Playing: one heartbeat every ten minutes and nothing else.
      if (Date.now() - lastBeat > PLAYER_BEAT) { lastBeat = Date.now(); syncOnce('beat'); }
      return;
    }
    if (pushTimer) clearTimeout(pushTimer);
    // PUSH_MAX stops a steady drip of edits from deferring the write forever.
    if (Date.now() - firstDirtyAt > PUSH_MAX) { firstDirtyAt = 0; return syncOnce('max'); }
    pushTimer = setTimeout(() => { firstDirtyAt = 0; syncOnce('idle'); }, PUSH_IDLE);
  }

  /** A deliberate act (bookmark, delete, clear, theme). Worth a round trip now. */
  function syncFlush(reason) {
    if (!syncOn()) return;
    dirtySeq++;
    const st = syncState();
    if (!st.dirty) { st.dirty = true; saveSyncState(st); }
    if (pushTimer) clearTimeout(pushTimer);
    // A flush landing mid-cycle would otherwise be swallowed by the syncBusy guard
    // and never rescheduled.
    pushTimer = setTimeout(() => {
      firstDirtyAt = 0;
      if (syncBusy) return scheduleRetry();
      syncOnce(reason);
    }, 1200);
  }

  function wireSync() {
    if (syncOn()) syncOnce('boot');
    // Coming back to the app is the moment another device's changes matter most, and
    // on Android it is also the only reliable signal before the process is killed.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // NO route() here. Coming back to the app is not a navigation: route() scrolls
        // to the top, rebuilds the view and re-establishes focus, so a signed-in phone
        // lost its place in a rail every single time it was foregrounded -- which on a
        // phone is constantly. syncStale stays set and the next REAL navigation picks
        // the merged data up, which is what the flag was for.
        syncOnce('visible');
      } else if (syncState().dirty) {
        syncOnce('hidden');
      }
    });
    // pagehide fires on desktop and on web; Android frequently kills the process
    // without it, which is why 'hidden' above is the one that carries the weight.
    window.addEventListener('pagehide', () => { if (syncState().dirty) syncOnce('pagehide'); });
  }

  /* ---- the account is a code ----------------------------------------------
     There is no sign-in: a person's four-digit access code IS their account. The Worker
     names the account after the code's label (mum=4829 -> "mum"), so the same history
     follows the same person to every device, and rotating their code keeps it. Entering a
     code on a device that never had one folds what it already holds into the account;
     entering a DIFFERENT person's code replaces it, so one person's history never lands
     in another's on a shared TV. Signing out locks this device and keeps its local copy
     for whoever unlocks it next with the same code.
     ------------------------------------------------------------------------- */
  async function adoptUid(uid, name) {
    const st = syncState();
    // Whose data is in the four stores? A device that belonged to another code account
    // starts clean. One that never had a code (a guest, or the old sign-in) merges.
    const prevCode = st.kind === 'code' ? st.boundUid : '';
    if (prevCode && prevCode !== uid) {
      try {
        localStorage.removeItem(WATCH_KEY); localStorage.removeItem(PROG_KEY);
        localStorage.removeItem(HIST_KEY); localStorage.removeItem(TOMB_KEY);
      } catch (e) {}
      st.clearedAt = { prog: 0, hist: 0 };
      st.themeAt = 0;
    }
    st.uid = uid; st.on = true; st.kind = 'code'; st.name = name || ''; st.pic = '';
    st.lastSyncAt = 0; st.stall = ''; st.lastErr = '';
    st.boundUid = uid;
    // Spent on the first SUCCESSFUL merge, so a failed first sync does not consume it.
    st.adopting = 1;
    saveSyncState(st);
    refreshAcctFace();
    await syncOnce('manual');
  }
  /** Lock this device. Its local copy stays, for the same code to pick up again. */
  function signOut() {
    const st = syncState();
    st.on = false; st.uid = ''; st.lastSyncAt = 0;
    saveSyncState(st);
    accessLocked();
  }

  // Derived from the fetched rows rather than written out here: a hard-coded map of
  // mirror names would have put every provider's name back into the public bundle, which
  // is most of what moving the URLs out was for. Each row carries its own `tracked` flag.
  function trackSeed() {
    const seed = {};
    (cfg.sources || []).forEach(s => { if (s && s.tracked && s.name) seed[s.name] = 1; });
    return seed;
  }
  // What THIS DEVICE has seen, per mirror:  1 = it delivered a position,  -1 = it claimed to
  // and did not. The table's own flag is only the starting assumption for a mirror nobody
  // has tried here yet; evidence, either way, outranks it.
  function trackSeen() {
    let t; try { t = JSON.parse(localStorage.getItem(TRACK_KEY) || 'null'); } catch (e) { t = null; }
    return (t && typeof t === 'object' && !Array.isArray(t)) ? t : {};
  }
  function trackedAll() {
    const out = trackSeed(), seen = trackSeen();
    Object.keys(seen).forEach(k => { if (seen[k] === -1) delete out[k]; else if (seen[k]) out[k] = 1; });
    return out;
  }
  function isTracked(name) { return !!(name && trackedAll()[name]); }
  function trackProven(name) { return trackSeen()[name] === 1; }
  /** A mirror that says it reports position played in the foreground and reported nothing. */
  function markUntracked(name) {
    if (!name || trackSeen()[name] === -1 || trackProven(name)) return;
    const t = trackSeen(); t[name] = -1;
    try { localStorage.setItem(TRACK_KEY, JSON.stringify(t)); } catch (e) {}
    document.querySelectorAll('.mirror').forEach(el => { if (el.dataset.mirrorName === name) el.classList.remove('tracked'); });
    toast(name + ' is not reporting its position \u2014 resume will be approximate. Verified servers track exactly.');
  }
  function markTracked(name) {
    if (!name || trackProven(name)) return;
    const wasShown = isTracked(name);
    const t = trackSeen(); t[name] = 1;
    try { localStorage.setItem(TRACK_KEY, JSON.stringify(t)); } catch (e) {}
    if (wasShown) return;                 // already wearing the badge on the table's word; now it is earned
    // Light the badge on the tile that is already on screen, rather than waiting for
    // the next render to explain what just changed.
    document.querySelectorAll('.mirror').forEach(el => {
      if (el.dataset.mirrorName === name) el.classList.add('tracked');
    });
    toast(name + ' verified \u2014 it reports exact playback position');
  }

  /* ---- Reading position out of the mirror --------------------------------
     The ONLY way to learn a cross-origin player's position is for the player to
     volunteer it. We accept that, but only from the exact origin we are framing:
     any page can postMessage at us, and this writes the user's history. */
  /**
   * Pull { t, d } in SECONDS out of whatever shape a mirror posts.
   *
   * Confirmed shapes, all from first-party sources (which mirror emits which is
   * recorded in the Worker, beside the rows):
   *   PLAYER_EVENT  data.currentTime / data.duration
   *   PLAYER_EVENT  data.player_progress / data.player_duration
   *   MEDIA_DATA    data.progress.watched / .duration
   *   MEDIA_DATA    data[<id>].progress.watched / .duration
   *
   * Two traps this deliberately avoids:
   *  - One family's TV MEDIA_DATA carries progress.watched/TOTAL counting EPISODES, not
   *    seconds. Requiring a `duration` (never `total`) rejects it, and the real
   *    per-episode seconds are picked up from show_progress instead.
   *  - Some players' PLAYER_EVENT `progress` is a PERCENTAGE. It is never read as a
   *    position; only currentTime is.
   */
  function readPosition(msg) {
    const body = (msg && msg.data) || msg;
    if (!body || typeof body !== 'object') return null;
    const pick = (t, d) => (num(t) != null && num(d) > 0) ? { t: num(t), d: num(d) } : null;

    let hit = pick(body.currentTime, body.duration)
           || pick(body.player_progress, body.player_duration);
    if (hit) return hit;
    if (body.progress) hit = pick(body.progress.watched, body.progress.duration);
    if (hit) return hit;

    // MEDIA_DATA keyed by content id ("550", "m550", "t1399"). One level deep only.
    // It is the mirror's WHOLE store -- every title ever played on it -- so only the entry for
    // the title ON SCREEN counts. Taking the first one was taking the lowest TMDB id in the
    // store: watch a second title on such a mirror and the first one's position was filed
    // under it (and earned the mirror its badge on the strength of a wrong number).
    const want = watchNow ? String(watchNow.id) : '';
    const wantKind = (watchNow && watchNow.type === 'tv') ? 't' : 'm';
    const ents = [];
    for (const k in body) {
      const v = body[k];
      if (!v || typeof v !== 'object' || !v.progress) continue;
      const m = /^([a-z]?)(\d+)$/i.exec(k);
      const raw = String(v.type || v.mediaType || (m && m[1]) || '').toLowerCase();
      ents.push({ v: v, kid: m ? m[2] : '', vid: v.id != null ? String(v.id) : '',
                  kind: /^(m|movie)$/.test(raw) ? 'm' : /^(t|tv)$/.test(raw) ? 't' : '' });
    }
    let mine = ents.filter(x => (x.kid === want || x.vid === want) && (!x.kind || x.kind === wantKind));
    // An entry that names NO id can be trusted only when it is alone. One that names another id, never.
    if (!mine.length && ents.length === 1 && !ents[0].kid && !ents[0].vid) mine = ents;
    for (const x of mine) {
      const v = x.v, sp = v.show_progress;
      // TV: the per-episode seconds FIRST; the entry's own `progress` is whichever episode the
      // mirror played last, which need not be this one.
      if (sp && typeof sp === 'object' && watchNow && watchNow.season) {
        const ep = sp['s' + watchNow.season + 'e' + watchNow.episode];
        if (ep && ep.progress) { hit = pick(ep.progress.watched, ep.progress.duration); if (hit) return hit; }
        const ls = num(v.last_season_watched), le = num(v.last_episode_watched);
        if (ls != null && le != null && (ls !== +watchNow.season || le !== +watchNow.episode)) continue;
      }
      hit = pick(v.progress.watched, v.progress.duration);
      if (hit) return hit;
    }
    return null;
  }

  let watchNow = null;
  /**
   * Is this message from OUR player -- the iframe itself, or a frame nested inside it?
   *
   * By window, not by origin string. Mirrors redirect to other domains and nest the real
   * player in an inner frame served from a CDN, so the origin of a genuine report often
   * differs from the origin of the URL we asked for -- and an origin comparison threw every
   * one of those reports away. `parent` is one of the few properties readable across
   * origins, which is what makes the walk possible. Depth-capped; a frame cannot make it loop.
   */
  function fromPlayer(src) {
    const fr = document.getElementById('player-iframe');
    const root = fr && fr.contentWindow;
    if (!root || !src) return false;
    try {
      let w = src;
      for (let i = 0; i < 6 && w; i++) {
        if (w === root) return true;
        if (w === window || w.parent === w) return false;
        w = w.parent;
      }
    } catch (e) {}
    return false;
  }
  /** Did the mirror say, in so many words, that the episode is over? */
  function saysEnded(msg) {
    const b = (msg && msg.data && typeof msg.data === 'object') ? msg.data : msg;
    const ev = String((b && (b.event || b.type || b.action || b.state)) || (msg && (msg.event || msg.type)) || '').toLowerCase();
    return ev === 'ended' || ev === 'end' || ev === 'complete' || ev === 'completed' || ev === 'finished';
  }
  window.addEventListener('message', (ev) => {
    if (!watchNow) return;
    if (!fromPlayer(ev.source)) return;           // not the mirror we are showing, nor anything inside it
    let d = ev.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || typeof d !== 'object') return;
    // A mirror with its own episode picker or next-episode autoplay moves on INSIDE the frame,
    // and its reports then describe an episode that is not the one on this page: filed here,
    // E3's playhead un-finished E2 and cancelled our own countdown. Where a payload names its
    // season and episode, the FIRST one seen this sitting is "this episode" (first seen, not
    // our URL's numbers -- a mirror that numbers differently must not be muted altogether);
    // anything tagged otherwise is dropped.
    const tagB = (d.data && typeof d.data === 'object') ? d.data : d;
    if (watchNow.type === 'tv') {
      const ms = num(tagB.season), me = num(tagB.episode);
      if (ms != null && me != null && ms >= 1 && me >= 1) {
        const tag = ms + ':' + me;
        if (!watchNow.epTag) watchNow.epTag = tag;
        else if (watchNow.epTag !== tag) return;
      }
    }
    const pos = readPosition(d);
    const over = saysEnded(d);
    if (!pos && !over) return;
    if (pos) {
      watchNow.gotProvider = true;
      // Auto-advance needs proof the episode was actually PLAYED to its end here: a mirror
      // reopening something already finished can report "at the end" the moment it loads.
      if (pos.d - pos.t > 30) watchNow.sawMid = true;
      progRecord(Object.assign({}, watchNow, { t: pos.t, d: pos.d, src: 'provider' }));
      markTracked(watchNow.source);   // it just proved it — promote it
      // The countdown claims the episode is over; a playhead that has gone BACK from where the
      // countdown started says otherwise (a seek, a replay). Stop counting -- nextUpCheck below
      // puts the plain prompt back if it still belongs.
      if (nextUpCount && watchNow.endT != null && pos.t < watchNow.endT - 5) nextUpHide();
      watchNow.lastT = pos.t;
      if (!nextUpDismissed) nextUpCheck(pos.t, pos.d);
    }
    // The end, as REPORTED: an explicit event, or within two seconds of the mirror's own
    // duration. Never inferred from the wall clock, which cannot tell a pause from progress.
    // An explicit "ended" is believed only near the end of what we last heard: any frame
    // nested in the player, adverts included, can post one.
    const nearEnd = pos ? (pos.d > NEXT_UP_WINDOW * 3 && pos.d - pos.t <= 2)
                        : (over && watchNow.lastT != null && watchNow.lastD > 0 && watchNow.lastD - watchNow.lastT <= NEXT_UP_WINDOW);
    if (pos) watchNow.lastD = pos.d;
    if (watchNow.sawMid && (nearEnd || (over && pos && pos.d - pos.t <= NEXT_UP_WINDOW))) {
      if (!nextUpCount) watchNow.endT = pos ? pos.t : watchNow.lastT;
      nextUpAuto();
    }
  });

  /**
   * "Next episode" as the current one runs out.
   *
   * On a remote, getting to the next episode otherwise means leaving full screen,
   * finding the strip and pressing along it -- four or five presses for the single
   * most predictable thing a viewer wants. This is one.
   *
   * 150 seconds is the window: long enough to notice and press during the credits,
   * short enough that it is never covering the last scene. It hides again if the
   * viewer seeks backwards, so scrubbing does not leave it stuck on screen.
   */
  const NEXT_UP_WINDOW = 180;          // three minutes of head start
  function nextUpCheck(t, dur) {
    if (!watchNow || !watchNow.nextHref) return;
    // Ignore nonsense durations: a mirror reporting a 90-second "duration" while it
    // loads would otherwise fire this immediately. The floor is derived from the
    // window rather than fixed, so the prompt can never cover more than the last third
    // of a runtime -- at a fixed 300s, a three-minute window would have put it over
    // most of a five-minute video.
    if (!(dur > NEXT_UP_WINDOW * 3)) return;
    const left = dur - t;
    if (left > NEXT_UP_WINDOW) return nextUpHide();     // (it used to hide again in the last second)
    nextUpShow();
  }
  /**
   * The episode is over, and the mirror said so: count down, then play the next one.
   * A visible countdown with a way out, because being moved on without warning is worse than
   * pressing a button. Any press of Dismiss cancels it; leaving the page cancels it (watchEnd).
   */
  // Set ONLY by "next episode" (the countdown or the prompt's Play) and consumed by the very
  // next route(). Every navigation tears cinema down, and nothing put it back: each episode
  // boundary turned a phone back to portrait and shrank the picture to a thumbnail -- in exactly
  // the hands-free case autoplay exists for. The TV re-enters by itself (pointer mode).
  let resumeCinema = 0;                 // 0 none, 1 theater, 2 fullscreen
  // The watch page opens on a poster and loads NO iframe until Play is pressed (an embed is
  // the heaviest thing this app ever loads, and on some TVs it stalls the whole page).
  // watchLive: Play has been pressed for this stay on /watch, so moving between episodes,
  // Next-episode autoplay and a re-render all go straight to the player. route() clears it on
  // any other page. watchStart: starts the pending player (Fullscreen/Theater and F/T use it).
  let watchLive = false, watchStart = null;
  let downPicked = '';                  // an offline mirror the viewer chose by hand, this session
  // Set by go() when the press that navigated was a title's own Play: watchView skips the
  // poster for that one visit. Consumed there; route() drops it for any other page.
  let watchArm = false;
  // TV: the player opens in the page, and full screen (with the pointer) waits for OK on the
  // picture -- some mirrors break when they load straight into it. Set by route() when the TV
  // was ALREADY in full screen and is moving to another episode or server, so that move keeps it.
  let cinemaCarry = false;
  function nextUpGo() {
    const h = watchNow && watchNow.nextHref;
    const b = document.body.classList;
    resumeCinema = (!IS_TV && h && b.contains('cinema-on')) ? (b.contains('cinema-screen') ? 2 : 1) : 0;
    nextUpHide();
    if (h) go(h);
  }
  let nextUpCount = 0;
  function nextUpAuto() {
    if (!watchNow || !watchNow.nextHref || nextUpDismissed || nextUpCount) return;
    if (cfg.autoNext === false) return nextUpShow();
    nextUpShow();
    const el = document.getElementById('next-up'); if (!el) return;
    el.classList.add('awake', 'counting');
    let n = 8;
    const label = el.querySelector('.nu-k');
    const paint = () => { if (label) label.textContent = 'Next episode in ' + n; };
    paint();
    nextUpCount = setInterval(() => {
      if (!watchNow || !el.isConnected) { clearInterval(nextUpCount); nextUpCount = 0; return; }
      n--;
      if (n > 0) { el.classList.add('awake'); return paint(); }
      clearInterval(nextUpCount); nextUpCount = 0;
      nextUpGo();
    }, 1000);
  }
  function nextUpShow() {
    if (!watchNow || document.getElementById('next-up')) return;
    const el = document.createElement('div');
    el.id = 'next-up'; el.className = 'next-up';
    el.innerHTML = '<span class="nu-k">Up next</span>' +
      '<span class="nu-t">' + esc(watchNow.nextLabel || 'Next episode') + '</span>' +
      '<button class="btn primary sm" id="nu-go">' + ICON.play + ' Play</button>' +
      '<button class="btn sm" id="nu-x" aria-label="Dismiss">' + ICON.x + '</button>';
    // Into whatever is currently on top -- the fullscreen frame if there is one.
    overlayHost().appendChild(el);
    el.querySelector('#nu-go').onclick = nextUpGo;
    el.querySelector('#nu-x').onclick = () => { nextUpDismissed = true; nextUpHide(); };

    /* It lives for three minutes in the bottom-right corner -- which is where subtitles
       and credits go -- so it rests at low opacity and comes up to full on any sign of
       life: a tap, the mouse, a key, the remote. It arrives awake so nobody misses it
       appearing, then settles. It never fades while it is hovered, while it holds the
       D-pad ring, or while the pointer is over it, and it stays fully hit-testable
       throughout, so someone who has noticed it can reach straight for it. */
    el.classList.add('awake');
    const sleep = () => {
      if (!el.isConnected) return;
      if (el.contains(document.activeElement)) return;        // never dim under the ring
      if (el.matches(':hover')) return;
      el.classList.remove('awake');
    };
    const wake = () => {
      if (!el.isConnected) return;
      el.classList.add('awake');
      clearTimeout(nextUpTimer);
      nextUpTimer = setTimeout(sleep, 3200);
    };
    nextUpTimer = setTimeout(sleep, 3200);
    nextUpWake = wake;
    // Capture, and passive where it can be: these must fire even when the tap lands on
    // the player overlay rather than on the prompt.
    ['pointerdown', 'touchstart', 'mousemove', 'keydown'].forEach(ev =>
      document.addEventListener(ev, wake, { passive: true, capture: true }));
    el.addEventListener('focusin', wake);
    // Deliberately does NOT take the ring. Two reasons:
    //  - Pointer mode is on throughout TV playback, and while it is, Enter goes to
    //    cursorTap() -- a blind tap at
    //    wherever the cursor is parked, usually the middle of the video. The ring
    //    would sit on Play promising an activation that cannot happen.
    //  - Stealing focus from whatever the viewer was doing, for a prompt they did
    //    not ask for, loses their place in the episode strip.
    // #next-up is in TV_PINNED and passes the cinema occlusion filter, so the D-pad
    // reaches it on its own, and a pointer tap works because it is the topmost hit
    // target at z-index 320.
    if (IS_TV) tvInvalidate();
  }
  let nextUpTimer = null, nextUpWake = null;
  function nextUpHide() {
    const el = document.getElementById('next-up');
    clearTimeout(nextUpTimer);
    if (nextUpCount) { clearInterval(nextUpCount); nextUpCount = 0; }
    if (nextUpWake) {
      ['pointerdown', 'touchstart', 'mousemove', 'keydown'].forEach(ev =>
        document.removeEventListener(ev, nextUpWake, { capture: true }));
      nextUpWake = null;
    }
    if (!el) return;
    const hadFocus = el.contains(document.activeElement);
    el.remove();
    // tvFocusFirst() would re-run the landing list and jump to the top of the page,
    // so only recover focus if it was actually in the
    // prompt, and recover it to where the ring last WAS rather than to page one.
    if (IS_TV) { tvInvalidate(); if (hadFocus) tvRestoreFocus(); }
  }
  let nextUpDismissed = false;
  // Whether "Servers & playback" was left open, so a re-render triggered from inside
  // it does not shut the panel under the viewer.
  let srvWasOpen = false;

  function watchBegin(o) {
    watchEnd();
    const prev = progGet(o.type, o.id, o.season, o.episode);
    watchNow = Object.assign({}, o, {
      started: Date.now(),
      base: (prev && !progDone(prev)) ? (prev.t || 0) : 0
    });
    watchNow._t = setInterval(watchTick, 15000);
    // Wall-clock counts time the app was not even on screen. Lock the phone on a
    // 100-minute film for 90 minutes and a single tick on resume writes the whole
    // 90 minutes: pct crosses DONE_PCT, the title is labelled "Watched" and
    // the title drops out of Recently watched -- the resume point is destroyed.
    // 13 of the 14 default mirrors take this path on a fresh install, so it is the
    // common case, not the edge one. Bank the foreground seconds on the way out and
    // restart the clock on the way back in; only visible time is ever counted.
    watchNow._vis = () => {
      if (!watchNow) return;
      if (document.hidden) {
        watchNow.base += Math.round((Date.now() - watchNow.started) / 1000);
        clearInterval(watchNow._t); watchNow._t = 0;
      } else {
        watchNow.started = Date.now();
        clearInterval(watchNow._t);
        watchNow._t = setInterval(watchTick, 15000);
      }
    };
    document.addEventListener('visibilitychange', watchNow._vis);
  }
  // Deliberately coarse, and skipped entirely once a mirror has told us the truth
  // for this episode.
  const SILENT_TICKS = 8;              // two foreground minutes: this mirror has had its chance to report
  function watchTick() {
    if (!watchNow) return;
    // If it wears the badge on the table's word and has reported nothing in that time, the
    // badge was wrong here.
    watchNow.ticks = (watchNow.ticks || 0) + 1;
    if (watchNow.ticks === SILENT_TICKS && !watchNow.gotProvider && isTracked(watchNow.source)) markUntracked(watchNow.source);
    const cur = progGet(watchNow.type, watchNow.id, watchNow.season, watchNow.episode);
    const stale = !!(cur && cur.src === 'provider');
    if (stale && watchNow.gotProvider) return;            // reported in THIS sitting: the truth
    if (stale && cur.d > 0) watchNow.runtime = cur.d;     // a measured duration beats TMDB's rounded one
    const secs = Math.round((Date.now() - watchNow.started) / 1000);
    const t = watchNow.base + secs;
    // A leftover provider entry is only taken over once this mirror has had its two minutes.
    progRecord(Object.assign({}, watchNow, { t: t, d: watchNow.runtime || 0, src: 'elapsed',
      takeover: stale && watchNow.ticks >= SILENT_TICKS }));
    // Also offered on the wall-clock path, with the same guard. It is an estimate, so
    // it can be a minute out either way -- still better than four presses.
    if (!nextUpDismissed) nextUpCheck(t, watchNow.runtime || 0);
  }
  function watchEnd() {
    nextUpHide(); nextUpDismissed = false;
    if (watchNow) {
      if (watchNow._t) clearInterval(watchNow._t);
      if (watchNow._vis) document.removeEventListener('visibilitychange', watchNow._vis);
    }
    watchNow = null;
  }

  /* ------------------------------------------------------------
     Card + rail + grid builders
     ------------------------------------------------------------ */
  /**
   * Worth showing at all?
   *
   * A title nobody has rated is, in practice, one the mirrors do not have either: the
   * long tail of TMDB is full of entries that exist as metadata only, and surfacing them
   * means a Play button that leads nowhere. Recent releases are the exception -- a film
   * out this month may have no vote yet and is exactly what people came for -- so
   * anything dated within the last ninety days, or in the future (Coming soon), stays.
   * The viewer's own lists (watchlist, history) are never filtered: they chose those.
   */
  const FRESH_MS = 90 * 86400000;
  function viewable(it) {
    if (!it) return false;
    if ((+it.vote_count || 0) > 0 || (+it.vote_average || 0) > 0) return true;
    const d = it.release_date || it.first_air_date || '';
    const t = d ? Date.parse(d) : NaN;
    return !isNaN(t) && t > now() - FRESH_MS;
  }

  function cardHTML(item, forcedType, mixed) {
    const type = forcedType || item.media_type || (item.first_air_date || item.name && !item.title ? 'tv' : 'movie');
    itemCache[ck(type, item.id)] = item;
    const title = item.title || item.name || 'Untitled';
    // `date` is what toggleWatch persists, so watchlist cards read that too — without
    // it every saved title showed a bare dash where its year should be.
    const y = year(item.release_date || item.first_air_date || item.date);
    const rating = item.vote_average ? Number(item.vote_average).toFixed(1) : null;
    const on = isInWatch(item.id, type);
    return `<div class="card" data-nav="#/${type}/${item.id}" tabindex="0" role="button" aria-label="${esc(title)}${y ? ', ' + y : ''}">
      <div class="poster">
        <img loading="lazy" decoding="async" src="${img(item.poster_path, 'w342')}" alt="${esc(title)}"
             onerror="this.src='${PLACEHOLDER}'">
        ${rating ? `<span class="rate">${ICON.star} ${rating}</span>` : ''}
        ${(forcedType && !mixed) ? '' : `<span class="typebadge">${type === 'tv' ? 'TV' : 'Movie'}</span>`}
        <button class="wl ${on ? 'on' : ''}" data-wl="${item.id}" data-type="${type}"${IS_TV ? ' tabindex="-1" aria-hidden="true"' : ''} aria-pressed="${on}" title="${on ? 'Remove from' : 'Add to'} watchlist" aria-label="${on ? 'Remove from' : 'Add to'} watchlist">
          ${on ? ICON.bookmarkFill : ICON.bookmark}
        </button>
        <div class="card-hover">
          <button class="ch-play" data-nav="${watchHref(type, item.id)}" tabindex="-1" aria-hidden="true">${ICON.play}</button>
          <div class="ch-cap"><div class="ch-title">${esc(title)}</div>
            <div class="ch-meta">${y || ''}${rating ? ' \u00b7 \u2605 ' + rating : ''}<span class="ch-rt" data-rt="${type}:${item.id}"></span></div></div>
        </div>
        ${(() => { const p = Math.round(cardProgress(type, item.id) * 100);
          return p > 1 ? `<span class="card-prog" role="img" aria-label="${p} percent watched"><i style="width:${p}%"></i></span>` : ''; })()}
      </div>
    </div>`;
  }

  function railHTML(title, items, moreHref, type) {
    items = (items || []).filter(viewable);
    if (!items.length) return '';
    // Home renders five rails. Twenty tiles each is ~100 cards and ~1900 DOM nodes to
    // lay out, restyle and composite on every D-pad press; fourteen is still more than
    // anyone scrolls through before taking the "See all" tile at the end.
    if (IS_TV) items = items.slice(0, 14);
    // On TV the "See all" link leaves the D-pad order and comes back as the LAST TILE
    // of the rail. One focusable row per rail is what keeps Up/Down predictable, and a
    // poster-sized target beats 13px of header text from across the room.
    const more = moreHref ? `<a class="more" href="${moreHref}" data-nav="${moreHref}"${IS_TV ? ' tabindex="-1"' : ''}>See all ${ICON.chevR}</a>` : '';
    // The LAST tile of the rail, never the first: a leading tile would take the slot
    // the top title should occupy. Reaching it costs a held Right, which is how every
    // other 10-foot app does an end-of-row "see everything" affordance.
    const moreTile = (IS_TV && moreHref)
      ? `<div class="card more-card" data-nav="${moreHref}" tabindex="0" role="button" aria-label="See all — ${esc(title)}">
          <div class="poster"><span class="mc-in">${ICON.chevR}<span>See all</span></span></div>
        </div>`
      : '';
    return `<section class="rail">
      <div class="rail-head"><h2>${esc(title)}</h2>${more}</div>
      <div class="rail-wrap">
        <button class="rail-arrow left" data-rail="-1" tabindex="-1" aria-label="Scroll left">${ICON.back}</button>
        <div class="track">${items.map(i => cardHTML(i, type)).join('')}${moreTile}</div>
        <button class="rail-arrow right" data-rail="1" tabindex="-1" aria-label="Scroll right">${ICON.chevR}</button>
      </div>
    </section>`;
  }

  /**
   * Everything recently watched, newest first, deep-linked to the exact episode.
   *
   * One rail, not two. "Continue watching" and "Recently watched" were the same list
   * split by whether something happened to be finished -- a distinction the viewer
   * had to work out by looking at two rails holding the same posters. Unfinished
   * entries resume where they stopped; finished ones simply start again.
   */
  /** "22m left", or nothing when there is no honest number to give. */
  function leftLabel(pr) {
    if (!pr) return '';
    if (progDone(pr)) return 'Watched';
    if (pr.d > 0 && pr.t >= 0 && pr.d > pr.t) {
      const m = Math.max(1, Math.round((pr.d - pr.t) / 60));
      return (m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm') + ' left';
    }
    return '';
  }
  function recentRailHTML() {
    // Grouped BEFORE slicing, or the cap would be spent on repeats of one show.
    let rows = histByTitle();
    if (!rows.length) return '';
    rows = rows.slice(0, IS_TV ? 10 : 16);
    const tiles = rows.map(r => {
      const href = r.type === 'tv'
        ? ('#/watch/tv/' + r.id + '?s=' + (r.s || 1) + '&e=' + (r.e || 1))
        : ('#/watch/movie/' + r.id);
      // The episode shown IS the latest one watched, so it doubles as "where you are up
      // to" -- which is what the tile is for.
      const ep = r.type === 'tv' ? ('S' + (r.s || 1) + ' E' + (r.e || 1)) : '';
      const pr = progGet(r.type, r.id, r.s, r.e);
      const pct = pr ? Math.round(Math.min(1, pr.pct || 0) * 100) : 0;
      const left = leftLabel(pr);
      const sub = [ep, left].filter(Boolean).join(' \u00b7 ') || (r.type === 'tv' ? ep : 'Film');
      // A backdrop when we know one; the poster, cropped, until artFill() finds it.
      const art = artGet(r.type, r.id);
      return `<div class="card cw-card${art ? '' : ' cw-poster'}" data-nav="${href}" tabindex="0" role="button"
                   ${art ? '' : `data-art-need="${r.type}:${r.id}"`}
                   aria-label="${esc(r.title || 'title')}${ep ? ', ' + ep : ''}${left ? ', ' + left : ''}, watched ${relTime(r.at)}">
        <div class="poster">
          <img class="cw-img" loading="lazy" decoding="async" src="${art ? img(art, 'w780') : img(r.poster_path, 'w342')}" alt="" onerror="this.src='${PLACEHOLDER}'">
          <div class="cw-shade"></div>
          <div class="cw-text"><div class="cw-t">${esc(r.title || 'Untitled')}</div><div class="cw-s">${esc(sub)}</div></div>
          <span class="cw-play" aria-hidden="true">${ICON.play}</span>
          ${pct > 1 ? `<span class="card-prog"><i style="width:${pct}%"></i></span>` : ''}
        </div>
        ${IS_TV ? '' : `<button class="cw-x" data-unwatch="${esc(r.k)}" data-unwatch-group="${esc(r.g)}" tabindex="-1"
                aria-label="Remove ${esc(r.title || 'this title')} from Continue watching">${ICON.x}</button>`}
      </div>`;
    }).join('');
    return `<section class="rail cw-rail">
      <div class="rail-head"><h2>Continue watching</h2>
        <a class="more" href="#/watchlist" data-nav="#/watchlist"${IS_TV ? ' tabindex="-1"' : ''}>History ${ICON.chevR}</a></div>
      <div class="rail-wrap">
        <button class="rail-arrow left" data-rail="-1" tabindex="-1" aria-label="Scroll left">${ICON.back}</button>
        <div class="track">${tiles}</div>
        <button class="rail-arrow right" data-rail="1" tabindex="-1" aria-label="Scroll right">${ICON.chevR}</button>
      </div>
    </section>`;
  }

  /* ---- Genres: a rail on Home, a grid on the empty Search page -------------------
     Type on colour, no artwork: a tile per genre would otherwise cost a request per
     genre. The hue is derived from the id, so a genre is always the same colour. */
  function genreTilesHTML(list, type) {
    const base = type === 'tv' ? '#/tv' : '#/movies';
    return list.map(g => `<a class="genre-tile" href="${base}?genres=${g.id}" data-nav="${base}?genres=${g.id}"
        style="--h:${(g.id * 47) % 360}" aria-label="${esc(g.name)} ${type === 'tv' ? 'shows' : 'movies'}"><span>${esc(g.name)}</span></a>`).join('');
  }
  function genreRailHTML(list) {
    if (!list || !list.length) return '';
    return `<section class="rail genre-rail">
      <div class="rail-head"><h2>Browse by mood or genre</h2></div>
      <div class="rail-wrap">
        <button class="rail-arrow left" data-rail="-1" tabindex="-1" aria-label="Scroll left">${ICON.back}</button>
        <div class="track">${presetTilesHTML()}${genreTilesHTML(list, 'movie')}</div>
        <button class="rail-arrow right" data-rail="1" tabindex="-1" aria-label="Scroll right">${ICON.chevR}</button>
      </div>
    </section>`;
  }

  /** The history log, newest first. */
  function histSectionHTML() {
    const h = histAll();
    if (!h.length) return '';
    const rows = h.slice(0, 80).map(r => {
      const href = r.type === 'tv'
        ? ('#/watch/tv/' + r.id + '?s=' + (r.s || 1) + '&e=' + (r.e || 1))
        : ('#/watch/movie/' + r.id);
      const sub = r.type === 'tv' ? ('S' + (r.s || 1) + ' \u00b7 E' + (r.e || 1)) : 'Film';
      const pr = progGet(r.type, r.id, r.s, r.e);
      return `<div class="hist-row" data-nav="${href}" tabindex="0" role="button"
                   aria-label="${esc(r.title || 'title')}, ${sub}, watched ${relTime(r.at)}">
        <img class="hist-poster" loading="lazy" decoding="async" src="${img(r.poster_path, 'w154')}" alt="" onerror="this.src='${PLACEHOLDER}'">
        <div style="min-width:0;flex:1">
          <div class="hist-t">${esc(r.title || 'Untitled')}</div>
          <div class="hist-s">${sub} \u00b7 ${relTime(r.at)}</div>
          ${progBar(pr)}
        </div>
      </div>`;
    }).join('');
    return `<div class="section" id="history">
      <div class="rail-head"><h2>Watch history</h2>
        <button class="btn sm ghost" id="hist-clear">Clear history</button></div>
      <div class="hist-list">${rows}</div>
    </div>`;
  }

  // Phosphor bold numerals for the Top 10 rail. The old numbers were TEXT at 148px
  // with -webkit-text-stroke, a non-standard property that strokes the glyph's own
  // hinted outline -- which is why the joins and curve ends looked ragged and looked
  // different in every engine. These are plain vector paths: exact at any size.
  const DIGIT = {
    '0': '<path d="M186.62,61.05c-13.76-21.62-34-33-58.62-33S83.14,39.43,69.38,61.05C58.17,78.66,52,102.44,52,128s6.17,49.33,17.38,66.94C83.14,216.57,103.41,228,128,228s44.86-11.43,58.62-33.06C197.83,177.33,204,153.56,204,128S197.83,78.66,186.62,61.05Zm-20.25,121C157.11,196.62,144.2,204,128,204s-29.11-7.38-38.37-21.94C80.84,168.25,76,149.05,76,128s4.84-40.25,13.63-54.06C98.89,59.38,111.8,52,128,52s29.11,7.38,38.37,21.94C175.16,87.75,180,107,180,128S175.16,168.25,166.37,182.06Z"/>',
    '1': '<path d="M148,48V208a12,12,0,0,1-24,0V69.19l-21.83,13.1A12,12,0,0,1,89.83,61.71l40-24A12,12,0,0,1,148,48Z"/>',
    '2': '<path d="M180,208a12,12,0,0,1-12,12H88a12,12,0,0,1-9.6-19.2l71.95-95.92a28,28,0,1,0-48-28.06,12,12,0,0,1-22-9.62,52.32,52.32,0,0,1,6.13-10.49,52,52,0,0,1,83.06,62.59L112,196h56A12,12,0,0,1,180,208Z"/>',
    '3': '<path d="M180,160A60,60,0,0,1,80,204.72a12,12,0,1,1,16-17.88A36,36,0,1,0,120,124a12,12,0,0,1-9.6-19.2L144,60H88a12,12,0,0,1,0-24h80a12,12,0,0,1,9.6,19.2l-36.48,48.64A60.11,60.11,0,0,1,180,160Z"/>',
    '4': '<path d="M184,156H172V48a12,12,0,0,0-21.37-7.5l-96,120A12,12,0,0,0,64,180h84v28a12,12,0,0,0,24,0V180h12a12,12,0,0,0,0-24Zm-36,0H89l59-73.79Z"/>',
    '5': '<path d="M180,160A60,60,0,0,1,80,204.72a12,12,0,1,1,16-17.88,36,36,0,1,0,.69-54.28,12,12,0,0,1-19.54-11.49L92.23,45.65A12,12,0,0,1,104,36h64a12,12,0,0,1,0,24H113.84l-8.36,41.79A60,60,0,0,1,180,160Z"/>',
    '6': '<path d="M128,100a59.21,59.21,0,0,0-7.81.53l26.27-46.64a12,12,0,0,0-20.92-11.78L76,130.13A60,60,0,1,0,128,100Zm0,96a36,36,0,1,1,36-36A36,36,0,0,1,128,196Z"/>',
    '7': '<path d="M179.49,51.45l-48,160A12,12,0,0,1,120,220a11.82,11.82,0,0,1-3.45-.51,12,12,0,0,1-8-14.94L151.87,60H88a12,12,0,0,1,0-24h80a12,12,0,0,1,11.49,15.45Z"/>',
    '8': '<path d="M162.44,118.91a52,52,0,1,0-68.88,0,60,60,0,1,0,68.88,0ZM100,80a28,28,0,1,1,28,28A28,28,0,0,1,100,80Zm28,124a36,36,0,1,1,36-36A36,36,0,0,1,128,204Z"/>',
    '9': '<path d="M188,96a60,60,0,1,0-60,60,59.21,59.21,0,0,0,7.81-.53l-26.27,46.64a12,12,0,0,0,20.92,11.78l49.54-88A59.57,59.57,0,0,0,188,96ZM92,96a36,36,0,1,1,36,36A36,36,0,0,1,92,96Z"/>',
  };
  /** A rank as vector digits. Two glyphs for 10, which is why this is a loop. */
  function rankNum(n) {
    return String(n).split('').map(c =>
      '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">' +
      (DIGIT[c] || '') + '</svg>').join('');
  }
  // "Top 10"-style ranked row with big numerals
  function rankRailHTML(title, items) {
    items = (items || []).filter(x => x.poster_path || x.backdrop_path).slice(0, 10);
    if (!items.length) return '';
    return `<section class="rail rank-rail">
      <div class="rail-head"><h2>${esc(title)}</h2></div>
      <div class="rail-wrap">
        <button class="rail-arrow left" data-rail="-1" tabindex="-1" aria-label="Scroll left">${ICON.back}</button>
        <div class="track">${items.map((it, i) => {
          const type = it.media_type || (it.first_air_date ? 'tv' : 'movie');
          itemCache[ck(type, it.id)] = it;
          return `<div class="rank-item card" data-nav="#/${type}/${it.id}" tabindex="0" role="button" aria-label="Number ${i + 1}, ${esc(it.title || it.name)}">
            <span class="rank-num" aria-hidden="true">${rankNum(i + 1)}</span>
            <div class="poster">
              <img loading="lazy" decoding="async" src="${img(it.poster_path, 'w342')}" onerror="this.src='${PLACEHOLDER}'" alt="${esc(it.title || it.name)}">
              <div class="card-hover"><button class="ch-play" data-nav="${watchHref(type, it.id)}" tabindex="-1" aria-hidden="true">${ICON.play}</button></div>
            </div>
          </div>`;
        }).join('')}</div>
        <button class="rail-arrow right" data-rail="1" tabindex="-1" aria-label="Scroll right">${ICON.chevR}</button>
      </div>
    </section>`;
  }

  function skeletonRow() {
    let s = '<div class="rail"><div class="sk line" style="width:180px;height:20px;margin:0 0 14px"></div><div class="track">';
    for (let i = 0; i < 7; i++) s += '<div style="width:165px;flex:none"><div class="sk poster"></div></div>';
    return s + '</div></div>';
  }

  function skeletonGrid(n) {
    let s = '<div class="grid">';
    for (let i = 0; i < (n || 12); i++) s += '<div><div class="sk poster"></div><div class="sk line" style="width:80%"></div><div class="sk line" style="width:50%"></div></div>';
    return s + '</div>';
  }

  /* ------------------------------------------------------------
     Genres (cached)
     ------------------------------------------------------------ */
  const GENRES = { movie: null, tv: null };
  // Names for the ids list responses carry. Filled by genres(); until then a hero simply
  // shows no genre, which is better than blocking first paint on a lookup table.
  const GENRE_NAMES = Object.create(null);
  async function genres(type) {
    if (GENRES[type]) return GENRES[type];
    const d = await tmdb('/genre/' + type + '/list');
    GENRES[type] = d.genres || [];
    GENRES[type].forEach(g => { GENRE_NAMES[g.id] = g.name; });
    return GENRES[type];
  }

  /* ============================================================
     VIEWS
     ============================================================ */

  /* ---------- Home ---------- */
  let heroTimer = null;
  function clearHero() {
    if (heroTimer) { clearInterval(heroTimer); heroTimer = null; }
    // The 'stop rotating, the user is driving' listener is one-shot, but if it never
    // fires it would otherwise outlive its billboard — one more on every visit Home.
    if (heroStopOnce) { document.removeEventListener('keydown', heroStopOnce); heroStopOnce = null; }
  }

  async function heroLogo(item) {
    // Back to Home hands us the SAME trending objects out of the cache, already carrying what
    // this worked out last time. /images is never cached, and homeView awaits all five before
    // it may render -- so without this the return costs a round trip however warm the lists are.
    if (item._heroPoster !== undefined && item._logo !== undefined) return item._logo;
    try {
      const type = item.media_type || (item.first_air_date ? 'tv' : 'movie');
      const d = await tmdb('/' + type + '/' + item.id + '/images', { include_image_language: 'en,null', language: 'en' });
      const logos = (d.logos || []).filter(l => l.file_path && (l.iso_639_1 === 'en' || l.iso_639_1 === null));
      logos.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
      // The same response lists posters, and the ones with NO language are textless --
      // key art without a printed title. The phone hero sets our own title treatment
      // over its poster, so a poster that already carries one prints the name twice.
      const clean = (d.posters || []).filter(p => p.file_path && p.iso_639_1 === null)
        .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))[0];
      // BOTH memo fields are written here, together, and only on success -- so "both defined"
      // can only mean "a lookup finished". homeView used to write _logo, and wrote a failure's
      // null too: leave Home mid-load, come back to one dropped request, and the hero showed a
      // plain text title until the list expired.
      item._heroPoster = clean ? clean.file_path : '';
      return (item._logo = logos[0] ? img(logos[0].file_path, 'w500') : null);
    } catch (e) { return null; }
  }

  function billboardSlide(it, i) {
    const type = it.media_type || (it.first_air_date ? 'tv' : 'movie');
    const title = it.title || it.name || '';
    const y = year(it.release_date || it.first_air_date);
    const rating = it.vote_average ? it.vote_average.toFixed(1) : null;
    const on = isInWatch(it.id, type);
    const ov = (it.overview || '').slice(0, 200);
    return `<div class="bb-slide ${i === 0 ? 'on' : ''}" data-i="${i}" data-key="${type}:${it.id}" data-amb="${esc(it.poster_path || '')}">
      <div class="bb-bg" style="background-image:url('${img(it.backdrop_path, 'w1280')}')"></div>
      ${(it._heroPoster || it.poster_path) ? `<img class="bb-poster" alt="" loading="lazy" decoding="async" src="${img(it._heroPoster || it.poster_path, 'w780')}">` : ''}
      <div class="bb-scrim"></div>
      <div class="bb-info">
        ${it._logo
          ? `<img class="bb-logo" src="${it._logo}" alt="${esc(title)}" onerror="this.style.display='none';var h=this.nextElementSibling;if(h)h.style.display='block'"><h1 class="bb-title" style="display:none">${esc(title)}</h1>`
          : `<h1 class="bb-title">${esc(title)}</h1>`}
        <div class="bb-meta">
          ${rating ? `<span class="pill rating">${ICON.star}${rating}</span>` : ''}
          <span>${y || ''}</span>
          <span class="pill-type">${type === 'tv' ? 'Series' : 'Film'}</span>
          ${(it.genre_ids || []).slice(0, 2).map(g => GENRE_NAMES[g]).filter(Boolean).map(n => `<span class="bb-genre">${esc(n)}</span>`).join('')}
        </div>
        <p class="bb-ovw">${esc(ov)}${(it.overview || '').length > 200 ? '…' : ''}</p>
        <div class="bb-cta">
          <button class="btn primary lg" data-nav="${watchHref(type, it.id)}">${ICON.play} Play</button>
          <button class="btn glass lg" data-nav="#/${type}/${it.id}">${ICON.info} More Info</button>
          <button class="btn glass icon" data-wl="${it.id}" data-type="${type}" aria-pressed="${on}" aria-label="${on ? 'Remove from' : 'Add to'} watchlist">${on ? ICON.check : ICON.plus}</button>
        </div>
      </div>
    </div>`;
  }

  function buildBillboard(items) {
    if (!items.length) return '';
    return `<div class="billboard" id="billboard">
      ${items.map(billboardSlide).join('')}
      <button class="bb-arrow left" data-bb="-1" tabindex="-1" aria-label="Previous featured title">${ICON.back}</button>
      <button class="bb-arrow right" data-bb="1" tabindex="-1" aria-label="Next featured title">${ICON.chevR}</button>
      <div class="bb-dots">${items.map((it, i) => `<button class="bb-dot ${i === 0 ? 'on' : ''}" data-dot="${i}" tabindex="${IS_TV ? '0' : '-1'}" aria-label="Featured ${i + 1}${(it.title || it.name) ? ': ' + esc(it.title || it.name) : ''}"></button>`).join('')}</div>
    </div>`;
  }

  function wireBillboard() {
    const bb = document.getElementById('billboard');
    if (!bb) return;
    const slides = [].slice.call(bb.querySelectorAll('.bb-slide'));
    const dots = [].slice.call(bb.querySelectorAll('.bb-dot'));
    let idx = 0;
    const show = (n) => {
      idx = (n + slides.length) % slides.length;
      slides.forEach((s, i) => {
        const on = i === idx;
        s.classList.toggle('on', on);
        // Keep the OFF slides out of the focus order and out of the accessibility
        // tree as well — CSS alone only stops the pointer and the D-pad.
        s.setAttribute('aria-hidden', on ? 'false' : 'true');
        if ('inert' in s) s.inert = !on;
        // `inert` only landed in Chromium 102 and TV boxes ship well behind that, so
        // without this an off slide keeps aria-hidden AND keeps its buttons in the tab
        // order — an aria-hidden-containing-focusable violation.
        else s.querySelectorAll('button, a, input, select').forEach(c => {
          if (on) c.removeAttribute('tabindex'); else c.setAttribute('tabindex', '-1');
        });
      });
      dots.forEach((d, i) => { d.classList.toggle('on', i === idx); d.setAttribute('aria-current', i === idx ? 'true' : 'false'); });
      ambientFrom(slides[idx].dataset.amb);   // the room follows the hero
      stageChipSet(slides[idx]);
      tvInvalidate();   // a different slide's buttons are focusable now
    };
    // Pointer staging (wirePointerStage) adds slides of its own and drives the hero from here.
    bb._slides = slides; bb._show = show; bb._cur = () => idx; bb._stop = clearHero;
    show(0);   // apply the off-state to slides 2..n before anything can focus them
    if (slides.length < 2) return;   // nothing to rotate between
    // Rotation is a courtesy for someone who is just looking. It stops for good the
    // moment the user acts — a hero that rotates between "I want that one" and the
    // button press is how you start the wrong film — and it never starts at all when
    // the viewer has asked for reduced motion (there is no pause control, so an
    // 8-second auto-advance would fail WCAG 2.2.2).
    let stopped = tvReduceMQ ? tvReduceMQ.matches : false;
    const start = () => { const keep = heroStopOnce; clearHero(); heroStopOnce = keep; if (!stopped) heroTimer = setInterval(() => show(idx + 1), 8000); };
    const stopForGood = () => { stopped = true; clearHero(); };
    bb._stop = stopForGood;
    if (heroStopOnce) document.removeEventListener('keydown', heroStopOnce);
    heroStopOnce = stopForGood;
    document.addEventListener('keydown', heroStopOnce, { once: true });
    start();
    bb.addEventListener('mouseenter', clearHero);
    bb.addEventListener('mouseleave', start);
    // Choosing a slide by hand does NOT re-arm the timer; focusout does that, and only
    // once focus has actually left the hero.
    dots.forEach((d, i) => d.addEventListener('click', () => { stopForGood(); show(i); }));
    bb.querySelectorAll('[data-bb]').forEach(b => b.addEventListener('click', () => {
      stopForGood(); show(idx + (+b.dataset.bb || 1));
    }));
    // Drag to change slide. Pointer events cover mouse and touch in one path. A move
    // is only claimed once it is clearly horizontal, so a vertical swipe still scrolls
    // the page instead of being eaten by the hero.
    let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false;
    bb.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, a')) return;      // let the CTAs be pressed
      dragging = true; sx = e.clientX; sy = e.clientY; dx = dy = 0;
    });
    bb.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dx = e.clientX - sx; dy = e.clientY - sy;
      bb.classList.toggle('dragging', Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy));
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false; bb.classList.remove('dragging');
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) { stopForGood(); show(idx + (dx < 0 ? 1 : -1)); }
    };
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => bb.addEventListener(ev, endDrag));
    // A hero that rotates out from under you is how you press Play and get the wrong
    // film — and rotating a slide away now also makes it inert, which would throw a
    // keyboard user's focus to the body. So whoever is holding focus owns the hero.
    bb.addEventListener('focusin', clearHero);
    bb.addEventListener('focusout', () => setTimeout(() => {
      if (document.body.contains(bb) && !bb.contains(document.activeElement)) start();
    }, 0));
    // On TV the dots are real D-pad targets, sitting on the same row as Play / More
    // Info, so the remote can walk right off the buttons into the featured picker.
    if (IS_TV) dots.forEach((d, i) => d.addEventListener('focus', () => { clearHero(); show(i); }));
  }

  /**
   * Desktop title page: its blocks under tabs -- Episodes, More like this, Details -- instead of
   * one long scroll. The blocks say which tab they belong to (data-panel); the bar goes in
   * front of the first. On a phone (860px and below, stage.css) the bar hides and every block shows, so the
   * phone keeps its stacked page.
   */
  function wireTitleTabs() {
    const panels = [].slice.call(view().querySelectorAll('.dv-panel'));
    const has = (k) => panels.some((p) => p.dataset.panel === k);
    const tabs = [['eps', 'Episodes'], ['more', 'More like this'], ['info', 'Details']].filter((t) => has(t[0]));
    if (tabs.length < 2) { panels.forEach((p) => p.classList.add('on')); return; }
    const bar = document.createElement('div');
    bar.className = 'dv-tabs';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'About this title');
    bar.innerHTML = tabs.map((t) => `<button type="button" role="tab" class="dv-tab" data-tab="${t[0]}" aria-selected="false">${t[1]}</button>`).join('');
    panels[0].parentNode.insertBefore(bar, panels[0]);
    const pick = (k) => {
      bar.querySelectorAll('.dv-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
      panels.forEach((p) => p.classList.toggle('on', p.dataset.panel === k));
    };
    bar.addEventListener('click', (e) => { const b = e.target.closest('.dv-tab'); if (b) pick(b.dataset.tab); });
    pick(tabs[0][0]);
  }

  /**
   * Phone title page: once the hero's Play has scrolled away, the same button waits above the
   * tab bar (stage.css shows it on a phone only). A copy of the hero's own button -- data-play
   * and data-nav come with it, so Resume, the episode and "straight to the player" all hold.
   */
  let titleDockIO = null;
  function wireTitleDock() {
    if (titleDockIO) { titleDockIO.disconnect(); titleDockIO = null; }
    const cta = view().querySelector('.dv-cta');
    const play = cta && cta.querySelector('.btn.primary[data-play]');
    if (!play || !('IntersectionObserver' in window)) return;
    const dock = document.createElement('div');
    dock.className = 'dv-dock';
    dock.hidden = true;
    dock.appendChild(play.cloneNode(true));
    view().appendChild(dock);
    titleDockIO = new IntersectionObserver((es) => {
      const e = es[es.length - 1];
      dock.hidden = e.isIntersecting || e.boundingClientRect.top > 0;   // only once it is ABOVE the screen
    });
    titleDockIO.observe(cta);
  }

  /* ---- Pointer staging (desktop) ------------------------------------------------
     The pointer's Stage: resting on a card in a row puts that title in the hero above, after
     a short pause so sweeping across a row does not flicker. It gets a slide built exactly
     like the featured ones, in one of two slots that take turns (the one going out
     cross-fades while the other comes in), so the hero never grows. The first time it
     happens the rotation stops for good: the viewer is choosing. Mouse and trackpad only --
     a tap is a press, not a point. */
  const STAGE_DWELL = 260;
  let pstageTimer = 0, pstageSeq = 0;
  const finePointer = () => !IS_TV && !!window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;
  function wirePointerStage() {
    const bb = document.getElementById('billboard');
    const rows = view().querySelector('.rows');
    if (!bb || !rows || !bb._show || !finePointer()) return;
    bb._slots = [];
    rows.addEventListener('pointerover', (e) => {
      const card = e.target.closest && e.target.closest('.card');
      if (!card || card.classList.contains('more-card')) return;
      const m = /^#\/(?:watch\/)?(movie|tv)\/(\d+)/.exec(card.getAttribute('data-nav') || '');
      if (!m) return;
      clearTimeout(pstageTimer);
      pstageTimer = setTimeout(() => pointerStage(bb, m[1], m[2]), STAGE_DWELL);
    });
    rows.addEventListener('pointerleave', () => clearTimeout(pstageTimer));
  }
  async function pointerStage(bb, type, id) {
    if (!document.body.contains(bb)) return;
    const seq = ++pstageSeq, key = type + ':' + id, slides = bb._slides;
    let n = slides.findIndex((s) => s.dataset.key === key);
    if (n < 0) {
      // A row's list carries no logo and sometimes no backdrop or story; Continue watching
      // carries only what history kept. Fill in what the hero needs (cached after the first).
      let it = itemCache[ck(type, id)];
      try {
        if (!it || !it.backdrop_path || !it.overview) {
          const d = await titleData(type, id);   // the title page's request: a click after this is instant
          it = Object.assign(it || {}, d);
          itemCache[ck(type, id)] = it;
        } else titleData(type, id).catch(() => {});
        it.media_type = it.media_type || type;
        await heroLogo(it);
      } catch (e) { if (!it) return; }
      if (seq !== pstageSeq || !document.body.contains(bb) || !it.backdrop_path) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = billboardSlide(it, slides.length).trim();
      const el = tmp.firstElementChild;
      // The slot not on screen takes the new title; the first two times there is none yet.
      const cur = bb._cur();
      const slot = bb._slots.length < 2 ? -1 : bb._slots.filter((i) => i !== cur)[0];
      if (slot < 0) {
        bb.insertBefore(el, bb.querySelector('.bb-arrow'));
        slides.push(el);
        bb._slots.push(n = slides.length - 1);
      } else {
        slides[slot].replaceWith(el);
        slides[n = slot] = el;
      }
    }
    bb.classList.add('pointing');
    bb._stop();
    bb._show(n);
  }

  /** The top bar's "On stage" chip: what the hero holds, one click away once it has scrolled off. */
  function stageChipSet(slide) {
    const chip = document.getElementById('on-stage');
    if (!chip || !slide) return;
    const more = slide.querySelector('.bb-cta [data-nav^="#/movie/"], .bb-cta [data-nav^="#/tv/"]');
    const logo = slide.querySelector('.bb-logo'), h = slide.querySelector('.bb-title');
    const title = (logo && logo.getAttribute('alt')) || (h && h.textContent) || '';
    if (!more || !title) { chip.hidden = true; return; }
    chip.hidden = false;
    chip.setAttribute('data-nav', more.getAttribute('data-nav'));
    chip.setAttribute('aria-label', 'On stage: ' + title + ', open');
    chip.querySelector('.os-t').textContent = title;
    const p = slide.dataset.amb, im = chip.querySelector('img');
    if (p && RX_IMGPATH.test(p)) { im.src = img(p, 'w92'); im.hidden = false; } else im.hidden = true;
  }

  async function homeView() {
    const my = routeSeq;
    clearHero();
    // TV Home is the Stage: no billboard (the stage behind the rows shows the focused title),
    // so none of its five /images lookups hold up the first paint either.
    const staged = !!stageEl;
    view().innerHTML = staged ? `<div class="rows">${skeletonRow()}${skeletonRow()}</div>`
                              : `<div class="billboard-sk sk"></div><div class="rows">${skeletonRow()}${skeletonRow()}</div>`;
    try {
      // "Because you watched X": recommendations for the title watched most recently.
      // Fetched alongside the rest, never awaited on its own, and a failure just means
      // no rail.
      const seed = histByTitle()[0] || null;
      // Every request on its own. One rail failing must not blank the page: whatever
      // came back is rendered and the rest is simply absent. Only when NOTHING came
      // back is the page an error, and then it is the first failure that is shown.
      let firstErr = null;
      const soft = (p) => p.catch((e) => { if (!firstErr) firstErr = e; return null; });
      const [trend, popM, popT, topM, upcoming, recs, gl] = await Promise.all([
        soft(tmdb('/trending/all/day')), soft(tmdb('/movie/popular')), soft(tmdb('/tv/popular')),
        soft(tmdb('/movie/top_rated')), soft(tmdb('/discover/movie', homeReleaseParams(45))),
        seed ? soft(tmdb('/' + seed.type + '/' + seed.id + '/recommendations')) : Promise.resolve(null),
        // Both lists: the rail shows film genres, and the hero names genres of either kind.
        Promise.all([genres('movie'), genres('tv')]).then(x => x[0]).catch(() => null)
      ]);
      if (!trend && !popM && !popT && !topM && !upcoming) throw firstErr || new Error('Nothing could be loaded.');
      const trendItems = ((trend && trend.results) || []).filter(x => x.media_type !== 'person' && viewable(x));
      const heroItems = trendItems.filter(x => x.backdrop_path).slice(0, 5);
      if (!staged) await Promise.all(heroItems.map(heroLogo));     // each sets its own _logo / _heroPoster
      if (!routeIs(my)) return;   // the user has navigated away — this response is stale
      heroItems.forEach((h) => { itemCache[ck(h.media_type, h.id)] = h; });
      // History rows behind Continue watching, by "type:id", for the stage's title fallback.
      if (staged) stageHist = new Map(histByTitle().map(r => [r.type + ':' + r.id, r]));
      let html = staged ? '' : buildBillboard(heroItems);
      html += '<div class="rows">';
      // ONE rail, not two. "Continue watching" and "Recently watched" were the same
      // list split by whether something happened to be finished, which is a
      // distinction the viewer has to work out by looking. Recently watched covers
      // both: unfinished entries resume where they stopped, finished ones start over.
      html += recentRailHTML();
      if (seed && recs && Array.isArray(recs.results)) {
        const items = recs.results.filter(x => x.poster_path && String(x.id) !== String(seed.id));
        html += railHTML('Because you watched ' + (seed.title || 'that'), items, null, seed.type);
      }
      html += rankRailHTML('Top 10 today', trendItems);
      html += railHTML('Popular movies', popM && popM.results, '#/movies', 'movie');
      html += railHTML('Popular shows', popT && popT.results, '#/tv', 'tv');
      html += genreRailHTML(gl);
      html += railHTML('Top rated', topM && topM.results, '#/movies?sort=vote_average.desc', 'movie');
      // "Coming soon" listed THEATRICAL releases -- films this app cannot play yet, so Play led
      // to empty mirrors. This is what reached digital or disc in the last six weeks. Where
      // TMDB's (crowd-sourced, US-heavy) release dates give too little, the old list returns.
      let fresh = upcoming && upcoming.results, freshTitle = 'New to watch at home', freshMore = '#/movies?preset=home';
      if (!fresh || fresh.filter(viewable).length < 6) {
        const up = await tmdb('/movie/upcoming', { region: cfg.region }).catch(() => null);
        if (!routeIs(my)) return;
        if (up && up.results) { fresh = up.results; freshTitle = 'Coming soon'; freshMore = '#/movies?sort=primary_release_date.desc'; }
      }
      html += railHTML(freshTitle, fresh, freshMore, 'movie');
      html += '</div>';
      view().innerHTML = html;
      wireBillboard();
      wirePointerStage();
      artFill(view());          // backdrops for history that predates the art cache
      const touchy = !IS_TV && window.matchMedia && matchMedia('(hover: none)').matches;
      if (IS_TV || touchy) {
        try {
          if (!localStorage.getItem('reeldeck.hint.holdok')) {
            localStorage.setItem('reeldeck.hint.holdok', '1');
            setTimeout(() => { if (routeIs(my) && !document.getElementById('lock')) toast(IS_TV ? 'Tip: hold OK on a title for more options' : 'Tip: press and hold a poster for options'); }, 2500);
          }
        } catch (e) {}
      }
    } catch (e) { if (routeIs(my)) errorState(e); }
  }

  /* ---- Presets -------------------------------------------------------------------
     One-press starting points for "what shall we watch": each is just a set of Discover
     parameters with a name. Keyword ids checked against the live API (each has 100+ films
     with 50+ votes behind it, so none of them opens onto a stub). */
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  function homeReleaseParams(days) {
    return { region: cfg.region, with_release_type: '4|5', 'release_date.gte': iso(now() - days * 86400000),
             'release_date.lte': iso(now()), sort_by: 'popularity.desc', 'vote_count.gte': 20 };
  }
  const PRESETS = [
    { id: 'short', label: 'Under 90 minutes', href: '#/movies?rt=90', h: 205 },
    { id: 'heist', label: 'Heist', href: '#/movies?kw=10051&kwn=Heist', h: 28 },
    { id: 'whodunit', label: 'Whodunit', href: '#/movies?kw=12570&kwn=Whodunit', h: 268 },
    { id: 'true', label: 'True story', href: '#/movies?kw=9672&kwn=True%20story', h: 150 },
    { id: 'gems', label: 'Hidden gems', href: '#/movies?preset=gems', h: 330 }
  ];
  const PRESET_NAMES = { home: 'New to watch at home', gems: 'Hidden gems' };
  function presetTilesHTML() {
    return PRESETS.map(p => `<a class="genre-tile preset-tile" href="${p.href}" data-nav="${p.href}" style="--h:${p.h}"><span>${esc(p.label)}</span></a>`).join('');
  }

  /* ---------- Discover / search (movies & tv share this) ---------- */
  const SORTS = [
    { v: 'popularity.desc', label: 'Popularity' },
    { v: 'vote_average.desc', label: 'Rating' },
    { v: 'newest', label: 'Newest' },
    { v: 'oldest', label: 'Oldest' },
    { v: 'revenue.desc', label: 'Revenue' }
  ];
  const LANGS = [
    { v: '', label: 'Any language' }, { v: 'en', label: 'English' }, { v: 'es', label: 'Spanish' },
    { v: 'fr', label: 'French' }, { v: 'ja', label: 'Japanese' }, { v: 'ko', label: 'Korean' },
    { v: 'hi', label: 'Hindi' }, { v: 'de', label: 'German' }, { v: 'it', label: 'Italian' },
    { v: 'zh', label: 'Chinese' }
  ];

  async function discoverView(type, params) {
    const my = routeSeq;
    const isTV = type === 'tv';
    const q = params.q || '';
    const page = Math.max(1, parseInt(params.page || '1', 10));
    const selGenres = (params.genres || '').split(',').filter(Boolean);
    // Paint BEFORE fetching. genres() is awaited below, and on a slow connection that
    // await used to hold the previous page on screen -- title, posters and all -- so
    // choosing "TV Shows" looked like a tap that had not registered. A title and a
    // skeleton cost nothing and say the right thing: you are here, it is loading.
    view().innerHTML = '<h1 class="page-title">' +
      (q ? 'Search' : (isTV ? 'TV Shows' : 'Movies')) + '</h1>' +
      '<div id="results">' + skeletonGrid(18) + '</div>';
    const gl = await genres(isTV ? 'tv' : 'movie').catch(() => []);
    if (!routeIs(my)) return;   // navigated on while genres was in flight

    // Build toolbar
    const sortSel = SORTS.map(s => `<option value="${s.v}" ${params.sort === s.v ? 'selected' : ''}>${s.label}</option>`).join('');
    const langSel = LANGS.map(l => `<option value="${l.v}" ${params.lang === l.v ? 'selected' : ''}>${l.label}</option>`).join('');
    const yNow = new Date().getFullYear();
    // Build the <select>s by marking the selected option while generating them. The old
    // blind String.replace could not match a year outside 1950…yNow+1, so an
    // out-of-range ?yfrom= showed "Any" and was then deleted by the next filter change.
    // Open the panel when something is already filtering, so a narrowed list never
    // looks like the whole catalogue with results mysteriously missing.
    const activeFilters = [params.sort && params.sort !== 'popularity.desc', params.yfrom, params.yto,
                           params.rating, params.lang, params.rt, selGenres.length].filter(Boolean).length;
    // Context that arrived by link rather than by a control: a keyword chip from a title
    // page, or a preset tile. Shown as a removable chip so a narrowed list says why.
    const ctxParams = new URLSearchParams(params);
    const without = (keys) => { const p = new URLSearchParams(ctxParams); keys.forEach(k => p.delete(k)); p.delete('page'); const q2 = p.toString(); return '#/' + (isTV ? 'tv' : 'movies') + (q2 ? '?' + q2 : ''); };
    const ctxChips = [
      params.kw ? `<button class="chip on ctx-chip" data-nav="${without(['kw', 'kwn'])}" aria-label="Remove keyword ${esc(params.kwn || '')}">${esc(params.kwn || 'Keyword')} ${ICON.x}</button>` : '',
      (params.preset && PRESET_NAMES[params.preset]) ? `<button class="chip on ctx-chip" data-nav="${without(['preset'])}" aria-label="Remove ${esc(PRESET_NAMES[params.preset])}">${esc(PRESET_NAMES[params.preset])} ${ICON.x}</button>` : ''
    ].join('');
    const yearOptsFor = (v) => {
      let out = `<option value=""${v ? '' : ' selected'}>Any</option>`;
      for (let y = yNow + 1; y >= 1950; y--) out += `<option value="${y}"${String(v) === String(y) ? ' selected' : ''}>${y}</option>`;
      if (v && !(v >= 1950 && v <= yNow + 1)) out = `<option value="${esc(String(v))}" selected>${esc(String(v))}</option>` + out;
      return out;
    };

    const toolbar = q ? `
      <div class="toolbar"><div class="field" style="flex:1">
        <label>Search results for</label>
        <div style="font-size:20px;font-weight:800">“${esc(q)}”</div>
      </div>
      <button class="btn sm" data-nav="#/${isTV ? 'tv' : 'movies'}">Clear search</button></div>` : `
      <details class="filters"${activeFilters ? ' open' : ''}>
        <summary tabindex="0">
          <span>Filters</span>
          ${activeFilters ? `<span class="fl-n">${activeFilters} active</span>` : '<span class="fl-n">Sort, year, rating, language, genre</span>'}
        </summary>
      <div class="toolbar">
        <div class="field"><label for="f-sort">Sort</label><select id="f-sort">${sortSel}</select></div>
        <div class="field"><label for="f-yfrom">From year</label><select id="f-yfrom">${yearOptsFor(params.yfrom)}</select></div>
        <div class="field"><label for="f-yto">To year</label><select id="f-yto">${yearOptsFor(params.yto)}</select></div>
        <div class="field"><label for="f-rating">Min rating</label><select id="f-rating">
          ${['', '5', '6', '7', '8', '9'].map(r => `<option value="${r}" ${params.rating === r ? 'selected' : ''}>${r ? r + '+' : 'Any'}</option>`).join('')}
        </select></div>
        <div class="field"><label for="f-lang">Language</label><select id="f-lang">${langSel}</select></div>
        <div class="field rt-field"><label id="f-rt-l">Length</label>
          <div class="chips" id="f-rt" role="group" aria-labelledby="f-rt-l">
            ${[['', 'Any'], ['90', 'Under 90 min'], ['120', 'Under 2 hours']].map(([v, l]) =>
              `<button class="chip ${(params.rt || '') === v ? 'on' : ''}" data-rt="${v}" aria-pressed="${(params.rt || '') === v}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="field genres-field"><label>Genres</label>
          <div class="chips" id="f-genres">
            ${gl.map(g => `<button class="chip ${selGenres.includes(String(g.id)) ? 'on' : ''}" data-genre="${g.id}" aria-pressed="${selGenres.includes(String(g.id))}">${esc(g.name)}</button>`).join('')}
          </div>
        </div>
      </div>
      </details>`;

    view().innerHTML = `<h1 class="page-title">${q ? 'Search' : (isTV ? 'TV Shows' : 'Movies')}</h1>${ctxChips ? `<div class="ctx-row">${ctxChips}</div>` : ''}${toolbar}<div id="results">${skeletonGrid(18)}</div>`;

    // Wire filter controls -> update URL
    if (!q) {
      const upd = () => {
        const p = new URLSearchParams();
        const sort = $('#f-sort').value; if (sort && sort !== 'popularity.desc') p.set('sort', sort);
        const yf = $('#f-yfrom').value; if (yf) p.set('yfrom', yf);
        const yt = $('#f-yto').value; if (yt) p.set('yto', yt);
        const rt = $('#f-rating').value; if (rt) p.set('rating', rt);
        const lg = $('#f-lang').value; if (lg) p.set('lang', lg);
        const gs = Array.from(document.querySelectorAll('#f-genres .chip.on')).map(c => c.dataset.genre);
        if (gs.length) p.set('genres', gs.join(','));
        const rtOn = document.querySelector('#f-rt .chip.on'); if (rtOn && rtOn.dataset.rt) p.set('rt', rtOn.dataset.rt);
        // Context that no control owns must survive a filter change, or touching Sort would
        // silently drop the keyword the user came in on.
        ['kw', 'kwn', 'preset'].forEach(k => { if (params[k]) p.set(k, params[k]); });
        const qs = p.toString();
        go('#/' + (isTV ? 'tv' : 'movies') + (qs ? '?' + qs : ''));
      };
      ['f-sort', 'f-yfrom', 'f-yto', 'f-rating', 'f-lang'].forEach(id => { const el = $('#' + id); if (el) el.onchange = upd; });
      const rtEl = $('#f-rt');
      if (rtEl) rtEl.onclick = e => {
        const c = e.target.closest('.chip'); if (!c) return;
        rtEl.querySelectorAll('.chip').forEach(x => { x.classList.toggle('on', x === c); x.setAttribute('aria-pressed', String(x === c)); });
        upd();
      };
      const gEl = $('#f-genres');
      if (gEl) gEl.onclick = e => {
        const c = e.target.closest('.chip');
        if (c) { c.classList.toggle('on'); c.setAttribute('aria-pressed', String(c.classList.contains('on'))); upd(); }
      };
      // A native disclosure changes what is on screen WITHOUT any DOM mutation the
      // row model observes, so without this the D-pad keeps navigating the layout the
      // panel had before it moved. Exactly the bug already fixed for the player's
      // server picker (#srv) -- same shape, new place.
      const fEl = $('.filters');
      const fSum = fEl && fEl.querySelector('summary');
      if (fEl) fEl.addEventListener('toggle', () => {
        if (!IS_TV) return;
        tvInvalidate();
        // Chromium queues a 'toggle' for a <details open> BUILT by innerHTML, so a panel that
        // merely RENDERS open arrives here looking exactly like one the user just opened --
        // and taking the ring then sent every chip press to Sort. Only OK on the summary leaves
        // the summary focused; "focus is somewhere in the panel" is not enough, because with a
        // cached result the ring is already back on the chip before this task runs.
        if (document.activeElement !== fSum) return;
        // Land the ring on the first revealed control rather than leaving it on the
        // summary with a panel of new options the user has to go hunting for.
        if (fEl.open) { const first = fEl.querySelector('select, button, .chip'); if (first) tvFocusEl(first); }
      });
    }

    // Build request
    try {
      let data;
      if (q) {
        data = await tmdb('/search/' + (isTV ? 'tv' : 'movie'), { query: q, page, include_adult: 'false' });
      } else {
        const p = { page, 'vote_count.gte': params.sort === 'vote_average.desc' ? 200 : 0 };
        // sort
        if (params.sort === 'newest') p.sort_by = isTV ? 'first_air_date.desc' : 'primary_release_date.desc';
        else if (params.sort === 'oldest') p.sort_by = isTV ? 'first_air_date.asc' : 'primary_release_date.asc';
        else p.sort_by = params.sort || 'popularity.desc';
        if (selGenres.length) p.with_genres = selGenres.join(',');
        if (params.rating) p['vote_average.gte'] = params.rating;
        if (params.lang) p.with_original_language = params.lang;
        const dgte = isTV ? 'first_air_date.gte' : 'primary_release_date.gte';
        const dlte = isTV ? 'first_air_date.lte' : 'primary_release_date.lte';
        if (params.yfrom) p[dgte] = params.yfrom + '-01-01';
        if (params.yto) p[dlte] = params.yto + '-12-31';
        if (/^\d{2,3}$/.test(params.rt || '')) {
          p['with_runtime.lte'] = params.rt;
          if (!isTV) p['with_runtime.gte'] = 40;          // not shorts
        }
        if (/^\d+$/.test(params.kw || '')) {
          p.with_keywords = params.kw;
          // TMDB keywords are crowd-tagged; a floor on votes keeps the long tail of
          // metadata-only entries out of a list someone opened on purpose.
          p['vote_count.gte'] = Math.max(p['vote_count.gte'] || 0, 50);
        }
        if (params.preset === 'home' && !isTV) Object.assign(p, homeReleaseParams(90), { page: page, sort_by: p.sort_by });
        if (params.preset === 'gems') { p['vote_average.gte'] = Math.max(+p['vote_average.gte'] || 0, 7.3); p['vote_count.gte'] = 150; p['vote_count.lte'] = 1500; }
        data = await tmdb('/discover/' + (isTV ? 'tv' : 'movie'), p);
      }
      const results = (data.results || []).filter(x => (x.poster_path || x.backdrop_path) && viewable(x));
      const totalPages = Math.min(data.total_pages || 1, 500);
      const box = $('#results');
      if (!box || !routeIs(my)) return;   // navigated away while the request was in flight
      if (!results.length) {
        box.innerHTML = `<div class="center-note">Nothing matched those filters.
          <div class="note-cta"><button class="btn primary" data-nav="#/${isTV ? 'tv' : 'movies'}">Clear filters</button></div></div>`;
        return;
      }
      box.innerHTML = `<div class="grid">${results.map(i => cardHTML(i, isTV ? 'tv' : 'movie')).join('')}</div>` + pagerHTML(page, totalPages, params, isTV ? 'tv' : 'movies');
    } catch (e) {
      const box = $('#results');
      if (box && routeIs(my)) { box.innerHTML = ''; errorState(e, '#results'); }
    }
  }

  function pagerHTML(page, totalPages, params, route) {
    if (totalPages <= 1) return '';
    const mk = (pg) => { const p = new URLSearchParams(params); p.set('page', pg); return '#/' + route + '?' + p.toString(); };
    return `<div class="pager">
      <button class="btn sm" ${page <= 1 ? 'disabled' : ''} data-nav="${mk(page - 1)}">← Prev</button>
      <span class="pg">Page ${page} of ${totalPages}</span>
      <button class="btn sm" ${page >= totalPages ? 'disabled' : ''} data-nav="${mk(page + 1)}">Next →</button>
    </div>`;
  }

  /* ---------- Multi search page ---------- */
  // On TV this page carries its own search field (the header has none) — a big,
  // unmissable target that opens the platform keyboard when you press OK.
  function tvSearchBar(q) {
    // Every platform now, not just TV. The header traded its inline field for an
    // icon, so this is the only search input in the app -- and giving it a whole
    // page means it can be the size it deserves instead of competing with the nav.
    // Same condition as the phone block in styles.css; the ellipsis rule there is the
    // safety net for a rotation or a resize after this was rendered.
    const ph = (!IS_TV && window.matchMedia && matchMedia('(max-width: 640px)').matches)
      ? 'Titles, people…' : 'Search movies, shows and people…';
    return `<div class="tv-search">
      <span class="ico">${ICON.search}</span>
      <input id="tv-search-input" type="search" value="${esc(q)}" autocomplete="off"
             placeholder="${ph}" aria-label="Search movies, shows and people">
      <button class="btn primary" id="tv-search-go">Search</button>
    </div>`;
  }
  function wireTvSearch() {
    const inp = $('#tv-search-input'), btn = $('#tv-search-go');
    if (!inp) return;
    // Land ready to type. Not on TV: focusing an input there opens the platform's
    // full-screen keyboard uninvited, over a page nobody has looked at yet.
    if (!IS_TV) { try { inp.focus(); inp.select(); } catch (e) {} }
    const submit = () => { const v = inp.value.trim(); if (v) go('#/search?q=' + encodeURIComponent(v)); };
    // The D-pad centre arrives as an Enter keydown, and on Android that is also the
    // gesture that raises the soft keyboard for a focused input — programmatic focus()
    // does not. Swallowing it unconditionally left the page telling the user to press
    // OK while OK did nothing, so only take the key when there is something to submit.
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (!inp.value.trim()) return;   // let the platform open its keyboard
      e.preventDefault(); submit();
    });
    // Land with the previous query selected, so typing replaces it and the caret is at
    // the end (escaping right otherwise costs one press per character).
    inp.addEventListener('focus', () => { try { inp.select(); } catch (e) {} });
    if (btn) btn.addEventListener('click', submit);
  }

  // The shell (title + TV search field) is rendered ONCE and only #results is swapped
  // when the fetch lands. Replacing all of #view a second time destroyed the element
  // the ring was on — and on TV that also tore down the input the platform keyboard
  // was attached to, mid-typing.
  async function searchView(params) {
    const my = routeSeq;
    const q = params.q || '';
    // The genre grid below is the "somewhere to go"; the old note and its two Browse
    // buttons repeated the header.
    const empty = IS_TV ? '<p class="muted search-hint">Press OK on the box above to type.</p>' : '';
    // Recent searches on the empty page: a chip is one press on a remote, against
    // re-typing a title with the on-screen keyboard.
    const rq = q ? [] : recentQ();
    const recent = rq.length ? `<div class="recent-q" role="group" aria-label="Recent searches"><span class="lbl">Recent</span>${
        rq.map(x => `<button class="chip" data-nav="#/search?q=${encodeURIComponent(x)}">${esc(x)}</button>`).join('')
      }<button class="chip ghost" id="recent-q-clear">Clear</button></div>` : '';
    view().innerHTML = `<h1 class="page-title">${q ? 'Results for “' + esc(q) + '”' : 'Search'}</h1>${tvSearchBar(q)}
      <div id="results">${q ? skeletonGrid(12) : recent + empty}</div>`;
    wireTvSearch();
    const rc = $('#recent-q-clear');
    if (rc) rc.onclick = () => { recentQClear(); route(); };
    if (!q) {
      // Nothing typed yet: somewhere to go instead of a blank page.
      genres('movie').then(gl => {
        const box = $('#results');
        if (!routeIs(my) || !box || !gl.length || box.querySelector('.genre-grid')) return;
        box.insertAdjacentHTML('beforeend', `<h2 class="sub-h">Browse by genre</h2><div class="genre-grid">${genreTilesHTML(gl, 'movie')}</div>`);
        if (IS_TV) tvInvalidate();
      }).catch(() => {});
      return;
    }
    recentQPush(q);
    try {
      const data = await tmdb('/search/multi', { query: q, page: 1, include_adult: 'false' });
      const results = (data.results || []).filter(x => x.media_type !== 'person' && (x.poster_path || x.backdrop_path) && viewable(x));
      // The field says "movies, shows and people", and people were being thrown away. One
      // strip above the grid, the same tile the cast row uses; only people with a face.
      const people = (data.results || []).filter(x => x.media_type === 'person' && x.profile_path).slice(0, 8);
      const peopleHTML = people.length ? `<h2 class="sub-h people-h">People</h2>
        <div class="rail-wrap"><button class="rail-arrow left" data-rail="-1" tabindex="-1" aria-label="Scroll people left">${ICON.back}</button>
        <div class="cast-track">${people.map(c => `<div class="person" data-nav="#/person/${c.id}" tabindex="0" role="button" aria-label="${esc(c.name)}${c.known_for_department ? ', ' + esc(c.known_for_department) : ''}">
            <img loading="lazy" decoding="async" src="${img(c.profile_path, 'w185')}" alt="" onerror="this.src='${PLACEHOLDER}'">
            <div class="n">${esc(c.name)}</div><div class="c">${esc(c.known_for_department || '')}</div>
          </div>`).join('')}</div>
        <button class="rail-arrow right" data-rail="1" tabindex="-1" aria-label="Scroll people right">${ICON.chevR}</button></div>
        ${results.length ? '<h2 class="sub-h">Titles</h2>' : ''}` : '';
      const box = $('#results');
      if (!box || !routeIs(my)) return;   // navigated away while the request was in flight
      box.innerHTML = (results.length || people.length)
        ? `${peopleHTML}${results.length ? `<div class="grid">${results.map(i => cardHTML(i)).join('')}</div>` : ''}`
        : `<div class="center-note">No titles found for “${esc(q)}”.
            <div class="note-cta"><button class="btn primary" data-nav="#/movies">Browse movies</button><button class="btn" data-nav="#/tv">Browse shows</button></div></div>`;
    } catch (e) { const box = $('#results'); if (box && routeIs(my)) { box.innerHTML = ''; errorState(e, '#results'); } }
  }
  /* ---- House lights --------------------------------------------------------------
     The page takes its colour from the title on screen. One poster, drawn once onto a
     24x36 canvas, gives a dominant hue; CSS does the rest through --ambient. TMDB sends
     Access-Control-Allow-Origin: * on images, which is what makes the canvas readable.

     Hue buckets rather than a plain average: the average of any poster is mud. Each
     pixel votes for its hue, weighted by how saturated and how mid-toned it is, and the
     winning bucket's own average is used -- then pulled into a band of lightness and
     saturation where it reads as coloured light rather than as neon or as grey. */
  const ambientCache = Object.create(null);
  let ambientSeq = 0;
  function ambientSet(css) {
    const st = document.documentElement.style;
    if (css) st.setProperty('--ambient', css); else st.removeProperty('--ambient');
  }
  function ambientPick(data) {
    const B = 12, bins = [];
    for (let i = 0; i < B; i++) bins.push({ w: 0, r: 0, g: 0, b: 0 });
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      const l = (mx + mn) / 510;
      if (d < 24 || l < 0.08 || l > 0.92) continue;          // greys, blacks, whites: no vote
      let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      const sat = d / (255 - Math.abs(mx + mn - 255) || 1);
      const w = sat * (1 - Math.abs(l - 0.5) * 1.6);
      if (w <= 0) continue;
      const bin = bins[Math.floor(h / (360 / B)) % B];
      bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
    }
    const top = bins.reduce((a, c) => (c.w > a.w ? c : a), bins[0]);
    if (top.w < 4) return '';                                // a monochrome poster: keep the theme's own light
    let r = top.r / top.w, g = top.g / top.w, b = top.b / top.w;
    // Into the band: lift the dark, settle the bright.
    const mx = Math.max(r, g, b) || 1, k = mx < 150 ? 150 / mx : mx > 215 ? 215 / mx : 1;
    r = Math.min(255, r * k); g = Math.min(255, g * k); b = Math.min(255, b * k);
    return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')';
  }
  function ambientFrom(path) {
    const mine = ++ambientSeq;
    if (!path || !RX_IMGPATH.test(path)) return ambientSet('');
    if (path in ambientCache) return ambientSet(ambientCache[path]);
    const im = new Image();
    im.crossOrigin = 'anonymous'; im.decoding = 'async';
    im.onload = () => {
      let css = '';
      try {
        const c = document.createElement('canvas'); c.width = 24; c.height = 36;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(im, 0, 0, 24, 36);
        css = ambientPick(cx.getImageData(0, 0, 24, 36).data);
      } catch (e) { css = ''; }                               // a tainted canvas: no light, no error
      ambientCache[path] = css;
      if (mine === ambientSeq) ambientSet(css);
    };
    // NOT cached: a dropped connection says nothing about the poster, and caching '' here
    // kept the room dark for that title for the rest of the session. The light does go
    // down, though, or the previous slide's colour would sit behind this one.
    im.onerror = () => { if (mine === ambientSeq) ambientSet(''); };
    im.src = img(path, 'w92');
  }

  /* ---- Art cache -----------------------------------------------------------------
     History rows carry a poster, and Continue watching wants a backdrop. Remembered when
     something is played, back-filled (a few at a time) for history older than this. */
  const ART_KEY = 'reeldeck.art.v1';
  let artMem = null, artSaveT = 0;
  function artAll() {
    if (!artMem) {
      try { const o = JSON.parse(localStorage.getItem(ART_KEY) || '{}'); artMem = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
      catch (e) { artMem = {}; }
    }
    return artMem;
  }
  function artGet(type, id) { const p = artAll()[type + ':' + id]; return (p && RX_IMGPATH.test(p)) ? p : ''; }
  function artNote(type, id, backdrop) {
    if (!backdrop || !RX_IMGPATH.test(backdrop)) return;
    const a = artAll(), k = type + ':' + id;
    if (a[k] === backdrop) return;
    a[k] = backdrop;
    const keys = Object.keys(a);
    if (keys.length > 400) keys.slice(0, keys.length - 400).forEach(x => { delete a[x]; });
    clearTimeout(artSaveT);
    artSaveT = setTimeout(() => { try { localStorage.setItem(ART_KEY, JSON.stringify(a)); } catch (e) {} }, 800);
  }
  /** Fetch the backdrops Continue watching is missing, three at a time, and drop each
   *  into its card as it lands. */
  async function artFill(root) {
    const my = routeSeq;
    const need = [].slice.call((root || document).querySelectorAll('.cw-card[data-art-need]')).slice(0, 9);
    let i = 0;
    const worker = async () => {
      while (i < need.length) {
        const card = need[i++];
        const m = /^(movie|tv):(\d+)$/.exec(card.dataset.artNeed || '');
        if (!m) continue;
        try {
          const d = await tmdb('/' + m[1] + '/' + m[2]);
          if (m[1] === 'tv') newEpNote(d);
          artNote(m[1], m[2], d.backdrop_path);
          if (!routeIs(my) || !document.contains(card) || !d.backdrop_path) continue;
          const im = card.querySelector('.cw-img');
          if (im) { im.src = img(d.backdrop_path, 'w780'); card.classList.remove('cw-poster'); }
          card.removeAttribute('data-art-need');
        } catch (e) { /* stays on its poster */ }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  /* ---- Recent searches ---------------------------------------------------------
     Eight of them, newest first, on the empty search page. Local only: what someone
     typed on the TV is not something the phone needs to know. */
  const RECENT_Q_KEY = 'reeldeck.recent-searches.v1';
  function recentQ() {
    try { const a = JSON.parse(localStorage.getItem(RECENT_Q_KEY) || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x) : []; }
    catch (e) { return []; }
  }
  function recentQPush(q) {
    q = (q || '').trim(); if (!q) return;
    const a = recentQ().filter(x => x.toLowerCase() !== q.toLowerCase());
    a.unshift(q);
    try { localStorage.setItem(RECENT_Q_KEY, JSON.stringify(a.slice(0, 8))); } catch (e) {}
  }
  function recentQClear() { try { localStorage.removeItem(RECENT_Q_KEY); } catch (e) {} }

  /* ---- New episodes ------------------------------------------------------------
     "Has something aired that I have not seen?", answered from TMDB's
     last_episode_to_air and cached per show for six hours, so a watchlist of fifty
     series is not fifty requests on every visit. The detail page feeds the cache for
     free, since it fetches the same object anyway. */
  const NEWEP_KEY = 'reeldeck.newep.v1';
  const NEWEP_TTL = 6 * 3600000;
  function newEpAll() {
    try { const o = JSON.parse(localStorage.getItem(NEWEP_KEY) || '{}'); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
    catch (e) { return {}; }
  }
  function newEpSave(o) { try { localStorage.setItem(NEWEP_KEY, JSON.stringify(o)); } catch (e) {} }
  /** Record what a fetched /tv/{id} object says about its latest and next episode. */
  function newEpNote(d) {
    if (!d || !d.id) return;
    const le = d.last_episode_to_air || {}, ne = d.next_episode_to_air || {};
    const all = newEpAll();
    all[d.id] = { s: le.season_number || 0, e: le.episode_number || 0, date: le.air_date || '',
                  next: ne.air_date || '', ns: ne.season_number || 0, ne: ne.episode_number || 0, at: now() };
    // Every series card in view is checked now, so a browsing session touches a few
    // hundred shows; beyond that, drop the stalest.
    const keys = Object.keys(all);
    if (keys.length > 300) keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, keys.length - 300).forEach(k => { delete all[k]; });
    newEpSave(all);
  }
  /**
   * A NEW episode: one that aired in the last fortnight and the viewer has not reached.
   * {s, e, date} or null.
   *
   * "Past your place" alone was the wrong test: a series that ended in 2019 told
   * someone on S1E1 there was a new episode. New means recent. A show you are behind
   * on badges only while the latest one is actually new; a finished show never does.
   */
  function newEpState(id) {
    const c = newEpAll()[id];
    if (!c || !c.s || !c.date) return null;
    const aired = Date.parse(c.date + 'T12:00:00');
    if (!aired || aired > now() + 86400000 || (now() - aired) > 14 * 86400000) return null;
    const last = progShow(id);
    if (last && (c.s * 1000 + c.e) <= ((last.s || 0) * 1000 + (last.e || 0))) return null;   // already seen
    return c;
  }
  /** Fetch what is missing or stale, four at a time. Resolves true if anything changed. */
  async function newEpScan(ids) {
    const cache = newEpAll(), t = now();
    const todo = (ids || []).filter((id, i, a) => a.indexOf(id) === i)
      .filter(id => !(cache[id] && (t - (cache[id].at || 0)) < NEWEP_TTL)).slice(0, 30);
    if (!todo.length) return false;
    let i = 0, changed = false;
    const worker = async () => {
      while (i < todo.length) {
        const id = todo[i++];
        try { newEpNote(await tmdb('/tv/' + id)); changed = true; }
        catch (e) { /* stays unknown; tried again next visit */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return changed;
  }
  function newEpBadgeHTML(id) {
    const st = newEpState(id);
    if (!st) return '';
    return `<span class="newep" title="S${st.s} \u00b7 E${st.e} aired ${esc(shortDate(st.date))}">New<i> episode</i></span>`;
  }
  /**
   * Badge every series card in the document, whichever view put it there.
   *
   * One observer on the view container, debounced: views render after awaits, grids
   * append pages, and a rail arrives when its request lands -- an explicit call from
   * each of those was the kind of list that silently loses an entry. Painting inserts
   * badges, which is itself a mutation; the second pass finds nothing to fetch and
   * stops. The scan is capped per pass (newEpScan), so a long grid fills in over a
   * few sweeps rather than in one burst.
   */
  let newEpSweepT = 0;
  function newEpSweep() {
    clearTimeout(newEpSweepT);
    newEpSweepT = setTimeout(() => {
      newEpPaint();
      const ids = [];
      document.querySelectorAll('.card[data-nav*="/tv/"]').forEach(c => {
        const m = /\/tv\/(\d+)/.exec(c.dataset.nav || '');
        if (m) ids.push(m[1]);
      });
      const my = routeSeq;
      newEpScan(ids).then(ch => { if (ch && routeIs(my)) newEpPaint(); });
    }, 350);
  }
  function newEpWatch() {
    const host = view();
    if (!host || !window.MutationObserver) return;
    new MutationObserver(newEpSweep).observe(host, { childList: true, subtree: true });
  }
  /** Put a badge on every series card on screen that has one coming. Idempotent. */
  function newEpPaint(root) {
    (root || document).querySelectorAll('.card[data-nav*="/tv/"]').forEach(c => {
      const m = /\/tv\/(\d+)/.exec(c.dataset.nav || '');
      const poster = c.querySelector('.poster');
      if (!m || !poster || poster.querySelector('.newep')) return;
      const h = newEpBadgeHTML(m[1]);
      if (!h) return;
      poster.insertAdjacentHTML('beforeend', h);
      // The floating pill and the hover/focus caption both want the poster's bottom-left
      // corner, and the caption's height varies with the title, so no offset is safe.
      // Where a card HAS a caption the pill joins it as its first line instead, and CSS
      // retires the floating copy whenever that caption is showing (.has-capnew).
      const cap = poster.querySelector('.ch-cap');
      if (cap && !cap.querySelector('.ch-new')) {
        cap.insertAdjacentHTML('afterbegin', '<div class="ch-new">New episode</div>');
        c.classList.add('has-capnew');
      }
    });
  }

  /* ---------- Detail (movie & tv) ---------- */
  /* ---- Title pages, fetched ahead --------------------------------------------------
     ONE request instead of six: TMDB folds the sub-resources into the title with
     append_to_response. On a TV's Wi-Fi that is five round trips the page does not wait for,
     and it is where the age rating and the keywords come from, for free. If the combined call
     fails, the bare title is tried, so the page still degrades to "hero and overview".

     It starts BEFORE the title is opened: resting on a card (the TV's focus, a desktop
     pointer) or pressing one (a phone) asks for it, so by the time the page opens it is
     usually here. A few titles, five minutes each, kept apart from tmdbCache: these bodies
     run to hundreds of kilobytes. In-flight requests are shared, never doubled. */
  const titleCache = new Map();
  const TITLE_TTL = 5 * 60000, TITLE_MAX = 6;
  function titleData(type, id) {
    const key = type + ':' + id, hit = titleCache.get(key);
    if (hit && Date.now() - hit.t < TITLE_TTL) return hit.p;
    const extra = 'credits,videos,similar,external_ids,images,keywords,' + (type === 'tv' ? 'content_ratings' : 'release_dates');
    const entry = { t: Date.now(), d: null, p: null };
    entry.p = tmdb('/' + type + '/' + id, { append_to_response: extra, include_image_language: 'en,null' })
      .catch(() => tmdb('/' + type + '/' + id))
      .then((d) => {
        entry.d = d;
        // A film in a collection lists the rest of it: one more (small, cached) request.
        if (type === 'movie' && d.belongs_to_collection && d.belongs_to_collection.id) tmdb('/collection/' + d.belongs_to_collection.id).catch(() => {});
        return d;
      });
    entry.p.catch(() => { if (titleCache.get(key) === entry) titleCache.delete(key); });   // a failure is not kept
    titleCache.set(key, entry);
    while (titleCache.size > TITLE_MAX) titleCache.delete(titleCache.keys().next().value);
    return entry.p;
  }
  /** The title's data if it has already arrived (so the page can paint at once), else null. */
  function titleReady(type, id) {
    const hit = titleCache.get(type + ':' + id);
    return hit && hit.d && Date.now() - hit.t < TITLE_TTL ? hit.d : null;
  }
  // Rest on a card for `ms` (0 = now) and its title page starts loading.
  let titlePrefetchTimer = 0;
  function titlePrefetchFrom(el, ms) {
    clearTimeout(titlePrefetchTimer);
    // A card names its title itself; a hero slide names it on its More Info button.
    const card = el && el.closest ? el.closest('.card, .bb-slide') : null;
    if (!card) return;
    const navEl = card.hasAttribute('data-nav') ? card : card.querySelector('[data-nav^="#/movie/"], [data-nav^="#/tv/"]');
    const m = /^#\/(?:watch\/)?(movie|tv)\/(\d+)/.exec((navEl && navEl.getAttribute('data-nav')) || '');
    if (!m) return;
    const go = () => titleData(m[1], m[2]).catch(() => {});
    if (ms) titlePrefetchTimer = setTimeout(go, ms); else go();
  }

  /**
   * The title page's hero from what the card already knew, painted the moment the title is
   * opened when its data has not arrived yet. Same structure and boxes as the real hero (the
   * title in its fixed-height box, stage.css), so the full page lands over it without moving
   * anything. Needs no network.
   */
  function titlePreviewHTML(type, it) {
    const title = it.title || it.name || '';
    const y = year(it.release_date || it.first_air_date || it.date);
    const rating = it.vote_average ? Number(it.vote_average).toFixed(1) : '';
    const logo = it._logo || null;
    const playBtn = `<button class="btn primary" data-play data-nav="${watchHref(type, it.id)}">${ICON.play} ${watchLabel(type, it.id)}</button>`;
    return `<div class="detail-hero dv-preview">
        <div class="bg" style="background-image:url('${img(it.backdrop_path, 'w1280')}')"></div>
        <div class="scrim"></div>
        <div class="dv-stage">
          <div class="dv-titlebox">${logo ? `<img class="detail-logo" src="${esc(logo)}" alt="${esc(title)}">` : `<h1 class="dv-title">${esc(title)}</h1>`}</div>
          ${IS_TV ? `<div class="dv-facts-line">${[type === 'tv' ? 'Series' : 'Film', y].filter(Boolean).map(esc).join(' · ')}${rating ? ' · <b>★ ' + rating + '</b>' : ''}</div>` : ''}
          ${it.overview ? `<p class="dv-over">${esc(it.overview)}</p>` : ''}
          <div class="metarow">
            <span class="pill rating">${ICON.star}${rating || '—'}</span>
            <span class="pill">${type === 'tv' ? 'Series' : 'Film'}</span>
            ${y ? `<span class="pill">${y}</span>` : ''}
          </div>
          <div class="dv-cta cta">${playBtn}</div>
        </div>
      </div><div class="section">${skeletonGrid(6)}</div>`;
  }

  async function detailView(type, id) {
    const my = routeSeq;
    const isTV = type === 'tv';
    // Already here (fetched while the card was being looked at)? Then the page paints in one go.
    // Otherwise the hero is painted from the card at once, or a skeleton when nothing is known.
    const ready = titleReady(type, id), known = itemCache[ck(type, id)];
    if (!ready) {
      view().innerHTML = (known && known.backdrop_path)
        ? titlePreviewHTML(type, known)
        : `<div class="sk" style="height:480px;border-radius:0;margin:-22px -22px 24px"></div><div class="section">${skeletonGrid(6)}</div>`;
      if (IS_TV && known) stageTitle(type, known);
    }
    try {
      const d = ready || await titleData(type, id);
      const credits = d.credits || {}, videos = d.videos || {}, similar = d.similar || {},
            ext = d.external_ids || {}, imgs = d.images || {};
      itemCache[ck(type, d.id)] = d;
      d._imdb = ext.imdb_id;
      // Age rating: the region's own, else the US one. Films carry one per release type;
      // theatrical (3) or digital (4) is the rating people recognise.
      const cert = (() => {
        const pick = (rows, f) => { const want = [cfg.region, 'US']; for (const c of want) { const r = (rows || []).find(x => x.iso_3166_1 === c); const v = r && f(r); if (v) return v; } return ''; };
        return isTV
          ? pick(d.content_ratings && d.content_ratings.results, r => r.rating)
          : pick(d.release_dates && d.release_dates.results, r => { const rd = (r.release_dates || []).filter(x => x.certification); const best = rd.find(x => x.type === 3) || rd.find(x => x.type === 4) || rd[0]; return best && best.certification; });
      })();
      // Keywords are crowd-tagged and noisy (Dune is tagged "sand"), so: a handful, no more.
      const kws = ((d.keywords && (d.keywords.keywords || d.keywords.results)) || []).slice(0, 6);
      // A film that belongs to a collection lists the rest of it. One more request, only
      // for those films -- and the reason nobody loses track of a sequel.
      const coll = (!isTV && d.belongs_to_collection && d.belongs_to_collection.id)
        ? await tmdb('/collection/' + d.belongs_to_collection.id).catch(() => null) : null;
      if (isTV) newEpNote(d);           // the badge cache gets this for free
      const nextEp = (isTV && d.next_episode_to_air && d.next_episode_to_air.air_date) ? d.next_episode_to_air : null;
      const lastEp = (isTV && d.last_episode_to_air && d.last_episode_to_air.air_date) ? d.last_episode_to_air : null;
      const epLbl = (ep) => 'S' + ep.season_number + ' \u00b7 E' + ep.episode_number + ' \u00b7 ' + shortDate(ep.air_date);
      const title = d.title || d.name;
      const y = year(d.release_date || d.first_air_date);
      const _logos = (imgs.logos || []).filter(l => l.file_path && (l.iso_639_1 === 'en' || l.iso_639_1 === null)).sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
      const logoUrl = _logos[0] ? img(_logos[0].file_path, 'w500') : null;
      // Its box is known before it loads, so a scroll restored on Back is applied to the final layout.
      const logoAR = (_logos[0] && _logos[0].aspect_ratio > 0) ? (+_logos[0].aspect_ratio).toFixed(4) : '';
      const gEls = (d.genres || []).map(g => `<button class="chip" data-nav="#/${isTV ? 'tv' : 'movies'}?genres=${g.id}">${esc(g.name)}</button>`).join('');
      // Links, not names: a director's page is a filmography now (see personView).
      const who = (list) => list.map(c => `<a class="who" href="#/person/${c.id}" data-nav="#/person/${c.id}">${esc(c.name)}</a>`).join(', ');
      const director = who((credits.crew || []).filter(c => c.job === 'Director' && c.id).slice(0, 3));
      const creators = who((d.created_by || []).filter(c => c.id).slice(0, 3));
      const trailer = (videos.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                      (videos.results || []).find(v => v.site === 'YouTube');
      const runtime = isTV
        ? ((d.number_of_seasons || 0) + ' season' + (d.number_of_seasons === 1 ? '' : 's'))
        : runtimeStr(d.runtime);
      const on = isInWatch(d.id, type);
      const hasProgress = hasAnyProgress(type, d.id);
      // The title's actions, built once: the desktop and phone button row shows them all,
      // the TV row shows Play and puts the rest in the More sheet.
      const playBtn = `<button class="btn primary" data-play data-nav="${watchHref(type, d.id)}">${ICON.play} ${watchLabel(type, d.id)}</button>`;
      const restartBtn = hasProgress ? `<button class="btn glass" data-play data-nav="${restartHref(type, d.id)}" title="Start from the beginning">${ICON.restart} Restart</button>` : '';
      const trailerBtn = trailer ? `<button class="btn glass" data-trailer="${trailer.key}">${ICON.film} Trailer</button>` : '';
      const wlBtn = `<button class="btn ${on ? 'primary' : 'glass'}" data-wl="${d.id}" data-type="${type}" id="detail-wl">
              ${on ? ICON.bookmarkFill : ICON.bookmark} ${on ? 'In watchlist' : 'Watchlist'}
            </button>`;
      const markBtn = !isTV ? `<button class="btn glass" data-mark="movie:${d.id}" data-d="${60 * (d.runtime || 0)}"
              data-title="${esc(title)}" data-poster="${esc(d.poster_path || '')}" aria-pressed="${progDone(progGet('movie', d.id))}"
              title="${progDone(progGet('movie', d.id)) ? 'Mark unwatched' : 'Mark watched'}">${
              ICON.check + (progDone(progGet('movie', d.id)) ? ' Watched' : ' Mark watched')}</button>` : '';

      let html = `<div class="detail-hero">
        <div class="bg" style="background-image:url('${img(d.backdrop_path, 'w1280')}')"></div>
        <div class="scrim"></div>
        <div class="dv-stage">
          <div class="dv-titlebox">${logoUrl
            ? `<img class="detail-logo"${logoAR ? ` style="--ar:${logoAR}"` : ''} src="${logoUrl}" alt="${esc(title)}" onerror="this.style.display='none';var h=this.nextElementSibling;if(h)h.style.display='block'"><h1 class="dv-title" style="display:none">${esc(title)}</h1>`
            : `<h1 class="dv-title">${esc(title)}</h1>`}</div>
          ${!IS_TV && d.overview ? `<p class="dv-over">${esc(d.overview)}</p>` : ''}
          ${IS_TV ? `<div class="dv-facts-line">${[isTV ? 'Series' : 'Film', y, runtime, cert].filter(Boolean).map(esc).join(' · ')}${
              d.vote_average ? ' · <b>★ ' + d.vote_average.toFixed(1) + '</b>' : ''}${
              nextEp ? ' · <span class="dv-next">Next ' + esc(epLbl(nextEp)) + '</span>' : ''}</div>
            <p class="dv-over">${esc(d.overview || '')}</p>` : ''}
          <div class="metarow">
            <span class="pill rating">${ICON.star}${d.vote_average ? d.vote_average.toFixed(1) : '\u2014'}</span>
            <span class="pill">${isTV ? 'Series' : 'Film'}</span>
            ${y ? `<span class="pill">${y}</span>` : ''}
            ${runtime ? `<span class="pill">${esc(runtime)}</span>` : ''}
            ${cert ? `<span class="pill cert" title="Age rating">${esc(cert)}</span>` : ''}
            ${d.status ? `<span class="pill">${esc(d.status)}</span>` : ''}
            ${nextEp ? `<span class="pill next-ep">${ICON.tv} Next ${esc(epLbl(nextEp))}</span>` : ''}
          </div>
          ${IS_TV
            // TV: three actions. Everything else waits behind More (openTitleMore).
            ? `<div class="dv-cta cta">${playBtn}
                <button class="btn glass" id="dv-down">${isTV ? 'Episodes' : 'More like this'}</button>
                <button class="btn glass" id="dv-more">More</button></div>`
            : `<div class="dv-cta cta">${playBtn}${restartBtn}${trailerBtn}${wlBtn}${markBtn}</div>`}
        </div>
      </div>`;

      // Cast is built BEFORE the body so it can sit inside the prose column. As its
      // own full-width section further down it left a large dead area beside the
      // overview, which is the emptiest part of the page and the obvious home for it.
      const cast = (credits.cast || []).slice(0, 14);
      const castBlock = cast.length ? `
        <h3 class="dv-sub">Cast</h3>
        <div class="rail-wrap">
          <button class="rail-arrow left" data-rail="-1" tabindex="-1" aria-label="Scroll cast left">${ICON.back}</button>
          <div class="cast-track">
          ${cast.map(c => `<div class="person" data-nav="#/person/${c.id}" tabindex="0" role="button" aria-label="${esc(c.name)}${c.character ? ' as ' + esc(c.character) : ''}">
            <img loading="lazy" decoding="async" src="${img(c.profile_path, 'w185')}" alt="" onerror="this.src='${PLACEHOLDER}'">
            <div class="n">${esc(c.name)}</div><div class="c">${esc(c.character || '')}</div>
          </div>`).join('')}
          </div>
          <button class="rail-arrow right" data-rail="1" tabindex="-1" aria-label="Scroll cast right">${ICON.chevR}</button>
        </div>` : '';

      const factsDl = `<dl>
            <dt>Rating</dt><dd class="dv-rate">${ICON.star}${d.vote_average ? d.vote_average.toFixed(1) : '—'}${d.vote_count ? ` <span class="muted">(${d.vote_count.toLocaleString()})</span>` : ''}</dd>
            ${director ? `<dt>Director</dt><dd>${director}</dd>` : ''}
            ${creators ? `<dt>Created by</dt><dd>${creators}</dd>` : ''}
            ${runtime ? `<dt>${isTV ? 'Length' : 'Runtime'}</dt><dd>${esc(runtime)}</dd>` : ''}
            ${d.status ? `<dt>Status</dt><dd>${esc(d.status)}</dd>` : ''}
            ${(d.release_date || d.first_air_date) ? `<dt>Released</dt><dd>${esc(d.release_date || d.first_air_date)}</dd>` : ''}
            ${lastEp ? `<dt>Latest episode</dt><dd>${esc(epLbl(lastEp))}</dd>` : ''}
            ${nextEp ? `<dt>Next episode</dt><dd>${esc(epLbl(nextEp))}</dd>` : ''}
          </dl>`;

      // Body: prose on the left at a readable measure, reference material on the
      // right. The poster lives here now -- useful for recognition, but no longer
      // covering a quarter of the artwork it was pasted on top of.
      // data-panel: which of the desktop title tabs each block belongs to (wireTitleTabs).
      html += `<div class="dv-body dv-panel" data-panel="info">
        <div class="dv-main">
          ${d.tagline && !IS_TV ? `<p class="dv-tagline">${esc(d.tagline)}</p>` : ''}
          <h3>Overview</h3>
          <p class="overview">${esc(d.overview || 'No overview available.')}</p>
          <div class="genre-row">${gEls}</div>
          ${kws.length ? `<div class="kw-row" aria-label="Themes">${kws.map(k =>
            `<button class="chip kw" data-nav="#/${isTV ? 'tv' : 'movies'}?kw=${k.id}&kwn=${encodeURIComponent(k.name)}">${esc(k.name)}</button>`).join('')}</div>` : ''}
          ${castBlock}
        </div>
        <aside class="dv-facts">
          <img class="dv-poster" src="${img(d.poster_path, 'w500')}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">
          ${factsDl}
        </aside>
      </div>`;

      // TV seasons
      if (isTV) {
        const seasons = (d.seasons || []).filter(s => s.season_number >= 1);
        html += `<div class="section dv-panel" data-panel="eps" id="seasons">
          <div class="season-head"><h3>Episodes</h3>
            <button class="btn sm ghost" id="season-mark" hidden aria-pressed="false">Mark season watched</button></div>
          <div class="rail-wrap season-wrap">
          <button class="rail-arrow left" data-rail="-1" tabindex="-1" aria-label="Scroll seasons left">${ICON.back}</button>
          <button class="rail-arrow right" data-rail="1" tabindex="-1" aria-label="Scroll seasons right">${ICON.chevR}</button>
          <div class="season-pills" id="season-pills" role="group" aria-label="Choose a season">
            ${seasons.map(x => `<button class="spill" aria-pressed="false" data-season="${x.season_number}">
                <span class="sp-n">Season ${x.season_number}</span>${x.episode_count ? `<span class="sp-c">${x.episode_count} eps</span>` : ''}
              </button>`).join('')}
          </div>
          </div>
          <div class="ep-list" id="ep-list"></div>
        </div>`;
      }


      // The collection, in release order, with the film you are looking at included so
      // its place in the sequence is visible.
      if (coll && Array.isArray(coll.parts)) {
        const parts = coll.parts.filter(x => x.poster_path)
          .sort((a, b) => String(a.release_date || '9999').localeCompare(String(b.release_date || '9999')));
        if (parts.length > 1) html += `<div class="section dv-panel" data-panel="more">${railHTML(coll.name || 'Collection', parts, null, 'movie')}</div>`;
      }

      // Similar
      const sim = (similar.results || []).filter(x => x.poster_path && viewable(x)).slice(0, 14);
      if (sim.length) html += `<div class="section dv-panel" data-panel="more">${railHTML(isTV ? 'Similar shows' : 'Similar movies', sim, null, type)}</div>`;

      if (!routeIs(my)) return;   // stale response — the user is on another page now
      // The preview's Play may hold the ring (or keyboard focus); it is about to be replaced.
      const hadFocus = !ready && view().contains(document.activeElement);
      view().innerHTML = html;
      if (!IS_TV) { wireTitleTabs(); wireTitleDock(); }
      if (hadFocus) {
        if (IS_TV) tvFocusFirst();
        else { const p = view().querySelector('.dv-cta .btn.primary'); if (p) try { p.focus({ preventScroll: true }); } catch (e) {} }
      }
      jumpTop();
      ambientFrom(d.poster_path);
      artNote(type, d.id, d.backdrop_path);

      if (IS_TV) {
        // The Stage stays up behind the title: arriving from a focused card on Home, the
        // backdrop is already this one, so the page reads as that card opening in place.
        stageTitle(type, d);
        const dn = $('#dv-down');
        if (dn) dn.onclick = () => {
          // The episode you are up to, when the list is showing its season; else the first.
          const ls = isTV ? progShow(id) : null;
          const t = isTV ? ((ls && $(`#ep-list .ep[data-nav$="?s=${ls.s}&e=${ls.e}"]`)) || $('#ep-list .ep') || $('#season-pills .spill.on'))
                         : view().querySelector('.section .rail .card');
          if (t) tvFocusEl(t); else toast(isTV ? 'No episodes listed yet' : 'Nothing similar listed');
        };
        const mo = $('#dv-more');
        if (mo) mo.onclick = () => {
          const back = document.createElement('div');
          back.className = 'modal-back sheet-back title-more-back';
          back.innerHTML = `<div class="modal sheet title-more">
            <div class="mh"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">${ICON.x}</button></div>
            <div class="mb">
              <div class="tm-acts">${restartBtn}${trailerBtn}${wlBtn}${markBtn}</div>
              ${castBlock ? `<section class="tm-sec">${castBlock}</section>` : ''}
              <section class="tm-sec"><h3 class="dv-sub">Details</h3>${factsDl}</section>
              ${gEls ? `<section class="tm-sec"><h3 class="dv-sub">Genres</h3><div class="genre-row">${gEls}</div></section>` : ''}
            </div></div>`;
          modalMount(back);
        };
      }

      // Wire seasons
      if (isTV) {
        const pills = $('#season-pills');
        // Season changes are not cancellable, so without a sequence number whichever
        // response lands LAST wins — pick S1, S2, S3 quickly and a slow S2 can end up
        // rendered under a select reading "Season 3", with every episode link pointing
        // at the wrong season.
        let seasonSeq = 0;
        let curSeason = { n: 0, s: null };
        // Painting is separate from loading so a mark can repaint from the season data
        // already in hand instead of asking TMDB for it again.
        const paintEps = (n, s) => {
          const box = $('#ep-list'); if (!box) return;
          const eps = s.episodes || [];
          box.innerHTML = eps.map(ep => {
            const pr = progGet('tv', id, n, ep.episode_number);
            const done = progDone(pr);
            const part = !!(pr && !done && pr.pct > 0.01);
            return `
            <div class="ep${done ? ' watched' : ''}" data-play data-nav="#/watch/tv/${id}?s=${n}&e=${ep.episode_number}" tabindex="0" role="button"
                 aria-label="${done ? 'Rewatch' : part ? 'Resume' : 'Play'} season ${n} episode ${ep.episode_number}${ep.name ? ', ' + esc(ep.name) : ''}">
              <div class="ep-thumb">
                <img class="thumb" alt="" loading="lazy" decoding="async" src="${img(ep.still_path, 'w300')}" onerror="this.src='${PLACEHOLDER}'">
                ${(pr && pr.pct > 0.01) ? `<span class="ep-fill" style="width:${Math.round(Math.min(1, pr.pct) * 100)}%"></span>` : ''}
                ${done ? `<span class="ep-tick" aria-hidden="true">${ICON.check}</span>` : ''}
              </div>
              <div class="ep-body">
                <div class="en">S${n} · E${ep.episode_number}${ep.runtime ? ' · ' + ep.runtime + 'm' : ''}</div>
                <div class="et">${esc(ep.name || 'Episode ' + ep.episode_number)}</div>
                <div class="eo">${esc(ep.overview || '')}</div>
                ${progBar(pr)}
              </div>
              ${IS_TV ? '' : `<button class="ep-mark" data-mark="tv:${id}:${n}:${ep.episode_number}" data-d="${60 * (ep.runtime || 0)}"
                data-title="${esc(title)}" data-poster="${esc(d.poster_path || '')}" tabindex="-1" aria-pressed="${done}"
                title="${done ? 'Mark unwatched' : 'Mark watched'}" aria-label="${done ? 'Mark unwatched' : 'Mark watched'}">${ICON.check}</button>`}
            </div>`;
          }).join('') || '<div class="center-note">No episode data.</div>';
          // The season button describes the season: every episode seen -> offer to unmark.
          const sm = $('#season-mark');
          if (sm) {
            const allDone = eps.length > 0 && eps.every(ep => progDone(progGet('tv', id, n, ep.episode_number)));
            sm.hidden = !eps.length;
            sm.dataset.n = n;
            sm.textContent = allDone ? 'Unmark season ' + n : 'Mark season ' + n + ' watched';
            sm.setAttribute('aria-pressed', String(allDone));
          }
          // The row model caches; replacing every episode under it would otherwise
          // leave the D-pad navigating the season that just went away.
          if (IS_TV) tvInvalidate();
        };
        const loadSeason = async (n) => {
          const mine = ++seasonSeq, myRoute = routeSeq;
          const box = $('#ep-list'); if (!box) return;
          box.innerHTML = skeletonGrid(4);
          try {
            const s = await tmdb('/tv/' + id + '/season/' + n);
            if (mine !== seasonSeq || !routeIs(myRoute) || !document.contains(box)) return;
            curSeason = { n: +n, s: s };
            paintEps(+n, s);
          } catch (e) {
            if (mine !== seasonSeq || !routeIs(myRoute) || !document.contains(box)) return;
            box.innerHTML = ''; errorState(e, '#ep-list');
          }
        };
        // One press for a season watched somewhere else. Quiet marks: ten history rows
        // stamped in the same second would bury the log, and the ticks already say it.
        const smBtn = $('#season-mark');
        if (smBtn) smBtn.onclick = () => {
          const n = curSeason.n, s = curSeason.s;
          const eps = (s && s.episodes) || [];
          if (!n || !eps.length) return;
          const allDone = eps.every(ep => progDone(progGet('tv', id, n, ep.episode_number)));
          if (allDone) eps.forEach(ep => progForget(progKey('tv', id, n, ep.episode_number)));
          else eps.forEach(ep => progMarkWatched({ type: 'tv', id: id, season: n, episode: ep.episode_number,
                                                   title: title, poster_path: d.poster_path, d: 60 * (ep.runtime || 0), quiet: true }));
          toast('Season ' + n + (allDone ? ' marked unwatched' : ' marked watched'));
          paintEps(n, s);
          if (IS_TV) tvFocusEl(smBtn);
        };
        const markPill = (n, byUser) => {
          if (!pills) return;
          pills.querySelectorAll('.spill').forEach(b => {
            const on = (+b.dataset.season === +n);
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', String(on));
            if (on) centreIn(pills, b, byUser);      // the rail only -- never the page (see centreIn)
          });
        };
        if (pills) pills.onclick = (e2) => {
          const b = e2.target.closest('.spill'); if (!b) return;
          markPill(b.dataset.season, true); loadSeason(b.dataset.season);
        };
        // Open on the season you were last watching, not always season 1.
        // Recomputed from `d`, NOT read from the `seasons` const above: that one is
        // block-scoped to the markup builder, and the bare name `seasons` resolves
        // instead to window.seasons -- the <div id="seasons"> -- whose .map is not a
        // function. Named access on window is a trap for any id used as a variable.
        const nums = (d.seasons || []).filter(x => x.season_number >= 1).map(x => x.season_number);
        const lastSeen = progShow(id);
        const startSeason = (lastSeen && nums.indexOf(lastSeen.s) >= 0) ? lastSeen.s : nums[0];
        // A specials-only show has no regular seasons at all; requesting season 1 then
        // renders a raw TMDB 404 under the "Episodes" heading.
        if (nums.length) { markPill(startSeason); loadSeason(startSeason); }
        else $('#ep-list').innerHTML = '<div class="center-note">No regular seasons listed for this title.</div>';
      }
    } catch (e) { if (routeIs(my)) errorState(e); }
  }

  /* ---------- Person ---------- */
  async function personView(id) {
    const my = routeSeq;
    view().innerHTML = skeletonGrid(10);
    try {
      const [p, credits] = await Promise.all([
        tmdb('/person/' + id),
        tmdb('/person/' + id + '/combined_credits')
      ]);
      if (!routeIs(my)) return;
      // Cast AND crew. Reading only `cast` made a director's page a list of talk-show
      // appearances. Crew is grouped by the jobs people actually browse by; each title once
      // per group, best-known first. The group matching what they are known FOR leads.
      const tidy = (rows) => {
        const seen = Object.create(null);
        return rows.filter(c => c.poster_path && viewable(c))
          .filter(c => { const k = c.media_type + ':' + c.id; if (seen[k]) return false; seen[k] = 1; return true; })
          .sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 24);
      };
      const crew = credits.crew || [];
      const groups = [
        { dept: 'Acting', title: 'Acting', rows: tidy(credits.cast || []) },
        { dept: 'Directing', title: 'Directing', rows: tidy(crew.filter(c => c.job === 'Director')) },
        { dept: 'Writing', title: 'Writing', rows: tidy(crew.filter(c => /^(Screenplay|Writer|Story|Novel)$/.test(c.job || ''))) },
        // "Created" means Creator. Executive producers were in here too, which credited Jennifer
        // Aniston with creating The Morning Show. They get their own heading -- without one, a
        // producer's page (Feige, Kennedy, Bruckheimer) is nothing but talk-show appearances.
        { dept: 'Creator', title: 'Created', rows: tidy(crew.filter(c => c.job === 'Creator' && c.media_type === 'tv')) },
        { dept: 'Production', title: 'Produced', rows: tidy(crew.filter(c => /^(Producer|Executive Producer)$/.test(c.job || ''))) }
      ].filter(g => g.rows.length);
      groups.sort((a, b) => (b.dept === p.known_for_department) - (a.dept === p.known_for_department));
      const known = groups.length ? groups[0].rows : [];
      view().innerHTML = `
        <div class="detail-body person-head" style="padding-top:8px">
          <div class="poster" style="width:180px"><img src="${img(p.profile_path, 'w342')}" onerror="this.src='${PLACEHOLDER}'"></div>
          <div class="info">
            <h1>${esc(p.name)}</h1>
            <div class="metarow">${p.known_for_department ? `<span class="pill">${esc(p.known_for_department)}</span>` : ''}
              ${p.birthday ? `<span class="pill">Born ${esc(p.birthday)}</span>` : ''}
              ${p.place_of_birth ? `<span class="pill">${esc(p.place_of_birth)}</span>` : ''}</div>
            <p class="overview" style="margin-top:12px">${esc((p.biography || '').slice(0, 600) || 'No biography.')}${p.biography && p.biography.length > 600 ? '…' : ''}</p>
          </div>
        </div>
        ${groups.length
          ? groups.map((g, i) => `<div class="section"><h3>${i === 0 ? 'Known for' + (groups.length > 1 ? ' \u00b7 ' + esc(g.title.toLowerCase()) : '') : esc(g.title)}</h3>
              <div class="grid">${g.rows.map(c => cardHTML(c, c.media_type, true)).join('')}</div></div>`).join('')
          : '<div class="center-note">No credits to show for this person.</div>'}`;
      jumpTop();
      if (IS_TV) tvInvalidate();
    } catch (e) { if (routeIs(my)) errorState(e); }
  }

  /**
   * One episode strip, reused by the first render and by every season swap. `playing`
   * is the episode number to mark as current, or -1 when the strip is showing a
   * season other than the one on screen -- nothing is "now playing" over there.
   */
  function epTiles(id, seasonNum, episodes, playing) {
    return (episodes || []).map(ep => {
      const pr = progGet('tv', id, seasonNum, ep.episode_number);
      const done = progDone(pr);
      const cur = ep.episode_number === playing;
      const pct = (pr && pr.pct > 0.01) ? Math.round(Math.min(1, pr.pct) * 100) : 0;
      return `<button class="epx${cur ? ' on' : ''}${done ? ' watched' : ''}"
              data-nav="#/watch/tv/${id}?s=${seasonNum}&e=${ep.episode_number}"
              aria-current="${cur}"
              aria-label="${cur ? 'Now playing: ' : ''}Season ${seasonNum} episode ${ep.episode_number}${ep.name ? ', ' + esc(ep.name) : ''}${done ? ', watched' : ''}">
        <span class="epx-thumb">
          <img loading="lazy" decoding="async" alt="" src="${img(ep.still_path, 'w300')}" onerror="this.src='${PLACEHOLDER}'">
          ${pct ? `<span class="ep-fill" style="width:${pct}%"></span>` : ''}
          ${done ? `<span class="ep-tick">${ICON.check}</span>` : ''}
          ${cur ? `<span class="epx-now">${ICON.play} Playing</span>` : ''}
        </span>
        <span class="epx-n">E${ep.episode_number}</span>
        <span class="epx-t">${esc(ep.name || '')}</span>
      </button>`;
    }).join('');
  }

  /* ---- Export / import ----------------------------------------------------------
     A backup that is yours, and a way into a fresh install without an account. */
  function exportBlob() {
    return { app: 'reeldeck', v: 1, at: now(), theme: cfg.theme,
             watch: getWatch(), prog: progAll(), hist: histAll() };
  }
  async function exportData() {
    const text = JSON.stringify(exportBlob());
    const name = 'reeldeck-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    // A file where a file can be saved. The APK and the desktop app both refuse
    // downloads outright (the same setting that stops a mirror dropping an installer),
    // so there the text goes to the clipboard and a note or a message is the file.
    if (!IS_NATIVE && !IS_DESKTOP) {
      try {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 4000);
        toast('Saved ' + name);
        return;
      } catch (e) { /* fall through to the clipboard */ }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to the clipboard \u2014 paste it into a note or a file to keep it');
    } catch (e) {
      toast('Could not copy \u2014 the web app can save it as a file');
    }
  }
  async function importFile(file) {
    let obj = null;
    try { obj = JSON.parse(await file.text()); } catch (e) {}
    if (!obj || obj.app !== 'reeldeck') { toast('That is not a Reeldeck backup'); return; }
    const n = importBlob(obj);
    toast('Imported \u2014 ' + n.watch + ' saved, ' + n.hist + ' history, ' + n.prog + ' positions added');
    syncFlush('import');
    route();
  }
  /** Union with what is here. The newest stamp wins a conflict; nothing local goes. */
  function importBlob(obj) {
    const t = now();
    // Same validation the sync path applies to a blob off the network: this file is
    // just as untrusted.
    const R = sanitize({ watch: obj.watch, prog: obj.prog, hist: obj.hist, tomb: {},
                         clearedAt: { prog: 0, hist: 0 }, theme: { id: '', at: 0 } }, t + FUTURE_SLACK, t);
    const wl = {};
    getWatch().forEach(e => { wl['w:' + e.type + ':' + e.id] = e; });
    let nw = 0;
    R.watch.forEach(e => {
      const k = 'w:' + e.type + ':' + e.id;
      if (!wl[k]) nw++;
      if (!wl[k] || (e.at || 0) > (wl[k].at || 0)) wl[k] = e;
    });
    setWatch(Object.keys(wl).map(k => wl[k]).sort((a, b) => (b.at || 0) - (a.at || 0)));
    const p = progAll(); let np = 0;
    for (const k in R.prog) { if (!p[k]) np++; p[k] = pickProg(p[k], R.prog[k]); }
    progSave(p);
    const hm = {};
    histAll().forEach(r => { hm[r.k] = r; });
    let nh = 0;
    R.hist.forEach(r => { if (!hm[r.k]) nh++; hm[r.k] = pickHist(hm[r.k], r); });
    histSave(Object.keys(hm).map(k => hm[k]).sort((a, b) => (b.at || 0) - (a.at || 0)));
    return { watch: nw, prog: np, hist: nh };
  }

  /* ---------- Player ---------- */
  async function watchView(type, id, params, resume) {
    const my = routeSeq;
    // A TV left on for an evening would otherwise judge mirrors by the boot-time verdict.
    // The answer lands while the poster is up; refreshSources redraws only if it changed.
    if (Date.now() - healthFetchedAt > 10 * 60000) refreshSources().catch(() => {});
    const isTV = type === 'tv';
    // A non-numeric ?e= used to yield NaN: Prev stayed enabled, the header printed
    // "S1 · ENaN", and buildSourceUrl's `episode || 1` quietly played episode 1.
    const season = Math.max(1, parseInt(params.s, 10) || 1);
    const episode = Math.max(1, parseInt(params.e, 10) || 1);
    view().innerHTML = `<div class="player-shell"><div class="sk" style="height:60vh;border-radius:16px"></div></div>`;

    let d = itemCache[ck(type, id)];
    let imdb = d && d._imdb;
    try {
      if (!d || d._imdb === undefined) {
        const [det, ext] = await Promise.all([
          tmdb('/' + type + '/' + id),
          tmdb('/' + type + '/' + id + '/external_ids').catch(() => ({}))
        ]);
        d = det; d._imdb = ext.imdb_id; imdb = ext.imdb_id; itemCache[ck(type, id)] = d;
      }
    } catch (e) { /* still render shell */ d = d || { id }; }
    // Left while this was loading? Then nothing below may run: it would mount the player
    // over the next page, light the room for the wrong title, and write that title into
    // progress and history.
    if (!routeIs(my)) return;

    const title = (d && (d.title || d.name)) || 'Title';
    const sources = cfg.sources || [];
    // The viewer's mirror is remembered by NAME (cfg.activeName). The index alone moved under them
    // whenever the table gained or lost a row, silently switching their mirror; it is now derived.
    let ai = cfg.activeName ? sources.findIndex(s => s.name === cfg.activeName) : -1;
    if (ai < 0) ai = cfg.activeSource < sources.length ? cfg.activeSource : 0;
    cfg.activeSource = ai;
    if (!cfg.activeName && sources[ai]) cfg.activeName = sources[ai].name;
    // Start on a mirror that is answering. Only when one is: if the Worker says EVERY mirror is
    // down, its own network is the likelier fault, so nothing is hidden at all.
    const upIdx = sources.map((s, i) => i).filter(i => !isDown(sources[i].name));
    const healthOn = upIdx.length > 0 && upIdx.length < sources.length;
    // Unless the viewer picked that offline mirror themselves this session: it may well work from here.
    const cur0 = (sources[cfg.activeSource] || {}).name;
    // For THIS visit only: activeName keeps the viewer's choice, so it comes back once it answers.
    if (healthOn && isDown(cur0) && cur0 !== downPicked) cfg.activeSource = upIdx[0];
    const src = sources[cfg.activeSource];

    // The season's episode list: the NAME of what is playing (the header only ever
    // said "S2 E5", which tells you nothing about which episode you are on), and the
    // strip below the player. Cached per season, so stepping through episodes with
    // Next does not refetch the same list every time.
    let seasonData = null;
    if (isTV) {
      const sk = 'season:' + id + ':' + season;
      seasonData = itemCache[sk] || null;
      if (!seasonData) {
        try { seasonData = await tmdb('/tv/' + id + '/season/' + season); itemCache[sk] = seasonData; }
        catch (e) { seasonData = null; }   // header degrades to S/E, strip is omitted
      }
      if (!routeIs(my)) return;
    }
    const seasonEps = (seasonData && seasonData.episodes) || [];
    const epMeta = seasonEps.find(x => x.episode_number === episode) || null;
    const nextEpMeta = seasonEps.find(x => x.episode_number === episode + 1) || null;

    // Episode bounds. TMDB tells us how many episodes each season actually has, so a
    // Next button running off the end -- or a hand-typed ?s=/?e= -- is answerable
    // instead of framing a mirror for an episode that was never made.
    const seasonList = (isTV && d && Array.isArray(d.seasons))
      ? d.seasons.filter(x => x.season_number >= 1) : [];
    const seasonMeta = seasonList.find(x => x.season_number === season) || null;
    const epCount = seasonMeta ? (seasonMeta.episode_count || 0) : 0;
    const prevSeason = isTV ? seasonList.find(x => x.season_number === season - 1) : null;
    const nextSeason = isTV ? seasonList.find(x => x.season_number === season + 1) : null;
    // Only claim something is missing when TMDB actually described the shape; a failed
    // detail fetch must not turn a working episode into an error page.
    const missing = isTV && seasonList.length > 0 && (!seasonMeta || (epCount > 0 && episode > epCount));
    const hasNextEp = isTV && (epCount ? episode < epCount : true);

    // Where to reopen the mirror. Declared at FUNCTION scope, not inside the branch
    // that builds the frame: switchTo() below reads it when the viewer changes mirror
    // mid-episode, and a block-scoped const left that throwing ReferenceError.
    // Only a position a MIRROR reported is used to seek -- the wall-clock estimate is
    // good enough to draw a bar with, but would drop the viewer at the wrong moment.
    const seen = progGet(type, id, isTV ? season : null, isTV ? episode : null);
    // ?restart=1 is an explicit "start over": ignore the saved position for THIS
    // load without discarding it, so backing out still leaves the resume point.
    const resumeAt = (params.restart || !seen || progDone(seen)) ? 0
      : seen.src === 'provider' ? (seen.t || 0) : (seen.seek || 0);   // .seek: see progRecord

    // Poster first, player on Play. Skipped when the player was already started on this stay
    // (episode hops, a re-render) or when "next episode" is carrying the viewer through.
    const armed = watchArm; watchArm = false;            // this visit came from a title's Play
    const gated = !missing && !!src && !watchLive && !resume && !armed;
    let frameInner, frameHTML = null;
    if (missing) {
      frameInner = `<div class="player-empty"><div class="box">
        <h3>That episode doesn\u2019t exist</h3>
        <p>${seasonMeta
            ? esc(title) + ' season ' + season + ' has ' + epCount + ' episode' + (epCount === 1 ? '' : 's') + ', so there is no episode ' + episode + '.'
            : esc(title) + ' has no season ' + season + '.'}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">
          ${seasonMeta && epCount ? `<button class="btn primary" data-nav="#/watch/tv/${id}?s=${season}&e=${epCount}">Play S${season} \u00b7 E${epCount}</button>` : ''}
          <button class="btn" data-nav="#/tv/${id}">All episodes</button>
        </div>
      </div></div>`;
    } else if (!src) {
      frameInner = `<div class="player-empty"><div class="box">
        <h3>No playback source configured</h3>
        <p>Add a source in <b>Settings → Playback sources</b>, or paste a URL template below.
           Placeholders: <code>{id}</code> <code>{imdb}</code> <code>{season}</code> <code>{episode}</code></p>
        <input id="quick-src" placeholder="${isTV ? 'https://host/embed/tv/{id}/{season}/{episode}' : 'https://host/embed/movie/{id}'}">
        <button class="btn primary" id="quick-add">Save source &amp; play</button>
      </div></div>`;
    } else {
      // A function because the frame may be built later, on Play, and for whichever mirror is
      // selected by then (the server room works while the poster is up).
      frameHTML = (s) => {
      const url = buildSourceUrl(s, type, id, imdb, season, episode, resumeAt);
      // In a browser the frame is ALWAYS sandboxed, and `allow-downloads` is never in
      // the list -- so an embed cannot start a download whatever else is switched on.
      // A native host blocks downloads itself (Electron cancels 'will-download';
      // MainActivity installs a DownloadListener that does nothing), so it is left
      // unsandboxed rather than risking a mirror that refuses to run in one.
      //
      // The pop-up guard decides one thing: allow-popups. Off, a player may open a window --
      // and that window inherits THIS sandbox: no downloads, no escaping it, no navigating
      // our page, no dialogs. The two tokens that used to come with it are gone for good:
      //   allow-popups-to-escape-sandbox  made every ad pop-up an ordinary, unsandboxed tab,
      //                                   free to download and offer installers
      //   allow-top-navigation            let a frame replace our page with an ad
      // Also never granted: allow-modals (alert/confirm -- the "your PC is infected" scam),
      // allow-downloads, allow-top-navigation-to-custom-protocols (links that make the OS
      // open another program). Everything a player legitimately needs is granted either way.
      const BASE_SB = 'allow-same-origin allow-scripts allow-forms allow-presentation ' +
                      'allow-orientation-lock allow-pointer-lock';
      const POPUP_SB = ' allow-popups';
      const sandbox = HOST_BLOCKS_POPUPS
        ? ''                                            // host-level blocking instead
        : 'sandbox="' + BASE_SB + (playerGuardOn() ? '' : POPUP_SB) + '"';
      // NO `fullscreen` in the allow list, deliberately. Fullscreen inside a
      // cross-origin frame is gated by Permissions Policy, whose default allowlist is
      // `self`, so omitting the token leaves document.fullscreenEnabled false inside the
      // embed and its own full-screen control cannot fire. Measured: with the token the
      // frame reports true, without it false, and with no allow attribute at all false.
      //
      // This is a fix, not a restriction. A player that enters NATIVE fullscreen is
      // promoted to the browser's top layer, where nothing outside its subtree paints --
      // that is what hid the next-episode pill, the D-pad pointer and every toast. It
      // also hands the video to the system player, which drops the DOM-drawn subtitles
      // the mirrors render, which is why they vanished over AirPlay. Our own Theater and
      // Fullscreen buttons call requestFullscreen on .player-frame, in OUR document, so
      // they are unaffected by the frame's policy and keep every overlay working.
      return `<iframe id="player-iframe" title="${esc(title)} — player" src="${esc(url)}" allow="autoplay; encrypted-media; picture-in-picture; airplay" ${sandbox} referrerpolicy="origin"></iframe>`;
      };
      const art = d && (d.backdrop_path || d.poster_path);
      const goLabel = resumeAt > 30 ? 'Resume ' + fmtClock(resumeAt) : 'Play';
      frameInner = gated
        ? `<div class="play-gate"${art ? ` style="background-image:url('${esc(img(art, IS_TV ? 'w780' : 'w1280'))}')"` : ''}>
            <button class="play-go" id="play-go" aria-label="${esc(goLabel + ' ' + title)}">${ICON.play}<span>${esc(goLabel)}</span></button>
          </div>`
        : frameHTML(src);
    }

    // Roll over to the neighbouring season rather than dead-ending, but never past
    // the ends of the show.
    const prevHref = !isTV ? null
      : episode > 1 ? ('#/watch/tv/' + id + '?s=' + season + '&e=' + (episode - 1))
      : prevSeason ? ('#/watch/tv/' + id + '?s=' + (season - 1) + '&e=' + (prevSeason.episode_count || 1))
      : null;
    const nextHref = !isTV ? null
      : hasNextEp ? ('#/watch/tv/' + id + '?s=' + season + '&e=' + (episode + 1))
      : nextSeason ? ('#/watch/tv/' + id + '?s=' + (season + 1) + '&e=1')
      : null;
    const epNav = isTV ? `
      <div style="display:flex;gap:8px;align-items:center;margin-left:auto">
        ${prevHref ? `<button class="btn sm" id="ep-prev" data-nav="${prevHref}">\u2039 Prev</button>`
                   : `<button class="btn sm" id="ep-prev" disabled>\u2039 Prev</button>`}
        <span class="muted" style="font-weight:700">S${season} \u00b7 E${episode}${epCount ? ' of ' + epCount : ''}</span>
        ${nextHref ? `<button class="btn sm" id="ep-next" data-nav="${nextHref}">${hasNextEp ? 'Next \u203a' : 'Season ' + (season + 1) + ' \u203a'}</button>`
                   : `<button class="btn sm" id="ep-next" disabled>Next \u203a</button>`}
      </div>` : '';

    // Change episode without leaving the player. Same idea as the server room right
    // below it: the thing you most often want next is one press away, and on a remote
    // it is a single D-pad row rather than a trip back to the show page.
    // A season rail beside the episodes. "All seasons" used to be a link OFF this
    // page -- you lost the player to go and pick, then came back. Switching season
    // here swaps the strip in place, so reaching any episode of any season is two
    // presses without the video ever going away.
    const allSeasons = (d && Array.isArray(d.seasons)) ? d.seasons.filter(x => x.season_number >= 1) : [];
    // A dropdown, not the pill rail the detail page uses. Twenty-three pills is a
    // thing you scroll THROUGH to find season 19, which is the opposite of choosing;
    // and this page's subject is the video, so the season control should take one
    // line and stop asking for attention. On a remote a <select> is also the better
    // control here -- OK opens the platform's own picker, which the D-pad drives
    // natively, instead of adding another horizontal row to walk.
    const seasonRail = (isTV && allSeasons.length > 1) ? `
      <label class="pl-season">
        <span class="sr-only">Season</span>
        <select id="pl-season-sel" aria-label="Choose a season">
          ${allSeasons.map(x => `<option value="${x.season_number}"${x.season_number === season ? ' selected' : ''}>Season ${x.season_number}${x.episode_count ? ' \u00b7 ' + x.episode_count + ' episodes' : ''}</option>`).join('')}
        </select>
      </label>` : '';

    const episodeSeason = season;   // the season actually playing, vs the one on show
    const epStrip = (isTV && seasonEps.length) ? `<section class="pl-eps" aria-label="Episodes">
      <div class="rail-head" style="margin:26px 0 12px">
        <h2 style="font-size:16px">Episodes</h2>
      </div>
      ${seasonRail}
      <div class="rail-wrap">
        <button class="rail-arrow left" data-rail="-1" tabindex="-1" aria-label="Scroll episodes left">${ICON.back}</button>
        <button class="rail-arrow right" data-rail="1" tabindex="-1" aria-label="Scroll episodes right">${ICON.chevR}</button>
      <div class="ep-strip" id="ep-strip">${epTiles(id, season, seasonEps, season === episodeSeason ? episode : -1)}</div>
      </div></section>` : '';

    // Mirrors that are not answering stay out of the room behind "Show offline": the verdict is
    // Cloudflare's view, and one of them may still work from the viewer's own network.
    const offCount = healthOn ? sources.filter((s, i) => isDown(s.name) && i !== cfg.activeSource).length : 0;
    const roomTiles = sources.map((s, i) => {
      const off = healthOn && isDown(s.name) && i !== cfg.activeSource;
      return `
      <button class="mirror ${i === cfg.activeSource ? 'on' : ''}${isTracked(s.name) ? ' tracked' : ''}${off ? ' down' : ''}"
              data-src="${i}" data-mirror-name="${esc(s.name || '')}" aria-pressed="${i === cfg.activeSource}"${off ? ' hidden title="Did not answer our check. It may still work on your network."' : ''}>
        <span class="num">${String(i + 1).padStart(2, '0')}</span>
        <span class="mn">${esc(s.name || ('Source ' + (i + 1)))}</span>
        <span class="ms">${i === cfg.activeSource ? '\u25cf Playing' : off ? offLabel(s.name) : 'Mirror ' + (i + 1)}</span>
        <span class="mbadge">${ICON.check} Verified</span>
      </button>`;
    }).join('');

    // Desktop and phone: the player in a main column, episodes and servers in a side one that
    // sits beside it on a wide window (stage.css) and below it otherwise. TV: the dock instead.
    const sideOpen = !IS_TV && !!window.matchMedia && matchMedia('(min-width: 1200px)').matches;
    view().innerHTML = `
      <div class="player-shell${IS_TV ? '' : ' pl-split'}">
        ${IS_TV ? '' : '<div class="pl-main">'}
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
          <button class="icon-btn" data-nav="#/${type}/${id}" data-back title="Back to details" aria-label="Back to details">${ICON.back}</button>
          <div class="pl-head" style="min-width:0">
            <div class="pl-title">${esc(title)}</div>
            ${isTV ? `<div class="pl-sub">S${season} \u00b7 E${episode}${epMeta && epMeta.name ? ' \u00b7 <b>' + esc(epMeta.name) + '</b>' : ''}</div>` : ''}
          </div>
          ${epNav}
        </div>
        <div class="player-frame"${IS_TV && src && !gated ? ' tabindex="0" role="button" aria-label="Open the player"' : ''}>${frameInner}</div>

        ${(src && IS_TV) ? '' : `<div class="source-bar">
          ${src ? '' : `<span class="lbl">No source selected</span>`}
          ${IS_TV ? '' : `<span class="sb-modes">
            ${IS_WINDOWED ? `<button class="btn sm" id="movie-mode" title="Fill this window and leave the rest of the desktop usable">${ICON.theater} Theater mode</button>` : ''}
            <button class="btn sm" id="tv-mode" title="Fill the screen">${ICON.fullscreen} Fullscreen</button>
          </span>`}
        </div>`}
        ${IS_TV ? '<div class="pl-dock" id="pl-dock">' : '</div><aside class="pl-side" aria-label="Episodes and servers">'}
        ${epStrip}
        ${sources.length ? `<div class="pl-srv">
        <div class="srv-now">
          <span class="lbl">${src ? 'Playing on <b>' + esc(src.name) + '</b>' : 'No source selected'}</span>
          ${(healthOn ? upIdx.length : sources.length) > 1 ? `<button class="btn sm" id="next-src">Try another server</button>` : ''}
        </div>
        <details class="srv" id="srv"${srvWasOpen || IS_TV || sideOpen ? ' open' : ''}>
          <summary tabindex="0">
            <span class="srv-t">Servers &amp; playback</span>
            <span class="srv-n">${healthOn ? upIdx.length + ' of ' + sources.length + ' online' : sources.length + ' mirrors'}${src ? ' · ' + esc(src.name) : ''}</span>
          </summary>
          <div class="srv-body">
            <div class="srv-opts">
              <button class="btn sm ${playerGuardOn() ? '' : 'ghost'}" id="toggle-sandbox" aria-pressed="${playerGuardOn()}"
                      title="Stops the player opening pop-up windows or redirecting the page. Cannot remove ads drawn inside the player itself, and a few mirrors refuse to run with it on.">
                ${playerGuardOn() ? ICON.check + ' Pop-ups blocked' : 'Block pop-up ads'}</button>
              ${playerGuardOn() || HOST_BLOCKS_POPUPS ? '' : `
              <span class="muted" style="font-size:12.5px">Pop-up ads can open from the player.</span>`}
            </div>
            <div class="server-room">${roomTiles}</div>
            ${offCount ? `<button class="btn sm ghost srv-offline" id="srv-offline" aria-expanded="false">Show ${offCount} offline</button>` : ''}
            <p class="muted mirror-note"><span class="mbadge static">${ICON.check} Verified</span>
              servers remember exactly where you stopped. The others still save your place,
              roughly. Switch servers if one stutters — no single one has everything.</p>
          </div>
        </details>
        </div>` : ''}
        ${IS_TV ? '</div>' : '</aside>'}
      </div>`;
    jumpTop();
    // The side column opens on the episode that is playing, not on E1 of 22. Its own scroll
    // only: scrollIntoView would move the page as well.
    if (sideOpen) {
      const eps = $('.pl-side .pl-eps'), onEp = eps && eps.querySelector('.epx.on');
      if (onEp) eps.scrollTop = onEp.getBoundingClientRect().top - eps.getBoundingClientRect().top - 12;
    }

    // Switch mirror IN PLACE — swap the iframe src instead of re-rendering the whole
    // page, so D-pad focus stays on the tile the user is on (no focus jump on TV).
    // Switching a mirror swaps the iframe src IN PLACE rather than re-rendering the
    // page, so the D-pad ring stays on the tile the user is on.
    const room = $('.server-room');
    const switchTo = (i) => {
      if (isNaN(i) || i === cfg.activeSource || !sources[i]) return;
      cfg.activeSource = i; cfg.activeName = sources[i].name; saveConfig();
      const s2 = sources[i];
      downPicked = isDown(s2.name) ? s2.name : '';
      // Where the episode stands NOW, not where it stood when the page rendered: open a film
      // fresh, watch forty minutes, change server -- the new one was sent to 0:00, and its first
      // report overwrote the forty minutes. Only ever FORWARD of the render-time point: a mirror
      // that ignored the seek and is reporting 0:01 must not drag the next one back with it.
      const ce = progGet(type, id, isTV ? season : null, isTV ? episode : null);
      const live = (ce && ce.src === 'provider' && !progDone(ce) &&
                    (!params.restart || (watchNow && watchNow.gotProvider))) ? (ce.t || 0) : 0;
      const at = Math.max(resumeAt, live);
      const fr2 = document.getElementById('player-iframe');
      if (fr2) {
        releasePlayerFocus();
        // A NEW frame, not a new src on the old one. Reports are identified by window ancestry,
        // and an iframe keeps the SAME WindowProxy across navigations: the outgoing mirror goes
        // on playing -- and reporting -- until the incoming URL commits, and every one of those
        // reports was credited to the incoming mirror: a server that never says a word was
        // stamped Verified, for good. A new element is a new browsing context. The old document
        // dies here, anything it had already queued no longer matches contentWindow, and no
        // session-history entry is left for Back to rewind the player into.
        const nf = fr2.cloneNode(false);            // same id / allow / sandbox / referrerpolicy
        nf.setAttribute('tabindex', '-1');
        nf.src = buildSourceUrl(s2, type, id, imdb, season, episode, at);   // set BEFORE insertion
        nf.addEventListener('error', () => toast('This mirror failed — try the next server'));
        fr2.replaceWith(nf);
      }
      // The badge, the two-minute silence clock, the "played to its end" proof and the episode
      // tag all belong to the mirror that is on screen NOW; and the wall clock restarts from
      // wherever the episode stands, not from where the last mirror's sitting began.
      if (watchNow) {
        watchNow.source = s2.name;
        watchNow.gotProvider = false; watchNow.sawMid = false; watchNow.ticks = 0;
        watchNow.epTag = ''; watchNow.endT = null; watchNow.lastT = null; watchNow.lastD = 0;
        watchNow.base = (ce && !progDone(ce)) ? (ce.t || 0) : 0;
        watchNow.started = Date.now();
      }
      nextUpHide();                                 // the old mirror's "ended" no longer applies
      const lbl = document.querySelector('.source-bar .lbl');
      if (lbl) lbl.innerHTML = 'Now playing: <b style="color:var(--text)">' + esc(s2.name) + '</b>';
      const nowLbl = document.querySelector('.srv-now .lbl');     // said the OLD mirror until a re-render
      if (nowLbl) nowLbl.innerHTML = 'Playing on <b>' + esc(s2.name) + '</b>';
      if (room) room.querySelectorAll('.mirror').forEach((el, idx) => {
        el.classList.toggle('on', idx === i);
        el.setAttribute('aria-pressed', String(idx === i));
        const ms = el.querySelector('.ms'); if (ms) ms.textContent = idx === i ? '● Playing' : el.classList.contains('down') ? offLabel(el.dataset.mirrorName) : 'Mirror ' + (idx + 1);
      });
    };
    const offBtn = $('#srv-offline');
    if (offBtn) offBtn.onclick = () => {
      const show = offBtn.getAttribute('aria-expanded') !== 'true';
      offBtn.setAttribute('aria-expanded', String(show));
      offBtn.textContent = show ? 'Hide offline' : 'Show ' + offCount + ' offline';
      // Never the one playing: an offline mirror picked by hand keeps its `.down` mark.
      if (room) room.querySelectorAll('.mirror.down:not(.on)').forEach(el => { el.hidden = !show; });
      if (IS_TV) tvInvalidate();
    };
    if (room) room.onclick = e => {
      const m = e.target.closest('.mirror'); if (!m) return;
      switchTo(parseInt(m.dataset.src, 10));
      dockClose();                                  // TV: back to the picture and the pointer
    };
    // One-press failover — the control the "this mirror failed" toast points at.
    const nx = $('#next-src');
    if (nx) nx.onclick = () => {
      let i = cfg.activeSource;                     // the next one that is answering
      for (let k = 0; k < sources.length; k++) {
        i = (i + 1) % sources.length;
        if (!healthOn || !isDown(sources[i].name)) break;
      }
      switchTo(i);
      toast('Switched to ' + (sources[i].name || 'the next server'));
      dockClose();
    };
    const tgl = $('#toggle-sandbox');
    if (tgl) tgl.onclick = () => {
      // Writes an explicit true/false, which from here on outranks the automatic default.
      cfg.playerGuard = !playerGuardOn(); saveConfig();
      // This control lives INSIDE the disclosure and its handler re-renders the whole
      // view, which closed the panel, scrolled to the top and left the only label
      // describing the new state hidden inside the thing that just shut. Say what
      // happened, and re-open the panel so the toggle is still where it was pressed.
      srvWasOpen = true;
      toast(playerGuardOn() ? 'Pop-up ads blocked' : 'Pop-ups allowed again');
      watchView(type, id, params);
    };
    const qa = $('#quick-add');
    if (qa) qa.onclick = () => {
      const val = $('#quick-src').value.trim();
      if (!val) return toast('Paste a URL template first');
      cfg.sources.push({ name: 'My source', movie: isTV ? '' : val, tv: isTV ? val : '' });
      cfg.activeSource = cfg.sources.length - 1; cfg.activeName = 'My source'; saveConfig();
      watchView(type, id, params);
    };
    const mm = $('#movie-mode');
    if (mm) mm.onclick = () => toggleCinema(false);   // fills the window
    const tv = $('#tv-mode');
    if (tv) tv.onclick = () => toggleCinema(true);    // fills the screen
    const fr = $('#player-iframe');
    if (fr) { fr.setAttribute('tabindex', '-1'); fr.addEventListener('error', () => toast('This mirror failed — try the next server')); }
    // Land the strip on the episode you are actually watching, not on E1.
    // Switching season swaps the strip WITHOUT navigating: the player keeps playing
    // while you look. Sequence-guarded, because a slow season could otherwise land
    // after a later one and leave the pills disagreeing with the tiles.
    let seasonSeq = 0;
    const plSel = $('#pl-season-sel');
    if (plSel) plSel.onchange = async () => {
      const n = parseInt(plSel.value, 10);
      const mine = ++seasonSeq, myRoute = routeSeq;
      const box = $('#ep-strip'); if (!box) return;
      const key = 'season:' + id + ':' + n;
      let sd = itemCache[key];
      if (!sd) {
        box.style.opacity = '.5';
        try { sd = await tmdb('/tv/' + id + '/season/' + n); itemCache[key] = sd; }
        catch (err) { sd = null; }
      }
      if (mine !== seasonSeq || !routeIs(myRoute) || !document.contains(box)) return;
      box.style.opacity = '';
      box.innerHTML = sd ? epTiles(id, n, sd.episodes, n === season ? episode : -1)
                         : '<div class="center-note">Could not load that season.</div>';
      box.scrollLeft = 0;
      if (IS_TV) { tvInvalidate(); const f = box.querySelector('.epx'); if (f) tvFocusEl(f); }
    };

    const strip = $('#ep-strip');
    if (strip) {
      centreIn(strip, strip.querySelector('.epx.on'));
    }
    // Start tracking position for this exact episode. Runtime is the denominator the
    // wall-clock fallback needs; the mirror overrides it the moment it posts its own.
    if (d) { ambientFrom(d.poster_path); artNote(type, id, d.backdrop_path); }
    // A function because with the poster up nothing is playing: tracking, and the native
    // layer's claim on the media keys, begin when Play builds the frame.
    const startTracking = () => {
    nativeSetPlayer(true);
    const live = sources[cfg.activeSource] || src;     // the room can change mirror before Play
    watchBegin({
      type: type, id: id,
      season: isTV ? season : null, episode: isTV ? episode : null,
      title: title, poster_path: d && d.poster_path, source: live && live.name,
      // Where "up next" goes, and what to call it. Computed here because the bounds
      // and the season rollover are already worked out at this point.
      nextHref: isTV ? nextHref : null,
      nextLabel: isTV ? (hasNextEp
        ? ('S' + season + ' \u00b7 E' + (episode + 1) + (nextEpMeta && nextEpMeta.name ? ' \u00b7 ' + nextEpMeta.name : ''))
        : (nextSeason ? ('Season ' + (season + 1) + ' \u00b7 E1') : null)) : null,
      runtime: 60 * (isTV ? ((d && d.episode_run_time && d.episode_run_time[0]) || 0)
                          : ((d && d.runtime) || 0))
    });
    };
    if (fr) { watchLive = true; startTracking(); }
    // Play: build the frame NOW, for whichever mirror is selected. The press is the user
    // gesture the mirror's autoplay needs, and the frame is created after it, so autoplay
    // stays on. Anything that would show the player (Fullscreen, Theater, F, T) goes through
    // watchStart so it plays too rather than going fullscreen on a poster.
    const mountPlayer = () => {
      const frame = $('.player-frame');
      if (!gated || watchLive || !frame || !frameHTML || !routeIs(my)) return;
      watchLive = true; watchStart = null;
      frame.innerHTML = frameHTML(sources[cfg.activeSource] || src);
      const f2 = $('#player-iframe');
      if (f2) { f2.setAttribute('tabindex', '-1'); f2.addEventListener('error', () => toast('This mirror failed — try the next server')); }
      startTracking();
      if (IS_TV) {
        frame.setAttribute('tabindex', '0'); frame.setAttribute('role', 'button'); frame.setAttribute('aria-label', 'Open the player');
        tvInvalidate(); tvFocusEl(frame);        // in the page: OK on the picture goes full screen
      }
    };
    const pg = $('#play-go');
    if (pg) pg.onclick = mountPlayer;
    watchStart = gated ? mountPlayer : null;
    // Landing on Play is TV_LANDING's job (route -> tvFocusFirst). Forcing it here also yanked
    // the ring out of the server room whenever a setting in there re-rendered the page.
    if (gated && IS_TV) tvInvalidate();
    const srv = $('#srv');
    // Only a press on the summary counts as the user opening the panel. On TV it renders
    // already open (it is half of the player's dock), and Chromium fires `toggle` for that
    // too -- which pulled the ring off Play and into the panel on every arrival.
    let srvByUser = false;
    const srvSum = srv && srv.querySelector('summary');
    if (srvSum) srvSum.addEventListener('click', () => { srvByUser = true; });
    if (srv) srv.addEventListener('toggle', () => {
      if (IS_TV && !srvByUser) return;
      srvByUser = false;
      srvWasOpen = srv.open;      // survive the re-render a setting in here triggers
      if (!IS_TV) return;
      tvInvalidate();
      // Land the ring on the first thing revealed, rather than leaving it on the
      // summary with a panel of new controls the user has to hunt for.
      if (srv.open) { const first = srv.querySelector('button'); if (first) tvFocusEl(first); }
    });
    // The pointer IS the full-screen player on TV: the mirrors' own controls are not reliably
    // reachable by spatial navigation, and the pointer reaches all of them. It comes back by
    // itself only when full screen is being carried over (another episode or server, Next
    // episode); otherwise the player waits in the page and OK on the picture brings it up.
    if (IS_TV && src && !gated) { if (cinemaCarry || resume) cursorOn(); }
    // Arrived by "next episode" from Theater or Fullscreen: back into it. Real OS fullscreen
    // cannot be re-acquired without a gesture, so desktop Fullscreen resumes as fill-the-window;
    // on a phone the landscape turn needs no gesture and comes back too.
    else if (resume && fr) enterCinema(resume === 2);
  }

  // "TV mode": a full-viewport player, for casting / screen-mirroring to a TV.
  // CSS-based so it works on iOS/Android/desktop; also tries native fullscreen.
  /**
   * Where an overlay must live to be seen over the player.
   *
   * A fullscreen element renders in the top layer, so anything outside its subtree is
   * not painted at all -- z-index does not enter into it. When the frame is
   * fullscreened, overlays have to be INSIDE it; otherwise document.body is right,
   * because the frame is a 16/9 box with overflow:hidden and an overlay parented there
   * outside cinema mode would be clipped to the video.
   */
  function overlayHost() {
    // Nothing but real fullscreen justifies moving an overlay out of <body>. Cinema mode
    // is an ordinary stacking context at z-index 300 and every overlay already outranks
    // it, so re-homing there bought nothing and cost the overlay its life on the next
    // re-render of the view -- the frame is rebuilt, and the child goes with it.
    return fsElement() || document.body;
  }

  /** Move the live overlays to wherever they now need to be. Focus is preserved:
   *  re-parenting blurs, and on a remote a lost ring reads as a crash. */
  function rehomeOverlays() {
    const host = overlayHost();
    const keep = document.activeElement;
    ['next-up', 'tv-cursor', 'tv-cursor-hint'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.parentNode !== host) host.appendChild(el);
    });
    if (keep && document.contains(keep) && keep !== document.body) {
      try { keep.focus({ preventScroll: true }); } catch (e) {}
    }
    if (IS_TV) tvInvalidate();
  }

  let cinemaTimer, cinemaReveal;
  function revealCinema() {
    const ex = $('#cinema-exit');
    if (ex) ex.classList.remove('faded');
    clearTimeout(cinemaTimer);
    cinemaTimer = setTimeout(() => {
      // Never fade it out from under the ring -- that is a dead remote.
      if (ex && ex !== document.activeElement) ex.classList.add('faded');
    }, 3000);
  }
  /**
   * Two different "bigger" requests, which used to be one button.
   *
   *   wantScreen = false  THEATER MODE. The player fills the WINDOW. Pure CSS, no
   *                       permission, no gesture requirement, and the rest of the
   *                       desktop stays usable around it.
   *   wantScreen = true   FULLSCREEN. The player fills the SCREEN, via a real
   *                       requestFullscreen.
   *
   * On a TV the window IS the screen, so the distinction is invisible there and the
   * remote only ever gets one control.
   */
  // ---- fullscreen, both spellings -------------------------------------------------
  // webkitRequestFullscreen was already used to ENTER, but the exit call and the change
  // event were unprefixed only: an engine that needed the prefix to get in had no
  // prefixed way back out, and never delivered the event that tears cinema down.
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  let fsSelfExit = false;
  /** Leave fullscreen, and mark it as OUR doing so onFsTeardown ignores it. */
  function fsExit() {
    if (!fsElement()) return;
    fsSelfExit = true;
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (!fn) { fsSelfExit = false; return; }
    try { Promise.resolve(fn.call(document)).catch(() => { fsSelfExit = false; }); }
    catch (e) { fsSelfExit = false; }
  }

  let fsWired = false;
  function enterCinema(wantScreen) {
    const frame = $('.player-frame'); if (!frame) return;
    if (!fsWired) {
      fsWired = true;
      // Fires for the app's own request AND for a user leaving with Escape or the
      // remote, so it is the one place that always knows where the top layer is.
      document.addEventListener('fullscreenchange', rehomeOverlays);
      document.addEventListener('webkitfullscreenchange', rehomeOverlays);
    }
    frame.classList.add('cinema'); document.body.classList.add('cinema-on');
    document.body.classList.toggle('cinema-screen', !!wantScreen);
    if (!$('#cinema-exit')) {
      // Exit, in the corner. On TV the pointer is up from the moment the episode opens
      // (cursorOn brings cinema with it), so there is no Pointer button to sit beside it.
      const bar = document.createElement('div');
      bar.id = 'cinema-chrome'; bar.className = 'cinema-chrome';
      const ex = document.createElement('button');
      ex.id = 'cinema-exit'; ex.className = 'cinema-btn cinema-exit'; ex.innerHTML = ICON.x + ' Exit';
      ex.setAttribute('aria-label', wantScreen ? 'Exit full screen' : 'Exit theater mode');
      ex.onclick = exitCinema;
      bar.appendChild(ex);
      frame.appendChild(bar);
      // Top hot-zone: reliably re-reveals the control on hover/tap even though the
      // cross-origin <iframe> swallows pointer events over the video itself.
      const hot = document.createElement('div');
      hot.id = 'cinema-hot'; hot.className = 'cinema-hot';
      ['mousemove', 'pointerdown', 'touchstart', 'click'].forEach(ev => hot.addEventListener(ev, revealCinema, { passive: true }));
      frame.appendChild(hot);
    }
    cinemaReveal = () => revealCinema();
    document.addEventListener('mousemove', cinemaReveal, { passive: true });
    document.addEventListener('keydown', cinemaReveal);
    revealCinema();  // start visible, then fade after 3s
    // requestFullscreen returns a promise; try/catch alone leaves an unhandled
    // rejection whenever the gesture requirement is not met.
    if (wantScreen) {
      const rq = frame.requestFullscreen || frame.webkitRequestFullscreen;
      let entered = Promise.resolve();
      if (rq) { try { entered = Promise.resolve(rq.call(frame)).catch(() => {}); } catch (e) {} }
      // A phone: fullscreen means landscape. After the request settles, because browsers
      // only allow an orientation lock while something IS fullscreen.
      // "A phone or a tablet", decided the same way the Theater button is (once, at startup)
      // plus touch capability -- NOT a live media query: a paired mouse, a stylus or a desktop
      // dock flips (pointer: coarse) mid-session and the rotation would silently not happen.
      const handheld = !IS_TV && !IS_WINDOWED && ((navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window);
      if (handheld) entered.then(cinemaLandscape);
    } else if (fsElement()) {
      // Stepping down from Fullscreen to Theater mode. fsSelfExit marks this as OURS, so the
      // teardown handler below does not mistake it for the user leaving and kill cinema.
      fsExit();
    }
  }
  /** Turn the picture landscape, by whichever means this platform has. See styles.css. */
  function cinemaLandscape() {
    const on = () => document.body.classList.contains('cinema-on');
    if (!on()) return;                                                   // already left
    // The fallback does not trust anyone's promise. A lock can reject, resolve without
    // turning anything, or never settle; an app's activity can be pinned by the system.
    // So: ask, and if the viewport is STILL portrait shortly afterwards, rotate the frame.
    // If the device then turns after all, the CSS is portrait-only and drops out by itself.
    const fallback = () => { if (on() && matchMedia('(orientation: portrait)').matches) document.body.classList.add('cinema-rot'); };
    if (NATIVE_TAP) { nativeSend('orient:landscape'); setTimeout(fallback, 1300); return; }   // the app: ask the activity
    const so = window.screen && screen.orientation;
    if (so && so.lock) { try { Promise.resolve(so.lock('landscape')).catch(fallback); } catch (e) { fallback(); } }
    else return fallback();
    setTimeout(fallback, 700);
  }
  function cinemaPortrait() {
    document.body.classList.remove('cinema-rot');
    if (IS_TV) return;
    if (NATIVE_TAP) nativeSend('orient:auto');
    try { if (window.screen && screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
  }
  function exitCinema() {
    cursorOff();
    cinemaPortrait();
    clearTimeout(cinemaTimer);
    if (cinemaReveal) {
      document.removeEventListener('mousemove', cinemaReveal);
      document.removeEventListener('keydown', cinemaReveal);
      cinemaReveal = null;
    }
    const frame = $('.player-frame'); if (frame) frame.classList.remove('cinema');
    document.body.classList.remove('cinema-on');
    document.body.classList.remove('cinema-screen');
    const bar = $('#cinema-chrome'); if (bar) bar.remove();
    const hot = $('#cinema-hot'); if (hot) hot.remove();
    if (fsElement()) fsExit();
    releasePlayerFocus();   // hand D-pad focus back to our UI
    // TV: the ring lands on the frame, which is where the remote was before the pointer
    // took over -- and OK there brings the pointer straight back up.
    if (IS_TV) { const f = $('.player-frame[tabindex="0"]'); if (f) tvFocusEl(f); }
  }
  // Pressing the mode you are already in leaves; pressing the OTHER one switches to it
  // rather than dropping you all the way out and making you press again.
  function toggleCinema(wantScreen) {
    if (watchStart) watchStart();      // the poster is still up: start the player first
    const on = document.body.classList.contains('cinema-on');
    const screen = document.body.classList.contains('cinema-screen');
    if (on && screen === !!wantScreen) return exitCinema();
    return enterCinema(wantScreen);
  }

  /* ---- D-pad pointer --------------------------------------------------------
     Handing DOM focus to the player never worked, and could not: the mirrors are
     cross-origin iframes whose play/pause controls are plain <div>s with click
     handlers. They are not focusable, so no amount of focus lands on them, and we
     cannot script into the frame to click one. The only thing that reaches inside is
     a real touch event, which only the native layer can synthesise — so on the TV
     build we draw a cursor, drive it with the D-pad, and tap through it.

     MainActivity exposes this over an ORIGIN-SCOPED WebMessageListener, so the
     embedded players cannot call it. Where it is missing (the browser build, or an
     old WebView) the cursor still works on our own UI and says so.                */
  const NATIVE_TAP = !!(window.ReeldeckNative && typeof window.ReeldeckNative.postMessage === 'function');
  let curEl = null, curHint = null, curX = 0, curY = 0, curStep = 14, curLast = 0;

  function nativeSend(msg) {
    if (!NATIVE_TAP) return;
    try { window.ReeldeckNative.postMessage(msg); } catch (e) {}
  }
  // Tell the native layer whether a player is on screen, so it only claims the
  // remote's MEDIA keys where they mean something.
  function nativeSetPlayer(on) { nativeSend('player:' + (on ? '1' : '0')); }

  // A tap that lands inside the player moves DOM focus INTO the cross-origin iframe.
  // Every key listener we have is on OUR document, and key events raised in another
  // browsing context never reach it — so the first tap that actually works would kill
  // the D-pad driving the cursor. Take the focus back. The click has already been
  // dispatched by then; only the focus is reclaimed.
  function cursorRefocus() {
    if (!cursorActive() || !curEl) return;
    if (document.activeElement === curEl) return;
    try { curEl.focus({ preventScroll: true }); } catch (e) { try { curEl.focus(); } catch (e2) {} }
  }
  // Primary guard: the iframe ELEMENT lives in our document, so it does raise focusin
  // here when the embed takes focus. Deliberately scoped to cursor mode — player-focus
  // mode wants focus in the iframe and must not be fought.
  document.addEventListener('focusin', (e) => {
    if (cursorActive() && e.target && e.target.id === 'player-iframe') cursorRefocus();
  });
  if (NATIVE_TAP) {
    try {
      window.ReeldeckNative.onmessage = (ev) => {
        const d = ev && ev.data;
        if (typeof d !== 'string') return;
        // Backstop for the guard above: the native layer acks once the MotionEvent has
        // actually been dispatched. Acking earlier would race the focus change.
        if (d === 'tapped') return cursorRefocus();
        // The remote's own media keys, handed to us by MainActivity because WebView
        // will not route them into page content on its own.
        if (d === 'key:playpause') return void playerKey('space');
        if (d === 'key:forward') return void playerKey('right');
        if (d === 'key:rewind') return void playerKey('left');
        // The key has been dispatched into the embed; take the remote back, or the
        // cross-origin frame keeps it and the D-pad is gone until Back.
        if (d === 'keysent') return playerKeyReturn();
        // The activity swallows OK's auto-repeats (it knows them for certain) and reports the
        // hold itself, so the sheet does not depend on how this WebView flags a repeat.
        if (d === 'key:okhold') return void okHold();
        if (d.indexOf('vol:') === 0) {
          const pct = parseInt(d.slice(4), 10);
          if (!isNaN(pct)) toast('Volume ' + pct + '%');
          return;
        }
        if (d.indexOf('upd:') === 0) {
          const rest = d.slice(4);
          if (rest.indexOf('err:') === 0) {
            updSet('error', { msg: rest.slice(4) });
            // Settings may have been closed while the download ran ("Keep browsing").
            // A failed DOWNLOAD still has to reach the user -- the installer is on
            // screen for 'done', so only the failure needs a voice.
            if (!document.getElementById('set-upd')) toast(rest.slice(4));
            return;
          }
          if (rest === 'done') return updSet('done');
          if (rest === 'busy') return;             // already downloading; the view already says so
          const pct = parseInt(rest, 10);
          if (!isNaN(pct)) updSet('downloading', { pct: pct });
          return;
        }
      };
    } catch (e) {}
  }

  function cursorActive() { return document.body.classList.contains('cursor-on'); }

  /** `what` names the thing Back leaves, for the hint: the player unless told otherwise. */
  function cursorOn(what) {
    if (!IS_TV) return;
    // A trailer plays in a modal over the page; the cinema it would enter is the page's
    // own player frame, underneath the modal, which is the wrong thing to fill.
    if (!document.body.classList.contains('cinema-on') && !document.querySelector('.modal-back')) enterCinema();
    if (!curEl) {
      curEl = document.createElement('div');
      curEl.className = 'tv-cursor'; curEl.id = 'tv-cursor';
      curEl.tabIndex = -1; curEl.setAttribute('aria-hidden', 'true');
    }
    // Appended (or re-appended) every time: cinema mode may have been entered since,
    // and a crosshair painted behind a fullscreen video is worse than none -- OK would
    // still tap through at a point the user cannot see.
    overlayHost().appendChild(curEl);
    document.body.classList.add('cursor-on');
    // Start where a play button usually is, rather than dead centre.
    curX = Math.round(window.innerWidth / 2);
    curY = Math.round(window.innerHeight * 0.58);
    curStep = 14;
    cursorDraw();
    if (!curHint) {
      curHint = document.createElement('div');
      curHint.className = 'tv-cursor-hint';
      curHint.id = 'tv-cursor-hint';
    }
    overlayHost().appendChild(curHint);
    const leaves = 'Back leaves ' + (typeof what === 'string' ? what : 'the player');
    const dockHint = document.getElementById('pl-dock') && !document.querySelector('.modal-back')
      ? '▼ at the bottom: episodes & servers · ' : '';
    curHint.textContent = NATIVE_TAP
      ? 'D-pad moves · OK presses · ' + dockHint + leaves
      : 'Pointer control needs the Reeldeck TV app · ' + dockHint + leaves;
    cursorWake();
    // Keep DOM focus in OUR document: if it were inside the iframe we would stop
    // receiving the arrow keys that drive the cursor.
    try { curEl.focus({ preventScroll: true }); } catch (e) { try { curEl.focus(); } catch (e2) {} }
    // tvMark ignores the cursor on purpose, so whatever wore the ring before -- on the
    // watch page, the frame itself -- would keep wearing it under a full-screen film.
    tvMark(null);
    tvInvalidate();
  }

  /**
   * Show the pointer and its hint, then let both fade if the remote goes quiet.
   *
   * The crosshair used to be painted once and left there for the rest of the film --
   * #cinema-exit and the control bar were both on a fade timer, but nothing ever dimmed
   * the pointer, so one press of OK put a white ring over the picture permanently. The
   * hint had the opposite bug: a one-shot 4.5s timeout, so it was gone for good after
   * the first few seconds and never came back to explain itself.
   */
  function cursorWake() {
    if (!cursorActive()) return;
    if (curEl) curEl.classList.remove('idle');
    if (curHint) curHint.classList.add('show');
    clearTimeout(cursorOn._t);
    cursorOn._t = setTimeout(() => {
      // The ring only DIMS; it never stops existing, because its position is the app's
      // only record of where the pointer is. One that vanished and came back somewhere
      // else would be worse than one that is merely faint.
      if (curEl) curEl.classList.add('idle');
      if (curHint) curHint.classList.remove('show');
    }, 4000);
  }

  function cursorOff() {
    if (!cursorActive()) return;
    document.body.classList.remove('cursor-on');
    if (curHint) curHint.classList.remove('show');
    if (curEl) curEl.classList.remove('idle');
    clearTimeout(cursorOn._t);
    // Whoever switched the pointer off places the ring: exitCinema puts it on the
    // frame, route() on the new page, a closing modal on what opened it. Left alone the
    // remote would sit on #tv-cursor -- aria-hidden, tabIndex -1, now display:none --
    // and the D-pad would look dead until a stray press re-seeded it; invalidating
    // here is what lets that next press recover if a caller places nothing.
    tvInvalidate();
  }

  /* ---- The player's dock (TV) --------------------------------------------------
     Episodes and servers WITHOUT leaving the picture. The watch page's own episode strip
     and server room are wrapped in #pl-dock; while the player fills the screen the dock
     waits below it (stage.css). Down with the pointer already at the bottom edge raises
     it and hands the D-pad to its tiles; Up from its top row, Back, or choosing a server
     lowers it and gives the pointer back exactly where it was. Choosing an episode
     navigates, and route() clears the dock with everything else. */
  let dockPointer = null;
  const dockIsOpen = () => document.body.classList.contains('dock-open');
  function dockOpen() {
    const dock = document.getElementById('pl-dock');
    if (!IS_TV || !dock || dockIsOpen() || !document.body.classList.contains('cinema-on')) return false;
    dockPointer = { x: curX, y: curY };
    cursorOff();
    document.body.classList.add('dock-open');
    dock.scrollTop = 0;
    tvInvalidate(); tvEnsureFocusable();
    // Land on what is playing: the current episode, else the current server.
    const f = [dock.querySelector('.epx.on'), dock.querySelector('.mirror.on'), dock.querySelector('.epx, .mirror')]
      .filter((el) => el && tvVisible(el))[0];
    if (f) tvFocusEl(f);
    return true;
  }
  function dockClose() {
    if (!dockIsOpen()) return false;
    document.body.classList.remove('dock-open');
    tvInvalidate();
    if (document.body.classList.contains('cinema-on')) {
      cursorOn();
      if (dockPointer) { curX = dockPointer.x; curY = Math.round(window.innerHeight * 0.58); cursorDraw(); }
    }
    dockPointer = null;
    return true;
  }

  function cursorDraw() {
    if (!curEl) return;
    // A re-render of the view (switching servers, an episode change) can detach whatever
    // curEl was parented to. Body is stable, so this is now belt-and-braces -- but a
    // detached cursor means pointer mode is still ON with nothing drawn, and OK would tap
    // at a position the viewer cannot see. Cheap to re-attach, expensive to get wrong.
    if (!curEl.isConnected) overlayHost().appendChild(curEl);
    curEl.style.transform = 'translate3d(' + curX + 'px,' + curY + 'px,0)';
  }

  // Held direction accelerates, so crossing the screen is a flick rather than a chore.
  function cursorMove(dir) {
    const t = (window.performance && performance.now) ? performance.now() : Date.now();
    curStep = (t - curLast < 260) ? Math.min(curStep + 7, 78) : 14;
    curLast = t;
    // Already at the bottom edge and pressing on: the dock (episodes and servers) rises.
    if (dir === 'down' && curY >= window.innerHeight - 8 && dockOpen()) return;
    if (dir === 'left') curX -= curStep;
    else if (dir === 'right') curX += curStep;
    else if (dir === 'up') curY -= curStep;
    else curY += curStep;
    curX = Math.max(6, Math.min(curX, window.innerWidth - 6));
    curY = Math.max(6, Math.min(curY, window.innerHeight - 6));
    cursorDraw();
    cursorWake();
  }

  // Where the ring was before we borrowed focus for a key press.
  let pkReturn = null;
  /**
   * Work one of the EMBED's own controls.
   *
   * We cannot script a cross-origin frame, but a key event delivered while that frame
   * holds focus reaches the player's own handler, and most bind Space to play/pause
   * and the arrows to seek. So: focus the frame, have native dispatch a real key, and
   * take focus back the moment it acks. Best-effort by nature — a mirror that binds
   * nothing will ignore it, which is what the pointer is for.
   */
  function playerKey(which) {
    const fr = document.getElementById('player-iframe');
    // TV only. This exists so a REMOTE can reach controls it cannot touch; on a phone
    // you just tap them, and enterPlayerFocus() would force the app into cinema mode.
    if (!fr || !NATIVE_TAP || !IS_TV) return false;
    const a = document.activeElement;
    // Keep the LAST real target. A second press lands while focus is already inside
    // the embed, and overwriting with null there is what stranded the remote.
    const cand = (a && a !== document.body && a.id !== 'player-iframe') ? a : null;
    if (cand) pkReturn = cand;
    // The pointer STAYS. It used to be switched off here because it and the borrowed
    // focus were competing modes; now it is the only mode, and dropping it for the
    // 700ms of a key dispatch just made the crosshair blink mid-film.
    enterPlayerFocus();
    nativeSend(which);
    // If the ack never lands (an old WebView, a page swapped underneath us) focus is
    // stranded in the embed and the D-pad is dead until Back. Reclaim it anyway.
    clearTimeout(playerKey._t);
    playerKey._t = setTimeout(playerKeyReturn, 700);
    return true;
  }
  function playerKeyReturn() {
    clearTimeout(playerKey._t);
    const el = pkReturn; pkReturn = null;
    // Release FIRST and unconditionally: bailing early here left focus in the
    // cross-origin frame, which takes the D-pad with it until Back.
    releasePlayerFocus();
    if (el && document.body.contains(el)) {
      if (IS_TV) tvFocusEl(el); else { try { el.focus(); } catch (e) {} }
    }
  }

  function cursorTap() {
    if (curEl) { curEl.classList.remove('tap'); void curEl.offsetWidth; curEl.classList.add('tap'); }
    if (NATIVE_TAP) {
      // Send a FRACTION of the viewport, not pixels. Converting CSS px to view px means
      // trusting devicePixelRatio to be the exact page-to-view scale, which only holds
      // while the page sits at scale 1; a fraction needs no such assumption.
      const fx = curX / (window.innerWidth || 1), fy = curY / (window.innerHeight || 1);
      try { window.ReeldeckNative.postMessage('tap:' + fx.toFixed(5) + ',' + fy.toFixed(5)); } catch (e) {}
      return;
    }
    // No bridge: a synthetic click still drives our own UI, never a cross-origin embed.
    const el = document.elementFromPoint(curX, curY);
    if (el && el.click) { try { el.click(); } catch (e) {} }
    else toast('Pointer control needs the Reeldeck app on your TV');
  }

  /**
   * Lend the embed DOM focus for one key dispatch.
   *
   * Only playerKey() calls this now: the remote's physical play/pause and seek keys are
   * delivered as real key events into the frame, which most mirrors bind, and the ack
   * (or a 700ms timeout) hands focus straight back. It never asks for real full screen:
   * requestFullscreen needs a user gesture and a media key is not one, so the request
   * would be rejected -- and a rejection is not free, it resolves as a failure the user
   * cannot see and cannot act on.
   */
  function enterPlayerFocus() {
    const fr = document.getElementById('player-iframe');
    if (!fr) return;
    if (!document.body.classList.contains('cinema-on')) enterCinema();
    document.body.classList.add('player-focused');
    tvInvalidate();
    fr.setAttribute('tabindex', '0');
    try { fr.focus(); } catch (e) {}
  }
  function releasePlayerFocus() {
    if (!document.body.classList.contains('player-focused')) return;
    document.body.classList.remove('player-focused');
    tvInvalidate();
    const fr = document.getElementById('player-iframe');
    if (fr) { try { fr.blur(); } catch (e) {} fr.setAttribute('tabindex', '-1'); }
    // Back to the pointer, which is where the remote was before the key dispatch
    // borrowed the frame's focus. This used to aim at the entry overlay's button; with
    // that gone, tvFocusEl found nothing and the ring dropped to <body>, leaving the
    // D-pad dead until a stray press woke it.
    if (IS_TV && cursorActive() && curEl) {
      try { curEl.focus({ preventScroll: true }); } catch (e) {}
    }
  }
  /**
   * The USER left fullscreen (Escape, F11, the remote) -> leave the player with them.
   *
   * This must not fire for fullscreen exits the app asked for itself. enterCinema(false)
   * calls fsExit() to step TV mode down to Movie mode, and exitCinema() calls it during
   * its own teardown; treating either as a user exit meant "Movie mode" pressed while in
   * TV mode dropped you out of the player altogether, and exitCinema re-entered itself.
   * fsSelfExit is the one bit of state that distinguishes them.
   */
  function onFsTeardown() {
    if (fsElement()) return;                 // entering, not leaving
    if (fsSelfExit) { fsSelfExit = false; return; }
    // In REAL fullscreen the browser keeps Esc (and Android's Back) for itself: the page never
    // sees the key, only this event. So the press that was meant to cancel a countdown left
    // the player instead, while the countdown ticked on and took the viewer to the next
    // episode anyway. Dismissed, not just hidden -- the mirror is still reporting the end.
    if (nextUpCount) { nextUpDismissed = true; nextUpHide(); }
    if (document.body.classList.contains('cinema-on')) exitCinema();
  }
  document.addEventListener('fullscreenchange', onFsTeardown);
  document.addEventListener('webkitfullscreenchange', onFsTeardown);

  // The two mirrors that document a start-position parameter. Everything else simply
  // starts from the beginning -- there is no generic way to seek a cross-origin player.
  // The resume parameter now rides on the row itself, for the same reason the URLs do:
  // a map keyed by provider name would put every provider's name back in the bundle.

  function buildSourceUrl(src, type, id, imdb, season, episode, resumeAt) {
    let tpl = (type === 'tv' ? src.tv : src.movie) || src.movie || src.tv || '';
    tpl = tpl
      .replace(/\{id\}|\{tmdbId\}|\{externalId\}/g, id)   // source site uses tmdbId / externalId
      .replace(/\{imdb\}/g, imdb || id)
      .replace(/\{season\}/g, season || 1)
      .replace(/\{episode\}/g, episode || 1)
      .replace(/\{color\}|\{primaryColor\}/g, (cfg.accent || '#f5c518').replace('#', ''));
    // Hand the mirror our saved position so it opens where the viewer stopped rather
    // than at 0:00. Only where the provider documents the parameter, and never for
    // something already finished.
    const rp = src && typeof src.resume === 'string' && /^[a-zA-Z]{1,24}$/.test(src.resume)
      ? src.resume : null;
    if (rp && resumeAt > 30) {
      tpl += (tpl.indexOf('?') >= 0 ? '&' : '?') + rp + '=' + Math.floor(resumeAt);
    }
    return tpl;
  }

  /* ---------- Watchlist ---------- */
  function watchlistView(params) {
    params = params || {};
    const all = getWatch();
    // Controls only once the list is long enough to need them; state lives in the hash, so
    // route()'s same-section logic keeps the TV ring where it was, as it does for Discover.
    const type = (params.type === 'movie' || params.type === 'tv') ? params.type : '';
    const f = (params.f === 'unwatched' || params.f === 'upcoming') ? params.f : '';
    const sort = ['added', 'date', 'rating', 'title'].indexOf(params.sort) >= 0 ? params.sort : 'added';
    const today = iso(now()), eps = newEpAll();
    const unwatched = (i) => i.type === 'tv' ? !progShow(i.id) : !progDone(progGet('movie', i.id));
    const upcoming = (i) => (i.date && i.date > today) || (i.type === 'tv' && eps[i.id] && eps[i.id].next && eps[i.id].next >= today);
    let list = all.filter(i => (!type || i.type === type) && (f !== 'unwatched' || unwatched(i)) && (f !== 'upcoming' || upcoming(i)));
    if (sort === 'date') list = list.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    else if (sort === 'rating') list = list.slice().sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
    else if (sort === 'title') list = list.slice().sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    const href = (over) => {
      const p = new URLSearchParams();
      const v = Object.assign({ type: type, f: f, sort: sort === 'added' ? '' : sort }, over);
      Object.keys(v).forEach(k => { if (v[k]) p.set(k, v[k]); });
      const q2 = p.toString(); return '#/watchlist' + (q2 ? '?' + q2 : '');
    };
    const chip = (label, over, on) => `<button class="chip ${on ? 'on' : ''}" data-nav="${href(over)}" aria-pressed="${on}">${label}</button>`;
    // ...and whenever a filter or sort is applied, however short the list has become: pruning
    // an 8-title list while filtered made the bar vanish with the filter still in force.
    const controls = (all.length >= 8 || type || f || sort !== 'added') ? `<div class="wl-controls">
        <div class="chips" role="group" aria-label="Show">
          ${chip('All', { type: '', f: '' }, !type && !f)}${chip('Films', { type: 'movie' }, type === 'movie')}${chip('Shows', { type: 'tv' }, type === 'tv')}
          ${chip('Unwatched', { f: f === 'unwatched' ? '' : 'unwatched' }, f === 'unwatched')}${chip('Upcoming', { f: f === 'upcoming' ? '' : 'upcoming' }, f === 'upcoming')}
        </div>
        <div class="chips" role="group" aria-label="Sort by">
          <span class="lbl">Sort</span>${chip('Added', { sort: '' }, sort === 'added')}${chip('Released', { sort: 'date' }, sort === 'date')}${chip('Rating', { sort: 'rating' }, sort === 'rating')}${chip('Title', { sort: 'title' }, sort === 'title')}
        </div>
      </div>` : '';
    let html = `<h1 class="page-title">Watchlist${all.length ? ` <span class="muted" style="font-size:16px">(${list.length === all.length ? all.length : list.length + ' of ' + all.length})</span>` : ''}</h1>${controls}`;
    html += list.length
      ? `<div class="grid">${list.map(i => cardHTML(i, i.type, true)).join('')}</div>`
      : all.length ? `<div class="center-note">Nothing on your watchlist matches that.
          <div class="note-cta"><button class="btn primary" data-nav="#/watchlist">Show everything</button></div></div>`
      : `<div class="center-note">Nothing saved yet \u2014 use the bookmark on any title to keep it here.
          <div class="note-cta"><button class="btn primary" data-nav="#/movies">Browse movies</button><button class="btn" data-nav="#/tv">Browse shows</button></div>
        </div>`;
    html += histSectionHTML();
    view().innerHTML = html;
    const hc = $('#hist-clear');
    // History and progress are one idea to a viewer, so Clear takes both -- leaving
    // progress bars behind with no history to explain them reads as a bug.
    if (hc) hc.onclick = () => {
      if (confirm('Clear your watch history and all resume positions?')) {
        histClear(); progClear(); route(); toast('History cleared'); syncFlush('clear');
      }
    };
  }

  /* ---------- Install on TV / other devices ---------- */
  // Shorten a long URL via a free, no-auth, CORS-enabled service so it's easy to
  // type on a TV remote. TinyURL is primary (established since 2002, deterministic
  // — same long URL always maps to the same short code — and returns plain text);
  // spoo.me is the fallback (Access-Control-Allow-Origin: *). Returns null if both
  // are unreachable, in which case the full URL is used (it always works).
  async function shortenUrl(longUrl) {
    try {
      const r = await fetchTimeout('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl), null, 6000);
      if (r.ok) { const t = (await r.text()).trim(); if (/^https?:\/\/tinyurl\.com\/\S+$/i.test(t)) return t; }
    } catch (e) {}
    try {
      const r = await fetchTimeout('https://spoo.me/', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'url=' + encodeURIComponent(longUrl)
      }, 6000);
      if (r.ok) { const j = await r.json(); if (j && j.short_url) return String(j.short_url).trim(); }
    } catch (e) {}
    return null;
  }

  function getAppView() {
    const longUrl = (cfg.apkUrl || '').trim();
    const manual  = (cfg.apkShortUrl || '').trim();
    const cached  = (cfg.apkShortAutoFor === longUrl && cfg.apkShortAuto) ? cfg.apkShortAuto : '';
    const short   = manual || cached;            // best short link we already have
    const primary = short || longUrl;            // address we tell people to type

    const isDefault = manual === (DEFAULTS.apkShortUrl || '');
    const autoLine = manual
      ? (isDefault
          ? 'Permanent Reeldeck link — always points at the newest release.'
          : 'Using your custom link. <button class="linkish" id="ga-reset">Switch back to the auto link</button>')
      : (cached ? 'Auto-shortened via TinyURL — same short link for everyone.' : 'Shortening the link…');

    view().innerHTML = `<h1 class="page-title">Get Reeldeck on your devices</h1>
      <div class="getapp">
        <div class="ga-card">
          <h3>${ICON.tv} Android TV / Google TV</h3>
          <p class="muted">Install the <b>Downloader</b> app on the TV, open it, and enter this address:</p>
          <div class="ga-url"><code id="ga-url">${esc(primary)}</code><button class="btn sm" id="ga-copy">Copy</button></div>
          <div class="ga-qr"><img id="ga-qr-img" alt="QR code for the app download" width="176" height="176"><span class="muted">Scan to open on a phone</span></div>
          <ol class="ga-steps">
            <li>On the TV: install <b>Downloader by AFTVnews</b>, and allow it to install unknown apps.</li>
            <li>Open Downloader, type the address above, press <b>Go</b>.</li>
            <li>When it downloads, choose <b>Install</b>. If a Play Protect notice appears, pick Install anyway.</li>
          </ol>
        </div>
        <div class="ga-card">
          <h3>Shorter link — easier to type on a remote</h3>
          <p class="muted" id="ga-auto">${autoLine}</p>
${IS_TV ? '' : `
          <p class="muted" style="font-size:12.5px;margin-top:4px">Want your own memorable link instead? Paste one (e.g. a custom <b>tinyurl.com</b> alias) and save — it replaces the address above and updates the QR.</p>
          <div class="ga-url"><input id="ga-short" placeholder="https://tinyurl.com/your-alias" value="${esc(manual)}"><button class="btn sm primary" id="ga-save">Save</button></div>`}
          <p class="muted" style="font-size:12.5px;margin-top:10px">Even easier: the Downloader app supports numeric <b>codes</b> — register your link at <b>aftv.news</b> and you get a short number to punch in.</p>
        </div>
        <div class="ga-card">
          <h3>Phone &amp; Windows</h3>
          <p class="muted"><b>Android phone:</b> open the address above (or scan the QR) and install the APK — same file as the TV. <b>Windows:</b> get the installer from the <button class="linkish" data-openext="https://github.com/jaig-eye/reeldeck/releases/latest">Releases page</button>.</p>
          ${IS_IOS && !IS_STANDALONE ? `
          <div class="ga-ios">
            <h3>${ICON.download} On this iPhone or iPad</h3>
            <p>The download above is an <b>Android</b> package — iOS cannot install it, and there
               is no App Store version. Install this page instead; it behaves the same, with its
               own icon and no browser bars.</p>
            <ol>
              <li>Make sure you are in <b>Safari</b> — no other iOS browser can install a web app.</li>
              <li>Tap the <b>Share</b> button (the square with an arrow).</li>
              <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
            </ol>
            <p class="muted">Two honest differences: ads are not blocked the way they are in the
               Android app, and video will not start until you tap the player once — iOS insists.</p>
          </div>` : ''}
          ${IS_IOS && IS_STANDALONE ? `
          <div class="ga-ios"><h3>${ICON.check} Installed</h3>
            <p>You are running the installed app. Enter the same code on your other devices
               and your watchlist and history follow you there.</p></div>` : ''}
        </div>
      </div>`;

    const paint = (addr) => {
      const u = $('#ga-url'); if (u) u.textContent = addr;
      try {
        const q = window.qrcode(0, 'M'); q.addData(addr); q.make();
        const im = $('#ga-qr-img'); if (im) { im.style.display = ''; im.src = q.createDataURL(5, 8); }
      } catch (e) { const im = $('#ga-qr-img'); if (im) im.style.display = 'none'; }
    };
    paint(primary);

    // Auto-generate the short link once (cached), only if the user hasn't set a manual one.
    if (!short && longUrl) {
      shortenUrl(longUrl).then((s) => {
        if (s) {
          cfg.apkShortAuto = s; cfg.apkShortAutoFor = longUrl; saveConfig();
          if (!(cfg.apkShortUrl || '').trim()) paint(s);      // don't clobber a manual link set meanwhile
          const b = $('#ga-auto'); if (b) b.innerHTML = 'Auto-shortened via TinyURL: <b>' + esc(s) + '</b>';
        } else {
          const b = $('#ga-auto'); if (b) b.textContent = 'Auto-shortening is unavailable right now — the full link above still works.';
        }
      });
    }

    const cp = $('#ga-copy');
    if (cp) cp.onclick = () => {
      const text = $('#ga-url').textContent;
      let p = null;
      try { p = navigator.clipboard && navigator.clipboard.writeText(text); } catch (e) { p = null; }
      // Only claim success once the write actually resolved. On a refusal, say so and
      // leave the address on screen to copy by hand.
      if (p && p.then) p.then(() => toast('Copied'), () => toast('Could not copy — select the address above'));
      else toast('Could not copy — select the address above');
    };
    const sv = $('#ga-save'); if (sv) sv.onclick = () => { cfg.apkShortUrl = $('#ga-short').value.trim(); saveConfig(); toast('Saved'); getAppView(); };
    const rs = $('#ga-reset'); if (rs) rs.onclick = () => { cfg.apkShortUrl = ''; saveConfig(); toast('Using the auto short link'); getAppView(); };
  }

  /* ---------- Account menu -------------------------------------------------
     The header carries three things: search, watchlist, account. Everything that
     used to sit in it -- settings, updates, install -- lives under the account
     button, because that is where people look for it and because it leaves the bar
     with room to breathe. Browsing by genre is a rail on Home and a grid on Search. */
  /**
   * The account button's face, in one place so the header and the menu cannot disagree.
   *
   * They did: the header drew the initial of cfg.brand while the menu drew the initial of
   * the signed-in name, so the same person was "R" in the bar and "B" in the panel
   * directly underneath it. Order is picture, then initial, then a gear -- an anonymous
   * person-glyph for a signed-out account says nothing the gear does not, and the menu it
   * opens is mostly settings.
   */
  function acctFaceHTML() {
    const st = syncState();
    if (st.on && st.uid) {
      // https only: this string goes straight into a src attribute. A broken or blocked
      // avatar falls back to the initial rather than leaving an empty circle.
      // The account's name is its code's label ("mum"); its first letter is the face.
      const ini = (st.name || '').trim().charAt(0).toUpperCase();
      if (ini) return '<span class="acct-ini">' + esc(ini) + '</span>';
    }
    return '<span class="acct-ini gear">' + ICON.gear + '</span>';
  }

  /**
   * Repaint just the account button's face.
   *
   * NOT buildHeader(): that rebuilds the whole bar and the bottom tabs, and only the avatar
   * actually changes here, so only the avatar is rewritten.
   */
  function refreshAcctFace() {
    const av = document.querySelector('#acct-btn .acct-av');
    if (av) av.innerHTML = acctFaceHTML();
  }

  function closeAcct() {
    const m = $('#acct-menu');
    // Standard menu-button behaviour: if focus was IN the menu, it returns to the button.
    // It also means a modal opened from the menu records the button as its opener, so
    // Back from Settings lands somewhere visible instead of on <body>.
    const had = !!(m && m.contains(document.activeElement));
    if (m) m.remove();
    const b = $('#acct-btn'); if (b) b.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', closeAcct._esc || (() => {}));
    if (had && b) { if (IS_TV) tvFocusEl(b); else { try { b.focus(); } catch (e) {} } }
  }
  // The account button opens the Account page (accountView, #/account). It used to open a
  // pop-out menu of Settings, Install on TV, Reload and Sign out: those are its tabs now.

  /* ---------- Error state ---------- */
  function errorState(e, sel) {
    const msg = (e && e.message) || 'Something went wrong';
    const html = `<div class="center-note">
      <div class="cn-warn">${ICON.warn}</div>
      <div style="font-weight:700;color:var(--text);margin-bottom:6px">Couldn't load data</div>
      <div>${esc(msg)}</div>
      ${e && e.path ? `<div class="muted" style="font-size:12px;margin-top:8px;opacity:.7">${esc(e.path)}${e.status ? ' · ' + e.status : ''}</div>` : ''}
      <button class="btn sm" style="margin-top:16px" onclick="location.reload()">Retry</button>
    </div>`;
    (sel ? $(sel) : view()).innerHTML = html;
  }

  /* ============================================================
     TRAILER + SETTINGS modals
     ============================================================ */
  function openTrailer(key) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal wide">
      <div class="mh"><h3>Trailer</h3><button class="icon-btn" data-close aria-label="Close">${ICON.x}</button></div>
      <div class="video-wrap">
        <iframe id="trailer-iframe" title="Trailer" src="https://www.youtube-nocookie.com/embed/${esc(key)}?autoplay=1" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>
      </div>
    </div>`;
    modalMount(back);
    // On TV the embed is the only thing that can pause or scrub, and an <iframe> is not
    // a D-pad target, so the pointer comes up with the trailer -- the same as the
    // player, and for the same reason. Back closes the modal, and the pointer with it.
    if (IS_TV) cursorOn('the trailer');
  }

  /* ---- Account (#/account) -----------------------------------------------------------
     What the account button's pop-out menu and the Settings dialog held, as one page with
     tabs: Profile (who this device is signed in as, sync, sign out), Settings (theme,
     playback, your data) and App (version and updates, reload, install on TV). The tab lives
     in the hash, so Back and the TV's place memory treat a tab like any other filter. */
  const ACCOUNT_TABS = [['profile', 'Profile'], ['settings', 'Settings'], ['app', 'App']];
  function accountView(params) {
    const tab = ACCOUNT_TABS.some((t) => t[0] === params.tab) ? params.tab : 'profile';
    const sst = syncState(), signedIn = !!(sst.on && sst.uid);
    const name = signedIn ? (sst.name || 'Your account') : 'Locked';
    const sync = signedIn ? (sst.stall ? 'Sync needs attention' : 'Synced ' + (sst.lastSyncAt ? relTime(sst.lastSyncAt) : 'soon'))
                          : 'Enter your code to continue';
    const updNote = updState.s === 'ready' ? 'Update ready' : updState.s === 'available' ? 'Update available' : '';
    const tabs = ACCOUNT_TABS.map((t) => `<button type="button" role="tab" class="acc-tab" data-nav="#/account?tab=${t[0]}" aria-selected="${t[0] === tab}">${t[1]}${
      t[0] === 'app' && updNote ? '<i class="acc-dot" role="img" aria-label="' + updNote + '"></i>' : ''}</button>`).join('');
    const themeCards = THEMES.map(t => `<button class="theme-card ${cfg.theme === t.id ? 'on' : ''}" data-theme-pick="${t.id}" aria-pressed="${cfg.theme === t.id}" aria-label="${t.name} theme">
        <span class="tprev">${t.preview.map(c => `<i style="background:${c}"></i>`).join('')}</span>
        <span class="tname">${t.name}</span>
      </button>`).join('');

    const panel = tab === 'profile' ? `
        <div class="acc-who"><span class="acct-av" aria-hidden="true">${acctFaceHTML()}</span>
          <div><h2>${esc(name)}</h2><p>${esc(sync)}</p></div></div>
        <div class="set-group">
          <p class="hint">Your four-digit code is your account: your watchlist, history and resume points follow it to any device you enter it on.</p>
          <div class="set-row"><button class="btn" id="acc-signout">${ICON.user} Sign out on this device</button></div>
        </div>`
      : tab === 'settings' ? `
        <div class="set-group">
          <h4>Theme</h4>
          <p class="hint">Pick a look — applies instantly.</p>
          <div class="theme-grid" id="set-themes">${themeCards}</div>
        </div>
        <div class="set-group">
          <h4>Playback</h4>
          <label class="set-toggle"><input type="checkbox" id="set-autonext" ${cfg.autoNext === false ? '' : 'checked'}>
            <span><b>Play the next episode automatically</b><small>When a server reports that an episode has ended. Servers marked Verified do; on the others it stays a button.</small></span></label>
        </div>
        ${IS_TV ? '' : `<div class="set-group">
          <h4>Your data</h4>
          <p class="hint">Watchlist, history and resume points. Import merges with what is here — nothing is removed.</p>
          <div class="set-row">
            <button class="btn sm" id="set-export">${ICON.download} Export</button>
            <button class="btn sm" id="set-import">Import…</button>
            <input type="file" id="set-import-file" accept=".json,application/json" hidden>
          </div>
        </div>`}
        <div class="set-group">
          <h4>Reset</h4>
          <p class="hint">Settings back to their defaults. Your watchlist and history are kept.</p>
          <div class="set-row"><button class="btn sm" id="set-reset">Reset settings</button></div>
        </div>`
      : `
        <div class="set-group">
          <h4>About</h4>
          <p class="hint">Reeldeck <b>v${APP_VERSION}</b> · ${IS_WEBOS ? 'LG webOS' : IS_TV ? 'Android TV' : IS_DESKTOP ? 'Desktop' : 'Web'}${
            IS_TV ? ' · screen ' + window.innerWidth + '×' + window.innerHeight + ' at ' + (+(window.devicePixelRatio || 1).toFixed(2)) + 'x' : ''}</p>
          <div class="upd-box" id="set-upd"></div>
        </div>
        <div class="set-group">
          <h4>This device</h4>
          <div class="set-row">
            <button class="btn sm" id="acc-reload">${ICON.sync} Reload app</button>
            ${IS_TV ? '' : `<button class="btn sm" id="set-getapp">${ICON.tv} Install on TV / other devices</button>`}
            ${IS_WINDOWED ? `<button class="btn sm" id="set-keys">Keyboard shortcuts</button>` : ''}
          </div>
        </div>`;
    view().innerHTML = `<h1 class="page-title">Account</h1>
      <div class="acc-tabs" role="tablist" aria-label="Account">${tabs}</div>
      <section class="acc-panel" role="tabpanel">${panel}</section>`;

    // Theme picker: applies and persists at once.
    const th = $('#set-themes');
    if (th) th.onclick = (e) => {
      const card = e.target.closest('[data-theme-pick]'); if (!card) return;
      cfg.theme = card.dataset.themePick;
      th.querySelectorAll('.theme-card').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
      card.classList.add('on'); card.setAttribute('aria-pressed', 'true');
      saveConfig();  // applyTheme runs -> live switch
      // The theme is the ONE field of cfg that syncs, so it needs its own stamp --
      // cfg itself is never sent, for the reasons above syncState().
      const st = syncState(); st.themeAt = now(); saveSyncState(st);
      syncFlush('theme');
    };
    renderUpdBox();
    const so = $('#acc-signout');
    if (so) so.onclick = signOut;
    // The APK and the desktop app have no address bar and no pull-to-refresh, so a wedged
    // session -- a mirror that hung, a view that failed to paint -- had no way out but
    // force-quitting. Reload the document: the states worth escaping are the ones route() cannot clear.
    const rl = $('#acc-reload');
    if (rl) rl.onclick = () => location.reload();
    const ga = $('#set-getapp');
    if (ga) ga.onclick = () => go('#/get-app');
    const an = $('#set-autonext');
    if (an) an.onchange = () => { cfg.autoNext = an.checked; saveConfig(); };
    const ex = $('#set-export');
    if (ex) ex.onclick = exportData;
    const imB = $('#set-import'), imF = $('#set-import-file');
    if (imB && imF) {
      imB.onclick = () => imF.click();
      imF.onchange = () => { const f = imF.files && imF.files[0]; if (f) importFile(f); };
    }
    const kb = $('#set-keys');
    if (kb) kb.onclick = openShortcuts;
    const rs = $('#set-reset');
    if (rs) rs.onclick = () => { if (confirm('Reset settings to defaults?\n\nThis also removes any mirrors you added and restores the built-in list. Your watchlist and history are kept.')) { cfg = Object.assign({}, DEFAULTS); cfg.sources = DEFAULT_SOURCES.map(x => Object.assign({}, x)); saveConfig(); const rst = syncState(); rst.themeAt = now(); saveSyncState(rst); syncFlush('reset'); route(); toast('Settings reset'); } };
    if (IS_TV) tvInvalidate();
  }

  // Closing a modal must also drop pointer mode — openTrailer hands the remote to the
  // cursor, and the Back handler closes the modal and returns before reaching it.
  function modalCursorReset() { if (document.body.classList.contains('cursor-on')) cursorOff(); }

  function modalMount(back) {
    // NOT <body>. The account menu removes the focused item before opening Settings,
    // so activeElement has already fallen back to <body> by the time we get here -- and
    // body satisfies every test in closeModal below, so it took tvFocusEl(body): a
    // focus() that does nothing, a ring that vanishes, and a scroll-into-view computed
    // against an element whose height is the whole document, which glided Home about
    // 1700px to its middle. Storing null instead routes closeModal to tvRestoreFocus.
    const opener0 = document.activeElement;
    back._opener = (opener0 && opener0 !== document.body && opener0 !== document.documentElement)
      ? opener0 : null;
    const heading = back.querySelector('.mh h3');
    if (heading) { heading.id = heading.id || ('mh-' + (++modalSeq)); }
    const dlg = back.querySelector('.modal');
    if (dlg) {
      dlg.setAttribute('role', 'dialog');
      dlg.setAttribute('aria-modal', 'true');
      if (heading) dlg.setAttribute('aria-labelledby', heading.id);
    }
    document.body.appendChild(back);
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) closeModal(back); });
    // Keep a handle so closeModal can always unhook this. It used to be removed only
    // when the user pressed Escape, so closing via the backdrop or the X button left a
    // document-level listener behind holding the detached modal alive — one more every
    // time Settings was opened.
    back._esc = (ev) => { if (ev.key === 'Escape') closeModal(back); };
    document.addEventListener('keydown', back._esc);
    // move focus into the modal (esp. for D-pad remotes)
    // querySelector with a selector LIST returns the first match in document order, not
    // the first selector's match — so the header's ✕ won every time and the first OK
    // press closed the dialog the user had just opened. Try the selectors in priority.
    const f = back.querySelector('[data-theme-pick]')
      || back.querySelector('.mb button, .mb [href], .mb input, .mb select, .mb [tabindex="0"]')
      || back.querySelector('button, [href], input, select, [tabindex="0"]');
    if (f) { if (IS_TV) tvFocusEl(f); else try { f.focus(); } catch (e) {} }
  }
  function closeModal(back) {
    if (!back || !back.parentNode) return;
    modalCursorReset();   // a trailer hands the remote to the pointer; take it back
    if (back._esc) { document.removeEventListener('keydown', back._esc); back._esc = null; }
    const opener = back._opener;
    back.parentNode.removeChild(back);
    // Put the ring back exactly where it was before the modal opened.
    if (opener && opener.focus && document.contains(opener)) {
      if (IS_TV) tvFocusEl(opener); else try { opener.focus(); } catch (e) {}
    } else if (IS_TV) tvRestoreFocus();
  }

  /* ============================================================
     ROUTER
     ============================================================ */
  function parseHash() {
    let raw = location.hash.slice(1) || '/';
    const qi = raw.indexOf('?');
    const path = qi >= 0 ? raw.slice(0, qi) : raw;
    const qs = qi >= 0 ? raw.slice(qi + 1) : '';
    const params = {};
    new URLSearchParams(qs).forEach((v, k) => params[k] = v);
    const parts = path.split('/').filter(Boolean);
    return { parts, params };
  }
  // In-app navigations are QUEUED, so the hashchange handler can tell a click that happens to
  // target the previous hash ("<- Prev", the logo, a poster you just came from) from a real
  // history traversal. Only a URL that actually changed queues a hashchange, so a same-hash
  // go() leaves nothing behind to poison the next real Back. `back` marks the one control
  // that is a click AND means Back: the player's "Back to details" arrow.
  const goQueue = [];
  function go(hash, back) {
    const before = location.href;
    // A title's own Play (marked data-play) goes straight into the player; anything else that
    // lands on a watch page -- a shortcut, a link, Continue watching -- still opens on the poster.
    const a = document.activeElement;
    const pl = a && a.closest && a.closest('[data-play]');
    if (pl && pl.getAttribute('data-nav') === hash) watchArm = true;
    location.hash = hash;
    if (location.href !== before) goQueue.push(back ? 1 : 0);
  }

  function setActiveNav(section) {
    document.querySelectorAll('[data-section]').forEach(a => {
      const on = a.dataset.section === section;
      a.classList.toggle('active', on);
      // The active item was conveyed by colour alone; aria-current names it.
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  function route(restore) {
    routeSeq++;
    ambientFrom(null);           // house lights down; the next view brings its own
    // Pointer mode was only ever cleared by exitCinema, so closing a trailer modal (or
    // navigating from the watch page) left body.cursor-on set: the D-pad kept driving
    // an invisible cursor around a page that had no player on it.
    cursorOff();
    tvGlideStop();               // the nodes we were animating are about to be replaced
    watchEnd();                  // stop counting against whatever was playing
    // Re-measure the scrollbar once this view has actually painted. The boot
    // measurement runs against an empty page, where there is no scrollbar to measure
    // yet -- so --sbw stayed 0 and the 100vw hero bled ~5px past the right edge,
    // giving the whole page a horizontal scrollbar until something else resized.
    // Timers, NOT requestAnimationFrame: rAF is suspended in a background tab or a
    // hidden container, which is precisely when a restored page needs re-measuring.
    // Twice, because views render after an await and the second pass catches content
    // that only lands once the network does.
    setTimeout(syncScrollbarWidth, 0);
    setTimeout(syncScrollbarWidth, 350);
    nativeSetPlayer(false);      // every view starts with no player; watchView re-arms it
    const { parts, params } = parseHash();
    watchStart = null;           // a pending Play belongs to the page that drew the poster
    if (parts[0] !== 'watch') { watchLive = false; watchArm = false; }
    document.body.classList.remove('dock-open');   // the player's episode/server dock (TV)
    // TV: a title page keeps the Stage behind it, so the backdrop carries over from Home.
    document.body.classList.toggle('title-page', (parts[0] === 'movie' || parts[0] === 'tv') && !!parts[1]);
    // TV: the grid screens put the Stage behind them too, driven by the focused card.
    const gridPage = parts[0] === 'search' || parts[0] === 'watchlist' || parts[0] === 'person' ||
      ((parts[0] === 'movies' || parts[0] === 'movie' || parts[0] === 'tv' || parts[0] === 'tv-shows') && !parts[1]);
    document.body.classList.toggle('stage-grid', gridPage);
    document.body.classList.remove('st-free', 'st-under');
    clearHero();                 // stop billboard rotation when leaving Home
    // Nothing from the previous screen may outlive it. An open modal would otherwise
    // stay mounted over the new page (browser Back on a playing trailer), and the
    // cinema/player classes would leave `overflow: hidden` and their document
    // listeners on every subsequent page with no way back but a reload.
    document.querySelectorAll('.modal-back').forEach(closeModal);
    // The account menu is an overlay too; left mounted it would sit over the new page.
    closeAcct();
    const resume = resumeCinema; resumeCinema = 0;            // set only by "next episode"; consumed here
    cinemaCarry = IS_TV && parts[0] === 'watch' && document.body.classList.contains('cinema-on');
    if (document.body.classList.contains('cinema-on') || document.body.classList.contains('player-focused')) exitCinema();
    tvGlideStop();               // exitCinema() focuses the frame, which starts a glide of its own
    document.body.classList.toggle('home', !parts.length);
    if (!restore) jumpTop();
    // Same section, different parameters = a filter/sort/page change, not a real
    // navigation, so the ring stays where the user left it.
    // A filter/sort/page change keeps your place; a different SEARCH TERM does not —
    // that is a new result set and the ring belongs on it.
    const viewKey = parts.join('/') + '|' + (params.q || '');
    // A filter or a sort keeps your place. A PAGE change does not: it is a new set of
    // results, and keeping the place left the ring on "Next" at the bottom of the new page.
    const pageKey = viewKey + '|' + (params.page || '1');
    const sameSection = viewKey === routeKey && pageKey === routePageKey;
    routeKey = viewKey; routePageKey = pageKey;
    if (IS_TV) tvFocusFirst(true, sameSection, restore);  // re-establish focus once the new view has rendered
    else if (restore) placeRestoreSoon(restore);
    const sec = parts[0] || 'home';
    setActiveNav(parts[0] === 'tv' ? 'tv' : parts[0] === 'movies' ? 'movies' : parts[0] === 'watchlist' ? 'watchlist' : parts[0] === 'search' ? 'search' : parts[0] === 'account' ? 'account' : 'home');

    if (!parts.length) return homeView();
    switch (parts[0]) {
      case 'movies': return discoverView('movie', params);
      case 'tv':
      case 'tv-shows':
        if (parts[1]) return detailView('tv', parts[1]);
        return discoverView('tv', params);
      case 'movie': return parts[1] ? detailView('movie', parts[1]) : discoverView('movie', params);
      case 'search': return searchView(params);
      case 'person': return personView(parts[1]);
      case 'watch': return watchView(parts[1], parts[2], params, resume);
      case 'watchlist': return watchlistView(params);
      case 'account': return accountView(params);
      case 'get-app': return getAppView();
      default: return homeView();
    }
  }

  /* ============================================================
     Header + global events
     ============================================================ */
  function buildHeader() {
    const hdr = $('header.top');
    // On TV the header is the side rail (stage.css): each item gets an icon and a label
    // that shows when the rail opens. Everywhere else the markup is exactly as before.
    const lb = (t) => IS_TV ? `<span class="lb">${t}</span>` : '';
    hdr.innerHTML = `
      <a class="brand" href="#/" data-nav="#/" aria-label="${esc(cfg.brand)} — home">
        <span class="brand-mark" aria-hidden="true"></span><span class="txt">${esc(cfg.brand)}</span>${lb('Home')}
      </a>
      <nav class="main" aria-label="Primary">
        <a href="#/movies" data-nav="#/movies" data-section="movies">${IS_TV ? ICON.film + lb('Movies') : 'Movies'}</a>
        <a href="#/tv" data-nav="#/tv" data-section="tv">${IS_TV ? ICON.tv + lb('TV Shows') : 'TV Shows'}</a>
      </nav>
      <span class="hdr-gap"></span>
      ${IS_TV ? '' : `<button class="on-stage" id="on-stage" hidden><img alt="" width="28" height="28" decoding="async" hidden><span class="os-k">On stage</span><span class="os-t"></span></button>`}
      <button class="icon-btn" id="search-btn" data-nav="#/search" data-section="search" title="Search" aria-label="Search">${ICON.search}${lb('Search')}</button>
      <a class="icon-btn" href="#/watchlist" data-nav="#/watchlist" data-section="watchlist" title="Watchlist" aria-label="Watchlist">${ICON.bookmark}${lb('Watchlist')}</a>
      <button class="acct-btn" id="acct-btn" data-nav="#/account" data-section="account" title="Account" aria-label="Account and settings">
        <span class="acct-av" aria-hidden="true">${acctFaceHTML()}</span>${lb('Account')}
      </button>`;

    // Search moved out of the header and onto its own page, for every platform.
    // An always-open field competing with the nav is what made the bar feel like a
    // toolbar; an icon that goes somewhere is the same affordance for less room, and
    // the search PAGE can give the field the space it actually wants. The account button
    // likewise goes to its page (data-nav, #/account).

    // Mobile bottom tab bar (hidden on desktop via CSS)
    if (!$('.bottom-nav')) {
      const bn = document.createElement('nav');
      bn.className = 'bottom-nav';
      bn.setAttribute('aria-label', 'Primary');
      bn.innerHTML = `
        <a href="#/movies" data-nav="#/movies" data-section="movies">${ICON.film}<span>Movies</span></a>
        <a href="#/tv" data-nav="#/tv" data-section="tv">${ICON.tv}<span>TV</span></a>
        <a href="#/search" data-nav="#/search" data-section="search">${ICON.search}<span>Search</span></a>
        <a href="#/watchlist" data-nav="#/watchlist" data-section="watchlist">${ICON.bookmark}<span>Saved</span></a>`;
      document.body.appendChild(bn);
    }
    // scroll-aware header: transparent over the Home billboard, frosts on scroll
    const hdrEl = $('header.top');
    const onScroll = () => {
      if (!hdrEl) return;
      hdrEl.classList.toggle('scrolled', window.scrollY > 30);
      // Home with the hero scrolled away: the "On stage" chip takes its place (stage.css).
      const bb = document.body.classList.contains('home') && document.getElementById('billboard');
      hdrEl.classList.toggle('past-hero', !!bb && window.scrollY > bb.offsetHeight - 120);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    applyTheme();
  }

  // Title pages load ahead (titleData): a pointer resting on a card, or a press on one --
  // the tap that follows is ~100ms behind, and on a phone's connection that is most of it.
  if (!IS_TV) {
    document.addEventListener('pointerover', (e) => { if (finePointer()) titlePrefetchFrom(e.target, 220); }, { passive: true });
    document.addEventListener('pointerdown', (e) => titlePrefetchFrom(e.target, 0), { passive: true });
  }

  // Global click delegation
  document.addEventListener('click', (e) => {
    const wl = e.target.closest('[data-wl]');
    if (wl) {
      e.preventDefault(); e.stopPropagation();
      const id = wl.dataset.wl, type = wl.dataset.type;
      const item = itemCache[ck(type, id)] || getWatch().find(x => x.id == id && x.type === type) || { id };
      watchReflect(id, type, toggleWatch(item, type));
      return;
    }
    const tr = e.target.closest('[data-trailer]');
    if (tr) { openTrailer(tr.dataset.trailer); return; }
    // A plain <a href> to another origin: Electron denies window.open outright and
    // Android's main-frame guard swallows it, so the TMDB attribution the API terms
    // require was dead on both. Route every off-origin anchor through the one path
    // that works per platform.
    const ext = e.target.closest('a[href]');
    if (ext && /^https?:/i.test(ext.getAttribute('href') || '')) {
      try {
        if (new URL(ext.href, location.href).origin !== location.origin) {
          e.preventDefault(); openExternal(ext.href); return;
        }
      } catch (e2) { /* unparseable href — fall through to normal handling */ }
    }
    const oe = e.target.closest('[data-openext]');
    if (oe) { e.preventDefault(); openExternal(oe.dataset.openext); return; }
    const ra = e.target.closest('[data-rail]');
    if (ra) {
      const track = ra.parentElement.querySelector('.track, .ep-strip, .season-pills, .cast-track');
      if (track) track.scrollBy({ left: (+ra.dataset.rail) * track.clientWidth * 0.85, behavior: 'smooth' });
      return;
    }
    // A resume rail that can only grow is one you stop trusting: a title you abandoned
    // sits at the front for good. Handled BEFORE [data-nav], because the control lives
    // inside a card that navigates.
    // Mark watched / unwatched. A button INSIDE a [data-nav] row on the show page, so it
    // must stop the row's own click from also opening the player.
    const mk = e.target.closest('[data-mark]');
    if (mk) {
      e.preventDefault(); e.stopPropagation();
      const parts = mk.dataset.mark.split(':');
      const mt = parts[0], mid = parts[1], ms = parts[2] ? +parts[2] : null, me = parts[3] ? +parts[3] : null;
      const wasDone = progDone(progGet(mt, mid, ms, me));
      if (wasDone) progForget(progKey(mt, mid, ms, me));
      else progMarkWatched({ type: mt, id: mid, season: ms, episode: me, title: mk.dataset.title || '',
                             poster_path: mk.dataset.poster || '', d: +(mk.dataset.d || 0) });
      toast(wasDone ? 'Marked unwatched' : 'Marked watched');
      const done = !wasDone;
      mk.setAttribute('aria-pressed', String(done));
      mk.title = done ? 'Mark unwatched' : 'Mark watched';
      mk.setAttribute('aria-label', mk.title);
      if (mk.classList.contains('btn')) mk.innerHTML = ICON.check + (done ? ' Watched' : ' Mark watched');
      // Repaint the row in place rather than rebuilding the page under the user.
      const row = mk.closest('.ep');
      if (row) {
        row.classList.toggle('watched', done);
        const thumb = row.querySelector('.ep-thumb'), tick = row.querySelector('.ep-tick');
        if (done && !tick && thumb) thumb.insertAdjacentHTML('beforeend', `<span class="ep-tick" aria-hidden="true">${ICON.check}</span>`);
        if (!done && tick) tick.remove();
        seasonMarkRefresh();
      }
      return;
    }
    const uw = e.target.closest('[data-unwatch]');
    if (uw) {
      e.preventDefault(); e.stopPropagation();
      // Remember where the ring was BEFORE the tile goes, so it can land on a
      // neighbour rather than being sent back to the top of the page.
      const goneCard = uw.closest('.card');
      const nextCard = goneCard && (goneCard.nextElementSibling || goneCard.previousElementSibling);
      // A grouped tile stands for every episode of that series, so dismiss all of them.
      if (uw.dataset.unwatchGroup) progForgetGroup(uw.dataset.unwatchGroup);
      else progForget(uw.dataset.unwatch);
      const card = uw.closest('.card'), rail = uw.closest('.rail');
      if (card) card.remove();
      // The last one out takes the rail with it, rather than leaving a bare heading.
      if (rail && !rail.querySelector('.card')) rail.remove();
      if (IS_TV) {
        tvInvalidate();
        // Land on the neighbour, not back at the top. tvFocusFirst() sends the ring to
        // the billboard and scrolls Home with it, so dismissing three tiles in a row
        // meant scrolling back down to the rail three times.
        if (nextCard && document.contains(nextCard)) tvFocusEl(nextCard);
        else tvRestoreFocus();
      }
      toast('Removed from Continue watching');
      return;
    }
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      e.preventDefault();
      // A mouse click does not always move focus (Safari), so go() alone could miss it.
      if (nav.hasAttribute('data-play')) watchArm = true;
      go(nav.dataset.nav, nav.hasAttribute('data-back')); return;
    }
  });

  // Keyboard / D-pad OK: activate any focused [data-nav] element (cards, cast,
  // episodes, nav links, search rows). Native buttons/inputs handle Enter themselves.
  // The browser build has no hardware Back, so Escape is the way out of the player.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('.modal-back')) {
      if (dockClose()) { e.preventDefault(); return; }
      // A running countdown owns the first Back: cancel it and stay where you are. (Only the
      // COUNTDOWN -- the plain three-minute prompt must not eat a Back press.)
      if (nextUpCount) { e.preventDefault(); nextUpDismissed = true; nextUpHide(); return; }
      // The same as hardware Back -- one press leaves the player -- so a keyboard and a
      // remote do not disagree about what Escape means.
      if (cursorActive() || document.body.classList.contains('cinema-on')) {
        e.preventDefault(); exitCinema();      // TV: back to the watch page, ring on the picture
        return;
      }
      // ...and in the TV side rail, Escape closes it, like hardware Back.
      const ae = document.activeElement;
      if (IS_TV && ae && ae.closest && ae.closest('header.top')) { e.preventDefault(); railLeave(); return; }
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (cursorActive()) { e.preventDefault(); if (!e.repeat) cursorTap(); return; }   // a held key is never a second tap
    const el = document.activeElement;
    if (el && el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      // Blink toggles these on Space only (unless the WebView has spatial navigation on), so OK on
      // a remote did nothing to the first checkbox this app has ever had. preventDefault stops
      // spatial-nav turning the same press into a second click.
      if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) el.click(); }
      return;
    }
    if (!el || /^(INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY)$/.test(el.tagName)) return; // native handles these
    // The frame is a target on the TV watch page: OK brings the pointer back up over
    // the mirror's controls, which is the only way to resume without re-rendering.
    if (el.classList && el.classList.contains('player-frame')) { e.preventDefault(); cursorOn(); return; }
    const nav = el.closest && el.closest('[data-nav]');
    if (!nav) return;
    e.preventDefault();
    // TV: OK on a title is a PRESS or a HOLD, and only keyup can tell them apart.
    if (IS_TV && e.key === 'Enter' && !okLegacy && nav.matches(QA_TARGETS)) {
      if (e.repeat) return;                                  // still the same press
      if (okTarget && !okUpSeen) {
        // A keydown while a press is still armed. Soon after the first it is an UNFLAGGED
        // repeat of the same hold -- ignore it. Only later can it be what it looks like: a new
        // press whose predecessor never got a keyup, i.e. a WebView that does not send them.
        if (Date.now() - okDownAt < OK_LEGACY_AFTER) return;
        okLegacy = true; clearTimeout(okTimer); okTarget = null;
        go(nav.dataset.nav); return;                         // navigate on keydown from now on
      }
      okTarget = nav; okUpSeen = false; okHeld = false; okDownAt = Date.now();
      clearTimeout(okTimer);
      okTimer = setTimeout(() => okHold(nav), OK_HOLD_MS);
      return;
    }
    go(nav.dataset.nav);
  });
  /** The hold has happened -- by our own timer, or because the native layer said so. */
  function okHold(nav) {
    nav = nav || okTarget;
    if (!nav || okHeld || okUpSeen || okTarget !== nav || !document.contains(nav)) return;
    clearTimeout(okTimer);
    okHeld = true; okSwallow = true;
    openQuickActions(nav);
  }
  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Enter') return;
    okSwallow = false; okUpEver = true;
    if (!okTarget) return;
    okUpSeen = true;
    clearTimeout(okTimer);
    const t = okTarget, held = okHeld; okTarget = null; okHeld = false;
    if (!held && document.contains(t)) go(t.dataset.nav);
  });
  // While OK is STILL held after the sheet opens, its key-repeat must not reach the sheet:
  // Enter activates a focused button on keydown, so the hold would press "Play" by itself.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = Date.now(), rapid = t - okLastDown < OK_RAPID;
    okLastDown = t;
    if (okSwallow) {
      // A WebView that has NEVER sent an Enter keyup cannot clear the swallow that way, and OK
      // stayed dead for the whole session. There, a keydown that is plainly a new press (not
      // flagged, not rapid) ends the hold. Where keyups do arrive, only the keyup ends it.
      if (!okUpEver && !e.repeat && !rapid) { okSwallow = false; return; }
      e.preventDefault(); e.stopPropagation(); return;
    }
    // On a TV a held OK is ONE press. Enter activates a focused <button> on every keydown,
    // repeats included: a firm OK on the sheet's "Details" went on to press "Watch now" on the
    // page it opened, and one on "Resume" reached the player as a burst of pointer taps.
    // Fields are left alone -- OK on an empty input is how Android raises the soft keyboard.
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
    if (IS_TV && (e.repeat || rapid) && !field) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  /* ---- Long-press (touch) ----------------------------------------------------------
     The same sheet, reached the way a phone expects. It is what lets the bookmark disc
     come off every poster: saving is a long-press away, and the artwork is unobstructed.
     The click that follows the lift lands on whatever is NOW under the finger -- the
     sheet -- so exactly one click is swallowed after the sheet opens. */
  let lpTimer = 0, lpAt = null, lpFired = false, lpClear = 0;
  const lpStop = () => { clearTimeout(lpTimer); lpTimer = 0; };
  // The swallow belongs to the click of THIS gesture's lift, so it is timed from the lift. Timed
  // from the sheet opening it was too long and too short at once. Too long: Android sends NO
  // click after a long-press, so the flag sat armed and ate the first real tap on the sheet.
  // Too short: a 1.5s hold outlived it, and the lift pressed whichever row was under the finger.
  const lpArm = (ms) => { clearTimeout(lpClear); lpClear = setTimeout(() => { lpFired = false; }, ms); };
  const lpLift = () => { lpStop(); if (lpFired) lpArm(700); };
  document.addEventListener('touchstart', (e) => {
    lpFired = false; clearTimeout(lpClear);                  // a new touch: the long-press gesture is over
    if (IS_TV || !e.touches || e.touches.length !== 1) return lpStop();
    const card = e.target.closest && e.target.closest(QA_TARGETS);
    // A button inside a card (the episode mark, the dismiss cross) keeps its own tap.
    if (!card || e.target.closest('button, a.who') || document.querySelector('.modal-back')) return lpStop();
    lpAt = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    lpStop();
    lpTimer = setTimeout(() => {
      lpTimer = 0; lpFired = true; lpArm(10000);             // backstop only, for a lift we never hear about
      try { if (navigator.vibrate) navigator.vibrate(10); } catch (e2) {}
      openQuickActions(card);
    }, 520);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!lpTimer || !lpAt || !e.touches[0]) return;
    if (Math.abs(e.touches[0].clientX - lpAt.x) > 10 || Math.abs(e.touches[0].clientY - lpAt.y) > 10) lpStop();   // a scroll, not a press
  }, { passive: true });
  document.addEventListener('touchend', lpLift, { passive: true });
  document.addEventListener('touchcancel', lpLift, { passive: true });
  document.addEventListener('click', (e) => {
    if (!lpFired) return;
    lpFired = false; e.preventDefault(); e.stopPropagation();
  }, true);
  // Android answers a long-press on an image with its own "Download image" menu.
  document.addEventListener('contextmenu', (e) => {
    if (!IS_TV && matchMedia('(hover: none)').matches && e.target.closest && e.target.closest(QA_TARGETS)) e.preventDefault();
  });

  /* ---- Quick actions (TV, hold OK) -----------------------------------------------
     Everything a pointer reaches with a hover button, for a remote: watchlist, mark watched,
     and -- the one that had no TV route at all -- taking a title off Continue watching. */
  /** The season button describes the rows as painted: every .ep ticked -> offer to unmark. */
  function seasonMarkRefresh() {
    const list = document.getElementById('ep-list'), sm = document.getElementById('season-mark');
    if (!list || !sm || !sm.dataset.n) return;
    const all = list.querySelectorAll('.ep').length, seen = list.querySelectorAll('.ep.watched').length;
    const whole = all > 0 && seen === all;
    sm.textContent = whole ? 'Unmark season ' + sm.dataset.n : 'Mark season ' + sm.dataset.n + ' watched';
    sm.setAttribute('aria-pressed', String(whole));
  }
  /**
   * Make the page agree with storage after a watchlist toggle. Shared by the bookmark click and
   * the quick-actions sheet: a Continue-watching tile has no bookmark to click, and on a phone
   * the poster's button is display:none, so the sheet cannot lean on the button.
   */
  function watchReflect(id, type, nowOn) {
    document.querySelectorAll(`[data-wl="${id}"][data-type="${type}"]`).forEach(b => {
      b.classList.toggle('on', nowOn);
      b.setAttribute('aria-pressed', String(nowOn));
      b.setAttribute('aria-label', (nowOn ? 'Remove from' : 'Add to') + ' watchlist');
      b.setAttribute('title', (nowOn ? 'Remove from' : 'Add to') + ' watchlist');
      // The billboard's button uses a check/plus pair, not the bookmark pair.
      if (b.closest('.bb-cta')) { b.innerHTML = nowOn ? ICON.check : ICON.plus; return; }
      if (b.id === 'detail-wl') { b.classList.toggle('primary', nowOn); b.innerHTML = (nowOn ? ICON.bookmarkFill : ICON.bookmark) + ' ' + (nowOn ? 'In watchlist' : 'Watchlist'); }
      else b.innerHTML = nowOn ? ICON.bookmarkFill : ICON.bookmark;
    });
    // parts[0], not a substring of the hash: searching for the word "watchlist" and saving a
    // result used to re-render the whole search view. A PLACE is handed over so the re-render
    // neither jumps a phone to the top nor drops the TV ring.
    if (parseHash().parts[0] === 'watchlist') {
      route({ y: window.scrollY || 0, lefts: [], nav: '', ni: -1, ci: -1, pos: tvLastPos ? { x: tvLastPos.x, cy: tvLastPos.cy } : null });
    }
  }
  function openQuickActions(card) {
    if (document.querySelector('.modal-back')) return;
    const nav = card.dataset.nav || '';
    const m = /^#\/(watch\/)?(movie|tv)\/(\d+)(?:\?(.*))?$/.exec(nav);
    if (!m) { go(nav); return; }
    const isWatch = !!m[1], type = m[2], id = m[3];
    const q = {}; new URLSearchParams(m[4] || '').forEach((v, k) => { q[k] = v; });
    const isEp = type === 'tv' && isWatch && q.s && q.e && card.classList.contains('ep');
    const item = itemCache[ck(type, id)] || {};
    // The tile's OWN text, never a piece of its aria-label: that label is "Monsters, Inc., 54m
    // left, ..." and splitting it at the comma stored "Monsters" as the title -- and synced it.
    const shown = ((card.querySelector('.cw-t, .ch-title, .et') || {}).textContent || '').trim();
    const title = item.title || item.name || shown;
    const saved = isInWatch(id, type);
    const inCW = card.classList.contains('cw-card');
    const prKey = isEp ? ['tv', id, +q.s, +q.e] : (type === 'movie' ? ['movie', id, null, null] : null);
    const seen = prKey ? progDone(progGet.apply(null, prKey)) : false;
    const btn = (act, icon, text) => `<button class="qa-item" data-qa="${act}">${icon}<span>${text}</span></button>`;
    const back = document.createElement('div');
    back.className = 'modal-back qa-back';
    back.innerHTML = `<div class="modal qa">
      <div class="mh"><h3>${esc(isEp ? ('S' + q.s + ' \u00b7 E' + q.e) : title)}</h3></div>
      <div class="mb qa-list">
        ${btn('play', ICON.play, isWatch ? (inCW ? 'Resume' : 'Play') : 'Play')}
        ${isEp ? '' : btn('open', ICON.info, 'Details')}
        ${isEp || !item.id ? '' : btn('save', saved ? ICON.bookmarkFill : ICON.bookmark, saved ? 'Remove from watchlist' : 'Add to watchlist')}
        ${prKey ? btn('seen', ICON.check, seen ? 'Mark unwatched' : 'Mark watched') : ''}
        ${inCW ? btn('forget', ICON.x, 'Remove from Continue watching') : ''}
      </div>
    </div>`;
    modalMount(back);
    back.querySelector('.qa-list').onclick = (ev) => {
      const b = ev.target.closest('[data-qa]'); if (!b) return;
      const act = b.dataset.qa;
      if (act === 'forget') {
        // Same steps as the pointer's dismiss button: neighbour first, then the card.
        const next = card.nextElementSibling || card.previousElementSibling, rail = card.closest('.rail');
        back._opener = null;
        closeModal(back);
        progForgetGroup(type + ':' + id);
        card.remove();
        if (rail && !rail.querySelector('.card')) rail.remove();
        if (IS_TV) { tvInvalidate(); if (next && document.contains(next)) tvFocusEl(next); else tvRestoreFocus(); }
        toast('Removed from Continue watching');
        return;
      }
      closeModal(back);
      if (act === 'play') go(isWatch ? nav : watchHref(type, id));
      else if (act === 'open') go('#/' + type + '/' + id);
      else if (act === 'save') watchReflect(id, type, toggleWatch(item, type));
      else if (act === 'seen') {
        if (seen) progForget(progKey.apply(null, prKey));
        // histPush keeps the stored title when none is given, so an unknown one is left empty.
        else progMarkWatched({ type: type, id: id, season: prKey[2], episode: prKey[3], title: item.title || item.name || (isEp ? '' : shown), poster_path: item.poster_path || '' });
        toast(seen ? 'Marked unwatched' : 'Marked watched');
        if (isEp) {
          card.classList.toggle('watched', !seen);
          const th = card.querySelector('.ep-thumb'), tick = card.querySelector('.ep-tick');
          if (!seen && !tick && th) th.insertAdjacentHTML('beforeend', `<span class="ep-tick" aria-hidden="true">${ICON.check}</span>`);
          if (seen && tick) tick.remove();
          const em = card.querySelector('.ep-mark');            // phone/desktop only; not rendered on TV
          if (em) { const t = seen ? 'Mark watched' : 'Mark unwatched'; em.setAttribute('aria-pressed', String(!seen)); em.title = t; em.setAttribute('aria-label', t); }
          seasonMarkRefresh();
        } else if (inCW && seen) {
          // Mark UNWATCHED drops the history row too, so this tile no longer exists on a fresh
          // Home. Take it off now -- the dismiss steps, neighbour first.
          const next = card.nextElementSibling || card.previousElementSibling, rail = card.closest('.rail');
          card.remove();
          if (rail && !rail.querySelector('.card')) rail.remove();
          if (IS_TV) { tvInvalidate(); if (next && document.contains(next)) tvFocusEl(next); else tvRestoreFocus(); }
        } else if (inCW) {
          const sub = card.querySelector('.cw-s'), poster = card.querySelector('.poster');
          if (sub) sub.textContent = 'Watched';
          if (poster && !card.querySelector('.card-prog')) poster.insertAdjacentHTML('beforeend', '<span class="card-prog"><i></i></span>');
          const bar = card.querySelector('.card-prog i'); if (bar) bar.style.width = '100%';
          card.setAttribute('aria-label', (title || 'title') + ', Watched, watched just now');
        } else {
          // An unstarted title has no bar to fill (cardHTML omits it under 1%), which is the
          // common case: make one. Unwatched removes it, as a fresh render would.
          let prog = card.querySelector('.card-prog');
          if (seen) { if (prog) prog.remove(); }
          else {
            const poster = card.querySelector('.poster');
            if (!prog && poster) { poster.insertAdjacentHTML('beforeend', '<span class="card-prog" role="img"><i></i></span>'); prog = poster.querySelector('.card-prog'); }
            if (prog) { prog.setAttribute('aria-label', '100 percent watched'); prog.firstElementChild.style.width = '100%'; }
          }
          // Watchlist: the Unwatched filter and its count are stale now. Same hand-over as watchReflect.
          if (parseHash().parts[0] === 'watchlist') route({ y: window.scrollY || 0, lefts: [], nav: '', ni: -1, ci: -1, pos: tvLastPos ? { x: tvLastPos.x, cy: tvLastPos.cy } : null });
        }
      }
    };
  }

  /* ============================================================
     Boot
     ============================================================ */
  // Our own history depth. hashchange fires for both forward navigation and Back, so
  // compare against the hash we last saw going forward.
  let navDepth = 0, navSeen = [location.hash || '#/'];
  // The hero bleeds edge-to-edge with 100vw, which counts the classic scrollbar the
  // layout box does not have — 5px of horizontal overflow at each edge on any platform
  // that shows one. Measure it and let CSS subtract it.
  function syncScrollbarWidth() {
    const cw = document.documentElement.clientWidth;
    // A zero client width means the document is not laid out yet, or is inside a
    // hidden container. The old `|| innerWidth` fallback turned that into a confident
    // --sbw of 0, which is indistinguishable from "measured, and there is no
    // scrollbar" -- so the 100vw hero kept its 5px of overflow with nothing to
    // correct it. Record nothing instead and let a later call do the measuring.
    if (!cw) return;
    document.documentElement.style.setProperty('--sbw', Math.max(0, window.innerWidth - cw) + 'px');
  }
  syncScrollbarWidth();
  // At boot the page is empty, so there is no scrollbar to measure yet — recompute when
  // the rendered content changes the document height, not just on viewport resize.
  const syncSbw = debounce(syncScrollbarWidth, 120);
  window.addEventListener('resize', syncSbw);
  if (window.ResizeObserver) { try { new ResizeObserver(syncSbw).observe(document.body); } catch (e) {} }

  /* ---- Place memory ----------------------------------------------------------------
     What a page looked like when you left it FORWARD, so Back can put it back: the scroll,
     every rail's own scroll, and (on a TV) which poster held the ring. Keyed by hash, a
     dozen deep, memory only. The DOM is still the old page when hashchange fires -- route()
     has not run yet -- which is what makes it possible to read all this here. */
  const PLACE_MAX = 12, PLACE_SCROLLERS = '.track, .cast-track, .ep-strip, .season-pills';
  const placeMemo = new Map();
  function placeSave(hash) {
    const root = view(); if (!root || !hash) return;
    const conts = [].slice.call(root.querySelectorAll(PLACE_SCROLLERS));
    const a = document.activeElement, inView = !!(a && root.contains(a));
    const place = { y: window.scrollY || 0, lefts: conts.map(c => c.scrollLeft), nav: '', ni: -1, ci: -1, pos: null };
    if (inView) {
      place.nav = (a.dataset && a.dataset.nav) || '';
      place.ci = conts.indexOf(a.closest(PLACE_SCROLLERS));   // the same title can sit in two rails
      // ...or twice in a GRID, which is not a scroller: a writer-director's page lists one film
      // under Directing and again under Writing. Which of the same-nav elements was it?
      if (place.nav) place.ni = [].indexOf.call(root.querySelectorAll(placeSel(place.nav)), a);
      place.pos = tvLastPos ? { x: tvLastPos.x, cy: tvLastPos.cy } : null;
    }
    placeMemo.delete(hash); placeMemo.set(hash, place);
    while (placeMemo.size > PLACE_MAX) placeMemo.delete(placeMemo.keys().next().value);
  }
  const placeSel = (nav) => '[data-nav="' + nav.replace(/["\\]/g, '\\$&') + '"]';
  /** true = applied; 'wait' = the view has not rendered yet; false = nothing to apply to. */
  function placeApply(place) {
    const root = view(); if (!root) return false;
    if (root.querySelector('.sk')) return 'wait';
    const conts = [].slice.call(root.querySelectorAll(PLACE_SCROLLERS));
    if (place.lefts.length && !conts.length) return root.children.length ? false : 'wait';
    conts.forEach((c, i) => {
      if (!place.lefts[i]) return;
      try { c.scrollTo({ left: place.lefts[i], behavior: 'instant' }); } catch (e) { c.scrollLeft = place.lefts[i]; }
    });
    // Anything still gliding (the player's exit, the 1200ms park on the nav bar) would go on
    // writing scrollTo AFTER this and drag the page to the top with the ring off screen.
    tvGlideStop();
    try { window.scrollTo({ top: place.y, behavior: 'instant' }); } catch (e) { window.scrollTo(0, place.y); }
    if (!IS_TV) return true;
    // Left from the HEADER: there is no poster to return to and no position worth trusting
    // (tvLastPos belongs to the page being left). Let the caller land the normal way.
    if (!place.nav && !place.pos) return false;
    tvInvalidate(); tvEnsureFocusable();
    let el = null;
    if (place.nav) {
      const sel = placeSel(place.nav), c = conts[place.ci], all = root.querySelectorAll(sel);
      el = (c && c.querySelector(sel)) || all[place.ni] || all[0];
    }
    if (el && tvVisible(el)) { tvFocusEl(el); return true; }
    // The poster is gone (trending moved on): the nearest thing to where it WAS.
    if (place.pos) tvLastPos = place.pos;
    return tvRestoreFocus() ? true : false;
  }
  /** Phones and desktops: wait for the view, then restore -- unless the user scrolls first. */
  function placeRestoreSoon(place) {
    const my = routeSeq, root = view(); if (!root) return;
    let live = true;
    const cancel = () => { live = false; };
    // Not keydown: Alt+Left IS a keydown, and it is how a desktop goes Back.
    ['wheel', 'touchstart'].forEach(ev => window.addEventListener(ev, cancel, { once: true, passive: true }));
    const tryIt = () => (!live || !routeIs(my)) ? true : placeApply(place) !== 'wait';
    // NEVER tried synchronously: at this point the DOM is still the page being left, and
    // applying to it "succeeds". Only a mutation of the view means the new page exists.
    const mo = new MutationObserver(() => { if (tryIt()) mo.disconnect(); });
    mo.observe(root, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 8000);
  }

  window.addEventListener('hashchange', () => {
    const h = location.hash || '#/';
    const viaGo = goQueue.length > 0, backIntent = viaGo && goQueue.shift() === 1;
    let restore = null;
    // Only a REAL traversal pops. A go() navigation is a new history entry whatever its hash,
    // so it always SAVES the page being left and pushes: film B -> "film A" on B's own rail ->
    // Back used to open B at the top, because the click had been booked as a Back and B was
    // never saved. navDepth is now the real session-history depth, which is what the hardware
    // Back handler needs before it calls history.back().
    if (!viaGo && navDepth > 0 && navSeen[navDepth - 1] === h) { navSeen.pop(); navDepth--; restore = placeMemo.get(h) || null; }
    else {
      placeSave(navSeen[navDepth]); navSeen[navDepth] = navSeen[navDepth] || h; navSeen[++navDepth] = h;
      if (backIntent) restore = placeMemo.get(h) || null;      // "Back to details" puts you back in the episode list
    }
    route(restore);
  });
  /**
   * First render. Declared here, CALLED FROM THE BOTTOM OF THE MODULE.
   *
   * Do not move the call back up. Everything here can reach a TV helper -- accessShow()
   * places the D-pad ring, route() measures rows -- and those helpers close over `const`
   * and `let` bindings declared further down the file. Calling boot() from this point
   * threw a ReferenceError out of the top level and abandoned the rest of module init,
   * which is what silently stripped the `tv` body class and the D-pad keydown listener
   * from every signed-out TV launch.
   */
  function boot() {
    if (!IS_TV) nativeSend('orient:auto');     // a reload mid-film must not leave the app locked sideways
    buildHeader();
    newEpWatch();
    route();
    // Every view builds its rails asynchronously, so watch for them rather than trying
    // to find a single point after which they all exist.
    if (window.MutationObserver) {
      try {
        new MutationObserver(wireRailChromeSoon)
          .observe(document.getElementById('view') || document.body, { childList: true, subtree: true });
      } catch (e) {}
    }
    wireRailChromeSoon();
    wireSync();
    // After the first paint, never before it: an existing install already has the table
    // and must not wait on a network call to render. The access check goes first: if this
    // device needs a code, the lock goes up and the servers are wiped before they are used.
    accessCheck().catch(() => {});
    refreshSources().catch(() => {});
  }

  // PWA: register service worker so the app is installable ("Add to Home Screen").
  // No-ops on file:// (SW not allowed there) — serve over http/https or the desktop app.
  if ('serviceWorker' in navigator) {
    // NOT in the desktop app. It loads its files from its own package, so a cache adds nothing --
    // and the SW is cache-first for ?v= URLs, so a release that changed app.js without moving ?v
    // would have kept desktops on the old file for good. Any worker an earlier version left is removed.
    if (IS_DESKTOP) navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
    else window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // Silent update check on launch (web/Android). Desktop uses electron-updater.
  if (!IS_DESKTOP) setTimeout(() => checkForUpdate(false), 1500);

  // ---- Update UI ---------------------------------------------------------
  // One persistent banner drives EVERY state so the user always gets feedback
  // (the old code wrote status into a Settings element we later removed, so
  // errors and progress were invisible). Works for desktop (electron-updater
  // events) and web/Android (GitHub Releases API).
  let updInteractive = false;   // was the current check triggered by the button?

  /**
   * Put the dot on the account button, and rebuild the menu row if it is open.
   *
   * This is the whole of the passive update UI now. An update is never urgent enough to
   * take over the bottom of the screen, and on a TV the banner was pinned chrome that the
   * D-pad had to be steered onto before it could be dismissed.
   */
  function updBadge() {
    const on = updState.s === 'available' || updState.s === 'ready';
    const b = document.getElementById('acct-btn');
    if (b) b.classList.toggle('has-dot', on);
    const item = document.querySelector('#acct-menu [data-am="settings"]');
    if (item) item.classList.toggle('has-dot', on);
  }

  // Only ever reached from an interactive check: the user pressed a button, so say
  // something. Toasts already sit above the player and the cinema frame.
  function updChecking() { if (updInteractive) toast('Checking for updates…'); }
  function updNone() { if (updInteractive) toast('You’re on the latest version (v' + APP_VERSION + ').'); }
  // A failed check the user did not ask for is not news. Settings shows the error for
  // anyone who goes looking, via renderUpdBox.
  function updError(msg) { if (updInteractive) toast(msg || 'Update check failed — try again later.'); }
  // Progress belongs in Settings, which renderUpdBox already draws and updates in place.
  function updDownloading() {}
  function updReady(version) {
    updBadge();
    // One line, once, and then it is in the menu waiting. Restarting the app is the
    // user's call and there is no hurry.
    toast('Update ' + (version ? 'v' + version + ' ' : '') + 'ready · Settings → Restart & update');
  }
  // The banner ANNOUNCES; Settings is where you act. On a TV the banner is pinned
  // chrome that lands wherever the row model puts it, so hunting for its button with
  // a remote was the worst part of updating — and the button went to the sideload
  // instructions, which is not something you can follow on the device you are holding.
  function updWebAvailable(version) {
    updSet('available', { v: version });     // updSet -> renderUpdBox + updBadge
    // Only speak up if the user asked. Otherwise the dot is the entire announcement.
    if (updInteractive) toast('Update available · v' + version);
  }

  function updSet(st, extra) {
    updState = Object.assign({ s: st, v: updState.v, pct: 0, msg: '' }, extra || {});
    updState.s = st;
    renderUpdBox();
    updBadge();
  }
  // Only the Android build can install itself: it has the bridge, the permission and
  // a package installer. Desktop hands off to electron-updater; the plain web build
  // has nowhere to put an APK.
  function updCanInstall() { return !IS_DESKTOP && NATIVE_TAP; }

  function renderUpdBox() {
    const box = document.getElementById('set-upd');
    if (!box) return;
    const st = updState;
    // A percentage tick must not replace the DOM the ring is standing on — at one
    // re-render per percent that would fight the remote a hundred times a download.
    if (st.s === 'downloading' && box.dataset.s === 'downloading') {
      const bar = box.querySelector('.ub-bar i'); if (bar) bar.style.width = st.pct + '%';
      const t = box.querySelector('.upd-t'); if (t) t.textContent = 'Downloading update… ' + st.pct + '%';
      return;
    }
    const hadFocus = box.contains(document.activeElement);
    let html;
    if (st.s === 'checking') {
      html = '<p class="upd-t"><span class="ub-spin"></span>Checking for updates…</p>';
    } else if (st.s === 'downloading') {
      // A button, ALWAYS. This state used to have none, so pressing Download & install
      // removed the only target under the ring and the remote went dead for the length
      // of the download -- on a TV that reads as the app freezing, and the user's fix
      // was Back, find the button again, press it again. The download had been running
      // the whole time and the installer opens by itself when it lands, so say so.
      html = '<p class="upd-t">Downloading update… ' + st.pct + '%</p>' +
             '<div class="ub-bar"><i style="width:' + st.pct + '%"></i></div>' +
             '<p class="upd-t upd-sub">The installer opens on its own when this finishes — you can keep browsing meanwhile.</p>' +
             '<button class="btn sm" id="upd-hide">Keep browsing</button>';
    } else if (st.s === 'ready') {
      html = '<p class="upd-t">Update ready.</p><button class="btn sm primary" id="upd-go">Restart &amp; update</button>';
    } else if (st.s === 'done') {
      // Native reports 'done' the moment startActivity() does not throw, which is
      // BEFORE the user has accepted or cancelled. Cancelling used to leave a message
      // with no button; offer the retry here rather than making them find the header.
      html = '<p class="upd-t">Installer opened — confirm it on screen to finish.</p>' +
             '<p class="upd-t upd-warn">If it says <b>App not installed</b>, this copy was signed with a ' +
             'different key to the new one. Uninstall Reeldeck and install again — once only; ' +
             'later updates will apply normally.</p>' +
             '<button class="btn sm" id="upd-go">Install again</button>';
    } else if (st.s === 'error') {
      html = '<p class="upd-t upd-warn">' + esc(st.msg || 'Update failed.') + '</p>' +
             '<button class="btn sm primary" id="upd-go">Try again</button>';
    } else if (st.s === 'available') {
      html = '<p class="upd-t">Version <b>v' + esc(st.v || '') + '</b> is available.</p>' +
             '<button class="btn sm primary" id="upd-go">' +
             (updCanInstall() ? 'Download &amp; install' : IS_DESKTOP ? 'Download &amp; restart' : 'How to install') +
             '</button>';
    } else if (st.s === 'portable') {
      html = '<p class="upd-t">This is the portable build — it updates by downloading a new copy.</p>' +
             '<button class="btn sm" id="upd-rel">Open Releases</button>';
    } else if (st.s === 'none') {
      html = '<p class="upd-t">You are on the latest version.</p><button class="btn sm" id="upd-check">Check again</button>';
    } else {
      html = '<button class="btn sm" id="upd-check">Check for updates</button>';
    }
    box.innerHTML = html;
    box.dataset.s = st.s;
    const c = box.querySelector('#upd-check'); if (c) c.onclick = () => checkForUpdate(true, true);
    const rl = box.querySelector('#upd-rel');
    if (rl) rl.onclick = () => openExternal('https://github.com/' + REPO + '/releases/latest');
    const g = box.querySelector('#upd-go');    if (g) g.onclick = updInstall;
    const h = box.querySelector('#upd-hide');
    if (h) h.onclick = () => { const m = box.closest('.modal-back'); if (m) closeModal(m); };
    if (IS_TV) tvInvalidate();
    // The button we were standing on has just been replaced. Put the ring on its
    // successor, or focus falls back to <body> and the remote goes dead mid-update.
    if (hadFocus) {
      const b = box.querySelector('button');
      if (b) { if (IS_TV) tvFocusEl(b); else { try { b.focus(); } catch (e) {} } }
    }
  }

  function updInstall() {
    if (IS_DESKTOP) {
      if (updState.s === 'ready' && window.reeldeck && window.reeldeck.installUpdate) window.reeldeck.installUpdate();
      else checkForUpdate(true, true);
      return;
    }
    if (!updCanInstall()) {   // plain web build: nowhere to put an APK
      const m = document.querySelector('.modal-back'); if (m) closeModal(m);
      go('#/get-app'); return;
    }
    if (updState.s === 'downloading') return;   // one download at a time; native drops repeats anyway
    updSet('downloading', { pct: 0 });
    nativeSend('update:' + APK_URL);
  }

  // Desktop auto-update: drive the banner from main-process (electron-updater) events.
  // 'available'/'downloading'/'ready' always show (a real update is worth surfacing);
  // 'none'/'error' only show when the user actually pressed the button (so the silent
  // launch check and the 6-hour timer don't nag).
  if (window.reeldeck && window.reeldeck.onUpdate) {
    window.reeldeck.onUpdate((d) => {
      if (!d) return;
      // Drive the Settings panel from the same events, so the two cannot disagree.
      if (d.state === 'checking') { updSet('checking'); if (updInteractive) updChecking(); }
      else if (d.state === 'available') { updSet('downloading', { pct: 0, v: d.version }); updDownloading(0); }
      else if (d.state === 'downloading') { updSet('downloading', { pct: d.percent || 0 }); updDownloading(d.percent); }
      else if (d.state === 'ready') { updSet('ready', { v: d.version }); updReady(d.version); updInteractive = false; }
      else if (d.state === 'none') { updSet('none'); if (updInteractive) updNone(); updInteractive = false; }
      else if (d.state === 'error') {
        // main.js already sends one sentence; an older desktop build sends the whole
        // electron-updater error, headers and all. One line, capped, either way.
        const m = String(d.message || 'try again later.').split('\n')[0].slice(0, 140);
        updSet('error', { msg: m });
        if (updInteractive) updError(m);
        updInteractive = false;
      }
      // The portable exe cannot replace itself; electron-updater would install a
      // second, separate copy and leave this one running and stale.
      else if (d.state === 'portable') updSet('portable');
    });
  }

  function verCmp(a, b) {
    const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; }
    return 0;
  }
  // Cross-platform update check. Desktop hands off to electron-updater (events above);
  // web/Android queries the GitHub Releases API and offers a manual install.
  // `quiet` = the Settings panel is already showing progress, so don't also float a
  // banner over it saying the same thing.
  async function checkForUpdate(interactive, quiet) {
    if (IS_DESKTOP && window.reeldeck && window.reeldeck.checkForUpdates) {
      updInteractive = !!interactive && !quiet;
      if (interactive && !quiet) updChecking();
      window.reeldeck.checkForUpdates();
      return;
    }
    if (interactive) { updSet('checking'); if (!quiet) updChecking(); }
    try {
      const r = await fetchTimeout('https://api.github.com/repos/' + REPO + '/releases/latest',
        { headers: { Accept: 'application/vnd.github+json' } }, 8000);
      if (!r.ok) throw new Error('http ' + r.status);
      const d = await r.json();
      const latest = (d.tag_name || '').replace(/^v/, '');
      if (latest && verCmp(latest, APP_VERSION) > 0) updWebAvailable(latest);
      else if (interactive) { updSet('none'); if (!quiet) updNone(); }
    } catch (e) {
      if (interactive) {
        updSet('error', { msg: 'Update check failed — check your connection.' });
        if (!quiet) updError('Update check failed — check your connection.');
      }
    }
  }

  /* ---------- TV / D-pad navigation (Android TV, Google TV) ---------- */
  // TV_FOCUSABLE, tvObserver and tvTimeout are declared near the top of this file
  // (right after IS_TV) so they're initialized before the first render calls these.

  // Nav links are <a data-nav> with NO href and NO tabindex — which means they are
  // NOT focusable, so el.focus() silently no-ops and the D-pad can never land on the
  // header/bottom nav (the "can't reach Home/Movies/TV" bug). Give every [data-nav]
  // that lacks an explicit tabindex one, so the whole nav surface is reachable.
  let tvFocusableGen = -1;
  function tvEnsureFocusable() {
    if (!IS_TV || tvFocusableGen === tvDomGen) return;   // nothing new since the last sweep
    tvFocusableGen = tvDomGen;
    document.querySelectorAll('[data-nav]:not([tabindex])').forEach(el => el.setAttribute('tabindex', '0'));
  }

  // An element is only a D-pad target if it is really on screen. Hidden billboard
  // slides keep their layout box, so a size check alone is not enough — they are
  // hidden with `visibility`, which inherits, which is exactly why we test for it.
  function tvVisible(el) {
    return !!tvMeasure(el);
  }

  // Returns the element's rect if it is a legitimate D-pad target, else null. Kept as
  // ONE layout read because tvRowModel calls it for every focusable on every keypress.
  // A display:none element reports an all-zero rect, so the size test covers that too.
  function tvMeasure(el) {
    // The cross-origin player is handed focus deliberately by enterPlayerFocus, never
    // by the row model. Excluding it here means a stale tabindex="0" left behind by
    // navigating away mid-playback cannot turn it into a D-pad target.
    if (el.id === 'player-iframe') return null;
    // Cinema mode fixes the player over the WHOLE viewport at z-index 300, but the
    // page behind it is still laid out and still passes every test below -- so the
    // header, the mirror tiles and the episode nav stayed live D-pad targets hidden
    // under the video. One LEFT press off the control bar landed on the invisible
    // header, and OK navigated away mid-film with no visible ring. Nothing here can
    // see occlusion, so name the chrome that is genuinely ON TOP of the player.
    // (Skipped when a modal is open: the modal is its own scope and sits above both.)
    if (document.body.classList.contains('cinema-on') && !el.closest('.modal-back') &&
        !el.closest(document.body.classList.contains('dock-open')
          ? '#pl-dock, #next-up'          // the dock owns the remote; the frame above it must not
          : '.player-frame.cinema, #cinema-exit, #next-up')) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const cs = getComputedStyle(el);
    // `visibility` and `pointer-events` both inherit, so these two reads also rule
    // out anything sitting inside a switched-off container (a rotated-away hero
    // slide, a faded overlay) without walking the ancestor chain.
    // A grid screen's rows above the lane are faded out of the way, not gone (stageGridPlace):
    // Up must still reach them, and reaching one brings it back.
    if (cs.visibility === 'hidden' || (cs.opacity === '0' && !el.classList.contains('st-above')) || cs.pointerEvents === 'none') return null;
    // Is it RENDERED? Every test above inspects one property; this one asks the question
    // directly, and it is the only thing that catches a collapsed <details>. Chromium
    // collapses one through ::details-content instead of display:none on the children, so
    // the contents keep a real layout box -- 1270x488 for the closed Servers panel, with
    // visibility:visible, opacity 1, pointer-events auto and a non-null offsetParent.
    // Every heuristic here passed them, so 15 controls on the player page and 21 on the
    // TV Shows grid were invisible D-pad targets sitting behind the content. The ring
    // walked into them and disappeared, which is what read as the app freezing.
    if (el.checkVisibility && !el.checkVisibility()) return null;
    // checkVisibility landed in Chromium 105 and a TV WebView can be older than the phone
    // it shares a codebase with, so keep an explicit fallback for the case that caused
    // this. A <summary> is the one part of a closed <details> that stays reachable.
    else if (!el.checkVisibility) {
      const det = el.closest('details:not([open])');
      if (det && !el.closest('summary')) return null;
    }
    return r;
  }

  function tvFocusables(root) {
    return [].slice.call(root.querySelectorAll(TV_FOCUSABLE)).filter(tvVisible);
  }

  /* ---- The row model ------------------------------------------------------
     Nearest-thing-in-that-direction geometry is what made the D-pad feel random:
     a press could land two rails away, and the sticky top bar — which never moves
     — either stole every UP press or could not be reached at all.

     So the page is reduced to an ORDERED LIST OF ROWS. Up/Down steps exactly one
     row and keeps your place; Left/Right walks inside the row. The top bar is
     simply row 0, which puts it a bounded number of presses from anywhere, and
     makes "what am I on?" a question with an answer.                            */

  // Invalidate the cached geometry. Cheap enough to call liberally.
  function tvInvalidate() { tvDomGen++; tvRowCache = null; }

  /**
   * What the D-pad is allowed to reach right now.
   *
   * Anything that covers the page has to be in this list or the ring walks straight
   * out of it onto the dimmed content behind, which on a remote is indistinguishable
   * from the app having lost focus entirely. Ordered by stacking: the splash sits
   * over everything, then the account menu, then modals.
   */
  function tvScope() {
    const lk = document.getElementById('lock');
    if (lk) return lk;
    const dw = document.getElementById('drawer');
    if (dw && dw.classList.contains('open')) return dw;
    const am = document.getElementById('acct-menu');
    if (am) return am;
    return document.querySelector('.modal-back') || document;
  }

  function tvRowModel(scope) {
    if (tvRowCache && tvRowCache.gen === tvDomGen && tvRowCache.scope === scope) return tvRowCache.rows;
    // Rows are measured in DOCUMENT space (rect + scrollY) so their order never
    // changes as the page scrolls. Two exceptions: a modal scrolls its own body, so
    // it stays in viewport space; and the sticky header is pinned to the viewport,
    // so in document space it belongs at the very top. That pin is what makes UP
    // reach the top bar from the first content row — and only from there.
    const inModal = !!document.querySelector('.modal-back');
    const sy = window.scrollY || 0;
    const vh = window.innerHeight || 0;
    const docH = document.documentElement.scrollHeight || 0;
    const metas = [];
    [].slice.call(scope.querySelectorAll(TV_FOCUSABLE)).forEach(el => {
      const r = tvMeasure(el);
      if (!r) return;
      const pinned = !inModal && !!el.closest(TV_PINNED);
      // A carousel scrolls under the cached x, so remember which one this item is in
      // and what its scrollLeft was; tvColOf() corrects for the difference later.
      const sc = el.closest(TV_ROW_CONTAINERS);
      let cy;
      if (inModal || pinned) {
        cy = r.top + r.height / 2;
        // Chrome pinned to the BOTTOM of the viewport (the update banner) belongs
        // after all the content, not wherever the current scroll position puts it.
        // Not the TV side rail: it runs the full height, and its lower half sorted after the
        // page, so Down from the last row walked into it.
        if (!inModal && cy > vh / 2 && !el.closest('header.top')) cy += docH;
      } else {
        cy = r.top + sy + r.height / 2;
      }
      metas.push({ el: el, x: r.left + r.width / 2, cy: cy, h: r.height, pinned: pinned,
                   sc: sc, sl: sc ? sc.scrollLeft : 0 });
    });

    const keyed = new Map(), loose = [];
    for (const m of metas) {
      let key = null;
      // Every pinned element used to share the key 'hdr', which merged the update
      // banner INTO row 0 and dragged the header row's mean cy to the middle of the
      // page: UP from the hero then reached nothing, and the banner's two buttons were
      // interleaved into the middle of the nav bar. The +docH offset above already
      // marks bottom-pinned chrome -- key it separately so that offset means something.
      if (m.pinned) key = (m.cy > docH) ? 'pin-bottom' : 'hdr';
      else {
        const c = m.el.closest(TV_ROW_CONTAINERS);
        if (c) key = (c.__tvRow || (c.__tvRow = 'c' + (++tvRowSeq)));
      }
      if (key) { if (!keyed.has(key)) keyed.set(key, []); keyed.get(key).push(m); }
      else loose.push(m);
    }

    const rows = [];
    keyed.forEach((items, key) => rows.push({ kind: key === 'hdr' ? 'hdr' : 'track', items }));
    // Everything else — wrapped grids, episode lists, chip clouds, button bars —
    // clusters by vertical centre, tolerance scaled to the item height.
    loose.sort((a, b) => a.cy - b.cy || a.x - b.x);
    let seed = null;
    for (const m of loose) {
      if (seed && Math.abs(m.cy - seed.cy) <= Math.max(18, Math.min(m.h, seed.h) * 0.6)) seed.items.push(m);
      else { seed = { kind: 'loose', cy: m.cy, h: m.h, items: [m] }; rows.push(seed); }
    }

    const mid = (row) => row.items.reduce((t, m) => t + m.cy, 0) / row.items.length;
    rows.forEach(row => row.items.sort((a, b) => a.x - b.x));
    rows.sort((a, b) => mid(a) - mid(b));
    tvRowCache = { gen: tvDomGen, scope: scope, rows: rows };
    return rows;
  }

  // Cached x, corrected for however far its carousel has scrolled since capture.
  // Vertical (cy) needs no correction: it is stored in document space.
  function tvColOf(m) { return m.sc ? m.x - (m.sc.scrollLeft - m.sl) : m.x; }

  // The CSS reduced-motion block can only override scrolls whose behavior is 'auto';
  // an explicit 'smooth' option wins over it. So the most frequent motion in the whole
  // app — a page scroll on every D-pad press — was the one the preference could not
  // switch off. Ask directly instead.
  const tvReduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function tvNow() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function tvScrollGet(el) { return el === window ? (window.scrollY || window.pageYOffset || 0) : el.scrollLeft; }
  function tvScrollSet(el, v) { if (el === window) window.scrollTo(0, v); else el.scrollLeft = v; }
  // Move `el` to `to`, retargeting instead of stacking. One rAF loop drives every
  // active scroller, so a vertical page move and a horizontal rail move during the
  // same keypress stay in step rather than racing.
  function tvGlide(el, to) {
    to = Math.round(to);
    const from = tvScrollGet(el);
    if (tvReduceMQ && tvReduceMQ.matches) { tvScrollSet(el, to); return; }
    if (Math.abs(to - from) < 2) { tvScrollSet(el, to); return; }
    let a = null;
    for (let i = 0; i < tvScrolls.length; i++) { if (tvScrolls[i].el === el) { a = tvScrolls[i]; break; } }
    if (a) { a.from = from; a.to = to; a.t0 = tvNow(); }
    else tvScrolls.push({ el: el, from: from, to: to, t0: tvNow() });
    if (!tvScrollRAF) tvScrollRAF = requestAnimationFrame(tvGlideStep);
  }
  function tvGlideStep() {
    const t = tvNow();
    for (let i = tvScrolls.length - 1; i >= 0; i--) {
      const a = tvScrolls[i];
      const k = Math.min(1, (t - a.t0) / TV_GLIDE_MS);
      const e = 1 - Math.pow(1 - k, 3);        // ease-out: fast off the mark, settles
      tvScrollSet(a.el, a.from + (a.to - a.from) * e);
      if (k >= 1) tvScrolls.splice(i, 1);
    }
    tvScrollRAF = tvScrolls.length ? requestAnimationFrame(tvGlideStep) : 0;
  }
  // A re-render replaces the scrollers we were animating; keep no handles on them.
  function tvGlideStop() { tvScrolls.length = 0; }

  /* ---- The Stage (TV Home) ------------------------------------------------------
     One fixed layer behind the page, made once and kept for the session (stage.css).
     It shows the FOCUSED title: backdrop, title or logo, one line of facts, two of
     story, and a beam of the poster's colour. tvMark feeds it on every focus change and
     tvFocusEl places the row; nothing else drives it. Shown only on TV Home (body.tv.home).

     Cheap by design: text swaps at once, the backdrop waits 160ms so holding an arrow
     sweeps past titles without decoding their art, and anything that costs a request
     (a missing overview, the logo, the colour) waits until focus has rested 450ms. */
  let stageEl = null, stageBd = [], stageBdOn = 0, stageWant = '', stageFor = '';
  let stageBdTimer = 0, stageSwapTimer = 0, stageDwellTimer = 0, stageProbed = false;
  let stageHist = new Map();
  let stageWheeled = false;             // the page moved by wheel or touch since the last D-pad press
  function stageMount() {
    if (!IS_TV || stageEl) return;
    stageEl = document.createElement('div');
    stageEl.id = 'stage';
    stageEl.setAttribute('aria-hidden', 'true');
    stageEl.innerHTML = '<div class="st-bd"></div><div class="st-bd"></div><div class="st-scrim"></div><div class="st-beam"></div>' +
      '<div class="st-info"><div class="st-kicker st-swap"></div><div class="st-title st-swap"></div>' +
      '<div class="st-meta st-swap"></div><div class="st-line st-swap"></div></div>';
    document.body.insertBefore(stageEl, document.body.firstChild);
    stageBd = [].slice.call(stageEl.querySelectorAll('.st-bd'));
    // A wheel or a finger moves Home or a grid screen by itself (a TV with a mouse, the
    // browser): while it moves, the lane does not hold -- nothing faded, and the stage's text
    // steps away once the page is off the top (st-under). When it stops, stageSnap settles
    // the row nearest the lane, as a D-pad press would have.
    let snapTimer = 0;
    const settle = () => { clearTimeout(snapTimer); snapTimer = setTimeout(stageSnap, 200); };
    const loose = () => {
      stageWheeled = true;
      if (!stageOn()) return;
      document.body.classList.add('st-free');
      [].slice.call(document.querySelectorAll('#view .st-above')).forEach((e) => e.classList.remove('st-above'));
      settle();
    };
    window.addEventListener('wheel', loose, { passive: true });
    window.addEventListener('touchmove', loose, { passive: true });
    window.addEventListener('scroll', () => {
      if (document.body.classList.contains('st-free')) document.body.classList.toggle('st-under', window.scrollY > 8);
      if (stageWheeled) settle();                // momentum and smooth scrolling carry on after the wheel
    }, { passive: true });
  }

  /**
   * The wheel has stopped: focus the row whose line is nearest the lane (Home's 50vh, a grid's
   * --grid-lane), on the item nearest where the ring last was across, and let tvFocusEl place it.
   * Not over a modal, the player, or the side rail -- those were not scrolled by the wheel.
   */
  function stageSnap() {
    if (!stageWheeled || !stageOn() || document.querySelector('.modal-back') ||
        document.body.classList.contains('cinema-on') || document.body.classList.contains('rail-open')) return;
    const root = document.getElementById('view'); if (!root) return;
    const vh = window.innerHeight, lane = vh * (stageGrid() ? GRID_LANE : 0.5);
    const flow = stageGrid() ? stageFlow(root) : null;
    const x0 = tvLastPos ? tvLastPos.x : 0;
    let best = null, bestD = Infinity;
    [].slice.call(root.querySelectorAll(TV_FOCUSABLE)).forEach((el) => {
      const r = tvMeasure(el); if (!r) return;
      // The line an item belongs to: its rail on Home, its card or block on a grid screen.
      const line = flow ? flow.filter((it) => it.contains(el))[0] : el.closest('#view > .rows > .rail');
      if (!line) return;
      const top = line.getBoundingClientRect().top;
      if (r.right < 0 || r.left > window.innerWidth) return;   // scrolled off its carousel
      const d = Math.abs(top - lane) * 4 + Math.abs(r.left + r.width / 2 - x0);
      if (d < bestD) { bestD = d; best = el; }
    });
    stageWheeled = false;
    if (best) tvFocusEl(best);
  }
  const stageOn = () => !!stageEl && (document.body.classList.contains('home') || document.body.classList.contains('stage-grid'));
  const stageGrid = () => !!stageEl && document.body.classList.contains('stage-grid');

  // The title behind a card: Home's rails register every item in itemCache under the same
  // "type:id" their data-nav names; Continue watching rows come from history instead.
  function stageItemFor(el) {
    const card = el && el.closest ? el.closest('#view .card') : null;
    if (!card) return null;
    const m = /^#\/(?:watch\/)?(movie|tv)\/(\d+)/.exec(card.getAttribute('data-nav') || '');
    if (!m) return null;
    const type = m[1], id = m[2], key = type + ':' + id;
    const cw = card.classList.contains('cw-card') ? ((card.querySelector('.cw-s') || {}).textContent || '') : '';
    const rank = card.classList.contains('rank-item') ? (/^Number (\d+)/.exec(card.getAttribute('aria-label') || '') || [])[1] : '';
    return { type: type, id: id, key: key, cw: cw, rank: rank, it: itemCache[ck(type, id)] || null, h: stageHist.get(key) || null };
  }

  function stageText(s) {
    const it = s.it || {}, h = s.h || {};
    const y = year(it.release_date || it.first_air_date || '');
    const rating = it.vote_average ? Number(it.vote_average).toFixed(1) : '';
    const len = s.type === 'tv'
      ? (it.number_of_seasons ? it.number_of_seasons + ' season' + (it.number_of_seasons === 1 ? '' : 's') : '')
      : (it.runtime ? Math.floor(it.runtime / 60) + 'h ' + (it.runtime % 60) + 'm' : '');
    const kicker = s.cw ? 'Resume · ' + s.cw : s.rank ? 'No. ' + s.rank + ' today' : (s.type === 'tv' ? 'Series' : 'Film');
    const meta = [y, s.type === 'tv' ? 'Series' : 'Film', len].filter(Boolean).map(esc).join(' · ') +
      (rating ? ' · <b>★ ' + rating + '</b>' : '');
    return { kicker: kicker, title: it.title || it.name || h.title || '', logo: it._logo || null, meta: meta, line: it.overview || '' };
  }

  let stageShown = '';
  function stagePaintInfo(s) { stagePaint(stageText(s)); }
  function stagePaint(t) {
    const sig = JSON.stringify(t);
    if (sig === stageShown) return;
    stageShown = sig;
    const els = stageEl.querySelectorAll('.st-swap');
    clearTimeout(stageSwapTimer);
    els.forEach((e) => e.classList.add('out'));
    stageSwapTimer = setTimeout(() => {
      els[0].textContent = t.kicker;
      els[1].innerHTML = t.logo ? `<img src="${esc(t.logo)}" alt="${esc(t.title)}">` : esc(t.title);
      els[2].innerHTML = t.meta;
      els[3].textContent = t.line;
      els.forEach((e) => e.classList.remove('out'));
    }, 110);
  }

  function stageBackdrop(path) {
    clearTimeout(stageBdTimer);
    if (!path || !RX_IMGPATH.test(path)) return;
    const url = img(path, 'w1280');
    if (url === stageWant) return;
    stageBdTimer = setTimeout(() => {
      stageWant = url;
      const im = new Image();
      im.decoding = 'async';
      // Swap only once the bitmap is ready, so a cross-fade never fades to an empty layer.
      im.onload = () => {
        if (stageWant !== url || !stageEl) return;
        const next = stageBd[1 - stageBdOn];
        next.style.backgroundImage = 'url("' + url + '")';
        next.classList.add('on');
        stageBd[stageBdOn].classList.remove('on');
        stageBdOn = 1 - stageBdOn;
        stageProbe();
      };
      im.src = url;
    }, 160);
  }

  /**
   * Focus landed on something on Home or a grid screen. Not a title card (a genre, "See all"):
   * Home leaves the stage as it is; a grid screen shows the page itself (stagePage).
   */
  function stageFocus(el) {
    if (!stageOn()) return;
    const s = stageItemFor(el);
    if (!s) { if (stageGrid() && el.closest('#view')) stagePage(); return; }
    const it = s.it || {};
    // Always: a title page in between may have shown another picture (deduped by URL).
    stageBackdrop(it.backdrop_path || artGet(s.type, s.id) || '');
    if (s.key === stageFor) return;
    stageFor = s.key;
    stagePaintInfo(s);
    clearTimeout(stageDwellTimer);
    stageDwellTimer = setTimeout(() => stageEnrich(s), 450);
  }

  // Resting on a title: fill what the rail's list did not carry, then the logo and colour.
  async function stageEnrich(s) {
    if (stageFor !== s.key || !stageOn()) return;
    let it = s.it;
    // The title page's own request: it fills the stage AND has the page ready if OK follows.
    const full = titleData(s.type, s.id);
    full.catch(() => {});
    if (!it || !it.overview || !it.backdrop_path) {
      try {
        const d = await full;
        it = Object.assign(it || {}, d);
        itemCache[ck(s.type, s.id)] = it;
      } catch (e) { /* the stage keeps what it has */ }
      if (stageFor !== s.key || !stageOn()) return;
      s.it = it;
      stageBackdrop(it && it.backdrop_path || '');
    }
    if (!it) return;
    if (!it.media_type) it.media_type = s.type;
    ambientFrom(it.poster_path);                 // the beam's colour (--ambient)
    await heroLogo(it);
    if (stageFor !== s.key || !stageOn()) return;
    stagePaintInfo(s);                           // a no-op unless the text or the logo changed
  }

  /** A title page on TV: the stage keeps (or takes) this title's backdrop and colour. */
  function stageTitle(type, d) {
    if (!stageEl || !d) return;
    stageBackdrop(d.backdrop_path || '');        // the text belongs to Home; only the picture changes
  }

  /**
   * A grid screen with the ring off the titles (the search box, a filter, the pager): the
   * stage shows the page -- its name, a count or what is filtering it, a person's story --
   * over the first result's backdrop. The view's own heading is hidden on TV (stage.css).
   */
  const STAGE_KICKER = { movies: 'Browse', movie: 'Browse', tv: 'Browse', 'tv-shows': 'Browse',
                         search: 'Search', watchlist: 'Your list', person: 'Person' };
  let stagePageTimer = 0;
  function stagePage(tries) {
    clearTimeout(stagePageTimer);
    const root = document.getElementById('view');
    const h1 = root && root.querySelector('h1');
    if (!h1) return;
    const sec = parseHash().parts[0] || '';
    const count = h1.querySelector('.muted');
    const title = [].slice.call(h1.childNodes).filter(n => n !== count).map(n => n.textContent).join('').trim();
    let meta = count ? count.textContent.replace(/[()]/g, '').trim() + ' titles' : '';
    const fl = root.querySelector('.filters .fl-n');
    if (fl && /active/.test(fl.textContent)) meta = fl.textContent.trim().replace('active', 'filters active');
    const pills = [].slice.call(root.querySelectorAll('.person-head .pill')).map(p => p.textContent.trim());
    if (pills.length) meta = pills.join(' · ');
    const bio = root.querySelector('.person-head .overview');
    const key = 'page:' + location.hash + ':' + title;
    if (stageFor !== key) {
      stageFor = key;
      clearTimeout(stageDwellTimer);
      const kicker = STAGE_KICKER[sec] || '';
      stagePaint({ kicker: kicker.toLowerCase() === title.toLowerCase() ? '' : kicker, title: title, logo: null, meta: esc(meta), line: bio ? bio.textContent.trim() : '' });
    }
    // The picture: the first result's. Results may still be loading; look again shortly.
    const first = stageItemFor(root.querySelector('.grid .card'));
    const it = first && first.it;
    if (it && it.backdrop_path) stageBackdrop(it.backdrop_path);
    else if ((tries || 0) < 8) { const my = routeSeq; stagePageTimer = setTimeout(() => { if (routeIs(my) && stageFor === key) stagePage((tries || 0) + 1); }, 400); }
  }

  /** Where the focused card will sit once the glides finish: the beam rises from there. */
  function stageBeam(left, top, width) {
    const b = stageEl && stageEl.querySelector('.st-beam'); if (!b) return;
    const w = Math.round(width * 2.4), h = b.offsetHeight || Math.round(window.innerHeight * 0.44);
    b.style.width = w + 'px';
    b.style.transform = 'translate3d(' + Math.round(left + width / 2 - w / 2) + 'px,' + Math.round(top - h + 14) + 'px,0)';
  }

  /**
   * tvFocusEl's placement on Home: the focused card at the start of its row (not centred),
   * and the row's heading at --lane-y (always, not only when off screen). Rows above it
   * step aside so they never sit under the stage text. Returns false when not applicable.
   */
  function stagePlace(el) {
    if (!stageOn()) return false;
    if (stageGrid()) return stageGridPlace(el);
    document.body.classList.remove('st-free');
    const rail = el.closest('#view > .rows > .rail');
    if (!rail) return false;
    const hs = el.closest('.track');
    const box = el.querySelector('.poster') || el;
    const r = box.getBoundingClientRect();
    let dx = 0;
    if (hs) {
      const er = el.getBoundingClientRect(), hr = hs.getBoundingClientRect();
      const pad = hs.__padL != null ? hs.__padL : (hs.__padL = parseFloat(getComputedStyle(hs).paddingLeft) || 0);
      const maxL = Math.max(0, hs.scrollWidth - hs.clientWidth);
      const left = Math.max(0, Math.min(hs.scrollLeft + (er.left - hr.left) - pad, maxL));
      dx = left - hs.scrollLeft;
      tvGlide(hs, left);
    }
    const laneY = window.innerHeight * 0.5;      // stage.css --lane-y
    const max = Math.max(0, (document.documentElement.scrollHeight || 0) - window.innerHeight);
    const top = Math.max(0, Math.min(window.scrollY + rail.getBoundingClientRect().top - laneY, max));
    const dy = top - window.scrollY;
    tvGlide(window, top);
    const rails = rail.parentNode.children;
    let above = true;
    for (let i = 0; i < rails.length; i++) {
      if (rails[i] === rail) above = false;
      rails[i].classList.toggle('st-above', above);
    }
    stageBeam(r.left - dx, r.top - dy, r.width);
    return true;
  }

  // The grid screens' lane, as a fraction of the height: stage.css --grid-lane.
  const GRID_LANE = 0.46;

  // What a grid screen is made of, top to bottom: every card of every grid on its own (a
  // grid is many visual rows), every other block whole.
  function stageFlow(root) {
    const out = [];
    (function walk(n) {
      [].slice.call(n.children).forEach((c) => {
        if (c.matches('.grid, .genre-grid')) out.push.apply(out, [].slice.call(c.children));
        else if (c.querySelector('.grid, .genre-grid')) walk(c);
        else out.push(c);
      });
    })(root);
    return out;
  }

  /**
   * tvFocusEl's placement on a grid screen: the focused line at --grid-lane, under the stage's
   * text, with everything above it faded out of the way -- Home's lane, for a grid. A block too
   * tall to sit under the lane (an open filter panel, the history list) is an ordinary page
   * instead: body.st-free hides the stage text and the default placement runs.
   */
  function stageGridPlace(el) {
    const root = document.getElementById('view');
    if (!root || !root.contains(el)) return false;
    const items = stageFlow(root);
    const item = items.filter((it) => it.contains(el))[0];
    if (!item) return false;
    const vh = window.innerHeight, lane = vh * GRID_LANE;
    const ir = item.getBoundingClientRect();
    const free = !stageItemFor(el) && ir.height > vh - lane - 16;
    document.body.classList.toggle('st-free', free);
    document.body.classList.toggle('st-under', free && window.scrollY > 8);
    if (free) { items.forEach((it) => it.classList.remove('st-above')); return false; }
    const hs = el.closest(TV_ROW_CONTAINERS);
    if (hs && hs.scrollWidth > hs.clientWidth + 4) {
      const r = el.getBoundingClientRect(), hr = hs.getBoundingClientRect();
      tvGlide(hs, Math.max(0, hs.scrollLeft + (r.left - hr.left) - (hr.width - r.width) / 2));
    }
    const max = Math.max(0, (document.documentElement.scrollHeight || 0) - vh);
    const top = Math.max(0, Math.min(window.scrollY + ir.top - lane, max));
    const dy = top - window.scrollY;
    // Above = starts above the focused line and would land under the stage's text. Measured
    // BEFORE the glide: its first step can move the page at once.
    const tops = items.map((it) => it.getBoundingClientRect().top);
    tvGlide(window, top);
    // A block that has since been filled in (the genre tiles land inside the results box) is
    // no longer one item: its old marks would fade everything in it.
    [].slice.call(root.querySelectorAll('.st-flow')).forEach((e) => {
      if (items.indexOf(e) < 0) e.classList.remove('st-flow', 'st-above');
    });
    items.forEach((it, i) => {
      it.classList.add('st-flow');
      it.classList.toggle('st-above', it !== item && tops[i] < ir.top - 2 && tops[i] - dy < lane - 4);
    });
    return true;
  }

  // A weak set shows it in the frame rate. Measured once, while the first backdrop drifts:
  // a median frame over 24ms turns off the drift and the beam (body.stage-lite).
  function stageProbe() {
    if (stageProbed || !window.requestAnimationFrame) return;
    stageProbed = true;
    const gaps = []; let last = 0;
    const step = (t) => {
      if (last) gaps.push(t - last);
      last = t;
      if (gaps.length < 40) { requestAnimationFrame(step); return; }
      gaps.sort((a, b) => a - b);
      if (gaps[gaps.length >> 1] > 24) document.body.classList.add('stage-lite');
    };
    requestAnimationFrame(step);
  }

  /* ---- The side rail (TV) -------------------------------------------------------
     The header, laid out as a column (stage.css). LEFT at the start of any row opens it,
     on the current section; UP/DOWN walk it; RIGHT or BACK return to exactly where you
     were. It is never part of the row model's vertical moves. */
  let tvRailReturn = null;
  function railItems() {
    const hdr = document.querySelector('header.top'); if (!hdr) return [];
    return [].slice.call(hdr.querySelectorAll(TV_FOCUSABLE)).filter(tvVisible)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }
  function railEnter(from) {
    const items = railItems(); if (!items.length) return false;
    tvRailReturn = from || null;
    const cur = document.querySelector('header.top nav.main a.active') ||
                (document.body.classList.contains('home') ? document.querySelector('header.top .brand') : null);
    tvFocusEl(cur && items.indexOf(cur) >= 0 ? cur : items[0]);
    return true;
  }
  function railLeave() {
    const r = tvRailReturn; tvRailReturn = null;
    if (r && r.isConnected && tvVisible(r)) { tvFocusEl(r); return; }
    tvFocusFirst();
  }
  function railNav(dir, cur) {
    const items = railItems(), i = items.indexOf(cur);
    if (dir === 'up' && i > 0) tvFocusEl(items[i - 1]);
    else if (dir === 'down' && i >= 0 && i < items.length - 1) tvFocusEl(items[i + 1]);
    else if (dir === 'right') railLeave();
  }

  // Focus WITHOUT the browser's own scroll, then place the selection ourselves: a
  // carousel centres its item sideways, the page centres the row vertically, and the
  // sticky bar just snaps the page home (centring a pinned element fights the scroll
  // and bounces focus straight back off it).
  function tvFocusEl(el) {
    // body/html are never a focus target: focus() is a no-op on them and the
    // scroll-into-view maths below uses their rect, which is the whole document.
    if (!el || el === document.body || el === document.documentElement) return;
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
    tvMark(el);
    tvRemember(el);
    if (stagePlace(el)) return;                 // TV Home: the focus lane (see the Stage)
    const hs = el.closest(TV_ROW_CONTAINERS);
    if (hs && hs.scrollWidth > hs.clientWidth + 4) {
      const r = el.getBoundingClientRect(), hr = hs.getBoundingClientRect();
      const left = Math.max(0, hs.scrollLeft + (r.left - hr.left) - (hr.width - r.width) / 2);
      tvGlide(hs, left);
    }
    // The player's dock scrolls itself; the page behind the picture must not move.
    const dock = dockIsOpen() && el.closest('#pl-dock');
    if (dock) {
      const r = el.getBoundingClientRect(), dr = dock.getBoundingClientRect();
      if (r.bottom > dr.bottom - 12) dock.scrollTop += Math.ceil(r.bottom - dr.bottom + 20);
      else if (r.top < dr.top + 12) dock.scrollTop -= Math.ceil(dr.top - r.top + 20);
      return;
    }
    // Pinned chrome never moves the page. The header used to snap it home; on TV the header
    // is now the side rail, fixed down the left edge, and opening it must leave you in place.
    if (el.closest(TV_PINNED)) return;
    // The first-run splash is a scroll container of its own, exactly like a modal: without
    // this the TV sign-in panel's only focusable (Cancel) sat below the fold with its ring
    // off screen, and nothing ever scrolled to it.
    if (el.closest('.modal-back, .splash-back')) { try { el.scrollIntoView({ block: 'center' }); } catch (e) {} return; }
    const r2 = el.getBoundingClientRect();
    const vh = window.innerHeight || 0;
    // Already comfortably in view (clear of the opaque sticky bar and the bottom
    // edge)? Leave the page where it is. Re-centring unconditionally meant simply
    // arriving on a page dragged its own title and the top bar off screen.
    // No top bar on TV any more (the header is the side rail), so the only thing to clear
    // at the top is the title-safe margin.
    const safeTop = 27 + 16;
    if (r2.top >= safeTop && r2.bottom <= vh - 16) return;
    const max = Math.max(0, (document.documentElement.scrollHeight || 0) - vh);
    let top = Math.max(0, Math.min(window.scrollY + r2.top - (vh - r2.height) / 2, max));
    // Anywhere near the top, snap to the very top. Leaving the page a hundred pixels
    // down is what made the hero look sliced off under the bar — the first row should
    // always show the whole hero, not most of it.
    if (top < vh * 0.42) top = 0;
    tvGlide(window, top);
  }

  // The highlight is a class we own, not just :focus. A WebView that loses window
  // focus — system dialog, IME, the player taking over — stops matching :focus, and
  // on a TV a selection that silently vanishes is indistinguishable from a crash.
  // Driven from a focusin listener so EVERY path that moves focus keeps it in sync.
  function tvMark(el) {
    // The pointer holds DOM focus so the arrows keep reaching us, but it is not a
    // selection — it must not wear the focus ring.
    if (el && el.id === 'tv-cursor') return;
    if (tvMarked === el) return;
    // Only CAROUSELS are rows. A .grid is one container holding many visual rows, so
    // marking it dimmed every poster on the page instead of the neighbours on the
    // focused line — the page read as disabled. The .rail is marked too so the rail
    // heading can light up without depending on :focus-within.
    const marks = (n) => n && n.closest ? [n.closest('.track, .cast-track'), n.closest('.rail')].filter(Boolean) : [];
    if (tvMarked) marks(tvMarked).forEach(m => m.classList.remove('tv-row-active'));
    if (tvMarked) tvMarked.classList.remove('tv-focus');
    tvMarked = (el && el.classList) ? el : null;
    if (tvMarked) {
      tvMarked.classList.add('tv-focus');
      marks(tvMarked).forEach(m => m.classList.add('tv-row-active'));
    }
    // The side rail opens while it holds the ring; the Stage follows it everywhere else.
    document.body.classList.toggle('rail-open', !!(tvMarked && tvMarked.closest('header.top')));
    if (tvMarked) stageFocus(tvMarked);
    // Resting on any card starts its title page loading (titleData; the Stage does the same).
    if (tvMarked) titlePrefetchFrom(tvMarked, 450);
  }

  // Where the ring was, in the same document space the row model uses.
  function tvRemember(el) {
    const r = el.getBoundingClientRect();
    const pinned = !!el.closest('header.top');
    tvLastPos = { x: r.left + r.width / 2, cy: r.top + (pinned ? 0 : (window.scrollY || 0)) + r.height / 2 };
  }

  // The row + item closest to a remembered position. Used to put the ring back after
  // a re-render deletes the element underneath it — on a TV that is the difference
  // between 'the remote went dead' and 'nothing happened'.
  function tvNearest(rows, pos) {
    if (!rows.length || !pos) return null;
    const mid = (row) => row.items.reduce((t, m) => t + m.cy, 0) / row.items.length;
    let ri = 0, best = Infinity;
    rows.forEach((row, i) => { const d = Math.abs(mid(row) - pos.cy); if (d < best) { best = d; ri = i; } });
    let ci = 0; best = Infinity;
    rows[ri].items.forEach((m, j) => { const d = Math.abs(tvColOf(m) - pos.x); if (d < best) { best = d; ci = j; } });
    return { ri: ri, ci: ci };
  }

  function tvRestoreFocus() {
    if (!IS_TV) return false;
    const rows = tvRowModel(tvScope());
    if (!rows.length) return false;
    const at = tvNearest(rows, tvLastPos);
    tvFocusEl(at ? rows[at.ri].items[at.ci].el : rows[0].items[0].el);
    return true;
  }

  // waitForRender: the router calls this BEFORE the new view has rendered, while the
  // OUTGOING page is still in the DOM. Grabbing immediately would focus a node that
  // is about to be thrown away, so on a route change we always wait for the next
  // render and let the observer do it.
  // Tear down the whole watch cycle. Every timer is cleared here — tvGiveUp used to be
  // left armed across navigations, and 15s later its callback would disconnect the
  // NEXT page's observer, which is how a page could render with no ring at all.
  function tvStopWatch() {
    if (tvObserver) { tvObserver.disconnect(); tvObserver = null; }
    clearTimeout(tvTimeout); clearTimeout(tvGiveUp);
  }

  // Try the landing selectors IN ORDER (priority, not document order), then fall back
  // to "first focusable" — but only once the view has finished rendering. While a
  // skeleton is still up, the fallback would grab whatever chrome rendered first (on
  // Movies that is the Sort dropdown) and then stop watching, so the posters arriving
  // a moment later never got the ring.
  function tvPickLanding() {
    const root = document.querySelector('.modal-back') || document.getElementById('view') || document.body;
    for (let i = 0; i < TV_LANDING.length; i++) {
      const hit = [].slice.call(root.querySelectorAll(TV_LANDING[i])).filter(tvVisible)[0];
      if (hit) return hit;
    }
    if (root.querySelector('.sk')) return null;   // still loading — wait for the real content
    return tvFocusables(root)[0] || null;
  }

  // keepPlace: the same screen re-rendered with different parameters (a genre chip, a
  // sort, a page). Landing on the page's primary control there would mean walking all
  // the way back to the toolbar for every single filter you want to change — picking
  // three genres cost about forty presses. Put the ring back where it was instead.
  function tvFocusFirst(waitForRender, keepPlace, place) {
    if (!IS_TV) return;
    const gen = ++tvGen;
    tvStopWatch();
    tvColX = null;
    tvUserMoved = false;
    const stop = () => { if (gen === tvGen) tvStopWatch(); };
    const grab = () => {
      // The pointer owns the remote. The watch page brings it up at the end of its
      // render, and the landing pass that follows used to put the ring on the frame
      // underneath it anyway -- harmless (the arrows check the pointer first) but a
      // second focus the user could not see. Done, not deferred: nothing to land on.
      if (cursorActive()) return true;
      tvEnsureFocusable();
      if (place) {                       // coming Back: put the page, and the ring, where they were
        const r = placeApply(place);
        if (r === true) return true;
        if (r === 'wait') return false;
        place = null;                    // unusable -- land the normal way
      }
      if (keepPlace && tvLastPos) {
        const root = document.getElementById('view');
        if (root && !root.querySelector('.sk') && tvFocusables(root).length) return tvRestoreFocus();
        return false;
      }
      const el = tvPickLanding();
      if (el) { tvFocusEl(el); return true; }
      return false;
    };
    if (!waitForRender && grab()) return;
    const target = document.querySelector('.modal-back') || document.getElementById('view') || document.body;
    // While the view is still fetching there may be nothing focusable at all. Park the
    // ring on the nav bar quickly so the remote is never dead, but keep watching: when
    // the content lands it takes the ring — unless the user has already pressed a
    // direction, in which case they are driving and we stay out of the way.
    tvObserver = new MutationObserver(() => {
      if (gen !== tvGen) return;
      if (tvUserMoved) { stop(); return; }
      if (grab()) stop();
    });
    tvObserver.observe(target, { childList: true, subtree: true });
    tvTimeout = setTimeout(() => {
      if (gen !== tvGen || tvUserMoved) return;
      if (grab()) { stop(); return; }
      const nav = document.querySelector('header.top nav.main a') || document.querySelector('[data-nav]');
      if (nav) tvFocusEl(nav);
    }, 1200);
    tvGiveUp = setTimeout(stop, 15000);
  }

  /* ---- Keyboard shortcuts --------------------------------------------------------
     Desktop and web only; a remote has none of these keys. The list is reachable with
     "?" and from Settings, so it is discoverable without being announced. */
  function openShortcuts() {
    if (document.querySelector('.modal-back')) return;
    const row = (k, what) => `<div class="kb-row"><kbd>${k}</kbd><span>${what}</span></div>`;
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal">
      <div class="mh"><h3>Keyboard shortcuts</h3><button class="icon-btn" data-close aria-label="Close">${ICON.x}</button></div>
      <div class="mb kb-list">
        ${row('/', 'Search')}
        ${row('F', 'Fullscreen while watching')}
        ${IS_WINDOWED ? row('T', 'Theater mode while watching') : ''}
        ${row('N', 'Next episode')}
        ${row('P', 'Previous episode')}
        ${row('Esc', 'Leave the player, or close a dialog')}
        ${IS_WINDOWED ? row('Alt + \u2190', 'Back to where you were') : ''}
        ${row('?', 'This list')}
      </div>
    </div>`;
    modalMount(back);
  }
  document.addEventListener('keydown', (e) => {
    if (IS_TV || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (document.getElementById('lock')) return;
    if (e.key === '?') { e.preventDefault(); openShortcuts(); return; }
    if (document.querySelector('.modal-back')) return;
    const k = (e.key || '').toLowerCase();
    const watching = !!document.querySelector('.player-frame');
    if (k === 'f' && watching) { e.preventDefault(); toggleCinema(true); }
    else if (k === 't' && watching && IS_WINDOWED) { e.preventDefault(); toggleCinema(false); }
    else if (k === 'n' || k === 'p') {
      const b = document.getElementById(k === 'n' ? 'ep-next' : 'ep-prev');
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    }
  });

  // Type "/" anywhere to jump to search. Registered here, at module scope, NOT inside
  // the IS_TV block below -- that block has silently swallowed a listener twice in this
  // file, and a shortcut for a physical keyboard is meaningless on the one platform it
  // would have worked on.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    if (document.querySelector('.modal-back') || document.getElementById('lock')) return;
    e.preventDefault();
    go('#/search');
    // The field is rendered by the view, so grab it once that has happened.
    setTimeout(() => { const i = document.querySelector('#q, .tv-search input, input[type="search"]'); if (i) i.focus(); }, 260);
  });

  function tvSpatialNav(e) {
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (!dir) return;
    // Pointer mode owns the D-pad outright.
    if (cursorActive()) { e.preventDefault(); cursorMove(dir); return; }
    const cur = document.activeElement;
    // Player has focus: the remote is driving the embed. Don't hijack arrows — let
    // the browser's own spatial nav move between the (cross-origin) player's controls.
    if (cur && cur.id === 'player-iframe') return;
    // let editable text fields use Left/Right for the caret until it hits the edge
    if (cur && /^(INPUT|TEXTAREA)$/.test(cur.tagName) && /^(text|search|url|email|tel|password|number|)$/i.test(cur.type || '') && (dir === 'left' || dir === 'right')) {
      const len = (cur.value || '').length;
      const atStart = cur.selectionStart === 0 && cur.selectionEnd === 0;
      const atEnd = cur.selectionStart === len && cur.selectionEnd === len;
      if ((dir === 'left' && !atStart) || (dir === 'right' && !atEnd)) return;
    }
    // A <select> on a desktop keyboard should cycle its options with Up/Down. On a
    // remote that is a trap: there is no Tab to escape with, every cycle fires change
    // (which re-renders the whole page through the router), and the user can never
    // leave the filter bar. On TV the select is just another row item — OK opens the
    // platform's own picker, which the remote drives natively.
    tvUserMoved = true;   // from here on the ring is the user's, not the router's
    if (!IS_TV && cur && cur.tagName === 'SELECT' && (dir === 'up' || dir === 'down')) return;
    e.preventDefault(); // TV owns focus — never let it escape into the cross-origin player iframe
    tvEnsureFocusable();

    // A column held on the page means nothing inside a menu or a modal: carried over, the
    // first Down in Settings jumped from column 1 to column 3.
    const scope = tvScope();
    if (scope !== tvLastScope) { tvColX = null; tvLastScope = scope; }
    // The side rail is its own little column, walked in screen order (see railNav).
    if (scope === document && cur && cur.closest && cur.closest('header.top')) { railNav(dir, cur); return; }
    // ...and it is never reached by Up/Down: on a page its items would sort into the row
    // order wherever their mean height happened to fall. LEFT at a row's start opens it.
    const rows = scope === document ? tvRowModel(scope).filter(r => r.kind !== 'hdr') : tvRowModel(scope);
    // Nothing focusable on screen (a skeleton, an error state). The press has already
    // been swallowed by preventDefault, so spend it re-entering rather than leaving
    // the remote looking dead with no key that helps.
    if (!rows.length) { tvFocusFirst(); return; }
    let ri = -1, ci = -1;
    for (let i = 0; i < rows.length && ri < 0; i++) {
      const j = rows[i].items.findIndex(m => m.el === cur);
      if (j >= 0) { ri = i; ci = j; }
    }
    // Focus was lost (a re-render replaced the element under the ring). Spend this
    // press putting the ring back where the user left it rather than at the top of
    // the page — one 'wake up' press, no teleport.
    if (ri < 0) { if (!tvRestoreFocus()) tvFocusFirst(); return; }
    // The page was scrolled by hand (a wheel; see stageMount) and the ring went off screen
    // with it: this press brings the ring back to its place, as on Home and the grids.
    if (stageWheeled) {
      stageWheeled = false;
      const r = cur.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) { tvFocusEl(cur); return; }
    }

    let target = null;
    if (dir === 'left' || dir === 'right') {
      const nj = ci + (dir === 'right' ? 1 : -1);
      if (nj < 0 && scope === document && railEnter(cur)) return;   // start of a row: the rail
      if (nj < 0 || nj >= rows[ri].items.length) return;   // edge of the row: stay put
      target = rows[ri].items[nj];
      tvColX = null;                                        // new column is wherever we land
    } else {
      const ni = ri + (dir === 'down' ? 1 : -1);
      // Up from the dock's top row lowers it and gives the pointer back.
      if (ni < 0 && dockIsOpen() && cur.closest && cur.closest('#pl-dock')) { dockClose(); return; }
      if (ni < 0 || ni >= rows.length) return;              // top/bottom of page: stay put
      const from = rows[ri], to = rows[ni];
      // ONE rule for every kind of row: land on whatever is visually below.
      //
      // Carousels used to carry the INDEX instead -- item 5 here went to item 5 there.
      // Two rails scrolled to different places then put that item far off screen, so the
      // rail had to scroll a long way to fetch it: the jump, the lag, and a ring that
      // appeared to move sideways as well as down. Carrying the on-screen column means
      // the target is nearly always already visible, so most vertical moves scroll
      // nothing at all.
      //
      // tvColOf() corrects a remembered x for however far that carousel has scrolled
      // since, which is what makes the column meaningful across independently scrolled
      // rows rather than just within one.
      const x = (tvColX == null) ? tvColOf(from.items[ci]) : tvColX;
      target = to.items.reduce((b, m) =>
        (b === null || Math.abs(tvColOf(m) - x) < Math.abs(tvColOf(b) - x)) ? m : b, null);
      tvColX = x;                                           // hold the column down a page
    }
    if (target) tvFocusEl(target.el);
  }

  // Runtime is filled in for the card being LOOKED at, on whichever device.
  // Registered OUTSIDE the IS_TV block below: a listener placed inside it only ever
  // registers on TV, where a mouseover cannot happen at all. Second time this exact
  // anchor has swallowed one.
  document.addEventListener('mouseover', (e) => {
    const c = e.target.closest && e.target.closest('.card');
    if (c) runtimeSoon(c);
  }, { passive: true });
  document.addEventListener('focusin', (e) => {
    const c = e.target.closest && e.target.closest('.card');
    if (c) runtimeSoon(c);
  });

  /* ---- The top bar steps aside when nothing is happening ---------------------
     Wired HERE, above the IS_TV block, on purpose: listeners fire in registration
     order, so chromeWake runs before tvSpatialNav on the same keydown. The bar is
     therefore already revealed and re-measured by the time the row model is built,
     and one UP press from the first content row both brings it back and lands on
     it. Registered after it, the first press would have been spent on the reveal. */
  const CHROME_IDLE_MS = 4000;
  let chromeTimer = null;

  // Reasons the bar must stay put. Hiding it while it holds focus would strand the
  // ring (or the caret) somewhere off screen, and the search suggestions drop out of
  // the bar itself, so hiding it would take them with it.
  function chromeHoldOpen() {
    const hdr = document.querySelector('header.top');
    if (!hdr) return true;
    if (hdr.contains(document.activeElement)) return true;
    try { if (hdr.matches(':hover')) return true; } catch (e) {}
    const a = document.activeElement;
    if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return true;
    // Any overlay owns the screen; the bar is not what the user is looking at, but
    // sliding it away underneath an open drawer or modal is just noise.
    if (document.getElementById('lock')) return true;
    const dw = document.getElementById('drawer');
    if (dw && dw.classList.contains('open')) return true;
    if (document.getElementById('acct-menu')) return true;
    if (document.querySelector('.modal-back')) return true;
    return false;
  }

  function chromeSleep() {
    // On TV the header is the side rail: narrow, at the edge, never in the way.
    if (IS_TV) return;
    // At the top of the page the bar is not in the way of anything, and hiding it there
    // just makes the app look like it lost its chrome. It only earns its keep once the
    // user has scrolled past where it would sit anyway.
    const hdr = document.querySelector('header.top');
    const past = (window.scrollY || 0) > (hdr ? hdr.offsetHeight : 56);
    if (!past) { chromeArm(); return; }
    if (chromeHoldOpen()) { chromeArm(); return; }   // re-check later rather than give up
    if (document.body.classList.contains('chrome-idle')) return;
    document.body.classList.add('chrome-idle');
    if (IS_TV) tvInvalidate();   // the bar has left the row model
  }

  function chromeArm() {
    clearTimeout(chromeTimer);
    chromeTimer = setTimeout(chromeSleep, CHROME_IDLE_MS);
  }

  function chromeWake() {
    if (document.body.classList.contains('chrome-idle')) {
      document.body.classList.remove('chrome-idle');
      // Re-measure NOW: pointer-events has just changed back, and on TV the row model
      // is about to be rebuilt by the very keypress that woke us.
      if (IS_TV) tvInvalidate();
    }
    chromeArm();
  }

  // `click` is in the list despite pointerdown covering a real mouse: activation that
  // never produces a pointer event still has to wake the bar -- assistive technology,
  // and any remote or automation that synthesises a click directly.
  ['pointermove', 'pointerdown', 'touchstart', 'wheel', 'keydown', 'click'].forEach(ev =>
    document.addEventListener(ev, chromeWake, { passive: true, capture: true }));
  window.addEventListener('scroll', chromeWake, { passive: true });
  // Focus landing in the bar (Tab, or the router placing the ring) must reveal it.
  document.addEventListener('focusin', (e) => {
    if (e.target.closest && e.target.closest('header.top')) chromeWake();
  });
  chromeArm();

  if (IS_TV) {
    document.body.classList.add('tv');
    document.documentElement.classList.add('tv');   // stage.css: no ambient transition on TV
    if (IS_WEBOS) document.documentElement.classList.add('webos');   // stage.css: the LG's 1280x720 canvas
    stageMount();
    document.addEventListener('keydown', tvSpatialNav);
    document.addEventListener('focusin', (e) => tvMark(e.target));
    // The cached geometry is only stale when the DOM or the viewport changes.
    if (window.MutationObserver) {
      const mo = new MutationObserver(tvInvalidate);
      mo.observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener('resize', tvInvalidate);
    window.addEventListener('load', tvInvalidate);
    // Safety net: if anything drops focus all the way to <body> the remote looks
    // dead, so catch it on the way down and put the ring back. (An iframe holding
    // focus is the player doing its job — leave that alone.)
    document.addEventListener('focusout', () => setTimeout(() => {
      if (tvObserver || cursorActive()) return;   // a route change or the pointer owns focus
      const a = document.activeElement;
      if (!a || a === document.body || a === document.documentElement) tvRestoreFocus();
    }, 0));
    tvFocusFirst();
  }

  // The remote's BACK: modal -> dock -> countdown -> full screen -> rail -> history -> exit.
  // Android's hardware Back and webOS's Back key (461) both come here; `exit` leaves the app.
  function remoteBack(exit) {
      // Overlays first, innermost outwards. Without these the universal Android
      // dismiss gesture either quits the app (at navDepth 0) or navigates the page
      // underneath while the overlay and its scrim stay mounted on top.
      if (document.getElementById('lock')) { exit(); return; }   // nothing behind the lock
      if (document.getElementById('acct-menu')) { closeAcct(); return; }
      const modal = document.querySelector('.modal-back');
      if (modal) { closeModal(modal); return; }
      // A running countdown owns the first Back: cancel it and stay in the episode. Back is
      // the cancel key on a remote, and it used to throw the viewer out of the player while
      // the countdown ticked on and dragged them into the next episode anyway.
      if (dockClose()) return;                     // the player's dock first: back to the picture
      if (nextUpCount) { nextUpDismissed = true; nextUpHide(); return; }
      // ONE press leaves full screen. There is only one mode now, so the old three-step
      // unwind -- drop the pointer, reveal a scrim, then leave -- was two presses of
      // ceremony and a button nobody asked to see. It lands on the watch page, where the
      // player keeps playing in the page (full screen is OK on the picture, not where Play
      // goes), and the next Back leaves the page.
      if (cursorActive() || document.body.classList.contains('cinema-on')) {
        exitCinema();
        return;
      }
      // In the side rail, Back closes it and returns to where you were, like Right does.
      const ae = document.activeElement;
      if (ae && ae.closest && ae.closest('header.top')) { railLeave(); return; }
      // history.length never decreases, so testing it meant exitApp() was unreachable
      // after the very first navigation and Back became inert on the home screen.
      // Track our own depth instead: Android TV's contract is "Back on root exits".
      if (navDepth > 0) { history.back(); return; }
      exit();
  }
  // Android: the reliable escape hatch, it fires even while focus is inside the player iframe.
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    const App = window.Capacitor.Plugins.App;
    App.addListener('backButton', () => remoteBack(() => App.exitApp()));
  }
  // webOS: the shell's appinfo.json sets disableBackHistoryAPI, so Back arrives here as key 461
  // instead of the system walking history on its own (which skipped the dock and full screen).
  // Keys go to whatever has focus, and a Magic Remote click on a player's controls moves focus
  // INTO the cross-origin frame, where our Back never arrives -- so focus is taken back a moment
  // after; the click itself has already landed.
  if (IS_WEBOS) {
    document.addEventListener('keydown', (e) => {
      if (e.keyCode !== 461 && e.key !== 'GoBack' && e.key !== 'BrowserBack') return;
      e.preventDefault(); e.stopPropagation();
      remoteBack(() => { try { window.close(); } catch (er) {} });
    }, true);
    window.addEventListener('blur', () => setTimeout(() => {
      const a = document.activeElement;
      if (!a || a.tagName !== 'IFRAME') return;
      const back = document.getElementById('tv-cursor') || document.querySelector('.player-frame[tabindex="0"]');
      if (back) try { back.focus({ preventScroll: true }); } catch (er) {}
    }, 400));
  }

  // The desktop app has no browser chrome: no Back button, no Alt+Left (a null menu means no
  // accelerators), and the mouse's thumb buttons do nothing. A browser does all of this itself,
  // so this is for Electron only -- doing it twice there would go back two pages.
  if (IS_DESKTOP) {
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;   // Option+Left is "back a word" on a Mac
      const alt = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey, cmd = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      if ((alt && e.key === 'ArrowLeft') || (cmd && e.key === '[')) { e.preventDefault(); history.back(); }
      else if ((alt && e.key === 'ArrowRight') || (cmd && e.key === ']')) { e.preventDefault(); history.forward(); }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 3) { e.preventDefault(); history.back(); }
      else if (e.button === 4) { e.preventDefault(); history.forward(); }
    });
  }

  // LAST STATEMENT IN THE MODULE, deliberately. Every `const`/`let` above is initialised
  // by now, so boot() cannot fall into a temporal dead zone, and the `tv` class plus the
  // D-pad listeners are already installed before the first paint.
  boot();

})();
