// Serves the app shell (index.html) from cache so a return visit renders without waiting for the
// network, then refreshes the cached copy for the next visit. Hashed assets stay with the HTTP cache.
const shellCache = 'shell-v1';
const shellUrl = '/';

self.addEventListener('install', event => {
  // Only navigations need this worker; everything else skips it (Chrome 123+ static routing).
  if (event.addRoutes)
    event.waitUntil(event.addRoutes({ condition: { not: { requestMode: 'navigate' } }, source: 'network' }));
  event.waitUntil(refreshShell());
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== shellCache).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.mode !== 'navigate' || request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/assets/')) return;
  event.respondWith(
    caches.match(shellUrl, { cacheName: shellCache }).then(cached => {
      const fresh = refreshShell();
      if (cached) {
        event.waitUntil(fresh);
        return cached;
      }
      return fresh.then(response => response ?? fetch(request));
    }),
  );
});

async function refreshShell() {
  try {
    const response = await fetch(shellUrl, { cache: 'no-cache', credentials: 'same-origin' });
    if (!response.ok || response.redirected || !response.headers.get('content-type')?.includes('text/html'))
      return null;
    await (await caches.open(shellCache)).put(shellUrl, response.clone());
    return response;
  } catch {
    return null;
  }
}
