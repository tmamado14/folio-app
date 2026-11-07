// Keeps the app working offline. The build fills in VERSION and FILES.

const VERSION = '__VERSION__';
const FILES = __FILES__;
const CACHE = `folio-${VERSION}`;
const RUNTIME = 'folio-runtime';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('folio-') && n !== CACHE && n !== RUNTIME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  event.respondWith((async () => {
    const hit = await caches.match(event.request, { ignoreSearch: true });
    if (hit) return hit;
    if (event.request.mode === 'navigate') {
      const shell = await caches.match(new URL('index.html', self.registration.scope));
      if (shell) return shell;
    }
    const response = await fetch(event.request);
    // The voice runtime is large, so it is kept only once it has actually been used.
    if (response.ok && url.pathname.includes('/vendor/')) {
      const cache = await caches.open(RUNTIME);
      await cache.put(event.request, response.clone());
    }
    return response;
  })());
});
