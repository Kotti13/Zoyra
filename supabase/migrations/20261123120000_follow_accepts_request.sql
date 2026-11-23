-- Following someone settles a pending message request between the two of you.
--
-- Bug: a 1:1 chat whose member row was 'request' / 'filtered' stayed that way after the follow graph changed,
-- so the chat kept showing "<name> wants to message you ... Accept" even after you followed them (or after both
-- of you followed each other, which dm_access() treats as 'direct').
--
-- Rule now: when A follows B,
--   * A's own pending row in their 1:1 chat with B becomes 'active' (following them is "I'm fine hearing from you"), and
--   * if B already follows A (mutual), B's pending row becomes 'active' too, so a request A sent is no longer pending.
-- Groups are untouched (a conversation with exactly two members only). Existing rows are fixed by the backfill below.

create or replace function public.follow_settles_requests() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- A's side: requests B sent to A.
  update public.conversation_members m set status = 'active'
  where m.user_id = new.follower_id
    and m.status <> 'active'
    and exists (select 1 from public.conversation_members o
                where o.conversation_id = m.conversation_id and o.user_id = new.following_id)
    and (select count(*) from public.conversation_members x where x.conversation_id = m.conversation_id) = 2;

  -- Mutual: B's side too (requests A sent to B).
  if exists (select 1 from public.follows f where f.follower_id = new.following_id and f.following_id = new.follower_id) then
    update public.conversation_members m set status = 'active'
    where m.user_id = new.following_id
      and m.status <> 'active'
      and exists (select 1 from public.conversation_members o
                  where o.conversation_id = m.conversation_id and o.user_id = new.follower_id)
      and (select count(*) from public.conversation_members x where x.conversation_id = m.conversation_id) = 2;
  end if;
  return new;
end $$;
revoke execute on function public.follow_settles_requests() from public, anon, authenticated;

drop trigger if exists follows_settle_requests on public.follows;
create trigger follows_settle_requests after insert on public.follows
  for each row execute function public.follow_settles_requests();

-- Backfill: anyone who already follows the other person should not be left with a pending request from them.
update public.conversation_members m set status = 'active'
where m.status <> 'active'
  and (select count(*) from public.conversation_members x where x.conversation_id = m.conversation_id) = 2
  and exists (
    select 1
    from public.conversation_members o
    join public.follows f on f.follower_id = m.user_id and f.following_id = o.user_id
    where o.conversation_id = m.conversation_id and o.user_id <> m.user_id
  );
