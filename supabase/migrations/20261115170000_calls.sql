-- 1:1 voice / video calls (Agora RTC). Client contract: src/lib/calls.ts — keep RPC names, argument names
-- and shapes in sync. Media goes through Agora; the database only holds call state + signalling.
--
--   calls                one row per call attempt; caller/callee can SELECT their rows (also via realtime),
--                        no direct INSERT/UPDATE/DELETE (only the security definer RPCs below write it)
--   start_call(cid, kind)        caller → 'ringing' (or 'busy'), pushes an incoming-call notification
--   answer_call(call_id, accept) callee → 'accepted' / 'declined' (or 'missed' after 60 s)
--   end_call(call_id)            either side → 'cancelled' / 'declined' / 'ended'
--   expire_ringing_calls()       pg_cron every minute: ringing > 60 s → 'missed' (+ missed-call notification);
--                                accepted calls answered > 6 h ago → 'ended' (crashed clients)
--   messages.kind        + 'call': one system message per finished call, sender = caller,
--                        meta {call_id, kind, status, duration_s}; previews 'Voice call · 2:31', 'Missed video call'
--   agora-token edge function (supabase/functions/agora-token) mints the RTC token for a ringing/accepted call;
--   uid 1 = caller, 2 = callee, channel = calls.channel.
--
-- Status flow:
--   ringing ─ callee accepts ─────────────→ accepted ─ either side hangs up ─→ ended
--   ringing ─ callee declines / hangs up ─→ declined
--   ringing ─ caller hangs up ────────────→ cancelled          (callee gets a 'call_missed' notification)
--   ringing ─ 60 s without an answer ─────→ missed             (callee gets a 'call_missed' notification)
--   callee already ringing / in a call ───→ busy (inserted as such; callee gets a 'call_missed' notification)
--
-- Notifications (public.notify_user, category 'calls'):
--   'call'         to the callee: title = caller display name, body 'Incoming voice call' / 'Incoming video call',
--                  payload {call_id, conversation_id, kind, caller_id, actor_name, url '/call?id=<id>'}.
--                  notify_user only folds kind 'message' rows and the push function only groups kind 'message',
--                  so every call is its own row and its own push (priority high, sound default).
--                  Marked read as soon as the call leaves 'ringing'.
--   'call_missed'  to the callee: title = caller display name, body 'Missed voice call' / 'Missed video call',
--                  same payload with url '/chat-pro?id=<conversation_id>'.
--
-- Errors raised for the client (hint → src/lib/calls.ts friendly message):
--   not_direct · blocked · request (from dm_tool_other) · not_member · bad_kind · rate_limited (10 per 10 min)
--   · not_found

-- ═════════════════════════════════════════════ table
create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  caller_id uuid not null references public.profiles (id) on delete cascade,
  callee_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('audio', 'video')),
  status text not null default 'ringing'
    check (status in ('ringing', 'accepted', 'declined', 'missed', 'ended', 'busy', 'cancelled')),
  channel text not null unique default ('zc_' || replace(gen_random_uuid()::text, '-', '')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  constraint calls_two_people check (caller_id <> callee_id)
);
create index if not exists calls_callee_status_idx on public.calls (callee_id, status);
create index if not exists calls_caller_created_idx on public.calls (caller_id, created_at desc);
create index if not exists calls_conversation_idx on public.calls (conversation_id, created_at desc);
create index if not exists calls_ringing_idx on public.calls (created_at) where status = 'ringing';

alter table public.calls enable row level security;
revoke all on public.calls from anon, authenticated;
grant select on public.calls to authenticated;

drop policy if exists "call participants read" on public.calls;
create policy "call participants read" on public.calls for select to authenticated
  using (caller_id = auth.uid() or callee_id = auth.uid());
-- No insert / update / delete policies: rows are written only by the security definer functions below.

do $$
begin
  begin alter publication supabase_realtime add table public.calls; exception when duplicate_object then null; end;
end $$;

-- ═════════════════════════════════════════════ messages: 'call' kind
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text', 'track', 'voice', 'poll', 'lyric', 'playlist', 'jam', 'live', 'photo', 'location', 'swap', 'call'));

-- Call messages are system messages: only the call functions (running as the function owner) insert them.
create or replace function public.call_message_guard() returns trigger
language plpgsql as $$
begin
  if new.kind = 'call' and current_user in ('anon', 'authenticated') then
    raise exception 'Call messages are added automatically' using errcode = '42501', hint = 'call_message';
  end if;
  return new;
end $$;
revoke execute on function public.call_message_guard() from public, anon, authenticated;
drop trigger if exists call_message_guard on public.messages;
create trigger call_message_guard before insert on public.messages
  for each row execute function public.call_message_guard();

-- Same as 20261115120000's version, plus 'call' ('Voice call · 2:31', 'Missed video call', 'Declined voice call').
create or replace function public.message_preview(p_kind text, p_body text, p_track jsonb, p_meta jsonb) returns text
language sql immutable set search_path = public as $$
  select case
    when p_kind = 'call' then (
      with c as (
        select case when p_meta ->> 'kind' = 'video' then 'video call' else 'voice call' end as label,
               p_meta ->> 'status' as status,
               case when jsonb_typeof(p_meta -> 'duration_s') = 'number'
                    then greatest(0, floor((p_meta ->> 'duration_s')::numeric))::int end as d
      )
      select case
        when c.status = 'ended' then initcap(left(c.label, 1)) || substr(c.label, 2)
          || case when c.d is null then ''
                  when c.d >= 3600 then ' · ' || (c.d / 3600) || ':' || lpad(((c.d % 3600) / 60)::text, 2, '0')
                                        || ':' || lpad((c.d % 60)::text, 2, '0')
                  else ' · ' || (c.d / 60) || ':' || lpad((c.d % 60)::text, 2, '0') end
        when c.status = 'declined' then 'Declined ' || c.label
        else 'Missed ' || c.label end
      from c)
    when p_kind = 'voice' then 'Sent a voice note'
    when p_kind = 'photo' then 'Sent a photo'
    when p_kind = 'poll' then 'Poll: ' || left(coalesce(p_meta ->> 'question', ''), 120)
    when p_kind = 'jam' then 'Invited you to a jam'
    when p_kind = 'live' then 'Invited you to a live session'
    when p_kind = 'location' then 'Shared a location'
    when p_kind = 'playlist' then 'Sent you a playlist: ' || coalesce(p_meta ->> 'title', 'a playlist')
    when p_kind = 'lyric' then 'Sent a lyric card'
    when p_kind = 'swap' then 'Song swap: ' || coalesce(p_track ->> 'title', 'a song')
    when coalesce(p_body, '') <> '' then left(p_body, 140)
    when p_track is not null then 'Sent you a song: ' || coalesce(p_track ->> 'title', 'a track')
    else 'Sent you a message' end;
$$;
revoke execute on function public.message_preview(text, text, jsonb, jsonb) from public, anon;
grant execute on function public.message_preview(text, text, jsonb, jsonb) to authenticated;

-- Same as 20261115150000_dm_fixes.sql's version, plus: 'call' system messages send no message
-- notification (calls notify through 'call' / 'call_missed' instead) and never accept a request.
create or replace function public.on_message_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m record;
  sender text := public.display_name_of(new.sender_id);
  preview text := public.message_preview(new.kind, new.body, new.track, new.meta);
  accepted int;
begin
  if new.kind = 'call' then return new; end if;

  update public.conversation_members set status = 'active'
  where conversation_id = new.conversation_id and user_id = new.sender_id and status <> 'active';
  get diagnostics accepted = row_count;
  if accepted > 0 then
    update public.notifications set read = true
    where user_id = new.sender_id and kind = 'message_request' and not read
      and payload ->> 'conversation_id' = new.conversation_id::text;
  end if;

  for m in
    select cm.user_id, cm.status, cm.muted, cm.requested_at from public.conversation_members cm
    where cm.conversation_id = new.conversation_id and cm.user_id <> new.sender_id
  loop
    if m.status = 'active' then
      if not m.muted then
        perform public.notify_user(m.user_id, 'message', sender, preview,
          jsonb_build_object('conversation_id', new.conversation_id, 'message_id', new.id, 'sender_id', new.sender_id,
            'actor_name', sender, 'url', '/chat-pro?id=' || new.conversation_id::text),
          'messages');
      end if;
    elsif m.requested_at is null then
      update public.conversation_members set requested_at = now()
      where conversation_id = new.conversation_id and user_id = m.user_id;
      if m.status = 'request' then
        perform public.notify_user(m.user_id, 'message_request', sender, 'Wants to send you a message',
          jsonb_build_object('conversation_id', new.conversation_id, 'message_id', new.id, 'sender_id', new.sender_id,
            'actor_name', sender, 'url', '/message-requests'),
          'messages');
      end if;
    end if;
  end loop;
  return new;
end $$;
revoke execute on function public.on_message_notify() from public, anon, authenticated;

-- ═════════════════════════════════════════════ internal helpers
-- Side effects of a call reaching a final status: clear the callee's incoming-call notification,
-- optionally send a missed-call notification, and post the 'call' system message into the chat.
create or replace function public.call_after_finish(c public.calls, notify_missed boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  caller_name text := public.display_name_of(c.caller_id);
  duration int := case when c.answered_at is not null and c.ended_at is not null
                       then greatest(0, floor(extract(epoch from c.ended_at - c.answered_at)))::int end;
begin
  update public.notifications set read = true
  where user_id = c.callee_id and kind = 'call' and not read and payload ->> 'call_id' = c.id::text;

  if notify_missed then
    perform public.notify_user(c.callee_id, 'call_missed', caller_name,
      case when c.kind = 'video' then 'Missed video call' else 'Missed voice call' end,
      jsonb_build_object('call_id', c.id, 'conversation_id', c.conversation_id, 'kind', c.kind,
        'caller_id', c.caller_id, 'actor_name', caller_name, 'url', '/chat-pro?id=' || c.conversation_id::text),
      'calls');
  end if;

  -- The chat log entry is best effort: never let it undo the call state change.
  begin
    insert into public.messages (conversation_id, sender_id, body, kind, meta, created_at)
    values (c.conversation_id, c.caller_id, '', 'call',
      jsonb_build_object('call_id', c.id, 'kind', c.kind, 'status', c.status, 'duration_s', duration),
      coalesce(c.ended_at, now()));
  exception when others then
    raise warning 'call % : chat log message skipped (%)', c.id, sqlerrm;
  end;
end $$;
revoke execute on function public.call_after_finish(public.calls, boolean) from public, anon, authenticated;

-- Moves a ringing/accepted call to a final status (no-op if it already left those) and runs the side effects.
create or replace function public.call_finish(cid uuid, new_status text, notify_missed boolean) returns public.calls
language plpgsql security definer set search_path = public as $$
declare
  c public.calls;
begin
  update public.calls set status = new_status, ended_at = now()
  where id = cid and status in ('ringing', 'accepted')
  returning * into c;
  if not found then
    select * into c from public.calls where id = cid;
    return c;
  end if;
  perform public.call_after_finish(c, notify_missed);
  return c;
end $$;
revoke execute on function public.call_finish(uuid, text, boolean) from public, anon, authenticated;

-- ═════════════════════════════════════════════ start_call
create or replace function public.start_call(cid uuid, kind text) returns public.calls
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  other uuid;
  c public.calls;
  r record;
  caller_name text;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  if start_call.kind is null or start_call.kind not in ('audio', 'video') then
    raise exception 'Unknown call type' using errcode = '22023', hint = 'bad_kind';
  end if;
  if cid is null or not public.is_conversation_member(cid) then
    raise exception 'Not a member of this conversation' using errcode = '42501', hint = 'not_member';
  end if;
  -- 1:1, not blocked, request accepted ('none'); returns the other member.
  other := public.dm_tool_other(cid);
  if other is null then
    raise exception 'This works in 1:1 chats only' using errcode = '22023', hint = 'not_direct';
  end if;

  -- Serialise call setup for both people (fixed order, so two people calling each other can't deadlock).
  perform pg_advisory_xact_lock(hashtextextended('call:' || least(me, other)::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('call:' || greatest(me, other)::text, 0));

  if (select count(*) from public.calls x
      where x.caller_id = me and x.created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'Too many calls. Wait a few minutes and try again.' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  -- Starting a call replaces anything the caller was still marked in (closed app, lost connection):
  -- their own ringing calls (stale → missed, otherwise cancelled) and accepted calls (→ ended).
  for r in
    select x.id, x.status, x.created_at from public.calls x
    where (x.caller_id = me and x.status = 'ringing')
       or ((x.caller_id = me or x.callee_id = me) and x.status = 'accepted')
    for update
  loop
    perform public.call_finish(r.id,
      case when r.status = 'accepted' then 'ended'
           when r.created_at < now() - interval '60 seconds' then 'missed'
           else 'cancelled' end,
      r.status = 'ringing');
  end loop;
  -- Calls ringing the caller that have timed out (the cron job will get to them anyway).
  for r in
    select x.id from public.calls x
    where x.callee_id = me and x.status = 'ringing' and x.created_at < now() - interval '60 seconds'
    for update
  loop
    perform public.call_finish(r.id, 'missed', true);
  end loop;
  -- Timed-out calls ringing the callee shouldn't make them look busy.
  for r in
    select x.id from public.calls x
    where (x.callee_id = other or x.caller_id = other) and x.status = 'ringing'
      and x.created_at < now() - interval '60 seconds'
    for update
  loop
    perform public.call_finish(r.id, 'missed', true);
  end loop;

  caller_name := public.display_name_of(me);

  -- Callee busy: already ringing (either side) or in a call (answered within the last 6 hours).
  if exists (
    select 1 from public.calls x
    where (x.callee_id = other or x.caller_id = other)
      and (x.status = 'ringing'
           or (x.status = 'accepted' and coalesce(x.answered_at, x.created_at) > now() - interval '6 hours'))
  ) then
    insert into public.calls (conversation_id, caller_id, callee_id, kind, status, ended_at)
    values (cid, me, other, start_call.kind, 'busy', now())
    returning * into c;
    perform public.call_after_finish(c, true);
    return c;
  end if;

  insert into public.calls (conversation_id, caller_id, callee_id, kind, status)
  values (cid, me, other, start_call.kind, 'ringing')
  returning * into c;

  perform public.notify_user(other, 'call', caller_name,
    case when c.kind = 'video' then 'Incoming video call' else 'Incoming voice call' end,
    jsonb_build_object('call_id', c.id, 'conversation_id', c.conversation_id, 'kind', c.kind,
      'caller_id', me, 'actor_name', caller_name, 'url', '/call?id=' || c.id::text),
    'calls');
  return c;
end $$;
revoke execute on function public.start_call(uuid, text) from public, anon;
grant execute on function public.start_call(uuid, text) to authenticated;

-- ═════════════════════════════════════════════ answer_call
create or replace function public.answer_call(call_id uuid, accept boolean) returns public.calls
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  c public.calls;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  select * into c from public.calls x where x.id = answer_call.call_id for update;
  if not found or c.callee_id <> me then
    raise exception 'Call not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if c.status <> 'ringing' then return c; end if;  -- already answered / over: the caller reads c.status

  if c.created_at < now() - interval '60 seconds' then
    return public.call_finish(c.id, 'missed', false);
  end if;
  if not coalesce(accept, false) or public.blocked_with(c.caller_id) then
    return public.call_finish(c.id, 'declined', false);
  end if;

  update public.calls set status = 'accepted', answered_at = now()
  where id = c.id
  returning * into c;
  update public.notifications set read = true
  where user_id = me and kind = 'call' and not read and payload ->> 'call_id' = c.id::text;
  return c;
end $$;
revoke execute on function public.answer_call(uuid, boolean) from public, anon;
grant execute on function public.answer_call(uuid, boolean) to authenticated;

-- ═════════════════════════════════════════════ end_call
create or replace function public.end_call(call_id uuid) returns public.calls
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  c public.calls;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  select * into c from public.calls x where x.id = end_call.call_id for update;
  if not found or (c.caller_id <> me and c.callee_id <> me) then
    raise exception 'Call not found' using errcode = 'P0002', hint = 'not_found';
  end if;

  if c.status = 'accepted' then
    return public.call_finish(c.id, 'ended', false);
  elsif c.status = 'ringing' then
    if c.created_at < now() - interval '60 seconds' then
      return public.call_finish(c.id, 'missed', true);
    elsif me = c.caller_id then
      return public.call_finish(c.id, 'cancelled', true);
    else
      return public.call_finish(c.id, 'declined', false);
    end if;
  end if;
  return c;  -- already over
end $$;
revoke execute on function public.end_call(uuid) from public, anon;
grant execute on function public.end_call(uuid) to authenticated;

-- ═════════════════════════════════════════════ cleanup (pg_cron, every minute)
-- Ringing > 60 s → missed (+ 'call_missed' notification). Accepted calls answered > 6 h ago → ended
-- (a client that crashed mid-call never sent end_call). Returns the number of calls closed.
create or replace function public.expire_ringing_calls() returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select x.id from public.calls x
    where x.status = 'ringing' and x.created_at < now() - interval '60 seconds'
    order by x.created_at
    for update skip locked
  loop
    perform public.call_finish(r.id, 'missed', true);
    n := n + 1;
  end loop;
  for r in
    select x.id from public.calls x
    where x.status = 'accepted' and coalesce(x.answered_at, x.created_at) < now() - interval '6 hours'
    for update skip locked
  loop
    perform public.call_finish(r.id, 'ended', false);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.expire_ringing_calls() from public, anon, authenticated;

create extension if not exists pg_cron;
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'zoyra-calls-expire';
  perform cron.schedule('zoyra-calls-expire', '* * * * *', $cmd$select public.expire_ringing_calls()$cmd$);
end $$;
