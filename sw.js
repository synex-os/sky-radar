// Служебный работник: приложение открывается и без сети, а на Android показывает уведомления о пролётах.
// Сайт и орбиты — «сначала сеть»: свежее, если есть связь, иначе последнее сохранённое.
// Шрифты — «сначала кэш»: они не меняются. Самолёты и маршруты живые — их не храним.
const CACHE = 'sky-radar-v1';
const SHELL = ['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req, { signal: AbortSignal.timeout(15000) });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./')) || Response.error();
  }
}
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) e.respondWith(networkFirst(req));
  else if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') e.respondWith(cacheFirst(req));
  // всё остальное (самолёты, маршруты, CelesTrak) — напрямую в сеть
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(ws => (ws.length ? ws[0].focus() : self.clients.openWindow('./'))));
});
