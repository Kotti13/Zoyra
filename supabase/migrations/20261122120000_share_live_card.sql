-- Public preview card for a shared live room (web/share, link kind /lv/<session id>).
-- Anon-callable like share_playlist_card / share_profile_card: it returns public fields only (title, status, listener
-- count, host name and picture), and hides the host's name and picture when their profile is private. A "live"
-- session whose host stopped sending heartbeats is reported as ended.

create or replace function public.share_live_card(lookup uuid)
returns table (title text, status text, listeners int, host_name text, avatar_url text, started_at timestamptz, scheduled_at timestamptz)
language sql stable security definer set search_path = public as $$
  select
    left(s.title, 120),
    case when s.status = 'live' and (s.heartbeat_at is null or s.heartbeat_at < now() - interval '2 minutes') then 'ended' else s.status end,
    greatest(0, coalesce(s.listeners, 0))::int,
    case when p.is_private then null else p.display_name end,
    case when p.is_private or p.avatar_url !~ '^https://' then null else p.avatar_url end,
    s.started_at,
    s.scheduled_at
  from public.live_sessions s
  join public.profiles p on p.id = s.host_id
  where s.id = lookup;
$$;

revoke all on function public.share_live_card(uuid) from public;
grant execute on function public.share_live_card(uuid) to anon, authenticated;
