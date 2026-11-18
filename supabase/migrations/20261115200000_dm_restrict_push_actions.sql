-- Restrict, blocked chats in the inbox, and push notification actions (Mute 1h, quiet hours time zone).
-- Client contract: src/lib/dm.ts, src/lib/presence.ts, src/lib/push.ts, supabase/functions/push/index.ts.
--
--   dm_restrictions                   (restricter, restricted): "Restricted accounts" in Message privacy.
--                                     Rows are visible only to the restricter; the restricted person is
--                                     never told. 1:1 conversations only.
--   restrict_user / unrestrict_user / list_restricted / restricted_count
--   Effects of restricting someone (for the restricter):
--     * their 1:1 chat leaves Messages (inbox) and shows in Message requests (folder 'requests',
--       restricted = true) while it has a message from them I haven't cleared
--     * their messages send no notification (in-app or push)
--     * they don't see my online status (presence_allowed() leaves me out of their list) or my read
--       receipts (conversation_receipts masks my last_read_at for them)
--     * Accept = unrestrict; Decline = clear the chat for me only (their copy stays, nothing is deleted)
--   conversation_members.muted_until  "Mute 1h" from a push notification: no notifications until then.
--   mute_conversation(cid, minutes)   sets / clears it (minutes null or 0 = unmute now).
--   inbox()                           + muted_until, blocked ('by_me' | null), restricted chats left out;
--                                     1:1 chats across a block are listed again. Only a block I made is
--                                     flagged: when they blocked me the row looks normal (null), so a
--                                     blocked person is never told (sending fails as before).
--   inbox_unread_total()              chats I blocked don't count.
--   set_notification_tz(tz)           IANA time zone stored in user_settings.notifications.tz so the push
--                                     function can apply quiet hours in the user's local time.

-- ═════════════════════════════════════════════ mute with expiry
alter table public.conversation_members add column if not exists muted_until timestamptz;
grant select (muted_until) on public.conversation_members to authenticated;
grant update (muted_until) on public.conversation_members to authenticated;

create or replace function public.mute_conversation(cid uuid, minutes int) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  until timestamptz := case when coalesce(minutes, 0) > 0 then now() + make_interval(mins => least(minutes, 60 * 24 * 365)) end;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not public.is_conversation_member(cid) then
    raise exception 'This conversation is no longer available.' using errcode = '42501';
  end if;
  update public.conversation_members set muted_until = until
  where conversation_id = cid and user_id = auth.uid();
  -- Muting from a notification also clears that chat's unread alert row.
  if until is not null then
    update public.notifications set read = true
    where user_id = auth.uid() and kind = 'message' and not read and payload ->> 'conversation_id' = cid::text;
  end if;
  return until;
end $$;
revoke execute on function public.mute_conversation(uuid, int) from public, anon;
grant execute on function public.mute_conversation(uuid, int) to authenticated;

-- ═════════════════════════════════════════════ restrict
create table if not exists public.dm_restrictions (
  restricter uuid not null references public.profiles (id) on delete cascade,
  restricted uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (restricter, restricted),
  check (restricter <> restricted)
);
create index if not exists dm_restrictions_restricted_idx on public.dm_restrictions (restricted, restricter);
alter table public.dm_restrictions enable row level security;
revoke all on public.dm_restrictions from anon, authenticated;
grant select on public.dm_restrictions to authenticated;
drop policy if exists "own restrictions" on public.dm_restrictions;
create policy "own restrictions" on public.dm_restrictions for select to authenticated
  using (restricter = auth.uid());
-- writes only through restrict_user / unrestrict_user (security definer)

-- Internal: does `a` restrict `b`?
create or replace function public.restricts(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.dm_restrictions r where r.restricter = a and r.restricted = b);
$$;
revoke execute on function public.restricts(uuid, uuid) from public, anon, authenticated;

create or replace function public.restrict_user(other uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if other is null or other = auth.uid() then raise exception 'You can''t restrict yourself' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles where id = other) then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  insert into public.dm_restrictions (restricter, restricted) values (auth.uid(), other)
  on conflict do nothing;
  -- Their pending chat alerts go quiet too.
  update public.notifications n set read = true
  where n.user_id = auth.uid() and n.kind = 'message' and not n.read
    and n.payload ->> 'conversation_id' in (
      select a.conversation_id::text from public.conversation_members a
      join public.conversation_members b on b.conversation_id = a.conversation_id and b.user_id = other
      where a.user_id = auth.uid()
        and (select count(*) from public.conversation_members x where x.conversation_id = a.conversation_id) = 2);
end $$;
revoke execute on function public.restrict_user(uuid) from public, anon;
grant execute on function public.restrict_user(uuid) to authenticated;

create or replace function public.unrestrict_user(other uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  delete from public.dm_restrictions where restricter = auth.uid() and restricted = other;
end $$;
revoke execute on function public.unrestrict_user(uuid) from public, anon;
grant execute on function public.unrestrict_user(uuid) to authenticated;

create or replace function public.list_restricted()
returns table (id uuid, display_name text, username text, avatar_url text, restricted_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, p.username, p.avatar_url, r.created_at
  from public.dm_restrictions r
  join public.profiles p on p.id = r.restricted
  where r.restricter = auth.uid()
  order by r.created_at desc;
$$;
revoke execute on function public.list_restricted() from public, anon;
grant execute on function public.list_restricted() to authenticated;

create or replace function public.restricted_count() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.dm_restrictions where restricter = auth.uid();
$$;
revoke execute on function public.restricted_count() from public, anon;
grant execute on function public.restricted_count() to authenticated;

-- Internal: the other member of a 1:1 conversation (null for groups / non-members).
create or replace function public.dm_partner(cid uuid, me uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select case when (select count(*) from public.conversation_members x where x.conversation_id = cid) = 2
    then (select o.user_id from public.conversation_members o where o.conversation_id = cid and o.user_id <> me limit 1)
  end;
$$;
revoke execute on function public.dm_partner(uuid, uuid) from public, anon, authenticated;

-- ═════════════════════════════════════════════ message notifications
-- Same as 20261115170000_calls.sql's version, plus: no notification while the recipient's
-- muted_until is in the future, or when the recipient restricts the sender.
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
    select cm.user_id, cm.status, cm.muted, cm.muted_until, cm.requested_at from public.conversation_members cm
    where cm.conversation_id = new.conversation_id and cm.user_id <> new.sender_id
  loop
    if m.status = 'active' then
      if not m.muted
         and (m.muted_until is null or m.muted_until <= now())
         and not public.restricts(m.user_id, new.sender_id) then
        perform public.notify_user(m.user_id, 'message', sender, preview,
          jsonb_build_object('conversation_id', new.conversation_id, 'message_id', new.id, 'sender_id', new.sender_id,
            'actor_name', sender, 'url', '/chat-pro?id=' || new.conversation_id::text),
          'messages');
      end if;
    elsif m.requested_at is null then
      update public.conversation_members set requested_at = now()
      where conversation_id = new.conversation_id and user_id = m.user_id;
      if m.status = 'request' and not public.restricts(m.user_id, new.sender_id) then
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

-- ═════════════════════════════════════════════ read receipts: hidden from people I restrict
-- As in 20261115150000_dm_fixes.sql, plus: a member who restricts the caller never shows the caller
-- their last_read_at.
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
      when public.restricts(m.user_id, auth.uid()) then null
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

-- ═════════════════════════════════════════════ presence: who may see me online
-- Ids whose online status the caller may see: accepted chat partners + mutual follows, minus anyone
-- who restricts the caller or has a block with them. (Each person's own Online status switch is applied
-- client side: people with it off never announce themselves.)
create or replace function public.presence_allowed() returns setof uuid
language sql stable security definer set search_path = public as $$
  with partners as (
    select o.user_id as id
    from public.conversation_members mine
    join public.conversation_members o on o.conversation_id = mine.conversation_id and o.user_id <> mine.user_id
    where mine.user_id = auth.uid() and mine.status = 'active' and o.status = 'active'
    union
    select f.following_id
    from public.follows f
    join public.follows b on b.follower_id = f.following_id and b.following_id = auth.uid()
    where f.follower_id = auth.uid()
  )
  select p.id from partners p
  where auth.uid() is not null
    and not public.restricts(p.id, auth.uid())
    and not public.blocked_with(p.id);
$$;
revoke execute on function public.presence_allowed() from public, anon;
grant execute on function public.presence_allowed() to authenticated;

-- ═════════════════════════════════════════════ inbox
-- As in 20261115150000_dm_fixes.sql, plus:
--   * muted reflects muted OR muted_until in the future; muted_until returned as well
--   * 1:1 chats across a block are listed; blocked = 'by_me' when I blocked them (clients show a
--     Blocked pill), null otherwise — 'they blocked me' is never revealed
--   * 1:1 chats with someone I restrict are left out (they show in Message requests instead), unless
--     a block also exists
drop function if exists public.inbox();
create function public.inbox()
returns table (
  conversation_id uuid, member_count int, other_id uuid, other_name text, other_username text, other_avatar text,
  last_message_id uuid, last_sender_id uuid, last_kind text, last_preview text, last_at timestamptz,
  unread int, request_state text, muted boolean, muted_until timestamptz, blocked text)
language sql stable security definer set search_path = public as $$
  with mine as (
    select m.conversation_id, m.last_read_at, m.muted, m.muted_until, c.created_at as conv_created,
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
  ), xb as (
    select x.*,
      case when x.member_count <> 2 or x.other_id is null then null
           when exists (select 1 from public.blocks b where b.blocker_id = auth.uid() and b.blocked_id = x.other_id) then 'by_me'
      end as blocked
    from x
  ), l as (
    select xb.*, lm.id as msg_id, lm.sender_id, lm.kind, lm.body, lm.track, lm.meta, lm.created_at as msg_at
    from xb
    left join lateral (
      select msg.id, msg.sender_id, msg.kind, msg.body, msg.track, msg.meta, msg.created_at
      from public.messages msg
      where msg.conversation_id = xb.conversation_id
        and not exists (select 1 from public.message_hidden h where h.user_id = auth.uid() and h.message_id = msg.id)
        and not (xb.disappear_seconds is not null and xb.disappear_since is not null
                 and msg.created_at >= xb.disappear_since
                 and msg.created_at < now() - make_interval(secs => xb.disappear_seconds))
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
    l.muted or coalesce(l.muted_until > now(), false),
    case when l.muted_until > now() then l.muted_until end,
    l.blocked
  from l
  left join public.profiles p on p.id = l.other_id
  where auth.uid() is not null
    and not (l.member_count = 2 and l.other_id is not null
             and public.restricts(auth.uid(), l.other_id) and not public.blocked_with(l.other_id))
    and (l.msg_id is not null
         or (l.pending and l.member_count = 2
             and public.dm_new_chat_access_for(auth.uid(), l.other_id) not in ('locked', 'blocked')))
  order by coalesce(l.msg_at, l.conv_created) desc
  limit 200;
$$;
revoke execute on function public.inbox() from public, anon;
grant execute on function public.inbox() to authenticated;

-- ═════════════════════════════════════════════ message requests (+ restricted chats)
-- Restricted chats: my active 1:1 with someone I restrict that has a message from them I haven't
-- cleared. Listed in the 'requests' folder with restricted = true; preview / created_at = their latest
-- message.
drop function if exists public.list_message_requests();
create function public.list_message_requests()
returns table (
  conversation_id uuid, folder text, other_id uuid, display_name text, username text, avatar_url text,
  follows_me boolean, mutual_count int, taste_match int, preview text, created_at timestamptz,
  new_account boolean, mass_sent boolean, restricted boolean)
language sql stable security definer set search_path = public as $$
  with pending as (
    select mine.conversation_id,
      case when mine.status = 'filtered' then 'filtered' else 'requests' end as folder,
      o.user_id as other_id,
      coalesce((select public.message_preview(m.kind, m.body, m.track, m.meta)
                from public.messages m where m.conversation_id = mine.conversation_id
                order by m.created_at limit 1), 'Sent you a message') as preview,
      coalesce(mine.requested_at, c.created_at) as at,
      false as restricted
    from public.conversation_members mine
    join public.conversations c on c.id = mine.conversation_id
    join public.conversation_members o on o.conversation_id = mine.conversation_id and o.user_id <> mine.user_id
    where mine.user_id = auth.uid()
      and mine.status in ('request', 'filtered')
      and mine.requested_at is not null
  ), restricted_chats as (
    select mine.conversation_id, 'requests'::text as folder, r.restricted as other_id,
      public.message_preview(lm.kind, lm.body, lm.track, lm.meta) as preview,
      lm.created_at as at,
      true as restricted
    from public.dm_restrictions r
    join public.conversation_members mine on mine.user_id = auth.uid() and mine.status = 'active'
    join public.conversation_members o on o.conversation_id = mine.conversation_id and o.user_id = r.restricted
    cross join lateral (
      select msg.kind, msg.body, msg.track, msg.meta, msg.created_at
      from public.messages msg
      where msg.conversation_id = mine.conversation_id and msg.sender_id = r.restricted
        and not exists (select 1 from public.message_hidden h where h.user_id = auth.uid() and h.message_id = msg.id)
        and not public.message_expired(msg.conversation_id, msg.created_at)
      order by msg.created_at desc
      limit 1
    ) lm
    where r.restricter = auth.uid()
      and (select count(*) from public.conversation_members x where x.conversation_id = mine.conversation_id) = 2
  ), allrows as (
    select * from pending union all select * from restricted_chats
  )
  select a.conversation_id, a.folder, p.id, p.display_name, p.username, p.avatar_url,
    exists (select 1 from public.follows f where f.follower_id = p.id and f.following_id = auth.uid()),
    public.dm_mutual_count(p.id),
    public.taste_match(p.id),
    a.preview,
    a.at,
    p.created_at > now() - interval '7 days',
    (select count(*) from public.conversations x
     where x.created_by = p.id and x.created_at > now() - interval '24 hours') > 10,
    a.restricted
  from allrows a
  join public.profiles p on p.id = a.other_id
  where auth.uid() is not null and not public.blocked_with(p.id)
  order by a.at desc;
$$;
revoke execute on function public.list_message_requests() from public, anon;
grant execute on function public.list_message_requests() to authenticated;

-- Badge: pending requests (Requests folder) + restricted chats with an unread message from them.
create or replace function public.message_request_count() returns int
language sql stable security definer set search_path = public as $$
  select (
    select count(*)::int
    from public.conversation_members mine
    join public.conversation_members o on o.conversation_id = mine.conversation_id and o.user_id <> mine.user_id
    where mine.user_id = auth.uid() and mine.status = 'request' and mine.requested_at is not null
      and not public.blocked_with(o.user_id)
  ) + (
    select count(*)::int
    from public.dm_restrictions r
    join public.conversation_members mine on mine.user_id = auth.uid() and mine.status = 'active'
    join public.conversation_members o on o.conversation_id = mine.conversation_id and o.user_id = r.restricted
    where r.restricter = auth.uid()
      and not public.blocked_with(r.restricted)
      and (select count(*) from public.conversation_members x where x.conversation_id = mine.conversation_id) = 2
      and exists (select 1 from public.messages msg
                  where msg.conversation_id = mine.conversation_id and msg.sender_id = r.restricted
                    and msg.created_at > mine.last_read_at
                    and not exists (select 1 from public.message_hidden h where h.user_id = auth.uid() and h.message_id = msg.id))
  );
$$;
revoke execute on function public.message_request_count() from public, anon;
grant execute on function public.message_request_count() to authenticated;

-- Home badge: unread across inbox() except blocked chats, + requests.
create or replace function public.inbox_unread_total() returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(i.unread) from public.inbox() i where i.blocked is null), 0)::int
       + public.message_request_count();
$$;
revoke execute on function public.inbox_unread_total() from public, anon;
grant execute on function public.inbox_unread_total() to authenticated;

-- Accept: as before, plus accepting a restricted chat unrestricts its other member.
create or replace function public.accept_message_request(cid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not public.is_conversation_member(cid) then
    raise exception 'Request not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  update public.conversation_members set status = 'active'
  where conversation_id = cid and user_id = auth.uid() and status <> 'active';
  delete from public.dm_restrictions
  where restricter = auth.uid() and restricted = public.dm_partner(cid, auth.uid());
  update public.notifications set read = true
  where user_id = auth.uid() and kind = 'message_request' and not read
    and payload ->> 'conversation_id' = cid::text;
end $$;
revoke execute on function public.accept_message_request(uuid) from public, anon;
grant execute on function public.accept_message_request(uuid) to authenticated;

-- Decline: a pending request is deleted as before; a restricted chat is only cleared for me (every
-- current message hidden), so it leaves Requests until they write again. Nothing is deleted for them.
create or replace function public.decline_message_request(cid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  other uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from public.conversation_members
             where conversation_id = cid and user_id = auth.uid() and status in ('request', 'filtered')) then
    insert into public.dm_declines (recipient, sender)
    select distinct auth.uid(), m.user_id from public.conversation_members m
    where m.conversation_id = cid and m.user_id <> auth.uid()
    on conflict (recipient, sender) do update set declined_at = now();
    delete from public.notifications
    where user_id = auth.uid() and kind = 'message_request' and payload ->> 'conversation_id' = cid::text;
    delete from public.conversations where id = cid;
    return;
  end if;

  other := public.dm_partner(cid, auth.uid());
  if other is null or not public.is_conversation_member(cid) or not public.restricts(auth.uid(), other) then
    raise exception 'Request not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  insert into public.message_hidden (user_id, message_id)
  select auth.uid(), m.id from public.messages m where m.conversation_id = cid
  on conflict do nothing;
  update public.conversation_members set last_read_at = now()
  where conversation_id = cid and user_id = auth.uid();
end $$;
revoke execute on function public.decline_message_request(uuid) from public, anon;
grant execute on function public.decline_message_request(uuid) to authenticated;

-- Decline all in a folder: pending ones deleted as before; in 'requests', restricted chats are cleared
-- for me too. Returns how many rows left the folder.
create or replace function public.decline_all_message_requests(folder text) returns int
language plpgsql security definer set search_path = public as $$
declare
  ids uuid[];
  rids uuid[];
  n int := 0;
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

  if cardinality(ids) > 0 then
    insert into public.dm_declines (recipient, sender)
    select distinct auth.uid(), o.user_id from public.conversation_members o
    where o.conversation_id = any (ids) and o.user_id <> auth.uid()
    on conflict (recipient, sender) do update set declined_at = now();
    delete from public.notifications
    where user_id = auth.uid() and kind = 'message_request'
      and payload ->> 'conversation_id' in (select i::text from unnest(ids) i);
    delete from public.conversations c where c.id = any (ids);
    get diagnostics n = row_count;
  end if;

  if folder = 'requests' then
    select coalesce(array_agg(r.conversation_id), '{}') into rids
    from public.list_message_requests() r where r.restricted;
    if cardinality(rids) > 0 then
      insert into public.message_hidden (user_id, message_id)
      select auth.uid(), m.id from public.messages m where m.conversation_id = any (rids)
      on conflict do nothing;
      update public.conversation_members set last_read_at = now()
      where conversation_id = any (rids) and user_id = auth.uid();
      n := n + cardinality(rids);
    end if;
  end if;
  return n;
end $$;
revoke execute on function public.decline_all_message_requests(text) from public, anon;
grant execute on function public.decline_all_message_requests(text) to authenticated;

-- ═════════════════════════════════════════════ quiet hours time zone
create or replace function public.set_notification_tz(tz text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  if tz is null or not exists (select 1 from pg_timezone_names where name = tz) then
    raise exception 'Unknown time zone' using errcode = '22023';
  end if;
  insert into public.user_settings (user_id, notifications)
  values (auth.uid(), jsonb_build_object('tz', tz))
  on conflict (user_id) do update
    set notifications = public.user_settings.notifications || jsonb_build_object('tz', tz)
    where public.user_settings.notifications ->> 'tz' is distinct from tz;
end $$;
revoke execute on function public.set_notification_tz(text) from public, anon;
grant execute on function public.set_notification_tz(text) to authenticated;

-- ═════════════════════════════════════════════ New message: taste match per contact
-- Same as 20261115120000_dm_requests_privacy.sql's message_contacts, plus taste_match (0–100, null
-- without data) for the "92% taste match" subtitle.
drop function if exists public.message_contacts(text);
create function public.message_contacts(q text)
returns table (
  id uuid, display_name text, username text, avatar_url text, access text,
  follows_me boolean, i_follow boolean, mutual_count int, conversation_id uuid, taste_match int)
language sql stable security definer set search_path = public as $$
  with term as (
    select nullif(btrim(ltrim(btrim(coalesce(q, '')), '@')), '') as t
  ), pat as (
    select t, case when t is null then null
      else '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%' end as p
    from term
  ), cand as (
    select f.following_id as uid from public.follows f where f.follower_id = auth.uid()
    union
    select f.follower_id from public.follows f where f.following_id = auth.uid()
    union
    select o.user_id from public.conversation_members mine
    join public.conversation_members o on o.conversation_id = mine.conversation_id and o.user_id <> mine.user_id
    where mine.user_id = auth.uid()
    union
    (select pr.id from public.profiles pr, pat
     where char_length(pat.t) >= 2 and (pr.display_name ilike pat.p or pr.username ilike pat.p)
     limit 200)
  ), base as (
    select p.id, p.display_name, p.username, p.avatar_url,
      exists (select 1 from public.follows f where f.follower_id = p.id and f.following_id = auth.uid()) as follows_me,
      exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.following_id = p.id) as i_follow,
      public.dm_mutual_count(p.id) as mutual_count,
      public.dm_conversation_with(p.id) as conversation_id
    from cand
    join public.profiles p on p.id = cand.uid
    cross join pat
    where auth.uid() is not null
      and p.id <> auth.uid()
      and not public.blocked_with(p.id)
      and (pat.p is null or p.display_name ilike pat.p or p.username ilike pat.p)
  ), shortlist as (
    select * from base
    order by (conversation_id is not null or (follows_me and i_follow)) desc, mutual_count desc, lower(display_name)
    limit 300
  ), ranked as (
    select s.*, public.dm_access(s.id) as access from shortlist s
    offset 0
  )
  , top as (
    select r.* from ranked r
    where r.access <> 'blocked'
    order by (r.access = 'direct') desc, r.mutual_count desc, lower(r.display_name)
    limit 50
  )
  select t.id, t.display_name, t.username, t.avatar_url, t.access, t.follows_me, t.i_follow,
         t.mutual_count, t.conversation_id, public.taste_match(t.id)
  from top t
  order by (t.access = 'direct') desc, t.mutual_count desc, lower(t.display_name);
$$;
revoke execute on function public.message_contacts(text) from public, anon;
grant execute on function public.message_contacts(text) to authenticated;
