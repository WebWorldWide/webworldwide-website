const CACHE_NAME = 'terminal-eighty-cms-v1';

// Only caching static assets, not API calls or HTML that needs auth
const urlsToCache = [
  '/css/admin.css',
  '/manifest.json',
  'https://unpkg.com/@simplewebauthn/browser/dist/bundle/index.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache)));
});

self.addEventListener('fetch', (event) => {
  // Only intercept GET requests
  if (event.request.method !== 'GET') return;

  // Don't intercept API calls
  if (event.request.url.includes('/api/') || event.request.url.includes('/auth/')) return;

  event.respondWith(
    caches.match(event.request).then((response) => {
      // Return cache if found
      if (response) return response;

      // Else fetch from network
      return fetch(event.request).then(function (response) {
        // Check if valid response
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        // Don't cache HTML files as they need auth checking
        if (event.request.url.endsWith('.html')) {
          return response;
        }

        // Clone and cache
        var responseToCache = response.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(event.request, responseToCache);
        });

        return response;
      });
    }),
  );
});
