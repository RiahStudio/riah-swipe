// service-worker.js
// PWA layer. Two cache strategies, one versioned cache namespace.
//
//   App shell (HTML/CSS/JS/icons/manifest):  cache-first
//   Data (./data/, ./decks/, or /api/):     network-first, fall back to cache
//
// Bump SW_VERSION on every deployment that ships new shell assets — the old
// cache is purged during activate, and skipWaiting + clients.claim makes the
// new SW take over immediately rather than waiting for every tab to close.

const SW_VERSION   = 'v1.0.0-oss';
const SHELL_CACHE  = `rs-shell-${SW_VERSION}`;
// Data cache is NOT versioned with the shell. Bumping SW_VERSION used to wipe
// every cached deck image (~1GB) and then the picker re-downloaded them all,
// which made the next open crawl. Deck JSON still refreshes via network-first
// on the manifest.
const DATA_CACHE   = 'rs-data-v1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/app.css',
  './src/app.js',
  './src/swipe-view.js',
  './src/history-view.js',
  './src/data/model.js',
  './src/data/store.js',
  './src/data/deck-loader.js',
  './src/logic/approved-thumb.js',
  './src/logic/deck-sort.js',
  './src/logic/finished-hold.js',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  './icon-192.png',
  './icon-512.png',
];

// ── Install: pre-cache the shell ────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll fails atomically if any asset 404s. We use cache.add per-asset
      // so a single missing optional asset (e.g. PNG icon) doesn't block
      // install. Logs the offenders for debugging.
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] precache skipped:', url, err);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: purge old caches, take control ────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => {
              if (k === SHELL_CACHE || k === DATA_CACHE) return false;
              // Keep any prior data cache so a shell bump does not flush media.
              if (k.startsWith('rs-data-')) return false;
              return true;
            })
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch routing ───────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Skip cross-origin requests (fonts, analytics) — let the network handle.
  if (url.origin !== self.location.origin) return;

  // The deck MANIFEST stays network-first: it must be fresh so newly published
  // decks appear and retired decks get purged. (If the manifest goes cache-first
  // the app serves a stale/empty deck list forever — the "board shows
  // nothing" bug. Keep it network-first.) Verdict / card-edit
  // data (/data/, /api/) stays network-first too so edits read back fresh.
  if (url.pathname.endsWith('/decks/index.json')) {
    event.respondWith(networkFirst(req));
    return;
  }
  // JS/CSS must not cache-first: a 401/504 cached shell is how /swipe/
  // painted the header and nothing else on phones.
  // Covers app.js and deck-sort.js, which used to be the only two listed.
  if (/\/src\/.+\.js(\?|$)/.test(url.pathname) || url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (url.pathname.includes('/data/') || url.pathname.includes('/api/')) {
    event.respondWith(networkFirst(req));
    return;
  }
  // Deck JSON is network-first so a just-published clock actually lands.
  // Pictures stay cache-first — a picker of 4MB covers used to revalidate
  // every file on open and freeze the local server.
  if (url.pathname.includes('/decks/')) {
    if (/\.(png|jpe?g|gif|webp|mp4|webm|mov|mp3|m4a|wav|ogg)$/i.test(url.pathname)) {
      event.respondWith(dataCacheFirst(req));
      return;
    }
    event.respondWith(networkFirst(req));
    return;
  }

  // Navigation requests (SPA-style): always serve index.html shell on miss.
  if (req.mode === 'navigate') {
    event.respondWith(navigationHandler(req));
    return;
  }

  // Everything else (shell): cache-first.
  event.respondWith(cacheFirst(req));
});

// ── Strategies ─────────────────────────────────────────────────────────────-

async function cacheFirst(req) {
  const cache  = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req) || await cache.match(req, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    // Last-ditch: return a synthetic offline response so the browser doesn't
    // throw an opaque network error for shell asset requests.
    return new Response('', { status: 504, statusText: 'Offline (shell miss)' });
  }
}

async function dataCacheFirst(req) {
  const cache  = await caches.open(DATA_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'Offline (media miss)' });
  }
}

async function networkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req) || await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    const shell = await caches.open(SHELL_CACHE);
    const fromShell = await shell.match(req, { ignoreSearch: true });
    if (fromShell) return fromShell;
    return new Response(JSON.stringify({ offline: true, error: 'no cached data' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Stale-while-revalidate: answer from cache immediately (fast), and refresh the
// cached copy from the network in the background for next time. Used for deck
// files + media so opening a deck doesn't wait on the network after the first time.
async function staleWhileRevalidate(event) {
  const req = event.request;
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  // Keep the SW alive long enough to finish the background refresh.
  event.waitUntil(network);
  return (
    cached ||
    (await network) ||
    new Response(JSON.stringify({ offline: true, error: 'no cached data' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

async function navigationHandler(req) {
  try {
    const res = await fetch(req);
    return res;
  } catch (err) {
    const cache  = await caches.open(SHELL_CACHE);
    const cached = await cache.match('./index.html') || await cache.match('./index.html', { ignoreSearch: true });
    if (cached) return cached;
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

// ── Client messaging ────────────────────────────────────────────────────────
// Allow the app to force a SW update / version check from inside the page.
self.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object') return;
  if (event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data.type === 'VERSION') {
    event.source && event.source.postMessage({ type: 'VERSION', version: SW_VERSION });
  }
});
