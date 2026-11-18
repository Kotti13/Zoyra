-- Notes v2, last seen & online, archive settings, backup summary (Messages redesign).
--
-- Settings (user_settings.dm, read with dm_setting(); defaults in dm_defaults()):
--   last_seen_who      'everyone' | 'mutuals' | 'forever' | 'nobody'   (default 'mutuals')
--   last_seen_approx   boolean: show "last seen recently" instead of the time (default false)
--   archive_keep_muted boolean: muted archived chats stay archived on new messages (default true = the old
--                      behaviour of 20261115320000)
--   archive_keep       boolean: archived chats never come back on new messages (default false)
--   Existing keys (who, read_receipts, online_status, typing, now_playing, filter_spam, song_shares_anyone,
--   group_invites) are unchanged; dm_defaults / dm_setting are redefined with every old rule kept.
--
-- Forever friends:
--   is_forever_pair(a, b)  = forever_active(a, b) from 20261117100000_forever_friends.sql (runs before this one).
--                          If that helper doesn't exist, an existing is_forever_pair is kept, else a stub
--                          returning false is created (to be replaced by the Forever migration).
--
-- Last seen:
--   user_last_seen         one row per user (seen_at). RLS on, no policies: RPC only.
--   touch_last_seen()      heartbeat from the app (foreground / background / every few minutes while open).
--   last_seen_allows(o, v) internal: does owner o's last_seen_who let viewer v see it? Forever friends always
--                          can, unless o chose 'nobody'.
--   last_seen_for(uid)     {visible, at, approx, bucket, online_visible} for the caller. Reciprocal: the caller
--                          sees uid's last seen only when uid's rule allows the caller AND the caller's own
--                          rule allows uid ("Nobody: you won't see theirs either"). Never across a block or a
--                          restriction (either way). Approximate when either side chose "approximate".
--                          online_visible = both Online status switches on (presence itself is enforced by
--                          the realtime policies of 20261115280000).
--
-- Notes v2 (on top of 20261115330000_user_notes.sql / 20261115350000_note_clip.sql):
--   note_views(note_owner, viewer, seen_at)              a friend opened the note
--   note_reactions(note_owner, reactor, emoji, created_at) one reaction per viewer (❤️ 🔥 😂 😮 👏 🎶), changeable
--   note_replies(id, note_owner, replier, created_at)    a reply DM was sent (written by record_note_reply)
--   All three belong to the owner's CURRENT note: they're wiped when the note is posted again, edited or
--   deleted (and reads also ignore rows older than the note). Writes only through the RPCs below (same
--   mutual-follow rule as the note: note_visible). RLS: the owner sees every row for their note; a viewer /
--   reactor / replier sees only their own rows.
--   view_note(owner)                  record a view (no-op for my own note or a note I can't see).
--   react_to_note(owner, emoji|null)  set / change / clear my reaction (also records a view).
--   record_note_reply(owner)          after the DM went out: needs a message from me in our 1:1 chat within
--                                     the last 5 minutes (the DM itself stays end-to-end encrypted).
--   note_insights()                   owner: {views, likes, replies, faces[≤4]} for the active note.
--   note_audience()                   owner: everyone who viewed / reacted / replied, with emoji + times.
--   list_notes()                      + my_reaction, seen (my reaction / whether I opened it). Same rows.
--
-- Archive:
--   unarchive_on_message()  same as 20261115320000 (a new message from someone else unarchives the chat for
--                           the other members), honouring archive_keep (never) and archive_keep_muted (muted
--                           chats stay archived; default on = old behaviour).
--
-- Backup:
--   chat_backup_summary()   {exists, updated_at, chats, bytes}: when the PIN key backup was last written and
--                           how much end-to-end encrypted history it unlocks (chats with e2ee messages and the
--                           ciphertext size). No key material.

-- ═════════════════════════════════════════════ settings
create or replace function public.dm_defaults() returns jsonb
language sql immutable set search_path = public as $$
  select '{"who":"mutuals","read_receipts":true,"online_status":true,"typing":true,"now_playing":true,
           "filter_spam":true,"song_shares_anyone":false,"group_invites":"mutuals",
           "last_seen_who":"mutuals","last_seen_approx":false,"archive_keep_muted":true,"archive_keep":false}'::jsonb;
$$;

create or replace function public.dm_setting(uid uuid, key text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select case
       when key = 'who' and s.dm ->> key in ('everyone', 'mutuals', 'followers', 'none') then s.dm ->> key
       when key = 'group_invites' and s.dm ->> key in ('everyone', 'mutuals', 'none') then s.dm ->> key
       when key = 'last_seen_who' and s.dm ->> key in ('everyone', 'mutuals', 'forever', 'nobody') then s.dm ->> key
       when key not in ('who', 'group_invites', 'last_seen_who') and jsonb_typeof(s.dm -> key) = 'boolean' then s.dm ->> key
     end
     from public.user_settings s where s.user_id = uid),
    public.dm_defaults() ->> key);
$$;
revoke execute on function public.dm_setting(uuid, text) from public, anon, authenticated;

-- ═════════════════════════════════════════════ forever helper (stub unless the Forever migration made it)
-- Delegates to forever_active(a, b) from 20261117100000_forever_friends.sql when it exists, else returns false
-- (the Forever migration should then `create or replace` it). Internal: not callable by clients.
do $$
begin
  if to_regprocedure('public.forever_active(uuid, uuid)') is not null then
    execute $f$
      create or replace function public.is_forever_pair(a uuid, b uuid) returns boolean
      language sql stable security definer set search_path = public as $q$ select public.forever_active(a, b) $q$
    $f$;
  elsif to_regprocedure('public.is_forever_pair(uuid, uuid)') is null then
    execute $f$
      create function public.is_forever_pair(a uuid, b uuid) returns boolean
      language sql stable security definer set search_path = public as $q$ select false $q$
    $f$;
  end if;
  execute 'revoke execute on function public.is_forever_pair(uuid, uuid) from public, anon, authenticated';
end $$;

-- ═════════════════════════════════════════════ last seen
create table if not exists public.user_last_seen (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  seen_at timestamptz not null default now()
);
alter table public.user_last_seen enable row level security;
revoke all on public.user_last_seen from anon, authenticated;

create or replace function public.touch_last_seen() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  insert into public.user_last_seen as s (user_id, seen_at) values (auth.uid(), now())
  on conflict (user_id) do update set seen_at = now()
    where s.seen_at < now() - interval '15 seconds';
end $$;
revoke execute on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;

create or replace function public.last_seen_allows(owner uuid, viewer uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.dm_setting(owner, 'last_seen_who')
    when 'nobody' then false
    when 'everyone' then true
    when 'forever' then coalesce(public.is_forever_pair(owner, viewer), false)
    else coalesce(public.is_forever_pair(owner, viewer), false)
      or (exists (select 1 from public.follows f where f.follower_id = owner and f.following_id = viewer)
          and exists (select 1 from public.follows f where f.follower_id = viewer and f.following_id = owner))
  end;
$$;
revoke execute on function public.last_seen_allows(uuid, uuid) from public, anon, authenticated;

create or replace function public.last_seen_for(uid uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  at timestamptz;
  approx boolean;
  online_ok boolean;
  age interval;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if uid is null then return jsonb_build_object('visible', false, 'online_visible', false); end if;
  select s.seen_at into at from public.user_last_seen s where s.user_id = uid;
  if uid = me then
    return jsonb_build_object('visible', at is not null, 'at', at, 'approx', false, 'bucket', null,
                              'online_visible', public.dm_setting(me, 'online_status')::boolean);
  end if;
  if public.blocked_with(uid) or public.restricts(uid, me) or public.restricts(me, uid) then
    return jsonb_build_object('visible', false, 'online_visible', false);
  end if;
  online_ok := public.dm_setting(uid, 'online_status')::boolean and public.dm_setting(me, 'online_status')::boolean;
  if at is null or not public.last_seen_allows(uid, me) or not public.last_seen_allows(me, uid) then
    return jsonb_build_object('visible', false, 'online_visible', online_ok);
  end if;
  approx := public.dm_setting(uid, 'last_seen_approx')::boolean or public.dm_setting(me, 'last_seen_approx')::boolean;
  if approx then
    age := now() - at;
    return jsonb_build_object('visible', true, 'at', null, 'approx', true, 'online_visible', online_ok,
      'bucket', case when age <= interval '3 days' then 'recently'
                     when age <= interval '7 days' then 'week'
                     when age <= interval '30 days' then 'month'
                     else 'long' end);
  end if;
  return jsonb_build_object('visible', true, 'at', at, 'approx', false, 'bucket', null, 'online_visible', online_ok);
end $$;
revoke execute on function public.last_seen_for(uuid) from public, anon;
grant execute on function public.last_seen_for(uuid) to authenticated;

-- ═════════════════════════════════════════════ notes v2: tables
create table if not exists public.note_views (
  note_owner uuid not null references public.profiles (id) on delete cascade,
  viewer uuid not null references public.profiles (id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (note_owner, viewer),
  check (note_owner <> viewer)
);
create index if not exists note_views_viewer_idx on public.note_views (viewer);

create table if not exists public.note_reactions (
  note_owner uuid not null references public.profiles (id) on delete cascade,
  reactor uuid not null references public.profiles (id) on delete cascade,
  emoji text not null check (emoji in ('❤️', '🔥', '😂', '😮', '👏', '🎶')),
  created_at timestamptz not null default now(),
  primary key (note_owner, reactor),
  check (note_owner <> reactor)
);
create index if not exists note_reactions_reactor_idx on public.note_reactions (reactor);

create table if not exists public.note_replies (
  id bigint generated always as identity primary key,
  note_owner uuid not null references public.profiles (id) on delete cascade,
  replier uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  check (note_owner <> replier)
);
create index if not exists note_replies_owner_idx on public.note_replies (note_owner, created_at desc);
create index if not exists note_replies_replier_idx on public.note_replies (replier);

alter table public.note_views enable row level security;
alter table public.note_reactions enable row level security;
alter table public.note_replies enable row level security;

drop policy if exists "note_views owner or self" on public.note_views;
create policy "note_views owner or self" on public.note_views for select to authenticated
  using (note_owner = auth.uid() or viewer = auth.uid());
drop policy if exists "note_reactions owner or self" on public.note_reactions;
create policy "note_reactions owner or self" on public.note_reactions for select to authenticated
  using (note_owner = auth.uid() or reactor = auth.uid());
drop policy if exists "note_replies owner or self" on public.note_replies;
create policy "note_replies owner or self" on public.note_replies for select to authenticated
  using (note_owner = auth.uid() or replier = auth.uid());

revoke all on public.note_views, public.note_reactions, public.note_replies from anon, authenticated;
grant select on public.note_views, public.note_reactions, public.note_replies to authenticated;

-- A new / edited / deleted note starts with no views, reactions or replies.
create or replace function public.user_notes_reset_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  owner uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
begin
  delete from public.note_views where note_owner = owner;
  delete from public.note_reactions where note_owner = owner;
  delete from public.note_replies where note_owner = owner;
  return null;
end $$;
revoke execute on function public.user_notes_reset_activity() from public, anon, authenticated;
drop trigger if exists user_notes_reset_activity on public.user_notes;
create trigger user_notes_reset_activity after insert or update or delete on public.user_notes
  for each row execute function public.user_notes_reset_activity();

-- True when the caller may interact with owner's note right now (active, visible, not their own).
create or replace function public.note_interactable(owner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and owner is not null and owner <> auth.uid()
    and exists (select 1 from public.user_notes n where n.user_id = owner and n.expires_at > now())
    and public.note_visible(owner);
$$;
revoke execute on function public.note_interactable(uuid) from public, anon, authenticated;

-- ═════════════════════════════════════════════ notes v2: RPCs
create or replace function public.view_note(p_owner uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not public.note_interactable(p_owner) then return; end if;
  insert into public.note_views (note_owner, viewer) values (p_owner, auth.uid())
  on conflict (note_owner, viewer) do nothing;
end $$;
revoke execute on function public.view_note(uuid) from public, anon;
grant execute on function public.view_note(uuid) to authenticated;

create or replace function public.react_to_note(p_owner uuid, p_emoji text default null) returns text
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not public.note_interactable(p_owner) then
    raise exception 'This note isn''t available anymore.' using errcode = 'P0001', hint = 'note_gone';
  end if;
  if p_emoji is null or p_emoji = '' then
    delete from public.note_reactions where note_owner = p_owner and reactor = me;
    return null;
  end if;
  if p_emoji not in ('❤️', '🔥', '😂', '😮', '👏', '🎶') then
    raise exception 'That reaction isn''t available.' using errcode = '22023', hint = 'note_emoji';
  end if;
  insert into public.note_views (note_owner, viewer) values (p_owner, me) on conflict do nothing;
  insert into public.note_reactions as r (note_owner, reactor, emoji) values (p_owner, me, p_emoji)
  on conflict (note_owner, reactor) do update set emoji = excluded.emoji, created_at = now()
    where r.emoji is distinct from excluded.emoji;
  return p_emoji;
end $$;
revoke execute on function public.react_to_note(uuid, text) from public, anon;
grant execute on function public.react_to_note(uuid, text) to authenticated;

create or replace function public.record_note_reply(p_owner uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cid uuid;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not public.note_interactable(p_owner) then return; end if;
  cid := public.dm_conversation_with(p_owner);
  if cid is null or not exists (
    select 1 from public.messages m
    where m.conversation_id = cid and m.sender_id = me and m.created_at > now() - interval '5 minutes'
  ) then
    return;
  end if;
  -- At most one reply row per minute per person (retries / double taps).
  if exists (select 1 from public.note_replies r where r.note_owner = p_owner and r.replier = me
             and r.created_at > now() - interval '1 minute') then
    return;
  end if;
  insert into public.note_views (note_owner, viewer) values (p_owner, me) on conflict do nothing;
  insert into public.note_replies (note_owner, replier) values (p_owner, me);
end $$;
revoke execute on function public.record_note_reply(uuid) from public, anon;
grant execute on function public.record_note_reply(uuid) to authenticated;

-- Everyone who viewed / reacted to / replied to my active note (newest activity first).
create or replace function public.note_audience()
returns table (user_id uuid, display_name text, avatar_url text, seen_at timestamptz, emoji text,
               reacted_at timestamptz, replies int, replied_at timestamptz)
language sql stable security definer set search_path = public as $$
  with n as (
    select created_at from public.user_notes where user_id = auth.uid() and expires_at > now()
  ), people as (
    select v.viewer as id from public.note_views v, n where v.note_owner = auth.uid() and v.seen_at >= n.created_at
    union
    select r.reactor from public.note_reactions r, n where r.note_owner = auth.uid() and r.created_at >= n.created_at
    union
    select p.replier from public.note_replies p, n where p.note_owner = auth.uid() and p.created_at >= n.created_at
  )
  select pp.id, p.display_name, p.avatar_url,
         v.seen_at, r.emoji, r.created_at,
         coalesce(rp.n, 0), rp.last_at
  from people pp
  join public.profiles p on p.id = pp.id
  left join public.note_views v on v.note_owner = auth.uid() and v.viewer = pp.id
  left join public.note_reactions r on r.note_owner = auth.uid() and r.reactor = pp.id
  left join lateral (
    select count(*)::int as n, max(x.created_at) as last_at from public.note_replies x
    where x.note_owner = auth.uid() and x.replier = pp.id
  ) rp on true
  where auth.uid() is not null and not public.blocked_with(pp.id)
  order by greatest(coalesce(rp.last_at, '-infinity'), coalesce(r.created_at, '-infinity'), coalesce(v.seen_at, '-infinity')) desc
  limit 500;
$$;
revoke execute on function public.note_audience() from public, anon;
grant execute on function public.note_audience() to authenticated;

create or replace function public.note_insights() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'views', (select count(*) from public.note_audience()),
    'likes', (select count(*) from public.note_audience() a where a.emoji is not null),
    'replies', (select coalesce(sum(a.replies), 0) from public.note_audience() a),
    'faces', coalesce((select jsonb_agg(jsonb_build_object('id', a.user_id, 'display_name', a.display_name, 'avatar_url', a.avatar_url))
                       from (select * from public.note_audience() limit 4) a), '[]'::jsonb)
  ) end;
$$;
revoke execute on function public.note_insights() from public, anon;
grant execute on function public.note_insights() to authenticated;

-- list_notes: same rows / order as 20261115330000, plus my reaction and whether I opened the note.
drop function if exists public.list_notes();
create function public.list_notes()
returns table (
  user_id uuid,
  text text,
  track jsonb,
  created_at timestamptz,
  expires_at timestamptz,
  display_name text,
  avatar_url text,
  mine boolean,
  my_reaction text,
  seen boolean
)
language sql stable security definer set search_path = public as $$
  select n.user_id, n.text, n.track, n.created_at, n.expires_at, p.display_name, p.avatar_url,
         n.user_id = auth.uid(),
         (select r.emoji from public.note_reactions r where r.note_owner = n.user_id and r.reactor = auth.uid() and r.created_at >= n.created_at),
         exists (select 1 from public.note_views v where v.note_owner = n.user_id and v.viewer = auth.uid() and v.seen_at >= n.created_at)
  from public.user_notes n
  join public.profiles p on p.id = n.user_id
  where auth.uid() is not null
    and n.expires_at > now()
    and public.note_visible(n.user_id)
  order by (n.user_id = auth.uid()) desc, n.created_at desc
  limit 100;
$$;
revoke execute on function public.list_notes() from public, anon;
grant execute on function public.list_notes() to authenticated;

-- ═════════════════════════════════════════════ archive: auto-unarchive honours the archive settings
create or replace function public.unarchive_on_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.conversation_members m
     set archived_at = null
   where m.conversation_id = new.conversation_id
     and m.user_id <> new.sender_id
     and m.archived_at is not null
     and not coalesce(public.dm_setting(m.user_id, 'archive_keep')::boolean, false)
     and not ((coalesce(m.muted, false) or coalesce(m.muted_until > now(), false))
              and coalesce(public.dm_setting(m.user_id, 'archive_keep_muted')::boolean, true));
  return new;
end $$;
revoke execute on function public.unarchive_on_message() from public, anon, authenticated;
drop trigger if exists on_message_unarchive on public.messages;
create trigger on_message_unarchive after insert on public.messages
  for each row execute function public.unarchive_on_message();

-- ═════════════════════════════════════════════ backup summary
create or replace function public.chat_backup_summary() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  b timestamptz;
  chats int;
  bytes bigint;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select k.updated_at into b from public.e2ee_key_backups k where k.user_id = me;
  if not found then return jsonb_build_object('exists', false); end if;
  select count(distinct m.conversation_id)::int, coalesce(sum(octet_length(m.ciphertext)), 0)
    into chats, bytes
  from public.messages m
  join public.conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = me
  where m.e2ee_version is not null;
  return jsonb_build_object('exists', true, 'updated_at', b, 'chats', chats, 'bytes', bytes);
end $$;
revoke execute on function public.chat_backup_summary() from public, anon;
grant execute on function public.chat_backup_summary() to authenticated;
