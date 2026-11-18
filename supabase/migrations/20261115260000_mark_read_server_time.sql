-- Mark a conversation read using the SERVER clock.
--
-- Clients used to write last_read_at = new Date() from the phone. When the phone clock is behind the
-- server, messages (created_at = server now()) stay "newer than read", so inbox() keeps counting them
-- as unread and the Messages badge never drops. This RPC stamps now() (never moving backwards past the
-- newest message), marks the matching message notifications read, and counts as delivered too.

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
  update public.conversation_members
     set last_read_at = greatest(now(), coalesce(newest, now()), last_read_at),
         last_delivered_at = greatest(now(), coalesce(newest, now()), coalesce(last_delivered_at, now()))
   where conversation_id = cid and user_id = me;
  update public.notifications
     set read = true
   where user_id = me and read = false
     and kind in ('message', 'message_request', 'group_added')
     and payload ->> 'conversation_id' = cid::text;
end $$;
revoke execute on function public.mark_conversation_read(uuid) from public, anon;
grant execute on function public.mark_conversation_read(uuid) to authenticated;
