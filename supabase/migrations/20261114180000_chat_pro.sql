-- Chat Pro: richer 1:1 chat (ChatPro, ChatActions, ChatAttach, ChatInfo, ChatVoice designs).
--
--   messages            + kind / reply_to / meta (voice notes, polls, lyric cards, playlists, jams,
--                         live invites, photos, locations)
--   message_reactions   emoji reactions (fixed set), one row per user per emoji
--   message_pins        pinned messages, shared by both members
--   message_hidden      "Delete for me" (hides a message for the caller only)
--   poll_votes          one vote per user per poll (changeable)
--   scheduled_messages  "Send later": delivered by pg_cron every minute
--   conversation_members + muted / read_receipts (per member)
--   conversations       + disappear_seconds / disappear_since (disappearing messages, both members)
--   storage bucket      chat-media (private): <conversation_id>/<user_id>/<file>, members only
--
-- RLS is on for every new table. Everything is scoped to conversation members via
-- public.is_conversation_member(), and writes respect blocks (public.conversation_blocked()).

-- ═════════════════════════════════════════════ messages: new columns
alter table public.messages
  add column if not exists kind text not null default 'text'
    check (kind in ('text', 'track', 'voice', 'poll', 'lyric', 'playlist', 'jam', 'live', 'photo', 'location')),
  add column if not exists reply_to uuid references public.messages (id) on delete set null,
  add column if not exists meta jsonb not null default '{}'::jsonb;

alter table public.messages drop constraint if exists messages_meta_size;
alter table public.messages add constraint messages_meta_size check (pg_column_size(meta) <= 8192);

-- Reply target must be in the same conversation.
create or replace function public.message_reply_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.reply_to is not null and not exists (
    select 1 from public.messages where id = new.reply_to and conversation_id = new.conversation_id
  ) then
    raise exception 'Reply target is not in this conversation' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists message_reply_guard on public.messages;
create trigger message_reply_guard before insert on public.messages
  for each row execute function public.message_reply_guard();

-- Conversation of a message, if the caller is a member (null otherwise). Used by policies.
create or replace function public.message_member_conversation(mid uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select m.conversation_id from public.messages m
  where m.id = mid and public.is_conversation_member(m.conversation_id);
$$;
revoke execute on function public.message_member_conversation(uuid) from public, anon;
grant execute on function public.message_member_conversation(uuid) to authenticated;

-- ═════════════════════════════════════════════ conversation settings
alter table public.conversation_members
  add column if not exists muted boolean not null default false,
  add column if not exists read_receipts boolean not null default true;

alter table public.conversations
  add column if not exists disappear_seconds int check (disappear_seconds in (86400, 604800, 7776000)),
  add column if not exists disappear_since timestamptz;

-- Either member can turn disappearing messages on/off. Applies to messages sent from now on.
create or replace function public.set_disappearing(cid uuid, seconds int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not public.is_conversation_member(cid) then raise exception 'Not a member of this conversation' using errcode = '42501'; end if;
  if seconds is not null and seconds not in (86400, 604800, 7776000) then
    raise exception 'Unsupported timer' using errcode = '22023';
  end if;
  update public.conversations
    set disappear_seconds = seconds,
        disappear_since = case when seconds is null then null else now() end
    where id = cid;
end $$;
revoke execute on function public.set_disappearing(uuid, int) from public, anon;
grant execute on function public.set_disappearing(uuid, int) to authenticated;

-- Expired disappearing messages are hidden immediately (restrictive policy) and deleted by cron.
create or replace function public.message_expired(cid uuid, created timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversations c
    where c.id = cid and c.disappear_seconds is not null and c.disappear_since is not null
      and created >= c.disappear_since
      and created < now() - make_interval(secs => c.disappear_seconds)
  );
$$;
revoke execute on function public.message_expired(uuid, timestamptz) from public, anon;
grant execute on function public.message_expired(uuid, timestamptz) to authenticated;

drop policy if exists "hide expired messages" on public.messages;
create policy "hide expired messages" on public.messages as restrictive for select to authenticated
  using (not public.message_expired(conversation_id, created_at));

-- ═════════════════════════════════════════════ reactions
create table if not exists public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null check (emoji in ('❤️', '🔥', '😂', '👏', '😮', '😢', '👍', '🎵', '💯', '🙏')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index if not exists message_reactions_conv_idx on public.message_reactions (conversation_id);
alter table public.message_reactions enable row level security;

drop policy if exists "members read reactions" on public.message_reactions;
create policy "members read reactions" on public.message_reactions for select to authenticated
  using (public.is_conversation_member(conversation_id));
drop policy if exists "members react" on public.message_reactions;
create policy "members react" on public.message_reactions for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.message_member_conversation(message_id) = conversation_id
    and not public.conversation_blocked(conversation_id)
  );
drop policy if exists "remove own reaction" on public.message_reactions;
create policy "remove own reaction" on public.message_reactions for delete to authenticated
  using (user_id = auth.uid());

-- ═════════════════════════════════════════════ pins
create table if not exists public.message_pins (
  message_id uuid primary key references public.messages (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  pinned_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists message_pins_conv_idx on public.message_pins (conversation_id, created_at desc);
alter table public.message_pins enable row level security;

drop policy if exists "members read pins" on public.message_pins;
create policy "members read pins" on public.message_pins for select to authenticated
  using (public.is_conversation_member(conversation_id));
drop policy if exists "members pin" on public.message_pins;
create policy "members pin" on public.message_pins for insert to authenticated
  with check (
    pinned_by = auth.uid()
    and public.message_member_conversation(message_id) = conversation_id
    and not public.conversation_blocked(conversation_id)
  );
drop policy if exists "members unpin" on public.message_pins;
create policy "members unpin" on public.message_pins for delete to authenticated
  using (public.is_conversation_member(conversation_id));

-- ═════════════════════════════════════════════ delete for me
create table if not exists public.message_hidden (
  user_id uuid not null references public.profiles (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);
alter table public.message_hidden enable row level security;

drop policy if exists "own hidden messages" on public.message_hidden;
create policy "own hidden messages" on public.message_hidden for select to authenticated
  using (user_id = auth.uid());
drop policy if exists "hide message for me" on public.message_hidden;
create policy "hide message for me" on public.message_hidden for insert to authenticated
  with check (user_id = auth.uid() and public.message_member_conversation(message_id) is not null);
drop policy if exists "unhide message" on public.message_hidden;
create policy "unhide message" on public.message_hidden for delete to authenticated
  using (user_id = auth.uid());

-- ═════════════════════════════════════════════ polls
create table if not exists public.poll_votes (
  message_id uuid not null references public.messages (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  option smallint not null check (option between 0 and 3),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists poll_votes_conv_idx on public.poll_votes (conversation_id);
alter table public.poll_votes enable row level security;

create or replace function public.poll_option_ok(mid uuid, cid uuid, opt int) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.messages m
    where m.id = mid and m.conversation_id = cid and m.kind = 'poll'
      and jsonb_typeof(m.meta -> 'options') = 'array'
      and opt >= 0 and opt < jsonb_array_length(m.meta -> 'options')
  ) and public.is_conversation_member(cid);
$$;
revoke execute on function public.poll_option_ok(uuid, uuid, int) from public, anon;
grant execute on function public.poll_option_ok(uuid, uuid, int) to authenticated;

drop policy if exists "members read votes" on public.poll_votes;
create policy "members read votes" on public.poll_votes for select to authenticated
  using (public.is_conversation_member(conversation_id));
drop policy if exists "members vote" on public.poll_votes;
create policy "members vote" on public.poll_votes for insert to authenticated
  with check (user_id = auth.uid() and public.poll_option_ok(message_id, conversation_id, option) and not public.conversation_blocked(conversation_id));
drop policy if exists "change own vote" on public.poll_votes;
create policy "change own vote" on public.poll_votes for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.poll_option_ok(message_id, conversation_id, option));
drop policy if exists "remove own vote" on public.poll_votes;
create policy "remove own vote" on public.poll_votes for delete to authenticated
  using (user_id = auth.uid());

-- ═════════════════════════════════════════════ scheduled messages
create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  send_at timestamptz not null,
  sent_at timestamptz,
  failed text,
  created_at timestamptz not null default now()
);
create index if not exists scheduled_messages_due_idx on public.scheduled_messages (send_at) where sent_at is null and failed is null;
alter table public.scheduled_messages enable row level security;

drop policy if exists "own scheduled" on public.scheduled_messages;
create policy "own scheduled" on public.scheduled_messages for select to authenticated
  using (sender_id = auth.uid());
drop policy if exists "schedule message" on public.scheduled_messages;
create policy "schedule message" on public.scheduled_messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and sent_at is null and failed is null
    and send_at > now() and send_at < now() + interval '30 days'
    and public.is_conversation_member(conversation_id)
    and not public.conversation_blocked(conversation_id)
  );
drop policy if exists "cancel scheduled" on public.scheduled_messages;
create policy "cancel scheduled" on public.scheduled_messages for delete to authenticated
  using (sender_id = auth.uid() and sent_at is null);

-- Runs as the job owner: re-checks membership and blocks for each due row, then posts it.
create or replace function public.deliver_scheduled_messages() returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select * from public.scheduled_messages
    where sent_at is null and failed is null and send_at <= now()
    order by send_at
    limit 200
    for update skip locked
  loop
    if not exists (select 1 from public.conversation_members where conversation_id = r.conversation_id and user_id = r.sender_id) then
      update public.scheduled_messages set failed = 'no_longer_member' where id = r.id;
    elsif exists (
      select 1 from public.conversation_members m
      join public.blocks b
        on (b.blocker_id = r.sender_id and b.blocked_id = m.user_id)
        or (b.blocked_id = r.sender_id and b.blocker_id = m.user_id)
      where m.conversation_id = r.conversation_id and m.user_id <> r.sender_id
    ) then
      update public.scheduled_messages set failed = 'blocked' where id = r.id;
    else
      insert into public.messages (conversation_id, sender_id, body, kind)
      values (r.conversation_id, r.sender_id, r.body, 'text');
      update public.scheduled_messages set sent_at = now() where id = r.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.deliver_scheduled_messages() from public, anon, authenticated;

create or replace function public.purge_expired_messages() returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  delete from public.messages m
  using public.conversations c
  where m.conversation_id = c.id
    and c.disappear_seconds is not null and c.disappear_since is not null
    and m.created_at >= c.disappear_since
    and m.created_at < now() - make_interval(secs => c.disappear_seconds);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.purge_expired_messages() from public, anon, authenticated;

create extension if not exists pg_cron;
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'zoyra-chat-scheduled';
  perform cron.schedule('zoyra-chat-scheduled', '* * * * *', $cmd$select public.deliver_scheduled_messages()$cmd$);
  perform cron.unschedule(jobid) from cron.job where jobname = 'zoyra-chat-disappearing';
  perform cron.schedule('zoyra-chat-disappearing', '*/10 * * * *', $cmd$select public.purge_expired_messages()$cmd$);
end $$;

-- ═════════════════════════════════════════════ message notifications: skip muted members
-- Same as phase3's on_message_notify, plus: muted members get no notification, previews
-- describe the new message kinds, and the deep link opens the new chat screen.
create or replace function public.on_message_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m record;
  sender text := public.display_name_of(new.sender_id);
  preview text := case
    when new.kind = 'voice' then 'Sent a voice note'
    when new.kind = 'photo' then 'Sent a photo'
    when new.kind = 'poll' then 'Poll: ' || left(coalesce(new.meta ->> 'question', ''), 120)
    when new.kind = 'jam' then 'Invited you to a jam'
    when new.kind = 'live' then 'Invited you to a live session'
    when new.kind = 'location' then 'Shared a location'
    when new.kind = 'playlist' then 'Sent you a playlist: ' || coalesce(new.meta ->> 'title', 'a playlist')
    when new.kind = 'lyric' then 'Sent a lyric card'
    when coalesce(new.body, '') <> '' then left(new.body, 140)
    when new.track is not null then 'Sent you a song: ' || coalesce(new.track ->> 'title', 'a track')
    else 'Sent you a message' end;
begin
  for m in
    select user_id from public.conversation_members
    where conversation_id = new.conversation_id and user_id <> new.sender_id and not muted
  loop
    perform public.notify_user(m.user_id, 'message', sender, preview,
      jsonb_build_object('conversation_id', new.conversation_id, 'message_id', new.id, 'sender_id', new.sender_id,
        'actor_name', sender, 'url', '/chat-pro?id=' || new.conversation_id::text),
      'messages');
  end loop;
  return new;
end $$;

-- ═════════════════════════════════════════════ storage: chat-media (voice notes, photos)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-media', 'chat-media', false, 10485760,
  array['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/webm', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

-- Path layout: <conversation_id>/<user_id>/<file>. Bad paths (non-uuid folders) are rejected.
create or replace function public.chat_media_member(object_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  cid uuid;
begin
  begin
    cid := (storage.foldername(object_name))[1]::uuid;
  exception when others then
    return false;
  end;
  return public.is_conversation_member(cid);
end $$;
revoke execute on function public.chat_media_member(text) from public, anon;
grant execute on function public.chat_media_member(text) to authenticated;

drop policy if exists "chat media read" on storage.objects;
create policy "chat media read" on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and public.chat_media_member(name));
drop policy if exists "chat media upload" on storage.objects;
create policy "chat media upload" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-media'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.chat_media_member(name)
  );
drop policy if exists "chat media delete own" on storage.objects;
create policy "chat media delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-media' and (storage.foldername(name))[2] = auth.uid()::text);

-- ═════════════════════════════════════════════ realtime
do $$
begin
  begin alter publication supabase_realtime add table public.message_reactions; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.message_pins; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.poll_votes; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.conversation_members; exception when duplicate_object then null; end;
end $$;
