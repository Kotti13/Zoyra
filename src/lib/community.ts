/**
 * Community fan feed: `community_posts`, `community_likes`, `community_comments`
 * (migration 20261114161000_games_community.sql). Blocked users are filtered by RLS. Editing your own post / reply and
 * nested replies need migration 20261122110000_community_replies_edit.sql (without it they say so).
 */
import type { CatalogTrack } from './catalog';
import { supabase } from './supabase';

export const POST_MAX = 500;
export const PAGE = 30;

/** Snapshot of an Audius track stored with a post (enough to show and play it). */
export type PostTrack = Pick<CatalogTrack, 'id' | 'title' | 'duration' | 'artwork' | 'genre'> & { artist: { id: string; name: string; handle: string; verified: boolean } };

export type Author = { id: string; display_name: string; avatar_url: string | null; username: string | null };

export type Post = {
  id: string;
  user_id: string;
  body: string;
  track: PostTrack | null;
  artist_id: string | null;
  artist_name: string | null;
  like_count: number;
  comment_count: number;
  created_at: string;
  edited_at?: string | null;
  author: Author | null;
};

/** A reply to a post. `parent_id` is set on a nested reply (it hangs under a top-level reply, one level deep). */
export type Comment = { id: string; post_id: string; user_id: string; body: string; created_at: string; edited_at?: string | null; parent_id?: string | null; author: Author | null };

const AUTHOR = 'author:profiles(id, display_name, avatar_url, username)';

function friendly(e: { message: string }, fallback: string) {
  if (/parent_id|edited_at/.test(e.message) && /does not exist|schema cache/i.test(e.message)) return 'Replies to replies and editing need the latest server update.';
  if (/same post/i.test(e.message)) return 'That reply is no longer there.';
  if (/community_/.test(e.message) && /does not exist|schema cache/i.test(e.message)) return 'The community feed isn’t set up on the server yet.';
  return e.message || fallback;
}

/** CatalogTrack → the snapshot stored on a post. */
export const toPostTrack = (t: CatalogTrack): PostTrack => ({
  id: t.id,
  title: t.title,
  duration: t.duration,
  artwork: t.artwork,
  genre: t.genre,
  artist: { id: t.artist.id, name: t.artist.name, handle: t.artist.handle, verified: t.artist.verified },
});

/** Snapshot → a playable CatalogTrack (stats unknown, so zero). */
export const fromPostTrack = (t: PostTrack): CatalogTrack => ({ ...t, plays: 0, likes: 0 });

export type FeedFilter = { kind: 'all' } | { kind: 'following'; ids: string[] } | { kind: 'mine'; me: string } | { kind: 'artist'; id: string };

export async function loadFeed(filter: FeedFilter, before?: string): Promise<Post[]> {
  let q = supabase.from('community_posts').select(`*, ${AUTHOR}`).order('created_at', { ascending: false }).limit(PAGE);
  if (filter.kind === 'following') {
    if (!filter.ids.length) return [];
    q = q.in('user_id', filter.ids);
  } else if (filter.kind === 'mine') q = q.eq('user_id', filter.me);
  else if (filter.kind === 'artist') q = filter.id.startsWith('yta_') ? q.in('artist_id', [filter.id, `${filter.id} - Topic`]) : q.eq('artist_id', filter.id);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw new Error(friendly(error, 'Could not load the feed'));
  return (data ?? []) as unknown as Post[];
}

export async function loadPost(id: string): Promise<Post | null> {
  const { data, error } = await supabase.from('community_posts').select(`*, ${AUTHOR}`).eq('id', id).maybeSingle();
  if (error) throw new Error(friendly(error, 'Could not load the post'));
  return (data as unknown as Post | null) ?? null;
}

/** Ids of people you follow. */
export async function followingIds(me: string): Promise<string[]> {
  const { data, error } = await supabase.from('follows').select('following_id').eq('follower_id', me).limit(1000);
  if (error) throw new Error(error.message);
  return ((data ?? []) as { following_id: string }[]).map((r) => r.following_id);
}

/** Which of these posts you've liked. */
export async function myLikes(me: string, postIds: string[]): Promise<Set<string>> {
  if (!postIds.length) return new Set();
  const { data, error } = await supabase.from('community_likes').select('post_id').eq('user_id', me).in('post_id', postIds);
  if (error) throw new Error(friendly(error, 'Could not load your likes'));
  return new Set(((data ?? []) as { post_id: string }[]).map((r) => r.post_id));
}

/** `club`: the fan club the post is written in; it wins over the artist of the song attached to the post. */
export async function createPost(body: string, track: CatalogTrack | null, club?: { id: string; name: string } | null): Promise<Post> {
  const text = body.trim();
  if (!text) throw new Error('Write something first');
  if (text.length > POST_MAX) throw new Error(`Posts can be up to ${POST_MAX} characters`);
  const { data, error } = await supabase
    .from('community_posts')
    .insert({
      body: text,
      track: track ? toPostTrack(track) : null,
      artist_id: (club?.id ?? track?.artist.id ?? null)?.slice(0, 64) ?? null,
      artist_name: (club?.name ?? track?.artist.name ?? null)?.slice(0, 120) ?? null,
    })
    .select(`*, ${AUTHOR}`)
    .single();
  if (error) throw new Error(friendly(error, 'Could not post'));
  return data as unknown as Post;
}

export async function deletePost(id: string): Promise<void> {
  const { error } = await supabase.from('community_posts').delete().eq('id', id);
  if (error) throw new Error(friendly(error, 'Could not delete the post'));
}

export async function setLiked(postId: string, me: string, on: boolean): Promise<void> {
  const { error } = on
    ? await supabase.from('community_likes').insert({ post_id: postId, user_id: me })
    : await supabase.from('community_likes').delete().eq('post_id', postId).eq('user_id', me);
  // Already liked (duplicate key) is fine.
  if (error && !(on && error.code === '23505')) throw new Error(friendly(error, 'Could not update the like'));
}

export async function loadComments(postId: string): Promise<Comment[]> {
  const { data, error } = await supabase.from('community_comments').select(`*, ${AUTHOR}`).eq('post_id', postId).order('created_at', { ascending: true }).limit(200);
  if (error) throw new Error(friendly(error, 'Could not load comments'));
  return (data ?? []) as unknown as Comment[];
}

/** `parentId` makes it a nested reply under that top-level reply. */
export async function addComment(postId: string, body: string, parentId?: string | null): Promise<Comment> {
  const text = body.trim();
  if (!text) throw new Error('Write a reply first');
  if (text.length > POST_MAX) throw new Error(`Replies can be up to ${POST_MAX} characters`);
  const row: Record<string, unknown> = { post_id: postId, body: text };
  if (parentId) row.parent_id = parentId;
  const { data, error } = await supabase.from('community_comments').insert(row).select(`*, ${AUTHOR}`).single();
  if (error) throw new Error(friendly(error, 'Could not reply'));
  return data as unknown as Comment;
}

/** Change the text of your own post (the server marks it edited). */
export async function editPost(id: string, body: string): Promise<{ body: string; edited_at: string }> {
  const text = body.trim();
  if (!text) throw new Error('Write something first');
  if (text.length > POST_MAX) throw new Error(`Posts can be up to ${POST_MAX} characters`);
  const { data, error } = await supabase.from('community_posts').update({ body: text }).eq('id', id).select('body, edited_at').single();
  if (error) throw new Error(friendly(error, 'Could not save your change'));
  return data as { body: string; edited_at: string };
}

/** Change the text of your own reply. */
export async function editComment(id: string, body: string): Promise<{ body: string; edited_at: string }> {
  const text = body.trim();
  if (!text) throw new Error('Write a reply first');
  if (text.length > POST_MAX) throw new Error(`Replies can be up to ${POST_MAX} characters`);
  const { data, error } = await supabase.from('community_comments').update({ body: text }).eq('id', id).select('body, edited_at').single();
  if (error) throw new Error(friendly(error, 'Could not save your change'));
  return data as { body: string; edited_at: string };
}

export async function deleteComment(id: string): Promise<void> {
  const { error } = await supabase.from('community_comments').delete().eq('id', id);
  if (error) throw new Error(friendly(error, 'Could not delete the reply'));
}

/** "2h", "3d", "now". */
export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString();
}
