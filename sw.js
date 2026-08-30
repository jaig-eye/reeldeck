// Reeldeck service worker — makes the app installable and load offline-ish.
// Only touches SAME-ORIGIN app shell files. TMDB, image CDN and the streaming
// providers are always fetched live from the network (never cached/intercepted).
const CACHE = 'reeldeck-v4';
const SHELL = [
  './', './index.html', './app.js?v=6', './styles.css?v=5',
  './manifest.webmanifest', './assets/icon-192.png', './assets/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
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
