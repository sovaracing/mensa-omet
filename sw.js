/* Omet – Mensa · service worker: app installabile, apertura veloce e senza rete.
   Le chiamate al backend (Google Apps Script) non passano mai dalla cache. */
const CACHE = "omet-mensa-v0.2.1";
const SHELL = ["./", "index.html", "config.js", "manifest.webmanifest", "js/core.js", "js/demo-env.js", "js/menu-pdf.js", "js/demo-menu.js",
  "icons/logo-bianco.png", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png", "icons/favicon-64.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("omet-mensa-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin) return;           // backend e siti esterni: sempre in rete
  if (r.mode === "navigate") {                                                // pagina: rete, se manca la copia salvata
    e.respondWith(fetch(r).then(res => { const c = res.clone(); caches.open(CACHE).then(k => k.put("index.html", c)); return res; })
      .catch(() => caches.match("index.html")));
    return;
  }
  if (u.pathname.endsWith("config.js")) {                                     // configurazione: rete prima, così il cambio di indirizzo vale subito
    e.respondWith(fetch(r).then(res => { const c = res.clone(); caches.open(CACHE).then(k => k.put(r, c)); return res; }).catch(() => caches.match(r)));
    return;
  }
  e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => {      // resto: cache, poi rete (pdf.js si salva al primo uso)
    if (res.ok) { const c = res.clone(); caches.open(CACHE).then(k => k.put(r, c)); }
    return res;
  })));
});
