-- Phase 6: profile customisation (Customize profile + Avatar picker).
-- Adds columns to public.profiles, which already has RLS enabled:
--   "profiles readable"  select for authenticated
--   "own profile update" update where id = auth.uid()
-- avatar_url stays an image URL; preset gradient avatars live in avatar_art.

alter table public.profiles
  add column if not exists avatar_art text
    check (avatar_art is null or avatar_art ~ '^[a-z]{2,20}$'),
  add column if not exists banner_art text not null default 'coral'
    check (banner_art ~ '^[a-z]{2,20}$'),
  add column if not exists avatar_frame text not null default 'glow'
    check (avatar_frame in ('glow', 'sunset', 'mint', 'none', 'rainbow', 'gold')),
  add column if not exists showcase jsonb not null default '{"pinned": true, "badges": true, "taste": true}'::jsonb
    check (jsonb_typeof(showcase) = 'object'),
  add column if not exists pinned_tracks jsonb not null default '[]'::jsonb
    check (jsonb_typeof(pinned_tracks) = 'array' and jsonb_array_length(pinned_tracks) <= 3);

-- Column-level grant: the plan column stays locked (see 20261113160000_lock_profile_plan.sql).
grant update (avatar_art, banner_art, avatar_frame, showcase, pinned_tracks) on public.profiles to authenticated;

-- RLS stays on (re-asserted here so this migration is safe on its own).
alter table public.profiles enable row level security;
