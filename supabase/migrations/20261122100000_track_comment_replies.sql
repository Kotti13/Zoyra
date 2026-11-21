-- Track comments: replies (one level deep), edit, and reply counts.
--   parent_id   set on a reply; points at a top-level comment of the same song (a reply to a reply is stored under the
--               same top-level comment, the app adds an @mention). Deleting a comment deletes its replies.
--   edited_at   set when the author changes the text.
-- list_track_comments now returns top-level comments only, with reply_count; list_track_replies pages one thread.
-- count_track_comments keeps counting everything (comments + replies).

alter table public.track_comments
  add column if not exists parent_id uuid references public.track_comments (id) on delete cascade,
  add column if not exists edited_at timestamptz;
create index if not exists track_comments_parent_idx on public.track_comments (parent_id, created_at) where parent_id is not null;

-- Authors may edit their own comment (the guard trigger below limits what can change).
drop policy if exists "author edits track comment" on public.track_comments;
create policy "author edits track comment" on public.track_comments for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Insert: server time, trimmed text, rate limit, and a reply must hang off a top-level comment of the same song.
-- Update: only the text can change (and edited_at is set); everything else stays as it was.
create or replace function public.track_comments_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.body := btrim(new.body);
    new.edited_at := null;
    if (select count(*) from public.track_comments
        where user_id = new.user_id and created_at > now() - interval '1 minute') >= 10 then
      raise exception 'You are commenting too fast. Wait a minute and try again.';
    end if;
    if new.parent_id is not null then
      if not exists (select 1 from public.track_comments p
                     where p.id = new.parent_id and p.track_id = new.track_id and p.parent_id is null) then
        raise exception 'You can only reply to a comment on the same song.';
      end if;
      new.at_seconds := null;
    end if;
    return new;
  end if;

  -- update
  new.id := old.id;
  new.user_id := old.user_id;
  new.track_id := old.track_id;
  new.parent_id := old.parent_id;
  new.at_seconds := old.at_seconds;
  new.created_at := old.created_at;
  new.body := btrim(new.body);
  if new.body is distinct from old.body then
    new.edited_at := now();
  else
    new.edited_at := old.edited_at;
  end if;
  return new;
end;
$$;
drop trigger if exists track_comments_guard on public.track_comments;
create trigger track_comments_guard before insert or update on public.track_comments
  for each row execute function public.track_comments_guard();

-- Top-level comments with author, like count, "liked by me", reply count and edited flag. SECURITY INVOKER: the
-- policies apply. p_sort: 'top' (most liked), 'new', or 'moment' (by timestamp in the song).
drop function if exists public.list_track_comments(text, text, integer, integer);
create or replace function public.list_track_comments(p_track text, p_sort text default 'new', p_limit integer default 50, p_offset integer default 0)
returns table (id uuid, user_id uuid, body text, at_seconds integer, created_at timestamptz,
               display_name text, avatar_url text, username text, like_count bigint, liked boolean,
               reply_count bigint, edited boolean)
language sql stable security invoker set search_path = public as $$
  select c.id, c.user_id, c.body, c.at_seconds, c.created_at,
         p.display_name, p.avatar_url, p.username,
         (select count(*) from public.track_comment_likes l where l.comment_id = c.id) as like_count,
         exists (select 1 from public.track_comment_likes l where l.comment_id = c.id and l.user_id = auth.uid()) as liked,
         (select count(*) from public.track_comments r where r.parent_id = c.id) as reply_count,
         c.edited_at is not null as edited
  from public.track_comments c
  join public.profiles p on p.id = c.user_id
  where c.track_id = p_track and c.parent_id is null
  order by
    case when p_sort = 'moment' then coalesce(c.at_seconds, 2147483647) end asc,
    case when p_sort = 'top' then (select count(*) from public.track_comment_likes l where l.comment_id = c.id) end desc,
    c.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100)) offset greatest(0, coalesce(p_offset, 0));
$$;

-- One thread: the replies to a comment, oldest first.
create or replace function public.list_track_replies(p_parent uuid, p_limit integer default 20, p_offset integer default 0)
returns table (id uuid, user_id uuid, body text, created_at timestamptz,
               display_name text, avatar_url text, username text, like_count bigint, liked boolean, edited boolean)
language sql stable security invoker set search_path = public as $$
  select c.id, c.user_id, c.body, c.created_at,
         p.display_name, p.avatar_url, p.username,
         (select count(*) from public.track_comment_likes l where l.comment_id = c.id) as like_count,
         exists (select 1 from public.track_comment_likes l where l.comment_id = c.id and l.user_id = auth.uid()) as liked,
         c.edited_at is not null as edited
  from public.track_comments c
  join public.profiles p on p.id = c.user_id
  where c.parent_id = p_parent
  order by c.created_at asc
  limit greatest(1, least(coalesce(p_limit, 20), 100)) offset greatest(0, coalesce(p_offset, 0));
$$;

grant execute on function public.list_track_comments(text, text, integer, integer) to authenticated;
grant execute on function public.list_track_replies(uuid, integer, integer) to authenticated;
