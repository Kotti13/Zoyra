-- DM requests, message privacy and chat tools (Message requests, Message privacy, New message,
-- Chat tools designs). Client contract: src/lib/dm.ts — keep RPC names, argument names and shapes in sync.
--
--   user_settings.dm           jsonb privacy settings (DmSettings in dm.ts), read via dm_setting()
--   conversation_members       + status ('active' | 'request' | 'filtered', recipient side)
--                              + requested_at (first message of a pending request) + last_delivered_at
--   conversations              + created_by, blend_playlist_id, queue_room_id
--   messages.kind              + 'swap' (Song swap)
--   song_swap_ratings          1–5 stars on the other person's swap pick
--
-- ─────────────────────────────────────────────────────────── DM access rules (dm_access)
-- Evaluated for the caller (me) messaging `other` (them):
--   1. not signed in / self / unknown user               → 'locked'
--   2. a block exists in either direction                → 'blocked'
--   3. a 1:1 conversation already exists                  → 'direct' if their member row is 'active',
--                                                           otherwise 'request' (still pending)
--   4. their dm.who = 'none'  ("Turn off new chats")      → 'locked'
--   5. we follow each other (mutual friends)              → 'direct'
--   6. their dm.who = 'followers' and I follow them       → 'direct'
--   7. their dm.who = 'mutuals' and no follow either way  → 'locked'  ("only accepts people they know")
--   8. everything else                                    → 'request' (lands in their Requests)
-- i.e. who='everyone': mutuals direct, everyone else request;
--      who='followers': their followers direct, others request;
--      who='mutuals'  : mutuals direct, one-way follow either direction request, strangers locked;
--      who='none'     : only existing chats.
--
-- A new request goes to 'filtered' instead of 'request' when the recipient has dm.filter_spam on,
-- there is no follow in either direction, and the sender's account is < 7 days old or the sender
-- started > 10 conversations in the last 24 hours.
--
-- Pending requests are invisible to the recipient's lists/badges until the first message arrives
-- (conversation_members.requested_at is set by the message trigger). Replying to a request accepts it.
-- A block deletes pending (request/filtered) conversations between the two people.

-- ═════════════════════════════════════════════ privacy settings
alter table public.user_settings add column if not exists dm jsonb not null default '{}'::jsonb;
alter table public.user_settings drop constraint if exists user_settings_dm_object;
alter table public.user_settings add constraint user_settings_dm_object
  check (jsonb_typeof(dm) = 'object' and pg_column_size(dm) <= 4096);

-- Same values as DM_DEFAULTS in src/lib/dm.ts.
create or replace function public.dm_defaults() returns jsonb
language sql immutable set search_path = public as $$
  select '{"who":"mutuals","read_receipts":true,"online_status":true,"typing":true,"now_playing":true,
           "filter_spam":true,"song_shares_anyone":false,"group_invites":"mutuals"}'::jsonb;
$$;

-- One dm setting for a user as text ('true'/'false' for booleans), falling back to the default when
-- the user has no row, no key, or an invalid value. Internal: other users' settings stay private.
create or replace function public.dm_setting(uid uuid, key text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select case
       when key = 'who' and s.dm ->> key in ('everyone', 'mutuals', 'followers', 'none') then s.dm ->> key
       when key = 'group_invites' and s.dm ->> key in ('everyone', 'mutuals', 'none') then s.dm ->> key
       when key not in ('who', 'group_invites') and jsonb_typeof(s.dm -> key) = 'boolean' then s.dm ->> key
     end
     from public.user_settings s where s.user_id = uid),
    public.dm_defaults() ->> key);
$$;
revoke execute on function public.dm_setting(uuid, text) from public, anon, authenticated;

-- ═════════════════════════════════════════════ request state + delivery
alter table public.conversation_members
  add column if not exists status text not null default 'active' check (status in ('active', 'request', 'filtered')),
  add column if not exists requested_at timestamptz,
  add column if not exists last_delivered_at timestamptz;
create index if not exists conversation_members_user_status_idx on public.conversation_members (user_id, status);

alter table public.conversations
  add column if not exists created_by uuid references public.profiles (id) on delete set null,
  add column if not exists blend_playlist_id uuid references public.playlists (id) on delete set null,
  add column if not exists queue_room_id uuid references public.rooms (id) on delete set null;
create index if not exists conversations_created_by_idx on public.conversations (created_by, created_at desc);

-- conversation_members RLS (unchanged): "member list" lets every member read all member rows of their
-- conversations (incl. last_read_at / last_delivered_at / status); "mark read" lets a member update
-- only their own row.

-- ═════════════════════════════════════════════ internal helpers
-- The caller's 1:1 conversation with `other` (most recent), if any.
create or replace function public.dm_conversation_with(other uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select a.conversation_id
  from public.conversation_members a
  join public.conversation_members b on b.conversation_id = a.conversation_id and b.user_id = other
  join public.conversations c on c.id = a.conversation_id
  where a.user_id = auth.uid()
    and (select count(*) from public.conversation_members x where x.conversation_id = a.conversation_id) = 2
  order by c.last_message_at desc
  limit 1;
$$;
revoke execute on function public.dm_conversation_with(uuid) from public, anon, authenticated;

-- "Followed by people you follow": users the caller follows who also follow `other`.
create or replace function public.dm_mutual_count(other uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int
  from public.follows a
  join public.follows b on b.follower_id = a.following_id and b.following_id = other
  where a.follower_id = auth.uid();
$$;
revoke execute on function public.dm_mutual_count(uuid) from public, anon, authenticated;

-- Notification / request preview text for a message.
create or replace function public.message_preview(p_kind text, p_body text, p_track jsonb, p_meta jsonb) returns text
language sql immutable set search_path = public as $$
  select case
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

-- Artist name from a track's `artist` (string, or catalogue object {id, name, ...}) or a followed artist.
create or replace function public.dm_artist_name(a jsonb) returns text
language sql immutable set search_path = public as $$
  select nullif(lower(btrim(case jsonb_typeof(a)
    when 'string' then a #>> '{}'
    when 'object' then a ->> 'name' end)), '');
$$;

-- Distinct artist names a user likes (recent liked tracks) or follows.
create or replace function public.taste_artists(uid uuid) returns setof text
language sql stable security definer set search_path = public as $$
  select n from (
    select public.dm_artist_name(t.track -> 'artist') as n
    from (select track from public.liked_tracks where user_id = uid order by created_at desc limit 500) t
    union
    select public.dm_artist_name(a.artist) from public.followed_artists a where a.user_id = uid
  ) x
  where n is not null;
$$;
revoke execute on function public.taste_artists(uuid) from public, anon, authenticated;

-- ═════════════════════════════════════════════ taste match
-- 0–100: sqrt(Jaccard) over the two artist sets (sqrt so small-but-real overlaps read sensibly,
-- e.g. 5% raw overlap → 22). Null when either side has no data, or across a block.
create or replace function public.taste_match(other uuid) returns int
language sql stable security definer set search_path = public as $$
  with a(name) as (select n from public.taste_artists(auth.uid()) n),
       b(name) as (select n from public.taste_artists(other) n),
       s as (select (select count(*) from a) as na,
                    (select count(*) from b) as nb,
                    (select count(*) from a join b using (name)) as ni)
  select case
    when auth.uid() is null or other is null or s.na = 0 or s.nb = 0 or public.blocked_with(other) then null
    else least(100, round(100 * sqrt(s.ni::numeric / (s.na + s.nb - s.ni))))::int end
  from s;
$$;
revoke execute on function public.taste_match(uuid) from public, anon;
grant execute on function public.taste_match(uuid) to authenticated;

-- ═════════════════════════════════════════════ access
create or replace function public.dm_access(other uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cid uuid;
  their_status text;
  who text;
  i_follow boolean;
  follows_me boolean;
begin
  if me is null or other is null or other = me then return 'locked'; end if;
  if not exists (select 1 from public.profiles where id = other) then return 'locked'; end if;
  if public.blocked_with(other) then return 'blocked'; end if;

  cid := public.dm_conversation_with(other);
  if cid is not null then
    select m.status into their_status from public.conversation_members m
    where m.conversation_id = cid and m.user_id = other;
    return case when their_status = 'active' then 'direct' else 'request' end;
  end if;

  who := public.dm_setting(other, 'who');
  if who = 'none' then return 'locked'; end if;
  i_follow := exists (select 1 from public.follows where follower_id = me and following_id = other);
  follows_me := exists (select 1 from public.follows where follower_id = other and following_id = me);
  if i_follow and follows_me then return 'direct'; end if;
  if who = 'followers' and i_follow then return 'direct'; end if;
  if who = 'mutuals' and not i_follow and not follows_me then return 'locked'; end if;
  return 'request';
end $$;
revoke execute on function public.dm_access(uuid) from public, anon;
grant execute on function public.dm_access(uuid) to authenticated;

-- ═════════════════════════════════════════════ start_conversation (requests + privacy)
create or replace function public.start_conversation(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cid uuid;
  access text;
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
  if cid is not null then return cid; end if;

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

  insert into public.conversations (created_by) values (me) returning id into cid;
  insert into public.conversation_members (conversation_id, user_id, status)
  values (cid, me, 'active'), (cid, other, recipient_status);
  return cid;
end $$;
revoke execute on function public.start_conversation(uuid) from public, anon;
grant execute on function public.start_conversation(uuid) to authenticated;

-- 'none' | 'incoming' (I haven't accepted) | 'outgoing' (they haven't accepted). 'none' for non-members.
create or replace function public.conversation_request_state(cid uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when not public.is_conversation_member(cid) then 'none'
    when exists (select 1 from public.conversation_members m
                 where m.conversation_id = cid and m.user_id = auth.uid() and m.status <> 'active') then 'incoming'
    when exists (select 1 from public.conversation_members m
                 where m.conversation_id = cid and m.user_id <> auth.uid() and m.status <> 'active') then 'outgoing'
    else 'none' end;
$$;
revoke execute on function public.conversation_request_state(uuid) from public, anon;
grant execute on function public.conversation_request_state(uuid) to authenticated;

-- ═════════════════════════════════════════════ requests inbox
create or replace function public.list_message_requests()
returns table (
  conversation_id uuid, folder text, other_id uuid, display_name text, username text, avatar_url text,
  follows_me boolean, mutual_count int, taste_match int, preview text, created_at timestamptz,
  new_account boolean, mass_sent boolean)
language sql stable security definer set search_path = public as $$
  select
    mine.conversation_id,
    case when mine.status = 'filtered' then 'filtered' else 'requests' end,
    p.id,
    p.display_name,
    p.username,
    p.avatar_url,
    exists (select 1 from public.follows f where f.follower_id = p.id and f.following_id = auth.uid()),
    public.dm_mutual_count(p.id),
    public.taste_match(p.id),
    coalesce((select public.message_preview(m.kind, m.body, m.track, m.meta)
              from public.messages m where m.conversation_id = mine.conversation_id
              order by m.created_at limit 1), 'Sent you a message'),
    coalesce(mine.requested_at, c.created_at),
    p.created_at > now() - interval '7 days',
    (select count(*) from public.conversations x
     where x.created_by = p.id and x.created_at > now() - interval '24 hours') > 10
  from public.conversation_members mine
  join public.conversations c on c.id = mine.conversation_id
  join public.conversation_members o on o.conversation_id = mine.conversation_id and o.user_id <> mine.user_id
  join public.profiles p on p.id = o.user_id
  where mine.user_id = auth.uid()
    and mine.status in ('request', 'filtered')
    and mine.requested_at is not null
    and not public.blocked_with(p.id)
  order by coalesce(mine.requested_at, c.created_at) desc;
$$;
revoke execute on function public.list_message_requests() from public, anon;
grant execute on function public.list_message_requests() to authenticated;

create or replace function public.accept_message_request(cid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not public.is_conversation_member(cid) then
    raise exception 'Request not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  update public.conversation_members set status = 'active'
  where conversation_id = cid and user_id = auth.uid() and status <> 'active';
end $$;
revoke execute on function public.accept_message_request(uuid) from public, anon;
grant execute on function public.accept_message_request(uuid) to authenticated;

-- Deletes the whole conversation; the sender gets no notification.
create or replace function public.decline_message_request(cid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from public.conversation_members
                 where conversation_id = cid and user_id = auth.uid() and status in ('request', 'filtered')) then
    raise exception 'Request not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  delete from public.conversations where id = cid;
end $$;
revoke execute on function public.decline_message_request(uuid) from public, anon;
grant execute on function public.decline_message_request(uuid) to authenticated;

-- folder: 'requests' | 'filtered'. Returns how many were declined.
create or replace function public.decline_all_message_requests(folder text) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if folder is null or folder not in ('requests', 'filtered') then
    raise exception 'Unknown folder' using errcode = '22023';
  end if;
  delete from public.conversations c
  where c.id in (
    select m.conversation_id from public.conversation_members m
    where m.user_id = auth.uid()
      and m.status = case when folder = 'filtered' then 'filtered' else 'request' end
      and m.requested_at is not null);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.decline_all_message_requests(text) from public, anon;
grant execute on function public.decline_all_message_requests(text) to authenticated;

-- Pending requests in the Requests folder (not Filtered), for badges.
create or replace function public.message_request_count() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int
  from public.conversation_members mine
  join public.conversation_members o on o.conversation_id = mine.conversation_id and o.user_id <> mine.user_id
  where mine.user_id = auth.uid() and mine.status = 'request' and mine.requested_at is not null
    and not public.blocked_with(o.user_id);
$$;
revoke execute on function public.message_request_count() from public, anon;
grant execute on function public.message_request_count() to authenticated;

-- A block removes pending (request/filtered) conversations between the two people.
create or replace function public.on_block_drop_requests() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.conversations c
  where c.id in (
    select a.conversation_id
    from public.conversation_members a
    join public.conversation_members b on b.conversation_id = a.conversation_id
    where a.user_id = new.blocker_id and b.user_id = new.blocked_id)
    and exists (select 1 from public.conversation_members m
                where m.conversation_id = c.id and m.status in ('request', 'filtered'));
  return new;
end $$;
revoke execute on function public.on_block_drop_requests() from public, anon, authenticated;
drop trigger if exists on_block_drop_requests on public.blocks;
create trigger on_block_drop_requests after insert on public.blocks
  for each row execute function public.on_block_drop_requests();

-- ═════════════════════════════════════════════ message notifications (requests aware)
-- Latest version from chat_pro, plus:
--   * sending into a conversation where the sender is still 'request'/'filtered' accepts it (reply = accept)
--   * 'active' members: as before ('message', skipped when muted)
--   * 'request' members: ONE 'message_request' notification on the first message (requested_at)
--   * 'filtered' members: no notification (requested_at still set so the request becomes visible)
--   * 'swap' preview
create or replace function public.on_message_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m record;
  sender text := public.display_name_of(new.sender_id);
  preview text := public.message_preview(new.kind, new.body, new.track, new.meta);
begin
  update public.conversation_members set status = 'active'
  where conversation_id = new.conversation_id and user_id = new.sender_id and status <> 'active';

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

-- ═════════════════════════════════════════════ delivery + read receipts
-- Marks every conversation of the caller as delivered (only rows that actually changed, to keep
-- realtime quiet).
create or replace function public.mark_delivered() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  update public.conversation_members cm set last_delivered_at = now()
  from public.conversations c
  where c.id = cm.conversation_id and cm.user_id = auth.uid()
    and (cm.last_delivered_at is null or cm.last_delivered_at < c.last_message_at);
end $$;
revoke execute on function public.mark_delivered() from public, anon;
grant execute on function public.mark_delivered() to authenticated;

-- Receipts for a conversation's members (caller must be a member; otherwise no rows).
-- last_read_at is null for other members when: they haven't accepted the request yet, either side has
-- dm.read_receipts off, or either side turned read receipts off for this chat (member.read_receipts).
-- The caller's own row is returned unmasked.
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
    m.last_delivered_at
  from public.conversation_members m
  where m.conversation_id = cid and public.is_conversation_member(cid);
$$;
revoke execute on function public.conversation_receipts(uuid) from public, anon;
grant execute on function public.conversation_receipts(uuid) to authenticated;

-- ═════════════════════════════════════════════ shared checks for chat tools
-- Caller is a member of a 1:1, unblocked, accepted conversation; returns the other member.
create or replace function public.dm_tool_other(cid uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  other uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not public.is_conversation_member(cid) then
    raise exception 'Not a member of this conversation' using errcode = '42501';
  end if;
  if (select count(*) from public.conversation_members where conversation_id = cid) <> 2 then
    raise exception 'This works in 1:1 chats only' using errcode = '22023', hint = 'not_direct';
  end if;
  if public.conversation_blocked(cid) then
    raise exception 'You can''t message this person' using errcode = '42501', hint = 'blocked';
  end if;
  if public.conversation_request_state(cid) <> 'none' then
    raise exception 'Available once the chat request is accepted' using errcode = '42501', hint = 'request';
  end if;
  select m.user_id into other from public.conversation_members m
  where m.conversation_id = cid and m.user_id <> auth.uid();
  return other;
end $$;
revoke execute on function public.dm_tool_other(uuid) from public, anon, authenticated;

-- ═════════════════════════════════════════════ Blend
create or replace function public.create_blend(cid uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  other uuid;
  pid uuid;
  v_owner uuid;
  ttl text;
  cnt int;
  v_match int;
begin
  other := public.dm_tool_other(cid);
  perform 1 from public.conversations where id = cid for update;

  if not exists (select 1 from public.liked_tracks where user_id in (me, other)) then
    raise exception 'Like a few songs first to make a Blend' using errcode = '22023', hint = 'empty';
  end if;

  ttl := left(public.display_name_of(me), 45) || ' + ' || left(public.display_name_of(other), 45) || ' Blend';

  select c.blend_playlist_id into pid from public.conversations c where c.id = cid;
  if pid is not null and not exists (select 1 from public.playlists where id = pid) then pid := null; end if;

  if pid is null then
    insert into public.playlists (owner_id, title, description, visibility)
    values (me, ttl, 'A mix of songs you both love. Refreshes whenever either of you taps Blend.', 'private')
    returning id into pid;
    update public.conversations set blend_playlist_id = pid where id = cid;
  else
    update public.playlists set title = ttl, updated_at = now() where id = pid;
    delete from public.playlist_tracks where playlist_id = pid;
  end if;

  select p.owner_id into v_owner from public.playlists p where p.id = pid;
  insert into public.playlist_collaborators (playlist_id, user_id)
  select pid, u from (values (me), (other)) v(u) where u <> v_owner
  on conflict do nothing;

  -- Interleave: my 1st, their 1st, my 2nd, ... (most recent likes first), deduped, max 50.
  with picks as (
    (select l.track_id, l.track, row_number() over (order by l.created_at desc) as rn, 0 as side
     from public.liked_tracks l where l.user_id = me order by l.created_at desc limit 50)
    union all
    (select l.track_id, l.track, row_number() over (order by l.created_at desc) as rn, 1 as side
     from public.liked_tracks l where l.user_id = other order by l.created_at desc limit 50)
  ), dedup as (
    select distinct on (track_id) track_id, track, rn, side from picks order by track_id, rn, side
  ), chosen as (
    select * from dedup order by rn, side limit 50
  )
  insert into public.playlist_tracks (playlist_id, track_id, track, position, added_by)
  select pid, ch.track_id, ch.track, row_number() over (order by ch.rn, ch.side),
         case when ch.side = 0 then me else other end
  from chosen ch;
  get diagnostics cnt = row_count;

  v_match := public.taste_match(other);

  insert into public.messages (conversation_id, sender_id, body, kind, meta)
  values (cid, me, '', 'playlist',
    jsonb_build_object('playlist_id', pid, 'title', ttl, 'count', cnt, 'blend', true, 'match', v_match));

  return pid;
end $$;
revoke execute on function public.create_blend(uuid) from public, anon;
grant execute on function public.create_blend(uuid) to authenticated;

-- ═════════════════════════════════════════════ Song swap
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text', 'track', 'voice', 'poll', 'lyric', 'playlist', 'jam', 'live', 'photo', 'location', 'swap'));

-- One swap per sender per conversation per UTC day. Returns the message id.
create or replace function public.send_song_swap(cid uuid, track jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  mid uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  if not public.is_conversation_member(cid) then
    raise exception 'Not a member of this conversation' using errcode = '42501';
  end if;
  if public.conversation_blocked(cid) then
    raise exception 'You can''t message this person' using errcode = '42501', hint = 'blocked';
  end if;
  if send_song_swap.track is null or jsonb_typeof(send_song_swap.track) <> 'object'
     or coalesce(send_song_swap.track ->> 'id', '') = '' or coalesce(send_song_swap.track ->> 'title', '') = ''
     or pg_column_size(send_song_swap.track) > 8192 then
    raise exception 'Pick a song to swap' using errcode = '22023', hint = 'bad_track';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('swap:' || cid::text || ':' || me::text, 0));
  if exists (
    select 1 from public.messages m
    where m.conversation_id = cid and m.sender_id = me and m.kind = 'swap'
      and (m.created_at at time zone 'utc')::date = (now() at time zone 'utc')::date
  ) then
    raise exception 'You already swapped a song today. Come back tomorrow!' using errcode = 'P0001', hint = 'swap_limit';
  end if;

  insert into public.messages (conversation_id, sender_id, body, kind, track, meta)
  values (cid, me, '', 'swap', send_song_swap.track, jsonb_build_object('swap', true))
  returning id into mid;
  return mid;
end $$;
revoke execute on function public.send_song_swap(uuid, jsonb) from public, anon;
grant execute on function public.send_song_swap(uuid, jsonb) to authenticated;

create table if not exists public.song_swap_ratings (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  stars int not null check (stars between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
alter table public.song_swap_ratings enable row level security;

-- Caller may rate this swap: it's a swap in one of their (unblocked) conversations, not their own.
create or replace function public.swap_rateable(mid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.messages m
    where m.id = mid and m.kind = 'swap' and m.sender_id <> auth.uid()
      and public.is_conversation_member(m.conversation_id)
      and not public.conversation_blocked(m.conversation_id)
  );
$$;
revoke execute on function public.swap_rateable(uuid) from public, anon;
grant execute on function public.swap_rateable(uuid) to authenticated;

drop policy if exists "members read swap ratings" on public.song_swap_ratings;
create policy "members read swap ratings" on public.song_swap_ratings for select to authenticated
  using (public.message_member_conversation(message_id) is not null);
drop policy if exists "rate others swaps" on public.song_swap_ratings;
create policy "rate others swaps" on public.song_swap_ratings for insert to authenticated
  with check (user_id = auth.uid() and public.swap_rateable(message_id));
drop policy if exists "change own swap rating" on public.song_swap_ratings;
create policy "change own swap rating" on public.song_swap_ratings for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.swap_rateable(message_id));
drop policy if exists "remove own swap rating" on public.song_swap_ratings;
create policy "remove own swap rating" on public.song_swap_ratings for delete to authenticated
  using (user_id = auth.uid());

create or replace function public.rate_song_swap(mid uuid, stars int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if rate_song_swap.stars is null or rate_song_swap.stars not between 1 and 5 then
    raise exception 'Rating must be 1 to 5 stars' using errcode = '22023';
  end if;
  if not public.swap_rateable(mid) then
    raise exception 'You can''t rate this swap' using errcode = '42501', hint = 'not_rateable';
  end if;
  insert into public.song_swap_ratings as r (message_id, user_id, stars)
  values (mid, auth.uid(), rate_song_swap.stars)
  on conflict (message_id, user_id) do update set stars = excluded.stars;
end $$;
revoke execute on function public.rate_song_swap(uuid, int) from public, anon;
grant execute on function public.rate_song_swap(uuid, int) to authenticated;

-- ═════════════════════════════════════════════ Shared queue
-- One open 'group' room per 1:1 chat; both members are put in room_members. Returns the room id.
create or replace function public.open_shared_queue(cid uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  rid uuid;
begin
  perform public.dm_tool_other(cid);
  select c.queue_room_id into rid from public.conversations c where c.id = cid for update;
  if rid is null or not exists (select 1 from public.rooms r where r.id = rid and r.is_open) then
    insert into public.rooms (host_id, kind, name) values (auth.uid(), 'group', 'Shared queue')
    returning id into rid;
    update public.conversations set queue_room_id = rid where id = cid;
  end if;
  insert into public.room_members (room_id, user_id)
  select rid, m.user_id from public.conversation_members m where m.conversation_id = cid
  on conflict do nothing;
  return rid;
end $$;
revoke execute on function public.open_shared_queue(uuid) from public, anon;
grant execute on function public.open_shared_queue(uuid) to authenticated;

-- ═════════════════════════════════════════════ New message: contacts
-- Candidates: people I follow, who follow me, or I've chatted with; with q >= 2 chars also any profile
-- whose name / @username matches. q (leading '@' ignored) filters every candidate. Self and blocked
-- people excluded. Order: direct first, then mutual_count desc, then name. Max 50.
create or replace function public.message_contacts(q text)
returns table (
  id uuid, display_name text, username text, avatar_url text, access text,
  follows_me boolean, i_follow boolean, mutual_count int, conversation_id uuid)
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
  select r.id, r.display_name, r.username, r.avatar_url, r.access, r.follows_me, r.i_follow,
         r.mutual_count, r.conversation_id
  from ranked r
  where r.access <> 'blocked'
  order by (r.access = 'direct') desc, r.mutual_count desc, lower(r.display_name)
  limit 50;
$$;
revoke execute on function public.message_contacts(text) from public, anon;
grant execute on function public.message_contacts(text) to authenticated;

-- ═════════════════════════════════════════════ disappearing messages: who turned it on
alter table public.conversations
  add column if not exists disappear_by uuid references public.profiles (id) on delete set null;

-- Same signature/behaviour as chat_pro's version, plus disappear_by (null when turned off).
create or replace function public.set_disappearing(cid uuid, seconds int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not public.is_conversation_member(cid) then raise exception 'Not a member of this conversation' using errcode = '42501'; end if;
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

-- ═════════════════════════════════════════════ realtime
do $$
begin
  begin alter publication supabase_realtime add table public.song_swap_ratings; exception when duplicate_object then null; end;
end $$;
