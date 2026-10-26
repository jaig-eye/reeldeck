/* Reeldeck smoke test: a real browser, real pixels, a real frame clock.
 *
 * Three profiles -- desktop, phone, TV -- walk the same route the way a person would:
 * home, a film, a series, search, the player page, Settings. Each step asserts the thing
 * that has actually broken before (rails render, the cast row scrolls, the D-pad crosses
 * rows, nothing throws) and saves a screenshot to OUT for a human to look at.
 *
 * Third-party hosts are BLOCKED. The player page embeds ad-laden mirrors; a test has no
 * business loading them, and the page under test is ours either way.
 */
const { chromium } = require('playwright');
const net = require('net');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://web:80';
const OUT = process.env.OUT || '/out';
const SHOTS = process.env.SHOTS !== '0';
const ONLY = (process.env.ONLY || '').trim();
const ORIGIN = 'http://localhost:8080';

const ALLOW = [/^localhost(:\d+)?$/, /(^|\.)themoviedb\.org$/, /(^|\.)tmdb\.org$/,
               /^fonts\.(googleapis|gstatic)\.com$/, /\.workers\.dev$/];

const PROFILES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, query: '' },
  phone:   { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, query: '' },
  // A 1080p set reports 960x540 CSS px at dpr 2 -- the size the TV layout is built for.
  tv:      { viewport: { width: 960, height: 540 }, deviceScaleFactor: 2, query: '?tv=1' }
};

/** The page must live on http://localhost: a secure context (service worker, clipboard)
 *  and the one origin the sync Worker answers without being a deployed site. */
function proxy(target) {
  const u = new URL(target);
  return new Promise((resolve) => {
    const srv = net.createServer((c) => {
      const up = net.connect(+u.port || 80, u.hostname);
      c.pipe(up).pipe(c);
      c.on('error', () => up.destroy()); up.on('error', () => c.destroy());
    });
    srv.listen(8080, '127.0.0.1', () => resolve(srv));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runProfile(browser, name, report) {
  const p = PROFILES[name];
  const ctx = await browser.newContext({
    viewport: p.viewport, deviceScaleFactor: p.deviceScaleFactor,
    isMobile: !!p.isMobile, hasTouch: !!p.hasTouch, colorScheme: 'dark'
  });
  await ctx.route('**/*', (route) => {
    let host = '';
    try { host = new URL(route.request().url()).host; } catch (e) {}
    if (route.request().url().startsWith('data:') || ALLOW.some((re) => re.test(host))) return route.continue();
    return route.abort();
  });
  // Someone who has watched things: one series mid-episode with a real position, one film
  // part-way, one title whose backdrop the art cache has never seen (so the back-fill runs).
  await ctx.addInitScript(() => {
    try {
      if (localStorage.getItem('reeldeck.history.v1')) return;
      const t = Date.now();
      localStorage.setItem('reeldeck.history.v1', JSON.stringify([
        { k: 'tv:1399:1:2', id: 1399, type: 'tv', title: 'Game of Thrones', poster_path: '/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg', s: 1, e: 2, pct: 0.35, at: t - 3600e3 },
        { k: 'movie:438631', id: 438631, type: 'movie', title: 'Dune', poster_path: '/d5NXSklXo0qyIYkgV94XAgMIckC.jpg', s: null, e: null, pct: 0.42, at: t - 86400e3 },
        { k: 'movie:550', id: 550, type: 'movie', title: 'Fight Club', poster_path: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg', s: null, e: null, pct: 0.1, at: t - 2 * 86400e3 }
      ]));
      localStorage.setItem('reeldeck.watchlist.v1', JSON.stringify([
        [1399, 'tv', 'Game of Thrones', 8.5, '2011-04-17'], [438631, 'movie', 'Dune', 7.8, '2021-09-15'], [550, 'movie', 'Fight Club', 8.4, '1999-10-15'],
        [1396, 'tv', 'Breaking Bad', 8.9, '2008-01-20'], [27205, 'movie', 'Inception', 8.4, '2010-07-15'], [603, 'movie', 'The Matrix', 8.2, '1999-03-31'],
        [66732, 'tv', 'Stranger Things', 8.6, '2016-07-15'], [157336, 'movie', 'Interstellar', 8.4, '2014-11-05'], [680, 'movie', 'Pulp Fiction', 8.5, '1994-09-10']
      ].map((w, i) => ({ id: w[0], type: w[1], title: w[2], poster_path: '', vote_average: w[3], date: w[4], at: t - i * 1000 }))));
      localStorage.setItem('reeldeck.progress.v1', JSON.stringify({
        'tv:1399:1:2': { t: 1190, d: 3400, pct: 0.35, at: t - 3600e3, src: 'provider' },
        'tv:1399': { s: 1, e: 2, at: t - 3600e3 },
        'movie:438631': { t: 3906, d: 9300, pct: 0.42, at: t - 86400e3, src: 'provider' },
        'movie:550': { t: 834, d: 8340, pct: 0.1, at: t - 2 * 86400e3, src: 'elapsed' }
      }));
    } catch (e) {}
  });
  const page = await ctx.newPage();
  const r = report[name] = { checks: [], errors: [], apiFailures: [] };
  page.on('pageerror', (e) => r.errors.push(String(e.message || e)));
  page.on('response', (res) => {
    if (res.status() >= 400 && /themoviedb\.org/.test(res.url())) {
      r.apiFailures.push(res.status() + ' ' + res.url().replace(/api_key=[^&]*/, 'api_key=X').slice(0, 140));
    }
  });

  const check = (label, ok, detail) => {
    r.checks.push({ label, ok: !!ok, detail: detail === undefined ? '' : detail });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} [${name}] ${label}${detail !== undefined && detail !== '' ? ' -- ' + JSON.stringify(detail) : ''}`);
  };
  let shotN = 0;
  const shot = async (label, opts) => {
    if (!SHOTS) return;
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await sleep(350);
    shotN++;
    const file = path.join(OUT, `${name}-${String(shotN).padStart(2, '0')}-${label}.png`);
    await page.screenshot(Object.assign({ path: file }, opts || {}));
  };
  const go = async (hash, waitFor) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    if (waitFor) await page.waitForSelector(waitFor, { timeout: 25000 });
  };
  const noError = async () => !(await page.evaluate(() => /Couldn't load data/.test(document.getElementById('view').textContent)));
  // The classic phone bug: one wide child and the whole page pans sideways.
  const fits = async (where) => {
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    check(where + ' does not scroll sideways', o.sw <= o.iw + 1, o.sw > o.iw + 1 ? o : undefined);
  };

  // ---- home
  await page.goto(`${ORIGIN}/${p.query}#/`, { waitUntil: 'domcontentloaded' });
  const guest = page.locator('#sp-guest');
  if (await guest.isVisible({ timeout: 4000 }).catch(() => false)) {
    await shot('splash');
    await guest.click();
  }
  await page.waitForSelector('.rail .card', { timeout: 30000 });
  const rails = await page.$$eval('.rail h2', (hs) => hs.map((h) => h.textContent.trim()));
  check('home renders its rails', rails.length >= 4, rails);
  if (name === 'tv') {
    // TV Home is the Stage: no billboard; the focused title fills the stage, its row heading
    // sits at half height, and the header is the side rail down the left edge.
    await sleep(1500);
    const st = await page.evaluate(() => {
      const a = document.activeElement, rail = a && a.closest && a.closest('#view > .rows > .rail');
      const hdr = document.querySelector('header.top').getBoundingClientRect();
      return { stage: !!document.getElementById('stage'), billboard: !!document.getElementById('billboard'),
               title: (document.querySelector('.st-title') || {}).textContent || (document.querySelector('.st-title img') || {}).alt || '',
               laneOff: rail ? Math.abs(rail.getBoundingClientRect().top - innerHeight / 2) : 999,
               railTall: hdr.height > innerHeight * 0.9 && hdr.width < 120 };
    });
    check('TV: home is the Stage (no billboard, a titled stage)', st.stage && !st.billboard && !!st.title.trim(), st);
    check('TV: the focused row sits at half height', st.laneOff <= 3, st);
    check('TV: the header is a narrow side rail', st.railTall, st);
    // Every rail item shows the selection, not only the current section's: Movies and TV Shows
    // once showed none (an item rule outranked .tv-focus), Search and Watchlist none on Home.
    await page.keyboard.press('ArrowLeft'); await sleep(400);
    for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowUp'); await sleep(120); }
    const unlit = [];
    for (let i = 0; i < 6; i++) {
      const it = await page.evaluate(() => { const a = document.activeElement, cs = getComputedStyle(a);
        return { name: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 16), inRail: !!a.closest('header.top'),
                 lit: cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.boxShadow !== 'none' }; });
      if (it.inRail && !it.lit) unlit.push(it.name);
      await page.keyboard.press('ArrowDown'); await sleep(220);
    }
    check('TV: every rail item shows the selection', unlit.length === 0, unlit);
    await page.keyboard.press('Escape'); await sleep(400);
  } else {
    check('home has a billboard', await page.locator('#billboard').count() > 0);
  }
  check('home is not an error page', await noError());
  check('the drawer is gone', await page.locator('#nav-open').count() === 0);
  const cw = await page.evaluate(() => {
    const cards = [].slice.call(document.querySelectorAll('.cw-card .poster'));
    const b = cards[0] && cards[0].getBoundingClientRect();
    return { n: cards.length, ratio: b ? +(b.width / b.height).toFixed(2) : 0,
             label: ((document.querySelector('.cw-card .cw-s') || {}).textContent || '') };
  });
  check('continue watching is landscape, with time left', cw.n >= 3 && cw.ratio > 1.6 && /left/.test(cw.label), cw);
  check('genre rail renders', await page.locator('.genre-rail .genre-tile').count() >= 10);
  check('presets lead the genre rail', await page.locator('.genre-rail .track > .preset-tile').count() >= 4);
  check('home has a fresh-releases rail', rails.some((t) => /New to watch at home|Coming soon/.test(t)), rails);
  await sleep(2600);   // the poster is sampled, then the room cross-fades to it
  const amb = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ambient').trim());
  check('house lights are on', /^rgb\(/.test(amb) && !/rgba\(0, 0, 0, 0\)/.test(amb), amb);
  check('backdrops were back-filled', await page.locator('.cw-card[data-art-need]').count() === 0);
  if (name === 'phone') {
    const hero = await page.evaluate(() => {
      const p = document.querySelector('.bb-slide.on .bb-poster'), b = document.querySelector('.billboard').getBoundingClientRect();
      return { posterShown: !!p && getComputedStyle(p).display !== 'none' && p.naturalWidth > 0, portrait: b.height > b.width };
    });
    check('phone hero is the poster', hero.posterShown && hero.portrait, hero);
    check('phone header is a logo and a face', await page.locator('header.top #search-btn').isHidden());
    // No bookmark disc on posters; a long-press opens the sheet instead.
    const lp = await page.evaluate(async () => {
      const card = document.querySelector('.rail:not(.cw-rail):not(.rank-rail) .card:not(.more-card)');
      card.scrollIntoView({ block: 'center', behavior: 'instant' });
      const wl = card.querySelector('.wl'); const disc = getComputedStyle(wl).display;
      const r = card.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      const t = new Touch({ identifier: 1, target: card, clientX: x, clientY: y });
      card.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t] }));
      await new Promise((res) => setTimeout(res, 750));
      const open = !!document.querySelector('.qa-list');
      card.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t] }));
      const items = [].map.call(document.querySelectorAll('.qa-item'), (b) => b.textContent.trim());
      return { disc, open, items, hash: location.hash };
    });
    check('phone: no bookmark disc on a poster', lp.disc === 'none', lp.disc);
    check('phone: a long-press opens quick actions', lp.open && lp.hash === '#/' && lp.items.some((t) => /watchlist/i.test(t)), lp);
    await sleep(250);    // a practised thumb: lift, then tap. The first tap used to be eaten.
    await page.locator('.qa-item', { hasText: /watchlist/i }).tap();
    await sleep(400);
    const marker = await page.evaluate(() => { const w = document.querySelector('.rail:not(.cw-rail):not(.rank-rail) .card:not(.more-card) .wl'); const c = getComputedStyle(w); return { on: w.classList.contains('on'), display: c.display, w: Math.round(parseFloat(c.width)), pe: c.pointerEvents }; });
    check('phone: a saved title wears a small marker, not a button', marker.on && marker.display !== 'none' && marker.w <= 26 && marker.pe === 'none', marker);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  }
  await fits('home');
  await shot('home');
  if (name === 'desktop') {
    // The audit's worst find: a real mouse could not click the bookmark on a card.
    const card = page.locator('.rail:not(.cw-rail):not(.rank-rail) .card:not(.more-card)').nth(1);
    await card.scrollIntoViewIfNeeded(); await card.hover(); await sleep(300);
    const b = await card.locator('.wl').boundingBox();
    const before = await page.evaluate(() => (JSON.parse(localStorage.getItem('reeldeck.watchlist.v1') || '[]')).length);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await sleep(400);
    const after = await page.evaluate(() => ({ n: (JSON.parse(localStorage.getItem('reeldeck.watchlist.v1') || '[]')).length, hash: location.hash }));
    check('a mouse can click the bookmark on a card', Math.abs(after.n - before) === 1 && after.hash === '#/', { before, after });
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await sleep(300);   // put it back

    // Pointer staging: resting on a card puts that title in the hero; once the hero has scrolled
    // off, the top bar's "On stage" chip names it and opens it.
    const sc = page.locator('.rail:not(.cw-rail):not(.rank-rail) .card:not(.more-card)').nth(3);
    await sc.scrollIntoViewIfNeeded(); await sc.hover(); await sleep(1600);
    const ps = await page.evaluate(() => {
      const c = document.querySelectorAll('.rail:not(.cw-rail):not(.rank-rail) .card:not(.more-card)')[3];
      const m = /#\/(movie|tv)\/(\d+)/.exec(c.getAttribute('data-nav') || ''), on = document.querySelector('#billboard .bb-slide.on');
      return { want: m ? m[1] + ':' + m[2] : '', on: on && on.dataset.key, slides: document.querySelectorAll('#billboard .bb-slide').length };
    });
    check('desktop: resting on a card puts it in the hero', !!ps.want && ps.on === ps.want, ps);
    await page.mouse.move(720, 30);                    // off the rows, so the scroll stages nothing new
    await page.evaluate(() => window.scrollTo({ top: 1100, behavior: 'instant' })); await sleep(400);
    const chip = await page.evaluate(() => { const c = document.getElementById('on-stage'); return { shown: !!c && getComputedStyle(c).display !== 'none', nav: c && c.getAttribute('data-nav') }; });
    check('desktop: the On stage chip names it once the hero is off screen', chip.shown && chip.nav === '#/' + ps.want.replace(':', '/'), { chip, ps });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await sleep(300);

    // Place memory: scroll the page and one rail, open a title, go Back.
    const want = await page.evaluate(() => {
      const t = document.querySelectorAll('.rail .track')[3]; t.scrollLeft = 520;
      window.scrollTo({ top: 1100, behavior: 'instant' });
      return { y: Math.round(window.scrollY), left: Math.round(t.scrollLeft) };
    });
    await sleep(300);
    await page.evaluate(() => { document.querySelectorAll('.rail .track')[3].querySelectorAll('.card')[4].click(); });
    await page.waitForSelector('.dv-stage', { timeout: 25000 });
    await page.goBack(); await page.waitForSelector('.rail .card', { timeout: 25000 }); await sleep(900);
    const got = await page.evaluate(() => ({ y: Math.round(window.scrollY), left: Math.round(document.querySelectorAll('.rail .track')[3].scrollLeft) }));
    check('Back restores the page scroll and the rail scroll', Math.abs(got.y - want.y) < 40 && Math.abs(got.left - want.left) < 40, { want, got });
    // ...but a CLICK that happens to lead to the page you came from is not Back: it starts at the top.
    await page.evaluate(() => window.scrollTo({ top: 1100, behavior: 'instant' })); await sleep(200);
    await page.evaluate(() => { document.querySelectorAll('.rail .track')[3].querySelectorAll('.card')[2].click(); });
    await page.waitForSelector('.dv-stage', { timeout: 25000 });
    await page.locator('header.top .brand').click();
    await page.waitForSelector('.rail .card', { timeout: 25000 }); await sleep(900);
    const viaLogo = await page.evaluate(() => Math.round(window.scrollY));
    check('the logo takes you to the TOP of Home, not to where you were', viaLogo < 40, viaLogo);
    // Film A -> film B (A's collection rail) -> "A" on B's own rail -> Back. The click to A used
    // to be booked as a Back, so B was never saved and opened at the top.
    const A = '#/movie/438631', B = '#/movie/693134';
    await page.evaluate((h) => { location.hash = h; }, A);
    await page.waitForSelector('.rail [data-nav="' + B + '"]', { timeout: 25000 });
    await page.evaluate((h) => document.querySelector('.rail [data-nav="' + h + '"]').click(), B);
    await page.waitForFunction((h) => location.hash === h && !!document.querySelector('.rail [data-nav="#/movie/438631"]'), B, { timeout: 25000 });
    await sleep(700);
    await page.evaluate(() => window.scrollTo({ top: 700, behavior: 'instant' })); await sleep(250);
    const leftAt = await page.evaluate(() => Math.round(window.scrollY));
    await page.evaluate(() => document.querySelector('.rail [data-nav="#/movie/438631"]').click());
    await page.waitForFunction((h) => location.hash === h && !!document.querySelector('.dv-stage'), A, { timeout: 25000 });
    await sleep(500);
    await page.goBack();
    await page.waitForFunction((h) => location.hash === h && !!document.querySelector('.cast-track, .rail .card'), B, { timeout: 25000 });
    await sleep(1500);
    const cameBack = await page.evaluate(() => Math.round(window.scrollY));
    check('Back after clicking the title you came from returns to your place', leftAt > 400 && Math.abs(cameBack - leftAt) < 40, { leftAt, cameBack });
    await go('#/', '.rail .card'); await sleep(400);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  }
  if (name !== 'tv') await shot('home-full', { fullPage: true });

  // ---- TV: the D-pad, with a frame clock running
  if (name === 'tv') {
    const moves = [];
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowUp']) {
      await page.evaluate(() => {
        window.__gaps = []; let last = performance.now();
        const end = last + 420;
        (function f(t) { window.__gaps.push(t - last); last = t; if (t < end) requestAnimationFrame(f); })(last);
      });
      await page.keyboard.press(key);
      await sleep(480);
      moves.push(await page.evaluate((k) => {
        const a = document.activeElement, g = (window.__gaps || []).slice(1);
        return { key: k, row: ((a.closest('.rail') || {}).querySelector ? ((a.closest('.rail').querySelector('h2') || {}).textContent || '') : a.tagName).slice(0, 28),
                 frames: g.length, maxGap: g.length ? +Math.max.apply(null, g).toFixed(1) : null,
                 over33: g.filter((x) => x > 33).length, focused: a.className.split(' ').slice(0, 2).join('.') };
      }, key));
    }
    const rowsSeen = new Set(moves.map((m) => m.row)).size;
    check('D-pad crosses rows', rowsSeen >= 3, moves.map((m) => m.key.replace('Arrow', '') + '>' + m.row));
    check('the frame clock runs during a move', moves.every((m) => m.frames > 5), moves.map((m) => m.frames));
    r.frames = moves.map((m) => ({ key: m.key, frames: m.frames, maxGap: m.maxGap, over33: m.over33 }));
    check('a card holds the ring', /card|person|btn/.test(moves[moves.length - 1].focused), moves[moves.length - 1].focused);
    await shot('home-focused');
    // Hold OK: the sheet opens, nothing navigates, and the held key does not press Play.
    const navBefore = await page.evaluate(() => document.activeElement.dataset.nav || '');
    await page.keyboard.down('Enter'); await sleep(800);
    const sheet = await page.evaluate(() => ({ open: !!document.querySelector('.qa-list'), hash: location.hash, items: [].map.call(document.querySelectorAll('.qa-item'), (b) => b.textContent.trim()) }));
    await page.keyboard.up('Enter'); await sleep(300);
    check('TV: holding OK opens quick actions without navigating', sheet.open && sheet.hash === '#/' && sheet.items.length >= 2, sheet);
    await shot('quick-actions');
    await page.keyboard.press('Escape'); await sleep(400);
    const afterClose = await page.evaluate(() => ({ open: !!document.querySelector('.qa-list'), nav: document.activeElement.dataset.nav || '' }));
    check('TV: closing the sheet returns the ring to the card', !afterClose.open && afterClose.nav === navBefore, afterClose);
    // "Mark watched" on a poster that has never been started: there is no bar to fill, so one is made.
    // On a FILM: a series poster has no single thing to mark, so the sheet does not offer it.
    const film = await page.evaluate(() => {
      window.__ring = document.activeElement;
      const pick = (root) => [].find.call(root.querySelectorAll('.card[data-nav^="#/movie/"]:not(.more-card)'), (c) => !c.querySelector('.card-prog') && !c.closest('.cw-rail'));
      const rail = window.__ring.closest('.rail'), c = (rail && pick(rail)) || pick(document);
      if (c) c.focus();
      return c ? c.dataset.nav : '';
    });
    await sleep(500);
    const hadBar = await page.evaluate(() => !!document.activeElement.querySelector('.card-prog'));
    await page.keyboard.down('Enter'); await sleep(800); await page.keyboard.up('Enter'); await sleep(300);
    const markIdx = await page.evaluate(() => [].findIndex.call(document.querySelectorAll('.qa-item'), (b) => /mark watched/i.test(b.textContent)));
    if (markIdx >= 0) {
      await page.evaluate((i) => document.querySelectorAll('.qa-item')[i].click(), markIdx); await sleep(500);
      const bar = await page.evaluate(() => { const c = document.activeElement, i = c && c.querySelector('.card-prog i'); return { nav: (c && c.dataset.nav) || '', w: i ? i.style.width : null }; });
      check('TV: Mark watched paints the bar on an unstarted poster', !!film && !hadBar && bar.w === '100%' && bar.nav === film, { film, hadBar, bar });
      // ...and put it back, so the rest of the walk sees the library it was given.
      await page.keyboard.down('Enter'); await sleep(800); await page.keyboard.up('Enter'); await sleep(300);
      await page.evaluate(() => { const b = [].find.call(document.querySelectorAll('.qa-item'), (x) => /mark unwatched/i.test(x.textContent)); if (b) b.click(); }); await sleep(500);
      check('TV: Mark unwatched takes the bar away again', await page.evaluate(() => !document.activeElement.querySelector('.card-prog')));
    } else {
      check('TV: Mark watched paints the bar on an unstarted poster', false, { film, why: 'no "Mark watched" item in the sheet' });
      await page.keyboard.press('Escape'); await sleep(300);
    }
    await page.evaluate(() => { if (window.__ring && document.contains(window.__ring)) window.__ring.focus(); }); await sleep(500);
    // The same hold as an Android WebView seems to deliver it: no `repeat` flag on any event.
    const unflagged = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const fire = (type) => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent(type, { key: 'Enter', bubbles: true, cancelable: true }));
      fire('keydown'); await wait(400);
      for (let i = 0; i < 10; i++) { fire('keydown'); await wait(50); }
      const mid = { open: !!document.querySelector('.qa-list'), hash: location.hash };
      fire('keyup'); await wait(150);
      return mid;
    });
    check('TV: a hold made of unflagged repeats still opens the sheet and goes nowhere', unflagged.open && unflagged.hash === '#/', unflagged);
    await page.keyboard.press('Escape'); await sleep(400);
    // A quick press still opens the title (so the fallback was not tripped); Back restores the ring.
    await page.keyboard.press('Enter');
    await page.waitForSelector('.dv-stage', { timeout: 25000 });
    await page.goBack(); await page.waitForSelector('.rail .card', { timeout: 25000 }); await sleep(1500);
    const back = await page.evaluate(() => ({ nav: document.activeElement.dataset.nav || '', y: Math.round(window.scrollY) }));
    check('TV: Back puts the ring on the poster you left', back.nav === navBefore && back.y > 100, { want: navBefore, got: back });
  }

  // ---- a film
  await go('#/movie/438631', '.dv-stage');
  await page.waitForSelector('.cast-track .person', { timeout: 20000 }).catch(() => {});
  check('film page is not an error page', await noError());
  const cast = await page.evaluate(() => {
    const t = document.querySelector('.cast-track'), m = document.querySelector('.dv-main'), f = document.querySelector('.dv-facts');
    if (!t) return null;
    return { scrollable: t.scrollWidth > t.clientWidth + 4,
             clearOfFacts: !f || getComputedStyle(f).position === 'static' && (m.getBoundingClientRect().right <= f.getBoundingClientRect().left + 2 || f.getBoundingClientRect().top >= m.getBoundingClientRect().bottom - 2) };
  });
  check('cast row is a scroller', cast && cast.scrollable, cast);
  const dv = await page.evaluate(() => ({ cert: (document.querySelector('.pill.cert') || {}).textContent || '', kws: document.querySelectorAll('.kw-row .chip').length,
    who: document.querySelectorAll('.dv-facts a.who').length, logo: !!document.querySelector('.detail-logo') }));
  check('film page: one request still yields logo, age rating, keywords, a linked director', !!dv.cert && dv.kws >= 3 && dv.who >= 1 && dv.logo, dv);
  check('cast row stays out of the facts column', cast && cast.clearOfFacts);
  await fits('film page');
  await shot('film');
  if (name !== 'tv') await shot('film-full', { fullPage: true });

  // ---- a series
  await go('#/tv/1399', '#ep-list .ep');
  check('series page lists episodes', await page.locator('#ep-list .ep').count() > 0);
  check('season mark is offered', await page.locator('#season-mark').isVisible().catch(() => false));
  await sleep(900);
  const openedAt = await page.evaluate(() => Math.round(window.scrollY));
  check('a show page opens at the top and stays there', openedAt < 40, openedAt);
  if (name === 'desktop') {
    // Desktop title pages are tabbed; a phone keeps every block stacked.
    const vis = () => page.evaluate(() => ({ tabs: [].map.call(document.querySelectorAll('.dv-tab'), (b) => b.textContent).join('|'),
      eps: getComputedStyle(document.getElementById('seasons')).display !== 'none',
      info: getComputedStyle(document.querySelector('.dv-body')).display !== 'none' }));
    const t0 = await vis();
    check('desktop: a series page is tabbed, Episodes first', t0.tabs === 'Episodes|More like this|Details' && t0.eps && !t0.info, t0);
    await page.locator('.dv-tab[data-tab="info"]').click(); await sleep(200);
    const t1 = await vis();
    check('desktop: the Details tab holds the overview and cast', t1.info && !t1.eps, t1);
    await page.locator('.dv-tab[data-tab="eps"]').click(); await sleep(200);
  }
  if (name === 'phone') {
    const st = await page.evaluate(() => ({ tabs: getComputedStyle(document.querySelector('.dv-tabs')).display,
      shown: [].filter.call(document.querySelectorAll('.dv-panel'), (p) => getComputedStyle(p).display === 'none').length }));
    check('phone: a title page stays stacked, no tabs', st.tabs === 'none' && st.shown === 0, st);
    // Scrolled past the hero, Play waits above the tab bar.
    await page.evaluate(() => window.scrollTo({ top: 1200, behavior: 'instant' })); await sleep(600);
    const dk = await page.evaluate(() => { const d = document.querySelector('.dv-dock'), n = document.querySelector('.bottom-nav');
      const r = d && d.getBoundingClientRect(); return { shown: !!d && !d.hidden && getComputedStyle(d).display !== 'none',
        bottom: r ? Math.round(r.bottom) : 0, navTop: Math.round(n.getBoundingClientRect().top), play: !!(d && d.querySelector('[data-play]')) }; });
    check('phone: Play waits above the tab bar once the hero has scrolled away', dk.shown && dk.play && dk.bottom <= dk.navTop, dk);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await sleep(300);
  }
  if (name !== 'tv') {
    await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' })); await sleep(250);
    const listAt = await page.evaluate(() => Math.round(window.scrollY));
    await page.evaluate(() => document.querySelectorAll('#ep-list .ep')[2].click());
    await page.waitForSelector('.player-frame', { timeout: 25000 }); await sleep(500);
    await page.locator('[data-back]').click();
    await page.waitForSelector('#ep-list .ep', { timeout: 25000 }); await sleep(1500);
    const backAt = await page.evaluate(() => Math.round(window.scrollY));
    check('"Back to details" returns to your place in the episode list', listAt > 400 && Math.abs(backAt - listAt) < 40, { listAt, backAt });
  }
  await page.evaluate(() => { const s = document.getElementById('seasons'); if (s) s.scrollIntoView({ block: 'start', behavior: 'instant' }); });
  await sleep(500);
  await fits('series page');
  await shot('series-episodes');

  // ---- search
  await go('#/search?q=dune', '.grid .card');
  check('search returns a grid', await page.locator('.grid .card').count() > 3);
  await go('#/search?q=villeneuve', '#results .person, #results .center-note');
  check('search finds people', await page.locator('#results .cast-track .person').count() >= 1);
  await go('#/person/137427', '.detail-body');
  await page.waitForSelector('.section h3', { timeout: 15000 });
  const heads = await page.$$eval('.section h3', (hs) => hs.map((h) => h.textContent.trim()));
  check('a director page leads with directing', /directing/i.test(heads[0] || ''), heads);
  await go('#/search?q=dune', '.grid .card');
  await shot('search-results');
  await go('#/search', '#tv-search-input');
  await page.waitForSelector('.genre-grid .genre-tile', { timeout: 15000 }).catch(() => {});
  check('empty search offers genres', await page.locator('.genre-grid .genre-tile').count() >= 10);
  await fits('search');
  await shot('search-empty');

  // ---- browse
  await go('#/tv', '.grid .card');
  check('browse grid renders', await page.locator('.grid .card').count() > 10);
  if (name === 'tv') {
    // The grid screens are the Stage too: the focused line of posters sits at --grid-lane
    // (46vh) under the focused title's text, the lines above it fade, and Down from the last
    // line stays on the page (the side rail's lower half once sorted after it).
    await page.waitForFunction(() => document.activeElement && document.activeElement.matches('.grid .card'), null, { timeout: 15000 }).catch(() => {});
    await sleep(900);
    const lane = () => page.evaluate(() => {
      const a = document.activeElement;
      return { grid: document.body.classList.contains('stage-grid'), card: !!(a && a.matches('.grid .card')),
               off: a ? Math.abs(a.getBoundingClientRect().top - innerHeight * 0.46) : 999,
               faded: document.querySelectorAll('.grid > .card.st-above').length,
               rail: !!(a && a.closest('header.top')), h1: getComputedStyle(document.querySelector('#view h1')).display,
               info: (document.querySelector('.st-meta') || {}).textContent || '' };
    });
    const g0 = await lane();
    check('TV: browse is the Stage, the focused card at the lane', g0.grid && g0.card && g0.off <= 3 && g0.h1 === 'none' && !!g0.info.trim(), g0);
    await page.keyboard.press('ArrowDown'); await sleep(900);
    const g1 = await lane();
    check('TV: Down keeps the lane and fades the line above', g1.card && g1.off <= 3 && g1.faded >= 3, g1);
    let g2 = g1;
    for (let i = 0; i < 10 && !g2.rail; i++) { await page.keyboard.press('ArrowDown'); await sleep(250); g2 = await lane(); }
    check('TV: Down from the last line stays on the page', !g2.rail, g2);
    await go('#/tv', '.grid .card');
  }
  await go('#/movies?kw=10051&kwn=Heist', '.ctx-row .ctx-chip');
  await page.waitForSelector('.grid .card', { timeout: 25000 });
  check('a keyword link filters, and says so', await page.locator('.ctx-row .ctx-chip').count() === 1 && await page.locator('.grid .card').count() > 5);
  await go('#/movies?rt=90', '#f-rt .chip.on[data-rt="90"]');
  await page.waitForSelector('.grid .card', { timeout: 25000 });
  check('the runtime chip is reflected in the panel', true);
  await go('#/watchlist', '.wl-controls');
  check('watchlist controls appear on a long list', await page.locator('.wl-controls .chip').count() >= 8);
  await go('#/watchlist?type=movie', '.wl-controls .chip.on');
  await sleep(400);
  const films = await page.evaluate(() => { const cs = [].slice.call(document.querySelectorAll('.grid .card')); return { n: cs.length, only: cs.every((c) => c.dataset.nav.indexOf('#/movie/') === 0) }; });
  check('watchlist: Films shows only films', films.only && films.n === 6, films);
  await fits('watchlist');
  await shot('watchlist');
  await shot('browse-tv');

  // ---- the player page (mirrors are blocked; the page around them is what is tested)
  await go('#/watch/tv/1399?s=1&e=2', '.player-frame');
  check('player page mounts a frame', await page.locator('.player-frame').count() === 1);
  // The page opens on a poster: the embed is the heaviest thing the app loads, so it waits for Play.
  check('watch opens on a poster with Play, and NO iframe yet', await page.evaluate(() => !!document.querySelector('.play-gate #play-go') && !document.querySelector('#player-iframe')));
  if (name === 'tv') {
    check('TV: the ring is on Play, and the pointer is not up yet', await page.evaluate(() => document.querySelector('#play-go').classList.contains('tv-focus') && !document.body.classList.contains('cursor-on')));
    await shot('play-gate-tv');
    await page.keyboard.press('Enter');
  } else {
    await shot('play-gate-' + name);
    await page.locator('#play-go').click();
  }
  await page.waitForSelector('#player-iframe', { timeout: 10000 });
  check('Play builds the player and removes the poster', await page.evaluate(() => !document.querySelector('.play-gate') && document.querySelectorAll('#player-iframe').length === 1));
  if (name === 'tv') {
    // The player opens in the page (some mirrors break loading straight into full screen);
    // OK on the picture is what brings full screen and the pointer.
    check('TV: the player waits in the page, ring on the picture', await page.evaluate(() =>
      !document.body.classList.contains('cinema-on') && !document.body.classList.contains('cursor-on') &&
      document.activeElement && document.activeElement.matches('.player-frame')));
    await page.keyboard.press('Enter'); await sleep(600);
    check('TV: OK on the picture brings full screen and the pointer', await page.evaluate(() =>
      document.body.classList.contains('cinema-on') && document.body.classList.contains('cursor-on')));
    await shot('player-pointer');
    // The dock: Down with the pointer at the bottom edge raises episodes and servers over the picture.
    for (let i = 0; i < 40 && !(await page.evaluate(() => document.body.classList.contains('dock-open'))); i++) {
      await page.keyboard.press('ArrowDown'); await sleep(30);
    }
    const dk = await page.evaluate(() => {
      const a = document.activeElement;
      return { open: document.body.classList.contains('dock-open'), inDock: !!(a && a.closest && a.closest('#pl-dock')),
               onPlaying: !!(a && a.matches && a.matches('.epx.on, .mirror.on')) };
    });
    check('TV: Down at the bottom edge opens the dock on what is playing', dk.open && dk.inDock && dk.onPlaying, dk);
    await shot('player-dock');
    await page.keyboard.press('Escape'); await sleep(400);
    check('TV: Back closes the dock and gives the pointer back', await page.evaluate(() =>
      !document.body.classList.contains('dock-open') && document.body.classList.contains('cursor-on')));
    await page.keyboard.press('Escape');
    await sleep(1200);
    check('TV: one press leaves full screen, back to the watch page', await page.evaluate(() =>
      !document.body.classList.contains('cinema-on') && !document.body.classList.contains('cursor-on') &&
      location.hash.indexOf('#/watch/') === 0 && document.activeElement && document.activeElement.matches('.player-frame')));
  }
  await fits('player page');
  await shot('player-page');
  if (name === 'desktop') {
    // Episodes run down the side of the picture at exactly its height; servers take the full row below.
    const sp = await page.evaluate(() => { const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
      const f = r('.player-frame'), eps = r('.pl-eps'), srv = r('.pl-srv'), bar = r('.source-bar'), shell = r('.player-shell');
      return { frame: f && [Math.round(f.left), Math.round(f.top), Math.round(f.right), Math.round(f.height)],
               eps: eps && [Math.round(eps.left), Math.round(eps.top), Math.round(eps.height)],
               srv: srv && [Math.round(srv.left), Math.round(srv.top), Math.round(srv.width)], shellW: shell && Math.round(shell.width),
               barBottom: bar ? Math.round(bar.bottom) : 0, vh: innerHeight }; });
    check('desktop: episodes run beside the picture at its height', !!sp.eps && sp.eps[0] > sp.frame[2] && Math.abs(sp.eps[1] - sp.frame[1]) <= 1 && Math.abs(sp.eps[2] - sp.frame[3]) <= 1, sp);
    check('desktop: servers take the full row below', !!sp.srv && sp.srv[1] >= sp.barBottom && sp.srv[2] >= sp.shellW - 2, sp);
    check('desktop: the picture and its bar fit the window', sp.barBottom <= sp.vh, sp);
    await page.locator('#movie-mode').click(); await sleep(500);
    const th = await page.evaluate(() => { const b = document.querySelector('.player-frame > iframe, .player-frame > .player-empty').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), vw: innerWidth, vh: innerHeight }; });
    check('desktop: Theater mode fills the window with the player', th.w >= th.vw - 2 && th.h >= th.vh - 2, th);
    await page.keyboard.press('Escape'); await sleep(300);
  }
  if (name === 'phone') {
    // The picture stays pinned under the bar while the episodes and servers scroll.
    await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' })); await sleep(300);
    const pin = await page.evaluate(() => ({ frame: Math.round(document.querySelector('.player-frame').getBoundingClientRect().top),
      bar: Math.round(document.querySelector('header.top').getBoundingClientRect().bottom), y: Math.round(scrollY) }));
    check('phone: the player stays pinned under the bar', pin.y > 100 && Math.abs(pin.frame - pin.bar) <= 2, pin);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await sleep(300);
    // Fullscreen on a phone turns the picture landscape, by whichever means exists here.
    await page.locator('#tv-mode').tap(); await sleep(2200);   // fullscreen settles, then the 700ms look-again
    const fsr = await page.evaluate(() => {
      // The PLAYER is what turns (a fullscreen element cannot be transformed): its own box is
      // landscape, and once swung round it covers the portrait screen.
      const f = document.getElementById('player-iframe') || document.querySelector('.player-frame > *'), r = f.getBoundingClientRect();
      return { body: document.body.className, fs: !!document.fullscreenElement, coarse: matchMedia('(hover: none) and (pointer: coarse)').matches,
               cinema: document.body.classList.contains('cinema-on'), rot: document.body.classList.contains('cinema-rot'),
               landscapeViewport: matchMedia('(orientation: landscape)').matches, boxW: f.offsetWidth, boxH: f.offsetHeight,
               covers: Math.round(r.width) >= innerWidth - 1 && Math.round(r.height) >= innerHeight - 1 };
    });
    check('phone: fullscreen shows the picture landscape', fsr.cinema && (fsr.landscapeViewport || (fsr.rot && fsr.boxW > fsr.boxH)) && fsr.covers, fsr);
    await shot('fullscreen');
    await page.evaluate(() => { const x = document.getElementById('cinema-exit'); if (x) x.click(); }); await sleep(500);
    check('phone: leaving fullscreen drops the rotation', await page.evaluate(() => !document.body.classList.contains('cinema-on') && !document.body.classList.contains('cinema-rot')));
  }
  if (name !== 'tv') await shot('player-page-full', { fullPage: true });

  // ---- account: the account button opens a page with Profile / Settings / App tabs (it used
  // to open a pop-out menu, and Settings a dialog)
  await go('#/', '.rail .card');
  await page.locator('#acct-btn').click();
  await page.waitForSelector('.acc-tabs .acc-tab', { timeout: 5000 });
  const acc = await page.evaluate(() => ({ hash: location.hash, menu: !!document.getElementById('acct-menu'),
    tabs: [].map.call(document.querySelectorAll('.acc-tab'), (b) => b.textContent.trim()).join('|') }));
  check('the account button opens the Account page, no pop-out', acc.hash === '#/account' && !acc.menu && acc.tabs === 'Profile|Settings|App', acc);
  await shot('account');
  await go('#/account?tab=settings', '#set-themes');
  check('the Settings tab holds the theme picker', await page.locator('#set-themes .theme-card').count() >= 3);
  await shot('settings');
  await go('#/account?tab=app', '#set-upd');
  check('the App tab holds the version and updates', await page.evaluate(() => /v\d+\.\d+\.\d+/.test(document.querySelector('.acc-panel').textContent)));

  check('no uncaught errors', r.errors.length === 0, r.errors.slice(0, 3));
  check('no failed TMDB calls', r.apiFailures.length === 0, r.apiFailures.slice(0, 3));
  await ctx.close();
}

/* Stand-in mirrors, served by Playwright -- the real ones are never loaded.
 *   talky.test   built the way the troublesome ones are: the page we ask for NESTS the player in an
 *                inner frame from another origin, which reports to window.top. "100 seconds in", then
 *                the last second of a 50-minute episode, so a reported end can be seen to act.
 *   silent.test  plays, and never says a word.
 *   store.test   posts MEDIA_DATA holding its WHOLE store: another title first, then this one. */
async function runPlayerFixture(browser, report) {
  const r = report.player = { checks: [], errors: [] };
  const check = (label, ok, detail) => {
    r.checks.push({ label, ok: !!ok, detail: detail === undefined ? '' : detail });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} [player] ${label}${detail !== undefined && detail !== '' ? ' -- ' + JSON.stringify(detail) : ''}`);
  };
  const page1 = (inner) => '<!doctype html><body style="margin:0;background:#000"><iframe src="' + inner + '" style="border:0;width:100%;height:100vh"></iframe>';
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.host === 'talky.test') return route.fulfill({ contentType: 'text/html', body: page1('https://cdn-player.test/talky') });
    if (u.host === 'silent.test') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="background:#111;color:#666">silent</body>' });
    if (u.host === 'store.test') return route.fulfill({ contentType: 'text/html', body: page1('https://cdn-player.test/store') });
    if (u.host === 'cdn-player.test' && u.pathname === '/talky') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><body><script>
      var n = 0; setInterval(function () { n++;
        var t = n < 6 ? 100 + n : 2999;
        window.top.postMessage(JSON.stringify({ type: 'PLAYER_EVENT', data: { event: 'timeupdate', currentTime: t, duration: 3000 } }), '*');
      }, 400);</script>` });
    if (u.host === 'cdn-player.test') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><body><script>
      setInterval(function () { window.top.postMessage({ type: 'MEDIA_DATA', data: {
        '550':  { id: 550, type: 'movie', progress: { watched: 5000, duration: 8340 } },
        '1399': { id: 1399, type: 'tv', progress: { watched: 600, duration: 3400 }, last_season_watched: 1, last_episode_watched: 2,
                  show_progress: { s1e2: { progress: { watched: 600, duration: 3400 } } } } } }, '*'); }, 300);</script>` });
    if (/\.workers\.dev$/.test(u.host)) return route.abort();        // keep the seeded source table
    if (u.protocol === 'data:' || ALLOW.some((re) => re.test(u.host))) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript(() => {
    try {
      if (localStorage.getItem('reeldeck.config.v5')) return;
      const src = (name, host) => ({ name: name, resume: 't', movie: 'https://' + host + '/m/{id}', tv: 'https://' + host + '/tv/{id}/{season}/{episode}' });
      // A film a mirror reported to 1:05:06, since nudged on by the wall clock on a silent one.
      localStorage.setItem('reeldeck.progress.v1', JSON.stringify({ 'movie:27205': { t: 4026, d: 8880, pct: 0.45, at: Date.now() - 3600e3, src: 'elapsed', seek: 3906 } }));
      localStorage.setItem('reeldeck.config.v5', JSON.stringify({ activeSource: 2, sources: [src('Talky', 'talky.test'), src('Silent', 'silent.test'), src('Store', 'store.test')] }));
    } catch (e) {}
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => r.errors.push(String(e.message || e)));
  const stored = (k2) => page.evaluate((key) => (JSON.parse(localStorage.getItem('reeldeck.progress.v1') || '{}'))[key] || null, k2);
  const badges = () => page.evaluate(() => JSON.parse(localStorage.getItem('reeldeck.tracked.v1') || '{}'));
  const pick = (i) => page.evaluate((n) => { const el = document.querySelector('.mirror[data-src="' + n + '"]'); if (el) el.click(); return !!el; }, i);

  await page.goto(`${ORIGIN}/#/watch/tv/1399?s=1&e=2`, { waitUntil: 'domcontentloaded' });
  const guest = page.locator('#sp-guest');
  if (await guest.isVisible({ timeout: 4000 }).catch(() => false)) await guest.click();
  await page.waitForSelector('.play-gate', { timeout: 30000 });
  check('fixture: poster first, no iframe loaded', await page.locator('#player-iframe').count() === 0);
  // Anything that would SHOW the player starts it, rather than fullscreening a poster.
  await page.locator('#movie-mode').click();
  await page.waitForSelector('#player-iframe', { timeout: 10000 });
  check('Theater on the poster starts the player and enters Theater', await page.evaluate(() => document.body.classList.contains('cinema-on') && !document.querySelector('.play-gate')));
  await page.keyboard.press('Escape');
  await sleep(1500);
  const viaStore = await stored('tv:1399:1:2');
  check('a whole-store report is read for THIS title, not the first one in it', !!viaStore && viaStore.t === 600 && viaStore.d === 3400, viaStore);

  check('switching to the talking mirror', await pick(0)); await sleep(1800);
  const viaTalky = await stored('tv:1399:1:2');
  check('a nested, different-origin player frame is heard', !!viaTalky && viaTalky.src === 'provider' && viaTalky.d === 3000 && viaTalky.t >= 100, viaTalky);
  check('hearing it earns the mirror its badge', (await badges()).Talky === 1);

  check('switching to the silent mirror while the other is mid-report', await pick(1)); await sleep(1800);
  const b2 = await badges();
  check('a silent mirror is NOT credited with the last one\'s reports', b2.Silent !== 1, b2);
  check('...and the old player is gone, not merely re-pointed', await page.evaluate(() => /silent\.test/.test(document.getElementById('player-iframe').src)));

  await pick(0);
  await page.waitForSelector('.next-up.counting', { timeout: 12000 }).catch(() => {});
  const counting = await page.evaluate(() => { const e = document.querySelector('.next-up.counting .nu-k'); return e ? e.textContent : ''; });
  check('a reported end starts the countdown', /Next episode in \d/.test(counting), counting);
  if (SHOTS) await page.screenshot({ path: path.join(OUT, 'player-01-countdown.png') });
  await page.keyboard.press('Escape'); await sleep(2500);
  const afterEsc = await page.evaluate(() => ({ pill: !!document.querySelector('.next-up.counting'), hash: location.hash }));
  check('Back / Escape cancels the countdown and stays in the episode', !afterEsc.pill && /[?&]e=2(&|$)/.test(afterEsc.hash), afterEsc);

  // REAL fullscreen: the browser keeps Esc for itself, so the page only ever sees the exit.
  await page.evaluate(() => { location.hash = '#/watch/tv/1399?s=1&e=3'; });
  await page.waitForFunction(() => /[?&]e=3(&|$)/.test(location.hash) && !!document.getElementById('player-iframe'), null, { timeout: 25000 });
  await sleep(600);
  await page.locator('#tv-mode').click();
  await page.waitForSelector('.next-up.counting', { timeout: 12000 }).catch(() => {});
  const wasFs = await page.evaluate(() => !!document.fullscreenElement);
  await page.evaluate(() => document.exitFullscreen && document.exitFullscreen().catch(() => {}));
  await sleep(9500);
  const afterFs = await page.evaluate(() => ({ pill: !!document.querySelector('.next-up.counting'), hash: location.hash }));
  check('leaving real fullscreen cancels the countdown too', wasFs && !afterFs.pill && /[?&]e=3(&|$)/.test(afterFs.hash), { wasFs, afterFs });

  // The seek point survives a wall-clock takeover: the mirror is sent to the last REPORTED moment.
  await page.evaluate(() => { location.hash = '#/watch/movie/27205'; });
  await page.waitForFunction(() => /movie\/27205/.test(location.hash) && /\/m\/27205/.test((document.getElementById('player-iframe') || {}).src || ''), null, { timeout: 25000 });
  const seekSrc = await page.getAttribute('#player-iframe', 'src');
  check('an entry the wall clock took over still seeks to the last reported moment', /[?&]t=3906$/.test(seekSrc || ''), seekSrc);

  // A fresh episode, this time in Theater mode: left alone, it plays the next one and keeps the big picture.
  await page.evaluate(() => { location.hash = '#/watch/tv/1399?s=1&e=4'; });
  await page.waitForFunction(() => /[?&]e=4(&|$)/.test(location.hash) && !!document.getElementById('player-iframe'), null, { timeout: 25000 });
  await sleep(600);
  await page.locator('#movie-mode').click();
  await page.waitForFunction(() => /[?&]e=5(&|$)/.test(location.hash), null, { timeout: 25000 }).catch(() => {});
  await sleep(1500);
  const adv = await page.evaluate(() => ({ hash: location.hash, cinema: document.body.classList.contains('cinema-on') }));
  check('left alone, the countdown plays the next episode', /[?&]e=5(&|$)/.test(adv.hash), adv.hash);
  check('...and stays in Theater mode across the episode boundary', adv.cinema, adv);
  check('no uncaught errors', r.errors.length === 0, r.errors.slice(0, 3));
  await ctx.close();
}

/* The desktop app has no browser chrome, so it has no Back unless the page provides one. The
 * Electron preload is stood in for by the one property app.js tests (window.reeldeck.desktop). */
async function runDesktopApp(browser, report) {
  const r = report.app = { checks: [], errors: [] };
  const check = (label, ok, detail) => {
    r.checks.push({ label, ok: !!ok, detail: detail === undefined ? '' : detail });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} [app] ${label}${detail !== undefined && detail !== '' ? ' -- ' + JSON.stringify(detail) : ''}`);
  };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  await ctx.route('**/*', (route) => {
    let host = '';
    try { host = new URL(route.request().url()).host; } catch (e) {}
    if (route.request().url().startsWith('data:') || ALLOW.some((re) => re.test(host))) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript(() => { window.reeldeck = { desktop: true }; });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => r.errors.push(String(e.message || e)));
  await page.goto(`${ORIGIN}/#/`, { waitUntil: 'domcontentloaded' });
  const guest = page.locator('#sp-guest');
  if (await guest.isVisible({ timeout: 4000 }).catch(() => false)) await guest.click();
  await page.waitForSelector('.rail .card', { timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' })); await sleep(250);
  const leftAt = await page.evaluate(() => Math.round(window.scrollY));
  await page.evaluate(() => { const c = [].find.call(document.querySelectorAll('.rail .card:not(.more-card)'), (x) => { const b = x.getBoundingClientRect(); return b.top > 80 && b.bottom < innerHeight; }); c.click(); });
  await page.waitForSelector('.dv-stage', { timeout: 25000 }); await sleep(500);
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForFunction(() => (location.hash || '#/') === '#/' && !!document.querySelector('.rail .card'), null, { timeout: 15000 }).catch(() => {});
  await sleep(1200);
  const got = await page.evaluate(() => ({ hash: location.hash || '#/', y: Math.round(window.scrollY) }));
  check('desktop app: Alt+Left goes Back, to where you were', got.hash === '#/' && leftAt > 400 && Math.abs(got.y - leftAt) < 40, { leftAt, got });
  await page.keyboard.press('Alt+ArrowRight');
  await page.waitForSelector('.dv-stage', { timeout: 15000 }).catch(() => {});
  check('desktop app: Alt+Right goes forward again', await page.evaluate(() => /^#\/(movie|tv)\/\d+/.test(location.hash)), await page.evaluate(() => location.hash));
  check('no uncaught errors', r.errors.length === 0, r.errors.slice(0, 3));
  await ctx.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (SHOTS) for (const f of fs.readdirSync(OUT)) if (/\.png$|^report\.json$/.test(f)) fs.unlinkSync(path.join(OUT, f));
  const srv = await proxy(BASE);
  const browser = await chromium.launch();
  const report = {};
  const names = Object.keys(PROFILES).filter((n) => !ONLY || n === ONLY);
  for (const n of names) {
    console.log(`\n== ${n} ==`);
    try { await runProfile(browser, n, report); }
    catch (e) {
      report[n] = report[n] || { checks: [], errors: [] };
      report[n].checks.push({ label: 'profile completed', ok: false, detail: String(e.message || e).split('\n')[0] });
      console.log(`  FAIL [${n}] profile aborted -- ${String(e.message || e).split('\n')[0]}`);
    }
  }
  if (!ONLY || ONLY === 'player') {
    console.log('\n== player ==');
    try { await runPlayerFixture(browser, report); }
    catch (e) { report.player = report.player || { checks: [] }; report.player.checks.push({ label: 'player fixture completed', ok: false, detail: String(e.message || e).split('\n')[0] }); console.log('  FAIL [player] aborted -- ' + String(e.message || e).split('\n')[0]); }
  }
  if (!ONLY || ONLY === 'app') {
    console.log('\n== app ==');
    try { await runDesktopApp(browser, report); }
    catch (e) { report.app = report.app || { checks: [] }; report.app.checks.push({ label: 'desktop app walk completed', ok: false, detail: String(e.message || e).split('\n')[0] }); console.log('  FAIL [app] aborted -- ' + String(e.message || e).split('\n')[0]); }
  }
  await browser.close(); srv.close();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const all = [].concat(...Object.values(report).map((x) => x.checks));
  const failed = all.filter((c) => !c.ok);
  console.log(`\n${all.length - failed.length}/${all.length} checks passed` + (failed.length ? ` -- ${failed.length} FAILED` : ''));
  process.exit(failed.length ? 1 : 0);
})();
