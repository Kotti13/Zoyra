-- Zoyra: group chat-message notifications per conversation.
--
-- Before: every message inserted one `notifications` row (and one push), so a burst of messages from
-- one person flooded the inbox. Now, when the recipient already has an UNREAD `message` row for the
-- same conversation, notify_user UPDATES that row instead of inserting a new one:
--   payload.count     += 1
--   payload.title/body/preview, sender_id, actor_name, message_id, url  → the latest message
--   payload.previews   last 5 messages, oldest → newest: [{ message_id, sender_id, actor_name, body, at }]
--   created_at         = now()   (so the group sorts to the top)
-- Once the row is read (chat opened / marked read), the next message starts a new row (count 1).
--
-- Realtime: the update is an ordinary UPDATE on public.notifications (already in supabase_realtime),
-- so subscribed clients get an UPDATE event carrying the full new row.
-- Push: still sent for every message; `data` now also carries `count` and `conversation_id` so the
-- push function can say "3 new messages" and collapse/thread them per conversation.
-- RLS: unchanged. Every other kind takes exactly the previous insert path.

create or replace function public.notify_user(
  recipient uuid, p_kind text, p_title text, p_body text, p_payload jsonb, p_category text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  secret text;
  nid uuid;
  prev jsonb;
  cnt int := 1;
  conv text := case when p_kind = 'message' then nullif(p_payload ->> 'conversation_id', '') end;
  item jsonb;
  previews jsonb;
begin
  if recipient is null then return; end if;

  if conv is not null then
    item := jsonb_build_object(
      'message_id', p_payload -> 'message_id',
      'sender_id', p_payload -> 'sender_id',
      'actor_name', p_payload -> 'actor_name',
      'body', p_body,
      'at', now());

    -- Serialise concurrent messages for the same (recipient, conversation) so they can't both insert.
    perform pg_advisory_xact_lock(hashtextextended('notif:' || recipient::text || ':' || conv, 0));

    select n.id, n.payload into nid, prev
    from public.notifications n
    where n.user_id = recipient and n.kind = 'message' and n.read = false
      and n.payload ->> 'conversation_id' = conv
    order by n.created_at desc
    limit 1
    for update;

    if nid is not null then
      cnt := coalesce(case when jsonb_typeof(prev -> 'count') = 'number' then (prev ->> 'count')::int end, 1) + 1;
      previews := case
        when jsonb_typeof(prev -> 'previews') = 'array' then prev -> 'previews'
        -- rows written before this migration: seed with their single message
        else jsonb_build_array(jsonb_build_object(
          'message_id', prev -> 'message_id', 'sender_id', prev -> 'sender_id',
          'actor_name', prev -> 'actor_name', 'body', prev -> 'body', 'at', null))
      end || jsonb_build_array(item);
      -- keep the last 5
      select coalesce(jsonb_agg(e order by i), '[]'::jsonb) into previews
      from jsonb_array_elements(previews) with ordinality as t(e, i)
      where i > jsonb_array_length(previews) - 5;

      update public.notifications
      set payload = prev || coalesce(p_payload, '{}'::jsonb) || jsonb_build_object(
            'title', p_title, 'body', p_body, 'preview', p_body, 'count', cnt, 'previews', previews),
          created_at = now()
      where id = nid;
    end if;
  end if;

  if nid is null then
    insert into public.notifications (user_id, kind, payload)
    values (recipient, p_kind,
      coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('title', p_title, 'body', p_body)
        || case when conv is not null
             then jsonb_build_object('preview', p_body, 'count', 1, 'previews', jsonb_build_array(item))
             else '{}'::jsonb end)
    returning id into nid;
  end if;

  begin
    select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_webhook_secret' limit 1;
    if coalesce(secret, '') = '' then return; end if;  -- push not set up: in-app inbox only
    perform net.http_post(
      url := 'https://vmdkgkgyzflvqsvecava.supabase.co/functions/v1/push',
      body := jsonb_build_object(
        'user_id', recipient,
        'title', p_title,
        'body', p_body,
        -- Expo data contract: { url, kind, notification_id } (+ category for the push function's prefs check,
        -- + count / conversation_id for per-conversation grouping)
        'data', jsonb_build_object(
          'url', coalesce(p_payload ->> 'url', '/notifications'),
          'kind', p_kind,
          'notification_id', nid,
          'actor_name', p_payload ->> 'actor_name',
          'category', p_category)
          || case when conv is not null
               then jsonb_build_object('conversation_id', conv, 'count', cnt)
               else '{}'::jsonb end
      ),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret),
      timeout_milliseconds := 5000
    );
  exception when others then
    -- Vault / pg_net unavailable or misconfigured: skip push silently.
    null;
  end;
end $$;
revoke execute on function public.notify_user(uuid, text, text, text, jsonb, text) from public, anon, authenticated;

-- Lookup used above: unread message rows per recipient + conversation.
create index if not exists notifications_unread_message_conv_idx
  on public.notifications (user_id, (payload ->> 'conversation_id'))
  where kind = 'message' and read = false;
