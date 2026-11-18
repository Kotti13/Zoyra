-- E2EE chat integration + group-safe 1:1 detection.
--
-- 1:1 detection by "conversation has 2 members" (a 2-person group has that too) → conversations.kind = 'direct':
--   restrict_user            notifications muted only for 1:1 chats with the restricted person
--   list_message_requests    pending rows and restricted chats: direct chats only
--   message_request_count    restricted chats: direct chats only
--   on_block_drop_requests   drops pending 1:1 requests only
--   dm_message_guard         request limits / song-share rule / access re-check: direct chats only
--   conversation_request_state  groups are always 'none' (no requests in groups)
--   edit_message             block check = conversation_blocked() (false in groups, like edit_e2ee_message)
--   deliver_scheduled_messages  a block between the sender and one group member no longer fails group
--                            deliveries (1:1 unchanged). Scheduled messages stay plaintext.
--   search_my_messages       + group history since joining (security: rows sent before I joined a group are
--                            never returned; the select policy already hides them, this function is security
--                            definer). 1:1 / group shape from conversations.kind.
-- Unchanged (already kind-aware): dm_conversation_with, dm_partner, dm_tool_other, conversation_blocked, inbox().
-- Not touched: notify_user / message_preview / poll_option_ok keep their e2ee branches (20261115250000).
--
-- Push tokens ↔ E2EE devices (per-device encrypted notification previews, see supabase/functions/push):
--   push_tokens.device_id    the E2EE device (e2ee_devices.device_id) of the install that owns the token, or
--                            null. No FK: revoked devices keep their row in e2ee_devices; the push function
--                            only uses device_id when it is an active device of the token's user. A trigger
--                            clears device_id when it isn't an active device of the row's user (clients can
--                            also write push_tokens directly under RLS).
--   register_push_token(p_token, p_platform, p_device_id)  p_device_id optional (old 2-arg calls still work).
--
-- Realtime: message_reactions / poll_votes leave supabase_realtime (clients use a `side` broadcast instead).

-- ═════════════════════════════════════════════ restrict_user (20261115200000 + kind = 'direct')
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
  -- Their pending chat alerts go quiet too (1:1 chats only).
  update public.notifications n set read = true
  where n.user_id = auth.uid() and n.kind = 'message' and not n.read
    and n.payload ->> 'conversation_id' in (
      select a.conversation_id::text from public.conversation_members a
      join public.conversation_members b on b.conversation_id = a.conversation_id and b.user_id = other
      join public.conversations c on c.id = a.conversation_id and c.kind = 'direct'
      where a.user_id = auth.uid());
end $$;
revoke execute on function public.restrict_user(uuid) from public, anon;
grant execute on function public.restrict_user(uuid) to authenticated;

-- ═════════════════════════════════════════════ list_message_requests (20261115200000 + kind = 'direct')
create or replace function public.list_message_requests()
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
    join public.conversations c on c.id = mine.conversation_id and c.kind = 'direct'
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
    join public.conversations c on c.id = mine.conversation_id and c.kind = 'direct'
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

-- ═════════════════════════════════════════════ message_request_count (20261115200000 + kind = 'direct')
create or replace function public.message_request_count() returns int
language sql stable security definer set search_path = public as $$
  select (
    select count(*)::int
    from public.conversation_members mine
    join public.conversations c on c.id = mine.conversation_id and c.kind = 'direct'
    join public.conversation_members o on o.conversation_id = mine.conversation_id and o.user_id <> mine.user_id
    where mine.user_id = auth.uid() and mine.status = 'request' and mine.requested_at is not null
      and not public.blocked_with(o.user_id)
  ) + (
    select count(*)::int
    from public.dm_restrictions r
    join public.conversation_members mine on mine.user_id = auth.uid() and mine.status = 'active'
    join public.conversations c on c.id = mine.conversation_id and c.kind = 'direct'
    join public.conversation_members o on o.conversation_id = mine.conversation_id and o.user_id = r.restricted
    where r.restricter = auth.uid()
      and not public.blocked_with(r.restricted)
      and exists (select 1 from public.messages msg
                  where msg.conversation_id = mine.conversation_id and msg.sender_id = r.restricted
                    and msg.created_at > mine.last_read_at
                    and not exists (select 1 from public.message_hidden h where h.user_id = auth.uid() and h.message_id = msg.id))
  );
$$;
revoke execute on function public.message_request_count() from public, anon;
grant execute on function public.message_request_count() to authenticated;

-- ═════════════════════════════════════════════ on_block_drop_requests (20261115150000 + kind = 'direct')
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
      and c.kind = 'direct'
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

-- ═════════════════════════════════════════════ dm_message_guard (20261115150000 + kind = 'direct')
create or replace function public.dm_message_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r record;
  sent int;
  access text;
begin
  if not exists (select 1 from public.conversations c where c.id = new.conversation_id and c.kind = 'direct') then
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

-- ═════════════════════════════════════════════ conversation_request_state (20261115120000 + groups → 'none')
create or replace function public.conversation_request_state(cid uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when not public.is_conversation_member(cid) then 'none'
    when public.is_group(cid) then 'none'
    when exists (select 1 from public.conversation_members m
                 where m.conversation_id = cid and m.user_id = auth.uid() and m.status <> 'active') then 'incoming'
    when exists (select 1 from public.conversation_members m
                 where m.conversation_id = cid and m.user_id <> auth.uid() and m.status <> 'active') then 'outgoing'
    else 'none' end;
$$;
revoke execute on function public.conversation_request_state(uuid) from public, anon;
grant execute on function public.conversation_request_state(uuid) to authenticated;

-- ═════════════════════════════════════════════ edit_message (20261115190000; block check = conversation_blocked)
create or replace function public.edit_message(mid uuid, new_body text) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.messages%rowtype;
  b text := btrim(coalesce(new_body, ''));
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into m from public.messages where id = mid for update;
  if not found or not public.is_conversation_member(m.conversation_id) then
    raise exception 'This message is no longer available.' using errcode = 'P0002';
  end if;
  if m.sender_id is distinct from auth.uid() then
    raise exception 'You can only edit your own messages.' using errcode = '42501';
  end if;
  if m.e2ee_version is not null then
    raise exception 'Use edit_e2ee_message for this message.' using errcode = '22023';
  end if;
  if m.kind is distinct from 'text' then
    raise exception 'Only text messages can be edited.' using errcode = '22023';
  end if;
  if m.created_at < now() - interval '15 minutes' then
    raise exception 'Messages can only be edited for 15 minutes after sending.' using errcode = '22023';
  end if;
  if b = '' then raise exception 'Message is empty.' using errcode = '22023'; end if;
  if char_length(b) > 2000 then raise exception 'Message is too long.' using errcode = '22023'; end if;
  -- 1:1: a block either way stops edits. Groups: a block between two members doesn't (conversation_blocked).
  if public.conversation_blocked(m.conversation_id) then
    raise exception 'You can''t message this person.' using errcode = '42501';
  end if;
  if b = m.body then return; end if;

  update public.messages
     set body = b,
         edited_at = now(),
         meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('edited_at', now())
   where id = mid;
end $$;
revoke execute on function public.edit_message(uuid, text) from public, anon;
grant execute on function public.edit_message(uuid, text) to authenticated;

-- ═════════════════════════════════════════════ deliver_scheduled_messages (20261114180000; group-safe block check)
create or replace function public.deliver_scheduled_messages() returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select * from public.scheduled_messages
    where sent_at is null and failed is null and send_at <= now()
    order by send_at
    limit 200
    for update skip locked
  loop
    if not exists (select 1 from public.conversation_members where conversation_id = r.conversation_id and user_id = r.sender_id) then
      update public.scheduled_messages set failed = 'no_longer_member' where id = r.id;
    elsif exists (select 1 from public.conversations c where c.id = r.conversation_id and c.kind = 'direct')
      and exists (
        select 1 from public.conversation_members m
        join public.blocks b
          on (b.blocker_id = r.sender_id and b.blocked_id = m.user_id)
          or (b.blocked_id = r.sender_id and b.blocker_id = m.user_id)
        where m.conversation_id = r.conversation_id and m.user_id <> r.sender_id
      ) then
      update public.scheduled_messages set failed = 'blocked' where id = r.id;
    else
      insert into public.messages (conversation_id, sender_id, body, kind)
      values (r.conversation_id, r.sender_id, r.body, 'text');
      update public.scheduled_messages set sent_at = now() where id = r.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.deliver_scheduled_messages() from public, anon, authenticated;

-- ═════════════════════════════════════════════ search_my_messages (20261115240000 + joined_at, kind)
drop function if exists public.search_my_messages(text, text, int);
create function public.search_my_messages(q text, kind_filter text default 'all', lim int default 50)
returns table (
  id uuid, conversation_id uuid, kind text, snippet text, track jsonb, meta jsonb, created_at timestamptz,
  sender_id uuid, sender_name text, sender_avatar text,
  conversation_title text, conversation_avatar text, other_id uuid, other_name text, other_avatar text,
  is_group boolean, member_count int)
language sql stable security definer set search_path = public as $$
  with args as (
    select
      btrim(coalesce(q, '')) as term,
      '%' || replace(replace(replace(btrim(coalesce(q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
      case when lower(coalesce(kind_filter, 'all')) in ('songs', 'voice', 'media', 'links', 'polls')
           then lower(kind_filter) else 'all' end as f,
      least(greatest(coalesce(lim, 50), 1), 200) as n
  ), convs as (
    -- My active chats + their shape (1:1 partner, member count, group fields) + when I joined.
    select c.id as cid, c.disappear_seconds, c.disappear_since,
           to_jsonb(c) as cj,
           c.kind = 'group' as grp,
           me.joined_at,
           o.n + 1 as members, o.other_id
    from public.conversation_members me
    join public.conversations c on c.id = me.conversation_id
    cross join lateral (
      select count(*)::int as n, (array_agg(om.user_id order by om.user_id))[1] as other_id
      from public.conversation_members om
      where om.conversation_id = c.id and om.user_id <> auth.uid()
    ) o
    where me.user_id = auth.uid() and me.status = 'active'
  ), shaped as (
    select convs.*
    from convs
    where not (
      not convs.grp and convs.other_id is not null
      and (public.blocked_with(convs.other_id) or public.restricts(auth.uid(), convs.other_id))
    )
  ), hits as (
    select m.id, m.conversation_id, m.kind, m.body, m.track, m.meta, m.created_at, m.sender_id,
           s.grp, s.members, s.other_id, s.cj, a.term, a.pat, a.f,
           sp.display_name as sender_name, sp.avatar_url as sender_avatar,
           op.display_name as other_name, op.avatar_url as other_avatar
    from args a
    cross join shaped s
    join public.messages m on m.conversation_id = s.cid
    left join public.profiles sp on sp.id = m.sender_id
    left join public.profiles op on op.id = s.other_id
    where auth.uid() is not null
      and (a.f <> 'all' or a.term <> '')
      and m.kind <> 'call'
      -- Groups: nothing from before I joined.
      and (not s.grp or m.created_at >= s.joined_at)
      and not exists (select 1 from public.message_hidden h where h.user_id = auth.uid() and h.message_id = m.id)
      and not (s.disappear_seconds is not null and s.disappear_since is not null
               and m.created_at >= s.disappear_since
               and m.created_at < now() - make_interval(secs => s.disappear_seconds))
      and (m.sender_id = auth.uid() or not public.blocked_with(m.sender_id))
      and case a.f
        when 'all' then
          m.body ilike a.pat
          or (m.track is not null and (m.track ->> 'title' ilike a.pat
                                       or coalesce(m.track -> 'artist' ->> 'name', m.track ->> 'artist') ilike a.pat))
          or (m.kind = 'poll' and (m.meta ->> 'question' ilike a.pat or (m.meta -> 'options')::text ilike a.pat))
          or (m.kind in ('playlist', 'jam', 'live') and (m.meta ->> 'title' ilike a.pat or m.meta ->> 'name' ilike a.pat))
          or (m.kind = 'lyric' and m.meta ->> 'line' ilike a.pat)
        when 'songs' then
          (m.kind in ('track', 'swap') or m.track is not null or (m.kind = 'lyric' and m.meta ? 'track'))
          and (a.term = ''
               or m.body ilike a.pat
               or coalesce(m.track, m.meta -> 'track') ->> 'title' ilike a.pat
               or coalesce(coalesce(m.track, m.meta -> 'track') -> 'artist' ->> 'name',
                           coalesce(m.track, m.meta -> 'track') ->> 'artist') ilike a.pat)
        when 'voice' then
          m.kind = 'voice'
          and (a.term = '' or sp.display_name ilike a.pat or op.display_name ilike a.pat or s.cj ->> 'title' ilike a.pat)
        when 'media' then
          m.kind = 'photo'
          and (a.term = '' or m.body ilike a.pat or sp.display_name ilike a.pat or op.display_name ilike a.pat
               or s.cj ->> 'title' ilike a.pat)
        when 'links' then
          m.body ~* '(https?://|www\.)[^[:space:]]+'
          and (a.term = '' or m.body ilike a.pat)
        when 'polls' then
          m.kind = 'poll'
          and (a.term = '' or m.meta ->> 'question' ilike a.pat or (m.meta -> 'options')::text ilike a.pat)
        else false
      end
    order by m.created_at desc
    limit (select n from args)
  )
  select h.id, h.conversation_id, h.kind,
    case
      when coalesce(h.body, '') <> '' and h.kind in ('text', 'track', 'photo') then
        case
          when char_length(h.body) <= 160 then h.body
          else (
            -- ~160 characters around the first match.
            with p as (select greatest(strpos(lower(h.body), lower(h.term)) - 50, 1) as st)
            select case when p.st > 1 then '…' else '' end
                   || substr(h.body, p.st, 160)
                   || case when p.st + 160 <= char_length(h.body) then '…' else '' end
            from p)
        end
      else public.message_preview(h.kind, h.body, h.track, h.meta)
    end,
    h.track, h.meta, h.created_at,
    h.sender_id, h.sender_name, h.sender_avatar,
    nullif(btrim(h.cj ->> 'title'), ''), nullif(h.cj ->> 'avatar_url', ''),
    case when h.grp then null else h.other_id end,
    case when h.grp then null else h.other_name end,
    case when h.grp then null else h.other_avatar end,
    h.grp, h.members
  from hits h
  order by h.created_at desc;
$$;
revoke execute on function public.search_my_messages(text, text, int) from public, anon;
grant execute on function public.search_my_messages(text, text, int) to authenticated;

-- ═════════════════════════════════════════════ push tokens ↔ E2EE devices
alter table public.push_tokens add column if not exists device_id uuid;
create index if not exists push_tokens_device_idx on public.push_tokens (device_id) where device_id is not null;

-- device_id must be an active E2EE device of the row's user (clients can write their rows under RLS).
create or replace function public.push_token_device_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.device_id is not null and not exists (
    select 1 from public.e2ee_devices d
    where d.device_id = new.device_id and d.user_id = new.user_id and d.revoked_at is null
  ) then
    new.device_id := null;
  end if;
  return new;
end $$;
revoke execute on function public.push_token_device_guard() from public, anon, authenticated;
drop trigger if exists push_token_device_guard on public.push_tokens;
create trigger push_token_device_guard before insert or update on public.push_tokens
  for each row execute function public.push_token_device_guard();

drop function if exists public.register_push_token(text, text);
create or replace function public.register_push_token(p_token text, p_platform text default 'unknown', p_device_id uuid default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  dev uuid := case when p_device_id is not null and exists (
                select 1 from public.e2ee_devices d
                where d.device_id = p_device_id and d.user_id = auth.uid() and d.revoked_at is null)
              then p_device_id end;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.push_tokens (user_id, token, platform, device_id, updated_at)
  values (auth.uid(), p_token,
          case when p_platform in ('ios', 'android', 'web') then p_platform else 'unknown' end, dev, now())
  on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform, device_id = excluded.device_id, updated_at = now();
end $$;
revoke execute on function public.register_push_token(text, text, uuid) from public, anon;
grant execute on function public.register_push_token(text, text, uuid) to authenticated;

-- ═════════════════════════════════════════════ realtime: reactions / votes leave the publication
-- Chat screens (chat-pro, group-chat) no longer subscribe to message_reactions / poll_votes changes: the member
-- who reacts / votes sends a `side` broadcast on the chat's private channel and receivers re-read under RLS.
-- Dropping the tables from supabase_realtime stops the server from fanning out their row changes at all.
do $$
begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reactions') then
    alter publication supabase_realtime drop table public.message_reactions;
  end if;
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'poll_votes') then
    alter publication supabase_realtime drop table public.poll_votes;
  end if;
end $$;
