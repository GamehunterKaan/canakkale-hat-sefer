// Service worker — handles incoming Web Push messages and notification clicks

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(clients.claim()));

self.addEventListener('push', event => {
  let title = 'Çanakkale Hat & Sefer';
  let body  = 'Otobüs yaklaşıyor.';
  let tag   = 'bus-notify';

  if (event.data) {
    try {
      const d = event.data.json();
      title = d.title || title;
      body  = d.body  || body;
      tag   = d.tag   || tag;
    } catch {}
  }

  const base = self.registration.scope;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon:  base + 'icons/web-app-manifest-192x192.png',
      badge: base + 'icons/favicon-96x96.png',
      data:  { url: base },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || self.location.origin;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(target) && 'focus' in c) return c.focus();
      }
      return clients.openWindow(target);
    })
  );
});
