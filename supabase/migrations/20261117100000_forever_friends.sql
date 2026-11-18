-- Forever friends (designs: MsgForever*, MsgBlockLocked, MsgChatForever, MsgChat, MsgChatInfo, MsgLongPress, MsgHome).
--
-- Up to 3 Forever friends per person. Eligibility: you follow each other AND have really chatted (a 1:1 chat with
-- >= 10 messages and at least one from each of you), no block either way. One person asks (request_forever), the
-- other accepts (respond_forever) → a forever_pairs row (user_a < user_b). Once Forever:
--   * neither can block the other: a BEFORE INSERT trigger on blocks refuses with hint 'forever_locked'
--     (covers block_user and direct inserts);
--   * "Always gets through" (forever_settings.breakthrough, default on): their messages still notify while the
--     chat is muted (on_message_forever_breakthrough below), and the push function skips quiet hours for their
--     messages / calls (forever_push_info(), service role only);
--   * a gold ringtone for their calls (forever_settings.ringtone 'gold', default; assets/sounds/zoyra_gold_ring.wav);
--   * milestones (forever_settings.milestones, default on): monthly / yearly "Forever since", message-count and daily
--     streak milestones + a streak reminder, from the daily pg_cron job run_forever_daily();
--   * shared vault: forever_vault(other) = both people's starred messages in their 1:1 chat + milestones.
-- Removal: "Pause Forever" = request_forever_removal(other) → ends 30 days later unless either cancels
-- (cancel_forever_removal). Pairs past removal_at count as ended immediately; the daily job deletes them.
-- Privacy: a pair row / request is readable only by the two people in it. Settings and hush rows only by their owner.
--
-- Notification kinds (notify_user, category 'forever'):
--   forever_request   url /forever-ask?id=<request id>      payload: request_id, sender_id, actor_name
--   forever_accepted  url /forever-done?uid=<acceptor id>   payload: sender_id, actor_name
--   forever_removal   url /forever                          payload: sender_id, actor_name, removal_at
--   forever_removal_cancelled / forever_ended   url /forever
--   forever_milestone url /forever-vault?uid=<friend id>    payload: sender_id, actor_name, milestone, value
--   forever_streak    url /chat-pro?id=<cid>                payload: sender_id, actor_name, streak

-- ═════════════════════════════════════════════ tables
create table if not exists public.forever_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  breakthrough boolean not null default true,
  milestones boolean not null default true,
  ringtone text not null default 'gold' check (ringtone in ('gold', 'default')),
  updated_at timestamptz not null default now()
);
alter table public.forever_settings enable row level security;
revoke all on public.forever_settings from anon, authenticated;
grant select on public.forever_settings to authenticated;
drop policy if exists "own forever settings" on public.forever_settings;
create policy "own forever settings" on public.forever_settings for select to authenticated using (user_id = auth.uid());
-- writes: set_forever_settings()

create table if not exists public.forever_requests (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references public.profiles (id) on delete cascade,
  to_user uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (from_user <> to_user)
);
-- One open request per pair (either direction).
create unique index if not exists forever_requests_one_pending
  on public.forever_requests (least(from_user, to_user), greatest(from_user, to_user)) where status = 'pending';
create index if not exists forever_requests_to_idx on public.forever_requests (to_user, status);
create index if not exists forever_requests_from_idx on public.forever_requests (from_user, status, created_at desc);
alter table public.forever_requests enable row level security;
revoke all on public.forever_requests from anon, authenticated;
grant select on public.forever_requests to authenticated;
drop policy if exists "forever request parties" on public.forever_requests;
create policy "forever request parties" on public.forever_requests for select to authenticated
  using (auth.uid() in (from_user, to_user));
-- writes: request_forever / respond_forever / cancel_forever_request

create table if not exists public.forever_pairs (
  user_a uuid not null references public.profiles (id) on delete cascade,
  user_b uuid not null references public.profiles (id) on delete cascade,
  since timestamptz not null default now(),
  removal_requested_by uuid references public.profiles (id) on delete set null,
  removal_at timestamptz,
  primary key (user_a, user_b),
  check (user_a < user_b),
  check ((removal_requested_by is null) = (removal_at is null))
);
create index if not exists forever_pairs_b_idx on public.forever_pairs (user_b);
alter table public.forever_pairs enable row level security;
revoke all on public.forever_pairs from anon, authenticated;
grant select on public.forever_pairs to authenticated;
drop policy if exists "forever pair members" on public.forever_pairs;
create policy "forever pair members" on public.forever_pairs for select to authenticated
  using (auth.uid() in (user_a, user_b));

-- "Mute notifications" from the Block-locked sheet: I muted this Forever friend on purpose, so breakthrough must
-- not override that chat's mute. Private to the owner.
create table if not exists public.forever_hush (
  user_id uuid not null references public.profiles (id) on delete cascade,
  other_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, other_id)
);
alter table public.forever_hush enable row level security;
revoke all on public.forever_hush from anon, authenticated;
grant select on public.forever_hush to authenticated;
drop policy if exists "own forever hush" on public.forever_hush;
create policy "own forever hush" on public.forever_hush for select to authenticated using (user_id = auth.uid());

-- Milestones reached by a pair (dedupe for notifications + "memories" in the shared vault). Internal writes only.
create table if not exists public.forever_milestones (
  user_a uuid not null,
  user_b uuid not null,
  key text not null,
  kind text not null check (kind in ('anniversary', 'messages', 'streak', 'reminder', 'start')),
  value int not null default 0,
  title text not null,
  reached_at timestamptz not null default now(),
  primary key (user_a, user_b, key),
  foreign key (user_a, user_b) references public.forever_pairs (user_a, user_b) on delete cascade
);
alter table public.forever_milestones enable row level security;
revoke all on public.forever_milestones from anon, authenticated;
grant select on public.forever_milestones to authenticated;
drop policy if exists "forever milestone members" on public.forever_milestones;
create policy "forever milestone members" on public.forever_milestones for select to authenticated
  using (auth.uid() in (user_a, user_b));

do $$
begin
  alter publication supabase_realtime add table public.forever_pairs, public.forever_requests;
exception when duplicate_object or undefined_object then null;
end $$;

-- ═════════════════════════════════════════════ internal helpers (not callable by clients)
create or replace function public.forever_max() returns int language sql immutable as $$ select 3 $$;
create or replace function public.forever_min_messages() returns int language sql immutable as $$ select 10 $$;

-- Active pair between a and b (removal not yet due).
create or replace function public.forever_active(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a is not null and b is not null and a <> b and exists (
    select 1 from public.forever_pairs p
    where p.user_a = least(a, b) and p.user_b = greatest(a, b)
      and (p.removal_at is null or p.removal_at > now())
  );
$$;
revoke execute on function public.forever_active(uuid, uuid) from public, anon, authenticated;

create or replace function public.forever_count_of(u uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.forever_pairs p
  where u in (p.user_a, p.user_b) and (p.removal_at is null or p.removal_at > now());
$$;
revoke execute on function public.forever_count_of(uuid) from public, anon, authenticated;

-- The 1:1 (non-group, exactly two members) conversation between a and b, most recently active first.
create or replace function public.forever_dm_of(a uuid, b uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select c.id
  from public.conversations c
  join public.conversation_members x on x.conversation_id = c.id and x.user_id = a
  join public.conversation_members y on y.conversation_id = c.id and y.user_id = b
  where coalesce(c.kind, 'direct') <> 'group'
    and (select count(*) from public.conversation_members z where z.conversation_id = c.id) = 2
  order by c.last_message_at desc
  limit 1;
$$;
revoke execute on function public.forever_dm_of(uuid, uuid) from public, anon, authenticated;

-- Messages in their 1:1 chat (calls excluded): total and per person.
create or replace function public.forever_chat_stats(a uuid, b uuid, out cid uuid, out total int, out a_sent int, out b_sent int)
language plpgsql stable security definer set search_path = public as $$
begin
  cid := public.forever_dm_of(a, b);
  total := 0; a_sent := 0; b_sent := 0;
  if cid is null then return; end if;
  select count(*)::int,
         count(*) filter (where m.sender_id = a)::int,
         count(*) filter (where m.sender_id = b)::int
    into total, a_sent, b_sent
  from public.messages m
  where m.conversation_id = cid and m.kind <> 'call';
end $$;
revoke execute on function public.forever_chat_stats(uuid, uuid) from public, anon, authenticated;

-- Daily streak: consecutive UTC days (ending today or yesterday) on which BOTH people sent at least one message.
create or replace function public.forever_streak(cid uuid) returns int
language sql stable security definer set search_path = public as $$
  with d as (
    select (m.created_at at time zone 'utc')::date as day
    from public.messages m
    where m.conversation_id = cid and m.kind <> 'call'
      and m.created_at > now() - interval '1100 days'
    group by 1
    having count(distinct m.sender_id) >= 2
  ),
  g as (select day, day - (row_number() over (order by day))::int as grp from d),
  last as (select max(day) as day from d)
  select case
    when cid is null or (select day from last) is null then 0
    when (select day from last) < (now() at time zone 'utc')::date - 1 then 0
    else (select count(*)::int from g where grp = (select grp from g where day = (select day from last)))
  end;
$$;
revoke execute on function public.forever_streak(uuid) from public, anon, authenticated;

create or replace function public.forever_follow_mutual(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.follows where follower_id = a and following_id = b)
     and exists (select 1 from public.follows where follower_id = b and following_id = a);
$$;
revoke execute on function public.forever_follow_mutual(uuid, uuid) from public, anon, authenticated;

create or replace function public.forever_blocked_between(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocks
                 where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a));
$$;
revoke execute on function public.forever_blocked_between(uuid, uuid) from public, anon, authenticated;

-- Serialises Forever changes for two people (slot counting).
create or replace function public.forever_lock(a uuid, b uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('forever:' || least(a, b)::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('forever:' || greatest(a, b)::text, 0));
end $$;
revoke execute on function public.forever_lock(uuid, uuid) from public, anon, authenticated;

-- Eligibility of me ↔ other as jsonb (shared by forever_eligibility / request / respond).
--   { eligible, reason, state, request_id, mutual_follow, messages, mine, theirs, min_messages, conversation_id,
--     slots_left, their_slots_full }
-- reason: null | 'self' | 'not_found' | 'blocked' | 'already' | 'pending_out' | 'pending_in' | 'not_mutual'
--         | 'not_enough_chat' | 'your_slots_full' | 'their_slots_full'
-- state:  'none' | 'pending_out' | 'pending_in' | 'forever'
create or replace function public.forever_check(me uuid, other uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  st record;
  mutual boolean;
  mine_n int;
  theirs_n int;
  req record;
  state text := 'none';
  reason text;
begin
  if other is null or other = me then
    return jsonb_build_object('eligible', false, 'reason', 'self', 'state', 'none');
  end if;
  if not exists (select 1 from public.profiles where id = other) then
    return jsonb_build_object('eligible', false, 'reason', 'not_found', 'state', 'none');
  end if;

  select * into st from public.forever_chat_stats(me, other);
  mutual := public.forever_follow_mutual(me, other);
  mine_n := public.forever_count_of(me);
  theirs_n := public.forever_count_of(other);
  select r.id, r.from_user into req from public.forever_requests r
  where r.status = 'pending' and least(r.from_user, r.to_user) = least(me, other) and greatest(r.from_user, r.to_user) = greatest(me, other)
  limit 1;

  if public.forever_active(me, other) then state := 'forever';
  elsif req.id is not null then state := case when req.from_user = me then 'pending_out' else 'pending_in' end;
  end if;

  reason := case
    when public.forever_blocked_between(me, other) then 'blocked'
    when state = 'forever' then 'already'
    when state = 'pending_out' then 'pending_out'
    when state = 'pending_in' then 'pending_in'
    when not mutual then 'not_mutual'
    when st.total < public.forever_min_messages() or st.a_sent < 1 or st.b_sent < 1 then 'not_enough_chat'
    when mine_n >= public.forever_max() then 'your_slots_full'
    when theirs_n >= public.forever_max() then 'their_slots_full'
  end;

  return jsonb_build_object(
    'eligible', reason is null,
    'reason', reason,
    'state', state,
    'request_id', req.id,
    'mutual_follow', mutual,
    'messages', st.total,
    'mine', st.a_sent,
    'theirs', st.b_sent,
    'min_messages', public.forever_min_messages(),
    'conversation_id', st.cid,
    'slots_left', greatest(0, public.forever_max() - mine_n),
    'their_slots_full', theirs_n >= public.forever_max());
end $$;
revoke execute on function public.forever_check(uuid, uuid) from public, anon, authenticated;

create or replace function public.forever_reason_text(reason text, other_name text) returns text
language sql immutable as $$
  select case reason
    when 'self' then 'You can''t make yourself your Forever.'
    when 'not_found' then 'This person is no longer available.'
    when 'blocked' then 'You can''t make this person your Forever.'
    when 'already' then other_name || ' is already your Forever.'
    when 'pending_out' then 'Your Forever request to ' || other_name || ' is still waiting.'
    when 'pending_in' then other_name || ' already asked you. Open their request to accept.'
    when 'not_mutual' then 'You need to follow each other first.'
    when 'not_enough_chat' then 'Chat a little more first. You both need to have sent messages in your chat.'
    when 'your_slots_full' then 'You already have 3 Forever friends.'
    when 'their_slots_full' then other_name || ' already has 3 Forever friends.'
    else 'You can''t do that right now.'
  end;
$$;

-- ═════════════════════════════════════════════ client RPCs
create or replace function public.forever_eligibility(other uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  return public.forever_check(auth.uid(), other);
end $$;
revoke execute on function public.forever_eligibility(uuid) from public, anon;
grant execute on function public.forever_eligibility(uuid) to authenticated;

create or replace function public.is_forever(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and public.forever_active(auth.uid(), other);
$$;
revoke execute on function public.is_forever(uuid) from public, anon;
grant execute on function public.is_forever(uuid) to authenticated;

-- Creates the pair (both locked). Caller has checked eligibility under forever_lock.
create or replace function public.forever_make_pair(a uuid, b uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  lo uuid := least(a, b);
  hi uuid := greatest(a, b);
begin
  delete from public.forever_pairs where user_a = lo and user_b = hi and removal_at is not null and removal_at <= now();
  insert into public.forever_pairs (user_a, user_b) values (lo, hi) on conflict do nothing;
  insert into public.forever_milestones (user_a, user_b, key, kind, value, title)
  values (lo, hi, 'start', 'start', 0, 'Became Forever') on conflict do nothing;
  -- Any other open request between them is settled now.
  update public.forever_requests set status = 'cancelled', responded_at = now()
  where status = 'pending' and least(from_user, to_user) = lo and greatest(from_user, to_user) = hi;
end $$;
revoke execute on function public.forever_make_pair(uuid, uuid) from public, anon, authenticated;

-- Ask `other` to be my Forever. If they already asked me, this accepts their request instead.
-- Returns { id, status: 'pending' | 'accepted' }.
create or replace function public.request_forever(other uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  chk jsonb;
  reason text;
  rid uuid;
  my_name text;
  their_name text;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  if other is null or other = me then raise exception 'You can''t make yourself your Forever.' using errcode = '22023', hint = 'self'; end if;
  perform public.forever_lock(me, other);
  chk := public.forever_check(me, other);
  reason := chk ->> 'reason';
  their_name := public.display_name_of(other);

  if reason = 'pending_in' then
    return public.respond_forever((chk ->> 'request_id')::uuid, true);
  end if;
  if reason is not null then
    raise exception '%', public.forever_reason_text(reason, their_name) using errcode = 'P0001', hint = reason;
  end if;

  -- Outgoing pending requests reserve slots too.
  if public.forever_count_of(me) + (select count(*) from public.forever_requests where from_user = me and status = 'pending') >= public.forever_max() then
    raise exception 'You already have 3 Forever friends or open requests. Cancel one first.' using errcode = 'P0001', hint = 'your_slots_full';
  end if;
  -- Spam guards: 10 requests a day; 7 days after they declined you.
  if (select count(*) from public.forever_requests where from_user = me and created_at > now() - interval '1 day') >= 10 then
    raise exception 'Too many Forever requests today. Try again tomorrow.' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  if exists (select 1 from public.forever_requests where from_user = me and to_user = other and status = 'declined'
             and responded_at > now() - interval '7 days') then
    raise exception '% said not now. You can ask again in a few days.', their_name using errcode = 'P0001', hint = 'cooldown';
  end if;

  insert into public.forever_requests (from_user, to_user) values (me, other) returning id into rid;
  my_name := public.display_name_of(me);
  perform public.notify_user(other, 'forever_request', my_name, 'Wants you as their Forever',
    jsonb_build_object('request_id', rid, 'sender_id', me, 'actor_name', my_name, 'url', '/forever-ask?id=' || rid::text),
    'forever');
  return jsonb_build_object('id', rid, 'status', 'pending');
end $$;
revoke execute on function public.request_forever(uuid) from public, anon;
grant execute on function public.request_forever(uuid) to authenticated;

-- Accept / decline a request sent to me. Accept re-checks eligibility (mutual follow, chat, slots, blocks).
create or replace function public.respond_forever(request_id uuid, accept boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r public.forever_requests;
  chk jsonb;
  reason text;
  my_name text;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  select * into r from public.forever_requests x where x.id = respond_forever.request_id;
  if not found or r.to_user <> me then
    raise exception 'This Forever request is no longer available.' using errcode = 'P0002', hint = 'not_found';
  end if;
  perform public.forever_lock(r.from_user, me);
  select * into r from public.forever_requests x where x.id = respond_forever.request_id for update;
  if r.status <> 'pending' then
    if r.status = 'accepted' then return jsonb_build_object('id', r.id, 'status', 'accepted'); end if;
    raise exception 'This Forever request is no longer available.' using errcode = 'P0002', hint = 'not_found';
  end if;

  if not coalesce(accept, false) then
    update public.forever_requests set status = 'declined', responded_at = now() where id = r.id;
    update public.notifications set read = true
    where user_id = me and kind = 'forever_request' and not read and payload ->> 'request_id' = r.id::text;
    return jsonb_build_object('id', r.id, 'status', 'declined');
  end if;

  chk := public.forever_check(me, r.from_user);
  reason := chk ->> 'reason';
  -- The request itself makes state 'pending_in'; every other reason refuses.
  if reason is not null and reason <> 'pending_in' then
    raise exception '%', public.forever_reason_text(reason, public.display_name_of(r.from_user)) using errcode = 'P0001', hint = reason;
  end if;
  if reason = 'pending_in' then
    -- re-run the remaining checks that 'pending_in' short-circuited
    if public.forever_blocked_between(me, r.from_user) then
      raise exception '%', public.forever_reason_text('blocked', '') using errcode = 'P0001', hint = 'blocked';
    elsif not (chk ->> 'mutual_follow')::boolean then
      raise exception '%', public.forever_reason_text('not_mutual', '') using errcode = 'P0001', hint = 'not_mutual';
    elsif (chk ->> 'messages')::int < public.forever_min_messages() or (chk ->> 'mine')::int < 1 or (chk ->> 'theirs')::int < 1 then
      raise exception '%', public.forever_reason_text('not_enough_chat', '') using errcode = 'P0001', hint = 'not_enough_chat';
    elsif public.forever_count_of(me) >= public.forever_max() then
      raise exception '%', public.forever_reason_text('your_slots_full', '') using errcode = 'P0001', hint = 'your_slots_full';
    elsif public.forever_count_of(r.from_user) >= public.forever_max() then
      raise exception '%', public.forever_reason_text('their_slots_full', public.display_name_of(r.from_user)) using errcode = 'P0001', hint = 'their_slots_full';
    end if;
  end if;

  update public.forever_requests set status = 'accepted', responded_at = now() where id = r.id;
  perform public.forever_make_pair(me, r.from_user);
  update public.notifications set read = true
  where user_id = me and kind = 'forever_request' and not read and payload ->> 'request_id' = r.id::text;
  my_name := public.display_name_of(me);
  perform public.notify_user(r.from_user, 'forever_accepted', my_name, 'You are Forever now',
    jsonb_build_object('request_id', r.id, 'sender_id', me, 'actor_name', my_name, 'url', '/forever-done?uid=' || me::text),
    'forever');
  return jsonb_build_object('id', r.id, 'status', 'accepted');
end $$;
revoke execute on function public.respond_forever(uuid, boolean) from public, anon;
grant execute on function public.respond_forever(uuid, boolean) to authenticated;

create or replace function public.cancel_forever_request(request_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r public.forever_requests;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  update public.forever_requests x set status = 'cancelled', responded_at = now()
  where x.id = cancel_forever_request.request_id and x.from_user = me and x.status = 'pending'
  returning * into r;
  if found then
    update public.notifications set read = true
    where user_id = r.to_user and kind = 'forever_request' and not read and payload ->> 'request_id' = r.id::text;
  end if;
end $$;
revoke execute on function public.cancel_forever_request(uuid) from public, anon;
grant execute on function public.cancel_forever_request(uuid) to authenticated;

-- One request with both people (for the Sent / Ask screens). Only the two parties can read it.
create or replace function public.forever_request_info(request_id uuid)
returns table (id uuid, status text, created_at timestamptz, from_user uuid, to_user uuid, incoming boolean,
               other_id uuid, other_name text, other_username text, other_avatar text)
language sql stable security definer set search_path = public as $$
  select r.id, r.status, r.created_at, r.from_user, r.to_user, r.to_user = auth.uid(),
         p.id, p.display_name, p.username, p.avatar_url
  from public.forever_requests r
  join public.profiles p on p.id = case when r.from_user = auth.uid() then r.to_user else r.from_user end
  where r.id = forever_request_info.request_id and auth.uid() in (r.from_user, r.to_user);
$$;
revoke execute on function public.forever_request_info(uuid) from public, anon;
grant execute on function public.forever_request_info(uuid) to authenticated;

-- My open requests (incoming + outgoing), newest first.
create or replace function public.forever_pending()
returns table (id uuid, incoming boolean, created_at timestamptz, other_id uuid, other_name text, other_username text, other_avatar text)
language sql stable security definer set search_path = public as $$
  select r.id, r.to_user = auth.uid(), r.created_at, p.id, p.display_name, p.username, p.avatar_url
  from public.forever_requests r
  join public.profiles p on p.id = case when r.from_user = auth.uid() then r.to_user else r.from_user end
  where r.status = 'pending' and auth.uid() in (r.from_user, r.to_user)
  order by r.created_at desc;
$$;
revoke execute on function public.forever_pending() from public, anon;
grant execute on function public.forever_pending() to authenticated;

-- My Forever friends with stats (pinned order: oldest first).
create or replace function public.list_forever()
returns table (user_id uuid, display_name text, username text, avatar_url text, since timestamptz, days int,
               messages int, streak int, conversation_id uuid, removal_requested_by uuid, removal_at timestamptz,
               vault_count int)
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  p record;
  st record;
begin
  if me is null then return; end if;
  for p in
    select fp.*, case when fp.user_a = me then fp.user_b else fp.user_a end as other
    from public.forever_pairs fp
    where me in (fp.user_a, fp.user_b) and (fp.removal_at is null or fp.removal_at > now())
    order by fp.since
  loop
    select * into st from public.forever_chat_stats(me, p.other);
    select pr.id, pr.display_name, pr.username, pr.avatar_url into user_id, display_name, username, avatar_url
    from public.profiles pr where pr.id = p.other;
    since := p.since;
    days := ((now() at time zone 'utc')::date - (p.since at time zone 'utc')::date) + 1;
    messages := st.total;
    streak := public.forever_streak(st.cid);
    conversation_id := st.cid;
    removal_requested_by := p.removal_requested_by;
    removal_at := p.removal_at;
    vault_count := public.forever_vault_count(me, p.other, st.cid);
    return next;
  end loop;
end $$;

-- People I could make my Forever ("Add a Forever" picker): my mutual follows that aren't Forever yet, most
-- chatted first, with the same eligibility verdict as forever_eligibility.
create or replace function public.forever_candidates()
returns table (user_id uuid, display_name text, username text, avatar_url text, messages int, eligible boolean,
               reason text, state text, request_id uuid)
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  f record;
  chk jsonb;
begin
  if me is null then return; end if;
  for f in
    select p.id, p.display_name, p.username, p.avatar_url
    from public.follows a
    join public.follows b on b.follower_id = a.following_id and b.following_id = me
    join public.profiles p on p.id = a.following_id
    where a.follower_id = me and not public.forever_active(me, p.id)
    limit 200
  loop
    chk := public.forever_check(me, f.id);
    user_id := f.id; display_name := f.display_name; username := f.username; avatar_url := f.avatar_url;
    messages := coalesce((chk ->> 'messages')::int, 0);
    eligible := coalesce((chk ->> 'eligible')::boolean, false);
    reason := chk ->> 'reason';
    state := chk ->> 'state';
    request_id := (chk ->> 'request_id')::uuid;
    if reason is distinct from 'blocked' then return next; end if;
  end loop;
end $$;
revoke execute on function public.forever_candidates() from public, anon;
grant execute on function public.forever_candidates() to authenticated;

-- ═════════════════════════════════════════════ shared vault
-- Starred messages come from public.message_stars (owned by the starred-messages migration, 20261117110000).
-- Until that table exists (or if its shape differs) the vault holds milestones only.
-- TODO(lead): once 20261117110000 lands, confirm message_stars has (message_id uuid, user_id uuid, created_at);
--             if the column names differ, adjust the two dynamic queries below (forever_vault_count / forever_vault).
create or replace function public.forever_vault_count(me uuid, other uuid, cid uuid) returns int
language plpgsql stable security definer set search_path = public as $$
declare
  n int := 0;
  stars int := 0;
begin
  select count(*)::int into n from public.forever_milestones
  where user_a = least(me, other) and user_b = greatest(me, other) and kind <> 'reminder';
  if cid is not null and to_regclass('public.message_stars') is not null then
    begin
      execute 'select count(distinct s.message_id)::int from public.message_stars s join public.messages m on m.id = s.message_id
               where m.conversation_id = $1 and s.user_id = any($2)'
        into stars using cid, array[me, other];
    exception when undefined_column or undefined_table or datatype_mismatch then stars := 0;
    end;
  end if;
  return n + coalesce(stars, 0);
end $$;
revoke execute on function public.forever_vault_count(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.list_forever() from public, anon;
grant execute on function public.list_forever() to authenticated;

-- { since, conversation_id, starred_ready, starred: [{ message_id, starred_by: [uuid], starred_at }], milestones: [...] }
-- Starred rows carry ids only: the client loads + decrypts the messages itself (they may be end-to-end encrypted).
create or replace function public.forever_vault(other uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cid uuid;
  pair public.forever_pairs;
  starred jsonb := '[]'::jsonb;
  ready boolean := false;
  ms jsonb;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  select * into pair from public.forever_pairs where user_a = least(me, other) and user_b = greatest(me, other)
    and (removal_at is null or removal_at > now());
  if not found then raise exception 'You are not Forever with this person.' using errcode = '42501', hint = 'not_forever'; end if;
  cid := public.forever_dm_of(me, other);

  if cid is not null and to_regclass('public.message_stars') is not null then
    begin
      execute 'select coalesce(jsonb_agg(jsonb_build_object(''message_id'', x.message_id, ''starred_by'', x.who, ''starred_at'', x.at)
                                  order by x.at desc), ''[]''::jsonb)
               from (select s.message_id, jsonb_agg(distinct s.user_id) as who, max(s.created_at) as at
                     from public.message_stars s join public.messages m on m.id = s.message_id
                     where m.conversation_id = $1 and s.user_id = any($2)
                     group by s.message_id
                     order by max(s.created_at) desc limit 500) x'
        into starred using cid, array[me, other];
      ready := true;
    exception when undefined_column or undefined_table or datatype_mismatch then
      starred := '[]'::jsonb;
    end;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('key', m.key, 'kind', m.kind, 'value', m.value, 'title', m.title, 'reached_at', m.reached_at)
                            order by m.reached_at desc), '[]'::jsonb)
    into ms
  from public.forever_milestones m
  where m.user_a = pair.user_a and m.user_b = pair.user_b and m.kind <> 'reminder';

  return jsonb_build_object('since', pair.since, 'conversation_id', cid, 'starred_ready', ready,
                            'starred', starred, 'milestones', ms);
end $$;
revoke execute on function public.forever_vault(uuid) from public, anon;
grant execute on function public.forever_vault(uuid) to authenticated;

-- ═════════════════════════════════════════════ removal (Pause Forever)
create or replace function public.request_forever_removal(other uuid) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  pair public.forever_pairs;
  my_name text;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  select * into pair from public.forever_pairs where user_a = least(me, other) and user_b = greatest(me, other)
    and (removal_at is null or removal_at > now()) for update;
  if not found then raise exception 'You are not Forever with this person.' using errcode = 'P0002', hint = 'not_forever'; end if;
  if pair.removal_at is not null then return pair.removal_at; end if;
  update public.forever_pairs set removal_requested_by = me, removal_at = now() + interval '30 days'
  where user_a = pair.user_a and user_b = pair.user_b
  returning * into pair;
  my_name := public.display_name_of(me);
  perform public.notify_user(other, 'forever_removal', my_name, 'Started a 30 day Forever removal. Either of you can cancel it.',
    jsonb_build_object('sender_id', me, 'actor_name', my_name, 'removal_at', pair.removal_at, 'url', '/forever'), 'forever');
  return pair.removal_at;
end $$;
revoke execute on function public.request_forever_removal(uuid) from public, anon;
grant execute on function public.request_forever_removal(uuid) to authenticated;

create or replace function public.cancel_forever_removal(other uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_name text;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  update public.forever_pairs set removal_requested_by = null, removal_at = null
  where user_a = least(me, other) and user_b = greatest(me, other) and removal_at is not null and removal_at > now();
  if not found then return; end if;
  my_name := public.display_name_of(me);
  perform public.notify_user(other, 'forever_removal_cancelled', my_name, 'Cancelled the Forever removal. You are still Forever.',
    jsonb_build_object('sender_id', me, 'actor_name', my_name, 'url', '/forever'), 'forever');
end $$;
revoke execute on function public.cancel_forever_removal(uuid) from public, anon;
grant execute on function public.cancel_forever_removal(uuid) to authenticated;

-- ═════════════════════════════════════════════ settings
create or replace function public.my_forever_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'breakthrough', coalesce(s.breakthrough, true),
    'milestones', coalesce(s.milestones, true),
    'ringtone', coalesce(s.ringtone, 'gold'))
  from (select 1) one
  left join public.forever_settings s on s.user_id = auth.uid();
$$;
revoke execute on function public.my_forever_settings() from public, anon;
grant execute on function public.my_forever_settings() to authenticated;

create or replace function public.set_forever_settings(p_breakthrough boolean default null, p_milestones boolean default null, p_ringtone text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  if p_ringtone is not null and p_ringtone not in ('gold', 'default') then
    raise exception 'Unknown ringtone' using errcode = '22023', hint = 'invalid';
  end if;
  insert into public.forever_settings (user_id, breakthrough, milestones, ringtone)
  values (auth.uid(), coalesce(p_breakthrough, true), coalesce(p_milestones, true), coalesce(p_ringtone, 'gold'))
  on conflict (user_id) do update set
    breakthrough = coalesce(p_breakthrough, forever_settings.breakthrough),
    milestones = coalesce(p_milestones, forever_settings.milestones),
    ringtone = coalesce(p_ringtone, forever_settings.ringtone),
    updated_at = now();
  return public.my_forever_settings();
end $$;
revoke execute on function public.set_forever_settings(boolean, boolean, text) from public, anon;
grant execute on function public.set_forever_settings(boolean, boolean, text) to authenticated;

-- Hush = "Mute notifications" from the Block-locked sheet: mutes our 1:1 chat for me and keeps breakthrough from
-- overriding that mute. on = false lifts both.
create or replace function public.set_forever_hush(other uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cid uuid;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  if other is null or other = me then raise exception 'Invalid person' using errcode = '22023', hint = 'invalid'; end if;
  cid := public.forever_dm_of(me, other);
  if coalesce(p_on, false) then
    insert into public.forever_hush (user_id, other_id) values (me, other) on conflict do nothing;
    if cid is not null then
      update public.conversation_members set muted = true where conversation_id = cid and user_id = me;
      update public.notifications set read = true
      where user_id = me and kind = 'message' and not read and payload ->> 'conversation_id' = cid::text;
    end if;
  else
    delete from public.forever_hush where user_id = me and other_id = other;
    if cid is not null then
      update public.conversation_members set muted = false, muted_until = null where conversation_id = cid and user_id = me;
    end if;
  end if;
end $$;
revoke execute on function public.set_forever_hush(uuid, boolean) from public, anon;
grant execute on function public.set_forever_hush(uuid, boolean) to authenticated;

-- ═════════════════════════════════════════════ block guard
create or replace function public.forever_block_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.forever_active(new.blocker_id, new.blocked_id) then
    raise exception '% is your Forever. Forever friends can''t be blocked.', public.display_name_of(new.blocked_id)
      using errcode = 'P0001', hint = 'forever_locked';
  end if;
  return new;
end $$;
revoke execute on function public.forever_block_guard() from public, anon, authenticated;
drop trigger if exists forever_block_guard on public.blocks;
create trigger forever_block_guard before insert on public.blocks
  for each row execute function public.forever_block_guard();

-- ═════════════════════════════════════════════ breakthrough
-- Should `sender`'s alerts break through `recipient`'s mute / quiet hours? (Forever + recipient's setting + not hushed)
create or replace function public.forever_breaks_through(recipient uuid, sender uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.forever_active(recipient, sender)
     and coalesce((select s.breakthrough from public.forever_settings s where s.user_id = recipient), true)
     and not exists (select 1 from public.forever_hush h where h.user_id = recipient and h.other_id = sender);
$$;
revoke execute on function public.forever_breaks_through(uuid, uuid) from public, anon, authenticated;

-- For the push function (service role): { forever, breakthrough, ringtone }.
create or replace function public.forever_push_info(recipient uuid, sender uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'forever', public.forever_active(recipient, sender),
    'breakthrough', public.forever_breaks_through(recipient, sender),
    'ringtone', case when public.forever_active(recipient, sender)
                     then coalesce((select s.ringtone from public.forever_settings s where s.user_id = recipient), 'gold') end);
$$;
revoke execute on function public.forever_push_info(uuid, uuid) from public, anon, authenticated;
grant execute on function public.forever_push_info(uuid, uuid) to service_role;

-- on_message_notify (owned by the chat migrations) skips members who muted the chat. This extra trigger sends the
-- same alert to a muted member when the sender is their Forever and breakthrough applies. 1:1 chats only.
-- Payload matches on_message_notify's 1:1 'message' alert + breakthrough = true.
create or replace function public.on_message_forever_breakthrough() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m record;
  sender text;
  preview text;
begin
  if new.kind = 'call' then return new; end if;
  if exists (select 1 from public.conversations c where c.id = new.conversation_id and c.kind = 'group') then return new; end if;
  for m in
    select cm.user_id from public.conversation_members cm
    where cm.conversation_id = new.conversation_id and cm.user_id <> new.sender_id and cm.status = 'active'
      and (cm.muted or (cm.muted_until is not null and cm.muted_until > now()))
  loop
    if public.forever_breaks_through(m.user_id, new.sender_id) and not public.restricts(m.user_id, new.sender_id) then
      sender := coalesce(sender, public.display_name_of(new.sender_id));
      preview := coalesce(preview, public.message_preview(new.kind, new.body, new.track, new.meta));
      perform public.notify_user(m.user_id, 'message', sender, preview,
        jsonb_build_object('conversation_id', new.conversation_id, 'message_id', new.id, 'sender_id', new.sender_id,
          'actor_name', sender, 'breakthrough', true, 'url', '/chat-pro?id=' || new.conversation_id::text),
        'messages');
    end if;
  end loop;
  return new;
end $$;
revoke execute on function public.on_message_forever_breakthrough() from public, anon, authenticated;
drop trigger if exists on_message_forever_breakthrough on public.messages;
create trigger on_message_forever_breakthrough after insert on public.messages
  for each row execute function public.on_message_forever_breakthrough();

-- ═════════════════════════════════════════════ daily job: removals due, milestones, streak reminders
create or replace function public.forever_milestone_notify(a uuid, b uuid, p_key text, p_kind text, p_value int, p_title text,
                                                           p_body_for_a text, p_body_for_b text, p_url text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  ins int;
  u uuid;
  other uuid;
begin
  insert into public.forever_milestones (user_a, user_b, key, kind, value, title)
  values (least(a, b), greatest(a, b), p_key, p_kind, p_value, p_title)
  on conflict do nothing;
  get diagnostics ins = row_count;
  if ins = 0 then return false; end if;
  foreach u in array array[a, b] loop
    other := case when u = a then b else a end;
    if coalesce((select s.milestones from public.forever_settings s where s.user_id = u), true) then
      perform public.notify_user(u, case when p_kind = 'reminder' then 'forever_streak' else 'forever_milestone' end,
        p_title, case when u = a then p_body_for_a else p_body_for_b end,
        jsonb_build_object('sender_id', other, 'actor_name', public.display_name_of(other), 'milestone', p_kind,
          'value', p_value, 'url', replace(p_url, '{other}', other::text)),
        'forever');
    end if;
  end loop;
  return true;
end $$;
revoke execute on function public.forever_milestone_notify(uuid, uuid, text, text, int, text, text, text, text) from public, anon, authenticated;

create or replace function public.run_forever_daily() returns int
language plpgsql security definer set search_path = public as $$
declare
  p record;
  st record;
  today date := (now() at time zone 'utc')::date;
  since_d date;
  months int;
  streak int;
  t int;
  na text;
  nb text;
  n int := 0;
  both_today boolean;
begin
  -- 1. Removals that came due.
  for p in delete from public.forever_pairs where removal_at is not null and removal_at <= now() returning * loop
    perform public.notify_user(p.user_a, 'forever_ended', public.display_name_of(p.user_b), 'Your Forever has ended.',
      jsonb_build_object('sender_id', p.user_b, 'actor_name', public.display_name_of(p.user_b), 'url', '/forever'), 'forever');
    perform public.notify_user(p.user_b, 'forever_ended', public.display_name_of(p.user_a), 'Your Forever has ended.',
      jsonb_build_object('sender_id', p.user_a, 'actor_name', public.display_name_of(p.user_a), 'url', '/forever'), 'forever');
    n := n + 1;
  end loop;

  -- 2. Milestones for every active pair.
  for p in select * from public.forever_pairs where removal_at is null or removal_at > now() loop
    na := public.display_name_of(p.user_a);
    nb := public.display_name_of(p.user_b);
    since_d := (p.since at time zone 'utc')::date;

    -- Anniversary ("Forever since"): every month, yearly ones named as years.
    months := (extract(year from age(today, since_d)) * 12 + extract(month from age(today, since_d)))::int;
    if months >= 1 and since_d + make_interval(months => months) = today then
      perform public.forever_milestone_notify(p.user_a, p.user_b,
        'anniv:' || months, 'anniversary', months,
        case when months % 12 = 0 then (months / 12) || ' year' || case when months = 12 then '' else 's' end || ' Forever'
             else months || ' month' || case when months = 1 then '' else 's' end || ' Forever' end,
        'You and ' || nb || ' have been Forever since ' || to_char(since_d, 'FMDD Mon YYYY') || '.',
        'You and ' || na || ' have been Forever since ' || to_char(since_d, 'FMDD Mon YYYY') || '.',
        '/forever-vault?uid={other}');
      n := n + 1;
    end if;

    select * into st from public.forever_chat_stats(p.user_a, p.user_b);
    -- Message-count milestones: the highest one crossed and not yet celebrated.
    select max(x) into t from unnest(array[100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000]) x
    where x <= st.total
      and not exists (select 1 from public.forever_milestones m
                      where m.user_a = p.user_a and m.user_b = p.user_b and m.key = 'msgs:' || x);
    if t is not null then
      -- Lower thresholds count as reached too (no backlog of old milestones).
      insert into public.forever_milestones (user_a, user_b, key, kind, value, title)
      select p.user_a, p.user_b, 'msgs:' || x, 'messages', x, to_char(x, 'FM999,999') || ' messages'
      from unnest(array[100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000]) x where x < t
      on conflict do nothing;
      perform public.forever_milestone_notify(p.user_a, p.user_b, 'msgs:' || t, 'messages', t,
        to_char(t, 'FM999,999') || ' messages',
        'You and ' || nb || ' just passed ' || to_char(t, 'FM999,999') || ' messages.',
        'You and ' || na || ' just passed ' || to_char(t, 'FM999,999') || ' messages.',
        '/forever-vault?uid={other}');
      n := n + 1;
    end if;

    -- Streak milestones + reminder.
    streak := public.forever_streak(st.cid);
    if streak in (7, 30, 50, 100, 200, 365, 500, 1000) then
      perform public.forever_milestone_notify(p.user_a, p.user_b, 'streak:' || streak || ':' || today, 'streak', streak,
        streak || ' day streak',
        streak || ' days in a row with ' || nb || '.',
        streak || ' days in a row with ' || na || '.',
        '/forever-vault?uid={other}');
      n := n + 1;
    end if;
    both_today := st.cid is not null and (
      select count(distinct m.sender_id) >= 2 from public.messages m
      where m.conversation_id = st.cid and m.kind <> 'call' and m.created_at >= today::timestamp at time zone 'utc');
    if streak >= 3 and not both_today then
      perform public.forever_milestone_notify(p.user_a, p.user_b, 'remind:' || today, 'reminder', streak,
        'Keep your streak going',
        'Your ' || streak || ' day streak with ' || nb || ' ends tonight. Say hi.',
        'Your ' || streak || ' day streak with ' || na || ' ends tonight. Say hi.',
        '/chat-pro?id=' || st.cid::text);
      n := n + 1;
    end if;
  end loop;
  -- Old reminders are only dedupe markers.
  delete from public.forever_milestones where kind = 'reminder' and reached_at < now() - interval '3 days';
  return n;
end $$;
revoke execute on function public.run_forever_daily() from public, anon, authenticated;

create extension if not exists pg_cron;
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'zoyra-forever-daily';
  -- 16:00 UTC: evening in Europe / India, morning-afternoon in the Americas (streak reminder still useful).
  perform cron.schedule('zoyra-forever-daily', '0 16 * * *', $cmd$select public.run_forever_daily()$cmd$);
end $$;
