// Служебный работник: нужен, чтобы на Android показывать уведомления о пролётах.
// Ничего не кэширует — сайт всегда свежий.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(ws => (ws.length ? ws[0].focus() : self.clients.openWindow('./'))));
});
