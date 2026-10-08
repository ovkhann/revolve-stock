/* Revolve Chat — onglet de discussion (groupes + privés) branché sur Supabase.
   S'appuie sur le pont window.RR exposé par l'appli (toast, openSheet, produits…). */
(() => {
  "use strict";
  const CFG = window.RR_CHAT_CONFIG || {};
  const SB_LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
  const EMOJIS = ["❤️", "🔥", "😂", "😮", "👏", "👍"];
  const PAGE = 50;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const R = () => window.RR;
  const toast = m => R()?.toast(m);

  const C = {
    sb:null, session:null, me:null, ready:false, error:null, loading:false,
    profiles:new Map(), convs:new Map(), members:new Map(), myRead:new Map(),
    msgs:new Map(), hasMore:new Map(), reactions:new Map(), urls:new Map(), urlPending:new Set(),
    open:null, root:null, view:"list", channel:null, authMode:"signup", pendingJoin:null, sending:0, readT:null
  };
  const configured = () => !!(CFG.url && CFG.anonKey);

  /* ---------- outils ---------- */
  const uidShort = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const initials = s => String(s || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
  const timeShort = t => {
    const d = new Date(t), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("fr-FR", {hour:"2-digit", minute:"2-digit"});
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Hier";
    if (now - d < 6 * 864e5) return d.toLocaleDateString("fr-FR", {weekday:"short"});
    return d.toLocaleDateString("fr-FR", {day:"numeric", month:"short"});
  };
  const dayLabel = t => {
    const d = new Date(t), now = new Date();
    if (d.toDateString() === now.toDateString()) return "Aujourd'hui";
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Hier";
    return d.toLocaleDateString("fr-FR", {weekday:"long", day:"numeric", month:"long"});
  };
  const linkify = s => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, "<br>");
  const loadScript = src => new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Chargement impossible")); document.head.append(s); });
  const b64ToU8 = b => { const p = "=".repeat((4 - b.length % 4) % 4), s = atob((b + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, c => c.charCodeAt(0)); };
  const errMsg = e => {
    const m = String(e?.message || e || "");
    if (/Invalid login/i.test(m)) return "E-mail ou mot de passe incorrect.";
    if (/already registered|already been registered/i.test(m)) return "Un compte existe déjà avec cet e-mail : connecte-toi.";
    if (/Password should be/i.test(m)) return "Mot de passe trop court (6 caractères minimum).";
    if (/Email not confirmed/i.test(m)) return "Confirme ton e-mail (lien reçu par mail), puis connecte-toi.";
    if (/invitation/i.test(m)) return "Code d'invitation incorrect.";
    if (/network|fetch/i.test(m)) return "Pas de connexion internet.";
    return m || "Une erreur est survenue.";
  };

  function convTitle(c){
    if (!c) return "";
    if (c.kind === "group") return c.name || "Groupe";
    const other = (C.members.get(c.id) || []).find(id => id !== C.me?.id);
    return C.profiles.get(other)?.username || "Discussion";
  }
  function convOther(c){ return c?.kind === "dm" ? C.profiles.get((C.members.get(c.id) || []).find(id => id !== C.me?.id)) : null; }
  function avatarHTML(p, size = 40, group = null){
    if (group) return `<span class="ch-av grp" style="--s:${size}px"><svg viewBox="0 0 24 24"><circle cx="9" cy="9" r="3.2"/><circle cx="16.5" cy="10" r="2.6"/><path d="M3.5 19c.6-3 2.9-4.6 5.5-4.6s4.9 1.6 5.5 4.6M14 15.2c.8-.5 1.7-.8 2.6-.8 2 0 3.7 1.3 4.1 3.6"/></svg></span>`;
    const u = p?.avatar_path ? signed(p.avatar_path) : "";
    return `<span class="ch-av" style="--s:${size}px">${u ? `<img src="${esc(u)}" alt="">` : esc(initials(p?.username))}</span>`;
  }
  function unreadOf(cid){
    const lr = C.myRead.get(cid) || 0, list = C.msgs.get(cid) || [];
    let n = 0; for (const m of list) if (m.sender_id !== C.me?.id && new Date(m.created_at).getTime() > lr) n++;
    return n;
  }
  function totalUnread(){ let n = 0; for (const id of C.convs.keys()) n += unreadOf(id); return n; }
  function updateBadge(){
    const n = totalUnread(), b = document.querySelector('.tabs button[data-tab="chat"] .ch-badge');
    if (b){ b.textContent = n > 9 ? "9+" : String(n); b.hidden = !n; }
    try { if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch(e){}
  }

  /* ---------- URLs signées des photos ---------- */
  function signed(path){
    if (!path) return "";
    const hit = C.urls.get(path); if (hit && hit.exp > Date.now()) return hit.url;
    queueSign(path); return hit?.url || "";
  }
  let signT = null;
  function queueSign(path){
    if (C.urlPending.has(path) || !C.sb) return; C.urlPending.add(path);
    clearTimeout(signT); signT = setTimeout(flushSign, 30);
  }
  async function flushSign(){
    const paths = [...C.urlPending]; if (!paths.length) return;
    const { data } = await C.sb.storage.from("chat").createSignedUrls(paths, 3600 * 6);
    for (const d of data || []) if (d.signedUrl) C.urls.set(d.path, {url:d.signedUrl, exp:Date.now() + 3600 * 5 * 1000});
    paths.forEach(p => C.urlPending.delete(p));
    paint();
  }

  /* ---------- démarrage ---------- */
  async function start(){
    if (C.sb || C.loading || !configured()) return;
    C.loading = true;
    try {
      if (!window.supabase?.createClient) await loadScript(SB_LIB);
      C.sb = window.supabase.createClient(CFG.url, CFG.anonKey, { auth:{ persistSession:true, autoRefreshToken:true, storageKey:"rr-chat-auth" }, realtime:{ params:{ eventsPerSecond:5 } } });
      const { data } = await C.sb.auth.getSession();
      C.session = data.session;
      C.sb.auth.onAuthStateChange((ev, session) => {
        const had = !!C.session; C.session = session;
        if (ev === "SIGNED_OUT"){ reset(); paint(); }
        else if (session && !had) afterLogin();
      });
      if (C.session) await afterLogin(); else C.ready = true;
    } catch(e){ console.error(e); C.error = errMsg(e); }
    C.loading = false; paint();
  }
  function reset(){
    if (C.channel) C.sb?.removeChannel(C.channel);
    Object.assign(C, {me:null, ready:true, channel:null, open:null, view:"list"});
    [C.profiles, C.convs, C.members, C.myRead, C.msgs, C.hasMore, C.reactions].forEach(m => m.clear());
    updateBadge();
  }
  async function afterLogin(){
    const uid = C.session.user.id;
    let { data: me } = await C.sb.from("profiles").select("*").eq("id", uid).maybeSingle();
    if (!me){
      let pj = null; try { pj = JSON.parse(localStorage.getItem("rr.chat.join") || "null"); } catch(e){}
      if (pj?.code && pj?.username){
        const r = await C.sb.rpc("join_crew", {p_code:pj.code, p_username:pj.username});
        if (!r.error){ me = r.data; try { localStorage.removeItem("rr.chat.join"); } catch(e){} }
        else C.error = errMsg(r.error);
      }
    }
    C.me = me || null; C.ready = true;
    if (C.me){ await loadAll(); subscribe(); resubscribePush(); }
    paint();
  }
  async function loadAll(){
    const [{ data: profs }, { data: mine }] = await Promise.all([
      C.sb.from("profiles").select("id,username,avatar_path,is_admin"),
      C.sb.from("conversation_members").select("conversation_id,last_read_at,conversations(id,kind,name,dm_key,last_message_at,created_at)").eq("user_id", C.me.id)
    ]);
    C.profiles.clear(); (profs || []).forEach(p => C.profiles.set(p.id, p));
    C.convs.clear(); C.myRead.clear();
    for (const r of mine || []){ if (r.conversations){ C.convs.set(r.conversation_id, r.conversations); C.myRead.set(r.conversation_id, new Date(r.last_read_at).getTime()); } }
    const ids = [...C.convs.keys()];
    if (!ids.length) return;
    const [{ data: mem }, { data: recent }] = await Promise.all([
      C.sb.from("conversation_members").select("conversation_id,user_id").in("conversation_id", ids),
      C.sb.from("messages").select("*").in("conversation_id", ids).order("created_at", {ascending:false}).limit(300)
    ]);
    C.members.clear(); for (const m of mem || []){ if (!C.members.has(m.conversation_id)) C.members.set(m.conversation_id, []); C.members.get(m.conversation_id).push(m.user_id); }
    C.msgs.clear();
    for (const m of (recent || []).slice().reverse()){ if (!C.msgs.has(m.conversation_id)) C.msgs.set(m.conversation_id, []); C.msgs.get(m.conversation_id).push(m); }
    updateBadge();
  }
  async function loadConv(cid, older = false){
    const list = C.msgs.get(cid) || [];
    let q = C.sb.from("messages").select("*").eq("conversation_id", cid).order("created_at", {ascending:false}).limit(PAGE);
    if (older && list.length) q = q.lt("created_at", list[0].created_at);
    const { data } = await q;
    const rows = (data || []).slice().reverse();
    const merged = older ? rows.concat(list) : mergeMsgs(list, rows);
    C.msgs.set(cid, merged); C.hasMore.set(cid, (data || []).length === PAGE);
    const mids = merged.map(m => m.id);
    if (mids.length){
      const { data: rx } = await C.sb.from("reactions").select("message_id,user_id,emoji").in("message_id", mids.slice(-200));
      const by = new Map(); for (const r of rx || []){ if (!by.has(r.message_id)) by.set(r.message_id, []); by.get(r.message_id).push(r); }
      for (const id of mids) if (by.has(id)) C.reactions.set(id, by.get(id)); else if (!older) C.reactions.delete(id);
    }
  }
  function mergeMsgs(a, b){
    const m = new Map(); for (const x of a.concat(b)) m.set(x.id, x);
    return [...m.values()].sort((x, y) => new Date(x.created_at) - new Date(y.created_at));
  }

  /* ---------- temps réel ---------- */
  function subscribe(){
    if (C.channel) C.sb.removeChannel(C.channel);
    C.channel = C.sb.channel("rr-chat")
      .on("postgres_changes", {event:"INSERT", schema:"public", table:"messages"}, p => onMessage(p.new))
      .on("postgres_changes", {event:"DELETE", schema:"public", table:"messages"}, p => { for (const [cid, list] of C.msgs){ const i = list.findIndex(m => m.id === p.old.id); if (i > -1){ list.splice(i, 1); paint(); updateBadge(); } } })
      .on("postgres_changes", {event:"*", schema:"public", table:"reactions"}, p => {
        if (p.eventType === "INSERT"){ const r = p.new; const l = C.reactions.get(r.message_id) || []; if (!l.some(x => x.user_id === r.user_id && x.emoji === r.emoji)) l.push(r); C.reactions.set(r.message_id, l); }
        if (p.eventType === "DELETE" && p.old.message_id){ const l = C.reactions.get(p.old.message_id) || []; C.reactions.set(p.old.message_id, l.filter(x => !(x.user_id === p.old.user_id && x.emoji === p.old.emoji))); }
        paint();
      })
      .on("postgres_changes", {event:"*", schema:"public", table:"conversation_members"}, () => refreshSoon())
      .on("postgres_changes", {event:"UPDATE", schema:"public", table:"conversations"}, p => { if (C.convs.has(p.new.id)){ C.convs.set(p.new.id, {...C.convs.get(p.new.id), ...p.new}); paint(); } })
      .subscribe(status => { if (status === "SUBSCRIBED" && C.wasDown){ C.wasDown = false; refreshSoon(); } if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") C.wasDown = true; });
  }
  let refT = null;
  function refreshSoon(){ clearTimeout(refT); refT = setTimeout(async () => { await loadAll(); if (C.open) await loadConv(C.open); paint(); }, 400); }
  function onMessage(m){
    if (!C.convs.has(m.conversation_id)){ refreshSoon(); return; }
    if (!C.profiles.has(m.sender_id)) refreshSoon();
    const list = C.msgs.get(m.conversation_id) || [];
    const tmp = list.findIndex(x => x._tmp && x._tmp === m.client_tmp);
    if (!list.some(x => x.id === m.id)){
      // remplace l'envoi en attente correspondant (même expéditeur, même contenu)
      const pend = list.findIndex(x => x._pending && x.sender_id === m.sender_id && (x.body || "") === (m.body || "") && !!x.product === !!m.product && !!x._localImg === !!m.image_path);
      if (pend > -1) list.splice(pend, 1, m); else list.push(m);
    }
    C.msgs.set(m.conversation_id, list);
    const c = C.convs.get(m.conversation_id); c.last_message_at = m.created_at;
    if (C.open === m.conversation_id && document.visibilityState === "visible" && isChatVisible()) markRead(m.conversation_id);
    paint(true); updateBadge();
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && C.me){ refreshSoon(); if (C.open && isChatVisible()) markRead(C.open); } });
  function markRead(cid){
    C.myRead.set(cid, Date.now()); updateBadge();
    clearTimeout(C.readT);
    C.readT = setTimeout(() => C.sb.from("conversation_members").update({last_read_at:new Date().toISOString()}).eq("conversation_id", cid).eq("user_id", C.me.id).then(() => {}), 600);
  }
  const isChatVisible = () => !!C.root?.isConnected;

  /* ---------- envoi ---------- */
  async function sendMessage(cid, payload, localImg){
    const tmp = {id:"tmp-" + uidShort(), _pending:true, conversation_id:cid, sender_id:C.me.id, created_at:new Date().toISOString(), body:payload.body || null, product:payload.product || null, image_path:null, _localImg:localImg || null};
    const list = C.msgs.get(cid) || []; list.push(tmp); C.msgs.set(cid, list); paint(true);
    try {
      if (payload.imageBlob){
        const path = `${cid}/${uidShort()}.jpg`;
        const up = await C.sb.storage.from("chat").upload(path, payload.imageBlob, {contentType:"image/jpeg", upsert:false});
        if (up.error) throw up.error;
        payload.image_path = path;
        C.urls.set(path, {url:localImg, exp:Date.now() + 3600e3});
      }
      const row = {conversation_id:cid, body:payload.body || null, image_path:payload.image_path || null, product:payload.product || null};
      const { data, error } = await C.sb.from("messages").insert(row).select().single();
      if (error) throw error;
      const l2 = C.msgs.get(cid) || [];
      const i = l2.indexOf(tmp);
      if (l2.some(x => x.id === data.id)){ if (i > -1) l2.splice(i, 1); }
      else if (i > -1) l2.splice(i, 1, data); else l2.push(data);
      markRead(cid);
    } catch(e){
      console.error(e); tmp._pending = false; tmp._failed = true; toast("Message non envoyé : " + errMsg(e));
    }
    paint(true);
  }
  function compress(file, max = 1600){
    return new Promise((res, rej) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); c.toBlob(b => b ? res(b) : rej(new Error("image")), "image/jpeg", .82); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Image illisible")); };
      img.src = url;
    });
  }
  async function toggleReaction(m, emoji){
    const l = C.reactions.get(m.id) || [];
    const mine = l.find(r => r.user_id === C.me.id && r.emoji === emoji);
    if (mine){
      C.reactions.set(m.id, l.filter(r => r !== mine)); paint();
      await C.sb.from("reactions").delete().eq("message_id", m.id).eq("user_id", C.me.id).eq("emoji", emoji);
    } else {
      l.push({message_id:m.id, user_id:C.me.id, emoji}); C.reactions.set(m.id, l); paint();
      const { error } = await C.sb.from("reactions").insert({message_id:m.id, emoji, conversation_id:m.conversation_id});
      if (error && !/duplicate/i.test(error.message)) toast("Réaction non envoyée.");
    }
  }

  /* ---------- notifications ---------- */
  const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && !!CFG.vapidPublic;
  async function enablePush(){
    if (!pushSupported()){ toast(standalone() ? "Notifications non disponibles sur cet appareil." : "Installe d'abord l'appli sur l'écran d'accueil pour recevoir les notifications."); return false; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted"){ toast("Notifications refusées. Tu peux les réactiver dans Réglages iPhone → Notifications."); return false; }
    return saveSubscription(true);
  }
  async function saveSubscription(loud){
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:b64ToU8(CFG.vapidPublic)});
      const j = sub.toJSON();
      const { error } = await C.sb.from("push_subscriptions").upsert({endpoint:j.endpoint, p256dh:j.keys.p256dh, auth:j.keys.auth});
      if (error) throw error;
      if (loud) toast("Notifications activées");
      return true;
    } catch(e){ console.error(e); if (loud) toast("Activation impossible : " + errMsg(e)); return false; }
  }
  async function disablePush(){
    try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
      if (sub){ await C.sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); } toast("Notifications coupées"); } catch(e){ console.error(e); }
  }
  async function resubscribePush(){ if (pushSupported() && Notification.permission === "granted") saveSubscription(false); }
  async function pushState(){ try { if (!pushSupported() || Notification.permission !== "granted") return false; const reg = await navigator.serviceWorker.ready; return !!(await reg.pushManager.getSubscription()); } catch(e){ return false; } }
  navigator.serviceWorker?.addEventListener("message", e => { if (e.data?.type === "open-conv") openConvFromOutside(e.data.conversation_id); });
  function openConvFromOutside(cid){
    if (!cid) return;
    const go = () => { C.view = "conv"; C.open = cid; R()?.goTab("chat"); if (C.me) loadConv(cid).then(() => { markRead(cid); paint(true); }); };
    if (C.me) go(); else { C.pendingOpen = cid; }
  }

  /* ---------- rendu ---------- */
  function ensureRoot(){
    if (!C.root){ C.root = document.createElement("div"); C.root.className = "ch-root"; }
    return C.root;
  }
  let paintQ = 0, wantBottom = false;
  function paint(bottom){
    if (bottom) wantBottom = true;
    if (paintQ) return;
    paintQ = requestAnimationFrame(() => { paintQ = 0; if (C.root?.isConnected) draw(); });
  }
  function draw(){
    const root = C.root;
    document.body.classList.toggle("ch-in-conv", C.view === "conv" && !!C.me);
    if (!configured()){ root.innerHTML = `<div class="ch-empty"><b>Chat pas encore configuré</b>Le serveur du chat n'est pas encore branché sur cette version de l'appli.</div>`; return; }
    if (C.error && !C.me && !C.loading){ /* l'erreur s'affiche dans l'écran de connexion */ }
    if (!C.ready){ root.innerHTML = `<div class="ch-empty"><span class="ch-spin"></span>Connexion au chat…</div>`; return; }
    if (!C.session) return drawAuth(root);
    if (!C.me) return drawJoin(root);
    if (C.pendingOpen){ const p = C.pendingOpen; C.pendingOpen = null; C.view = "conv"; C.open = p; loadConv(p).then(() => { markRead(p); paint(true); }); }
    if (C.view === "conv" && C.convs.has(C.open)) return drawConv(root);
    C.view = "list"; drawList(root);
  }

  function drawAuth(root){
    const up = C.authMode === "signup";
    root.innerHTML = `
      <div class="ch-auth">
        <h2 class="ch-h">Revolve Chat</h2>
        <p class="ch-sub">${up ? "Crée ton compte avec le code d'invitation que t'a donné Ovkhan." : "Content de te revoir."}</p>
        <div class="seg ch-seg" role="group"><button data-am="signup" aria-pressed="${up}">Créer un compte</button><button data-am="login" aria-pressed="${!up}">Se connecter</button></div>
        <form id="ch-auth" novalidate>
          ${up ? `<div class="field"><label for="ch-name">Pseudo</label><input id="ch-name" autocomplete="nickname" maxlength="24" placeholder="Ton pseudo"></div>` : ""}
          <div class="field"><label for="ch-mail">E-mail</label><input id="ch-mail" type="email" autocomplete="email" inputmode="email" placeholder="toi@mail.com"></div>
          <div class="field"><label for="ch-pass">Mot de passe</label><input id="ch-pass" type="password" autocomplete="${up ? "new-password" : "current-password"}" placeholder="6 caractères minimum"></div>
          ${up ? `<div class="field"><label for="ch-code">Code d'invitation</label><input id="ch-code" autocapitalize="characters" placeholder="Ex. REVOLVE26"><span class="hint">Le tout premier compte choisit le code : ce sera celui à donner à tes potes.</span></div>` : ""}
          ${C.error ? `<p class="ch-err">${esc(C.error)}</p>` : ""}
          <button class="btn primary block" type="submit" id="ch-go">${up ? "Créer mon compte" : "Se connecter"}</button>
        </form>
      </div>`;
    root.querySelectorAll("[data-am]").forEach(b => b.onclick = () => { C.authMode = b.dataset.am; C.error = null; draw(); });
    root.querySelector("#ch-auth").onsubmit = async e => {
      e.preventDefault();
      const g = id => root.querySelector("#" + id)?.value.trim() || "";
      const mail = g("ch-mail"), pass = root.querySelector("#ch-pass").value;
      const btn = root.querySelector("#ch-go"); btn.disabled = true; btn.textContent = "Patiente…"; C.error = null;
      try {
        if (up){
          const name = g("ch-name"), code = g("ch-code");
          if (name.length < 2) throw new Error("Choisis un pseudo (2 caractères minimum).");
          if (!code) throw new Error("Entre le code d'invitation.");
          localStorage.setItem("rr.chat.join", JSON.stringify({username:name, code}));
          const { data, error } = await C.sb.auth.signUp({email:mail, password:pass});
          if (error) throw error;
          if (!data.session){ C.authMode = "login"; C.error = null; draw(); toast("Compte créé : confirme ton e-mail, puis connecte-toi ici."); return; }
        } else {
          const { error } = await C.sb.auth.signInWithPassword({email:mail, password:pass});
          if (error) throw error;
        }
      } catch(x){ C.error = errMsg(x); draw(); }
    };
  }
  function drawJoin(root){
    root.innerHTML = `
      <div class="ch-auth">
        <h2 class="ch-h">Rejoindre le crew</h2>
        <p class="ch-sub">Ton compte est prêt. Entre ton pseudo et le code d'invitation.</p>
        <form id="ch-join" novalidate>
          <div class="field"><label for="ch-name">Pseudo</label><input id="ch-name" maxlength="24"></div>
          <div class="field"><label for="ch-code">Code d'invitation</label><input id="ch-code" autocapitalize="characters"></div>
          ${C.error ? `<p class="ch-err">${esc(C.error)}</p>` : ""}
          <button class="btn primary block" type="submit">Rejoindre</button>
          <button class="btn block" type="button" id="ch-out" style="margin-top:8px">Se déconnecter</button>
        </form>
      </div>`;
    root.querySelector("#ch-out").onclick = () => C.sb.auth.signOut();
    root.querySelector("#ch-join").onsubmit = async e => {
      e.preventDefault();
      const name = root.querySelector("#ch-name").value.trim(), code = root.querySelector("#ch-code").value.trim();
      const r = await C.sb.rpc("join_crew", {p_code:code, p_username:name});
      if (r.error){ C.error = errMsg(r.error); draw(); return; }
      C.error = null; C.me = r.data; await loadAll(); subscribe(); paint();
    };
  }

  function lastOf(cid){ const l = C.msgs.get(cid) || []; return l[l.length - 1]; }
  function preview(m){
    if (!m) return "Aucun message";
    const nm = C.profiles.get(m.sender_id)?.username;
    const who = m.sender_id === C.me.id ? "Toi : " : (C.convs.get(m.conversation_id)?.kind === "group" && nm ? nm + " : " : "");
    const t = m.body ? m.body : m.image_path || m._localImg ? "📷 Photo" : m.product ? "👕 " + (m.product.name || "Une pièce") : "";
    return who + t;
  }
  function drawList(root){
    const convs = [...C.convs.values()].sort((a, b) => new Date(lastOf(b.id)?.created_at || b.last_message_at) - new Date(lastOf(a.id)?.created_at || a.last_message_at));
    root.innerHTML = `
      <div class="ch-top">
        <button class="ch-me" id="ch-prof" aria-label="Mon profil">${avatarHTML(C.me, 36)}</button>
        <h2 class="ch-h">Messages</h2>
        <button class="ch-icon" id="ch-new" aria-label="Nouvelle discussion"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
      </div>
      <div class="list ch-list">${convs.length ? convs.map(c => { const u = unreadOf(c.id), last = lastOf(c.id); return `
        <button class="row ch-row ${u ? "unread" : ""}" data-cv="${esc(c.id)}">
          ${avatarHTML(convOther(c), 46, c.kind === "group")}
          <span class="main"><div class="t">${esc(convTitle(c))}</div><div class="s">${esc(preview(last))}</div></span>
          <span class="ch-meta"><span>${last ? esc(timeShort(last.created_at)) : ""}</span>${u ? `<b class="ch-n">${u > 9 ? "9+" : u}</b>` : ""}</span>
        </button>`; }).join("") : `<div class="empty"><b>Aucune discussion</b>Touche le crayon pour écrire à un pote.</div>`}</div>
      <p class="note" style="text-align:center">${C.profiles.size} membre${C.profiles.size > 1 ? "s" : ""} dans le crew</p>`;
    root.querySelector("#ch-prof").onclick = openProfile;
    root.querySelector("#ch-new").onclick = openNew;
    root.querySelectorAll("[data-cv]").forEach(b => b.onclick = () => openConv(b.dataset.cv));
  }
  async function openConv(cid){
    C.open = cid; C.view = "conv"; wantBottom = true; draw();
    await loadConv(cid); markRead(cid); paint(true);
  }

  function msgHTML(m, prev, next, isGroup){
    const mine = m.sender_id === C.me.id;
    const sameAsPrev = prev && prev.sender_id === m.sender_id && new Date(m.created_at) - new Date(prev.created_at) < 5 * 60e3 && dayLabel(prev.created_at) === dayLabel(m.created_at);
    const sameAsNext = next && next.sender_id === m.sender_id && new Date(next.created_at) - new Date(m.created_at) < 5 * 60e3;
    const p = C.profiles.get(m.sender_id);
    let content = "";
    if (m.image_path || m._localImg){ const u = m._localImg || signed(m.image_path); content += `<button class="ch-img" data-img="${esc(m.image_path || "")}" data-local="${m._localImg ? "1" : ""}">${u ? `<img src="${esc(u)}" alt="Photo" loading="lazy">` : `<span class="ch-spin"></span>`}</button>`; }
    if (m.product){ const pr = m.product, u = pr.photo_path ? signed(pr.photo_path) : "";
      content += `<button class="ch-prod" data-prod="${esc(pr.id || "")}"><span class="ch-prod-img">${u ? `<img src="${esc(u)}" alt="">` : `<span>${esc(initials(pr.name))}</span>`}</span>
        <span class="ch-prod-b"><span class="ch-prod-k">PIÈCE REVOLVE REALM</span><b>${esc(pr.name)}</b>${pr.collection ? `<span class="ch-prod-c">${esc(pr.collection)}</span>` : ""}
        <span class="ch-prod-s">${(pr.sizes || []).length ? (pr.sizes || []).map(s => `<i>${esc(s)}</i>`).join("") : `<i class="off">Épuisé</i>`}</span>${pr.price != null ? `<span class="ch-prod-p">${esc(R()?.eur(pr.price) || pr.price + " €")}</span>` : ""}</span></button>`; }
    if (m.body) content += `<div class="ch-txt">${linkify(m.body)}</div>`;
    const rx = C.reactions.get(m.id) || [];
    const groups = {}; rx.forEach(r => { (groups[r.emoji] ||= []).push(r.user_id); });
    const onlyEmoji = m.body && !m.image_path && !m.product && /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s){1,8}$/u.test(m.body) && m.body.trim().length <= 12;
    return `<div class="ch-msg ${mine ? "me" : "them"} ${sameAsPrev ? "cont" : ""} ${sameAsNext ? "more" : ""} ${m._pending ? "pending" : ""} ${m._failed ? "failed" : ""}" data-mid="${esc(m.id)}">
      ${!mine && isGroup ? `<span class="ch-mav">${sameAsNext ? "" : avatarHTML(p, 28)}</span>` : ""}
      <div class="ch-col">
        ${!mine && isGroup && !sameAsPrev ? `<span class="ch-who">${esc(p?.username || "?")}</span>` : ""}
        <div class="ch-bub ${onlyEmoji ? "emoji" : ""} ${m.image_path || m._localImg ? "has-img" : ""} ${m.product ? "has-prod" : ""}">${content}</div>
        ${Object.keys(groups).length ? `<div class="ch-rx">${Object.entries(groups).map(([e, us]) => `<button class="${us.includes(C.me.id) ? "mine" : ""}" data-rx="${esc(e)}" data-mid="${esc(m.id)}">${e}${us.length > 1 ? `<span>${us.length}</span>` : ""}</button>`).join("")}</div>` : ""}
        ${!sameAsNext ? `<span class="ch-time">${m._failed ? "Non envoyé" : m._pending ? "Envoi…" : esc(new Date(m.created_at).toLocaleTimeString("fr-FR", {hour:"2-digit", minute:"2-digit"}))}</span>` : ""}
      </div>
    </div>`;
  }
  function drawConv(root){
    const c = C.convs.get(C.open), list = C.msgs.get(C.open) || [], isGroup = c.kind === "group";
    const mem = (C.members.get(c.id) || []).map(id => C.profiles.get(id)).filter(Boolean);
    const existing = root.querySelector(".ch-conv[data-c='" + c.id + "']");
    const scroller = existing?.querySelector(".ch-scroll");
    const atBottom = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80 : true;
    const prevH = scroller?.scrollHeight || 0, prevTop = scroller?.scrollTop || 0;
    const draft = existing?.querySelector("#ch-input")?.value ?? C.drafts?.[c.id] ?? "";
    const hadFocus = document.activeElement?.id === "ch-input";
    let lastDay = "", body = "";
    list.forEach((m, i) => { const d = dayLabel(m.created_at); if (d !== lastDay){ body += `<div class="ch-day">${esc(d)}</div>`; lastDay = d; } body += msgHTML(m, i && dayLabel(list[i - 1].created_at) === d ? list[i - 1] : null, list[i + 1] && dayLabel(list[i + 1].created_at) === d ? list[i + 1] : null, isGroup); });
    if (!existing){
      root.innerHTML = `
      <div class="ch-conv" data-c="${esc(c.id)}">
        <div class="ch-bar">
          <button class="ch-icon" id="ch-back" aria-label="Retour"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
          <button class="ch-bar-t" id="ch-info">${avatarHTML(convOther(c), 34, isGroup)}<span><b></b><small></small></span></button>
        </div>
        <div class="ch-scroll"><div class="ch-msgs"></div></div>
        <form class="ch-compose" id="ch-form">
          <button type="button" class="ch-icon ch-plus" id="ch-plus" aria-label="Ajouter"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
          <textarea id="ch-input" rows="1" placeholder="Message…" enterkeyhint="send"></textarea>
          <button type="submit" class="ch-send" id="ch-send" aria-label="Envoyer"><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg></button>
          <input type="file" accept="image/*" id="ch-file" hidden>
        </form>
      </div>`;
      bindConv(root, c);
      root.querySelector("#ch-input").value = draft;
    }
    root.querySelector(".ch-bar-t b").textContent = convTitle(c);
    root.querySelector(".ch-bar-t small").textContent = isGroup ? mem.map(p => p.id === C.me.id ? "toi" : p.username).join(", ") : "Message privé";
    const msgsEl = root.querySelector(".ch-msgs");
    msgsEl.innerHTML = (C.hasMore.get(c.id) ? `<button class="ch-more" id="ch-more">Messages précédents</button>` : "") + (list.length ? body : `<div class="ch-empty small">Dis bonjour 👋</div>`);
    const sc = root.querySelector(".ch-scroll");
    if (wantBottom || atBottom){ sc.scrollTop = sc.scrollHeight; wantBottom = false; }
    else if (C.keepOlder){ sc.scrollTop = sc.scrollHeight - prevH + prevTop; C.keepOlder = false; }
    root.querySelector("#ch-more")?.addEventListener("click", async () => { C.keepOlder = true; await loadConv(c.id, true); draw(); });
    msgsEl.querySelectorAll("img").forEach(img => img.addEventListener("load", () => { if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 400) sc.scrollTop = sc.scrollHeight; }, {once:true}));
    if (hadFocus) root.querySelector("#ch-input").focus();
  }
  function bindConv(root, c){
    const input = root.querySelector("#ch-input"), form = root.querySelector("#ch-form");
    const grow = () => { input.style.height = "auto"; input.style.height = Math.min(120, input.scrollHeight) + "px"; };
    input.addEventListener("input", () => { grow(); (C.drafts ||= {})[c.id] = input.value; });
    input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)){ e.preventDefault(); form.requestSubmit(); } });
    form.onsubmit = e => { e.preventDefault(); const t = input.value.trim(); if (!t) return; input.value = ""; (C.drafts ||= {})[c.id] = ""; grow(); sendMessage(c.id, {body:t}); input.focus(); };
    root.querySelector("#ch-back").onclick = () => { C.view = "list"; C.open = null; root.innerHTML = ""; draw(); };
    root.querySelector("#ch-info").onclick = () => openConvInfo(c);
    root.querySelector("#ch-plus").onclick = () => openAttach(c);
    root.querySelector("#ch-file").onchange = async e => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      try { const blob = await compress(f); sendMessage(c.id, {imageBlob:blob}, URL.createObjectURL(blob)); } catch(x){ toast(x.message); }
    };
    // interactions sur les messages (délégation)
    const msgs = root.querySelector(".ch-msgs");
    let pressT = null, pressed = null, sx = 0, sy = 0;
    msgs.addEventListener("pointerdown", e => {
      const el = e.target.closest(".ch-bub"); if (!el) return;
      pressed = el.closest(".ch-msg"); sx = e.clientX; sy = e.clientY;
      pressT = setTimeout(() => { if (pressed) { navigator.vibrate?.(8); openReact(pressed.dataset.mid); pressed = null; } }, 420);
    });
    const cancel = e => { if (pressT && (!e || e.type !== "pointermove" || Math.hypot(e.clientX - sx, e.clientY - sy) > 8)){ clearTimeout(pressT); pressT = null; } };
    msgs.addEventListener("pointermove", cancel); msgs.addEventListener("pointerup", () => { clearTimeout(pressT); pressT = null; }); msgs.addEventListener("pointercancel", cancel);
    msgs.addEventListener("contextmenu", e => { const m = e.target.closest(".ch-msg"); if (m){ e.preventDefault(); openReact(m.dataset.mid); } });
    let lastTap = {id:null, t:0};
    msgs.addEventListener("click", e => {
      const rx = e.target.closest("[data-rx]");
      if (rx){ const m = findMsg(rx.dataset.mid); if (m) toggleReaction(m, rx.dataset.rx); return; }
      const img = e.target.closest("[data-img]");
      if (img && img.dataset.img){ viewImage(img.dataset.img); return; }
      const pr = e.target.closest("[data-prod]");
      if (pr && pr.dataset.prod && R()?.isOwner() && R()?.hasProduct(pr.dataset.prod)){ R().openProduct(pr.dataset.prod); return; }
      const bub = e.target.closest(".ch-msg"); if (!bub) return;
      const now = Date.now();
      if (lastTap.id === bub.dataset.mid && now - lastTap.t < 320){ const m = findMsg(bub.dataset.mid); if (m && !m._pending) toggleReaction(m, "❤️"); lastTap = {id:null, t:0}; }
      else lastTap = {id:bub.dataset.mid, t:now};
    });
  }
  const findMsg = id => (C.msgs.get(C.open) || []).find(m => m.id === id);

  /* ---------- feuilles ---------- */
  function openReact(mid){
    const m = findMsg(mid); if (!m || m._pending || m._failed) return;
    const R_ = R(); const mine = m.sender_id === C.me.id;
    R_.openSheet("Réagir", body => {
      body.innerHTML = `
        <div class="ch-react">${EMOJIS.map(e => `<button data-e="${e}" class="${(C.reactions.get(m.id) || []).some(r => r.user_id === C.me.id && r.emoji === e) ? "on" : ""}">${e}</button>`).join("")}</div>
        ${m.body ? `<button class="btn block" id="ch-copy" style="margin-top:14px">Copier le texte</button>` : ""}
        ${mine ? `<button class="btn danger block" id="ch-del" style="margin-top:8px">Supprimer le message</button>` : ""}`;
      body.querySelectorAll("[data-e]").forEach(b => b.onclick = () => { toggleReaction(m, b.dataset.e); R_.closeSheet(); });
      body.querySelector("#ch-copy") && (body.querySelector("#ch-copy").onclick = async () => { try { await navigator.clipboard.writeText(m.body); toast("Texte copié"); } catch(e){} R_.closeSheet(); });
      body.querySelector("#ch-del") && R_.armDelete(body.querySelector("#ch-del"), "Toucher encore pour supprimer", async () => {
        const { error } = await C.sb.from("messages").delete().eq("id", m.id);
        if (error) toast("Suppression impossible."); else { const l = C.msgs.get(m.conversation_id) || []; const i = l.indexOf(m); if (i > -1) l.splice(i, 1); paint(); }
        R_.closeSheet();
      });
    });
  }
  function viewImage(path){
    const u = signed(path); if (!u) return;
    const ov = document.createElement("div"); ov.className = "ch-viewer";
    ov.innerHTML = `<img src="${esc(u)}" alt=""><button class="x" aria-label="Fermer">×</button>`;
    ov.onclick = () => ov.remove(); document.body.append(ov);
  }
  function openAttach(c){
    const R_ = R();
    R_.openSheet("Envoyer", body => {
      body.innerHTML = `<div class="list">
        <button class="row" id="ch-a-photo"><span class="ch-ai">📷</span><span class="main"><div class="t">Photo</div><div class="s">Depuis ta galerie ou l'appareil photo</div></span></button>
        ${R_.isOwner() && R_.products().length ? `<button class="row" id="ch-a-prod"><span class="ch-ai">👕</span><span class="main"><div class="t">Une pièce Revolve Realm</div><div class="s">Photo, nom, tailles dispo et prix. Jamais tes prix d'achat ni tes marges.</div></span></button>` : ""}
      </div>`;
      body.querySelector("#ch-a-photo").onclick = () => { R_.closeSheet(); C.root.querySelector("#ch-file").click(); };
      body.querySelector("#ch-a-prod") && (body.querySelector("#ch-a-prod").onclick = () => pickProduct(c));
    });
  }
  function pickProduct(c){
    const R_ = R();
    R_.openSheet("Partager une pièce", body => {
      body.innerHTML = `<div class="list">${R_.products().map(p => `<button class="row" data-pp="${esc(p.id)}">${p.photo ? `<img class="thumb" src="${esc(R_.imgSrc(p.photo))}" alt="">` : `<span class="thumb">${esc(initials(p.name))}</span>`}<span class="main"><div class="t">${esc(p.name)}</div><div class="s">${esc(R_.productSizes(p).join(" · ") || "Épuisé")}</div></span></button>`).join("")}</div>`;
      body.querySelectorAll("[data-pp]").forEach(b => b.onclick = async () => {
        const p = R_.products().find(x => x.id === b.dataset.pp); if (!p) return;
        b.disabled = true; R_.closeSheet();
        const card = {id:p.id, name:p.name, collection:R_.collectionName(p.collectionId) || null, price:p.price ?? null, sizes:R_.productSizes(p), photo_path:null};
        try {
          if (p.photo){
            const blob = await (await fetch(R_.imgSrc(p.photo))).blob();
            const small = await compress(blob, 900);
            const path = `${c.id}/p-${uidShort()}.jpg`;
            const up = await C.sb.storage.from("chat").upload(path, small, {contentType:"image/jpeg"});
            if (!up.error){ card.photo_path = path; C.urls.set(path, {url:URL.createObjectURL(small), exp:Date.now() + 3600e3}); }
          }
        } catch(e){ console.error(e); }
        sendMessage(c.id, {product:card});
      });
    });
  }
  function openNew(){
    const R_ = R(); const others = [...C.profiles.values()].filter(p => p.id !== C.me.id).sort((a, b) => a.username.localeCompare(b.username));
    R_.openSheet("Nouvelle discussion", body => {
      body.innerHTML = `
        <div class="list"><button class="row" id="ch-ng"><span class="ch-av grp" style="--s:40px"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span><span class="main"><div class="t">Nouveau groupe</div><div class="s">Choisis le nom et les membres</div></span></button></div>
        <h2 class="sec">Message privé <span>${others.length}</span></h2>
        <div class="list">${others.length ? others.map(p => `<button class="row" data-dm="${esc(p.id)}">${avatarHTML(p, 40)}<span class="main"><div class="t">${esc(p.username)}</div></span></button>`).join("") : `<div class="empty">Personne d'autre pour l'instant. Donne le code d'invitation à tes potes (dans ton profil).</div>`}</div>`;
      body.querySelector("#ch-ng").onclick = () => newGroup();
      body.querySelectorAll("[data-dm]").forEach(b => b.onclick = async () => {
        b.disabled = true;
        const { data, error } = await C.sb.rpc("open_dm", {p_other:b.dataset.dm});
        if (error){ toast(errMsg(error)); return; }
        R_.closeSheet(); await loadAll(); openConv(data);
      });
    });
  }
  function newGroup(){
    const R_ = R(); const others = [...C.profiles.values()].filter(p => p.id !== C.me.id).sort((a, b) => a.username.localeCompare(b.username));
    const sel = new Set();
    R_.openSheet("Nouveau groupe", body => {
      body.innerHTML = `
        <div class="field"><label for="ch-gname">Nom du groupe</label><input id="ch-gname" maxlength="40" placeholder="Ex. Shooting SS26"></div>
        <span class="flabel">Membres</span>
        <div class="list" style="margin-top:8px">${others.map(p => `<button class="row" data-gm="${esc(p.id)}" aria-pressed="false">${avatarHTML(p, 36)}<span class="main"><div class="t">${esc(p.username)}</div></span><span class="ch-check"></span></button>`).join("") || `<div class="empty">Personne d'autre dans le crew pour l'instant.</div>`}</div>
        <button class="btn primary block" id="ch-gok" style="margin-top:14px">Créer le groupe</button>`;
      body.querySelectorAll("[data-gm]").forEach(b => b.onclick = () => { const id = b.dataset.gm; sel.has(id) ? sel.delete(id) : sel.add(id); b.setAttribute("aria-pressed", sel.has(id)); });
      body.querySelector("#ch-gok").onclick = async () => {
        const name = body.querySelector("#ch-gname").value.trim();
        if (!name){ toast("Donne un nom au groupe."); return; }
        const { data, error } = await C.sb.rpc("create_group", {p_name:name, p_members:[...sel]});
        if (error){ toast(errMsg(error)); return; }
        R_.closeSheet(); await loadAll(); openConv(data);
      };
    });
  }
  function openConvInfo(c){
    const R_ = R(); const isGroup = c.kind === "group";
    R_.openSheet(convTitle(c), body => {
      const mem = (C.members.get(c.id) || []).map(id => C.profiles.get(id)).filter(Boolean);
      const out = [...C.profiles.values()].filter(p => !mem.some(m => m.id === p.id));
      body.innerHTML = `
        ${isGroup ? `<div class="field"><label for="ch-ren">Nom du groupe</label><div style="display:flex;gap:8px"><input id="ch-ren" value="${esc(c.name || "")}" maxlength="40" style="flex:1"><button class="btn" id="ch-ren-ok">OK</button></div></div>` : ""}
        <h2 class="sec">Membres <span>${mem.length}</span></h2>
        <div class="list">${mem.map(p => `<div class="row">${avatarHTML(p, 36)}<span class="main"><div class="t">${esc(p.username)}${p.id === C.me.id ? " (toi)" : ""}</div></span></div>`).join("")}</div>
        ${isGroup && out.length ? `<h2 class="sec">Ajouter</h2><div class="list">${out.map(p => `<button class="row" data-add="${esc(p.id)}">${avatarHTML(p, 36)}<span class="main"><div class="t">${esc(p.username)}</div></span><span class="muted">+ Ajouter</span></button>`).join("")}</div>` : ""}
        ${isGroup && c.dm_key !== "crew" ? `<button class="btn danger block" id="ch-leave" style="margin-top:16px">Quitter le groupe</button>` : ""}`;
      body.querySelector("#ch-ren-ok") && (body.querySelector("#ch-ren-ok").onclick = async () => {
        const n = body.querySelector("#ch-ren").value.trim(); if (!n) return;
        const { error } = await C.sb.from("conversations").update({name:n}).eq("id", c.id);
        if (error) toast("Renommage impossible."); else { c.name = n; paint(); toast("Groupe renommé"); }
      });
      body.querySelectorAll("[data-add]").forEach(b => b.onclick = async () => {
        const { error } = await C.sb.rpc("add_to_group", {p_conv:c.id, p_user:b.dataset.add});
        if (error) toast(errMsg(error)); else { await loadAll(); R_.closeSheet(); paint(); toast("Ajouté au groupe"); }
      });
      body.querySelector("#ch-leave") && R_.armDelete(body.querySelector("#ch-leave"), "Toucher encore pour quitter", async () => {
        await C.sb.from("conversation_members").delete().eq("conversation_id", c.id).eq("user_id", C.me.id);
        R_.closeSheet(); C.view = "list"; C.open = null; C.root.innerHTML = ""; await loadAll(); paint();
      });
    });
  }
  function openProfile(){
    const R_ = R();
    R_.openSheet("Mon profil", async body => {
      const pushOn = await pushState();
      const code = C.me.is_admin ? (await C.sb.rpc("get_invite_code")).data : null;
      body.innerHTML = `
        <div class="ch-prof">
          <label class="ch-prof-av">${avatarHTML(C.me, 84)}<input type="file" accept="image/*" id="ch-avf" hidden><span>Changer</span></label>
          <div class="field" style="flex:1"><label for="ch-uname">Pseudo</label><div style="display:flex;gap:8px"><input id="ch-uname" value="${esc(C.me.username)}" maxlength="24" style="flex:1"><button class="btn" id="ch-uok">OK</button></div></div>
        </div>
        <div class="list" style="margin-top:6px">
          <div class="row"><span class="main"><div class="t">Notifications</div><div class="s">${standalone() ? "Recevoir une alerte quand un pote t'écrit" : "Disponible une fois l'appli installée sur l'écran d'accueil"}</div></span>
            <button class="btn ${pushOn ? "" : "primary"}" id="ch-push" style="padding:9px 14px">${pushOn ? "Couper" : "Activer"}</button></div>
        </div>
        ${C.me.is_admin ? `<h2 class="sec">Code d'invitation <span>admin</span></h2>
        <div class="list"><div class="row"><span class="main"><div class="t mono" style="font-size:18px;letter-spacing:.08em">${esc(code || "—")}</div><div class="s">À donner à tes potes pour qu'ils créent leur compte</div></span><button class="btn" id="ch-ccopy" style="padding:9px 14px">Copier</button></div></div>
        <div class="field" style="margin-top:10px"><label for="ch-ncode">Changer le code</label><div style="display:flex;gap:8px"><input id="ch-ncode" autocapitalize="characters" placeholder="Nouveau code" style="flex:1"><button class="btn" id="ch-ncok">OK</button></div><span class="hint">Les comptes déjà créés ne sont pas touchés.</span></div>` : ""}
        <button class="btn block" id="ch-logout" style="margin-top:16px">Se déconnecter</button>`;
      body.querySelector("#ch-avf").onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        try { const blob = await compress(f, 400); const path = `avatars/${C.me.id}/${uidShort()}.jpg`;
          const up = await C.sb.storage.from("chat").upload(path, blob, {contentType:"image/jpeg"}); if (up.error) throw up.error;
          const { error } = await C.sb.from("profiles").update({avatar_path:path}).eq("id", C.me.id); if (error) throw error;
          C.urls.set(path, {url:URL.createObjectURL(blob), exp:Date.now() + 3600e3}); C.me.avatar_path = path; C.profiles.set(C.me.id, {...C.me}); R_.closeSheet(); paint(); toast("Photo de profil mise à jour");
        } catch(x){ toast("Envoi impossible : " + errMsg(x)); }
      };
      body.querySelector("#ch-uok").onclick = async () => {
        const n = body.querySelector("#ch-uname").value.trim(); if (n.length < 2){ toast("Pseudo trop court."); return; }
        const { error } = await C.sb.from("profiles").update({username:n}).eq("id", C.me.id);
        if (error) toast("Modification impossible."); else { C.me.username = n; C.profiles.set(C.me.id, {...C.me}); paint(); toast("Pseudo modifié"); }
      };
      body.querySelector("#ch-push").onclick = async () => { pushOn ? await disablePush() : await enablePush(); R_.closeSheet(); };
      body.querySelector("#ch-ccopy") && (body.querySelector("#ch-ccopy").onclick = async () => { try { await navigator.clipboard.writeText(code); toast("Code copié"); } catch(e){ toast(code); } });
      body.querySelector("#ch-ncok") && (body.querySelector("#ch-ncok").onclick = async () => {
        const n = body.querySelector("#ch-ncode").value.trim(); if (n.length < 4){ toast("4 caractères minimum."); return; }
        const { error } = await C.sb.rpc("set_invite_code", {p_code:n}); if (error) toast(errMsg(error)); else { toast("Code changé"); R_.closeSheet(); openProfile(); }
      });
      body.querySelector("#ch-logout").onclick = async () => { await disablePush().catch(() => {}); await C.sb.auth.signOut(); R_.closeSheet(); };
    });
  }

  /* ---------- clavier iOS : la conversation suit la zone visible ---------- */
  const vv = window.visualViewport;
  function fitViewport(){
    if (!vv) return;
    const de = document.documentElement;
    de.style.setProperty("--vvh", vv.height + "px"); de.style.setProperty("--vvt", vv.offsetTop + "px");
    const conv = C.root?.querySelector(".ch-conv"); if (conv) conv.classList.toggle("kb", vv.height < window.innerHeight - 120);
    if (document.activeElement?.id === "ch-input"){ const sc = C.root?.querySelector(".ch-scroll"); if (sc) sc.scrollTop = sc.scrollHeight; }
  }
  vv?.addEventListener("resize", fitViewport); vv?.addEventListener("scroll", fitViewport); fitViewport();

  /* ---------- API pour l'appli ---------- */
  window.RRChat = {
    view(v){ const root = ensureRoot(); if (root.parentNode !== v){ v.innerHTML = ""; v.append(root); } start(); draw(); if (C.open && C.view === "conv") markRead(C.open); },
    leave(){ document.body.classList.remove("ch-in-conv"); },
    start, openConv:openConvFromOutside, unread:totalUnread, configured
  };
  // démarre en arrière-plan si un compte est déjà connecté (pour le badge)
  try { if (configured() && localStorage.getItem("rr-chat-auth")) setTimeout(start, 1200); } catch(e){}
  const h = location.hash.match(/^#chat-([0-9a-f-]{36})$/); if (h){ C.pendingOpen = h[1]; history.replaceState(null, "", location.pathname + location.search); setTimeout(() => window.RR?.goTab("chat"), 0); }
})();
