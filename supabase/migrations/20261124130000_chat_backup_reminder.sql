-- Remind people who chat but have no chat backup PIN to set one.
--
-- Chats are end-to-end encrypted with keys that live on the phone, so on a new phone older messages are
-- unreadable unless a backup PIN was set (e2ee_key_backups holds the encrypted backup). Anyone who has sent a
-- message and has no backup gets an in-app notification + push whose tap opens /e2ee-setup (data.url). This works
-- on every installed build: the push tap handler and the notification inbox already exist. Newer builds also show
-- an in-app popup (src/components/BackupPinPrompt.tsx).
--
-- Cadence per person: the first reminder as soon as they qualify, then after 1, 3, 7, 14, 14 days (6 in total),
-- and never again once a backup exists. Runs daily; the reminders are rows in public.notifications
-- (kind 'backup_reminder'), so the history is the cadence.

create or replace function public.remind_chat_backup() returns integer
language plpgsql security definer set search_path = public as $$
declare
  r record;
  sent int := 0;
begin
  for r in
    select p.id,
           (select count(*) from public.notifications n where n.user_id = p.id and n.kind = 'backup_reminder') as done,
           (select max(n.created_at) from public.notifications n where n.user_id = p.id and n.kind = 'backup_reminder') as last_at
    from public.profiles p
    where exists (select 1 from public.messages m where m.sender_id = p.id)
      and not exists (select 1 from public.e2ee_key_backups b where b.user_id = p.id)
  loop
    continue when r.done >= 6;
    continue when r.last_at is not null
      and r.last_at > now() - make_interval(days => (array[1, 3, 7, 14, 14])[least(r.done, 5)::int]);
    perform public.notify_user(r.id, 'backup_reminder', 'Back up your chats',
      'Set a 6-digit PIN so you can read your messages again if you switch phones.',
      jsonb_build_object('url', '/e2ee-setup'),
      'account_security');
    sent := sent + 1;
  end loop;
  return sent;
end $$;
revoke execute on function public.remind_chat_backup() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'zoyra-chat-backup-reminder';
  -- 13:30 UTC = 19:00 in India, mid-morning in Europe.
  perform cron.schedule('zoyra-chat-backup-reminder', '30 13 * * *', $cmd$select public.remind_chat_backup()$cmd$);
end $$;
