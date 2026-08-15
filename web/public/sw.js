const SHELL_CACHE = 'ours-messenger-shell-v1';
const SHELL = ['/', '/chats', '/manifest.webmanifest', '/icon.svg', '/maskable-icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(SHELL_CACHE).then((cache) => cache.put('/', response.clone()));
      return response;
    }).catch(() => caches.match('/')));
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname === '/icon.svg' || url.pathname === '/maskable-icon.svg') {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) caches.open(SHELL_CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    })));
  }
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const title = typeof payload.title === 'string' ? payload.title : 'ours messenger';
  const body = typeof payload.body === 'string' ? payload.body : 'Open messenger to view the update.';
  const url = typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/chats';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: typeof payload.wire_id === 'string' ? `ours-${payload.wire_id}` : undefined,
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data && typeof event.notification.data.url === 'string'
    ? event.notification.data.url
    : '/chats';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
    for (const client of clients) {
      if ('navigate' in client) await client.navigate(url);
      return client.focus();
    }
    return self.clients.openWindow(url);
  }));
});
