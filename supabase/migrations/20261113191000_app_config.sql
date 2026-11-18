-- Zoyra phase 4 (agent C): in-app update config + AI lyrics cache.

-- ───────────────────────────────────────────── app config (in-app updates)
-- One row per platform. The app compares its own version with latest_version / min_version:
--   installed < min_version     → update required
--   installed < latest_version  → update available
-- Edit rows from the Supabase dashboard when a release ships (no client can write).
create table public.app_config (
  platform text primary key check (platform in ('ios', 'android', 'web')),
  latest_version text not null check (latest_version ~ '^\d+(\.\d+){0,2}$'),
  min_version text not null check (min_version ~ '^\d+(\.\d+){0,2}$'),
  store_url text,
  notes text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;
create policy "app config is public" on public.app_config for select to anon, authenticated using (true);
-- No insert/update/delete policies: only the service role / dashboard changes it.

insert into public.app_config (platform, latest_version, min_version, store_url, notes) values
  ('ios', '1.0.0', '1.0.0', null, '{}'),
  ('android', '1.0.0', '1.0.0', 'https://play.google.com/store/apps/details?id=com.zoyra.app', '{}')
on conflict (platform) do nothing;

-- ───────────────────────────────────────────── lyrics AI cache
-- Translations / romanizations produced by the `lyrics-ai` edge function, keyed by the track,
-- the mode, the target language ('' for romanize) and a hash of the source lines (so a change in
-- the source lyrics never serves a stale, misaligned result).
create table public.lyrics_cache (
  track_id text not null check (char_length(track_id) between 1 and 100),
  mode text not null check (mode in ('translate', 'romanize')),
  target text not null default '' check (char_length(target) <= 40),
  source_hash text not null check (char_length(source_hash) = 64),
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  created_at timestamptz not null default now(),
  primary key (track_id, mode, target, source_hash)
);

alter table public.lyrics_cache enable row level security;
create policy "lyrics cache readable" on public.lyrics_cache for select to authenticated using (true);
-- No write policies: only the edge function (service role) inserts rows.
