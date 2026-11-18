-- Inbox: pin & archive chats (Messages screen, Instagram-DMs style).
--
--   conversation_members.pinned_at / archived_at   own row only ("mark read" policy: user_id = auth.uid());
--                                                 UPDATE granted on the two columns, SELECT is not (like
--                                                 muted / muted_until in 20261115280000 L2: other members
--                                                 must not learn that I pinned or archived our chat). Own
--                                                 values come back from inbox() (security definer).
--   pin limit                                      max 5 pinned chats per user, enforced by a trigger so a
--                                                 direct column update can't bypass it (hint 'pin_limit').
--   set_chat_pinned(cid, pinned)                   member check; pinning also unarchives.
--   set_chat_archived(cid, archived)               member check; archiving also unpins.
--   auto-unarchive                                 a new message from someone else clears archived_at for
--                                                 the other members (WhatsApp behaviour), except members who
--                                                 muted the chat (muted, or muted_until in the future).
--   inbox()                                        same as 20261115230000_group_chats.sql (every column and
--                                                 rule kept), plus pinned_at, archived_at and last_track
--                                                 (track jsonb of the last visible message, null for E2EE
--                                                 rows) for cover thumbnails. Pinned chats first (newest
--                                                 pin first), then last activity. Archived chats are still
--                                                 returned; the client files them under "Archived chats".

-- ═════════════════════════════════════════════ columns + privileges
alter table public.conversation_members
  add column if not exists pinned_at timestamptz,
  add column if not exists archived_at timestamptz;

create index if not exists conversation_members_user_pinned_idx
  on public.conversation_members (user_id) where pinned_at is not null;

-- "mark read" (20261115150000) already limits UPDATE to the caller's own rows (using + with check).
grant update (pinned_at, archived_at) on public.conversation_members to authenticated;

-- ═════════════════════════════════════════════ pin limit
create or replace function public.conversation_members_pin_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.pinned_at is not null and old.pinned_at is null then
    -- Serialise concurrent pins by the same user so two requests can't both pass the count.
    perform pg_advisory_xact_lock(hashtext('chat_pin:' || new.user_id::text));
    if (select count(*) from public.conversation_members m
        where m.user_id = new.user_id and m.pinned_at is not null
          and m.conversation_id <> new.conversation_id and m.status = 'active') >= 5 then
      raise exception 'You can pin up to 5 chats' using errcode = 'P0001', hint = 'pin_limit';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.conversation_members_pin_guard() from public, anon, authenticated;
drop trigger if exists conversation_members_pin_guard on public.conversation_members;
create trigger conversation_members_pin_guard before update of pinned_at on public.conversation_members
  for each row when (new.pinned_at is distinct from old.pinned_at)
  execute function public.conversation_members_pin_guard();

-- ═════════════════════════════════════════════ RPCs
create or replace function public.set_chat_pinned(cid uuid, pinned boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not exists (select 1 from public.conversation_members m
                 where m.conversation_id = cid and m.user_id = auth.uid() and m.status = 'active') then
    raise exception 'This conversation is no longer available.' using errcode = '42501';
  end if;
  if coalesce(pinned, false) then
    update public.conversation_members
       set pinned_at = coalesce(pinned_at, now()), archived_at = null
     where conversation_id = cid and user_id = auth.uid();
  else
    update public.conversation_members set pinned_at = null
     where conversation_id = cid and user_id = auth.uid() and pinned_at is not null;
  end if;
end $$;
revoke execute on function public.set_chat_pinned(uuid, boolean) from public, anon;
grant execute on function public.set_chat_pinned(uuid, boolean) to authenticated;

create or replace function public.set_chat_archived(cid uuid, archived boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not exists (select 1 from public.conversation_members m
                 where m.conversation_id = cid and m.user_id = auth.uid() and m.status = 'active') then
    raise exception 'This conversation is no longer available.' using errcode = '42501';
  end if;
  if coalesce(archived, false) then
    update public.conversation_members
       set archived_at = coalesce(archived_at, now()), pinned_at = null
     where conversation_id = cid and user_id = auth.uid();
  else
    update public.conversation_members set archived_at = null
     where conversation_id = cid and user_id = auth.uid() and archived_at is not null;
  end if;
end $$;
revoke execute on function public.set_chat_archived(uuid, boolean) from public, anon;
grant execute on function public.set_chat_archived(uuid, boolean) to authenticated;

-- ═════════════════════════════════════════════ auto-unarchive on new messages
create or replace function public.unarchive_on_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.conversation_members m
     set archived_at = null
   where m.conversation_id = new.conversation_id
     and m.user_id <> new.sender_id
     and m.archived_at is not null
     and not (coalesce(m.muted, false) or coalesce(m.muted_until > now(), false));
  return new;
end $$;
revoke execute on function public.unarchive_on_message() from public, anon, authenticated;
drop trigger if exists on_message_unarchive on public.messages;
create trigger on_message_unarchive after insert on public.messages
  for each row execute function public.unarchive_on_message();

-- ═════════════════════════════════════════════ inbox (+ pinned_at, archived_at, last_track)
drop function if exists public.inbox();
create function public.inbox()
returns table (
  conversation_id uuid, member_count int, other_id uuid, other_name text, other_username text, other_avatar text,
  last_message_id uuid, last_sender_id uuid, last_kind text, last_preview text, last_at timestamptz,
  unread int, request_state text, muted boolean, muted_until timestamptz, blocked text,
  kind text, title text, avatar_url text, last_sender_name text, last_meta jsonb,
  pinned_at timestamptz, archived_at timestamptz, last_track jsonb)
language sql stable security definer set search_path = public as $$
  with mine as (
    select m.conversation_id, m.last_read_at, m.muted, m.muted_until, c.created_at as conv_created,
           c.disappear_seconds, c.disappear_since, c.kind as conv_kind, c.title as conv_title,
           c.avatar_url as conv_avatar,
           case when c.kind = 'group' then m.joined_at end as since,
           m.pinned_at as pin_at, m.archived_at as arch_at
    from public.conversation_members m
    join public.conversations c on c.id = m.conversation_id
    where m.user_id = auth.uid() and m.status = 'active'
  ), x as (
    select mine.*, o.n + 1 as member_count,
           case when mine.conv_kind = 'group' then null else o.other_id end as other_id,
           coalesce(o.pending, false) as pending
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
      case when x.conv_kind = 'group' or x.member_count <> 2 or x.other_id is null then null
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
        and (xb.since is null or msg.created_at >= xb.since)
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
       and (l.since is null or u.created_at >= l.since)
       and not exists (select 1 from public.message_hidden h where h.user_id = auth.uid() and h.message_id = u.id)
       and not (l.disappear_seconds is not null and l.disappear_since is not null
                and u.created_at >= l.disappear_since
                and u.created_at < now() - make_interval(secs => l.disappear_seconds))),
    case when l.pending then 'outgoing' else 'none' end,
    l.muted or coalesce(l.muted_until > now(), false),
    case when l.muted_until > now() then l.muted_until end,
    l.blocked,
    l.conv_kind,
    case when l.conv_kind = 'group' then l.conv_title end,
    case when l.conv_kind = 'group' then l.conv_avatar end,
    case when l.msg_id is null then null else public.display_name_of(l.sender_id) end,
    case when l.msg_id is null then null else l.meta end,
    l.pin_at,
    l.arch_at,
    case when l.msg_id is null or coalesce(l.meta ? 'e2ee', false) then null else l.track end
  from l
  left join public.profiles p on p.id = l.other_id
  where auth.uid() is not null
    and (l.conv_kind = 'group'
         or not (l.member_count = 2 and l.other_id is not null
                 and public.restricts(auth.uid(), l.other_id) and not public.blocked_with(l.other_id)))
    and (l.conv_kind = 'group'
         or l.msg_id is not null
         or (l.pending and l.member_count = 2
             and public.dm_new_chat_access_for(auth.uid(), l.other_id) not in ('locked', 'blocked')))
  order by (l.pin_at is not null) desc, l.pin_at desc nulls last, coalesce(l.msg_at, l.conv_created) desc
  limit 200;
$$;
revoke execute on function public.inbox() from public, anon;
grant execute on function public.inbox() to authenticated;

-- inbox_unread_total() reads inbox() by column name (unread, blocked): unchanged and still valid.
