/* global self, caches, fetch, URL, Response */
const VERSION = 'nix-pwa-dev';
const ASSETS = ['/offline.html', '/nix-icon-192.png', '/nix-icon-512.png'];
const SHELL_ASSETS = ['/offline.html', '/nix-icon-192.png', '/nix-icon-512.png'];
const knownAssets = new Set(ASSETS);
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL_ASSETS)));
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('nix-pwa-') && key !== VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Auth, API, collaboration and capability URLs always use the network.
  if (knownAssets.has(url.pathname) && url.search === '') {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && !response.redirected && response.type !== 'opaque')
          await cache.put(request, response.clone()).catch(() => undefined);
        return response;
      }),
    );
  } else if (
    request.mode === 'navigate' &&
    (url.pathname === '/' || url.pathname.startsWith('/w/'))
  ) {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(VERSION);
        return (await cache.match('/offline.html')) ?? Response.error();
      }),
    );
  }
});
