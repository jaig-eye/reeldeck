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
    accent:   '#f5c518',
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
    document.documentElement.style.setProperty('--accent', cfg.accent);
    const b = document.querySelector('.brand .txt'); if (b) b.textContent = cfg.brand;
    document.title = cfg.brand;
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
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>'
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
      </div>
      <div class="cap"><div class="t">${esc(title)}</div><div class="y">${y || '—'}</div></div>
    </div>`;
  }

  function railHTML(title, items, moreHref, type) {
    if (!items || !items.length) return '';
    return `<section class="rail">
      <div class="rail-head"><h2>${esc(title)}</h2>${moreHref ? `<a class="more" data-nav="${moreHref}">See all →</a>` : ''}</div>
      <div class="track">${items.map(i => cardHTML(i, type)).join('')}</div>
    </section>`;
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
  async function homeView() {
    view().innerHTML = `<div class="sk" style="height:420px;border-radius:20px;margin-bottom:28px"></div>${skeletonGrid(8)}`;
    try {
      const [trend, popM, popT, topM, upcoming] = await Promise.all([
        tmdb('/trending/all/day'),
        tmdb('/movie/popular'),
        tmdb('/tv/popular'),
        tmdb('/movie/top_rated'),
        tmdb('/movie/upcoming', { region: cfg.region })
      ]);
      const heroItems = (trend.results || []).filter(x => x.backdrop_path && (x.media_type === 'movie' || x.media_type === 'tv'));
      const hero = heroItems[Math.floor(Math.random() * Math.min(5, heroItems.length))] || heroItems[0];
      let html = '';
      if (hero) {
        const type = hero.media_type;
        itemCache[ck(type, hero.id)] = hero;
        html += `<div class="hero">
          <div class="bg" style="background-image:url('${img(hero.backdrop_path, 'w1280')}')"></div>
          <div class="scrim"></div>
          <div class="inner">
            <div class="metarow" style="margin-bottom:10px"></div>
            <h1>${esc(hero.title || hero.name)}</h1>
            <div class="meta">
              <span>${ICON.star} ${hero.vote_average ? hero.vote_average.toFixed(1) : '—'}</span>
              <span>${year(hero.release_date || hero.first_air_date) || ''}</span>
              <span style="text-transform:uppercase">${type}</span>
            </div>
            <p class="ovw">${esc(hero.overview || '')}</p>
            <div class="cta">
              <button class="btn primary" data-nav="#/watch/${type}/${hero.id}">${ICON.play} Watch</button>
              <button class="btn" data-nav="#/${type}/${hero.id}">Details</button>
            </div>
          </div>
        </div>`;
      }
      html += railHTML('Trending today', (trend.results || []).filter(x => x.media_type !== 'person'), '#/movies?sort=popularity.desc');
      html += railHTML('Popular movies', popM.results, '#/movies', 'movie');
      html += railHTML('Popular shows', popT.results, '#/tv', 'tv');
      html += railHTML('Top rated movies', topM.results, '#/movies?sort=vote_average.desc', 'movie');
      html += railHTML('Coming soon', upcoming.results, '#/movies?sort=primary_release_date.desc', 'movie');
      view().innerHTML = html;
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
      const [d, credits, videos, similar, ext] = await Promise.all([
        tmdb('/' + type + '/' + id),
        tmdb('/' + type + '/' + id + '/credits'),
        tmdb('/' + type + '/' + id + '/videos'),
        tmdb('/' + type + '/' + id + '/similar'),
        tmdb('/' + type + '/' + id + '/external_ids').catch(() => ({}))
      ]);
      itemCache[ck(type, d.id)] = d;
      d._imdb = ext.imdb_id;
      const title = d.title || d.name;
      const y = year(d.release_date || d.first_air_date);
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
            <h1>${esc(title)} ${y ? `<span class="muted" style="font-weight:600">(${y})</span>` : ''}</h1>
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
          ${cfg.blockPlayerAds ? '<span class="lbl" style="color:var(--accent)">● Sandbox ON — some providers will refuse</span>' : '<span class="lbl" style="color:var(--good)">● Sandbox off (recommended)</span>'}
          <button class="btn sm ghost" id="toggle-sandbox">${cfg.blockPlayerAds ? 'Turn sandbox off' : 'Force sandbox'}</button>
          <button class="btn sm ghost" id="tv-mode" title="Fill the screen — for casting / screen-mirroring to a TV">⛶ TV mode</button>
          ${src ? `<button class="btn sm ghost" data-openext="${esc(buildSourceUrl(src, type, id, imdb, season, episode))}">${ICON.ext} Open</button>` : ''}
        </div>
        ${sources.length ? `
        <div class="rail-head" style="margin:26px 0 12px">
          <h2 style="font-size:16px">Server room <span class="muted" style="font-weight:600;font-size:13px">· ${sources.length} mirrors</span></h2>
          <a class="more" id="manage-src">Manage in Settings →</a>
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
    if (fr) fr.addEventListener('error', () => toast('This mirror failed — try another server'));
  }

  // "TV mode": a full-viewport player, for casting / screen-mirroring to a TV.
  // CSS-based so it works on iOS/Android/desktop; also tries native fullscreen.
  function enterCinema() {
    const frame = $('.player-frame'); if (!frame) return;
    frame.classList.add('cinema'); document.body.classList.add('cinema-on');
    if (!$('#cinema-exit')) {
      const ex = document.createElement('button');
      ex.id = 'cinema-exit'; ex.className = 'cinema-exit'; ex.innerHTML = ICON.x + ' Exit';
      ex.onclick = exitCinema; frame.appendChild(ex);
    }
    const rq = frame.requestFullscreen || frame.webkitRequestFullscreen;
    if (rq) { try { rq.call(frame); } catch (e) {} }
  }
  function exitCinema() {
    const frame = $('.player-frame'); if (frame) frame.classList.remove('cinema');
    document.body.classList.remove('cinema-on');
    const ex = $('#cinema-exit'); if (ex) ex.remove();
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
    const s = cfg;
    const srcRows = () => s.sources.map((src, i) => `
      <div class="set-row" style="border:1px solid var(--border);border-radius:12px;padding:12px" data-srcrow="${i}">
        <div style="display:flex;gap:8px;align-items:center">
          <input data-sf="name" data-i="${i}" value="${esc(src.name || '')}" placeholder="Source name" style="flex:1">
          <button class="btn sm" data-rmsrc="${i}">Remove</button>
        </div>
        <input data-sf="movie" data-i="${i}" value="${esc(src.movie || '')}" placeholder="Movie template — https://host/embed/movie/{id}">
        <input data-sf="tv" data-i="${i}" value="${esc(src.tv || '')}" placeholder="TV template — https://host/embed/tv/{id}/{season}/{episode}">
      </div>`).join('');

    const swatches = ['#f5c518', '#7c5cff', '#22d3ee', '#4ade80', '#ff5470', '#fb923c']
      .map(c => `<div class="swatch ${s.accent === c ? 'on' : ''}" style="background:${c}" data-accent="${c}"></div>`).join('');

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal">
      <div class="mh"><h3>${ICON.gear} &nbsp;Settings</h3><button class="icon-btn" data-close aria-label="Close">${ICON.x}</button></div>
      <div class="mb">

        <div class="set-group">
          <h4>Data source</h4>
          <p class="hint">The app reads all titles, art and search from this backend (TMDB by default). Change it and everything follows.</p>
          <div class="set-row"><label for="set-brand">App name</label><input id="set-brand" value="${esc(s.brand)}"></div>
          <div class="set-row"><label for="set-base">API base URL</label><input id="set-base" value="${esc(s.tmdbBase)}"><span class="desc">Default: https://api.themoviedb.org/3</span></div>
          <div class="set-row"><label for="set-key">API key</label><input id="set-key" value="${esc(s.apiKey)}"><span class="desc">Using a shared demo key. Get your own free one at themoviedb.org → Settings → API.</span></div>
          <div class="set-row"><label for="set-img">Image CDN base</label><input id="set-img" value="${esc(s.imgBase)}"></div>
          <div style="display:flex;gap:12px">
            <div class="set-row" style="flex:1"><label for="set-lang">Language</label><input id="set-lang" value="${esc(s.language)}"></div>
            <div class="set-row" style="flex:1"><label for="set-region">Region</label><input id="set-region" value="${esc(s.region)}"></div>
          </div>
        </div>

        <div class="set-group">
          <h4>Appearance</h4>
          <div class="set-row"><label>Accent color</label><div class="swatches" id="set-swatches">${swatches}</div></div>
        </div>

        <div class="set-group">
          <h4>Playback sources</h4>
          <div class="warn-box">
            <b>How playback works.</b> This app hosts no video. Like the original site, it just embeds a third-party
            player URL in an iframe. Those providers carry their own ads and their own legal risk — that part is on the
            source you choose, not on this app. You control exactly what URL loads here.
          </div>
          <p class="hint">Add one or more source templates. Placeholders: <code>{id}</code> (TMDB id), <code>{imdb}</code>, <code>{season}</code>, <code>{episode}</code>, <code>{color}</code>.</p>
          <div id="set-sources" style="display:flex;flex-direction:column;gap:12px">${srcRows() || '<p class="muted" style="font-size:13px">No sources yet.</p>'}</div>
          <button class="btn sm" id="add-source" style="margin-top:12px">+ Add source</button>
          <div class="set-row" style="margin-top:16px;flex-direction:row;align-items:center;gap:10px">
            <input type="checkbox" id="set-sandbox" ${s.blockPlayerAds ? 'checked' : ''} style="width:auto">
            <label for="set-sandbox" style="margin:0">Force iframe sandbox on the player</label>
          </div>
          <p class="hint" style="margin-top:6px">Leave this <b>off</b>. The sandbox blocks pop-up ads, but most providers detect it and
             show <b>“Iframe Sandbox Detected”</b> instead of playing. In the <b>desktop app</b>, ads are blocked at the network
             layer instead (a real ad-blocker filter list), so video plays and the pop-unders are still gone. In a plain browser,
             use an extension like uBlock Origin for the same effect.</p>
        </div>

        <div class="set-actions">
          <button class="btn" data-close>Cancel</button>
          <button class="btn" id="set-reset">Reset defaults</button>
          <button class="btn primary" id="set-save">Save</button>
        </div>
      </div>
    </div>`;
    modalMount(back);

    // add source
    $('#add-source', back).onclick = () => {
      s.sources.push({ name: 'Source ' + (s.sources.length + 1), movie: '', tv: '' });
      const c = $('#set-sources', back);
      if (c.querySelector('.muted')) c.innerHTML = '';
      c.insertAdjacentHTML('beforeend', `
        <div class="set-row" style="border:1px solid var(--border);border-radius:12px;padding:12px" data-srcrow="${s.sources.length - 1}">
          <div style="display:flex;gap:8px;align-items:center">
            <input data-sf="name" data-i="${s.sources.length - 1}" value="${esc(s.sources[s.sources.length - 1].name)}" style="flex:1">
            <button class="btn sm" data-rmsrc="${s.sources.length - 1}">Remove</button>
          </div>
          <input data-sf="movie" data-i="${s.sources.length - 1}" placeholder="Movie template — https://host/embed/movie/{id}">
          <input data-sf="tv" data-i="${s.sources.length - 1}" placeholder="TV template — https://host/embed/tv/{id}/{season}/{episode}">
        </div>`);
    };
    $('#set-sources', back).onclick = (e) => {
      const rm = e.target.closest('[data-rmsrc]');
      if (rm) { s.sources.splice(parseInt(rm.dataset.rmsrc, 10), 1); openSettings.refresh(back); }
    };
    // swatches
    $('#set-swatches', back).onclick = (e) => {
      const sw = e.target.closest('.swatch'); if (!sw) return;
      back.querySelectorAll('.swatch').forEach(x => x.classList.remove('on'));
      sw.classList.add('on'); s._pendingAccent = sw.dataset.accent;
    };
    $('#set-reset', back).onclick = () => { if (confirm('Reset all settings to defaults? Your watchlist is kept.')) { cfg = Object.assign({}, DEFAULTS, { sources: [] }); saveConfig(); closeModal(back); route(); toast('Settings reset'); } };
    $('#set-save', back).onclick = () => {
      // collect source fields
      back.querySelectorAll('[data-sf]').forEach(inp => {
        const i = parseInt(inp.dataset.i, 10); if (!s.sources[i]) return;
        s.sources[i][inp.dataset.sf] = inp.value.trim();
      });
      cfg.brand = $('#set-brand', back).value.trim() || 'Reeldeck';
      cfg.tmdbBase = $('#set-base', back).value.trim() || DEFAULTS.tmdbBase;
      cfg.apiKey = $('#set-key', back).value.trim() || DEFAULTS.apiKey;
      cfg.imgBase = $('#set-img', back).value.trim() || DEFAULTS.imgBase;
      cfg.language = $('#set-lang', back).value.trim() || 'en-US';
      cfg.region = $('#set-region', back).value.trim() || 'US';
      cfg.blockPlayerAds = $('#set-sandbox', back).checked;
      if (s._pendingAccent) cfg.accent = s._pendingAccent;
      if (cfg.activeSource >= cfg.sources.length) cfg.activeSource = 0;
      saveConfig();
      closeModal(back); toast('Settings saved'); route();
    };
  }
  // re-render settings body (used after removing a source)
  openSettings.refresh = (back) => { closeModal(back); openSettings(); };

  function modalMount(back) {
    document.body.appendChild(back);
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) closeModal(back); });
    document.addEventListener('keydown', escClose);
    function escClose(ev) { if (ev.key === 'Escape') { closeModal(back); document.removeEventListener('keydown', escClose); } }
  }
  function closeModal(back) { if (back && back.parentNode) back.parentNode.removeChild(back); }

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
      default: return homeView();
    }
  }

  /* ============================================================
     Header + global events
     ============================================================ */
  function buildHeader() {
    const hdr = $('header.top');
    hdr.innerHTML = `
      <a class="brand" data-nav="#/">${ICON.film}<span class="txt">${esc(cfg.brand)}</span><span class="dot">.</span></a>
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
    const nav = e.target.closest('[data-nav]');
    if (nav) { e.preventDefault(); go(nav.dataset.nav); return; }
    // click outside search closes suggestions
    if (!e.target.closest('.search-wrap')) closeSuggest();
  });

  // Keyboard: activate focused cards (role="button") with Enter / Space
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = document.activeElement;
    const nav = el && el.matches && el.matches('.card[data-nav]') ? el : null;
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

})();
