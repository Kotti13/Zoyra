/**
 * Chat extras data layer (migration 20261117110000_chat_extras.sql): time capsules, whisper (view once) photos,
 * starred messages and the shared media index. Everything the user writes stays end-to-end encrypted:
 *
 * - Capsule: text + song + {opens_at, hide, reminder, countdown} go in the ENCRYPTED payload (kind 'capsule',
 *   sendMessage with requireEncrypted). `seal_capsule` then stores only the date / switches server side; the
 *   recipients' message_keys rows stay unreadable (RLS) until the date when hidden, so their phones cannot
 *   decrypt early. A capsule that failed to seal stays locked for the recipient (safe default).
 * - Whisper: the photo is encrypted with encryptFile and its file key travels in the encrypted payload, like
 *   any photo. `register_whisper` records the storage path (the server already holds the encrypted object).
 *   Viewing calls `mark_whisper_viewed`, which deletes the viewer's envelope and hides the file from them; the
 *   decrypted copy only exists in memory / a temp file while the photo is held, and the local payload cache
 *   entry is dropped. The sender's app deletes the encrypted file once everyone has viewed it.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import type { CatalogTrack } from './catalog';
import {
  chatError,
  chatMediaUrl,
  CHAT_MEDIA,
  decryptChatRows,
  MSG_SELECT,
  messagePreview,
  photoMeta,
  sendMessage,
  trackArtist,
  voiceMeta,
  type ChatMessage,
  type ChatPerson,
} from './chat';
import { encryptAndUpload, newMessageId, willEncrypt } from './chat-e2ee';
import { decryptFile, getE2EEStatus } from './e2ee';
import { cacheDelete } from './e2ee/cache';
import { supabase } from './supabase';

/* ------------------------------------------------------------------ time capsule */

export type CapsuleRow = { message_id: string; conversation_id: string; sender_id: string; opens_at: string; hide: boolean; reminder: boolean };

export type CapsuleDraft = { body: string; track: CatalogTrack | null; opensAt: Date; hide: boolean; reminder: boolean; countdown: boolean };

export async function sendCapsule(cid: string, me: string, d: CapsuleDraft): Promise<ChatMessage> {
  if (!(await willEncrypt(cid, me, 'capsule'))) throw new Error('Time capsules need end-to-end encryption. Ask them to update Zoyra.');
  const id = newMessageId();
  const meta = { opens_at: d.opensAt.toISOString(), hide: d.hide, reminder: d.reminder, countdown: d.countdown };
  const sent = await sendMessage(cid, me, { kind: 'capsule', body: d.body.trim(), track: d.track, meta }, { messageId: id, requireEncrypted: true });
  let lastError: unknown = null;
  for (let i = 0; i < 3; i++) {
    const { error } = await supabase.rpc('seal_capsule', { mid: sent.id, p_opens_at: meta.opens_at, p_hide: d.hide, p_reminder: d.reminder });
    if (!error || error.code === '23505') return sent;
    lastError = error;
    if (error.code === '22023') break;
  }
  // Never leave an unsealed capsule behind (it would stay locked for them forever).
  await supabase.rpc('unsend_message', { mid: sent.id }).then(undefined, () => undefined);
  throw new Error(chatError(lastError, 'Could not seal the capsule'));
}

export async function loadCapsules(cid: string): Promise<Map<string, CapsuleRow>> {
  const { data, error } = await supabase.from('message_capsules').select('message_id, conversation_id, sender_id, opens_at, hide, reminder').eq('conversation_id', cid);
  if (error) return new Map();
  return new Map(((data ?? []) as CapsuleRow[]).map((r) => [r.message_id, r]));
}

/** My capsules still waiting to open (Scheduled screen). */
export async function myPendingCapsules(cid: string, me: string): Promise<CapsuleRow[]> {
  const { data, error } = await supabase
    .from('message_capsules')
    .select('message_id, conversation_id, sender_id, opens_at, hide, reminder')
    .eq('conversation_id', cid)
    .eq('sender_id', me)
    .gt('opens_at', new Date().toISOString())
    .order('opens_at');
  if (error) throw new Error(error.message);
  return (data ?? []) as CapsuleRow[];
}

/** Cancel a capsule before it opens = unsend it for everyone. */
export async function cancelCapsule(mid: string): Promise<void> {
  const { error } = await supabase.rpc('unsend_message', { mid });
  if (error) throw new Error(chatError(error, 'Could not cancel'));
}

/** "OPENS 14 FEB 2027". */
export const capsuleDateLabel = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

/** Days / hours / minutes / seconds left (all 0 once open). */
export function countdownParts(iso: string, now = Date.now()): { d: number; h: number; m: number; s: number; done: boolean } {
  const left = Math.max(0, Date.parse(iso) - now);
  const s = Math.floor(left / 1000);
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60, done: left <= 0 };
}

/* ------------------------------------------------------------------ whisper (view once) */

export type WhisperView = { message_id: string; user_id: string; viewed_at: string | null; screenshot_at: string | null };

export async function sendWhisper(cid: string, me: string, photo: { uri: string; mime: string; width?: number; height?: number }): Promise<ChatMessage> {
  if (!(await willEncrypt(cid, me, 'whisper'))) throw new Error('View once photos need end-to-end encryption. Ask them to update Zoyra.');
  const media = await encryptAndUpload(cid, me, photo.uri, photo.mime);
  const id = newMessageId();
  const sent = await sendMessage(cid, me, { kind: 'whisper', body: '', meta: { media: { ...media, width: photo.width, height: photo.height }, view_once: true } }, { messageId: id, requireEncrypted: true });
  const { error } = await supabase.rpc('register_whisper', { mid: sent.id, p_path: media.path });
  if (error) console.warn('register_whisper failed', error.message);
  return sent;
}

export async function loadWhisperViews(mids: string[]): Promise<WhisperView[]> {
  if (!mids.length) return [];
  const { data, error } = await supabase.from('whisper_views').select('message_id, user_id, viewed_at, screenshot_at').in('message_id', mids);
  if (error) return [];
  return (data ?? []) as WhisperView[];
}

/** Downloads + decrypts a whisper photo into a temp file (deleted by `discardWhisperFile`). */
export async function openWhisperFile(path: string, key: string, mime: string): Promise<string> {
  const res = await fetch(await chatMediaUrl(path));
  if (!res.ok) throw new Error('This photo is no longer available.');
  const bytes = decryptFile(new Uint8Array(await res.arrayBuffer()), key);
  if (Platform.OS === 'web') return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const dir = new Directory(Paths.cache, 'zoyra-whisper');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const out = new File(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.${mime === 'image/png' ? 'png' : 'jpg'}`);
  out.create({ overwrite: true });
  await out.write(bytes);
  return out.uri;
}

export function discardWhisperFile(uri: string | null): void {
  if (!uri) return;
  try {
    if (Platform.OS === 'web') URL.revokeObjectURL(uri);
    else {
      const f = new File(uri);
      if (f.exists) f.delete();
    }
  } catch {
    // ignore
  }
}

/** Marks the whisper viewed (server deletes my envelope) and forgets the decrypted payload on this phone. */
export async function markWhisperViewed(mid: string): Promise<void> {
  const { error } = await supabase.rpc('mark_whisper_viewed', { mid });
  const uid = getE2EEStatus().userId;
  if (uid) await cacheDelete(uid, [mid]).catch(() => undefined);
  if (error) throw new Error(chatError(error, 'Could not open'));
}

export async function reportWhisperScreenshot(mid: string): Promise<void> {
  await supabase.rpc('whisper_screenshot', { mid }).then(undefined, () => undefined);
}

const removed = new Set<string>();
/** Sender side: delete encrypted whisper files every recipient has viewed (DMs: the other member). */
export async function cleanupViewedWhispers(cid: string, me: string, viewedMids: Set<string>): Promise<void> {
  if (!viewedMids.size) return;
  const { data } = await supabase.from('message_whispers').select('message_id, media_path').eq('conversation_id', cid).eq('sender_id', me).in('message_id', [...viewedMids]);
  const paths = ((data ?? []) as { media_path: string }[]).map((r) => r.media_path).filter((p) => !removed.has(p));
  if (!paths.length) return;
  paths.forEach((p) => removed.add(p));
  await supabase.storage.from(CHAT_MEDIA).remove(paths).then(undefined, () => undefined);
}

/* ------------------------------------------------------------------ starred */

export async function loadStarIds(cid?: string): Promise<Set<string>> {
  let q = supabase.from('message_stars').select('message_id');
  if (cid) q = q.eq('conversation_id', cid);
  const { data, error } = await q;
  if (error) return new Set();
  return new Set(((data ?? []) as { message_id: string }[]).map((r) => r.message_id));
}

export async function starCount(cid: string): Promise<number> {
  const { count, error } = await supabase.from('message_stars').select('message_id', { count: 'exact', head: true }).eq('conversation_id', cid);
  return error ? 0 : (count ?? 0);
}

export async function setStarred(mid: string, me: string, on: boolean): Promise<void> {
  const q = on ? supabase.from('message_stars').insert({ user_id: me, message_id: mid }) : supabase.from('message_stars').delete().eq('message_id', mid).eq('user_id', me);
  const { error } = await q;
  if (error && error.code !== '23505') throw new Error(chatError(error, on ? 'Could not star' : 'Could not unstar'));
}

export type StarFilter = 'all' | 'text' | 'songs' | 'photos' | 'links';
export type StarredItem = { message: ChatMessage; starredAt: string; chat: { id: string; title: string; person: ChatPerson | null; group: boolean } };

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
export const linksIn = (text: string): string[] => text.match(URL_RE) ?? [];

export function starKind(m: ChatMessage): Exclude<StarFilter, 'all'> | null {
  if (m.kind === 'photo') return 'photos';
  if (m.track || m.kind === 'track' || m.kind === 'swap' || m.kind === 'lyric') return 'songs';
  if (m.body && linksIn(m.body).length) return 'links';
  if (m.kind === 'text' && m.body) return 'text';
  return null;
}

/** All my starred messages across chats (decrypted), newest star first. */
export async function loadStarred(cid?: string): Promise<StarredItem[]> {
  let q = supabase.from('message_stars').select('message_id, conversation_id, created_at').order('created_at', { ascending: false }).limit(300);
  if (cid) q = q.eq('conversation_id', cid);
  const stars = await q;
  if (stars.error) throw new Error(stars.error.message);
  const rows = (stars.data ?? []) as { message_id: string; conversation_id: string; created_at: string }[];
  if (!rows.length) return [];
  const [msgs, inbox] = await Promise.all([supabase.from('messages').select(MSG_SELECT).in('id', rows.map((r) => r.message_id)), supabase.rpc('inbox')]);
  if (msgs.error) throw new Error(msgs.error.message);
  const decrypted = await decryptChatRows((msgs.data ?? []) as ChatMessage[]);
  const byId = new Map(decrypted.map((m) => [m.id, m]));
  type InboxRow = { conversation_id: string; kind: string | null; title: string | null; avatar_url: string | null; other_id: string | null; other_name: string | null; other_avatar: string | null; other_username: string | null };
  const chats = new Map(((inbox.data ?? []) as InboxRow[]).map((r) => [r.conversation_id, r]));
  return rows.flatMap((r) => {
    const m = byId.get(r.message_id);
    if (!m) return [];
    const c = chats.get(r.conversation_id);
    const group = c?.kind === 'group';
    const person: ChatPerson | null = group
      ? { id: r.conversation_id, display_name: c?.title ?? 'Group', avatar_url: c?.avatar_url ?? null, username: null }
      : c?.other_id
        ? { id: c.other_id, display_name: c.other_name ?? '', avatar_url: c.other_avatar ?? null, username: c.other_username ?? null }
        : null;
    return [{ message: m, starredAt: r.created_at, chat: { id: r.conversation_id, title: group ? (c?.title ?? 'Group') : (c?.other_name ?? 'Chat'), person, group } }];
  });
}

/* ------------------------------------------------------------------ shared media index */

export type MediaTab = 'media' | 'songs' | 'links' | 'docs' | 'voice';
export type SharedEntry = { message: ChatMessage; tab: MediaTab; link?: string; track?: CatalogTrack };
export type SharedMedia = Record<MediaTab, SharedEntry[]>;

/** Everything shared in a chat (newest first), decrypted on this phone. View-once photos are never listed. */
export async function loadSharedMedia(cid: string, limit = 600): Promise<SharedMedia> {
  const { data, error } = await supabase
    .from('messages')
    .select(MSG_SELECT)
    .eq('conversation_id', cid)
    .in('kind', ['photo', 'voice', 'track', 'swap', 'lyric', 'text'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const hidden = await supabase.from('message_hidden').select('message_id');
  const hide = new Set(((hidden.data ?? []) as { message_id: string }[]).map((h) => h.message_id));
  const rows = (await decryptChatRows((data ?? []) as ChatMessage[])).filter((m) => !hide.has(m.id) && !m.meta?.e2ee_error);
  const out: SharedMedia = { media: [], songs: [], links: [], docs: [], voice: [] };
  for (const m of rows) {
    if (photoMeta(m)) out.media.push({ message: m, tab: 'media' });
    else if (voiceMeta(m)) out.voice.push({ message: m, tab: 'voice' });
    if (m.track) out.songs.push({ message: m, tab: 'songs', track: m.track });
    if (m.body) for (const link of linksIn(m.body)) out.links.push({ message: m, tab: 'links', link });
  }
  return out;
}

/** "This month" / "Last month" / "September 2026". */
export function monthLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const diff = (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth();
  if (diff <= 0) return 'This month';
  if (diff === 1) return 'Last month';
  return d.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

export const songLine = (t: CatalogTrack) => `${t.title}${trackArtist(t) ? ` · ${trackArtist(t)}` : ''}`;
export { messagePreview };
