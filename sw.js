// アプリ本体(画面のファイル)だけをオフライン用に保存する。教材データはここには入らない。
const V = 'kansa-app-v2-r3', FILES = ['./', 'index.html', 'style.css', 'js/main.js', 'js/db.js', 'js/zip.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => { if (e.request.method === 'GET') e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request))); });
