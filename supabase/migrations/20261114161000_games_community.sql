-- Zoyra phase 12 (Agent E2): games and the community fan feed.
--
--   game_scores        one row per finished game round (Beat Rush today; 'quiz' reserved for Song guess).
--                      Scores are computed on the device, so the server only sanity-checks them.
--   community_posts    fan feed posts: text (max 500 chars), optional attached Audius track snapshot,
--                      optional Audius artist id (the "fan club" the post belongs to).
--   community_likes    one like per user per post; like_count is kept on the post by a trigger.
--   community_comments replies under a post; comment_count is kept on the post by a trigger.
--
-- Blocked users (either direction, via public.blocked_with) never see each other's scores, posts,
-- likes or comments.

-- ═════════════════════════════════════════════ game_scores
create table public.game_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  game text not null check (game in ('beat', 'quiz')),
  score integer not null check (score between 0 and 10000000),
  accuracy real check (accuracy between 0 and 1),
  max_combo integer not null default 0 check (max_combo between 0 and 100000),
  perfect integer not null default 0 check (perfect >= 0),
  good integer not null default 0 check (good >= 0),
  miss integer not null default 0 check (miss >= 0),
  track_id text check (char_length(track_id) <= 64),
  track jsonb check (track is null or (jsonb_typeof(track) = 'object' and pg_column_size(track) < 4096)),
  created_at timestamptz not null default now()
);
create index on public.game_scores (game, score desc);
create index on public.game_scores (user_id, game, score desc);

alter table public.game_scores enable row level security;
-- Leaderboards: everyone signed in can read scores, except between people who blocked each other.
create policy "game scores readable" on public.game_scores for select to authenticated
  using (user_id = auth.uid() or not public.blocked_with(user_id));
create policy "insert own game score" on public.game_scores for insert to authenticated
  with check (user_id = auth.uid());
create policy "delete own game score" on public.game_scores for delete to authenticated
  using (user_id = auth.uid());

create or replace function public.game_scores_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_at := now();
  if (select count(*) from public.game_scores
      where user_id = new.user_id and created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'Too many games saved in a short time. Try again in a few minutes.';
  end if;
  return new;
end;
$$;
create trigger game_scores_guard before insert on public.game_scores
  for each row execute function public.game_scores_guard();

-- ═════════════════════════════════════════════ community_posts
create table public.community_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 500),
  track jsonb check (track is null or (jsonb_typeof(track) = 'object' and pg_column_size(track) < 4096)),
  artist_id text check (char_length(artist_id) <= 64),
  artist_name text check (char_length(artist_name) <= 120),
  like_count integer not null default 0,
  comment_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index on public.community_posts (created_at desc);
create index on public.community_posts (artist_id, created_at desc);
create index on public.community_posts (user_id, created_at desc);

alter table public.community_posts enable row level security;
create policy "community posts readable" on public.community_posts for select to authenticated
  using (user_id = auth.uid() or not public.blocked_with(user_id));
create policy "author posts" on public.community_posts for insert to authenticated
  with check (user_id = auth.uid());
create policy "author deletes post" on public.community_posts for delete to authenticated
  using (user_id = auth.uid());
-- No update policy: posts are immutable for clients; counters change only through the triggers below.

-- Server timestamps, zeroed counters, and a rate limit of 10 posts per 10 minutes per user.
create or replace function public.community_posts_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_at := now();
  new.body := btrim(new.body);
  new.like_count := 0;
  new.comment_count := 0;
  if (select count(*) from public.community_posts
      where user_id = new.user_id and created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'You are posting too fast. Wait a few minutes and try again.';
  end if;
  return new;
end;
$$;
create trigger community_posts_guard before insert on public.community_posts
  for each row execute function public.community_posts_guard();

-- ═════════════════════════════════════════════ community_likes
create table public.community_likes (
  post_id uuid not null references public.community_posts (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index on public.community_likes (user_id);

alter table public.community_likes enable row level security;
create policy "community likes readable" on public.community_likes for select to authenticated
  using (user_id = auth.uid() or not public.blocked_with(user_id));
-- You can like a post you can see, unless you and the author blocked each other.
create policy "like a post" on public.community_likes for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.community_posts p where p.id = post_id and not public.blocked_with(p.user_id))
  );
create policy "unlike a post" on public.community_likes for delete to authenticated
  using (user_id = auth.uid());

create or replace function public.community_likes_count() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.community_posts set like_count = like_count + 1 where id = new.post_id;
  else
    update public.community_posts set like_count = greatest(0, like_count - 1) where id = old.post_id;
  end if;
  return null;
end;
$$;
create trigger community_likes_count after insert or delete on public.community_likes
  for each row execute function public.community_likes_count();

-- ═════════════════════════════════════════════ community_comments
create table public.community_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.community_posts (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);
create index on public.community_comments (post_id, created_at);
create index on public.community_comments (user_id, created_at desc);

alter table public.community_comments enable row level security;
create policy "community comments readable" on public.community_comments for select to authenticated
  using (user_id = auth.uid() or not public.blocked_with(user_id));
create policy "comment on a post" on public.community_comments for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.community_posts p where p.id = post_id and not public.blocked_with(p.user_id))
  );
create policy "author deletes comment" on public.community_comments for delete to authenticated
  using (user_id = auth.uid());

create or replace function public.community_comments_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_at := now();
  new.body := btrim(new.body);
  if (select count(*) from public.community_comments
      where user_id = new.user_id and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'You are commenting too fast. Wait a minute and try again.';
  end if;
  return new;
end;
$$;
create trigger community_comments_guard before insert on public.community_comments
  for each row execute function public.community_comments_guard();

create or replace function public.community_comments_count() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.community_posts set comment_count = comment_count + 1 where id = new.post_id;
  else
    update public.community_posts set comment_count = greatest(0, comment_count - 1) where id = old.post_id;
  end if;
  return null;
end;
$$;
create trigger community_comments_count after insert or delete on public.community_comments
  for each row execute function public.community_comments_count();

-- ═════════════════════════════════════════════ realtime
-- Postgres Changes respects the select policies above, so blocked users' rows are never delivered.
alter publication supabase_realtime add table public.community_posts, public.community_likes, public.community_comments;
