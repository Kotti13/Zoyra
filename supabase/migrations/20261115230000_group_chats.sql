-- Group chats (GroupChat design: /group-chat, /group-info, /new-group). Client contract: src/lib/groups.ts —
-- keep RPC names, argument names and shapes in sync.
--
--   conversations          + kind ('direct' | 'group'), title, avatar_url, jam_room_id (the group's jam)
--   conversation_members   + role ('owner' | 'admin' | 'member'), joined_at
--                          exactly one owner per group (partial unique index). 1:1 rows stay 'member'.
--
--   create_group(title, member_ids)          → conversation id. Caller = owner. Every invitee must pass
--                                              group_invite_refusal(); otherwise nothing is created and the
--                                              error lists who couldn't be added (hint 'invite_refused').
--   add_group_members(cid, member_ids)       → int (rows added). Owner / admins. Same checks, all or nothing.
--   remove_group_member(cid, uid)            owner removes anyone; admins remove members; uid = me → leave.
--   leave_group(cid)                         owner leaving → oldest admin, else oldest member, becomes owner;
--                                            the last member leaving deletes the group.
--   rename_group(cid, title)                 owner / admins. 1–64 chars.
--   set_group_avatar(cid, url)               owner / admins. https URL (public avatars bucket) or null.
--   set_group_role(cid, uid, role)           'admin' / 'member': owner, or an admin promoting a member;
--                                            only the owner demotes admins. 'owner': owner transfers ownership
--                                            (old owner becomes admin).
--   group_members(cid)                       members with profile + role, owner first.
--   group_invite_check(ids)                  (user_id, ok, reason) for the new-group / add-members pickers.
--   group_jam(cid) / start_group_jam(cid)    the group's live listening room (rooms + room_members).
--
-- Group invite rules (group_invite_refusal, inviter → invitee):
--   unknown user → 'not_found' · block either way → 'blocked' · invitee dm.group_invites = 'none' →
--   'not_accepting' · 'mutuals' (default) → inviter and invitee must follow each other or already have an
--   accepted 1:1 chat → 'mutuals_only' · 'everyone' → ok.
--
-- History: a member only sees group messages sent after they joined (restrictive policy on messages +
-- inbox()). Existing 1:1 member rows get joined_at = conversation created_at, so nothing changes for them.
--
-- DM-only logic made group-safe (1:1 detection used to be "2 members", which a 2-person group also has):
--   dm_conversation_with / dm_partner / dm_tool_other   → kind = 'direct' only (start_conversation, Blend,
--                                                          Song swap's tools, shared queue, calls stay 1:1)
--   conversation_blocked                                 → false for groups: a block between two members
--                                                          doesn't lock the whole group (blocked people
--                                                          can't be invited by the blocker, though)
--   inbox()                                              → + kind, title, avatar_url, last_sender_name, last_meta;
--                                                          groups listed even before the first message
--   on_message_notify()                                  → group messages: title = group title,
--                                                          body "Sender: preview", url /group-chat?id=
-- Not changed (still count-based, 1:1 semantics): restrict_user, list_message_requests,
-- message_request_count (a 2-person group with someone I restrict could show as a restricted chat).

-- ═════════════════════════════════════════════ columns
alter table public.conversations
  add column if not exists kind text not null default 'direct',
  add column if not exists title text,
  add column if not exists avatar_url text,
  add column if not exists jam_room_id uuid references public.rooms (id) on delete set null;
alter table public.conversations drop constraint if exists conversations_kind_check;
alter table public.conversations add constraint conversations_kind_check check (kind in ('direct', 'group'));
alter table public.conversations drop constraint if exists conversations_title_len;
alter table public.conversations add constraint conversations_title_len check (title is null or char_length(title) between 1 and 64);
alter table public.conversations drop constraint if exists conversations_avatar_len;
alter table public.conversations add constraint conversations_avatar_len check (avatar_url is null or char_length(avatar_url) <= 1024);
create index if not exists conversations_kind_created_by_idx on public.conversations (created_by, created_at desc) where kind = 'group';

alter table public.conversation_members
  add column if not exists role text not null default 'member',
  add column if not exists joined_at timestamptz;
alter table public.conversation_members drop constraint if exists conversation_members_role_check;
alter table public.conversation_members add constraint conversation_members_role_check check (role in ('owner', 'admin', 'member'));
update public.conversation_members m set joined_at = c.created_at
from public.conversations c where c.id = m.conversation_id and m.joined_at is null;
alter table public.conversation_members alter column joined_at set default now();
alter table public.conversation_members alter column joined_at set not null;
create unique index if not exists conversation_members_one_owner on public.conversation_members (conversation_id) where role = 'owner';

-- Members may read each other's role / join date (same as status / muted); still no client writes.
grant select (role, joined_at) on public.conversation_members to authenticated;

-- ═════════════════════════════════════════════ internal helpers
create or replace function public.is_group(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversations c where c.id = cid and c.kind = 'group');
$$;
revoke execute on function public.is_group(uuid) from public, anon;
grant execute on function public.is_group(uuid) to authenticated;

-- The caller's role in a group (null when not a member / not a group).
create or replace function public.group_role(cid uuid) returns text
language sql stable security definer set search_path = public as $$
  select m.role from public.conversation_members m
  join public.conversations c on c.id = m.conversation_id and c.kind = 'group'
  where m.conversation_id = cid and m.user_id = auth.uid();
$$;
revoke execute on function public.group_role(uuid) from public, anon;
grant execute on function public.group_role(uuid) to authenticated;

-- Why `inviter` can't add `invitee` to a group (null = allowed). Internal: takes an arbitrary inviter.
create or replace function public.group_invite_refusal(inviter uuid, invitee uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  setting text;
begin
  if invitee is null or not exists (select 1 from public.profiles where id = invitee) then return 'not_found'; end if;
  if exists (select 1 from public.blocks b
             where (b.blocker_id = inviter and b.blocked_id = invitee)
                or (b.blocker_id = invitee and b.blocked_id = inviter)) then
    return 'blocked';
  end if;
  setting := public.dm_setting(invitee, 'group_invites');
  if setting = 'none' then return 'not_accepting'; end if;
  if setting = 'mutuals' and not (
       (exists (select 1 from public.follows where follower_id = inviter and following_id = invitee)
        and exists (select 1 from public.follows where follower_id = invitee and following_id = inviter))
    or exists (select 1 from public.conversation_members a
               join public.conversation_members b on b.conversation_id = a.conversation_id and b.user_id = invitee
               join public.conversations c on c.id = a.conversation_id and c.kind = 'direct'
               where a.user_id = inviter and a.status = 'active' and b.status = 'active')
  ) then
    return 'mutuals_only';
  end if;
  return null;
end $$;
revoke execute on function public.group_invite_refusal(uuid, uuid) from public, anon, authenticated;

-- Raises one friendly error naming everyone in `ids` the caller can't invite (no-op when all are fine).
create or replace function public.group_assert_invitable(ids uuid[]) returns void
language plpgsql stable security definer set search_path = public as $$
declare
  bad jsonb;
  names text;
  n int;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', coalesce(p.display_name, 'Someone'), 'reason', x.reason)), '[]'::jsonb),
         string_agg(coalesce(p.display_name, 'Someone'), ', ' order by p.display_name),
         count(*)
    into bad, names, n
  from (select i as id, public.group_invite_refusal(auth.uid(), i) as reason from unnest(ids) i) x
  left join public.profiles p on p.id = x.id
  where x.reason is not null;
  if n > 0 then
    raise exception 'Couldn''t add %: their privacy settings don''t allow it.', names
      using errcode = '42501', hint = 'invite_refused', detail = bad::text;
  end if;
end $$;
revoke execute on function public.group_assert_invitable(uuid[]) from public, anon, authenticated;

-- Caller must be a member of group `cid`; returns their role.
create or replace function public.group_require(cid uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  r text;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not exists (select 1 from public.conversations where id = cid and kind = 'group') then
    raise exception 'This group is no longer available.' using errcode = 'P0002', hint = 'not_found';
  end if;
  r := public.group_role(cid);
  if r is null then
    raise exception 'You''re not in this group anymore.' using errcode = '42501', hint = 'not_member';
  end if;
  return r;
end $$;
revoke execute on function public.group_require(uuid) from public, anon, authenticated;

-- Notify people who were just added to a group (in-app + push, category 'messages').
create or replace function public.group_notify_added(cid uuid, ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare
  u uuid;
  actor text := public.display_name_of(auth.uid());
  ttl text := coalesce((select title from public.conversations where id = cid), 'a group');
begin
  foreach u in array ids loop
    perform public.notify_user(u, 'group_added', ttl, actor || ' added you to ' || ttl,
      jsonb_build_object('conversation_id', cid, 'sender_id', auth.uid(), 'actor_name', actor,
        'url', '/group-chat?id=' || cid::text),
      'messages');
  end loop;
end $$;
revoke execute on function public.group_notify_added(uuid, uuid[]) from public, anon, authenticated;

-- ═════════════════════════════════════════════ 1:1-only helpers now check kind
-- Same as 20261115120000_dm_requests_privacy.sql, plus kind = 'direct'.
create or replace function public.dm_conversation_with(other uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select a.conversation_id
  from public.conversation_members a
  join public.conversation_members b on b.conversation_id = a.conversation_id and b.user_id = other
  join public.conversations c on c.id = a.conversation_id
  where a.user_id = auth.uid()
    and c.kind = 'direct'
    and (select count(*) from public.conversation_members x where x.conversation_id = a.conversation_id) = 2
  order by c.last_message_at desc
  limit 1;
$$;
revoke execute on function public.dm_conversation_with(uuid) from public, anon, authenticated;

-- Same as 20261115200000_dm_restrict_push_actions.sql, plus kind = 'direct'.
create or replace function public.dm_partner(cid uuid, me uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select case when not public.is_group(cid)
                and (select count(*) from public.conversation_members x where x.conversation_id = cid) = 2
    then (select o.user_id from public.conversation_members o where o.conversation_id = cid and o.user_id <> me limit 1)
  end;
$$;
revoke execute on function public.dm_partner(uuid, uuid) from public, anon, authenticated;

-- Same as 20261115120000_dm_requests_privacy.sql, plus: groups are refused like any non-1:1 chat.
create or replace function public.dm_tool_other(cid uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  other uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not public.is_conversation_member(cid) then
    raise exception 'Not a member of this conversation' using errcode = '42501';
  end if;
  if public.is_group(cid) or (select count(*) from public.conversation_members where conversation_id = cid) <> 2 then
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

-- Same as 20261113190000_safety_family.sql, but only for 1:1 chats: in a group a block between two members
-- must not stop either of them (or everyone else) from talking.
create or replace function public.conversation_blocked(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not public.is_group(cid) and exists (
    select 1 from public.conversation_members m
    join public.blocks b
      on (b.blocker_id = auth.uid() and b.blocked_id = m.user_id)
      or (b.blocked_id = auth.uid() and b.blocker_id = m.user_id)
    where m.conversation_id = cid and m.user_id <> auth.uid()
  );
$$;
revoke execute on function public.conversation_blocked(uuid) from public, anon;
grant execute on function public.conversation_blocked(uuid) to authenticated;

-- ═════════════════════════════════════════════ history since joining
-- True unless `cid` is a group the caller joined after `created`.
create or replace function public.message_visible_since_join(cid uuid, created timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from public.conversation_members m
    join public.conversations c on c.id = m.conversation_id and c.kind = 'group'
    where m.conversation_id = cid and m.user_id = auth.uid() and created < m.joined_at
  );
$$;
revoke execute on function public.message_visible_since_join(uuid, timestamptz) from public, anon;
grant execute on function public.message_visible_since_join(uuid, timestamptz) to authenticated;

drop policy if exists "group history since joining" on public.messages;
create policy "group history since joining" on public.messages as restrictive for select to authenticated
  using (public.message_visible_since_join(conversation_id, created_at));

-- ═════════════════════════════════════════════ create / manage
create or replace function public.create_group(title text, member_ids uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  ids uuid[];
  cid uuid;
  t text := nullif(btrim(regexp_replace(coalesce(create_group.title, ''), '\s+', ' ', 'g')), '');
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select coalesce(array_agg(distinct i), '{}') into ids from unnest(coalesce(member_ids, '{}')) i where i is not null and i <> me;
  if cardinality(ids) = 0 then
    raise exception 'Pick at least one person for the group' using errcode = '22023', hint = 'no_members';
  end if;
  if cardinality(ids) + 1 > 64 then
    raise exception 'Groups can have up to 64 people' using errcode = '22023', hint = 'too_many';
  end if;
  if t is not null and char_length(t) > 64 then
    raise exception 'Group names can be up to 64 characters' using errcode = '22023', hint = 'bad_title';
  end if;
  if (select count(*) from public.conversations c
      where c.created_by = me and c.kind = 'group' and c.created_at > now() - interval '24 hours') >= 20 then
    raise exception 'You''ve made a lot of groups today. Try again tomorrow.' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  perform public.group_assert_invitable(ids);

  -- No name: first names of the first three members (me included) by name, "+N" beyond that.
  if t is null then
    select left(string_agg(n, ', ' order by n) filter (where rn <= 3)
                || case when count(*) > 3 then ' +' || (count(*) - 3) else '' end, 64)
      into t
    from (select split_part(coalesce(nullif(btrim(p.display_name), ''), p.username, 'Friend'), ' ', 1) as n,
                 row_number() over (order by p.display_name) as rn
          from public.profiles p where p.id = any (ids || me)) x;
    t := coalesce(nullif(t, ''), 'New group');
  end if;

  insert into public.conversations (created_by, kind, title) values (me, 'group', t) returning id into cid;
  insert into public.conversation_members (conversation_id, user_id, status, role)
  values (cid, me, 'active', 'owner');
  insert into public.conversation_members (conversation_id, user_id, status, role)
  select cid, i, 'active', 'member' from unnest(ids) i;
  perform public.group_notify_added(cid, ids);
  return cid;
end $$;
revoke execute on function public.create_group(text, uuid[]) from public, anon;
grant execute on function public.create_group(text, uuid[]) to authenticated;

create or replace function public.add_group_members(cid uuid, member_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  r text := public.group_require(cid);
  ids uuid[];
  n int;
begin
  if r not in ('owner', 'admin') then
    raise exception 'Only group admins can add people' using errcode = '42501', hint = 'not_admin';
  end if;
  perform 1 from public.conversations where id = cid for update;
  select coalesce(array_agg(distinct i), '{}') into ids
  from unnest(coalesce(member_ids, '{}')) i
  where i is not null
    and not exists (select 1 from public.conversation_members m where m.conversation_id = cid and m.user_id = i);
  if cardinality(ids) = 0 then return 0; end if;
  if (select count(*) from public.conversation_members where conversation_id = cid) + cardinality(ids) > 64 then
    raise exception 'Groups can have up to 64 people' using errcode = '22023', hint = 'too_many';
  end if;
  perform public.group_assert_invitable(ids);
  insert into public.conversation_members (conversation_id, user_id, status, role, joined_at)
  select cid, i, 'active', 'member', now() from unnest(ids) i
  on conflict (conversation_id, user_id) do nothing;
  get diagnostics n = row_count;
  perform public.group_notify_added(cid, ids);
  return n;
end $$;
revoke execute on function public.add_group_members(uuid, uuid[]) from public, anon;
grant execute on function public.add_group_members(uuid, uuid[]) to authenticated;

create or replace function public.leave_group(cid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r text := public.group_require(cid);
  heir uuid;
begin
  perform 1 from public.conversations where id = cid for update;
  delete from public.conversation_members where conversation_id = cid and user_id = me;
  update public.notifications set read = true
  where user_id = me and not read and kind in ('message', 'group_added') and payload ->> 'conversation_id' = cid::text;
  if not exists (select 1 from public.conversation_members where conversation_id = cid) then
    delete from public.conversations where id = cid;
    return;
  end if;
  if r = 'owner' then
    select m.user_id into heir from public.conversation_members m
    where m.conversation_id = cid
    order by (m.role = 'admin') desc, m.joined_at, m.user_id
    limit 1;
    update public.conversation_members set role = 'owner' where conversation_id = cid and user_id = heir;
  end if;
end $$;
revoke execute on function public.leave_group(uuid) from public, anon;
grant execute on function public.leave_group(uuid) to authenticated;

create or replace function public.remove_group_member(cid uuid, uid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  r text;
  target text;
begin
  if uid is not null and uid = auth.uid() then
    perform public.leave_group(cid);
    return;
  end if;
  r := public.group_require(cid);
  select m.role into target from public.conversation_members m where m.conversation_id = cid and m.user_id = uid;
  if target is null then return; end if;  -- already gone
  if target = 'owner' then
    raise exception 'The group owner can''t be removed' using errcode = '42501', hint = 'owner';
  end if;
  if not (r = 'owner' or (r = 'admin' and target = 'member')) then
    raise exception 'Only group admins can remove people' using errcode = '42501', hint = 'not_admin';
  end if;
  delete from public.conversation_members where conversation_id = cid and user_id = uid;
  update public.notifications set read = true
  where user_id = uid and not read and kind in ('message', 'group_added') and payload ->> 'conversation_id' = cid::text;
end $$;
revoke execute on function public.remove_group_member(uuid, uuid) from public, anon;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;

create or replace function public.rename_group(cid uuid, title text) returns void
language plpgsql security definer set search_path = public as $$
declare
  r text := public.group_require(cid);
  t text := nullif(btrim(regexp_replace(coalesce(rename_group.title, ''), '\s+', ' ', 'g')), '');
begin
  if r not in ('owner', 'admin') then
    raise exception 'Only group admins can rename the group' using errcode = '42501', hint = 'not_admin';
  end if;
  if t is null then raise exception 'Give the group a name' using errcode = '22023', hint = 'bad_title'; end if;
  if char_length(t) > 64 then
    raise exception 'Group names can be up to 64 characters' using errcode = '22023', hint = 'bad_title';
  end if;
  update public.conversations c set title = t where c.id = cid and c.title is distinct from t;
end $$;
revoke execute on function public.rename_group(uuid, text) from public, anon;
grant execute on function public.rename_group(uuid, text) to authenticated;

create or replace function public.set_group_avatar(cid uuid, url text) returns void
language plpgsql security definer set search_path = public as $$
declare
  r text := public.group_require(cid);
  u text := nullif(btrim(coalesce(url, '')), '');
begin
  if r not in ('owner', 'admin') then
    raise exception 'Only group admins can change the photo' using errcode = '42501', hint = 'not_admin';
  end if;
  if u is not null and (u !~ '^https://' or char_length(u) > 1024) then
    raise exception 'That photo link isn''t valid' using errcode = '22023', hint = 'bad_url';
  end if;
  update public.conversations set avatar_url = u where id = cid;
end $$;
revoke execute on function public.set_group_avatar(uuid, text) from public, anon;
grant execute on function public.set_group_avatar(uuid, text) to authenticated;

create or replace function public.set_group_role(cid uuid, uid uuid, role text) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r text := public.group_require(cid);
  target text;
begin
  if set_group_role.role is null or set_group_role.role not in ('owner', 'admin', 'member') then
    raise exception 'Unknown role' using errcode = '22023', hint = 'bad_role';
  end if;
  perform 1 from public.conversations where id = cid for update;
  select m.role into target from public.conversation_members m where m.conversation_id = cid and m.user_id = uid;
  if target is null then
    raise exception 'They''re not in this group anymore' using errcode = 'P0002', hint = 'not_member';
  end if;
  if uid = me then
    raise exception 'You can''t change your own role' using errcode = '42501', hint = 'self';
  end if;
  if target = set_group_role.role then return; end if;

  if set_group_role.role = 'owner' then
    if r <> 'owner' then
      raise exception 'Only the group owner can hand over ownership' using errcode = '42501', hint = 'not_owner';
    end if;
    update public.conversation_members set role = 'admin' where conversation_id = cid and user_id = me;
    update public.conversation_members set role = 'owner' where conversation_id = cid and user_id = uid;
    return;
  end if;
  if target = 'owner' then
    raise exception 'The owner''s role can''t be changed' using errcode = '42501', hint = 'owner';
  end if;
  if not (r = 'owner' or (r = 'admin' and target = 'member' and set_group_role.role = 'admin')) then
    raise exception 'Only the group owner can change admins' using errcode = '42501', hint = 'not_admin';
  end if;
  update public.conversation_members set role = set_group_role.role where conversation_id = cid and user_id = uid;
end $$;
revoke execute on function public.set_group_role(uuid, uuid, text) from public, anon;
grant execute on function public.set_group_role(uuid, uuid, text) to authenticated;

create or replace function public.group_members(cid uuid)
returns table (user_id uuid, display_name text, username text, avatar_url text, role text, joined_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.user_id, p.display_name, p.username, p.avatar_url, m.role, m.joined_at
  from public.conversation_members m
  join public.profiles p on p.id = m.user_id
  where m.conversation_id = cid and public.is_group(cid) and public.is_conversation_member(cid)
  order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.joined_at, lower(p.display_name);
$$;
revoke execute on function public.group_members(uuid) from public, anon;
grant execute on function public.group_members(uuid) to authenticated;

-- For pickers: can the caller add each of `ids` to a group? reason: see group_invite_refusal.
create or replace function public.group_invite_check(ids uuid[])
returns table (user_id uuid, ok boolean, reason text)
language sql stable security definer set search_path = public as $$
  select i, r is null, r
  from (select distinct i from unnest(coalesce(ids, '{}')) i where i is not null limit 300) x,
       lateral (select public.group_invite_refusal(auth.uid(), x.i) as r) y
  where auth.uid() is not null;
$$;
revoke execute on function public.group_invite_check(uuid[]) from public, anon;
grant execute on function public.group_invite_check(uuid[]) to authenticated;

-- ═════════════════════════════════════════════ group jam
-- The group's jam room (null row when none). listeners = room_members (readable here even for members
-- who haven't joined the room yet).
create or replace function public.group_jam(cid uuid)
returns table (room_id uuid, code text, name text, host_id uuid, is_open boolean, is_playing boolean,
               track jsonb, listeners int, joined boolean)
language sql stable security definer set search_path = public as $$
  select r.id, r.code, r.name, r.host_id, r.is_open, r.is_playing, r.track,
    (select count(*)::int from public.room_members rm where rm.room_id = r.id),
    exists (select 1 from public.room_members rm where rm.room_id = r.id and rm.user_id = auth.uid())
  from public.conversations c
  join public.rooms r on r.id = c.jam_room_id
  where c.id = cid and c.kind = 'group' and public.is_conversation_member(cid);
$$;
revoke execute on function public.group_jam(uuid) from public, anon;
grant execute on function public.group_jam(uuid) to authenticated;

-- Opens the group's jam (reuses it while it's open), joins the caller to it and, when a new room was
-- made, posts a 'jam' message. Returns the room id.
create or replace function public.start_group_jam(cid uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  rid uuid;
  rcode text;
  rname text;
  ttl text;
begin
  perform public.group_require(cid);
  select c.jam_room_id, c.title into rid, ttl from public.conversations c where c.id = cid for update;
  if rid is not null and exists (select 1 from public.rooms r where r.id = rid and r.is_open) then
    insert into public.room_members (room_id, user_id) values (rid, me) on conflict do nothing;
    return rid;
  end if;
  rname := left(coalesce(ttl, 'Group') || ' jam', 80);
  insert into public.rooms (host_id, kind, name) values (me, 'group', rname) returning id, code into rid, rcode;
  insert into public.room_members (room_id, user_id) values (rid, me) on conflict do nothing;
  update public.conversations set jam_room_id = rid where id = cid;
  insert into public.messages (conversation_id, sender_id, body, kind, meta)
  values (cid, me, '', 'jam', jsonb_build_object('room_id', rid, 'code', rcode, 'name', rname));
  return rid;
end $$;
revoke execute on function public.start_group_jam(uuid) from public, anon;
grant execute on function public.start_group_jam(uuid) to authenticated;

-- ═════════════════════════════════════════════ inbox (+ groups)
-- As in 20261115200000_dm_restrict_push_actions.sql (every column and rule kept), plus:
--   * kind ('direct' | 'group'), title, avatar_url (group name / photo; null for 1:1)
--   * last_sender_name: display name of the last message's sender ("Meera: …" previews)
--   * last_meta: the last visible message's meta (voice note duration etc.)
--   * groups: listed even before the first message; other_* columns null; blocked always null;
--     restrict rules don't apply; last message / unread only count messages since I joined.
drop function if exists public.inbox();
create function public.inbox()
returns table (
  conversation_id uuid, member_count int, other_id uuid, other_name text, other_username text, other_avatar text,
  last_message_id uuid, last_sender_id uuid, last_kind text, last_preview text, last_at timestamptz,
  unread int, request_state text, muted boolean, muted_until timestamptz, blocked text,
  kind text, title text, avatar_url text, last_sender_name text, last_meta jsonb)
language sql stable security definer set search_path = public as $$
  with mine as (
    select m.conversation_id, m.last_read_at, m.muted, m.muted_until, c.created_at as conv_created,
           c.disappear_seconds, c.disappear_since, c.kind as conv_kind, c.title as conv_title,
           c.avatar_url as conv_avatar,
           case when c.kind = 'group' then m.joined_at end as since
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
    case when l.msg_id is null then null else l.meta end
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
  order by coalesce(l.msg_at, l.conv_created) desc
  limit 200;
$$;
revoke execute on function public.inbox() from public, anon;
grant execute on function public.inbox() to authenticated;

-- inbox_unread_total() reads inbox() by column name (unread, blocked): unchanged and still valid.

-- ═════════════════════════════════════════════ message notifications (+ groups)
-- Same as 20261115200000_dm_restrict_push_actions.sql's version for 1:1 chats. Group messages notify every
-- other active member (not muted / muted_until passed, no block with the sender either way) with
-- title = group title, body "Sender: preview", url /group-chat?id=<cid>.
create or replace function public.on_message_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m record;
  sender text := public.display_name_of(new.sender_id);
  preview text := public.message_preview(new.kind, new.body, new.track, new.meta);
  accepted int;
  g record;
begin
  if new.kind = 'call' then return new; end if;

  select c.kind, c.title into g from public.conversations c where c.id = new.conversation_id;
  if g.kind = 'group' then
    for m in
      select cm.user_id from public.conversation_members cm
      where cm.conversation_id = new.conversation_id and cm.user_id <> new.sender_id
        and cm.status = 'active' and not cm.muted
        and (cm.muted_until is null or cm.muted_until <= now())
        and not exists (select 1 from public.blocks b
                        where (b.blocker_id = cm.user_id and b.blocked_id = new.sender_id)
                           or (b.blocker_id = new.sender_id and b.blocked_id = cm.user_id))
    loop
      perform public.notify_user(m.user_id, 'message', coalesce(g.title, 'Group'), sender || ': ' || preview,
        jsonb_build_object('conversation_id', new.conversation_id, 'message_id', new.id, 'sender_id', new.sender_id,
          'actor_name', sender, 'group', true, 'url', '/group-chat?id=' || new.conversation_id::text),
        'messages');
    end loop;
    return new;
  end if;

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
