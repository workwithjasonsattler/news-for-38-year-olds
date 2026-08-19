const SHELL_CACHE = "source-app-shell-v3";
const WIRE_CACHE = "source-app-wire-v3";

const SHELL_ASSETS = [
  "/source/",
  "/source/index.html",
  "/source/source.css",
  "/source/source.js",
  "/source/manifest.json",
  "/source/icons/icon-192.png",
  "/source/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== WIRE_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // writes always go straight to the network
  const url = new URL(req.url);

  // App shell assets: cache-first, refresh cache in the background.
  if (url.origin === self.location.origin && url.pathname.startsWith("/source/")) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          if (res.ok) caches.open(SHELL_CACHE).then((c) => c.put(req, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Unfiltered wire (Read tab, /api/dispatches with no query string):
  // network-first, falls back to the last successful response offline.
  // Same basic-offline-only scope as the app shell's own sw.
  if (url.pathname === "/api/dispatches" && !url.search) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) caches.open(WIRE_CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Everything else (Sources/Buzz/You, personalized or dynamic): network
  // only, no caching.
});
