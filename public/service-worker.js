/* TapTots Service Worker — v4
 * Strategy: cache-first for static shell, network-first for API calls.
 * Keeps it simple and safe — no stale deployment risk.
 */

const CACHE_NAME = 'taptots-v4';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/play.html',
  '/auth.js',
  '/manifest.json'
  /* Game files are cached on first visit, not precached,
     so a broken game file never blocks the install step. */
];

/* ── Install: cache the shell ── */
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      /* addAll fails silently per-item so a missing icon won't break install */
      return Promise.allSettled(
        PRECACHE_URLS.map(function(url) { return cache.add(url); })
      );
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

/* ── Activate: delete old caches ── */
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k)  { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

/* ── Fetch ── */
self.addEventListener('fetch', function(event) {
  var url = event.request.url;
  var method = event.request.method;

  /* Never intercept non-GET, API calls, Supabase, or Stripe */
  if (method !== 'GET') return;
  if (url.includes('/api/'))            return;
  if (url.includes('supabase.co'))      return;
  if (url.includes('stripe.com'))       return;
  if (url.includes('fonts.googleapis')) return;
  if (url.includes('cdn.jsdelivr'))     return;

  event.respondWith(
    caches.match(event.request).then(function(cached) {
      /* Serve from cache if available, fetch in background to update */
      var networkFetch = fetch(event.request).then(function(response) {
        if (response && response.status === 200 && response.type === 'basic') {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function() { return null; });

      return cached || networkFetch;
    })
  );
});
