import type { RealtimeChannel } from '@supabase/supabase-js';
import type { IconName } from '../components/icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';

import { confirmBlockHref, confirmClearHref } from '../lib/confirm-routes';
import { DialogButton } from '../lib/confirm-ui';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Animated, Easing, Keyboard, KeyboardAvoidingView, Linking, Modal, Platform, ScrollView, TextInput, useWindowDimensions, View, type ScrollViewInstance } from 'react-native';

import { Button, Cover, EmptyState, ErrorState, Gradient, Icon, IconButton, Loading, Row, Screen, SkeletonBlock, T, Tap, useReduceMotion } from '../components';
import { catalog } from '../lib/catalog';
import {
  blendMeta,
  callMeta,
  chatBus,
  CHAT_GONE,
  chatPeerParams,
  chatError,
  updateMySettings,
  conversationExists,
  createJam,
  dayLabel,
  DELIVERY_LABEL,
  deliveryOf,
  disappearLabel,
  decryptChatRows,
  editedAt,
  editChatMessage,
  jamMeta,
  listScheduled,
  liveMeta,
  loadChat,
  loadMessage,
  loadReceipts,
  locationMeta,
  lyricMeta,
  mapsUrl,
  messagePreview,
  peerFromParams,
  photoMeta,
  playlistMeta,
  pollMeta,
  sendMessage,
  swapMeta,
  timeOf,
  toggleReaction,
  trackArtist,
  useChatEditing,
  useChatReply,
  voiceMeta,
  vote,
  type ChatMessage,
  type ChatSnapshot,
  type NewMessage,
  type Receipt,
  type Scheduled,
  markConversationRead,
} from '../lib/chat';
import { cleanupViewedWhispers, loadCapsules, loadStarIds, loadWhisperViews, type CapsuleRow, type WhisperView } from '../lib/chat-extras';
import { moodColor, useChatMood } from '../lib/chat-mood';
import { useLastSeen } from '../lib/last-seen';
import { ForeverBadge, ForeverPromptCard } from '../components/forever';
import { useIsForever } from '../lib/forever';
import { CallLogRow, useStartCall } from '../lib/call-ui';
import { CALLS_ENABLED, type CallKind } from '../lib/calls';
import { CapsuleCard, ChatAvatar, PhotoBubble, VoiceNote, WhisperCard } from '../lib/chat-ui';
import { PhotoViewer, type ViewerPhoto } from '../components/PhotoViewer';
import { EmojiPanel, useEmojiComposer } from '../components/EmojiPicker';
import { bigEmojiCount } from '../lib/emoji';
import { decryptErrorOf, isNotEncrypted, newMessageId, routeIfSetupRequired } from '../lib/chat-e2ee';
import { REPLY_ACTIONS, SwipeToReply, useTimeReveal } from '../lib/swipe-reply';
import { E2EEChatNotice, NotEncryptedNote, PinnedBar, SecurityCodeRow, UnavailableBubble, useIdentityChanges } from '../lib/e2ee-chat-ui';
import { acceptRequest, declineRequest, dmSettings, markDelivered, rateSongSwap, requestState, swapRatings, type RequestState } from '../lib/dm';
import { friendlySocialError, isBlockedWith, useBlocks } from '../lib/social';
import { claimTopic, dropTopic, privateChannel } from '../lib/realtime';
import { supabase } from '../lib/supabase';
import { useChatGate } from '../lib/chat-lock';
import { CatchUpCard } from '../lib/chat-catchup';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors, fonts, shadow, withAlpha } from '../theme/tokens';

/** Design colours without a theme token. */
const BLOCK_RED = '#FF8A8A';
const SOFT_TEXT = '#D4D4D4';
const LISTEN_SUB = '#7EF2C2';
const REACTION_BG = 'rgba(20,20,20,0.85)';
const ONLINE_GREEN = '#2EE59D';
/** Outgoing bubble: 135deg accent → deep red. */
const OUT_GRADIENT = [colors.accent, colors.indigo] as const;

const TYPING_MS = 4000;

/** What a member shares on the chat's presence channel. `online: false` = hides their online status. */
type NowPlayingLite = { id: string; title: string; artist: string };
type PresencePayload = { online_at?: string; online?: boolean; now_playing?: NowPlayingLite | null };

const scheduledLabel = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * Chat Pro (`/chat-pro?id=<conversation>`): the redesigned 1:1 chat.
 * Real: messages, replies, reactions, pins, polls, voice notes, photos, song/lyric/playlist cards,
 * jam and live invites, Blend and Song swap cards, delivery states (Sent / Delivered / Read from
 * `conversation_receipts`), typing, online status and "now playing" (Supabase Realtime broadcast +
 * presence, each honouring my Message privacy settings), message requests (Accept / Decline / Block),
 * disappearing-message notices and my scheduled messages. Long-press a message for actions.
 * Voice / video calls (Agora, src/lib/calls.ts): header buttons + call log rows (tap to call back);
 * refused while a request is pending or a block exists.
 */
/** Chat Pro behind the optional device lock (Face ID / passcode) set in Chat info → Lock chat. */
export default function ChatPro() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { user } = useAuth();
  const gate = useChatGate(user?.id, typeof id === 'string' ? id : undefined);
  if (gate.state === 'open') return <ChatProScreen />;
  return (
    <Screen top={4} gap={16}>
      <EmptyState icon="clock" title="This chat is locked" body="Use Face ID, Touch ID or your passcode to open it." action={gate.state === 'locked' ? 'Unlock' : undefined} onAction={() => void gate.unlock()} />
    </Screen>
  );
}

function ChatProScreen() {
  const { id: rawId, search: searchParam, jump: jumpParam, uid: peerUid, name: peerName, avatar: peerAvatar } = useLocalSearchParams<{ id?: string; search?: string; jump?: string; uid?: string; name?: string; avatar?: string }>();
  const id = typeof rawId === 'string' && rawId ? rawId : undefined;
  // The other person as the caller knew them (list row, profile…), shown until loadChat resolves.
  const seedPeer = useMemo(() => peerFromParams(peerUid, peerName, peerAvatar), [peerUid, peerName, peerAvatar]);
  const { user, profile, settings } = useAuth();
  const me = user?.id;
  const dm = dmSettings(settings?.dm);
  const { track: nowPlaying, playTrack } = usePlayerPick('track');
  const [snap, setSnap] = useState<ChatSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [catchUp, setCatchUp] = useState<ChatMessage[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [online, setOnline] = useState(false);
  const [otherPlaying, setOtherPlaying] = useState<NowPlayingLite | null>(null);
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [reqState, setReqState] = useState<RequestState>('none');
  /** The conversation was deleted under me (my request was declined, or the chat was removed). */
  const [gone, setGone] = useState(false);
  const [scheduled, setScheduled] = useState<Scheduled[]>([]);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [pinIdx, setPinIdx] = useState(0);
  // Chat extras: capsule metadata (server), whisper view state, my stars in this chat.
  const [capsules, setCapsules] = useState<Map<string, CapsuleRow>>(new Map());
  const [whisperViews, setWhisperViews] = useState<WhisperView[]>([]);
  const [stars, setStars] = useState<Set<string>>(new Set());
  const reveal = useTimeReveal(useReduceMotion());
  const rowY = useRef(new Map<string, number>());
  const catchH = useRef(0);
  const subscribed = useRef(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const channel = useRef<RealtimeChannel | null>(null);
  const lastTypingSent = useRef(0);
  const replyTo = useChatReply(id);
  const editing = useChatEditing(id);
  const reduce = useReduceMotion();
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  // Message options › Edit puts the message's text in the composer.
  const [editSeen, setEditSeen] = useState<string | undefined>(undefined);
  if (editing && editing.id !== editSeen) {
    setEditSeen(editing.id);
    setDraft(editing.body);
  }

  // Search in chat: `?search=<query>` (from Messages search) opens it prefilled and jumps to the newest
  // match; `?search=<nonce>` (13-digit timestamp from Chat tools) just opens it. Each new value re-opens.
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState<{ top: number; right: number } | null>(null);
  const [query, setQuery] = useState('');
  const [matchSel, setMatchSel] = useState<number | null>(null);
  const [searchSeen, setSearchSeen] = useState<string | undefined>(undefined);
  const searchPrefill = typeof searchParam === 'string' && searchParam && !/^\d{13}$/.test(searchParam) ? searchParam : '';
  if (typeof searchParam === 'string' && searchParam && searchParam !== searchSeen) {
    setSearchSeen(searchParam);
    setSearchOpen(true);
    setQuery(searchPrefill);
    setMatchSel(null);
  }
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery('');
    setMatchSel(null);
  };

  // Keyboard: Android is edge-to-edge, so the window no longer resizes. Pad on both platforms and
  // drop the footer's bottom safe-area gap while the keyboard is open.
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, () => {
      setKeyboardOpen(true);
      requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: true }));
    });
    const hide = Keyboard.addListener(hideEvt, () => setKeyboardOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const { blocked, block, unblock } = useBlocks(me);

  const other = snap?.other ?? seedPeer;
  const otherId = other?.id;
  const lastSeen = useLastSeen(otherId);
  const forever = useIsForever(otherId) === true;
  const [moodMode] = useChatMood(id);
  const name = other?.display_name || (other?.username ? `@${other.username}` : '') || 'Chat';
  // Header placeholder while we don't know their name yet (instead of a generic "Chat").
  const nameLoading = !snap && loading && !other?.display_name;
  const infoParams = id ? { id, ...chatPeerParams(other) } : null;
  const iBlocked = !!otherId && blocked.has(otherId);
  const [blockedWith, setBlockedWith] = useState<{ id: string; value: boolean } | null>(null);
  useEffect(() => {
    if (!otherId) return;
    let alive = true;
    isBlockedWith(otherId)
      .then((v) => alive && setBlockedWith({ id: otherId, value: v }))
      .catch(() => alive && setBlockedWith({ id: otherId, value: false }));
    return () => {
      alive = false;
    };
  }, [otherId, iBlocked]);
  const theyBlocked = !iBlocked && !!otherId && blockedWith?.id === otherId && blockedWith.value;
  const cantSend = iBlocked || theyBlocked;
  // Calls are refused while a chat request is pending or either side blocked the other.
  const callBlockedReason = cantSend ? "You can't call this person." : reqState !== 'none' ? 'You can call once your chat request is accepted.' : null;
  const caller = useStartCall(id, callBlockedReason);
  const placeCall = (kind: CallKind) => {
    Keyboard.dismiss();
    void caller.start(kind).then((err) => err && setNote(err));
  };

  const markRead = useCallback(() => {
    if (!id || !me) return;
    void markConversationRead(id, me);
    void supabase.from('notifications').update({ read: true }).eq('user_id', me).eq('read', false).in('kind', ['message', 'message_request']).eq('payload->>conversation_id', id).then(undefined, () => undefined);
  }, [id, me]);

  const refreshReceipts = useCallback(() => {
    if (!id) return;
    loadReceipts(id)
      .then(setReceipts)
      .catch(() => setReceipts(null));
  }, [id]);

  const refreshReqState = useCallback(() => {
    if (!id) return;
    requestState(id)
      .then(setReqState)
      .catch(() => undefined);
  }, [id]);

  /** Request state, receipts and my scheduled messages: none of them block the chat from opening. */
  const loadExtras = useCallback(() => {
    if (!id || !me) return;
    void markDelivered().then(refreshReceipts);
    refreshReqState();
    listScheduled(id)
      .then((rows) => setScheduled(rows.filter((r) => !r.failed)))
      .catch(() => setScheduled([]));
    void loadCapsules(id).then(setCapsules);
    void loadStarIds(id).then(setStars);
  }, [id, me, refreshReceipts, refreshReqState]);

  const load = useCallback(
    async (quiet = false) => {
      if (!id || !me) return;
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const s = await loadChat(id, me);
        if (!quiet) {
          // Unread baseline from before markRead runs below: drives the catch-up card.
          const since = s.mine?.last_read_at ?? null;
          const fresh = since ? s.messages.filter((m) => m.sender_id !== me && m.created_at > since && !callMeta(m)) : [];
          setCatchUp(fresh.length >= 5 ? fresh : null);
        }
        setSnap((prev) => {
          if (!prev) return s;
          // Keep optimistic rows that haven't been echoed yet.
          const pending = prev.messages.filter((m) => m.pending);
          return { ...s, messages: [...s.messages, ...pending] };
        });
        markRead();
        loadExtras();
      } catch (e) {
        if (e instanceof Error && e.message === CHAT_GONE) setGone(true);
        else if (!quiet) setError(e instanceof Error ? e.message : 'Could not load this conversation');
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [id, me, markRead, loadExtras],
  );

  useEffect(() => {
    // Async loader: state updates happen after the network round trip.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Clear chat / unsend / delete-for-me dialogs bump chatBus.version: reload quietly.
  useEffect(() => {
    let seen = chatBus.get().version;
    return chatBus.subscribe(() => {
      const v = chatBus.get().version;
      if (v !== seen) {
        seen = v;
        void load(true);
      }
    });
  }, [load]);

  // Sheets (actions, attach, info) change pins / hidden / settings: refresh quietly on return.
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void load(true);
      // Message options may have changed a reaction: let the other side refresh too.
      void channel.current?.send({ type: 'broadcast', event: 'side', payload: {} });
    }, [load]),
  );

  // Side tables (reactions, pins, votes) refetch together, debounced.
  const sideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSide = useCallback(() => {
    if (!id) return;
    if (sideTimer.current) clearTimeout(sideTimer.current);
    sideTimer.current = setTimeout(async () => {
      const [r, p, v] = await Promise.all([
        supabase.from('message_reactions').select('message_id, user_id, emoji').eq('conversation_id', id),
        supabase.from('message_pins').select('message_id, pinned_by, created_at').eq('conversation_id', id).order('created_at', { ascending: false }),
        supabase.from('poll_votes').select('message_id, user_id, option').eq('conversation_id', id),
      ]);
      setSnap((s) =>
        s
          ? {
              ...s,
              reactions: r.error ? s.reactions : (r.data ?? []),
              pins: p.error ? s.pins : (p.data ?? []),
              votes: v.error ? s.votes : (v.data ?? []),
            }
          : s,
      );
    }, 250);
  }, [id]);
  useEffect(() => () => void (sideTimer.current && clearTimeout(sideTimer.current)), []);

  // My presence payload, honouring Message privacy: no online flag when online status is off, no song
  // when "now playing" is off. Nothing is tracked at all when both are off.
  // While a request is pending (either way) or a block exists, nothing live is shared or shown.
  const quiet = reqState !== 'none' || cantSend || gone;
  const quietRef = useRef(quiet);
  useEffect(() => {
    quietRef.current = quiet;
  }, [quiet]);
  const shareOnline = dm.online_status && !quiet;
  const shareSong = dm.now_playing && !quiet;
  const playingId = nowPlaying?.id;
  const presence = useMemo<PresencePayload | null>(() => {
    const np = shareSong && nowPlaying ? { id: nowPlaying.id, title: nowPlaying.title, artist: nowPlaying.artist.name } : null;
    // Typing is only trusted from presence keys (server-checked on the private channel), so a member who
    // sends typing tracks presence too (with online: false when their online status is hidden).
    const typingOn = dm.typing && !quiet;
    if (!shareOnline && !np && !typingOn) return null;
    return { online: shareOnline, now_playing: np };
    // Re-track only when the song (not its position) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareOnline, shareSong, playingId, dm.typing, quiet]);
  const presenceRef = useRef(presence);
  useEffect(() => {
    presenceRef.current = presence;
    const ch = channel.current;
    if (!ch || !subscribed.current) return;
    void (presence ? ch.track({ ...presence, online_at: new Date().toISOString() }) : ch.untrack());
  }, [presence]);

  useEffect(() => {
    if (!id || !me) return;
    const topic = `chatpro:${id}`;
    let alive = true;
    let live: RealtimeChannel | null = null;
    const start = () => {
    // Private channel (realtime.messages RLS: members only); postgres_changes still use table RLS.
    const ch = privateChannel(topic, { presence: { key: me }, broadcast: { self: false } });
    const insert = (msg: ChatMessage) =>
      setSnap((s) => {
        if (!s) return s;
        if (s.messages.some((x) => x.id === msg.id)) return s;
        const i = s.messages.findIndex((x) => x.pending && x.sender_id === msg.sender_id && x.body === msg.body && x.kind === msg.kind);
        const messages = i >= 0 ? [...s.messages.slice(0, i), msg, ...s.messages.slice(i + 1)] : [...s.messages, msg];
        return { ...s, messages };
      });
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${id}` }, (payload) => {
      const raw = payload.new as ChatMessage;
      // A capsule is sealed right after it's sent: pick up its open date.
      if (raw.kind === 'capsule') setTimeout(() => void loadCapsules(id).then(setCapsules), 1500);
      // E2EE rows: decrypt first (my own sends hit the local cache).
      void decryptChatRows([raw]).then(([msg]) => insert(msg ?? raw), () => insert(raw));
      const msg = raw;
      if (msg.sender_id !== me) {
        setTyping(false);
        markRead();
      }
    })
      // Edits (edit_message): swap in the new text.
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${id}` }, (payload) => {
        const raw = payload.new as ChatMessage;
        // E2EE edits carry new ciphertext: decrypt, then swap body + meta (and track for completeness).
        void decryptChatRows([raw]).then(([msg]) => {
          if (!msg) return;
          setSnap((s) => (s ? { ...s, messages: s.messages.map((x) => (x.id === msg.id ? { ...x, body: msg.body, track: msg.e2ee_version != null ? msg.track : x.track, meta: msg.meta ?? x.meta } : x)) } : s));
        });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_pins', filter: `conversation_id=eq.${id}` }, refreshSide)
      // Reactions / votes: a `side` broadcast from the member who changed them (those tables left the realtime
      // publication in 20261115270000); receivers re-read them under RLS.
      .on('broadcast', { event: 'side' }, refreshSide)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversation_members', filter: `conversation_id=eq.${id}` }, (payload) => {
        // Only my own row's settings are used; other members' read state comes from conversation_receipts.
        const row = payload.new as { user_id?: string; muted?: boolean; read_receipts?: boolean };
        if (row.user_id === me) {
          setSnap((s) =>
            s?.mine
              ? { ...s, mine: { ...s.mine, ...(typeof row.muted === 'boolean' ? { muted: row.muted } : null), ...(typeof row.read_receipts === 'boolean' ? { read_receipts: row.read_receipts } : null) } }
              : s,
          );
        }
        // Read / delivered moved, or a request was accepted: re-read receipts and the request state.
        refreshReceipts();
        refreshReqState();
      })
      // Declined requests delete the conversation. Realtime never delivers DELETE to filtered
      // subscriptions, so listen unfiltered and match the primary key.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'conversations' }, (payload) => {
        if ((payload.old as { id?: string } | undefined)?.id === id) setGone(true);
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'conversation_members' }, (payload) => {
        const old = payload.old as { conversation_id?: string; user_id?: string } | undefined;
        if (old?.conversation_id === id && old.user_id === me) setGone(true);
      })
      .on('broadcast', { event: 'typing' }, (payload) => {
        const who = (payload.payload as { user_id?: string } | undefined)?.user_id;
        if (!who || who === me || quietRef.current) return;
        // Broadcast payloads are client-authored: only trust ids that are presence keys on this channel.
        if (!Object.prototype.hasOwnProperty.call(ch.presenceState(), who)) return;
        setTyping(true);
        if (typingTimer.current) clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => setTyping(false), TYPING_MS);
      })
      .on('presence', { event: 'sync' }, () => {
        if (quietRef.current) {
          setOnline(false);
          setOtherPlaying(null);
          return;
        }
        const state = ch.presenceState<PresencePayload>();
        let on = false;
        let np: NowPlayingLite | null = null;
        for (const [key, metas] of Object.entries(state)) {
          if (key === me) continue;
          for (const p of metas) {
            if (p.online !== false) on = true;
            if (p.now_playing && typeof p.now_playing.id === 'string') np = p.now_playing;
          }
        }
        setOnline(on);
        setOtherPlaying(np);
      })
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return;
        subscribed.current = true;
        const p = presenceRef.current;
        if (p) void ch.track({ ...p, online_at: new Date().toISOString() });
      });
    channel.current = ch;
    live = ch;
    };
    const stop = () => {
      const c = live;
      live = null;
      if (!c) return Promise.resolve();
      subscribed.current = false;
      if (channel.current === c) channel.current = null;
      return supabase.removeChannel(c).then(undefined, () => undefined);
    };
    // The same chat open twice: only the newest copy holds the live channel (see claimTopic).
    const holder = {
      release: stop,
      resume: () => {
        if (!alive || live) return;
        start();
        void load(true); // catch up on anything sent while the other copy was on top
      },
    };
    void claimTopic(topic, holder).then(() => {
      if (alive && !live) start();
    });
    return () => {
      alive = false;
      dropTopic(topic, holder, stop());
    };
  }, [id, me, markRead, refreshSide, refreshReceipts, refreshReqState, load]);

  useEffect(() => () => void (typingTimer.current && clearTimeout(typingTimer.current)), []);

  // Declined / deleted under me: say so, then leave.
  const goneText = reqState === 'none' && snap ? 'This conversation is no longer available' : 'This request was declined';
  useEffect(() => {
    if (!gone) return;
    const t = setTimeout(() => (router.canGoBack() ? router.back() : router.replace('/messages')), 2000);
    return () => clearTimeout(t);
  }, [gone]);

  const onDraft = (t: string) => {
    setDraft(t);
    const n = Date.now();
    if (t && dm.typing && !quiet && channel.current && n - lastTypingSent.current > 2000) {
      lastTypingSent.current = n;
      void channel.current.send({ type: 'broadcast', event: 'typing', payload: { user_id: me } });
    }
  };
  // Smiley button: full emoji picker in place of the keyboard, inserting at the cursor.
  const picker = useEmojiComposer(draft, onDraft, inputRef);

  const post = async (m: NewMessage) => {
    if (!id || !me) return false;
    // Real message id up front: the optimistic bubble keeps it (encrypted sends use it as the message id).
    const tempId = newMessageId();
    const optimistic: ChatMessage = {
      id: tempId,
      conversation_id: id,
      sender_id: me,
      body: m.body ?? '',
      track: m.track ?? null,
      kind: m.kind ?? (m.track && !m.body ? 'track' : 'text'),
      reply_to: m.reply_to ?? null,
      meta: m.meta ?? {},
      created_at: new Date().toISOString(),
      pending: true,
    };
    setSnap((s) => (s ? { ...s, messages: [...s.messages, optimistic] } : s));
    setFollowEnd(true);
    try {
      const saved = await sendMessage(id, me, m, { messageId: tempId });
      setSnap((s) => {
        if (!s) return s;
        const without = s.messages.filter((x) => x.id !== tempId);
        return { ...s, messages: without.some((x) => x.id === saved.id) ? without : [...without, saved] };
      });
      markRead();
      // Replying to an incoming request accepts it; my own sends can't change it but are cheap to re-check.
      refreshReqState();
      return true;
    } catch (e) {
      setSnap((s) => (s ? { ...s, messages: s.messages.filter((x) => x.id !== tempId) } : s));
      if (routeIfSetupRequired(e, `/chat-pro?id=${encodeURIComponent(id)}`)) return false;
      if (!(await conversationExists(id))) {
        setGone(true);
        return false;
      }
      setNote(reqState === 'outgoing' ? 'Wait for them to accept your request' : e instanceof Error ? e.message : 'Message not sent');
      return false;
    }
  };

  const cancelEdit = () => {
    if (!id) return;
    chatBus.setEditing(id, undefined);
    setEditSeen(undefined);
    setDraft('');
  };

  const saveEdit = async (m: ChatMessage, text: string) => {
    if (!id) return;
    if (text === m.body) return cancelEdit();
    const before = m.body;
    const stamp = new Date().toISOString();
    setSnap((s) => (s ? { ...s, messages: s.messages.map((x) => (x.id === m.id ? { ...x, body: text, meta: { ...x.meta, edited_at: stamp } } : x)) } : s));
    chatBus.setEditing(id, undefined);
    setEditSeen(undefined);
    setDraft('');
    try {
      await editChatMessage(m, text);
    } catch (e) {
      setSnap((s) => (s ? { ...s, messages: s.messages.map((x) => (x.id === m.id ? { ...x, body: before, meta: m.meta } : x)) } : s));
      if (routeIfSetupRequired(e, `/chat-pro?id=${encodeURIComponent(id)}`)) return;
      setNote(chatError(e, 'Could not edit'));
    }
  };

  const unblockThem = async () => {
    if (!otherId || busy) return;
    setBusy('unblock');
    setNote(null);
    try {
      const done = await unblock(otherId, name);
      if (!done) return;
      setBlockedWith(null);
      const still = await isBlockedWith(otherId).catch(() => false);
      setBlockedWith({ id: otherId, value: still });
      await load(true);
    } catch (e) {
      setNote(friendlySocialError(e, 'Could not unblock'));
    } finally {
      setBusy(null);
    }
  };

  const send = () => {
    const text = draft.trim();
    if (!text || !id) return;
    if (editing) {
      void saveEdit(editing, text);
      return;
    }
    setDraft('');
    const reply = replyTo?.id ?? null;
    chatBus.setReply(id, undefined);
    void post({ body: text, kind: 'text', reply_to: reply });
  };

  const muted = !!snap?.mine?.muted;
  const toggleMute = async () => {
    if (!id || !me || !snap?.mine) return;
    const next = !muted;
    setSnap((s) => (s?.mine ? { ...s, mine: { ...s.mine, muted: next } } : s));
    try {
      await updateMySettings(id, me, { muted: next });
      setNote(next ? 'Notifications muted for this chat' : 'Notifications on for this chat');
    } catch (e) {
      setSnap((s) => (s?.mine ? { ...s, mine: { ...s.mine, muted: !next } } : s));
      setNote(chatError(e, 'Setting not saved'));
    }
  };

  const startJam = async () => {
    if (!me || busy) return;
    setBusy('jam');
    setNote(null);
    try {
      const jam = await createJam(me, `${profile?.display_name ?? 'My'}'s jam`);
      const ok = await post({ kind: 'jam', meta: jam, body: '' });
      if (ok) router.push({ pathname: '/group-listening', params: { id: jam.room_id } });
    } catch (e) {
      setNote(chatError(e, 'Could not start a jam'));
    } finally {
      setBusy(null);
    }
  };

  /** Tells the other members to re-read reactions / votes (see the `side` listener). */
  const pingSide = () => void channel.current?.send({ type: 'broadcast', event: 'side', payload: {} });

  const react = async (m: ChatMessage, emoji: string) => {
    if (!id || !me || m.pending) return;
    const mineOn = !!snap?.reactions.some((r) => r.message_id === m.id && r.user_id === me && r.emoji === emoji);
    setSnap((s) =>
      s
        ? {
            ...s,
            reactions: mineOn ? s.reactions.filter((r) => !(r.message_id === m.id && r.user_id === me && r.emoji === emoji)) : [...s.reactions, { message_id: m.id, user_id: me, emoji }],
          }
        : s,
    );
    try {
      await toggleReaction(id, m.id, me, emoji, !mineOn);
      pingSide();
    } catch (e) {
      setNote(chatError(e, 'Could not react'));
      refreshSide();
    }
  };

  const castVote = async (m: ChatMessage, option: number) => {
    if (!id || !me || m.pending) return;
    setSnap((s) => (s ? { ...s, votes: [...s.votes.filter((v) => !(v.message_id === m.id && v.user_id === me)), { message_id: m.id, user_id: me, option }] } : s));
    try {
      await vote(id, m.id, me, option);
      pingSide();
    } catch (e) {
      setNote(chatError(e, 'Vote not saved'));
      refreshSide();
    }
  };

  const openActions = (m: ChatMessage) => {
    if (!id || m.pending) return;
    router.push({ pathname: '/chat-actions', params: { id, msg: m.id } });
  };

  const answerRequest = async (what: 'accept' | 'decline' | 'block') => {
    if (!id || busy) return;
    setBusy(what);
    setNote(null);
    try {
      if (what === 'accept') {
        await acceptRequest(id);
        setReqState('none');
        await load(true);
        return;
      }
      if (what === 'block') {
        if (!otherId) return;
        const done = await block(otherId, name);
        if (!done) return;
        // block() already deletes the pending conversation server side; a decline may find nothing.
        await declineRequest(id).catch(() => undefined);
        router.replace('/messages');
        return;
      }
      await declineRequest(id);
      if (router.canGoBack()) router.back();
      else router.replace('/messages');
    } catch (e) {
      setNote(chatError(e, what === 'accept' ? 'Could not accept' : what === 'block' ? 'Could not block' : 'Could not decline'));
    } finally {
      setBusy(null);
    }
  };

  const rate = async (m: ChatMessage, stars: number) => {
    if (m.pending) return;
    const before = ratings[m.id];
    setRatings((r) => ({ ...r, [m.id]: stars }));
    try {
      await rateSongSwap(m.id, stars);
    } catch (e) {
      setRatings((r) => {
        const next = { ...r };
        if (before === undefined) delete next[m.id];
        else next[m.id] = before;
        return next;
      });
      setNote(chatError(e, 'Rating not saved'));
    }
  };

  const joinListening = async () => {
    if (!otherPlaying || busy) return;
    setBusy('join');
    setNote(null);
    try {
      const t = await catalog.track(otherPlaying.id);
      playTrack(t, `Listening with ${name}`);
      router.push('/player');
    } catch (e) {
      setNote(chatError(e, `Could not play ${otherPlaying.title}`));
    } finally {
      setBusy(null);
    }
  };

  const visible = useMemo(() => (snap ? snap.messages.filter((m) => !snap.hidden.has(m.id)) : []), [snap]);
  const byId = useMemo(() => new Map((snap?.messages ?? []).map((m) => [m.id, m])), [snap]);
  // Full-screen photo viewer over every photo in this chat (swipe between them).
  const [viewerAt, setViewerAt] = useState<number | null>(null);
  const photos = useMemo<ViewerPhoto[]>(
    () =>
      visible.flatMap((m) => {
        const ph = m.pending ? null : photoMeta(m);
        if (!ph) return [];
        const who = m.sender_id === me ? 'You' : snap?.other?.display_name || 'Photo';
        return [{ id: m.id, path: ph.path, key: ph.key, mime: ph.mime, width: ph.width, height: ph.height, senderName: who, at: m.created_at }];
      }),
    [visible, me, snap?.other?.display_name],
  );
  // "Security code changed" notices for the other person (local, from this phone's TOFU book).
  const idChanges = useIdentityChanges(snap?.other?.id ? [snap.other.id] : []);

  // Search in chat: matches oldest → newest; the newest is selected until the user steps through.
  const q = searchOpen ? query.trim().toLowerCase() : '';
  const matches = useMemo(
    () => (q ? visible.filter((m) => !m.pending && `${m.body ?? ''}\n${messagePreview(m)}`.toLowerCase().includes(q)).map((m) => m.id) : []),
    [visible, q],
  );
  const matchAt = matches.length ? Math.min(matchSel ?? matches.length - 1, matches.length - 1) : -1;
  const currentMatch = matchAt >= 0 ? matches[matchAt] : undefined;
  const matchSet = useMemo(() => new Set(matches), [matches]);
  useEffect(() => {
    if (!currentMatch) return;
    // Rows may not be laid out yet (search prefilled on open): retry for a moment.
    let tries = 0;
    let t: ReturnType<typeof setTimeout> | null = null;
    const go = () => {
      const y = rowY.current.get(currentMatch);
      if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - 24), animated: !reduce });
      else if (tries++ < 20) t = setTimeout(go, 100);
    };
    go();
    return () => void (t && clearTimeout(t));
  }, [currentMatch, reduce]);
  const stepMatch = (dir: -1 | 1) => {
    if (!matches.length) return;
    setMatchSel((matchAt + dir + matches.length) % matches.length);
  };

  // Song swap ratings for the swaps on screen.
  const swapKey = visible
    .filter((m) => m.kind === 'swap' && !m.pending)
    .map((m) => m.id)
    .join(',');
  useEffect(() => {
    if (!swapKey) return;
    let alive = true;
    swapRatings(swapKey.split(','))
      .then((r) => alive && setRatings((cur) => ({ ...cur, ...r })))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [swapKey]);

  /** Re-reads one message (a capsule whose open date just passed: the server now releases its key). */
  const refreshMessage = useCallback(
    (mid: string) => {
      void loadMessage(mid)
        .then((msg) => msg && setSnap((s) => (s ? { ...s, messages: s.messages.map((x) => (x.id === mid ? msg : x)) } : s)))
        .catch(() => undefined);
      if (id) void loadCapsules(id).then(setCapsules);
    },
    [id],
  );

  // View-once state of the whispers on screen; as the sender, delete files everyone has viewed.
  const whisperKey = visible
    .filter((m) => m.kind === 'whisper' && !m.pending)
    .map((m) => m.id)
    .join(',');
  useEffect(() => {
    if (!whisperKey || !id || !me) return;
    let alive = true;
    void loadWhisperViews(whisperKey.split(',')).then((views) => {
      if (!alive) return;
      setWhisperViews(views);
      const mineIds = new Set(visible.filter((m) => m.kind === 'whisper' && m.sender_id === me).map((m) => m.id));
      const done = new Set(views.filter((v) => v.viewed_at && mineIds.has(v.message_id)).map((v) => v.message_id));
      void cleanupViewedWhispers(id, me, done);
    });
    return () => {
      alive = false;
    };
    // `visible` is read for ownership only; the key covers the whisper set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whisperKey, id, me, snap?.messages.length]);

  // `?jump=<message>` (Starred): scroll to it once it's laid out and flash it.
  const [jumped, setJumped] = useState<string | null>(null);
  /** After a jump, stay put until I send something. */
  const [followEnd, setFollowEnd] = useState(false);
  const jumpTo = typeof jumpParam === 'string' && jumpParam ? jumpParam : null;
  useEffect(() => {
    if (!jumpTo || jumped === jumpTo || !snap) return;
    let tries = 0;
    let t: ReturnType<typeof setTimeout> | null = null;
    const go = () => {
      const y = rowY.current.get(jumpTo);
      if (y !== undefined) {
        scroll.current?.scrollTo({ y: Math.max(0, y - 80), animated: !reduce });
        setJumped(jumpTo);
      } else if (tries++ < 30) t = setTimeout(go, 100);
      else setJumped(jumpTo);
    };
    t = setTimeout(go, 150);
    return () => void (t && clearTimeout(t));
  }, [jumpTo, jumped, snap, reduce]);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!jumped) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFlash(jumped);
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [jumped]);

  // Delivery: only from conversation_receipts (privacy-filtered by the server). My own read-receipts
  // switch (Message privacy or this chat) hides Read.
  const showRead = dm.read_receipts && snap?.mine?.read_receipts !== false;
  // Online status is reciprocal: with mine hidden (Message privacy) I don't see theirs either. Nothing
  // live (online, typing, now playing) shows while a request is pending or a block exists.
  const showOnline = dm.online_status && online && !quiet;
  const showTyping = typing && !quiet;
  const shownPlaying = quiet ? null : otherPlaying;
  // Chat mood (Chat info › Chat mood, Auto by default): glow + my bubbles follow the song playing (mine, else theirs).
  const mood = moodMode === 'auto' ? moodColor(nowPlaying ?? shownPlaying) : null;
  const otherReceipt: Receipt | null = otherId ? (receipts?.find((r) => r.user_id === otherId) ?? null) : null;

  const pins = useMemo(() => (snap?.pins ?? []).filter((p) => byId.has(p.message_id) && !snap?.hidden.has(p.message_id)), [snap, byId]);
  const pinAt = pins.length ? pinIdx % pins.length : 0;
  const pinned = pins.length ? byId.get(pins[pinAt].message_id) : undefined;
  const cyclePin = () => {
    if (!pinned) return;
    const y = rowY.current.get(pinned.id);
    if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - 12), animated: true });
    if (pins.length > 1) setPinIdx((i) => (i + 1) % pins.length);
  };

  /* ------------------------------------------------------------------ rendering */

  const card = (mine: boolean, children: ReactNode, onPress?: () => void, label?: string, onLongPress?: () => void, opts?: { width?: number; padding?: number; gap?: number }) => (
    <Tap
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityLabel={label}
      pressScale={0.98}
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        width: opts?.width ?? 260,
        maxWidth: '86%',
        borderRadius: 32,
        padding: opts?.padding ?? 12,
        backgroundColor: withAlpha(colors.white, 0.06),
        borderWidth: 1,
        borderColor: withAlpha(colors.white, 0.12),
        gap: opts?.gap ?? 10,
      }}
    >
      {children}
    </Tap>
  );

  const playBtn = (
    <View style={[{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }, shadow.sticker]}>
      <Icon name="play" size={16} color={colors.onAccent} filled />
    </View>
  );

  const renderBody = (m: ChatMessage, mine: boolean, withAvatar = false): ReactNode => {
    const long = () => openActions(m);
    // Time capsules render their locked card while the key is withheld (decrypt fails with no_envelope).
    if (m.kind === 'capsule') return <CapsuleCard m={m} mine={mine} row={capsules.get(m.id)} from={name} reduce={reduce} onDue={() => refreshMessage(m.id)} onLongPress={long} />;
    if (m.kind === 'whisper') {
      const view = whisperViews.find((v) => v.message_id === m.id && (mine ? v.user_id !== me : v.user_id === me));
      return <WhisperCard mine={mine} view={view} onOpen={id ? () => router.push({ pathname: '/chat-whisper', params: { id, msg: m.id } }) : undefined} onLongPress={long} />;
    }
    const failed = decryptErrorOf(m);
    if (failed || m.meta?.e2ee_pending === true) return <UnavailableBubble code={failed ?? 'server'} mine={mine} onLongPress={long} />;
    const v = voiceMeta(m);
    if (v) return bubble(m, mine, <VoiceNote meta={v} mine={mine} />, { radius: 24, width: 240 });
    const ph = photoMeta(m);
    if (ph) {
      const at = photos.findIndex((p) => p.id === m.id);
      return (
        <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start' }}>
          <PhotoBubble meta={ph} onPress={() => setViewerAt(at >= 0 ? at : null)} onLongPress={long} />
        </View>
      );
    }
    const poll = pollMeta(m);
    if (poll) {
      const votes = snap?.votes.filter((x) => x.message_id === m.id) ?? [];
      const myVote = votes.find((x) => x.user_id === me)?.option;
      return card(
        mine,
        <>
          <T size={11} weight={700} tracking={0.8} color={colors.accentLight}>
            POLL
          </T>
          <T size={15} weight={600}>
            {poll.question}
          </T>
          {poll.options.map((o, i) => {
            const n = votes.filter((x) => x.option === i).length;
            const pct = votes.length ? Math.round((n / votes.length) * 100) : 0;
            const chosen = myVote === i;
            return (
              <Tap
                key={i}
                onPress={() => void castVote(m, i)}
                accessibilityLabel={`${o}, ${pct} percent${chosen ? ', your vote' : ''}`}
                accessibilityState={{ selected: chosen }}
                hitSlop={4}
                style={{ height: 36, borderRadius: 18, overflow: 'hidden', backgroundColor: withAlpha(colors.white, 0.08), borderWidth: chosen ? 1 : 0, borderColor: colors.accent, justifyContent: 'center' }}
              >
                <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, backgroundColor: withAlpha(colors.accent, 0.45) }} />
                <Row style={{ paddingHorizontal: 14, justifyContent: 'space-between' }}>
                  <T size={13} weight={600} numberOfLines={1} style={{ flex: 1 }}>
                    {o}
                  </T>
                  <T size={13} weight={600}>
                    {votes.length ? `${pct}%` : ''}
                  </T>
                </Row>
              </Tap>
            );
          })}
          <T size={11} color={colors.textSecondary} accessibilityHint={myVote === undefined ? 'Tap an option to vote' : 'Tap another option to change your vote'}>
            {votes.length === 1 ? '1 vote' : `${votes.length} votes`}
          </T>
        </>,
        undefined,
        undefined,
        long,
        { padding: 14, gap: 8 },
      );
    }
    const ly = lyricMeta(m);
    if (ly) {
      return card(
        mine,
        <>
          <T size={18} weight={300} lineHeight={25}>
            “{ly.line}”
          </T>
          <Row gap={10}>
            <Cover artwork={ly.track.artwork} id={ly.track.id} size={36} radius={10} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T size={13} weight={600} numberOfLines={1}>
                {ly.track.title}
              </T>
              <T size={12} color={colors.textSecondary} numberOfLines={1}>
                {ly.track.artist.name}
              </T>
            </View>
            {playBtn}
          </Row>
        </>,
        () => {
          playTrack(ly.track, `Lyric card from ${mine ? 'you' : name}`);
          router.push('/player');
        },
        `Lyric card: ${ly.line}. Play ${ly.track.title}`,
        long,
      );
    }
    const blend = blendMeta(m);
    if (blend) {
      const sub = [blend.count !== null ? (blend.count === 1 ? '1 song' : `${blend.count} songs`) : null, blend.match !== null ? `${Math.round(blend.match)}% taste match` : null].filter(Boolean).join(' · ');
      return (
        <Tap
          onPress={() => router.push({ pathname: '/playlist', params: { id: blend.playlist_id } })}
          onLongPress={long}
          accessibilityLabel={`Blend ready: ${name} and you. ${sub}. Open playlist`}
          pressScale={0.98}
          style={{ alignSelf: 'center', width: 280, maxWidth: '90%', borderRadius: 24, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, overflow: 'hidden', borderWidth: 1, borderColor: withAlpha(colors.white, 0.16) }}
        >
          <Gradient colors={[withAlpha(colors.white, 0.12), withAlpha(colors.white, 0.03)]} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
          <View style={{ width: 56, height: 56 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Gradient colors={[colors.accent, '#3A0B10']} style={{ position: 'absolute', left: 0, top: 8, width: 40, height: 40, borderRadius: 20, opacity: 0.9 }} />
            <Gradient colors={[colors.rose, '#5A1B3A']} style={{ position: 'absolute', right: 0, top: 8, width: 40, height: 40, borderRadius: 20, opacity: 0.85 }} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T size={11} weight={700} tracking={0.6} color={colors.accentLight}>
              BLEND READY
            </T>
            <T size={15} weight={600} numberOfLines={1}>
              {name} + You
            </T>
            {sub ? (
              <T size={12} color={colors.textSecondary} numberOfLines={1}>
                {sub}
              </T>
            ) : null}
          </View>
        </Tap>
      );
    }
    const swap = swapMeta(m);
    if (swap) {
      const t = swap.track;
      const stars = ratings[m.id];
      const artist = trackArtist(t);
      return card(
        mine,
        <>
          <T variant="overline" color={colors.accentLight}>
            {mine ? 'YOUR SONG SWAP' : `SONG SWAP FROM ${name.toUpperCase()}`}
          </T>
          <Tap
            onPress={() => {
              playTrack(t, `Song swap from ${mine ? 'you' : name}`);
              router.push('/player');
            }}
            onLongPress={long}
            accessibilityLabel={`Play ${t.title}${artist ? ` by ${artist}` : ''}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
          >
            <Cover artwork={t.artwork} id={t.id} size={52} radius={24} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <T size={14} weight={600} numberOfLines={1}>
                {t.title}
              </T>
              <T size={12} color={colors.textSecondary} numberOfLines={1}>
                {artist}
              </T>
            </View>
            {playBtn}
          </Tap>
          {mine ? (
            <T size={12} color={stars ? colors.text : colors.textSecondary} accessibilityLabel={stars ? `${name} rated it ${stars} of 5` : `Waiting for ${name} to rate it`}>
              {stars ? `${name} rated it ${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}` : `Waiting for ${name}’s rating`}
            </T>
          ) : (
            <View style={{ gap: 2 }}>
              <T size={12} color={colors.textSecondary}>
                {stars ? 'Your rating · tap to change' : 'Rate this pick'}
              </T>
              <Row gap={0} accessibilityRole="adjustable" accessibilityLabel="Rating">
                {[1, 2, 3, 4, 5].map((n) => {
                  const on = !!stars && n <= stars;
                  return (
                    <Tap
                      key={n}
                      onPress={() => void rate(m, n)}
                      accessibilityRole="button"
                      accessibilityLabel={`${n} star${n > 1 ? 's' : ''}`}
                      accessibilityState={{ selected: stars === n }}
                      style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Icon name="star" size={24} color={on ? colors.gold : colors.textSecondary} filled={on} />
                    </Tap>
                  );
                })}
              </Row>
            </View>
          )}
        </>,
        undefined,
        undefined,
        long,
      );
    }
    const pl = playlistMeta(m);
    if (pl) {
      return card(
        mine,
        <Row gap={12}>
          <Cover uri={pl.cover_url} id={pl.id} size={52} radius={14} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="overline" color={colors.accentLight}>
              PLAYLIST
            </T>
            <T size={15} weight={600} numberOfLines={1}>
              {pl.title}
            </T>
            {pl.track_count !== undefined ? (
              <T size={12} color={colors.textSecondary}>
                {pl.track_count === 1 ? '1 song' : `${pl.track_count} songs`}
              </T>
            ) : null}
          </View>
          <Icon name="chevronRight" size={18} color={colors.textSecondary} />
        </Row>,
        () => router.push({ pathname: '/playlist', params: { id: pl.id } }),
        `Open playlist ${pl.title}`,
        long,
      );
    }
    const jam = jamMeta(m);
    if (jam) {
      return card(
        mine,
        <Row gap={12}>
          <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="users" size={22} color={colors.accentLight} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={15} weight={600} numberOfLines={1}>
              {jam.name}
            </T>
            <T size={12} color={colors.textSecondary}>
              {mine ? 'You started a jam' : 'Listen together'}
              {jam.code ? ` · ${jam.code}` : ''}
            </T>
          </View>
          <T size={13} weight={600} color={colors.accentLight}>
            Join
          </T>
        </Row>,
        () => router.push({ pathname: '/group-listening', params: { id: jam.room_id } }),
        `Join jam ${jam.name}`,
        long,
      );
    }
    const live = liveMeta(m);
    if (live) {
      return card(
        mine,
        <Row gap={12}>
          <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: withAlpha(colors.live, 0.18), alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="cast" size={22} color={colors.live} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={15} weight={600} numberOfLines={1}>
              {live.title}
            </T>
            <T size={12} color={colors.textSecondary}>
              Live listening session
            </T>
          </View>
          <T size={13} weight={600} color={colors.accentLight}>
            Tune in
          </T>
        </Row>,
        () => router.push({ pathname: '/live-room', params: { id: live.session_id } }),
        `Tune in to ${live.title}`,
        long,
      );
    }
    const loc = locationMeta(m);
    if (loc) {
      return card(
        mine,
        <Row gap={12}>
          <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="pin" size={22} color={colors.accentLight} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={15} weight={600}>
              Location
            </T>
            <T size={12} color={colors.textSecondary} numberOfLines={1}>
              {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}
              {loc.accuracy_m ? ` · ±${Math.round(loc.accuracy_m)} m` : ''}
            </T>
          </View>
          <Icon name="link" size={18} color={colors.textSecondary} />
        </Row>,
        () => void Linking.openURL(mapsUrl(loc)).catch(() => setNote('Could not open maps.')),
        'Open shared location in maps',
        long,
      );
    }
    const parts: ReactNode[] = [];
    if (m.track) {
      const t = m.track;
      parts.push(
        <View key="t">
          {card(
            mine,
            <Row gap={12}>
              <Cover artwork={t.artwork} id={t.id} size={56} radius={26} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T size={14} weight={600} numberOfLines={1}>
                  {t.title}
                </T>
                <T size={12} color={colors.textSecondary} numberOfLines={1}>
                  {t.artist.name} · {Math.floor(t.duration / 60)}:{String(Math.floor(t.duration % 60)).padStart(2, '0')}
                </T>
              </View>
              {playBtn}
            </Row>,
            () => {
              playTrack(t, `Shared by ${mine ? 'you' : name}`);
              router.push('/player');
            },
            `Play ${t.title} by ${t.artist.name}`,
            long,
            { width: 250 },
          )}
        </View>,
      );
    }
    if (m.body) {
      // 1–3 emoji only: drawn large without a bubble.
      const b = bigEmojiCount(m.body)
        ? bubble(m, mine, <T size={40} lineHeight={50}>{m.body.trim()}</T>, { bare: true })
        : bubble(m, mine, <T size={15} lineHeight={20} color={mine ? colors.onAccent : colors.text}>{marked(m.body)}</T>);
      parts.push(
        mine ? (
          <View key="b">{b}</View>
        ) : (
          // Incoming text: 30 px avatar beside the bubble (on the last bubble of a run).
          <Row key="b" gap={8} align="flex-end" style={{ maxWidth: '86%' }}>
            {withAvatar ? <ChatAvatar person={other} size={30} radius={10} /> : <View style={{ width: 30 }} />}
            <View style={{ flexShrink: 1 }}>{b}</View>
          </Row>
        ),
      );
    }
    return parts;
  };

  /** Search hits inside a text bubble, marked in amber. */
  const marked = (text: string): ReactNode => {
    if (!q) return text;
    const lower = text.toLowerCase();
    const out: ReactNode[] = [];
    let i = 0;
    for (let j = lower.indexOf(q); j >= 0; j = lower.indexOf(q, i)) {
      if (j > i) out.push(text.slice(i, j));
      out.push(
        <T key={j} size={15} lineHeight={20} weight={700} color={colors.onLight} style={{ backgroundColor: colors.amber }}>
          {text.slice(j, j + q.length)}
        </T>,
      );
      i = j + q.length;
    }
    if (!out.length) return text;
    out.push(text.slice(i));
    return out;
  };

  /** Swipe-to-reply / "Reply" accessibility action: same as Message options › Reply. */
  const canReply = (m: ChatMessage) => !!id && !m.pending && !cantSend && reqState !== 'outgoing' && !gone;
  const replyWith = (m: ChatMessage) => {
    if (!id) return;
    chatBus.setReply(id, m);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const bubble = (m: ChatMessage, mine: boolean, content: ReactNode, opts?: { radius?: number; width?: number; bare?: boolean }) => {
    const r = opts?.radius ?? 20;
    // Sent (not yet delivered) bubbles are slightly dimmed, as in the design.
    const sentOnly = mine && !m.pending && deliveryOf(m, otherReceipt, showRead) === 'sent';
    return (
      <Tap
        onLongPress={() => openActions(m)}
        delayLongPress={300}
        accessibilityActions={canReply(m) ? REPLY_ACTIONS : undefined}
        onAccessibilityAction={(e) => e.nativeEvent.actionName === 'reply' && canReply(m) && replyWith(m)}
        accessibilityLabel={`${mine ? 'You' : name}: ${messagePreview(m)}${editedAt(m) ? ', edited' : ''}`}
        accessibilityHint="Long press for message options"
        pressScale={0.99}
        style={{
          alignSelf: mine ? 'flex-end' : 'flex-start',
          maxWidth: opts?.width ? '86%' : mine ? '80%' : '100%',
          width: opts?.width,
          paddingVertical: 10,
          paddingHorizontal: 14,
          borderRadius: r,
          borderBottomLeftRadius: mine ? r : 6,
          borderBottomRightRadius: mine ? 6 : r,
          overflow: 'hidden',
          opacity: sentOnly ? 0.85 : 1,
          backgroundColor: opts?.bare ? 'transparent' : mine ? colors.accent : withAlpha(colors.white, 0.06),
          borderWidth: mine || opts?.bare ? 0 : 1,
          borderColor: withAlpha(colors.white, 0.12),
          ...(opts?.bare ? { paddingVertical: 0, paddingHorizontal: 2 } : null),
        }}
      >
        {mine && !opts?.bare ? <Gradient colors={mood ? [mood, colors.indigo] : OUT_GRADIENT} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} /> : null}
        {content}
      </Tap>
    );
  };

  const rows: ReactNode[] = [];
  let lastDay = '';
  const disappearSince = snap?.conversation?.disappear_seconds ? (snap.conversation.disappear_since ?? '') : null;
  let noticeShown = disappearSince === null;
  const notice = (key: string) => (
    <View
      key={key}
      accessibilityRole="text"
      style={{ alignSelf: 'center', minHeight: 28, paddingVertical: 4, paddingHorizontal: 12, borderRadius: 14, backgroundColor: withAlpha(colors.white, 0.08), flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '90%' }}
    >
      <Icon name="timer" size={13} color={SOFT_TEXT} />
      <T size={11} color={SOFT_TEXT}>
        {snap?.conversation?.disappear_by === me
          ? 'You turned on disappearing messages'
          : snap?.conversation?.disappear_by && snap.conversation.disappear_by === otherId
            ? `${name.split(' ')[0]} turned on disappearing messages`
            : 'Disappearing messages are on'}{' '}
        · {disappearLabel(snap?.conversation?.disappear_seconds).replace(' hours', 'h').replace(' days', 'd')}
      </T>
    </View>
  );
  const pendingChanges = [...idChanges].sort((a, b) => (a.at < b.at ? -1 : 1));
  const flushChanges = (before: string | null) => {
    while (pendingChanges.length && (before === null || pendingChanges[0].at <= before)) {
      const c = pendingChanges.shift() as (typeof pendingChanges)[number];
      rows.push(<SecurityCodeRow key={`sc-${c.userId}-${c.at}`} uid={c.userId} name={name} at={c.at} />);
    }
  };
  visible.forEach((m, idx) => {
    flushChanges(m.created_at);
    if (!noticeShown && disappearSince !== null && m.created_at >= disappearSince) {
      noticeShown = true;
      rows.push(notice('disappear'));
    }
    const day = dayLabel(m.created_at);
    if (day !== lastDay) {
      lastDay = day;
      rows.push(
        <View key={`d-${m.id}`} style={{ alignSelf: 'center', height: 24, paddingHorizontal: 12, borderRadius: 12, backgroundColor: withAlpha(colors.white, 0.08), justifyContent: 'center' }}>
          <T size={11} color={colors.textSecondary}>
            {day}
          </T>
        </View>,
      );
    }
    // Call log entry (posted by the server as the caller when a call finishes): centered system row.
    const cm = callMeta(m);
    if (cm) {
      rows.push(
        <View
          key={m.id}
          onLayout={(e) => rowY.current.set(m.id, e.nativeEvent.layout.y)}
          style={[{ borderRadius: 16, paddingVertical: 2 }, matchSet.has(m.id) ? { backgroundColor: withAlpha(colors.amber, m.id === currentMatch ? 0.18 : 0.06) } : null]}
        >
          <CallLogRow meta={cm} mine={m.sender_id === me} at={m.created_at} onCallBack={CALLS_ENABLED && !callBlockedReason ? placeCall : undefined} />
        </View>,
      );
      return;
    }
    const mine = m.sender_id === me;
    const quoted = m.reply_to ? byId.get(m.reply_to) : undefined;
    const reactions = snap?.reactions.filter((r) => r.message_id === m.id) ?? [];
    const grouped = [...new Set(reactions.map((r) => r.emoji))].map((e) => ({ emoji: e, n: reactions.filter((r) => r.emoji === e).length, mineOn: reactions.some((r) => r.emoji === e && r.user_id === me) }));
    const next = visible[idx + 1];
    const endOfRun = !next || next.sender_id !== m.sender_id;
    const delivery = mine ? deliveryOf(m, otherReceipt, showRead) : null;
    const isPinned = pins.some((p) => p.message_id === m.id);
    rows.push(
      <View
        key={m.id}
        onLayout={(e) => rowY.current.set(m.id, e.nativeEvent.layout.y)}
        style={[
          { gap: 4, opacity: m.pending ? 0.6 : 1, alignItems: mine ? 'flex-end' : 'flex-start', borderRadius: 16 },
          matchSet.has(m.id) ? { backgroundColor: withAlpha(colors.amber, m.id === currentMatch ? 0.18 : 0.06) } : null,
          flash === m.id ? { backgroundColor: withAlpha(colors.gold, 0.14) } : null,
        ]}
      >
        {m.reply_to ? (
          <View style={{ maxWidth: '80%', marginLeft: mine ? 0 : 38, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 22, backgroundColor: withAlpha(colors.white, 0.08), borderLeftWidth: 3, borderLeftColor: colors.accent }}>
            <T size={12} weight={700} color={colors.white}>
              {quoted ? (quoted.sender_id === me ? 'You' : name) : 'Reply'}
            </T>
            <T size={12} color={colors.peach} numberOfLines={2}>
              {quoted ? messagePreview(quoted) : 'Original message unavailable'}
            </T>
          </View>
        ) : null}
        <SwipeToReply
          enabled={canReply(m)}
          onReply={() => replyWith(m)}
          reduce={reduce}
          mine={mine}
          reveal={reveal.x}
          meta={
            <Row gap={4}>
              <T size={12} color={SOFT_TEXT}>
                {m.pending ? '…' : timeOf(m.created_at)}
              </T>
              {mine && delivery && !m.pending ? (
                <T size={12} color={delivery === 'read' ? colors.accentLight : SOFT_TEXT}>
                  {DELIVERY_LABEL[delivery].ticks}
                </T>
              ) : null}
            </Row>
          }
        >
          <View style={{ alignSelf: 'stretch', gap: 6, alignItems: mine ? 'flex-end' : 'flex-start' }}>{renderBody(m, mine, endOfRun)}</View>
        </SwipeToReply>
        {isNotEncrypted(m) ? <NotEncryptedNote mine={mine} indent={38} /> : null}
        {grouped.length ? (
          <Row gap={4} style={{ flexWrap: 'wrap', marginTop: -8, marginLeft: mine ? 0 : 38, marginRight: mine ? 12 : 0, justifyContent: mine ? 'flex-end' : 'flex-start' }}>
            {grouped.map((g) => (
              <Tap
                key={g.emoji}
                onPress={() => void react(m, g.emoji)}
                accessibilityLabel={`${g.emoji} ${g.n}${g.mineOn ? ', tap to remove yours' : ', tap to add'}`}
                hitSlop={10}
                style={{ height: 24, paddingHorizontal: 8, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: REACTION_BG, borderWidth: 1, borderColor: g.mineOn ? colors.accent : colors.glassBorder }}
              >
                <T size={12}>
                  {g.emoji} {g.n}
                </T>
              </Tap>
            ))}
          </Row>
        ) : null}
        {mine && delivery && (endOfRun || m.pending) ? (
          <T size={11} color={colors.textSecondary} accessibilityLabel={m.pending ? 'Sending' : `${timeOf(m.created_at)}, ${DELIVERY_LABEL[delivery].text}`}>
            {isPinned ? '📌 ' : ''}
            {stars.has(m.id) ? '★ ' : ''}
            {m.pending ? 'Sending…' : `${timeOf(m.created_at)} · ${editedAt(m) ? 'Edited · ' : ''}`}
            {!m.pending ? (
              <T size={11} color={delivery === 'read' ? colors.accentLight : colors.textSecondary}>
                {DELIVERY_LABEL[delivery].ticks}
              </T>
            ) : null}
            {!m.pending ? ` ${DELIVERY_LABEL[delivery].text}` : ''}
          </T>
        ) : isPinned || stars.has(m.id) || (editedAt(m) && !mine) ? (
          <T size={11} color={colors.textSecondary} style={{ marginLeft: mine ? 0 : 38 }}>
            {[isPinned ? '📌 Pinned' : null, stars.has(m.id) ? '★ Starred' : null, editedAt(m) && !mine ? 'Edited' : null].filter(Boolean).join(' · ')}
          </T>
        ) : null}
      </View>,
    );
  });
  if (!noticeShown && visible.length) rows.push(notice('disappear'));
  flushChanges(null);

  // My scheduled messages wait at the bottom as outgoing bubbles until the server sends them.
  for (const sm of scheduled) {
    rows.push(
      <Tap
        key={`sch-${sm.id}`}
        onPress={() => id && router.push({ pathname: '/chat-scheduled', params: { id } })}
        accessibilityLabel={`Scheduled for ${scheduledLabel(sm.send_at)}: ${sm.body}. Tap to manage`}
        style={{ alignSelf: 'flex-end', maxWidth: '80%', alignItems: 'flex-end', gap: 3 }}
      >
        <View style={{ paddingVertical: 10, paddingHorizontal: 14, borderRadius: 20, borderBottomRightRadius: 6, backgroundColor: withAlpha(colors.white, 0.04), borderWidth: 1.5, borderStyle: 'dashed', borderColor: withAlpha(colors.white, 0.35) }}>
          <T size={15} lineHeight={20} color={colors.peach}>
            {sm.body}
          </T>
        </View>
        <Row gap={4}>
          <Icon name="clockSmall" size={12} color={colors.textSecondary} />
          <T size={11} color={colors.textSecondary}>
            Scheduled · {scheduledLabel(sm.send_at)}
          </T>
        </Row>
      </Tap>,
    );
  }

  if (showTyping) {
    rows.push(
      <Row key="typing" gap={8} align="flex-end" accessibilityRole="text" accessibilityLabel={`${name} is typing`} accessibilityLiveRegion="polite">
        <ChatAvatar person={other} size={30} radius={10} />
        <View style={{ height: 36, paddingHorizontal: 14, borderRadius: 18, borderBottomLeftRadius: 6, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12), flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <TypingDots reduce={reduce} />
        </View>
      </Row>,
    );
  }

  // Pinned messages sit in a bar under the header (PinnedBar); "now playing" stays in the strip above the composer.
  const firstName = name.split(' ')[0];
  const pinnedBar =
    id && snap && !gone ? (
      <PinnedBar
        text={pinned && !searchOpen ? messagePreview(pinned) : null}
        index={pinAt}
        count={pins.length}
        onPress={cyclePin}
        onLongPress={() => infoParams && router.push({ pathname: '/chat-info', params: { ...infoParams, section: 'pinned' } })}
      />
    ) : null;
  const playingPart = shownPlaying ? (
    <Tap
      onPress={() => void joinListening()}
      accessibilityRole="button"
      accessibilityLabel={`${firstName} is listening to ${shownPlaying.title} by ${shownPlaying.artist}. Join`}
      accessibilityHint="Plays the same song"
      pressScale={0.98}
      style={{ flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}
    >
      <EqBars reduce={reduce} />
      <T size={12} color={colors.peach} numberOfLines={1} style={{ flex: 1 }}>
        {firstName} is listening to{' '}
        <T size={12} weight={700}>
          {shownPlaying.title}
        </T>
      </T>
      <View style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.success, justifyContent: 'center' }}>
        <T size={12} weight={700} color={colors.onLight}>
          {busy === 'join' ? '…' : 'Join'}
        </T>
      </View>
    </Tap>
  ) : null;
  const strip = playingPart ? (
    <Row gap={8} style={{ marginHorizontal: 12, minHeight: 44, paddingLeft: 12, paddingRight: 6, borderRadius: 22, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
      {playingPart}
    </Row>
  ) : null;

  const composer =
    id && snap && !gone ? (
      <View style={{ gap: 8, paddingBottom: 12 }}>
        {note ? (
          <Tap onPress={() => setNote(null)} style={{ paddingHorizontal: 16 }} accessibilityLabel={`${note}. Tap to dismiss`}>
            <T size={13} color={colors.amber} align="center" accessibilityLiveRegion="polite">
              {note}
            </T>
          </Tap>
        ) : null}
        {reqState === 'incoming' && !cantSend ? (
          <View style={{ marginHorizontal: 12, padding: 12, gap: 10, borderRadius: 20, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
            <T size={13} lineHeight={18} color={colors.textSecondary} align="center">
              {name} wants to message you. They won’t know you’ve seen it until you accept.
            </T>
            <Row gap={8}>
              <Button label={busy === 'accept' ? 'Accepting…' : 'Accept'} height={44} style={{ flex: 1 }} variant={busy ? 'disabled' : 'primary'} onPress={() => void answerRequest('accept')} />
              <Button label={busy === 'decline' ? 'Declining…' : 'Decline'} height={44} style={{ flex: 1 }} variant="glass" onPress={() => void answerRequest('decline')} />
              <Button label={busy === 'block' ? 'Blocking…' : 'Block'} height={44} style={{ flex: 1 }} variant="destructive" onPress={() => void answerRequest('block')} />
            </Row>
          </View>
        ) : reqState === 'outgoing' && !cantSend ? (
          <Row gap={8} style={{ marginHorizontal: 16 }}>
            <Icon name="clock" size={16} color={colors.textSecondary} />
            <T size={12} lineHeight={17} color={colors.textSecondary} style={{ flex: 1 }}>
              Request sent. They’ll see your messages if they accept.
            </T>
          </Row>
        ) : null}
        {strip}
        {cantSend ? (
          // Block bar (same glass + pill language as ConfirmBlock / BlockedDone).
          <View
            accessibilityRole="summary"
            style={{ marginHorizontal: 12, padding: 16, gap: 12, borderRadius: 28, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}
          >
            <Row gap={12}>
              <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: withAlpha(colors.error, 0.16), alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="block" size={20} color={BLOCK_RED} />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T size={15} weight={600} accessibilityRole="header">
                  {iBlocked ? `You blocked ${name}` : 'You can’t reply to this conversation'}
                </T>
                <T size={13} lineHeight={18} color={colors.textSecondary}>
                  {iBlocked ? 'You can’t message or call each other.' : 'This account isn’t available.'}
                </T>
              </View>
            </Row>
            {iBlocked ? (
              <Row gap={10}>
                <View style={{ flex: 1 }}>
                  <DialogButton label="Unblock" busy={busy === 'unblock'} onPress={() => void unblockThem()} />
                </View>
                <View style={{ flex: 1 }}>
                  <DialogButton label="Delete chat" kind="danger" disabled={busy === 'unblock'} onPress={() => router.push(confirmClearHref(id, other?.display_name))} />
                </View>
              </Row>
            ) : null}
          </View>
        ) : (
          <>
            {editing ? (
              <Row style={{ marginHorizontal: 12, paddingVertical: 8, paddingLeft: 12, paddingRight: 4, borderRadius: 16, backgroundColor: withAlpha(colors.white, 0.06), borderLeftWidth: 3, borderLeftColor: colors.accent }}>
                <Icon name="edit" size={16} color={colors.accentLight} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={12} weight={700}>
                    Editing message
                  </T>
                  <T size={12} color={colors.textSecondary} numberOfLines={1}>
                    {editing.body}
                  </T>
                </View>
                <IconButton icon="close" label="Cancel editing" size={44} iconSize={18} color={colors.textSecondary} onPress={cancelEdit} />
              </Row>
            ) : replyTo ? (
              <Row style={{ marginHorizontal: 12, paddingVertical: 8, paddingLeft: 12, paddingRight: 4, borderRadius: 16, backgroundColor: withAlpha(colors.white, 0.06), borderLeftWidth: 3, borderLeftColor: colors.accent }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={12} weight={700}>
                    Replying to {replyTo.sender_id === me ? 'yourself' : name}
                  </T>
                  <T size={12} color={colors.textSecondary} numberOfLines={1}>
                    {messagePreview(replyTo)}
                  </T>
                </View>
                <IconButton icon="close" label="Cancel reply" size={44} iconSize={18} color={colors.textSecondary} onPress={() => chatBus.setReply(id, undefined)} />
              </Row>
            ) : null}
            <Row gap={8} style={{ paddingHorizontal: 12 }}>
              {editing ? null : (
                <IconButton icon="plus" label="Chat extras" size={46} iconSize={22} bg={colors.chipGhost} onPress={() => router.push({ pathname: '/chat-extras', params: { id } })} />
              )}
              <Row gap={8} style={{ flex: 1, height: 48, borderRadius: 24, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12), paddingLeft: 16, paddingRight: 2 }}>
                <TextInput
                  ref={inputRef}
                  value={draft}
                  onChangeText={onDraft}
                  onSubmitEditing={send}
                  returnKeyType={editing ? 'done' : 'send'}
                  placeholder={editing ? 'Edit message' : forever ? 'Message your Forever' : 'Message'}
                  placeholderTextColor={colors.textSecondary}
                  accessibilityLabel={editing ? 'Edit message' : 'Message'}
                  maxLength={2000}
                  {...picker.inputProps}
                  onFocus={() => {
                    picker.onInputFocus();
                    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 250);
                  }}
                  style={{ flex: 1, height: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 15 }}
                />
                {editing || draft.trim() ? null : (
                  <IconButton icon="image" label="Share a photo, song or more" size={40} iconSize={20} color={colors.textSecondary} onPress={() => router.push({ pathname: '/chat-attach', params: { id } })} />
                )}
                <IconButton
                  icon="faceId"
                  label={picker.open ? 'Show keyboard' : 'Emoji'}
                  size={44}
                  iconSize={20}
                  color={picker.open ? colors.accentLight : colors.textSecondary}
                  onPress={picker.toggle}
                />
              </Row>
              {editing ? (
                <IconButton icon="check" label="Save edit" size={48} iconSize={22} bg={colors.accent} color={colors.onAccent} onPress={send} />
              ) : draft.trim() ? (
                <IconButton icon="send" label="Send" size={48} iconSize={22} bg={colors.accent} color={colors.onAccent} onPress={send} />
              ) : (
                <IconButton icon="mic" label="Voice note" size={48} iconSize={22} bg={colors.accent} color={colors.onAccent} onPress={() => router.push({ pathname: '/chat-voice', params: { id } })} />
              )}
            </Row>
            {picker.open ? <EmojiPanel {...picker.panelProps} /> : null}
          </>
        )}
      </View>
    ) : undefined;

  // "typing…" › "online" › "last seen today at 9:41 PM" (useLastSeen, privacy-filtered server side) › @username.
  const moreRef = useRef<ComponentRef<typeof View>>(null);
  const { width: winW } = useWindowDimensions();
  const openMenu = () => {
    const node = moreRef.current;
    if (!node) return setMenu({ top: 96, right: 16 });
    node.measureInWindow((x, y, w, h) => setMenu({ top: y + h + 6, right: Math.max(8, winW - (x + w)) }));
  };
  const closeMenu = () => setMenu(null);
  const timerLabel = disappearLabel(snap?.conversation?.disappear_seconds).replace(' hours', 'h').replace(' days', 'd');
  type MenuItem = { key: string; label: string; icon: IconName; sub?: string; value?: string; danger?: boolean; tint?: boolean; chevron?: boolean; disabled?: boolean; onPress: () => void } | 'divider';
  // While a block exists, the jam / timer / tools entries are disabled (nothing can be sent).
  const blockedSub = cantSend ? (iBlocked ? `Unblock ${firstName} to use this` : 'Not available') : undefined;
  const peerParams = chatPeerParams(other);
  const menuItems: MenuItem[] = id
    ? [
        {
          key: 'listen',
          label: busy === 'jam' ? 'Starting…' : 'Listen together',
          icon: 'headphones',
          sub: blockedSub ?? (shownPlaying ? `${firstName} is on ${shownPlaying.title}` : 'Start a jam and invite them'),
          tint: true,
          disabled: cantSend,
          onPress: () => void startJam(),
        },
        { key: 'search', label: 'Search in chat', icon: 'search', onPress: () => setSearchOpen(true) },
        { key: 'info', label: 'Chat info', icon: 'infoDot', onPress: () => router.push({ pathname: '/chat-info', params: { ...peerParams, id } }) },
        ...(snap?.mine ? [{ key: 'mute', label: muted ? 'Unmute notifications' : 'Mute notifications', icon: (muted ? 'bell' : 'bellOff') as IconName, onPress: () => void toggleMute() }] : []),
        'divider',
        { key: 'pins', label: 'Pinned messages', icon: 'pushPin', value: String(pins.length), onPress: () => router.push({ pathname: '/chat-info', params: { ...peerParams, id, section: 'pinned' } }) },
        { key: 'starred', label: 'Starred messages', icon: 'star', onPress: () => router.push({ pathname: '/starred', params: { cid: id } }) },
        { key: 'media', label: 'Media, links and songs', icon: 'image', onPress: () => router.push({ pathname: '/chat-media', params: { ...peerParams, id } }) },
        cantSend || reqState !== 'none'
          ? { key: 'timer', label: 'Disappearing', icon: 'timer', sub: blockedSub ?? 'Available after they accept', disabled: true, onPress: () => setNote(cantSend ? 'Chat tools are off while this chat is blocked.' : 'Disappearing messages and scheduling are available after they accept.') }
          : { key: 'timer', label: 'Disappearing', icon: 'timer', value: timerLabel, onPress: () => router.push({ pathname: '/chat-tools', params: { id } }) },
        {
          key: 'extras',
          label: 'Chat extras',
          icon: 'plus',
          sub: blockedSub ?? 'Capsule, whisper, mood, schedule',
          chevron: true,
          disabled: cantSend,
          onPress: () => router.push({ pathname: '/chat-extras', params: { id } }),
        },
        {
          key: 'tools',
          label: 'All chat tools',
          icon: 'grid',
          sub: blockedSub ?? (reqState !== 'none' ? 'Timer and scheduling after they accept' : undefined),
          chevron: true,
          disabled: cantSend,
          onPress: () => router.push({ pathname: '/chat-tools', params: { id } }),
        },
        'divider',
        {
          key: 'block',
          label: iBlocked ? `Unblock ${firstName}` : 'Block or report',
          icon: 'ban',
          danger: true,
          onPress: () => (iBlocked ? void unblockThem() : other ? router.push(confirmBlockHref(other, id)) : router.push({ pathname: '/chat-info', params: { id } })),
        },
      ]
    : [];

  const menuView = (
    <Modal visible={!!menu} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={closeMenu}>
      <Tap onPress={closeMenu} accessibilityLabel="Close menu" pressScale={1} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.scrim }}>
        <View />
      </Tap>
      {menu ? (
        <View
          accessibilityRole="menu"
          accessibilityLabel="Chat options"
          accessibilityViewIsModal
          style={[
            { position: 'absolute', top: menu.top, right: menu.right, width: 256, padding: 6, borderRadius: 22, backgroundColor: withAlpha(colors.bgTertiary, 0.96), borderWidth: 1, borderColor: withAlpha(colors.white, 0.14) },
            shadow.sticker,
          ]}
        >
          {menuItems.map((it, i) =>
            it === 'divider' ? (
              <View key={`div-${i}`} accessibilityElementsHidden importantForAccessibility="no" style={{ height: 1, marginVertical: 4, marginHorizontal: 12, backgroundColor: withAlpha(colors.white, 0.08) }} />
            ) : (
              <Tap
                key={it.key}
                onPress={() => {
                  closeMenu();
                  if (it.disabled && it.key !== 'timer') return;
                  it.onPress();
                }}
                accessibilityRole="menuitem"
                accessibilityLabel={[it.label, it.sub, it.value].filter(Boolean).join(', ')}
                accessibilityState={it.disabled ? { disabled: true } : undefined}
                pressScale={0.98}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: it.sub ? 52 : 48, paddingHorizontal: 12, borderRadius: 16, opacity: it.disabled ? 0.5 : 1, backgroundColor: it.tint ? withAlpha(colors.success, 0.1) : undefined }}
              >
                <Icon name={it.icon} size={20} color={it.danger ? BLOCK_RED : it.tint ? colors.success : colors.text} />
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <T size={14} weight={it.tint ? 600 : 500} color={it.danger ? BLOCK_RED : colors.text} numberOfLines={1}>
                    {it.label}
                  </T>
                  {it.sub ? (
                    <T size={11} color={it.tint ? LISTEN_SUB : colors.textSecondary} numberOfLines={1}>
                      {it.sub}
                    </T>
                  ) : null}
                </View>
                {it.value ? (
                  <T size={12} color={colors.textSecondary}>
                    {it.value}
                  </T>
                ) : null}
                {it.chevron ? <Icon name="chevronRight" size={16} color={colors.textSecondary} /> : null}
              </Tap>
            ),
          )}
        </View>
      ) : null}
    </Modal>
  );

  const statusText = showTyping ? 'typing…' : showOnline ? 'online' : (!quiet && lastSeen.label) || (other?.username ? `@${other.username}` : 'Tap for chat info');

  const header = searchOpen ? (
    <Row gap={6} style={{ paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: withAlpha(colors.white, 0.08) }}>
      <IconButton icon="close" label="Close search" size={44} onPress={closeSearch} />
      <Row gap={8} style={{ flex: 1, height: 44, borderRadius: 22, paddingHorizontal: 14, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
        <Icon name="search" size={16} color={colors.textSecondary} />
        <TextInput
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            setMatchSel(null);
          }}
          autoFocus={!searchPrefill}
          placeholder="Search in chat"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Search in chat"
          returnKeyType="search"
          onSubmitEditing={() => stepMatch(-1)}
          style={{ flex: 1, height: 42, color: colors.text, fontFamily: fonts.regular, fontSize: 15 }}
        />
        {q ? (
          <T size={12} color={colors.textSecondary} accessibilityLiveRegion="polite" accessibilityLabel={matches.length ? `Match ${matchAt + 1} of ${matches.length}` : 'No matches'}>
            {matches.length ? `${matchAt + 1}/${matches.length}` : '0'}
          </T>
        ) : null}
      </Row>
      <IconButton icon="chevronUp" label="Previous match" size={44} iconSize={20} color={matches.length ? colors.text : colors.textTertiary} onPress={() => stepMatch(-1)} />
      <IconButton icon="chevronDown" label="Next match" size={44} iconSize={20} color={matches.length ? colors.text : colors.textTertiary} onPress={() => stepMatch(1)} />
    </Row>
  ) : (
    <Row gap={8} style={{ paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: withAlpha(colors.white, 0.08) }}>
      <IconButton icon="back" label="Back" size={40} iconSize={22} onPress={() => (router.canGoBack() ? router.back() : router.replace('/messages'))} />
      <Tap
        onPress={() => infoParams && router.push({ pathname: '/chat-info', params: infoParams })}
        accessibilityRole="button"
        accessibilityLabel={nameLoading ? 'Loading chat. Chat info' : `${name}${forever ? ', Forever friend' : ''}, ${statusText}. Chat info`}
        style={{ flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 }}
      >
        <View>
          <ChatAvatar person={other} size={42} radius={22} />
          {showOnline ? <View style={{ position: 'absolute', right: -1, bottom: -1, width: 14, height: 14, borderRadius: 7, backgroundColor: ONLINE_GREEN, borderWidth: 2.5, borderColor: colors.bg }} /> : null}
          {forever ? <ForeverBadge size={18} style={{ position: 'absolute', right: -6, top: -5 }} /> : null}
        </View>
        {nameLoading ? (
          <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
            <SkeletonBlock width="55%" height={14} r={7} />
            <SkeletonBlock width="35%" height={10} r={5} />
          </View>
        ) : (
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={16} weight={600} numberOfLines={1}>
              {name}
            </T>
            <T size={12} color={showTyping || showOnline ? ONLINE_GREEN : colors.textSecondary} numberOfLines={1} accessibilityLiveRegion="polite">
              {statusText}
            </T>
          </View>
        )}
      </Tap>
      {/* Header: back, person, Video, Call, ⋯ (chat options menu). */}
      {cantSend ? null : CALLS_ENABLED && other && id ? (
        <>
          <IconButton icon="video" label={caller.busy === 'video' ? 'Starting video call' : 'Video call'} size={40} iconSize={19} bg={colors.chipGhost} color={callBlockedReason ? colors.textTertiary : colors.text} onPress={() => placeCall('video')} />
          <IconButton icon="call" label={caller.busy === 'audio' ? 'Starting voice call' : 'Voice call'} size={40} iconSize={19} bg={colors.chipGhost} color={callBlockedReason ? colors.textTertiary : colors.text} onPress={() => placeCall('audio')} />
        </>
      ) : other ? (
        <IconButton icon="headphones" label={busy === 'jam' ? 'Starting jam' : 'Listen together'} size={40} iconSize={19} bg={colors.chipGhost} onPress={() => void startJam()} />
      ) : null}
      {id ? (
        <View ref={moreRef} collapsable={false}>
          <IconButton icon="more" label="More options" size={40} iconSize={19} bg={colors.chipGhost} onPress={openMenu} />
        </View>
      ) : null}
    </Row>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior="padding">
      <Screen top={4} gap={10} scroll={false} backdrop={{ pattern: 'none', mesh: 'rose', orbs: true }} footer={composer} footerInset={!keyboardOpen}>
        {header}
        {pinnedBar}
        {menuView}
        {!id ? (
          <EmptyState icon="mail" title="No conversation selected" body="Pick a conversation or start a new one." action="Open messages" onAction={() => router.replace('/messages')} />
        ) : !me ? (
          <EmptyState icon="mail" title="Sign in to chat" body="Messages are tied to your Zoyra account." action="Sign in" onAction={() => router.push('/login')} />
        ) : gone ? (
          <EmptyState icon="mail" title={goneText} body="Taking you back to your messages." action="Back to messages" onAction={() => router.replace('/messages')} />
        ) : loading ? (
          <Loading />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : (
          <View style={{ flex: 1 }} {...reveal.handlers}>
          <ScrollView
            ref={scroll}
            style={{ flex: 1 }}
            contentContainerStyle={{ gap: 12, paddingVertical: 8, flexGrow: 1 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            onLayout={() => (!jumpTo || followEnd) && scroll.current?.scrollToEnd({ animated: false })}
            onContentSizeChange={() => {
              if (!searchOpen && (!jumpTo || followEnd)) scroll.current?.scrollToEnd({ animated: true });
            }}
          >
            <E2EEChatNotice uid={otherId} name={name} />
            {catchUp ? (
              <View onLayout={(e) => (catchH.current = e.nativeEvent.layout.height + 10)}>
              <CatchUpCard
                unread={catchUp}
                name={name}
                onDismiss={() => setCatchUp(null)}
                onReply={(t) => {
                  setCatchUp(null);
                  onDraft(t);
                  inputRef.current?.focus();
                }}
                onJump={() => {
                  const y = rowY.current.get(catchUp[0].id);
                  setCatchUp(null);
                  // Row offsets were measured with the card above them.
                  if (y !== undefined) setTimeout(() => scroll.current?.scrollTo({ y: Math.max(0, y - catchH.current - 80), animated: !reduce }), 50);
                }}
              />
              </View>
            ) : null}
            {visible.length === 0 ? <EmptyState icon="mail" title={`Say hi to ${name}`} body="Send a message, a voice note or the song you're playing." /> : rows}
            {!cantSend && reqState === 'none' ? <ForeverPromptCard uid={otherId} name={name} /> : null}
          </ScrollView>
          </View>
        )}
      </Screen>
      {mood ? (
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '60%' }}>
          <Gradient colors={[withAlpha(mood, 0.22), withAlpha(mood, 0)]} angle={180} style={{ flex: 1 }} />
        </View>
      ) : null}
      <PhotoViewer
        photos={photos}
        index={viewerAt}
        onClose={() => setViewerAt(null)}
        onIndexChange={setViewerAt}
        onReply={(p) => {
          const m = byId.get(p.id);
          setViewerAt(null);
          if (m && id) {
            chatBus.setReply(id, m);
            requestAnimationFrame(() => inputRef.current?.focus());
          }
        }}
        onForward={(p) => {
          setViewerAt(null);
          const m = byId.get(p.id);
          if (m) openActions(m);
        }}
      />
    </KeyboardAvoidingView>
  );
}

/** Three blinking dots in the typing bubble (static with Reduce Motion). */
function TypingDots({ reduce }: { reduce: boolean }) {
  const [t] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(Animated.timing(t, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [t, reduce]);
  return (
    <>
      {[0, 0.2, 0.4].map((d) => (
        <Animated.View
          key={d}
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: SOFT_TEXT,
            opacity: reduce ? 1 : t.interpolate({ inputRange: [0, d, d + 0.25, d + 0.5, 1], outputRange: [1, 1, 0.25, 1, 1], extrapolate: 'clamp' }),
          }}
        />
      ))}
    </>
  );
}

/** Green equalizer bars beside "now playing" (static with Reduce Motion). */
function EqBars({ reduce }: { reduce: boolean }) {
  const [t] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(Animated.timing(t, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [t, reduce]);
  return (
    <Row gap={2} align="flex-end" style={{ height: 12 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {[0, 0.22, 0.44].map((d, i) => (
        <Animated.View
          key={d}
          style={{
            width: 3,
            height: 12,
            borderRadius: 2,
            backgroundColor: colors.success,
            transform: reduce
              ? [{ scaleY: [1, 0.6, 0.85][i] }]
              : [
                  { translateY: 6 },
                  { scaleY: t.interpolate({ inputRange: [0, d, d + 0.28, d + 0.56, 1], outputRange: [0.22, 0.22, 1, 0.22, 0.22], extrapolate: 'clamp' }) },
                  { translateY: -6 },
                ],
          }}
        />
      ))}
    </Row>
  );
}
