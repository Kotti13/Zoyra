-- Zoyra phase 10 (Agent N2): notification center kinds.
--
--   new_release  hourly `new-releases` edge function (pg_cron → pg_net, Vault secret header) checks
--                Audius for tracks released by followed artists since each user's last check.
--   room_join    trigger on room_members: "<name> joined your jam" to the room host.
--   live         already sent by on_live_started_notify (20261114120000_live.sql); unchanged here.
--   downloads_ready is a device-only local notification (no server side).
--
-- All rows go through public.notify_user(...) (20261113180000_phase3.sql), which inserts the inbox
-- row and asks the `push` function to deliver it (that function honours the per-category toggles).

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ═════════════════════════════════════════════ new releases: state
-- Per (user, artist): newest release time already accounted for. A user with no row yet starts
-- from the time they followed the artist, so following never floods them with the back catalogue.
create table public.new_release_checks (
  user_id uuid not null references public.profiles (id) on delete cascade,
  artist_id text not null,
  last_seen_at timestamptz not null,
  checked_at timestamptz not null default now(),
  primary key (user_id, artist_id)
);
create index on public.new_release_checks (artist_id);

-- Per artist: when Audius was last polled (round-robin cursor so each run takes the stalest artists).
create table public.new_release_artists (
  artist_id text primary key,
  checked_at timestamptz not null default now(),
  last_error text
);
create index on public.new_release_artists (checked_at);

-- Ledger of (user, track) already notified: makes every run idempotent, even if two overlap.
create table public.new_release_sent (
  user_id uuid not null references public.profiles (id) on delete cascade,
  track_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

alter table public.new_release_checks enable row level security;
alter table public.new_release_artists enable row level security;
alter table public.new_release_sent enable row level security;
-- Users may see their own check state; everything else is service-role only (no policies).
create policy "own release checks readable" on public.new_release_checks for select to authenticated
  using (user_id = auth.uid());

-- Followed Audius artists, stalest first (never polled → first).
create or replace function public.new_release_due_artists(p_limit int)
returns table (artist_id text, artist_name text)
language sql stable security definer set search_path = public as $$
  select fa.artist_id, max(fa.artist ->> 'name') as artist_name
  from public.followed_artists fa
  left join public.new_release_artists a on a.artist_id = fa.artist_id
  where fa.artist_id not like 'local%'
  group by fa.artist_id, a.checked_at
  order by a.checked_at asc nulls first
  limit greatest(1, least(coalesce(p_limit, 25), 100));
$$;
revoke execute on function public.new_release_due_artists(int) from public, anon, authenticated;
grant execute on function public.new_release_due_artists(int) to service_role;

-- One release for one user. Returns true when a notification was created.
-- Skips (but records) when the user turned "New releases" off, so turning it back on later
-- doesn't replay old tracks.
create or replace function public.notify_new_release(
  p_user uuid, p_artist_id text, p_artist_name text, p_track_id text, p_track_title text, p_artwork text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  prefs jsonb;
begin
  if p_user is null or coalesce(p_track_id, '') = '' then return false; end if;

  insert into public.new_release_sent (user_id, track_id) values (p_user, p_track_id)
  on conflict do nothing;
  if not found then return false; end if;

  select notifications into prefs from public.user_settings where user_id = p_user;
  if prefs ->> 'new_releases' = 'false' then return false; end if;

  perform public.notify_user(
    p_user, 'new_release',
    'New release from ' || coalesce(nullif(p_artist_name, ''), 'an artist you follow'),
    coalesce(nullif(p_track_title, ''), 'A new song') || ' is out now',
    jsonb_build_object(
      'track_id', p_track_id,
      'track_title', p_track_title,
      'artist_id', p_artist_id,
      'artist_name', p_artist_name,
      'artwork', p_artwork,
      'url', '/track-detail?id=' || p_track_id),
    'new_releases');
  return true;
end $$;
revoke execute on function public.notify_new_release(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.notify_new_release(uuid, text, text, text, text, text) to service_role;

-- ═════════════════════════════════════════════ new releases: hourly schedule
-- Calls the edge function with the same Vault secret the push path uses (push_webhook_secret).
-- Without the secret it does nothing (the function would answer 401 anyway).
create or replace function public.run_new_releases_job() returns void
language plpgsql security definer set search_path = public as $$
declare
  secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_webhook_secret' limit 1;
  if coalesce(secret, '') = '' then return; end if;
  perform net.http_post(
    url := 'https://vmdkgkgyzflvqsvecava.supabase.co/functions/v1/new-releases',
    body := jsonb_build_object('source', 'cron'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret),
    timeout_milliseconds := 60000
  );
exception when others then
  null;  -- Vault / pg_net unavailable: skip this run quietly.
end $$;
revoke execute on function public.run_new_releases_job() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'zoyra-new-releases';
  perform cron.schedule('zoyra-new-releases', '17 * * * *', $cmd$select public.run_new_releases_job()$cmd$);
end $$;

-- ═════════════════════════════════════════════ room_join
-- "<name> joined your jam" to the host of a group/party room (category friend_activity).
-- Live rooms are skipped: listeners join them through join_live and the host sees the live
-- listener count instead (and on_live_started_notify already covers live sessions).
-- At most one notification per member per room every 30 minutes (leave/rejoin doesn't spam).
create index if not exists notifications_user_kind_created_idx on public.notifications (user_id, kind, created_at desc);

create or replace function public.on_room_join_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r record;
  joiner text;
  members int;
begin
  select id, host_id, kind, name into r from public.rooms where id = new.room_id;
  if r is null or r.kind = 'live' or r.host_id = new.user_id then return new; end if;

  if exists (select 1 from public.blocks b
             where (b.blocker_id = r.host_id and b.blocked_id = new.user_id)
                or (b.blocker_id = new.user_id and b.blocked_id = r.host_id)) then
    return new;
  end if;

  if exists (select 1 from public.notifications n
             where n.user_id = r.host_id and n.kind = 'room_join'
               and n.created_at > now() - interval '30 minutes'
               and n.payload ->> 'room_id' = new.room_id::text
               and n.payload ->> 'actor_id' = new.user_id::text) then
    return new;
  end if;

  joiner := public.display_name_of(new.user_id);
  select count(*)::int into members from public.room_members where room_id = new.room_id and user_id <> r.host_id;

  perform public.notify_user(
    r.host_id, 'room_join', joiner || ' joined your jam',
    case when members > 1 then '"' || r.name || '" has ' || members || ' listeners' else 'In "' || r.name || '"' end,
    jsonb_build_object(
      'room_id', new.room_id,
      'room_kind', r.kind,
      'room_name', r.name,
      'actor_id', new.user_id,
      'actor_name', joiner,
      'url', case when r.kind = 'party' then '/party?id=' else '/group-listening?id=' end || new.room_id::text),
    'friend_activity');
  return new;
exception when others then
  return new;  -- a notification problem must never block joining a room
end $$;

drop trigger if exists on_room_join_notify on public.room_members;
create trigger on_room_join_notify after insert on public.room_members
  for each row execute function public.on_room_join_notify();
