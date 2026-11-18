-- Backfill message requests for conversations created before the request system
-- (20261115120000_dm_requests_privacy.sql). Those rows all defaulted to status 'active', so
-- dm_access() / start_conversation() treated them as accepted chats and new messages from people who
-- are not mutual friends went straight into the inbox instead of Message requests.
--
-- Rule (MessagingFlow design: mutual friends chat directly, everyone else is a request):
--   * 1:1 conversations only, created before the request system shipped.
--   * Skip mutual follows (they are direct by design).
--   * Skip conversations where BOTH people have sent a message (they already talk = accepted).
--   * If exactly one person wrote, that person is the initiator; the other member becomes a pending
--     request ('request', requested_at = first message time) unless blocked either way.
--   * Empty conversations (nobody wrote) are deleted; start_conversation recreates them under the rules.
--   * conversations.created_by is filled with the initiator where missing.
-- No notifications are sent. Idempotent: only touches rows still 'active' with the conditions above.

do $$
declare
  cutoff timestamptz := '2026-11-15 12:00:00+00';
begin
  -- Empty legacy 1:1 conversations.
  delete from public.conversations c
  where c.created_at < cutoff
    and (select count(*) from public.conversation_members m where m.conversation_id = c.id) = 2
    and not exists (select 1 from public.messages x where x.conversation_id = c.id);

  with pairs as (
    select c.id as cid, c.created_at,
           min(m.user_id::text)::uuid as a, max(m.user_id::text)::uuid as b
    from public.conversations c
    join public.conversation_members m on m.conversation_id = c.id
    where c.created_at < cutoff
    group by c.id, c.created_at
    having count(*) = 2
  ),
  writers as (
    select p.cid, p.a, p.b,
           exists (select 1 from public.messages x where x.conversation_id = p.cid and x.sender_id = p.a) as a_wrote,
           exists (select 1 from public.messages x where x.conversation_id = p.cid and x.sender_id = p.b) as b_wrote
    from pairs p
  ),
  one_sided as (
    select w.cid,
           case when w.a_wrote then w.a else w.b end as initiator,
           case when w.a_wrote then w.b else w.a end as recipient
    from writers w
    where w.a_wrote <> w.b_wrote
  ),
  targets as (
    select o.*,
           (select min(x.created_at) from public.messages x where x.conversation_id = o.cid) as first_at
    from one_sided o
    where not (
        exists (select 1 from public.follows f where f.follower_id = o.initiator and f.following_id = o.recipient)
        and exists (select 1 from public.follows f where f.follower_id = o.recipient and f.following_id = o.initiator)
      )
      and not exists (select 1 from public.blocks bl
                      where (bl.blocker_id = o.initiator and bl.blocked_id = o.recipient)
                         or (bl.blocker_id = o.recipient and bl.blocked_id = o.initiator))
  ),
  upd as (
    update public.conversation_members m
    set status = 'request', requested_at = coalesce(m.requested_at, t.first_at)
    from targets t
    where m.conversation_id = t.cid and m.user_id = t.recipient and m.status = 'active'
    returning t.cid, t.initiator
  )
  update public.conversations c
  set created_by = u.initiator
  from upd u
  where c.id = u.cid and c.created_by is null;
end $$;
