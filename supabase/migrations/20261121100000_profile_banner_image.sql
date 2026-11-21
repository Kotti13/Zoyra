-- Profile banner photo: optional image shown instead of the preset banner_art gradient.
-- Files live in the existing public `avatars` bucket under <user_id>/banner-*.ext
-- (the "own folder" insert/delete policies from 20261113150000_zoyra_core already cover that path).

alter table public.profiles
  add column if not exists banner_url text
    check (banner_url is null or banner_url ~* '^https://');

grant update (banner_url) on public.profiles to authenticated;
