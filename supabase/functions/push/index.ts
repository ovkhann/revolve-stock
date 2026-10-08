// Revolve Chat — envoie une notification push aux membres d'une discussion quand un message arrive.
// Appelée par le déclencheur SQL « messages_push » avec {message_id}. Pas de JWT : la fonction relit
// le message elle-même et ne l'envoie qu'une fois (colonne pushed_at), dans les 2 minutes qui suivent.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  try {
    const { message_id } = await req.json().catch(() => ({}));
    if (!message_id) return new Response("missing", { status: 400 });

    // réserver l'envoi (une seule fois, message récent seulement)
    const since = new Date(Date.now() - 120_000).toISOString();
    const { data: msg } = await sb.from("messages").update({ pushed_at: new Date().toISOString() })
      .eq("id", message_id).is("pushed_at", null).gte("created_at", since)
      .select("id, conversation_id, sender_id, body, image_path, product").maybeSingle();
    if (!msg) return new Response("skip");

    const [{ data: secrets }, { data: conv }, { data: sender }, { data: members }] = await Promise.all([
      sb.from("app_secrets").select("key, value").in("key", ["vapid_public", "vapid_private", "vapid_subject"]),
      sb.from("conversations").select("kind, name").eq("id", msg.conversation_id).single(),
      sb.from("profiles").select("username").eq("id", msg.sender_id).single(),
      sb.from("conversation_members").select("user_id").eq("conversation_id", msg.conversation_id).neq("user_id", msg.sender_id),
    ]);
    const k = Object.fromEntries((secrets ?? []).map((s) => [s.key, s.value]));
    if (!k.vapid_public || !k.vapid_private) return new Response("no vapid", { status: 500 });
    webpush.setVapidDetails(k.vapid_subject || "mailto:contact@revolverealm.fr", k.vapid_public, k.vapid_private);

    const ids = (members ?? []).map((m) => m.user_id);
    if (!ids.length) return new Response("nobody");
    const { data: subs } = await sb.from("push_subscriptions").select("endpoint, p256dh, auth").in("user_id", ids);

    const who = sender?.username ?? "Quelqu'un";
    const title = conv?.kind === "group" ? `${who} · ${conv?.name ?? "Groupe"}` : who;
    const body = msg.body ? String(msg.body).slice(0, 140)
      : msg.image_path ? "📷 Photo"
      : msg.product ? `👕 ${msg.product?.name ?? "Une pièce"}` : "Nouveau message";
    const payload = JSON.stringify({ title, body, conversation_id: msg.conversation_id, tag: msg.conversation_id });

    const dead: string[] = [];
    await Promise.all((subs ?? []).map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400, urgency: "high" });
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push(s.endpoint);
        else console.error("push", code, (e as Error).message);
      }
    }));
    if (dead.length) await sb.from("push_subscriptions").delete().in("endpoint", dead);
    return new Response(JSON.stringify({ sent: (subs ?? []).length - dead.length }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
});
