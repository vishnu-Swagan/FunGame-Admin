// Minimal service worker to satisfy PWA installability (network-first pass-through).
// Intentionally does not cache API responses — the app is backend-driven and live.
const CACHE = 'fungame-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GET navigations/assets; never intercept API or non-GET.
  if (req.method !== 'GET' || req.url.includes('/api/')) return;
  event.respondWith(
    fetch(req).catch(() =>
      caches.match(req).then((hit) => hit || Response.error())
    )
  );
});
