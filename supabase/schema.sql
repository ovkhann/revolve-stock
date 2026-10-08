-- Revolve Chat — schéma Supabase
-- Profils, équipage (accès par code d'invitation), discussions (groupes + privés), messages, réactions, abonnements push.

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (char_length(username) between 2 and 24),
  avatar_path text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.crew_settings (
  id int primary key default 1 check (id = 1),
  invite_code text not null
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('group','dm')),
  name text,
  dm_key text unique,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  body text check (body is null or char_length(body) <= 4000),
  image_path text,
  product jsonb,
  created_at timestamptz not null default now(),
  pushed_at timestamptz,
  check (body is not null or image_path is not null or product is not null)
);
create index if not exists messages_conv_created on public.messages(conversation_id, created_at desc);

create table if not exists public.reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  emoji text not null check (char_length(emoji) <= 16),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- Clés privées (VAPID) : lisibles seulement par le serveur (aucune règle d'accès publique).
create table if not exists public.app_secrets (
  key text primary key,
  value text not null
);

-- ---------- fonctions d'aide (security definer = pas de boucle RLS) ----------
create or replace function public.is_crew() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid());
$$;

create or replace function public.is_member(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversation_members where conversation_id = conv and user_id = auth.uid());
$$;

create or replace function public.is_member_path(p text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return public.is_member(p::uuid);
exception when others then
  return false;
end; $$;

-- Rejoindre l'équipage avec le code d'invitation. Le tout premier inscrit devient admin et fixe le code.
create or replace function public.join_crew(p_code text, p_username text) returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  first_user boolean;
  expected text;
  me public.profiles;
  g uuid;
begin
  if auth.uid() is null then raise exception 'Non connecté'; end if;
  select * into me from public.profiles where id = auth.uid();
  if found then return me; end if;
  select not exists (select 1 from public.profiles) into first_user;
  select invite_code into expected from public.crew_settings where id = 1;
  if first_user then
    insert into public.crew_settings(id, invite_code) values (1, upper(trim(p_code)))
      on conflict (id) do update set invite_code = excluded.invite_code;
  elsif expected is null or upper(trim(p_code)) <> expected then
    raise exception 'Code d''invitation incorrect';
  end if;
  insert into public.profiles(id, username, is_admin) values (auth.uid(), trim(p_username), first_user) returning * into me;
  -- groupe commun « Revolve Crew » : créé par le premier inscrit, tout le monde y entre
  select id into g from public.conversations where kind = 'group' and dm_key = 'crew';
  if g is null then
    insert into public.conversations(kind, name, dm_key, created_by) values ('group', 'Revolve Crew', 'crew', auth.uid()) returning id into g;
  end if;
  insert into public.conversation_members(conversation_id, user_id) values (g, auth.uid()) on conflict do nothing;
  return me;
end; $$;

-- Ouvrir (ou retrouver) une discussion privée avec quelqu'un.
create or replace function public.open_dm(p_other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  k text; c uuid;
begin
  if not public.is_crew() then raise exception 'Accès refusé'; end if;
  if p_other = auth.uid() or not exists (select 1 from public.profiles where id = p_other) then raise exception 'Destinataire invalide'; end if;
  k := least(auth.uid()::text, p_other::text) || ':' || greatest(auth.uid()::text, p_other::text);
  select id into c from public.conversations where dm_key = k;
  if c is null then
    insert into public.conversations(kind, dm_key, created_by) values ('dm', k, auth.uid()) returning id into c;
    insert into public.conversation_members(conversation_id, user_id) values (c, auth.uid()), (c, p_other);
  end if;
  return c;
end; $$;

-- Créer un groupe avec des membres de l'équipage.
create or replace function public.create_group(p_name text, p_members uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare c uuid;
begin
  if not public.is_crew() then raise exception 'Accès refusé'; end if;
  insert into public.conversations(kind, name, created_by) values ('group', left(trim(p_name), 40), auth.uid()) returning id into c;
  insert into public.conversation_members(conversation_id, user_id)
    select c, p.id from public.profiles p where p.id = auth.uid() or p.id = any(p_members)
    on conflict do nothing;
  return c;
end; $$;

-- Ajouter quelqu'un à un groupe dont on est membre.
create or replace function public.add_to_group(p_conv uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(p_conv) then raise exception 'Accès refusé'; end if;
  if (select kind from public.conversations where id = p_conv) <> 'group' then raise exception 'Pas un groupe'; end if;
  insert into public.conversation_members(conversation_id, user_id) values (p_conv, p_user) on conflict do nothing;
end; $$;

-- Changer le code d'invitation (admin seulement).
create or replace function public.set_invite_code(p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin) then raise exception 'Réservé à l''admin'; end if;
  update public.crew_settings set invite_code = upper(trim(p_code)) where id = 1;
end; $$;

create or replace function public.get_invite_code() returns text
language sql stable security definer set search_path = public as $$
  select invite_code from public.crew_settings where id = 1
    and exists (select 1 from public.profiles where id = auth.uid() and is_admin);
$$;

-- Met à jour l'heure du dernier message.
create or replace function public.touch_conversation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  return new;
end; $$;
drop trigger if exists messages_touch on public.messages;
create trigger messages_touch after insert on public.messages for each row execute function public.touch_conversation();

-- ---------- règles d'accès (RLS) ----------
alter table public.profiles enable row level security;
alter table public.crew_settings enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.reactions enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.app_secrets enable row level security;

drop policy if exists "crew lit les profils" on public.profiles;
create policy "crew lit les profils" on public.profiles for select to authenticated using (public.is_crew());
drop policy if exists "je modifie mon profil" on public.profiles;
create policy "je modifie mon profil" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid() and is_admin = (select p.is_admin from public.profiles p where p.id = auth.uid()));

drop policy if exists "membres lisent la discussion" on public.conversations;
create policy "membres lisent la discussion" on public.conversations for select to authenticated using (public.is_member(id));
drop policy if exists "membres renomment le groupe" on public.conversations;
create policy "membres renomment le groupe" on public.conversations for update to authenticated using (public.is_member(id) and kind = 'group') with check (kind = 'group');

drop policy if exists "membres voient les membres" on public.conversation_members;
create policy "membres voient les membres" on public.conversation_members for select to authenticated using (public.is_member(conversation_id));
drop policy if exists "je marque comme lu" on public.conversation_members;
create policy "je marque comme lu" on public.conversation_members for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "je quitte un groupe" on public.conversation_members;
create policy "je quitte un groupe" on public.conversation_members for delete to authenticated using (user_id = auth.uid());

drop policy if exists "membres lisent les messages" on public.messages;
create policy "membres lisent les messages" on public.messages for select to authenticated using (public.is_member(conversation_id));
drop policy if exists "membres écrivent" on public.messages;
create policy "membres écrivent" on public.messages for insert to authenticated with check (sender_id = auth.uid() and public.is_member(conversation_id) and pushed_at is null);
drop policy if exists "je supprime mes messages" on public.messages;
create policy "je supprime mes messages" on public.messages for delete to authenticated using (sender_id = auth.uid());

drop policy if exists "membres lisent les réactions" on public.reactions;
create policy "membres lisent les réactions" on public.reactions for select to authenticated using (public.is_member(conversation_id));
drop policy if exists "je réagis" on public.reactions;
create policy "je réagis" on public.reactions for insert to authenticated with check (user_id = auth.uid() and public.is_member(conversation_id)
  and conversation_id = (select m.conversation_id from public.messages m where m.id = message_id));
drop policy if exists "je retire ma réaction" on public.reactions;
create policy "je retire ma réaction" on public.reactions for delete to authenticated using (user_id = auth.uid());

drop policy if exists "mes abonnements" on public.push_subscriptions;
create policy "mes abonnements" on public.push_subscriptions for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_crew());
-- crew_settings et app_secrets : aucune règle → inaccessibles depuis l'appli (seulement via les fonctions ci-dessus / le serveur).

-- ---------- temps réel ----------
alter table public.messages replica identity full;
alter table public.reactions replica identity full;
do $$ begin
  begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.reactions; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.conversation_members; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.conversations; exception when duplicate_object then null; end;
end $$;

-- ---------- photos (stockage privé) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat', 'chat', false, 8388608, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- Chemins : <conversation_id>/<fichier> pour les photos de discussion, avatars/<user_id>/<fichier> pour les avatars.
drop policy if exists "chat lecture" on storage.objects;
create policy "chat lecture" on storage.objects for select to authenticated using (
  bucket_id = 'chat' and (
    ((storage.foldername(name))[1] = 'avatars' and public.is_crew())
    or public.is_member_path((storage.foldername(name))[1])
  ));
drop policy if exists "chat envoi" on storage.objects;
create policy "chat envoi" on storage.objects for insert to authenticated with check (
  bucket_id = 'chat' and (
    ((storage.foldername(name))[1] = 'avatars' and (storage.foldername(name))[2] = auth.uid()::text)
    or public.is_member_path((storage.foldername(name))[1])
  ));

-- ---------- notifications : appel de la fonction « push » à chaque nouveau message ----------
create extension if not exists pg_net with schema extensions;
create or replace function public.notify_push() returns trigger
language plpgsql security definer set search_path = public as $$
declare url text;
begin
  select value into url from public.app_secrets where key = 'push_function_url';
  if url is not null then
    perform net.http_post(url := url, body := jsonb_build_object('message_id', new.id), headers := '{"Content-Type":"application/json"}'::jsonb);
  end if;
  return new;
end; $$;
drop trigger if exists messages_push on public.messages;
create trigger messages_push after insert on public.messages for each row execute function public.notify_push();

-- ---------- verrouillage des fonctions ----------
revoke execute on function public.notify_push(), public.touch_conversation() from public, anon, authenticated;
revoke execute on function public.join_crew(text, text), public.open_dm(uuid), public.create_group(text, uuid[]), public.add_to_group(uuid, uuid), public.set_invite_code(text), public.get_invite_code(), public.is_crew(), public.is_member(uuid), public.is_member_path(text) from public, anon;
grant execute on function public.join_crew(text, text), public.open_dm(uuid), public.create_group(text, uuid[]), public.add_to_group(uuid, uuid), public.set_invite_code(text), public.get_invite_code(), public.is_crew(), public.is_member(uuid), public.is_member_path(text) to authenticated;
-- Clés à insérer après déploiement (ne jamais les mettre dans le dépôt) :
-- insert into public.app_secrets(key, value) values ('push_function_url', 'https://<ref>.supabase.co/functions/v1/push'), ('vapid_public','…'), ('vapid_private','…'), ('vapid_subject','mailto:…');
