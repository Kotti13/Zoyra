-- Zoyra core schema: profiles, library, social, realtime rooms, messaging, stats.
-- Tracks come from an external catalogue (Audius); we store their id + a JSON snapshot.

create extension if not exists pgcrypto;

-- ───────────────────────────────────────────── profiles & settings
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique check (username ~ '^[a-z0-9_.]{3,30}$'),
  display_name text not null default 'Listener',
  bio text not null default '',
  avatar_url text,
  is_private boolean not null default false,
  plan text not null default 'free' check (plan in ('free', 'premium', 'family', 'student')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  genres text[] not null default '{}',
  languages text[] not null default '{}',
  favorite_artists jsonb not null default '[]',
  audio_quality text not null default 'normal' check (audio_quality in ('low', 'normal', 'high', 'lossless')),
  crossfade_seconds int not null default 0 check (crossfade_seconds between 0 and 12),
  gapless boolean not null default true,
  normalize boolean not null default true,
  equalizer jsonb not null default '{"enabled":false,"preset":"Flat","bands":[0,0,0,0,0,0,0,0,0,0]}',
  theme text not null default 'dark',
  accent text not null default '#FF6B4A',
  notifications jsonb not null default '{}',
  privacy jsonb not null default '{"listening_activity":true,"show_top_artists":true}',
  onboarded boolean not null default false,
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, 'Listener'), '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  insert into public.user_settings (user_id) values (new.id);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────────────────────────── library
create table public.liked_tracks (
  user_id uuid not null references public.profiles (id) on delete cascade,
  track_id text not null,
  track jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

create table public.playlists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  description text not null default '',
  cover_url text,
  visibility text not null default 'public' check (visibility in ('public', 'private', 'collaborative')),
  is_ai boolean not null default false,
  ai_prompt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.playlist_collaborators (
  playlist_id uuid not null references public.playlists (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (playlist_id, user_id)
);

create table public.playlist_tracks (
  id uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references public.playlists (id) on delete cascade,
  track_id text not null,
  track jsonb not null,
  position double precision not null default extract(epoch from now()),
  added_by uuid references public.profiles (id) on delete set null,
  added_at timestamptz not null default now()
);
create index on public.playlist_tracks (playlist_id, position);

create table public.followed_artists (
  user_id uuid not null references public.profiles (id) on delete cascade,
  artist_id text not null,
  artist jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, artist_id)
);

create table public.play_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  track_id text not null,
  track jsonb not null,
  context text,
  seconds_listened int not null default 0,
  played_at timestamptz not null default now()
);
create index on public.play_history (user_id, played_at desc);

create table public.search_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  query text not null,
  created_at timestamptz not null default now()
);
create index on public.search_history (user_id, created_at desc);

-- ───────────────────────────────────────────── social graph
create table public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

create table public.dedications (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  track jsonb not null,
  message text not null default '',
  created_at timestamptz not null default now()
);

-- ───────────────────────────────────────────── messaging
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  body text not null default '',
  track jsonb,
  created_at timestamptz not null default now()
);
create index on public.messages (conversation_id, created_at);

create or replace function public.touch_conversation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  return new;
end $$;
create trigger on_message_insert after insert on public.messages for each row execute function public.touch_conversation();

-- ───────────────────────────────────────────── listening rooms (group listening + party mode)
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null default 'group' check (kind in ('group', 'party')),
  name text not null default 'Listening room',
  code text not null unique default upper(substr(md5(random()::text), 1, 6)),
  track jsonb,
  position_ms int not null default 0,
  is_playing boolean not null default false,
  skip_votes int not null default 0,
  is_open boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table public.room_queue (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  track jsonb not null,
  added_by uuid references public.profiles (id) on delete set null,
  votes int not null default 0,
  created_at timestamptz not null default now()
);

-- ───────────────────────────────────────────── notifications & achievements
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}',
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.achievements (
  user_id uuid not null references public.profiles (id) on delete cascade,
  key text not null,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ───────────────────────────────────────────── helper functions (security definer, avoid RLS recursion)
create or replace function public.is_conversation_member(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversation_members where conversation_id = cid and user_id = auth.uid());
$$;

create or replace function public.can_edit_playlist(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.playlists p where p.id = pid and p.owner_id = auth.uid())
      or exists (select 1 from public.playlist_collaborators c where c.playlist_id = pid and c.user_id = auth.uid());
$$;

create or replace function public.can_view_playlist(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.playlists p where p.id = pid and (p.visibility <> 'private' or p.owner_id = auth.uid()))
      or public.can_edit_playlist(pid);
$$;

create or replace function public.is_room_member(rid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.room_members where room_id = rid and user_id = auth.uid())
      or exists (select 1 from public.rooms where id = rid and host_id = auth.uid());
$$;

-- Start (or reuse) a 1:1 conversation with another user; returns its id.
create or replace function public.start_conversation(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select a.conversation_id into cid
  from public.conversation_members a
  join public.conversation_members b on b.conversation_id = a.conversation_id
  where a.user_id = auth.uid() and b.user_id = other
  limit 1;
  if cid is null then
    insert into public.conversations default values returning id into cid;
    insert into public.conversation_members (conversation_id, user_id) values (cid, auth.uid()), (cid, other);
  end if;
  return cid;
end $$;

-- Join a room by its share code; returns the room id.
create or replace function public.join_room(room_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  select id into rid from public.rooms where code = upper(room_code) and is_open;
  if rid is null then raise exception 'room not found'; end if;
  insert into public.room_members (room_id, user_id) values (rid, auth.uid()) on conflict do nothing;
  return rid;
end $$;

-- Consecutive-day listening streak for a user.
create or replace function public.listening_streak(uid uuid default auth.uid()) returns int
language sql stable security definer set search_path = public as $$
  with days as (
    select distinct (played_at at time zone 'utc')::date d from public.play_history where user_id = uid
  ), numbered as (
    select d, d - (row_number() over (order by d desc))::int * -1 as grp from days
  )
  select coalesce((
    select count(*)::int from numbered
    where grp = (select grp from numbered order by d desc limit 1)
      and (select max(d) from days) >= current_date - 1
  ), 0);
$$;

-- Aggregated listening insights for the signed-in user.
create or replace function public.listening_insights(days int default 7) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'minutes', coalesce(round(sum(seconds_listened) / 60.0), 0),
    'plays', count(*),
    'top_artists', coalesce((
      select jsonb_agg(x) from (
        select track -> 'artist' ->> 'name' as name, count(*) as plays
        from public.play_history where user_id = auth.uid() and played_at > now() - make_interval(days => days)
        group by 1 order by 2 desc limit 5) x), '[]'),
    'top_genres', coalesce((
      select jsonb_agg(x) from (
        select track ->> 'genre' as genre, count(*) as plays
        from public.play_history where user_id = auth.uid() and played_at > now() - make_interval(days => days)
        group by 1 order by 2 desc limit 5) x), '[]'),
    'by_day', coalesce((
      select jsonb_agg(x order by day) from (
        select (played_at at time zone 'utc')::date as day, round(sum(seconds_listened) / 60.0) as minutes
        from public.play_history where user_id = auth.uid() and played_at > now() - make_interval(days => days)
        group by 1) x), '[]')
  )
  from public.play_history where user_id = auth.uid() and played_at > now() - make_interval(days => days);
$$;

-- Weekly leaderboard: XP = minutes listened this week, among people you follow + you.
create or replace function public.weekly_leaderboard() returns table (user_id uuid, display_name text, avatar_url text, xp int)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, p.avatar_url, coalesce((sum(h.seconds_listened) / 60)::int, 0) as xp
  from public.profiles p
  left join public.play_history h on h.user_id = p.id and h.played_at > date_trunc('week', now())
  where p.id = auth.uid() or p.id in (select following_id from public.follows where follower_id = auth.uid())
  group by p.id order by xp desc limit 50;
$$;

-- ───────────────────────────────────────────── row level security
alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.liked_tracks enable row level security;
alter table public.playlists enable row level security;
alter table public.playlist_collaborators enable row level security;
alter table public.playlist_tracks enable row level security;
alter table public.followed_artists enable row level security;
alter table public.play_history enable row level security;
alter table public.search_history enable row level security;
alter table public.follows enable row level security;
alter table public.dedications enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_queue enable row level security;
alter table public.notifications enable row level security;
alter table public.achievements enable row level security;

create policy "profiles readable" on public.profiles for select to authenticated using (true);
create policy "own profile update" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "own settings" on public.user_settings for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own likes" on public.liked_tracks for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "view playlists" on public.playlists for select to authenticated using (public.can_view_playlist(id));
create policy "create playlists" on public.playlists for insert to authenticated with check (owner_id = auth.uid());
create policy "edit playlists" on public.playlists for update to authenticated using (public.can_edit_playlist(id));
create policy "delete own playlists" on public.playlists for delete to authenticated using (owner_id = auth.uid());

create policy "view collaborators" on public.playlist_collaborators for select to authenticated using (public.can_view_playlist(playlist_id));
create policy "owner manages collaborators" on public.playlist_collaborators for all to authenticated
  using (exists (select 1 from public.playlists p where p.id = playlist_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from public.playlists p where p.id = playlist_id and p.owner_id = auth.uid()) or user_id = auth.uid());

create policy "view playlist tracks" on public.playlist_tracks for select to authenticated using (public.can_view_playlist(playlist_id));
create policy "edit playlist tracks" on public.playlist_tracks for all to authenticated
  using (public.can_edit_playlist(playlist_id)) with check (public.can_edit_playlist(playlist_id));

create policy "own followed artists" on public.followed_artists for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own history" on public.play_history for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "friends see activity" on public.play_history for select to authenticated using (
  exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.following_id = play_history.user_id)
  and exists (select 1 from public.user_settings s where s.user_id = play_history.user_id and coalesce((s.privacy ->> 'listening_activity')::boolean, true))
);

create policy "own search history" on public.search_history for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "follows readable" on public.follows for select to authenticated using (true);
create policy "follow as self" on public.follows for insert to authenticated with check (follower_id = auth.uid());
create policy "unfollow as self" on public.follows for delete to authenticated using (follower_id = auth.uid());

create policy "dedications sender or recipient" on public.dedications for select to authenticated using (sender_id = auth.uid() or recipient_id = auth.uid());
create policy "send dedication" on public.dedications for insert to authenticated with check (sender_id = auth.uid());

create policy "member conversations" on public.conversations for select to authenticated using (public.is_conversation_member(id));
create policy "member list" on public.conversation_members for select to authenticated using (public.is_conversation_member(conversation_id));
create policy "mark read" on public.conversation_members for update to authenticated using (user_id = auth.uid());
create policy "read messages" on public.messages for select to authenticated using (public.is_conversation_member(conversation_id));
create policy "send messages" on public.messages for insert to authenticated with check (sender_id = auth.uid() and public.is_conversation_member(conversation_id));

create policy "rooms readable" on public.rooms for select to authenticated using (true);
create policy "create room" on public.rooms for insert to authenticated with check (host_id = auth.uid());
create policy "host or member updates room" on public.rooms for update to authenticated using (public.is_room_member(id));
create policy "host closes room" on public.rooms for delete to authenticated using (host_id = auth.uid());

create policy "room members readable" on public.room_members for select to authenticated using (public.is_room_member(room_id));
create policy "join as self" on public.room_members for insert to authenticated with check (user_id = auth.uid());
create policy "leave or host removes" on public.room_members for delete to authenticated using (
  user_id = auth.uid() or exists (select 1 from public.rooms r where r.id = room_id and r.host_id = auth.uid()));

create policy "room queue readable" on public.room_queue for select to authenticated using (public.is_room_member(room_id));
create policy "room queue add" on public.room_queue for insert to authenticated with check (public.is_room_member(room_id) and added_by = auth.uid());
create policy "room queue vote" on public.room_queue for update to authenticated using (public.is_room_member(room_id));
create policy "room queue remove" on public.room_queue for delete to authenticated using (
  added_by = auth.uid() or exists (select 1 from public.rooms r where r.id = room_id and r.host_id = auth.uid()));

create policy "own notifications" on public.notifications for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own achievements read" on public.achievements for select to authenticated using (user_id = auth.uid());

-- ───────────────────────────────────────────── realtime
alter publication supabase_realtime add table public.messages, public.rooms, public.room_members, public.room_queue,
  public.notifications, public.play_history, public.playlist_tracks;

-- ───────────────────────────────────────────── storage: avatars + playlist covers
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true), ('covers', 'covers', true)
  on conflict (id) do nothing;

create policy "public read images" on storage.objects for select using (bucket_id in ('avatars', 'covers'));
create policy "upload own images" on storage.objects for insert to authenticated
  with check (bucket_id in ('avatars', 'covers') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "update own images" on storage.objects for update to authenticated
  using (bucket_id in ('avatars', 'covers') and (storage.foldername(name))[1] = auth.uid()::text);
