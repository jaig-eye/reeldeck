/* A scratch probe against the web container -- for a question the smoke test does not
 * already ask. Edit freely; it is mounted, not baked into the image.
 *
 *   docker compose run --rm -v ./docker/smoke/probe.js:/smoke/probe.js:ro smoke node probe.js
 *
 * As committed it photographs Home in every theme, on a desktop and a phone, so a change to
 * the shared layer can be checked against the light theme as well as the dark ones.
 */
const { chromium } = require('playwright');
const net = require('net');
const path = require('path');

const OUT = process.env.OUT || '/out';
const THEMES = ['midnight', 'oled', 'onyx', 'aurora', 'ocean', 'ember', 'daylight'];

(async () => {
  const srv = net.createServer((c) => { const up = net.connect(80, 'web'); c.pipe(up).pipe(c); c.on('error', () => up.destroy()); up.on('error', () => c.destroy()); });
  await new Promise((r) => srv.listen(8080, '127.0.0.1', r));
  const browser = await chromium.launch();
  for (const [name, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    for (const theme of THEMES) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: name === 'phone' ? 2 : 1, isMobile: name === 'phone', hasTouch: name === 'phone' });
      await ctx.addInitScript((t) => { try { localStorage.setItem('reeldeck.config.v5', JSON.stringify({ theme: t })); } catch (e) {} }, theme);
      const page = await ctx.newPage();
      const errs = []; page.on('pageerror', (e) => errs.push(String(e.message)));
      await page.goto('http://localhost:8080/#/', { waitUntil: 'domcontentloaded' });
      const g = page.locator('#sp-guest'); if (await g.isVisible({ timeout: 4000 }).catch(() => false)) await g.click();
      await page.waitForSelector('.rail .card', { timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      await page.screenshot({ path: path.join(OUT, `theme-${name}-${theme}.png`) });
      console.log(name, theme, errs.length ? 'ERRORS ' + errs.join(' | ') : 'ok');
      await ctx.close();
    }
  }
  await browser.close(); srv.close();
})();
