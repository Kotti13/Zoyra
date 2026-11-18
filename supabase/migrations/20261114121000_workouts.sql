-- Zoyra phase 7: Run mode.
--
-- One row per finished run. Everything is measured on the device: time from the session clock,
-- distance / pace / route from foreground GPS (expo-location), steps / cadence from the pedometer
-- (expo-sensors). There is no heart-rate or calorie data (no wearable integration).
--
-- `route` is a downsampled polyline [[lat, lng], ...] (≤ 500 points) used for the summary snapshot.
-- `tracks` is the list of catalogue tracks that played during the run (CatalogTrack JSON, ≤ 100).

create table public.workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null default 'run' check (kind in ('run', 'walk')),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  duration_seconds int not null check (duration_seconds >= 0 and duration_seconds <= 86400),
  distance_m double precision not null default 0 check (distance_m >= 0 and distance_m <= 500000),
  steps int check (steps is null or steps >= 0),
  avg_cadence int check (avg_cadence is null or (avg_cadence >= 0 and avg_cadence <= 400)),
  target_bpm int check (target_bpm is null or (target_bpm between 40 and 240)),
  tempo_label text check (char_length(tempo_label) <= 40),
  playlist_id uuid references public.playlists (id) on delete set null,
  playlist_title text check (char_length(playlist_title) <= 100),
  route jsonb not null default '[]'::jsonb check (jsonb_typeof(route) = 'array' and jsonb_array_length(route) <= 500),
  tracks jsonb not null default '[]'::jsonb check (jsonb_typeof(tracks) = 'array' and jsonb_array_length(tracks) <= 100),
  created_at timestamptz not null default now(),
  check (ended_at >= started_at)
);

create index workouts_user_idx on public.workouts (user_id, started_at desc);

alter table public.workouts enable row level security;

create policy "own workouts readable" on public.workouts for select to authenticated
  using (user_id = auth.uid());
create policy "insert own workouts" on public.workouts for insert to authenticated
  with check (user_id = auth.uid());
create policy "delete own workouts" on public.workouts for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.workouts from anon;
