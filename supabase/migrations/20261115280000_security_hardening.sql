-- Security hardening (audit follow-up). Runs after 20261115270000_e2ee_integration.sql and builds on its
-- versions of shared functions (register_push_token).
--
--   H2  realtime.messages policies for private channels (client helper: src/lib/realtime.ts):
--         chatpro:<cid>       member of the conversation, not blocked (1:1)
--         group:<cid>         member of the group conversation
--         call-listen:<id>    caller / callee (is_call_participant)
--         room:<id>           room member or host (is_room_member)
--         presence:<uid>      read: uid = me, or uid ∈ presence_allowed() with both Online status switches on;
--                             write (track / broadcast): only uid = me
--       calls-incoming:<uid>:* / call:<id>:* are postgres_changes-only channels (table RLS applies) → no policy.
--   H4  rooms: no more "join as self" (joins only via join_room / join_live / join_room_by_id, all definer;
--       the host may still add their own row); rooms readable by members or when open party / live;
--       update needs membership in USING and WITH CHECK; rooms_member_guard: host_id / code never change
--       from the client, non-hosts may only bump skip_votes by one.
--   M1  messages: client inserts get created_at = now(), edited_at = null, and can't use kind swap / call;
--       mark_conversation_read ignores future created_at.
--   M2  song_swap_ratings leaves the realtime publication (no client subscribes to it). message_reactions,
--       poll_votes, conversation_members, conversations, messages stay (clients still subscribe; see report).
--   M3  chat-media reads, message_pins / message_reactions / poll_votes reads respect group history since joining
--       (and disappearing-message expiry).
--   M5  e2ee_setup(p_reset => true) / revoke_device need a sign-in within the last 10 minutes (JWT amr
--       timestamp, which token refreshes don't bump); resets have a 24 h cooldown and notify the user.
--   L1  taste_match: only between people with a follow (either way) or a shared chat; rounded to 5.
--   L2  conversation_members.muted / muted_until no longer readable by other members (own: my_memberships()).
--   L3  set_group_avatar: only this project's public avatars URL in the caller's own folder.
--   L4  avatars / covers: 5 MB, jpeg/png/webp/heic, no anonymous object listing.
--   L5  chat-media accepts application/octet-stream (encrypted media), still 10 MB.
--   L7  a new block ends ringing / accepted calls between the two people.
--   L8  register_push_token / register_voip_token don't take over another user's fresh token (≤ 30 days old).
--   L11 execute revoked from anon on definer helpers that need a signed-in user; trigger functions from all.
--   L13 rate limits: 30 messages / minute per sender, 50 pending scheduled messages per user.

-- ═════════════════════════════════════════════ helpers
create or replace function public.try_uuid(v text) returns uuid
language sql immutable set search_path = public as $$
  select case when v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v::uuid end;
$$;

-- True when the caller may see message `mid` (member, after joining for groups, not expired).
create or replace function public.message_visible(mid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.messages m
    where m.id = mid
      and public.is_conversation_member(m.conversation_id)
      and public.message_visible_since_join(m.conversation_id, m.created_at)
      and not public.message_expired(m.conversation_id, m.created_at)
  );
$$;
revoke execute on function public.message_visible(uuid) from public, anon;
grant execute on function public.message_visible(uuid) to authenticated;

-- ═════════════════════════════════════════════ H2 realtime private channels
-- May the caller watch `owner`'s presence topic? Both Online status switches on, owner in presence_allowed().
create or replace function public.presence_can_watch(owner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and owner is not null and (
    owner = auth.uid() or (
      coalesce(public.dm_setting(owner, 'online_status'), 'true') = 'true'
      and coalesce(public.dm_setting(auth.uid(), 'online_status'), 'true') = 'true'
      and exists (select 1 from public.presence_allowed() a where a = owner)
    )
  );
$$;
revoke execute on function public.presence_can_watch(uuid) from public, anon;
grant execute on function public.presence_can_watch(uuid) to authenticated;

-- Topic check used by the realtime.messages policies (p_write = send broadcast / track presence).
create or replace function public.realtime_topic_allowed(p_topic text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  k text := split_part(coalesce(p_topic, ''), ':', 1);
  id uuid := public.try_uuid(split_part(coalesce(p_topic, ''), ':', 2));
begin
  if me is null or id is null or split_part(p_topic, ':', 3) <> '' then return false; end if;
  case k
    when 'chatpro' then
      return public.is_conversation_member(id) and not public.conversation_blocked(id);
    when 'group' then
      return public.is_group(id) and public.is_conversation_member(id);
    when 'call-listen' then
      return public.is_call_participant(id);
    when 'room' then
      return public.is_room_member(id);
    when 'presence' then
      if id = me then return true; end if;
      return not coalesce(p_write, true) and public.presence_can_watch(id);
    else
      return false;
  end case;
end $$;
revoke execute on function public.realtime_topic_allowed(text, boolean) from public, anon;
grant execute on function public.realtime_topic_allowed(text, boolean) to authenticated;

do $$
begin
  if to_regclass('realtime.messages') is null then
    raise notice 'realtime.messages missing: private channel policies skipped';
    return;
  end if;
  execute 'drop policy if exists "zoyra private topics read" on realtime.messages';
  execute 'drop policy if exists "zoyra private topics write" on realtime.messages';
  execute $p$create policy "zoyra private topics read" on realtime.messages for select to authenticated
    using (extension in ('broadcast', 'presence') and public.realtime_topic_allowed(realtime.topic(), false))$p$;
  execute $p$create policy "zoyra private topics write" on realtime.messages for insert to authenticated
    with check (extension in ('broadcast', 'presence') and public.realtime_topic_allowed(realtime.topic(), true))$p$;
end $$;

-- ═════════════════════════════════════════════ H4 rooms
drop policy if exists "join as self" on public.room_members;
-- The host adds their own row right after creating a room (src/app/group-listening.tsx, src/lib/chat.ts).
drop policy if exists "host joins own room" on public.room_members;
create policy "host joins own room" on public.room_members for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.rooms r where r.id = room_id and r.host_id = auth.uid()));

drop policy if exists "rooms readable" on public.rooms;
create policy "rooms readable" on public.rooms for select to authenticated
  using (host_id = auth.uid() or public.is_room_member(id) or (is_open and kind in ('party', 'live')));

drop policy if exists "host or member updates room" on public.rooms;
create policy "host or member updates room" on public.rooms for update to authenticated
  using (public.is_room_member(id)) with check (public.is_room_member(id));

create or replace function public.rooms_member_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;
  if new.host_id is distinct from old.host_id or new.code is distinct from old.code or new.id is distinct from old.id
     or new.created_at is distinct from old.created_at then
    raise exception 'Room host and code can''t change' using errcode = '42501', hint = 'room_locked';
  end if;
  if auth.uid() is distinct from old.host_id then
    -- Guests only vote to skip (one vote per update); playback, name and open state are the host's.
    if new.kind is distinct from old.kind or new.name is distinct from old.name or new.track is distinct from old.track
       or new.position_ms is distinct from old.position_ms or new.is_playing is distinct from old.is_playing
       or new.is_open is distinct from old.is_open
       or new.skip_votes not between old.skip_votes and old.skip_votes + 1 then
      raise exception 'Only the host controls this room' using errcode = '42501', hint = 'not_host';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.rooms_member_guard() from public, anon, authenticated;
drop trigger if exists rooms_member_guard on public.rooms;
create trigger rooms_member_guard before update on public.rooms
  for each row execute function public.rooms_member_guard();

-- Open a room link (`/group-listening?id=`) as a non-member. Allowed for open party rooms, a group chat's jam
-- (member of that group), or a room whose host shares a chat with the caller / that was posted as a jam
-- card in one of the caller's chats. Live rooms join through join_live(). Errors look like join_room's.
create or replace function public.join_room_by_id(rid uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r public.rooms%rowtype;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into r from public.rooms where id = rid;
  if not found or not r.is_open or r.kind = 'live' then raise exception 'room not found' using errcode = 'P0002'; end if;
  if r.host_id = me then return r.id; end if;
  if public.blocked_with(r.host_id) then raise exception 'room not found' using errcode = 'P0002'; end if;
  if not (
    r.kind = 'party'
    or exists (select 1 from public.conversations c
               join public.conversation_members m on m.conversation_id = c.id and m.user_id = me
               where c.jam_room_id = rid)
    or exists (select 1 from public.conversation_members a
               join public.conversation_members b on b.conversation_id = a.conversation_id and b.user_id = r.host_id
               where a.user_id = me and a.status = 'active')
    or exists (select 1 from public.conversation_members m
               join public.messages x on x.conversation_id = m.conversation_id
               where m.user_id = me and x.kind = 'jam' and x.meta ->> 'room_id' = rid::text
                 and x.created_at >= m.joined_at)
  ) then
    raise exception 'room not found' using errcode = 'P0002';
  end if;
  insert into public.room_members (room_id, user_id) values (rid, me) on conflict do nothing;
  return rid;
end $$;
revoke execute on function public.join_room_by_id(uuid) from public, anon;
grant execute on function public.join_room_by_id(uuid) to authenticated;

-- ═════════════════════════════════════════════ M1 messages
create or replace function public.message_insert_hardening() returns trigger
language plpgsql set search_path = public as $$
begin
  -- Direct client inserts (security definer RPCs run as the function owner and keep their values).
  if current_user in ('anon', 'authenticated') then
    new.created_at := now();
    new.edited_at := null;
    if new.kind in ('swap', 'call') then
      raise exception 'This message type is added by the server' using errcode = '42501', hint = 'system_kind';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.message_insert_hardening() from public, anon, authenticated;
-- "a_" so it runs before the other BEFORE INSERT triggers (alphabetical).
drop trigger if exists a_message_insert_hardening on public.messages;
create trigger a_message_insert_hardening before insert on public.messages
  for each row execute function public.message_insert_hardening();

-- Same as 20261115260000, but a message stamped in the future (older rows written before the trigger above)
-- can't push last_read_at / last_delivered_at past now().
create or replace function public.mark_conversation_read(cid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  newest timestamptz;
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if not exists (select 1 from public.conversation_members where conversation_id = cid and user_id = me) then
    raise exception 'Not a member of this conversation' using errcode = '42501';
  end if;
  select max(created_at) into newest from public.messages where conversation_id = cid;
  newest := least(coalesce(newest, now()), now());
  update public.conversation_members
     set last_read_at = greatest(now(), newest, least(last_read_at, now())),
         last_delivered_at = greatest(now(), newest, least(coalesce(last_delivered_at, now()), now()))
   where conversation_id = cid and user_id = me;
  update public.notifications
     set read = true
   where user_id = me and read = false
     and kind in ('message', 'message_request', 'group_added')
     and payload ->> 'conversation_id' = cid::text;
end $$;
revoke execute on function public.mark_conversation_read(uuid) from public, anon;
grant execute on function public.mark_conversation_read(uuid) to authenticated;

-- ═════════════════════════════════════════════ M2 realtime publication
do $$
begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
             and schemaname = 'public' and tablename = 'song_swap_ratings') then
    alter publication supabase_realtime drop table public.song_swap_ratings;
  end if;
end $$;

-- ═════════════════════════════════════════════ M3 history since joining: media, pins, reactions, votes
create or replace function public.chat_media_visible(object_name text, created timestamptz) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  cid uuid := public.try_uuid((storage.foldername(object_name))[1]);
begin
  if cid is null then return false; end if;
  return public.is_conversation_member(cid) and public.message_visible_since_join(cid, coalesce(created, now()));
end $$;
revoke execute on function public.chat_media_visible(text, timestamptz) from public, anon;
grant execute on function public.chat_media_visible(text, timestamptz) to authenticated;

drop policy if exists "chat media read" on storage.objects;
create policy "chat media read" on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and public.chat_media_visible(name, created_at));

drop policy if exists "visible messages only" on public.message_reactions;
create policy "visible messages only" on public.message_reactions as restrictive for select to authenticated
  using (public.message_visible(message_id));
drop policy if exists "visible messages only" on public.message_pins;
create policy "visible messages only" on public.message_pins as restrictive for select to authenticated
  using (public.message_visible(message_id));
drop policy if exists "visible messages only" on public.poll_votes;
create policy "visible messages only" on public.poll_votes as restrictive for select to authenticated
  using (public.message_visible(message_id));

-- ═════════════════════════════════════════════ M5 E2EE reset / revoke need a recent sign-in
alter table public.e2ee_accounts add column if not exists reset_at timestamptz;

-- Latest authentication (password / OTP / OAuth / MFA …) of this session within `max_age`. Uses the JWT `amr`
-- timestamps: a token refresh keeps them, so a stolen refresh token can't satisfy this.
create or replace function public.auth_is_recent(max_age interval default interval '10 minutes') returns boolean
language sql stable set search_path = public as $$
  select coalesce((
    select max((a ->> 'timestamp')::numeric)
    from jsonb_array_elements(case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]'::jsonb end) a
    where jsonb_typeof(a -> 'timestamp') = 'number'
  ), 0) >= extract(epoch from now() - max_age);
$$;
revoke execute on function public.auth_is_recent(interval) from public, anon;
grant execute on function public.auth_is_recent(interval) to authenticated;

-- Same as 20261115250000, plus for p_reset: recent sign-in (hint 'e2ee_reauth'), one reset per 24 h
-- (hint 'e2ee_reset_cooldown'), and a notification to the account ("keys were reset on a new device").
create or replace function public.e2ee_setup(
  p_account_sign_pub text, p_device_id uuid, p_enc_pub text, p_sign_pub text, p_account_sig text,
  p_backup_ciphertext text, p_backup_nonce text, p_kdf_params jsonb, p_salt text, p_verifier text,
  p_reset boolean default false, p_label text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  last_reset timestamptz;
  did_reset boolean := false;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  perform public.e2ee_check_backup_args(p_kdf_params);
  perform pg_advisory_xact_lock(hashtextextended('e2ee:' || me::text, 0));
  if exists (select 1 from public.e2ee_accounts where user_id = me) then
    if not coalesce(p_reset, false) then
      raise exception 'Encryption is already set up for this account' using errcode = '23505', hint = 'e2ee_exists';
    end if;
    if not public.auth_is_recent(interval '10 minutes') then
      raise exception 'Sign in again to reset your encryption keys' using errcode = '42501', hint = 'e2ee_reauth';
    end if;
    select reset_at into last_reset from public.e2ee_accounts where user_id = me;
    if last_reset is not null and last_reset > now() - interval '24 hours' then
      raise exception 'Encryption keys were reset recently. Try again in 24 hours.' using errcode = '42501', hint = 'e2ee_reset_cooldown';
    end if;
    update public.e2ee_devices set revoked_at = now() where user_id = me and revoked_at is null;
    update public.e2ee_accounts set account_sign_pub = p_account_sign_pub, updated_at = now(), reset_at = now() where user_id = me;
    delete from public.e2ee_key_backups where user_id = me;
    did_reset := true;
  else
    insert into public.e2ee_accounts (user_id, account_sign_pub) values (me, p_account_sign_pub);
  end if;
  perform public.e2ee_insert_device(me, p_device_id, p_enc_pub, p_sign_pub, p_account_sig, p_label);
  insert into public.e2ee_key_backups (user_id, ciphertext, nonce, kdf, kdf_params, salt, verifier)
  values (me, p_backup_ciphertext, p_backup_nonce, 'scrypt', p_kdf_params, p_salt, p_verifier);
  if did_reset then
    perform public.notify_user(me, 'e2ee_reset', 'Your encryption keys were reset',
      'Your encryption keys were reset on a new device'
        || coalesce(' (' || nullif(btrim(coalesce(p_label, '')), '') || ')', '')
        || '. If this wasn''t you, change your password now.',
      jsonb_build_object('device_id', p_device_id, 'label', p_label, 'url', '/settings'), null);
  end if;
end $$;
revoke execute on function public.e2ee_setup(text, uuid, text, text, text, text, text, jsonb, text, text, boolean, text) from public, anon;
grant execute on function public.e2ee_setup(text, uuid, text, text, text, text, text, jsonb, text, text, boolean, text) to authenticated;

-- Same as 20261115250000, but revoking needs a recent sign-in (hint 'e2ee_reauth') unless the caller registered
-- another device in the last 10 minutes (key rotation: register the new device, then revoke the old one).
create or replace function public.revoke_device(p_device_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not public.auth_is_recent(interval '10 minutes') and not exists (
    select 1 from public.e2ee_devices d
    where d.user_id = me and d.device_id <> p_device_id and d.revoked_at is null
      and d.created_at > now() - interval '10 minutes'
  ) then
    raise exception 'Sign in again to remove a device' using errcode = '42501', hint = 'e2ee_reauth';
  end if;
  update public.e2ee_devices set revoked_at = coalesce(revoked_at, now())
  where device_id = p_device_id and user_id = me;
  if not found then raise exception 'Device not found' using errcode = 'P0002'; end if;
end $$;
revoke execute on function public.revoke_device(uuid) from public, anon;
grant execute on function public.revoke_device(uuid) to authenticated;

-- ═════════════════════════════════════════════ L1 taste_match
-- Same score as 20261115120000, but only between people who follow each other in either direction or share a
-- chat (requests included), and rounded to the nearest 5 (less precise as a probing oracle).
create or replace function public.taste_match(other uuid) returns int
language sql stable security definer set search_path = public as $$
  with rel as (
    select auth.uid() is not null and other is not null and other <> auth.uid() and (
      exists (select 1 from public.follows f
              where (f.follower_id = auth.uid() and f.following_id = other)
                 or (f.follower_id = other and f.following_id = auth.uid()))
      or exists (select 1 from public.conversation_members a
                 join public.conversation_members b on b.conversation_id = a.conversation_id and b.user_id = other
                 where a.user_id = auth.uid())
    ) as ok
  ),
  a(name) as (select n from public.taste_artists(auth.uid()) n where (select ok from rel)),
  b(name) as (select n from public.taste_artists(other) n where (select ok from rel)),
  s as (select (select count(*) from a) as na,
               (select count(*) from b) as nb,
               (select count(*) from a join b using (name)) as ni)
  select case
    when not (select ok from rel) or s.na = 0 or s.nb = 0 or public.blocked_with(other) then null
    else (least(100, round(round(100 * sqrt(s.ni::numeric / (s.na + s.nb - s.ni))) / 5) * 5))::int end
  from s;
$$;
revoke execute on function public.taste_match(uuid) from public, anon;
grant execute on function public.taste_match(uuid) to authenticated;

-- ═════════════════════════════════════════════ L2 mute state is private
-- Own values come from my_memberships() / inbox() (security definer); UPDATE grants stay for own rows.
revoke select (muted, muted_until) on public.conversation_members from authenticated, anon;

-- ═════════════════════════════════════════════ L3 group photo URL
-- Same as 20261115230000, but the URL must be this project's public avatars bucket, in the caller's own folder
-- (src/lib/avatar.ts uploads to avatars/<uid>/…). Override the origin with
-- `alter database postgres set app.storage_origin = 'https://<custom domain>'` if the project moves.
create or replace function public.set_group_avatar(cid uuid, url text) returns void
language plpgsql security definer set search_path = public as $$
declare
  r text := public.group_require(cid);
  u text := nullif(btrim(coalesce(url, '')), '');
  origin text := coalesce(nullif(current_setting('app.storage_origin', true), ''), 'https://vmdkgkgyzflvqsvecava.supabase.co');
  prefix text;
begin
  if r not in ('owner', 'admin') then
    raise exception 'Only group admins can change the photo' using errcode = '42501', hint = 'not_admin';
  end if;
  prefix := rtrim(origin, '/') || '/storage/v1/object/public/avatars/' || auth.uid()::text || '/';
  if u is not null and (
       char_length(u) > 1024
       or left(u, char_length(prefix)) <> prefix
       or substr(u, char_length(prefix) + 1) !~ '^[A-Za-z0-9._-]+(\?[A-Za-z0-9=&._-]*)?$'
     ) then
    raise exception 'That photo link isn''t valid' using errcode = '22023', hint = 'bad_url';
  end if;
  update public.conversations set avatar_url = u where id = cid;
end $$;
revoke execute on function public.set_group_avatar(uuid, text) from public, anon;
grant execute on function public.set_group_avatar(uuid, text) to authenticated;

-- ═════════════════════════════════════════════ L4 / L5 storage buckets
update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
 where id in ('avatars', 'covers');

update storage.buckets
   set file_size_limit = 10485760,
       allowed_mime_types = array['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/webm',
                                  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/octet-stream']
 where id = 'chat-media';

-- Public buckets serve files at /object/public/… without a SELECT policy; the old policy let anyone list every
-- object. Owners keep read access to their own folder (needed for upsert uploads).
drop policy if exists "public read images" on storage.objects;
drop policy if exists "read own images" on storage.objects;
create policy "read own images" on storage.objects for select to authenticated
  using (bucket_id in ('avatars', 'covers') and (storage.foldername(name))[1] = auth.uid()::text);

-- ═════════════════════════════════════════════ L7 a block ends calls between the pair
create or replace function public.on_block_end_calls() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  c record;
begin
  for c in
    select x.id, x.status from public.calls x
    where x.status in ('ringing', 'accepted')
      and ((x.caller_id = new.blocker_id and x.callee_id = new.blocked_id)
        or (x.caller_id = new.blocked_id and x.callee_id = new.blocker_id))
    for update
  loop
    perform public.call_finish(c.id, case when c.status = 'accepted' then 'ended' else 'cancelled' end, false);
  end loop;
  return new;
end $$;
revoke execute on function public.on_block_end_calls() from public, anon, authenticated;
drop trigger if exists on_block_end_calls on public.blocks;
create trigger on_block_end_calls after insert on public.blocks
  for each row execute function public.on_block_end_calls();

-- ═════════════════════════════════════════════ L8 push / VoIP token ownership
-- Same as 20261115270000's register_push_token, but a token owned by another user moves only when that row is
-- stale (not refreshed for 30 days); otherwise the call is a silent no-op.
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
    set user_id = excluded.user_id, platform = excluded.platform, device_id = excluded.device_id, updated_at = now()
    where public.push_tokens.user_id = excluded.user_id
       or public.push_tokens.updated_at < now() - interval '30 days';
end $$;
revoke execute on function public.register_push_token(text, text, uuid) from public, anon;
grant execute on function public.register_push_token(text, text, uuid) to authenticated;

-- Same as 20261115220000, with the same ownership rule (also for the "one row per device" cleanup).
create or replace function public.register_voip_token(p_token text, p_platform text default 'ios', p_push_token text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  if p_platform is null or p_platform not in ('ios', 'android') then
    raise exception 'Unknown platform' using errcode = '22023', hint = 'bad_platform';
  end if;
  if p_token is null or char_length(p_token) not between 8 and 512 then
    raise exception 'Invalid token' using errcode = '22023', hint = 'bad_token';
  end if;
  -- One row per device: a new VoIP token for the same Expo push token replaces the old one (mine or stale).
  if p_push_token is not null then
    delete from public.voip_tokens
    where push_token = p_push_token and token <> p_token
      and (user_id = me or updated_at < now() - interval '30 days');
  end if;
  insert into public.voip_tokens (token, user_id, platform, push_token, updated_at)
  values (p_token, me, p_platform, nullif(left(coalesce(p_push_token, ''), 512), ''), now())
  on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform,
        push_token = coalesce(excluded.push_token, public.voip_tokens.push_token), updated_at = now()
    where public.voip_tokens.user_id = excluded.user_id
       or public.voip_tokens.updated_at < now() - interval '30 days';
end $$;
revoke execute on function public.register_voip_token(text, text, text) from public, anon;
grant execute on function public.register_voip_token(text, text, text) to authenticated;

-- ═════════════════════════════════════════════ L11 execute privileges
-- Signed-in helpers / RPCs (no anon client calls them; guests never reach these screens).
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.is_conversation_member(uuid)', 'public.can_edit_playlist(uuid)', 'public.can_view_playlist(uuid)',
    'public.is_room_member(uuid)', 'public.join_room(text)', 'public.listening_streak(uuid)',
    'public.listening_insights(integer)', 'public.weekly_leaderboard()', 'public.display_name_of(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- Trigger functions are never called directly.
  foreach f in array array[
    'public.handle_new_user()', 'public.touch_conversation()', 'public.on_dedication_notify()',
    'public.on_follow_notify()', 'public.on_collaborator_notify()', 'public.on_family_owner_plan_change()',
    'public.keep_family_member_plan()', 'public.on_family_group_delete()', 'public.live_sessions_guard()',
    'public.live_sessions_close_room()', 'public.live_session_tracks_guard()', 'public.on_live_started_notify()',
    'public.rooms_live_guard()', 'public.live_room_message_guard()', 'public.live_room_queue_guard()',
    'public.video_comments_guard()', 'public.on_room_join_notify()', 'public.game_scores_guard()',
    'public.community_posts_guard()', 'public.community_likes_count()', 'public.community_comments_guard()',
    'public.community_comments_count()', 'public.message_reply_guard()'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', f);
    end if;
  end loop;
end $$;

-- ═════════════════════════════════════════════ L13 rate limits
create index if not exists messages_sender_created_idx on public.messages (sender_id, created_at desc);

create or replace function public.message_rate_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- User-originated sends (direct inserts and RPCs such as send_e2ee_message); server jobs have no auth.uid().
  if auth.uid() is null or new.sender_id is distinct from auth.uid() or new.kind = 'call' then return new; end if;
  if (select count(*) from (
        select 1 from public.messages m
        where m.sender_id = new.sender_id and m.created_at > now() - interval '1 minute'
        limit 30) x) >= 30 then
    raise exception 'You''re sending messages too fast. Wait a moment.' using errcode = '54000', hint = 'rate_limited';
  end if;
  return new;
end $$;
revoke execute on function public.message_rate_limit() from public, anon, authenticated;
drop trigger if exists message_rate_limit on public.messages;
create trigger message_rate_limit before insert on public.messages
  for each row execute function public.message_rate_limit();

create or replace function public.scheduled_message_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from (
        select 1 from public.scheduled_messages s
        where s.sender_id = new.sender_id and s.sent_at is null and s.failed is null
        limit 50) x) >= 50 then
    raise exception 'You can schedule up to 50 messages' using errcode = '54000', hint = 'rate_limited';
  end if;
  return new;
end $$;
revoke execute on function public.scheduled_message_limit() from public, anon, authenticated;
drop trigger if exists scheduled_message_limit on public.scheduled_messages;
create trigger scheduled_message_limit before insert on public.scheduled_messages
  for each row execute function public.scheduled_message_limit();
