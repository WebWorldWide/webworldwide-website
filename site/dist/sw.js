/* Web World Wide — service worker
 *
 * Strategy:
 *   - static assets (CSS/JS/fonts/images): stale-while-revalidate
 *   - HTML pages: network-first with 4s timeout, fall back to cache,
 *     fall back to an offline page if both fail
 *   - opaque/external requests: passthrough
 *
 * Cache versioning is in the cache name — bump WWW_CACHE_VERSION on
 * any sw.js change to force clients to refresh.
 */
// Bump on any sw.js change OR when the immutable asset hash strategy
// changes. v3: latin-only font subsets + font preload (CSS/font hashes
// changed); old entries are evicted on activate.
const WWW_CACHE_VERSION = 'v3';
const STATIC_CACHE = `www-static-${WWW_CACHE_VERSION}`;
const HTML_CACHE = `www-html-${WWW_CACHE_VERSION}`;
const ALL_CACHES = [STATIC_CACHE, HTML_CACHE];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(HTML_CACHE).then((c) => c.add('/offline.html').catch(() => {})));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !ALL_CACHES.includes(k)).map((k) => caches.delete(k))),
      ),
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
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(req));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(HTML_CACHE);
  try {
    const fresh = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    const offline = await cache.match('/offline.html');
    return offline ?? new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || new Response('Offline', { status: 503 });
}
