/* ══════════════════════════════════════════════════════════
   MangaVerse Service Worker
   Strategy:
   - App shell (HTML/fonts/CSS): Cache-first, update in background
   - MangaDex API calls: Network-first, fall back to cache (5 min TTL)
   - Manga page images: Cache-first (read chapters work offline)
   - Jikan/MAL API: Network-only (always fresh)
══════════════════════════════════════════════════════════ */

const CACHE_SHELL   = 'mv-shell-v1';
const CACHE_API     = 'mv-api-v1';
const CACHE_IMAGES  = 'mv-images-v1';
const API_TTL_MS    = 5 * 60 * 1000;  // 5 minutes

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,300;0,400;0,500;1,300&family=DM+Serif+Display:ital@0;1&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_SHELL)
      .then(c => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  const keep = [CACHE_SHELL, CACHE_API, CACHE_IMAGES];
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !keep.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Jikan/MAL — always network, no cache
  if (url.hostname.includes('jikan.moe') || url.hostname.includes('myanimelist')) {
    return;
  }

  // Manga page images (MangaDex CDN) — cache-first for offline reading
  if (url.hostname.includes('uploads.mangadex.org') && url.pathname.startsWith('/data/')) {
    e.respondWith(cacheFirst(CACHE_IMAGES, request));
    return;
  }

  // MangaDex API — network-first, cache fallback with TTL
  if (url.hostname.includes('mangadex.org') || url.hostname.includes('corsproxy') || url.hostname.includes('allorigins')) {
    e.respondWith(networkFirstWithTTL(CACHE_API, request));
    return;
  }

  // Shell (HTML, fonts, self) — cache-first
  if (url.hostname === self.location.hostname || url.hostname.includes('fonts.g')) {
    e.respondWith(cacheFirst(CACHE_SHELL, request));
    return;
  }
});

async function cacheFirst(cacheName, request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const c = await caches.open(cacheName);
      c.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirstWithTTL(cacheName, request) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const headers = new Headers(response.headers);
      headers.set('x-sw-cached-at', Date.now().toString());
      const tagged = new Response(await response.clone().blob(), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
      cache.put(request, tagged);
      return response;
    }
  } catch { /* network failed — try cache */ }

  const cached = await cache.match(request);
  if (cached) {
    const cachedAt = parseInt(cached.headers.get('x-sw-cached-at') || '0');
    if (Date.now() - cachedAt < API_TTL_MS) return cached;
  }
  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });
}