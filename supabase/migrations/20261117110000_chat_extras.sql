-- Chat extras (Chat Pro redesign): time capsules, whisper (view once) photos, starred messages and editable
-- scheduled messages. Everything the user writes stays end-to-end encrypted: capsule text / song and whisper
-- photos travel inside the encrypted payload (send_e2ee_message); this migration only adds the METADATA the
-- server must know to enforce the rules (open date, view-once state, storage path of the encrypted file).
--
--   messages.kind               + 'capsule', 'whisper' (both must be encrypted: messages_extras_e2ee).
--   send_e2ee_message           same as 20261115250000 + the two kinds.
--   message_capsules            (message_id, opens_at, hide, reminder): sealed by the sender right after the send
--                               (seal_capsule). While hide = true and opens_at is in the future the recipients'
--                               message_keys rows are NOT readable (restrictive RLS below), so the content key is
--                               unavailable on their phones until the date: the ciphertext is delivered, the key
--                               is not. A capsule row that was never sealed stays locked for recipients.
--   capsule_reminders()         pg_cron every 5 min: "Your time capsule opens today" for both sides (reminder).
--   message_whispers            (message_id, media_path): registered by the sender (register_whisper).
--   whisper_views               (message_id, user_id, viewed_at, screenshot_at).
--   mark_whisper_viewed(mid)    recipient opened it: view row + their message_keys deleted; the encrypted file
--                               becomes unreadable for them (restrictive storage policy); the sender's app deletes it
--                               once every recipient has viewed it.
--   whisper_screenshot(mid)     notifies the sender once ("X took a screenshot").
--   message_stars               per-user stars (RLS own + message visible).
--   edit_scheduled_message      edit text / time of my pending "send later" message.
--
-- The iOS push function must not ship the envelope of a capsule / whisper inside the notification
-- (supabase/functions/push cryptoBundle skips those kinds), otherwise a sealed capsule could be previewed.

-- ═════════════════════════════════════════════ kinds
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text', 'track', 'voice', 'poll', 'lyric', 'playlist', 'jam', 'live', 'photo', 'location', 'swap', 'call', 'capsule', 'whisper'));

alter table public.messages drop constraint if exists messages_extras_e2ee;
alter table public.messages add constraint messages_extras_e2ee
  check (kind not in ('capsule', 'whisper') or e2ee_version is not null) not valid;

-- Same as 20261115250000_e2ee.sql, plus 'capsule' and 'whisper'.
create or replace function public.send_e2ee_message(
  p_cid uuid, p_message_id uuid, p_ciphertext text, p_nonce text, p_sender_device_id uuid, p_signature text,
  p_kind text default 'text', p_reply_to uuid default null, p_envelopes jsonb default '[]'::jsonb, p_version int default 1
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if p_message_id is null then raise exception 'message id required' using errcode = '22023'; end if;
  if coalesce(p_kind, '') not in ('text', 'track', 'voice', 'poll', 'lyric', 'playlist', 'jam', 'live', 'photo', 'location', 'capsule', 'whisper') then
    raise exception 'This kind of message can''t be encrypted' using errcode = '22023', hint = 'e2ee_kind';
  end if;
  -- Same rules as the "send messages" insert policy (this function bypasses RLS).
  if not public.is_conversation_member(p_cid) then
    raise exception 'This conversation is no longer available.' using errcode = '42501';
  end if;
  if public.conversation_blocked(p_cid) then
    raise exception 'You can''t message this person' using errcode = '42501', hint = 'blocked';
  end if;
  if not public.dm_can_send(p_cid) then
    raise exception 'You can send up to 3 messages until they accept your request' using errcode = '42501', hint = 'request_pending';
  end if;
  perform public.e2ee_check_envelopes(p_cid, p_sender_device_id, p_envelopes, p_ciphertext, p_nonce, p_signature, p_version);

  insert into public.messages (id, conversation_id, sender_id, body, track, kind, reply_to, meta,
                               e2ee_version, ciphertext, nonce, sender_device_id, signature)
  values (p_message_id, p_cid, me, '', null, p_kind, p_reply_to, '{"e2ee": 1}'::jsonb,
          p_version, p_ciphertext, p_nonce, p_sender_device_id, p_signature);
  perform public.e2ee_insert_envelopes(p_message_id, p_envelopes);
  return p_message_id;
end $$;
revoke execute on function public.send_e2ee_message(uuid, uuid, text, text, uuid, text, text, uuid, jsonb, int) from public, anon;
grant execute on function public.send_e2ee_message(uuid, uuid, text, text, uuid, text, text, uuid, jsonb, int) to authenticated;

-- ═════════════════════════════════════════════ time capsules
create table if not exists public.message_capsules (
  message_id uuid primary key references public.messages (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  opens_at timestamptz not null,
  hide boolean not null default true,
  reminder boolean not null default true,
  reminded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists message_capsules_conv_idx on public.message_capsules (conversation_id);
create index if not exists message_capsules_due_idx on public.message_capsules (opens_at) where reminder and reminded_at is null;
alter table public.message_capsules enable row level security;
revoke insert, update, delete on public.message_capsules from anon, authenticated;
drop policy if exists "members read capsules" on public.message_capsules;
create policy "members read capsules" on public.message_capsules for select to authenticated
  using (public.message_visible(message_id));

-- Seals my capsule message (once). opens_at: 1 minute .. 5 years ahead.
create or replace function public.seal_capsule(mid uuid, p_opens_at timestamptz, p_hide boolean default true, p_reminder boolean default true)
returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.messages%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into m from public.messages where id = mid;
  if not found or m.sender_id is distinct from auth.uid() then
    raise exception 'This message is no longer available.' using errcode = 'P0002';
  end if;
  if m.kind <> 'capsule' then raise exception 'Not a time capsule' using errcode = '22023'; end if;
  if p_opens_at is null or p_opens_at < now() + interval '1 minute' or p_opens_at > now() + interval '5 years' then
    raise exception 'Pick an open date between tomorrow and 5 years from now' using errcode = '22023', hint = 'capsule_date';
  end if;
  insert into public.message_capsules (message_id, conversation_id, sender_id, opens_at, hide, reminder)
  values (mid, m.conversation_id, m.sender_id, p_opens_at, coalesce(p_hide, true), coalesce(p_reminder, true))
  on conflict (message_id) do nothing;
  if not found then raise exception 'This capsule is already sealed' using errcode = '23505'; end if;
end $$;
revoke execute on function public.seal_capsule(uuid, timestamptz, boolean, boolean) from public, anon;
grant execute on function public.seal_capsule(uuid, timestamptz, boolean, boolean) to authenticated;

-- Pending capsules I sent (Scheduled screen) are listed with a plain select on message_capsules.

create or replace function public.capsule_reminders() returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  u record;
  n int := 0;
  sender text;
begin
  for r in
    select c.* from public.message_capsules c
    where c.reminder and c.reminded_at is null and c.opens_at <= now()
    order by c.opens_at
    limit 200
    for update skip locked
  loop
    sender := coalesce(public.display_name_of(r.sender_id), 'Someone');
    for u in select cm.user_id from public.conversation_members cm where cm.conversation_id = r.conversation_id loop
      -- No message_id in the payload: the reminder is a plain notification, never a decrypted preview.
      perform public.notify_user(u.user_id, 'capsule_open', 'Time capsule',
        case when u.user_id = r.sender_id then 'Your time capsule opens today'
             else 'A time capsule from ' || sender || ' is ready to open' end,
        jsonb_build_object('conversation_id', r.conversation_id, 'capsule_id', r.message_id, 'sender_id', r.sender_id,
          'actor_name', sender, 'url', '/chat-pro?id=' || r.conversation_id::text),
        'messages');
    end loop;
    update public.message_capsules set reminded_at = now() where message_id = r.message_id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.capsule_reminders() from public, anon, authenticated;

-- ═════════════════════════════════════════════ whispers (view once)
create table if not exists public.message_whispers (
  message_id uuid primary key references public.messages (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  media_path text not null,
  created_at timestamptz not null default now()
);
create index if not exists message_whispers_path_idx on public.message_whispers (media_path);
alter table public.message_whispers enable row level security;
revoke insert, update, delete on public.message_whispers from anon, authenticated;
drop policy if exists "sender reads whisper" on public.message_whispers;
create policy "sender reads whisper" on public.message_whispers for select to authenticated
  using (sender_id = auth.uid());

create table if not exists public.whisper_views (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  viewed_at timestamptz,
  screenshot_at timestamptz,
  primary key (message_id, user_id)
);
alter table public.whisper_views enable row level security;
revoke insert, update, delete on public.whisper_views from anon, authenticated;
drop policy if exists "whisper views" on public.whisper_views;
create policy "whisper views" on public.whisper_views for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.messages m where m.id = message_id and m.sender_id = auth.uid()));

create or replace function public.register_whisper(mid uuid, p_path text) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.messages%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into m from public.messages where id = mid;
  if not found or m.sender_id is distinct from auth.uid() then
    raise exception 'This message is no longer available.' using errcode = 'P0002';
  end if;
  if m.kind <> 'whisper' then raise exception 'Not a view-once message' using errcode = '22023'; end if;
  if p_path is null or p_path not like m.conversation_id::text || '/' || auth.uid()::text || '/%' or p_path like '%..%' then
    raise exception 'Invalid media path' using errcode = '22023';
  end if;
  insert into public.message_whispers (message_id, conversation_id, sender_id, media_path)
  values (mid, m.conversation_id, m.sender_id, p_path)
  on conflict (message_id) do nothing;
end $$;
revoke execute on function public.register_whisper(uuid, text) from public, anon;
grant execute on function public.register_whisper(uuid, text) to authenticated;

-- Recipient opened the whisper. Returns {path, all_viewed}. The encrypted file is deleted by the sender's app
-- once all_viewed (only the sender can still read / delete it).
create or replace function public.mark_whisper_viewed(mid uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  m public.messages%rowtype;
  w public.message_whispers%rowtype;
  waiting int;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into m from public.messages where id = mid;
  if not found or m.kind <> 'whisper' or not public.message_visible(mid) then
    raise exception 'This message is no longer available.' using errcode = 'P0002';
  end if;
  if m.sender_id = me then raise exception 'You sent this photo' using errcode = '22023'; end if;
  insert into public.whisper_views (message_id, user_id, viewed_at) values (mid, me, now())
  on conflict (message_id, user_id) do update set viewed_at = coalesce(public.whisper_views.viewed_at, excluded.viewed_at);
  delete from public.message_keys where message_id = mid and user_id = me;
  select * into w from public.message_whispers where message_id = mid;
  select count(*) into waiting from public.conversation_members cm
  where cm.conversation_id = m.conversation_id and cm.user_id <> m.sender_id
    and not exists (select 1 from public.whisper_views v where v.message_id = mid and v.user_id = cm.user_id and v.viewed_at is not null);
  return jsonb_build_object('path', w.media_path, 'all_viewed', waiting = 0);
end $$;
revoke execute on function public.mark_whisper_viewed(uuid) from public, anon;
grant execute on function public.mark_whisper_viewed(uuid) to authenticated;

create or replace function public.whisper_screenshot(mid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  m public.messages%rowtype;
  first boolean;
  who text;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into m from public.messages where id = mid;
  if not found or m.kind <> 'whisper' or m.sender_id = me or not public.is_conversation_member(m.conversation_id) then
    return;
  end if;
  insert into public.whisper_views (message_id, user_id, screenshot_at) values (mid, me, now())
  on conflict (message_id, user_id) do update set screenshot_at = now()
    where public.whisper_views.screenshot_at is null
  returning true into first;
  if not coalesce(first, false) then return; end if;
  who := coalesce(public.display_name_of(me), 'Someone');
  perform public.notify_user(m.sender_id, 'whisper_screenshot', who, who || ' took a screenshot of your view-once photo',
    jsonb_build_object('conversation_id', m.conversation_id, 'sender_id', me, 'actor_name', who,
      'url', '/chat-pro?id=' || m.conversation_id::text),
    'messages');
end $$;
revoke execute on function public.whisper_screenshot(uuid) from public, anon;
grant execute on function public.whisper_screenshot(uuid) to authenticated;

-- ═════════════════════════════════════════════ key release (restrictive RLS on message_keys)
-- Capsules: recipients get their envelope only once sealed AND (not hidden OR opened). Whispers: no envelope
-- after viewing (mark_whisper_viewed also deletes it). Everything else: unchanged.
create or replace function public.message_key_released(mid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when m.sender_id = auth.uid() then true
      when m.kind = 'capsule' then exists (
        select 1 from public.message_capsules c where c.message_id = m.id and (not c.hide or c.opens_at <= now()))
      when m.kind = 'whisper' then not exists (
        select 1 from public.whisper_views v where v.message_id = m.id and v.user_id = auth.uid() and v.viewed_at is not null)
      else true
    end
    from public.messages m where m.id = mid), true);
$$;
revoke execute on function public.message_key_released(uuid) from public, anon;
grant execute on function public.message_key_released(uuid) to authenticated;

drop policy if exists "released keys only" on public.message_keys;
create policy "released keys only" on public.message_keys as restrictive for select to authenticated
  using (public.message_key_released(message_id));

-- Viewed whisper files: unreadable for that viewer. The sender's app deletes the encrypted file once every
-- recipient has viewed it ("chat media delete own"; it sees whisper_views).
create or replace function public.whisper_file_viewed(object_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.message_whispers w
    join public.whisper_views v on v.message_id = w.message_id
    where w.media_path = object_name and v.user_id = auth.uid() and v.viewed_at is not null);
$$;
revoke execute on function public.whisper_file_viewed(text) from public, anon;
grant execute on function public.whisper_file_viewed(text) to authenticated;

drop policy if exists "whisper viewed hidden" on storage.objects;
create policy "whisper viewed hidden" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'chat-media' or not public.whisper_file_viewed(name));

-- ═════════════════════════════════════════════ starred messages
create table if not exists public.message_stars (
  user_id uuid not null references public.profiles (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);
create index if not exists message_stars_conv_idx on public.message_stars (user_id, conversation_id);
alter table public.message_stars enable row level security;

create or replace function public.message_star_fill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select m.conversation_id into new.conversation_id from public.messages m where m.id = new.message_id;
  new.user_id := coalesce(auth.uid(), new.user_id);
  new.created_at := now();
  return new;
end $$;
revoke execute on function public.message_star_fill() from public, anon, authenticated;
drop trigger if exists message_star_fill on public.message_stars;
create trigger message_star_fill before insert on public.message_stars
  for each row execute function public.message_star_fill();

drop policy if exists "own stars read" on public.message_stars;
create policy "own stars read" on public.message_stars for select to authenticated
  using (user_id = auth.uid() and public.message_visible(message_id));
drop policy if exists "own stars add" on public.message_stars;
create policy "own stars add" on public.message_stars for insert to authenticated
  with check (user_id = auth.uid() and public.message_visible(message_id));
drop policy if exists "own stars remove" on public.message_stars;
create policy "own stars remove" on public.message_stars for delete to authenticated
  using (user_id = auth.uid());
revoke update on public.message_stars from anon, authenticated;

-- ═════════════════════════════════════════════ scheduled messages: edit
create or replace function public.edit_scheduled_message(sid uuid, p_body text, p_send_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 2000 then
    raise exception 'Message is empty' using errcode = '22023';
  end if;
  if p_send_at is null or p_send_at <= now() or p_send_at >= now() + interval '30 days' then
    raise exception 'Pick a time in the next 30 days' using errcode = '22023';
  end if;
  update public.scheduled_messages set body = btrim(p_body), send_at = p_send_at
  where id = sid and sender_id = auth.uid() and sent_at is null and failed is null;
  if not found then raise exception 'This message was already sent or cancelled.' using errcode = 'P0002'; end if;
end $$;
revoke execute on function public.edit_scheduled_message(uuid, text, timestamptz) from public, anon;
grant execute on function public.edit_scheduled_message(uuid, text, timestamptz) to authenticated;

-- ═════════════════════════════════════════════ jobs
create extension if not exists pg_cron;
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'zoyra-capsule-reminders';
  perform cron.schedule('zoyra-capsule-reminders', '*/5 * * * *', $cmd$select public.capsule_reminders()$cmd$);
end $$;
