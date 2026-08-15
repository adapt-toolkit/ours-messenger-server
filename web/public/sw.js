// Ported from ours-control-plane's proven updater. build.mjs replaces this
// stamp on every release so browsers always see different service-worker bytes.
// This worker deliberately caches no application shell: keeping an old HTML
// document and hashed JS chunks in Cache Storage can strand an installed PWA
// on a blank screen during a deployment.
const SW_BUILD = '__MESSENGER_BUILD_SHA__';
const FOREGROUND_HEARTBEAT_FRESH_MS = 30_000;
let lastVisibility = null;
let lastIOSStandalone = false;

// WindowClient.visibilityState is not authoritative on mobile PWAs. Suppress
// only when a page-owned heartbeat is fresh and explicitly visible. Installed
// iOS always shows because its service worker can be torn down between events.
function shouldSuppressNotification(clientList, visibility, now, freshMs, iosStandalone) {
  if (!clientList || clientList.length === 0 || iosStandalone) return false;
  const current = visibility === undefined ? lastVisibility : visibility;
  const time = now === undefined ? Date.now() : now;
  const fresh = freshMs === undefined ? FOREGROUND_HEARTBEAT_FRESH_MS : freshMs;
  return !!current && time - current.ts <= fresh && current.state === 'visible';
}

function queryClientsVisible(clientList, timeoutMs) {
  if (!clientList || clientList.length === 0) return Promise.resolve(false);
  const timeout = typeof timeoutMs === 'number' ? timeoutMs : 400;
  return new Promise((resolve) => {
    let replies = 0;
    let visible = false;
    let iosStandalone = false;
    let settled = false;
    const ports = [];
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const port of ports) { try { port.close(); } catch { /* closed */ } }
      resolve(visible && !iosStandalone);
    };
    const replied = (data) => {
      replies++;
      if (data?.iosStandalone === true) iosStandalone = true;
      if (data?.state === 'visible') visible = true;
      if (replies >= clientList.length) finish();
    };
    for (const client of clientList) {
      try {
        const channel = new MessageChannel();
        ports.push(channel.port1);
        channel.port1.onmessage = (event) => replied(event.data);
        client.postMessage({ type: 'ours-visibility-query' }, [channel.port2]);
      } catch {
        replied(null);
      }
    }
    timer = setTimeout(finish, timeout);
  });
}

function safeNotificationUrl(value, origin) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/chats';
  try {
    const parsed = new URL(value, origin);
    if (parsed.origin !== origin || !parsed.pathname.startsWith('/')) return '/chats';
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return '/chats';
  }
}

function selectClickTarget(clientList, origin, targetUrl) {
  const safe = (clientList || []).filter((client) => {
    try { return new URL(client.url).origin === origin; } catch { return false; }
  });
  if (targetUrl) {
    const target = new URL(targetUrl, origin).href;
    const exact = safe.find((client) => client.url === target);
    if (exact) return exact;
  }
  return safe.find((client) => client.focused) || safe[0] || null;
}

function selectForegroundClient(clientList, origin) {
  const safe = (clientList || []).filter((client) => {
    try { return new URL(client.url).origin === origin; } catch { return false; }
  });
  return safe.find((client) => client.visibilityState === 'visible') || safe[0] || null;
}

function safeText(value, fallback, max) {
  return typeof value === 'string' && value.trim() ? value.slice(0, max) : fallback;
}

// Exact ours-control-plane lifecycle: activate immediately, claim existing
// windows, and purge every legacy app-shell cache. HTML and hashed bundles then
// always come from the server's current immutable release.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch { /* Cache API may be unavailable; nothing to purge. */ }
    try {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) client.postMessage({ type: 'ours-sw-activated', build: SW_BUILD });
    } catch { /* no clients */ }
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data?.type === 'ours-visibility' && (data.state === 'visible' || data.state === 'hidden')) {
    lastVisibility = { state: data.state, ts: typeof data.ts === 'number' ? data.ts : Date.now() };
    lastIOSStandalone = data.iosStandalone === true;
    return;
  }
  if (data?.type === 'ours-clear-notifications') {
    event.waitUntil((async () => {
      const notifications = await self.registration.getNotifications();
      for (const notification of notifications) notification.close();
      if ('clearAppBadge' in self.navigator) await self.navigator.clearAppBadge().catch(() => {});
    })());
  }
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  const title = safeText(payload.title, 'ours messenger', 160);
  const body = safeText(payload.body, 'Open messenger to view the update.', 512);
  const url = safeNotificationUrl(payload.url, self.location.origin);
  const tag = typeof payload.wire_id === 'string' && payload.wire_id
    ? `ours-${payload.wire_id.slice(0, 256)}` : undefined;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
    const suppress = shouldSuppressNotification(clientList, undefined, undefined, undefined, lastIOSStandalone)
      || await queryClientsVisible(clientList);
    if (suppress) {
      selectForegroundClient(clientList, self.location.origin)?.postMessage({
        type: 'ours-push-foreground', kind: payload.kind,
        contact_id: payload.contact_id, wire_id: payload.wire_id,
      });
      return;
    }
    await self.registration.showNotification(title, {
      body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag, data: { url },
    });
    if ('setAppBadge' in self.navigator) {
      const notifications = await self.registration.getNotifications();
      await self.navigator.setAppBadge(notifications.length).catch(() => {});
    }
  }));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
    for (const client of clientList) client.postMessage({ type: 'ours-push-repair-required' });
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeNotificationUrl(event.notification.data?.url, self.location.origin);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
    const target = selectClickTarget(clientList, self.location.origin, url);
    if (target) {
      const desired = new URL(url, self.location.origin).href;
      if (target.url !== desired && 'navigate' in target) await target.navigate(desired);
      return target.focus();
    }
    return self.clients.openWindow(url);
  }));
});
