-- Zoyra phase 3: push tokens, room chat, and the notify path (in-app inbox + Expo push via edge function).

create extension if not exists pg_net;

-- ───────────────────────────────────────────── push tokens
create table public.push_tokens (
  user_id uuid not null references public.profiles (id) on delete cascade,
  token text not null unique,
  platform text not null default 'unknown' check (platform in ('ios', 'android', 'web', 'unknown')),
  updated_at timestamptz not null default now()
);
create index on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;
create policy "own push tokens" on public.push_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- The client upserts own rows with onConflict 'token' (allowed by the policy above).
-- A device token can move between accounts (sign out / sign in as someone else). Plain upsert can't
-- take over another user's row under RLS, so the app calls this instead:
--   supabase.rpc('register_push_token', { p_token, p_platform })
create or replace function public.register_push_token(p_token text, p_platform text default 'unknown') returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.push_tokens (user_id, token, platform, updated_at)
  values (auth.uid(), p_token,
          case when p_platform in ('ios', 'android', 'web') then p_platform else 'unknown' end, now())
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, updated_at = now();
end $$;
revoke execute on function public.register_push_token(text, text) from public, anon;
grant execute on function public.register_push_token(text, text) to authenticated;

-- ───────────────────────────────────────────── room chat
create table public.room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index on public.room_messages (room_id, created_at);

alter table public.room_messages enable row level security;
create policy "room members read chat" on public.room_messages for select to authenticated
  using (public.is_room_member(room_id));
create policy "room members send chat" on public.room_messages for insert to authenticated
  with check (user_id = auth.uid() and public.is_room_member(room_id));
create policy "delete own chat" on public.room_messages for delete to authenticated
  using (user_id = auth.uid());

alter publication supabase_realtime add table public.room_messages;

-- ───────────────────────────────────────────── notify path
-- Inserts an in-app notification row, then (if the Vault secret exists) asks the `push` edge
-- function to deliver an Expo push. Push failures never block the original insert.
create or replace function public.notify_user(
  recipient uuid, p_kind text, p_title text, p_body text, p_payload jsonb, p_category text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  secret text;
  nid uuid;
begin
  if recipient is null then return; end if;

  insert into public.notifications (user_id, kind, payload)
  values (recipient, p_kind, coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('title', p_title, 'body', p_body))
  returning id into nid;

  begin
    select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_webhook_secret' limit 1;
    if coalesce(secret, '') = '' then return; end if;  -- push not set up: in-app inbox only
    perform net.http_post(
      url := 'https://vmdkgkgyzflvqsvecava.supabase.co/functions/v1/push',
      body := jsonb_build_object(
        'user_id', recipient,
        'title', p_title,
        'body', p_body,
        -- Expo data contract: { url, kind, notification_id } (+ category for the push function's prefs check)
        'data', jsonb_build_object(
          'url', coalesce(p_payload ->> 'url', '/notifications'),
          'kind', p_kind,
          'notification_id', nid,
          'category', p_category)
      ),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret),
      timeout_milliseconds := 5000
    );
  exception when others then
    -- Vault / pg_net unavailable or misconfigured: skip push silently.
    null;
  end;
end $$;
revoke execute on function public.notify_user(uuid, text, text, text, jsonb, text) from public, anon, authenticated;

create or replace function public.display_name_of(uid uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select display_name from public.profiles where id = uid), 'Someone');
$$;

-- messages → every other conversation member
create or replace function public.on_message_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m record;
  sender text := public.display_name_of(new.sender_id);
  preview text := case
    when coalesce(new.body, '') <> '' then left(new.body, 140)
    when new.track is not null then 'Sent you a song: ' || coalesce(new.track ->> 'title', 'a track')
    else 'Sent you a message' end;
begin
  for m in
    select user_id from public.conversation_members
    where conversation_id = new.conversation_id and user_id <> new.sender_id
  loop
    perform public.notify_user(m.user_id, 'message', sender, preview,
      jsonb_build_object('conversation_id', new.conversation_id, 'message_id', new.id, 'sender_id', new.sender_id,
        'actor_name', sender, 'url', '/chat?id=' || new.conversation_id::text),
      'messages');
  end loop;
  return new;
end $$;
create trigger on_message_notify after insert on public.messages
  for each row execute function public.on_message_notify();

-- dedications → recipient
create or replace function public.on_dedication_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.recipient_id = new.sender_id then return new; end if;
  perform public.notify_user(new.recipient_id, 'dedication',
    public.display_name_of(new.sender_id) || ' dedicated a song to you',
    coalesce(new.track ->> 'title', 'A song') ||
      case when coalesce(new.message, '') <> '' then ' — ' || left(new.message, 120) else '' end,
    jsonb_build_object('dedication_id', new.id, 'sender_id', new.sender_id,
      'actor_name', public.display_name_of(new.sender_id),
      'track_title', coalesce(new.track ->> 'title', 'A song'), 'track', new.track, 'url', '/messages'),
    'dedications');
  return new;
end $$;
create trigger on_dedication_notify after insert on public.dedications
  for each row execute function public.on_dedication_notify();

-- follows → the person followed
create or replace function public.on_follow_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.notify_user(new.following_id, 'follow', 'New follower',
    public.display_name_of(new.follower_id) || ' started following you',
    jsonb_build_object('follower_id', new.follower_id, 'actor_name', public.display_name_of(new.follower_id),
      'url', '/followers'),
    'new_followers');
  return new;
end $$;
create trigger on_follow_notify after insert on public.follows
  for each row execute function public.on_follow_notify();

-- playlist_collaborators → the added collaborator (owner added them), or the owner (someone joined)
create or replace function public.on_collaborator_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  pl record;
begin
  select id, owner_id, title into pl from public.playlists where id = new.playlist_id;
  if pl.id is null then return new; end if;
  if new.user_id <> pl.owner_id and (auth.uid() is null or auth.uid() <> new.user_id) then
    perform public.notify_user(new.user_id, 'collab_invite', 'You''re a collaborator',
      public.display_name_of(pl.owner_id) || ' added you to "' || pl.title || '"',
      jsonb_build_object('playlist_id', pl.id, 'owner_id', pl.owner_id,
        'actor_name', public.display_name_of(pl.owner_id), 'url', '/playlist?id=' || pl.id::text),
      'playlist_updates');
  elsif new.user_id <> pl.owner_id then
    perform public.notify_user(pl.owner_id, 'collab_invite', 'New collaborator',
      public.display_name_of(new.user_id) || ' joined "' || pl.title || '"',
      jsonb_build_object('playlist_id', pl.id, 'user_id', new.user_id,
        'actor_name', public.display_name_of(new.user_id), 'url', '/playlist?id=' || pl.id::text),
      'playlist_updates');
  end if;
  return new;
end $$;
create trigger on_collaborator_notify after insert on public.playlist_collaborators
  for each row execute function public.on_collaborator_notify();

-- profiles.plan stays server-only (see 20261113160000_lock_profile_plan.sql);
-- the revenuecat-webhook edge function updates it with the service role.
