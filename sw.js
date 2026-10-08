// Offline support.
// - App files: network first (so updates show up right away), cache fallback.
// - Map tiles: cache first, so areas you've viewed at the dock still show at sea.
// - Wind forecasts are cached by the app itself (localStorage), not here.

const APP_CACHE = 'fluke-app-v2';
const TILE_CACHE = 'fluke-tiles-v1';
const MAX_TILES = 3000;
const TILE_HOSTS = ['gis.charttools.noaa.gov', 'server.arcgisonline.com', 'tile.openstreetmap.org'];

const APP_FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/charts.js', 'js/drift.js', 'js/geo.js', 'js/particles.js', 'js/position.js', 'js/wind.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'icons/icon-180.png', 'icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![APP_CACHE, TILE_CACHE].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirstTile(request));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(APP_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirstTile(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Tile servers answer cross-origin <img> requests opaquely (status 0); cache those too.
  if (response.ok || response.type === 'opaque') {
    await cache.put(request, response.clone());
    trimTiles(cache);
  }
  return response;
}

async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_TILES) return;
  await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k)));
}
