/* global self, caches, fetch, URL, Response */
const VERSION = 'nix-pwa-dev';
// VERSION, ASSETS, SHELL_ASSETS and SHELL_ENTRY are placeholders the build replaces (vite.config.ts)
// with this build's own values, so one worker version always serves one coherent application: its
// own document, and the scripts and styles that document names.
const ASSETS = ['/offline.html', '/nix-icon-192.png', '/nix-icon-512.png'];
const SHELL_ASSETS = ['/offline.html', '/nix-icon-192.png', '/nix-icon-512.png'];
const SHELL_ENTRY = null;
const SHELL_DOCUMENT = '/index.html';
const knownAssets = new Set(ASSETS);
// Client-side routes the shell may answer. An allowlist, not "anything without an extension":
// the object store's capability URLs are served from this origin under a deployment-chosen path,
// and a navigation to one must reach the network rather than be swallowed by the application.
const APP_ROUTE_PREFIXES = ['/w/', '/workspaces/', '/launch/'];

function isAppNavigation(url) {
  return (
    url.pathname === '/' ||
    APP_ROUTE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
  );
}

async function precacheShell() {
  const cache = await caches.open(VERSION);
  await cache.addAll(SHELL_ASSETS);
  if (SHELL_ENTRY === null) return;
  // Refuse to install a shell whose document belongs to a different build - a deploy landing
  // between this worker's download and its install - rather than pairing it with these scripts.
  const shell = await cache.match(SHELL_DOCUMENT);
  const text = shell ? await shell.clone().text() : '';
  if (!text.includes(SHELL_ENTRY)) {
    await cache.delete(SHELL_DOCUMENT);
    throw new Error('The application document does not match this worker build.');
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell());
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
        // `ignoreVary`: a module script asks with an Origin header the install-time fetch did not
        // send, and a server that answers `Vary: Origin` would otherwise make every precached
        // script a miss exactly when there is no network. A hashed build file never varies.
        const cached = await cache.match(request, { ignoreVary: true });
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && !response.redirected && response.type !== 'opaque')
          await cache.put(request, response.clone()).catch(() => undefined);
        return response;
      }),
    );
  } else if (request.mode === 'navigate' && isAppNavigation(url)) {
    // The installed shell opens at once and without a network, like an installed application; a
    // newer build arrives through the update prompt rather than halfway through a launch. The
    // document holds no user data - the session and every item still come from Core.
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const shell = await cache.match(SHELL_DOCUMENT);
        if (shell) return shell;
        try {
          return await fetch(request);
        } catch {
          return (await cache.match('/offline.html')) ?? Response.error();
        }
      }),
    );
  }
});
