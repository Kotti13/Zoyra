-- DM fixes (follow-up to 20261115120000_dm_requests_privacy.sql). Client contract: src/lib/dm.ts, src/lib/chat.ts.
--
--   1. conversation_members: members may only update last_read_at / muted / read_receipts on their own row
--      (policy now has WITH CHECK; column-level UPDATE grant). No client INSERT/DELETE (no policies, no grants).
--   2. conversation_members: SELECT limited to (conversation_id, user_id, status, muted) so other members'
--      last_read_at / last_delivered_at / read_receipts can't be read via PostgREST or realtime.
--      Own full row: my_memberships(). Others' receipts: conversation_receipts(cid) (privacy-filtered).
--   3. dm_declines: a declined sender can't start a new chat with the decliner for 30 days ('locked').
--      While a request is pending the sender can send at most 3 messages (dm_can_send / dm_message_guard).
--      Disappearing messages and Send later need an accepted chat.
--   4. message_request notifications are marked read on accept (incl. reply = accept) and deleted on
--      decline / block.
--   5. Privacy rules: who='followers' now locks people who don't follow (was: request). An existing empty
--      request (nothing sent yet) is re-checked against the current rules.
--   6. dm.song_shares_anyone is enforced on pending requests (dm_message_guard). dm.group_invites is stored
--      only: there are no group chats yet.
--   7. conversation_receipts / mark_delivered ignore members that haven't accepted.
--   8. on_block_drop_requests only touches 1:1 conversations.
--   9. inbox() + inbox_unread_total() for the Messages screen and the Home badge.
--
-- ─────────────────────────────────────────────────────────── DM access rules (dm_access), updated
-- Evaluated for the caller (me) messaging `other` (them):
--   1. not signed in / self / unknown user                     → 'locked'
--   2. a block exists in either direction                      → 'blocked'
--   3. a 1:1 conversation already exists:
--        their member row is 'active'                          → 'direct'
--        pending and something was already sent              → 'request'
--        pending and nothing sent yet                        → re-checked with rules 4–9 ('locked' / 'direct'
--                                                              win, otherwise 'request')
--   4. they declined a request from me in the last 30 days    → 'locked'
--   5. their dm.who = 'none'  ("Turn off new chats")           → 'locked'
--   6. we follow each other (mutual friends)                   → 'direct'
--   7. their dm.who = 'followers': I follow them → 'direct', otherwise → 'locked'  ("follow first")
--   8. their dm.who = 'mutuals' and no follow either way       → 'locked'  ("only accepts people they know")
--   9. everything else                                         → 'request' (lands in their Requests)
-- i.e. who='everyone' : mutuals direct, everyone else request;
--      who='followers': their followers direct, everyone else locked;
--      who='mutuals'  : mutuals direct, one-way follow either direction request, strangers locked;
--      who='none'     : only existing chats.

-- ═════════════════════════════════════════════ 1 + 2. conversation_members privileges
drop policy if exists "mark read" on public.conversation_members;
create policy "mark read" on public.conversation_members for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No INSERT / DELETE policies exist on conversation_members (rows are only written by security definer
-- functions: start_conversation, open_shared_queue, ...), so table-level privileges can go entirely.
revoke all on public.conversation_members from anon, authenticated;
grant select (conversation_id, user_id, status, muted) on public.conversation_members to authenticated;
grant update (last_read_at, muted, read_receipts) on public.conversation_members to authenticated;

-- The caller's own memberships, full row (replaces client selects of last_read_at etc.).
create or replace function public.my_memberships()
returns table (conversation_id uuid, status text, last_read_at timestamptz, last_delivered_at timestamptz,
               muted boolean, read_receipts boolean, last_message_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.conversation_id, m.status, m.last_read_at, m.last_delivered_at, m.muted, m.read_receipts, c.last_message_at
  from public.conversation_members m
  join public.conversations c on c.id = m.conversation_id
  where m.user_id = auth.uid();
$$;
revoke execute on function public.my_memberships() from public, anon;
grant execute on function public.my_memberships() to authenticated;

-- ═════════════════════════════════════════════ 3. declines
create table if not exists public.dm_declines (
  recipient uuid not null references public.profiles (id) on delete cascade,
  sender uuid not null references public.profiles (id) on delete cascade,
  declined_at timestamptz not null default now(),
  primary key (recipient, sender)
);
create index if not exists dm_declines_sender_idx on public.dm_declines (sender, recipient);
alter table public.dm_declines enable row level security;
revoke all on public.dm_declines from anon, authenticated;
-- no policies: only security definer functions read/write it.

-- ═════════════════════════════════════════════ 5. access (shared by dm_access, start_conversation, guard)
-- Access for `me` starting a NEW chat with `other` (rules 1, 2, 4–9; ignores existing conversations).
-- Internal: takes an arbitrary `me`, so never exposed to clients.
create or replace function public.dm_new_chat_access_for(me uuid, other uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  who text;
  i_follow boolean;
  follows_me boolean;
begin
  if me is null or other is null or other = me then return 'locked'; end if;
  if not exists (select 1 from public.profiles where id = other) then return 'locked'; end if;
  if exists (select 1 from public.blocks b
             where (b.blocker_id = me and b.blocked_id = other) or (b.blocker_id = other and b.blocked_id = me)) then
    return 'blocked';
  end if;
  if exists (select 1 from public.dm_declines d
             where d.recipient = other and d.sender = me and d.declined_at > now() - interval '30 days') then
    return 'locked';
  end if;

  who := public.dm_setting(other, 'who');
  if who = 'none' then return 'locked'; end if;
  i_follow := exists (select 1 from public.follows where follower_id = me and following_id = other);
  follows_me := exists (select 1 from public.follows where follower_id = other and following_id = me);
  if i_follow and follows_me then return 'direct'; end if;
  if who = 'followers' then return case when i_follow then 'direct' else 'locked' end; end if;
  if who = 'mutuals' and not i_follow and not follows_me then return 'locked'; end if;
  return 'request';
end $$;
revoke execute on function public.dm_new_chat_access_for(uuid, uuid) from public, anon, authenticated;

create or replace function public.dm_access(other uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cid uuid;
  their_status text;
  their_requested timestamptz;
  fresh text;
begin
  if me is null or other is null or other = me then return 'locked'; end if;
  if not exists (select 1 from public.profiles where id = other) then return 'locked'; end if;
  if public.blocked_with(other) then return 'blocked'; end if;

  cid := public.dm_conversation_with(other);
  if cid is not null then
    select m.status, m.requested_at into their_status, their_requested
    from public.conversation_members m where m.conversation_id = cid and m.user_id = other;
    if their_status = 'active' then return 'direct'; end if;
    if their_requested is not null or exists (select 1 from public.messages x where x.conversation_id = cid) then
      return 'request';
    end if;
    fresh := public.dm_new_chat_access_for(me, other);
    return case when fresh in ('locked', 'direct', 'blocked') then fresh else 'request' end;
  end if;

  return public.dm_new_chat_access_for(me, other);
end $$;
revoke execute on function public.dm_access(uuid) from public, anon;
grant execute on function public.dm_access(uuid) to authenticated;

create or replace function public.start_conversation(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cid uuid;
  access text;
  their_status text;
  their_requested timestamptz;
  recipient_status text := 'active';
begin
  if me is null then raise exception 'not signed in'; end if;
  if other is null or other = me then raise exception 'You can''t message yourself' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles where id = other) then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  if public.blocked_with(other) then
    raise exception 'You can''t message this person' using errcode = '42501', hint = 'blocked';
  end if;

  -- One conversation per pair even under concurrent calls.
  perform pg_advisory_xact_lock(hashtextextended(
    'dm:' || least(me::text, other::text) || ':' || greatest(me::text, other::text), 0));

  cid := public.dm_conversation_with(other);
  if cid is not null then
    select m.status, m.requested_at into their_status, their_requested
    from public.conversation_members m where m.conversation_id = cid and m.user_id = other;
    if their_status = 'active' or their_requested is not null
       or exists (select 1 from public.messages x where x.conversation_id = cid) then
      return cid;
    end if;
    -- Pending request with nothing sent yet: re-check against the current rules.
    access := public.dm_new_chat_access_for(me, other);
    if access in ('locked', 'blocked') then
      -- (The empty conversation can't be deleted here: the exception rolls the delete back. It stays
      -- invisible to them, inbox() hides it from me, and dm_message_guard refuses the first message.)
      raise exception 'This person isn''t accepting messages from you' using errcode = '42501', hint = 'locked';
    elsif access = 'direct' then
      update public.conversation_members set status = 'active'
      where conversation_id = cid and user_id = other and status <> 'active';
    end if;
    return cid;
  end if;

  access := public.dm_access(other);
  if access = 'locked' then
    raise exception 'This person isn''t accepting messages from you' using errcode = '42501', hint = 'locked';
  elsif access = 'blocked' then
    raise exception 'You can''t message this person' using errcode = '42501', hint = 'blocked';
  elsif access = 'request' then
    recipient_status := case
      when public.dm_setting(other, 'filter_spam')::boolean
        and not exists (select 1 from public.follows f
                        where (f.follower_id = me and f.following_id = other)
                           or (f.follower_id = other and f.following_id = me))
        and (
          (select p.created_at from public.profiles p where p.id = me) > now() - interval '7 days'
          or (select count(*) from public.conversations c
              where c.created_by = me and c.created_at > now() - interval '24 hours') > 10
        )
      then 'filtered' else 'request' end;
  end if;

  -- Reaching out clears my own earlier decline of them.
  delete from public.dm_declines where recipient = me and sender = other;

  insert into public.conversations (created_by) values (me) returning id into cid;
  insert into public.conversation_members (conversation_id, user_id, status)
  values (cid, me, 'active'), (cid, other, recipient_status);
  return cid;
end $$;
revoke execute on function public.start_conversation(uuid) from public, anon;
grant execute on function public.start_conversation(uuid) to authenticated;

-- ═════════════════════════════════════════════ 3 + 4. accept / decline
create or replace function public.accept_message_request(cid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not public.is_conversation_member(cid) then
    raise exception 'Request not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  update public.conversation_members set status = 'active'
  where conversation_id = cid and user_id = auth.uid() and status <> 'active';
  update public.notifications set read = true
  where user_id = auth.uid() and kind = 'message_request' and not read
    and payload ->> 'conversation_id' = cid::text;
end $$;
revoke execute on function public.accept_message_request(uuid) from public, anon;
grant execute on function public.accept_message_request(uuid) to authenticated;

-- Deletes the whole conversation; the sender gets no notification but can't re-request for 30 days.
create or replace function public.decline_message_request(cid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from public.conversation_members
                 where conversation_id = cid and user_id = auth.uid() and status in ('request', 'filtered')) then
    raise exception 'Request not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  insert into public.dm_declines (recipient, sender)
  select distinct auth.uid(), m.user_id from public.conversation_members m
  where m.conversation_id = cid and m.user_id <> auth.uid()
  on conflict (recipient, sender) do update set declined_at = now();
  delete from public.notifications
  where user_id = auth.uid() and kind = 'message_request' and payload ->> 'conversation_id' = cid::text;
  delete from public.conversations where id = cid;
end $$;
revoke execute on function public.decline_message_request(uuid) from public, anon;
grant execute on function public.decline_message_request(uuid) to authenticated;

-- folder: 'requests' | 'filtered'. Returns how many were declined.
create or replace function public.decline_all_message_requests(folder text) returns int
language plpgsql security definer set search_path = public as $$
declare
  ids uuid[];
  n int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if folder is null or folder not in ('requests', 'filtered') then
    raise exception 'Unknown folder' using errcode = '22023';
  end if;
  select coalesce(array_agg(m.conversation_id), '{}') into ids
  from public.conversation_members m
  where m.user_id = auth.uid()
    and m.status = case when folder = 'filtered' then 'filtered' else 'request' end
    and m.requested_at is not null;
  if cardinality(ids) = 0 then return 0; end if;

  insert into public.dm_declines (recipient, sender)
  select distinct auth.uid(), o.user_id from public.conversation_members o
  where o.conversation_id = any (ids) and o.user_id <> auth.uid()
  on conflict (recipient, sender) do update set declined_at = now();
  delete from public.notifications
  where user_id = auth.uid() and kind = 'message_request'
    and payload ->> 'conversation_id' in (select i::text from unnest(ids) i);
  delete from public.conversations c where c.id = any (ids);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.decline_all_message_requests(text) from public, anon;
grant execute on function public.decline_all_message_requests(text) to authenticated;

-- ═════════════════════════════════════════════ 4 + 8. block drops pending 1:1 requests
create or replace function public.on_block_drop_requests() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  with dropped as (
    delete from public.conversations c
    where c.id in (
      select a.conversation_id
      from public.conversation_members a
      join public.conversation_members b on b.conversation_id = a.conversation_id
      where a.user_id = new.blocker_id and b.user_id = new.blocked_id)
      and (select count(*) from public.conversation_members x where x.conversation_id = c.id) = 2
      and exists (select 1 from public.conversation_members m
                  where m.conversation_id = c.id and m.status in ('request', 'filtered'))
    returning c.id
  )
  delete from public.notifications n
  using dropped d
  where n.kind = 'message_request' and n.user_id in (new.blocker_id, new.blocked_id)
    and n.payload ->> 'conversation_id' = d.id::text;
  return new;
end $$;
revoke execute on function public.on_block_drop_requests() from public, anon, authenticated;
drop trigger if exists on_block_drop_requests on public.blocks;
create trigger on_block_drop_requests after insert on public.blocks
  for each row execute function public.on_block_drop_requests();

-- ═════════════════════════════════════════════ 4. message notifications: reply = accept clears the request
-- Same as 20261115120000's version, plus: when the sender's reply accepts a request, their
-- 'message_request' notifications for the conversation are marked read. Payloads unchanged
-- (message_request carries conversation_id, message_id, sender_id, actor_name, url).
create or replace function public.on_message_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m record;
  sender text := public.display_name_of(new.sender_id);
  preview text := public.message_preview(new.kind, new.body, new.track, new.meta);
  accepted int;
begin
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

-- ═════════════════════════════════════════════ 3 + 6. sending into a pending request
-- Caller may send into cid: not an outgoing pending request, or fewer than 3 messages sent so far.
create or replace function public.dm_can_send(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.conversation_request_state(cid) <> 'outgoing'
      or (select count(*) from public.messages m where m.conversation_id = cid and m.sender_id = auth.uid()) < 3;
$$;
revoke execute on function public.dm_can_send(uuid) from public, anon;
grant execute on function public.dm_can_send(uuid) to authenticated;

drop policy if exists "send messages" on public.messages;
create policy "send messages" on public.messages for insert to authenticated with check (
  sender_id = auth.uid()
  and public.is_conversation_member(conversation_id)
  and not public.conversation_blocked(conversation_id)
  and public.dm_can_send(conversation_id)
);

-- Runs for every insert (also from security definer RPCs such as send_song_swap, which bypass RLS) and
-- gives friendly errors. Applies only when the sender is the active side of a 1:1 whose other member
-- hasn't accepted yet (an outgoing request):
--   * song shares (kind track/swap, or a text message carrying a track) need the recipient's
--     dm.song_shares_anyone                                          → hint 'song_shares_off'
--   * the first message re-checks access (rules may have changed)   → hint 'locked' / 'blocked'
--   * at most 3 messages until they accept                          → hint 'request_pending'
create or replace function public.dm_message_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r record;
  sent int;
  access text;
begin
  if (select count(*) from public.conversation_members where conversation_id = new.conversation_id) <> 2 then
    return new;
  end if;
  if not exists (select 1 from public.conversation_members
                 where conversation_id = new.conversation_id and user_id = new.sender_id and status = 'active') then
    return new;  -- not a member (RLS decides) or the recipient replying (= accept)
  end if;
  select m.user_id, m.status into r from public.conversation_members m
  where m.conversation_id = new.conversation_id and m.user_id <> new.sender_id;
  if not found or r.status = 'active' then return new; end if;

  if (new.kind in ('track', 'swap') or (new.kind = 'text' and new.track is not null))
     and not public.dm_setting(r.user_id, 'song_shares_anyone')::boolean then
    raise exception '% only accepts song shares from people they''ve accepted', public.display_name_of(r.user_id)
      using errcode = '42501', hint = 'song_shares_off';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('dmreq:' || new.conversation_id::text, 0));
  select count(*) into sent from public.messages
  where conversation_id = new.conversation_id and sender_id = new.sender_id;

  if sent = 0 then
    access := public.dm_new_chat_access_for(new.sender_id, r.user_id);
    if access = 'blocked' then
      raise exception 'You can''t message this person' using errcode = '42501', hint = 'blocked';
    elsif access = 'locked' then
      raise exception 'This person isn''t accepting messages from you' using errcode = '42501', hint = 'locked';
    end if;
  end if;

  if sent >= 3 then
    raise exception 'You can send up to 3 messages until they accept your request'
      using errcode = '42501', hint = 'request_pending';
  end if;
  return new;
end $$;
revoke execute on function public.dm_message_guard() from public, anon, authenticated;
drop trigger if exists dm_message_guard on public.messages;
create trigger dm_message_guard before insert on public.messages
  for each row execute function public.dm_message_guard();

-- ═════════════════════════════════════════════ 3. accepted-only chat tools
-- Same as 20261115120000's version, plus: only in accepted chats.
create or replace function public.set_disappearing(cid uuid, seconds int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not public.is_conversation_member(cid) then raise exception 'Not a member of this conversation' using errcode = '42501'; end if;
  if public.conversation_request_state(cid) <> 'none' then
    raise exception 'Available once the chat request is accepted' using errcode = '42501', hint = 'request';
  end if;
  if seconds is not null and seconds not in (86400, 604800, 7776000) then
    raise exception 'Unsupported timer' using errcode = '22023';
  end if;
  update public.conversations
    set disappear_seconds = seconds,
        disappear_since = case when seconds is null then null else now() end,
        disappear_by = case when seconds is null then null else auth.uid() end
    where id = cid;
end $$;
revoke execute on function public.set_disappearing(uuid, int) from public, anon;
grant execute on function public.set_disappearing(uuid, int) to authenticated;

drop policy if exists "schedule message" on public.scheduled_messages;
create policy "schedule message" on public.scheduled_messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and sent_at is null and failed is null
    and send_at > now() and send_at < now() + interval '30 days'
    and public.is_conversation_member(conversation_id)
    and not public.conversation_blocked(conversation_id)
    and public.conversation_request_state(conversation_id) = 'none'
  );

-- Friendly error (same as set_disappearing) instead of a bare RLS violation; the policy still enforces it.
create or replace function public.scheduled_message_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and public.is_conversation_member(new.conversation_id)
     and public.conversation_request_state(new.conversation_id) <> 'none' then
    raise exception 'Available once the chat request is accepted' using errcode = '42501', hint = 'request';
  end if;
  return new;
end $$;
revoke execute on function public.scheduled_message_guard() from public, anon, authenticated;
drop trigger if exists scheduled_message_guard on public.scheduled_messages;
create trigger scheduled_message_guard before insert on public.scheduled_messages
  for each row execute function public.scheduled_message_guard();

-- ═════════════════════════════════════════════ 7. delivery + read receipts
create or replace function public.mark_delivered() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  update public.conversation_members cm set last_delivered_at = now()
  from public.conversations c
  where c.id = cm.conversation_id and cm.user_id = auth.uid() and cm.status = 'active'
    and (cm.last_delivered_at is null or cm.last_delivered_at < c.last_message_at);
end $$;
revoke execute on function public.mark_delivered() from public, anon;
grant execute on function public.mark_delivered() to authenticated;

-- As before, plus: last_delivered_at is also null for other members who haven't accepted.
create or replace function public.conversation_receipts(cid uuid)
returns table (user_id uuid, last_read_at timestamptz, last_delivered_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.user_id,
    case
      when m.user_id = auth.uid() then m.last_read_at
      when m.status <> 'active' then null
      when not m.read_receipts then null
      when not public.dm_setting(m.user_id, 'read_receipts')::boolean then null
      when not public.dm_setting(auth.uid(), 'read_receipts')::boolean then null
      when not coalesce((select me.read_receipts from public.conversation_members me
                         where me.conversation_id = cid and me.user_id = auth.uid()), true) then null
      else m.last_read_at end,
    case
      when m.user_id = auth.uid() then m.last_delivered_at
      when m.status <> 'active' then null
      else m.last_delivered_at end
  from public.conversation_members m
  where m.conversation_id = cid and public.is_conversation_member(cid);
$$;
revoke execute on function public.conversation_receipts(uuid) from public, anon;
grant execute on function public.conversation_receipts(uuid) to authenticated;

-- ═════════════════════════════════════════════ 9. inbox
-- My accepted chats, newest first. Left out: chats with no visible message (except my outgoing pending
-- requests that are still allowed), 1:1s across a block. "Visible" = not hidden for me (Delete for me)
-- and not an expired disappearing message. other_* = the other member (lowest user id in groups).
create or replace function public.inbox()
returns table (
  conversation_id uuid, member_count int, other_id uuid, other_name text, other_username text, other_avatar text,
  last_message_id uuid, last_sender_id uuid, last_kind text, last_preview text, last_at timestamptz,
  unread int, request_state text, muted boolean)
language sql stable security definer set search_path = public as $$
  with mine as (
    select m.conversation_id, m.last_read_at, m.muted, c.created_at as conv_created,
           c.disappear_seconds, c.disappear_since
    from public.conversation_members m
    join public.conversations c on c.id = m.conversation_id
    where m.user_id = auth.uid() and m.status = 'active'
  ), x as (
    select mine.*, o.n + 1 as member_count, o.other_id, coalesce(o.pending, false) as pending
    from mine
    cross join lateral (
      select count(*)::int as n,
             (array_agg(om.user_id order by om.user_id))[1] as other_id,
             bool_or(om.status <> 'active') as pending
      from public.conversation_members om
      where om.conversation_id = mine.conversation_id and om.user_id <> auth.uid()
    ) o
  ), l as (
    select x.*, lm.id as msg_id, lm.sender_id, lm.kind, lm.body, lm.track, lm.meta, lm.created_at as msg_at
    from x
    left join lateral (
      select msg.id, msg.sender_id, msg.kind, msg.body, msg.track, msg.meta, msg.created_at
      from public.messages msg
      where msg.conversation_id = x.conversation_id
        and not exists (select 1 from public.message_hidden h where h.user_id = auth.uid() and h.message_id = msg.id)
        and not (x.disappear_seconds is not null and x.disappear_since is not null
                 and msg.created_at >= x.disappear_since
                 and msg.created_at < now() - make_interval(secs => x.disappear_seconds))
      order by msg.created_at desc
      limit 1
    ) lm on true
  )
  select l.conversation_id, l.member_count, l.other_id, p.display_name, p.username, p.avatar_url,
    l.msg_id, l.sender_id, l.kind,
    case when l.msg_id is null then null else public.message_preview(l.kind, l.body, l.track, l.meta) end,
    coalesce(l.msg_at, l.conv_created),
    (select count(*)::int from public.messages u
     where u.conversation_id = l.conversation_id and u.sender_id <> auth.uid() and u.created_at > l.last_read_at
       and not exists (select 1 from public.message_hidden h where h.user_id = auth.uid() and h.message_id = u.id)
       and not (l.disappear_seconds is not null and l.disappear_since is not null
                and u.created_at >= l.disappear_since
                and u.created_at < now() - make_interval(secs => l.disappear_seconds))),
    case when l.pending then 'outgoing' else 'none' end,
    l.muted
  from l
  left join public.profiles p on p.id = l.other_id
  where auth.uid() is not null
    and (l.member_count <> 2 or l.other_id is null or not public.blocked_with(l.other_id))
    and (l.msg_id is not null
         or (l.pending and l.member_count = 2
             and public.dm_new_chat_access_for(auth.uid(), l.other_id) not in ('locked', 'blocked')))
  order by coalesce(l.msg_at, l.conv_created) desc
  limit 200;
$$;
revoke execute on function public.inbox() from public, anon;
grant execute on function public.inbox() to authenticated;

-- Home badge: unread messages across inbox() (muted chats included) + pending requests.
create or replace function public.inbox_unread_total() returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(i.unread) from public.inbox() i), 0)::int + public.message_request_count();
$$;
revoke execute on function public.inbox_unread_total() from public, anon;
grant execute on function public.inbox_unread_total() to authenticated;

-- ═════════════════════════════════════════════ realtime
-- conversation_members is already published (chat_pro); conversations is added so clients get DELETE
-- events (declined / blocked requests). DELETE payloads carry the primary key columns
-- (conversations.id; conversation_members.conversation_id + user_id), all still selectable.
do $$
begin
  begin alter publication supabase_realtime add table public.conversations; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.conversation_members; exception when duplicate_object then null; end;
end $$;
