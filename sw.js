// Service worker: κρατά την εφαρμογή διαθέσιμη και χωρίς σύνδεση.
// Άλλαξε το VERSION όταν ανεβάζεις νέα έκδοση ώστε να ανανεωθεί η cache.
const VERSION = 'nutrilog-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

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
  // Οι κλήσεις στο Gemini και οτιδήποτε εξωτερικό πάνε πάντα στο δίκτυο.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Network-first: παίρνει την τελευταία έκδοση όταν υπάρχει ίντερνετ, αλλιώς από την cache.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
