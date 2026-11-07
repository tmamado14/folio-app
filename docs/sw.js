// Keeps the app working offline, and adds the headers that let the voice engine use
// more than one CPU core, which GitHub Pages can't send. The build fills in VERSION
// and FILES.

const VERSION = 'ab162be413b2';
const FILES = ["./","css/app.css","css/page.css","css/reader.css","css/shelf.css","css/web.css","fonts/literata-latin-ext-wght-italic.woff2","fonts/literata-latin-ext-wght-normal.woff2","fonts/literata-latin-wght-italic.woff2","fonts/literata-latin-wght-normal.woff2","fonts/Literata-OFL.txt","icons/icon-180.png","icons/icon-192.png","icons/icon-512.png","index.html","js/app.js","js/book.js","js/folio-web.js","js/narrator.js","js/pager.js","js/player.js","js/reader.js","js/sentences.js","js/shelf.js","js/ui.js","js/voice-worker.js","manifest.webmanifest"];
const CACHE = `folio-${VERSION}`;
const RUNTIME = 'folio-runtime';

function withIsolation(response) {
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

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
    if (hit) return withIsolation(hit);
    if (event.request.mode === 'navigate') {
      const shell = await caches.match(new URL('index.html', self.registration.scope));
      if (shell) return withIsolation(shell);
    }
    const response = await fetch(event.request);
    // The voice runtime is large, so it is kept only once it has actually been used.
    if (response.ok && url.pathname.includes('/vendor/')) {
      const cache = await caches.open(RUNTIME);
      await cache.put(event.request, response.clone());
    }
    return withIsolation(response);
  })());
});
