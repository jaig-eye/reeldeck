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

  // Mirror list lifted verbatim from the source site's own player module.
  // These are third-party embed providers — the app just frames them. Fully
  // editable/removable in Settings. Placeholders resolved by buildSourceUrl().
  // Autoplay: the WebView is started with setMediaPlaybackRequiresUserGesture(false)
  // (Capacitor's Bridge does it) and the player iframe carries allow="autoplay", so a
  // mirror that asks to autoplay is permitted to. Whether it ASKS is per-provider:
  //   verified   - all but two, each read from the provider's own docs page or its own
  //                shipped player bundle. Note the CASE: VidKing, Cinemaos and VidFast
  //                parse the literal string 'autoPlay=true' and ignore 'autoplay=1'.
  //   unverified - MultiEmbed and AutoEmbed publish nothing we could confirm, so no
  //                parameter is invented for them. An unknown query parameter would be
  //                ignored, but so would our claim to know it.
  // Caveat worth knowing: VidSrc's own docs say click-free autoplay works on custom
  // domains only, so on their public hosts a play button still appears first.
  // Ad-free tiers commonly ignore autoplay on purpose, and no parameter overrides a
  // browser's own block on unmuted autoplay — this raises the odds, it is not a promise.
  const DEFAULT_SOURCES = [
    { name: 'VidSrcMe',   movie: 'https://vidsrcme.su/embed/movie/{id}?autoplay=1',           tv: 'https://vidsrcme.su/embed/tv/{id}/{season}/{episode}?autoplay=1' },
    { name: 'VidKing',    movie: 'https://www.vidking.net/embed/movie/{id}?autoPlay=true',    tv: 'https://www.vidking.net/embed/tv/{id}/{season}/{episode}?autoPlay=true&nextEpisode=true&episodeSelector=true' },
    { name: 'VidEasy',    movie: 'https://player.videasy.net/movie/{id}?color=%23{color}',    tv: 'https://player.videasy.net/tv/{id}/{season}/{episode}?color=%23{color}&nextEpisode=true&autoplayNextEpisode=true&episodeSelector=true' },
    { name: 'Cinemaos',   movie: 'https://cinemaos.tech/player/{id}?autoPlay=true',                         tv: 'https://cinemaos.tech/player/{id}/{season}/{episode}?autoPlay=true' },
    { name: 'VidSrc RU',  movie: 'https://vidsrc-embed.ru/embed/movie/{id}?autoplay=1',       tv: 'https://vidsrc-embed.ru/embed/tv/{id}/{season}/{episode}?autoplay=1' },
    { name: 'VidSrc SU',  movie: 'https://vidsrc-embed.su/embed/movie/{id}?autoplay=1',       tv: 'https://vidsrc-embed.su/embed/tv/{id}/{season}/{episode}?autoplay=1' },
    { name: 'MultiEmbed', movie: 'https://multiembed.mov/?video_id={id}&tmdb=1',              tv: 'https://multiembed.mov/?video_id={id}&tmdb=1&s={season}&e={episode}' },
    { name: 'Vsrc',       movie: 'https://vsrc.su/embed/movie/{id}?autoplay=1',               tv: 'https://vsrc.su/embed/tv/{id}/{season}/{episode}?autoplay=1' },
    { name: 'VidLink',    movie: 'https://vidlink.pro/movie/{id}',                            tv: 'https://vidlink.pro/tv/{id}/{season}/{episode}' },
    { name: 'AutoEmbed',  movie: 'https://player.autoembed.app/embed/movie/{id}',             tv: 'https://player.autoembed.app/embed/tv/{id}/{season}/{episode}' },
    { name: 'VidFast',    movie: 'https://vidfast.pro/movie/{id}?autoPlay=true',                            tv: 'https://vidfast.pro/tv/{id}/{season}/{episode}?autoPlay=true' },
    { name: '111Movies',  movie: 'https://111movies.com/movie/{id}?autoplay=true',                          tv: 'https://111movies.com/tv/{id}/{season}/{episode}?autoplay=true' },
    { name: 'Vidora',     movie: 'https://vidora.su/movie/{id}?autoplay=true',                tv: 'https://vidora.su/tv/{id}/{season}/{episode}?autoplay=true' },
    { name: 'Smashy',     movie: 'https://player.smashystream.com/movie/{id}?autoplay=true',  tv: 'https://player.smashystream.com/tv/{id}?s={season}&e={episode}&autoplay=true' }
  ];

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
    // Install-on-TV: where the Android APK lives. apkShortUrl is an optional
    // manual override; apkShortAuto is the auto-generated short link (cached,
    // keyed by apkShortAutoFor so it regenerates only when apkUrl changes).
    apkUrl:   'https://github.com/jaig-eye/reeldeck/releases/latest/download/Reeldeck.apk',
    apkShortUrl: '',
    apkShortAuto: '',
    apkShortAutoFor: '',
    // OFF by default: the iframe sandbox trips "Iframe Sandbox Detected" on most
    // providers (it's their anti-adblock gate). The desktop app blocks pop-under/ad
    // requests at the network layer instead, so video plays AND the ads are gone.
    blockPlayerAds: false,
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
    { id: 'onyx',     name: 'Onyx',     accent: '#22d3ee', preview: ['#000000', '#17171b', '#22d3ee'] },
    { id: 'aurora',   name: 'Aurora',   accent: '#d946ef', preview: ['#0f0a1a', '#251a42', '#d946ef'] },
    { id: 'ocean',    name: 'Ocean',    accent: '#2dd4bf', preview: ['#06121a', '#143240', '#2dd4bf'] },
    { id: 'ember',    name: 'Ember',    accent: '#fb923c', preview: ['#14100d', '#2c211a', '#fb923c'] },
    { id: 'daylight', name: 'Daylight', accent: '#4f46e5', preview: ['#f4f5f7', '#ffffff', '#4f46e5'] }
  ];

  let cfg = loadConfig();

  function loadConfig() {
    let c;
    try { c = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}')); }
    catch (e) { c = Object.assign({}, DEFAULTS); }
    // deep-copy sources so editing them never mutates DEFAULT_SOURCES
    c.sources = (Array.isArray(c.sources) ? c.sources : DEFAULT_SOURCES).map(s => Object.assign({}, s));
    // Sources are snapshotted into localStorage on first run, so a shipped fix to a
    // provider's URL (an autoplay parameter, a moved domain) would never reach anyone
    // who already has the app. Refresh the entries we ship by name and leave anything
    // the user added themselves alone.
    c.sources = c.sources.map(s => {
      const std = DEFAULT_SOURCES.find(d => d.name === s.name);
      return std ? Object.assign({}, s, { movie: std.movie, tv: std.tv }) : s;
    });
    // ...and pick up providers added in a later release.
    DEFAULT_SOURCES.forEach(d => {
      if (!c.sources.some(s => s.name === d.name)) c.sources.push(Object.assign({}, d));
    });
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
    const r = await fetch(u.toString());
    if (!r.ok) {
      let msg = 'Request failed (' + r.status + ')';
      try { const j = await r.json(); if (j && j.status_message) msg = j.status_message; } catch (_) {}
      if (r.status === 401) msg = 'TMDB rejected the API key. Add your own free key in Settings.';
      throw new Error(msg);
    }
    return r.json();
  }

  /* ------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------ */
  const $  = (s, r) => (r || document).querySelector(s);
  const view = () => $('#view');

  // Desktop (Electron) exposes a trusted bridge; on the web we fall back to window.open.
  const IS_DESKTOP = !!(window.reeldeck && window.reeldeck.desktop);
  const IS_TV = /ReeldeckTV/.test(navigator.userAgent || '') || location.href.indexOf('tv=1') >= 0;
  const APP_VERSION = '1.0.12';   // bump with each release (matches package.json)
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
  let routeKey = null;      // identifies the view, to tell a filter change from a navigation
  const routeIs = (n) => n === routeSeq;
  let tvUserMoved = false;  // the user has taken over — stop placing the ring for them
  // Every horizontal scroller in the app. ONE list, used for three separate jobs:
  // grouping a carousel into a single D-pad row, correcting a cached column for the
  // rail's scrollLeft, and scrolling the focused item into view. They drifted apart
  // once already -- the season rail was in none of them, so the ring could sit on a
  // season that was off screen with nothing scrolling to reveal it.
  const TV_ROW_CONTAINERS = '.track, .cast-track, .ep-list, .season-pills, .ep-strip';
  // Where a freshly rendered page should put the ring — the thing the user came to
  // press. This is a PRIORITY ORDER, tried one selector at a time: as a single
  // querySelectorAll it would have returned document order instead, which only
  // happened to agree with the intent on today's markup.
  // NB: the search field is deliberately absent. It is the first focusable in the
  // search page's markup, so the generic fallback still lands on it when there are no
  // results — but once results exist they win, instead of trapping the ring on the box
  // you just typed into and making you press Back to reach what you searched for.
  const TV_LANDING = ['#player-enter', '.bb-slide.on .bb-cta .btn.primary',
                      '.dv-stage .cta .btn.primary', '.grid .card', '.rail .track .card'];
  // Chrome pinned to the VIEWPORT rather than the document. Measured with no scroll
  // offset so its row keeps a fixed place in the order — otherwise the update
  // banner's row slides down through the rails by exactly scrollY on every rebuild.
  // #tv-controls only counts as pinned while cinema mode has it fixed over the
  // player; in normal flow it is an ordinary row and must be measured as one.
  const TV_PINNED = 'header.top, #update-banner, #cinema-exit, .toast, #next-up, body.cinema-on #tv-controls';
  let tvRowSeq = 0;                                  // stable ids for carousel rows
  let tvColX = null;                                 // column held while moving vertically
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
  function img(path, size) {
    if (!path) return PLACEHOLDER;
    return cfg.imgBase.replace(/\/+$/, '') + '/' + size + path;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function year(d) { return d ? String(d).slice(0, 4) : ''; }
  function runtimeStr(m) { if (!m) return ''; const h = Math.floor(m / 60), mm = m % 60; return (h ? h + 'h ' : '') + (mm ? mm + 'm' : ''); }
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); const a = arguments, c = this; t = setTimeout(() => fn.apply(c, a), ms); }; }

  let toastTimer;
  // role="status" so the confirmation is actually announced — on TV the toast is the
  // only feedback the hero's Save button gives.
  function toast(msg) {
    let t = $('#toast');
    if (!t) {
      t = document.createElement('div'); t.id = 'toast'; t.className = 'toast';
      t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite');
      document.body.appendChild(t);
    }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // Cache of items we render so watchlist toggles can find full data by id.
  const itemCache = {};
  const ck = (type, id) => type + ':' + id;

  /* ------------------------------------------------------------
     Icons
     ------------------------------------------------------------ */
  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4h12a1 1 0 011 1v15l-7-4-7 4V5a1 1 0 011-1z"/></svg>',
    bookmarkFill: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h12a1 1 0 011 1v15l-7-4-7 4V5a1 1 0 011-1z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 6.9 7.5.6-5.7 5 1.8 7.4L12 18.2 5.4 21.9l1.8-7.4-5.7-5 7.5-.6z"/></svg>',
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10"/></svg>',
    tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M8 3l4 4 4-4"/></svg>',
    cast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 16a6 6 0 016 6M2 12a10 10 0 0110 10M2 20a2 2 0 012 2"/><path d="M2 8V6a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2h-6"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>',
    chevR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6L9 17l-5-5"/></svg>',
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>'
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
    if (i >= 0) { list.splice(i, 1); setWatch(list); toast('Removed from watchlist'); return false; }
    list.unshift({
      id: item.id, type,
      title: item.title || item.name,
      poster_path: item.poster_path,
      vote_average: item.vote_average,
      date: item.release_date || item.first_air_date || ''
    });
    setWatch(list); toast('Added to watchlist'); return true;
  }


  /* ------------------------------------------------------------
     Watch progress + history (localStorage)

     A cross-origin player cannot be scripted, so there is no reading currentTime
     off the <video> inside a mirror. Two tiers instead:

       provider - the mirror POSTS its own position to the parent. VidLink documents
                  MEDIA_DATA / PLAYER_EVENT with currentTime + duration; others use
                  the same shape. Exact, and the only real answer available.
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
    const now = Date.now(); let changed = false;
    for (const k in p) {
      if (k.indexOf('movie:') === 0 && (now - ((p[k] && p[k].at) || 0)) > MOVIE_TTL) { delete p[k]; changed = true; }
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
    // A wall-clock guess must never walk over a real timestamp from the player.
    if (o.src !== 'provider' && prev.src === 'provider') return;
    const pct = dur > 0 ? Math.max(0, Math.min(1, t / dur)) : (prev.pct || 0);
    p[k] = { t: Math.round(t), d: Math.round(dur), pct: pct, at: Date.now(), src: o.src || prev.src || 'elapsed' };
    // Series-level pointer: which episode to drop the user back on.
    if (o.type === 'tv') p['tv:' + o.id] = { s: +o.season || 1, e: +o.episode || 1, at: Date.now() };
    progSave(p);
    histPush(o, pct);
  }

  function histAll() {
    try { const h = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); return Array.isArray(h) ? h : []; }
    catch (e) { return []; }
  }
  function histSave(h) { try { localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, HIST_MAX))); } catch (e) {} }
  function histClear() { try { localStorage.removeItem(HIST_KEY); } catch (e) {} }
  function progClear() { try { localStorage.removeItem(PROG_KEY); } catch (e) {} }
  function relTime(ms) {
    const sec = Math.max(0, (Date.now() - (ms || 0)) / 1000);
    if (sec < 90) return 'just now';
    const m = sec / 60; if (m < 60) return Math.round(m) + 'm ago';
    const h = m / 60; if (h < 24) return Math.round(h) + 'h ago';
    const dd = h / 24; if (dd < 7) return Math.round(dd) + 'd ago';
    try { return new Date(ms).toLocaleDateString(); } catch (e) { return 'a while ago'; }
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
      pct: pct, at: Date.now()
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
  function progForget(key) {
    if (!key) return;
    const p = progAll();
    delete p[key];
    // A series pointer with no episodes left behind it would keep aiming "Resume" at
    // an episode the user has explicitly dismissed.
    const m = /^tv:(\d+):/.exec(key);
    if (m && !Object.keys(p).some(k => k.indexOf('tv:' + m[1] + ':') === 0)) delete p['tv:' + m[1]];
    progSave(p);
    histSave(histAll().filter(r => r.k !== key));
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

  /** Everything started but not finished, newest first — drives "Continue watching". */
  function progResumable() {
    const p = progAll(); if (progPrune(p)) progSave(p);
    const hist = histAll();
    const out = [];
    for (const row of hist) {
      const pr = p[row.k];
      if (!pr || progDone(pr) || !(pr.pct > 0.01)) continue;
      out.push(Object.assign({}, row, { pr: pr }));
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
  // Every entry here was confirmed against a FIRST-PARTY source: the provider's own
  // docs page or, where there is no docs page, its own shipped player bundle. Nothing
  // is seeded on resemblance to another provider. MultiEmbed and AutoEmbed publish
  // nothing we could confirm and are deliberately absent -- they can still earn the
  // badge at runtime the first time they report a real position.
  const TRACK_SEED = {
    'VidSrcMe': 1, 'VidSrc RU': 1, 'VidSrc SU': 1, 'Vsrc': 1,   // vidsrc/docs PLAYER_EVENT
    'VidKing': 1,                                                // its own VideoPlayer bundle
    'VidEasy': 1,                                                // videasy.to/docs
    'Cinemaos': 1,                                               // cinemaos.tech/embed docs
    'VidLink': 1, 'VidFast': 1, '111Movies': 1,                  // MEDIA_DATA / PLAYER_EVENT
    'Vidora': 1, 'Smashy': 1
  };
  function trackedAll() {
    let t; try { t = JSON.parse(localStorage.getItem(TRACK_KEY) || 'null'); } catch (e) { t = null; }
    return Object.assign({}, TRACK_SEED, (t && typeof t === 'object' && !Array.isArray(t)) ? t : {});
  }
  function isTracked(name) { return !!(name && trackedAll()[name]); }
  function markTracked(name) {
    if (!name || isTracked(name)) return;
    const t = trackedAll(); t[name] = 1;
    try { localStorage.setItem(TRACK_KEY, JSON.stringify(t)); } catch (e) {}
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
   * Confirmed shapes, all from first-party sources:
   *   PLAYER_EVENT  data.currentTime / data.duration          VidKing, VidEasy, VidFast,
   *                                                           111Movies, VidLink, Smashy
   *   PLAYER_EVENT  data.player_progress / player_duration    the whole VidSrc family
   *   MEDIA_DATA    data.progress.watched / .duration         Vidora
   *   MEDIA_DATA    data[<id>].progress.watched / .duration   VidLink, Cinemaos, VidFast
   *
   * Two traps this deliberately avoids:
   *  - VidKing's TV MEDIA_DATA carries progress.watched/TOTAL counting EPISODES, not
   *    seconds. Requiring a `duration` (never `total`) rejects it, and the real
   *    per-episode seconds are picked up from show_progress instead.
   *  - VidKing's and 111Movies' PLAYER_EVENT `progress` is a PERCENTAGE. It is never
   *    read as a position; only currentTime is.
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
    for (const k in body) {
      const v = body[k];
      if (!v || typeof v !== 'object') continue;
      if (v.progress) {
        hit = pick(v.progress.watched, v.progress.duration);
        if (hit) return hit;
        // TV: the seconds live per episode, under show_progress["s2e5"].
        const sp = v.show_progress;
        if (sp && typeof sp === 'object' && watchNow && watchNow.season) {
          const ep = sp['s' + watchNow.season + 'e' + watchNow.episode];
          if (ep && ep.progress) {
            hit = pick(ep.progress.watched, ep.progress.duration);
            if (hit) return hit;
          }
        }
      }
    }
    return null;
  }

  let watchNow = null;
  function playerOrigin() {
    const fr = document.getElementById('player-iframe');
    if (!fr || !fr.src) return null;
    try { return new URL(fr.src).origin; } catch (e) { return null; }
  }
  window.addEventListener('message', (ev) => {
    if (!watchNow) return;
    const want = playerOrigin();
    if (!want || ev.origin !== want) return;      // not the mirror we are showing
    let d = ev.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || typeof d !== 'object') return;
    const pos = readPosition(d);
    if (!pos) return;
    const t = pos.t, dur = pos.d;
    progRecord(Object.assign({}, watchNow, { t: t, d: dur, src: 'provider' }));
    markTracked(watchNow.source);   // it just proved it — promote it
    if (!nextUpDismissed) nextUpCheck(t, dur);
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
  const NEXT_UP_WINDOW = 150;
  function nextUpCheck(t, dur) {
    if (!watchNow || !watchNow.nextHref) return;
    // Ignore nonsense durations: a mirror reporting a 90-second "duration" while it
    // loads would otherwise fire this immediately.
    if (!(dur > 300)) return;
    const left = dur - t;
    if (left > NEXT_UP_WINDOW || left < 1) return nextUpHide();
    nextUpShow();
  }
  function nextUpShow() {
    if (!watchNow || document.getElementById('next-up')) return;
    const el = document.createElement('div');
    el.id = 'next-up'; el.className = 'next-up';
    el.innerHTML = '<span class="nu-k">Up next</span>' +
      '<span class="nu-t">' + esc(watchNow.nextLabel || 'Next episode') + '</span>' +
      '<button class="btn primary sm" id="nu-go">' + ICON.play + ' Play</button>' +
      '<button class="btn sm" id="nu-x" aria-label="Dismiss">' + ICON.x + '</button>';
    document.body.appendChild(el);
    el.querySelector('#nu-go').onclick = () => { const h = watchNow && watchNow.nextHref; nextUpHide(); if (h) go(h); };
    el.querySelector('#nu-x').onclick = () => { nextUpDismissed = true; nextUpHide(); };
    // Deliberately does NOT take the ring. Two reasons:
    //  - Pointer mode is the DEFAULT during TV playback (#player-enter's handler is
    //    cursorOn), and while it is on, Enter goes to cursorTap() -- a blind tap at
    //    wherever the cursor is parked, usually the middle of the video. The ring
    //    would sit on Play promising an activation that cannot happen.
    //  - Stealing focus from whatever the viewer was doing, for a prompt they did
    //    not ask for, loses their place in the episode strip.
    // #next-up is in TV_PINNED and passes the cinema occlusion filter, so the D-pad
    // reaches it on its own, and a pointer tap works because it is the topmost hit
    // target at z-index 320.
    if (IS_TV) tvInvalidate();
  }
  function nextUpHide() {
    const el = document.getElementById('next-up');
    if (!el) return;
    const hadFocus = el.contains(document.activeElement);
    el.remove();
    // tvFocusFirst() would re-run the landing list and jump to #player-enter, which
    // scrolls the page to the top -- so only recover focus if it was actually in the
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
    // progResumable drops it from Continue watching -- the resume point is destroyed.
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
  function watchTick() {
    if (!watchNow) return;
    const cur = progGet(watchNow.type, watchNow.id, watchNow.season, watchNow.episode);
    if (cur && cur.src === 'provider') return;
    const secs = Math.round((Date.now() - watchNow.started) / 1000);
    const t = watchNow.base + secs;
    progRecord(Object.assign({}, watchNow, { t: t, d: watchNow.runtime || 0, src: 'elapsed' }));
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
  function cardHTML(item, forcedType) {
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
        <span class="typebadge">${type === 'tv' ? 'TV' : 'Movie'}</span>
        <button class="wl ${on ? 'on' : ''}" data-wl="${item.id}" data-type="${type}"${IS_TV ? ' tabindex="-1" aria-hidden="true"' : ''} aria-pressed="${on}" title="${on ? 'Remove from' : 'Add to'} watchlist" aria-label="${on ? 'Remove from' : 'Add to'} watchlist">
          ${on ? ICON.bookmarkFill : ICON.bookmark}
        </button>
        <div class="card-hover">
          <button class="ch-play" data-nav="${watchHref(type, item.id)}" tabindex="-1" aria-hidden="true">${ICON.play}</button>
          <div class="ch-cap"><div class="ch-title">${esc(title)}</div><div class="ch-meta">${y || ''}${rating ? ' \u00b7 \u2605 ' + rating : ''}</div></div>
        </div>
        ${(() => { const p = Math.round(cardProgress(type, item.id) * 100);
          return p > 1 ? `<span class="card-prog" role="img" aria-label="${p} percent watched"><i style="width:${p}%"></i></span>` : ''; })()}
      </div>
      <div class="cap"><div class="t">${esc(title)}</div><div class="y">${y || '—'}</div></div>
    </div>`;
  }

  function railHTML(title, items, moreHref, type) {
    if (!items || !items.length) return '';
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

  /** Everything started and not finished, deep-linked to the exact episode. */
  function continueRailHTML() {
    let rows = progResumable();
    if (!rows.length) return '';
    if (IS_TV) rows = rows.slice(0, 14);
    const tiles = rows.slice(0, 20).map(r => {
      const href = r.type === 'tv'
        ? ('#/watch/tv/' + r.id + '?s=' + (r.s || 1) + '&e=' + (r.e || 1))
        : ('#/watch/movie/' + r.id);
      const sub = r.type === 'tv' ? ('S' + (r.s || 1) + ' \u00b7 E' + (r.e || 1)) : 'Film';
      const pct = Math.round(Math.min(1, r.pr.pct) * 100);
      const at = (r.pr.src === 'provider' && r.pr.t > 0) ? fmtClock(r.pr.t) : (pct + '%');
      return `<div class="card" data-nav="${href}" tabindex="0" role="button"
                   aria-label="Resume ${esc(r.title || 'title')}, ${sub}, ${pct} percent watched">
        <div class="poster">
          <img loading="lazy" src="${img(r.poster_path, 'w342')}" alt="" onerror="this.src='${PLACEHOLDER}'">
          <span class="card-prog"><i style="width:${pct}%"></i></span>
        </div>
        <div class="cap"><div class="t">${esc(r.title || 'Untitled')}</div><div class="y">${sub} \u00b7 ${at}</div></div>
        <button class="cw-x" data-unwatch="${esc(r.k)}" tabindex="${IS_TV ? '0' : '-1'}"
                aria-label="Remove ${esc(r.title || 'this title')} from Continue watching">${ICON.x}</button>
      </div>`;
    }).join('');
    return `<section class="rail">
      <div class="rail-head"><h2>Continue watching</h2></div>
      <div class="rail-wrap">
        <button class="rail-arrow left" data-rail="-1" tabindex="-1" aria-label="Scroll left">${ICON.back}</button>
        <div class="track">${tiles}</div>
        <button class="rail-arrow right" data-rail="1" tabindex="-1" aria-label="Scroll right">${ICON.chevR}</button>
      </div>
    </section>`;
  }

  /**
   * Recently watched, as a rail. Continue watching answers "finish this"; this
   * answers "take me back to that", which includes things already finished -- a
   * series you are rewatching, an episode you want to re-open. Anything already
   * shown in Continue watching is excluded so the two rails never duplicate.
   */
  function recentRailHTML() {
    const resumable = new Set(progResumable().map(r => r.k));
    let rows = histAll().filter(r => !resumable.has(r.k));
    if (!rows.length) return '';
    if (IS_TV) rows = rows.slice(0, 14);
    const tiles = rows.slice(0, 20).map(r => {
      const href = r.type === 'tv'
        ? ('#/watch/tv/' + r.id + '?s=' + (r.s || 1) + '&e=' + (r.e || 1))
        : ('#/watch/movie/' + r.id);
      const sub = r.type === 'tv' ? ('S' + (r.s || 1) + ' \u00b7 E' + (r.e || 1)) : 'Film';
      const pr = progGet(r.type, r.id, r.s, r.e);
      const pct = pr ? Math.round(Math.min(1, pr.pct || 0) * 100) : 0;
      return `<div class="card" data-nav="${href}" tabindex="0" role="button"
                   aria-label="${esc(r.title || 'title')}, ${sub}, watched ${relTime(r.at)}">
        <div class="poster">
          <img loading="lazy" src="${img(r.poster_path, 'w342')}" alt="" onerror="this.src='${PLACEHOLDER}'">
          ${pct > 1 ? `<span class="card-prog"><i style="width:${pct}%"></i></span>` : ''}
        </div>
        <div class="cap"><div class="t">${esc(r.title || 'Untitled')}</div><div class="y">${sub} \u00b7 ${relTime(r.at)}</div></div>
      </div>`;
    }).join('');
    return `<section class="rail">
      <div class="rail-head"><h2>Recently watched</h2>
        <a class="more" href="#/watchlist" data-nav="#/watchlist"${IS_TV ? ' tabindex="-1"' : ''}>Full history ${ICON.chevR}</a></div>
      <div class="rail-wrap">
        <button class="rail-arrow left" data-rail="-1" tabindex="-1" aria-label="Scroll left">${ICON.back}</button>
        <div class="track">${tiles}</div>
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
        <img class="hist-poster" loading="lazy" src="${img(r.poster_path, 'w154')}" alt="" onerror="this.src='${PLACEHOLDER}'">
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
            <span class="rank-num">${i + 1}</span>
            <div class="poster">
              <img loading="lazy" src="${img(it.poster_path, 'w342')}" onerror="this.src='${PLACEHOLDER}'" alt="${esc(it.title || it.name)}">
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
  async function genres(type) {
    if (GENRES[type]) return GENRES[type];
    const d = await tmdb('/genre/' + type + '/list');
    GENRES[type] = d.genres || [];
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
    try {
      const type = item.media_type || (item.first_air_date ? 'tv' : 'movie');
      const d = await tmdb('/' + type + '/' + item.id + '/images', { include_image_language: 'en,null', language: 'en' });
      const logos = (d.logos || []).filter(l => l.file_path && (l.iso_639_1 === 'en' || l.iso_639_1 === null));
      logos.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
      return logos[0] ? img(logos[0].file_path, 'w500') : null;
    } catch (e) { return null; }
  }

  function billboardSlide(it, i) {
    const type = it.media_type || (it.first_air_date ? 'tv' : 'movie');
    const title = it.title || it.name || '';
    const y = year(it.release_date || it.first_air_date);
    const rating = it.vote_average ? it.vote_average.toFixed(1) : null;
    const on = isInWatch(it.id, type);
    const ov = (it.overview || '').slice(0, 200);
    return `<div class="bb-slide ${i === 0 ? 'on' : ''}" data-i="${i}">
      <div class="bb-bg" style="background-image:url('${img(it.backdrop_path, 'w1280')}')"></div>
      <div class="bb-scrim"></div>
      <div class="bb-info">
        ${it._logo
          ? `<img class="bb-logo" src="${it._logo}" alt="${esc(title)}" onerror="this.style.display='none';var h=this.nextElementSibling;if(h)h.style.display='block'"><h1 class="bb-title" style="display:none">${esc(title)}</h1>`
          : `<h1 class="bb-title">${esc(title)}</h1>`}
        <div class="bb-meta">
          ${rating ? `<span class="pill rating">${ICON.star}${rating}</span>` : ''}
          <span>${y || ''}</span>
          <span class="pill-type">${type === 'tv' ? 'Series' : 'Film'}</span>
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
      tvInvalidate();   // a different slide's buttons are focusable now
    };
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

  async function homeView() {
    const my = routeSeq;
    clearHero();
    view().innerHTML = `<div class="billboard-sk sk"></div><div class="rows">${skeletonRow()}${skeletonRow()}</div>`;
    try {
      const [trend, popM, popT, topM, upcoming] = await Promise.all([
        tmdb('/trending/all/day'), tmdb('/movie/popular'), tmdb('/tv/popular'),
        tmdb('/movie/top_rated'), tmdb('/movie/upcoming', { region: cfg.region })
      ]);
      const trendItems = (trend.results || []).filter(x => x.media_type !== 'person');
      const heroItems = trendItems.filter(x => x.backdrop_path).slice(0, 5);
      const logos = await Promise.all(heroItems.map(heroLogo));
      if (!routeIs(my)) return;   // the user has navigated away — this response is stale
      heroItems.forEach((h, i) => { h._logo = logos[i]; itemCache[ck(h.media_type, h.id)] = h; });
      let html = buildBillboard(heroItems);
      html += '<div class="rows">';
      html += continueRailHTML();      // above Top 10: it is why most people opened the app
      html += recentRailHTML();        // and the things already finished, to go back to
      html += rankRailHTML('Top 10 today', trendItems);
      html += railHTML('Popular movies', popM.results, '#/movies', 'movie');
      html += railHTML('Popular shows', popT.results, '#/tv', 'tv');
      html += railHTML('Top rated', topM.results, '#/movies?sort=vote_average.desc', 'movie');
      html += railHTML('Coming soon', upcoming.results, '#/movies?sort=primary_release_date.desc', 'movie');
      html += '</div>';
      view().innerHTML = html;
      wireBillboard();
    } catch (e) { if (routeIs(my)) errorState(e); }
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
    const gl = await genres(isTV ? 'tv' : 'movie').catch(() => []);

    // Build toolbar
    const sortSel = SORTS.map(s => `<option value="${s.v}" ${params.sort === s.v ? 'selected' : ''}>${s.label}</option>`).join('');
    const langSel = LANGS.map(l => `<option value="${l.v}" ${params.lang === l.v ? 'selected' : ''}>${l.label}</option>`).join('');
    const yNow = new Date().getFullYear();
    // Build the <select>s by marking the selected option while generating them. The old
    // blind String.replace could not match a year outside 1950…yNow+1, so an
    // out-of-range ?yfrom= showed "Any" and was then deleted by the next filter change.
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
      <div class="toolbar">
        <div class="field"><label for="f-sort">Sort</label><select id="f-sort">${sortSel}</select></div>
        <div class="field"><label for="f-yfrom">From year</label><select id="f-yfrom">${yearOptsFor(params.yfrom)}</select></div>
        <div class="field"><label for="f-yto">To year</label><select id="f-yto">${yearOptsFor(params.yto)}</select></div>
        <div class="field"><label for="f-rating">Min rating</label><select id="f-rating">
          ${['', '5', '6', '7', '8', '9'].map(r => `<option value="${r}" ${params.rating === r ? 'selected' : ''}>${r ? r + '+' : 'Any'}</option>`).join('')}
        </select></div>
        <div class="field"><label for="f-lang">Language</label><select id="f-lang">${langSel}</select></div>
        <div class="field genres-field"><label>Genres</label>
          <div class="chips" id="f-genres">
            ${gl.map(g => `<button class="chip ${selGenres.includes(String(g.id)) ? 'on' : ''}" data-genre="${g.id}" aria-pressed="${selGenres.includes(String(g.id))}">${esc(g.name)}</button>`).join('')}
          </div>
        </div>
      </div>`;

    view().innerHTML = `<h1 class="page-title">${q ? 'Search' : (isTV ? 'TV Shows' : 'Movies')}</h1>${toolbar}<div id="results">${skeletonGrid(18)}</div>`;

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
        const qs = p.toString();
        go('#/' + (isTV ? 'tv' : 'movies') + (qs ? '?' + qs : ''));
      };
      ['f-sort', 'f-yfrom', 'f-yto', 'f-rating', 'f-lang'].forEach(id => { const el = $('#' + id); if (el) el.onchange = upd; });
      const gEl = $('#f-genres');
      if (gEl) gEl.onclick = e => {
        const c = e.target.closest('.chip');
        if (c) { c.classList.toggle('on'); c.setAttribute('aria-pressed', String(c.classList.contains('on'))); upd(); }
      };
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
        data = await tmdb('/discover/' + (isTV ? 'tv' : 'movie'), p);
      }
      const results = (data.results || []).filter(x => x.poster_path || x.backdrop_path);
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
    if (!IS_TV) return '';
    return `<div class="tv-search">
      <span class="ico">${ICON.search}</span>
      <input id="tv-search-input" type="search" value="${esc(q)}" autocomplete="off"
             placeholder="Search movies, shows and people…" aria-label="Search movies, shows and people">
      <button class="btn primary" id="tv-search-go">Search</button>
    </div>`;
  }
  function wireTvSearch() {
    const inp = $('#tv-search-input'), btn = $('#tv-search-go');
    if (!inp) return;
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
    const empty = `<div class="center-note">${IS_TV ? 'Press OK on the box above to type.' : 'Use the search box above to find movies, shows and people.'}
      <div class="note-cta"><button class="btn primary" data-nav="#/movies">Browse movies</button><button class="btn" data-nav="#/tv">Browse shows</button></div></div>`;
    view().innerHTML = `<h1 class="page-title">${q ? 'Results for “' + esc(q) + '”' : 'Search'}</h1>${tvSearchBar(q)}
      <div id="results">${q ? skeletonGrid(12) : empty}</div>`;
    wireTvSearch();
    if (!q) return;
    try {
      const data = await tmdb('/search/multi', { query: q, page: 1, include_adult: 'false' });
      const results = (data.results || []).filter(x => x.media_type !== 'person' && (x.poster_path || x.backdrop_path));
      const box = $('#results');
      if (!box || !routeIs(my)) return;   // navigated away while the request was in flight
      box.innerHTML = results.length
        ? `<div class="grid">${results.map(i => cardHTML(i)).join('')}</div>`
        : `<div class="center-note">No titles found for “${esc(q)}”.
            <div class="note-cta"><button class="btn primary" data-nav="#/movies">Browse movies</button><button class="btn" data-nav="#/tv">Browse shows</button></div></div>`;
    } catch (e) { const box = $('#results'); if (box && routeIs(my)) { box.innerHTML = ''; errorState(e, '#results'); } }
  }
  /* ---------- Detail (movie & tv) ---------- */
  async function detailView(type, id) {
    const my = routeSeq;
    const isTV = type === 'tv';
    view().innerHTML = `<div class="sk" style="height:480px;border-radius:0;margin:-22px -22px 24px"></div><div class="section">${skeletonGrid(6)}</div>`;
    try {
      const [d, credits, videos, similar, ext, imgs] = await Promise.all([
        tmdb('/' + type + '/' + id),
        tmdb('/' + type + '/' + id + '/credits'),
        tmdb('/' + type + '/' + id + '/videos'),
        tmdb('/' + type + '/' + id + '/similar'),
        tmdb('/' + type + '/' + id + '/external_ids').catch(() => ({})),
        tmdb('/' + type + '/' + id + '/images', { include_image_language: 'en,null', language: 'en' }).catch(() => ({}))
      ]);
      itemCache[ck(type, d.id)] = d;
      d._imdb = ext.imdb_id;
      const title = d.title || d.name;
      const y = year(d.release_date || d.first_air_date);
      const _logos = (imgs.logos || []).filter(l => l.file_path && (l.iso_639_1 === 'en' || l.iso_639_1 === null)).sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
      const logoUrl = _logos[0] ? img(_logos[0].file_path, 'w500') : null;
      const gEls = (d.genres || []).map(g => `<button class="chip" data-nav="#/${isTV ? 'tv' : 'movies'}?genres=${g.id}">${esc(g.name)}</button>`).join('');
      const director = (credits.crew || []).filter(c => c.job === 'Director').map(c => c.name).join(', ');
      const creators = (d.created_by || []).map(c => c.name).join(', ');
      const trailer = (videos.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                      (videos.results || []).find(v => v.site === 'YouTube');
      const runtime = isTV
        ? ((d.number_of_seasons || 0) + ' season' + (d.number_of_seasons === 1 ? '' : 's'))
        : runtimeStr(d.runtime);
      const on = isInWatch(d.id, type);
      const hasProgress = hasAnyProgress(type, d.id);

      let html = `<div class="detail-hero">
        <div class="bg" style="background-image:url('${img(d.backdrop_path, 'w1280')}')"></div>
        <div class="scrim"></div>
        <div class="dv-stage">
          ${logoUrl
            ? `<img class="detail-logo" src="${logoUrl}" alt="${esc(title)}" onerror="this.style.display='none';var h=this.nextElementSibling;if(h)h.style.display='block'"><h1 class="dv-title" style="display:none">${esc(title)}</h1>`
            : `<h1 class="dv-title">${esc(title)}</h1>`}
          ${d.tagline ? `<p class="dv-tagline">${esc(d.tagline)}</p>` : ''}
          <div class="metarow">
            <span class="pill rating">${ICON.star}${d.vote_average ? d.vote_average.toFixed(1) : '\u2014'}</span>
            <span class="pill">${isTV ? 'Series' : 'Film'}</span>
            ${y ? `<span class="pill">${y}</span>` : ''}
            ${runtime ? `<span class="pill">${esc(runtime)}</span>` : ''}
            ${d.status ? `<span class="pill">${esc(d.status)}</span>` : ''}
          </div>
          <div class="dv-cta cta">
            <button class="btn primary" data-nav="${watchHref(type, d.id)}">${ICON.play} ${watchLabel(type, d.id)}</button>
            ${hasProgress ? `<button class="btn glass" data-nav="${restartHref(type, d.id)}" title="Start from the beginning">Restart</button>` : ''}
            ${trailer ? `<button class="btn glass" data-trailer="${trailer.key}">▶ Trailer</button>` : ''}
            <button class="btn ${on ? 'primary' : 'glass'}" data-wl="${d.id}" data-type="${type}" id="detail-wl">
              ${on ? ICON.bookmarkFill : ICON.bookmark} ${on ? 'In watchlist' : 'Watchlist'}
            </button>
          </div>
        </div>
      </div>`;

      // Cast is built BEFORE the body so it can sit inside the prose column. As its
      // own full-width section further down it left a large dead area beside the
      // overview, which is the emptiest part of the page and the obvious home for it.
      const cast = (credits.cast || []).slice(0, 14);
      const castBlock = cast.length ? `
        <h3 class="dv-sub">Cast</h3>
        <div class="cast-track">
          ${cast.map(c => `<div class="person" data-nav="#/person/${c.id}" tabindex="0" role="button" aria-label="${esc(c.name)}${c.character ? ' as ' + esc(c.character) : ''}">
            <img loading="lazy" src="${img(c.profile_path, 'w185')}" alt="" onerror="this.src='${PLACEHOLDER}'">
            <div class="n">${esc(c.name)}</div><div class="c">${esc(c.character || '')}</div>
          </div>`).join('')}
        </div>` : '';

      // Body: prose on the left at a readable measure, reference material on the
      // right. The poster lives here now -- useful for recognition, but no longer
      // covering a quarter of the artwork it was pasted on top of.
      html += `<div class="dv-body">
        <div class="dv-main">
          <h3>Overview</h3>
          <p class="overview">${esc(d.overview || 'No overview available.')}</p>
          <div class="genre-row">${gEls}</div>
          ${castBlock}
        </div>
        <aside class="dv-facts">
          <img class="dv-poster" src="${img(d.poster_path, 'w500')}" alt="" loading="lazy" onerror="this.style.display='none'">
          <dl>
            <dt>Rating</dt><dd class="dv-rate">${ICON.star}${d.vote_average ? d.vote_average.toFixed(1) : '\u2014'}${d.vote_count ? ` <span class="muted">(${d.vote_count.toLocaleString()})</span>` : ''}</dd>
            ${director ? `<dt>Director</dt><dd>${esc(director)}</dd>` : ''}
            ${creators ? `<dt>Created by</dt><dd>${esc(creators)}</dd>` : ''}
            ${runtime ? `<dt>${isTV ? 'Length' : 'Runtime'}</dt><dd>${esc(runtime)}</dd>` : ''}
            ${d.status ? `<dt>Status</dt><dd>${esc(d.status)}</dd>` : ''}
            ${(d.release_date || d.first_air_date) ? `<dt>Released</dt><dd>${esc(d.release_date || d.first_air_date)}</dd>` : ''}
          </dl>
        </aside>
      </div>`;

      // TV seasons
      if (isTV) {
        const seasons = (d.seasons || []).filter(s => s.season_number >= 1);
        html += `<div class="section" id="seasons">
          <h3>Episodes</h3>
          <div class="season-pills" id="season-pills" role="group" aria-label="Choose a season">
            ${seasons.map(x => `<button class="spill" aria-pressed="false" data-season="${x.season_number}">
                <span class="sp-n">Season ${x.season_number}</span>${x.episode_count ? `<span class="sp-c">${x.episode_count} eps</span>` : ''}
              </button>`).join('')}
          </div>
          <div class="ep-list" id="ep-list"></div>
        </div>`;
      }


      // Similar
      const sim = (similar.results || []).filter(x => x.poster_path).slice(0, 14);
      if (sim.length) html += `<div class="section">${railHTML(isTV ? 'Similar shows' : 'Similar movies', sim, null, type)}</div>`;

      if (!routeIs(my)) return;   // stale response — the user is on another page now
      view().innerHTML = html;
      window.scrollTo(0, 0);

      // Wire seasons
      if (isTV) {
        const pills = $('#season-pills');
        // Season changes are not cancellable, so without a sequence number whichever
        // response lands LAST wins — pick S1, S2, S3 quickly and a slow S2 can end up
        // rendered under a select reading "Season 3", with every episode link pointing
        // at the wrong season.
        let seasonSeq = 0;
        const loadSeason = async (n) => {
          const mine = ++seasonSeq, myRoute = routeSeq;
          const box = $('#ep-list'); if (!box) return;
          box.innerHTML = skeletonGrid(4);
          try {
            const s = await tmdb('/tv/' + id + '/season/' + n);
            if (mine !== seasonSeq || !routeIs(myRoute) || !document.contains(box)) return;
            box.innerHTML = (s.episodes || []).map(ep => {
              const pr = progGet('tv', id, n, ep.episode_number);
              const done = progDone(pr);
              const part = !!(pr && !done && pr.pct > 0.01);
              return `
              <div class="ep${done ? ' watched' : ''}" data-nav="#/watch/tv/${id}?s=${n}&e=${ep.episode_number}" tabindex="0" role="button"
                   aria-label="${done ? 'Rewatch' : part ? 'Resume' : 'Play'} season ${n} episode ${ep.episode_number}${ep.name ? ', ' + esc(ep.name) : ''}">
                <div class="ep-thumb">
                  <img class="thumb" alt="" loading="lazy" src="${img(ep.still_path, 'w300')}" onerror="this.src='${PLACEHOLDER}'">
                  ${(pr && pr.pct > 0.01) ? `<span class="ep-fill" style="width:${Math.round(Math.min(1, pr.pct) * 100)}%"></span>` : ''}
                  ${done ? `<span class="ep-tick" aria-hidden="true">${ICON.check}</span>` : ''}
                </div>
                <div style="min-width:0">
                  <div class="en">S${n} \u00b7 E${ep.episode_number}${ep.runtime ? ' \u00b7 ' + ep.runtime + 'm' : ''}</div>
                  <div class="et">${esc(ep.name || 'Episode ' + ep.episode_number)}</div>
                  <div class="eo">${esc(ep.overview || '')}</div>
                  ${progBar(pr)}
                </div>
                <button class="btn primary sm play" tabindex="-1" aria-hidden="true">${ICON.play} ${part ? 'Resume' : done ? 'Again' : 'Play'}</button>
              </div>`;
            }).join('') || '<div class="center-note">No episode data.</div>';
            // The row model caches; replacing every episode under it would otherwise
            // leave the D-pad navigating the season that just went away.
            if (IS_TV) tvInvalidate();
          } catch (e) {
            if (mine !== seasonSeq || !routeIs(myRoute) || !document.contains(box)) return;
            box.innerHTML = ''; errorState(e, '#ep-list');
          }
        };
        const markPill = (n) => {
          if (!pills) return;
          pills.querySelectorAll('.spill').forEach(b => {
            const on = (+b.dataset.season === +n);
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', String(on));
            // block:'nearest' so centring the pill never drags the PAGE around too.
            if (on) { try { b.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {} }
          });
        };
        if (pills) pills.onclick = (e2) => {
          const b = e2.target.closest('.spill'); if (!b) return;
          markPill(b.dataset.season); loadSeason(b.dataset.season);
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
    view().innerHTML = skeletonGrid(10);
    try {
      const [p, credits] = await Promise.all([
        tmdb('/person/' + id),
        tmdb('/person/' + id + '/combined_credits')
      ]);
      const known = (credits.cast || []).filter(c => c.poster_path)
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 24);
      view().innerHTML = `
        <div class="detail-body" style="padding-top:8px">
          <div class="poster" style="width:180px"><img src="${img(p.profile_path, 'w342')}" onerror="this.src='${PLACEHOLDER}'"></div>
          <div class="info">
            <h1>${esc(p.name)}</h1>
            <div class="metarow">${p.known_for_department ? `<span class="pill">${esc(p.known_for_department)}</span>` : ''}
              ${p.birthday ? `<span class="pill">Born ${esc(p.birthday)}</span>` : ''}
              ${p.place_of_birth ? `<span class="pill">${esc(p.place_of_birth)}</span>` : ''}</div>
            <p class="overview" style="margin-top:12px">${esc((p.biography || '').slice(0, 600) || 'No biography.')}${p.biography && p.biography.length > 600 ? '…' : ''}</p>
          </div>
        </div>
        <div class="section"><h3>Known for</h3><div class="grid">${known.map(c => cardHTML(c, c.media_type)).join('')}</div></div>`;
      window.scrollTo(0, 0);
    } catch (e) { errorState(e); }
  }

  /* ---------- Player ---------- */
  async function watchView(type, id, params) {
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

    const title = (d && (d.title || d.name)) || 'Title';
    const sources = cfg.sources || [];
    if (cfg.activeSource >= sources.length) cfg.activeSource = 0;
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
    const resumeAt = (params.restart || !seen || seen.src !== 'provider' || progDone(seen))
      ? 0 : (seen.t || 0);

    let frameInner;
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
      const url = buildSourceUrl(src, type, id, imdb, season, episode, resumeAt);
      const sandbox = cfg.blockPlayerAds ? 'sandbox="allow-same-origin allow-scripts allow-forms allow-presentation"' : '';
      frameInner = `<iframe id="player-iframe" title="${esc(title)} — player" src="${esc(url)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture; airplay" ${sandbox} referrerpolicy="origin"></iframe>`;
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
        ${prevHref ? `<button class="btn sm" data-nav="${prevHref}">\u2039 Prev</button>`
                   : `<button class="btn sm" disabled>\u2039 Prev</button>`}
        <span class="muted" style="font-weight:700">S${season} \u00b7 E${episode}${epCount ? ' of ' + epCount : ''}</span>
        ${nextHref ? `<button class="btn sm" data-nav="${nextHref}">${hasNextEp ? 'Next \u203a' : 'Season ' + (season + 1) + ' \u203a'}</button>`
                   : `<button class="btn sm" disabled>Next \u203a</button>`}
      </div>` : '';

    // Change episode without leaving the player. Same idea as the server room right
    // below it: the thing you most often want next is one press away, and on a remote
    // it is a single D-pad row rather than a trip back to the show page.
    const epStrip = (isTV && seasonEps.length) ? `
      <div class="rail-head" style="margin:26px 0 12px">
        <h2 style="font-size:16px">Episodes <span class="muted" style="font-weight:600;font-size:13px">\u00b7 Season ${season}</span></h2>
        <button class="btn sm ghost" data-nav="#/tv/${id}">All seasons</button>
      </div>
      <div class="rail-wrap">
        <button class="rail-arrow left" data-rail="-1" tabindex="-1" aria-label="Scroll episodes left">${ICON.back}</button>
        <button class="rail-arrow right" data-rail="1" tabindex="-1" aria-label="Scroll episodes right">${ICON.chevR}</button>
      <div class="ep-strip" id="ep-strip">${seasonEps.map(ep => {
        const pr = progGet('tv', id, season, ep.episode_number);
        const done = progDone(pr);
        const cur = ep.episode_number === episode;
        const pct = (pr && pr.pct > 0.01) ? Math.round(Math.min(1, pr.pct) * 100) : 0;
        return `<button class="epx${cur ? ' on' : ''}${done ? ' watched' : ''}"
                data-nav="#/watch/tv/${id}?s=${season}&e=${ep.episode_number}"
                aria-current="${cur}"
                aria-label="${cur ? 'Now playing: ' : ''}Episode ${ep.episode_number}${ep.name ? ', ' + esc(ep.name) : ''}${done ? ', watched' : ''}">
          <span class="epx-thumb">
            <img loading="lazy" alt="" src="${img(ep.still_path, 'w300')}" onerror="this.src='${PLACEHOLDER}'">
            ${pct ? `<span class="ep-fill" style="width:${pct}%"></span>` : ''}
            ${done ? `<span class="ep-tick">${ICON.check}</span>` : ''}
            ${cur ? `<span class="epx-now">${ICON.play}</span>` : ''}
          </span>
          <span class="epx-n">E${ep.episode_number}</span>
          <span class="epx-t">${esc(ep.name || '')}</span>
        </button>`;
      }).join('')}</div>
      </div>` : '';

    const roomTiles = sources.map((s, i) => `
      <button class="mirror ${i === cfg.activeSource ? 'on' : ''}${isTracked(s.name) ? ' tracked' : ''}"
              data-src="${i}" data-mirror-name="${esc(s.name || '')}" aria-pressed="${i === cfg.activeSource}">
        <span class="num">${String(i + 1).padStart(2, '0')}</span>
        <span class="mn">${esc(s.name || ('Source ' + (i + 1)))}</span>
        <span class="ms">${i === cfg.activeSource ? '\u25cf Projecting' : 'Mirror ' + (i + 1)}</span>
        <span class="mbadge">${ICON.check} Verified</span>
      </button>`).join('');

    view().innerHTML = `
      <div class="player-shell">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
          <button class="icon-btn" data-nav="#/${type}/${id}" title="Back to details" aria-label="Back to details">${ICON.back}</button>
          <div class="pl-head" style="min-width:0">
            <div class="pl-title">${esc(title)}</div>
            ${isTV ? `<div class="pl-sub">S${season} \u00b7 E${episode}${epMeta && epMeta.name ? ' \u00b7 <b>' + esc(epMeta.name) + '</b>' : ''}</div>` : ''}
          </div>
          ${epNav}
        </div>
        <div class="player-frame">${frameInner}${IS_TV && src ? `<button class="player-enter" id="player-enter" aria-label="Control the player with the remote">
            <span class="pe-pill">${ICON.play} Control player</span><small>OK turns the remote into a pointer</small></button>` : ''}</div>
        ${IS_TV && src ? `
        <div class="tv-controls" id="tv-controls" role="group" aria-label="Player controls">
          <button class="btn sm" data-pk="space">${ICON.play} Play / Pause</button>
          <button class="btn sm" data-pk="left" aria-label="Back 10 seconds">« 10s</button>
          <button class="btn sm" data-pk="right" aria-label="Forward 10 seconds">10s »</button>
          <button class="btn sm" data-vol="down" aria-label="Volume down">Vol −</button>
          <button class="btn sm" data-vol="up" aria-label="Volume up">Vol +</button>
          <button class="btn sm" data-vol="mute" aria-label="Mute">Mute</button>
          <button class="btn sm" id="tvc-pointer">Pointer</button>
          <button class="btn sm" id="tvc-full">⛶ Full screen</button>
        </div>
        <p class="tv-controls-hint muted">Volume, full screen and the pointer are ours and always work. Play and seek are passed to the mirror — if one ignores them, use <b>Pointer</b> to press its own controls.</p>` : ''}
        <div class="source-bar">
          <span class="lbl">${src ? 'Playing on <b style="color:var(--text)">' + esc(src.name) + '</b>' : 'No source selected'}</span>
          ${sources.length > 1 ? `<button class="btn sm" id="next-src">Try another server</button>` : ''}
        </div>
        ${epStrip}
        ${sources.length ? `
        <details class="srv" id="srv"${srvWasOpen ? ' open' : ''}>
          <summary tabindex="0">
            <span class="srv-t">Servers &amp; playback</span>
            <span class="srv-n">${sources.length} mirrors${src ? ' · ' + esc(src.name) : ''}</span>
          </summary>
          <div class="srv-body">
            <div class="srv-opts">
              <button class="btn sm ghost" id="toggle-sandbox" aria-pressed="${!!cfg.blockPlayerAds}"
                      title="Restrict what the embedded player is allowed to do (may break some mirrors)">
                ${cfg.blockPlayerAds ? 'Player locked down' : 'Lock down player'}</button>
              <button class="btn sm ghost" id="movie-mode" title="Fill this window">Movie mode</button>
              <button class="btn sm ghost" id="tv-mode" title="Fill the whole screen">${ICON.tv} TV mode</button>
            </div>
            <div class="server-room">${roomTiles}</div>
            <p class="muted mirror-note"><span class="mbadge static">${ICON.check} Verified</span>
              reports its exact playback position, so resume points are accurate to the second.
              Every other mirror is tracked by time on screen instead — progress still saves, but it
              drifts if you pause, skip or leave it running. A mirror earns the badge automatically the
              first time it reports a real position. Switch mirrors if one stutters or a title will not
              load — no single mirror has everything.</p>
          </div>
        </details>
        ` : ''}
      </div>`;
    window.scrollTo(0, 0);

    // Switch mirror IN PLACE — swap the iframe src instead of re-rendering the whole
    // page, so D-pad focus stays on the tile the user is on (no focus jump on TV).
    // Switching a mirror swaps the iframe src IN PLACE rather than re-rendering the
    // page, so the D-pad ring stays on the tile the user is on.
    const room = $('.server-room');
    const switchTo = (i) => {
      if (isNaN(i) || i === cfg.activeSource || !sources[i]) return;
      cfg.activeSource = i; saveConfig();
      const s2 = sources[i];
      const fr2 = document.getElementById('player-iframe');
      if (fr2) { releasePlayerFocus(); fr2.setAttribute('tabindex', '-1'); fr2.src = buildSourceUrl(s2, type, id, imdb, season, episode, resumeAt); }
      // The mirror changed under the same watch session. Without this the next
      // position report is credited to whichever mirror happened to be active when
      // the page rendered -- which would hand the Verified badge to the wrong one.
      if (watchNow) watchNow.source = s2.name;
      const lbl = document.querySelector('.source-bar .lbl');
      if (lbl) lbl.innerHTML = 'Now playing: <b style="color:var(--text)">' + esc(s2.name) + '</b>';
      if (room) room.querySelectorAll('.mirror').forEach((el, idx) => {
        el.classList.toggle('on', idx === i);
        el.setAttribute('aria-pressed', String(idx === i));
        const ms = el.querySelector('.ms'); if (ms) ms.textContent = idx === i ? '● Projecting' : 'Mirror ' + (idx + 1);
      });
    };
    if (room) room.onclick = e => {
      const m = e.target.closest('.mirror'); if (!m) return;
      switchTo(parseInt(m.dataset.src, 10));
    };
    // One-press failover — the control the "this mirror failed" toast points at.
    const nx = $('#next-src');
    if (nx) nx.onclick = () => {
      const i = (cfg.activeSource + 1) % sources.length;
      switchTo(i);
      toast('Switched to ' + (sources[i].name || 'the next server'));
    };
    const tgl = $('#toggle-sandbox');
    if (tgl) tgl.onclick = () => {
      cfg.blockPlayerAds = !cfg.blockPlayerAds; saveConfig();
      // This control lives INSIDE the disclosure and its handler re-renders the whole
      // view, which closed the panel, scrolled to the top and left the only label
      // describing the new state hidden inside the thing that just shut. Say what
      // happened, and re-open the panel so the toggle is still where it was pressed.
      srvWasOpen = true;
      toast(cfg.blockPlayerAds ? 'Player locked down' : 'Player restrictions off');
      watchView(type, id, params);
    };
    const qa = $('#quick-add');
    if (qa) qa.onclick = () => {
      const val = $('#quick-src').value.trim();
      if (!val) return toast('Paste a URL template first');
      cfg.sources.push({ name: 'My source', movie: isTV ? '' : val, tv: isTV ? val : '' });
      cfg.activeSource = cfg.sources.length - 1; saveConfig();
      watchView(type, id, params);
    };
    const mm = $('#movie-mode');
    if (mm) mm.onclick = () => toggleCinema(false);   // fills the window
    const tv = $('#tv-mode');
    if (tv) tv.onclick = () => toggleCinema(true);    // fills the screen
    const fr = $('#player-iframe');
    if (fr) { fr.setAttribute('tabindex', '-1'); fr.addEventListener('error', () => toast('This mirror failed — try the next server')); }
    // Land the strip on the episode you are actually watching, not on E1.
    const strip = $('#ep-strip');
    if (strip) {
      const on = strip.querySelector('.epx.on');
      if (on) { try { on.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {} }
    }
    nativeSetPlayer(!!fr);
    // Start tracking position for this exact episode. Runtime is the denominator the
    // wall-clock fallback needs; the mirror overrides it the moment it posts its own.
    if (fr) watchBegin({
      type: type, id: id,
      season: isTV ? season : null, episode: isTV ? episode : null,
      title: title, poster_path: d && d.poster_path, source: src && src.name,
      // Where "up next" goes, and what to call it. Computed here because the bounds
      // and the season rollover are already worked out at this point.
      nextHref: isTV ? nextHref : null,
      nextLabel: isTV ? (hasNextEp
        ? ('S' + season + ' \u00b7 E' + (episode + 1) + (nextEpMeta && nextEpMeta.name ? ' \u00b7 ' + nextEpMeta.name : ''))
        : (nextSeason ? ('Season ' + (season + 1) + ' \u00b7 E1') : null)) : null,
      runtime: 60 * (isTV ? ((d && d.episode_run_time && d.episode_run_time[0]) || 0)
                          : ((d && d.runtime) || 0))
    });
    const srv = $('#srv');
    if (srv) srv.addEventListener('toggle', () => {
      srvWasOpen = srv.open;      // survive the re-render a setting in here triggers
      if (!IS_TV) return;
      tvInvalidate();
      // Land the ring on the first thing revealed, rather than leaving it on the
      // summary with a panel of new controls the user has to hunt for.
      if (srv.open) { const first = srv.querySelector('button'); if (first) tvFocusEl(first); }
    });
    const tvc = $('#tv-controls');
    if (tvc) tvc.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.pk) {
        if (!playerKey(b.dataset.pk)) toast('Player control needs the Reeldeck app on your TV');
        return;
      }
      if (b.dataset.vol) { nativeSend('vol:' + b.dataset.vol); return; }
      if (b.id === 'tvc-pointer') { cursorOn(); return; }
      if (b.id === 'tvc-full') { toggleCinema(true); return; }
    };
    const pe = $('#player-enter');
    if (pe) pe.onclick = cursorOn;
    // On TV land focus on the player entry so OK immediately hands control to the embed.
    // The router also places the ring here (#player-enter is a landing target), but
    // do it explicitly too so the highlight class and remembered position are set even
    // when this view is re-rendered without a route change.
    if (IS_TV && pe) tvFocusEl(pe);
  }

  // "TV mode": a full-viewport player, for casting / screen-mirroring to a TV.
  // CSS-based so it works on iOS/Android/desktop; also tries native fullscreen.
  let cinemaTimer, cinemaReveal;
  function revealCinema() {
    const ex = $('#cinema-exit'); if (ex) ex.classList.remove('faded');
    // The TV control bar rides the same timer — parked permanently over the film it
    // would be worse than not having it.
    const tc = $('#tv-controls'); if (tc) tc.classList.remove('faded');
    clearTimeout(cinemaTimer);
    cinemaTimer = setTimeout(() => {
      const e2 = $('#cinema-exit'); if (e2) e2.classList.add('faded');
      const t2 = $('#tv-controls');
      // Never fade it out from under the ring — that is a dead remote.
      if (t2 && !t2.contains(document.activeElement)) t2.classList.add('faded');
    }, 3000);
  }
  /**
   * Two different "bigger" requests, which used to be one button.
   *
   *   wantScreen = false  MOVIE MODE. The player fills the WINDOW. Pure CSS, no
   *                       permission, no gesture requirement, and the rest of the
   *                       desktop stays usable around it.
   *   wantScreen = true   TV MODE. The player fills the SCREEN, via real
   *                       requestFullscreen.
   *
   * On a TV the window IS the screen, so the distinction is invisible there and the
   * remote only ever gets one control.
   */
  function enterCinema(wantScreen) {
    const frame = $('.player-frame'); if (!frame) return;
    frame.classList.add('cinema'); document.body.classList.add('cinema-on');
    document.body.classList.toggle('cinema-screen', !!wantScreen);
    if (!$('#cinema-exit')) {
      const ex = document.createElement('button');
      ex.id = 'cinema-exit'; ex.className = 'cinema-exit'; ex.innerHTML = ICON.x + ' Exit';
      ex.setAttribute('aria-label', wantScreen ? 'Exit TV mode' : 'Exit movie mode');
      ex.onclick = exitCinema; frame.appendChild(ex);
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
      if (rq) { try { Promise.resolve(rq.call(frame)).catch(() => {}); } catch (e) {} }
    } else if (document.fullscreenElement) {
      // Stepping down from TV mode to Movie mode.
      try { Promise.resolve(document.exitFullscreen()).catch(() => {}); } catch (e) {}
    }
  }
  function exitCinema() {
    cursorOff();
    clearTimeout(cinemaTimer);
    if (cinemaReveal) {
      document.removeEventListener('mousemove', cinemaReveal);
      document.removeEventListener('keydown', cinemaReveal);
      cinemaReveal = null;
    }
    const frame = $('.player-frame'); if (frame) frame.classList.remove('cinema');
    document.body.classList.remove('cinema-on');
    document.body.classList.remove('cinema-screen');
    const ex = $('#cinema-exit'); if (ex) ex.remove();
    const hot = $('#cinema-hot'); if (hot) hot.remove();
    if (document.fullscreenElement) { try { Promise.resolve(document.exitFullscreen()).catch(() => {}); } catch (e) {} }
    releasePlayerFocus();   // hand D-pad focus back to our UI
  }
  // Pressing the mode you are already in leaves; pressing the OTHER one switches to it
  // rather than dropping you all the way out and making you press again.
  function toggleCinema(wantScreen) {
    const on = document.body.classList.contains('cinema-on');
    const screen = document.body.classList.contains('cinema-screen');
    if (on && screen === !!wantScreen) return exitCinema();
    return enterCinema(wantScreen);
  }

  // TV: hand keyboard/D-pad focus to the cross-origin player so the remote drives
  // playback. We can't script inside a cross-origin iframe, so once focus is in it
  // the browser's OWN spatial navigation moves between the embed's controls; the
  // ONLY way back to our UI is the hardware Back button (handled below) or Exit.
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
        if (d.indexOf('vol:') === 0) {
          const pct = parseInt(d.slice(4), 10);
          if (!isNaN(pct)) toast('Volume ' + pct + '%');
          return;
        }
        if (d.indexOf('upd:') === 0) {
          const rest = d.slice(4);
          if (rest.indexOf('err:') === 0) return updSet('error', { msg: rest.slice(4) });
          if (rest === 'done') return updSet('done');
          const pct = parseInt(rest, 10);
          if (!isNaN(pct)) updSet('downloading', { pct: pct });
          return;
        }
      };
    } catch (e) {}
  }

  function cursorActive() { return document.body.classList.contains('cursor-on'); }

  function cursorOn() {
    if (!IS_TV) return;
    if (!document.body.classList.contains('cinema-on')) enterCinema();
    if (!curEl) {
      curEl = document.createElement('div');
      curEl.className = 'tv-cursor'; curEl.id = 'tv-cursor';
      curEl.tabIndex = -1; curEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(curEl);
    }
    document.body.classList.add('cursor-on');
    // Start where a play button usually is, rather than dead centre.
    curX = Math.round(window.innerWidth / 2);
    curY = Math.round(window.innerHeight * 0.58);
    curStep = 14;
    cursorDraw();
    if (!curHint) {
      curHint = document.createElement('div');
      curHint.className = 'tv-cursor-hint';
      document.body.appendChild(curHint);
    }
    curHint.textContent = NATIVE_TAP
      ? 'Move with the D-pad · OK to press · Back to exit'
      : 'Pointer control needs the Reeldeck TV app · Back to exit';
    curHint.classList.add('show');
    clearTimeout(cursorOn._t);
    cursorOn._t = setTimeout(() => { if (curHint) curHint.classList.remove('show'); }, 4500);
    // Keep DOM focus in OUR document: if it were inside the iframe we would stop
    // receiving the arrow keys that drive the cursor.
    try { curEl.focus({ preventScroll: true }); } catch (e) { try { curEl.focus(); } catch (e2) {} }
    tvInvalidate();
  }

  function cursorOff() {
    if (!cursorActive()) return;
    document.body.classList.remove('cursor-on');
    if (curHint) { curHint.classList.remove('show'); }
    clearTimeout(cursorOn._t);
    tvInvalidate();
  }

  function cursorDraw() {
    if (curEl) curEl.style.transform = 'translate3d(' + curX + 'px,' + curY + 'px,0)';
  }

  // Held direction accelerates, so crossing the screen is a flick rather than a chore.
  function cursorMove(dir) {
    const t = (window.performance && performance.now) ? performance.now() : Date.now();
    curStep = (t - curLast < 260) ? Math.min(curStep + 7, 78) : 14;
    curLast = t;
    if (dir === 'left') curX -= curStep;
    else if (dir === 'right') curX += curStep;
    else if (dir === 'up') curY -= curStep;
    else curY += curStep;
    curX = Math.max(6, Math.min(curX, window.innerWidth - 6));
    curY = Math.max(6, Math.min(curY, window.innerHeight - 6));
    cursorDraw();
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
   * nothing will ignore it, which is what the Pointer button is for.
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
    cursorOff();
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

  function enterPlayerFocus() {
    const fr = document.getElementById('player-iframe');
    if (!fr) return;
    if (!document.body.classList.contains('cinema-on')) enterCinema();
    document.body.classList.add('player-focused');
    tvInvalidate();   // the Open-player overlay is gone from the row model now
    fr.setAttribute('tabindex', '0');
    try { fr.focus(); } catch (e) {}
  }
  function releasePlayerFocus() {
    if (!document.body.classList.contains('player-focused')) return;
    document.body.classList.remove('player-focused');
    tvInvalidate();
    const fr = document.getElementById('player-iframe');
    if (fr) { try { fr.blur(); } catch (e) {} fr.setAttribute('tabindex', '-1'); }
    // Route through tvFocusEl so the selection class, the remembered position and the
    // scroll all match every other placement — a raw focus() here left the ring off.
    const pe = document.getElementById('player-enter');
    if (pe && IS_TV) tvFocusEl(pe);
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('cinema-on')) exitCinema();
  });

  // The two mirrors that document a start-position parameter. Everything else simply
  // starts from the beginning -- there is no generic way to seek a cross-origin player.
  const RESUME_PARAM = { 'VidSrcMe': 'startAt', 'VidSrc RU': 'startAt', 'VidSrc SU': 'startAt',
                         'Vsrc': 'startAt', 'VidKing': 'progress' };

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
    const rp = src && RESUME_PARAM[src.name];
    if (rp && resumeAt > 30) {
      tpl += (tpl.indexOf('?') >= 0 ? '&' : '?') + rp + '=' + Math.floor(resumeAt);
    }
    return tpl;
  }

  /* ---------- Watchlist ---------- */
  function watchlistView() {
    const list = getWatch();
    let html = `<h1 class="page-title">Watchlist${list.length ? ` <span class="muted" style="font-size:16px">(${list.length})</span>` : ''}</h1>`;
    html += list.length
      ? `<div class="grid">${list.map(i => cardHTML(i, i.type)).join('')}</div>`
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
        histClear(); progClear(); route(); toast('History cleared');
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
      const r = await fetch('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl));
      if (r.ok) { const t = (await r.text()).trim(); if (/^https?:\/\/tinyurl\.com\/\S+$/i.test(t)) return t; }
    } catch (e) {}
    try {
      const r = await fetch('https://spoo.me/', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'url=' + encodeURIComponent(longUrl)
      });
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

    const autoLine = manual
      ? 'Using your custom link. <button class="linkish" id="ga-reset">Switch back to the auto link</button>'
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
          <p class="muted" style="font-size:12.5px;margin-top:4px">Want your own memorable link instead? Paste one (e.g. a custom <b>tinyurl.com</b> alias) and save — it replaces the address above and updates the QR.</p>
          <div class="ga-url"><input id="ga-short" placeholder="https://tinyurl.com/your-alias" value="${esc(manual)}"><button class="btn sm primary" id="ga-save">Save</button></div>
          <p class="muted" style="font-size:12.5px;margin-top:10px">Even easier: the Downloader app supports numeric <b>codes</b> — register your link at <b>aftv.news</b> and you get a short number to punch in.</p>
        </div>
        <div class="ga-card">
          <h3>Phone &amp; Windows</h3>
          <p class="muted"><b>Android phone:</b> open the address above (or scan the QR) and install the APK — same file as the TV. <b>Windows:</b> get the installer from the <button class="linkish" data-openext="https://github.com/jaig-eye/reeldeck/releases/latest">Releases page</button>.</p>
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

  /* ---------- Error state ---------- */
  function errorState(e, sel) {
    const msg = (e && e.message) || 'Something went wrong';
    const html = `<div class="center-note">
      <div style="font-size:44px;margin-bottom:10px">⚠️</div>
      <div style="font-weight:700;color:var(--text);margin-bottom:6px">Couldn't load data</div>
      <div>${esc(msg)}</div>
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
    // On TV the embed is the only thing that can pause or scrub, and an <iframe> is not
    // a D-pad target — without a hand-off the user could start a trailer and then have
    // no control over it at all. Same pattern as the player's "Open player" overlay.
    const handoff = IS_TV
      ? `<button class="player-enter" id="trailer-enter" aria-label="Control the trailer with the remote">
           <span class="pe-pill">${ICON.play} Control trailer</span><small>OK turns the remote into a pointer</small>
         </button>`
      : '';
    back.innerHTML = `<div class="modal wide">
      <div class="mh"><h3>Trailer</h3><button class="icon-btn" data-close aria-label="Close">${ICON.x}</button></div>
      <div class="video-wrap">
        <iframe id="trailer-iframe" title="Trailer" src="https://www.youtube-nocookie.com/embed/${esc(key)}?autoplay=1" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>
        ${handoff}
      </div>
    </div>`;
    const te = back.querySelector('#trailer-enter');
    if (te) te.onclick = cursorOn;
    modalMount(back);
  }

  function openSettings() {
    const themeCards = THEMES.map(t => `<button class="theme-card ${cfg.theme === t.id ? 'on' : ''}" data-theme-pick="${t.id}" aria-pressed="${cfg.theme === t.id}" aria-label="${t.name} theme">
        <span class="tprev">${t.preview.map(c => `<i style="background:${c}"></i>`).join('')}</span>
        <span class="tname">${t.name}</span>
      </button>`).join('');

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal">
      <div class="mh"><h3>${ICON.gear} Settings</h3><button class="icon-btn" data-close aria-label="Close">${ICON.x}</button></div>
      <div class="mb">
        <div class="set-group">
          <h4>Theme</h4>
          <p class="hint">Pick a look — applies instantly.</p>
          <div class="theme-grid" id="set-themes">${themeCards}</div>
        </div>
        <div class="set-group">
          <button class="btn sm" id="set-getapp" style="width:100%;justify-content:center">${ICON.tv} Install on TV / other devices</button>
        </div>
        <div class="set-group">
          <h4>About</h4>
          <p class="hint">Reeldeck <b>v${APP_VERSION}</b> · ${IS_TV ? 'Android TV' : IS_DESKTOP ? 'Desktop' : 'Web'}</p>
          <div class="upd-box" id="set-upd"></div>
        </div>
        <div class="set-actions">
          <button class="btn" id="set-reset">Reset</button>
          <button class="btn primary" data-close>Done</button>
        </div>
      </div>
    </div>`;
    modalMount(back);

    // theme picker — applies + persists instantly
    $('#set-themes', back).onclick = (e) => {
      const card = e.target.closest('[data-theme-pick]'); if (!card) return;
      cfg.theme = card.dataset.themePick;
      back.querySelectorAll('.theme-card').forEach(x => x.classList.remove('on'));
      card.classList.add('on');
      saveConfig();  // applyTheme runs -> live switch
    };
    renderUpdBox();
    const ga = $('#set-getapp', back);
    if (ga) ga.onclick = () => { closeModal(back); go('#/get-app'); };
    $('#set-reset', back).onclick = () => { if (confirm('Reset theme + settings to defaults? Your watchlist is kept.')) { cfg = Object.assign({}, DEFAULTS); cfg.sources = DEFAULT_SOURCES.map(x => Object.assign({}, x)); saveConfig(); closeModal(back); route(); toast('Settings reset'); } };
  }

  // Closing a modal must also drop pointer mode — openTrailer hands the remote to the
  // cursor, and the Back handler closes the modal and returns before reaching it.
  function modalCursorReset() { if (document.body.classList.contains('cursor-on')) cursorOff(); }

  function modalMount(back) {
    back._opener = document.activeElement;
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
      || back.querySelector('#trailer-enter')
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
  function go(hash) { location.hash = hash; }

  function setActiveNav(section) {
    document.querySelectorAll('[data-section]').forEach(a => {
      const on = a.dataset.section === section;
      a.classList.toggle('active', on);
      // The active item was conveyed by colour alone; aria-current names it.
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  function syncSearchBox(params, parts) {
    const inp = $('#search-input');
    if (!inp) return;
    if (parts[0] === 'search' || (parts[0] === 'movies' && params.q) || (parts[0] === 'tv' && params.q)) inp.value = params.q || '';
  }

  function route() {
    routeSeq++;
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
    closeSuggest();
    clearHero();                 // stop billboard rotation when leaving Home
    // Nothing from the previous screen may outlive it. An open modal would otherwise
    // stay mounted over the new page (browser Back on a playing trailer), and the
    // cinema/player classes would leave `overflow: hidden` and their document
    // listeners on every subsequent page with no way back but a reload.
    document.querySelectorAll('.modal-back').forEach(closeModal);
    if (document.body.classList.contains('cinema-on') || document.body.classList.contains('player-focused')) exitCinema();
    document.body.classList.toggle('home', !parts.length);
    window.scrollTo(0, 0);
    // Same section, different parameters = a filter/sort/page change, not a real
    // navigation, so the ring stays where the user left it.
    // A filter/sort/page change keeps your place; a different SEARCH TERM does not —
    // that is a new result set and the ring belongs on it.
    const viewKey = parts.join('/') + '|' + (params.q || '');
    const sameSection = viewKey === routeKey;
    routeKey = viewKey;
    if (IS_TV) tvFocusFirst(true, sameSection);  // re-establish focus once the new view has rendered
    const sec = parts[0] || 'home';
    setActiveNav(parts[0] === 'tv' ? 'tv' : parts[0] === 'movies' ? 'movies' : parts[0] === 'watchlist' ? 'watchlist' : parts[0] === 'search' ? 'search' : 'home');
    syncSearchBox(params, parts);

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
      case 'watch': return watchView(parts[1], parts[2], params);
      case 'watchlist': return watchlistView();
      case 'get-app': return getAppView();
      default: return homeView();
    }
  }

  /* ============================================================
     Header + global events
     ============================================================ */
  function buildHeader() {
    const hdr = $('header.top');
    hdr.innerHTML = `
      <a class="brand" href="#/" data-nav="#/" aria-label="${esc(cfg.brand)} — home">
        <span class="brand-mark" aria-hidden="true"></span><span class="txt">${esc(cfg.brand)}</span>
      </a>
      <nav class="main" aria-label="Primary">
        <a href="#/" data-nav="#/" data-section="home">Home</a>
        <a href="#/movies" data-nav="#/movies" data-section="movies">Movies</a>
        <a href="#/tv" data-nav="#/tv" data-section="tv">TV Shows</a>
        <a href="#/watchlist" data-nav="#/watchlist" data-section="watchlist">Watchlist</a>
      </nav>
      ${IS_TV
        // A TV never types in the header: the platform keyboard is a full-screen
        // overlay, and an inline field forces brand + nav + field + icons into a
        // header that does not fit at the ~853 CSS px a 720p set reports. So the
        // header offers a target and the search PAGE owns the input.
        ? `<button class="icon-btn" id="search-btn" data-nav="#/search" data-section="search" title="Search" aria-label="Search">${ICON.search}</button>`
        : `<div class="search-wrap">
        <span class="ico">${ICON.search}</span>
        <input id="search-input" type="search" placeholder="Search movies, shows, people…" autocomplete="off" aria-label="Search movies, shows and people">
        <button class="clear" id="search-clear" title="Clear" aria-label="Clear search" style="display:none">${ICON.x}</button>
        <div class="suggest" id="suggest" style="display:none"></div>
      </div>`}
      <button class="icon-btn" id="update-btn" title="Check for updates" aria-label="Check for updates">${ICON.download}</button>
      <button class="icon-btn" id="settings-btn" title="Settings" aria-label="Settings">${ICON.gear}</button>`;

    const inp = $('#search-input');
    const clear = $('#search-clear');
    if (inp && clear) {
      inp.addEventListener('input', () => {
        clear.style.display = inp.value ? 'block' : 'none';
        liveSuggest(inp.value.trim());
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { closeSuggest(); if (inp.value.trim()) go('#/search?q=' + encodeURIComponent(inp.value.trim())); }
        if (e.key === 'Escape') closeSuggest();
      });
      clear.addEventListener('click', () => { inp.value = ''; clear.style.display = 'none'; closeSuggest(); inp.focus(); });
    }
    $('#settings-btn').addEventListener('click', openSettings);
    $('#update-btn').addEventListener('click', () => checkForUpdate(true));

    // Mobile bottom tab bar (hidden on desktop via CSS)
    if (!$('.bottom-nav')) {
      const bn = document.createElement('nav');
      bn.className = 'bottom-nav';
      bn.setAttribute('aria-label', 'Primary');
      bn.innerHTML = `
        <a href="#/" data-nav="#/" data-section="home">${ICON.home}<span>Home</span></a>
        <a href="#/movies" data-nav="#/movies" data-section="movies">${ICON.film}<span>Movies</span></a>
        <a href="#/tv" data-nav="#/tv" data-section="tv">${ICON.tv}<span>TV</span></a>
        <a href="#/search" data-nav="#/search" data-section="search">${ICON.search}<span>Search</span></a>
        <a href="#/watchlist" data-nav="#/watchlist" data-section="watchlist">${ICON.bookmark}<span>Saved</span></a>`;
      document.body.appendChild(bn);
    }
    // scroll-aware header: transparent over the Home billboard, frosts on scroll
    const hdrEl = $('header.top');
    const onScroll = () => { if (hdrEl) hdrEl.classList.toggle('scrolled', window.scrollY > 30); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    applyTheme();
  }

  // Sequence guard: the debounce only delays requests, it does not order responses, so
  // a slow "du" could repaint over a fast "dune" — and a response landing after Enter,
  // Escape or a navigation would re-open a dropdown the user had already dismissed.
  let suggestSeq = 0;
  const liveSuggest = debounce(async (q) => {
    const mine = ++suggestSeq;
    if (!q || q.length < 2) return closeSuggest();
    try {
      const d = await tmdb('/search/multi', { query: q, page: 1, include_adult: 'false' });
      const inp = $('#search-input');
      if (mine !== suggestSeq || !inp || inp.value.trim() !== q) return;
      const items = (d.results || []).filter(x => x.media_type !== 'person' && (x.poster_path || x.profile_path)).slice(0, 6);
      const box = $('#suggest');
      if (!items.length) return closeSuggest();
      box.innerHTML = items.map(it => {
        const t = it.title || it.name; const ty = it.media_type;
        return `<div class="row" data-nav="#/${ty}/${it.id}" tabindex="0" role="option" aria-label="${esc(t)}">
          <img src="${img(it.poster_path, 'w92')}" alt="" onerror="this.src='${PLACEHOLDER}'">
          <div style="min-width:0"><div class="t">${esc(t)}</div>
            <div class="s">${year(it.release_date || it.first_air_date) || ''} · ${ty === 'tv' ? 'TV' : 'Movie'}</div></div>
          <span class="badge rate" style="position:static;background:var(--surface-2)">${ICON.star} ${it.vote_average ? it.vote_average.toFixed(1) : '—'}</span>
        </div>`;
      }).join('');
      box.style.display = 'block';
    } catch (e) { closeSuggest(); }
  }, 260);
  function closeSuggest() { suggestSeq++; const b = $('#suggest'); if (b) { b.style.display = 'none'; b.innerHTML = ''; } }

  // Global click delegation
  document.addEventListener('click', (e) => {
    const wl = e.target.closest('[data-wl]');
    if (wl) {
      e.preventDefault(); e.stopPropagation();
      const id = wl.dataset.wl, type = wl.dataset.type;
      const item = itemCache[ck(type, id)] || getWatch().find(x => x.id == id && x.type === type) || { id };
      const nowOn = toggleWatch(item, type);
      // update any matching buttons
      document.querySelectorAll(`[data-wl="${id}"][data-type="${type}"]`).forEach(b => {
        b.classList.toggle('on', nowOn);
        b.setAttribute('aria-pressed', String(nowOn));
        b.setAttribute('aria-label', (nowOn ? 'Remove from' : 'Add to') + ' watchlist');
        b.setAttribute('title', (nowOn ? 'Remove from' : 'Add to') + ' watchlist');
        // The billboard's button uses a check/plus pair, not the bookmark pair — the
        // blanket rewrite below used to swap the hero's + for a bookmark glyph.
        if (b.closest('.bb-cta')) { b.innerHTML = nowOn ? ICON.check : ICON.plus; return; }
        if (b.id === 'detail-wl') { b.classList.toggle('primary', nowOn); b.innerHTML = (nowOn ? ICON.bookmarkFill : ICON.bookmark) + ' ' + (nowOn ? 'In watchlist' : 'Watchlist'); }
        else b.innerHTML = nowOn ? ICON.bookmarkFill : ICON.bookmark;
      });
      // Substring-matching the whole hash meant searching for the word "watchlist" and
      // saving a result re-rendered the entire search view and jumped you to the top.
      if (parseHash().parts[0] === 'watchlist') route();
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
      const track = ra.parentElement.querySelector('.track, .ep-strip, .season-pills');
      if (track) track.scrollBy({ left: (+ra.dataset.rail) * track.clientWidth * 0.85, behavior: 'smooth' });
      return;
    }
    // A resume rail that can only grow is one you stop trusting: a title you abandoned
    // sits at the front for good. Handled BEFORE [data-nav], because the control lives
    // inside a card that navigates.
    const uw = e.target.closest('[data-unwatch]');
    if (uw) {
      e.preventDefault(); e.stopPropagation();
      progForget(uw.dataset.unwatch);
      const card = uw.closest('.card'), rail = uw.closest('.rail');
      if (card) card.remove();
      // The last one out takes the rail with it, rather than leaving a bare heading.
      if (rail && !rail.querySelector('.card')) rail.remove();
      if (IS_TV) { tvInvalidate(); tvFocusFirst(); }
      toast('Removed from Continue watching');
      return;
    }
    const nav = e.target.closest('[data-nav]');
    if (nav) { e.preventDefault(); go(nav.dataset.nav); return; }
    // click outside search closes suggestions
    if (!e.target.closest('.search-wrap')) closeSuggest();
  });

  // Keyboard / D-pad OK: activate any focused [data-nav] element (cards, cast,
  // episodes, nav links, search rows). Native buttons/inputs handle Enter themselves.
  // The browser build has no hardware Back, so Escape is the way out of the player.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (cursorActive() || document.body.classList.contains('cinema-on'))) {
      if (!document.querySelector('.modal-back')) { e.preventDefault(); exitCinema(); return; }
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (cursorActive()) { e.preventDefault(); cursorTap(); return; }
    const el = document.activeElement;
    if (!el || /^(INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY)$/.test(el.tagName)) return; // native handles these
    const nav = el.closest && el.closest('[data-nav]');
    if (nav) { e.preventDefault(); go(nav.dataset.nav); }
  });

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

  window.addEventListener('hashchange', () => {
    const h = location.hash || '#/';
    if (navDepth > 0 && navSeen[navDepth - 1] === h) { navSeen.pop(); navDepth--; }
    else { navSeen[navDepth] = navSeen[navDepth] || h; navSeen[++navDepth] = h; }
    route();
  });
  buildHeader();
  route();

  // PWA: register service worker so the app is installable ("Add to Home Screen").
  // No-ops on file:// (SW not allowed there) — serve over http/https or the desktop app.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // Silent update check on launch (web/Android). Desktop uses electron-updater.
  if (!IS_DESKTOP) setTimeout(() => checkForUpdate(false), 1500);

  // ---- Update UI ---------------------------------------------------------
  // One persistent banner drives EVERY state so the user always gets feedback
  // (the old code wrote status into a Settings element we later removed, so
  // errors and progress were invisible). Works for desktop (electron-updater
  // events) and web/Android (GitHub Releases API).
  let updInteractive = false;   // was the current check triggered by the button?
  function updBanner() {
    let b = document.getElementById('update-banner');
    if (!b) { b = document.createElement('div'); b.id = 'update-banner'; b.className = 'update-banner'; document.body.appendChild(b); }
    clearTimeout(updBanner._t);
    return b;
  }
  function updClose() { clearTimeout(updBanner._t); const b = document.getElementById('update-banner'); if (b) b.remove(); }
  function updWireDismiss() { const x = document.getElementById('ub-x'); if (x) x.onclick = updClose; }
  function updChecking() { updBanner().innerHTML = '<span class="ub-msg"><span class="ub-spin"></span>Checking for updates…</span>'; }
  function updNone() {
    updBanner().innerHTML = '<span class="ub-msg">You’re on the latest version (v' + esc(APP_VERSION) + ').</span><button class="btn sm" id="ub-x">OK</button>';
    updWireDismiss(); updBanner._t = setTimeout(updClose, 5000);
  }
  function updError(msg) {
    updBanner().innerHTML = '<span class="ub-msg">' + esc(msg || 'Update check failed — try again later.') + '</span>' +
      '<button class="btn sm primary" id="ub-retry">Retry</button><button class="btn sm" id="ub-x">Dismiss</button>';
    const r = document.getElementById('ub-retry'); if (r) r.onclick = () => checkForUpdate(true);
    updWireDismiss();
  }
  function updDownloading(pct) {
    pct = Math.max(0, Math.min(100, Math.round(pct || 0)));
    updBanner().innerHTML = '<span class="ub-msg">Downloading update… ' + pct + '%</span><div class="ub-bar"><i style="width:' + pct + '%"></i></div>';
  }
  function updReady(version) {
    updBanner().innerHTML = '<span class="ub-msg">Update ' + (version ? 'v' + esc(version) + ' ' : '') + 'ready to install.</span>' +
      '<button class="btn sm primary" id="ub-install">Restart &amp; update</button><button class="btn sm" id="ub-x">Later</button>';
    const i = document.getElementById('ub-install'); if (i) i.onclick = () => { if (window.reeldeck && window.reeldeck.installUpdate) window.reeldeck.installUpdate(); };
    updWireDismiss();
  }
  // The banner ANNOUNCES; Settings is where you act. On a TV the banner is pinned
  // chrome that lands wherever the row model puts it, so hunting for its button with
  // a remote was the worst part of updating — and the button went to the sideload
  // instructions, which is not something you can follow on the device you are holding.
  function updWebAvailable(version) {
    const ub = document.getElementById('update-btn'); if (ub) ub.classList.add('has-update');
    updSet('available', { v: version });
    updBanner().innerHTML = '<span class="ub-msg">New version available — v' + esc(version) + '.</span>' +
      '<button class="btn sm primary" id="ub-get">' + (updCanInstall() ? 'Update' : 'Get it') + '</button>' +
      '<button class="btn sm" id="ub-x">Later</button>';
    const g = document.getElementById('ub-get');
    if (g) g.onclick = () => { updClose(); openSettings(); };
    updWireDismiss();
  }

  function updSet(st, extra) {
    updState = Object.assign({ s: st, v: updState.v, pct: 0, msg: '' }, extra || {});
    updState.s = st;
    renderUpdBox();
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
      html = '<p class="upd-t">Downloading update… ' + st.pct + '%</p>' +
             '<div class="ub-bar"><i style="width:' + st.pct + '%"></i></div>';
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
      else if (d.state === 'error') { updSet('error', { msg: 'Update failed — ' + (d.message || 'try again later.') }); if (updInteractive) updError('Update failed — ' + (d.message || 'try again later.')); updInteractive = false; }
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
      const r = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
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
        !el.closest('.player-frame.cinema, #tv-controls, #cinema-exit, #next-up')) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const cs = getComputedStyle(el);
    // `visibility` and `pointer-events` both inherit, so these two reads also rule
    // out anything sitting inside a switched-off container (a rotated-away hero
    // slide, a faded overlay) without walking the ancestor chain.
    if (cs.visibility === 'hidden' || cs.opacity === '0' || cs.pointerEvents === 'none') return null;
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
      // `.suggest` lives inside the header but drops down over the page, so it is
      // content, not chrome: it keeps its own rows.
      const pinned = !inModal && !!el.closest(TV_PINNED) && !el.closest('.suggest');
      // A carousel scrolls under the cached x, so remember which one this item is in
      // and what its scrollLeft was; tvColOf() corrects for the difference later.
      const sc = el.closest(TV_ROW_CONTAINERS);
      let cy;
      if (inModal || pinned) {
        cy = r.top + r.height / 2;
        // Chrome pinned to the BOTTOM of the viewport (the update banner) belongs
        // after all the content, not wherever the current scroll position puts it.
        if (!inModal && cy > vh / 2) cy += docH;
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

  // Focus WITHOUT the browser's own scroll, then place the selection ourselves: a
  // carousel centres its item sideways, the page centres the row vertically, and the
  // sticky bar just snaps the page home (centring a pinned element fights the scroll
  // and bounces focus straight back off it).
  function tvFocusEl(el) {
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
    tvMark(el);
    tvRemember(el);
    const hs = el.closest(TV_ROW_CONTAINERS);
    if (hs && hs.scrollWidth > hs.clientWidth + 4) {
      const r = el.getBoundingClientRect(), hr = hs.getBoundingClientRect();
      const left = Math.max(0, hs.scrollLeft + (r.left - hr.left) - (hr.width - r.width) / 2);
      tvGlide(hs, left);
    }
    if (el.closest(TV_PINNED)) { if (el.closest('header.top')) tvGlide(window, 0); return; }
    if (el.closest('.modal-back')) { try { el.scrollIntoView({ block: 'center' }); } catch (e) {} return; }
    const r2 = el.getBoundingClientRect();
    const vh = window.innerHeight || 0;
    // Already comfortably in view (clear of the opaque sticky bar and the bottom
    // edge)? Leave the page where it is. Re-centring unconditionally meant simply
    // arriving on a page dragged its own title and the top bar off screen.
    const hdr = document.querySelector('header.top');
    const safeTop = (hdr ? hdr.getBoundingClientRect().height : 0) + 16;
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
  }

  // Where the ring was, in the same document space the row model uses.
  function tvRemember(el) {
    const r = el.getBoundingClientRect();
    const pinned = !!el.closest('header.top') && !el.closest('.suggest');
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
    const rows = tvRowModel(document.querySelector('.modal-back') || document);
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
  function tvFocusFirst(waitForRender, keepPlace) {
    if (!IS_TV) return;
    const gen = ++tvGen;
    tvStopWatch();
    tvColX = null;
    tvUserMoved = false;
    const stop = () => { if (gen === tvGen) tvStopWatch(); };
    const grab = () => {
      tvEnsureFocusable();
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

    const rows = tvRowModel(document.querySelector('.modal-back') || document);
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

    let target = null;
    if (dir === 'left' || dir === 'right') {
      const nj = ci + (dir === 'right' ? 1 : -1);
      if (nj < 0 || nj >= rows[ri].items.length) return;   // edge of the row: stay put
      target = rows[ri].items[nj];
      tvColX = null;                                        // new column is wherever we land
    } else {
      const ni = ri + (dir === 'down' ? 1 : -1);
      if (ni < 0 || ni >= rows.length) return;              // top/bottom of page: stay put
      const from = rows[ri], to = rows[ni];
      if (from.kind === 'track' && to.kind === 'track') {   // carry the index, not the column
        // Carousel to carousel: carry the POSITION IN THE ROW, the way every TV app
        // does — item 5 of one rail lands on item 5 of the next, not on whatever
        // happens to sit under it after the two rails scrolled independently.
        target = to.items[Math.min(ci, to.items.length - 1)];
        tvColX = null;
      } else {
        const x = (tvColX == null) ? tvColOf(from.items[ci]) : tvColX;
        target = to.items.reduce((b, m) => (b === null || Math.abs(tvColOf(m) - x) < Math.abs(tvColOf(b) - x)) ? m : b, null);
        tvColX = x;                                         // hold the column down a grid
      }
    }
    if (target) tvFocusEl(target.el);
  }

  // '/' jumps to search, the way every content app on a desktop does. Never on TV
  // (no keyboard there, and the key is itself a D-pad target) and never while the
  // caret is already sitting in a field.
  document.addEventListener('keydown', (e) => {
    if (IS_TV || e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    const inp = $('#search-input');
    if (!inp) return;
    e.preventDefault();
    try { inp.focus(); inp.select(); } catch (e2) {}
  });

  if (IS_TV) {
    document.body.classList.add('tv');
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

  // Hardware BACK (Android) — the reliable escape hatch (fires even while focus
  // is inside the cross-origin player iframe). modal -> cinema -> history -> exit.
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    const App = window.Capacitor.Plugins.App;
    App.addListener('backButton', () => {
      const modal = document.querySelector('.modal-back');
      if (modal) { closeModal(modal); return; }
      // In the player (pointer up, and/or full-screen): first Back returns to our UI
      // rather than leaving the page.
      if (cursorActive() || document.body.classList.contains('player-focused') || document.body.classList.contains('cinema-on')) { exitCinema(); return; }
      // history.length never decreases, so testing it meant exitApp() was unreachable
      // after the very first navigation and Back became inert on the home screen.
      // Track our own depth instead: Android TV's contract is "Back on root exits".
      if (navDepth > 0) { history.back(); return; }
      App.exitApp();
    });
  }

})();
