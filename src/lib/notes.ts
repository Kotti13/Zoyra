/**
 * Notes (Instagram-style) for the Messages inbox: a short text (≤ 60 chars) and/or a song, visible for
 * 24 hours only to mutual followers (people you follow who follow you back; the server enforces it, and an
 * unfollow hides the note at once). One active note per user; posting replaces it.
 * Backend: supabase/migrations/20261115330000_user_notes.sql (user_notes, post_note, delete_note, list_notes) and
 * 20261117120000_notes_v2_last_seen.sql (views, reactions, replies: view_note, react_to_note, record_note_reply,
 * note_insights, note_audience; list_notes + my_reaction / seen). Views, reactions and replies belong to the
 * current note: posting, editing or deleting it starts over.
 */
import type { CatalogTrack } from './catalog';
import { sendMessage } from './chat';
import { startChat } from './dm';
import { friendlySocialError } from './social';
import { supabase } from './supabase';

export const NOTE_MAX = 60;

/** Who sees a note (fixed: mutual followers only). */
export const NOTE_AUDIENCE_HINT = 'Visible to people you follow who follow you back · 24 hours';

/** Reactions friends can leave on a note (one per person, changeable). Same list as the server check. */
export const NOTE_REACTIONS = ['❤️', '🔥', '😂', '😮', '👏', '🎶'] as const;
export type NoteReaction = (typeof NOTE_REACTIONS)[number];

/**
 * Song saved on a note: enough to show it and to play it (refreshed from the catalog on play), plus the
 * 30-second clip friends hear when they tap it (`clip_start` whole seconds, `clip_len` ≤ 30; older notes
 * have no clip and play from 0:00).
 */
export type NoteTrack = Pick<CatalogTrack, 'id' | 'title' | 'artist' | 'artwork'> &
  Partial<Pick<CatalogTrack, 'duration' | 'streamUrl' | 'url' | 'plays' | 'likes' | 'explicit'>> & { clip_start?: number; clip_len?: number };

export type UserNote = {
  user_id: string;
  text: string | null;
  track: NoteTrack | null;
  created_at: string;
  expires_at: string;
  display_name: string;
  avatar_url: string | null;
  mine: boolean;
  /** My reaction to this note (friends' notes; null / missing before the notes v2 migration). */
  my_reaction?: string | null;
  /** I opened this note already. */
  seen?: boolean;
};

/** Owner's summary for the active note ("Seen by 12 · 8 likes · 3 replies"). */
export type NoteInsights = { views: number; likes: number; replies: number; faces: { id: string; display_name: string; avatar_url: string | null }[] };

/** One person in "Seen by": viewed / reacted / replied (times are ISO strings). */
export type NoteAudienceRow = {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  seen_at: string | null;
  emoji: string | null;
  reacted_at: string | null;
  replies: number;
  replied_at: string | null;
};

const noteError = (e: unknown, fallback: string) => {
  const err = (e ?? {}) as { hint?: string; message?: string };
  if (err.hint?.startsWith('note_') && err.message) return err.message;
  return friendlySocialError(e, fallback);
};

/** Trimmed song for the note (the server caps the jsonb at 4 KB). Keeps the clip when `t` has one. */
export function noteTrackOf(t: CatalogTrack | NoteTrack): NoteTrack {
  const artist = { id: t.artist.id, name: t.artist.name, handle: t.artist.handle, verified: t.artist.verified };
  const out: NoteTrack = { id: t.id, title: t.title.slice(0, 200), artist, artwork: t.artwork, duration: t.duration, plays: t.plays, likes: t.likes };
  if (t.streamUrl) out.streamUrl = t.streamUrl;
  if (t.url) out.url = t.url;
  if (t.explicit) out.explicit = true;
  const clip = (t as NoteTrack).clip_start;
  if (typeof clip === 'number' && Number.isFinite(clip) && clip >= 0) {
    out.clip_start = Math.floor(clip);
    const len = (t as NoteTrack).clip_len;
    out.clip_len = typeof len === 'number' && len >= 1 ? Math.min(30, Math.round(len)) : 30;
  }
  return out;
}

/** The note song with its chosen clip (whole seconds; `len` ≤ 30, shorter for short songs). */
export function withClip(t: NoteTrack, start: number, len: number): NoteTrack {
  return { ...t, clip_start: Math.max(0, Math.floor(start)), clip_len: Math.max(1, Math.min(30, Math.round(len))) };
}

/** "Expires in 18h" / "Expires in 25m" / "Expires soon". */
export function noteExpiresIn(iso: string): string {
  const m = Math.floor((new Date(iso).getTime() - Date.now()) / 60_000);
  if (m < 1) return 'Expires soon';
  if (m < 60) return `Expires in ${m}m`;
  return `Expires in ${Math.floor(m / 60)}h`;
}

/** Full catalog-shaped track for the player (missing counters filled with 0). */
export function playableNoteTrack(t: NoteTrack): CatalogTrack {
  return { duration: 0, plays: 0, likes: 0, ...t };
}

/** "Song · Artist". */
export function noteSongLine(t: NoteTrack | null | undefined): string | null {
  if (!t?.title) return null;
  const artist = typeof t.artist === 'object' && t.artist ? t.artist.name : '';
  return artist ? `${t.title} · ${artist}` : t.title;
}

/** Short label for a bubble: the text, else "🎵 Song". */
export function noteBubbleText(n: Pick<UserNote, 'text' | 'track'>): string {
  if (n.text) return n.text;
  return n.track ? `🎵 ${n.track.title}` : '';
}

/** "2h ago" / "now" since the note was posted. */
export function noteAgo(iso: string): string {
  const a = noteAge(iso);
  return a === 'now' ? 'now' : `${a} ago`;
}

/** "22h left" / "25m left" / "ending soon". */
export function noteLeft(iso: string): string {
  const m = Math.floor((new Date(iso).getTime() - Date.now()) / 60_000);
  if (m < 1) return 'ending soon';
  if (m < 60) return `${m}m left`;
  return `${Math.floor(m / 60)}h left`;
}

/** "3h" / "12m" since the note was posted. */
export function noteAge(iso: string): string {
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/** My note (first, when active) and the visible notes of people I follow, newest first. */
export async function listNotes(): Promise<UserNote[]> {
  const { data, error } = await supabase.rpc('list_notes');
  if (error) throw new Error(noteError(error, 'Could not load notes'));
  return ((data ?? []) as UserNote[]).filter((n) => n.text || n.track);
}

/** Posts (or replaces) my note; it stays up for 24 hours. */
export async function postNote({ text, track }: { text?: string | null; track?: CatalogTrack | NoteTrack | null }): Promise<UserNote> {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length > NOTE_MAX) throw new Error(`Notes can be up to ${NOTE_MAX} characters.`);
  if (!clean && !track) throw new Error('Write something or add a song.');
  const t = track ? noteTrackOf(track) : null;
  const { data, error } = await supabase.rpc('post_note', { p_text: clean || null, p_track: t });
  if (error) throw new Error(noteError(error, 'Could not share your note'));
  return data as UserNote;
}

export async function deleteNote(): Promise<void> {
  const { error } = await supabase.rpc('delete_note');
  if (error) throw new Error(noteError(error, 'Could not delete your note'));
}

/**
 * Replies to a friend's note in a DM ("Replied to your note: …"). Goes through `sendMessage`, so it is
 * end-to-end encrypted like every other message. Returns the conversation id (and whether it went out as a
 * request). May throw E2EESetupRequired (callers: routeIfSetupRequired).
 */
export async function replyToNote(note: Pick<UserNote, 'user_id' | 'text' | 'track'>, me: string, reply: string): Promise<{ id: string; request: boolean }> {
  const body = reply.trim();
  if (!body) throw new Error('Write a reply first.');
  const quoted = note.text ?? (note.track ? `🎵 ${noteSongLine(note.track)}` : '');
  const chat = await startChat(note.user_id);
  await sendMessage(chat.id, me, { body: `Replied to your note: “${quoted}”\n${body}`, kind: 'text' });
  // Counts the reply for the note's owner ("3 replies"); the DM itself stays end-to-end encrypted.
  void supabase.rpc('record_note_reply', { p_owner: note.user_id }).then(
    () => undefined,
    () => undefined,
  );
  return chat;
}

/** Records that I opened a friend's note (no-op for my own note / before the notes v2 migration). */
export async function viewNote(owner: string): Promise<void> {
  const { error } = await supabase.rpc('view_note', { p_owner: owner });
  if (error && error.code !== 'PGRST202') throw new Error(noteError(error, 'Could not open this note'));
}

/** Sets, changes or (with null) clears my reaction to a friend's note. */
export async function reactToNote(owner: string, emoji: NoteReaction | null): Promise<string | null> {
  const { data, error } = await supabase.rpc('react_to_note', { p_owner: owner, p_emoji: emoji });
  if (error) throw new Error(noteError(error, 'Could not react to this note'));
  return (data as string | null) ?? null;
}

/** "Seen by N · likes · replies" for my active note (zeros when there is none). */
export async function noteInsights(): Promise<NoteInsights> {
  const { data, error } = await supabase.rpc('note_insights');
  if (error) throw new Error(noteError(error, 'Could not load who saw your note'));
  const d = (data ?? {}) as Partial<NoteInsights>;
  return { views: Number(d.views) || 0, likes: Number(d.likes) || 0, replies: Number(d.replies) || 0, faces: Array.isArray(d.faces) ? d.faces : [] };
}

/** Everyone who viewed / reacted to / replied to my active note, newest activity first. */
export async function noteAudience(): Promise<NoteAudienceRow[]> {
  const { data, error } = await supabase.rpc('note_audience');
  if (error) throw new Error(noteError(error, 'Could not load who saw your note'));
  return ((data ?? []) as NoteAudienceRow[]).map((r) => ({ ...r, replies: Number(r.replies) || 0 }));
}
