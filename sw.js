// Service worker: κρατά την εφαρμογή διαθέσιμη και χωρίς σύνδεση.
// Άλλαξε το VERSION όταν ανεβάζεις νέα έκδοση ώστε να ανανεωθεί η cache.
const VERSION = 'nutrilog-v3';
const SHELL = ['./', './index.html', './config.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const CDN = 'cdn.jsdelivr.net';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Η βιβλιοθήκη του Supabase από το CDN: cache-first (η έκδοση δεν αλλάζει συχνά).
  if (url.host === CDN) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
      return res;
    })));
    return;
  }
  // Supabase (σύνδεση, δεδομένα, AI) και οτιδήποτε άλλο εξωτερικό πάνε πάντα στο δίκτυο.
  if (url.origin !== self.location.origin) return;
  // Network-first: παίρνει την τελευταία έκδοση όταν υπάρχει ίντερνετ, αλλιώς από την cache.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
