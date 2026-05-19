// Service worker — handles incoming Web Push messages and notification clicks

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(clients.claim()));

const WORKER_URL = 'https://bus-notify.17bus-notify.workers.dev';

self.addEventListener('push', event => {
  let title = 'Çanakkale Hat & Sefer';
  let body  = 'Otobüs yaklaşıyor.';
  let tag   = 'bus-notify';
  let raw   = '';
  let parseError = '';

  try { raw = event.data ? event.data.text() : ''; } catch (e) { raw = '<text() failed: ' + e.message + '>'; }

  if (event.data) {
    try {
      const d = JSON.parse(raw);
      title = d.title || title;
      body  = d.body  || body;
      tag   = d.tag   || tag;
    } catch (e) { parseError = e.message; }
  } else {
    parseError = 'event.data is null';
  }

  // Phone home: log that SW received a push, with raw payload preview
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body,
      tag,
      icon:  '/icons/web-app-manifest-192x192.png',
      badge: '/icons/favicon-96x96.png',
      data:  { url: self.location.origin + self.location.pathname.replace('sw.js', '') },
    }),
    fetch(WORKER_URL + '/sw-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ts: Date.now(),
        hasData: !!event.data,
        rawPreview: raw.slice(0, 200),
        rawLength: raw.length,
        parseError,
      }),
    }).catch(() => {}),
  ]));
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
