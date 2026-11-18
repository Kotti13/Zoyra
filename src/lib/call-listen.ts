/**
 * Listening together during a 1:1 call ("PLAYING FOR BOTH OF YOU").
 *
 * - Every shared song is a `call_tracks` row (supabase/migrations/20261115210000_calls_extras.sql), so both
 *   sides see it (realtime) and the ended screen can list "You listened to N songs together".
 * - Playback is kept in step with a small realtime broadcast on the private topic `call-listen:<call id>`
 *   (src/lib/realtime.ts; only the two participants may join):
 *     play   { track_id, position, playing, sent_at }  start / jump to this shared song at this position
 *     pause  { position }                              pause for both
 *     resume { position, sent_at }                     resume for both
 *     hello  {}                                        "I just joined": whoever is playing the shared song answers with `play`
 *   Only songs recorded in call_tracks (RLS: participants only) are ever played from a broadcast.
 * - <CallListenHost /> (mounted by CallHost while a call is active) owns the channel and the player wiring;
 *   screens read `useCallListen()` and call shareSong() / toggleSharedPause().
 * - The caller's current song is shared automatically when they place the call (the "Listening to …" chip on
 *   the incoming screen), unless Message privacy → Show now playing is off.
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { useAuth } from '../state/auth';
import { usePlayer } from '../state/player';
import type { CatalogTrack } from './catalog';
import { addCallTrack, CallError, loadCallTracks, type Call, type CallTrack } from './calls';
import { dmSettings } from './dm';
import { privateChannel } from './realtime';
import { supabase } from './supabase';

export type CallListen = {
  callId: string;
  /** Every share in this call, oldest first. */
  tracks: CallTrack[];
  /** The song currently shared for both of you (last share / last `play`), or null. */
  shared: CatalogTrack | null;
  error: string | null;
};

type Payload = { track_id?: unknown; position?: unknown; playing?: unknown; sent_at?: unknown };

const CONTEXT = 'Listening together';
/** Re-seek only when the two sides drift further apart than this (seconds). */
const DRIFT_S = 2;

let state: CallListen | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (callId: string, p: Partial<CallListen>) => {
  if (!state || state.callId !== callId) return;
  state = { ...state, ...p };
  emit();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => state;

/** Shared-listening state of the active call (null when no call is active). */
export function useCallListen(callId: string | null | undefined): CallListen | null {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  return s && callId && s.callId === callId ? s : null;
}

/** Actions bound by the host to the live player + channel. */
type Actions = { share: (t: CatalogTrack) => Promise<string | null>; togglePause: () => void };
let actions: Actions | null = null;

/** Shares a song with the other person and starts it for both. Resolves with an error message or null. */
export function shareSong(track: CatalogTrack): Promise<string | null> {
  return actions ? actions.share(track) : Promise.resolve('Listening together starts once the call is on.');
}

/** Pauses / resumes the shared song for both of you. */
export function toggleSharedPause(): void {
  actions?.togglePause();
}

const elapsedSince = (sentAt: unknown) => {
  const t = typeof sentAt === 'number' ? sentAt : 0;
  // Device clocks differ: trust at most a few seconds of transit time.
  return t ? Math.min(3, Math.max(0, (Date.now() - t) / 1000)) : 0;
};

/**
 * Owns the listening-together channel for `call` and drives the local player. Mount once (CallHost) while a
 * call session exists.
 */
export function useCallListenHost(call: Call | null): void {
  const { user, settings } = useAuth();
  const me = user?.id ?? null;
  const player = usePlayer();
  const callId = call?.id ?? null;
  const accepted = call?.status === 'accepted';
  const live = call?.status === 'ringing' || call?.status === 'accepted';

  // Latest values for the long-lived channel callbacks.
  const ref = useRef({ player, accepted, me, position: () => player.playlist.currentTime || 0 });
  useEffect(() => {
    ref.current = { player, accepted, me, position: () => player.playlist.currentTime || 0 };
  });
  const channelRef = useRef<RealtimeChannel | null>(null);
  const subscribed = useRef(false);
  /** Seek to apply once the shared track has loaded: target position at `at` (device ms). */
  const pendingSeek = useRef<{ trackId: string; position: number; at: number; playing: boolean } | null>(null);

  // State + channel per call.
  useEffect(() => {
    if (!callId || !me) return;
    state = { callId, tracks: [], shared: null, error: null };
    emit();
    let alive = true;

    const merge = (rows: CallTrack[]) => {
      if (!state || state.callId !== callId) return;
      const byId = new Map(state.tracks.map((r) => [r.id, r]));
      const fresh = rows.some((r) => !byId.has(r.id));
      rows.forEach((r) => byId.set(r.id, r));
      const tracks = [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
      // A new share becomes the song playing for both (its `play` broadcast follows).
      set(callId, { tracks, shared: fresh ? (tracks[tracks.length - 1]?.track ?? null) : state.shared });
    };

    const known = async (trackId: string): Promise<CatalogTrack | null> => {
      const find = () => state?.tracks.find((r) => r.track.id === trackId)?.track ?? null;
      const hit = find();
      if (hit) return hit;
      merge(await loadCallTracks(callId));
      return find();
    };

    const send = (event: 'play' | 'pause' | 'resume' | 'hello', payload: Record<string, unknown> = {}) => {
      const ch = channelRef.current;
      if (!ch || !subscribed.current) return;
      void ch.send({ type: 'broadcast', event, payload: { ...payload, sent_at: Date.now() } });
    };

    /** Tells the other side what I'm playing (if it is the shared song). */
    const announce = () => {
      const { player: p, position: pos } = ref.current;
      const shared = state?.shared;
      if (!shared || p.track?.id !== shared.id) return;
      send('play', { track_id: shared.id, position: pos(), playing: p.playing });
    };

    const onPlay = async (pl: Payload) => {
      if (!ref.current.accepted || typeof pl.track_id !== 'string') return;
      const track = await known(pl.track_id);
      if (!alive || !track) return;
      set(callId, { shared: track });
      const target = (typeof pl.position === 'number' ? pl.position : 0) + (pl.playing === false ? 0 : elapsedSince(pl.sent_at));
      const playing = pl.playing !== false;
      const p = ref.current.player;
      if (p.track?.id === track.id) {
        if (Math.abs(ref.current.position() - target) > DRIFT_S) p.seekTo(target);
        if (playing && !p.playing) p.play();
        if (!playing && p.playing) p.pause();
        return;
      }
      p.playTrack(track, CONTEXT);
      pendingSeek.current = { trackId: track.id, position: target, at: Date.now(), playing };
    };

    // Private topic: only the caller and callee may join / broadcast (realtime.messages policy).
    const ch = privateChannel(`call-listen:${callId}`, { broadcast: { self: false } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_tracks', filter: `call_id=eq.${callId}` }, (payload) => {
        const row = payload.new as CallTrack | undefined;
        if (row?.id && row.track?.id) merge([row]);
      })
      .on('broadcast', { event: 'play' }, ({ payload }) => void onPlay((payload ?? {}) as Payload))
      .on('broadcast', { event: 'pause' }, ({ payload }) => {
        const pl = (payload ?? {}) as Payload;
        const p = ref.current.player;
        const shared = state?.shared;
        if (!ref.current.accepted || !shared || p.track?.id !== shared.id) return;
        if (p.playing) p.pause();
        if (typeof pl.position === 'number' && Math.abs(ref.current.position() - pl.position) > DRIFT_S) p.seekTo(pl.position);
      })
      .on('broadcast', { event: 'resume' }, ({ payload }) => {
        const pl = (payload ?? {}) as Payload;
        const p = ref.current.player;
        const shared = state?.shared;
        if (!ref.current.accepted || !shared || p.track?.id !== shared.id) return;
        if (typeof pl.position === 'number') {
          const target = pl.position + elapsedSince(pl.sent_at);
          if (Math.abs(ref.current.position() - target) > DRIFT_S) p.seekTo(target);
        }
        if (!p.playing) p.play();
      })
      .on('broadcast', { event: 'hello' }, () => {
        if (ref.current.accepted) announce();
      })
      .subscribe((status) => {
        subscribed.current = status === 'SUBSCRIBED';
        if (subscribed.current && ref.current.accepted) {
          send('hello');
          announce();
        }
      });
    channelRef.current = ch;
    void loadCallTracks(callId).then((rows) => alive && merge(rows));

    actions = {
      share: async (track) => {
        const uid = ref.current.me;
        if (!uid) return 'Sign in to share songs.';
        if (track.id.startsWith('local:')) return "Songs from your device can't be shared.";
        try {
          const row = await addCallTrack(callId, uid, track);
          merge([row]);
          set(callId, { shared: row.track, error: null });
          const p = ref.current.player;
          let pos = 0;
          if (p.track?.id === track.id) {
            pos = ref.current.position();
            if (!p.playing) p.play();
          } else {
            p.playTrack(track, CONTEXT);
          }
          if (ref.current.accepted) send('play', { track_id: track.id, position: pos, playing: true });
          return null;
        } catch (e) {
          const msg = e instanceof CallError ? e.message : "Couldn't share the song. Try again.";
          set(callId, { error: msg });
          return msg;
        }
      },
      togglePause: () => {
        const p = ref.current.player;
        const shared = state?.shared;
        if (!shared) return;
        if (p.track?.id !== shared.id) {
          // Resume the shared song after the user played something else.
          p.playTrack(shared, CONTEXT);
          send('play', { track_id: shared.id, position: 0, playing: true });
          return;
        }
        if (p.playing) {
          p.pause();
          send('pause', { position: ref.current.position() });
        } else {
          p.play();
          send('resume', { position: ref.current.position() });
        }
      },
    };

    return () => {
      alive = false;
      actions = null;
      subscribed.current = false;
      channelRef.current = null;
      pendingSeek.current = null;
      void supabase.removeChannel(ch);
      if (state?.callId === callId) {
        state = null;
        emit();
      }
    };
  }, [callId, me]);

  // Once connected: say hello (the other side answers with what's playing) and announce mine.
  useEffect(() => {
    if (!accepted || !subscribed.current || !channelRef.current) return;
    void channelRef.current.send({ type: 'broadcast', event: 'hello', payload: { sent_at: Date.now() } });
    const shared = state?.shared;
    const p = ref.current.player;
    if (shared && p.track?.id === shared.id) {
      void channelRef.current.send({ type: 'broadcast', event: 'play', payload: { track_id: shared.id, position: ref.current.position(), playing: p.playing, sent_at: Date.now() } });
    }
  }, [accepted]);

  // Apply a pending seek once the shared track is the current one.
  const trackId = player.track?.id;
  useEffect(() => {
    const ps = pendingSeek.current;
    if (!ps || trackId !== ps.trackId) return;
    const t = setTimeout(() => {
      const cur = pendingSeek.current;
      if (!cur || ref.current.player.track?.id !== cur.trackId) return;
      pendingSeek.current = null;
      const target = cur.position + (cur.playing ? (Date.now() - cur.at) / 1000 : 0);
      if (target > 1) ref.current.player.seekTo(target);
      if (!cur.playing) ref.current.player.pause();
    }, 700);
    return () => clearTimeout(t);
  }, [trackId]);

  // The caller's current song is shared when the call is placed (the incoming "Listening to …" chip).
  const iAmCaller = !!call && !!me && call.caller_id === me;
  const shareNowPlaying = dmSettings(settings?.dm).now_playing;
  const autoShared = useRef<string | null>(null);
  useEffect(() => {
    if (!callId || !iAmCaller || !live || call?.status !== 'ringing' || autoShared.current === callId) return;
    const t = ref.current.player.track;
    if (!shareNowPlaying || !t || !ref.current.player.playing || t.id.startsWith('local:')) return;
    autoShared.current = callId;
    void addCallTrack(callId, me as string, t)
      .then((row) => {
        if (state?.callId !== callId) return;
        set(callId, { tracks: [...state.tracks.filter((r) => r.id !== row.id), row], shared: row.track });
      })
      .catch(() => undefined);
  }, [callId, iAmCaller, live, call?.status, shareNowPlaying, me]);
}
