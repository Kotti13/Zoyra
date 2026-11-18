-- Zoyra phase 6: devices and sessions.
--
-- Supabase Auth keeps one row per signed-in device in auth.sessions, but clients can't read that
-- schema. Two security-definer functions expose ONLY the caller's own sessions:
--   * list_my_sessions()        → every live session of auth.uid(), joined with the device label the
--                                  app reported for it, plus `is_current` for the calling session.
--   * revoke_my_session(id)     → deletes one of the caller's OTHER sessions. Deleting the auth.sessions
--                                  row also deletes its refresh tokens, so that device is signed out the
--                                  next time it refreshes (access tokens live at most ~1 hour).
--
-- public.user_sessions holds the friendly device label + heartbeat the app writes for its own session
-- (session id taken from the JWT, so a client can only label the session it is using).

create table public.user_sessions (
  session_id uuid primary key references auth.sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  device_name text check (char_length(device_name) <= 100),
  platform text check (platform in ('ios', 'android', 'web', 'other')),
  os_version text check (char_length(os_version) <= 40),
  app_version text check (char_length(app_version) <= 40),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index user_sessions_user_idx on public.user_sessions (user_id);

alter table public.user_sessions enable row level security;

create policy "own sessions readable" on public.user_sessions for select to authenticated
  using (user_id = auth.uid());
create policy "label own current session" on public.user_sessions for insert to authenticated
  with check (user_id = auth.uid() and session_id = (auth.jwt() ->> 'session_id')::uuid);
create policy "update own current session" on public.user_sessions for update to authenticated
  using (user_id = auth.uid() and session_id = (auth.jwt() ->> 'session_id')::uuid)
  with check (user_id = auth.uid() and session_id = (auth.jwt() ->> 'session_id')::uuid);
create policy "own sessions deletable" on public.user_sessions for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.user_sessions from anon;

create or replace function public.list_my_sessions()
returns table (
  id uuid,
  created_at timestamptz,
  last_active_at timestamptz,
  user_agent text,
  aal text,
  is_current boolean,
  device_name text,
  platform text,
  os_version text,
  app_version text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id,
    s.created_at,
    greatest(s.refreshed_at at time zone 'utc', s.updated_at, u.last_seen_at) as last_active_at,
    s.user_agent,
    s.aal::text,
    s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid as is_current,
    u.device_name,
    u.platform,
    u.os_version,
    u.app_version
  from auth.sessions s
  left join public.user_sessions u on u.session_id = s.id
  where s.user_id = auth.uid()
    and (s.not_after is null or s.not_after > now())
  order by (s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid) desc, last_active_at desc nulls last;
$$;

create or replace function public.revoke_my_session(p_session_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if p_session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid then
    raise exception 'use sign out to end this device''s session';
  end if;
  delete from auth.sessions where id = p_session_id and user_id = auth.uid();
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function public.list_my_sessions() from public, anon;
revoke all on function public.revoke_my_session(uuid) from public, anon;
grant execute on function public.list_my_sessions() to authenticated;
grant execute on function public.revoke_my_session(uuid) to authenticated;
