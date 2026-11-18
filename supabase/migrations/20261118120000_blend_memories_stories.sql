-- Zoyra: On this day (memories), Artist stories, Blend support.
--
--   on_this_day(month, day, tz_min)  my top song for this calendar day in each earlier year (from play_history)
--   artist_stories                   24-hour stories: kicker + text, optionally on top of a song's cover
--   story_views / story_likes        seen state (ring) and likes, visible to the viewer and the author
--
-- Blend needs nothing new: it reads friends' play_history through the existing "friends see activity" policy
-- (follow + their Listening activity setting + not blocked).

-- ═════════════════════════════════════════════ on this day
-- p_tz_min = JavaScript getTimezoneOffset() (minutes behind UTC) so "today" is the caller's local day.
create or replace function public.on_this_day(p_month int, p_day int, p_tz_min int default 0)
returns table (year int, track_id text, track jsonb, plays int)
language sql stable security invoker set search_path = public as $$
  with local as (
    select ph.track_id, ph.track, ph.played_at - make_interval(mins => greatest(least(p_tz_min, 840), -840)) as lt
    from public.play_history ph
    where ph.user_id = auth.uid()
  ),
  d as (
    select extract(year from lt)::int as y, l.track_id, (array_agg(l.track order by l.lt desc))[1] as track, count(*)::int as plays
    from local l
    where extract(month from lt) = p_month and extract(day from lt) = p_day
      and extract(year from lt) < extract(year from now() - make_interval(mins => greatest(least(p_tz_min, 840), -840)))
    group by 1, 2
  ),
  r as (select d.*, row_number() over (partition by y order by plays desc, track_id) as rn from d)
  select y, r.track_id, r.track, r.plays from r where rn = 1 order by y desc limit 10;
$$;
revoke execute on function public.on_this_day(int, int, int) from public, anon;
grant execute on function public.on_this_day(int, int, int) to authenticated;

-- ═════════════════════════════════════════════ stories
create table if not exists public.artist_stories (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kicker text not null default '' check (char_length(kicker) <= 32),
  body text not null check (char_length(btrim(body)) between 1 and 280),
  track jsonb check (track is null or (jsonb_typeof(track) = 'object' and pg_column_size(track) <= 8192)),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);
create index if not exists artist_stories_author_idx on public.artist_stories (author_id, created_at desc);
create index if not exists artist_stories_expires_idx on public.artist_stories (expires_at);

alter table public.artist_stories enable row level security;

drop policy if exists "stories visible" on public.artist_stories;
create policy "stories visible" on public.artist_stories for select to authenticated using (
  expires_at > now()
  and (
    author_id = auth.uid()
    or (
      exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.following_id = artist_stories.author_id)
      and not public.blocked_with(artist_stories.author_id)
    )
  )
);
drop policy if exists "stories insert own" on public.artist_stories;
create policy "stories insert own" on public.artist_stories for insert to authenticated
  with check (author_id = auth.uid() and expires_at <= now() + interval '24 hours 5 minutes');
drop policy if exists "stories delete own" on public.artist_stories;
create policy "stories delete own" on public.artist_stories for delete to authenticated using (author_id = auth.uid());

revoke all on public.artist_stories from anon;
revoke update on public.artist_stories from authenticated;

-- At most 8 live stories per person.
create or replace function public.artist_stories_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.artist_stories s where s.author_id = new.author_id and s.expires_at > now()) >= 8 then
    raise exception 'story_limit' using errcode = 'P0001', hint = 'You can have up to 8 live stories.';
  end if;
  return new;
end $$;
drop trigger if exists artist_stories_limit_trg on public.artist_stories;
create trigger artist_stories_limit_trg before insert on public.artist_stories
  for each row execute function public.artist_stories_limit();

create table if not exists public.story_views (
  story_id uuid not null references public.artist_stories (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, user_id)
);
create table if not exists public.story_likes (
  story_id uuid not null references public.artist_stories (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (story_id, user_id)
);

alter table public.story_views enable row level security;
alter table public.story_likes enable row level security;

-- Policy subqueries on artist_stories run under the caller's own RLS: you can only touch stories you can see.
drop policy if exists "story views read" on public.story_views;
create policy "story views read" on public.story_views for select to authenticated using (
  user_id = auth.uid() or exists (select 1 from public.artist_stories s where s.id = story_id and s.author_id = auth.uid())
);
drop policy if exists "story views insert" on public.story_views;
create policy "story views insert" on public.story_views for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.artist_stories s where s.id = story_id));

drop policy if exists "story likes read" on public.story_likes;
create policy "story likes read" on public.story_likes for select to authenticated using (
  user_id = auth.uid() or exists (select 1 from public.artist_stories s where s.id = story_id and s.author_id = auth.uid())
);
drop policy if exists "story likes insert" on public.story_likes;
create policy "story likes insert" on public.story_likes for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.artist_stories s where s.id = story_id));
drop policy if exists "story likes delete" on public.story_likes;
create policy "story likes delete" on public.story_likes for delete to authenticated using (user_id = auth.uid());

revoke all on public.story_views, public.story_likes from anon;
revoke update on public.story_views, public.story_likes from authenticated;
