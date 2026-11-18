/**
 * Track comments (screen: track-comments; table: track_comments, migration 20261118110000).
 * Timestamped comments on a song ("0:42 · The drop here gave me chills"), with likes, delete (own) and
 * report. Reads skip blocked people and anything you reported (RLS); posting is rate limited server-side.
 */
import { friendlySocialError } from './social';
import { supabase } from './supabase';

export const TRACK_COMMENT_MAX = 500;

export type TrackComment = {
  id: string;
  user_id: string;
  body: string;
  at_seconds: number | null;
  created_at: string;
  author: { id: string; display_name: string; avatar_url: string | null; username: string | null };
  like_count: number;
  liked: boolean;
};

export type CommentSort = 'top' | 'new' | 'moment';

type Row = {
  id: string;
  user_id: string;
  body: string;
  at_seconds: number | null;
  created_at: string;
  display_name: string;
  avatar_url: string | null;
  username: string | null;
  like_count: number | string;
  liked: boolean;
};

const PAGE = 40;
const fail = (e: { message: string } | null, fallback: string) => {
  if (e && /does not exist|could not find the (table|function)/i.test(e.message)) throw new Error('Comments need the latest server update.');
  if (e) throw new Error(friendlySocialError(e, fallback));
};

export async function listTrackComments(trackId: string, sort: CommentSort, offset = 0): Promise<{ comments: TrackComment[]; more: boolean }> {
  const { data, error } = await supabase.rpc('list_track_comments', { p_track: trackId, p_sort: sort, p_limit: PAGE, p_offset: offset });
  fail(error, 'Could not load comments');
  const rows = (data ?? []) as Row[];
  return {
    comments: rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      body: r.body,
      at_seconds: r.at_seconds,
      created_at: r.created_at,
      author: { id: r.user_id, display_name: r.display_name, avatar_url: r.avatar_url, username: r.username },
      like_count: Number(r.like_count) || 0,
      liked: !!r.liked,
    })),
    more: rows.length === PAGE,
  };
}

export async function countTrackComments(trackId: string): Promise<number> {
  const { data, error } = await supabase.rpc('count_track_comments', { p_track: trackId });
  fail(error, 'Could not load comments');
  return Number(data) || 0;
}

export async function postTrackComment(trackId: string, body: string, atSeconds: number | null): Promise<void> {
  const text = body.trim();
  if (!text) throw new Error('Write something first.');
  if (text.length > TRACK_COMMENT_MAX) throw new Error(`Comments can be up to ${TRACK_COMMENT_MAX} characters.`);
  const { error } = await supabase.from('track_comments').insert({ track_id: trackId, body: text, at_seconds: atSeconds === null ? null : Math.max(0, Math.floor(atSeconds)) });
  if (error) throw new Error(error.message.includes('too fast') ? 'You are commenting too fast. Wait a minute and try again.' : friendlySocialError(error, 'Could not post your comment'));
}

export async function deleteTrackComment(id: string): Promise<void> {
  const { error } = await supabase.from('track_comments').delete().eq('id', id);
  fail(error, 'Could not delete the comment');
}

export async function setTrackCommentLiked(id: string, me: string, on: boolean): Promise<void> {
  const { error } = on
    ? await supabase.from('track_comment_likes').insert({ comment_id: id, user_id: me })
    : await supabase.from('track_comment_likes').delete().eq('comment_id', id).eq('user_id', me);
  // A repeated like (double tap) is not an error.
  if (error && error.code !== '23505') fail(error, 'Could not update your like');
}

export type ReportReason = 'spam' | 'abuse' | 'hate' | 'other';
export async function reportTrackComment(id: string, reason: ReportReason): Promise<void> {
  const { error } = await supabase.from('track_comment_reports').insert({ comment_id: id, reason });
  if (error && error.code !== '23505') fail(error, 'Could not send the report');
}

/** "0:42" / "1:05:09" */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** "now", "5m", "2h", "3d", "4w", "2y" */
export function ago(iso: string, now = Date.now()): string {
  const d = (now - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(d) || d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 604800) return `${Math.floor(d / 86400)}d`;
  if (d < 31536000) return `${Math.floor(d / 604800)}w`;
  return `${Math.floor(d / 31536000)}y`;
}
