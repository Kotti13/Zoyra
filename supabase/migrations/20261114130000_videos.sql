-- Zoyra phase 9 (Agent V): the video section (YouTube official embedded player).
--
-- Videos themselves stay on YouTube; these tables only hold Zoyra-side state:
--   saved_videos       "My list" (Save) per user, with a snapshot of the video card for listing
--   followed_channels  YouTube channels a user follows inside Zoyra (feeds the Shorts "Following" tab)
--   video_comments     comments posted on Zoyra about a YouTube video ("On Zoyra" tab). Posting to
--                      YouTube itself would need Google OAuth, which Zoyra does not use.
--   youtube_cache      server-side cache of YouTube Data API responses (edge function only) to stay
--                      inside the 10,000 units/day quota. No client access.

-- ═════════════════════════════════════════════ saved_videos
create table public.saved_videos (
  user_id uuid not null references public.profiles (id) on delete cascade,
  video_id text not null check (video_id ~ '^[A-Za-z0-9_-]{6,20}$'),
  video jsonb not null default '{}'::jsonb check (jsonb_typeof(video) = 'object' and pg_column_size(video) < 4096),
  created_at timestamptz not null default now(),
  primary key (user_id, video_id)
);
create index on public.saved_videos (user_id, created_at desc);

alter table public.saved_videos enable row level security;
create policy "own saved videos readable" on public.saved_videos for select to authenticated
  using (user_id = auth.uid());
create policy "save own videos" on public.saved_videos for insert to authenticated
  with check (user_id = auth.uid());
create policy "unsave own videos" on public.saved_videos for delete to authenticated
  using (user_id = auth.uid());

-- ═════════════════════════════════════════════ followed_channels
create table public.followed_channels (
  user_id uuid not null references public.profiles (id) on delete cascade,
  channel_id text not null check (channel_id ~ '^UC[A-Za-z0-9_-]{20,24}$'),
  channel jsonb not null default '{}'::jsonb check (jsonb_typeof(channel) = 'object' and pg_column_size(channel) < 2048),
  created_at timestamptz not null default now(),
  primary key (user_id, channel_id)
);
create index on public.followed_channels (user_id, created_at desc);

alter table public.followed_channels enable row level security;
create policy "own followed channels readable" on public.followed_channels for select to authenticated
  using (user_id = auth.uid());
create policy "follow channels" on public.followed_channels for insert to authenticated
  with check (user_id = auth.uid());
create policy "unfollow channels" on public.followed_channels for delete to authenticated
  using (user_id = auth.uid());

-- ═════════════════════════════════════════════ video_comments
create table public.video_comments (
  id uuid primary key default gen_random_uuid(),
  video_id text not null check (video_id ~ '^[A-Za-z0-9_-]{6,20}$'),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);
create index on public.video_comments (video_id, created_at desc);
create index on public.video_comments (user_id);

alter table public.video_comments enable row level security;
-- Anyone signed in can read, except comments between people who blocked each other.
create policy "video comments readable" on public.video_comments for select to authenticated
  using (user_id = auth.uid() or not public.blocked_with(user_id));
create policy "author posts video comment" on public.video_comments for insert to authenticated
  with check (user_id = auth.uid());
create policy "author deletes video comment" on public.video_comments for delete to authenticated
  using (user_id = auth.uid());

-- Server timestamps; no backdating, and a light rate limit (10 comments per minute per user).
create or replace function public.video_comments_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_at := now();
  new.body := btrim(new.body);
  if (select count(*) from public.video_comments
      where user_id = new.user_id and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'You are commenting too fast. Wait a minute and try again.';
  end if;
  return new;
end;
$$;
create trigger video_comments_guard before insert on public.video_comments
  for each row execute function public.video_comments_guard();

-- ═════════════════════════════════════════════ youtube_cache (edge function / service role only)
create table public.youtube_cache (
  key text primary key check (char_length(key) <= 600),
  body jsonb not null,
  expires_at timestamptz not null
);
create index on public.youtube_cache (expires_at);

alter table public.youtube_cache enable row level security;
-- No policies: only the service role (which bypasses RLS) reads or writes it.
revoke all on public.youtube_cache from anon, authenticated;
