
const CACHE_NAME = "trading-pwa-v1";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./decimal_fp.js",
  "./storage.js",
  "./csv.js",
  "./sources.js",
  "./model.js",
  "./charts.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event)=>{
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache=>cache.addAll(CORE_ASSETS)).then(()=>self.skipWaiting())
  );
});

self.addEventListener("activate", (event)=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.map(k=>k===CACHE_NAME?null:caches.delete(k)))).then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch", (event)=>{
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Same-origin: cache-first
  if (url.origin === location.origin){
    event.respondWith(
      caches.match(req).then(cached=>{
        if (cached) return cached;
        return fetch(req).then(resp=>{
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(cache=>cache.put(req, copy)).catch(()=>{});
          return resp;
        }).catch(()=>cached);
      })
    );
    return;
  }

  // Cross-origin: network-first with cache fallback
  event.respondWith(
    fetch(req).then(resp=>{
      const copy = resp.clone();
      caches.open(CACHE_NAME).then(cache=>cache.put(req, copy)).catch(()=>{});
      return resp;
    }).catch(()=>caches.match(req))
  );
});
