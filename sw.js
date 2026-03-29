/* ══════════════════════════════════════════════════════════
   MangaVerse Service Worker
   Strategy:
   - App shell (HTML/fonts/CSS): Cache-first, update in background
   - MangaDex API calls: Network-first, fall back to cache (5 min TTL)
   - Manga page images: Cache-first (read chapters work offline)
   - Jikan/MAL API: Network-only (always fresh)
══════════════════════════════════════════════════════════ */

const CACHE_SHELL   = 'mv-shell-v2';
const CACHE_API     = 'mv-api-v2';
const CACHE_IMAGES  = 'mv-images-v2';
const API_TTL_MS    = 5 * 60 * 1000; // 5 minutes

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,300;0,400;0,500;1,300&family=DM+Serif+Display:ital@0;1&display=swap'
];

// These are the image CDNs that should be aggressively cached (cache-first)
const IMAGE_HOSTNAMES = [
  'uploads.mangadex.org', // MangaDex chapter pages and covers
  'cdn.myanimelist.net' // MyAnimeList covers (fetched via Jikan)
  // Add other image hosts if MangaVerse starts using them
  // e.g., 'og.image.mangadex.org' for social share images if needed
];

self.addEventListener('install', e => {
  e.waitUntil(precacheShell().then(() => self.skipWaiting()));
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

  if (request.mode === 'navigate') {
    e.respondWith(navigateWithFallback(request));
    return;
  }

  // Jikan API (non-image) — network-only (always fresh for API data)
  // This rule should be specific to the Jikan API endpoint, not general MyAnimeList images.
  if (url.hostname.includes('jikan.moe') && url.pathname.startsWith('/v4/manga')) {
    return;
  }

  // Manga page images & covers — cache-first for offline reading
  // Includes MangaDex CDN images (chapters, covers) and MyAnimeList CDN images (from Jikan covers)
  for (const hostname of IMAGE_HOSTNAMES) {
    if (url.hostname.includes(hostname)) {
      // Further refine for MangaDex specific paths if necessary, but for generic image CDNs, hostname is enough.
      if (hostname === 'uploads.mangadex.org' && !(url.pathname.startsWith('/data/') || url.pathname.startsWith('/data-saver/') || url.pathname.startsWith('/covers/'))) {
        continue; // Skip if it's MangaDex but not a known image path
      }
      e.respondWith(cacheFirst(CACHE_IMAGES, request));
      return;
    }
  }

  // MangaDex API & Proxy requests — network-first, cache fallback with TTL
  // This rule specifically targets the MangaDex API domain and proxy URLs, not image CDNs.
  if (url.hostname.includes('api.mangadex.org') || url.hostname.includes('corsproxy') || url.hostname.includes('allorigins')) {
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
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirstWithTTL(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    const cachedAt = parseInt(cached.headers.get('x-sw-cached-at') || '0');
    if (Date.now() - cachedAt < API_TTL_MS) {
      return cached;
    }
  }

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
    return response;
  } catch {
    if (cached) return cached; // network failed — fallback to stale cache
  }

  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function navigateWithFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_SHELL);
      cache.put('./index.html', response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(CACHE_SHELL);
    return (await cache.match('./index.html')) || new Response('Offline', { status: 503 });
  }
}

async function precacheShell() {
  const cache = await caches.open(CACHE_SHELL);
  await Promise.all(SHELL_ASSETS.map(async asset => {
    try {
      const response = await fetch(asset, { cache: 'no-cache' });
      if (response.ok || response.type === 'opaque') {
        await cache.put(asset, response);
      }
    } catch {
      // Non-critical asset failures should not block SW install.
    }
  }));
}
