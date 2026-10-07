/* Revolve Realm Stock — stockage local (IndexedDB) qui remplace la base en ligne.
   Fournit window.claude.use("db" | "user" | "assets" | "downloads") avec la même API que l'appli attend. */
(() => {
  "use strict";
  const DB_NAME = "revolve-stock", VER = 1;
  let idb = null;
  const docs = new Map();          // "collection/id" -> body
  const assetBlobs = new Map();    // id -> Blob
  const assetURLs = new Map();     // id -> object URL
  const listeners = new Set();     // {kind:"col"|"doc", path, next}

  const openIDB = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VER);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains("docs")) d.createObjectStore("docs"); if (!d.objectStoreNames.contains("assets")) d.createObjectStore("assets"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = (store, mode, fn) => new Promise((res, rej) => {
    const t = idb.transaction(store, mode); const s = t.objectStore(store); const out = fn(s);
    t.oncomplete = () => res(out && "result" in out ? out.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
  const readAll = store => new Promise((res, rej) => {
    const t = idb.transaction(store, "readonly"), s = t.objectStore(store), out = [];
    const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur){ out.push([cur.key, cur.value]); cur.continue(); } else res(out); }; c.onerror = () => rej(c.error);
  });

  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const parentOf = p => p.split("/").slice(0, -1).join("/");
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  const mkSnap = (path, body) => ({id:path.split("/").pop(), exists:body !== undefined, data:() => body === undefined ? undefined : clone(body), metadata:{fromCache:false, hasPendingWrites:false}});
  const colSnap = path => {
    const ds = [...docs.entries()].filter(([p]) => parentOf(p) === path).sort((a,b) => a[0].localeCompare(b[0])).map(([p, b]) => mkSnap(p, b));
    return {docs:ds, size:ds.length, empty:!ds.length, docChanges:() => ds.map((d, i) => ({type:"added", doc:d, oldIndex:-1, newIndex:i})), metadata:{fromCache:false, hasPendingWrites:false}};
  };
  let notifyQueued = new Set();
  const notify = path => {
    notifyQueued.add(path);
    queueMicrotask(() => {
      const paths = notifyQueued; notifyQueued = new Set();
      for (const l of listeners){
        if (l.kind === "col" && [...paths].some(p => parentOf(p) === l.path)) l.next(colSnap(l.path));
        if (l.kind === "doc" && paths.has(l.path)) l.next(mkSnap(l.path, docs.get(l.path)));
      }
    });
  };
  const persist = async (path) => {
    const body = docs.get(path);
    await tx("docs", "readwrite", s => body === undefined ? s.delete(path) : s.put(body, path));
  };
  const deepMerge = (a, b) => {
    const o = (a && typeof a === "object" && !Array.isArray(a)) ? {...a} : {};
    for (const [k, v] of Object.entries(b)){
      if (v && typeof v === "object" && !Array.isArray(v) && v.__delete__ === true){ delete o[k]; continue; }
      o[k] = (v && typeof v === "object" && !Array.isArray(v)) ? deepMerge(o[k], v) : clone(v);
    }
    return o;
  };
  const err = (code, message) => Object.assign(new Error(message), {code});

  function docRef(path){
    return {
      id:path.split("/").pop(), path,
      async get(){ return mkSnap(path, clone(docs.get(path))); },
      async set(data){ if (!data || typeof data !== "object") throw err("invalid_argument", "objet attendu"); docs.set(path, clone(data)); await persist(path); notify(path); },
      async update(data){ if (!docs.has(path)) throw err("invalid_argument", "document absent"); docs.set(path, deepMerge(docs.get(path), data)); await persist(path); notify(path); },
      async delete(){ docs.delete(path); await persist(path); notify(path); },
      onSnapshot(next){ const l = {kind:"doc", path, next}; listeners.add(l); queueMicrotask(() => listeners.has(l) && next(mkSnap(path, docs.get(path)))); return () => listeners.delete(l); },
      collection(sub){ return colRef(path + "/" + sub); },
      async acquire(){ return {acquired:true}; }
    };
  }
  function colRef(path){
    const q = {
      path,
      doc(id){ return docRef(path + "/" + (id || newId())); },
      async add(data){ const r = docRef(path + "/" + newId()); await r.set(data); return r; },
      async get(){ return colSnap(path); },
      onSnapshot(next){ const l = {kind:"col", path, next}; listeners.add(l); queueMicrotask(() => listeners.has(l) && next(colSnap(path))); return () => listeners.delete(l); },
      where(){ return q; }, orderBy(){ return q; }, limit(){ return q; }
    };
    return q;
  }
  const db = {doc:docRef, collection:colRef};

  const assets = {
    async upload(blob, opts = {}){
      const id = newId() + newId(); const b = opts.type && blob.type !== opts.type ? new Blob([blob], {type:opts.type}) : blob;
      assetBlobs.set(id, b); await tx("assets", "readwrite", s => s.put(b, id));
      const url = URL.createObjectURL(b); assetURLs.set(id, url);
      return {id, url, sizeBytes:b.size, contentType:b.type};
    },
    async delete(id){ assetBlobs.delete(id); if (assetURLs.has(id)) URL.revokeObjectURL(assetURLs.get(id)); assetURLs.delete(id); await tx("assets", "readwrite", s => s.delete(id)); return {deleted:true}; },
    async list(){ return {assets:[...assetBlobs.entries()].map(([id, b]) => ({id, url:assetURLs.get(id), contentType:b.type, sizeBytes:b.size, createdAt:""})), usage:{}}; }
  };
  window.__assetURL = id => assetURLs.get(id) || "";

  /* ----- fichiers : partage iOS (Enregistrer dans Fichiers, Mail, WhatsApp…) ou téléchargement ----- */
  const MIME = {pdf:"application/pdf", csv:"text/csv", json:"application/json", txt:"text/plain", png:"image/png"};
  function shareSheetFallback(file){
    return new Promise((resolve, reject) => {
      const ov = document.createElement("div"); ov.className = "rr-share";
      ov.innerHTML = `<div class="rr-share-box"><b>${file.name.replace(/[<>&]/g, "")}</b><p>Le fichier est prêt.</p><button class="btn primary block" id="rr-go">Partager / Enregistrer</button><button class="btn block" id="rr-x" style="margin-top:8px">Annuler</button></div>`;
      document.body.append(ov);
      ov.querySelector("#rr-x").onclick = () => { ov.remove(); reject(err("declined", "annulé")); };
      ov.querySelector("#rr-go").onclick = async () => {
        try { await navigator.share({files:[file], title:file.name}); ov.remove(); resolve({status:"saved"}); }
        catch(e){ if (e && e.name === "AbortError"){ ov.remove(); reject(err("declined", "annulé")); } else { ov.remove(); anchorSave(file); resolve({status:"saved"}); } }
      };
    });
  }
  function anchorSave(file){
    const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = file.name; document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  const downloads = {
    async save({filename, data}){
      const ext = (filename.split(".").pop() || "").toLowerCase();
      const blob = data instanceof Blob ? data : new Blob([data], {type:MIME[ext] || "application/octet-stream"});
      const file = new File([blob], filename, {type:blob.type || MIME[ext] || "application/octet-stream"});
      if (navigator.canShare && navigator.canShare({files:[file]})){
        try { await navigator.share({files:[file], title:filename}); return {status:"saved"}; }
        catch(e){ if (e && e.name === "AbortError") throw err("declined", "annulé"); return shareSheetFallback(file); }
      }
      anchorSave(file); return {status:"saved"};
    }
  };

  const user = {isOwner:() => true, canEdit:() => true, can:async () => true, id:async () => "local", me:async () => ({id:"local", name:"Moi"}), profiles:async () => ({})};

  /* ----- sauvegarde / restauration ----- */
  const blobToDataURL = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  window.__backup = async () => {
    const data = {};
    for (const [p, b] of docs){ const [col, id] = [parentOf(p), p.split("/").pop()]; (data[col] ||= {})[id] = b; }
    const as = {}; for (const [id, b] of assetBlobs) as[id] = await blobToDataURL(b);
    return JSON.stringify({app:"revolve-stock", version:1, exportedAt:new Date().toISOString(), data, assets:as});
  };
  window.__restore = async (json) => {
    const o = typeof json === "string" ? JSON.parse(json) : json;
    if (!o || o.app !== "revolve-stock" || !o.data) throw new Error("Ce fichier n'est pas une sauvegarde Revolve Stock.");
    await tx("docs", "readwrite", s => s.clear()); await tx("assets", "readwrite", s => s.clear());
    docs.clear(); for (const u of assetURLs.values()) URL.revokeObjectURL(u); assetURLs.clear(); assetBlobs.clear();
    await tx("docs", "readwrite", s => { for (const [col, items] of Object.entries(o.data)) for (const [id, b] of Object.entries(items || {})){ docs.set(col + "/" + id, b); s.put(b, col + "/" + id); } });
    for (const [id, du] of Object.entries(o.assets || {})){ const b = await (await fetch(du)).blob(); assetBlobs.set(id, b); assetURLs.set(id, URL.createObjectURL(b)); }
    await tx("assets", "readwrite", s => { for (const [id, b] of assetBlobs) s.put(b, id); });
    try { localStorage.setItem("rr.started", "1"); } catch(e){}
    location.reload();
  };

  /* ----- démarrage ----- */
  let readyResolve; const ready = new Promise(r => readyResolve = r);
  async function boot(){
    try {
      idb = await openIDB();
      for (const [k, v] of await readAll("docs")) docs.set(k, v);
      for (const [k, v] of await readAll("assets")){ assetBlobs.set(k, v); assetURLs.set(k, URL.createObjectURL(v)); }
      navigator.storage?.persist?.().catch(() => {});
    } catch(e){ console.error(e); readyResolve(false); return; }
    let started = false; try { started = localStorage.getItem("rr.started") === "1"; } catch(e){}
    if (!docs.size && !started) await welcome();
    readyResolve(true);
  }
  function welcome(){
    return new Promise(resolve => {
      const ov = document.createElement("div"); ov.className = "rr-welcome";
      const logo = document.querySelector(".logo")?.src || "";
      ov.innerHTML = `<div class="rr-w-box">${logo ? `<img src="${logo}" alt="Revolve Realm" class="rr-w-logo">` : ""}
        <h1>Bienvenue</h1><p>Tes données restent dans ce téléphone. Importe ta sauvegarde pour retrouver ton stock, tes collections et tes magasins.</p>
        <label class="btn primary block" style="cursor:pointer">Importer ma sauvegarde<input type="file" accept=".json,application/json" hidden id="rr-file"></label>
        <button class="btn block" id="rr-empty" style="margin-top:8px">Commencer avec une appli vide</button>
        <p class="rr-w-err" id="rr-err" hidden></p></div>`;
      document.body.append(ov);
      ov.querySelector("#rr-empty").onclick = () => { try { localStorage.setItem("rr.started", "1"); } catch(e){} ov.remove(); resolve(); };
      ov.querySelector("#rr-file").onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        try { await window.__restore(await f.text()); } catch(x){ const el = ov.querySelector("#rr-err"); el.textContent = x.message || "Import impossible."; el.hidden = false; }
      };
    });
  }
  window.__pickBackup = () => new Promise(resolve => {
    const i = document.createElement("input"); i.type = "file"; i.accept = ".json,application/json";
    i.onchange = async () => { const f = i.files[0]; if (!f) return resolve(false); try { await window.__restore(await f.text()); resolve(true); } catch(x){ alert(x.message); resolve(false); } };
    i.click();
  });

  window.claude = {
    use: async name => {
      const ok = await ready;
      if (!ok) return null;
      return ({db, user, assets, downloads})[name] || null;
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
