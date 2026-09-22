const CACHE_VERSION = 'v2.0.36';
const CACHE_NAME = `sammia-pharm-shell-${CACHE_VERSION}`;
const CACHE_PREFIX = 'sammia-pharm-shell-';
const LEGACY_CACHE_PREFIX = 'pharmacare-shell-';
const OFFLINE_URL = '/offline.html';

const CORE_ASSETS = [
  '/',
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/favicon.svg',
  '/brand/sammia-mark.png',
  '/brand/sammia-dashboard-real.png',
  '/brand/sammia-pos-mobile-real.png',
  '/brand/sammia-inventory-real.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(CORE_ASSETS.map(async (url) => {
      try {
        const response = await fetch(url, { cache: 'reload' });
        if (response.ok || response.type === 'opaque') {
          await cache.put(url, response);
        }
      } catch {
        // One optional asset must not make the whole service worker installation fail.
      }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => (name.startsWith(CACHE_PREFIX) || name.startsWith(LEGACY_CACHE_PREFIX)) && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'CACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      const sameOriginUrls = data.urls
        .map((value) => {
          try {
            const url = new URL(value, self.location.origin);
            return url.origin === self.location.origin ? url.pathname + url.search : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      await Promise.allSettled(sameOriginUrls.map(async (url) => {
        try {
          const response = await fetch(url, { cache: 'reload' });
          if (response.ok) await cache.put(url, response);
        } catch {
          // Keep any existing cached copy when refreshing an asset fails.
        }
      }));
    })());
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put('/', networkResponse.clone());
        }
        return networkResponse;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('/')) || (await cache.match(OFFLINE_URL)) || Response.error();
      }
    })());
    return;
  }

  const isStaticAsset = ['script', 'style', 'image', 'font', 'manifest'].includes(request.destination)
    || /\.(?:js|css|png|jpg|jpeg|svg|webp|ico|woff2?)$/i.test(url.pathname);

  if (isStaticAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(request);
      const networkPromise = fetch(request)
        .then(async (response) => {
          if (response.ok) await cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      return cachedResponse || (await networkPromise) || Response.error();
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(request)) || Response.error();
    }
  })());
});

// Landing inventory screenshot cache refresh: v9


self.addEventListener('sync', (event) => {
  if (!['sammia-pos-sync', 'sammia-offline-sync'].includes(event.tag)) return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach((client) => client.postMessage({ type: 'SAMMIA_OFFLINE_SYNC_REQUESTED' }));
  })());
});
