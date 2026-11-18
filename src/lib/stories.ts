import type { CatalogTrack } from './catalog';
import { supabase } from './supabase';

/**
 * Stories: 24-hour posts (kicker + text, optionally over a song's cover) from people you follow and yourself.
 * The server (`artist_stories` RLS) decides who can see what; likes / views are per viewer.
 */
export type Story = { id: string; author_id: string; kicker: string; body: string; track: CatalogTrack | null; created_at: string; expires_at: string };
export type StoryAuthor = { id: string; display_name: string; avatar_url: string | null };
export type StoryGroup = { author: StoryAuthor; stories: Story[]; seen: boolean; mine: boolean };

export async function loadStoryGroups(me: string): Promise<StoryGroup[]> {
  const s = await supabase.from('artist_stories').select('id, author_id, kicker, body, track, created_at, expires_at').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: true }).limit(300);
  if (s.error) throw new Error(s.error.message);
  const stories = (s.data ?? []) as Story[];
  if (!stories.length) return [];
  const authorIds = [...new Set(stories.map((x) => x.author_id))];
  const [p, v] = await Promise.all([
    supabase.from('profiles').select('id, display_name, avatar_url').in('id', authorIds),
    supabase.from('story_views').select('story_id').eq('user_id', me).in('story_id', stories.map((x) => x.id)),
  ]);
  if (p.error) throw new Error(p.error.message);
  const seen = new Set(((v.data ?? []) as { story_id: string }[]).map((r) => r.story_id));
  const people = new Map(((p.data ?? []) as StoryAuthor[]).map((a) => [a.id, a]));
  const groups: StoryGroup[] = authorIds
    .map((id) => {
      const mine = stories.filter((x) => x.author_id === id);
      return { author: people.get(id) ?? { id, display_name: 'Someone', avatar_url: null }, stories: mine, seen: mine.every((x) => seen.has(x.id)), mine: id === me };
    });
  // Yours first, then unseen, then seen; newest activity first within each.
  const latest = (g: StoryGroup) => g.stories[g.stories.length - 1]?.created_at ?? '';
  return groups.sort((a, b) => Number(b.mine) - Number(a.mine) || Number(a.seen) - Number(b.seen) || latest(b).localeCompare(latest(a)));
}

export async function markStoryViewed(id: string): Promise<void> {
  await supabase.from('story_views').upsert({ story_id: id }, { onConflict: 'story_id,user_id', ignoreDuplicates: true });
}

export async function loadStoryLikes(ids: string[], me: string): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { data } = await supabase.from('story_likes').select('story_id').eq('user_id', me).in('story_id', ids);
  return new Set(((data ?? []) as { story_id: string }[]).map((r) => r.story_id));
}

export async function setStoryLiked(id: string, me: string, on: boolean): Promise<void> {
  const r = on ? await supabase.from('story_likes').upsert({ story_id: id, user_id: me }, { onConflict: 'story_id,user_id', ignoreDuplicates: true }) : await supabase.from('story_likes').delete().eq('story_id', id).eq('user_id', me);
  if (r.error) throw new Error(r.error.message);
}

/** Viewer counts for my own story (views and likes are readable by the author). */
export async function loadStoryStats(id: string): Promise<{ views: number; likes: number }> {
  const [v, l] = await Promise.all([
    supabase.from('story_views').select('story_id', { count: 'exact', head: true }).eq('story_id', id),
    supabase.from('story_likes').select('story_id', { count: 'exact', head: true }).eq('story_id', id),
  ]);
  return { views: v.count ?? 0, likes: l.count ?? 0 };
}

export async function postStory(input: { kicker: string; body: string; track: CatalogTrack | null }): Promise<void> {
  const body = input.body.trim();
  if (!body) throw new Error('Write something for your story');
  const { error } = await supabase.from('artist_stories').insert({ kicker: input.kicker.trim().slice(0, 32), body: body.slice(0, 280), track: input.track });
  if (error) throw new Error(error.message.includes('story_limit') ? 'You can have up to 8 live stories. Delete one first.' : error.message);
}

export async function deleteStory(id: string): Promise<void> {
  const { error } = await supabase.from('artist_stories').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export function storyAge(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
