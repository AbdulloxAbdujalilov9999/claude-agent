// Mina's service worker: makes her installable and opens the right conversation
// when a notification is clicked. It never caches API calls.
const SHELL = "mina-shell-v2";
const SHELL_FILES = ["/", "/app.css", "/app.js", "/favicon.svg", "/vendor/marked.js", "/vendor/purify.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Network first for the app shell, so a deploy shows up right away; cache only when offline.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || !SHELL_FILES.includes(url.pathname)) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const client = clients[0];
      if (client) {
        client.focus();
        if (sessionId) client.postMessage({ open: sessionId });
        return;
      }
      return self.clients.openWindow(sessionId ? `/?s=${encodeURIComponent(sessionId)}` : "/");
    })
  );
});

// Sent by the Mina server when a conversation finishes or needs a decision, even if no window is open.
self.addEventListener("push", (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {}
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const watching = clients.some((c) => c.visibilityState === "visible" && c.focused);
      return self.registration.showNotification(msg.title || "Mina", {
        body: msg.body || "",
        tag: msg.sessionId ? `${msg.sessionId}:${msg.kind}` : "mina",
        icon: "/icons/icon-192.png",
        badge: "/icons/badge.png",
        data: { sessionId: msg.sessionId },
        silent: watching, // she's on screen already; don't make noise
        requireInteraction: msg.kind === "waiting",
      });
    })
  );
});
