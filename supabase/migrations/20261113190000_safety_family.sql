-- Zoyra phase 4 (Agent A): blocking + family plan.
--
-- Blocking: `blocks` + block_user / unblock_user rpcs. A block in either direction stops new
-- conversations, messages, follows and dedications between the two people.
--
-- Family: one group per owner (plan = 'family'), up to 6 seats including the owner, joined with an
-- invite code. Members' profiles.plan follows the owner's plan (server-side only; clients still can't
-- write profiles.plan, see 20261113160000_lock_profile_plan.sql).

-- ═════════════════════════════════════════════ blocking
create table public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index on public.blocks (blocked_id);

alter table public.blocks enable row level security;
-- You only ever see your own block list (never who blocked you). Writes go through the rpcs below,
-- but deleting your own row directly is harmless, so it's allowed too.
create policy "own blocks readable" on public.blocks for select to authenticated using (blocker_id = auth.uid());
create policy "own blocks insert" on public.blocks for insert to authenticated with check (blocker_id = auth.uid());
create policy "own blocks delete" on public.blocks for delete to authenticated using (blocker_id = auth.uid());

-- True when the caller and `other` have blocked each other in either direction.
-- Only reveals relationships that involve the caller.
create or replace function public.blocked_with(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.blocks
    where (blocker_id = auth.uid() and blocked_id = other)
       or (blocker_id = other and blocked_id = auth.uid())
  );
$$;
revoke execute on function public.blocked_with(uuid) from public, anon;
grant execute on function public.blocked_with(uuid) to authenticated;

-- True when the caller has a block (either direction) with any other member of the conversation.
create or replace function public.conversation_blocked(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversation_members m
    join public.blocks b
      on (b.blocker_id = auth.uid() and b.blocked_id = m.user_id)
      or (b.blocked_id = auth.uid() and b.blocker_id = m.user_id)
    where m.conversation_id = cid and m.user_id <> auth.uid()
  );
$$;
revoke execute on function public.conversation_blocked(uuid) from public, anon;
grant execute on function public.conversation_blocked(uuid) to authenticated;

-- Block someone: also removes follows in both directions.
create or replace function public.block_user(target uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if target is null or target = auth.uid() then raise exception 'You can''t block yourself' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles where id = target) then raise exception 'User not found' using errcode = 'P0002'; end if;
  insert into public.blocks (blocker_id, blocked_id) values (auth.uid(), target) on conflict do nothing;
  delete from public.follows
  where (follower_id = auth.uid() and following_id = target)
     or (follower_id = target and following_id = auth.uid());
end $$;
revoke execute on function public.block_user(uuid) from public, anon;
grant execute on function public.block_user(uuid) to authenticated;

create or replace function public.unblock_user(target uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from public.blocks where blocker_id = auth.uid() and blocked_id = target;
end $$;
revoke execute on function public.unblock_user(uuid) from public, anon;
grant execute on function public.unblock_user(uuid) to authenticated;

-- start_conversation: same as before, but refuses when either side has blocked the other.
create or replace function public.start_conversation(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if other is null or other = auth.uid() then raise exception 'You can''t message yourself' using errcode = '22023'; end if;
  if public.blocked_with(other) then
    raise exception 'You can''t message this person' using errcode = '42501', hint = 'blocked';
  end if;
  select a.conversation_id into cid
  from public.conversation_members a
  join public.conversation_members b on b.conversation_id = a.conversation_id
  where a.user_id = auth.uid() and b.user_id = other
  limit 1;
  if cid is null then
    insert into public.conversations default values returning id into cid;
    insert into public.conversation_members (conversation_id, user_id) values (cid, auth.uid()), (cid, other);
  end if;
  return cid;
end $$;

-- messages: no sending into a conversation with someone you blocked / who blocked you.
drop policy if exists "send messages" on public.messages;
create policy "send messages" on public.messages for insert to authenticated with check (
  sender_id = auth.uid()
  and public.is_conversation_member(conversation_id)
  and not public.conversation_blocked(conversation_id)
);

-- follows: no following across a block.
drop policy if exists "follow as self" on public.follows;
create policy "follow as self" on public.follows for insert to authenticated with check (
  follower_id = auth.uid() and not public.blocked_with(following_id)
);

-- dedications: no dedications across a block.
drop policy if exists "send dedication" on public.dedications;
create policy "send dedication" on public.dedications for insert to authenticated with check (
  sender_id = auth.uid() and not public.blocked_with(recipient_id)
);

-- ═════════════════════════════════════════════ family plan
create table public.family_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references public.profiles (id) on delete cascade,
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_at timestamptz not null default now()
);

-- One row per seat, the owner included. A person belongs to at most one family.
create table public.family_members (
  group_id uuid not null references public.family_groups (id) on delete cascade,
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

alter table public.family_groups enable row level security;
alter table public.family_members enable row level security;

create or replace function public.my_family_group() returns uuid
language sql stable security definer set search_path = public as $$
  select group_id from public.family_members where user_id = auth.uid() limit 1;
$$;
revoke execute on function public.my_family_group() from public, anon;
grant execute on function public.my_family_group() to authenticated;

-- Read-only from the client; every write goes through the rpcs below.
create policy "family group visible to members" on public.family_groups for select to authenticated
  using (owner_id = auth.uid() or id = public.my_family_group());
create policy "family members visible to members" on public.family_members for select to authenticated
  using (group_id = public.my_family_group());

-- Owner: get (or rotate) the invite code. Creates the group on first use. Requires the Family plan.
create or replace function public.create_family_invite(rotate boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  g public.family_groups;
begin
  if me is null then raise exception 'not signed in'; end if;
  if coalesce((select plan from public.profiles where id = me), 'free') <> 'family' then
    raise exception 'You need the Family plan to invite people' using errcode = '42501', hint = 'not_family';
  end if;
  if exists (select 1 from public.family_members m join public.family_groups fg on fg.id = m.group_id
             where m.user_id = me and fg.owner_id <> me) then
    raise exception 'You''re a member of someone else''s family. Leave it before starting your own.' using errcode = '42501', hint = 'member_elsewhere';
  end if;

  select * into g from public.family_groups where owner_id = me;
  if g.id is null then
    insert into public.family_groups (owner_id) values (me) returning * into g;
    insert into public.family_members (group_id, user_id) values (g.id, me) on conflict do nothing;
  elsif rotate then
    update public.family_groups
      set invite_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
      where id = g.id returning * into g;
  end if;
  return g.invite_code;
end $$;
revoke execute on function public.create_family_invite(boolean) from public, anon;
grant execute on function public.create_family_invite(boolean) to authenticated;

-- Anyone signed in: what an invite code points at (for the join screen). Null when the code is unknown.
create or replace function public.family_invite_info(code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'owner_id', p.id,
    'owner_name', p.display_name,
    'owner_avatar', p.avatar_url,
    'active', p.plan = 'family',
    'seats_used', (select count(*) from public.family_members m where m.group_id = g.id),
    'seats_total', 6,
    'is_member', exists (select 1 from public.family_members m where m.group_id = g.id and m.user_id = auth.uid())
  )
  from public.family_groups g
  join public.profiles p on p.id = g.owner_id
  where g.invite_code = upper(trim(code))
    and auth.uid() is not null;
$$;
revoke execute on function public.family_invite_info(text) from public, anon;
grant execute on function public.family_invite_info(text) to authenticated;

-- Join with a code. Only free accounts can join (joining would otherwise replace a paid plan).
create or replace function public.join_family(code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  g public.family_groups;
  owner_plan text;
  my_plan text;
  current_group uuid;
  seats int;
begin
  if me is null then raise exception 'not signed in'; end if;

  select * into g from public.family_groups where invite_code = upper(trim(code)) for update;
  if g.id is null then raise exception 'That invite code isn''t valid' using errcode = 'P0002', hint = 'invalid_code'; end if;
  if g.owner_id = me then raise exception 'This is your own family' using errcode = '22023', hint = 'own_family'; end if;

  select group_id into current_group from public.family_members where user_id = me;
  if current_group = g.id then return g.id; end if;
  if current_group is not null then
    raise exception 'You''re already in a family. Leave it first.' using errcode = '42501', hint = 'already_member';
  end if;

  select plan into owner_plan from public.profiles where id = g.owner_id;
  if owner_plan is distinct from 'family' then
    raise exception 'This family''s plan isn''t active' using errcode = '42501', hint = 'inactive';
  end if;

  select plan into my_plan from public.profiles where id = me;
  if my_plan is distinct from 'free' then
    raise exception 'You already have a paid plan. Cancel it before joining a family.' using errcode = '42501', hint = 'paid_plan';
  end if;

  select count(*) into seats from public.family_members where group_id = g.id;
  if seats >= 6 then raise exception 'This family is full (6 of 6 seats)' using errcode = '42501', hint = 'full'; end if;

  insert into public.family_members (group_id, user_id) values (g.id, me);
  update public.profiles set plan = 'family', updated_at = now() where id = me;

  perform public.notify_user(g.owner_id, 'family_join', 'New family member',
    public.display_name_of(me) || ' joined your Family plan',
    jsonb_build_object('user_id', me, 'actor_name', public.display_name_of(me), 'url', '/family'),
    'family');
  return g.id;
end $$;
revoke execute on function public.join_family(text) from public, anon;
grant execute on function public.join_family(text) to authenticated;

-- Owner removes a member; the member goes back to free.
create or replace function public.remove_family_member(member uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  gid uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  select id into gid from public.family_groups where owner_id = me;
  if gid is null then raise exception 'You don''t manage a family' using errcode = '42501'; end if;
  if member = me then raise exception 'You can''t remove yourself as the plan manager' using errcode = '22023'; end if;
  delete from public.family_members where group_id = gid and user_id = member;
  if not found then raise exception 'That person isn''t in your family' using errcode = 'P0002'; end if;
  update public.profiles set plan = 'free', updated_at = now() where id = member and plan = 'family';
end $$;
revoke execute on function public.remove_family_member(uuid) from public, anon;
grant execute on function public.remove_family_member(uuid) to authenticated;

-- A member leaves; they go back to free. (The owner keeps their own subscription; they cancel in the store.)
create or replace function public.leave_family() returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  gid uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  select m.group_id into gid from public.family_members m join public.family_groups g on g.id = m.group_id
  where m.user_id = me and g.owner_id <> me;
  if gid is null then raise exception 'You''re not a member of a family' using errcode = 'P0002'; end if;
  delete from public.family_members where group_id = gid and user_id = me;
  update public.profiles set plan = 'free', updated_at = now() where id = me and plan = 'family';
end $$;
revoke execute on function public.leave_family() from public, anon;
grant execute on function public.leave_family() to authenticated;

-- ───────────────────────────── plan propagation (security definer triggers; clients can't write plan)

-- Owner's plan changed → members follow: back on 'family' when the owner is, 'free' otherwise.
create or replace function public.on_family_owner_plan_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare gid uuid;
begin
  select id into gid from public.family_groups where owner_id = new.id;
  if gid is null then return new; end if;
  if new.plan = 'family' then
    update public.profiles p set plan = 'family', updated_at = now()
    from public.family_members m
    where m.group_id = gid and m.user_id = p.id and p.id <> new.id and p.plan = 'free';
  else
    update public.profiles p set plan = 'free', updated_at = now()
    from public.family_members m
    where m.group_id = gid and m.user_id = p.id and p.id <> new.id and p.plan = 'family';
  end if;
  return new;
end $$;
create trigger on_family_owner_plan_change after update of plan on public.profiles
  for each row when (old.plan is distinct from new.plan)
  execute function public.on_family_owner_plan_change();

-- A member's own billing (e.g. a store expiration event) must not knock them off an active family.
create or replace function public.keep_family_member_plan() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.plan = 'free' and exists (
    select 1 from public.family_members m
    join public.family_groups g on g.id = m.group_id
    join public.profiles o on o.id = g.owner_id
    where m.user_id = new.id and g.owner_id <> new.id and o.plan = 'family'
  ) then
    new.plan := 'family';
  end if;
  return new;
end $$;
create trigger keep_family_member_plan before update of plan on public.profiles
  for each row when (old.plan is distinct from new.plan)
  execute function public.keep_family_member_plan();

-- Group removed (e.g. the owner deleted their account) → members go back to free.
create or replace function public.on_family_group_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles p set plan = 'free', updated_at = now()
  from public.family_members m
  where m.group_id = old.id and m.user_id = p.id and p.id <> old.owner_id and p.plan = 'family';
  return old;
end $$;
create trigger on_family_group_delete before delete on public.family_groups
  for each row execute function public.on_family_group_delete();

-- Seat changes show up live on the Family screen.
alter publication supabase_realtime add table public.family_members;
