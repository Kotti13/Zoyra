/**
 * Direct-message access, requests and "chat tools" (Message requests, Message privacy, New message,
 * Chat tools designs). Thin wrappers over the RPCs in
 * supabase/migrations/20261115120000_dm_requests_privacy.sql, 20261115150000_dm_fixes.sql and
 * 20261115200000_dm_restrict_push_actions.sql and 20261115320000_inbox_pin_archive.sql — keep names and shapes in sync.
 */
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

import type { TrackLike } from './dm-types';
import { supabase } from './supabase';

export type { TrackLike } from './dm-types';

/* ================================================================== privacy settings */

/** Who may start a chat with me. Others' messages land in Requests (or are refused for 'none'). */
export type DmWho = 'everyone' | 'mutuals' | 'followers' | 'none';
export type GroupInvites = 'everyone' | 'mutuals' | 'none';

/** Stored in `user_settings.dm` (jsonb). The server reads the same keys. */
export type DmSettings = {
  who: DmWho;
  /** Off: I don't send read receipts and don't see others'. */
  read_receipts: boolean;
  /** Off: no green dot / "Active now" for me (I stop tracking presence). */
  online_status: boolean;
  /** Off: I don't broadcast typing. */
  typing: boolean;
  /** Off: friends don't see my current song in chat. */
  now_playing: boolean;
  /** On: suspicious requests go to Filtered. */
  filter_spam: boolean;
  /** On: song shares from people I haven't chatted with arrive as requests instead of being dropped. */
  song_shares_anyone: boolean;
  group_invites: GroupInvites;
};

export const DM_DEFAULTS: DmSettings = {
  who: 'mutuals',
  read_receipts: true,
  online_status: true,
  typing: true,
  now_playing: true,
  filter_spam: true,
  song_shares_anyone: false,
  group_invites: 'mutuals',
};

export function dmSettings(raw: Partial<DmSettings> | null | undefined): DmSettings {
  return { ...DM_DEFAULTS, ...(raw ?? {}) };
}

export const DM_WHO_LABEL: Record<DmWho, { title: string; hint: string }> = {
  everyone: { title: 'Everyone', hint: 'Non-friends land in Requests' },
  mutuals: { title: 'Mutual friends', hint: 'People you follow who follow you back' },
  followers: { title: 'Followers', hint: 'Anyone who follows you' },
  none: { title: 'No one', hint: 'Turn off new chats' },
};

/* ================================================================== access + contacts */

/**
 * What happens if I message `other`: 'direct' (straight into their chats), 'request' (lands in their
 * Requests), 'locked' (their settings refuse me), 'blocked' (a block exists either way).
 */
export type DmAccess = 'direct' | 'request' | 'locked' | 'blocked';

export type DmContact = {
  id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  access: DmAccess;
  follows_me: boolean;
  i_follow: boolean;
  mutual_count: number;
  /** Existing 1:1 conversation, if any. */
  conversation_id: string | null;
  /** 0–100 music taste overlap, null without data (or before the 20261115200000 migration). */
  taste_match?: number | null;
};

export async function dmAccess(other: string): Promise<DmAccess> {
  const { data, error } = await supabase.rpc('dm_access', { other });
  if (error) throw error;
  return (data as DmAccess) ?? 'locked';
}

/** People I can message, mutual friends first. `q` filters by name / @username (server side, max 50). */
export async function searchContacts(q: string): Promise<DmContact[]> {
  const { data, error } = await supabase.rpc('message_contacts', { q: q.trim() });
  if (error) throw error;
  return (data ?? []) as DmContact[];
}

/**
 * Opens (or creates) the 1:1 chat with `other`. Throws a friendly error when locked/blocked.
 * Returns the conversation id and whether it went out as a request.
 */
export async function startChat(other: string): Promise<{ id: string; request: boolean }> {
  const { data, error } = await supabase.rpc('start_conversation', { other });
  if (error) throw error;
  const id = String(data);
  const { data: st } = await supabase.rpc('conversation_request_state', { cid: id });
  return { id, request: st === 'outgoing' };
}

/* ================================================================== requests */

export type RequestFolder = 'requests' | 'filtered';

export type MessageRequest = {
  conversation_id: string;
  folder: RequestFolder;
  other_id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  follows_me: boolean;
  mutual_count: number;
  /** 0–100, null when either side has no taste data yet. */
  taste_match: number | null;
  /** First message preview ("Sent you a song: …" for tracks). */
  preview: string;
  created_at: string;
  /** Account younger than 7 days. */
  new_account: boolean;
  /** Sender started many requests in the last day ("Sent to many people at once"). */
  mass_sent: boolean;
  /**
   * An existing chat with someone I restrict (their new messages land here). Accept = unrestrict,
   * Decline = clear the chat for me only.
   */
  restricted: boolean;
};

/**
 * 'none' = normal chat, 'incoming' = I haven't accepted their request yet,
 * 'outgoing' = they haven't accepted mine yet.
 */
export type RequestState = 'none' | 'incoming' | 'outgoing';

export async function listRequests(): Promise<MessageRequest[]> {
  const { data, error } = await supabase.rpc('list_message_requests');
  if (error) throw error;
  return (data ?? []) as MessageRequest[];
}

export async function requestState(cid: string): Promise<RequestState> {
  const { data, error } = await supabase.rpc('conversation_request_state', { cid });
  if (error) throw error;
  return (data as RequestState) ?? 'none';
}

export async function acceptRequest(cid: string): Promise<void> {
  const { error } = await supabase.rpc('accept_message_request', { cid });
  if (error) throw error;
}

/** Deletes the request (the sender isn't told). */
export async function declineRequest(cid: string): Promise<void> {
  const { error } = await supabase.rpc('decline_message_request', { cid });
  if (error) throw error;
}

export async function declineAllRequests(folder: RequestFolder): Promise<void> {
  const { error } = await supabase.rpc('decline_all_message_requests', { folder });
  if (error) throw error;
}

/** Live count of pending requests (Requests folder only) for badges. */
export function useRequestCount(userId: string | undefined) {
  const [count, setCount] = useState(0);
  const load = useCallback(async () => {
    if (!userId) return setCount(0);
    const { data, error } = await supabase.rpc('message_request_count');
    if (!error) setCount(typeof data === 'number' ? data : 0);
  }, [userId]);
  useEffect(() => {
    void Promise.resolve().then(load);
    if (!userId) return;
    const ch = supabase
      .channel(`dm-requests:${userId}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members', filter: `user_id=eq.${userId}` }, () => void load())
      // Realtime never delivers DELETE to filtered subscriptions: listen unfiltered and just recount.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'conversation_members' }, () => void load())
      .subscribe();
    return () => void supabase.removeChannel(ch);
  }, [userId, load]);
  return { count, reload: load };
}

/** Marks every chat of mine as delivered up to now (drives ✓✓ Delivered for senders). Never throws. */
export async function markDelivered(): Promise<void> {
  try {
    await supabase.rpc('mark_delivered');
  } catch {
    // offline
  }
}

/**
 * Marks chats delivered whenever the app comes to the foreground and whenever a push arrives while it
 * is running. Mount once (root layout) while signed in.
 */
export function useDeliveryMarker(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn) return;
    void markDelivered();
    const app = AppState.addEventListener('change', (s) => {
      if (s === 'active') void markDelivered();
    });
    let received: { remove: () => void } | null = null;
    if (Platform.OS !== 'web') {
      try {
        // Any push may be a chat message; the RPC is cheap and idempotent.
        received = Notifications.addNotificationReceivedListener(() => void markDelivered());
      } catch {
        received = null;
      }
    }
    return () => {
      app.remove();
      received?.remove();
    };
  }, [signedIn]);
}

/* ================================================================== inbox */

/**
 * Row from `inbox()`: my active chats, newest first. Empty chats and chats with people I restrict are
 * left out server side; 1:1 chats across a block are included (`blocked` = 'by_me' when I blocked them).
 */
export type InboxRow = {
  conversation_id: string;
  member_count: number;
  other_id: string | null;
  other_name: string | null;
  other_username: string | null;
  other_avatar: string | null;
  last_message_id: string | null;
  last_sender_id: string | null;
  last_kind: string | null;
  last_preview: string | null;
  last_at: string | null;
  unread: number;
  /** 'outgoing' = they haven't accepted my request yet. */
  request_state: 'none' | 'outgoing';
  /** Muted for good, or until `muted_until`. */
  muted: boolean;
  /** "Mute 1h" from a notification: muted until this time (null when not time-limited). */
  muted_until: string | null;
  /**
   * 'by_me' = 1:1 chat with someone I blocked (shown with a Blocked pill, not counted as unread). A block
   * by the other person is never revealed: those rows come back as null and look like normal chats.
   */
  blocked: 'by_me' | null;
  /** Pinned by me (20261115320000_inbox_pin_archive.sql): pinned rows come first, newest pin first. */
  pinned_at?: string | null;
  /** Archived by me: still returned, the Messages screen files it under "Archived chats". */
  archived_at?: string | null;
  /** Track of the last message (cover thumbnail), null for E2EE rows. */
  last_track?: Record<string, unknown> | null;
};

/** Max pinned chats per person (enforced server side, hint 'pin_limit'). */
export const MAX_PINNED_CHATS = 5;

/** Pins / unpins a chat for me. Pinning also unarchives it. Throws "You can pin up to 5 chats" past the limit. */
export async function setChatPinned(cid: string, pinned: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_chat_pinned', { cid, pinned });
  if (error) throw error;
}

/** Archives / unarchives a chat for me. Archiving also unpins it; a new message from someone else unarchives it. */
export async function setChatArchived(cid: string, archived: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_chat_archived', { cid, archived });
  if (error) throw error;
}

export async function loadInbox(): Promise<InboxRow[]> {
  const { data, error } = await supabase.rpc('inbox');
  if (error) throw error;
  return (data ?? []) as InboxRow[];
}

/** Unread messages + pending requests, for the Home badge. */
export async function inboxUnreadTotal(): Promise<number> {
  const { data, error } = await supabase.rpc('inbox_unread_total');
  if (error) throw error;
  return typeof data === 'number' ? data : Number(data) || 0;
}

/* ================================================================== restrict */

/**
 * Restricted accounts (Message privacy → Restricted accounts). Restricting someone is silent: their new
 * messages go to Message requests without notifications, and they can't see my online status or read
 * receipts. 1:1 chats only.
 */
export type RestrictedUser = { id: string; display_name: string; username: string | null; avatar_url: string | null; restricted_at: string };

export async function restrictUser(other: string): Promise<void> {
  const { error } = await supabase.rpc('restrict_user', { other });
  if (error) throw error;
}

export async function unrestrictUser(other: string): Promise<void> {
  const { error } = await supabase.rpc('unrestrict_user', { other });
  if (error) throw error;
}

export async function listRestricted(): Promise<RestrictedUser[]> {
  const { data, error } = await supabase.rpc('list_restricted');
  if (error) throw error;
  return (data ?? []) as RestrictedUser[];
}

export async function restrictedCount(): Promise<number> {
  const { data, error } = await supabase.rpc('restricted_count');
  if (error) throw error;
  return typeof data === 'number' ? data : Number(data) || 0;
}

/** Whether I restrict `other` (only my own restrictions are readable). */
export async function isRestricted(other: string): Promise<boolean> {
  const { data, error } = await supabase.from('dm_restrictions').select('restricted').eq('restricted', other).maybeSingle();
  if (error) throw error;
  return !!data;
}

/** Live "do I restrict them?" for a chat screen (e.g. stop broadcasting presence / reading receipts). */
export function useIsRestricted(other: string | null | undefined): boolean {
  const [state, setState] = useState<{ other: string; on: boolean } | null>(null);
  useEffect(() => {
    if (!other) return;
    let alive = true;
    isRestricted(other)
      .then((on) => alive && setState({ other, on }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [other]);
  return !!other && state?.other === other && state.on;
}

/* ================================================================== mute */

/** Mutes a chat's notifications for `minutes` (null / 0 = unmute). Returns the end time. */
export async function muteConversationFor(cid: string, minutes: number | null): Promise<string | null> {
  const { data, error } = await supabase.rpc('mute_conversation', { cid, minutes: minutes ?? 0 });
  if (error) throw error;
  return typeof data === 'string' ? data : null;
}

/* ================================================================== chat tools */

/** 0–100 overlap of liked artists / followed artists, null without data. */
export async function tasteMatch(other: string): Promise<number | null> {
  const { data, error } = await supabase.rpc('taste_match', { other });
  if (error) throw error;
  return typeof data === 'number' ? data : null;
}

/**
 * Builds (or refreshes) the Blend playlist for this 1:1 chat from both members' liked songs, and posts
 * a "Blend ready" playlist message. Returns the playlist id.
 */
export async function createBlend(cid: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_blend', { cid });
  if (error) throw error;
  return String(data);
}

/** Song swap: one song per person per day in a chat; posts a `swap` message. Returns the message id. */
export async function sendSongSwap(cid: string, track: TrackLike): Promise<string> {
  const { data, error } = await supabase.rpc('send_song_swap', { cid, track });
  if (error) throw error;
  return String(data);
}

/** Rate the other person's swap pick, 1–5. */
export async function rateSongSwap(mid: string, stars: number): Promise<void> {
  const { error } = await supabase.rpc('rate_song_swap', { mid, stars });
  if (error) throw error;
}

/** Ratings for swap messages: message id → stars (by the non-sender). */
export async function swapRatings(mids: string[]): Promise<Record<string, number>> {
  if (!mids.length) return {};
  const { data, error } = await supabase.from('song_swap_ratings').select('message_id, stars').in('message_id', mids);
  if (error) throw error;
  const out: Record<string, number> = {};
  for (const r of (data ?? []) as { message_id: string; stars: number }[]) out[r.message_id] = r.stars;
  return out;
}

/** Shared queue: one listening room tied to this chat, both members in it. Returns the room id. */
export async function openSharedQueue(cid: string): Promise<string> {
  const { data, error } = await supabase.rpc('open_shared_queue', { cid });
  if (error) throw error;
  return String(data);
}
