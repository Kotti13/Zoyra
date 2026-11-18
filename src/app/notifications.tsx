import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, View } from 'react-native';

import { artFor, Avatar, Button, Cover, decelerate, EmptyState, ErrorState, Glass, Icon, IconButton, Loading, Row, Screen, T, Tap, useReduceMotion } from '../components';
import { formatDuration } from '../lib/catalog';
import { describeNotification, notificationHref, openPath, type NotificationRow } from '../lib/push';
import { friendlySocialError, useBlocks } from '../lib/social';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { isLocalTrack, usePlaybackProgress, usePlayerPick } from '../state/player';
import { colors, motion, radius, withAlpha } from '../theme/tokens';

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function when(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The other person behind a social notification (follow, message, dedication, family join, jam join), if any. */
function actorOf(n: NotificationRow): { id: string; name: string } | null {
  const p = n.payload ?? {};
  // Calls ('call' / 'call_missed') have an actor but never stack: each stays its own card (see groupKey).
  if (!['follow', 'message', 'message_request', 'dedication', 'family_join', 'room_join', 'live', 'call', 'call_missed'].includes(n.kind)) return null;
  const id = str(p.follower_id) ?? str(p.sender_id) ?? str(p.caller_id) ?? str(p.actor_id) ?? str(p.user_id);
  return id ? { id, name: str(p.actor_name) ?? 'this person' } : null;
}

/* ------------------------------------------------------------------ grouping */

type Actor = { id: string; name: string };

/** One line inside an expanded group (a single message, follow, dedication…). */
type GroupItem = { key: string; text: string; at: string | null; unread: boolean };

/** Notifications collapsed into one card: a conversation's messages, or repeats of one kind from one person. */
type NotifGroup = {
  key: string;
  kind: string;
  /** Newest first. */
  rows: NotificationRow[];
  latest: NotificationRow;
  actor: Actor | null;
  /** Unread items (a grouped message row counts every message it holds). */
  unread: number;
  total: number;
  /** Newest first. */
  items: GroupItem[];
};

/** Kinds that stack per actor; `message` stacks per conversation. */
const STACKABLE = new Set(['follow', 'dedication', 'room_join']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Messages a row stands for (`payload.count`, set by notify_user when it folds a burst into one row). */
function rowCount(n: NotificationRow) {
  if (n.kind !== 'message') return 1;
  const c = n.payload?.count;
  return typeof c === 'number' && Number.isFinite(c) && c > 1 ? Math.floor(c) : 1;
}

function groupKey(n: NotificationRow, actor: Actor | null) {
  if (n.kind === 'message') {
    const conv = str(n.payload?.conversation_id) ?? actor?.id;
    if (conv) return `message:${conv}`;
  }
  if (STACKABLE.has(n.kind) && actor) return `${n.kind}:${actor.id}`;
  return `one:${n.id}`;
}

/** Lines a row contributes to its group, newest first. */
function itemsOf(n: NotificationRow): GroupItem[] {
  const d = describeNotification(n.kind, n.payload);
  if (n.kind === 'message') {
    const previews = n.payload?.previews;
    if (Array.isArray(previews) && previews.length > 0) {
      const out: GroupItem[] = [];
      previews.forEach((e: unknown, i) => {
        if (!isRecord(e)) return;
        const text = str(e.body);
        if (!text) return;
        out.push({ key: str(e.message_id) ?? `${n.id}:${i}`, text, at: str(e.at) ?? null, unread: !n.read });
      });
      if (out.length) return out.reverse();
    }
    return [{ key: str(n.payload?.message_id) ?? n.id, text: d.body ?? d.title, at: n.created_at, unread: !n.read }];
  }
  return [{ key: n.id, text: d.body ? `${d.title} · ${d.body}` : d.title, at: n.created_at, unread: !n.read }];
}

function groupNotifications(rows: NotificationRow[]): NotifGroup[] {
  const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const byKey = new Map<string, NotifGroup>();
  const order: NotifGroup[] = [];
  for (const n of sorted) {
    const actor = actorOf(n);
    const key = groupKey(n, actor);
    let g = byKey.get(key);
    if (!g) {
      g = { key, kind: n.kind, rows: [], latest: n, actor, unread: 0, total: 0, items: [] };
      byKey.set(key, g);
      order.push(g);
    }
    g.rows.push(n);
    const c = rowCount(n);
    g.total += c;
    if (!n.read) g.unread += c;
    const seen = new Set(g.items.map((x) => x.key));
    for (const it of itemsOf(n)) if (!seen.has(it.key)) g.items.push(it);
  }
  return order;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Latest messages shown inline on a conversation's card. */
const MESSAGE_LINES = 3;

/** Ticking clock for the header (re-renders every 15 s, aligned closely enough to the minute). */
function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/* ------------------------------------------------------------------ now playing */

function NowPlayingCard() {
  const { track, playing, buffering, toggle, next, previous, shuffle, setShuffle } = usePlayerPick('track', 'playing', 'buffering', 'shuffle');
  const { isLiked, toggleLike } = useLibrary();
  const { position, duration, progress } = usePlaybackProgress();
  const [likeError, setLikeError] = useState<string | null>(null);
  if (!track) return null;
  const local = isLocalTrack(track);
  const liked = !local && isLiked(track.id);

  const like = () => {
    setLikeError(null);
    toggleLike(track).catch((e: unknown) => setLikeError(e instanceof Error ? e.message : 'Could not update your likes'));
  };

  return (
    <Glass padding={16} strong style={{ gap: 14 }}>
      <View style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: withAlpha(colors.accent, 0.14) }} pointerEvents="none" />
      <Tap href="/player" accessibilityLabel={`Now playing: ${track.title} by ${track.artist.name}. Open the player`}>
        <Row gap={12}>
          <Cover artwork={track.artwork} id={track.id} size={64} radius={radius.lg} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T size={11} weight={600} tracking={1.2} color={colors.accentLight}>
              NOW PLAYING
            </T>
            <T size={16} weight={600} numberOfLines={1}>
              {track.title}
            </T>
            <T size={13} color={colors.textSecondary} numberOfLines={1}>
              {buffering ? 'Loading…' : track.artist.name}
            </T>
          </View>
        </Row>
      </Tap>

      <View style={{ gap: 6 }} accessible accessibilityRole="progressbar" accessibilityLabel="Playback position" accessibilityValue={{ min: 0, max: Math.round(duration), now: Math.round(position) }}>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.track, overflow: 'hidden' }}>
          <View style={{ height: 4, width: `${progress * 100}%`, backgroundColor: colors.accent }} />
        </View>
        <Row style={{ justifyContent: 'space-between' }}>
          <T mono size={11} color={colors.textSecondary}>
            {formatDuration(position)}
          </T>
          <T mono size={11} color={colors.textSecondary}>
            {duration > 0 ? formatDuration(duration) : formatDuration(track.duration)}
          </T>
        </Row>
      </View>

      <Row style={{ justifyContent: 'space-between', paddingHorizontal: 6 }}>
        <IconButton icon="shuffle" label={shuffle ? 'Turn shuffle off' : 'Turn shuffle on'} color={shuffle ? colors.accentLight : colors.text} onPress={() => setShuffle(!shuffle)} />
        <IconButton icon="prev" label="Previous track" size={48} bg={colors.chipGhost} onPress={previous} />
        <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Pause' : 'Play'} size={64} iconSize={28} bg={colors.accent} color={colors.onAccent} onPress={toggle} />
        <IconButton icon="next" label="Next track" size={48} bg={colors.chipGhost} onPress={next} />
        {local ? (
          <View style={{ width: 44 }} />
        ) : (
          <IconButton icon="heart" label={liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'} filled={liked} color={liked ? colors.like : colors.text} onPress={like} />
        )}
      </Row>
      {likeError ? (
        <T size={12} color={colors.error} align="center">
          {likeError}
        </T>
      ) : null}
    </Glass>
  );
}

/* ------------------------------------------------------------------ notification card */

function NotificationCard({
  n,
  me,
  onOpen,
  onDismiss,
  onBlock,
}: {
  n: NotificationRow;
  me: string | undefined;
  onOpen: () => void;
  onDismiss: () => void;
  onBlock: (a: { id: string; name: string }) => void;
}) {
  const d = describeNotification(n.kind, n.payload);
  const actor = actorOf(n);
  return (
    <Glass padding={14}>
      <Row gap={12} align="flex-start">
        <Tap
          onPress={onOpen}
          onLongPress={onDismiss}
          delayLongPress={450}
          accessibilityLabel={`${d.section}, ${when(n.created_at)}${n.read ? '' : ', unread'}. ${d.title}${d.body ? `. ${d.body}` : ''}`}
          accessibilityHint="Opens the notification. Long-press to dismiss."
          accessibilityActions={[{ name: 'activate' }, { name: 'dismiss', label: 'Dismiss' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'dismiss') onDismiss();
            else onOpen();
          }}
          style={{ flex: 1, minWidth: 0 }}
        >
          <Row gap={12} align="flex-start">
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: d.color, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={d.icon} size={20} color={d.iconColor} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T size={11} color={colors.textSecondary}>
                  {d.section}
                </T>
                <Row gap={6}>
                  <T size={11} color={colors.textSecondary}>
                    {when(n.created_at)}
                  </T>
                  {n.read ? null : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent }} />}
                </Row>
              </Row>
              <T size={14} weight={600} color={n.read ? colors.textSecondary : colors.text}>
                {d.title}
              </T>
              {d.body ? (
                <T size={13} color={colors.textSecondary} lineHeight={18}>
                  {d.body}
                </T>
              ) : null}
            </View>
          </Row>
        </Tap>
        <View>
          <IconButton icon="close" label={`Dismiss: ${d.title}`} size={32} iconSize={16} color={colors.textSecondary} onPress={onDismiss} />
          {actor && actor.id !== me ? <IconButton icon="more" label={`Block ${actor.name}`} size={32} iconSize={16} color={colors.textSecondary} onPress={() => onBlock(actor)} /> : null}
        </View>
      </Row>
    </Glass>
  );
}

/* ------------------------------------------------------------------ grouped card */

/** 0 → 1 progress for an expand/collapse; jumps straight there with Reduce Motion on. */
function useExpandProgress(open: boolean) {
  const reduce = useReduceMotion();
  const [progress] = useState(() => new Animated.Value(open ? 1 : 0));
  useEffect(() => {
    const to = open ? 1 : 0;
    if (reduce) {
      progress.setValue(to);
      return;
    }
    // Height can't run on the native driver, so the whole expand runs on JS (short, one card at a time).
    const a = Animated.timing(progress, { toValue: to, duration: open ? motion.normal : motion.fast, easing: decelerate, useNativeDriver: false });
    a.start();
    return () => a.stop();
  }, [open, reduce, progress]);
  return progress;
}

/** Animates its children's natural height between 0 and full; hidden from touch and screen readers when closed. */
function Collapsible({ open, progress, children }: { open: boolean; progress: Animated.Value; children: ReactNode }) {
  const [height, setHeight] = useState(0);
  return (
    <Animated.View
      style={{ overflow: 'hidden', height: progress.interpolate({ inputRange: [0, 1], outputRange: [0, height] }), opacity: progress }}
      pointerEvents={open ? 'auto' : 'none'}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
    >
      {/* Absolutely positioned so it always lays out at its natural height, whatever the animated box is. */}
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0 }} onLayout={(e) => setHeight(Math.ceil(e.nativeEvent.layout.height))}>
        {children}
      </View>
    </Animated.View>
  );
}

function ActorAvatar({ actor, avatar, fallback }: { actor: Actor | null; avatar: string | null | undefined; fallback: ReturnType<typeof describeNotification> }) {
  if (actor && avatar) return <Cover uri={avatar} id={actor.id} size={40} radius={20} />;
  if (actor) return <Avatar initial={(actor.name.trim().charAt(0) || '?').toUpperCase()} art={artFor(actor.id)} size={40} />;
  return (
    <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: fallback.color, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={fallback.icon} size={20} color={fallback.iconColor} />
    </View>
  );
}

/**
 * A conversation's stacked messages, styled like the expanded message push (PushExpanded design):
 * app label row, sender, then the latest messages as chat bubbles. Tapping anywhere opens the chat.
 */
function MessageCard({
  g,
  me,
  avatar,
  onOpen,
  onDismiss,
  onBlock,
}: {
  g: NotifGroup;
  me: string | undefined;
  avatar: string | null | undefined;
  onOpen: () => void;
  onDismiss: () => void;
  onBlock: (a: Actor) => void;
}) {
  const d = describeNotification(g.latest.kind, g.latest.payload);
  const actor = g.actor;
  const name = actor?.name ?? d.title;
  const unread = g.unread > 0;
  const count = unread ? plural(g.unread, 'new message') : plural(g.total, 'message');
  // Newest last, like the chat itself.
  const recent = g.items.slice(0, MESSAGE_LINES).reverse();
  const earlier = Math.max(0, g.total - recent.length);
  const latest = recent[recent.length - 1]?.text ?? d.body ?? d.title;

  return (
    <Tap
      onPress={onOpen}
      onLongPress={onDismiss}
      delayLongPress={450}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${count}, ${when(g.latest.created_at)}. Latest: ${latest}`}
      accessibilityHint="Opens the chat. Long-press to dismiss."
      accessibilityActions={[{ name: 'activate' }, { name: 'dismiss', label: 'Dismiss' }]}
      onAccessibilityAction={(e) => (e.nativeEvent.actionName === 'dismiss' ? onDismiss() : onOpen())}
    >
      <Glass padding={14} style={{ gap: 12 }}>
        <Row gap={6}>
          <View style={{ width: 16, height: 16, borderRadius: 5, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="mail" size={10} color={colors.onAccent} />
          </View>
          <T size={11} color={colors.textSecondary} style={{ flex: 1, letterSpacing: 0.6 }}>
            ZOYRA · MESSAGES
          </T>
          <T size={11} color={colors.textSecondary}>
            {when(g.latest.created_at)}
          </T>
          {unread ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent }} /> : null}
        </Row>

        <Row gap={12}>
          <ActorAvatar actor={actor} avatar={avatar} fallback={d} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={16} weight={700} numberOfLines={1}>
              {name}
            </T>
            <T size={12} weight={600} color={unread ? colors.accentLight : colors.textSecondary} numberOfLines={1}>
              {count}
            </T>
          </View>
          <IconButton icon="close" label={`Dismiss messages from ${name}`} size={32} iconSize={16} bg={colors.chipGhost} color={colors.textSecondary} onPress={onDismiss} />
          {actor && actor.id !== me ? <IconButton icon="more" label={`Block ${actor.name}`} size={32} iconSize={16} color={colors.textSecondary} onPress={() => onBlock(actor)} /> : null}
        </Row>

        <View style={{ gap: 8 }}>
          {earlier > 0 ? (
            <T size={11} color={colors.textSecondary}>
              + {plural(earlier, 'earlier message')}
            </T>
          ) : null}
          {recent.map((it) => (
            <View
              key={it.key}
              style={{
                alignSelf: 'flex-start',
                maxWidth: '85%',
                paddingHorizontal: 13,
                paddingVertical: 9,
                borderRadius: 18,
                borderBottomLeftRadius: 5,
                backgroundColor: colors.chipGhost,
                borderWidth: it.unread ? 1 : 0,
                borderColor: withAlpha(colors.accent, 0.45),
              }}
            >
              <T size={14} lineHeight={19} color={it.unread ? colors.text : colors.textSecondary} numberOfLines={3}>
                {it.text}
              </T>
            </View>
          ))}
        </View>
      </Glass>
    </Tap>
  );
}

function GroupCard({
  g,
  me,
  avatar,
  onOpen,
  onDismiss,
  onBlock,
}: {
  g: NotifGroup;
  me: string | undefined;
  avatar: string | null | undefined;
  onOpen: () => void;
  onDismiss: () => void;
  onBlock: (a: Actor) => void;
}) {
  const [open, setOpen] = useState(false);
  const progress = useExpandProgress(open);
  const d = describeNotification(g.latest.kind, g.latest.payload);
  const isMessage = g.kind === 'message';
  const actor = g.actor;
  const name = actor?.name ?? d.title;
  const count = isMessage
    ? g.unread > 0
      ? plural(g.unread, 'new message')
      : plural(g.total, 'message')
    : g.unread > 0
      ? `${plural(g.rows.length, 'notification')} · ${g.unread} new`
      : plural(g.rows.length, 'notification');
  const preview = isMessage ? (d.body ?? d.title) : d.body ? `${d.title} · ${d.body}` : d.title;
  const hidden = g.total - g.items.length;
  const chevron = progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  const toggle = () => setOpen((v) => !v);

  return (
    <Glass padding={14} style={{ gap: 0 }}>
      <Row gap={12} align="flex-start">
        <Tap
          onPress={toggle}
          onLongPress={onDismiss}
          delayLongPress={450}
          pressScale={1}
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${name}, ${count}, ${when(g.latest.created_at)}. Latest: ${preview}`}
          accessibilityHint={open ? 'Collapses the group. Long-press to dismiss it.' : 'Shows every notification in the group. Long-press to dismiss it.'}
          accessibilityActions={[{ name: 'activate' }, { name: 'dismiss', label: 'Dismiss group' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'dismiss') onDismiss();
            else toggle();
          }}
          style={{ flex: 1, minWidth: 0 }}
        >
          <Row gap={12} align="flex-start">
            <ActorAvatar actor={g.actor} avatar={avatar} fallback={d} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T size={11} color={colors.textSecondary}>
                  {d.section}
                </T>
                <Row gap={6}>
                  <T size={11} color={colors.textSecondary}>
                    {when(g.latest.created_at)}
                  </T>
                  {g.unread > 0 ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent }} /> : null}
                </Row>
              </Row>
              <Row gap={6}>
                <T size={14} weight={600} numberOfLines={1} color={g.unread > 0 ? colors.text : colors.textSecondary} style={{ flexShrink: 1 }}>
                  {name}
                </T>
                <T size={12} weight={600} color={g.unread > 0 ? colors.accentLight : colors.textSecondary} numberOfLines={1}>
                  · {count}
                </T>
              </Row>
              <Row gap={6}>
                <T size={13} color={colors.textSecondary} lineHeight={18} numberOfLines={open ? undefined : 2} style={{ flex: 1 }}>
                  {preview}
                </T>
                <Animated.View style={{ transform: [{ rotate: chevron }] }}>
                  <Icon name="chevronDown" size={16} color={colors.textSecondary} />
                </Animated.View>
              </Row>
            </View>
          </Row>
        </Tap>
        <View>
          <IconButton icon="close" label={`Dismiss ${name} group`} size={32} iconSize={16} color={colors.textSecondary} onPress={onDismiss} />
          {actor && actor.id !== me ? <IconButton icon="more" label={`Block ${actor.name}`} size={32} iconSize={16} color={colors.textSecondary} onPress={() => onBlock(actor)} /> : null}
        </View>
      </Row>

      <Collapsible open={open} progress={progress}>
        <View style={{ paddingTop: 12, gap: 10 }}>
          {/* Thread rail under the avatar. */}
          <View style={{ marginLeft: 19, paddingLeft: 21, borderLeftWidth: 2, borderLeftColor: colors.track, gap: 10 }}>
            {g.items.map((it) => (
              <Row key={it.key} gap={8} align="flex-start">
                <View style={{ width: 6, height: 6, borderRadius: 3, marginTop: 6, backgroundColor: it.unread ? colors.accent : colors.track }} />
                <T size={13} lineHeight={18} color={it.unread ? colors.text : colors.textSecondary} numberOfLines={3} style={{ flex: 1 }}>
                  {it.text}
                </T>
                {it.at ? (
                  <T size={11} color={colors.textSecondary}>
                    {when(it.at)}
                  </T>
                ) : null}
              </Row>
            ))}
            {hidden > 0 ? (
              <T size={12} color={colors.textSecondary}>
                + {plural(hidden, isMessage ? 'earlier message' : 'earlier notification')}
              </T>
            ) : null}
          </View>
          <Row style={{ justifyContent: 'flex-end' }}>
            <Button label={isMessage ? 'Open chat' : 'Open'} icon={isMessage ? 'mail' : undefined} height={40} onPress={onOpen} />
          </Row>
        </View>
      </Collapsible>
    </Glass>
  );
}

/* ------------------------------------------------------------------ screen */

export default function NotificationCenter() {
  const { user } = useAuth();
  const me = user?.id;
  const now = useNow();
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!me) return;
      if (!quiet) setLoading(true);
      setError(null);
      const { data, error: e } = await supabase.from('notifications').select('id, user_id, kind, payload, read, created_at').eq('user_id', me).order('created_at', { ascending: false }).limit(100);
      if (e) setError(e.message);
      else setRows((data ?? []) as NotificationRow[]);
      setLoading(false);
    },
    [me],
  );

  useFocusEffect(
    useCallback(() => {
      void load(true);
    }, [load]),
  );

  useEffect(() => {
    if (!me) return;
    const ch = supabase
      .channel(`notif-inbox:${me}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${me}` }, (p) => {
        const row = p.new as NotificationRow;
        setRows((list) => (list.some((x) => x.id === row.id) ? list : [row, ...list]));
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'notifications', filter: `user_id=eq.${me}` }, (p) => {
        // notify_user folds a burst of chat messages into one row by UPDATE (count, previews, created_at bump).
        const row = p.new as NotificationRow;
        setRows((list) => (list.some((x) => x.id === row.id) ? list.map((x) => (x.id === row.id ? row : x)) : [row, ...list]));
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'notifications' }, (p) => {
        const id = (p.old as { id?: string }).id;
        if (id) setRows((list) => list.filter((x) => x.id !== id));
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [me]);

  const open = async (n: NotificationRow) => {
    if (!n.read) {
      setRows((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      const { error: e } = await supabase.from('notifications').update({ read: true }).eq('id', n.id);
      if (e) setNote(e.message);
    }
    const path = notificationHref(n.kind, n.payload ?? {});
    if (path) openPath(path);
  };

  const dismiss = async (n: NotificationRow) => {
    setNote(null);
    setRows((list) => list.filter((x) => x.id !== n.id));
    const { error: e } = await supabase.from('notifications').delete().eq('id', n.id);
    if (e) {
      setRows((list) => (list.some((x) => x.id === n.id) ? list : [...list, n].sort((a, b) => b.created_at.localeCompare(a.created_at))));
      setNote(e.message);
    }
  };

  /** Opens a group's target and marks every row in it read. */
  const openGroup = async (g: NotifGroup) => {
    setNote(null);
    const ids = g.rows.filter((r) => !r.read).map((r) => r.id);
    if (ids.length) {
      const set = new Set(ids);
      setRows((list) => list.map((x) => (set.has(x.id) ? { ...x, read: true } : x)));
      const { error: e } = await supabase.from('notifications').update({ read: true }).in('id', ids);
      if (e) setNote(e.message);
    }
    const path = notificationHref(g.latest.kind, g.latest.payload ?? {});
    if (path) openPath(path);
  };

  const dismissGroup = async (g: NotifGroup) => {
    setNote(null);
    const ids = new Set(g.rows.map((r) => r.id));
    setRows((list) => list.filter((x) => !ids.has(x.id)));
    const { error: e } = await supabase.from('notifications').delete().in('id', [...ids]);
    if (e) {
      setRows((list) => [...list.filter((x) => !ids.has(x.id)), ...g.rows]);
      setNote(e.message);
    }
  };

  const { blocked, block } = useBlocks(me);
  const [info, setInfo] = useState<string | null>(null);
  // Notifications from people you blocked are hidden.
  const shown = useMemo(
    () =>
      rows.filter((r) => {
        const a = actorOf(r);
        return !a || !blocked.has(a.id);
      }),
    [rows, blocked],
  );

  const blockActor = async (a: { id: string; name: string }) => {
    setNote(null);
    setInfo(null);
    try {
      if (await block(a.id, a.name)) setInfo(`Blocked ${a.name}. Unblock them in Privacy → Blocked users.`);
    } catch (e) {
      setNote(friendlySocialError(e, 'Could not block'));
    }
  };

  const unread = shown.filter((r) => !r.read).length;
  const groups = useMemo(() => groupNotifications(shown), [shown]);
  const unreadItems = groups.reduce((sum, g) => sum + g.unread, 0);

  // Sender photos for grouped cards (profiles are readable by any signed-in user).
  const actorKey = [...new Set(groups.filter((g) => g.rows.length > 1 || g.total > 1).flatMap((g) => (g.actor ? [g.actor.id] : [])))].sort().join(',');
  const [avatars, setAvatars] = useState<Record<string, string | null>>({});
  useEffect(() => {
    if (!actorKey) return;
    let alive = true;
    supabase
      .from('profiles')
      .select('id, avatar_url')
      .in('id', actorKey.split(','))
      .then(({ data }) => {
        if (!alive || !data) return;
        setAvatars((prev) => {
          const next = { ...prev };
          for (const p of data as { id: string; avatar_url: string | null }[]) next[p.id] = p.avatar_url;
          return next;
        });
      });
    return () => {
      alive = false;
    };
  }, [actorKey]);

  const markAll = async () => {
    if (!me || !unread || busy) return;
    setBusy(true);
    setNote(null);
    const before = rows;
    setRows((list) => list.map((x) => ({ ...x, read: true })));
    const { error: e } = await supabase.from('notifications').update({ read: true }).eq('user_id', me).eq('read', false);
    setBusy(false);
    if (e) {
      setRows(before);
      setNote(e.message);
    }
  };

  /** Marks everything read, then deletes it (after the inline confirm). */
  const clearAll = async () => {
    if (!me || busy) return;
    setBusy(true);
    setNote(null);
    const before = rows;
    const { error: readErr } = await supabase.from('notifications').update({ read: true }).eq('user_id', me).eq('read', false);
    if (readErr) {
      setBusy(false);
      setNote(readErr.message);
      return;
    }
    setRows([]);
    const { error: e } = await supabase.from('notifications').delete().eq('user_id', me);
    setBusy(false);
    setConfirmClear(false);
    if (e) {
      setRows(before.map((x) => ({ ...x, read: true })));
      setNote(e.message);
    }
  };

  const date = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  return (
    <Screen onRefresh={me ? () => load(true) : undefined}
      top={4}
      gap={16}
      backdrop={{
        pattern: 'none',
        mesh: 'none',
        glows: [
          { x: 0.1, y: 0, color: colors.accent, opacity: 0.4 },
          { x: 1, y: 0.35, color: colors.orange, opacity: 0.18 },
        ],
      }}
    >
      <Row style={{ justifyContent: 'space-between' }}>
        <IconButton icon="back" label="Back" size={40} iconSize={20} bg={colors.chipGhost} href="back" />
        <IconButton icon="sliders" label="Notification settings" size={40} iconSize={20} bg={colors.chipGhost} href="/notif-settings" />
      </Row>

      <View accessible accessibilityRole="header" accessibilityLabel={`Notification center. ${date}, ${time}`}>
        <T size={13} color={colors.textSecondary}>
          {date}
        </T>
        <T size={52} weight={200} tracking={-2} lineHeight={56}>
          {time}
        </T>
      </View>

      <NowPlayingCard />

      <Row style={{ justifyContent: 'space-between' }}>
        <T size={18} weight={500} accessibilityRole="header">
          Notifications{unreadItems > 0 ? ` · ${unreadItems} new` : ''}
        </T>
        {shown.length > 0 && !confirmClear ? (
          <Row gap={4}>
            {unread > 0 ? (
              <Tap onPress={() => void markAll()} accessibilityLabel="Mark all notifications read" style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 }}>
                <T size={13} weight={600} color={colors.textSecondary}>
                  {busy ? 'Marking…' : 'Mark read'}
                </T>
              </Tap>
            ) : null}
            <Tap onPress={() => setConfirmClear(true)} accessibilityLabel="Clear all notifications" style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 }}>
              <T size={13} weight={600} color={colors.accentLight}>
                Clear all
              </T>
            </Tap>
          </Row>
        ) : null}
      </Row>

      {confirmClear ? (
        <Glass padding={14} style={{ gap: 10 }}>
          <T size={14}>
            Delete all {rows.length} {rows.length === 1 ? 'notification' : 'notifications'}? This can’t be undone.
          </T>
          <Row style={{ justifyContent: 'flex-end' }} gap={8}>
            <Tap onPress={() => setConfirmClear(false)} disabled={busy} accessibilityLabel="Cancel clearing" style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 }}>
              <T size={14} weight={600} color={colors.textSecondary}>
                Cancel
              </T>
            </Tap>
            <Tap
              onPress={() => void clearAll()}
              disabled={busy}
              accessibilityLabel="Confirm clear all notifications"
              style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: colors.accent }}
            >
              {busy ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <T size={14} weight={600} color={colors.onAccent}>
                  Clear all
                </T>
              )}
            </Tap>
          </Row>
        </Glass>
      ) : null}

      {note ? (
        <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
          {note}
        </T>
      ) : null}

      {info ? (
        <T size={13} color={colors.textSecondary} align="center" accessibilityLiveRegion="polite">
          {info}
        </T>
      ) : null}

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : shown.length === 0 ? (
        <EmptyState icon="clock" title="You're all caught up" body="Live sessions, new releases from artists you follow, jam joins, messages and invites show up here." />
      ) : (
        <View style={{ gap: 10 }}>
          {groups.map((g) =>
            g.rows.length === 1 && g.total === 1 ? (
              <NotificationCard key={g.key} n={g.latest} me={me} onOpen={() => void open(g.latest)} onDismiss={() => void dismiss(g.latest)} onBlock={(a) => void blockActor(a)} />
            ) : g.kind === 'message' ? (
              <MessageCard
                key={g.key}
                g={g}
                me={me}
                avatar={g.actor ? avatars[g.actor.id] : undefined}
                onOpen={() => void openGroup(g)}
                onDismiss={() => void dismissGroup(g)}
                onBlock={(a) => void blockActor(a)}
              />
            ) : (
              <GroupCard
                key={g.key}
                g={g}
                me={me}
                avatar={g.actor ? avatars[g.actor.id] : undefined}
                onOpen={() => void openGroup(g)}
                onDismiss={() => void dismissGroup(g)}
                onBlock={(a) => void blockActor(a)}
              />
            ),
          )}
          <T size={12} color={colors.textSecondary} align="center">
            Tap a group to expand it. Long-press a notification to dismiss it.
          </T>
        </View>
      )}
    </Screen>
  );
}
