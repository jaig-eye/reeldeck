// Reeldeck service worker — makes the app installable and load offline-ish.
// Only touches SAME-ORIGIN app shell files. TMDB, image CDN and the streaming
// providers are always fetched live from the network (never cached/intercepted).
const CACHE = 'reeldeck-v32';
const SHELL = [
  './', './index.html', './app.js?v=32', './styles.css?v=32',
  './assets/vendor/qrcode.js',
  './manifest.webmanifest', './assets/icon-192.png', './assets/icon-512.png',
  // The header logo mask and the Apple touch icon: without them the brand mark is an
  // empty box on an offline first paint.
  './assets/brand/mark-alpha.png', './assets/icon-180.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll is all-or-nothing; swallowing its rejection used to activate an
      // INCOMPLETE cache (and then delete the previous, complete one) whenever a
      // single shell entry 404'd. Fetch them individually and keep what we got.
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;           // live network for API/CDN/providers
  if (e.request.method !== 'GET') return;

  // The document itself is NETWORK-FIRST. It is cached under an unversioned key
  // ('./', './index.html'), so answering it from cache handed back the previous
  // release's HTML — which then asked for the previous release's app.js?v=…, also
  // still cached. An update looked like it simply had not installed until the app
  // was launched twice. Everything else stays cache-first: those URLs carry a
  // version query, so a new release can never match an old entry.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) =>
      cached ||
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => cached)
    )
  );
});
