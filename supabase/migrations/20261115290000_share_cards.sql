-- Public share cards for the web share service (web/share, rich link previews).
--
-- profiles / playlists are only readable by `authenticated` (RLS), and the share service must never
-- use the service-role key. These two SECURITY DEFINER functions are the ONLY things the `anon` role
-- can read for sharing, and they return a fixed set of public fields:
--   * share_playlist_card: playlists with visibility = 'public' only (private / collaborative → no row);
--                          the owner's name is omitted when the owner's profile is private.
--   * share_profile_card:  public profiles get name, @username, bio, avatar and counts; a private
--                          profile returns just is_private = true (no name, no id, no avatar).
-- Nothing else (emails, plan, settings, followers lists, listening history) is ever exposed.

create or replace function public.share_playlist_card(pid uuid)
returns table (
  id uuid,
  title text,
  description text,
  cover_url text,
  track_count int,
  owner_name text,
  owner_username text,
  artwork text[],
  preview jsonb,
  updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    p.id,
    p.title,
    left(p.description, 300),
    case when p.cover_url ~ '^https://' then p.cover_url end,
    (select count(*)::int from public.playlist_tracks t where t.playlist_id = p.id),
    -- A private owner stays anonymous even on their public playlist.
    case when pr.is_private then null else pr.display_name end,
    case when pr.is_private then null else pr.username end,
    array(
      select a.url from (
        select coalesce(t.track -> 'artwork' ->> 'large', t.track -> 'artwork' ->> 'medium') as url, t.position
        from public.playlist_tracks t
        where t.playlist_id = p.id
        order by t.position
        limit 12
      ) a
      where a.url ~ '^https://'
      limit 4
    ),
    coalesce((
      select jsonb_agg(jsonb_build_object('title', x.title, 'artist', x.artist))
      from (
        select left(t.track ->> 'title', 120) as title, left(t.track -> 'artist' ->> 'name', 120) as artist
        from public.playlist_tracks t
        where t.playlist_id = p.id and t.track_id not like 'local:%'
        order by t.position
        limit 3
      ) x
    ), '[]'::jsonb),
    p.updated_at
  from public.playlists p
  join public.profiles pr on pr.id = p.owner_id
  where p.id = pid and p.visibility = 'public';
$$;

create or replace function public.share_profile_card(lookup text)
returns table (
  is_private boolean,
  id uuid,
  username text,
  display_name text,
  bio text,
  avatar_url text,
  followers int,
  following int,
  public_playlists int
)
language sql stable security definer set search_path = public as $$
  with target as (
    select pr.*
    from public.profiles pr
    -- CASE (not AND) so a non-uuid lookup is never cast to uuid.
    where pr.id = case when lookup ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then lookup::uuid end
       or pr.username = case when lookup ~ '^[A-Za-z0-9_.]{3,30}$' then lower(lookup) end
    limit 1
  )
  select
    t.is_private,
    case when t.is_private then null else t.id end,
    case when t.is_private then null else t.username end,
    case when t.is_private then null else t.display_name end,
    case when t.is_private then null else left(t.bio, 300) end,
    case when t.is_private or t.avatar_url !~ '^https://' then null else t.avatar_url end,
    case when t.is_private then null else (select count(*)::int from public.follows f where f.following_id = t.id) end,
    case when t.is_private then null else (select count(*)::int from public.follows f where f.follower_id = t.id) end,
    case when t.is_private then null else (select count(*)::int from public.playlists p where p.owner_id = t.id and p.visibility = 'public') end
  from target t;
$$;

revoke all on function public.share_playlist_card(uuid) from public;
revoke all on function public.share_profile_card(text) from public;
grant execute on function public.share_playlist_card(uuid) to anon, authenticated;
grant execute on function public.share_profile_card(text) to anon, authenticated;
