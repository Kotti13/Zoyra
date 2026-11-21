-- Community: edit your own post / reply, and nested replies (one level deep) under a reply.
--   community_posts.edited_at       set when the author changes the text
--   community_comments.parent_id    set on a nested reply; points at a top-level reply of the same post (a reply to a
--                                   nested reply is stored under the same top-level reply, the app adds an @mention)
--   community_comments.edited_at    set when the author changes the text
-- Clients may update only `body` (column-level grant), so counters and everything else stay server-controlled.

alter table public.community_posts add column if not exists edited_at timestamptz;
alter table public.community_comments
  add column if not exists parent_id uuid references public.community_comments (id) on delete cascade,
  add column if not exists edited_at timestamptz;
create index if not exists community_comments_parent_idx on public.community_comments (parent_id) where parent_id is not null;

-- Authors edit their own rows; only the text column is writable by clients.
drop policy if exists "author edits post" on public.community_posts;
create policy "author edits post" on public.community_posts for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "author edits comment" on public.community_comments;
create policy "author edits comment" on public.community_comments for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke update on public.community_posts from authenticated;
grant update (body) on public.community_posts to authenticated;
revoke update on public.community_comments from authenticated;
grant update (body) on public.community_comments to authenticated;

-- Posts: insert as before; on update, mark edited when the text changed (counter updates from the like / comment
-- triggers pass through untouched, they never change the text).
create or replace function public.community_posts_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.body := btrim(new.body);
    new.like_count := 0;
    new.comment_count := 0;
    new.edited_at := null;
    if (select count(*) from public.community_posts
        where user_id = new.user_id and created_at > now() - interval '10 minutes') >= 10 then
      raise exception 'You are posting too fast. Wait a few minutes and try again.';
    end if;
    return new;
  end if;
  if new.body is distinct from old.body then
    new.body := btrim(new.body);
    new.edited_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists community_posts_guard on public.community_posts;
create trigger community_posts_guard before insert or update on public.community_posts
  for each row execute function public.community_posts_guard();

-- Comments: insert as before plus a parent check; update marks edited when the text changed.
create or replace function public.community_comments_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.body := btrim(new.body);
    new.edited_at := null;
    if (select count(*) from public.community_comments
        where user_id = new.user_id and created_at > now() - interval '1 minute') >= 10 then
      raise exception 'You are commenting too fast. Wait a minute and try again.';
    end if;
    if new.parent_id is not null and not exists (
         select 1 from public.community_comments p
         where p.id = new.parent_id and p.post_id = new.post_id and p.parent_id is null) then
      raise exception 'You can only reply to a reply on the same post.';
    end if;
    return new;
  end if;
  if new.body is distinct from old.body then
    new.body := btrim(new.body);
    new.edited_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists community_comments_guard on public.community_comments;
create trigger community_comments_guard before insert or update on public.community_comments
  for each row execute function public.community_comments_guard();
