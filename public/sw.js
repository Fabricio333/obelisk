// Service worker for installability plus small, safe caches.
//
// Cached:
//   - same-origin hashed Next static assets (`/_next/static/*`)
//   - same-origin public image/font assets and the web manifest
//   - the `/app` navigation shell as a network-first offline fallback
//
// Not cached:
//   - non-GET requests
//   - cross-origin relay, analytics, Blossom, wallet, and image requests
//   - `/api/*`, auth/session/storage-looking routes, `/_next/data/*`, `/sw.js`
//   - localStorage/IndexedDB state (service workers cannot read it)
//
// Bump CACHE_VERSION to force every installed client to re-evaluate the
// cache namespace and reload once after activation.
const CACHE_VERSION = 'obelisk-v8-static-shell-cache';
const STATIC_CACHE = `${CACHE_VERSION}:static`;
const SHELL_CACHE = `${CACHE_VERSION}:shell`;
const APP_SHELL_KEY = '/app';
const PRECACHE_URLS = [
  APP_SHELL_KEY,
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/obelisk-favicon.png',
];

const PUBLIC_ASSET_RE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf)$/i;
const BYPASS_PATH_RE = /(?:^|\/)(?:api|auth|session|storage)(?:\/|$)/i;

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function isCacheableResponse(response) {
  return response && response.ok && (response.type === 'basic' || response.type === 'default');
}

function shouldBypassRequest(request, url) {
  if (request.method !== 'GET') return true;
  if (!sameOrigin(url)) return true;
  if (url.pathname === '/sw.js') return true;
  if (url.pathname.startsWith('/_next/data/')) return true;
  if (url.pathname.startsWith('/_next/webpack-hmr')) return true;
  if (BYPASS_PATH_RE.test(url.pathname)) return true;
  return false;
}

function isStaticAsset(request, url) {
  if (url.pathname.startsWith('/_next/static/')) return true;
  if (url.pathname === '/manifest.webmanifest') return true;
  if (PUBLIC_ASSET_RE.test(url.pathname)) return true;
  return ['font', 'image', 'manifest', 'script', 'style'].includes(request.destination);
}

function isAppShellNavigation(url) {
  return url.pathname === '/' || url.pathname === '/app' || url.pathname.startsWith('/app/');
}

async function putIfCacheable(cache, key, response) {
  if (!isCacheableResponse(response)) return;
  await cache.put(key, response.clone());
}

async function fetchAndCache(request, cache) {
  const response = await fetch(request);
  await putIfCacheable(cache, request, response);
  return response;
}

async function precache() {
  const cache = await caches.open(STATIC_CACHE);
  await Promise.allSettled(
    PRECACHE_URLS.map(async (url) => {
      const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
      await putIfCacheable(cache, url, response);
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await precache();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([STATIC_CACHE, SHELL_CACHE]);
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('obelisk-v') && !keep.has(key))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: 'OBELISK_SW_UPDATED', version: CACHE_VERSION });
      }
    })(),
  );
});

async function handleStaticAsset(event) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(event.request);
  if (cached) {
    event.waitUntil(fetchAndCache(event.request, cache).catch(() => undefined));
    return cached;
  }
  return fetchAndCache(event.request, cache);
}

async function handleNavigation(event, url) {
  if (!isAppShellNavigation(url)) return fetch(event.request);

  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(event.request);
    await putIfCacheable(cache, APP_SHELL_KEY, response);
    return response;
  } catch (err) {
    const cached = await cache.match(APP_SHELL_KEY) || await caches.match(APP_SHELL_KEY);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (shouldBypassRequest(request, url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event, url));
    return;
  }

  if (isStaticAsset(request, url)) {
    event.respondWith(handleStaticAsset(event));
  }
});
