/**
 * Chat Pro data layer (screens: chat-pro, chat-actions, chat-attach, chat-info, chat-voice).
 * Tables come from migration 20261114180000_chat_pro.sql: messages.kind/reply_to/meta,
 * message_reactions, message_pins, message_hidden, poll_votes, scheduled_messages,
 * conversation_members.muted/read_receipts, conversations.disappear_seconds and the private
 * `chat-media` bucket (<conversation_id>/<user_id>/<file>).
 */
import { File } from 'expo-file-system';
import { useEffect, useState } from 'react';

import type { CallMessageMeta } from './calls';
import { E2EE_MSG_COLS, decryptChatRows, decryptErrorOf, decryptedMediaUri, editSecure, encryptAndUpload, sendSecure, willEncrypt } from './chat-e2ee';
import type { CatalogTrack } from './catalog';
import { friendlySocialError } from './social';
import { supabase } from './supabase';

export type ChatPerson = { id: string; display_name: string; avatar_url: string | null; username: string | null };

export type MessageKind = 'text' | 'track' | 'voice' | 'poll' | 'lyric' | 'playlist' | 'jam' | 'live' | 'photo' | 'location' | 'swap' | 'call' | 'capsule' | 'whisper';

/** `key` is set for end-to-end encrypted media (file key from the encrypted payload's meta.media). */
export type VoiceMeta = { path: string; duration_ms: number; mime: string; levels?: number[]; key?: string };
export type PhotoMeta = { path: string; mime: string; width?: number; height?: number; key?: string };
export type PollMeta = { question: string; options: string[] };
export type LyricMeta = { line: string; track: CatalogTrack };
export type PlaylistMeta = { id: string; title: string; cover_url: string | null; track_count?: number };
export type JamMeta = { room_id: string; code: string; name: string };
export type LiveMeta = { session_id: string; title: string };
export type LocationMeta = { lat: number; lng: number; accuracy_m?: number };
/** Blend playlist message (kind 'playlist', meta {playlist_id, title, count, blend: true, match}). */
export type BlendMeta = { playlist_id: string; title: string; count: number | null; match: number | null };
/** Song swap message (kind 'swap', track in `track`, meta {swap: true}). */
export type SwapMeta = { track: CatalogTrack };
/**
 * Time capsule (kind 'capsule', always end-to-end encrypted): text in `body`, optional song in `track`, and
 * inside the ENCRYPTED meta {opens_at, hide, reminder, countdown}. The server keeps its own copy of the
 * open date in message_capsules (seal_capsule) and withholds the recipients' key until then when hidden.
 */
export type CapsuleMeta = { opens_at: string; hide: boolean; reminder: boolean; countdown: boolean };
/** Whisper (kind 'whisper', view once): encrypted photo in meta.media, like a photo. */
export type WhisperMeta = PhotoMeta;

export type ChatMessage = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  track: CatalogTrack | null;
  kind: MessageKind;
  reply_to: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  pending?: boolean;
  /** E2EE columns (E2EE_MSG_COLS); body / track / meta are filled from the decrypted payload. */
  e2ee_version?: number | null;
  ciphertext?: string | null;
  nonce?: string | null;
  sender_device_id?: string | null;
  signature?: string | null;
};

export type Reaction = { message_id: string; user_id: string; emoji: string };
export type Pin = { message_id: string; pinned_by: string | null; created_at: string };
export type Vote = { message_id: string; user_id: string; option: number };
export type MemberSettings = { muted: boolean; read_receipts: boolean; last_read_at: string };
export type ConversationInfo = { disappear_seconds: number | null; disappear_since: string | null; disappear_by?: string | null };
export type Scheduled = { id: string; body: string; send_at: string; sent_at: string | null; failed: string | null };

export const MSG_COLS = 'id, conversation_id, sender_id, body, track, kind, reply_to, meta, created_at';
/** Message columns + the E2EE columns: use for every messages select, then `decryptChatRows`. */
export const MSG_SELECT = `${MSG_COLS}, ${E2EE_MSG_COLS}`;
export { decryptChatRows };
export const CHAT_MEDIA = 'chat-media';

/** Allowed reactions (must match the check constraint in the migration). Quick row first. */
export const QUICK_REACTIONS = ['❤️', '🔥', '😂', '😮', '👏'] as const;
export const MORE_REACTIONS = ['😢', '👍', '🎵', '💯', '🙏'] as const;

export const DISAPPEAR_OPTIONS: { label: string; seconds: number | null }[] = [
  { label: 'Off', seconds: null },
  { label: '24 hours', seconds: 86_400 },
  { label: '7 days', seconds: 604_800 },
  { label: '90 days', seconds: 7_776_000 },
];
export const disappearLabel = (s: number | null | undefined) => DISAPPEAR_OPTIONS.find((o) => o.seconds === (s ?? null))?.label ?? 'Off';

export const VOICE_MAX_MS = 120_000;

/**
 * Route params (`uid`, `name`, `avatar`) that let /chat-pro and /chat-info show the other person
 * right away, before `loadChat` resolves. Spread into `params` next to `id`.
 */
export type ChatPeerParams = { uid?: string; name?: string; avatar?: string };

export function chatPeerParams(p: { id?: string | null; display_name?: string | null; avatar_url?: string | null } | null | undefined): ChatPeerParams {
  if (!p?.id) return {};
  const out: ChatPeerParams = { uid: p.id };
  if (p.display_name) out.name = p.display_name;
  if (p.avatar_url) out.avatar = p.avatar_url;
  return out;
}

/** The other person from `chatPeerParams` route params (null when the caller didn't know them). */
export function peerFromParams(uid: unknown, name: unknown, avatar: unknown): ChatPerson | null {
  const id = typeof uid === 'string' && uid ? uid : null;
  if (!id) return null;
  return { id, display_name: typeof name === 'string' ? name : '', avatar_url: typeof avatar === 'string' && avatar ? avatar : null, username: null };
}

/* ------------------------------------------------------------------ meta readers (meta is jsonb from the server) */

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** meta.media of an encrypted voice note / photo ({path, key, mime, size, duration_ms, width, height}). */
function mediaOf(m: ChatMessage): Record<string, unknown> | null {
  const x = m.meta?.media;
  return x && typeof x === 'object' && !Array.isArray(x) && typeof (x as Record<string, unknown>).path === 'string' ? (x as Record<string, unknown>) : null;
}
export function voiceMeta(m: ChatMessage): VoiceMeta | null {
  const media = mediaOf(m);
  const src = media ?? m.meta;
  const path = str(src.path);
  if (m.kind !== 'voice' || !path) return null;
  const levels = Array.isArray(m.meta.levels) ? m.meta.levels.filter((x): x is number => typeof x === 'number') : undefined;
  return { path, duration_ms: num(src.duration_ms) ?? num(m.meta.duration_ms) ?? 0, mime: str(src.mime) ?? 'audio/mp4', levels, key: media ? (str(media.key) ?? undefined) : undefined };
}
export function photoMeta(m: ChatMessage): PhotoMeta | null {
  const media = mediaOf(m);
  const src = media ?? m.meta;
  const path = str(src.path);
  if (m.kind !== 'photo' || !path) return null;
  return { path, mime: str(src.mime) ?? 'image/jpeg', width: num(src.width) ?? undefined, height: num(src.height) ?? undefined, key: media ? (str(media.key) ?? undefined) : undefined };
}
export function pollMeta(m: ChatMessage): PollMeta | null {
  const q = str(m.meta.question);
  if (m.kind !== 'poll' || !q || !Array.isArray(m.meta.options)) return null;
  const options = m.meta.options.filter((x): x is string => typeof x === 'string');
  return options.length >= 2 ? { question: q, options } : null;
}
export function lyricMeta(m: ChatMessage): LyricMeta | null {
  const line = str(m.meta.line);
  if (m.kind !== 'lyric' || !line || !m.track) return null;
  return { line, track: m.track };
}
export function playlistMeta(m: ChatMessage): PlaylistMeta | null {
  const id = str(m.meta.id) ?? str(m.meta.playlist_id);
  if (m.kind !== 'playlist' || !id) return null;
  return { id, title: str(m.meta.title) ?? 'Playlist', cover_url: str(m.meta.cover_url), track_count: num(m.meta.track_count) ?? num(m.meta.count) ?? undefined };
}
export function blendMeta(m: ChatMessage): BlendMeta | null {
  const id = str(m.meta.playlist_id) ?? str(m.meta.id);
  if (m.kind !== 'playlist' || m.meta.blend !== true || !id) return null;
  return { playlist_id: id, title: str(m.meta.title) ?? 'Blend', count: num(m.meta.count) ?? num(m.meta.track_count), match: num(m.meta.match) };
}
/** Capsule settings from the decrypted payload (null when not a capsule or not decrypted on this phone). */
export function capsuleMeta(m: ChatMessage): CapsuleMeta | null {
  const at = str(m.meta?.opens_at);
  if (m.kind !== 'capsule' || !at) return null;
  return { opens_at: at, hide: m.meta.hide !== false, reminder: m.meta.reminder !== false, countdown: m.meta.countdown !== false };
}
export function whisperMeta(m: ChatMessage): WhisperMeta | null {
  const media = mediaOf(m);
  if (m.kind !== 'whisper' || !media) return null;
  return { path: str(media.path) ?? '', mime: str(media.mime) ?? 'image/jpeg', width: num(media.width) ?? undefined, height: num(media.height) ?? undefined, key: str(media.key) ?? undefined };
}
/** View-once photos and time capsules can't be forwarded, copied or saved. */
export const isPrivateKind = (m: Pick<ChatMessage, 'kind'>) => m.kind === 'whisper' || m.kind === 'capsule';

export function swapMeta(m: ChatMessage): SwapMeta | null {
  if (m.kind !== 'swap' || !m.track) return null;
  return { track: m.track };
}

/** Artist name of a stored track: CatalogTrack has `artist.name`, server-built rows may store a plain string. */
export function trackArtist(t: { artist?: unknown } | null | undefined): string {
  const a = t?.artist;
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string') return (a as { name: string }).name;
  return '';
}
export function jamMeta(m: ChatMessage): JamMeta | null {
  const room = str(m.meta.room_id);
  if (m.kind !== 'jam' || !room) return null;
  return { room_id: room, code: str(m.meta.code) ?? '', name: str(m.meta.name) ?? 'Jam' };
}
export function liveMeta(m: ChatMessage): LiveMeta | null {
  const s = str(m.meta.session_id);
  if (m.kind !== 'live' || !s) return null;
  return { session_id: s, title: str(m.meta.title) ?? 'Live session' };
}
export function locationMeta(m: ChatMessage): LocationMeta | null {
  const lat = num(m.meta.lat);
  const lng = num(m.meta.lng);
  if (m.kind !== 'location' || lat === null || lng === null) return null;
  return { lat, lng, accuracy_m: num(m.meta.accuracy_m) ?? undefined };
}

export const mapsUrl = (l: LocationMeta) => `https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}#map=16/${l.lat}/${l.lng}`;

/** `meta` of a `kind: 'call'` log message (posted by the server when a call finishes), or null. */
export function callMeta(m: Pick<ChatMessage, 'kind' | 'meta'>): CallMessageMeta | null {
  if (m.kind !== 'call') return null;
  const x = m.meta ?? {};
  if (typeof x.call_id !== 'string') return null;
  return {
    call_id: x.call_id,
    kind: x.kind === 'video' ? 'video' : 'audio',
    status: typeof x.status === 'string' ? (x.status as CallMessageMeta['status']) : 'ended',
    duration_s: typeof x.duration_s === 'number' && Number.isFinite(x.duration_s) ? x.duration_s : null,
  };
}

/** "Voice call · 2:31", "Missed video call", "Declined voice call" (same wording as the server's message_preview). */
export function callSummary(c: Pick<CallMessageMeta, 'kind' | 'status' | 'duration_s'>): string {
  const label = c.kind === 'video' ? 'video call' : 'voice call';
  if (c.status === 'ended') return `${c.kind === 'video' ? 'Video' : 'Voice'} call${c.duration_s !== null ? ` · ${formatDuration(c.duration_s)}` : ''}`;
  if (c.status === 'declined') return `Declined ${label}`;
  return `Missed ${label}`;
}

/** 2:31, or 1:02:31 past an hour. */
export function formatDuration(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** One-line text for previews, copy and quotes. */
export function messagePreview(m: ChatMessage): string {
  // Never the content: a capsule may still be sealed, a whisper is view once.
  if (m.kind === 'capsule') return 'Time capsule';
  if (m.kind === 'whisper') return 'View once photo';
  if (decryptErrorOf(m)) return 'Message unavailable on this device';
  if (m.meta?.e2ee_pending === true) return 'Encrypted message';
  switch (m.kind) {
    case 'voice':
      return `Voice note · ${formatMs(voiceMeta(m)?.duration_ms ?? 0)}`;
    case 'photo':
      return 'Photo';
    case 'poll':
      return `Poll: ${pollMeta(m)?.question ?? ''}`;
    case 'lyric':
      return `“${lyricMeta(m)?.line ?? ''}”`;
    case 'playlist':
      return blendMeta(m) ? `Blend: ${blendMeta(m)?.title ?? ''}` : `Playlist: ${playlistMeta(m)?.title ?? ''}`;
    case 'swap':
      return m.track ? `Song swap: ${m.track.title} · ${trackArtist(m.track)}` : 'Song swap';
    case 'jam':
      return `Jam: ${jamMeta(m)?.name ?? ''}`;
    case 'live':
      return `Live: ${liveMeta(m)?.title ?? ''}`;
    case 'location':
      return 'Location';
    case 'call': {
      const c = callMeta(m);
      return c ? callSummary(c) : 'Call';
    }
    default:
      if (m.body) return m.body;
      if (m.track) return `${m.track.title} · ${trackArtist(m.track)}`;
      return 'Message';
  }
}

export const formatMs = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export const chatError = (e: unknown, fallback = 'Something went wrong. Try again.') => friendlySocialError(e, fallback);

const fail = (e: { message: string } | null) => {
  if (e) throw new Error(e.message);
};

/* ------------------------------------------------------------------ loading */

export type ChatSnapshot = {
  other: ChatPerson | null;
  /** My own membership settings (from `my_memberships()`); other members' rows are never read. */
  mine: MemberSettings | null;
  conversation: ConversationInfo | null;
  messages: ChatMessage[];
  reactions: Reaction[];
  pins: Pin[];
  votes: Vote[];
  hidden: Set<string>;
};

/** Thrown by `loadChat` when the conversation no longer exists for me (declined request, deleted, left). */
export const CHAT_GONE = 'This conversation is no longer available.';

/** Row from `my_memberships()`: my own memberships only. */
export type MyMembership = {
  conversation_id: string;
  status: string | null;
  last_read_at: string | null;
  last_delivered_at: string | null;
  muted: boolean;
  read_receipts: boolean;
  last_message_at: string | null;
};

/** My settings for one conversation, from `my_memberships()` (direct column reads are revoked). */
export async function loadMySettings(cid: string, _me: string): Promise<MemberSettings | null> {
  const rpc = await supabase.rpc('my_memberships');
  if (rpc.error) return null;
  const row = ((rpc.data ?? []) as MyMembership[]).find((r) => r.conversation_id === cid);
  return row ? { muted: !!row.muted, read_receipts: row.read_receipts !== false, last_read_at: row.last_read_at ?? new Date(0).toISOString() } : null;
}

// Last snapshot per conversation, kept in memory so reopening a chat shows it at once while a fresh copy loads.
// Memory only (never written to disk) and cleared at sign-out / account switch.
const snapshots = new Map<string, ChatSnapshot>();
const SNAPSHOTS_MAX = 12;

/** The last loaded snapshot of a conversation, if this session has one. */
export const peekChat = (cid: string): ChatSnapshot | null => snapshots.get(cid) ?? null;

export function clearChatSnapshots(): void {
  snapshots.clear();
}

function rememberSnapshot(cid: string, s: ChatSnapshot) {
  snapshots.delete(cid);
  snapshots.set(cid, s);
  if (snapshots.size > SNAPSHOTS_MAX) snapshots.delete(snapshots.keys().next().value as string);
}

export async function loadChat(cid: string, me: string): Promise<ChatSnapshot> {
  const s = await loadChatFresh(cid, me);
  rememberSnapshot(cid, s);
  return s;
}

async function loadChatFresh(cid: string, me: string): Promise<ChatSnapshot> {
  const [members, mine, conv, msgs, reactions, pins, votes, hidden] = await Promise.all([
    // Only ids + profiles of the other members: their read/delivered state comes from conversation_receipts.
    supabase.from('conversation_members').select('user_id, profiles(id, display_name, avatar_url, username)').eq('conversation_id', cid).neq('user_id', me),
    loadMySettings(cid, me),
    supabase.from('conversations').select('disappear_seconds, disappear_since, disappear_by').eq('id', cid).maybeSingle(),
    supabase.from('messages').select(MSG_SELECT).eq('conversation_id', cid).order('created_at', { ascending: false }).limit(200),
    supabase.from('message_reactions').select('message_id, user_id, emoji').eq('conversation_id', cid),
    supabase.from('message_pins').select('message_id, pinned_by, created_at').eq('conversation_id', cid).order('created_at', { ascending: false }),
    supabase.from('poll_votes').select('message_id, user_id, option').eq('conversation_id', cid),
    supabase.from('message_hidden').select('message_id').eq('user_id', me),
  ]);
  fail(members.error);
  fail(conv.error);
  if (!conv.data) throw new Error(CHAT_GONE);
  fail(msgs.error);
  fail(reactions.error);
  fail(pins.error);
  fail(votes.error);
  fail(hidden.error);
  type MemberRow = { user_id: string; profiles: ChatPerson | null };
  const otherRow = ((members.data ?? []) as unknown as MemberRow[])[0] ?? null;
  const other = otherRow?.profiles ?? (await findOther(cid, otherRow?.user_id ?? null));
  return {
    other,
    mine,
    conversation: (conv.data as ConversationInfo | null) ?? null,
    messages: (await decryptChatRows((msgs.data ?? []) as ChatMessage[])).reverse(),
    reactions: (reactions.data ?? []) as Reaction[],
    pins: (pins.data ?? []) as Pin[],
    votes: (votes.data ?? []) as Vote[],
    hidden: new Set(((hidden.data ?? []) as { message_id: string }[]).map((h) => h.message_id)),
  };
}

/**
 * Fallback for the other member when the members select comes back without an embedded profile (no
 * row visible, or the profiles embed is null): their profile by id, then `inbox()`, then my message
 * requests. Never throws; null when nothing is found.
 */
async function findOther(cid: string, userId: string | null): Promise<ChatPerson | null> {
  try {
    if (userId) {
      const p = await supabase.from('profiles').select('id, display_name, avatar_url, username').eq('id', userId).maybeSingle();
      if (!p.error && p.data) return p.data as ChatPerson;
    }
    type InboxPeer = { conversation_id: string; other_id: string | null; other_name: string | null; other_avatar: string | null; other_username: string | null };
    const inbox = await supabase.rpc('inbox');
    const row = inbox.error ? null : (((inbox.data ?? []) as InboxPeer[]).find((r) => r.conversation_id === cid) ?? null);
    if (row?.other_id) return { id: row.other_id, display_name: row.other_name ?? '', avatar_url: row.other_avatar ?? null, username: row.other_username ?? null };
    type RequestPeer = { conversation_id: string; other_id: string; display_name: string | null; avatar_url: string | null; username: string | null };
    const reqs = await supabase.rpc('list_message_requests');
    const req = reqs.error ? null : (((reqs.data ?? []) as RequestPeer[]).find((r) => r.conversation_id === cid) ?? null);
    if (req?.other_id) return { id: req.other_id, display_name: req.display_name ?? '', avatar_url: req.avatar_url ?? null, username: req.username ?? null };
    return userId ? { id: userId, display_name: '', avatar_url: null, username: null } : null;
  } catch {
    return userId ? { id: userId, display_name: '', avatar_url: null, username: null } : null;
  }
}

/** True while the conversation row is still visible to me (false after a decline / delete). */
export async function conversationExists(cid: string): Promise<boolean> {
  const { data, error } = await supabase.from('conversations').select('id').eq('id', cid).maybeSingle();
  if (error) return true;
  return !!data;
}

export async function loadMessage(id: string): Promise<ChatMessage | null> {
  const { data, error } = await supabase.from('messages').select(MSG_SELECT).eq('id', id).maybeSingle();
  fail(error);
  if (!data) return null;
  return (await decryptChatRows([data as ChatMessage]))[0] ?? null;
}

/* ------------------------------------------------------------------ sending */

export type NewMessage = {
  body?: string;
  track?: CatalogTrack | null;
  kind?: MessageKind;
  reply_to?: string | null;
  meta?: Record<string, unknown>;
};

/**
 * Sends a message: end-to-end encrypted when every member has E2EE keys (src/lib/chat-e2ee.ts sendSecure),
 * plaintext with meta.e2ee_off only when someone never set up E2EE. Keys are created silently; on a new phone
 * with a backup the first send asks once "Restore your chat history first?" and throws E2EESetupRequired when
 * the user picks Restore / cancels (callers: routeIfSetupRequired). `messageId` keeps an optimistic bubble's id.
 */
export async function sendMessage(cid: string, me: string, m: NewMessage, opts: { messageId?: string; requireEncrypted?: boolean } = {}): Promise<ChatMessage> {
  const kind = m.kind ?? (m.track && !m.body ? 'track' : 'text');
  const res = await sendSecure(
    cid,
    me,
    { body: m.body ?? '', track: m.track ?? null, kind, reply_to: m.reply_to ?? null, meta: m.meta ?? {} },
    {
      ...opts,
      insertPlain: async (row) => {
        const { data, error } = await supabase.from('messages').insert(row).select(MSG_SELECT).single();
        if (error || !data) throw new Error(chatError(error, 'Message not sent'));
        return data as Record<string, unknown>;
      },
    },
  ).catch((e: unknown) => {
    if (e instanceof Error && e.name === 'E2EESetupRequired') throw e;
    throw new Error(chatError(e, 'Message not sent'));
  });
  if (res.row) return res.row as unknown as ChatMessage;
  return { id: res.id, conversation_id: cid, sender_id: me, body: m.body ?? '', track: m.track ?? null, kind, reply_to: m.reply_to ?? null, meta: res.meta, created_at: new Date().toISOString() };
}

async function readFile(uri: string): Promise<ArrayBuffer> {
  try {
    return await new File(uri).arrayBuffer();
  } catch {
    return await (await fetch(uri)).arrayBuffer();
  }
}

/** Upload a local file to chat-media under this conversation and return its storage path. */
export async function uploadChatMedia(cid: string, me: string, uri: string, mime: string, ext: string): Promise<string> {
  const body = await readFile(uri);
  if (!body.byteLength) throw new Error('Could not read that file.');
  if (body.byteLength > 10 * 1024 * 1024) throw new Error('That file is too large (max 10 MB).');
  const path = `${cid}/${me}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from(CHAT_MEDIA).upload(path, body, { contentType: mime, upsert: false });
  if (error) throw new Error(/bucket not found/i.test(error.message) ? 'Chat media storage isn’t set up yet.' : `Upload failed: ${error.message}`);
  return path;
}

/**
 * Uploads a voice note / photo for a message about to be sent. Encrypted (meta.media {path, key, mime, size})
 * when the message will be end-to-end encrypted, else the plaintext layout (meta.path / mime). Pass the
 * returned `requireEncrypted` to sendMessage so an encrypted upload is never sent as a plaintext message.
 */
export async function uploadMediaForMessage(cid: string, me: string, uri: string, mime: string, ext: string, kind: 'voice' | 'photo', extra: Record<string, unknown> = {}): Promise<{ meta: Record<string, unknown>; requireEncrypted: boolean }> {
  if (await willEncrypt(cid, me, kind)) {
    const media = await encryptAndUpload(cid, me, uri, mime);
    const { levels, ...rest } = extra;
    return { meta: { media: { ...media, ...rest }, ...(levels !== undefined ? { levels } : {}) }, requireEncrypted: true };
  }
  const path = await uploadChatMedia(cid, me, uri, mime, ext);
  return { meta: { path, mime, ...extra }, requireEncrypted: false };
}

const signedCache = new Map<string, { url: string; until: number }>();
/** Short-lived signed URL for a chat-media object (cached for most of its life). */
export async function chatMediaUrl(path: string): Promise<string> {
  const hit = signedCache.get(path);
  if (hit && hit.until > Date.now()) return hit.url;
  const { data, error } = await supabase.storage.from(CHAT_MEDIA).createSignedUrl(path, 3600);
  if (error || !data) throw new Error(error?.message ?? 'Could not open this file');
  signedCache.set(path, { url: data.signedUrl, until: Date.now() + 50 * 60_000 });
  return data.signedUrl;
}

/** Displayable URL of a chat-media object; with `key` (E2EE media) a decrypted local cache file. */
export function mediaUri(path: string, key?: string, mime?: string): Promise<string> {
  return key ? decryptedMediaUri(path, key, mime, chatMediaUrl) : chatMediaUrl(path);
}

export function useChatMediaUrl(path: string | null | undefined, key?: string, mime?: string) {
  const [state, setState] = useState<{ path: string; url: string | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    mediaUri(path, key, mime)
      .then((url) => alive && setState({ path, url, error: null }))
      .catch((e: unknown) => alive && setState({ path, url: null, error: e instanceof Error ? e.message : 'Could not load' }));
    return () => {
      alive = false;
    };
  }, [path, key, mime]);
  const cur = state && state.path === path ? state : null;
  return { url: cur?.url ?? null, error: cur?.error ?? null, loading: !!path && !cur };
}

/* ------------------------------------------------------------------ message actions */

export async function toggleReaction(cid: string, mid: string, me: string, emoji: string, on: boolean): Promise<void> {
  const q = on
    ? supabase.from('message_reactions').insert({ message_id: mid, conversation_id: cid, user_id: me, emoji })
    : supabase.from('message_reactions').delete().eq('message_id', mid).eq('user_id', me).eq('emoji', emoji);
  const { error } = await q;
  if (error && error.code !== '23505') throw new Error(chatError(error, 'Could not react'));
}

export async function setPinned(cid: string, mid: string, me: string, on: boolean): Promise<void> {
  const q = on
    ? supabase.from('message_pins').insert({ message_id: mid, conversation_id: cid, pinned_by: me })
    : supabase.from('message_pins').delete().eq('message_id', mid);
  const { error } = await q;
  if (error && error.code !== '23505') throw new Error(chatError(error, on ? 'Could not pin' : 'Could not unpin'));
}

/**
 * Marks a conversation read with the SERVER clock (`mark_conversation_read`), so a phone whose clock is
 * behind (or ahead) can't skew unread counts. Never throws.
 */
export async function markConversationRead(cid: string, _me: string): Promise<void> {
  try {
    await supabase.rpc('mark_conversation_read', { cid });
  } catch {
    // offline: cleared next time the chat opens
  }
}

export async function hideForMe(mid: string, me: string): Promise<void> {
  const { error } = await supabase.from('message_hidden').insert({ message_id: mid, user_id: me });
  if (error && error.code !== '23505') throw new Error(chatError(error, 'Could not delete'));
  chatBus.touch();
}

export async function vote(cid: string, mid: string, me: string, option: number): Promise<void> {
  const { error } = await supabase.from('poll_votes').upsert({ message_id: mid, conversation_id: cid, user_id: me, option }, { onConflict: 'message_id,user_id' });
  if (error) throw new Error(chatError(error, 'Vote not saved'));
}

/** Copy a message into another conversation. Voice notes and photos stay in their own chat. */
export async function forwardMessage(m: ChatMessage, toCid: string, me: string): Promise<void> {
  if (isPrivateKind(m)) throw new Error('View once photos and time capsules can’t be forwarded.');
  if (m.kind === 'voice' || m.kind === 'photo') throw new Error('Voice notes and photos can’t be forwarded.');
  if (decryptErrorOf(m)) throw new Error('This message isn’t available on this device.');
  await sendMessage(toCid, me, { body: m.body, track: m.track, kind: m.kind, meta: m.meta });
}

/** My open jams (group listening rooms I'm in) for Forward: their room chat takes plain text. */
export async function listMyJams(me: string): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase.from('room_members').select('rooms(id, name, kind, is_open)').eq('user_id', me).limit(50);
  fail(error);
  type Row = { rooms: { id: string; name: string | null; kind: string; is_open: boolean } | null };
  return ((data ?? []) as unknown as Row[]).flatMap((r) => (r.rooms && r.rooms.kind === 'group' && r.rooms.is_open ? [{ id: r.rooms.id, name: r.rooms.name || 'Jam' }] : []));
}

/** Forward a message into a jam's room chat as text (room chat is text only, max 1000 chars). */
export async function forwardToJam(m: ChatMessage, roomId: string, me: string): Promise<void> {
  if (isPrivateKind(m)) throw new Error('View once photos and time capsules can’t be forwarded.');
  if (m.kind === 'voice' || m.kind === 'photo') throw new Error('Voice notes and photos can’t be forwarded.');
  const body = messagePreview(m).slice(0, 1000);
  const { error } = await supabase.from('room_messages').insert({ room_id: roomId, user_id: me, body });
  if (error) throw new Error(chatError(error, 'Could not forward'));
}

/* ------------------------------------------------------------------ editing (migration 20261115190000_advanced_chat.sql) */

/** Own text messages can be edited for this long after sending (enforced by `edit_message`). */
export const EDIT_WINDOW_MS = 15 * 60_000;

/** When the message was last edited (mirrored into meta by `edit_message`), or null. */
export function editedAt(m: Pick<ChatMessage, 'meta'>): string | null {
  return str(m.meta?.edited_at);
}

/** True while I can still edit this message (my own, plain text, sent less than 15 minutes ago). */
export function canEdit(m: ChatMessage, me: string | undefined, now = Date.now()): boolean {
  return !!me && !m.pending && m.sender_id === me && m.kind === 'text' && !!m.body && now - Date.parse(m.created_at) < EDIT_WINDOW_MS;
}

/** Edit my text message: re-encrypts E2EE rows (edit_e2ee_message), else edit_message. */
export async function editChatMessage(m: Pick<ChatMessage, 'id' | 'conversation_id' | 'meta'>, body: string): Promise<void> {
  try {
    await editSecure(m, body, () => editMessage(m.id, body));
  } catch (e) {
    if (e instanceof Error && (e.name === 'E2EESetupRequired' || e.message === 'Editing isn’t available yet.')) throw e;
    throw new Error(chatError(e, 'Could not edit'));
  }
  chatBus.touch();
}

export async function editMessage(mid: string, body: string): Promise<void> {
  const { error } = await supabase.rpc('edit_message', { mid, new_body: body.trim() });
  if (error) {
    if (/edit_message/.test(error.message) && /function|schema cache/i.test(error.message)) throw new Error('Editing isn’t available yet.');
    throw new Error(chatError(error, 'Could not edit'));
  }
  chatBus.touch();
}

/** The caller's other 1:1 conversations (for Forward). */
export async function listConversations(me: string, exclude?: string): Promise<{ id: string; other: ChatPerson | null }[]> {
  const mine = await supabase.from('conversation_members').select('conversation_id, conversations(last_message_at)').eq('user_id', me).eq('status', 'active');
  fail(mine.error);
  type Row = { conversation_id: string; conversations: { last_message_at: string } | null };
  const rows = ((mine.data ?? []) as unknown as Row[])
    .filter((r) => r.conversation_id !== exclude)
    .sort((a, b) => (b.conversations?.last_message_at ?? '').localeCompare(a.conversations?.last_message_at ?? ''))
    .slice(0, 50);
  if (!rows.length) return [];
  const others = await supabase
    .from('conversation_members')
    .select('conversation_id, profiles(id, display_name, avatar_url, username)')
    .in(
      'conversation_id',
      rows.map((r) => r.conversation_id),
    )
    .neq('user_id', me);
  fail(others.error);
  const byConv = new Map(((others.data ?? []) as unknown as { conversation_id: string; profiles: ChatPerson | null }[]).map((o) => [o.conversation_id, o.profiles]));
  return rows.map((r) => ({ id: r.conversation_id, other: byConv.get(r.conversation_id) ?? null }));
}

/* ------------------------------------------------------------------ settings */

export async function updateMySettings(cid: string, me: string, patch: Partial<Pick<MemberSettings, 'muted' | 'read_receipts'>>): Promise<void> {
  const { error } = await supabase.from('conversation_members').update(patch).eq('conversation_id', cid).eq('user_id', me);
  if (error) throw new Error(chatError(error, 'Setting not saved'));
}

export async function setDisappearing(cid: string, seconds: number | null): Promise<void> {
  const { error } = await supabase.rpc('set_disappearing', { cid, seconds });
  if (error) throw new Error(chatError(error, 'Could not change the timer'));
}

/* ------------------------------------------------------------------ receipts */

/** Row from `conversation_receipts(cid)`. `last_read_at` is null when that member hides read receipts. */
export type Receipt = { user_id: string; last_read_at: string | null; last_delivered_at: string | null };
export type Delivery = 'sending' | 'sent' | 'delivered' | 'read';

export async function loadReceipts(cid: string): Promise<Receipt[]> {
  const { data, error } = await supabase.rpc('conversation_receipts', { cid });
  if (error) throw new Error(error.message);
  return (data ?? []) as Receipt[];
}

/**
 * Delivery state of one of my messages given the other member's receipt. `showRead` is false when I
 * turned read receipts off (then I don't see theirs either): Read collapses to Delivered.
 */
export function deliveryOf(m: Pick<ChatMessage, 'created_at' | 'pending'>, other: Receipt | null | undefined, showRead: boolean): Delivery {
  if (m.pending) return 'sending';
  if (!other) return 'sent';
  const at = Date.parse(m.created_at);
  const read = other.last_read_at ? Date.parse(other.last_read_at) >= at : false;
  if (read && showRead) return 'read';
  const delivered = other.last_delivered_at ? Date.parse(other.last_delivered_at) >= at : false;
  return delivered || read ? 'delivered' : 'sent';
}

export const DELIVERY_LABEL: Record<Delivery, { ticks: string; text: string }> = {
  sending: { ticks: '', text: 'Sending…' },
  sent: { ticks: '✓', text: 'Sent' },
  delivered: { ticks: '✓✓', text: 'Delivered' },
  read: { ticks: '✓✓', text: 'Read' },
};

/* ------------------------------------------------------------------ scheduled */

export async function listScheduled(cid: string): Promise<Scheduled[]> {
  const { data, error } = await supabase.from('scheduled_messages').select('id, body, send_at, sent_at, failed').eq('conversation_id', cid).is('sent_at', null).order('send_at');
  fail(error);
  return (data ?? []) as Scheduled[];
}

export async function scheduleMessage(cid: string, me: string, body: string, at: Date): Promise<void> {
  const { error } = await supabase.from('scheduled_messages').insert({ conversation_id: cid, sender_id: me, body, send_at: at.toISOString() });
  if (error) throw new Error(chatError(error, 'Could not schedule'));
}

export async function editScheduled(id: string, body: string, at: Date): Promise<void> {
  const { error } = await supabase.rpc('edit_scheduled_message', { sid: id, p_body: body, p_send_at: at.toISOString() });
  if (error) throw new Error(chatError(error, 'Could not save'));
}

export async function cancelScheduled(id: string): Promise<void> {
  const { error } = await supabase.from('scheduled_messages').delete().eq('id', id);
  if (error) throw new Error(chatError(error, 'Could not cancel'));
}

/* ------------------------------------------------------------------ jam + live invites */

/** Opens a new group listening room hosted by me and returns what the invite needs. */
export async function createJam(me: string, name: string): Promise<JamMeta> {
  const { data, error } = await supabase.from('rooms').insert({ host_id: me, kind: 'group', name }).select('id, code, name').single();
  if (error || !data) throw new Error(chatError(error, 'Could not start a jam'));
  const r = data as { id: string; code: string; name: string };
  const j = await supabase.from('room_members').insert({ room_id: r.id, user_id: me });
  if (j.error && j.error.code !== '23505') throw new Error(chatError(j.error, 'Could not start a jam'));
  return { room_id: r.id, code: r.code, name: r.name };
}

/** My session that is on air right now, if any. */
export async function myLiveSession(me: string): Promise<LiveMeta | null> {
  const { data, error } = await supabase.from('live_sessions').select('id, title').eq('host_id', me).eq('status', 'live').order('started_at', { ascending: false }).limit(1).maybeSingle();
  fail(error);
  const s = data as { id: string; title: string } | null;
  return s ? { session_id: s.id, title: s.title } : null;
}

/* ------------------------------------------------------------------ cross-screen bus (reply target, voice/attach results) */

/** `version` bumps whenever messages change outside the chat screen (clear chat, unsend, delete for me). */
type BusState = { replyTo: Record<string, ChatMessage | undefined>; editing: Record<string, ChatMessage | undefined>; version: number };
let bus: BusState = { replyTo: {}, editing: {}, version: 0 };
const listeners = new Set<() => void>();

export const chatBus = {
  get: () => bus,
  setReply(cid: string, m: ChatMessage | undefined) {
    bus = { ...bus, replyTo: { ...bus.replyTo, [cid]: m } };
    listeners.forEach((l) => l());
  },
  /** The message being edited in this chat's composer (set from Message options › Edit). */
  setEditing(cid: string, m: ChatMessage | undefined) {
    bus = { ...bus, editing: { ...bus.editing, [cid]: m } };
    listeners.forEach((l) => l());
  },
  /** Tell open chat screens to reload (messages were cleared, unsent or hidden elsewhere). */
  touch() {
    bus = { ...bus, version: bus.version + 1 };
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /** Sign-out / account switch: forget reply targets and edits of the previous account. */
  reset() {
    bus = { replyTo: {}, editing: {}, version: bus.version + 1 };
    listeners.forEach((l) => l());
  },
};

export function useChatReply(cid: string | undefined): ChatMessage | undefined {
  const [state, setState] = useState(bus);
  useEffect(() => chatBus.subscribe(() => setState(bus)), []);
  return cid ? state.replyTo[cid] : undefined;
}

export function useChatEditing(cid: string | undefined): ChatMessage | undefined {
  const [state, setState] = useState(bus);
  useEffect(() => chatBus.subscribe(() => setState(bus)), []);
  return cid ? state.editing[cid] : undefined;
}

/* ------------------------------------------------------------------ notification quick reply */

/**
 * Sends a plain text message as the signed-in user (session read from AsyncStorage, so it also works
 * when the app is woken by a notification action). Throws an Error whose message is already friendly
 * (RLS / block errors go through `friendlySocialError`).
 */
export async function sendChatMessage(cid: string, body: string): Promise<ChatMessage> {
  const text = body.trim();
  if (!cid || !text) throw new Error('Message is empty');
  const { data } = await supabase.auth.getSession();
  const me = data.session?.user.id;
  if (!me) throw new Error('Sign in to Zoyra to reply');
  return sendMessage(cid, me, { body: text, kind: 'text' });
}
