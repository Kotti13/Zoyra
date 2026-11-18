/**
 * Group chats data layer (screens: group-chat, group-info, new-group).
 * Server side: supabase/migrations/20261115230000_group_chats.sql — keep RPC names and shapes in sync.
 * Messages, reactions, pins, polls, voice notes and photos reuse the Chat Pro tables (src/lib/chat.ts):
 * a group is a `conversations` row with kind = 'group'.
 */
import { useCallback, useEffect, useState } from 'react';

import { uploadAvatar } from './avatar';
import { startCall, toCallError, type Call, type CallKind } from './calls';
import { decryptChatRows, loadMySettings, MSG_SELECT, CHAT_GONE, type ChatMessage, type ConversationInfo, type MemberSettings, type Pin, type Reaction, type Vote } from './chat';
import type { CatalogTrack } from './catalog';
import { startChat } from './dm';
import { friendlySocialError } from './social';
import { supabase } from './supabase';

export const GROUP_MAX_MEMBERS = 64;
export const GROUP_TITLE_MAX = 64;

export type GroupRole = 'owner' | 'admin' | 'member';

export type GroupMember = {
  user_id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  role: GroupRole;
  joined_at: string;
};

export type GroupInfo = ConversationInfo & {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  avatar_url: string | null;
  created_by: string | null;
  created_at: string;
  jam_room_id: string | null;
};

export type GroupSnapshot = {
  group: GroupInfo;
  members: GroupMember[];
  mine: MemberSettings | null;
  messages: ChatMessage[];
  reactions: Reaction[];
  pins: Pin[];
  votes: Vote[];
  hidden: Set<string>;
};

/** Why someone can't be added (group_invite_refusal on the server). */
export type InviteRefusal = 'not_found' | 'blocked' | 'not_accepting' | 'mutuals_only';
export type InviteCheck = { user_id: string; ok: boolean; reason: InviteRefusal | null };

export type GroupJam = {
  room_id: string;
  code: string;
  name: string;
  host_id: string;
  is_open: boolean;
  is_playing: boolean;
  track: CatalogTrack | null;
  listeners: number;
  joined: boolean;
};

/** Thrown by loadGroupChat when the id is a 1:1 chat (open /chat-pro instead). */
export const NOT_A_GROUP = 'not_a_group';

type PgError = { message?: string; hint?: string; code?: string };

/** Friendly text for group RPC errors (server messages are already written for people). */
export function groupError(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  const err = (e ?? {}) as PgError;
  const msg = typeof err.message === 'string' ? err.message : '';
  if (/could not find the function|schema cache/i.test(msg)) return 'Group chats need the latest server update.';
  if (err.hint) return msg || fallback;
  return friendlySocialError(e, fallback);
}

const fail = (e: PgError | null) => {
  if (e) throw new Error(groupError(e));
};

/** Short label for an invite refusal (picker rows). Never says who blocked whom. */
export function refusalLabel(r: InviteRefusal | null | undefined): string {
  switch (r) {
    case 'not_accepting':
      return 'Isn’t accepting group invites';
    case 'mutuals_only':
      return 'Only friends they follow back can add them';
    case 'blocked':
    case 'not_found':
      return 'Can’t be added';
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ loading */

const GROUP_COLS = 'id, kind, title, avatar_url, created_by, created_at, jam_room_id, disappear_seconds, disappear_since, disappear_by';

export async function loadGroupInfo(cid: string): Promise<GroupInfo | null> {
  const { data, error } = await supabase.from('conversations').select(GROUP_COLS).eq('id', cid).maybeSingle();
  fail(error);
  return (data as GroupInfo | null) ?? null;
}

export async function loadGroupMembers(cid: string): Promise<GroupMember[]> {
  const { data, error } = await supabase.rpc('group_members', { cid });
  fail(error);
  return (data ?? []) as GroupMember[];
}

export async function loadGroupChat(cid: string, me: string): Promise<GroupSnapshot> {
  const [group, members, mine, msgs, reactions, pins, votes, hidden] = await Promise.all([
    loadGroupInfo(cid),
    loadGroupMembers(cid),
    loadMySettings(cid, me),
    supabase.from('messages').select(MSG_SELECT).eq('conversation_id', cid).order('created_at', { ascending: false }).limit(200),
    supabase.from('message_reactions').select('message_id, user_id, emoji').eq('conversation_id', cid),
    supabase.from('message_pins').select('message_id, pinned_by, created_at').eq('conversation_id', cid).order('created_at', { ascending: false }),
    supabase.from('poll_votes').select('message_id, user_id, option').eq('conversation_id', cid),
    supabase.from('message_hidden').select('message_id').eq('user_id', me),
  ]);
  if (!group) throw new Error(CHAT_GONE);
  if (group.kind !== 'group') throw new Error(NOT_A_GROUP);
  if (!members.some((m) => m.user_id === me)) throw new Error(CHAT_GONE);
  fail(msgs.error);
  fail(reactions.error);
  fail(pins.error);
  fail(votes.error);
  fail(hidden.error);
  return {
    group,
    members,
    mine,
    messages: (await decryptChatRows((msgs.data ?? []) as ChatMessage[])).reverse(),
    reactions: (reactions.data ?? []) as Reaction[],
    pins: (pins.data ?? []) as Pin[],
    votes: (votes.data ?? []) as Vote[],
    hidden: new Set(((hidden.data ?? []) as { message_id: string }[]).map((h) => h.message_id)),
  };
}

/* ------------------------------------------------------------------ create / manage */

/** Creates a group (I'm the owner). `title` empty → the server names it after the members. */
export async function createGroup(title: string, memberIds: string[]): Promise<string> {
  const { data, error } = await supabase.rpc('create_group', { title: title.trim() || null, member_ids: memberIds });
  fail(error);
  return String(data);
}

export async function addGroupMembers(cid: string, memberIds: string[]): Promise<number> {
  const { data, error } = await supabase.rpc('add_group_members', { cid, member_ids: memberIds });
  fail(error);
  return typeof data === 'number' ? data : Number(data) || 0;
}

export async function removeGroupMember(cid: string, uid: string): Promise<void> {
  const { error } = await supabase.rpc('remove_group_member', { cid, uid });
  fail(error);
}

export async function leaveGroup(cid: string): Promise<void> {
  const { error } = await supabase.rpc('leave_group', { cid });
  fail(error);
}

export async function renameGroup(cid: string, title: string): Promise<void> {
  const { error } = await supabase.rpc('rename_group', { cid, title: title.trim() });
  fail(error);
}

/** Uploads a picked image to the public avatars bucket (my folder) and sets it as the group photo. */
export async function setGroupPhoto(cid: string, me: string, uri: string, mime?: string | null): Promise<string> {
  const url = await uploadAvatar(me, uri, mime);
  const { error } = await supabase.rpc('set_group_avatar', { cid, url });
  fail(error);
  return url;
}

export async function clearGroupPhoto(cid: string): Promise<void> {
  const { error } = await supabase.rpc('set_group_avatar', { cid, url: null });
  fail(error);
}

export async function setGroupRole(cid: string, uid: string, role: GroupRole): Promise<void> {
  const { error } = await supabase.rpc('set_group_role', { cid, uid, role });
  fail(error);
}

/** Which of `ids` I may add to a group (privacy + blocks). Missing ids count as ok. */
export async function checkInvites(ids: string[]): Promise<Map<string, InviteCheck>> {
  if (!ids.length) return new Map();
  const { data, error } = await supabase.rpc('group_invite_check', { ids });
  fail(error);
  return new Map(((data ?? []) as InviteCheck[]).map((r) => [r.user_id, r]));
}

/* ------------------------------------------------------------------ jam */

export async function loadGroupJam(cid: string): Promise<GroupJam | null> {
  const { data, error } = await supabase.rpc('group_jam', { cid });
  fail(error);
  return (((data ?? []) as GroupJam[])[0] ?? null);
}

/** Opens (or reuses) the group's jam, joins me and posts a jam message when it's new. Returns the room id. */
export async function startGroupJam(cid: string): Promise<string> {
  const { data, error } = await supabase.rpc('start_group_jam', { cid });
  fail(error);
  return String(data);
}

/** Live jam state for a group: reloads on room changes (realtime) and every 20 s. */
export function useGroupJam(cid: string | undefined) {
  const [jam, setJam] = useState<GroupJam | null>(null);
  const reload = useCallback(() => {
    if (!cid) return;
    loadGroupJam(cid)
      .then(setJam)
      .catch(() => undefined);
  }, [cid]);
  const roomId = jam?.room_id;
  useEffect(() => {
    if (!cid) return;
    reload();
    const t = setInterval(reload, 20_000);
    return () => clearInterval(t);
  }, [cid, reload]);
  useEffect(() => {
    if (!roomId) return;
    const ch = supabase
      .channel(`groupjam:${roomId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` }, reload)
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [roomId, reload]);
  return { jam, reload };
}

/* ------------------------------------------------------------------ calls (1:1 with one member) */

/** Calls one member in our 1:1 chat (opened / created first). Throws a friendly Error. */
export async function callMember(uid: string, kind: CallKind): Promise<Call> {
  let cid: string;
  try {
    cid = (await startChat(uid)).id;
  } catch (e) {
    throw new Error(friendlySocialError(e, 'Couldn’t start the call.'));
  }
  try {
    return await startCall(cid, kind);
  } catch (e) {
    throw new Error(toCallError(e).message);
  }
}

/* ------------------------------------------------------------------ display helpers */

export const firstName = (n: string | null | undefined) => (n ?? '').trim().split(/\s+/)[0] || 'Someone';

/** "Priya, Aarav, Meera, you" (others by join order, max 3 names, then "+N"). */
export function memberSummary(members: GroupMember[], me: string | undefined): string {
  const others = members.filter((m) => m.user_id !== me);
  const names = others.slice(0, 3).map((m) => firstName(m.display_name));
  const extra = others.length > 3 ? ` +${others.length - 3}` : '';
  return [...names, 'you'].join(', ') + extra;
}

export const roleLabel = (r: GroupRole) => (r === 'owner' ? 'Owner' : r === 'admin' ? 'Admin' : '');
export const isAdmin = (r: GroupRole | null | undefined) => r === 'owner' || r === 'admin';

export const groupChatHref = (id: string) => ({ pathname: '/group-chat' as const, params: { id } });
