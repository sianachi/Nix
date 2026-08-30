/* global self */
/* Nix metadata writes remain online-only. This worker supplies an installed-app lifecycle without
   caching authenticated HTML or API responses and making stale data look current. */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
