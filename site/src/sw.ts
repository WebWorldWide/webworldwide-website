/// <reference lib="webworker" />

export {};
declare const self: ServiceWorkerGlobalScope;

/* Web World Wide — service worker
 *
 * Strategy:
 *   - /_assets/* (content-hashed by Vite, never change): cache-first.
 *     GitHub Pages serves everything with max-age=600, so without this
 *     every visit after ten minutes re-downloads ~200KB of fonts/JS, and
 *     stale-while-revalidate re-fetched each one on every page view.
 *   - other static files (images, icons): stale-while-revalidate
 *   - HTML pages: network-first with 4s timeout (using navigation preload
 *     so the request isn't held up while the worker boots), fall back to
 *     cache, fall back to an offline page if both fail
 *   - opaque/external requests: passthrough
 *
 * Cache versioning is in the cache name — bump WWW_CACHE_VERSION on
 * any sw.js change to force clients to refresh.
 */
// Bump on any sw.js change OR when the immutable asset hash strategy
// changes. v3: latin-only font subsets + font preload (CSS/font hashes
// changed); old entries are evicted on activate. v4: cache-first hashed
// assets + navigation preload.
const WWW_CACHE_VERSION = 'v4';
const STATIC_CACHE = `www-static-${WWW_CACHE_VERSION}`;
const HTML_CACHE = `www-html-${WWW_CACHE_VERSION}`;
const ALL_CACHES = [STATIC_CACHE, HTML_CACHE];
// Hashed assets from old deploys pile up in the static cache; keep the
// newest entries only.
const STATIC_MAX_ENTRIES = 150;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(HTML_CACHE).then((c) => c.add('/offline.html').catch(() => {})));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(keys.filter((k) => !ALL_CACHES.includes(k)).map((k) => caches.delete(k))),
        ),
      self.registration.navigationPreload?.enable().catch(() => {}),
    ]),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    event.respondWith(networkFirst(event));
  } else if (url.pathname.startsWith('/_assets/')) {
    event.respondWith(cacheFirst(event));
  } else {
    event.respondWith(staleWhileRevalidate(event));
  }
});

async function networkFirst(event: FetchEvent): Promise<Response> {
  const req = event.request;
  const cache = await caches.open(HTML_CACHE);
  try {
    const preloaded = event.preloadResponse.then((r: Response | undefined) => r ?? fetch(req));
    const fresh = await Promise.race([
      preloaded,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    if (fresh && fresh.ok) event.waitUntil(cache.put(req, fresh.clone()));
    return fresh;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    const offline = await cache.match('/offline.html');
    return offline ?? new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function trim(cache: Cache): Promise<void> {
  const keys = await cache.keys();
  const excess = keys.length - STATIC_MAX_ENTRIES;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

async function store(event: FetchEvent, res: Response): Promise<void> {
  const cache = await caches.open(STATIC_CACHE);
  await cache.put(event.request, res);
  await trim(cache);
}

async function cacheFirst(event: FetchEvent): Promise<Response> {
  const cached = await caches.match(event.request, { cacheName: STATIC_CACHE });
  if (cached) return cached;
  const res = await fetch(event.request);
  if (res.ok) event.waitUntil(store(event, res.clone()));
  return res;
}

async function staleWhileRevalidate(event: FetchEvent): Promise<Response> {
  const req = event.request;
  const cached = await caches.match(req, { cacheName: STATIC_CACHE });
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) event.waitUntil(store(event, res.clone()));
      return res;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) || new Response('Offline', { status: 503 });
}
