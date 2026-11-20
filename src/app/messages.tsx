import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { BackHandler, RefreshControl, ScrollView, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import { ForeverBadge, ForeverRing, ForeverTag } from '../components/forever';
import { sortForeverFirst, useForeverIds } from '../lib/forever';

import { Cover, EmptyState, ErrorState, Glass, Icon, IconButton, ListRow, Row, Screen, T, Tap, Toggle, type IconName } from '../components';
import { chatPeerParams, decryptChatRows, formatMs, messagePreview, MSG_SELECT, trackArtist, updateMySettings, voiceMeta, type ChatMessage } from '../lib/chat';
import { confirmClearHref } from '../lib/confirm-routes';
import { loadInbox, markDelivered, MAX_PINNED_CHATS, muteConversationFor, restrictUser, setChatArchived, setChatPinned, useRequestCount, type DmSettings, type InboxRow } from '../lib/dm';
import { useE2EE } from '../lib/e2ee';
import { RestoreHistoryCard } from '../lib/e2ee/ui';
import {
  ChatContextMenu,
  closeOpenSwipeRow,
  CountPill,
  GlassCard,
  InboxSkeleton,
  InboxTabs,
  NoteFace,
  OnlineDot,
  PresenceFace,
  RoundFace,
  RowPill,
  SwipeRow,
  type ContextMenuItem,
  type InboxTab,
  type RowRect,
  type SwipeAction,
} from '../lib/inbox-ui';
import { listNotes, noteSongLine, type UserNote } from '../lib/notes';
import { NoteSheet } from '../lib/notes-ui';
import { useOnlineUsers } from '../lib/presence';
import { friendlySocialError, useBlocks } from '../lib/social';
import { supabase } from '../lib/supabase';
import { authenticate, useChatLocks } from '../lib/chat-lock';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

/**
 * Inbox, in Zoyra's cinematic glass style. Rows come from `inbox()`. The group chats migration adds
 * `kind`, `title`, `avatar_url`, `last_sender_name` (and possibly `jam_room_id` / `last_meta`); the pin &
 * archive migration (20261115320000) adds `pinned_at`, `archived_at`, `last_track`. They are read when
 * present, with the older fields as fallback.
 *
 * Layout: large light title + "N unread · M online" with glass Requests / accent New message buttons → glass Search pill →
 * "Now playing with friends" strip: glass speech bubbles above round photos ("Your note" → my NoteSheet (play / edit / new / delete), or /note-compose when I have none;
 * friends' notes (tap: NoteSheet with Reply / Play song) with ♪ song; then people online / recent as round avatars) →
 * restore card (new phone with a chat backup: "Backup found from 12 Nov · 1.2 MB") →
 * accent filter chips All · Unread · Groups · Jams · Requests (Requests opens /message-requests) → PINNED glass card + chats glass card
 * (swipe right: Pin, swipe left: Mute / Archive / Delete; long press: ChatContextMenu with the row lifted:
 * Pin · Mute notifications · Archive · Restrict · Block) → "Archived chats (N)".
 * Archived chats open as an in-screen view (hardware back returns to the inbox) with the archive settings
 * (user_settings.dm archive_keep_muted / archive_keep, honoured by the server's auto-unarchive trigger).
 *
 * Forever friends (lead wires these): `isForeverChat` below, and the `FOREVER: badge` comments in the row,
 * the notes strip and the long-press menu.
 */

/** FOREVER: replace with the Forever friends lookup (true = the other person in this 1:1 chat is a Forever friend). */
/** True when the other person in this 1:1 chat is one of my Forever friends. */
const isForeverChat = (t: { other: { id: string } | null; group: boolean }, ids: ReadonlySet<string>): boolean => !t.group && !!t.other && ids.has(t.other.id);
type InboxRowX = InboxRow & {
  kind?: string | null;
  title?: string | null;
  avatar_url?: string | null;
  last_sender_name?: string | null;
  jam_room_id?: string | null;
  last_meta?: Record<string, unknown> | null;
};

type Person = { id: string; display_name: string; avatar_url: string | null };
/** Delivery state of my own last message: Sent ✓, Delivered ✓✓ (grey), Read ✓✓ (accent). */
type Receipt = 'sent' | 'delivered' | 'read';
/** Row preview: text with a kind emoji ("🎵 Song · Artist", "🎤 Voice message · 0:24") and an optional cover. */
type Preview = { text: string; cover: string | null };
type Thread = {
  id: string;
  /** The other person (for a group: the one `inbox()` names). */
  other: Person | null;
  memberCount: number;
  group: boolean;
  /** Group title / picture (null for 1:1 or before the group chats migration). */
  title: string | null;
  avatar: string | null;
  /** Preview without any "You:" / "Sender:" prefix. */
  preview: string;
  /** Track cover for song shares (tiny thumbnail before the preview). */
  cover: string | null;
  /** First name of the group member who sent the last message (null when mine or unknown). */
  senderFirst: string | null;
  mine: boolean;
  lastId: string | null;
  lastKind: string | null;
  lastAt: string | null;
  at: string;
  unreadCount: number;
  receipt: Receipt | null;
  muted: boolean;
  /** Active jam: see JAM_WINDOW_MS. */
  jam: boolean;
  /** They haven't accepted my request yet. */
  requestSent: boolean;
  /** I blocked them (server flag; a block by them is never revealed). */
  blockedByMe: boolean;
  pinned: boolean;
  archived: boolean;
};
type ReceiptRow = { user_id: string; last_read_at: string | null; last_delivered_at: string | null };
type Filter = 'primary' | 'unread' | 'groups' | 'jams' | 'requests';
type Note = { text: string; tone?: 'error' | 'info'; undo?: () => void };

const AMBER = colors.gold;
const ROW_H = 72;
const AVATAR = 52;
const AVATAR_R = 17;
/** Ring around dots / stacked faces drawn over the glass list. */
const RING = '#141414';
/** Round glass swipe-action fill. */
const GLASS_BTN = withAlpha(colors.white, 0.12);
/**
 * "Jams" filter: chats with an active jam = the last message is a jam invite sent in the last 12 hours,
 * or a group whose `jam_room_id` is set (when `inbox()` provides it).
 */
const JAM_WINDOW_MS = 12 * 60 * 60_000;

function when(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  if (h < 48) return 'Yesterday';
  if (h < 24 * 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Cover URL from a track jsonb (`artwork` is a string or { small, medium, large }). */
function artOf(track: unknown): string | null {
  if (!track || typeof track !== 'object') return null;
  const a = (track as { artwork?: unknown }).artwork;
  if (typeof a === 'string') return a || null;
  if (a && typeof a === 'object') {
    const o = a as Record<string, unknown>;
    const v = o.small ?? o.medium ?? o.large;
    return typeof v === 'string' && v ? v : null;
  }
  return null;
}

function songLine(track: unknown): string | null {
  if (!track || typeof track !== 'object') return null;
  const title = (track as { title?: unknown }).title;
  if (typeof title !== 'string' || !title.trim()) return null;
  const artist = trackArtist(track as { artist?: unknown });
  return artist ? `${title} · ${artist}` : title;
}

/**
 * Rich preview from a message kind + plain preview text (server `last_preview`, or `messagePreview()` of a
 * decrypted E2EE message), its meta and its track.
 */
function richPreview(kind: string | null | undefined, text: string, meta: Record<string, unknown> | null | undefined, track: unknown): Preview {
  const t = text.trim();
  const song = songLine(track);
  switch (kind) {
    case 'voice': {
      const ms = meta?.duration_ms;
      return { text: typeof ms === 'number' && ms > 0 ? `🎤 ${formatMs(ms)}` : '🎤 Voice message', cover: null };
    }
    case 'photo':
      return { text: '📷 Photo', cover: null };
    case 'poll':
      return { text: `📊 ${t || 'Poll'}`, cover: null };
    case 'jam': {
      const room = typeof meta?.name === 'string' && meta.name.trim() ? meta.name.trim() : null;
      return { text: room ? `🎧 Jam · ${room}` : `🎧 ${t && !/^Invited you/.test(t) ? t : 'Jam invite'}`, cover: null };
    }
    case 'live':
      return { text: `🔴 ${t || 'Live session'}`, cover: null };
    case 'call': {
      const video = meta?.kind === 'video';
      const d = typeof meta?.duration_s === 'number' ? Math.max(0, Math.floor(meta.duration_s)) : null;
      if (meta?.status === 'ended') return { text: `📞 ${video ? 'Video call' : 'Call'}${d !== null ? ` · ${formatMs(d * 1000)}` : ''}`, cover: null };
      if (meta?.status === 'declined') return { text: `📞 Declined ${video ? 'video call' : 'call'}`, cover: null };
      if (meta?.status) return { text: `📞 Missed ${video ? 'video call' : 'call'}`, cover: null };
      return { text: `📞 ${t || 'Call'}`, cover: null };
    }
    case 'location':
      return { text: '📍 Location', cover: null };
    case 'playlist':
      return { text: `💿 ${t.replace(/^Sent you a playlist: /, '') || 'Playlist'}`, cover: null };
    case 'swap':
      return { text: song ? `🔁 Song swap · ${song}` : `🔁 ${t || 'Song swap'}`, cover: artOf(track) };
    default:
      break;
  }
  if (song && (kind === 'track' || !t || /^Sent you a song/.test(t) || t === song)) return { text: `🎵 ${song}`, cover: artOf(track) };
  if (/^Sent you a song: /.test(t)) return { text: t.replace(/^Sent you a song: /, '🎵 '), cover: null };
  return { text: t || 'Message', cover: null };
}

/** Row preview from `inbox()` (last_preview / last_kind / last_meta / last_track). */
function previewOf(r: InboxRowX): Preview {
  const text = r.last_preview?.trim();
  if (!text) return { text: 'Say hi', cover: null };
  return richPreview(r.last_kind, text, r.last_meta, r.last_track);
}

/** Decrypted inbox previews by message id (E2EE rows: the server only knows 'Sent you a message'). */
const e2eePreviews = new Map<string, Preview>();

/** Fills `preview` for threads whose last message is end-to-end encrypted (one batch query + decrypt). */
async function decryptPreviews(rows: InboxRowX[], list: Thread[]): Promise<void> {
  const ids = rows.filter((r) => r.last_message_id && ((r.last_meta as Record<string, unknown> | null | undefined)?.e2ee !== undefined || r.last_preview === 'Sent you a message')).map((r) => r.last_message_id as string);
  const missing = ids.filter((id) => !e2eePreviews.has(id));
  if (missing.length) {
    const { data } = await supabase.from('messages').select(MSG_SELECT).in('id', missing.slice(0, 100));
    const msgs = await decryptChatRows((data ?? []) as ChatMessage[]);
    for (const m of msgs) {
      if (m.meta?.e2ee_pending === true || m.meta?.e2ee_error === 'server') continue; // retry next load
      const plain = messagePreview(m);
      const failed = m.meta?.e2ee_error !== undefined || plain === 'Encrypted message';
      e2eePreviews.set(m.id, failed ? { text: plain, cover: null } : richPreview(m.kind, plain, m.kind === 'voice' ? { duration_ms: voiceMeta(m)?.duration_ms } : m.meta, m.track));
    }
    if (e2eePreviews.size > 500) e2eePreviews.delete(e2eePreviews.keys().next().value as string);
  }
  for (const t of list) {
    const hit = t.lastId ? e2eePreviews.get(t.lastId) : undefined;
    if (hit) {
      t.preview = hit.text;
      t.cover = hit.cover;
    }
  }
}

const threadName = (t: Thread) => {
  if (!t.group) return t.other?.display_name ?? 'Listener';
  if (t.title) return t.title;
  const n = t.other?.display_name ?? 'Listener';
  return `${n.split(' ')[0]} +${Math.max(1, t.memberCount - 2)}`;
};

/** Receipt for my last message: read when every other member has read past it, else delivered, else sent. */
async function receiptFor(cid: string, me: string, sentAt: string): Promise<Receipt> {
  const { data, error } = await supabase.rpc('conversation_receipts', { cid });
  if (error) return 'sent';
  const rows = ((data ?? []) as ReceiptRow[]).filter((r) => r.user_id !== me);
  if (!rows.length) return 'sent';
  const at = new Date(sentAt).getTime();
  const past = (iso: string | null) => !!iso && new Date(iso).getTime() >= at;
  if (rows.every((r) => past(r.last_read_at))) return 'read';
  if (rows.every((r) => past(r.last_delivered_at) || past(r.last_read_at))) return 'delivered';
  return 'sent';
}

/** 52 px squircle row avatar: a person, a group picture, or two stacked faces for a group without one. */
function ThreadAvatar({ t, online }: { t: Thread; online: boolean }) {
  if (t.group && !t.avatar) {
    return (
      <View style={{ width: AVATAR, height: AVATAR }}>
        <RoundFace id={t.id} name={threadName(t)} size={38} radius={13} />
        <View style={{ position: 'absolute', right: -1, bottom: -1, borderRadius: 14, borderWidth: 2, borderColor: RING }}>
          <RoundFace id={t.other?.id} name={t.other?.display_name} uri={t.other?.avatar_url} size={34} radius={12} />
        </View>
      </View>
    );
  }
  return (
    <View style={{ width: AVATAR, height: AVATAR }}>
      {t.group ? <RoundFace id={t.id} name={threadName(t)} uri={t.avatar} size={AVATAR} radius={AVATAR_R} /> : <RoundFace id={t.other?.id} name={t.other?.display_name} uri={t.other?.avatar_url} size={AVATAR} radius={AVATAR_R} />}
      {online ? (
        <View accessibilityLabel="Online" style={{ position: 'absolute', right: -2, bottom: -2 }}>
          <OnlineDot size={14} ring={RING} />
        </View>
      ) : null}
    </View>
  );
}

function Ticks({ receipt }: { receipt: Receipt }) {
  const read = receipt === 'read';
  return (
    <T size={12} weight={600} color={read ? colors.accentLight : colors.textSecondary} accessibilityLabel={read ? 'Read' : receipt === 'delivered' ? 'Delivered' : 'Sent'}>
      {receipt === 'sent' ? '✓' : '✓✓'}
    </T>
  );
}

/** Kind emoji at the start of a preview ("🎵 Song · Artist") → a line icon in the row. */
const KIND_ICONS: [string, IconName][] = [
  ['🎵', 'music'],
  ['🎤', 'mic'],
  ['📷', 'camera'],
  ['📊', 'chart'],
  ['🎧', 'headphones'],
  ['🔴', 'broadcast'],
  ['📞', 'call'],
  ['📍', 'pin'],
  ['💿', 'library'],
  ['🔁', 'repeat'],
];
function splitKind(text: string): { icon: IconName | null; text: string } {
  for (const [emoji, icon] of KIND_ICONS) if (text.startsWith(`${emoji} `)) return { icon, text: text.slice(emoji.length + 1) };
  return { icon: null, text };
}

function openThread(t: Thread, locked = false) {
  if (locked) {
    void authenticate('Unlock this chat').then((ok) => ok && openThread(t, false));
    return;
  }
  if (t.group) {
    router.push({ pathname: '/group-chat', params: { id: t.id } });
    return;
  }
  router.push({ pathname: '/chat-pro', params: { id: t.id, ...(t.other ? chatPeerParams(t.other) : {}) } });
}

type RowHandlers = {
  onMenu: (t: Thread, rect: RowRect | null) => void;
  onPin: (t: Thread) => void;
  onMute: (t: Thread) => void;
  onArchive: (t: Thread, archived: boolean) => void;
  onDelete: (t: Thread) => void;
};

/** Spoken summary of a row (the list row and the menu title). */
function rowLabel(t: Thread, isBlock: boolean, online: boolean) {
  const unread = t.unreadCount > 0 && !isBlock;
  const ticks = t.mine && t.receipt && !isBlock ? t.receipt : null;
  const prefix = isBlock ? '' : t.mine ? (t.group || !ticks ? 'You: ' : '') : t.group && t.senderFirst ? `${t.senderFirst}: ` : '';
  const preview = isBlock ? 'You blocked this person' : `${prefix}${t.preview}`;
  const seen = ticks === 'read' ? ', seen' : ticks === 'delivered' ? ', delivered' : ticks === 'sent' ? ', sent' : '';
  return `${threadName(t)}${t.group ? ', group' : ''}${t.pinned ? ', pinned' : ''}${isBlock ? ', blocked' : ''}${t.requestSent ? ', request sent' : ''}${online ? ', online' : ''}${t.muted ? ', muted' : ''}: ${preview}${seen}, ${when(t.at)}${unread ? `, ${t.unreadCount} unread` : ''}`;
}

/**
 * The visible part of a chat row (MsgHome): squircle avatar (online dot), name + time, then ticks · kind
 * icon · preview, and at the end the Blocked / Request sent pill, a muted bell with a grey count, or the
 * accent unread count; song shares show their cover on the right. Also drawn lifted in the long-press menu.
 */
const RowBody = memo(function RowBody({ t, isBlock, online }: { t: Thread; isBlock: boolean; online: boolean }) {
  const name = threadName(t);
  const unread = t.unreadCount > 0 && !isBlock;
  const ticks = t.mine && t.receipt && !isBlock ? t.receipt : null;
  // 1:1: my last message shows ticks instead of "You:"; groups always name the sender.
  const prefix = isBlock ? '' : t.mine ? (t.group || !ticks ? 'You: ' : '') : t.group && t.senderFirst ? `${t.senderFirst}: ` : '';
  const kind = isBlock ? { icon: null, text: 'You blocked this person' } : splitKind(t.preview);
  const tone = unread ? colors.text : colors.textSecondary;
  return (
    <Row gap={14} style={{ minHeight: ROW_H, paddingVertical: 8 }}>
      <View style={isBlock ? { opacity: 0.45 } : undefined}>
        <ForeverRing uid={t.group ? null : t.other?.id} radius={AVATAR_R}>
          <ThreadAvatar t={t} online={online} />
        </ForeverRing>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Row gap={6}>
          <T size={16} weight={unread ? 700 : 600} tracking={-0.1} numberOfLines={1} style={{ flexShrink: 1 }}>
            {name}
          </T>
          <View style={{ flex: 1 }} />
          <T size={12} color={unread ? colors.accentLight : colors.textSecondary} accessibilityElementsHidden importantForAccessibility="no">
            {when(t.at)}
          </T>
        </Row>
        <Row gap={6}>
          {ticks ? <Ticks receipt={ticks} /> : null}
          {prefix ? (
            <T size={14} color={colors.peach} numberOfLines={1}>
              {prefix}
            </T>
          ) : null}
          {kind.icon ? <Icon name={kind.icon} size={14} color={unread ? colors.accentLight : colors.textSecondary} strokeWidth={1.9} /> : null}
          <T size={14} weight={unread ? 500 : 400} color={tone} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
            {kind.text}
          </T>
          {isBlock ? <RowPill label="Blocked" /> : t.requestSent ? <RowPill label="Request sent" /> : null}
          {t.muted && !isBlock ? <Icon name="bellOff" size={14} color={colors.textSecondary} strokeWidth={1.8} /> : null}
          {unread ? <CountPill count={t.unreadCount} light={t.muted} /> : null}
          {t.pinned ? <Icon name="pushPin" size={15} color={colors.textSecondary} strokeWidth={1.8} /> : null}
        </Row>
      </View>
      {t.cover && !isBlock ? <Cover uri={t.cover} size={44} radius={22} /> : null}
    </Row>
  );
});

/** One chat row: swipe right = Pin, swipe left = Mute / Archive / Delete, long press = menu. */
const ThreadRow = memo(function ThreadRow({ t, isBlock, online, locked, handlers }: { t: Thread; isBlock: boolean; online: boolean; locked: boolean; handlers: RowHandlers }) {
  const { onMenu, onPin, onMute, onArchive, onDelete } = handlers;
  const ref = useRef<ComponentRef<typeof View>>(null);

  const pinAction: SwipeAction = { key: 'pin', label: t.pinned ? 'Unpin' : 'Pin', icon: 'pushPin', color: GLASS_BTN, fg: colors.gold, onPress: () => onPin(t) };
  const muteAction: SwipeAction = { key: 'mute', label: t.muted ? 'Unmute' : 'Mute', icon: t.muted ? 'bell' : 'bellOff', color: GLASS_BTN, fg: colors.text, onPress: () => onMute(t) };
  const archiveAction: SwipeAction = { key: 'archive', label: t.archived ? 'Unarchive' : 'Archive', icon: 'storage', color: GLASS_BTN, fg: colors.text, onPress: () => onArchive(t, !t.archived) };
  const deleteAction: SwipeAction = { key: 'delete', label: 'Delete', icon: 'trash', color: colors.accent, onPress: () => onDelete(t) };
  const left = t.archived ? [] : [pinAction];
  const right = [muteAction, archiveAction, deleteAction];

  const onA11yAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'menu') return openMenu();
    const a = [...left, ...right].find((x) => x.key === e.nativeEvent.actionName);
    a?.onPress();
  };

  /** Measures the row so the menu can lift it in place. */
  function openMenu() {
    const v = ref.current;
    if (!v) return onMenu(t, null);
    v.measureInWindow((x, y, width, height) => onMenu(t, width > 0 ? { x, y, width, height } : null));
  }

  return (
    <View ref={ref} collapsable={false}>
      <SwipeRow left={left} right={right}>
        <Tap
          pressScale={0.98}
          onPress={() => openThread(t, locked)}
          onLongPress={openMenu}
          accessibilityLabel={rowLabel(t, isBlock, online)}
          accessibilityHint="Long press for more options"
          accessibilityActions={[...left, ...right].map((a) => ({ name: a.key, label: a.key === 'delete' ? 'Delete chat' : a.label })).concat({ name: 'menu', label: 'More options' })}
          onAccessibilityAction={onA11yAction}
        >
          <RowBody t={t} isBlock={isBlock} online={online} />
        </Tap>
      </SwipeRow>
    </View>
  );
});

/** Rows stacked straight on the backdrop (MsgHome: no card, no dividers). */
function RowGroup({ label, threads, render }: { label?: string; threads: Thread[]; render: (t: Thread) => ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      {label ? <SectionLabel>{label}</SectionLabel> : null}
      <View>
        {threads.map((t) => (
          <Fragment key={t.id}>{render(t)}</Fragment>
        ))}
      </View>
    </View>
  );
}

/** Small uppercase overline (PINNED, NOW PLAYING WITH FRIENDS). */
function SectionLabel({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <Row gap={8} style={{ paddingHorizontal: 4 }}>
      <T variant="overline" color={colors.textSecondary} accessibilityRole="header" style={{ flex: 1, textTransform: 'uppercase' }}>
        {children}
      </T>
      {right}
    </Row>
  );
}

/** "Backup found from 12 Nov · 1.2 MB" (chat_backup_summary, 20261117120000). */
type BackupSummary = { exists: boolean; updated_at?: string; chats?: number; bytes?: number };

const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

/**
 * Restore card (MsgHome): amber glass card "Restore your chat history? · Backup found from 12 Nov · 1.2 MB"
 * → /e2ee-restore, shown while this phone has an undecided restore offer for a PIN backup. Other undecided
 * states (keys reset on another phone, password confirm) keep the existing RestoreHistoryCard.
 */
function InboxRestoreCard() {
  const snap = useE2EE();
  const offer = snap.status === 'needs_restore' && snap.restoreReason === 'backup';
  const [summary, setSummary] = useState<BackupSummary | null>(null);
  useEffect(() => {
    if (!offer) return;
    let alive = true;
    void supabase.rpc('chat_backup_summary').then(({ data, error }) => {
      if (alive && !error && data && typeof data === 'object') setSummary(data as BackupSummary);
    });
    return () => {
      alive = false;
    };
  }, [offer]);
  if (!offer) return <RestoreHistoryCard />;
  const date = summary?.updated_at ? new Date(summary.updated_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null;
  const sub = date ? `Backup found from ${date}${summary?.bytes ? ` · ${fmtBytes(summary.bytes)}` : ''}` : 'Enter your backup PIN to read older messages';
  return (
    <Tap href="/e2ee-restore" pressScale={0.98} accessibilityLabel={`Restore your chat history? ${sub}`} accessibilityHint="Opens Restore chats">
      <View style={{ borderRadius: 26, overflow: 'hidden', borderWidth: 1, borderColor: withAlpha(AMBER, 0.4), paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <LinearGradient colors={[withAlpha(AMBER, 0.2), 'rgba(20,20,20,0.6)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: AMBER, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="lock" size={19} color={colors.onLight} strokeWidth={2} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={14} weight={700}>
            Restore your chat history?
          </T>
          <T size={12} color={colors.peach} numberOfLines={1}>
            {sub}
          </T>
        </View>
        <Icon name="chevronRight" size={18} color={colors.text} />
      </View>
    </Tap>
  );
}

export default function Messages() {
  const foreverIds = useForeverIds();
  const { user, profile, settings, updateSettings } = useAuth();
  const me = user?.id;
  const [filter, setFilter] = useState<Filter>('primary');
  const [view, setView] = useState<'inbox' | 'archived'>('inbox');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const { blocked, block, unblock } = useBlocks(me);
  const { count: requestCount, reload: reloadRequests } = useRequestCount(me);
  const onlineIds = useOnlineUsers();
  /** Notes (src/lib/notes.ts): mine first when active, then friends' newest first. Refreshed on focus / pull. */
  const [notes, setNotes] = useState<UserNote[]>([]);
  /** Open note sheet: the notes it pages through (friends' notes, or just mine) and which one is shown first. */
  const [openNote, setOpenNote] = useState<{ list: UserNote[]; index: number } | null>(null);
  /** Long-press menu: the chat and where its row is on screen. */
  const [menu, setMenu] = useState<{ t: Thread; rect: RowRect | null; items: ContextMenuItem[] } | null>(null);
  const loadNotes = useCallback(async () => {
    if (!me) return;
    try {
      setNotes(await listNotes());
    } catch {
      // Notes are optional (e.g. before the user_notes migration): keep whatever was shown.
    }
  }, [me]);

  /** Receipt per conversation for my last message; 'read' is final for that message, so it isn't re-asked. */
  const receiptCache = useRef(new Map<string, { mid: string; receipt: Receipt }>());

  const load = useCallback(
    async (quiet = false) => {
      if (!me) return;
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const rows = (await loadInbox()) as InboxRowX[];
        const now = Date.now();
        const list: Thread[] = rows.map((r) => {
          const mine = r.last_sender_id === me;
          const memberCount = Number(r.member_count) || 2;
          const group = r.kind ? r.kind === 'group' : memberCount > 2;
          const sender = mine ? null : (r.last_sender_name ?? (r.last_sender_id && r.last_sender_id === r.other_id ? r.other_name : null));
          const recentJam = r.last_kind === 'jam' && !!r.last_at && now - new Date(r.last_at).getTime() < JAM_WINDOW_MS;
          const pv = previewOf(r);
          return {
            id: r.conversation_id,
            other: r.other_id ? { id: r.other_id, display_name: r.other_name ?? 'Listener', avatar_url: r.other_avatar } : null,
            memberCount,
            group,
            title: r.title?.trim() || null,
            avatar: r.avatar_url ?? null,
            preview: pv.text,
            cover: pv.cover,
            senderFirst: sender ? sender.split(' ')[0] : null,
            mine,
            lastId: r.last_message_id,
            lastKind: r.last_kind,
            lastAt: r.last_at,
            at: r.last_at ?? new Date().toISOString(),
            unreadCount: Number(r.unread) || 0,
            receipt: null,
            muted: !!r.muted,
            jam: recentJam || (group && !!r.jam_room_id),
            requestSent: r.request_state === 'outgoing',
            blockedByMe: r.blocked === 'by_me',
            pinned: !!r.pinned_at,
            archived: !!r.archived_at,
          };
        });
        await decryptPreviews(rows, list).catch(() => undefined);
        // Ticks only for rows whose last message is mine: one conversation_receipts call each.
        const cache = receiptCache.current;
        await Promise.all(
          list.map(async (t) => {
            if (!t.mine || !t.lastAt || !t.lastId || t.blockedByMe) return;
            const hit = cache.get(t.id);
            if (hit && hit.mid === t.lastId && hit.receipt === 'read') {
              t.receipt = 'read';
              return;
            }
            t.receipt = await receiptFor(t.id, me, t.lastAt).catch((): Receipt => 'sent');
            cache.set(t.id, { mid: t.lastId, receipt: t.receipt });
          }),
        );
        setThreads(list);
      } catch (e) {
        setError(friendlySocialError(e, 'Could not load messages'));
      } finally {
        setLoading(false);
      }
    },
    [me],
  );

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(true), 400);
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void markDelivered();
      void load(true);
      void reloadRequests();
      void loadNotes();
    }, [load, reloadRequests, loadNotes]),
  );

  // New messages and changes to my memberships (incl. pin / archive / auto-unarchive) refresh the inbox
  // (debounced: they arrive in bursts).
  useEffect(() => {
    if (!me) return;
    const ch = supabase
      .channel(`inbox:${me}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => {
        if ((p.new as { sender_id?: string } | undefined)?.sender_id !== me) void markDelivered();
        soon();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members', filter: `user_id=eq.${me}` }, soon)
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      void supabase.removeChannel(ch);
    };
  }, [me, soon]);

  // Android back closes the Archived view first.
  useEffect(() => {
    if (view !== 'archived') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setView('inbox');
      return true;
    });
    return () => sub.remove();
  }, [view]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([load(true), reloadRequests(), loadNotes()]);
    } finally {
      setRefreshing(false);
    }
  }, [load, reloadRequests, loadNotes]);

  /** Blocked by me: the server flag, or a block made on this screen a moment ago (until the next reload). */
  const isBlocked = useCallback((t: Thread) => !t.group && !!t.other && (t.blockedByMe || blocked.has(t.other.id)), [blocked]);

  /** Optimistic local change, then a quiet reload for the server's truth. */
  const patch = useCallback((id: string, p: Partial<Thread>) => setThreads((list) => list.map((t) => (t.id === id ? { ...t, ...p } : t))), []);

  const togglePin = useCallback(
    async (t: Thread) => {
      setNote(null);
      if (!t.pinned && threads.filter((x) => x.pinned && x.id !== t.id).length >= MAX_PINNED_CHATS) {
        setNote({ text: `You can pin up to ${MAX_PINNED_CHATS} chats. Unpin one first.`, tone: 'error' });
        return;
      }
      patch(t.id, t.pinned ? { pinned: false } : { pinned: true, archived: false });
      try {
        await setChatPinned(t.id, !t.pinned);
      } catch (e) {
        setNote({ text: friendlySocialError(e, 'Could not pin this chat'), tone: 'error' });
      }
      void load(true);
    },
    [threads, patch, load],
  );

  const applyArchived = useCallback(
    async (t: Thread, archived: boolean) => {
      patch(t.id, archived ? { archived: true, pinned: false } : { archived: false });
      await setChatArchived(t.id, archived);
    },
    [patch],
  );

  const setArchived = useCallback(
    async (t: Thread, archived: boolean) => {
      setNote(null);
      try {
        await applyArchived(t, archived);
        setNote({
          text: archived ? `Archived ${threadName(t)}.` : `Moved ${threadName(t)} back to your chats.`,
          tone: 'info',
          undo: () => {
            void (async () => {
              try {
                await applyArchived(t, !archived);
                if (archived && t.pinned) await setChatPinned(t.id, true);
              } catch (e) {
                setNote({ text: friendlySocialError(e, 'Could not update this chat'), tone: 'error' });
              }
              void load(true);
            })();
          },
        });
      } catch (e) {
        setNote({ text: friendlySocialError(e, 'Could not update this chat'), tone: 'error' });
      }
      void load(true);
    },
    [applyArchived, load],
  );

  const toggleMute = useCallback(
    async (t: Thread) => {
      if (!me) return;
      setNote(null);
      patch(t.id, { muted: !t.muted });
      try {
        if (t.muted) {
          await updateMySettings(t.id, me, { muted: false });
          await muteConversationFor(t.id, null);
        } else {
          await updateMySettings(t.id, me, { muted: true });
        }
      } catch (e) {
        setNote({ text: friendlySocialError(e, 'Could not change notifications'), tone: 'error' });
      }
      void load(true);
    },
    [me, patch, load],
  );

  const deleteChat = useCallback((t: Thread) => router.push(confirmClearHref(t.id, threadName(t), { group: t.group })), []);

  /** Long-press menu actions (MsgLongPress): Pin · Mute notifications · Archive, plus Restrict / Block (or Unblock) for 1:1 chats. */
  const menuItems = (t: Thread): ContextMenuItem[] => {
    const p = !t.group ? t.other : null;
    const blockedChat = isBlocked(t);
    const forever = isForeverChat(t, foreverIds);
    const guard = (fn: () => Promise<void>) => () => {
      setNote(null);
      void fn().catch((e: unknown) => setNote({ text: friendlySocialError(e, 'Could not update this chat'), tone: 'error' }));
    };
    const items: ContextMenuItem[] = [
      { key: 'pin', label: t.pinned ? 'Unpin' : 'Pin', icon: 'pushPin', onPress: guard(() => togglePin(t)) },
      { key: 'mute', label: t.muted ? 'Unmute notifications' : 'Mute notifications', icon: t.muted ? 'bell' : 'bellOff', onPress: guard(() => toggleMute(t)) },
      { key: 'archive', label: t.archived ? 'Unarchive' : 'Archive', icon: 'storage', onPress: guard(() => setArchived(t, !t.archived)) },
    ];
    if (!p) return items;
    if (blockedChat) {
      items.push({
        key: 'unblock',
        label: 'Unblock',
        icon: 'block',
        onPress: guard(async () => {
          if (await unblock(p.id, p.display_name)) {
            setNote({ text: `Unblocked ${p.display_name}.`, tone: 'info' });
            void load(true);
          }
        }),
      });
      return items;
    }
    items.push(
      {
        key: 'restrict',
        label: 'Restrict',
        sub: 'Limit what they can see',
        icon: 'ban',
        onPress: guard(async () => {
          await restrictUser(p.id);
          setNote({ text: `Restricted ${p.display_name}. Their new messages go to Message requests.`, tone: 'info' });
          void load(true);
        }),
      },
      {
        key: 'block',
        label: 'Block',
        sub: forever ? 'Forever friends cannot be blocked' : undefined,
        icon: 'block',
        tone: forever ? 'warn' : 'danger',
        disabled: forever,
        badge: forever ? <ForeverTag /> : undefined,
        onPress: guard(async () => {
          if (await block(p.id, p.display_name)) setNote({ text: `Blocked ${p.display_name}. Unblock them by long-pressing this chat.`, tone: 'info' });
        }),
      },
    );
    return items;
  };

  /** Archive settings (user_settings.dm; the server's auto-unarchive trigger reads them). */
  const rawDm = (settings?.dm ?? {}) as Record<string, unknown>;
  const keepMuted = rawDm.archive_keep_muted !== false;
  const keepAll = rawDm.archive_keep === true;
  const saveArchivePref = async (key: 'archive_keep_muted' | 'archive_keep', value: boolean) => {
    setNote(null);
    try {
      await updateSettings({ dm: { ...rawDm, [key]: value } as Partial<DmSettings> });
    } catch (e) {
      setNote({ text: friendlySocialError(e, 'Could not save that change'), tone: 'error' });
    }
  };

  // Chats with people I blocked stay listed with a Blocked pill (no unread, no online dot).
  const isOnline = useCallback((t: Thread) => !t.group && !t.requestSent && !isBlocked(t) && !!t.other && onlineIds.has(t.other.id), [onlineIds, isBlocked]);
  // Locked chats (device-only, see lib/chat-lock): previews are masked, and chats set to "Hide from list"
  // leave the lists until the person opens "Locked chats" and passes Face ID.
  const lockMap = useChatLocks(me);
  const [lockedOpen, setLockedOpen] = useState(false);
  const masked = useMemo(() => threads.map((t) => (lockMap[t.id] ? { ...t, preview: 'Locked chat' } : t)), [threads, lockMap]);
  const hiddenLocked = masked.filter((t) => lockMap[t.id]?.hide && !t.archived);
  const visible = lockedOpen ? masked : masked.filter((t) => !lockMap[t.id]?.hide);
  const active = visible.filter((t) => !t.archived);
  const archived = visible.filter((t) => t.archived);
  const unreadChats = active.filter((t) => t.unreadCount > 0 && !isBlocked(t));
  const groupChats = active.filter((t) => t.group);
  const jamChats = active.filter((t) => t.jam && !isBlocked(t));
  const archivedUnread = archived.filter((t) => t.unreadCount > 0 && !isBlocked(t)).length;

  /** My active note and friends' notes (people I blocked on this screen are hidden until the next reload). */
  const myNote = notes.find((n) => n.mine) ?? null;
  const friendNotes = useMemo(() => notes.filter((n) => !n.mine && n.user_id !== me && !blocked.has(n.user_id)), [notes, me, blocked]);

  /**
   * Notes strip fallback after friends' notes: people online now first (green dot), then recent 1:1 chats
   * (people who already have a note bubble are not repeated).
   */
  const people = useMemo(() => {
    const seen = new Set<string>(friendNotes.map((n) => n.user_id));
    const online: { p: Person; t: Thread; online: boolean }[] = [];
    const recent: { p: Person; t: Thread; online: boolean }[] = [];
    threads.forEach((t) => {
      if (t.group || !t.other || t.requestSent || t.archived || isBlocked(t)) return;
      const p = t.other;
      if (p.id === me || seen.has(p.id)) return;
      seen.add(p.id);
      (onlineIds.has(p.id) ? online : recent).push({ p, t, online: onlineIds.has(p.id) });
    });
    return [...online, ...recent].slice(0, 15);
  }, [threads, onlineIds, me, isBlocked, friendNotes]);

  const shown = view === 'archived' ? archived : filter === 'unread' ? unreadChats : filter === 'groups' ? groupChats : filter === 'jams' ? jamChats : active;

  const tabs: InboxTab<Filter>[] = [
    { key: 'primary', label: 'All' },
    { key: 'unread', label: 'Unread', badge: unreadChats.length || undefined },
    { key: 'groups', label: 'Groups' },
    { key: 'jams', label: 'Jams' },
  ];

  const changeTab = (k: Filter) => {
    closeOpenSwipeRow();
    setFilter(k);
  };

  const filterEmpty =
    filter === 'unread' ? (
      <EmptyState icon="mail" title="You're all caught up" body="No unread chats right now." />
    ) : filter === 'groups' ? (
      <EmptyState icon="users" title="No group chats yet" body="Start a group with a few friends to share songs and jam together." action="New group" href="/new-group" />
    ) : filter === 'jams' ? (
      <EmptyState icon="music" title="No active jams" body="Chats where a jam started in the last 12 hours show up here." />
    ) : (
      <EmptyState icon="mail" title="No chats here" body={archived.length ? 'All your chats are archived.' : 'Send a song or say hi to someone you follow.'} action="New message" href="/new-message" />
    );

  // Rows are memoized: they get one stable handlers object that forwards to the latest callbacks.
  const latestHandlers = useRef<RowHandlers | null>(null);
  useEffect(() => {
    latestHandlers.current = {
      onMenu: (t, rect) => {
        closeOpenSwipeRow();
        setMenu({ t, rect, items: menuItems(t) });
      },
      onPin: (t) => void togglePin(t),
      onMute: (t) => void toggleMute(t),
      onArchive: (t, on) => void setArchived(t, on),
      onDelete: deleteChat,
    };
  });
  const [handlers] = useState<RowHandlers>(() => ({
    onMenu: (t, rect) => latestHandlers.current?.onMenu(t, rect),
    onPin: (t) => latestHandlers.current?.onPin(t),
    onMute: (t) => latestHandlers.current?.onMute(t),
    onArchive: (t, on) => latestHandlers.current?.onArchive(t, on),
    onDelete: (t) => latestHandlers.current?.onDelete(t),
  }));
  const renderRow = (t: Thread) => <ThreadRow t={t} isBlock={isBlocked(t)} online={isOnline(t)} locked={!!lockMap[t.id]} handlers={handlers} />;

  const noteBanner = note ? (
    <GlassCard radius={18} tint={note.tone === 'error' ? withAlpha(colors.error, 0.1) : undefined} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingLeft: 14, paddingRight: 4 }}>
      <Icon name={note.tone === 'error' ? 'info' : 'check'} size={16} color={note.tone === 'error' ? colors.error : colors.accentLight} strokeWidth={2} />
      <T size={13} color={note.tone === 'error' ? colors.error : colors.text} accessibilityLiveRegion="polite" style={{ flex: 1, paddingVertical: 10 }}>
        {note.text}
      </T>
      {note.undo ? (
        <Tap
          onPress={() => {
            const u = note.undo;
            setNote(null);
            u?.();
          }}
          accessibilityLabel="Undo"
          style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' }}
        >
          <T size={13} weight={700} color={colors.accentLight}>
            Undo
          </T>
        </Tap>
      ) : null}
      <Tap onPress={() => setNote(null)} accessibilityLabel="Dismiss" style={{ minHeight: 44, minWidth: 40, justifyContent: 'center', alignItems: 'center' }}>
        <Icon name="close" size={16} color={colors.textSecondary} />
      </Tap>
    </GlassCard>
  ) : null;

  const refresh = <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.bgTertiary} />;

  /** Empty / filter-empty states sit in a glass card like the list they replace. */
  const emptyCard = (child: ReactNode) => (
    <GlassCard radius={28} padding={8}>
      {child}
    </GlassCard>
  );

  const menuSheet = menu ? (
    <ChatContextMenu
      rect={menu.rect}
      title={threadName(menu.t)}
      row={<RowBody t={menu.t} isBlock={isBlocked(menu.t)} online={isOnline(menu.t)} />}
      items={menu.items}
      onClose={() => setMenu(null)}
    />
  ) : null;

  /* ---------------------------------------------------------------- archived view */
  if (view === 'archived') {
    return (
      <Screen top={8} gap={14} bottom={16} backdrop={{ pattern: 'none', mesh: 'coral', orbs: true }} refreshControl={refresh}>
        <Row gap={8} style={{ minHeight: 44 }}>
          <IconButton icon="back" label="Back to messages" size={44} iconSize={20} glass onPress={() => setView('inbox')} />
        </Row>
        <View style={{ gap: 6 }}>
          <T size={36} weight={300} tracking={-1} lineHeight={40} accessibilityRole="header" numberOfLines={1}>
            Archived
          </T>
          <T size={14} color={colors.textSecondary} lineHeight={20}>
            {`${archived.length} ${archived.length === 1 ? 'chat' : 'chats'}${archivedUnread ? ` (${archivedUnread} unread)` : ''}. `}
            {keepAll
              ? 'They stay here until you unarchive them.'
              : keepMuted
                ? `${archived.length === 1 ? 'It comes' : 'They come'} back when someone new messages you, unless muted.`
                : `${archived.length === 1 ? 'It comes' : 'They come'} back when someone new messages you.`}
          </T>
        </View>
        {loading ? (
          <InboxSkeleton rows={4} />
        ) : error ? (
          emptyCard(<ErrorState message={error} onRetry={() => void load()} />)
        ) : archived.length === 0 ? (
          emptyCard(<EmptyState icon="mail" title="No archived chats" body="Swipe left on a chat and tap Archive to tidy up your inbox." />)
        ) : (
          <RowGroup threads={archived} render={renderRow} />
        )}
        {noteBanner}
        <Glass radius={36} padding={0} style={{ paddingHorizontal: 4, paddingVertical: 4 }}>
          <ListRow
            title="Muted archived chats"
            subtitle="Stay archived when messaged"
            icon="bellOff"
            right={<Toggle value={keepMuted || keepAll} label="Muted archived chats stay archived" onChange={(v) => void saveArchivePref('archive_keep_muted', v)} />}
          />
          <ListRow
            title="Keep chats archived"
            subtitle="Do not return on new message"
            icon="storage"
            divider
            right={<Toggle value={keepAll} label="Keep chats archived, do not return on new message" onChange={(v) => void saveArchivePref('archive_keep', v)} />}
          />
        </Glass>
        {menuSheet}
      </Screen>
    );
  }

  /* ---------------------------------------------------------------- inbox */
  const myName = profile?.display_name ?? 'You';
  const mySong = noteSongLine(myNote?.track);
  const myNoteLabel = myNote ? [myNote.text, mySong ? `song ${mySong}` : null].filter(Boolean).join(', ') : null;
  const onlineCount = active.filter(isOnline).length;
  // Forever friends sit in the Pinned group too (gold ring, top of the list), in Forever order, before manual pins.
  const isTopRow = (t: Thread) => t.pinned || (!t.archived && !isBlocked(t) && isForeverChat(t, foreverIds));
  const pinnedShown = sortForeverFirst(
    shown.filter(isTopRow),
    (t) => (t.group ? null : t.other?.id),
  );
  const restShown = pinnedShown.length ? shown.filter((t) => !isTopRow(t)) : shown;

  return (
    <Screen top={8} gap={16} bottom={16} backdrop={{ pattern: 'none', mesh: 'coral', orbs: true }} refreshControl={refresh}>
      <Row gap={10} style={{ minHeight: 56 }}>
        {router.canGoBack() ? <IconButton icon="back" label="Back" size={40} iconSize={18} glass href="back" /> : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={34} weight={300} tracking={-0.8} lineHeight={40} accessibilityRole="header" numberOfLines={1} accessibilityLabel={loading && !threads.length ? 'Messages, syncing' : unreadChats.length ? `Messages, ${unreadChats.length} unread${onlineCount ? `, ${onlineCount} online` : ''}` : 'Messages'}>
            Messages
          </T>
        </View>
        <View>
          <IconButton icon="users" label={requestCount ? `Message requests, ${requestCount}` : 'Message requests'} size={44} iconSize={20} glass href="/message-requests" />
          {requestCount ? (
            <View pointerEvents="none" style={{ position: 'absolute', top: 8, right: 9, width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent, borderWidth: 2, borderColor: colors.bg }} />
          ) : null}
        </View>
        <IconButton icon="edit" label="New message" size={44} iconSize={20} bg={colors.accent} color={colors.onAccent} href="/new-message" />
      </Row>

      <Tap href="/chat-search" pressScale={0.98} accessibilityRole="search" accessibilityLabel="Search people, songs and messages" style={{ height: 46 }}>
        <GlassCard radius={23} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18 }}>
          <Icon name="search" size={18} color={colors.textSecondary} />
          <T size={15} weight={400} color={colors.textSecondary} numberOfLines={1} style={{ flex: 1 }}>
            Search
          </T>
        </GlassCard>
      </Tap>

      <View style={{ gap: 10 }}>
        {/* Items reserve a fixed, clipped bubble row above the avatar, so nothing rises under the Search pill. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16, flexGrow: 0 }} contentContainerStyle={{ gap: 4, paddingHorizontal: 12, paddingTop: 4 }} onScrollBeginDrag={closeOpenSwipeRow}>
          <NoteFace
            id={me}
            name={myName}
            uri={profile?.avatar_url}
            note={myNote ? myNote.text : 'Share a note'}
            song={myNote?.track?.title}
            songLine={mySong}
            muted={!myNote}
            add={!myNote}
            caption="Your note"
            onPress={() => (myNote ? setOpenNote({ list: [myNote], index: 0 }) : router.push('/note-compose'))}
            accessibilityLabel={myNoteLabel ? `Your note: ${myNoteLabel}` : 'Your note. Share a note'}
            accessibilityHint={myNote ? 'Opens your note to play, edit or delete it' : 'Share a short note or a song with your friends for 24 hours'}
          />
          {friendNotes.map((n, i) => {
            const online = onlineIds.has(n.user_id);
            const songLine = noteSongLine(n.track);
            return (
              <NoteFace
                key={`note:${n.user_id}`}
                id={n.user_id}
                name={n.display_name}
                uri={n.avatar_url}
                note={n.text}
                song={n.track?.title}
                songLine={songLine}
                online={online}
                caption={n.display_name.split(' ')[0]}
                onPress={() => setOpenNote({ list: friendNotes, index: i })}
                badge={foreverIds.has(n.user_id) ? <ForeverBadge size={18} /> : undefined}
                accessibilityLabel={`${n.display_name}'s note: ${[n.text, songLine ? `song ${songLine}` : null].filter(Boolean).join(', ')}${online ? ', active now' : ''}`}
                accessibilityHint="Opens the note to reply or play the song"
              />
            );
          })}
          {people.map(({ p, t, online }) => (
            <PresenceFace
              key={p.id}
              id={p.id}
              name={p.display_name}
              uri={p.avatar_url}
              online={online}
              caption={p.display_name.split(' ')[0]}
              badge={foreverIds.has(p.id) ? <ForeverBadge size={18} /> : undefined}
              onPress={() => openThread(t, !!lockMap[t.id])}
              accessibilityLabel={`${p.display_name}${online ? ', active now' : ''}. Open chat`}
            />
          ))}
          {people.length === 0 && friendNotes.length === 0 && !loading ? (
            <NoteFace name="New" caption="New chat" note="Say hi 👋" muted add onPress={() => router.push('/new-message')} accessibilityLabel="Start a new chat" />
          ) : null}
        </ScrollView>
      </View>

      <InboxTabs tabs={tabs} active={filter} onChange={changeTab} />

      <InboxRestoreCard />

      {noteBanner}

      {loading ? (
        <InboxSkeleton />
      ) : error ? (
        emptyCard(<ErrorState message={error} onRetry={() => void load()} />)
      ) : threads.length === 0 && filter === 'primary' ? (
        emptyCard(<EmptyState icon="mail" title="No conversations yet" body="Send a song or say hi to someone you follow." action="New message" href="/new-message" />)
      ) : (
        <>
          {shown.length === 0 ? (
            <View key="empty">{emptyCard(filterEmpty)}</View>
          ) : (
            // Pinned and Forever chats sit at the top of the one normal list; pinned rows carry a pin icon on the right.
            <RowGroup key="chats" threads={[...pinnedShown, ...restShown]} render={renderRow} />
          )}
          {filter === 'primary' && hiddenLocked.length > 0 ? (
            <Tap
              key="locked"
              pressScale={0.98}
              onPress={() => {
                if (lockedOpen) return setLockedOpen(false);
                void authenticate('Show locked chats').then((ok) => ok && setLockedOpen(true));
              }}
              accessibilityLabel={lockedOpen ? 'Hide locked chats' : `Locked chats, ${hiddenLocked.length}`}
            >
              <Row gap={12} style={{ minHeight: 52, paddingVertical: 12, paddingHorizontal: 4 }}>
                <Icon name="lock" size={20} color={colors.textSecondary} />
                <T size={14} color={colors.textSecondary} style={{ flex: 1 }}>
                  {lockedOpen ? 'Hide locked chats' : `Locked chats (${hiddenLocked.length})`}
                </T>
                <Icon name="chevronRight" size={18} color={colors.textSecondary} />
              </Row>
            </Tap>
          ) : null}
          {filter === 'primary' && archived.length > 0 ? (
            <Tap
              key="archived"
              pressScale={0.98}
              onPress={() => {
                closeOpenSwipeRow();
                setView('archived');
              }}
              accessibilityLabel={`Archived chats, ${archived.length}${archivedUnread ? `, ${archivedUnread} unread` : ''}`}
            >
              <Row gap={12} style={{ minHeight: 52, paddingVertical: 12, paddingHorizontal: 4 }}>
                <Icon name="storage" size={20} color={colors.textSecondary} />
                <T size={14} color={colors.textSecondary} style={{ flex: 1 }}>
                  Archived ({archived.length})
                </T>
                {archivedUnread ? <CountPill count={archivedUnread} /> : null}
                <Icon name="chevronRight" size={18} color={colors.textSecondary} />
              </Row>
            </Tap>
          ) : null}
        </>
      )}

      {/* Mounted only while open (a null child adds no Screen gap); its Modal draws above everything. */}
      {openNote ? (
        <NoteSheet
          notes={openNote.list}
          index={openNote.index}
          me={me}
          onClose={() => setOpenNote(null)}
          onDeleted={() => {
            setNotes((list) => list.filter((n) => !n.mine));
            void loadNotes();
          }}
          onReacted={(owner, emoji) => setNotes((list) => list.map((n) => (n.user_id === owner ? { ...n, my_reaction: emoji, seen: true } : n)))}
        />
      ) : null}
      {menuSheet}
    </Screen>
  );
}
