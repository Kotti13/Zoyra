-- Advanced chat: edit my own text messages for 15 minutes.
--
--   messages.edited_at        set when the sender edits a message (null = never edited). The same
--                             timestamp is mirrored into messages.meta->>'edited_at' so clients that
--                             select the existing column list (MSG_COLS) see the "Edited" state without
--                             a schema-dependent select.
--   edit_message(mid, body)   the sender changes the text of their own `kind = 'text'` message within
--                             15 minutes of sending it. Refused while either side has blocked the other
--                             and for messages that are not text (songs, polls, voice notes, call log…).
--
-- Realtime: `messages` is already in the supabase_realtime publication, so members receive the UPDATE.

alter table public.messages add column if not exists edited_at timestamptz;

create or replace function public.edit_message(mid uuid, new_body text) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.messages%rowtype;
  b text := btrim(coalesce(new_body, ''));
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into m from public.messages where id = mid for update;
  if not found or not public.is_conversation_member(m.conversation_id) then
    raise exception 'This message is no longer available.' using errcode = 'P0002';
  end if;
  if m.sender_id is distinct from auth.uid() then
    raise exception 'You can only edit your own messages.' using errcode = '42501';
  end if;
  if m.kind is distinct from 'text' then
    raise exception 'Only text messages can be edited.' using errcode = '22023';
  end if;
  if m.created_at < now() - interval '15 minutes' then
    raise exception 'Messages can only be edited for 15 minutes after sending.' using errcode = '22023';
  end if;
  if b = '' then raise exception 'Message is empty.' using errcode = '22023'; end if;
  if char_length(b) > 2000 then raise exception 'Message is too long.' using errcode = '22023'; end if;
  if exists (
    select 1
    from public.conversation_members cm
    join public.blocks bl
      on (bl.blocker_id = auth.uid() and bl.blocked_id = cm.user_id)
      or (bl.blocker_id = cm.user_id and bl.blocked_id = auth.uid())
    where cm.conversation_id = m.conversation_id and cm.user_id <> auth.uid()
  ) then
    raise exception 'You can''t message this person.' using errcode = '42501';
  end if;
  if b = m.body then return; end if;

  update public.messages
     set body = b,
         edited_at = now(),
         meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('edited_at', now())
   where id = mid;
end $$;
revoke execute on function public.edit_message(uuid, text) from public, anon;
grant execute on function public.edit_message(uuid, text) to authenticated;
