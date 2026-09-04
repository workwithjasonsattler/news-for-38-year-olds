const SHELL_CACHE = "source-app-shell-v13";
const DATA_CACHE = "source-app-data-v13";

const SHELL_ASSETS = [
  "/source/",
  "/source/index.html",
  "/source/source.css",
  "/source/source.js",
  "/source/manifest.json",
  "/source/icons/icon-192.png",
  "/source/icons/icon-512.png",
];

// Public, read-mostly GET endpoints that back the app's main tabs on
// first paint — safe to show a cached copy instantly while quietly
// refreshing in the background (stale-while-revalidate), since none of
// this is personalized or mutates. Deliberately NOT including anything
// reader-specific (my/*, me, an individual mix view whose is_owner flag
// depends on who's asking) or already-mutation-adjacent — those stay
// network-only, same as before.
const SWR_PATHS = new Set([
  "/api/dispatches",
  "/api/actions-feed",
  "/api/nerve-center/bluesky",
  "/api/nerve-center/chatter",
  "/api/sources",
  "/api/video-feed",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k)))
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

  // Public data endpoints (see SWR_PATHS above): genuine
  // stale-while-revalidate. If a cached copy exists, return it
  // IMMEDIATELY — no network wait at all — and kick off a background
  // fetch to refresh the cache for next time. Only wait on the network
  // when there's nothing cached yet (a reader's very first-ever visit).
  // This is the main perceived-speed win: every repeat visit to Read,
  // Buzz, or Sources paints instantly from the last-known copy instead
  // of blocking on a fresh round-trip every single time, at the cost of
  // being up to one refresh cycle stale — an acceptable tradeoff for
  // news content that's already cached server-side for a while anyway.
  if (url.origin === self.location.origin && SWR_PATHS.has(url.pathname) && !url.search) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const refresh = fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => null);
        if (cached) return cached; // don't await refresh — let it update the cache quietly in the background
        const fresh = await refresh;
        return fresh || new Response("[]", { headers: { "Content-Type": "application/json" } });
      })
    );
    return;
  }

  // Everything else (Sources' personalized bits, You, spray-bar, custom
  // sources, an individual mix view, paywall status, etc.): network
  // only, no caching — this is either personalized, dynamic, or
  // mutation-adjacent, and shouldn't ever silently go stale.
});
