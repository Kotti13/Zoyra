-- Group calls: voice / video rooms for group chats (3+ people), on Agora like the 1:1 calls.
--
--   group_calls                one row per call room in a group chat; status 'live' | 'ended'
--   group_call_participants    who is in (or was in) the room; agora_uid is fixed per person per call;
--                              last_seen is a heartbeat (client pings every 30 s) so people whose app
--                              died drop out after 90 s and a room nobody is in ends by itself
--   group_call_secrets         per-call Agora media-encryption key + salt (service role only)
--
-- Anyone in the group can join a live room at any time ("join late"); there is no per-person ringing state.
-- Members get a 'group_call' notification when a room starts (url '/group-call?id=<id>').
--
-- RPCs (all security definer, member checked):
--   start_group_call(cid, kind)   starts a room (or returns the live one) and joins the caller
--   join_group_call(call_id)      joins (or rejoins) a live room, max 8 people
--   leave_group_call(call_id)     leaves; the last person out ends the room
--   touch_group_call(call_id)     heartbeat
--   end_group_call(call_id)       starter or group owner/admin ends it for everyone
-- Errors carry a hint the client maps in src/lib/group-calls.ts:
--   not_signed_in · not_member · not_group · bad_kind · rate_limited · not_found · call_ended · room_full
-- On finish a 'call' system message is posted in the group:
--   meta {group_call_id, group: true, kind, status 'ended', duration_s, participants}.

create table if not exists public.group_calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  started_by uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('audio', 'video')),
  status text not null default 'live' check (status in ('live', 'ended')),
  channel text not null unique default ('zg_' || replace(gen_random_uuid()::text, '-', '')),
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists group_calls_conv_idx on public.group_calls (conversation_id, created_at desc);
create unique index if not exists group_calls_one_live_idx on public.group_calls (conversation_id) where status = 'live';

create table if not exists public.group_call_participants (
  call_id uuid not null references public.group_calls (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  agora_uid int not null,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  last_seen timestamptz not null default now(),
  primary key (call_id, user_id),
  unique (call_id, agora_uid)
);
create index if not exists group_call_participants_user_idx on public.group_call_participants (user_id, call_id);

create table if not exists public.group_call_secrets (
  call_id uuid primary key references public.group_calls (id) on delete cascade,
  encryption_key text not null,
  encryption_salt text not null,
  created_at timestamptz not null default now()
);
alter table public.group_call_secrets enable row level security;
revoke all on public.group_call_secrets from anon, authenticated;
-- No policies: only the service role (agora-token) touches this table.

alter table public.group_calls enable row level security;
alter table public.group_call_participants enable row level security;
revoke all on public.group_calls from anon, authenticated;
revoke all on public.group_call_participants from anon, authenticated;
grant select on public.group_calls to authenticated;
grant select on public.group_call_participants to authenticated;

drop policy if exists "group call members read" on public.group_calls;
create policy "group call members read" on public.group_calls for select to authenticated
  using (exists (select 1 from public.conversation_members m where m.conversation_id = group_calls.conversation_id and m.user_id = auth.uid()));

drop policy if exists "group call participants read" on public.group_call_participants;
create policy "group call participants read" on public.group_call_participants for select to authenticated
  using (exists (
    select 1 from public.group_calls g
    join public.conversation_members m on m.conversation_id = g.conversation_id and m.user_id = auth.uid()
    where g.id = group_call_participants.call_id));
-- No insert / update / delete policies: rows are written only by the functions below.

do $$
begin
  begin alter publication supabase_realtime add table public.group_calls; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.group_call_participants; exception when duplicate_object then null; end;
end $$;

-- ═════════════════════════════════════════════ helpers
-- Seconds without a heartbeat before someone counts as gone.
create or replace function public.group_call_stale_after() returns interval
language sql immutable as $$ select interval '90 seconds' $$;

-- Marks people with no heartbeat as left, then ends rooms nobody is in. Returns the call row.
create or replace function public.group_call_sweep(gid uuid) returns public.group_calls
language plpgsql security definer set search_path = public as $$
declare
  g public.group_calls;
begin
  update public.group_call_participants set left_at = now()
  where call_id = gid and left_at is null and last_seen < now() - public.group_call_stale_after();
  select * into g from public.group_calls where id = gid;
  if found and g.status = 'live' and not exists (select 1 from public.group_call_participants where call_id = gid and left_at is null) then
    g := public.group_call_finish(gid);
  end if;
  return g;
end $$;
revoke execute on function public.group_call_sweep(uuid) from public, anon, authenticated;

-- Ends a live room (no-op when already ended) and posts the chat log message.
create or replace function public.group_call_finish(gid uuid) returns public.group_calls
language plpgsql security definer set search_path = public as $$
declare
  g public.group_calls;
  people int;
  first_join timestamptz;
begin
  update public.group_calls set status = 'ended', ended_at = now()
  where id = gid and status = 'live' returning * into g;
  if not found then
    select * into g from public.group_calls where id = gid;
    return g;
  end if;
  update public.group_call_participants set left_at = coalesce(left_at, now()) where call_id = gid;
  select count(*), min(joined_at) into people, first_join from public.group_call_participants where call_id = gid;
  update public.notifications set read = true
  where kind = 'group_call' and not read and payload ->> 'call_id' = gid::text;
  -- Best effort: never let the log entry undo the state change.
  begin
    insert into public.messages (conversation_id, sender_id, body, kind, meta, created_at)
    values (g.conversation_id, g.started_by, '', 'call',
      jsonb_build_object('group_call_id', gid, 'call_id', gid, 'group', true, 'kind', g.kind, 'status', 'ended',
        'duration_s', greatest(0, floor(extract(epoch from g.ended_at - coalesce(first_join, g.created_at)))::int),
        'participants', people),
      g.ended_at);
  exception when others then
    raise warning 'group call % : chat log message skipped (%)', gid, sqlerrm;
  end;
  return g;
end $$;
revoke execute on function public.group_call_finish(uuid) from public, anon, authenticated;

-- Adds / re-activates `uid` in the room with a stable Agora uid (1..n, never reused inside a call).
create or replace function public.group_call_add(gid uuid, uid uuid) returns public.group_call_participants
language plpgsql security definer set search_path = public as $$
declare
  p public.group_call_participants;
begin
  perform pg_advisory_xact_lock(hashtextextended('gcall:' || gid::text, 0));
  update public.group_call_participants set left_at = null, last_seen = now()
  where call_id = gid and user_id = uid returning * into p;
  if found then return p; end if;
  insert into public.group_call_participants (call_id, user_id, agora_uid)
  values (gid, uid, (select coalesce(max(agora_uid), 0) + 1 from public.group_call_participants where call_id = gid))
  returning * into p;
  return p;
end $$;
revoke execute on function public.group_call_add(uuid, uuid) from public, anon, authenticated;

-- ═════════════════════════════════════════════ start_group_call
create or replace function public.start_group_call(cid uuid, kind text) returns public.group_calls
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  g public.group_calls;
  m record;
  name text;
  title text;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  if start_group_call.kind is null or start_group_call.kind not in ('audio', 'video') then
    raise exception 'Unknown call type' using errcode = '22023', hint = 'bad_kind';
  end if;
  if cid is null or not public.is_conversation_member(cid) then
    raise exception 'Not a member of this group' using errcode = '42501', hint = 'not_member';
  end if;
  if not public.is_group(cid) then
    raise exception 'Group calls work in group chats only' using errcode = '22023', hint = 'not_group';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('gcall-start:' || cid::text, 0));

  -- A live room already exists (after dropping people whose app died): just join it.
  select * into g from public.group_calls where conversation_id = cid and status = 'live';
  if found then
    g := public.group_call_sweep(g.id);
    if g.status = 'live' then
      perform public.group_call_add(g.id, me);
      return g;
    end if;
  end if;

  if (select count(*) from public.group_calls x
      where x.started_by = me and x.created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'Too many calls. Wait a few minutes and try again.' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  insert into public.group_calls (conversation_id, started_by, kind)
  values (cid, me, start_group_call.kind) returning * into g;
  perform public.group_call_add(g.id, me);

  name := public.display_name_of(me);
  select c.title into title from public.conversations c where c.id = cid;
  for m in
    select cm.user_id, cm.muted from public.conversation_members cm
    where cm.conversation_id = cid and cm.user_id <> me and cm.status = 'active'
  loop
    -- Not for people with a block either way with the starter.
    if exists (select 1 from public.blocks b
               where (b.blocker_id = me and b.blocked_id = m.user_id) or (b.blocker_id = m.user_id and b.blocked_id = me)) then
      continue;
    end if;
    perform public.notify_user(m.user_id, 'group_call', coalesce(nullif(title, ''), 'Group call'),
      name || case when g.kind = 'video' then ' started a group video call' else ' started a group voice call' end,
      jsonb_build_object('call_id', g.id, 'conversation_id', cid, 'kind', g.kind, 'caller_id', me, 'actor_name', name,
        'url', '/group-call?id=' || g.id::text),
      'calls');
  end loop;
  return g;
end $$;
revoke execute on function public.start_group_call(uuid, text) from public, anon;
grant execute on function public.start_group_call(uuid, text) to authenticated;

-- ═════════════════════════════════════════════ join_group_call
create or replace function public.join_group_call(call_id uuid) returns public.group_call_participants
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  g public.group_calls;
  p public.group_call_participants;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  select * into g from public.group_calls x where x.id = join_group_call.call_id;
  if not found or not public.is_conversation_member(g.conversation_id) then
    raise exception 'Call not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  g := public.group_call_sweep(g.id);
  if g.status <> 'live' then
    raise exception 'This call has ended' using errcode = 'P0001', hint = 'call_ended';
  end if;
  if not exists (select 1 from public.group_call_participants x where x.call_id = g.id and x.user_id = me and x.left_at is null)
     and (select count(*) from public.group_call_participants x where x.call_id = g.id and x.left_at is null) >= 8 then
    raise exception 'This call is full' using errcode = 'P0001', hint = 'room_full';
  end if;
  p := public.group_call_add(g.id, me);
  return p;
end $$;
revoke execute on function public.join_group_call(uuid) from public, anon;
grant execute on function public.join_group_call(uuid) to authenticated;

-- ═════════════════════════════════════════════ leave / touch / end
create or replace function public.leave_group_call(call_id uuid) returns public.group_calls
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  g public.group_calls;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  update public.group_call_participants set left_at = now()
  where group_call_participants.call_id = leave_group_call.call_id and user_id = me and left_at is null;
  select * into g from public.group_calls x where x.id = leave_group_call.call_id;
  if not found then raise exception 'Call not found' using errcode = 'P0002', hint = 'not_found'; end if;
  return public.group_call_sweep(g.id);
end $$;
revoke execute on function public.leave_group_call(uuid) from public, anon;
grant execute on function public.leave_group_call(uuid) to authenticated;

create or replace function public.touch_group_call(call_id uuid) returns public.group_calls
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  g public.group_calls;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  update public.group_call_participants set last_seen = now()
  where group_call_participants.call_id = touch_group_call.call_id and user_id = me and left_at is null;
  select * into g from public.group_calls x where x.id = touch_group_call.call_id;
  if not found or not public.is_conversation_member(g.conversation_id) then
    raise exception 'Call not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  return public.group_call_sweep(g.id);
end $$;
revoke execute on function public.touch_group_call(uuid) from public, anon;
grant execute on function public.touch_group_call(uuid) to authenticated;

create or replace function public.end_group_call(call_id uuid) returns public.group_calls
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  g public.group_calls;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  select * into g from public.group_calls x where x.id = end_group_call.call_id;
  if not found or not public.is_conversation_member(g.conversation_id) then
    raise exception 'Call not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if g.started_by <> me and coalesce(public.group_role(g.conversation_id), 'member') not in ('owner', 'admin') then
    raise exception 'Only the person who started the call or a group admin can end it for everyone' using errcode = '42501', hint = 'not_member';
  end if;
  return public.group_call_finish(g.id);
end $$;
revoke execute on function public.end_group_call(uuid) from public, anon;
grant execute on function public.end_group_call(uuid) to authenticated;
