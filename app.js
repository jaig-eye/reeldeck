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
  // iPadOS 13+ reports itself as a Mac, so the touch-points test is the only reliable
  // way to tell an iPad from a desktop Safari.
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
                 (/Mac/.test(navigator.userAgent || '') && navigator.maxTouchPoints > 1);
  // Already launched from the home screen: Safari sets standalone, and the display-mode
  // query covers everything else.
  const IS_STANDALONE = !!(window.navigator.standalone) ||
                        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  const APP_VERSION = '1.0.19';   // bump with each release (matches package.json)
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
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
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
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 12H4m0 0l4-4m-4 4l4 4M14 4h5a1 1 0 011 1v14a1 1 0 01-1 1h-5"/></svg>',
    devices: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="14" height="10" rx="1"/><rect x="17" y="9" width="5" height="11" rx="1"/><path d="M6 18h6"/></svg>',
    sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/></svg>'
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
    const nowMs = now(); let changed = false;
    for (const k in p) {
      if (k.indexOf('movie:') === 0 && (nowMs - ((p[k] && p[k].at) || 0)) > MOVIE_TTL) { delete p[k]; changed = true; }
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
    p[k] = { t: Math.round(t), d: Math.round(dur), pct: pct, at: now(), src: o.src || prev.src || 'elapsed' };
    // Series-level pointer: which episode to drop the user back on.
    if (o.type === 'tv') p['tv:' + o.id] = { s: +o.season || 1, e: +o.episode || 1, at: now() };
    progSave(p);
    histPush(o, pct);
    syncMark();
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
      on: false, uid: '', kind: '', name: '',
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

  /** 192 bits from the CSPRNG. Math.random() is a predictable PRNG and this id is,
   *  on its own, the entire credential for an account on an unauthenticated server. */
  function newAnonUid() {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    return btoa(String.fromCharCode.apply(null, b))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');   // 32 chars
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
    if (ap !== bp) return ap ? a : b;
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
      if (k.indexOf('movie:') === 0 && (syncNow - e.at) > MOVIE_TTL) delete pg[k];
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
      const r = await fetch(SYNC_URL + path, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
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
      if (!r.ok) return { err: d.error || ('http ' + r.status), status: r.status };
      return { ok: true, d: d };
    } catch (e) {
      return { err: e.name === 'AbortError' ? 'timeout' : 'net' };
    } finally { clearTimeout(kill); }
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

  /* ---- sign-in screens ----------------------------------------------------
     Google's device flow, not a "Sign in with Google" button, and not by choice:
     Google returns disallowed_useragent to embedded WebViews, and the phone build and
     the TV build are the same Capacitor WebView. The device flow needs no redirect URI
     and no registered origin, so one code path serves all four targets -- and it is
     the flow people already know from signing in to Netflix or YouTube on a TV.
     ------------------------------------------------------------------------- */
  let authAbort = null;

  /**
   * Turn a password into the value the server actually sees.
   *
   * The password itself never leaves the device. PBKDF2 runs HERE for two reasons: a
   * Cloudflare Worker on the free plan gets about 10ms of CPU per request, which is
   * nowhere near enough for an iteration count worth having; and doing it this way a
   * database dump yields only keyed hashes of an already-expensive derivation.
   *
   * The salt is the normalised email rather than a random per-user value, because the
   * server must be able to verify a login without first telling the client whether the
   * account exists -- and a per-user random salt would require exactly that round trip.
   * The cost is that two people with the same password and the same address would get
   * the same dk, which is not a scenario that exists.
   */
  const PBKDF2_ITERS = 210000;
  async function deriveDk(email, password) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey(
      'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode('reeldeck:pw:v1:' + email),
        iterations: PBKDF2_ITERS, hash: 'SHA-256' },
      base, 256
    );
    return btoa(String.fromCharCode.apply(null, new Uint8Array(bits)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const normEmail = (v) => String(v || '').trim().toLowerCase();
  const RX_EMAIL_C = /^[^\s@]{1,64}@[^\s@.]{1,63}(\.[^\s@.]{1,63}){1,4}$/;

  /**
   * The email/password panel. One form, two buttons -- signing in and creating an
   * account differ by one endpoint, and making the user pick a mode first is a step
   * that exists only to serve the implementation.
   */
  function pwPanel(mount) {
    authStop();
    // crypto.subtle exists only in a secure context. localhost and 127.0.0.1 count, so
    // the packaged app and the desktop build are fine -- but the PWA served over plain
    // http to another machine on the LAN is not, and there this path is impossible.
    // Say which, rather than blaming the device.
    if (!window.isSecureContext || !(window.crypto && crypto.subtle)) {
      mount.innerHTML =
        '<div class="au-err"><p>Passwords need a secure connection, and this page was ' +
        'opened over plain <b>http</b>. Use the installed app, or open the site over ' +
        '<b>https</b> \u2014 or sign in with Google or a device code instead.</p>' +
        '<button class="btn" data-au="cancel">Back</button></div>';
      if (IS_TV) tvInvalidate();
      return;
    }
    mount.innerHTML =
      // A real <form>: password managers look for one, and without it most will not
      // offer to save what was just typed.
      '<form class="au-flow au-narrow" id="pw-form" autocomplete="on">' +
        '<div class="au-form">' +
          '<label class="au-field"><span>Email</span>' +
            '<input class="au-input wide" id="pw-email" name="email" type="email" ' +
                   'inputmode="email" autocomplete="username" spellcheck="false" ' +
                   'placeholder="you@example.com"></label>' +
          '<label class="au-field"><span>Password</span>' +
            '<input class="au-input wide" id="pw-pass" name="password" type="password" ' +
                   'autocomplete="current-password" placeholder="At least 8 characters"></label>' +
          '<p class="au-hint" id="pw-msg" role="status" aria-live="polite"></p>' +
        '</div>' +
        '<div class="au-foot">' +
          '<span class="au-btns">' +
            '<button class="btn primary sm" type="submit" data-au="pw-login">Sign in</button>' +
            '<button class="btn sm" type="button" data-au="pw-signup">Create account</button>' +
          '</span>' +
          '<button class="btn sm ghost" type="button" data-au="cancel">Back</button>' +
        '</div>' +
        '<p class="au-fine">There is no password reset \u2014 nothing here can email you. ' +
          'If you forget it, sign in on a device that still works and use ' +
          '<b>Connect a device</b> to bring this one back.</p>' +
      '</form>';

    const form = mount.querySelector('#pw-form');
    form.addEventListener('submit', (ev) => { ev.preventDefault(); pwSubmit(mount, 'login'); });

    mount.querySelectorAll('.au-input').forEach(el => {
      el.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        // LET THE PLATFORM HAVE IT while the field is empty. The D-pad centre arrives
        // as an Enter keydown, and on Android that is the only gesture that raises the
        // soft keyboard for a focused input -- programmatic focus() does not. Taking
        // the key unconditionally made both fields impossible to type into on a TV and
        // told the user their empty email was malformed. Same guard as the search box.
        if (!el.value.trim()) return;
        ev.preventDefault();
        // From the email field, move on rather than submitting a half-filled form.
        const pass = mount.querySelector('#pw-pass');
        if (el.id === 'pw-email' && pass && !pass.value) { pass.focus(); return; }
        pwSubmit(mount, 'login');
      });
    });

    const e = mount.querySelector('#pw-email');
    if (e && !IS_TV) e.focus();                    // never raise a keyboard uninvited on TV
    if (IS_TV) { tvInvalidate(); if (e) tvFocusEl(e); }   // ...but do give the ring a home
  }

  /** Shared by both buttons; `mode` picks the endpoint. */
  let pwBusy = false, pwGen = 0;
  async function pwSubmit(mount, mode) {
    // One at a time. PBKDF2 plus two round trips is seconds on a TV box, the buttons
    // stay live throughout, and a second tap spends another of the five-per-minute
    // tokens the whole sign-in screen shares -- locking the user out of Google and
    // pairing too, for a mistake the UI invited.
    if (pwBusy) return;
    const msg = mount.querySelector('#pw-msg');
    const email = normEmail((mount.querySelector('#pw-email') || {}).value);
    const pass = (mount.querySelector('#pw-pass') || {}).value || '';
    const say = (t) => { if (msg) msg.textContent = t; };
    if (!RX_EMAIL_C.test(email)) return say('That does not look like an email address.');
    if (pass.length < 8) return say('Passwords need at least 8 characters.');

    pwBusy = true;
    const btns = mount.querySelectorAll('[data-au^="pw-"]');
    btns.forEach(b => { b.disabled = true; });
    const done = () => { pwBusy = false; btns.forEach(b => { b.disabled = false; }); };
    // The screen can change under a derivation that takes seconds. If it has, throw the
    // result away rather than signing someone in on a page they already left -- which
    // would run adoptUid and, on a different identity, clear the local stores.
    const gen = ++pwGen;
    const stale = () => gen !== pwGen || !mount.isConnected;

    say(mode === 'signup' ? 'Creating your account\u2026' : 'Checking\u2026');
    let dk;
    try { dk = await deriveDk(email, pass); }
    catch (err) { done(); return say('Could not run the encryption step on this device.'); }
    if (stale()) { done(); return; }

    const r = await syncCall('/v1/auth/pw/' + (mode === 'signup' ? 'signup' : 'login'),
                             { email: email, dk: dk });
    if (stale()) { done(); return; }
    done();
    if (r.err) {
      return say(
        r.status === 409 ? 'That address already has an account \u2014 use Sign in.'
        : r.status === 401 ? 'That email and password do not match an account.'
        : r.status === 404 ? 'Password sign-in is not enabled on the server yet — use Google or a device code.'
        : r.status === 429 && r.err === 'locked'
            ? 'Too many failed attempts on this account. Try again in 15 minutes.'
        : (typeof r.err === 'string' && r.err.indexOf('UID_PEPPER') >= 0)
            ? 'Password sign-in is not finished being set up on the server.'
        : r.err === 'net' || r.err === 'timeout' ? 'No connection. Try again.'
        : r.err === 'slow down' ? 'Too many attempts. Wait a minute.'
        : 'Could not sign in (' + r.err + ').');
    }
    toast(mode === 'signup' ? 'Account created' : 'Signed in');
    return adoptUid(r.d.uid, 'email', email.split('@')[0]);
  }

  /**
   * The ways in, identical on every device.
   *
   * They were not before: the splash offered Google and guest, the sync page offered
   * Google and pairing, and nothing offered a password. Someone who did not want a
   * Google account had no way of knowing the app supported them.
   */
  function authChoicesHTML(withGuest) {
    return '<div class="au-choices">' +
      '<button class="btn primary lg" data-au="google">' + ICON.user + ' Continue with Google</button>' +
      '<button class="btn lg" data-au="pw">' + ICON.mail + ' Email and password</button>' +
      '<button class="btn lg" data-au="pairshow">' + ICON.devices + ' Use a code from another device</button>' +
      (withGuest ? '<button class="btn ghost" id="sp-guest">Continue as guest</button>' : '') +
      '</div>';
  }

  /**
   * Show a terminal error and THEN stop the flow.
   *
   * Order matters and cost us the whole error surface: set() is guarded by !me.dead,
   * authStop() sets me.dead, so "authStop(); set(...)" computed the message and threw
   * it away. Every terminal path did that, so a declined or expired sign-in left the
   * panel waiting for ever with no way forward but Cancel.
   */
  function authFail(mount, me, html) {
    if (!me.dead && mount && mount.isConnected) mount.innerHTML = html;
    if (IS_TV) tvInvalidate();
    authStop();
  }

  function authStop() {
    pwGen++;                 // abandons any password derivation still in flight
    if (!authAbort) return;
    clearTimeout(authAbort.timer);
    if (authAbort.offVis) authAbort.offVis();
    authAbort.dead = true;
    authAbort = null;
  }

  /** Adopt an identity and immediately reconcile with whatever the account already has. */
  async function adoptUid(uid, kind, name) {
    const st = syncState();
    // Whose data is currently in the four stores? If it belongs to a DIFFERENT account,
    // merging would carry the previous occupant's library and -- worse -- their
    // tombstones into this one, silently deleting things the new owner had added. On a
    // shared living-room TV that is one person's deletions quietly editing another
    // person's watchlist. A genuine guest upgrade (boundUid empty) still merges, which
    // is the whole point of signing in after using the app.
    if (st.boundUid && st.boundUid !== uid) {
      try {
        localStorage.removeItem(WATCH_KEY); localStorage.removeItem(PROG_KEY);
        localStorage.removeItem(HIST_KEY); localStorage.removeItem(TOMB_KEY);
      } catch (e) {}
      st.clearedAt = { prog: 0, hist: 0 };
      st.themeAt = 0;
    }
    st.uid = uid; st.on = true; st.kind = kind || 'anon'; st.name = name || '';
    st.lastSyncAt = 0; st.stall = ''; st.lastErr = '';
    // Bound HERE, not after a successful sync. If the first sync fails -- no network
    // in the seconds after signing in on a TV is the ordinary case -- a later sign-in
    // by a different person would still see the previous occupant's boundUid as empty
    // and merge their library instead of replacing it.
    st.boundUid = uid;
    // ...which is exactly why the first-merge exemption cannot be inferred from
    // boundUid. Set it explicitly and spend it on the first SUCCESSFUL merge, so a
    // failed first sync does not consume it.
    st.adopting = 1;
    saveSyncState(st);
    // For a guest upgrading, the merge is a union and cannot remove anything this
    // device had -- mergeBlob's firstAdopt branch exempts local rows from the
    // account's clear epochs precisely so that stays true.
    await syncOnce('manual');
    splashClose();
    route();
  }

  /**
   * Google sign-in, the ordinary way: the system browser opens Google's own consent
   * screen and comes straight back.
   *
   * The device code -- "go to google.com/device and type MKD-VLQ-FCF" -- is right for a
   * television, where the alternative is typing an email on a D-pad, and wrong
   * everywhere else. It was originally used everywhere because Google returns
   * disallowed_useragent to OAuth from an embedded WebView, and both Capacitor builds
   * are embedded WebViews. That is a reason not to use the IN-APP webview, not a reason
   * to avoid redirect OAuth: the system browser is what Google's own guidance
   * prescribes, and openExternal already reaches it on every target.
   *
   * On a modern phone this is also where fingerprint and Face ID come from -- Google's
   * consent screen asks for them itself. Nothing here implements that, and nothing here
   * could.
   */
  async function googleRedirectSignIn(mount) {
    authStop();
    const me = authAbort = { dead: false, timer: null };
    // Opened SYNCHRONOUSLY, while still inside the click that started this. Safari --
    // and therefore every browser on iOS, including the home-screen app we now ship --
    // blocks a window.open issued after an await, because it is no longer attributable
    // to a user gesture. The tab is parked blank and pointed at Google once the Worker
    // answers. Electron is excluded: it denies window.open outright and has its own
    // trusted channel.
    let pre = null;
    if (!IS_DESKTOP && !IS_TV) { try { pre = window.open('', '_blank'); } catch (e) { pre = null; } }
    const closePre = () => { try { if (pre && !pre.closed) pre.close(); } catch (e) {} };
    const set = (html) => { if (!me.dead && mount.isConnected) mount.innerHTML = html; if (IS_TV) tvInvalidate(); };

    set('<div class="au-wait"><span class="ub-spin"></span> Opening Google\u2026</div>');
    const r = await syncCall('/v1/auth/google/begin', {});
    if (me.dead) { closePre(); return; }
    if (r.err) {
      closePre();
      return set('<div class="au-err"><p>' + esc(
        r.err === 'net' || r.err === 'timeout' ? 'No connection. Check the network and try again.'
        : r.err === 'slow down' ? 'Too many attempts. Wait a minute and try again.'
        : r.status === 404
            ? 'The server has not been updated for this sign-in yet — use a device code or a password for now.'
        : (typeof r.err === 'string' && r.err.indexOf('missing') >= 0)
            ? 'Google sign-in is not finished being set up on the server.'
            : 'Could not start sign-in (' + r.err + ').') +
        '</p><button class="btn" data-au="retry">Try again</button>' +
        (mount.closest('#splash') ? '<button class="btn ghost" data-au="guest">Continue as guest</button>' : '') +
        '</div>');
    }

    me.url = r.d.url;                 // for "Open again", without spending a new session
    set(
      '<div class="au-flow au-narrow">' +
        '<span class="au-sb"><span class="au-lead">Choose your Google account in the browser ' +
          'window that just opened, then come back here.</span></span>' +
        '<div class="au-foot">' +
          '<span class="au-live"><i></i>Waiting for you to finish\u2026</span>' +
          '<span class="au-btns">' +
            '<button class="btn sm" data-au="reopen">Open again</button>' +
            '<button class="btn sm ghost" data-au="cancel">Cancel</button>' +
          '</span>' +
        '</div>' +
      '</div>'
    );
    if (pre && !pre.closed) {
      try { pre.location.href = r.d.url; } catch (e) { openExternal(r.d.url); }
    } else {
      openExternal(r.d.url);
    }

    // Coming back to the app is the moment the answer is ready, and also the moment a
    // backgrounded WebView's timers have been frozen -- so poll on return, not only on
    // a timer. clearTimeout FIRST: without it the pending timer survives and every
    // foreground return adds another independent poll chain, each hammering /finish.
    const onVis = () => {
      if (document.visibilityState !== 'visible' || me.dead) return;
      clearTimeout(me.timer);
      tick();
    };
    document.addEventListener('visibilitychange', onVis);
    me.offVis = () => document.removeEventListener('visibilitychange', onVis);

    const tick = async () => {
      if (me.dead) return;
      const p = await syncCall('/v1/auth/google/finish', { session: r.d.session });
      if (me.dead) return;
      if (p.err) { me.timer = setTimeout(tick, 2000); return; }   // transient: keep waiting
      const st = p.d.status;
      if (st === 'pending') { me.timer = setTimeout(tick, 1500); return; }
      if (st === 'ok') {
        authStop();
        toast('Signed in as ' + (p.d.name || 'you'));
        return adoptUid(p.d.uid, 'google', p.d.name);
      }
      authFail(mount, me, '<div class="au-err"><p>' +
        (st === 'denied' ? 'Sign-in was cancelled.'
         : st === 'expired' ? 'That took too long. Start again.'
         : 'Google could not complete sign-in.') +
        '</p><button class="btn" data-au="retry">Try again</button>' +
        (mount.closest('#splash') ? '<button class="btn ghost" data-au="guest">Continue as guest</button>' : '') +
        '</div>');
    };
    me.timer = setTimeout(tick, 1500);
  }

  /** The device flow. TELEVISION ONLY -- see googleRedirectSignIn. */
  async function googleDeviceSignIn(mount) {
    authStop();
    const me = authAbort = { dead: false, timer: null };
    // tvInvalidate alone rebuilds the row model but places nothing, so on the splash --
    // where the chooser that held the ring has just been hidden -- the remote was left
    // with no focus at all until the user guessed to press a direction.
    const set = (html) => {
      if (!me.dead && mount.isConnected) mount.innerHTML = html;
      if (!IS_TV) return;
      tvInvalidate();
      const f = mount.querySelector('button');
      if (f) tvFocusEl(f);
    };

    set('<div class="au-wait"><span class="ub-spin"></span> Contacting Google…</div>');
    const r = await syncCall('/v1/auth/google/start', {});
    if (me.dead) return;
    if (r.err) {
      return set('<div class="au-err"><p>' + esc(
        r.err === 'net' || r.err === 'timeout'
          ? 'No connection. Check the network and try again.'
          : r.err === 'google_unavailable'
            ? 'Google turned the request down. Try again in a minute.'
            : r.err === 'slow down'
              ? 'Too many attempts. Wait a minute and try again.'
              : (typeof r.err === 'string' && r.err.indexOf('missing its') >= 0)
                ? 'Sign-in is not set up on the server yet.'
                : 'Could not start sign-in (' + r.err + ').') +
        '</p><button class="btn" data-au="retry">Try again</button></div>');
    }
    const d = r.d;
    let qr = '';
    try {
      const q = window.qrcode(0, 'M'); q.addData(d.qr_url); q.make();
      // Generated LARGE with a tight quiet zone, then rendered pixelated. At the old
      // (5, 8) the image was 181px and the layout drew it at 132 -- a fractional
      // downscale that smears a 1-bit pattern into a pale grey square which will not
      // scan and, against a white card, simply reads as blank.
      qr = '<img class="au-qr" alt="" width="264" height="264" src="' +
           q.createDataURL(8, 4) + '">';
    } catch (e) { qr = ''; }

    const host = esc(String(d.verification_url || '').replace(/^https?:\/\//, ''));

    if (IS_TV) {
      // A television genuinely needs a second device: there is no browser worth using
      // and no keyboard worth typing on. The QR and the code ARE the instruction.
      set(
        '<div class="au-flow">' +
          (qr ? '<div class="au-qrwrap">' + qr +
                '<span class="au-qrcap">Scan with your phone</span></div>' : '') +
          '<ol class="au-steps">' +
            '<li><span class="au-n">1</span><span class="au-sb">' +
              '<span class="au-lead">Open this on your phone</span>' +
              '<span class="au-url">' + host + '</span></span></li>' +
            '<li><span class="au-n">2</span><span class="au-sb">' +
              '<span class="au-lead">Enter this code</span>' +
              '<span class="au-code">' + esc(d.user_code) + '</span></span></li>' +
          '</ol>' +
          '<div class="au-foot">' +
            '<span class="au-live"><i></i>Waiting for you to approve\u2026</span>' +
            '<button class="btn sm ghost" data-au="cancel">Cancel</button>' +
          '</div>' +
        '</div>'
      );
    } else {
      // Phone, desktop, web: the browser is in your hand. Telling someone holding a
      // phone to "open this on your phone" is the bug this branch exists to fix.
      set(
        '<div class="au-flow au-narrow">' +
          '<span class="au-sb">' +
            '<span class="au-lead">Approve the sign-in in the browser window that just opened, ' +
              'then come back here.</span>' +
          '</span>' +
          '<div class="au-fallback">' +
            '<span class="au-lead">Nothing opened? Go to <b>' + host + '</b> and enter</span>' +
            '<span class="au-code">' + esc(d.user_code) + '</span>' +
          '</div>' +
          '<div class="au-foot">' +
            '<span class="au-live"><i></i>Waiting for you to approve\u2026</span>' +
            '<span class="au-btns">' +
              '<button class="btn sm" data-au="reopen">Open again</button>' +
              '<button class="btn sm ghost" data-au="cancel">Cancel</button>' +
            '</span>' +
          '</div>' +
        '</div>'
      );
      // Remembered so "Open again" works without spending another device code.
      me.url = d.qr_url;
      openExternal(d.qr_url);
    }

    // Poll at the interval Google asked for. The server raises it on slow_down.
    let wait = (d.interval || 5) * 1000;
    // Coming back from the browser is the exact moment the answer is ready, and it is
    // also the moment a backgrounded WebView's timers have been throttled or frozen --
    // so waiting for the next tick can leave someone staring at "Waiting for you to
    // approve" seconds after they approved.
    const onVis = () => {
      if (document.visibilityState !== 'visible' || me.dead) return;
      clearTimeout(me.timer);      // or every return spawns another poll chain
      tick();
    };
    document.addEventListener('visibilitychange', onVis);
    me.offVis = () => document.removeEventListener('visibilitychange', onVis);
    const tick = async () => {
      if (me.dead) return;
      const p = await syncCall('/v1/auth/google/poll', { session: d.session });
      if (me.dead) return;
      if (p.err) { me.timer = setTimeout(tick, wait); return; }   // transient: keep waiting
      const st = p.d.status;
      if (st === 'pending') {
        if (p.d.interval) wait = p.d.interval * 1000;
        me.timer = setTimeout(tick, wait);
        return;
      }
      if (st === 'ok') {
        authStop();
        toast('Signed in as ' + (p.d.name || 'you'));
        return adoptUid(p.d.uid, 'google', p.d.name);
      }
      authFail(mount, me, '<div class="au-err"><p>' +
        (st === 'denied' ? 'Sign-in was declined on the phone.'
         : st === 'expired' ? 'That code expired. Codes last a few minutes.'
         : 'Google could not complete sign-in.') +
        '</p><button class="btn" data-au="retry">Start again</button>' +
        // On the first-run splash the two original buttons are hidden while the flow
        // runs, so without this a failed sign-in leaves "Try again" as the ONLY thing
        // on screen -- no way to continue as a guest, on a device where the failure
        // may well be that there is no network.
        (mount.closest('#splash') ? '<button class="btn ghost" data-au="guest">Continue as guest</button>' : '') +
        '</div>');
      return;
    };
    me.timer = setTimeout(tick, wait);
  }

  /** One entry point; the device it is running on decides which flow. */
  function googleSignIn(mount) {
    return IS_TV ? googleDeviceSignIn(mount) : googleRedirectSignIn(mount);
  }

  /** Pairing: for anyone who would rather not attach a Google account. The TV shows a
   *  code, a signed-in phone claims it, and the TV adopts that identity. */
  async function pairShow(mount) {
    authStop();
    const me = authAbort = { dead: false, timer: null };
    const set = (h) => {
      if (!me.dead && mount.isConnected) mount.innerHTML = h;
      if (!IS_TV) return;
      tvInvalidate();
      const f = mount.querySelector('button');
      if (f) tvFocusEl(f);
    };
    set('<div class="au-wait"><span class="ub-spin"></span> Getting a code…</div>');
    const r = await syncCall('/v1/pair/start', {});
    if (me.dead) return;
    if (r.err) return set('<div class="au-err"><p>Could not get a code. Try again.</p>' +
                          '<button class="btn" data-au="retry-pair">Try again</button></div>');
    set('<div class="au-flow">' +
        '<ol class="au-steps">' +
          '<li><span class="au-n">1</span><span class="au-sb">' +
            '<span class="au-lead">On a device that is already signed in, open</span>' +
            '<span class="au-url">Account \u2192 Connect a device</span></span></li>' +
          '<li><span class="au-n">2</span><span class="au-sb">' +
            '<span class="au-lead">Enter this code</span>' +
            '<span class="au-code">' + esc(r.d.code) + '</span></span></li>' +
        '</ol>' +
        '<div class="au-foot">' +
          '<span class="au-live"><i></i>Works once, expires in a few minutes\u2026</span>' +
          '<button class="btn sm ghost" data-au="cancel">Cancel</button>' +
        '</div></div>');
    const tick = async () => {
      if (me.dead) return;
      // The watcher token, not the code, is what authorises collecting the result.
      // The code is on a television screen; anyone who can read it could otherwise
      // poll faster than the TV, take the uid the phone just attached, and burn the
      // single-use code -- leaving the real TV showing "expired".
      const p = await syncCall('/v1/pair/poll', { code: r.d.code, watcher: r.d.watcher });
      if (me.dead) return;
      if (p.ok && p.d.uid) { authStop(); toast('Device connected'); return adoptUid(p.d.uid, 'paired', ''); }
      if (p.err === 'expired') {
        return authFail(mount, me, '<div class="au-err"><p>That code expired before it was used.</p>' +
                   '<button class="btn" data-au="retry-pair">New code</button></div>');
      }
      me.timer = setTimeout(tick, 1500);
    };
    me.timer = setTimeout(tick, 1500);
  }

  /** The other half of pairing, run on the device that already has an identity. */
  function pairClaim(mount) {
    authStop();
    mount.innerHTML =
      '<div class="au-flow au-narrow">' +
        '<span class="au-sb">' +
          '<span class="au-lead">Enter the code shown on the other device</span>' +
          '<input class="au-input" id="pair-in" maxlength="6" autocapitalize="characters" ' +
                 'autocomplete="off" spellcheck="false" placeholder="ABC123" aria-label="Pairing code">' +
        '</span>' +
        '<div class="au-foot">' +
          '<span class="au-hint" id="pair-msg"></span>' +
          '<button class="btn primary sm" data-au="claim">Connect</button>' +
        '</div>' +
      '</div>';
    const inp = mount.querySelector('#pair-in');
    // The alphabet excludes I, O, 0 and 1 precisely because these get read off a TV
    // across a room, so accept the confusable characters rather than rejecting them.
    if (inp) inp.oninput = () => {
      inp.value = inp.value.toUpperCase().replace(/\s+/g, '')
        .replace(/0/g, 'O').replace(/1/g, 'I')
        .replace(/[^A-Z0-9]/g, '').slice(0, 6);
    };
    if (IS_TV) tvInvalidate();
  }

  function syncView() {
    const st = syncState();
    const on = !!(st.on && st.uid);
    const who = st.kind === 'google' ? (st.name ? esc(st.name) : 'your Google account')
              : st.kind === 'email' ? (st.name ? esc(st.name) + "'s account" : 'your email account')
              : st.kind === 'paired' ? 'a connected device' : 'this device';
    const when = st.lastSyncAt ? relTime(st.lastSyncAt) : 'not yet';

    view().innerHTML = (
      '<div class="sync-page">' +
        '<h1 class="page-title">' + ICON.sync + ' Sync</h1>' +
        (on
          ? '<div class="sync-on">' +
              '<p class="sync-lead">Your watchlist, history and where you left off are saved to ' +
              'your account and follow you to every device.</p>' +
              '<div class="sync-facts">' +
                '<div><span>Signed in with</span><b>' + who + '</b></div>' +
                '<div><span>Last synced</span><b>' + esc(when) + '</b></div>' +
                (st.stall ? '<div class="bad"><span>Problem</span><b>' + esc(st.stall) + '</b></div>' : '') +
              '</div>' +
              '<div class="sync-actions">' +
                '<button class="btn" data-au="now">' + ICON.sync + ' Sync now</button>' +
                '<button class="btn" data-au="pairclaim">' + ICON.devices + ' Connect a device</button>' +
                '<button class="btn danger" data-au="signout">' + ICON.logout + ' Sign out</button>' +
              '</div>' +
              '<div class="au-mount"></div>' +
            '</div>'
          : '<div class="sync-off">' +
              '<p class="sync-lead">Sign in and your watchlist, history and resume points ' +
              'follow you to your phone, your TV and your desktop. Without it everything ' +
              'stays on this device only.</p>' +
              authChoicesHTML(false) +
              '<div class="au-mount"></div>' +
              '<p class="sync-fine">Signing in with Google only reads your name and email ' +
              'address to recognise you — Reeldeck never posts anything and never keeps a ' +
              'Google login token. A Google account and an email/password account are ' +
              'separate, even with the same address.</p>' +
            '</div>') +
      '</div>'
    );

    wireAu($('.sync-page'));
    // false: the view is already in the DOM by this line, so waiting for a render
    // that has happened only leaves the ring absent for the poll interval.
    if (IS_TV) tvFocusFirst(false, false);
  }

  /**
   * The sign-in controls, wired for whichever container is showing them.
   *
   * Both the #/sync page and the first-run splash mount the same flow. Binding the
   * handler to .sync-page alone left every button inside the splash inert -- it
   * rendered perfectly and did nothing, which is exactly the failure a render-only
   * test cannot see.
   */
  function wireAu(root) {
    if (!root) return;
    root.onclick = async (e) => {
      const b = e.target.closest('[data-au]'); if (!b) return;
      const what = b.dataset.au;
      // Scoped to THIS container: while the splash is open there can be two mounts in
      // the document, and a document-wide lookup would drive the wrong one.
      const mount = root.querySelector('.au-mount');
      if (what === 'google') return googleSignIn(mount);
      if (what === 'pw') return pwPanel(mount);
      if (what === 'pw-login') return pwSubmit(mount, 'login');
      if (what === 'pw-signup') return pwSubmit(mount, 'signup');
      if (what === 'retry') return googleSignIn(mount);
      if (what === 'pairshow' || what === 'retry-pair') return pairShow(mount);
      if (what === 'pairclaim') return pairClaim(mount);
      if (what === 'guest') { const st2 = syncState(); st2.splash = 1; saveSyncState(st2); return splashClose(); }
      if (what === 'reopen') {
        // Reuses the SAME device code -- asking Google for another one would spend
        // quota and invalidate the code already on screen.
        if (authAbort && authAbort.url) openExternal(authAbort.url);
        return;
      }
      if (what === 'cancel') {
        authStop();
        mount.innerHTML = '';
        const acts = root.querySelector('.splash-actions');
        if (acts) acts.style.display = '';      // splash: give the choices back
        const fine2 = root.querySelector('.splash-fine');
        if (fine2) fine2.style.display = '';
        if (IS_TV) {
          tvInvalidate();
          // Put the ring back on the choices EXPLICITLY. tvFocusFirst hunts inside
          // #view and falls back to the header nav, and while the splash is open
          // body.splash-on sets both to display:none -- so it would find nothing at
          // all and leave the remote with no visible focus and nothing to press.
          const first = root.querySelector('.au-choices [data-au]');
          if (first) tvFocusEl(first); else tvFocusFirst(false, false);
        }
        return;
      }
      if (what === 'now') { toast('Syncing…'); await syncOnce('manual'); return route(); }
      if (what === 'claim') {
        const inp = $('#pair-in'), msg = $('#pair-msg');
        const code = (inp && inp.value || '').trim();
        if (code.length !== 6) { if (msg) msg.textContent = 'That code is six characters.'; return; }
        const r = await syncCall('/v1/pair/claim', { code: code, uid: syncState().uid });
        if (msg) {
          msg.textContent = r.ok ? 'Connected. The other device will pick it up in a moment.'
            : r.status === 410 ? 'That code has expired — get a new one on the other device.'
            : r.status === 409 ? 'That code has already been used.'
            : 'That code was not recognised.';
        }
        return;
      }
      if (what === 'signout') {
        if (!confirm('Sign out on this device?\n\nWhat you have watched stays on this device. ' +
                     'It also stays in your account, and signing in again brings it back.')) return;
        authStop();
        const s2 = syncState();
        s2.on = false; s2.uid = ''; s2.kind = ''; s2.name = ''; s2.lastSyncAt = 0;
        saveSyncState(s2);
        toast('Signed out');
        return route();
      }
    };
  }

  /* ---- first-run splash ---------------------------------------------------
     Shown ONCE. A sign-in wall on every launch would be exactly wrong here: the app
     has always worked without an account, and on a TV the first thing a new user
     would meet is a QR code standing between them and anything to watch.
     ------------------------------------------------------------------------- */
  function splashSeen() { const st = syncState(); return !!st.splash || !!(st.on && st.uid); }

  /** Take the overlay down and give the app back. Called from adoptUid, so a sign-in
   *  that STARTED on the splash also finishes there -- otherwise the overlay stays
   *  over a working app until the next reload. */
  function splashClose() {
    const sp = document.getElementById('splash');
    if (!sp) return;
    authStop();
    sp.remove();
    document.body.classList.remove('splash-on');
    if (IS_TV) { tvInvalidate(); tvFocusFirst(false, false); }
  }
  function maybeSplash() {
    if (splashSeen()) return;
    const back = document.createElement('div');
    back.className = 'splash-back';
    back.id = 'splash';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-labelledby', 'splash-h');
    back.innerHTML =
      '<div class="splash">' +
        // The app's own mark, masked so it takes the current theme's colour like the
        // one in the header does -- not a generic gradient tile.
        '<div class="splash-brand">' +
          '<span class="brand-mark" aria-hidden="true"></span>' +
          '<span class="splash-word">' + esc(cfg.brand || 'Reeldeck') + '</span>' +
        '</div>' +
        '<h2 id="splash-h">Watch everywhere</h2>' +
        '<p>Sign in and your watchlist, history and resume points follow you to your ' +
        'phone, your TV and your desktop.</p>' +
        '<div class="splash-actions">' + authChoicesHTML(true) + '</div>' +
        '<p class="splash-fine">You can sign in later from the account menu.</p>' +
        '<div class="au-mount splash-mount"></div>' +
      '</div>';
    document.body.appendChild(back);
    // Hides #view and the header behind the opaque overlay. Visually a no-op, but it
    // also makes them unfocusable -- without it route()'s pending focus grab lands on
    // Home the moment its content arrives and the D-pad ring disappears behind the
    // splash with no way back.
    document.body.classList.add('splash-on');
    const done = () => { const st = syncState(); st.splash = 1; saveSyncState(st); };
    back.querySelector('#sp-guest').onclick = () => { done(); splashClose(); };
    // Any of the three real choices hides the chooser and hands over to its flow; the
    // shared [data-au] handler below does the rest.
    back.addEventListener('click', (e) => {
      const b = e.target.closest('[data-au]');
      if (!b || b.id === 'sp-guest') return;
      done();
      const acts = back.querySelector('.splash-actions');
      if (acts) acts.style.display = 'none';
      // "You can sign in later" is orientation for someone deciding. Once they have
      // decided it is just a stranded line above the thing they are now doing.
      const fine = back.querySelector('.splash-fine');
      if (fine) fine.style.display = 'none';
    }, true);      // capture, so it runs BEFORE wireAu starts the flow
    // The same controls the #/sync page uses -- Cancel and Try again live in here too.
    wireAu(back);
    if (IS_TV) { tvInvalidate(); tvFocusEl(back.querySelector('[data-au="google"]')); }
  }

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
  let nextUpTimer = null, nextUpWake = null;
  function nextUpHide() {
    const el = document.getElementById('next-up');
    clearTimeout(nextUpTimer);
    if (nextUpWake) {
      ['pointerdown', 'touchstart', 'mousemove', 'keydown'].forEach(ev =>
        document.removeEventListener(ev, nextUpWake, { capture: true }));
      nextUpWake = null;
    }
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

  /**
   * Everything recently watched, newest first, deep-linked to the exact episode.
   *
   * One rail, not two. "Continue watching" and "Recently watched" were the same list
   * split by whether something happened to be finished -- a distinction the viewer
   * had to work out by looking at two rails holding the same posters. Unfinished
   * entries resume where they stopped; finished ones simply start again.
   */
  function recentRailHTML() {
    let rows = histAll();
    if (!rows.length) return '';
    if (IS_TV) rows = rows.slice(0, 14);
    const tiles = rows.slice(0, 20).map(r => {
      const href = r.type === 'tv'
        ? ('#/watch/tv/' + r.id + '?s=' + (r.s || 1) + '&e=' + (r.e || 1))
        : ('#/watch/movie/' + r.id);
      const sub = r.type === 'tv' ? ('S' + (r.s || 1) + ' · E' + (r.e || 1)) : 'Film';
      const pr = progGet(r.type, r.id, r.s, r.e);
      const pct = pr ? Math.round(Math.min(1, pr.pct || 0) * 100) : 0;
      return `<div class="card" data-nav="${href}" tabindex="0" role="button"
                   aria-label="${esc(r.title || 'title')}, ${sub}, watched ${relTime(r.at)}">
        <div class="poster">
          <img loading="lazy" src="${img(r.poster_path, 'w342')}" alt="" onerror="this.src='${PLACEHOLDER}'">
          ${pct > 1 ? `<span class="card-prog"><i style="width:${pct}%"></i></span>` : ''}
        </div>
        <div class="cap"><div class="t">${esc(r.title || 'Untitled')}</div><div class="y">${sub} · ${relTime(r.at)}</div></div>
        <button class="cw-x" data-unwatch="${esc(r.k)}" tabindex="${IS_TV ? '0' : '-1'}"
                aria-label="Remove ${esc(r.title || 'this title')} from Recently watched">${ICON.x}</button>
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
      // ONE rail, not two. "Continue watching" and "Recently watched" were the same
      // list split by whether something happened to be finished, which is a
      // distinction the viewer has to work out by looking. Recently watched covers
      // both: unfinished entries resume where they stopped, finished ones start over.
      html += recentRailHTML();
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
    // Open the panel when something is already filtering, so a narrowed list never
    // looks like the whole catalogue with results mysteriously missing.
    const activeFilters = [params.sort && params.sort !== 'popularity.desc', params.yfrom, params.yto,
                           params.rating, params.lang, selGenres.length].filter(Boolean).length;
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
        <div class="field genres-field"><label>Genres</label>
          <div class="chips" id="f-genres">
            ${gl.map(g => `<button class="chip ${selGenres.includes(String(g.id)) ? 'on' : ''}" data-genre="${g.id}" aria-pressed="${selGenres.includes(String(g.id))}">${esc(g.name)}</button>`).join('')}
          </div>
        </div>
      </div>
      </details>`;

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
      // A native disclosure changes what is on screen WITHOUT any DOM mutation the
      // row model observes, so without this the D-pad keeps navigating the layout the
      // panel had before it moved. Exactly the bug already fixed for the player's
      // server picker (#srv) -- same shape, new place.
      const fEl = $('.filters');
      if (fEl) fEl.addEventListener('toggle', () => {
        if (!IS_TV) return;
        tvInvalidate();
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
    // Every platform now, not just TV. The header traded its inline field for an
    // icon, so this is the only search input in the app -- and giving it a whole
    // page means it can be the size it deserves instead of competing with the nav.
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
                <div class="ep-body">
                  <div class="en">S${n} · E${ep.episode_number}${ep.runtime ? ' · ' + ep.runtime + 'm' : ''}</div>
                  <div class="et">${esc(ep.name || 'Episode ' + ep.episode_number)}</div>
                  <div class="eo">${esc(ep.overview || '')}</div>
                  ${progBar(pr)}
                </div>
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
        <div class="section"><h3>Known for</h3><div class="grid">${known.map(c => cardHTML(c, c.media_type, true)).join('')}</div></div>`;
      window.scrollTo(0, 0);
    } catch (e) { errorState(e); }
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
          <img loading="lazy" alt="" src="${img(ep.still_path, 'w300')}" onerror="this.src='${PLACEHOLDER}'">
          ${pct ? `<span class="ep-fill" style="width:${pct}%"></span>` : ''}
          ${done ? `<span class="ep-tick">${ICON.check}</span>` : ''}
          ${cur ? `<span class="epx-now">${ICON.play}</span>` : ''}
        </span>
        <span class="epx-n">E${ep.episode_number}</span>
        <span class="epx-t">${esc(ep.name || '')}</span>
      </button>`;
    }).join('');
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
    const epStrip = (isTV && seasonEps.length) ? `
      <div class="rail-head" style="margin:26px 0 12px">
        <h2 style="font-size:16px">Episodes</h2>
      </div>
      ${seasonRail}
      <div class="rail-wrap">
        <button class="rail-arrow left" data-rail="-1" tabindex="-1" aria-label="Scroll episodes left">${ICON.back}</button>
        <button class="rail-arrow right" data-rail="1" tabindex="-1" aria-label="Scroll episodes right">${ICON.chevR}</button>
      <div class="ep-strip" id="ep-strip">${epTiles(id, season, seasonEps, season === episodeSeason ? episode : -1)}</div>
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
          <span class="sb-modes">
            <button class="btn sm ghost" id="movie-mode" title="Fill this window">Movie mode</button>
            <button class="btn sm ghost" id="tv-mode" title="Fill the whole screen">${ICON.tv} TV mode</button>
          </span>
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
            </div>
            <div class="server-room">${roomTiles}</div>
            <p class="muted mirror-note"><span class="mbadge static">${ICON.check} Verified</span>
              servers remember exactly where you stopped. The others still save your place,
              roughly. Switch servers if one stutters — no single one has everything.</p>
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
      ? `<div class="grid">${list.map(i => cardHTML(i, i.type, true)).join('')}</div>`
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
          <p class="muted" style="font-size:12.5px;margin-top:4px">Want your own memorable link instead? Paste one (e.g. a custom <b>tinyurl.com</b> alias) and save — it replaces the address above and updates the QR.</p>
          <div class="ga-url"><input id="ga-short" placeholder="https://tinyurl.com/your-alias" value="${esc(manual)}"><button class="btn sm primary" id="ga-save">Save</button></div>
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
            <p>You are running the installed app. Sign in under <b>Account</b> to carry your
               watchlist and history across to your other devices.</p></div>` : ''}
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

  /* ---------- Account menu + browse drawer ----------------------------------
     The header carries three things now: search, watchlist, account. Everything that
     used to sit in it -- settings, updates, install -- lives under the account
     button, because that is where people look for it and because it leaves the bar
     with room to breathe. Browsing by genre moved to a drawer, which also let the
     Movies/TV filter bar stop being a wall of controls. */
  function closeAcct() {
    const m = $('#acct-menu'); if (m) m.remove();
    const b = $('#acct-btn'); if (b) b.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', closeAcct._esc || (() => {}));
  }
  function wireAccountMenu() {
    const btn = $('#acct-btn'); if (!btn) return;
    btn.onclick = (e) => {
      e.stopPropagation();
      if ($('#acct-menu')) return closeAcct();
      const m = document.createElement('div');
      m.className = 'acct-menu'; m.id = 'acct-menu'; m.setAttribute('role', 'menu');
      const sst = syncState();
      const signedIn = !!(sst.on && sst.uid);
      const label = signedIn ? (sst.name || 'Signed in') : 'Signed out';
      const sub2 = signedIn
        ? (sst.stall ? 'Sync needs attention'
                     : 'Synced ' + (sst.lastSyncAt ? relTime(sst.lastSyncAt) : 'soon'))
        : 'Watching on this device';
      const initial = (signedIn && sst.name ? sst.name : (cfg.brand || 'R')).charAt(0).toUpperCase();
      m.innerHTML = `
        <div class="am-who"><span class="acct-av">${esc(initial)}</span>
          <span><b>${esc(label)}</b><small>${esc(sub2)}</small></span></div>
        <button class="am-item" data-am="sync" role="menuitem">${signedIn ? ICON.sync + ' Sync &amp; devices' : ICON.user + ' Sign in'}</button>
        <button class="am-item" data-am="settings" role="menuitem">${ICON.gear} Settings</button>
        <button class="am-item" data-am="update" role="menuitem">${ICON.download} Check for updates</button>
        <button class="am-item" data-am="getapp" role="menuitem">${ICON.tv} Install on TV</button>
        <button class="am-item" data-am="watchlist" role="menuitem">${ICON.bookmark} Watchlist</button>`;
      document.body.appendChild(m);
      const r = btn.getBoundingClientRect();
      // Clamped against the safe area, not just against 0. The button sits inside a
      // header that already carries safe-area-inset-top, so in practice this is a
      // floor rather than a correction -- but it is set as an inline style, so a
      // stylesheet rule could never provide one.
      const safeTop = parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--sat')) || 0;
      m.style.top = Math.round(Math.max(r.bottom + 8, safeTop + 8)) + 'px';
      m.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
      btn.setAttribute('aria-expanded', 'true');
      m.onclick = (e2) => {
        const it = e2.target.closest('[data-am]'); if (!it) return;
        const what = it.dataset.am; closeAcct();
        if (what === 'sync') go('#/sync');
        else if (what === 'settings') openSettings();
        else if (what === 'update') checkForUpdate(true);
        else if (what === 'getapp') go('#/get-app');
        else if (what === 'watchlist') go('#/watchlist');
      };
      closeAcct._esc = (e3) => { if (e3.key === 'Escape') closeAcct(); };
      document.addEventListener('keydown', closeAcct._esc);
      if (IS_TV) { tvInvalidate(); const f = m.querySelector('.am-item'); if (f) tvFocusEl(f); }
    };
    document.addEventListener('click', (e) => {
      if ($('#acct-menu') && !e.target.closest('#acct-menu') && !e.target.closest('#acct-btn')) closeAcct();
    });
  }

  function closeDrawer() {
    const d = $('#drawer'), b = $('#drawer-back');
    // REMOVE it, do not just slide it away. translateX(-100%) moves it off screen but
    // leaves every link in it focusable, so after opening the drawer once the D-pad
    // could walk into 23 invisible targets on every subsequent screen.
    if (d) {
      d.classList.remove('open');
      const gone = () => { if (d.parentNode && !d.classList.contains('open')) d.remove(); };
      // After the 260ms slide-out, or immediately where transitions do not run.
      d.addEventListener('transitionend', gone, { once: true });
      setTimeout(gone, 320);
    }
    if (b) b.remove();
    const o = $('#nav-open'); if (o) o.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('drawer-on');
    if (IS_TV) tvInvalidate();
  }
  async function openDrawer() {
    let d = $('#drawer');
    if (!d) {
      d = document.createElement('aside');
      d.id = 'drawer'; d.className = 'drawer'; d.setAttribute('aria-label', 'Browse');
      d.innerHTML = `
        <div class="dw-head">
          <button class="icon-btn" id="drawer-close" aria-label="Close menu">${ICON.x}</button>
          <span class="dw-brand">${esc(cfg.brand)}</span>
        </div>
        <nav class="dw-nav" aria-label="Sections">
          <a href="#/" data-nav="#/">Home</a>
          <a href="#/movies" data-nav="#/movies">Movies</a>
          <a href="#/tv" data-nav="#/tv">TV Shows</a>
          <a href="#/watchlist" data-nav="#/watchlist">Watchlist</a>
        </nav>
        <hr class="dw-sep">
        <div class="dw-kicker">Genres</div>
        <div class="dw-genres" id="dw-genres"><span class="muted">Loading…</span></div>`;
      document.body.appendChild(d);
      d.querySelector('#drawer-close').onclick = closeDrawer;
      d.addEventListener('click', (e) => { if (e.target.closest('[data-nav]')) closeDrawer(); });
    }
    const back = document.createElement('div');
    back.id = 'drawer-back'; back.className = 'drawer-back';
    back.onclick = closeDrawer;
    document.body.appendChild(back);
    document.body.classList.add('drawer-on');
    requestAnimationFrame(() => d.classList.add('open'));
    const o = $('#nav-open'); if (o) o.setAttribute('aria-expanded', 'true');

    // Genres are fetched once and cached by genres(); the drawer just renders them.
    // Movie ids, because TMDB numbers movie and TV genres differently and one list
    // has to win -- the section links above are how you get to shows.
    const box = $('#dw-genres');
    if (box && !box.dataset.filled) {
      try {
        const gl = await genres('movie');
        box.innerHTML = gl.map(g => `<a href="#/movies?genres=${g.id}" data-nav="#/movies?genres=${g.id}">${esc(g.name)}</a>`).join('');
        box.dataset.filled = '1';
      } catch (e) { box.innerHTML = '<span class="muted">Could not load genres.</span>'; }
    }
    if (IS_TV) { tvInvalidate(); const f = d.querySelector('a, button'); if (f) tvFocusEl(f); }
  }
  function wireDrawer() {
    const o = $('#nav-open'); if (!o) return;
    o.onclick = () => ($('#drawer') && $('#drawer').classList.contains('open')) ? closeDrawer() : openDrawer();
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
      // The theme is the ONE field of cfg that syncs, so it needs its own stamp --
      // cfg itself is never sent, for the reasons above syncState().
      const st = syncState(); st.themeAt = now(); saveSyncState(st);
      syncFlush('theme');
    };
    renderUpdBox();
    const ga = $('#set-getapp', back);
    if (ga) ga.onclick = () => { closeModal(back); go('#/get-app'); };
    $('#set-reset', back).onclick = () => { if (confirm('Reset theme + settings to defaults? Your watchlist is kept.')) { cfg = Object.assign({}, DEFAULTS); cfg.sources = DEFAULT_SOURCES.map(x => Object.assign({}, x)); saveConfig(); const rst = syncState(); rst.themeAt = now(); saveSyncState(rst); syncFlush('reset'); closeModal(back); route(); toast('Settings reset'); } };
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
    authStop();                  // abandon any sign-in / pairing poll from the last view
    closeSuggest();
    clearHero();                 // stop billboard rotation when leaving Home
    // Nothing from the previous screen may outlive it. An open modal would otherwise
    // stay mounted over the new page (browser Back on a playing trailer), and the
    // cinema/player classes would leave `overflow: hidden` and their document
    // listeners on every subsequent page with no way back but a reload.
    document.querySelectorAll('.modal-back').forEach(closeModal);
    // The drawer and the account menu are overlays too. Left mounted across a
    // navigation, the drawer keeps body.drawer-on (overflow: hidden) and its scrim
    // over the new page.
    closeDrawer();
    closeAcct();
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
      case 'sync': return syncView();
      default: return homeView();
    }
  }

  /* ============================================================
     Header + global events
     ============================================================ */
  function buildHeader() {
    const hdr = $('header.top');
    hdr.innerHTML = `
      <button class="icon-btn nav-burger" id="nav-open" aria-label="Browse menu" aria-expanded="false" aria-controls="drawer">${ICON.menu}</button>
      <a class="brand" href="#/" data-nav="#/" aria-label="${esc(cfg.brand)} — home">
        <span class="brand-mark" aria-hidden="true"></span><span class="txt">${esc(cfg.brand)}</span>
      </a>
      <nav class="main" aria-label="Primary">
        <a href="#/" data-nav="#/" data-section="home">Home</a>
        <a href="#/movies" data-nav="#/movies" data-section="movies">Movies</a>
        <a href="#/tv" data-nav="#/tv" data-section="tv">TV Shows</a>
      </nav>
      <span class="hdr-gap"></span>
      <button class="icon-btn" id="search-btn" data-nav="#/search" data-section="search" title="Search" aria-label="Search">${ICON.search}</button>
      <a class="icon-btn" href="#/watchlist" data-nav="#/watchlist" data-section="watchlist" title="Watchlist" aria-label="Watchlist">${ICON.bookmark}</a>
      <button class="acct-btn" id="acct-btn" aria-haspopup="true" aria-expanded="false" title="Account" aria-label="Account and settings">
        <span class="acct-av" aria-hidden="true">${esc((cfg.brand || 'R').charAt(0).toUpperCase())}</span>
      </button>`;

    // Search moved out of the header and onto its own page, for every platform.
    // An always-open field competing with the nav is what made the bar feel like a
    // toolbar; an icon that goes somewhere is the same affordance for less room, and
    // the search PAGE can give the field the space it actually wants.
    wireAccountMenu();
    wireDrawer();

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
      // Remember where the ring was BEFORE the tile goes, so it can land on a
      // neighbour rather than being sent back to the top of the page.
      const goneCard = uw.closest('.card');
      const nextCard = goneCard && (goneCard.nextElementSibling || goneCard.previousElementSibling);
      progForget(uw.dataset.unwatch);
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
      toast('Removed from Recently watched');
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
  wireSync();
  maybeSplash();

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

  /**
   * What the D-pad is allowed to reach right now.
   *
   * Anything that covers the page has to be in this list or the ring walks straight
   * out of it onto the dimmed content behind, which on a remote is indistinguishable
   * from the app having lost focus entirely. Ordered by stacking: the splash sits
   * over everything, then the drawer, then the account menu, then modals.
   */
  function tvScope() {
    const sp = document.getElementById('splash');
    if (sp) return sp;
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
    // body/html are never a focus target: focus() is a no-op on them and the
    // scroll-into-view maths below uses their rect, which is the whole document.
    if (!el || el === document.body || el === document.documentElement) return;
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

  // Type "/" anywhere to jump to search. Registered here, at module scope, NOT inside
  // the IS_TV block below -- that block has silently swallowed a listener twice in this
  // file, and a shortcut for a physical keyboard is meaningless on the one platform it
  // would have worked on.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    if (document.querySelector('.modal-back') || document.getElementById('splash')) return;
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

    const rows = tvRowModel(tvScope());
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
      // Overlays first, innermost outwards. Without these the universal Android
      // dismiss gesture either quits the app (at navDepth 0) or navigates the page
      // underneath while the overlay and its scrim stay mounted on top.
      const sp = document.getElementById('splash');
      if (sp) {
        // If a sign-in flow is mounted, Back cancels THAT and returns to the choices.
        // Falling straight through to "Continue as guest" meant the hardware Back
        // button silently answered a question the user was still in the middle of, and
        // dismissed the first-run screen for good.
        const mnt = sp.querySelector('.au-mount');
        if (mnt && mnt.innerHTML.trim()) {
          const c = mnt.querySelector('[data-au="cancel"]');
          if (c) { c.click(); return; }
          authStop();
          mnt.innerHTML = '';
          const acts = sp.querySelector('.splash-actions'); if (acts) acts.style.display = '';
          const fine = sp.querySelector('.splash-fine'); if (fine) fine.style.display = '';
          if (IS_TV) { tvInvalidate(); const f = sp.querySelector('.au-choices [data-au]'); if (f) tvFocusEl(f); }
          return;
        }
        const g = sp.querySelector('#sp-guest'); if (g) g.click();
        return;
      }
      const dw = document.getElementById('drawer');
      if (dw && dw.classList.contains('open')) { closeDrawer(); return; }
      if (document.getElementById('acct-menu')) { closeAcct(); return; }
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
