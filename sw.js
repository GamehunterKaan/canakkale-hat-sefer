// Service worker — handles incoming Web Push messages and notification clicks

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(clients.claim()));

self.addEventListener('push', event => {
  if (!event.data) return;
  const d = event.data.json();
  event.waitUntil(
    self.registration.showNotification(d.title, {
      body:  d.body,
      tag:   d.tag  || 'bus-notify',
      icon:  d.icon || null,
      badge: d.icon || null,
      data:  { url: self.location.origin + self.location.pathname.replace('sw.js','') }
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
