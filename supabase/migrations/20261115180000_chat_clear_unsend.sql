-- Chat: Clear chat (for me) and Unsend (delete for everyone).
--
--   clear_chat(cid, keep_pinned, keep_media)
--                                 hides every message currently in the conversation for the caller
--                                 (rows in message_hidden), optionally keeping pinned messages and/or
--                                 photos + voice notes. The other member keeps their copy and new
--                                 messages show up as usual. Returns how many messages were hidden.
--   unsend_message(mid)           the sender deletes their own message for both members. Reactions,
--                                 pins, poll votes, hidden rows and swap ratings cascade; replies keep
--                                 their text (reply_to is set null). Scheduled messages are untouched.
--                                 Call log messages (kind 'call') can't be unsent.
--
-- Note: media for unsent voice notes / photos stays in the chat-media bucket (storage objects can't
-- be removed from SQL); the message pointing at it is gone, so members can no longer open it.

-- ═════════════════════════════════════════════ clear chat (for me)
create or replace function public.clear_chat(cid uuid, keep_pinned boolean default false, keep_media boolean default false) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if cid is null or not public.is_conversation_member(cid) then
    raise exception 'This conversation is no longer available.' using errcode = '42501';
  end if;

  insert into public.message_hidden (user_id, message_id)
  select auth.uid(), m.id
  from public.messages m
  where m.conversation_id = cid
    and m.created_at <= now()
    and not (coalesce(keep_pinned, false) and exists (select 1 from public.message_pins p where p.message_id = m.id))
    and not (coalesce(keep_media, false) and m.kind in ('photo', 'voice'))
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.clear_chat(uuid, boolean, boolean) from public, anon;
grant execute on function public.clear_chat(uuid, boolean, boolean) to authenticated;

-- ═════════════════════════════════════════════ unsend (delete for everyone)
create or replace function public.unsend_message(mid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.messages%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into m from public.messages where id = mid;
  if not found or not public.is_conversation_member(m.conversation_id) then
    raise exception 'This message is no longer available.' using errcode = 'P0002';
  end if;
  if m.sender_id is distinct from auth.uid() then
    raise exception 'You can only unsend your own messages.' using errcode = '42501';
  end if;
  if m.kind = 'call' then
    raise exception 'Call history can''t be unsent.' using errcode = '22023';
  end if;
  delete from public.messages where id = mid;
end $$;
revoke execute on function public.unsend_message(uuid) from public, anon;
grant execute on function public.unsend_message(uuid) to authenticated;
