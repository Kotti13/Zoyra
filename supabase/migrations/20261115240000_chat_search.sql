-- Chat search (Chat search design): search across every chat I'm an active member of.
--
--   search_my_messages(q, kind_filter, lim)
--     kind_filter  'all'    text messages, captions, shared songs (title / artist), polls (question /
--                           options), playlists and jams whose text matches `q`. Empty `q` → no rows.
--                  'songs'  messages carrying a song (track / swap / lyric card). `q` matches title,
--                           artist or text; empty `q` → most recent shares.
--                  'voice'  voice notes. `q` matches the sender's or the chat's name; empty → all.
--                  'media'  photos. Same matching as 'voice'.
--                  'links'  messages whose text contains a URL. `q` matches the text; empty → all.
--                  'polls'  polls. `q` matches question / options; empty → all.
--     Only chats where the caller is an *active* member (no pending requests), only messages the
--     caller can still see (not cleared / hidden for me, not expired by disappearing messages), never
--     messages from someone the caller has a block with (either direction), and nothing from 1:1
--     chats across a block or with someone the caller restricts (same as inbox()).
--     `q` is matched with ILIKE on an escaped pattern (% _ \ are literal). Newest first, max 200.
--
--   Group fields (conversations.kind / title / avatar_url, added by the group chats migration) are
--   read through to_jsonb(c) so this function works before and after that migration.
--
--   Index: pg_trgm GIN on messages.body (speeds up ILIKE '%…%'); skipped if pg_trgm isn't available.

do $$
declare
  ext_schema text;
begin
  begin
    if exists (select 1 from pg_namespace where nspname = 'extensions') then
      create extension if not exists pg_trgm with schema extensions;
    else
      create extension if not exists pg_trgm;
    end if;
  exception when others then
    raise notice 'pg_trgm unavailable, skipping trigram index: %', sqlerrm;
    return;
  end;
  select n.nspname into ext_schema
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';
  if ext_schema is not null then
    execute format(
      'create index if not exists messages_body_trgm_idx on public.messages using gin (body %I.gin_trgm_ops)',
      ext_schema);
  end if;
end $$;

drop function if exists public.search_my_messages(text, text, int);
create function public.search_my_messages(q text, kind_filter text default 'all', lim int default 50)
returns table (
  id uuid, conversation_id uuid, kind text, snippet text, track jsonb, meta jsonb, created_at timestamptz,
  sender_id uuid, sender_name text, sender_avatar text,
  conversation_title text, conversation_avatar text, other_id uuid, other_name text, other_avatar text,
  is_group boolean, member_count int)
language sql stable security definer set search_path = public as $$
  with args as (
    select
      btrim(coalesce(q, '')) as term,
      '%' || replace(replace(replace(btrim(coalesce(q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
      case when lower(coalesce(kind_filter, 'all')) in ('songs', 'voice', 'media', 'links', 'polls')
           then lower(kind_filter) else 'all' end as f,
      least(greatest(coalesce(lim, 50), 1), 200) as n
  ), convs as (
    -- My active chats + their shape (1:1 partner, member count, group fields when present).
    select c.id as cid, c.disappear_seconds, c.disappear_since,
           to_jsonb(c) as cj,
           o.n + 1 as members, o.other_id
    from public.conversation_members me
    join public.conversations c on c.id = me.conversation_id
    cross join lateral (
      select count(*)::int as n, (array_agg(om.user_id order by om.user_id))[1] as other_id
      from public.conversation_members om
      where om.conversation_id = c.id and om.user_id <> auth.uid()
    ) o
    where me.user_id = auth.uid() and me.status = 'active'
  ), shaped as (
    select convs.*,
           coalesce(convs.cj ->> 'kind' = 'group', false) or convs.members > 2 as grp
    from convs
    where not (
      convs.members = 2 and convs.other_id is not null
      and coalesce(convs.cj ->> 'kind', 'dm') <> 'group'
      and (public.blocked_with(convs.other_id) or public.restricts(auth.uid(), convs.other_id))
    )
  ), hits as (
    select m.id, m.conversation_id, m.kind, m.body, m.track, m.meta, m.created_at, m.sender_id,
           s.grp, s.members, s.other_id, s.cj, a.term, a.pat, a.f,
           sp.display_name as sender_name, sp.avatar_url as sender_avatar,
           op.display_name as other_name, op.avatar_url as other_avatar
    from args a
    cross join shaped s
    join public.messages m on m.conversation_id = s.cid
    left join public.profiles sp on sp.id = m.sender_id
    left join public.profiles op on op.id = s.other_id
    where auth.uid() is not null
      and (a.f <> 'all' or a.term <> '')
      and m.kind <> 'call'
      and not exists (select 1 from public.message_hidden h where h.user_id = auth.uid() and h.message_id = m.id)
      and not (s.disappear_seconds is not null and s.disappear_since is not null
               and m.created_at >= s.disappear_since
               and m.created_at < now() - make_interval(secs => s.disappear_seconds))
      and (m.sender_id = auth.uid() or not public.blocked_with(m.sender_id))
      and case a.f
        when 'all' then
          m.body ilike a.pat
          or (m.track is not null and (m.track ->> 'title' ilike a.pat
                                       or coalesce(m.track -> 'artist' ->> 'name', m.track ->> 'artist') ilike a.pat))
          or (m.kind = 'poll' and (m.meta ->> 'question' ilike a.pat or (m.meta -> 'options')::text ilike a.pat))
          or (m.kind in ('playlist', 'jam', 'live') and (m.meta ->> 'title' ilike a.pat or m.meta ->> 'name' ilike a.pat))
          or (m.kind = 'lyric' and m.meta ->> 'line' ilike a.pat)
        when 'songs' then
          (m.kind in ('track', 'swap') or m.track is not null or (m.kind = 'lyric' and m.meta ? 'track'))
          and (a.term = ''
               or m.body ilike a.pat
               or coalesce(m.track, m.meta -> 'track') ->> 'title' ilike a.pat
               or coalesce(coalesce(m.track, m.meta -> 'track') -> 'artist' ->> 'name',
                           coalesce(m.track, m.meta -> 'track') ->> 'artist') ilike a.pat)
        when 'voice' then
          m.kind = 'voice'
          and (a.term = '' or sp.display_name ilike a.pat or op.display_name ilike a.pat or s.cj ->> 'title' ilike a.pat)
        when 'media' then
          m.kind = 'photo'
          and (a.term = '' or m.body ilike a.pat or sp.display_name ilike a.pat or op.display_name ilike a.pat
               or s.cj ->> 'title' ilike a.pat)
        when 'links' then
          m.body ~* '(https?://|www\.)[^[:space:]]+'
          and (a.term = '' or m.body ilike a.pat)
        when 'polls' then
          m.kind = 'poll'
          and (a.term = '' or m.meta ->> 'question' ilike a.pat or (m.meta -> 'options')::text ilike a.pat)
        else false
      end
    order by m.created_at desc
    limit (select n from args)
  )
  select h.id, h.conversation_id, h.kind,
    case
      when coalesce(h.body, '') <> '' and h.kind in ('text', 'track', 'photo') then
        case
          when char_length(h.body) <= 160 then h.body
          else (
            -- ~160 characters around the first match.
            with p as (select greatest(strpos(lower(h.body), lower(h.term)) - 50, 1) as st)
            select case when p.st > 1 then '…' else '' end
                   || substr(h.body, p.st, 160)
                   || case when p.st + 160 <= char_length(h.body) then '…' else '' end
            from p)
        end
      else public.message_preview(h.kind, h.body, h.track, h.meta)
    end,
    h.track, h.meta, h.created_at,
    h.sender_id, h.sender_name, h.sender_avatar,
    nullif(btrim(h.cj ->> 'title'), ''), nullif(h.cj ->> 'avatar_url', ''),
    case when h.grp then null else h.other_id end,
    case when h.grp then null else h.other_name end,
    case when h.grp then null else h.other_avatar end,
    h.grp, h.members
  from hits h
  order by h.created_at desc;
$$;
revoke execute on function public.search_my_messages(text, text, int) from public, anon;
grant execute on function public.search_my_messages(text, text, int) to authenticated;
