/* ============================================================
   Reeldeck — client-side app logic (no build step, no framework)
   Data: TMDB API v3 (same backend the source site uses).
   Everything routes through CONFIG so you can re-point the app
   at a different base URL / key / player source from Settings.
   ============================================================ */
(function () {
  'use strict';

  /* ------------------------------------------------------------
     CONFIG  — the single source of truth. Change the link here
     (or in the Settings panel) and every request follows.
     ------------------------------------------------------------ */
  const CONFIG_KEY = 'reeldeck.config.v5';
  const WATCH_KEY  = 'reeldeck.watchlist.v1';

  // Mirror list lifted verbatim from the source site's own player module.
  // These are third-party embed providers — the app just frames them. Fully
  // editable/removable in Settings. Placeholders resolved by buildSourceUrl().
  const DEFAULT_SOURCES = [
    { name: 'VidSrcMe',   movie: 'https://vidsrcme.su/embed/movie/{id}',                      tv: 'https://vidsrcme.su/embed/tv/{id}/{season}/{episode}' },
    { name: 'VidKing',    movie: 'https://www.vidking.net/embed/movie/{id}?autoPlay=true',    tv: 'https://www.vidking.net/embed/tv/{id}/{season}/{episode}?autoPlay=true&nextEpisode=true&episodeSelector=true' },
    { name: 'VidEasy',    movie: 'https://player.videasy.net/movie/{id}?color=%23{color}',    tv: 'https://player.videasy.net/tv/{id}/{season}/{episode}?color=%23{color}&nextEpisode=true&autoplayNextEpisode=true&episodeSelector=true' },
    { name: 'Cinemaos',   movie: 'https://cinemaos.tech/player/{id}',                         tv: 'https://cinemaos.tech/player/{id}/{season}/{episode}' },
    { name: 'VidSrc RU',  movie: 'https://vidsrc-embed.ru/embed/movie/{id}',                  tv: 'https://vidsrc-embed.ru/embed/tv/{id}/{season}/{episode}' },
    { name: 'VidSrc SU',  movie: 'https://vidsrc-embed.su/embed/movie/{id}',                  tv: 'https://vidsrc-embed.su/embed/tv/{id}/{season}/{episode}' },
    { name: 'MultiEmbed', movie: 'https://multiembed.mov/?video_id={id}&tmdb=1',              tv: 'https://multiembed.mov/?video_id={id}&tmdb=1&s={season}&e={episode}' },
    { name: 'Vsrc',       movie: 'https://vsrc.su/embed/movie/{id}',                          tv: 'https://vsrc.su/embed/tv/{id}/{season}/{episode}' },
    { name: 'VidLink',    movie: 'https://vidlink.pro/movie/{id}',                            tv: 'https://vidlink.pro/tv/{id}/{season}/{episode}' },
    { name: 'AutoEmbed',  movie: 'https://player.autoembed.app/embed/movie/{id}',            tv: 'https://player.autoembed.app/embed/tv/{id}/{season}/{episode}' },
    { name: 'VidFast',    movie: 'https://vidfast.pro/movie/{id}',                            tv: 'https://vidfast.pro/tv/{id}/{season}/{episode}' },
    { name: '111Movies',  movie: 'https://111movies.com/movie/{id}',                          tv: 'https://111movies.com/tv/{id}/{season}/{episode}' },
    { name: 'Vidora',     movie: 'https://vidora.su/movie/{id}',                              tv: 'https://vidora.su/tv/{id}/{season}/{episode}?autoplay=true' },
    { name: 'Smashy',     movie: 'https://player.smashystream.com/movie/{id}?autoplay=true',  tv: 'https://player.smashystream.com/tv/{id}?s={season}&e={episode}' }
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
  const APP_VERSION = '1.0.5';   // bump with each release (matches package.json)
  const REPO = 'jaig-eye/reeldeck';

  // TV / D-pad state — declared up here (not next to the nav functions further
  // down) because route() and other render paths call tvFocusFirst()/tvSpatialNav()
  // at boot, BEFORE those later lines would run. Declaring them there left them in
  // the temporal dead zone, so the first call threw "Cannot access 'X' before
  // initialization" and aborted the whole app on TV (blank home, dead D-pad).
  const TV_FOCUSABLE = '[data-nav], button:not([disabled]), input:not([type="hidden"]), select, [tabindex="0"]';
  let tvObserver = null, tvTimeout = 0;
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
  function toast(msg) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
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
  function getWatch() { try { return JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'); } catch (e) { return []; } }
  function setWatch(a) { localStorage.setItem(WATCH_KEY, JSON.stringify(a)); }
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
     Card + rail + grid builders
     ------------------------------------------------------------ */
  function cardHTML(item, forcedType) {
    const type = forcedType || item.media_type || (item.first_air_date || item.name && !item.title ? 'tv' : 'movie');
    itemCache[ck(type, item.id)] = item;
    const title = item.title || item.name || 'Untitled';
    const y = year(item.release_date || item.first_air_date);
    const rating = item.vote_average ? Number(item.vote_average).toFixed(1) : null;
    const on = isInWatch(item.id, type);
    return `<div class="card" data-nav="#/${type}/${item.id}" tabindex="0" role="button" aria-label="${esc(title)}${y ? ', ' + y : ''}">
      <div class="poster">
        <img loading="lazy" src="${img(item.poster_path, 'w342')}" alt="${esc(title)}"
             onerror="this.src='${PLACEHOLDER}'">
        ${rating ? `<span class="rate">${ICON.star} ${rating}</span>` : ''}
        <span class="typebadge">${type === 'tv' ? 'TV' : 'Movie'}</span>
        <button class="wl ${on ? 'on' : ''}" data-wl="${item.id}" data-type="${type}" title="Toggle watchlist" aria-label="${on ? 'Remove from' : 'Add to'} watchlist">
          ${on ? ICON.bookmarkFill : ICON.bookmark}
        </button>
        <div class="card-hover">
          <button class="ch-play" data-nav="#/watch/${type}/${item.id}" tabindex="-1" aria-label="Play ${esc(title)}">${ICON.play}</button>
          <div class="ch-cap"><div class="ch-title">${esc(title)}</div><div class="ch-meta">${y || ''}${rating ? ' · ★ ' + rating : ''}</div></div>
        </div>
      </div>
      <div class="cap"><div class="t">${esc(title)}</div><div class="y">${y || '—'}</div></div>
    </div>`;
  }

  function railHTML(title, items, moreHref, type) {
    if (!items || !items.length) return '';
    return `<section class="rail">
      <div class="rail-head"><h2>${esc(title)}</h2>${moreHref ? `<a class="more" data-nav="${moreHref}">See all ${ICON.chevR}</a>` : ''}</div>
      <div class="rail-wrap">
        <button class="rail-arrow left" data-rail="-1" tabindex="-1" aria-label="Scroll left">${ICON.back}</button>
        <div class="track">${items.map(i => cardHTML(i, type)).join('')}</div>
        <button class="rail-arrow right" data-rail="1" tabindex="-1" aria-label="Scroll right">${ICON.chevR}</button>
      </div>
    </section>`;
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
              <div class="card-hover"><button class="ch-play" data-nav="#/watch/${type}/${it.id}" tabindex="-1" aria-label="Play">${ICON.play}</button></div>
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
  function clearHero() { if (heroTimer) { clearInterval(heroTimer); heroTimer = null; } }

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
          ${rating ? `<span class="star">${ICON.star} ${rating}</span>` : ''}
          <span>${y || ''}</span>
          <span class="pill-type">${type === 'tv' ? 'Series' : 'Film'}</span>
        </div>
        <p class="bb-ovw">${esc(ov)}${(it.overview || '').length > 200 ? '…' : ''}</p>
        <div class="bb-cta">
          <button class="btn primary lg" data-nav="#/watch/${type}/${it.id}">${ICON.play} Play</button>
          <button class="btn glass lg" data-nav="#/${type}/${it.id}">${ICON.info} More Info</button>
          <button class="btn glass icon" data-wl="${it.id}" data-type="${type}" aria-label="${on ? 'Remove from' : 'Add to'} watchlist">${on ? ICON.check : ICON.plus}</button>
        </div>
      </div>
    </div>`;
  }

  function buildBillboard(items) {
    if (!items.length) return '';
    return `<div class="billboard" id="billboard">
      ${items.map(billboardSlide).join('')}
      <div class="bb-dots">${items.map((it, i) => `<button class="bb-dot ${i === 0 ? 'on' : ''}" data-dot="${i}" tabindex="-1" aria-label="Featured ${i + 1}"></button>`).join('')}</div>
    </div>`;
  }

  function wireBillboard() {
    const bb = document.getElementById('billboard');
    if (!bb) return;
    const slides = [].slice.call(bb.querySelectorAll('.bb-slide'));
    const dots = [].slice.call(bb.querySelectorAll('.bb-dot'));
    if (slides.length < 2) return;
    let idx = 0;
    const show = (n) => {
      idx = (n + slides.length) % slides.length;
      slides.forEach((s, i) => s.classList.toggle('on', i === idx));
      dots.forEach((d, i) => d.classList.toggle('on', i === idx));
    };
    const start = () => { clearHero(); heroTimer = setInterval(() => show(idx + 1), 8000); };
    start();
    bb.addEventListener('mouseenter', clearHero);
    bb.addEventListener('mouseleave', start);
    dots.forEach((d, i) => d.addEventListener('click', () => { show(i); start(); }));
  }

  async function homeView() {
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
      heroItems.forEach((h, i) => { h._logo = logos[i]; itemCache[ck(h.media_type, h.id)] = h; });
      let html = buildBillboard(heroItems);
      html += '<div class="rows">';
      html += rankRailHTML('Top 10 today', trendItems);
      html += railHTML('Popular movies', popM.results, '#/movies', 'movie');
      html += railHTML('Popular shows', popT.results, '#/tv', 'tv');
      html += railHTML('Top rated', topM.results, '#/movies?sort=vote_average.desc', 'movie');
      html += railHTML('Coming soon', upcoming.results, '#/movies?sort=primary_release_date.desc', 'movie');
      html += '</div>';
      view().innerHTML = html;
      wireBillboard();
    } catch (e) { errorState(e); }
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
    const isTV = type === 'tv';
    const q = params.q || '';
    const page = Math.max(1, parseInt(params.page || '1', 10));
    const selGenres = (params.genres || '').split(',').filter(Boolean);
    const gl = await genres(isTV ? 'tv' : 'movie').catch(() => []);

    // Build toolbar
    const sortSel = SORTS.map(s => `<option value="${s.v}" ${params.sort === s.v ? 'selected' : ''}>${s.label}</option>`).join('');
    const langSel = LANGS.map(l => `<option value="${l.v}" ${params.lang === l.v ? 'selected' : ''}>${l.label}</option>`).join('');
    const yNow = new Date().getFullYear();
    let yearOpts = '<option value="">Any</option>';
    for (let y = yNow + 1; y >= 1950; y--) yearOpts += `<option value="${y}">${y}</option>`;

    const toolbar = q ? `
      <div class="toolbar"><div class="field" style="flex:1">
        <label>Search results for</label>
        <div style="font-size:20px;font-weight:800">“${esc(q)}”</div>
      </div>
      <button class="btn sm" data-nav="#/${isTV ? 'tv' : 'movies'}">Clear search</button></div>` : `
      <div class="toolbar">
        <div class="field"><label for="f-sort">Sort</label><select id="f-sort">${sortSel}</select></div>
        <div class="field"><label for="f-yfrom">From year</label><select id="f-yfrom">${yearOpts.replace(`value="${params.yfrom}"`, `value="${params.yfrom}" selected`)}</select></div>
        <div class="field"><label for="f-yto">To year</label><select id="f-yto">${yearOpts.replace(`value="${params.yto}"`, `value="${params.yto}" selected`)}</select></div>
        <div class="field"><label for="f-rating">Min rating</label><select id="f-rating">
          ${['', '5', '6', '7', '8', '9'].map(r => `<option value="${r}" ${params.rating === r ? 'selected' : ''}>${r ? r + '+' : 'Any'}</option>`).join('')}
        </select></div>
        <div class="field"><label for="f-lang">Language</label><select id="f-lang">${langSel}</select></div>
        <div class="field" style="flex:1;min-width:200px"><label>Genres</label>
          <div class="chips" id="f-genres">
            ${gl.map(g => `<button class="chip ${selGenres.includes(String(g.id)) ? 'on' : ''}" data-genre="${g.id}">${esc(g.name)}</button>`).join('')}
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
      if (gEl) gEl.onclick = e => { const c = e.target.closest('.chip'); if (c) { c.classList.toggle('on'); upd(); } };
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
      if (!results.length) { box.innerHTML = `<div class="center-note">No results found.</div>`; return; }
      box.innerHTML = `<div class="grid">${results.map(i => cardHTML(i, isTV ? 'tv' : 'movie')).join('')}</div>` + pagerHTML(page, totalPages, params, isTV ? 'tv' : 'movies');
    } catch (e) { $('#results').innerHTML = ''; errorState(e, '#results'); }
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
  async function searchView(params) {
    const q = params.q || '';
    view().innerHTML = `<h1 class="page-title">Search</h1>${q ? skeletonGrid(12) : '<div class="center-note">Type in the search box above to find movies, shows and people.</div>'}`;
    if (!q) return;
    try {
      const data = await tmdb('/search/multi', { query: q, page: 1, include_adult: 'false' });
      const results = (data.results || []).filter(x => x.media_type !== 'person' && (x.poster_path || x.backdrop_path));
      const people = (data.results || []).filter(x => x.media_type === 'person' && x.profile_path).slice(0, 8);
      let html = '';
      if (results.length) html += `<div class="grid">${results.map(i => cardHTML(i)).join('')}</div>`;
      else html += `<div class="center-note">No titles found for “${esc(q)}”.</div>`;
      view().innerHTML = `<h1 class="page-title">Results for “${esc(q)}”</h1>${html}`;
    } catch (e) { errorState(e); }
  }

  /* ---------- Detail (movie & tv) ---------- */
  async function detailView(type, id) {
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

      let html = `<div class="detail-hero">
        <div class="bg" style="background-image:url('${img(d.backdrop_path, 'w1280')}')"></div>
        <div class="scrim"></div>
        <div class="detail-body">
          <div class="poster"><img src="${img(d.poster_path, 'w500')}" alt="${esc(title)}" onerror="this.src='${PLACEHOLDER}'"></div>
          <div class="info">
            ${logoUrl
              ? `<img class="detail-logo" src="${logoUrl}" alt="${esc(title)}" onerror="this.style.display='none';var h=this.nextElementSibling;if(h)h.style.display='block'"><h1 style="display:none">${esc(title)} ${y ? `<span class="muted" style="font-weight:600">(${y})</span>` : ''}</h1>`
              : `<h1>${esc(title)} ${y ? `<span class="muted" style="font-weight:600">(${y})</span>` : ''}</h1>`}
            ${d.tagline ? `<p class="tagline">${esc(d.tagline)}</p>` : ''}
            <div class="metarow">
              <span class="pill"><span class="star">${ICON.star}</span> ${d.vote_average ? d.vote_average.toFixed(1) : '—'}</span>
              ${runtime ? `<span class="pill">${esc(runtime)}</span>` : ''}
              ${y ? `<span class="pill">${y}</span>` : ''}
              ${d.status ? `<span class="pill">${esc(d.status)}</span>` : ''}
            </div>
            <div class="genre-row">${gEls}</div>
            <div class="cta">
              <button class="btn primary" data-nav="#/watch/${type}/${d.id}">${ICON.play} Watch now</button>
              ${trailer ? `<button class="btn" data-trailer="${trailer.key}">▶ Trailer</button>` : ''}
              <button class="btn ${on ? 'primary' : ''}" data-wl="${d.id}" data-type="${type}" id="detail-wl">
                ${on ? ICON.bookmarkFill : ICON.bookmark} ${on ? 'In watchlist' : 'Watchlist'}
              </button>
            </div>
          </div>
        </div>
      </div>`;

      html += `<div class="section"><h3>Overview</h3><p class="overview">${esc(d.overview || 'No overview available.')}</p>
        ${director ? `<p class="muted" style="margin-top:12px"><b style="color:var(--text)">Director:</b> ${esc(director)}</p>` : ''}
        ${creators ? `<p class="muted"><b style="color:var(--text)">Created by:</b> ${esc(creators)}</p>` : ''}</div>`;

      // TV seasons
      if (isTV) {
        const seasons = (d.seasons || []).filter(s => s.season_number >= 1);
        html += `<div class="section" id="seasons">
          <h3>Episodes</h3>
          <div class="season-picker">
            <select id="season-sel" class="field" aria-label="Select season" style="height:40px;background:var(--bg-2);border:1px solid var(--border);color:var(--text);border-radius:10px;padding:0 12px">
              ${seasons.map(s => `<option value="${s.season_number}">Season ${s.season_number}${s.episode_count ? ' · ' + s.episode_count + ' eps' : ''}</option>`).join('')}
            </select>
          </div>
          <div class="ep-list" id="ep-list"></div>
        </div>`;
      }

      // Cast
      const cast = (credits.cast || []).slice(0, 14);
      if (cast.length) {
        html += `<div class="section"><h3>Cast</h3><div class="cast-track">
          ${cast.map(c => `<div class="person" data-nav="#/person/${c.id}">
            <img loading="lazy" src="${img(c.profile_path, 'w185')}" alt="${esc(c.name)}" onerror="this.src='${PLACEHOLDER}'">
            <div class="n">${esc(c.name)}</div><div class="c">${esc(c.character || '')}</div>
          </div>`).join('')}
        </div></div>`;
      }

      // Similar
      const sim = (similar.results || []).filter(x => x.poster_path).slice(0, 14);
      if (sim.length) html += `<div class="section">${railHTML(isTV ? 'Similar shows' : 'Similar movies', sim, null, type)}</div>`;

      view().innerHTML = html;
      window.scrollTo(0, 0);

      // Wire seasons
      if (isTV) {
        const sel = $('#season-sel');
        const loadSeason = async (n) => {
          const box = $('#ep-list'); box.innerHTML = skeletonGrid(4);
          try {
            const s = await tmdb('/tv/' + id + '/season/' + n);
            box.innerHTML = (s.episodes || []).map(ep => `
              <div class="ep" data-nav="#/watch/tv/${id}?s=${n}&e=${ep.episode_number}">
                <img class="thumb" loading="lazy" src="${img(ep.still_path, 'w300')}" onerror="this.src='${PLACEHOLDER}'">
                <div style="min-width:0">
                  <div class="en">S${n} · E${ep.episode_number}</div>
                  <div class="et">${esc(ep.name || 'Episode ' + ep.episode_number)}</div>
                  <div class="eo">${esc(ep.overview || '')}</div>
                </div>
                <button class="btn primary sm play">${ICON.play} Play</button>
              </div>`).join('') || '<div class="center-note">No episode data.</div>';
          } catch (e) { box.innerHTML = ''; errorState(e, '#ep-list'); }
        };
        sel.onchange = () => loadSeason(sel.value);
        loadSeason(sel.value || 1);
      }
    } catch (e) { errorState(e); }
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
    const season = parseInt(params.s || '1', 10);
    const episode = parseInt(params.e || '1', 10);
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

    let frameInner;
    if (!src) {
      frameInner = `<div class="player-empty"><div class="box">
        <h3>No playback source configured</h3>
        <p>Add a source in <b>Settings → Playback sources</b>, or paste a URL template below.
           Placeholders: <code>{id}</code> <code>{imdb}</code> <code>{season}</code> <code>{episode}</code></p>
        <input id="quick-src" placeholder="${isTV ? 'https://host/embed/tv/{id}/{season}/{episode}' : 'https://host/embed/movie/{id}'}">
        <button class="btn primary" id="quick-add">Save source &amp; play</button>
      </div></div>`;
    } else {
      const url = buildSourceUrl(src, type, id, imdb, season, episode);
      const sandbox = cfg.blockPlayerAds ? 'sandbox="allow-same-origin allow-scripts allow-forms allow-presentation"' : '';
      frameInner = `<iframe id="player-iframe" src="${esc(url)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture; airplay" ${sandbox} referrerpolicy="origin"></iframe>`;
    }

    const epNav = isTV ? `
      <div style="display:flex;gap:8px;align-items:center;margin-left:auto">
        <button class="btn sm" data-nav="#/watch/tv/${id}?s=${season}&e=${Math.max(1, episode - 1)}" ${episode <= 1 ? 'disabled' : ''}>‹ Prev</button>
        <span class="muted" style="font-weight:700">S${season} · E${episode}</span>
        <button class="btn sm" data-nav="#/watch/tv/${id}?s=${season}&e=${episode + 1}">Next ›</button>
      </div>` : '';

    const roomTiles = sources.map((s, i) => `
      <button class="mirror ${i === cfg.activeSource ? 'on' : ''}" data-src="${i}">
        <span class="num">${String(i + 1).padStart(2, '0')}</span>
        <span class="mn">${esc(s.name || ('Source ' + (i + 1)))}</span>
        <span class="ms">${i === cfg.activeSource ? '● Projecting' : 'Mirror ' + (i + 1)}</span>
      </button>`).join('');

    view().innerHTML = `
      <div class="player-shell">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
          <button class="icon-btn" data-nav="#/${type}/${id}" title="Back to details" aria-label="Back to details">${ICON.back}</button>
          <div style="font-weight:800;font-size:18px">${esc(title)}${isTV ? ` <span class="muted">· S${season} E${episode}</span>` : ''}</div>
          ${epNav}
        </div>
        <div class="player-frame">${frameInner}</div>
        <div class="source-bar">
          <span class="lbl">${src ? 'Now playing: <b style="color:var(--text)">' + esc(src.name) + '</b>' : 'No source selected'}</span>
          ${sources.length > 1 ? `<button class="btn sm" id="next-src">Try next server →</button>` : ''}
          <button class="btn sm ghost" id="tv-mode" title="Fill the screen — for casting / screen-mirroring to a TV">⛶ TV mode</button>
        </div>
        ${sources.length ? `
        <div class="rail-head" style="margin:26px 0 12px">
          <h2 style="font-size:16px">Server room <span class="muted" style="font-weight:600;font-size:13px">· ${sources.length} mirrors</span></h2>
        </div>
        <div class="server-room">${roomTiles}</div>
        <p class="muted" style="font-size:12px;margin-top:12px;text-transform:uppercase;letter-spacing:.5px">Switch mirrors if a server stutters or the title won't load — no single mirror has everything.</p>
        ` : ''}
      </div>`;
    window.scrollTo(0, 0);

    const room = $('.server-room');
    if (room) room.onclick = e => { const m = e.target.closest('.mirror'); if (m) { cfg.activeSource = parseInt(m.dataset.src, 10); saveConfig(); watchView(type, id, params); } };
    const next = $('#next-src');
    if (next) next.onclick = () => { cfg.activeSource = (cfg.activeSource + 1) % sources.length; saveConfig(); toast('Switched to ' + (sources[cfg.activeSource].name || 'next server')); watchView(type, id, params); };
    const tgl = $('#toggle-sandbox');
    if (tgl) tgl.onclick = () => { cfg.blockPlayerAds = !cfg.blockPlayerAds; saveConfig(); watchView(type, id, params); };
    const manage = $('#manage-src');
    if (manage) manage.onclick = openSettings;
    const qa = $('#quick-add');
    if (qa) qa.onclick = () => {
      const val = $('#quick-src').value.trim();
      if (!val) return toast('Paste a URL template first');
      cfg.sources.push({ name: 'My source', movie: isTV ? '' : val, tv: isTV ? val : '' });
      cfg.activeSource = cfg.sources.length - 1; saveConfig();
      watchView(type, id, params);
    };
    const tv = $('#tv-mode');
    if (tv) tv.onclick = toggleCinema;
    const fr = $('#player-iframe');
    if (fr) { fr.setAttribute('tabindex', '-1'); fr.addEventListener('error', () => toast('This mirror failed — try another server')); }
    if (IS_TV) tvFocusFirst();
  }

  // "TV mode": a full-viewport player, for casting / screen-mirroring to a TV.
  // CSS-based so it works on iOS/Android/desktop; also tries native fullscreen.
  let cinemaTimer, cinemaReveal;
  function revealCinema() {
    const ex = $('#cinema-exit'); if (ex) ex.classList.remove('faded');
    clearTimeout(cinemaTimer);
    cinemaTimer = setTimeout(() => { const e2 = $('#cinema-exit'); if (e2) e2.classList.add('faded'); }, 3000);
  }
  function enterCinema() {
    const frame = $('.player-frame'); if (!frame) return;
    frame.classList.add('cinema'); document.body.classList.add('cinema-on');
    if (!$('#cinema-exit')) {
      const ex = document.createElement('button');
      ex.id = 'cinema-exit'; ex.className = 'cinema-exit'; ex.innerHTML = ICON.x + ' Exit';
      ex.setAttribute('aria-label', 'Exit TV mode');
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
    const rq = frame.requestFullscreen || frame.webkitRequestFullscreen;
    if (rq) { try { rq.call(frame); } catch (e) {} }
  }
  function exitCinema() {
    clearTimeout(cinemaTimer);
    if (cinemaReveal) {
      document.removeEventListener('mousemove', cinemaReveal);
      document.removeEventListener('keydown', cinemaReveal);
      cinemaReveal = null;
    }
    const frame = $('.player-frame'); if (frame) frame.classList.remove('cinema');
    document.body.classList.remove('cinema-on');
    const ex = $('#cinema-exit'); if (ex) ex.remove();
    const hot = $('#cinema-hot'); if (hot) hot.remove();
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
  }
  function toggleCinema() { (document.body.classList.contains('cinema-on') ? exitCinema : enterCinema)(); }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('cinema-on')) exitCinema();
  });

  function buildSourceUrl(src, type, id, imdb, season, episode) {
    let tpl = (type === 'tv' ? src.tv : src.movie) || src.movie || src.tv || '';
    return tpl
      .replace(/\{id\}|\{tmdbId\}|\{externalId\}/g, id)   // source site uses tmdbId / externalId
      .replace(/\{imdb\}/g, imdb || id)
      .replace(/\{season\}/g, season || 1)
      .replace(/\{episode\}/g, episode || 1)
      .replace(/\{color\}|\{primaryColor\}/g, (cfg.accent || '#f5c518').replace('#', ''));
  }

  /* ---------- Watchlist ---------- */
  function watchlistView() {
    const list = getWatch();
    if (!list.length) { view().innerHTML = `<h1 class="page-title">Watchlist</h1><div class="center-note">Your watchlist is empty. Tap the bookmark on any title to save it here.</div>`; return; }
    view().innerHTML = `<h1 class="page-title">Watchlist <span class="muted" style="font-size:16px">(${list.length})</span></h1>
      <div class="grid">${list.map(i => cardHTML(i, i.type)).join('')}</div>`;
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

    const cp = $('#ga-copy'); if (cp) cp.onclick = () => { try { navigator.clipboard.writeText($('#ga-url').textContent); } catch (e) {} toast('Copied'); };
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
    back.innerHTML = `<div class="modal wide">
      <div class="mh"><h3>Trailer</h3><button class="icon-btn" data-close aria-label="Close">${ICON.x}</button></div>
      <div class="video-wrap"><iframe src="https://www.youtube-nocookie.com/embed/${esc(key)}?autoplay=1" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe></div>
    </div>`;
    modalMount(back);
  }

  function openSettings() {
    const themeCards = THEMES.map(t => `<button class="theme-card ${cfg.theme === t.id ? 'on' : ''}" data-theme-pick="${t.id}" aria-label="${t.name} theme">
        <span class="tprev">${t.preview.map(c => `<i style="background:${c}"></i>`).join('')}</span>
        <span class="tname">${t.name}</span>
      </button>`).join('');

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal">
      <div class="mh"><h3>${ICON.gear} &nbsp;Settings</h3><button class="icon-btn" data-close aria-label="Close">${ICON.x}</button></div>
      <div class="mb">
        <div class="set-group">
          <h4>Theme</h4>
          <p class="hint">Pick a look — applies instantly.</p>
          <div class="theme-grid" id="set-themes">${themeCards}</div>
        </div>
        <div class="set-group">
          <button class="btn sm" id="set-getapp" style="width:100%;justify-content:center">${ICON.tv} Install on TV / other devices</button>
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
    const ga = $('#set-getapp', back);
    if (ga) ga.onclick = () => { closeModal(back); go('#/get-app'); };
    $('#set-reset', back).onclick = () => { if (confirm('Reset theme + settings to defaults? Your watchlist is kept.')) { cfg = Object.assign({}, DEFAULTS); cfg.sources = DEFAULT_SOURCES.map(x => Object.assign({}, x)); saveConfig(); closeModal(back); route(); toast('Settings reset'); } };
  }

  function modalMount(back) {
    back._opener = document.activeElement;
    document.body.appendChild(back);
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) closeModal(back); });
    document.addEventListener('keydown', escClose);
    function escClose(ev) { if (ev.key === 'Escape') { closeModal(back); document.removeEventListener('keydown', escClose); } }
    // move focus into the modal (esp. for D-pad remotes)
    const f = back.querySelector('[data-theme-pick], button, [href], input, select, [tabindex="0"]');
    if (f) try { f.focus(); } catch (e) {}
  }
  function closeModal(back) {
    if (!back || !back.parentNode) return;
    const opener = back._opener;
    back.parentNode.removeChild(back);
    if (opener && opener.focus && document.contains(opener)) { try { opener.focus(); } catch (e) {} }
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
      a.classList.toggle('active', a.dataset.section === section);
    });
  }

  function syncSearchBox(params, parts) {
    const inp = $('#search-input');
    if (!inp) return;
    if (parts[0] === 'search' || (parts[0] === 'movies' && params.q) || (parts[0] === 'tv' && params.q)) inp.value = params.q || '';
  }

  function route() {
    const { parts, params } = parseHash();
    closeSuggest();
    clearHero();                 // stop billboard rotation when leaving Home
    document.body.classList.toggle('home', !parts.length);
    window.scrollTo(0, 0);
    if (IS_TV) tvFocusFirst();  // re-establish focus after every (re-)render
    const sec = parts[0] || 'home';
    setActiveNav(parts[0] === 'tv' ? 'tv' : parts[0] === 'movies' ? 'movies' : parts[0] === 'watchlist' ? 'watchlist' : parts[0] === 'search' ? '' : 'home');
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
      <a class="brand" data-nav="#/" aria-label="${esc(cfg.brand)} — home">
        <span class="brand-mark" aria-hidden="true"></span><span class="txt">${esc(cfg.brand)}</span>
      </a>
      <nav class="main">
        <a data-nav="#/" data-section="home">Home</a>
        <a data-nav="#/movies" data-section="movies">Movies</a>
        <a data-nav="#/tv" data-section="tv">TV Shows</a>
        <a data-nav="#/watchlist" data-section="watchlist">Watchlist</a>
      </nav>
      <div class="search-wrap">
        <span class="ico">${ICON.search}</span>
        <input id="search-input" type="search" placeholder="Search movies, shows, people…" autocomplete="off" aria-label="Search movies, shows and people">
        <button class="clear" id="search-clear" title="Clear" aria-label="Clear search" style="display:none">${ICON.x}</button>
        <div class="suggest" id="suggest" style="display:none"></div>
      </div>
      <button class="icon-btn" id="update-btn" title="Check for updates" aria-label="Check for updates">${ICON.download}</button>
      <button class="icon-btn" id="settings-btn" title="Settings" aria-label="Settings">${ICON.gear}</button>`;

    const inp = $('#search-input');
    const clear = $('#search-clear');
    inp.addEventListener('input', () => {
      clear.style.display = inp.value ? 'block' : 'none';
      liveSuggest(inp.value.trim());
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { closeSuggest(); if (inp.value.trim()) go('#/search?q=' + encodeURIComponent(inp.value.trim())); }
      if (e.key === 'Escape') closeSuggest();
    });
    clear.addEventListener('click', () => { inp.value = ''; clear.style.display = 'none'; closeSuggest(); inp.focus(); });
    $('#settings-btn').addEventListener('click', openSettings);
    $('#update-btn').addEventListener('click', () => checkForUpdate(true));

    // Mobile bottom tab bar (hidden on desktop via CSS)
    if (!$('.bottom-nav')) {
      const bn = document.createElement('nav');
      bn.className = 'bottom-nav';
      bn.innerHTML = `
        <a data-nav="#/" data-section="home">${ICON.home}<span>Home</span></a>
        <a data-nav="#/movies" data-section="movies">${ICON.film}<span>Movies</span></a>
        <a data-nav="#/tv" data-section="tv">${ICON.tv}<span>TV</span></a>
        <a data-nav="#/search" data-section="search">${ICON.search}<span>Search</span></a>
        <a data-nav="#/watchlist" data-section="watchlist">${ICON.bookmark}<span>Saved</span></a>`;
      document.body.appendChild(bn);
    }
    // scroll-aware header: transparent over the Home billboard, frosts on scroll
    const hdrEl = $('header.top');
    const onScroll = () => { if (hdrEl) hdrEl.classList.toggle('scrolled', window.scrollY > 30); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    applyTheme();
  }

  const liveSuggest = debounce(async (q) => {
    if (!q || q.length < 2) return closeSuggest();
    try {
      const d = await tmdb('/search/multi', { query: q, page: 1, include_adult: 'false' });
      const items = (d.results || []).filter(x => x.media_type !== 'person' && (x.poster_path || x.profile_path)).slice(0, 6);
      const box = $('#suggest');
      if (!items.length) return closeSuggest();
      box.innerHTML = items.map(it => {
        const t = it.title || it.name; const ty = it.media_type;
        return `<div class="row" data-nav="#/${ty}/${it.id}">
          <img src="${img(it.poster_path, 'w92')}" onerror="this.src='${PLACEHOLDER}'">
          <div style="min-width:0"><div class="t">${esc(t)}</div>
            <div class="s">${year(it.release_date || it.first_air_date) || ''} · ${ty === 'tv' ? 'TV' : 'Movie'}</div></div>
          <span class="badge rate" style="position:static;background:var(--surface-2)">${ICON.star} ${it.vote_average ? it.vote_average.toFixed(1) : '—'}</span>
        </div>`;
      }).join('');
      box.style.display = 'block';
    } catch (e) { closeSuggest(); }
  }, 260);
  function closeSuggest() { const b = $('#suggest'); if (b) { b.style.display = 'none'; b.innerHTML = ''; } }

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
        if (b.id === 'detail-wl') { b.classList.toggle('primary', nowOn); b.innerHTML = (nowOn ? ICON.bookmarkFill : ICON.bookmark) + ' ' + (nowOn ? 'In watchlist' : 'Watchlist'); }
        else b.innerHTML = nowOn ? ICON.bookmarkFill : ICON.bookmark;
      });
      if (location.hash.indexOf('watchlist') >= 0) route();
      return;
    }
    const tr = e.target.closest('[data-trailer]');
    if (tr) { openTrailer(tr.dataset.trailer); return; }
    const oe = e.target.closest('[data-openext]');
    if (oe) { e.preventDefault(); openExternal(oe.dataset.openext); return; }
    const ra = e.target.closest('[data-rail]');
    if (ra) { const track = ra.parentElement.querySelector('.track'); if (track) track.scrollBy({ left: (+ra.dataset.rail) * track.clientWidth * 0.85, behavior: 'smooth' }); return; }
    const nav = e.target.closest('[data-nav]');
    if (nav) { e.preventDefault(); go(nav.dataset.nav); return; }
    // click outside search closes suggestions
    if (!e.target.closest('.search-wrap')) closeSuggest();
  });

  // Keyboard / D-pad OK: activate any focused [data-nav] element (cards, cast,
  // episodes, nav links, search rows). Native buttons/inputs handle Enter themselves.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = document.activeElement;
    if (!el || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName)) return; // native handles these
    const nav = el.closest && el.closest('[data-nav]');
    if (nav) { e.preventDefault(); go(nav.dataset.nav); }
  });

  /* ============================================================
     Boot
     ============================================================ */
  window.addEventListener('hashchange', route);
  buildHeader();
  route();

  // PWA: register service worker so the app is installable ("Add to Home Screen").
  // No-ops on file:// (SW not allowed there) — serve over http/https or the desktop app.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // Silent update check on launch (web/Android). Desktop uses electron-updater.
  if (!IS_DESKTOP) setTimeout(() => checkForUpdate(false), 1500);

  // Desktop auto-update (electron-updater) notifications.
  if (window.reeldeck && window.reeldeck.onUpdate) {
    window.reeldeck.onUpdate((d) => {
      if (!d) return;
      const st = document.getElementById('set-update-status');
      if (d.state === 'available') { toast('Update found — downloading in the background…'); if (st) st.textContent = 'Downloading…'; }
      else if (d.state === 'ready') { showUpdateReady(d.version); if (st) st.textContent = 'Ready to install'; }
      else if (d.state === 'none') { toast('You’re on the latest version.'); if (st) st.textContent = 'Up to date.'; }
      else if (d.state === 'error') { if (st) st.textContent = 'Check failed — try again later.'; }
    });
  }
  function showUpdateReady(version) {
    if ($('#update-banner')) return;
    const b = document.createElement('div');
    b.id = 'update-banner'; b.className = 'update-banner';
    b.innerHTML = `<span>Update ${version ? 'v' + esc(version) + ' ' : ''}ready to install.</span>
      <button class="btn sm primary" id="update-now">Restart &amp; update</button>
      <button class="btn sm" id="update-later" aria-label="Dismiss update">Later</button>`;
    document.body.appendChild(b);
    $('#update-now').onclick = () => { if (window.reeldeck && window.reeldeck.installUpdate) window.reeldeck.installUpdate(); };
    $('#update-later').onclick = () => b.remove();
  }

  // Cross-platform update check. Desktop uses electron-updater; web/Android
  // queries the GitHub Releases API and offers a manual install (the app can't
  // silently self-install on Android).
  function verCmp(a, b) {
    const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; }
    return 0;
  }
  async function checkForUpdate(interactive) {
    if (IS_DESKTOP && window.reeldeck && window.reeldeck.checkForUpdates) {
      window.reeldeck.checkForUpdates();
      if (interactive) toast('Checking for updates…');
      return;
    }
    try {
      const r = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error('http ' + r.status);
      const d = await r.json();
      const latest = (d.tag_name || '').replace(/^v/, '');
      if (latest && verCmp(latest, APP_VERSION) > 0) {
        const ub = document.getElementById('update-btn'); if (ub) ub.classList.add('has-update');
        showUpdateAvailable(latest);
      } else if (interactive) {
        toast('You’re on the latest version (v' + APP_VERSION + ').');
      }
    } catch (e) { if (interactive) toast('Update check failed — try again later.'); }
  }
  function showUpdateAvailable(version) {
    if ($('#update-banner')) return;
    const b = document.createElement('div');
    b.id = 'update-banner'; b.className = 'update-banner';
    b.innerHTML = `<span>New version available — v${esc(version)}.</span>
      <button class="btn sm primary" id="ub-get">Get it</button>
      <button class="btn sm" id="ub-later" aria-label="Dismiss">Later</button>`;
    document.body.appendChild(b);
    $('#ub-get').onclick = () => { b.remove(); go('#/get-app'); };
    $('#ub-later').onclick = () => b.remove();
  }

  /* ---------- TV / D-pad navigation (Android TV, Google TV) ---------- */
  // TV_FOCUSABLE, tvObserver and tvTimeout are declared near the top of this file
  // (right after IS_TV) so they're initialized before the first render calls these.

  // Nav links are <a data-nav> with NO href and NO tabindex — which means they are
  // NOT focusable, so el.focus() silently no-ops and the D-pad can never land on the
  // header/bottom nav (the "can't reach Home/Movies/TV" bug). Give every [data-nav]
  // that lacks an explicit tabindex one, so the whole nav surface is reachable.
  function tvEnsureFocusable() {
    if (!IS_TV) return;
    document.querySelectorAll('[data-nav]:not([tabindex])').forEach(el => el.setAttribute('tabindex', '0'));
  }

  function tvFocusFirst() {
    if (!IS_TV) return;
    if (tvObserver) { tvObserver.disconnect(); tvObserver = null; }
    clearTimeout(tvTimeout);
    tvEnsureFocusable();
    const grab = () => {
      const el = (document.querySelector('.modal-back') || document.getElementById('view') || document).querySelector(TV_FOCUSABLE);
      if (el) { try { el.focus(); el.scrollIntoView({ block: 'center' }); } catch (e) {} return true; }
      return false;
    };
    if (grab()) return;
    const target = document.querySelector('.modal-back') || document.getElementById('view') || document.body;
    tvObserver = new MutationObserver(() => { if (grab()) { if (tvObserver) tvObserver.disconnect(); tvObserver = null; clearTimeout(tvTimeout); } });
    tvObserver.observe(target, { childList: true, subtree: true });
    tvTimeout = setTimeout(() => {
      if (tvObserver) { tvObserver.disconnect(); tvObserver = null; }
      if (!grab()) { const nav = document.querySelector('header.top nav.main a') || document.querySelector('[data-nav]'); if (nav) try { nav.focus(); } catch (e) {} }
    }, 8000);
  }
  function tvSpatialNav(e) {
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (!dir) return;
    const cur = document.activeElement;
    // let editable text fields use Left/Right for the caret until it hits the edge
    if (cur && /^(INPUT|TEXTAREA)$/.test(cur.tagName) && /^(text|search|url|email|tel|password|number|)$/i.test(cur.type || '') && (dir === 'left' || dir === 'right')) {
      const len = (cur.value || '').length;
      const atStart = cur.selectionStart === 0 && cur.selectionEnd === 0;
      const atEnd = cur.selectionStart === len && cur.selectionEnd === len;
      if ((dir === 'left' && !atStart) || (dir === 'right' && !atEnd)) return;
    }
    if (cur && cur.tagName === 'SELECT' && (dir === 'up' || dir === 'down')) return; // native option cycling
    e.preventDefault(); // TV owns focus — never let it escape into the cross-origin player iframe
    tvEnsureFocusable();
    const scope = document.querySelector('.modal-back') || document;
    const items = [].slice.call(scope.querySelectorAll(TV_FOCUSABLE))
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; });
    if (!items.length) return;
    const cr = (cur && cur.getBoundingClientRect) ? cur.getBoundingClientRect()
      : { left: window.innerWidth / 2, top: 0, width: 0, height: 0, right: window.innerWidth / 2, bottom: 0 };
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    const horiz = (dir === 'left' || dir === 'right');
    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, dx = x - cx, dy = y - cy;
      const ok = dir === 'up' ? dy < -4 : dir === 'down' ? dy > 4 : dir === 'left' ? dx < -4 : dx > 4;
      if (!ok) continue;
      // primary = distance the way we're moving; cross = misalignment on the other axis.
      const primary = horiz ? Math.abs(dx) : Math.abs(dy);
      const cross   = horiz ? Math.abs(dy) : Math.abs(dx);
      // Overlap on the cross axis = "same row" (L/R) or "same column" (U/D). A D-pad
      // press should follow that line, so aligned candidates are cheap and off-axis
      // ones are heavily penalized — otherwise a horizontally-near card in another
      // row steals a LEFT press meant for the same-row nav bar (the header trap).
      const overlap = horiz ? (r.top < cr.bottom && r.bottom > cr.top)
                            : (r.left < cr.right && r.right > cr.left);
      const score = primary + cross * (overlap ? 0.5 : 6);
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) { try { best.focus(); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e2) {} }
  }
  if (IS_TV) {
    document.body.classList.add('tv');
    document.addEventListener('keydown', tvSpatialNav);
    tvFocusFirst();
  }

  // Hardware BACK (Android) — the reliable escape hatch (fires even while focus
  // is inside the cross-origin player iframe). modal -> cinema -> history -> exit.
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    const App = window.Capacitor.Plugins.App;
    App.addListener('backButton', () => {
      const modal = document.querySelector('.modal-back');
      if (modal) { closeModal(modal); return; }
      if (document.body.classList.contains('cinema-on')) { exitCinema(); return; }
      if (location.hash.indexOf('#/watch') === 0 || window.history.length > 1) { history.back(); return; }
      App.exitApp();
    });
  }

})();
