// Installable app shell. API calls remain network-only because games and account
// data are live; only the frontend shell and same-origin static assets are cached.
const CACHE = 'chakri-shell-v5';
const CORE_ASSETS = [
  '/',
  '/manifest.json',
  '/chakri-roulette-brand.png',
  '/chakri-favicon.png',
  '/chakri-app-icon-192.png',
  '/chakri-app-icon-512.png',
  '/chakri-app-icon-maskable-512.png',
  '/chakri-apple-touch-icon.png',
];

const offlineDocument = () => new Response(
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0B0B0F"><title>CHAKRI.CASINO</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0f;color:#fff;font:600 16px system-ui"><main style="text-align:center;padding:24px"><img src="/chakri-roulette-brand.png" width="640" height="160" style="width:min(90vw,640px);height:auto" alt="CHAKRI.CASINO"><p style="color:#aaa;font-weight:400">You are offline. Reconnect to continue playing live games.</p></main></body></html>',
  { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
);

const isRuntimeCacheable = (pathname) =>
  CORE_ASSETS.includes(pathname) || pathname.startsWith('/static/');

async function discoverShellAssets() {
  const assets = new Set(CORE_ASSETS);
  let manifestLoaded = false;

  // CRA publishes the exact hashed JS/CSS filenames here. Caching those files
  // makes an installed app's shell boot even when the connection is offline.
  try {
    const response = await fetch('/asset-manifest.json', { cache: 'no-store' });
    if (response.ok) {
      manifestLoaded = true;
      const manifest = await response.json();
      Object.values(manifest.files || {}).forEach((path) => {
        if (/\.(?:js|css|woff2?|png|svg|webp|avif)$/i.test(path)) assets.add(path);
      });
    }
  } catch (error) {
    // Core assets still provide a branded fallback if manifest discovery fails.
  }

  return { assets, manifestLoaded };
}

async function precacheShell() {
  const cache = await caches.open(CACHE);
  const { assets } = await discoverShellAssets();

  await Promise.all([...assets].map((path) => cache.add(path).catch(() => undefined)));
}

async function pruneObsoleteStaticAssets() {
  const { assets, manifestLoaded } = await discoverShellAssets();
  // If the deploy manifest cannot be reached, keep the last complete shell.
  // Pruning against CORE_ASSETS alone would strand an offline installation.
  if (!manifestLoaded) return;
  const currentUrls = new Set([...assets].map((path) => new URL(path, self.location.origin).href));
  const cache = await caches.open(CACHE);
  const requests = await cache.keys();
  await Promise.all(requests.map((request) => {
    const url = new URL(request.url);
    return url.pathname.startsWith('/static/') && !currentUrls.has(url.href)
      ? cache.delete(request)
      : undefined;
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('chakri-shell-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => pruneObsoleteStaticAssets())
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never cache API/account/game-engine responses or third-party resources.
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    // Aviator is its own embedded build. It must never replace the cached React
    // shell at '/', and its versioned assets are managed independently.
    if (url.pathname.startsWith('/aviator-live/')) return;
    event.respondWith(
      fetch(req)
        .then(async (response) => {
          if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
            const copy = response.clone();
            try {
              const cache = await caches.open(CACHE);
              await cache.put('/', copy);
            } catch (error) {
              // A quota/cache failure must never break a valid navigation.
            }
          }
          return response;
        })
        .catch(() => caches.match(req).then(async (hit) => hit || (await caches.match('/')) || offlineDocument()))
    );
    return;
  }

  // Media uses byte-range requests and fixed-name sub-app assets must update as
  // one coordinated build. Leave both entirely to the network/browser cache.
  if (req.headers.has('range') || url.pathname.startsWith('/aviator-live/') || !isRuntimeCacheable(url.pathname)) return;

  // Hashed build assets can be served immediately, then refreshed in the
  // background. Activation prunes files absent from the current build manifest.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then(async (response) => {
        if (response.ok && response.status !== 206) {
          const copy = response.clone();
          try {
            const cache = await caches.open(CACHE);
            await cache.put(req, copy);
          } catch (error) {
            // Return the successful network response even if caching fails.
          }
        }
        return response;
      });
      if (cached) {
        event.waitUntil(network.catch(() => undefined));
        return cached;
      }
      return network;
    })
  );
});
