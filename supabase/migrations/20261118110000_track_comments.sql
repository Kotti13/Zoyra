-- Track comments (design: TrackComments). Timestamped comments on any catalogue song ("0:42 · The drop here gave me chills").
--   track_comments         one row per comment; at_seconds = the moment of the song it refers to (optional)
--   track_comment_likes    one like per person per comment
--   track_comment_reports  one report per person per comment; a comment you reported disappears for you
-- Reads skip people who blocked each other (public.blocked_with). Writes: own rows only, 500 chars, 10 per minute.

create table if not exists public.track_comments (
  id uuid primary key default gen_random_uuid(),
  track_id text not null check (char_length(track_id) between 1 and 200),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 500),
  at_seconds integer check (at_seconds is null or at_seconds between 0 and 86400),
  created_at timestamptz not null default now()
);
create index if not exists track_comments_track_idx on public.track_comments (track_id, created_at desc);
create index if not exists track_comments_user_idx on public.track_comments (user_id);

create table if not exists public.track_comment_likes (
  comment_id uuid not null references public.track_comments (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create table if not exists public.track_comment_reports (
  comment_id uuid not null references public.track_comments (id) on delete cascade,
  reporter_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  reason text not null default 'other' check (reason in ('spam', 'abuse', 'hate', 'other')),
  created_at timestamptz not null default now(),
  primary key (comment_id, reporter_id)
);

alter table public.track_comments enable row level security;
alter table public.track_comment_likes enable row level security;
alter table public.track_comment_reports enable row level security;

drop policy if exists "track comments readable" on public.track_comments;
create policy "track comments readable" on public.track_comments for select to authenticated
  using (
    (user_id = auth.uid() or not public.blocked_with(user_id))
    and not exists (select 1 from public.track_comment_reports r where r.comment_id = id and r.reporter_id = auth.uid())
  );
drop policy if exists "author posts track comment" on public.track_comments;
create policy "author posts track comment" on public.track_comments for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "author deletes track comment" on public.track_comments;
create policy "author deletes track comment" on public.track_comments for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists "track comment likes readable" on public.track_comment_likes;
create policy "track comment likes readable" on public.track_comment_likes for select to authenticated using (true);
drop policy if exists "like a track comment" on public.track_comment_likes;
create policy "like a track comment" on public.track_comment_likes for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "unlike a track comment" on public.track_comment_likes;
create policy "unlike a track comment" on public.track_comment_likes for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists "report a track comment" on public.track_comment_reports;
create policy "report a track comment" on public.track_comment_reports for insert to authenticated
  with check (reporter_id = auth.uid());
drop policy if exists "see my track comment reports" on public.track_comment_reports;
create policy "see my track comment reports" on public.track_comment_reports for select to authenticated
  using (reporter_id = auth.uid());

-- Server timestamps, trimmed text, no backdating, light rate limit.
create or replace function public.track_comments_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_at := now();
  new.body := btrim(new.body);
  if (select count(*) from public.track_comments
      where user_id = new.user_id and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'You are commenting too fast. Wait a minute and try again.';
  end if;
  return new;
end;
$$;
drop trigger if exists track_comments_guard on public.track_comments;
create trigger track_comments_guard before insert on public.track_comments
  for each row execute function public.track_comments_guard();

-- Comments for a song with author, like count and "liked by me". SECURITY INVOKER: the policies above apply.
-- p_sort: 'top' (most liked), 'new', or 'moment' (by timestamp in the song).
create or replace function public.list_track_comments(p_track text, p_sort text default 'new', p_limit integer default 50, p_offset integer default 0)
returns table (id uuid, user_id uuid, body text, at_seconds integer, created_at timestamptz,
               display_name text, avatar_url text, username text, like_count bigint, liked boolean)
language sql stable security invoker set search_path = public as $$
  select c.id, c.user_id, c.body, c.at_seconds, c.created_at,
         p.display_name, p.avatar_url, p.username,
         (select count(*) from public.track_comment_likes l where l.comment_id = c.id) as like_count,
         exists (select 1 from public.track_comment_likes l where l.comment_id = c.id and l.user_id = auth.uid()) as liked
  from public.track_comments c
  join public.profiles p on p.id = c.user_id
  where c.track_id = p_track
  order by
    case when p_sort = 'moment' then coalesce(c.at_seconds, 2147483647) end asc,
    case when p_sort = 'top' then (select count(*) from public.track_comment_likes l where l.comment_id = c.id) end desc,
    c.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100)) offset greatest(0, coalesce(p_offset, 0));
$$;

create or replace function public.count_track_comments(p_track text) returns bigint
language sql stable security invoker set search_path = public as $$
  select count(*) from public.track_comments where track_id = p_track;
$$;

grant execute on function public.list_track_comments(text, text, integer, integer) to authenticated;
grant execute on function public.count_track_comments(text) to authenticated;

-- Realtime: new comments appear for people on the screen.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'track_comments') then
    alter publication supabase_realtime add table public.track_comments;
  end if;
end $$;
