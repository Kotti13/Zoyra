-- Instagram-style follow requests.
--
--   * Public profile  -> Follow is instant (a row in public.follows, as before).
--   * Private profile -> Follow sends a REQUEST. The button shows "Requested" until the owner accepts
--     (a row moves into public.follows) or declines (the request is deleted). Nothing about the profile
--     unlocks until then, and the requester is not counted as a follower.
--   * Messaging does not need a follow: dm_access() / message requests are unchanged.
--
-- Requests live in their own table so every existing query over public.follows (follower counts, mutuals,
-- presence, note audiences, dm_access) keeps meaning "accepted follows" with no change.
--
-- Backward compatible: public profiles still accept a plain insert into public.follows (older app builds).
-- Direct inserts for a PRIVATE profile are refused, so an old build can't skip the approval step.

create table if not exists public.follow_requests (
  requester_id uuid not null references public.profiles (id) on delete cascade,
  target_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (requester_id, target_id),
  check (requester_id <> target_id)
);
create index if not exists follow_requests_target_idx on public.follow_requests (target_id, created_at desc);

alter table public.follow_requests enable row level security;
-- The two people involved can see it; either can delete it (withdraw / decline). No insert or update policy:
-- requests are created and accepted only through the functions below.
drop policy if exists "follow requests visible to both" on public.follow_requests;
create policy "follow requests visible to both" on public.follow_requests for select to authenticated
  using (requester_id = auth.uid() or target_id = auth.uid());
drop policy if exists "follow requests withdraw or decline" on public.follow_requests;
create policy "follow requests withdraw or decline" on public.follow_requests for delete to authenticated
  using (requester_id = auth.uid() or target_id = auth.uid());

-- A direct insert into follows is only for public profiles; private ones go through follow_user().
drop policy if exists "follow as self" on public.follows;
create policy "follow as self" on public.follows for insert to authenticated with check (
  follower_id = auth.uid()
  and not public.blocked_with(following_id)
  and not exists (select 1 from public.profiles p where p.id = following_id and p.is_private)
);

-- Follow someone. Returns 'following' (public profile, or already following) or 'requested' (private profile).
create or replace function public.follow_user(target uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  priv boolean;
begin
  if me is null then
    raise exception 'Sign in to follow people.' using errcode = '28000';
  end if;
  if target is null or target = me then
    raise exception 'You can''t follow yourself.' using errcode = '22023';
  end if;
  if public.blocked_with(target) then
    raise exception 'You can''t follow this person.' using errcode = '42501', hint = 'blocked';
  end if;
  if exists (select 1 from public.follows where follower_id = me and following_id = target) then
    return 'following';
  end if;
  select p.is_private into priv from public.profiles p where p.id = target;
  if priv is null then
    raise exception 'That profile doesn''t exist.' using errcode = '22023';
  end if;
  if priv then
    insert into public.follow_requests (requester_id, target_id) values (me, target) on conflict do nothing;
    return 'requested';
  end if;
  insert into public.follows (follower_id, following_id) values (me, target) on conflict do nothing;
  return 'following';
end $$;
revoke execute on function public.follow_user(uuid) from public, anon;
grant execute on function public.follow_user(uuid) to authenticated;

-- Accept a request someone sent me: they become my follower.
create or replace function public.accept_follow_request(requester uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  removed int;
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  delete from public.follow_requests where requester_id = requester and target_id = me;
  get diagnostics removed = row_count;
  if removed = 0 then return; end if;  -- already handled (withdrawn, declined or accepted elsewhere)
  if public.blocked_with(requester) then return; end if;
  insert into public.follows (follower_id, following_id) values (requester, me) on conflict do nothing;
  perform public.notify_user(requester, 'follow', 'Follow request accepted',
    public.display_name_of(me) || ' accepted your follow request',
    jsonb_build_object('follower_id', me, 'actor_name', public.display_name_of(me),
      'url', '/public-profile?id=' || me::text),
    'new_followers');
end $$;
revoke execute on function public.accept_follow_request(uuid) from public, anon;
grant execute on function public.accept_follow_request(uuid) to authenticated;

-- Decline a request someone sent me (they are not told).
create or replace function public.decline_follow_request(requester uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.follow_requests where requester_id = requester and target_id = auth.uid();
$$;
revoke execute on function public.decline_follow_request(uuid) from public, anon;
grant execute on function public.decline_follow_request(uuid) to authenticated;

-- New request -> notify the owner.
create or replace function public.on_follow_request_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.notify_user(new.target_id, 'follow', 'Follow request',
    public.display_name_of(new.requester_id) || ' requested to follow you',
    jsonb_build_object('follower_id', new.requester_id, 'actor_name', public.display_name_of(new.requester_id),
      'url', '/follow-requests'),
    'new_followers');
  return new;
end $$;
drop trigger if exists on_follow_request_notify on public.follow_requests;
create trigger on_follow_request_notify after insert on public.follow_requests
  for each row execute function public.on_follow_request_notify();

-- Switching a profile from private to public accepts everything waiting (nothing to approve any more).
create or replace function public.profile_public_accepts_requests() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.is_private and not new.is_private then
    insert into public.follows (follower_id, following_id)
    select r.requester_id, r.target_id from public.follow_requests r
    where r.target_id = new.id
      and not exists (select 1 from public.blocks b
                      where (b.blocker_id = r.requester_id and b.blocked_id = r.target_id)
                         or (b.blocker_id = r.target_id and b.blocked_id = r.requester_id))
    on conflict do nothing;
    delete from public.follow_requests where target_id = new.id;
  end if;
  return new;
end $$;
revoke execute on function public.profile_public_accepts_requests() from public, anon, authenticated;
drop trigger if exists profile_public_accepts_requests on public.profiles;
create trigger profile_public_accepts_requests after update of is_private on public.profiles
  for each row execute function public.profile_public_accepts_requests();

-- Live: the Requested button and the request list update without a refresh.
alter publication supabase_realtime add table public.follow_requests;
