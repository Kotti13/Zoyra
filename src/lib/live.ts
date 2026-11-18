import type { RealtimeChannel } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';

import { usePlaybackProgress, usePlayerPick } from '../state/player';
import type { CatalogTrack } from './catalog';
import { friendlySocialError } from './social';
import { supabase } from './supabase';
import { FLASH, flash } from './flash';
import { LIVE_CONNECT_ERROR, NetworkError, isNetworkError, retryOnNetworkError } from './http';

/**
 * Live listening sessions (server side: supabase/migrations/20261114120000_live.sql).
 *
 * The host plays songs; listeners hear the same song in sync. Playback sync goes over a Realtime
 * broadcast channel (`live:<session id>`), the listener count comes from Realtime presence on the same
 * channel, and chat / song requests reuse the room tables (room_messages / room_queue) of the
 * session's `rooms` row (kind 'live'). No microphone or video: this is a shared music session.
 *
 * Realtime topics (all public channels, not `privateChannel`):
 *   live:<session id>             broadcast `sync` / `hello` / `reaction` + presence (listener count). Kept public:
 *                                 live sessions are public by design (live_sessions and open live rooms are readable by
 *                                 every signed-in user), the sync payload is the same track / position the rooms row
 *                                 already exposes, and presence carries no user ids for listeners (random key). A
 *                                 private topic would need a realtime.messages policy pushed before the client ships,
 *                                 otherwise every listener's join is refused. Broadcasts are client-authored: never
 *                                 trust ids in them.
 *   live-room:<room id>:<rand>    postgres_changes on room_messages / room_queue (table RLS applies)
 *   live-session:<id>:<rand>      postgres_changes on live_sessions (table RLS applies)
 */

export type Person = { id: string; display_name: string; avatar_url: string | null };
export type LiveStatus = 'scheduled' | 'live' | 'ended';

export type LiveSession = {
  id: string;
  host_id: string;
  room_id: string | null;
  title: string;
  status: LiveStatus;
  chat_enabled: boolean;
  requests_enabled: boolean;
  save_replay: boolean;
  notify_followers: boolean;
  scheduled_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  heartbeat_at: string | null;
  listeners: number;
  peak_listeners: number;
  created_at: string;
  host: Person | null;
};

export type LiveTrackRow = { id: string; track: CatalogTrack; played_at: string };
export type RequestRow = { id: string; track: CatalogTrack; added_by: string | null; votes: number; created_at: string; profiles: { display_name: string } | null };
export type ChatLine = { key: string; user_id: string; name: string; avatar: string | null; text: string; created_at: string; pending?: boolean };

/** A live session whose host hasn't sent a heartbeat for this long is treated as offline. */
export const STALE_MS = 2 * 60_000;
/** Replays stay available this long after a session ends. */
export const REPLAY_DAYS = 7;

const SELECT = '*, host:profiles!live_sessions_host_id_fkey(id, display_name, avatar_url)';

export const liveLink = (id: string) => `zoyra://live-room?id=${encodeURIComponent(id)}`;

export const isOnAir = (s: Pick<LiveSession, 'status' | 'heartbeat_at'>, now = Date.now()) =>
  s.status === 'live' && !!s.heartbeat_at && now - new Date(s.heartbeat_at).getTime() < STALE_MS;

export const replayExpiresAt = (s: Pick<LiveSession, 'ended_at'>) =>
  s.ended_at ? new Date(new Date(s.ended_at).getTime() + REPLAY_DAYS * 86_400_000) : null;

/** Turns server errors from live writes into a sentence the user can act on. */
export function friendlyLiveError(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  // Transport failures (expo/fetch native rejections, offline, timeouts) never reach the screen verbatim.
  if (isNetworkError(e)) return LIVE_CONNECT_ERROR;
  const msg = e && typeof e === 'object' && 'message' in e && typeof e.message === 'string' ? e.message : '';
  if (/live_sessions_one_live_per_host|duplicate key/i.test(msg)) return 'You already have a live session running. End it first.';
  if (/relation .*live_sessions|live_sessions.* does not exist|join_live/i.test(msg) && /does not exist|could not find/i.test(msg))
    return 'Live sessions need the latest server update.';
  return friendlySocialError(e, fallback);
}

const fail = (error: { message: string } | null) => {
  if (!error) return;
  if (isNetworkError(error)) throw new NetworkError(LIVE_CONNECT_ERROR);
  throw new Error(friendlyLiveError(error));
};

/* ================================================================== formatting */

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(n);
}

/** "2m", "18m", "1h 5m" since an ISO time. */
export function sinceShort(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** "Today, 8:00 PM", "Tomorrow, 9:30 AM", "Fri 20 Nov, 8:00 PM". */
export function formatWhen(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(today)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Tomorrow, ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}

/* ================================================================== queries */

export type HubData = {
  mine: LiveSession | null;
  live: LiveSession[];
  upcoming: LiveSession[];
  replays: (LiveSession & { trackCount: number })[];
  following: Set<string>;
  followers: Record<string, number>;
  reminders: Set<string>;
};

export async function loadHub(me: string): Promise<HubData> {
  const now = Date.now();
  const staleBefore = new Date(now - STALE_MS).toISOString();
  const replayAfter = new Date(now - REPLAY_DAYS * 86_400_000).toISOString();
  const [mineQ, liveQ, upQ, repQ, remQ] = await Promise.all([
    supabase.from('live_sessions').select(SELECT).eq('host_id', me).eq('status', 'live').maybeSingle(),
    supabase.from('live_sessions').select(SELECT).eq('status', 'live').gt('heartbeat_at', staleBefore).order('listeners', { ascending: false }).limit(30),
    supabase.from('live_sessions').select(SELECT).eq('status', 'scheduled').gt('scheduled_at', new Date(now - 60 * 60_000).toISOString()).order('scheduled_at').limit(30),
    supabase
      .from('live_sessions')
      .select(`${SELECT}, live_session_tracks(count)`)
      .eq('status', 'ended')
      .eq('save_replay', true)
      .gt('ended_at', replayAfter)
      .order('ended_at', { ascending: false })
      .limit(20),
    supabase.from('live_reminders').select('session_id').eq('user_id', me),
  ]);
  fail(mineQ.error ?? liveQ.error ?? upQ.error ?? repQ.error ?? remQ.error);

  const live = (liveQ.data ?? []) as unknown as LiveSession[];
  type ReplayRaw = LiveSession & { live_session_tracks: { count: number }[] | null };
  const replays = ((repQ.data ?? []) as unknown as ReplayRaw[])
    .map(({ live_session_tracks, ...s }) => ({ ...s, trackCount: live_session_tracks?.[0]?.count ?? 0 }))
    .filter((s) => s.trackCount > 0 || s.host_id === me);
  const upcoming = (upQ.data ?? []) as unknown as LiveSession[];

  const hosts = [...new Set(live.map((s) => s.host_id).filter((h) => h !== me))];
  const [following, followers] = await Promise.all([loadFollowing(me, hosts), loadFollowerCounts(hosts.slice(0, 12))]);
  return {
    mine: (mineQ.data as unknown as LiveSession | null) ?? null,
    live,
    upcoming,
    replays,
    following,
    followers,
    reminders: new Set(((remQ.data ?? []) as { session_id: string }[]).map((r) => r.session_id)),
  };
}

export async function loadFollowing(me: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { data, error } = await supabase.from('follows').select('following_id').eq('follower_id', me).in('following_id', ids);
  fail(error);
  return new Set(((data ?? []) as { following_id: string }[]).map((r) => r.following_id));
}

export async function loadFollowerCounts(ids: string[]): Promise<Record<string, number>> {
  const entries = await Promise.all(
    ids.map(async (id) => {
      const { count } = await supabase.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', id);
      return [id, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(entries.filter(([, n]) => n > 0));
}

export async function loadSession(id: string): Promise<LiveSession | null> {
  const { data, error } = await supabase.from('live_sessions').select(SELECT).eq('id', id).maybeSingle();
  fail(error);
  return (data as unknown as LiveSession | null) ?? null;
}

export async function loadTracks(sessionId: string): Promise<LiveTrackRow[]> {
  const { data, error } = await supabase.from('live_session_tracks').select('id, track, played_at').eq('session_id', sessionId).order('played_at');
  fail(error);
  return (data ?? []) as unknown as LiveTrackRow[];
}

export async function reminderCount(sessionId: string): Promise<number> {
  const { data, error } = await supabase.rpc('live_reminder_count', { sid: sessionId });
  fail(error);
  return typeof data === 'number' ? data : 0;
}

/* ================================================================== writes */

export type NewSession = {
  title: string;
  chat: boolean;
  requests: boolean;
  replay: boolean;
  notifyFollowers: boolean;
  /** Start time for a scheduled session; omit to go live now. */
  scheduledAt?: Date;
};

async function createLiveRoom(me: string, title: string): Promise<string> {
  const { data, error } = await supabase.from('rooms').insert({ host_id: me, kind: 'live', name: title }).select('id').single();
  fail(error);
  return (data as { id: string }).id;
}

/** Creates a session (live now, or scheduled). Returns its id. */
export async function createSession(me: string, s: NewSession): Promise<string> {
  const title = s.title.trim().slice(0, 80);
  if (!title) throw new Error('Give your session a title.');
  const base = { host_id: me, title, chat_enabled: s.chat, requests_enabled: s.requests, save_replay: s.replay, notify_followers: s.notifyFollowers };
  if (s.scheduledAt) {
    const { data, error } = await supabase.from('live_sessions').insert({ ...base, status: 'scheduled', scheduled_at: s.scheduledAt.toISOString() }).select('id').single();
    fail(error);
    return (data as { id: string }).id;
  }
  const roomId = await createLiveRoom(me, title);
  const { data, error } = await supabase.from('live_sessions').insert({ ...base, status: 'live', room_id: roomId }).select('id').single();
  if (error) {
    await supabase.from('rooms').delete().eq('id', roomId);
    fail(error);
  }
  return (data as { id: string }).id;
}

/** Host starts a scheduled session now. */
export async function startScheduled(me: string, s: Pick<LiveSession, 'id' | 'title'>): Promise<void> {
  const roomId = await createLiveRoom(me, s.title);
  const { error } = await supabase.from('live_sessions').update({ status: 'live', room_id: roomId }).eq('id', s.id);
  if (error) {
    await supabase.from('rooms').delete().eq('id', roomId);
    fail(error);
  }
}

/** Ends a live session, or cancels a scheduled one. */
export async function endSession(id: string): Promise<void> {
  const { error } = await supabase.from('live_sessions').update({ status: 'ended' }).eq('id', id);
  fail(error);
}

export async function deleteSession(id: string): Promise<void> {
  const { error } = await supabase.from('live_sessions').delete().eq('id', id);
  fail(error);
}

export async function setReminder(me: string, sessionId: string, on: boolean): Promise<void> {
  const { error } = on
    ? await supabase.from('live_reminders').upsert({ session_id: sessionId, user_id: me }, { onConflict: 'session_id,user_id', ignoreDuplicates: true })
    : await supabase.from('live_reminders').delete().eq('session_id', sessionId).eq('user_id', me);
  fail(error);
}

export async function setFollow(me: string, id: string, on: boolean): Promise<void> {
  const { error } = on
    ? await supabase.from('follows').upsert({ follower_id: me, following_id: id }, { onConflict: 'follower_id,following_id', ignoreDuplicates: true })
    : await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', id);
  fail(error);
  flash(on ? FLASH.followed : FLASH.unfollowed);
}

/* ================================================================== the live room hook */

type SyncPayload = { track: CatalogTrack | null; position: number; playing: boolean; at: number };
type RoomRow = { track: CatalogTrack | null; position_ms: number; is_playing: boolean; updated_at: string; is_open: boolean };
type MessageRow = { id: string; room_id: string; user_id: string; body: string; created_at: string };
export type Reaction = { key: string; icon: string; x: number };

const SYNC_EVERY_MS = 5_000;
const HEARTBEAT_MS = 20_000;
const DRIFT_S = 2.5;

/**
 * Everything the live room screen needs: session + room state, playback sync (host publishes,
 * listeners follow), presence listener count, chat, song requests and reactions.
 */
export function useLiveSession(id: string | undefined, me: string | undefined) {
  const player = usePlayerPick('track', 'playing');
  const { position } = usePlaybackProgress();
  const posRef = useRef(0);
  const playerRef = useRef(player);
  useEffect(() => {
    posRef.current = position;
    playerRef.current = player;
  });

  const [session, setSession] = useState<LiveSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const [hostState, setHostState] = useState<SyncPayload | null>(null);
  const [listeners, setListeners] = useState(0);
  const [people, setPeople] = useState<Record<string, { name: string; avatar: string | null }>>({});
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [following, setFollowingAlong] = useState(true);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const channel = useRef<RealtimeChannel | null>(null);

  const isHost = !!session && !!me && session.host_id === me;
  const roomId = session?.room_id ?? null;
  const live = session?.status === 'live';

  /* ---------------- load + join */
  const load = useCallback(async () => {
    if (!id || !me) return;
    setLoading(true);
    setError(null);
    try {
      // One automatic retry for network-level failures (join_live is idempotent: on conflict do nothing).
      const { s, row } = await retryOnNetworkError(async () => {
        const s = await loadSession(id);
        if (!s) throw new Error('This live session no longer exists.');
        if (s.status !== 'live' || !s.room_id) return { s, row: null };
        if (s.host_id !== me) {
          const j = await supabase.rpc('join_live', { sid: s.id });
          fail(j.error);
        }
        const r = await supabase.from('rooms').select('track, position_ms, is_playing, updated_at, is_open').eq('id', s.room_id).maybeSingle();
        // The room row only seeds the listener's position (the host's sync broadcast follows); a server error
        // here isn't fatal, a transport error is (retry / Try again).
        if (r.error && isNetworkError(r.error)) throw new NetworkError(LIVE_CONNECT_ERROR);
        return { s, row: (r.data as RoomRow | null) ?? null };
      });
      setSession(s);
      if (s.status === 'live' && s.room_id) {
        if (row?.is_open && s.host_id !== me) {
          const elapsed = row.is_playing ? Math.max(0, (Date.now() - new Date(row.updated_at).getTime()) / 1000) : 0;
          setHostState({ track: row.track, position: row.position_ms / 1000 + elapsed, playing: row.is_playing, at: Date.now() });
        }
        setJoined(true);
      }
    } catch (e) {
      setError(friendlyLiveError(e, 'Could not open this live session'));
    } finally {
      setLoading(false);
    }
  }, [id, me]);

  useEffect(() => {
    // Loading on mount / id change is the point of this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const nameOf = useCallback(
    async (uid: string) => {
      if (people[uid]) return;
      const { data } = await supabase.from('profiles').select('id, display_name, avatar_url').eq('id', uid).maybeSingle();
      const p = data as Person | null;
      if (p) setPeople((m) => ({ ...m, [p.id]: { name: p.display_name, avatar: p.avatar_url } }));
    },
    [people],
  );
  const nameOfRef = useRef(nameOf);
  useEffect(() => {
    nameOfRef.current = nameOf;
  }, [nameOf]);

  /* ---------------- chat + requests (room tables) */
  const loadRequests = useCallback(async () => {
    if (!roomId) return;
    const { data } = await supabase
      .from('room_queue')
      .select('id, track, added_by, votes, created_at, profiles(display_name)')
      .eq('room_id', roomId)
      .order('votes', { ascending: false })
      .order('created_at', { ascending: true });
    if (data) setRequests(data as unknown as RequestRow[]);
  }, [roomId]);

  const toLine = useCallback(
    (m: MessageRow, profile?: Person | null): ChatLine => ({
      key: m.id,
      user_id: m.user_id,
      name: profile?.display_name ?? '',
      avatar: profile?.avatar_url ?? null,
      text: m.body,
      created_at: m.created_at,
    }),
    [],
  );

  useEffect(() => {
    if (!roomId || !joined) return;
    let alive = true;
    void supabase
      .from('room_messages')
      .select('id, room_id, user_id, body, created_at, profiles(id, display_name, avatar_url)')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(40)
      .then(({ data, error: e }) => {
        if (!alive) return;
        if (e) {
          setNote({ ok: false, text: `Chat unavailable: ${friendlyLiveError(e)}` });
          return;
        }
        const rows = (data ?? []) as unknown as (MessageRow & { profiles: Person | null })[];
        setChat(rows.reverse().map((m) => toLine(m, m.profiles)));
        setPeople((map) => {
          const next = { ...map };
          for (const m of rows) if (m.profiles) next[m.user_id] = { name: m.profiles.display_name, avatar: m.profiles.avatar_url };
          return next;
        });
      });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRequests();
    const ch = supabase
      .channel(`live-room:${roomId}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${roomId}` }, (p) => {
        const m = p.new as MessageRow;
        void nameOfRef.current(m.user_id);
        setChat((list) => {
          if (list.some((x) => x.key === m.id)) return list;
          const i = list.findIndex((x) => x.pending && x.user_id === m.user_id && x.text === m.body);
          const line = toLine(m);
          if (i >= 0) return [...list.slice(0, i), line, ...list.slice(i + 1)];
          return [...list.slice(-39), line];
        });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_queue', filter: `room_id=eq.${roomId}` }, () => void loadRequests())
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'room_queue' }, () => void loadRequests())
      .subscribe();
    return () => {
      alive = false;
      void supabase.removeChannel(ch).then(undefined, () => undefined);
    };
  }, [roomId, joined, loadRequests, toLine]);

  /* ---------------- session row changes (toggles, ended) */
  useEffect(() => {
    if (!id) return;
    const ch = supabase
      .channel(`live-session:${id}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'live_sessions', filter: `id=eq.${id}` }, (p) =>
        setSession((s) => (s ? { ...s, ...(p.new as Omit<LiveSession, 'host'>) } : s)),
      )
      .subscribe();
    return () => void supabase.removeChannel(ch).then(undefined, () => undefined);
  }, [id]);

  /* ---------------- broadcast (sync + reactions) and presence (listener count) */
  const pushReaction = useCallback((icon: unknown) => {
    if (typeof icon !== 'string') return;
    const key = `${Date.now()}-${Math.random()}`;
    setReactions((list) => [...list.slice(-14), { key, icon, x: 0.1 + Math.random() * 0.8 }]);
    setTimeout(() => setReactions((list) => list.filter((x) => x.key !== key)), 2600);
  }, []);

  const sendSync = useCallback(() => {
    const p = playerRef.current;
    const payload: SyncPayload = { track: p.track, position: posRef.current, playing: p.playing, at: Date.now() };
    void channel.current?.send({ type: 'broadcast', event: 'sync', payload });
  }, []);

  useEffect(() => {
    if (!id || !me || !live || !joined) return;
    const hostId = session?.host_id;
    // Public topic on purpose (see the note at the top of this file). The host's presence key is their id (already
    // public in live_sessions.host_id); listeners use a random per-join key so the topic never lists who is listening.
    const presenceKey = hostId === me ? me : `l-${Math.random().toString(36).slice(2, 12)}`;
    const ch = supabase.channel(`live:${id}`, { config: { presence: { key: presenceKey }, broadcast: { self: false } } });
    ch.on('broadcast', { event: 'sync' }, (msg) => {
      const p = msg.payload as Partial<SyncPayload> | undefined;
      if (!p || typeof p.position !== 'number' || typeof p.playing !== 'boolean') return;
      // Clamp the host-clock delta so device clock skew can't throw the position far off.
      const latency = typeof p.at === 'number' ? Math.min(3, Math.max(0, (Date.now() - p.at) / 1000)) : 0;
      setHostState({ track: p.track ?? null, position: p.position + (p.playing ? latency : 0), playing: p.playing, at: Date.now() });
    })
      .on('broadcast', { event: 'hello' }, () => {
        if (hostId === me) sendSync();
      })
      .on('broadcast', { event: 'reaction' }, (msg) => pushReaction((msg.payload as { icon?: unknown } | undefined)?.icon))
      .on('presence', { event: 'sync' }, () => {
        const keys = Object.keys(ch.presenceState());
        setListeners(keys.filter((k) => k !== hostId).length);
      })
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return;
        void ch.track({ at: Date.now() });
        if (hostId !== me) void ch.send({ type: 'broadcast', event: 'hello', payload: {} });
        else sendSync();
      });
    channel.current = ch;
    return () => {
      channel.current = null;
      void supabase.removeChannel(ch).then(undefined, () => undefined);
    };
  }, [id, me, live, joined, session?.host_id, sendSync, pushReaction]);

  /* ---------------- host: publish playback, persist room state, heartbeat, replay tracklist */
  const lastKey = useRef('');
  useEffect(() => {
    if (!isHost || !live || !roomId || !session) return;
    const t = player.track;
    const key = `${t?.id ?? ''}|${player.playing}`;
    if (key === lastKey.current) return;
    const trackChanged = lastKey.current.split('|')[0] !== (t?.id ?? '');
    lastKey.current = key;
    sendSync();
    void supabase
      .from('rooms')
      .update({ track: t, is_playing: player.playing, position_ms: trackChanged ? 0 : Math.round(posRef.current * 1000), updated_at: new Date().toISOString() })
      .eq('id', roomId);
    if (trackChanged && t && session.save_replay) {
      void supabase
        .from('live_session_tracks')
        .insert({ session_id: session.id, track: t })
        .then(({ error: e }) => {
          if (e) setNote({ ok: false, text: `Replay: ${friendlyLiveError(e)}` });
        });
    }
  }, [isHost, live, roomId, session, player.track, player.playing, sendSync]);

  useEffect(() => {
    if (!isHost || !live || !roomId) return;
    const sync = setInterval(() => {
      if (!playerRef.current.playing) return;
      sendSync();
    }, SYNC_EVERY_MS);
    const persist = setInterval(() => {
      if (!playerRef.current.playing) return;
      void supabase.from('rooms').update({ position_ms: Math.round(posRef.current * 1000), updated_at: new Date().toISOString() }).eq('id', roomId).then(undefined, () => undefined);
    }, 10_000);
    return () => {
      clearInterval(sync);
      clearInterval(persist);
    };
  }, [isHost, live, roomId, sendSync]);

  const listenersRef = useRef(listeners);
  useEffect(() => {
    listenersRef.current = listeners;
  }, [listeners]);
  useEffect(() => {
    if (!isHost || !live || !id) return;
    const beat = () =>
      void supabase
        .from('live_sessions')
        .update({ heartbeat_at: new Date().toISOString(), listeners: listenersRef.current, peak_listeners: listenersRef.current })
        .eq('id', id);
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [isHost, live, id]);

  /* ---------------- listeners: follow the host */
  const contextLabel = session ? `Live · ${session.title}` : 'Live';
  useEffect(() => {
    if (isHost || !live || !following || !hostState?.track) return;
    const p = playerRef.current;
    const target = hostState.position;
    if (p.track?.id !== hostState.track.id) {
      const res = p.playTrack(hostState.track, contextLabel);
      if (!res.played) {
        setNote({ ok: false, text: res.reason ?? 'This song can’t play right now.' });
        return;
      }
      const timer = setTimeout(() => {
        playerRef.current.seekTo(target + 1);
        if (!hostState.playing) playerRef.current.pause();
      }, 1000);
      return () => clearTimeout(timer);
    }
    if (Math.abs(posRef.current - target) > DRIFT_S) p.seekTo(target);
    if (hostState.playing && !p.playing) p.play();
    else if (!hostState.playing && p.playing) p.pause();
    return undefined;
  }, [hostState, isHost, live, following, contextLabel]);

  const followAlong = useCallback((on: boolean) => {
    setFollowingAlong(on);
    if (on) void channel.current?.send({ type: 'broadcast', event: 'hello', payload: {} });
  }, []);

  /* ---------------- actions */
  const react = useCallback(
    (icon: string) => {
      pushReaction(icon);
      void channel.current?.send({ type: 'broadcast', event: 'reaction', payload: { icon } });
    },
    [pushReaction],
  );

  const say = useCallback(
    async (text: string) => {
      const t = text.trim().slice(0, 500);
      if (!t || !me || !roomId) return false;
      const tempKey = `temp-${Date.now()}`;
      setChat((list) => [...list.slice(-39), { key: tempKey, user_id: me, name: '', avatar: null, text: t, created_at: new Date().toISOString(), pending: true }]);
      const { data, error: e } = await supabase.from('room_messages').insert({ room_id: roomId, user_id: me, body: t }).select('id, room_id, user_id, body, created_at').single();
      if (e || !data) {
        setChat((list) => list.filter((x) => x.key !== tempKey));
        setNote({ ok: false, text: friendlyLiveError(e, 'Message not sent') });
        return false;
      }
      const line = toLine(data as MessageRow);
      setChat((list) => {
        const without = list.filter((x) => x.key !== tempKey);
        return without.some((x) => x.key === line.key) ? without : [...without, line];
      });
      return true;
    },
    [me, roomId, toLine],
  );

  const requestSong = useCallback(
    async (track: CatalogTrack) => {
      if (!me || !roomId) return;
      const { error: e } = await supabase.from('room_queue').insert({ room_id: roomId, track, added_by: me });
      setNote(e ? { ok: false, text: friendlyLiveError(e) } : { ok: true, text: isHost ? `Queued ${track.title}` : `Requested ${track.title}` });
      if (!e) void loadRequests();
    },
    [me, roomId, isHost, loadRequests],
  );

  const [voted, setVoted] = useState<Set<string>>(new Set());
  const vote = useCallback(
    async (r: RequestRow) => {
      if (voted.has(r.id)) return;
      setVoted((s) => new Set(s).add(r.id));
      setRequests((list) => list.map((x) => (x.id === r.id ? { ...x, votes: x.votes + 1 } : x)).sort((a, b) => b.votes - a.votes || a.created_at.localeCompare(b.created_at)));
      const { error: e } = await supabase.from('room_queue').update({ votes: r.votes + 1 }).eq('id', r.id);
      if (e) setNote({ ok: false, text: friendlyLiveError(e) });
    },
    [voted],
  );

  const removeRequest = useCallback(
    async (r: RequestRow) => {
      setRequests((list) => list.filter((x) => x.id !== r.id));
      const { error: e } = await supabase.from('room_queue').delete().eq('id', r.id);
      if (e) {
        setNote({ ok: false, text: friendlyLiveError(e) });
        void loadRequests();
      }
    },
    [loadRequests],
  );

  /** Host: play a request (or any track) for everyone. */
  const playForAll = useCallback(
    (track: CatalogTrack) => {
      const res = playerRef.current.playTrack(track, contextLabel);
      if (!res.played) setNote({ ok: false, text: res.reason ?? 'This song can’t play right now.' });
      return res.played > 0;
    },
    [contextLabel],
  );

  const playRequest = useCallback(
    async (r: RequestRow) => {
      if (playForAll(r.track)) await removeRequest(r);
    },
    [playForAll, removeRequest],
  );

  /** Host: the next song is the top request when there is one, otherwise the player's own queue. */
  const next = useCallback(async () => {
    const top = requests[0];
    if (top) await playRequest(top);
    else playerRef.current.next();
  }, [requests, playRequest]);

  const [ending, setEnding] = useState(false);
  const end = useCallback(async () => {
    if (!id) return false;
    setEnding(true);
    try {
      void channel.current?.send({ type: 'broadcast', event: 'sync', payload: { track: null, position: 0, playing: false, at: Date.now() } });
      await endSession(id);
      setSession((s) => (s ? { ...s, status: 'ended', ended_at: new Date().toISOString() } : s));
      return true;
    } catch (e) {
      setNote({ ok: false, text: friendlyLiveError(e, 'Could not end the session') });
      return false;
    } finally {
      setEnding(false);
    }
  }, [id]);

  const updateToggles = useCallback(
    async (patch: Partial<Pick<LiveSession, 'chat_enabled' | 'requests_enabled'>>) => {
      if (!id) return;
      const before = session;
      setSession((s) => (s ? { ...s, ...patch } : s));
      const { error: e } = await supabase.from('live_sessions').update(patch).eq('id', id);
      if (e) {
        setSession(before);
        setNote({ ok: false, text: friendlyLiveError(e) });
      }
    },
    [id, session],
  );

  return {
    session,
    setSession,
    loading,
    error,
    reload: load,
    isHost,
    live,
    hostState,
    listeners,
    people,
    chat,
    requests,
    reactions,
    following,
    followAlong,
    note,
    setNote,
    voted,
    react,
    say,
    requestSong,
    vote,
    removeRequest,
    playForAll,
    playRequest,
    next,
    end,
    ending,
    updateToggles,
  };
}

export type LiveApi = ReturnType<typeof useLiveSession>;
