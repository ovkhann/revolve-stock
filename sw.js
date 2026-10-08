/* Service worker : l'appli s'ouvre même sans réseau. */
const VERSION = "rr-v4";
const SHELL = ["./", "./index.html", "./logo.png", "./local-runtime.js", "./chat.js", "./chat-config.js", "./pdf-lib.min.js", "./manifest.webmanifest", "./apple-touch-icon.png", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  // page : réseau d'abord (pour recevoir les mises à jour), cache si hors ligne
  if (req.mode === "navigate"){
    e.respondWith(fetch(req).then(r => { const cp = r.clone(); caches.open(VERSION).then(c => c.put("./index.html", cp)); return r; }).catch(() => caches.match("./index.html")));
    return;
  }
  // polices Google et fichiers de l'appli : cache d'abord, mise à jour en arrière-plan
  if (url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) || (url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("@supabase/supabase-js@"))){
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});

/* ---------- notifications du chat ---------- */
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch(x){ d = {title:"Revolve Chat", body:e.data ? e.data.text() : ""}; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || "Revolve Chat", {
      body:d.body || "Nouveau message", tag:d.tag || "rr-chat", renotify:true,
      icon:"icon-192.png", badge:"icon-192.png", data:{conversation_id:d.conversation_id || null}
    });
    try { const n = (await self.registration.getNotifications()).length; if (self.navigator.setAppBadge) await self.navigator.setAppBadge(n); } catch(x){}
  })());
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const cid = e.notification.data?.conversation_id;
  e.waitUntil((async () => {
    const all = await clients.matchAll({type:"window", includeUncontrolled:true});
    for (const c of all){ if ("focus" in c){ await c.focus(); if (cid) c.postMessage({type:"open-conv", conversation_id:cid}); return; } }
    await clients.openWindow("./" + (cid ? "#chat-" + cid : ""));
  })());
});
