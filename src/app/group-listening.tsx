import type { RealtimeChannel } from '@supabase/supabase-js';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Share, TextInput, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import {
  Button,
  Cover,
  EmptyState,
  ErrorState,
  Glass,
  Icon,
  IconButton,
  ListRow,
  Loading,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  SeekBar,
  Spacer,
  Sticker,
  T,
  Tap,
  TextField,
  Toast,
  go,
  useAsync,
  useDebounced,
} from '../components';
import type { IconName } from '../components';
import { catalog, formatDuration, type CatalogTrack } from '../lib/catalog';
import { privateChannel } from '../lib/realtime';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { usePlaybackProgress, usePlayer } from '../state/player';
import { colors, fonts } from '../theme/tokens';

/* ================================================================== shared room logic (also used by /party) */

export type RoomKind = 'group' | 'party';
type Person = { id: string; display_name: string; avatar_url: string | null };
export type RoomRow = {
  id: string;
  host_id: string;
  kind: RoomKind;
  name: string;
  code: string;
  track: CatalogTrack | null;
  position_ms: number;
  is_playing: boolean;
  skip_votes: number;
  is_open: boolean;
  updated_at: string;
};
export type RoomMember = { user_id: string; profiles: Person | null };
export type QueueRow = { id: string; track: CatalogTrack; added_by: string | null; votes: number; created_at: string; profiles: { display_name: string } | null };
type FloatingReaction = { key: string; icon: IconName; color: string; x: number };
type ChatLine = { key: string; user_id: string; text: string; created_at: string; pending?: boolean };
type RoomMessageRow = { id: string; room_id: string; user_id: string; body: string; created_at: string };

const toLine = (m: RoomMessageRow): ChatLine => ({ key: m.id, user_id: m.user_id, text: m.body, created_at: m.created_at });

export const REACTIONS: { icon: IconName; label: string; color: string; filled?: boolean }[] = [
  { icon: 'heart', label: 'React with heart', color: colors.like },
  { icon: 'flame', label: 'React with flame', color: colors.amber, filled: false },
  { icon: 'star', label: 'React with star', color: colors.accentLight },
  { icon: 'bolt', label: 'React with bolt', color: colors.amber },
];

const routeFor = (kind: RoomKind) => (kind === 'party' ? '/party' : '/group-listening');

/** Deep link that joins a room by its share code (works for anyone, unlike the id link). */
export const roomJoinLink = (kind: RoomKind, code: string) => `zoyra:/${routeFor(kind)}?code=${encodeURIComponent(code)}`;

export function useRoom(id: string | undefined) {
  const { user } = useAuth();
  const me = user?.id;
  const player = usePlayer();
  const { position, duration, progress } = usePlaybackProgress();
  const [room, setRoom] = useState<RoomRow | null>(null);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [votedTrack, setVotedTrack] = useState<string | null>(null);
  const [votedQueue, setVotedQueue] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const channel = useRef<RealtimeChannel | null>(null);
  const posRef = useRef(0);
  posRef.current = position;

  const isHost = !!room && room.host_id === me;

  const loadMembers = useCallback(async () => {
    if (!id) return;
    const { data } = await supabase.from('room_members').select('user_id, profiles(id, display_name, avatar_url)').eq('room_id', id).order('joined_at');
    if (data) setMembers(data as unknown as RoomMember[]);
  }, [id]);

  const loadQueue = useCallback(async () => {
    if (!id) return;
    const { data } = await supabase
      .from('room_queue')
      .select('id, track, added_by, votes, created_at, profiles(display_name)')
      .eq('room_id', id)
      .order('votes', { ascending: false })
      .order('created_at', { ascending: true });
    if (data) setQueue(data as unknown as QueueRow[]);
  }, [id]);

  const load = useCallback(async () => {
    if (!id || !me) return;
    setLoading(true);
    setError(null);
    try {
      let r = await supabase.from('rooms').select('*').eq('id', id).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      if (!r.data) {
        // Not a member yet: rooms are only readable by members (open party / live rooms excepted). Opening a
        // jam link joins through the server, which checks the invite came from a shared chat.
        const j = await supabase.rpc('join_room_by_id', { rid: id });
        if (j.error) throw new Error(/not found|no longer/i.test(j.error.message) ? 'This room no longer exists.' : j.error.message);
        r = await supabase.from('rooms').select('*').eq('id', id).maybeSingle();
        if (r.error) throw new Error(r.error.message);
        if (!r.data) throw new Error('This room no longer exists.');
      }
      const row = r.data as RoomRow;
      // Opening a room link joins it (idempotent).
      if (row.is_open && row.host_id !== me) {
        const j = await supabase.rpc('join_room', { room_code: row.code });
        if (j.error) throw new Error(j.error.message);
      }
      setRoom(row);
      await Promise.all([loadMembers(), loadQueue()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the room');
    } finally {
      setLoading(false);
    }
  }, [id, me, loadMembers, loadQueue]);

  useEffect(() => {
    void load();
  }, [load]);

  const pushReaction = useCallback((icon: unknown) => {
    const r = REACTIONS.find((x) => x.icon === icon);
    if (!r) return;
    const key = `${Date.now()}-${Math.random()}`;
    setReactions((list) => [...list.slice(-14), { key, icon: r.icon, color: r.color, x: 0.1 + Math.random() * 0.8 }]);
    setTimeout(() => setReactions((list) => list.filter((x) => x.key !== key)), 2600);
  }, []);

  // Room chat: persisted in room_messages (history + realtime INSERTs) on its own channel.
  const addLine = useCallback((m: RoomMessageRow) => {
    setChat((list) => {
      if (list.some((x) => x.key === m.id)) return list;
      const i = list.findIndex((x) => x.pending && x.user_id === m.user_id && x.text === m.body);
      if (i >= 0) return [...list.slice(0, i), toLine(m), ...list.slice(i + 1)];
      return [...list.slice(-49), toLine(m)];
    });
  }, []);

  useEffect(() => {
    if (!id || !me) return;
    let live = true;
    void supabase
      .from('room_messages')
      .select('id, room_id, user_id, body, created_at')
      .eq('room_id', id)
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data, error: e }) => {
        if (!live) return;
        if (e) setNote({ ok: false, text: `Chat unavailable: ${e.message}` });
        else setChat(((data ?? []) as RoomMessageRow[]).reverse().map(toLine));
      });
    const ch = supabase
      .channel(`room-chat:${id}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${id}` }, (p) => addLine(p.new as RoomMessageRow))
      .subscribe();
    return () => {
      live = false;
      void supabase.removeChannel(ch).then(undefined, () => undefined);
    };
  }, [id, me, addLine]);

  // Realtime: room state, members, queue (postgres_changes) + reactions (broadcast) + who's here (presence).
  // Private topic (room members + host only): subscribe once load() has joined the room.
  const roomReady = room !== null;
  useEffect(() => {
    if (!id || !me || !roomReady) return;
    const ch = privateChannel(`room:${id}`, { presence: { key: me }, broadcast: { self: true } });
    ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${id}` }, (p) => setRoom(p.new as RoomRow))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members', filter: `room_id=eq.${id}` }, () => void loadMembers())
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'room_members' }, () => void loadMembers())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_queue', filter: `room_id=eq.${id}` }, () => void loadQueue())
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'room_queue' }, () => void loadQueue())
      .on('broadcast', { event: 'reaction' }, (msg) => pushReaction((msg.payload as { icon?: unknown } | undefined)?.icon))
      .on('presence', { event: 'sync' }, () => setOnline(new Set(Object.keys(ch.presenceState()))))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void ch.track({ user_id: me, at: Date.now() });
      });
    channel.current = ch;
    return () => {
      channel.current = null;
      void supabase.removeChannel(ch).then(undefined, () => undefined);
    };
  }, [id, me, roomReady, loadMembers, loadQueue, pushReaction]);

  /* ---------------- host is the source of truth: publish track / play state */
  const lastSent = useRef('');
  useEffect(() => {
    if (!id || !isHost || !room?.is_open) return;
    const t = player.track;
    const key = `${t?.id ?? ''}|${player.playing}`;
    if (key === lastSent.current) return;
    const trackChanged = lastSent.current.split('|')[0] !== (t?.id ?? '');
    lastSent.current = key;
    void supabase
      .from('rooms')
      .update({
        track: t,
        is_playing: player.playing,
        position_ms: trackChanged ? 0 : Math.round(posRef.current * 1000),
        updated_at: new Date().toISOString(),
        ...(trackChanged ? { skip_votes: 0 } : {}),
      })
      .eq('id', id);
  }, [id, isHost, room?.is_open, player.track, player.playing]);

  // Heartbeat so late joiners and seeks stay in sync.
  useEffect(() => {
    if (!id || !isHost || !room?.is_open || !player.playing) return;
    const timer = setInterval(() => {
      void supabase.from('rooms').update({ position_ms: Math.round(posRef.current * 1000), updated_at: new Date().toISOString() }).eq('id', id).then(undefined, () => undefined);
    }, 10_000);
    return () => clearInterval(timer);
  }, [id, isHost, room?.is_open, player.playing]);

  /* ---------------- members follow the host */
  useEffect(() => {
    if (!room || isHost || !room.is_open || !room.track) return;
    const elapsed = room.is_playing ? Math.max(0, (Date.now() - new Date(room.updated_at).getTime()) / 1000) : 0;
    const target = room.position_ms / 1000 + elapsed;
    if (player.track?.id !== room.track.id) {
      player.playTrack(room.track, `Room · ${room.name}`);
      const timer = setTimeout(() => {
        player.seekTo(target + 1);
        if (!room.is_playing) player.pause();
      }, 1000);
      return () => clearTimeout(timer);
    }
    if (Math.abs(posRef.current - target) > 3) player.seekTo(target);
    if (room.is_playing && !player.playing) player.play();
    else if (!room.is_playing && player.playing) player.pause();
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.track?.id, room?.position_ms, room?.is_playing, room?.updated_at, room?.is_open, isHost]);

  /* ---------------- queue */
  const addToQueue = useCallback(
    async (track: CatalogTrack) => {
      if (!id || !me) return;
      const { error: e } = await supabase.from('room_queue').insert({ room_id: id, track, added_by: me });
      setNote(e ? { ok: false, text: e.message } : { ok: true, text: `Added ${track.title}` });
      if (!e) void loadQueue();
    },
    [id, me, loadQueue],
  );

  const vote = useCallback(
    async (q: QueueRow) => {
      if (votedQueue.has(q.id)) return;
      setVotedQueue((s) => new Set(s).add(q.id));
      setQueue((list) => list.map((x) => (x.id === q.id ? { ...x, votes: x.votes + 1 } : x)).sort((a, b) => b.votes - a.votes || a.created_at.localeCompare(b.created_at)));
      const { error: e } = await supabase.from('room_queue').update({ votes: q.votes + 1 }).eq('id', q.id);
      if (e) setNote({ ok: false, text: e.message });
    },
    [votedQueue],
  );

  const removeFromQueue = useCallback(
    async (q: QueueRow) => {
      setQueue((list) => list.filter((x) => x.id !== q.id));
      const { error: e } = await supabase.from('room_queue').delete().eq('id', q.id);
      if (e) {
        setNote({ ok: false, text: e.message });
        void loadQueue();
      }
    },
    [loadQueue],
  );

  const playFromQueue = useCallback(
    async (q: QueueRow) => {
      player.playTrack(q.track, room ? `Room · ${room.name}` : undefined);
      await removeFromQueue(q);
    },
    [player, room, removeFromQueue],
  );

  const skip = useCallback(async () => {
    if (!id) return;
    const top = queue[0];
    if (top) await playFromQueue(top);
    else player.next();
    await supabase.from('rooms').update({ skip_votes: 0 }).eq('id', id);
  }, [id, queue, playFromQueue, player]);

  const voteSkip = useCallback(async () => {
    if (!room?.track || votedTrack === room.track.id) return;
    setVotedTrack(room.track.id);
    if (isHost) {
      void skip();
      return;
    }
    const { error: e } = await supabase.from('rooms').update({ skip_votes: room.skip_votes + 1 }).eq('id', room.id);
    if (e) setNote({ ok: false, text: e.message });
  }, [room, votedTrack, isHost, skip]);

  // Host skips once more than half the room has voted.
  useEffect(() => {
    if (!isHost || !room) return;
    if (room.skip_votes > Math.max(1, members.length) / 2) void skip();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.skip_votes, members.length, isHost]);

  /* ---------------- broadcast */
  const react = useCallback((icon: IconName) => {
    void channel.current?.send({ type: 'broadcast', event: 'reaction', payload: { icon } });
  }, []);

  const say = useCallback(
    async (text: string) => {
      const t = text.trim().slice(0, 500);
      if (!t || !me || !id) return;
      const tempKey = `temp-${Date.now()}`;
      setChat((list) => [...list.slice(-49), { key: tempKey, user_id: me, text: t, created_at: new Date().toISOString(), pending: true }]);
      const { data, error: e } = await supabase.from('room_messages').insert({ room_id: id, user_id: me, body: t }).select('id, room_id, user_id, body, created_at').single();
      if (e || !data) {
        setChat((list) => list.filter((x) => x.key !== tempKey));
        setNote({ ok: false, text: e?.message ?? 'Message not sent' });
        return;
      }
      setChat((list) => {
        const without = list.filter((x) => x.key !== tempKey);
        return without.some((x) => x.key === (data as RoomMessageRow).id) ? without : [...without, toLine(data as RoomMessageRow)];
      });
    },
    [me, id],
  );

  /* ---------------- membership */
  const share = useCallback(async () => {
    if (!room) return;
    const what = room.kind === 'party' ? 'party' : 'listening room';
    await Share.share({ message: `Join my ${what} “${room.name}” on Zoyra — code ${room.code}\n${roomJoinLink(room.kind, room.code)}` }).catch(() => undefined);
  }, [room]);

  const copyCode = useCallback(async () => {
    if (!room) return;
    await Clipboard.setStringAsync(room.code);
    setNote({ ok: true, text: `Code ${room.code} copied` });
  }, [room]);

  const leave = useCallback(async () => {
    if (id && me) await supabase.from('room_members').delete().eq('room_id', id).eq('user_id', me);
    go('back');
  }, [id, me]);

  const end = useCallback(async () => {
    if (!id) return;
    const { error: e } = await supabase.from('rooms').update({ is_open: false, is_playing: false, updated_at: new Date().toISOString() }).eq('id', id);
    if (e) {
      setNote({ ok: false, text: e.message });
      return;
    }
    go('back');
  }, [id]);

  // Room progress: our own player when in sync, otherwise extrapolate from the room row.
  const inSync = !!room?.track && player.track?.id === room.track.id;
  const roomDuration = room?.track?.duration ?? 0;
  const roomPos = room ? room.position_ms / 1000 + (room.is_playing ? Math.max(0, (Date.now() - new Date(room.updated_at).getTime()) / 1000) : 0) : 0;
  const pos = inSync ? position : Math.min(roomPos, roomDuration);
  const dur = inSync && duration ? duration : roomDuration;
  const prog = inSync ? progress : dur ? pos / dur : 0;

  return {
    me,
    room,
    members,
    queue,
    loading,
    error,
    reload: load,
    isHost,
    online,
    reactions,
    chat,
    note,
    setNote,
    votedTrack,
    votedQueue,
    progress: { position: pos, duration: dur, value: prog },
    addToQueue,
    vote,
    removeFromQueue,
    playFromQueue,
    voteSkip,
    react,
    say,
    share,
    copyCode,
    leave,
    end,
  };
}

export type RoomApi = ReturnType<typeof useRoom>;

/* ================================================================== shared room UI */

export function PersonAvatar({ p, size = 44, initial }: { p: Person | null; size?: number; initial?: string }) {
  const name = p?.display_name ?? initial ?? '?';
  return (
    <Cover uri={p?.avatar_url} id={p?.id} size={size} radius={size / 2} style={{ alignItems: 'center', justifyContent: 'center' }}>
      {p?.avatar_url ? null : (
        <T size={Math.round(size / 3)} weight={600} color={colors.white}>
          {(name[0] ?? '?').toUpperCase()}
        </T>
      )}
    </Cover>
  );
}

function Floater({ r }: { r: FloatingReaction }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 2400, useNativeDriver: true }).start();
  }, [v]);
  return (
    <Animated.View
      style={{
        position: 'absolute',
        bottom: 140,
        left: `${Math.round(r.x * 85)}%`,
        opacity: v.interpolate({ inputRange: [0, 0.15, 0.8, 1], outputRange: [0, 1, 1, 0] }),
        transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -280] }) }, { scale: v.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0.6, 1.2, 1] }) }],
      }}
    >
      <Icon name={r.icon} size={36} color={r.color} filled={r.icon === 'heart' || r.icon === 'star'} />
    </Animated.View>
  );
}

/** Ephemeral emoji-style reactions floating up over the screen (design icons). */
export function FloatingReactions({ list }: { list: FloatingReaction[] }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
      {list.map((r) => (
        <Floater key={r.key} r={r} />
      ))}
    </View>
  );
}

export function ReactionBar({ onReact }: { onReact: (icon: IconName) => void }) {
  const [last, setLast] = useState<IconName | null>(null);
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      {REACTIONS.map((r) => (
        <Tap
          key={r.icon}
          accessibilityLabel={r.label}
          accessibilityState={{ selected: last === r.icon }}
          onPress={() => {
            setLast(r.icon);
            onReact(r.icon);
          }}
          style={{ width: 48, height: 48, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: last === r.icon ? colors.accentTint : colors.chipGhost }}
        >
          <Icon name={r.icon} size={24} color={r.color} filled={r.filled} />
        </Tap>
      ))}
    </Row>
  );
}

export function RoomQueue({ api }: { api: RoomApi }) {
  const { queue, me, isHost, votedQueue } = api;
  if (!queue.length) {
    return (
      <T size={14} color={colors.textSecondary} align="center" style={{ paddingVertical: 20 }}>
        Queue is empty
      </T>
    );
  }
  return (
    <>
      {queue.map((q, i) => (
        <Row key={q.id} style={[{ minHeight: 60, paddingLeft: 8 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
          <Cover artwork={q.track.artwork} id={q.track.id} size={44} radius={14} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T size={16} weight={500} numberOfLines={1}>
              {q.track.title}
            </T>
            <T size={14} color={colors.textSecondary} numberOfLines={1}>
              Added by {q.added_by === me ? 'You' : q.profiles?.display_name ?? 'a guest'}
            </T>
          </View>
          <Tap
            onPress={() => void api.vote(q)}
            accessibilityLabel={`Vote for ${q.track.title}, ${q.votes} votes`}
            accessibilityState={{ selected: votedQueue.has(q.id) }}
            style={{ minWidth: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="chevronUp" size={20} color={votedQueue.has(q.id) ? colors.accentLight : colors.textSecondary} />
            <T mono size={11} color={votedQueue.has(q.id) ? colors.accentLight : colors.textSecondary}>
              {q.votes}
            </T>
          </Tap>
          {isHost ? <IconButton icon="play" label={`Play ${q.track.title} now`} color={colors.accentLight} onPress={() => void api.playFromQueue(q)} /> : null}
          {isHost || q.added_by === me ? <IconButton icon="close" label="Remove" color={colors.textSecondary} onPress={() => void api.removeFromQueue(q)} /> : null}
        </Row>
      ))}
    </>
  );
}

/** Add the now-playing song or a catalogue search result to the room queue. */
export function QueueAdder({ api }: { api: RoomApi }) {
  const { track } = usePlayer();
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim());
  const results = useAsync<CatalogTrack[]>(() => (q ? catalog.searchTracks(q, { limit: 8 }) : Promise.resolve([])), [q]);
  const nowPlayingQueued = !!track && (api.room?.track?.id === track.id || api.queue.some((x) => x.track.id === track.id));
  return (
    <View style={{ gap: 10 }}>
      {track && !nowPlayingQueued && !api.isHost ? (
        <Button label={`Add “${track.title}”`} icon="plus" variant="glass" height={44} onPress={() => void api.addToQueue(track)} />
      ) : null}
      <Row gap={8} style={{ height: 48, borderRadius: 24, backgroundColor: colors.bgTertiary, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 }}>
        <Icon name="search" size={20} color={colors.textSecondary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search songs to add"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Search songs to add"
          returnKeyType="search"
          style={{ flex: 1, height: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 16 }}
        />
      </Row>
      {q ? (
        results.loading ? (
          <Loading height={80} />
        ) : results.error ? (
          <ErrorState message={results.error} onRetry={results.reload} />
        ) : !results.data?.length ? (
          <T size={14} color={colors.textSecondary} align="center" style={{ paddingVertical: 12 }}>
            No songs match “{q}”
          </T>
        ) : (
          <Glass padding={4}>
            {results.data.map((t, i) => (
              <ListRow
                key={t.id}
                divider={i > 0}
                minHeight={60}
                title={t.title}
                subtitle={`${t.artist.name} · ${formatDuration(t.duration)}`}
                leading={<Cover artwork={t.artwork} id={t.id} size={44} radius={14} />}
                onPress={() => {
                  void api.addToQueue(t);
                  setQuery('');
                }}
                right={<Icon name="plus" size={20} color={colors.accentLight} />}
              />
            ))}
          </Glass>
        )
      ) : null}
    </View>
  );
}

export function RoomNote({ api }: { api: RoomApi }) {
  const { note, setNote } = api;
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 2600);
    return () => clearTimeout(t);
  }, [note, setNote]);
  return note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.error} message={note.text} /> : null;
}

/** No room id yet: create a room or join one with a share code. */
export function RoomLobby({ kind }: { kind: RoomKind }) {
  const { user, profile } = useAuth();
  const me = user?.id;
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const label = kind === 'party' ? 'party' : 'room';

  const mine = useAsync<RoomRow[]>(async () => {
    if (!me) return [];
    const { data, error } = await supabase.from('rooms').select('*').eq('host_id', me).eq('kind', kind).eq('is_open', true).order('created_at', { ascending: false }).limit(5);
    if (error) throw new Error(error.message);
    return (data ?? []) as RoomRow[];
  }, [me, kind]);

  const create = async () => {
    if (!me) return;
    setBusy('create');
    setErr(null);
    const defaultName = kind === 'party' ? `${profile?.display_name ?? 'My'}'s party` : `${profile?.display_name ?? 'My'}'s room`;
    const { data, error } = await supabase.from('rooms').insert({ host_id: me, kind, name: name.trim() || defaultName }).select('id').single();
    if (error || !data) {
      setBusy(null);
      setErr(error?.message ?? 'Could not create room');
      return;
    }
    const rid = (data as { id: string }).id;
    await supabase.from('room_members').insert({ room_id: rid, user_id: me });
    setBusy(null);
    router.replace({ pathname: routeFor(kind), params: { id: rid } });
  };

  const join = async () => {
    const c = code.trim().replace(/^ZOY-?/i, '');
    if (!c) return;
    setBusy('join');
    setErr(null);
    const { data, error } = await supabase.rpc('join_room', { room_code: c });
    if (error || !data) {
      setBusy(null);
      setErr(error?.message === 'room not found' ? 'No open room with that code.' : error?.message ?? 'Could not join');
      return;
    }
    const rid = String(data);
    const { data: r } = await supabase.from('rooms').select('kind').eq('id', rid).maybeSingle();
    setBusy(null);
    router.replace({ pathname: routeFor(((r as { kind?: RoomKind } | null)?.kind ?? kind) as RoomKind), params: { id: rid } });
  };

  return (
    <View style={{ gap: 16 }}>
      <Glass padding={16}>
        <View style={{ gap: 12 }}>
          <T size={16} weight={600}>
            {kind === 'party' ? 'Start a party' : 'Start a listening room'}
          </T>
          <T size={14} color={colors.textSecondary} lineHeight={20}>
            {kind === 'party' ? 'Guests join with a code, add songs to a shared queue and vote on what plays next.' : 'Everyone hears the same song at the same moment. You control playback.'}
          </T>
          <TextField label="Name" hideLabel placeholder={kind === 'party' ? 'Party name' : 'Room name'} value={name} onChangeText={setName} maxLength={60} />
          <Button label={busy === 'create' ? 'Creating…' : `Create ${label}`} icon="plus" onPress={() => void create()} />
        </View>
      </Glass>

      <Glass padding={16}>
        <View style={{ gap: 12 }}>
          <T size={16} weight={600}>
            Join with a code
          </T>
          <TextField label="Code" hideLabel placeholder="e.g. 4F2A9C" autoCapitalize="characters" autoCorrect={false} value={code} onChangeText={setCode} maxLength={10} />
          <Button label={busy === 'join' ? 'Joining…' : 'Join'} variant={code.trim() ? 'secondary' : 'disabled'} onPress={() => void join()} />
        </View>
      </Glass>

      {err ? (
        <T size={13} color={colors.error} align="center">
          {err}
        </T>
      ) : null}

      {mine.data?.length ? (
        <>
          <SectionHeader title={kind === 'party' ? 'Your open parties' : 'Your open rooms'} />
          <Glass padding={4}>
            {mine.data.map((r, i) => (
              <ListRow
                key={r.id}
                divider={i > 0}
                icon="users"
                title={r.name}
                subtitle={`Code ${r.code}${r.track ? ` · ${r.track.title}` : ''}`}
                onPress={() => router.replace({ pathname: routeFor(kind), params: { id: r.id } })}
              />
            ))}
          </Glass>
        </>
      ) : null}
    </View>
  );
}

/** Scannable QR of the room's join link, on the white rounded card (168 px). */
export function RoomQR({ kind, code, onPress }: { kind: RoomKind; code: string; onPress?: () => void }) {
  return (
    <Tap onPress={onPress} accessibilityLabel={`QR code to join, code ${code}. Tap to copy the code`}>
      <View style={{ width: 168, height: 168, padding: 12, borderRadius: 26, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' }}>
        <QRCode value={roomJoinLink(kind, code)} size={144} color={colors.bg} backgroundColor={colors.white} ecl="M" />
      </View>
    </Tap>
  );
}

/** `?code=` deep link (QR scan / shared link): join the room, then swap to `?id=`. */
export function JoinByCode({ kind, code }: { kind: RoomKind; code: string }) {
  const { user } = useAuth();
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!user) return;
    let live = true;
    setErr(null);
    void (async () => {
      const c = code.trim().replace(/^ZOY-?/i, '');
      const { data, error } = await supabase.rpc('join_room', { room_code: c });
      if (!live) return;
      if (error || !data) {
        setErr(error?.message === 'room not found' ? `No open room with code ${c.toUpperCase()}.` : error?.message ?? 'Could not join');
        return;
      }
      const rid = String(data);
      const { data: r } = await supabase.from('rooms').select('kind').eq('id', rid).maybeSingle();
      if (!live) return;
      router.replace({ pathname: routeFor((r as { kind?: RoomKind } | null)?.kind ?? kind), params: { id: rid } });
    })();
    return () => {
      live = false;
    };
  }, [user, code, kind, attempt]);
  if (err) return <ErrorState message={err} onRetry={() => setAttempt((n) => n + 1)} />;
  return <Loading label={`Joining ${code.toUpperCase()}…`} />;
}

export function RoomEnded() {
  return <EmptyState icon="music" title="This room has ended" body="The host closed it. Start your own or join another with a code." action="Back" onAction={() => go('back')} />;
}

/* ================================================================== screen */

export default function GroupListening() {
  const { id: rawId, code: rawCode } = useLocalSearchParams<{ id?: string; code?: string }>();
  const id = typeof rawId === 'string' && rawId ? rawId : undefined;
  const code = typeof rawCode === 'string' && rawCode.trim() ? rawCode : undefined;

  if (!id) {
    return (
      <Screen top={4} gap={14} backdrop={{ pattern: 'dots', mesh: 'rose' }}>
        <ScreenHeader title="Listening together" />
        {code ? <JoinByCode kind="group" code={code} /> : <RoomLobby kind="group" />}
      </Screen>
    );
  }
  return <GroupRoom id={id} />;
}

function GroupRoom({ id }: { id: string }) {
  const api = useRoom(id);
  const { room, members, online, isHost, chat, me } = api;
  const player = usePlayer();
  const [settings, setSettings] = useState(false);
  const [draft, setDraft] = useState('');

  if (api.loading || api.error || !room) {
    return (
      <Screen top={4} gap={14} backdrop={{ pattern: 'dots', mesh: 'rose' }}>
        <ScreenHeader title="Listening together" />
        {api.loading ? <Loading /> : <ErrorState message={api.error ?? 'Room not found'} onRetry={() => void api.reload()} />}
      </Screen>
    );
  }

  if (!room.is_open) {
    return (
      <Screen top={4} gap={14} backdrop={{ pattern: 'dots', mesh: 'rose' }}>
        <ScreenHeader title="Listening together" />
        <RoomEnded />
      </Screen>
    );
  }

  const inSyncCount = members.filter((m) => online.has(m.user_id)).length || online.size;
  const needed = Math.floor(Math.max(1, members.length) / 2) + 1;
  const remaining = Math.max(0, api.progress.duration - api.progress.position);
  const voted = !!room.track && api.votedTrack === room.track.id;
  const nameOf = (uid: string) => (uid === me ? 'You' : members.find((m) => m.user_id === uid)?.profiles?.display_name ?? 'Listener');

  const sendChat = () => {
    if (!draft.trim()) return;
    void api.say(draft);
    setDraft('');
  };

  return (
    <View style={{ flex: 1 }}>
      <Screen top={4} gap={14} backdrop={{ pattern: 'dots', mesh: 'rose' }} contentStyle={{ flexGrow: 1 }}>
        <ScreenHeader title="Listening together" right={<IconButton icon={settings ? 'close' : 'sliders'} label="Room settings" onPress={() => setSettings((s) => !s)} />} />

        {settings ? (
          <Glass padding={14}>
            <View style={{ gap: 10 }}>
              <Row>
                <View style={{ flex: 1, gap: 2 }}>
                  <T size={16} weight={600} numberOfLines={1}>
                    {room.name}
                  </T>
                  <Tap onPress={() => void api.copyCode()} accessibilityLabel={`Copy room code ${room.code}`}>
                    <T mono size={13} color={colors.accentLight}>
                      Code {room.code} · tap to copy
                    </T>
                  </Tap>
                </View>
                {isHost ? <Sticker label="HOST" rotate={-3} /> : null}
              </Row>
              <View style={{ alignItems: 'center', gap: 6, paddingVertical: 4 }}>
                <RoomQR kind="group" code={room.code} onPress={() => void api.copyCode()} />
                <T size={12} tracking={0.2} color={colors.textSecondary}>
                  Scan to join · tap to copy the code
                </T>
              </View>
              <Row gap={8}>
                <Button label="Leave" variant="glass" height={44} style={{ flex: 1 }} onPress={() => void api.leave()} />
                {isHost ? <Button label="End room" variant="destructive" height={44} style={{ flex: 1 }} onPress={() => void api.end()} /> : null}
              </Row>
            </View>
          </Glass>
        ) : null}

        {/* Listeners */}
        <Row gap={12}>
          <Row gap={0}>
            {members.slice(0, 5).map((m, i) => (
              <View key={m.user_id} style={{ marginLeft: i === 0 ? 0 : -12, borderWidth: 3, borderColor: online.has(m.user_id) ? colors.success : colors.bgSecondary, borderRadius: 32 }}>
                <PersonAvatar p={m.profiles} size={44} />
              </View>
            ))}
          </Row>
          <T size={14} color={colors.textSecondary} style={{ flex: 1 }}>
            {inSyncCount} in sync
          </T>
          <Sticker label={room.is_playing ? 'LIVE' : 'PAUSED'} bg={room.is_playing ? colors.like : colors.textSecondary} rotate={3} />
        </Row>

        {/* Now playing */}
        <Glass padding={16}>
          <View style={{ gap: 14 }}>
            <Row gap={14}>
              <Cover artwork={room.track?.artwork} id={room.track?.id ?? room.id} size={72} radius={32} />
              <View style={{ flex: 1, gap: 2 }}>
                <T size={18} weight={700} numberOfLines={1}>
                  {room.track?.title ?? 'Nothing playing yet'}
                </T>
                <T size={14} color={colors.textSecondary} numberOfLines={1}>
                  {room.track?.artist.name ?? (isHost ? 'Play any song — everyone hears it' : 'Waiting for the host')}
                </T>
              </View>
              {isHost && player.track ? <IconButton icon={player.playing ? 'pause' : 'play'} label={player.playing ? 'Pause for everyone' : 'Play for everyone'} bg={colors.accent} color={colors.onAccent} onPress={player.toggle} /> : null}
            </Row>
            {room.track ? <SeekBar value={api.progress.value} elapsed={formatDuration(api.progress.position)} remaining={`-${formatDuration(remaining)}`} /> : null}
          </View>
        </Glass>

        <ReactionBar onReact={api.react} />

        {/* Chat (saved to room_messages, live via realtime) */}
        <Glass padding={14}>
          <View style={{ gap: 10 }}>
            {chat.length === 0 ? (
              <T size={14} color={colors.textSecondary}>
                Say hi to the room
              </T>
            ) : (
              chat.slice(-6).map((m) => {
                const member = members.find((x) => x.user_id === m.user_id)?.profiles ?? null;
                return (
                  <Row key={m.key} gap={8} align="flex-end">
                    <PersonAvatar p={member} initial={nameOf(m.user_id)} size={32} />
                    <View style={{ paddingVertical: 10, paddingHorizontal: 14, borderRadius: 18, backgroundColor: m.user_id === me ? colors.accentTint : colors.chipGhost, flexShrink: 1, opacity: m.pending ? 0.6 : 1 }}>
                      <T size={14}>{m.text}</T>
                    </View>
                  </Row>
                );
              })
            )}
            <Row gap={8}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                onSubmitEditing={sendChat}
                returnKeyType="send"
                placeholder={`Message as ${nameOf(me ?? '')}`}
                placeholderTextColor={colors.textSecondary}
                accessibilityLabel="Room message"
                maxLength={500}
                style={{ flex: 1, height: 44, paddingHorizontal: 14, borderRadius: 22, backgroundColor: colors.bgTertiary, color: colors.text, fontFamily: fonts.regular, fontSize: 15 }}
              />
              <IconButton icon="next" label="Send" bg={colors.accent} color={colors.onAccent} onPress={sendChat} />
            </Row>
          </View>
        </Glass>

        <SectionHeader title="Up next" />
        <Glass padding={4}>
          <RoomQueue api={api} />
        </Glass>
        <QueueAdder api={api} />

        <Spacer />

        <RoomNote api={api} />

        <Row gap={12}>
          <Button
            variant={room.track ? 'glass' : 'disabled'}
            label={isHost ? 'Skip' : `${voted ? 'Voted' : 'Vote skip'} (${room.skip_votes}/${needed})`}
            onPress={() => void api.voteSkip()}
            style={{ flex: 1 }}
          />
          <Button label="Invite" style={{ flex: 1 }} onPress={() => void api.share()} />
        </Row>
      </Screen>
      <FloatingReactions list={api.reactions} />
    </View>
  );
}
