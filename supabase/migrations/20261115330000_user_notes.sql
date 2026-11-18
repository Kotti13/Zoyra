-- Notes (Instagram-style) for the Messages inbox.
--
--   user_notes                 one active note per user (user_id is the primary key: posting replaces it).
--                              A note is short text (≤ 60 chars) and/or a song (track jsonb ≤ 4 KB:
--                              id, title, artist, artwork, …). Visible for 24 hours (expires_at).
--   audience                   mutual followers only: the viewer follows the owner AND the owner follows the
--                              viewer. There is no audience choice. Unfollowing (either way) hides the note
--                              at once (the rule is checked on every read, nothing is cached).
--   timestamps                 created_at / expires_at are always set by the server (trigger), so a client
--                              can't post a note that never expires. Updating a note restarts the 24 h.
--   RLS                        owner: full access to their own row. Others: select only while not expired,
--                              when the follow is mutual and nobody blocked anybody (blocked_with).
--                              Restricted accounts can still see notes (kept simple).
--   note_visible(owner)        the mutual-follow + block rule (security definer; used by the policy and
--                              list_notes).
--   post_note(text, track)     upsert of the caller's note (restarts the 24 h).
--   delete_note()              removes the caller's note.
--   list_notes()               the caller's own active note + visible notes of mutual followers, with
--                              display_name / avatar_url. Own note first, then newest first.

-- ═════════════════════════════════════════════ table
create table if not exists public.user_notes (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  text text check (text is null or (char_length(text) between 1 and 60 and text !~ '[\r\n]')),
  track jsonb check (
    track is null or coalesce(
      jsonb_typeof(track) = 'object'
      and jsonb_typeof(track -> 'id') = 'string'
      and jsonb_typeof(track -> 'title') = 'string'
      and octet_length(track::text) <= 4096,
      false
    )
  ),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  constraint user_notes_not_empty check (text is not null or track is not null)
);

create index if not exists user_notes_expires_idx on public.user_notes (expires_at);

-- Server-owned timestamps; text is trimmed (an all-blank text becomes null).
create or replace function public.user_notes_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  new.text := nullif(btrim(regexp_replace(coalesce(new.text, ''), '\s+', ' ', 'g')), '');
  new.created_at := now();
  new.expires_at := now() + interval '24 hours';
  return new;
end $$;
revoke execute on function public.user_notes_stamp() from public, anon, authenticated;

drop trigger if exists user_notes_stamp on public.user_notes;
create trigger user_notes_stamp before insert or update on public.user_notes
  for each row execute function public.user_notes_stamp();

-- ═════════════════════════════════════════════ visibility
-- True when the caller may see notes by `owner` (expiry is checked by the callers): it's the caller's own,
-- or both follow each other and there is no block either way.
create or replace function public.note_visible(owner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    owner = auth.uid()
    or (
      exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.following_id = owner)
      and exists (select 1 from public.follows f where f.follower_id = owner and f.following_id = auth.uid())
      and not public.blocked_with(owner)
    )
  );
$$;
revoke execute on function public.note_visible(uuid) from public, anon;
grant execute on function public.note_visible(uuid) to authenticated;

-- ═════════════════════════════════════════════ RLS + privileges
alter table public.user_notes enable row level security;

drop policy if exists "user_notes owner" on public.user_notes;
create policy "user_notes owner" on public.user_notes
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "user_notes mutuals" on public.user_notes;
create policy "user_notes mutuals" on public.user_notes
  for select to authenticated
  using (expires_at > now() and public.note_visible(user_id));

revoke all on public.user_notes from anon, authenticated;
grant select, delete on public.user_notes to authenticated;
grant insert (user_id, text, track) on public.user_notes to authenticated;
grant update (text, track) on public.user_notes to authenticated;

-- ═════════════════════════════════════════════ RPCs
create or replace function public.post_note(p_text text default null, p_track jsonb default null)
returns public.user_notes
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  t text := nullif(btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g')), '');
  r public.user_notes;
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if t is null and p_track is null then
    raise exception 'Write something or add a song.' using errcode = '22023', hint = 'note_empty';
  end if;
  if t is not null and char_length(t) > 60 then
    raise exception 'Notes can be up to 60 characters.' using errcode = '22001', hint = 'note_too_long';
  end if;
  if p_track is not null and (octet_length(p_track::text) > 4096 or jsonb_typeof(p_track) <> 'object'
      or coalesce(jsonb_typeof(p_track -> 'id'), '') <> 'string' or coalesce(jsonb_typeof(p_track -> 'title'), '') <> 'string') then
    raise exception 'That song can''t be added to a note.' using errcode = '22001', hint = 'note_track';
  end if;
  insert into public.user_notes as n (user_id, text, track)
  values (me, t, p_track)
  on conflict (user_id) do update set text = excluded.text, track = excluded.track
  returning n.* into r;
  return r;
end $$;
revoke execute on function public.post_note(text, jsonb) from public, anon;
grant execute on function public.post_note(text, jsonb) to authenticated;

create or replace function public.delete_note() returns void
language sql security definer set search_path = public as $$
  delete from public.user_notes where user_id = auth.uid();
$$;
revoke execute on function public.delete_note() from public, anon;
grant execute on function public.delete_note() to authenticated;

create or replace function public.list_notes()
returns table (
  user_id uuid,
  text text,
  track jsonb,
  created_at timestamptz,
  expires_at timestamptz,
  display_name text,
  avatar_url text,
  mine boolean
)
language sql stable security definer set search_path = public as $$
  select n.user_id, n.text, n.track, n.created_at, n.expires_at, p.display_name, p.avatar_url,
         n.user_id = auth.uid()
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
