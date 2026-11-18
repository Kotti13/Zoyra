-- Calls extras (client: src/lib/calls.ts, src/lib/call-listen.ts, src/lib/call-session.ts) + block facts.
--
--   call_secrets   per-call Agora media-encryption key + salt (AES_128_GCM2). Written / read only by the
--                  agora-token edge function (service role); no client access at all. Both participants get
--                  the same pair in the token response. The server issues the keys, so this is transport
--                  encryption of the media ("Encrypted"), not end-to-end encryption.
--   call_tracks    songs shared while listening together during a call (Share song). Participants can read
--                  and add rows while the call is ringing / live; realtime so both sides see new rows.
--                  Playback position sync is a realtime broadcast on `call-listen:<call id>` (no table).
--   call_ratings   "How was the call quality?" stars, one row per (call, user); participants of an answered call.
--
-- Block facts shown in Confirm block (src/app/confirm-block.tsx), made true server side:
--   "She won't see when you're online or listening"  play_history "friends see activity" also requires
--                                                    no block in either direction (online status is
--                                                    filtered in src/lib/presence.ts).
--   "Your chat and Blend playlist stay hidden"       inbox() already hides blocked chats; the chat's Blend
--                                                    playlist is hidden (view + edit) for both members while
--                                                    either has blocked the other (can_view_playlist /
--                                                    can_edit_playlist), and comes back on unblock.

-- ═════════════════════════════════════════════ call_secrets
create table if not exists public.call_secrets (
  call_id uuid primary key references public.calls (id) on delete cascade,
  encryption_key text not null,
  -- base64 of 32 random bytes (Agora encryptionKdfSalt).
  encryption_salt text not null,
  created_at timestamptz not null default now()
);
alter table public.call_secrets enable row level security;
revoke all on public.call_secrets from anon, authenticated;
-- No policies: only the service role (agora-token) touches this table.

-- ═════════════════════════════════════════════ call_tracks
create table if not exists public.call_tracks (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls (id) on delete cascade,
  track jsonb not null check (
    jsonb_typeof(track) = 'object'
    and jsonb_typeof(track -> 'id') = 'string'
    and jsonb_typeof(track -> 'title') = 'string'
    and pg_column_size(track) < 16384
  ),
  shared_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists call_tracks_call_idx on public.call_tracks (call_id, created_at);

create or replace function public.is_call_participant(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.calls c where c.id = cid and (c.caller_id = auth.uid() or c.callee_id = auth.uid()));
$$;
revoke execute on function public.is_call_participant(uuid) from public, anon;
grant execute on function public.is_call_participant(uuid) to authenticated;

-- Shares are only accepted while the call is ringing / live, at most 200 per call.
create or replace function public.call_track_can_add(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.calls c
    where c.id = cid and (c.caller_id = auth.uid() or c.callee_id = auth.uid()) and c.status in ('ringing', 'accepted')
  ) and (select count(*) from public.call_tracks t where t.call_id = cid) < 200;
$$;
revoke execute on function public.call_track_can_add(uuid) from public, anon;
grant execute on function public.call_track_can_add(uuid) to authenticated;

alter table public.call_tracks enable row level security;
revoke all on public.call_tracks from anon, authenticated;
grant select, insert on public.call_tracks to authenticated;

drop policy if exists "call participants read tracks" on public.call_tracks;
create policy "call participants read tracks" on public.call_tracks for select to authenticated
  using (public.is_call_participant(call_id));
drop policy if exists "call participants share tracks" on public.call_tracks;
create policy "call participants share tracks" on public.call_tracks for insert to authenticated
  with check (shared_by = auth.uid() and public.call_track_can_add(call_id));

do $$
begin
  begin alter publication supabase_realtime add table public.call_tracks; exception when duplicate_object then null; end;
end $$;

-- ═════════════════════════════════════════════ call_ratings
create table if not exists public.call_ratings (
  call_id uuid not null references public.calls (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  stars smallint not null check (stars between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (call_id, user_id)
);

create or replace function public.call_was_answered(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.calls c
    where c.id = cid and (c.caller_id = auth.uid() or c.callee_id = auth.uid()) and c.answered_at is not null
  );
$$;
revoke execute on function public.call_was_answered(uuid) from public, anon;
grant execute on function public.call_was_answered(uuid) to authenticated;

alter table public.call_ratings enable row level security;
revoke all on public.call_ratings from anon, authenticated;
grant select, insert, update on public.call_ratings to authenticated;

drop policy if exists "own call ratings read" on public.call_ratings;
create policy "own call ratings read" on public.call_ratings for select to authenticated
  using (user_id = auth.uid());
drop policy if exists "own call ratings insert" on public.call_ratings;
create policy "own call ratings insert" on public.call_ratings for insert to authenticated
  with check (user_id = auth.uid() and public.call_was_answered(call_id));
drop policy if exists "own call ratings update" on public.call_ratings;
create policy "own call ratings update" on public.call_ratings for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.call_was_answered(call_id));

-- ═════════════════════════════════════════════ block: listening activity
drop policy if exists "friends see activity" on public.play_history;
create policy "friends see activity" on public.play_history for select to authenticated using (
  exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.following_id = play_history.user_id)
  and exists (select 1 from public.user_settings s where s.user_id = play_history.user_id and coalesce((s.privacy ->> 'listening_activity')::boolean, true))
  and not public.blocked_with(play_history.user_id)
);

-- ═════════════════════════════════════════════ block: Blend playlist hidden
create index if not exists conversations_blend_playlist_idx on public.conversations (blend_playlist_id) where blend_playlist_id is not null;

-- True when `pid` is the Blend of a chat I'm in and either of us has blocked the other.
create or replace function public.playlist_blend_blocked(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversations c
    where c.blend_playlist_id = pid
      and public.is_conversation_member(c.id)
      and public.conversation_blocked(c.id)
  );
$$;
revoke execute on function public.playlist_blend_blocked(uuid) from public, anon;
grant execute on function public.playlist_blend_blocked(uuid) to authenticated;

-- Same as 20261113150000_zoyra_core.sql, plus the Blend block check.
create or replace function public.can_edit_playlist(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select (exists (select 1 from public.playlists p where p.id = pid and p.owner_id = auth.uid())
       or exists (select 1 from public.playlist_collaborators c where c.playlist_id = pid and c.user_id = auth.uid()))
     and not public.playlist_blend_blocked(pid);
$$;

create or replace function public.can_view_playlist(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select (exists (select 1 from public.playlists p where p.id = pid and (p.visibility <> 'private' or p.owner_id = auth.uid()))
       or public.can_edit_playlist(pid))
     and not public.playlist_blend_blocked(pid);
$$;
