-- Zoyra phase 7 (Agent L): live listening sessions.
--
-- A live session is a public listening room: the host plays songs and listeners hear the same song
-- in sync (Realtime broadcast), with live chat, song requests, reactions and a listener count
-- (Realtime presence). There is no microphone or video: it is a shared music session only.
--
-- Reuses the rooms infrastructure: a live session owns a `rooms` row (kind 'live') once it starts,
-- so chat lives in room_messages, song requests in room_queue and the last known playback state in
-- rooms.track / position_ms / is_playing (for late joiners).
--
-- New tables:
--   live_sessions        metadata, toggles, schedule, status, listener counts
--   live_session_tracks  the tracklist, kept only when the host turned on "Save replay" (visible 7 days)
--   live_reminders       "notify me" for scheduled sessions (notified when the host goes live)

-- ═════════════════════════════════════════════ rooms: allow kind 'live'
alter table public.rooms drop constraint if exists rooms_kind_check;
alter table public.rooms add constraint rooms_kind_check check (kind in ('group', 'party', 'live'));

-- ═════════════════════════════════════════════ live_sessions
create table public.live_sessions (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles (id) on delete cascade,
  room_id uuid unique references public.rooms (id) on delete set null,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'ended')),
  chat_enabled boolean not null default true,
  requests_enabled boolean not null default true,
  save_replay boolean not null default false,
  notify_followers boolean not null default true,
  scheduled_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  heartbeat_at timestamptz,
  listeners int not null default 0 check (listeners >= 0),
  peak_listeners int not null default 0 check (peak_listeners >= 0),
  created_at timestamptz not null default now(),
  check (status <> 'scheduled' or scheduled_at is not null)
);
create index on public.live_sessions (status, heartbeat_at desc);
create index on public.live_sessions (status, scheduled_at);
create index on public.live_sessions (status, ended_at desc);
create index on public.live_sessions (host_id, created_at desc);
-- One live session at a time per host.
create unique index live_sessions_one_live_per_host on public.live_sessions (host_id) where status = 'live';

alter table public.live_sessions enable row level security;
-- Live sessions are public, except between people who blocked each other.
create policy "live sessions readable" on public.live_sessions for select to authenticated
  using (host_id = auth.uid() or not public.blocked_with(host_id));
create policy "host creates live session" on public.live_sessions for insert to authenticated
  with check (host_id = auth.uid());
create policy "host updates live session" on public.live_sessions for update to authenticated
  using (host_id = auth.uid()) with check (host_id = auth.uid());
create policy "host deletes live session" on public.live_sessions for delete to authenticated
  using (host_id = auth.uid());

-- Server-side rules: valid status transitions, server timestamps, room ownership.
create or replace function public.live_sessions_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  if tg_op = 'INSERT' then
    if new.status = 'ended' then raise exception 'a live session cannot start ended'; end if;
    new.created_at := now();
    new.started_at := null;
    new.ended_at := null;
    new.listeners := 0;
    new.peak_listeners := 0;
    if new.status = 'scheduled' then
      if new.scheduled_at < now() - interval '5 minutes' or new.scheduled_at > now() + interval '60 days' then
        raise exception 'pick a start time within the next 60 days';
      end if;
      new.room_id := null;
      new.heartbeat_at := null;
    else
      new.started_at := now();
      new.heartbeat_at := now();
    end if;
  else
    -- Immutable fields.
    new.host_id := old.host_id;
    new.created_at := old.created_at;
    if old.status = 'ended' and new.status <> 'ended' then raise exception 'this live session has ended'; end if;
    if old.status = 'live' and new.status = 'scheduled' then raise exception 'a live session cannot be rescheduled'; end if;
    if old.status = 'scheduled' and new.status = 'scheduled' and new.scheduled_at is distinct from old.scheduled_at
       and (new.scheduled_at < now() - interval '5 minutes' or new.scheduled_at > now() + interval '60 days') then
      raise exception 'pick a start time within the next 60 days';
    end if;
    if new.status = 'scheduled' then
      new.started_at := null;
      new.ended_at := null;
      new.heartbeat_at := null;
      new.room_id := null;
    end if;
    if new.status = 'live' and old.status = 'scheduled' then
      new.started_at := now();
      new.heartbeat_at := now();
      new.listeners := 0;
      new.peak_listeners := 0;
    elsif new.status = 'live' then
      new.started_at := old.started_at;
      if new.heartbeat_at is distinct from old.heartbeat_at then new.heartbeat_at := now(); end if;
      new.peak_listeners := greatest(old.peak_listeners, new.peak_listeners, new.listeners);
    end if;
    if new.status = 'ended' and old.status <> 'ended' then
      new.ended_at := now();
      new.listeners := 0;
    elsif new.status = 'ended' then
      new.ended_at := old.ended_at;
      new.started_at := old.started_at;
      new.save_replay := old.save_replay;
      new.listeners := 0;
    end if;
  end if;

  if new.room_id is not null and (tg_op = 'INSERT' or new.room_id is distinct from old.room_id) then
    select host_id, kind into r from public.rooms where id = new.room_id;
    if r is null or r.host_id <> new.host_id or r.kind <> 'live' then
      raise exception 'invalid room for this live session';
    end if;
  end if;
  if new.status = 'live' and new.room_id is null then raise exception 'a live session needs a room'; end if;
  return new;
end $$;
create trigger live_sessions_guard before insert or update on public.live_sessions
  for each row execute function public.live_sessions_guard();

-- Closing the room when the session ends.
create or replace function public.live_sessions_close_room() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'ended' and old.status <> 'ended' and new.room_id is not null then
    update public.rooms set is_open = false, is_playing = false, updated_at = now() where id = new.room_id;
  end if;
  return new;
end $$;
create trigger live_sessions_close_room after update on public.live_sessions
  for each row execute function public.live_sessions_close_room();

-- ═════════════════════════════════════════════ live_session_tracks (replay tracklist)
create table public.live_session_tracks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions (id) on delete cascade,
  track jsonb not null check (jsonb_typeof(track) = 'object' and coalesce(track ->> 'id', '') <> ''),
  played_at timestamptz not null default now()
);
create index on public.live_session_tracks (session_id, played_at);

-- True when the caller may read a session's saved tracklist: always for the host; for everyone else
-- only while the session is live or for 7 days after it ended, and only if "Save replay" was on.
create or replace function public.live_replay_visible(sid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.live_sessions s
    where s.id = sid
      and (s.host_id = auth.uid()
           or (s.save_replay and not public.blocked_with(s.host_id)
               and (s.status = 'live' or (s.status = 'ended' and s.ended_at > now() - interval '7 days'))))
  );
$$;
revoke execute on function public.live_replay_visible(uuid) from public, anon;
grant execute on function public.live_replay_visible(uuid) to authenticated;

create or replace function public.is_live_host(sid uuid, need_status text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.live_sessions s
    where s.id = sid and s.host_id = auth.uid() and (need_status is null or s.status = need_status)
  );
$$;
revoke execute on function public.is_live_host(uuid, text) from public, anon;
grant execute on function public.is_live_host(uuid, text) to authenticated;

alter table public.live_session_tracks enable row level security;
create policy "replay tracks readable" on public.live_session_tracks for select to authenticated
  using (public.live_replay_visible(session_id));
create policy "host records tracks" on public.live_session_tracks for insert to authenticated
  with check (public.is_live_host(session_id, 'live')
              and exists (select 1 from public.live_sessions s where s.id = session_id and s.save_replay));
create policy "host deletes tracks" on public.live_session_tracks for delete to authenticated
  using (public.is_live_host(session_id, null));

create or replace function public.live_session_tracks_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.played_at := now();
  if (select count(*) from public.live_session_tracks where session_id = new.session_id) >= 500 then
    raise exception 'replay tracklist is full';
  end if;
  return new;
end $$;
create trigger live_session_tracks_guard before insert on public.live_session_tracks
  for each row execute function public.live_session_tracks_guard();

-- ═════════════════════════════════════════════ live_reminders ("notify me")
create table public.live_reminders (
  session_id uuid not null references public.live_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (session_id, user_id)
);
create index on public.live_reminders (user_id);

alter table public.live_reminders enable row level security;
create policy "own reminders readable" on public.live_reminders for select to authenticated
  using (user_id = auth.uid());
create policy "set own reminder" on public.live_reminders for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from public.live_sessions s
                          where s.id = session_id and s.status = 'scheduled'
                            and s.host_id <> auth.uid() and not public.blocked_with(s.host_id)));
create policy "remove own reminder" on public.live_reminders for delete to authenticated
  using (user_id = auth.uid());

-- How many people asked to be notified (hosts see this on their upcoming sessions).
create or replace function public.live_reminder_count(sid uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.live_reminders where session_id = sid;
$$;
revoke execute on function public.live_reminder_count(uuid) from public, anon;
grant execute on function public.live_reminder_count(uuid) to authenticated;

-- ═════════════════════════════════════════════ notify when a session goes live
-- Everyone who tapped "Notify me" gets a notification (category 'live_reminders'). If the host kept
-- "Notify followers" on, followers get one too (category 'friend_activity', so the existing toggle
-- applies) — at most once per 30 minutes per host to avoid spam from restarts.
create or replace function public.on_live_started_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  host_name text := public.display_name_of(new.host_id);
  payload jsonb := jsonb_build_object('session_id', new.id, 'actor_id', new.host_id, 'actor_name', host_name,
                                      'url', '/live-room?id=' || new.id::text);
  rec record;
  recent boolean;
begin
  if new.status <> 'live' or (tg_op = 'UPDATE' and old.status = 'live') then return new; end if;

  for rec in
    select r.user_id from public.live_reminders r
    where r.session_id = new.id and r.user_id <> new.host_id
      and not exists (select 1 from public.blocks b
                      where (b.blocker_id = r.user_id and b.blocked_id = new.host_id)
                         or (b.blocker_id = new.host_id and b.blocked_id = r.user_id))
  loop
    perform public.notify_user(rec.user_id, 'live', host_name || ' is live now',
      new.title, payload, 'live_reminders');
  end loop;

  if new.notify_followers then
    select exists (
      select 1 from public.live_sessions s
      where s.host_id = new.host_id and s.id <> new.id and s.started_at > now() - interval '30 minutes'
    ) into recent;
    if not recent then
      for rec in
        select f.follower_id as user_id from public.follows f
        where f.following_id = new.host_id
          and not exists (select 1 from public.live_reminders r where r.session_id = new.id and r.user_id = f.follower_id)
          and not exists (select 1 from public.blocks b
                          where (b.blocker_id = f.follower_id and b.blocked_id = new.host_id)
                             or (b.blocker_id = new.host_id and b.blocked_id = f.follower_id))
        limit 1000
      loop
        perform public.notify_user(rec.user_id, 'live', host_name || ' went live',
          new.title, payload, 'friend_activity');
      end loop;
    end if;
  end if;
  return new;
end $$;
create trigger on_live_started_notify after insert or update of status on public.live_sessions
  for each row execute function public.on_live_started_notify();

-- ═════════════════════════════════════════════ joining
-- Listeners join the session's room (needed for room chat / requests RLS). Returns the room id.
create or replace function public.join_live(sid uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  s record;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into s from public.live_sessions where id = sid;
  if s is null then raise exception 'live session not found'; end if;
  if s.status <> 'live' or s.room_id is null then raise exception 'this session is not live'; end if;
  if s.host_id <> auth.uid() and public.blocked_with(s.host_id) then raise exception 'live session not found'; end if;
  if s.host_id <> auth.uid() then
    insert into public.room_members (room_id, user_id) values (s.room_id, auth.uid()) on conflict do nothing;
  end if;
  return s.room_id;
end $$;
revoke execute on function public.join_live(uuid) from public, anon;
grant execute on function public.join_live(uuid) to authenticated;

-- ═════════════════════════════════════════════ guards on the reused room tables
-- Only the host changes a live room's playback state (group/party rooms keep their member updates).
create or replace function public.rooms_live_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (old.kind = 'live' or new.kind = 'live') and auth.uid() is not null and auth.uid() <> old.host_id then
    raise exception 'only the host controls a live session';
  end if;
  if new.kind is distinct from old.kind and auth.uid() is not null then
    raise exception 'room kind cannot change';
  end if;
  return new;
end $$;
create trigger rooms_live_guard before update on public.rooms
  for each row execute function public.rooms_live_guard();

-- Live chat / song requests follow the host's toggles and only work while the session is live.
create or replace function public.live_room_message_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  s record;
begin
  if not exists (select 1 from public.rooms where id = new.room_id and kind = 'live') then return new; end if;
  select * into s from public.live_sessions where room_id = new.room_id;
  if s is null or s.status <> 'live' then raise exception 'this live session has ended'; end if;
  if not s.chat_enabled and auth.uid() is distinct from s.host_id then raise exception 'live chat is off'; end if;
  return new;
end $$;
create trigger live_room_message_guard before insert on public.room_messages
  for each row execute function public.live_room_message_guard();

create or replace function public.live_room_queue_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  s record;
begin
  if not exists (select 1 from public.rooms where id = new.room_id and kind = 'live') then return new; end if;
  select * into s from public.live_sessions where room_id = new.room_id;
  if s is null or s.status <> 'live' then raise exception 'this live session has ended'; end if;
  if auth.uid() is distinct from s.host_id then
    if not s.requests_enabled then raise exception 'song requests are off'; end if;
    if (select count(*) from public.room_queue where room_id = new.room_id and added_by = auth.uid()) >= 3 then
      raise exception 'you already have 3 requests waiting';
    end if;
  end if;
  return new;
end $$;
create trigger live_room_queue_guard before insert on public.room_queue
  for each row execute function public.live_room_queue_guard();

-- ═════════════════════════════════════════════ realtime
alter publication supabase_realtime add table public.live_sessions;
