self.addEventListener("push", e => {
  let d = {}; try { d = e.data.json(); } catch (x) {}
  e.waitUntil((async () => {
    const cs = await clients.matchAll({ type: "window", includeUncontrolled: true });
    if (cs.some(c => c.visibilityState === "visible")) return; // the open page already shows it
    await self.registration.showNotification(d.title || "Holo Bid", { body: d.body || "", icon: "/icon.svg", badge: "/icon.svg", tag: d.tag, data: { url: d.url || "/" } });
  })());
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil((async () => {
    const cs = await clients.matchAll({ type: "window", includeUncontrolled: true });
    if (cs.length) return cs[0].focus();
    return clients.openWindow(e.notification.data.url || "/");
  })());
});
