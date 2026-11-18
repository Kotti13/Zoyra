import type { RealtimeChannel } from '@supabase/supabase-js';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Keyboard, KeyboardAvoidingView, Modal, Platform, ScrollView, TextInput, View, type ScrollViewInstance } from 'react-native';

import { EmptyState, ErrorState, Gradient, Icon, IconButton, Loading, Row, Screen, SkeletonBlock, T, Tap, useReduceMotion } from '../components';
import {
  chatBus,
  CHAT_GONE,
  chatError,
  conversationExists,
  dayLabel,
  decryptChatRows,
  editedAt,
  editChatMessage,
  loadReceipts,
  messagePreview,
  photoMeta,
  pollMeta,
  sendMessage,
  timeOf,
  toggleReaction,
  useChatEditing,
  useChatReply,
  voiceMeta,
  vote,
  type ChatMessage,
  type NewMessage,
  type Receipt,
  markConversationRead,
} from '../lib/chat';
import { ChatAvatar, GroupAvatar, hasRichCard, PhotoBubble, PollCard, RichMessageCard, TypingDots, VoiceNote } from '../lib/chat-ui';
import { PhotoViewer, type ViewerPhoto } from '../components/PhotoViewer';
import { EmojiPanel, useEmojiComposer } from '../components/EmojiPicker';
import { bigEmojiCount } from '../lib/emoji';
import { decryptErrorOf, invalidateKeyCoverage, isNotEncrypted, newMessageId, routeIfSetupRequired } from '../lib/chat-e2ee';
import { REPLY_ACTIONS, SwipeToReply, useTimeReveal } from '../lib/swipe-reply';
import { E2EEChatNotice, NotEncryptedNote, PinnedBar, SecurityCodeRow, UnavailableBubble, useIdentityChanges } from '../lib/e2ee-chat-ui';
import { dmSettings, markDelivered } from '../lib/dm';
import { startGroupCall, toGroupCallError, useLiveGroupCall } from '../lib/group-calls';
import { callMember, firstName, groupError, loadGroupChat, memberSummary, NOT_A_GROUP, startGroupJam, useGroupJam, type GroupMember, type GroupSnapshot } from '../lib/groups';
import { privateChannel } from '../lib/realtime';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors, fonts, shadow, withAlpha } from '../theme/tokens';

const TYPING_MS = 4000;
const OUT_GRADIENT = [colors.accent, colors.indigo] as const;
const BUBBLE_BG = withAlpha(colors.white, 0.06);
const BUBBLE_BORDER = withAlpha(colors.white, 0.12);
const REACTION_BG = 'rgba(20,20,20,0.85)';

type Delivery = 'sending' | 'sent' | 'delivered' | 'read';

/**
 * Group chat (`/group-chat?id=<conversation>[&search=<query>]`), GroupChat design: stacked member avatars,
 * group name + "Priya, Aarav, you · 2 online" (→ /group-info), Start jam and Call (pick one member for a
 * 1:1 call), the live jam strip, sender avatar + name on incoming runs, ✓✓ (accent) once every member
 * has read my message, polls / voice notes / photos / songs via the Chat Pro sheets, replies, reactions,
 * edits, typing (broadcast) and online (presence) on the group channel. `search` opens in-chat search
 * prefilled with that query and jumps to the newest match.
 */
export default function GroupChat() {
  const { id: rawId, search: searchParam, jump: jumpParam } = useLocalSearchParams<{ id?: string; search?: string; jump?: string }>();
  const id = typeof rawId === 'string' && rawId ? rawId : undefined;
  const { user, settings } = useAuth();
  const me = user?.id;
  const dm = dmSettings(settings?.dm);
  const reduce = useReduceMotion();
  // Swipe left on the chat: every bubble shifts left and shows its time + ticks.
  const reveal = useTimeReveal(reduce);
  const composerRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [snap, setSnap] = useState<GroupSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [typers, setTypers] = useState<Record<string, number>>({});
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [callOpen, setCallOpen] = useState(false);
  const liveCall = useLiveGroupCall(id);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const channel = useRef<RealtimeChannel | null>(null);
  const subscribed = useRef(false);
  const lastTypingSent = useRef(0);
  const rowY = useRef(new Map<string, number>());
  const replyTo = useChatReply(id);
  const editing = useChatEditing(id);
  const [editSeen, setEditSeen] = useState<string | undefined>(undefined);
  if (editing && editing.id !== editSeen) {
    setEditSeen(editing.id);
    setDraft(editing.body);
  }
  const { jam, reload: reloadJam } = useGroupJam(id);

  // In-chat search: `?search=<query>` opens it prefilled; each new value re-opens.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchSel, setMatchSel] = useState<number | null>(null);
  const [searchSeen, setSearchSeen] = useState<string | undefined>(undefined);
  if (typeof searchParam === 'string' && searchParam && searchParam !== searchSeen) {
    setSearchSeen(searchParam);
    setSearchOpen(true);
    setQuery(searchParam);
    setMatchSel(null);
  }
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery('');
    setMatchSel(null);
  };

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => {
      setKeyboardOpen(true);
      requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: true }));
    });
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const markRead = useCallback(() => {
    if (!id || !me) return;
    void markConversationRead(id, me);
    void supabase.from('notifications').update({ read: true }).eq('user_id', me).eq('read', false).in('kind', ['message', 'group_added']).eq('payload->>conversation_id', id).then(undefined, () => undefined);
  }, [id, me]);

  const refreshReceipts = useCallback(() => {
    if (!id) return;
    loadReceipts(id)
      .then(setReceipts)
      .catch(() => undefined);
  }, [id]);

  const load = useCallback(
    async (quiet = false) => {
      if (!id || !me) return;
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const s = await loadGroupChat(id, me);
        setSnap((prev) => (prev ? { ...s, messages: [...s.messages, ...prev.messages.filter((m) => m.pending)] } : s));
        markRead();
        void markDelivered().then(refreshReceipts);
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        if (msg === NOT_A_GROUP) router.replace({ pathname: '/chat-pro', params: { id } });
        else if (msg === CHAT_GONE) setGone(true);
        else if (!quiet) setError(msg || 'Could not load this group');
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [id, me, markRead, refreshReceipts],
  );

  useEffect(() => {
    // Async loader: state updates happen after the network round trip.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

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

  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void load(true);
      reloadJam();
      void channel.current?.send({ type: 'broadcast', event: 'side', payload: {} });
    }, [load, reloadJam]),
  );

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
      setSnap((s) => (s ? { ...s, reactions: r.error ? s.reactions : (r.data ?? []), pins: p.error ? s.pins : (p.data ?? []), votes: v.error ? s.votes : (v.data ?? []) } : s));
    }, 250);
  }, [id]);
  useEffect(() => () => void (sideTimer.current && clearTimeout(sideTimer.current)), []);

  const shareOnline = dm.online_status;
  // Typing is only trusted from presence keys, so members who send typing track presence too
  // ({online: false} when their online status is hidden; the online list skips those).
  const trackPresence = shareOnline || dm.typing;
  const shareRef = useRef({ track: trackPresence, online: shareOnline });
  useEffect(() => {
    shareRef.current = { track: trackPresence, online: shareOnline };
    const ch = channel.current;
    if (!ch || !subscribed.current) return;
    void (trackPresence ? ch.track({ online: shareOnline, online_at: new Date().toISOString() }) : ch.untrack());
  }, [trackPresence, shareOnline]);

  useEffect(() => {
    if (!id || !me) return;
    // Private channel (realtime.messages RLS: members only); postgres_changes still use table RLS.
    const ch = privateChannel(`group:${id}`, { presence: { key: me }, broadcast: { self: false } });
    const insert = (msg: ChatMessage) =>
      setSnap((s) => {
        if (!s || s.messages.some((x) => x.id === msg.id)) return s;
        const i = s.messages.findIndex((x) => x.pending && x.sender_id === msg.sender_id && x.body === msg.body && x.kind === msg.kind);
        const messages = i >= 0 ? [...s.messages.slice(0, i), msg, ...s.messages.slice(i + 1)] : [...s.messages, msg];
        return { ...s, messages };
      });
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${id}` }, (payload) => {
      const msg = payload.new as ChatMessage;
      // E2EE rows: decrypt first (my own sends hit the local cache).
      void decryptChatRows([msg]).then(([d]) => insert(d ?? msg), () => insert(msg));
      if (msg.sender_id !== me) {
        setTypers((t) => {
          const next = { ...t };
          delete next[msg.sender_id];
          return next;
        });
        markRead();
      }
      if (msg.kind === 'jam') reloadJam();
    })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${id}` }, (payload) => {
        const raw = payload.new as ChatMessage;
        // E2EE edits carry new ciphertext: decrypt, then swap body + meta.
        void decryptChatRows([raw]).then(([msg]) => {
          if (!msg) return;
          setSnap((s) => (s ? { ...s, messages: s.messages.map((x) => (x.id === msg.id ? { ...x, body: msg.body, track: msg.e2ee_version != null ? msg.track : x.track, meta: msg.meta ?? x.meta } : x)) } : s));
        });
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (payload) => {
        const old = payload.old as { id?: string } | undefined;
        if (old?.id) setSnap((s) => (s && s.messages.some((x) => x.id === old.id) ? { ...s, messages: s.messages.filter((x) => x.id !== old.id) } : s));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_pins', filter: `conversation_id=eq.${id}` }, refreshSide)
      // Reactions / votes: `side` broadcast from the member who changed them (tables left the realtime publication).
      .on('broadcast', { event: 'side' }, refreshSide)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members', filter: `conversation_id=eq.${id}` }, () => {
        invalidateKeyCoverage(id); // members changed: re-check who has encryption keys before the next send
        refreshReceipts();
        void load(true);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations', filter: `id=eq.${id}` }, () => void load(true))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'conversations' }, (payload) => {
        if ((payload.old as { id?: string } | undefined)?.id === id) setGone(true);
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'conversation_members' }, (payload) => {
        const old = payload.old as { conversation_id?: string; user_id?: string } | undefined;
        if (old?.conversation_id === id && old.user_id === me) setGone(true);
        else if (old?.conversation_id === id) void load(true);
      })
      .on('broadcast', { event: 'typing' }, (payload) => {
        const who = (payload.payload as { user_id?: string } | undefined)?.user_id;
        if (!who || who === me) return;
        // Client-authored payload: only trust ids that are presence keys on this private channel.
        if (!Object.prototype.hasOwnProperty.call(ch.presenceState(), who)) return;
        setTypers((t) => ({ ...t, [who]: Date.now() }));
      })
      .on('presence', { event: 'sync' }, () => {
        const state = ch.presenceState<{ online?: boolean }>();
        setOnlineIds(new Set(Object.entries(state).filter(([k, metas]) => k !== me && metas.some((p) => p.online !== false)).map(([k]) => k)));
      })
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return;
        subscribed.current = true;
        if (shareRef.current.track) void ch.track({ online: shareRef.current.online, online_at: new Date().toISOString() });
      });
    channel.current = ch;
    return () => {
      subscribed.current = false;
      channel.current = null;
      void supabase.removeChannel(ch).then(undefined, () => undefined);
    };
  }, [id, me, markRead, refreshSide, refreshReceipts, load, reloadJam]);

  // Typing entries expire after TYPING_MS.
  const typerCount = Object.keys(typers).length;
  useEffect(() => {
    if (!typerCount) return;
    const t = setInterval(() => {
      const now = Date.now();
      setTypers((cur) => {
        const next = Object.fromEntries(Object.entries(cur).filter(([, at]) => now - at < TYPING_MS));
        return Object.keys(next).length === Object.keys(cur).length ? cur : next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [typerCount]);

  useEffect(() => {
    if (!gone) return;
    const t = setTimeout(() => (router.canGoBack() ? router.back() : router.replace('/messages')), 2000);
    return () => clearTimeout(t);
  }, [gone]);

  const members = useMemo(() => snap?.members ?? [], [snap]);
  const byMember = useMemo(() => new Map(members.map((m) => [m.user_id, m])), [members]);
  const others = members.filter((m) => m.user_id !== me);
  const title = snap?.group.title || 'Group';
  const personOf = (uid: string) => {
    const m = byMember.get(uid);
    return m ? { id: m.user_id, display_name: m.display_name, avatar_url: m.avatar_url, username: m.username } : { id: uid, display_name: 'Former member', avatar_url: null, username: null };
  };
  const nameOf = (uid: string) => (uid === me ? 'You' : (byMember.get(uid)?.display_name ?? 'Former member'));

  const onlineCount = others.filter((m) => onlineIds.has(m.user_id)).length;
  const typingNames = Object.keys(typers)
    .filter((u) => byMember.has(u))
    .map((u) => firstName(byMember.get(u)?.display_name));
  const typingText = typingNames.length === 1 ? `${typingNames[0]} is typing…` : typingNames.length > 1 ? `${typingNames.length} people are typing…` : '';
  const subtitle = typingText || `${memberSummary(members, me)}${onlineCount ? ` · ${onlineCount} online` : ''}`;

  const onDraft = (t: string) => {
    setDraft(t);
    const n = Date.now();
    if (t && dm.typing && channel.current && n - lastTypingSent.current > 2000) {
      lastTypingSent.current = n;
      void channel.current.send({ type: 'broadcast', event: 'typing', payload: { user_id: me } });
    }
  };
  // Smiley button: full emoji picker in place of the keyboard, inserting at the cursor.
  const picker = useEmojiComposer(draft, onDraft, composerRef);

  const post = async (m: NewMessage) => {
    if (!id || !me) return false;
    // Real message id up front (encrypted sends use it as the message id).
    const tempId = newMessageId();
    const optimistic: ChatMessage = {
      id: tempId,
      conversation_id: id,
      sender_id: me,
      body: m.body ?? '',
      track: m.track ?? null,
      kind: m.kind ?? 'text',
      reply_to: m.reply_to ?? null,
      meta: m.meta ?? {},
      created_at: new Date().toISOString(),
      pending: true,
    };
    setSnap((s) => (s ? { ...s, messages: [...s.messages, optimistic] } : s));
    try {
      const saved = await sendMessage(id, me, m, { messageId: tempId });
      setSnap((s) => {
        if (!s) return s;
        const without = s.messages.filter((x) => x.id !== tempId);
        return { ...s, messages: without.some((x) => x.id === saved.id) ? without : [...without, saved] };
      });
      markRead();
      return true;
    } catch (e) {
      setSnap((s) => (s ? { ...s, messages: s.messages.filter((x) => x.id !== tempId) } : s));
      if (routeIfSetupRequired(e, `/group-chat?id=${encodeURIComponent(id)}`)) return false;
      if (!(await conversationExists(id))) setGone(true);
      else setNote(e instanceof Error ? e.message : 'Message not sent');
      return false;
    }
  };

  const cancelEdit = () => {
    if (!id) return;
    chatBus.setEditing(id, undefined);
    setEditSeen(undefined);
    setDraft('');
  };

  const send = () => {
    const text = draft.trim();
    if (!text || !id) return;
    if (editing) {
      const m = editing;
      cancelEdit();
      if (text === m.body) return;
      setSnap((s) => (s ? { ...s, messages: s.messages.map((x) => (x.id === m.id ? { ...x, body: text, meta: { ...x.meta, edited_at: new Date().toISOString() } } : x)) } : s));
      void editChatMessage(m, text).catch((e: unknown) => {
        setSnap((s) => (s ? { ...s, messages: s.messages.map((x) => (x.id === m.id ? m : x)) } : s));
        if (routeIfSetupRequired(e, `/group-chat?id=${encodeURIComponent(id)}`)) return;
        setNote(chatError(e, 'Could not edit'));
      });
      return;
    }
    setDraft('');
    const reply = replyTo?.id ?? null;
    chatBus.setReply(id, undefined);
    void post({ body: text, kind: 'text', reply_to: reply });
  };

  const startJam = async () => {
    if (!id || busy) return;
    setBusy('jam');
    setNote(null);
    try {
      const rid = await startGroupJam(id);
      reloadJam();
      router.push({ pathname: '/group-listening', params: { id: rid } });
    } catch (e) {
      setNote(groupError(e, 'Could not start a jam'));
    } finally {
      setBusy(null);
    }
  };

  /** Starts (or joins the live) group call and opens the call screen. */
  const groupCall = async (kind: 'audio' | 'video') => {
    if (!id || busy) return;
    setBusy(`gcall:${kind}`);
    try {
      const g = await startGroupCall(id, kind);
      setCallOpen(false);
      router.push({ pathname: '/group-call', params: { id: g.id } });
    } catch (e) {
      setCallOpen(false);
      setNote(toGroupCallError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const call = async (m: GroupMember) => {
    if (busy) return;
    setBusy(`call:${m.user_id}`);
    try {
      const c = await callMember(m.user_id, 'audio');
      setCallOpen(false);
      if (c.status === 'busy') setNote(`${firstName(m.display_name)} is on another call. We’ll let them know you called.`);
      else router.push({ pathname: '/call', params: { id: c.id } });
    } catch (e) {
      setCallOpen(false);
      setNote(e instanceof Error ? e.message : 'Couldn’t start the call.');
    } finally {
      setBusy(null);
    }
  };

  /** Tells the other members to re-read reactions / votes (see the `side` listener). */
  const pingSide = () => void channel.current?.send({ type: 'broadcast', event: 'side', payload: {} });

  const react = async (m: ChatMessage, emoji: string) => {
    if (!id || !me || m.pending) return;
    const on = !!snap?.reactions.some((r) => r.message_id === m.id && r.user_id === me && r.emoji === emoji);
    setSnap((s) => (s ? { ...s, reactions: on ? s.reactions.filter((r) => !(r.message_id === m.id && r.user_id === me && r.emoji === emoji)) : [...s.reactions, { message_id: m.id, user_id: me, emoji }] } : s));
    try {
      await toggleReaction(id, m.id, me, emoji, !on);
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
    router.push({ pathname: '/chat-actions', params: { id, msg: m.id, group: '1' } });
  };

  const visible = useMemo(() => (snap ? snap.messages.filter((m) => !snap.hidden.has(m.id)) : []), [snap]);
  const byId = useMemo(() => new Map((snap?.messages ?? []).map((m) => [m.id, m])), [snap]);

  // Full-screen photo viewer over every photo in this group (swipe between them).
  const [viewerAt, setViewerAt] = useState<number | null>(null);
  const photos = useMemo<ViewerPhoto[]>(
    () =>
      visible.flatMap((m) => {
        const ph = m.pending ? null : photoMeta(m);
        if (!ph) return [];
        const who = m.sender_id === me ? 'You' : (byMember.get(m.sender_id)?.display_name ?? 'Former member');
        return [{ id: m.id, path: ph.path, key: ph.key, mime: ph.mime, width: ph.width, height: ph.height, senderName: who, at: m.created_at }];
      }),
    [visible, me, byMember],
  );

  // Pinned bar (top, under the header): tap jumps to the pin and cycles; long press opens the pinned list.
  const [pinIdx, setPinIdx] = useState(0);
  const pins = useMemo(() => (snap?.pins ?? []).filter((p) => byId.has(p.message_id) && !snap?.hidden.has(p.message_id)), [snap, byId]);
  const pinAt = pins.length ? pinIdx % pins.length : 0;
  const pinned = pins.length ? byId.get(pins[pinAt].message_id) : undefined;

  // "Security code changed" notices for current members (local TOFU book).
  const idChanges = useIdentityChanges(others.map((o) => o.user_id));

  // Search: matches oldest → newest; the newest is selected until the user steps through.
  const q = searchOpen ? query.trim().toLowerCase() : '';
  const matches = useMemo(() => (q ? visible.filter((m) => !m.pending && `${m.body ?? ''}\n${messagePreview(m)}`.toLowerCase().includes(q)).map((m) => m.id) : []), [visible, q]);
  const matchAt = matches.length ? Math.min(matchSel ?? matches.length - 1, matches.length - 1) : -1;
  const currentMatch = matchAt >= 0 ? matches[matchAt] : undefined;
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const jumpTo = useCallback((mid: string | undefined) => {
    if (!mid) return;
    const y = rowY.current.get(mid);
    if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - 24), animated: true });
  }, []);
  useEffect(() => {
    // Rows may lay out after the match is computed (deep link): retry once shortly after.
    jumpTo(currentMatch);
    const t = setTimeout(() => jumpTo(currentMatch), 400);
    return () => clearTimeout(t);
  }, [currentMatch, jumpTo, loading]);
  // `?jump=<message>` (Starred): scroll to it once laid out.
  const starJump = typeof jumpParam === 'string' && jumpParam ? jumpParam : undefined;
  useEffect(() => {
    if (!starJump || loading) return;
    const a = setTimeout(() => jumpTo(starJump), 200);
    const b = setTimeout(() => jumpTo(starJump), 700);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [starJump, jumpTo, loading]);
  const stepMatch = (dir: -1 | 1) => {
    if (matches.length) setMatchSel((matchAt + dir + matches.length) % matches.length);
  };
  const cyclePin = () => {
    if (!pinned) return;
    jumpTo(pinned.id);
    if (pins.length > 1) setPinIdx((i) => (i + 1) % pins.length);
  };

  // ✓✓ in accent once every other member (who shares read receipts) has read it; ✓✓ grey when delivered to all.
  const showRead = dm.read_receipts && snap?.mine?.read_receipts !== false;
  const otherReceipts = receipts.filter((r) => r.user_id !== me && byMember.has(r.user_id));
  const deliveryOf = (m: ChatMessage): Delivery => {
    if (m.pending) return 'sending';
    if (!otherReceipts.length) return 'sent';
    const at = Date.parse(m.created_at);
    const readAll = otherReceipts.every((r) => r.last_read_at && Date.parse(r.last_read_at) >= at);
    if (readAll && showRead) return 'read';
    const deliveredAll = otherReceipts.every((r) => (r.last_delivered_at && Date.parse(r.last_delivered_at) >= at) || (r.last_read_at && Date.parse(r.last_read_at) >= at));
    return deliveredAll ? 'delivered' : 'sent';
  };

  /* ------------------------------------------------------------------ rendering */

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
  const canReply = (m: ChatMessage) => !!id && !m.pending && !gone;
  const replyWith = (m: ChatMessage) => {
    if (!id) return;
    chatBus.setReply(id, m);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const bubble = (m: ChatMessage, mine: boolean, content: ReactNode, width?: number, bare?: boolean) => (
    <Tap
      onLongPress={() => openActions(m)}
      delayLongPress={300}
      accessibilityActions={canReply(m) ? REPLY_ACTIONS : undefined}
        onAccessibilityAction={(e) => e.nativeEvent.actionName === 'reply' && canReply(m) && replyWith(m)}
      accessibilityLabel={`${mine ? 'You' : nameOf(m.sender_id)}: ${messagePreview(m)}${editedAt(m) ? ', edited' : ''}`}
      accessibilityHint="Long press for message options"
      pressScale={0.99}
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        width,
        maxWidth: '100%',
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 20,
        borderBottomLeftRadius: mine ? 20 : 6,
        borderBottomRightRadius: mine ? 6 : 20,
        overflow: 'hidden',
        backgroundColor: bare ? 'transparent' : mine ? colors.accent : BUBBLE_BG,
        borderWidth: mine || bare ? 0 : 1,
        borderColor: BUBBLE_BORDER,
        ...(bare ? { paddingVertical: 0, paddingHorizontal: 2 } : null),
      }}
    >
      {mine && !bare ? <Gradient colors={OUT_GRADIENT} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} /> : null}
      {content}
    </Tap>
  );

  const content = (m: ChatMessage, mine: boolean): ReactNode => {
    const long = () => openActions(m);
    // Capsules / view-once photos are 1:1 extras; if one shows up here, a plain label (never the content).
    if (m.kind === 'call') {
      const gm = (m.meta ?? {}) as { kind?: string; duration_s?: number | null; participants?: number };
      const d = typeof gm.duration_s === 'number' ? gm.duration_s : null;
      return (
        <View key={m.id} style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: withAlpha(colors.white, 0.06) }}>
          <Icon name={gm.kind === 'video' ? 'video' : 'call'} size={14} color={colors.textSecondary} />
          <T size={12} weight={600} color={colors.textSecondary}>
            {`Group ${gm.kind === 'video' ? 'video' : 'voice'} call${d ? ` · ${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}` : ''}${gm.participants ? ` · ${gm.participants} joined` : ''}`}
          </T>
        </View>
      );
    }
    if (m.kind === 'capsule' || m.kind === 'whisper') return bubble(m, mine, <T size={14} color={mine ? colors.onAccent : colors.textSecondary}>{messagePreview(m)}</T>);
    const failed = decryptErrorOf(m);
    if (failed || m.meta?.e2ee_pending === true) return <UnavailableBubble code={failed ?? 'server'} mine={mine} onLongPress={long} />;
    const v = voiceMeta(m);
    if (v) return bubble(m, mine, <VoiceNote meta={v} mine={mine} />, 240);
    const ph = photoMeta(m);
    if (ph) {
      const at = photos.findIndex((p) => p.id === m.id);
      return <PhotoBubble meta={ph} onPress={() => setViewerAt(at >= 0 ? at : null)} onLongPress={long} />;
    }
    const poll = pollMeta(m);
    if (poll) return <PollCard poll={poll} votes={snap?.votes.filter((x) => x.message_id === m.id) ?? []} me={me} mine={mine} onVote={(o) => void castVote(m, o)} onLongPress={long} />;
    const rich = hasRichCard(m) ? <RichMessageCard m={m} mine={mine} from={mine ? 'you' : nameOf(m.sender_id)} onLongPress={long} onError={setNote} /> : null;
    // 1–3 emoji only: drawn large without a bubble.
    const big = !!m.body && m.kind !== 'swap' && bigEmojiCount(m.body) > 0;
    const text = big ? bubble(m, mine, <T size={40} lineHeight={50}>{(m.body ?? '').trim()}</T>, undefined, true) : m.body && m.kind !== 'swap' ? bubble(m, mine, <T size={15} lineHeight={20} color={mine ? colors.onAccent : colors.text}>{marked(m.body)}</T>) : null;
    return (
      <View style={{ gap: 6, alignItems: mine ? 'flex-end' : 'flex-start' }}>
        {rich}
        {text}
        {!rich && !text ? bubble(m, mine, <T size={15} color={mine ? colors.onAccent : colors.text}>{messagePreview(m)}</T>) : null}
      </View>
    );
  };

  const rows: ReactNode[] = [];
  let lastDay = '';
  const pendingChanges = [...idChanges].sort((a, b) => (a.at < b.at ? -1 : 1));
  const flushChanges = (before: string | null) => {
    while (pendingChanges.length && (before === null || pendingChanges[0].at <= before)) {
      const c = pendingChanges.shift() as (typeof pendingChanges)[number];
      rows.push(<SecurityCodeRow key={`sc-${c.userId}-${c.at}`} uid={c.userId} name={byMember.get(c.userId)?.display_name ?? 'A member'} at={c.at} />);
    }
  };
  visible.forEach((m, idx) => {
    flushChanges(m.created_at);
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
    const mine = m.sender_id === me;
    const prev = visible[idx - 1];
    const next = visible[idx + 1];
    const startOfRun = !prev || prev.sender_id !== m.sender_id || dayLabel(prev.created_at) !== day;
    const endOfRun = !next || next.sender_id !== m.sender_id;
    const quoted = m.reply_to ? byId.get(m.reply_to) : undefined;
    const reactions = snap?.reactions.filter((r) => r.message_id === m.id) ?? [];
    const grouped = [...new Set(reactions.map((r) => r.emoji))].map((e) => ({ emoji: e, n: reactions.filter((r) => r.emoji === e).length, mineOn: reactions.some((r) => r.emoji === e && r.user_id === me) }));
    const delivery = mine ? deliveryOf(m) : null;
    const isPinned = !!snap?.pins.some((p) => p.message_id === m.id);
    const body = (
      <View style={{ gap: 4, flexShrink: 1, alignItems: mine ? 'flex-end' : 'flex-start' }}>
        {!mine && startOfRun ? (
          <T size={11} color={colors.accentLight} style={{ paddingLeft: 6 }} numberOfLines={1}>
            {nameOf(m.sender_id)}
          </T>
        ) : null}
        {m.reply_to ? (
          <View style={{ maxWidth: '100%', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 22, backgroundColor: withAlpha(colors.white, 0.08), borderLeftWidth: 3, borderLeftColor: colors.accent }}>
            <T size={12} weight={700}>
              {quoted ? nameOf(quoted.sender_id) : 'Reply'}
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
            <T size={12} color={colors.textSecondary}>
              {m.pending ? '…' : timeOf(m.created_at)}
              {mine && delivery && !m.pending ? <T size={12} color={delivery === 'read' ? colors.accentLight : colors.textSecondary}>{delivery === 'sent' ? ' ✓' : ' ✓✓'}</T> : null}
            </T>
          }
        >
          {content(m, mine)}
        </SwipeToReply>
        {isNotEncrypted(m) ? <NotEncryptedNote mine={mine} /> : null}
        {grouped.length ? (
          <Row gap={4} style={{ flexWrap: 'wrap', marginTop: -6 }}>
            {grouped.map((g) => (
              <Tap
                key={g.emoji}
                onPress={() => void react(m, g.emoji)}
                accessibilityLabel={`${g.emoji} ${g.n}${g.mineOn ? ', tap to remove yours' : ', tap to add'}`}
                hitSlop={10}
                style={{ height: 24, paddingHorizontal: 8, borderRadius: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: REACTION_BG, borderWidth: 1, borderColor: g.mineOn ? colors.accent : colors.glassBorder }}
              >
                <T size={12}>
                  {g.emoji} {g.n}
                </T>
              </Tap>
            ))}
          </Row>
        ) : null}
        {mine && delivery && (endOfRun || m.pending) ? (
          <T size={11} color={colors.textSecondary} accessibilityLabel={m.pending ? 'Sending' : `${timeOf(m.created_at)}, ${delivery === 'read' ? 'read by everyone' : delivery}`}>
            {isPinned ? '📌 ' : ''}
            {m.pending ? 'Sending…' : `${timeOf(m.created_at)} · ${editedAt(m) ? 'Edited · ' : ''}`}
            {m.pending ? null : (
              <T size={11} color={delivery === 'read' ? colors.accentLight : colors.textSecondary}>
                {delivery === 'sent' ? '✓' : '✓✓'}
              </T>
            )}
          </T>
        ) : !mine && (isPinned || editedAt(m)) ? (
          <T size={11} color={colors.textSecondary} style={{ paddingLeft: 6 }}>
            {[isPinned ? '📌 Pinned' : null, editedAt(m) ? 'Edited' : null].filter(Boolean).join(' · ')}
          </T>
        ) : null}
      </View>
    );
    rows.push(
      <View
        key={m.id}
        onLayout={(e) => rowY.current.set(m.id, e.nativeEvent.layout.y)}
        style={[{ opacity: m.pending ? 0.6 : 1, borderRadius: 16 }, matchSet.has(m.id) ? { backgroundColor: withAlpha(colors.amber, m.id === currentMatch ? 0.18 : 0.06) } : null]}
      >
        {mine ? (
          <View style={{ alignSelf: 'flex-end', maxWidth: '80%' }}>{body}</View>
        ) : (
          <Row gap={8} align="flex-end" style={{ maxWidth: '86%' }}>
            {endOfRun ? <ChatAvatar person={personOf(m.sender_id)} size={30} radius={10} /> : <View style={{ width: 30 }} />}
            {body}
          </Row>
        )}
      </View>,
    );
  });

  flushChanges(null);

  if (typingNames.length) {
    const first = Object.keys(typers).find((u) => byMember.has(u));
    rows.push(
      <Row key="typing" gap={8} align="flex-end" accessibilityRole="text" accessibilityLabel={typingText} accessibilityLiveRegion="polite">
        {first ? <ChatAvatar person={personOf(first)} size={30} radius={10} /> : null}
        <View style={{ height: 36, paddingHorizontal: 14, borderRadius: 18, borderBottomLeftRadius: 6, backgroundColor: BUBBLE_BG, borderWidth: 1, borderColor: BUBBLE_BORDER, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <TypingDots reduce={reduce} />
        </View>
      </Row>,
    );
  }

  const jamLive = !!jam && jam.is_open && jam.listeners > 0;
  const jamTrack = jam?.track ? `${jam.track.title}${jam.track.artist ? ` · ${typeof jam.track.artist === 'string' ? jam.track.artist : jam.track.artist.name}` : ''}` : 'Nothing playing yet';
  const jamStrip = jamLive && jam ? (
    <Tap
      onPress={() => router.push({ pathname: '/group-listening', params: { id: jam.room_id } })}
      accessibilityRole="button"
      accessibilityLabel={`Jam is live, ${jam.listeners} listening. ${jamTrack}. ${jam.joined ? 'Open' : 'Join'}`}
      pressScale={0.98}
      style={{ paddingVertical: 10, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, borderColor: withAlpha(colors.white, 0.14), flexDirection: 'row', alignItems: 'center', gap: 10, overflow: 'hidden' }}
    >
      <Gradient colors={[withAlpha(colors.accent, 0.35), 'rgba(20,20,20,0.6)']} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
      <View style={[{ width: 34, height: 34, borderRadius: 17, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }, shadow.sticker]}>
        <Icon name="headphones" size={18} color={colors.onAccent} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={13} weight={700}>
          Jam is live · {jam.listeners} listening
        </T>
        <T size={12} color={colors.peach} numberOfLines={1}>
          {jamTrack}
        </T>
      </View>
      <View style={{ height: 30, paddingHorizontal: 14, borderRadius: 15, backgroundColor: withAlpha(colors.white, 0.16), justifyContent: 'center' }}>
        <T size={12} weight={700}>
          {jam.joined ? 'Open' : 'Join'}
        </T>
      </View>
    </Tap>
  ) : null;

  const header = searchOpen ? (
    <Row gap={6} style={{ paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: withAlpha(colors.white, 0.08) }}>
      <IconButton icon="close" label="Close search" size={44} onPress={closeSearch} />
      <Row gap={8} style={{ flex: 1, height: 44, borderRadius: 22, paddingHorizontal: 14, backgroundColor: BUBBLE_BG, borderWidth: 1, borderColor: BUBBLE_BORDER }}>
        <Icon name="search" size={16} color={colors.textSecondary} />
        <TextInput
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            setMatchSel(null);
          }}
          autoFocus={!searchParam}
          placeholder="Search in group"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Search in group"
          returnKeyType="search"
          onSubmitEditing={() => stepMatch(-1)}
          style={{ flex: 1, height: 42, color: colors.text, fontFamily: fonts.regular, fontSize: 15 }}
        />
        {q ? (
          <T size={12} color={colors.textSecondary} accessibilityLiveRegion="polite">
            {matches.length ? `${matchAt + 1}/${matches.length}` : '0'}
          </T>
        ) : null}
      </Row>
      <IconButton icon="chevronUp" label="Previous match" size={44} iconSize={20} color={matches.length ? colors.text : colors.textTertiary} onPress={() => stepMatch(-1)} />
      <IconButton icon="chevronDown" label="Next match" size={44} iconSize={20} color={matches.length ? colors.text : colors.textTertiary} onPress={() => stepMatch(1)} />
    </Row>
  ) : (
    <Row gap={10} style={{ paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: withAlpha(colors.white, 0.08) }}>
      <IconButton icon="back" label="Back" size={40} iconSize={22} onPress={() => (router.canGoBack() ? router.back() : router.replace('/messages'))} />
      <Tap
        onPress={() => id && router.push({ pathname: '/group-info', params: { id } })}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${subtitle}. Group info`}
        style={{ flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 }}
      >
        <GroupAvatar avatarUrl={snap?.group.avatar_url} members={others.map((m) => ({ id: m.user_id, display_name: m.display_name, avatar_url: m.avatar_url, username: m.username }))} size={34} title={title} />
        {snap ? (
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={16} weight={600} numberOfLines={1}>
              {title}
            </T>
            <T size={12} color={typingText ? colors.success : colors.textSecondary} numberOfLines={1}>
              {subtitle}
            </T>
          </View>
        ) : (
          <View style={{ flex: 1, gap: 6 }}>
            <SkeletonBlock width="55%" height={14} r={7} />
            <SkeletonBlock width="35%" height={10} r={5} />
          </View>
        )}
      </Tap>
      {snap ? (
        <>
          <IconButton icon="headphones" label={busy === 'jam' ? 'Starting jam' : jamLive ? 'Open the jam' : 'Start jam'} size={40} iconSize={19} bg={withAlpha(colors.white, 0.1)} onPress={() => void startJam()} />
          <IconButton icon={liveCall.call ? 'video' : 'call'} label={liveCall.call ? 'Join live group call' : 'Group call'} size={40} iconSize={19} bg={liveCall.call ? colors.accent : withAlpha(colors.white, 0.1)} onPress={() => setCallOpen(true)} />
        </>
      ) : null}
    </Row>
  );

  const callSheet = (
    <Modal visible={callOpen} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={() => setCallOpen(false)}>
      <Tap onPress={() => setCallOpen(false)} accessibilityLabel="Close" pressScale={1} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.scrim }}>
        <View />
      </Tap>
      <View accessibilityViewIsModal style={{ position: 'absolute', left: 12, right: 12, bottom: 24, maxHeight: '70%', padding: 16, gap: 8, borderRadius: 32, backgroundColor: withAlpha(colors.bgTertiary, 0.97), borderWidth: 1, borderColor: withAlpha(colors.white, 0.14) }}>
        <T size={17} weight={600} accessibilityRole="header">
          Group call
        </T>
        {liveCall.call ? (
          <Tap
            onPress={() => {
              setCallOpen(false);
              router.push({ pathname: '/group-call', params: { id: liveCall.call!.id } });
            }}
            accessibilityRole="button"
            accessibilityLabel={`Join the live call, ${liveCall.people} in it`}
            style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, borderRadius: 20, backgroundColor: colors.accent }}
          >
            <Icon name={liveCall.call.kind === 'video' ? 'video' : 'call'} size={20} color={colors.onAccent} glow={false} />
            <T size={15} weight={700} color={colors.onAccent} style={{ flex: 1 }}>
              {`Join live ${liveCall.call.kind === 'video' ? 'video' : 'voice'} call`}
            </T>
            <T size={13} color={colors.onAccent}>
              {`${liveCall.people} in call`}
            </T>
          </Tap>
        ) : (
          <Row gap={10}>
            {(['audio', 'video'] as const).map((k) => (
              <Tap
                key={k}
                onPress={() => void groupCall(k)}
                accessibilityRole="button"
                accessibilityLabel={`Start group ${k === 'video' ? 'video' : 'voice'} call`}
                style={{ flex: 1, minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 20, backgroundColor: withAlpha(colors.white, 0.1) }}
              >
                <Icon name={k === 'video' ? 'video' : 'call'} size={20} color={colors.text} />
                <T size={15} weight={600}>
                  {busy === `gcall:${k}` ? 'Starting…' : k === 'video' ? 'Video call' : 'Voice call'}
                </T>
              </Tap>
            ))}
          </Row>
        )}
        <T size={13} color={colors.textSecondary} style={{ marginTop: 4 }}>
          Or call one member
        </T>
        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 2 }}>
          {others.map((m) => (
            <Tap key={m.user_id} onPress={() => void call(m)} accessibilityLabel={`Voice call ${m.display_name}`} style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <ChatAvatar person={personOf(m.user_id)} size={40} radius={13} />
              <T size={15} weight={500} numberOfLines={1} style={{ flex: 1 }}>
                {m.display_name}
              </T>
              <T size={13} color={colors.accentLight}>
                {busy === `call:${m.user_id}` ? 'Calling…' : ''}
              </T>
              <Icon name="call" size={20} color={colors.text} />
            </Tap>
          ))}
          {!others.length ? (
            <T size={14} color={colors.textSecondary}>
              No one else is in this group yet.
            </T>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );

  const composer =
    id && snap && !gone ? (
      <View style={{ gap: 8, paddingBottom: 12 }}>
        {liveCall.call ? (
          <Tap
            onPress={() => router.push({ pathname: '/group-call', params: { id: liveCall.call!.id } })}
            accessibilityRole="button"
            accessibilityLabel={`Join the live group call, ${liveCall.people} in it`}
            style={{ marginHorizontal: 12, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, borderRadius: 24, backgroundColor: withAlpha(colors.accent, 0.18), borderWidth: 1, borderColor: withAlpha(colors.accent, 0.5) }}
          >
            <Icon name={liveCall.call.kind === 'video' ? 'video' : 'call'} size={18} color={colors.accentLight} />
            <T size={14} weight={600} style={{ flex: 1 }}>
              {liveCall.people ? `Group call live · ${liveCall.people} in it` : 'Group call live'}
            </T>
            <T size={14} weight={700} color={colors.accentLight}>
              Join
            </T>
          </Tap>
        ) : null}
        {note ? (
          <Tap onPress={() => setNote(null)} style={{ paddingHorizontal: 16 }} accessibilityLabel={`${note}. Tap to dismiss`}>
            <T size={13} color={colors.amber} align="center" accessibilityLiveRegion="polite">
              {note}
            </T>
          </Tap>
        ) : null}
        {editing || replyTo ? (
          <Row style={{ marginHorizontal: 12, paddingVertical: 8, paddingLeft: 12, paddingRight: 4, borderRadius: 16, backgroundColor: BUBBLE_BG, borderLeftWidth: 3, borderLeftColor: colors.accent }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T size={12} weight={700}>
                {editing ? 'Editing message' : `Replying to ${replyTo ? (replyTo.sender_id === me ? 'yourself' : nameOf(replyTo.sender_id)) : ''}`}
              </T>
              <T size={12} color={colors.textSecondary} numberOfLines={1}>
                {editing ? editing.body : replyTo ? messagePreview(replyTo) : ''}
              </T>
            </View>
            <IconButton icon="close" label={editing ? 'Cancel editing' : 'Cancel reply'} size={44} iconSize={18} color={colors.textSecondary} onPress={() => (editing ? cancelEdit() : chatBus.setReply(id, undefined))} />
          </Row>
        ) : null}
        <Row gap={8} style={{ paddingHorizontal: 12 }}>
          {editing ? null : <IconButton icon="plus" label="Attach" size={46} iconSize={22} bg={withAlpha(colors.white, 0.1)} onPress={() => router.push({ pathname: '/chat-attach', params: { id } })} />}
          <Row gap={8} style={{ flex: 1, height: 48, borderRadius: 32, backgroundColor: BUBBLE_BG, borderWidth: 1, borderColor: BUBBLE_BORDER, paddingLeft: 16, paddingRight: 8 }}>
            <TextInput
              ref={composerRef}
              value={draft}
              onChangeText={onDraft}
              onSubmitEditing={send}
              returnKeyType={editing ? 'done' : 'send'}
              placeholder={editing ? 'Edit message' : 'Message the crew'}
              placeholderTextColor={colors.textSecondary}
              accessibilityLabel={editing ? 'Edit message' : 'Message the crew'}
              maxLength={2000}
              {...picker.inputProps}
              onFocus={() => {
                picker.onInputFocus();
                setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 250);
              }}
              style={{ flex: 1, height: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 15 }}
            />
            <IconButton icon="faceId" label={picker.open ? 'Show keyboard' : 'Emoji'} size={40} iconSize={20} color={picker.open ? colors.accentLight : colors.textSecondary} onPress={picker.toggle} />
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
      </View>
    ) : undefined;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior="padding">
      <Screen top={4} gap={10} scroll={false} backdrop={{ pattern: 'none', mesh: 'rose', orbs: true }} footer={composer} footerInset={!keyboardOpen}>
        {header}
        {id && snap && !gone ? (
          <PinnedBar
            text={pinned && !searchOpen ? messagePreview(pinned) : null}
            index={pinAt}
            count={pins.length}
            onPress={cyclePin}
            onLongPress={() => router.push({ pathname: '/chat-info', params: { id, section: 'pinned', group: '1' } })}
          />
        ) : null}
        {callSheet}
        {jamStrip}
        {!id ? (
          <EmptyState icon="users" title="No group selected" body="Pick a group from your messages." action="Open messages" onAction={() => router.replace('/messages')} />
        ) : !me ? (
          <EmptyState icon="mail" title="Sign in to chat" body="Messages are tied to your Zoyra account." action="Sign in" onAction={() => router.push('/login')} />
        ) : gone ? (
          <EmptyState icon="users" title="You’re no longer in this group" body="Taking you back to your messages." action="Back to messages" onAction={() => router.replace('/messages')} />
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
            onLayout={() => {
              if (!searchOpen && !starJump) scroll.current?.scrollToEnd({ animated: false });
            }}
            onContentSizeChange={() => {
              if (!searchOpen && !starJump) scroll.current?.scrollToEnd({ animated: true });
            }}
          >
            <E2EEChatNotice />
            {visible.length === 0 ? <EmptyState icon="users" title={`Say hi to ${title}`} body="Send a message, a poll, a voice note or start a jam." /> : rows}
          </ScrollView>
          </View>
        )}
      </Screen>
      <PhotoViewer
        photos={photos}
        index={viewerAt}
        onClose={() => setViewerAt(null)}
        onIndexChange={setViewerAt}
        onReply={(p) => {
          const m = byId.get(p.id);
          setViewerAt(null);
          if (m && id) chatBus.setReply(id, m);
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
