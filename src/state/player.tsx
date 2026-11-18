import {
  setAudioModeAsync,
  useAudioPlaylist,
  type AudioLockScreenOptions,
  type AudioMetadata,
  type AudioPlaylist,
  type AudioPlaylistLoopMode,
} from 'expo-audio';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { getPlayPref, playPrefsReady, setPlayPref, type LastSession } from '../lib/play-prefs';
import { clockAt, initialClock, reconcileClock, resetClock, seekClock, type ClockState } from '../lib/lyrics-sync';
import { getPref } from '../lib/prefs';
import { catalog, type CatalogTrack } from '../lib/catalog';
import { filterHidden, isTrackHidden, looksExplicit } from '../lib/content-filter';
import { downloads } from '../lib/downloads';
import { flash } from '../lib/flash';
import { addLockScreenActionListener, setLockScreenButtons, type LockScreenAction } from '../lib/lock-screen';
import { isLocalTrack, localMusic, toFileUri, UNKNOWN_ALBUM } from '../lib/local-music';
import { supabase } from '../lib/supabase';
import { usage } from '../lib/usage';
import { zoyra } from '../lib/zoyra-api';
import { useAuth } from './auth';
import { useLibrary } from './library';

export type RepeatMode = 'off' | 'all' | 'one';
export type SleepTimer = ({ endsAt: number; minutes: number } | { endOfTrack: true }) & { fadeOut?: boolean } | null;
export type SleepTimerOptions = {
  /** Ramp the volume to 0 over the last 30 s before pausing (default true). */
  fadeOut?: boolean;
};
export type PlayOptions = {
  /** Hide title/artist/artwork on the lock screen and notification (e.g. the music quiz). */
  hideMetadata?: boolean;
};
export type PlayResult = { played: number; skipped: number; reason?: string };

const FADE_MS = 30_000;
/** "Resume where I left off": save the position at most this often while playing. */
const SESSION_SAVE_MS = 15_000;
/** Tracks kept in the saved session (from the current one on). */
const SESSION_MAX = 100;
/** Similar songs added when the queue runs out ("Autoplay similar"). */
const AUTOPLAY_COUNT = 15;

type PlayerState = {
  /** Current track (null until something is played). */
  track: CatalogTrack | null;
  queue: CatalogTrack[];
  index: number;
  playing: boolean;
  buffering: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  rate: number;
  context: string | null;
  sleep: SleepTimer;
  playlist: AudioPlaylist;

  /** Shown over the app when playback had to skip something (e.g. offline and not downloaded). */
  notice: string | null;
  /**
   * Plays a list. Downloaded tracks play from the local file. While offline, tracks that aren't
   * downloaded are skipped and `notice` explains why.
   */
  playTracks: (tracks: CatalogTrack[], startIndex?: number, context?: string, opts?: PlayOptions) => PlayResult;
  playTrack: (track: CatalogTrack, context?: string, opts?: PlayOptions) => PlayResult;
  toggle: () => void;
  play: () => void;
  pause: () => void;
  next: () => void;
  previous: () => void;
  skipTo: (index: number) => void;
  seekTo: (seconds: number) => void;
  setShuffle: (on: boolean) => void;
  cycleRepeat: () => void;
  setRate: (rate: number) => void;
  addToQueue: (track: CatalogTrack) => void;
  playNext: (track: CatalogTrack) => void;
  removeFromQueue: (index: number) => void;
  moveInQueue: (from: number, to: number) => void;
  clearUpNext: () => void;
  setSleepTimer: (minutes: number | 'endOfTrack' | null, opts?: SleepTimerOptions) => void;
  /** Turns fade-out on/off for the running timer without restarting it. */
  setSleepFade: (on: boolean) => void;
  /**
   * Lowers the music to `level` (0..1) while something talks over it (AI DJ); `null` releases it.
   * The player owns the final volume (sleep fade × smooth transition, capped by the duck level),
   * so callers never write `playlist.volume` themselves.
   */
  duck: (level: number | null) => void;
};

const Ctx = createContext<PlayerState | null>(null);

/**
 * Same state as `Ctx`, as an external store. Components that only need a slice (is *this* row the
 * current track? is it playing?) subscribe with `usePlayerSelector` and re-render only when their
 * slice changes, instead of on every play/pause/buffering/queue change like `usePlayer()` consumers.
 */
type PlayerStore = { get: () => PlayerState; set: (v: PlayerState) => void; subscribe: (l: () => void) => () => void };
const StoreCtx = createContext<PlayerStore | null>(null);

function createPlayerStore(initial: PlayerState): PlayerStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (v) => {
      if (v === current) return;
      current = v;
      listeners.forEach((l) => l());
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** Stable action surface: identity never changes, every call goes to the latest player state. */
export type PlayerActions = Pick<
  PlayerState,
  | 'playTracks'
  | 'playTrack'
  | 'toggle'
  | 'play'
  | 'pause'
  | 'next'
  | 'previous'
  | 'skipTo'
  | 'seekTo'
  | 'setShuffle'
  | 'cycleRepeat'
  | 'setRate'
  | 'addToQueue'
  | 'playNext'
  | 'removeFromQueue'
  | 'moveInQueue'
  | 'clearUpNext'
  | 'setSleepTimer'
  | 'setSleepFade'
  | 'duck'
> & {
  /** Current state snapshot for event handlers (does not subscribe / re-render). */
  getState: () => PlayerState;
};

function createActions(store: PlayerStore): PlayerActions {
  const s = store.get;
  return {
    getState: s,
    playTracks: (...a) => s().playTracks(...a),
    playTrack: (...a) => s().playTrack(...a),
    toggle: () => s().toggle(),
    play: () => s().play(),
    pause: () => s().pause(),
    next: () => s().next(),
    previous: () => s().previous(),
    skipTo: (i) => s().skipTo(i),
    seekTo: (x) => s().seekTo(x),
    setShuffle: (on) => s().setShuffle(on),
    cycleRepeat: () => s().cycleRepeat(),
    setRate: (r) => s().setRate(r),
    addToQueue: (t) => s().addToQueue(t),
    playNext: (t) => s().playNext(t),
    removeFromQueue: (i) => s().removeFromQueue(i),
    moveInQueue: (f, t) => s().moveInQueue(f, t),
    clearUpNext: () => s().clearUpNext(),
    setSleepTimer: (m, o) => s().setSleepTimer(m, o),
    setSleepFade: (on) => s().setSleepFade(on),
    duck: (l) => s().duck(l),
  };
}
const ActionsCtx = createContext<PlayerActions | null>(null);

/* ---------- playback clock */

/** Monotonic wall clock in ms (performance.now when available). */
const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

/**
 * Smooth, accurate playback position. Native status ticks arrive every {@link STATUS_INTERVAL_MS};
 * between them the position is interpolated from the last tick (`base + elapsed × rate`), frozen
 * while paused/buffering, snapped on seeks, stalls and track changes (see `reconcileClock`).
 * Subscribers are notified only when the clock's segment changes (not every frame), so they can
 * schedule work (next lyric line) or restart a native-driven animation.
 */
export type PlaybackClock = {
  /** Interpolated audio position in seconds, right now. */
  now: () => number;
  state: () => ClockState;
  /** Id of the track the clock is running for (null before the first status). */
  trackId: () => string | null;
  subscribe: (l: () => void) => () => void;
};

type ClockWriter = PlaybackClock & {
  sample: (s: Parameters<typeof reconcileClock>[1], trackId: string | null) => void;
  seek: (seconds: number) => void;
  reset: (index: number, trackId: string | null) => void;
};

function createClock(): ClockWriter {
  let st = initialClock();
  let track: string | null = null;
  const listeners = new Set<() => void>();
  const set = (next: ClockState, id: string | null) => {
    if (next === st && id === track) return;
    st = next;
    track = id;
    listeners.forEach((l) => l());
  };
  return {
    now: () => clockAt(st, nowMs()),
    state: () => st,
    trackId: () => track,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    sample: (smp, id) => set(reconcileClock(st, smp, nowMs()), id ?? track),
    seek: (seconds) => set(seekClock(st, seconds, nowMs()), track),
    reset: (index, id) => set(resetClock(st, index, nowMs()), id),
  };
}

/**
 * Coarse position for progress bars and time labels: republished at most about twice a second
 * (or at once on a seek / duration change), so the faster native status rate used by the lyric
 * clock doesn't re-render every progress consumer more often than before.
 */
type Progress = { position: number; duration: number };
type ProgressStore = { get: () => Progress; subscribe: (l: () => void) => () => void; push: (p: Progress) => void };
function createProgressStore(): ProgressStore {
  let cur: Progress = { position: 0, duration: 0 };
  const listeners = new Set<() => void>();
  return {
    get: () => cur,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    push: (p) => {
      const sameHalf = Math.floor(p.position * 2) === Math.floor(cur.position * 2) && Math.abs(p.position - cur.position) < 0.6;
      if (sameHalf && p.duration === cur.duration) return;
      cur = p;
      listeners.forEach((l) => l());
    },
  };
}

/** Native status rate. The lyric clock interpolates between ticks; progress UI is throttled to ~2 Hz. */
const STATUS_INTERVAL_MS = 250;
/** A device file that isn't ready after this long is treated as unplayable (notice instead of a silent 0:00). */
const LOCAL_LOAD_TIMEOUT_MS = 5000;
export const LOCAL_PLAY_FAILED = 'Couldn’t play this file';

const ClockCtx = createContext<{ clock: PlaybackClock; progress: ProgressStore } | null>(null);

const loopFor = (r: RepeatMode): AudioPlaylistLoopMode => (r === 'one' ? 'single' : r === 'all' ? 'all' : 'none');

const shuffled = <T,>(arr: T[]) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Smart shuffle: random order but avoid the same artist back-to-back when possible. */
function smartShuffle(tracks: CatalogTrack[]) {
  const pool = shuffled(tracks);
  const out: CatalogTrack[] = [];
  while (pool.length) {
    const last = out[out.length - 1];
    const i = pool.findIndex((t) => !last || t.artist.id !== last.artist.id);
    out.push(pool.splice(i === -1 ? 0 : i, 1)[0]);
  }
  return out;
}

/**
 * Native playlist setters. expo-audio exposes these as mutable properties on the hook's object;
 * routing writes through plain functions keeps the React Compiler's immutability lint satisfied.
 */
const setVolume = (p: AudioPlaylist, v: number) => {
  p.volume = v;
};
const setLoop = (p: AudioPlaylist, l: AudioPlaylistLoopMode) => {
  p.loop = l;
};
const setPlaybackRate = (p: AudioPlaylist, r: number) => {
  p.playbackRate = r;
};

export { isLocalTrack };

/**
 * File URI of a device-library track (`local:` id): local-music's registry first, then the
 * `localUri` it puts on the track object (survives a track restored from a list/snapshot).
 */
function deviceUri(t: CatalogTrack): string | null {
  const m: CatalogTrack & { localUri?: string } = t;
  const uri = localMusic.uriFor(t.id) ?? m.localUri ?? null;
  // expo-audio (Android) treats a scheme-less string as a res/raw resource name: always hand it a URI.
  return uri ? toFileUri(uri) : null;
}

/** Track ids whose latest queued source is on the device (for data usage: no data vs streamed). */
const queuedLocal = new Set<string>();

/** Device file for local tracks, downloaded file when available (works offline), stream otherwise. */
const sourceFor = (t: CatalogTrack) => {
  const local = isLocalTrack(t) ? deviceUri(t) : downloads.localUri(t.id);
  if (local) queuedLocal.add(t.id);
  else queuedLocal.delete(t.id);
  // Non-Audius items (LibriVox chapters) carry their own public stream URL.
  return { uri: local ?? t.streamUrl ?? catalog.streamUrl(t.id) };
};

/** Can this track play without a network connection? */
const playableOffline = (t: CatalogTrack) => (isLocalTrack(t) ? !!deviceUri(t) : downloads.isDownloaded(t.id));

/** "Wi-Fi only streaming" is on and the device is on mobile data (or another metered link). */
const wifiOnlyBlocked = () => {
  if (!getPref('wifiOnlyStreaming', false) || !downloads.isOnline()) return false;
  const c = downloads.getSnapshot().connection;
  return c !== 'wifi' && c !== 'ethernet' && c !== 'unknown';
};
/** Streaming isn't possible right now; only downloaded or device files can play. */
const streamBlockedReason = (many: boolean): string | null => {
  if (!downloads.isOnline()) return many ? 'You are offline and none of these songs are downloaded.' : 'You are offline and this song isn’t downloaded.';
  if (wifiOnlyBlocked()) return many ? 'Wi-Fi only streaming is on and none of these songs are downloaded.' : 'Wi-Fi only streaming is on and this song isn’t downloaded.';
  return null;
};

/**
 * System media controls (lock screen, Control Center, Android media notification). expo-audio
 * renders play/pause, scrubbing, previous/next and ±10 s seek. iOS shows the seek buttons only when
 * the matching previous/next command is unavailable (e.g. a single-track queue). Android also gets
 * Shuffle and Like buttons through our expo-audio patch (`src/lib/lock-screen.ts`); iOS and cast
 * buttons aren't available on the system card.
 */
const lockScreenOptions: AudioLockScreenOptions = {
  showNextTrack: true,
  showPreviousTrack: true,
  showSeekForward: true,
  showSeekBackward: true,
  seekForwardIntervalSeconds: 10,
  seekBackwardIntervalSeconds: 10,
};

/** Album name for the system card: the device file's folder album, otherwise the app name. */
const albumFor = (t: CatalogTrack): string => {
  if (!isLocalTrack(t)) return 'Zoyra';
  const album = localMusic.metaFor(t.id)?.album;
  return album && album !== UNKNOWN_ALBUM ? album : 'Zoyra';
};

/** Lock-screen artwork: the downloaded copy when there is one (works offline), else the remote art. */
const artworkFor = (t: CatalogTrack): string | undefined =>
  downloads.localArtwork(t.id) ?? t.artwork.large ?? t.artwork.medium ?? t.artwork.small ?? undefined;

/** Full metadata for every track change; the quiz hides the answer. */
const lockMetaFor = (t: CatalogTrack, hide: boolean): AudioMetadata =>
  hide
    ? { title: 'Zoyra Quiz', artist: 'Guess the song', albumTitle: 'Zoyra' }
    : { title: t.title, artist: t.artist.name, albumTitle: albumFor(t), artworkUrl: artworkFor(t) };

/**
 * Real playback engine on expo-audio's native playlist.
 * - Background audio + lock-screen / notification controls (play, pause, next, previous, scrub).
 * - Logs every play to Supabase `play_history` (powers Recent, Insights, Wrapped, streaks, friend activity).
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const playlist = useAudioPlaylist({ updateInterval: STATUS_INTERVAL_MS, loop: 'none' });
  const [clock] = useState(createClock);
  const [progressStore] = useState(createProgressStore);
  const [clockCtx] = useState(() => ({ clock, progress: progressStore }));
  const [queue, setQueue] = useState<CatalogTrack[]>([]);
  const [original, setOriginal] = useState<CatalogTrack[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [shuffle, setShuffleState] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>('off');
  const [rate, setRateState] = useState(1);
  const [context, setContext] = useState<string | null>(null);
  const [sleep, setSleep] = useState<SleepTimer>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);
  useEffect(() => () => void (noticeTimer.current && clearTimeout(noticeTimer.current)), []);
  const hideMetaRef = useRef(false);
  /*
   * Volume mixer. Final volume = min(sleepGain × transitionGain, duckLevel). Only the player writes
   * `playlist.volume`, so the sleep fade, smooth transitions and AI DJ ducking never fight.
   */
  const sleepGain = useRef(1);
  const transGain = useRef(1);
  const duckLevel = useRef<number | null>(null);
  const lastVol = useRef<number | null>(null);
  /** The current track started by the previous one ending: ramp it in. */
  const fadeInPending = useRef(false);
  /** Seconds left on the current track at the last mixer tick (tells natural ends from skips). */
  const lastLeft = useRef(Number.POSITIVE_INFINITY);
  /** Wall clock of the previous status tick while playing (data usage estimate). */
  const usageTick = useRef<number | null>(null);
  /** Restored session: seek here once the track has loaded. */
  const pendingSeek = useRef<number | null>(null);
  /** Restored paused: start counting the listen when the user presses play. */
  const restoredPending = useRef(false);
  /** Local track id we already told the user couldn't be played (one notice per attempt). */
  const localFailNotified = useRef<string | null>(null);
  /** Bumped on every queue load so replaying the same file re-arms the watchdog. */
  const [loadSeq, setLoadSeq] = useState(0);
  const lastSessionSave = useRef(0);
  const autoplayBusy = useRef(false);
  const wasPlaying = useRef(false);
  const contextRef = useRef<string | null>(null);

  const queueRef = useRef(queue);
  const sleepRef = useRef(sleep);
  const listenStart = useRef<{ trackId: string; at: number } | null>(null);
  const lockActive = useRef(false);
  const { settings, user } = useAuth();
  const { isLiked, toggleLike } = useLibrary();
  const privateRef = useRef(false);
  const crossfadeRef = useRef(0);
  /** Kid-safe mode (user_settings.privacy.hide_explicit; off unless the user turns it on). */
  const kidSafeRef = useRef(true);
  const repeatRef = useRef(repeat);
  // Latest values for native event listeners (synced before any effect or event can read them).
  useLayoutEffect(() => {
    queueRef.current = queue;
    sleepRef.current = sleep;
    privateRef.current = Boolean(settings?.privacy?.private_session);
    kidSafeRef.current = (settings?.privacy?.hide_explicit ?? false) || settings?.kids?.on === true;
    crossfadeRef.current = Math.max(0, Math.min(12, settings?.crossfade_seconds ?? 0));
    repeatRef.current = repeat;
    contextRef.current = context;
  });

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' }).catch(() => {});
  }, []);

  /* ---------- history logging */
  const logListen = useCallback(async () => {
    const s = listenStart.current;
    listenStart.current = null;
    if (!s || privateRef.current) return; // private session: never record history
    const seconds = Math.round((Date.now() - s.at) / 1000);
    const t = queueRef.current.find((q) => q.id === s.trackId);
    if (!t || seconds < 10) return; // skip accidental taps
    if (isLocalTrack(t)) return; // device files stay on the device: no server writes
    if (t.id.startsWith('librivox:')) return; // audiobook chapters aren't songs: keep them out of play history
    const { data } = await supabase.auth.getSession();
    if (!data.session) return;
    await supabase.from('play_history').insert({
      user_id: data.session.user.id,
      track_id: t.id,
      track: t,
      context,
      seconds_listened: Math.min(seconds, Math.ceil(t.duration)),
    });
  }, [context]);

  /* ---------- lock screen metadata */
  const updateLockScreen = useCallback(
    (t: CatalogTrack | undefined) => {
      if (!t) return;
      const meta = lockMetaFor(t, hideMetaRef.current);
      if (!lockActive.current) {
        playlist.setActiveForLockScreen(true, meta, lockScreenOptions);
        lockActive.current = true;
      } else {
        playlist.updateLockScreenMetadata(meta);
      }
    },
    [playlist],
  );

  const applyVolume = useCallback(() => {
    const v = Math.max(0, Math.min(1, sleepGain.current * transGain.current, duckLevel.current ?? 1));
    if (lastVol.current !== null && Math.abs(v - lastVol.current) < 0.004) return;
    setVolume(playlist, v);
    lastVol.current = v;
  }, [playlist]);

  /** Ends the sleep fade (timer finished or cancelled). */
  const restoreVolume = useCallback(() => {
    sleepGain.current = 1;
    applyVolume();
  }, [applyVolume]);

  /* ---------- "Resume where I left off" (device pref) */
  /** Saves the queue from the current track on, and the position in it. Never saves hidden (quiz) playback. */
  const saveSession = useCallback(() => {
    lastSessionSave.current = Date.now();
    if (!getPlayPref('playback.resume') || hideMetaRef.current || restoredPending.current) return;
    const q = queueRef.current;
    const i = Math.min(Math.max(0, playlist.currentIndex), q.length - 1);
    if (!q[i]) return;
    const session: LastSession = {
      queue: q.slice(i, i + SESSION_MAX),
      index: 0,
      position: Math.max(0, Math.floor(playlist.currentTime || 0)),
      context: contextRef.current,
      savedAt: Date.now(),
    };
    setPlayPref('playback.lastSession', session);
  }, [playlist]);

  /* ---------- "Autoplay similar" (device pref) */
  /**
   * The queue ran out: add songs by the same artist and from the same genre (Audius catalogue) and
   * keep playing. Skipped while streaming is blocked (offline / Wi-Fi only) or for hidden playback.
   */
  const extendWithSimilar = useCallback(async () => {
    if (autoplayBusy.current || hideMetaRef.current || !getPlayPref('playback.autoplaySimilar')) return;
    const q = queueRef.current;
    const last = q[q.length - 1];
    if (!last || streamBlockedReason(false) || last.id.startsWith('librivox:')) return; // no "similar songs" after an audiobook
    autoplayBusy.current = true;
    try {
      const [byArtist, byGenre] = await Promise.all([
        isLocalTrack(last) ? Promise.resolve<CatalogTrack[]>([]) : catalog.artistTracks(last.artist.id, 20).catch(() => [] as CatalogTrack[]),
        last.genre ? catalog.trending({ genre: last.genre, limit: 40 }).catch(() => [] as CatalogTrack[]) : Promise.resolve<CatalogTrack[]>([]),
      ]);
      // The user started something else while we were fetching: leave it alone.
      if (queueRef.current !== q || playlist.playing) return;
      const seen = new Set(q.map((t) => t.id));
      // Never autoplay hidden songs / artists, or explicit songs in kid-safe mode.
      const pick = (list: CatalogTrack[], n: number) => shuffled(filterHidden(list, kidSafeRef.current).filter((t) => !seen.has(t.id))).slice(0, n).map((t) => (seen.add(t.id), t));
      const artistPicks = pick(byArtist, 5);
      const picks = smartShuffle([...artistPicks, ...pick(byGenre, AUTOPLAY_COUNT - artistPicks.length)]);
      if (!picks.length) {
        showNotice('Autoplay found no similar songs to continue with.');
        return;
      }
      picks.forEach((t) => playlist.add(sourceFor(t)));
      setQueue((x) => [...x, ...picks]);
      setOriginal((o) => [...o, ...picks]);
      playlist.skipTo(q.length);
      playlist.play();
      showNotice(`Autoplay: ${picks.length} similar ${picks.length === 1 ? 'song' : 'songs'}${last.genre ? ` (${last.genre})` : ''}`);
    } finally {
      autoplayBusy.current = false;
    }
  }, [playlist, showNotice]);

  /* ---------- native events */
  useEffect(() => {
    const changed = playlist.addListener('trackChanged', ({ currentIndex }) => {
      // Previous track ran out on its own → ramp the new one in; a skip plays at full volume at once.
      const natural = lastLeft.current < 1.5;
      fadeInPending.current = natural && crossfadeRef.current > 0;
      transGain.current = fadeInPending.current ? 0 : 1;
      lastLeft.current = Number.POSITIVE_INFINITY;
      applyVolume();
      void logListen();
      setIndex(currentIndex);
      const t = queueRef.current[currentIndex];
      clock.reset(currentIndex, t?.id ?? null);
      if (t) listenStart.current = { trackId: t.id, at: Date.now() };
      updateLockScreen(t);
      if (sleepRef.current && 'endOfTrack' in sleepRef.current) {
        playlist.pause();
        restoreVolume();
        setSleep(null);
      }
      saveSession();
    });
    const status = playlist.addListener('playlistStatusUpdate', (s) => {
      // Android sends `error: { message, code }` with the status when ExoPlayer can't open the source
      // (not in the published AudioPlaylistStatus type).
      const err = (s as { error?: { message?: string } | string | null }).error;
      if (err) {
        const t = queueRef.current[s.currentIndex];
        if (t && isLocalTrack(t) && localFailNotified.current !== t.id) {
          localFailNotified.current = t.id;
          showNotice(LOCAL_PLAY_FAILED);
        }
      }
      // Lyric clock + throttled progress first, so they see every tick.
      clock.sample(
        { time: s.currentTime, playing: s.playing, buffering: s.isBuffering, rate: s.playbackRate || 1, duration: s.isLoaded ? s.duration : 0, index: s.currentIndex, loaded: s.isLoaded },
        queueRef.current[s.currentIndex]?.id ?? null,
      );
      progressStore.push({ position: s.currentTime, duration: s.duration || 0 });
      // Paused (or stopped): remember where, for "Resume where I left off".
      if (wasPlaying.current && !s.playing) saveSession();
      wasPlaying.current = s.playing;
      setPlaying((p) => (p === s.playing ? p : s.playing));
      setBuffering((b) => (b === s.isBuffering ? b : s.isBuffering));
      // Restored session: jump to the saved position once the track can seek.
      if (pendingSeek.current !== null && s.isLoaded && s.duration > 0) {
        const at = Math.min(pendingSeek.current, Math.max(0, s.duration - 2));
        pendingSeek.current = null;
        if (at > 0) {
          clock.seek(at);
          void playlist.seekTo(at);
        }
      }
      if (restoredPending.current && s.playing) {
        restoredPending.current = false;
        const t = queueRef.current[s.currentIndex];
        listenStart.current = t ? { trackId: t.id, at: Date.now() } : null;
      }
      if (s.playing && Date.now() - lastSessionSave.current > SESSION_SAVE_MS) saveSession();
      const sleepEnds = s.didJustFinish && !!sleepRef.current && 'endOfTrack' in sleepRef.current;
      if (s.didJustFinish && s.currentIndex >= s.trackCount - 1 && repeat === 'off') {
        void logListen();
        if (!sleepEnds) void extendWithSimilar();
      }
      // "End of track" on the last song (or with repeat one) never gets a trackChanged event.
      if (sleepEnds) {
        playlist.pause();
        restoreVolume();
        setSleep(null);
      }
      // Data usage estimate: audio seconds actually played, split by source and network.
      const now = Date.now();
      const prev = usageTick.current;
      usageTick.current = s.playing && !s.isBuffering ? now : null;
      const t = queueRef.current[s.currentIndex];
      if (prev !== null && s.playing && t) {
        const seconds = Math.min(2, (now - prev) / 1000) * (playlist.playbackRate || 1);
        if (seconds > 0) usage.record(seconds, { local: queuedLocal.has(t.id) });
      }
    });
    return () => {
      changed.remove();
      status.remove();
    };
  }, [playlist, clock, progressStore, logListen, updateLockScreen, repeat, restoreVolume, applyVolume, saveSession, extendWithSimilar, showNotice]);

  /* ---------- local file watchdog: not loaded ~5 s after it became current → tell the user */
  const currentTrackId = queue[index]?.id ?? null;
  useEffect(() => {
    localFailNotified.current = null;
    if (!currentTrackId || !isLocalTrack({ id: currentTrackId })) return;
    const id = setTimeout(() => {
      if (restoredPending.current) return; // restored session, paused: nothing was asked to play yet
      if (playlist.isLoaded) return;
      if (queueRef.current[playlist.currentIndex]?.id !== currentTrackId) return;
      if (localFailNotified.current === currentTrackId) return;
      localFailNotified.current = currentTrackId;
      showNotice(LOCAL_PLAY_FAILED);
    }, LOCAL_LOAD_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [currentTrackId, index, loadSeq, playlist, showNotice]);

  /* ---------- sleep timer (minutes) */
  useEffect(() => {
    if (!sleep || !('endsAt' in sleep)) return;
    const id = setTimeout(() => {
      playlist.pause();
      restoreVolume();
      setSleep(null);
    }, Math.max(0, sleep.endsAt - Date.now()));
    return () => clearTimeout(id);
  }, [sleep, playlist, restoreVolume]);

  /*
   * ---------- mixer tick (while playing)
   * - Sleep fade: ramp to 0 over the last 30 s of the timer (or of the track for "end of track").
   * - Smooth transition (`crossfade_seconds`): fade the outgoing track out over its last N s and the
   *   next one in over its first N s. expo-audio's playlist plays one source at a time, so this is a
   *   fade-out/fade-in, not an overlapping crossfade (a second player would break lock-screen/queue).
   */
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const r = playlist.playbackRate || 1;
      const d = playlist.duration;
      const pos = playlist.currentTime;
      const left = d > 0 ? Math.max(0, d - pos) / r : Number.POSITIVE_INFINITY;
      lastLeft.current = left;

      let sg = 1;
      const sl = sleepRef.current;
      if (sl && sl.fadeOut !== false) {
        const ms = 'endsAt' in sl ? sl.endsAt - Date.now() : left * 1000;
        if (ms <= FADE_MS) sg = Math.max(0, ms) / FADE_MS;
      }
      sleepGain.current = sg;

      let tg = 1;
      const cf = crossfadeRef.current;
      if (cf > 0 && d > 0) {
        const win = Math.min(cf, d / 3);
        const hasNext = repeatRef.current !== 'off' || playlist.currentIndex < playlist.trackCount - 1;
        if (hasNext && left < win) tg = Math.min(tg, left / win);
        if (fadeInPending.current) {
          const inS = pos / r;
          if (inS < win) tg = Math.min(tg, inS / win);
          else fadeInPending.current = false;
        }
      } else fadeInPending.current = false;
      transGain.current = tg;
      applyVolume();
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [playing, playlist, applyVolume]);

  // Timer cancelled / fade turned off: give the volume back right away (even while paused).
  useEffect(() => {
    if (!sleep || sleep.fadeOut === false) restoreVolume();
  }, [sleep, restoreVolume]);

  /* ---------- queue loading */
  const load = useCallback(
    (tracks: CatalogTrack[], start: number, opts?: { paused?: boolean }) => {
      void logListen();
      restoredPending.current = false;
      pendingSeek.current = null;
      setLoadSeq((n) => n + 1);
      playlist.clear();
      tracks.forEach((t) => playlist.add(sourceFor(t)));
      setLoop(playlist, loopFor(repeat));
      setPlaybackRate(playlist, rate);
      setQueue(tracks);
      setIndex(start);
      playlist.skipTo(start);
      if (opts?.paused) {
        // Restored session: the listen starts counting when the user presses play.
        restoredPending.current = true;
        listenStart.current = null;
      } else {
        playlist.play();
        listenStart.current = tracks[start] ? { trackId: tracks[start].id, at: Date.now() } : null;
      }
      updateLockScreen(tracks[start]);
    },
    [playlist, repeat, rate, logListen, updateLockScreen],
  );

  const playTracks = useCallback(
    (input: CatalogTrack[], startIndex = 0, ctx?: string, opts?: PlayOptions): PlayResult => {
      if (!input.length) return { played: 0, skipped: 0 };
      // Content controls: drop hidden songs / artists and (kid-safe) explicit songs. The song the
      // user explicitly started stays unless kid-safe blocks it.
      const kidSafe = kidSafeRef.current;
      const chosen = input[Math.min(Math.max(0, startIndex), input.length - 1)];
      const visible = new Set(filterHidden(input, kidSafe));
      const all = visible.size === input.length ? input : input.filter((t) => visible.has(t) || (t === chosen && !(kidSafe && looksExplicit(t))));
      if (!all.length) {
        const reason = kidSafe && looksExplicit(chosen) ? 'Kid-safe mode is on, so explicit songs don’t play.' : 'Everything here is hidden in Content controls.';
        showNotice(reason);
        return { played: 0, skipped: input.length, reason };
      }
      let tracks = all;
      let start = Math.max(0, all.indexOf(chosen));
      let skipped = 0;
      const blocked = streamBlockedReason(all.length > 1);
      if (blocked) {
        // Offline or Wi-Fi-only on mobile data: only downloaded/device songs can play.
        tracks = all.filter(playableOffline);
        skipped = all.length - tracks.length;
        if (!tracks.length) {
          const reason = blocked;
          showNotice(reason);
          return { played: 0, skipped, reason };
        }
        const wanted = all[start];
        start = Math.max(0, tracks.findIndex((t) => t.id === wanted.id));
      }
      hideMetaRef.current = Boolean(opts?.hideMetadata);
      setContext(ctx ?? null);
      setOriginal(tracks);
      if (shuffle) {
        const first = tracks[start];
        const rest = smartShuffle(tracks.filter((_, i) => i !== start));
        load([first, ...rest], 0);
      } else {
        load(tracks, start);
      }
      if (skipped) {
        const reason = `${downloads.isOnline() ? 'Wi-Fi only' : 'Offline'}: skipped ${skipped} ${skipped === 1 ? 'song' : 'songs'} that ${skipped === 1 ? 'isn’t' : 'aren’t'} downloaded.`;
        showNotice(reason);
        return { played: tracks.length, skipped, reason };
      }
      return { played: tracks.length, skipped: 0 };
    },
    [shuffle, load, showNotice],
  );

  // Restore the last session, paused, once on app start (if nothing has been played yet).
  const restored = useRef(false);
  useEffect(() => {
    let alive = true;
    void playPrefsReady.then(() => {
      if (!alive || restored.current) return;
      restored.current = true;
      const savedRate = getPlayPref('playback.rate');
      if (savedRate >= 0.5 && savedRate <= 2 && savedRate !== 1) {
        setPlaybackRate(playlist, savedRate);
        setRateState(savedRate);
      }
      const last = getPlayPref('playback.lastSession');
      if (!getPlayPref('playback.resume') || !last?.queue.length || queueRef.current.length) return;
      let tracks = last.queue;
      let start = Math.min(Math.max(0, last.index), tracks.length - 1);
      const wanted = tracks[start];
      if (streamBlockedReason(true)) {
        tracks = tracks.filter(playableOffline);
        if (!tracks.length) return;
        start = Math.max(0, tracks.findIndex((t) => t.id === wanted.id));
      }
      hideMetaRef.current = false;
      setContext(last.context);
      setOriginal(tracks);
      load(tracks, start, { paused: true });
      if (tracks[start]?.id === wanted.id) pendingSeek.current = last.position;
    });
    return () => {
      alive = false;
    };
  }, [load, playlist]);

  const playTrack = useCallback(
    (track: CatalogTrack, ctx?: string, opts?: PlayOptions): PlayResult => {
      const existing = queueRef.current.findIndex((t) => t.id === track.id);
      if (existing >= 0) {
        hideMetaRef.current = Boolean(opts?.hideMetadata);
        playlist.skipTo(existing);
        playlist.play();
        updateLockScreen(track);
        return { played: 1, skipped: 0 };
      }
      return playTracks([track], 0, ctx, opts);
    },
    [playlist, playTracks, updateLockScreen],
  );

  /** Offline guard for queue edits. */
  const canQueue = useCallback(
    (t: CatalogTrack) => {
      if (kidSafeRef.current && looksExplicit(t)) {
        showNotice('Kid-safe mode is on, so explicit songs can’t be queued.');
        return false;
      }
      if (isTrackHidden(t)) {
        showNotice('That song or artist is hidden. Unhide it in Content controls to queue it.');
        return false;
      }
      const blocked = streamBlockedReason(false);
      if (!blocked || playableOffline(t)) return true;
      showNotice(blocked);
      return false;
    },
    [showNotice],
  );

  const setShuffle = useCallback(
    (on: boolean) => {
      setShuffleState(on);
      const q = queueRef.current;
      const current = q[index];
      if (!current) return;
      // Rebuild "up next" without interrupting the current song.
      const upNext = on ? smartShuffle(q.filter((t) => t.id !== current.id)) : original.filter((t) => t.id !== current.id);
      for (let i = playlist.trackCount - 1; i >= 0; i--) if (i !== index) playlist.remove(i);
      upNext.forEach((t) => playlist.add(sourceFor(t)));
      setQueue([current, ...upNext]);
      setIndex(0);
    },
    [index, original, playlist],
  );

  /* ---------- Warm the next Zoyra (YouTube) songs so Next / autoplay start without a wait */
  useEffect(() => {
    for (const t of queue.slice(index + 1, index + 3)) {
      if (!downloads.localUri(t.id)) zoyra.prefetch(t.id);
    }
  }, [queue, index]);

  /* ---------- Like / Shuffle on the Android media notification and lock screen */
  const current = queue[index];
  const currentLiked = current ? isLiked(current.id) : false;
  useEffect(() => {
    // No Like for device files, audiobook chapters, or the quiz (it would give the answer away).
    const likeable = !!current && !isLocalTrack(current) && !current.id.startsWith('librivox:') && !hideMetaRef.current;
    setLockScreenButtons({ liked: likeable && currentLiked, shuffle, showLike: likeable, showShuffle: !!current });
  }, [current, currentLiked, shuffle]);

  /** A guest tapped Like while the app was in the background: prompt once it's back on screen. */
  const guestLikePending = useRef(false);
  const lockActionRef = useRef<(a: LockScreenAction) => void>(() => {});
  useLayoutEffect(() => {
    lockActionRef.current = (action) => {
      if (action === 'shuffle') {
        setShuffle(!shuffle);
        return;
      }
      const t = queueRef.current[index];
      if (!t || isLocalTrack(t) || t.id.startsWith('librivox:') || hideMetaRef.current) return;
      if (!user && AppState.currentState !== 'active') {
        guestLikePending.current = true; // toggleLike would navigate to /login from the background
        return;
      }
      void toggleLike(t);
    };
  });
  useEffect(() => addLockScreenActionListener((a) => lockActionRef.current(a)), []);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active' || !guestLikePending.current) return;
      guestLikePending.current = false;
      flash('Sign in to like songs');
    });
    return () => sub.remove();
  }, []);

  const cycleRepeat = useCallback(() => {
    setRepeat((r) => {
      const n: RepeatMode = r === 'off' ? 'all' : r === 'all' ? 'one' : 'off';
      setLoop(playlist, loopFor(n));
      return n;
    });
  }, [playlist]);

  const value = useMemo<PlayerState>(
    () => ({
      track: queue[index] ?? null,
      queue,
      index,
      playing,
      buffering,
      shuffle,
      repeat,
      rate,
      context,
      sleep,
      notice,
      playlist,
      playTracks,
      playTrack,
      toggle: () => (playlist.playing ? playlist.pause() : playlist.play()),
      play: () => playlist.play(),
      pause: () => playlist.pause(),
      next: () => playlist.next(),
      // Restart the song if more than 3 s in, like every major player.
      previous: () => {
        if (playlist.currentTime > 3) {
          clock.seek(0);
          progressStore.push({ position: 0, duration: progressStore.get().duration });
          void playlist.seekTo(0);
        } else playlist.previous();
      },
      skipTo: (i) => {
        playlist.skipTo(i);
        playlist.play();
      },
      // The clock and progress jump at once (lyrics highlight follows a tap immediately).
      seekTo: (s) => {
        clock.seek(s);
        progressStore.push({ position: s, duration: progressStore.get().duration });
        void playlist.seekTo(s);
      },
      setShuffle,
      cycleRepeat,
      setRate: (r) => {
        setPlaybackRate(playlist, r);
        setRateState(r);
        setPlayPref('playback.rate', r);
      },
      addToQueue: (t) => {
        if (!canQueue(t)) return;
        playlist.add(sourceFor(t));
        setQueue((q) => [...q, t]);
        setOriginal((o) => [...o, t]);
      },
      playNext: (t) => {
        if (!canQueue(t)) return;
        playlist.insert(sourceFor(t), index + 1);
        setQueue((q) => [...q.slice(0, index + 1), t, ...q.slice(index + 1)]);
      },
      removeFromQueue: (i) => {
        if (i === index) return;
        playlist.remove(i);
        setQueue((q) => q.filter((_, j) => j !== i));
        if (i < index) setIndex((x) => x - 1);
      },
      moveInQueue: (from, to) => {
        if (from === index || to === index || from === to) return;
        const q = [...queueRef.current];
        const [t] = q.splice(from, 1);
        q.splice(to, 0, t);
        playlist.remove(from);
        playlist.insert(sourceFor(t), to);
        setQueue(q);
      },
      clearUpNext: () => {
        for (let i = playlist.trackCount - 1; i > index; i--) playlist.remove(i);
        setQueue((q) => q.slice(0, index + 1));
      },
      setSleepTimer: (m, opts) => {
        const fadeOut = opts?.fadeOut ?? true;
        setSleep(m === null ? null : m === 'endOfTrack' ? { endOfTrack: true, fadeOut } : { endsAt: Date.now() + m * 60_000, minutes: m, fadeOut });
      },
      setSleepFade: (on) => setSleep((s) => (s ? { ...s, fadeOut: on } : s)),
      duck: (level) => {
        duckLevel.current = level === null ? null : Math.max(0, Math.min(1, level));
        applyVolume();
      },
    }),
    [queue, index, playing, buffering, shuffle, repeat, rate, context, sleep, notice, playlist, clock, progressStore, playTracks, playTrack, setShuffle, cycleRepeat, canQueue, applyVolume],
  );

  // Seeded with the first value so children can read it during the initial render. `value` only holds
  // callbacks that read refs when called, never during render; the compiler rule can't tell.
  // eslint-disable-next-line react-hooks/refs
  const [store] = useState(() => createPlayerStore(value));
  const [actions] = useState(() => createActions(store));
  // Publish after commit; selector subscribers re-render synchronously (before paint) when their slice changed.
  useLayoutEffect(() => {
    store.set(value);
  }, [store, value]);

  return (
    <StoreCtx.Provider value={store}>
      <ActionsCtx.Provider value={actions}>
        <ClockCtx.Provider value={clockCtx}>
          <Ctx.Provider value={value}>{children}</Ctx.Provider>
        </ClockCtx.Provider>
      </ActionsCtx.Provider>
    </StoreCtx.Provider>
  );
}

/**
 * Subscribe to one derived slice of the player. Re-renders only when `selector`'s result changes
 * (Object.is), so return primitives or stable references (e.g. `s => s.track?.id === id`).
 */
export function usePlayerSelector<T>(selector: (s: PlayerState) => T): T {
  const store = useContext(StoreCtx);
  if (!store) throw new Error('usePlayerSelector must be used inside <PlayerProvider>');
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

/** The non-function fields of the player state (what a component can subscribe to). */
export type PlayerStateKey = 'track' | 'queue' | 'index' | 'playing' | 'buffering' | 'shuffle' | 'repeat' | 'rate' | 'context' | 'sleep' | 'notice' | 'playlist';

/**
 * Drop-in replacement for `usePlayer()` that subscribes only to the listed fields: returns the stable
 * actions plus `Pick<PlayerState, K>`, and re-renders (with a new object) only when one of those fields
 * changes. `usePlayerPick()` with no keys never re-renders. Keys must be a fixed list per call site.
 */
export function usePlayerPick<K extends PlayerStateKey = never>(...keys: K[]): PlayerActions & Pick<PlayerState, K> {
  const store = useContext(StoreCtx);
  const actions = useContext(ActionsCtx);
  if (!store || !actions) throw new Error('usePlayerPick must be used inside <PlayerProvider>');
  // One snapshot function per component, caching the last picked object (same values → same object).
  const [getSnapshot] = useState(() => {
    let last: { vals: unknown[]; out: PlayerActions & Pick<PlayerState, K> } | null = null;
    return () => {
      const state = store.get();
      const vals = keys.map((k) => state[k]);
      if (last && vals.every((v, i) => Object.is(v, last!.vals[i]))) return last.out;
      const out = { ...actions } as PlayerActions & Pick<PlayerState, K>;
      keys.forEach((k, i) => {
        (out as Record<string, unknown>)[k] = vals[i];
      });
      last = { vals, out };
      return out;
    };
  });
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

/** Player commands with a stable identity: using them never re-renders the caller. */
export function usePlayerActions(): PlayerActions {
  const v = useContext(ActionsCtx);
  if (!v) throw new Error('usePlayerActions must be used inside <PlayerProvider>');
  return v;
}

export function usePlayer() {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePlayer must be used inside <PlayerProvider>');
  return v;
}

/** Live position/duration, ~2 updates a second (re-renders only the component that uses it). */
export function usePlaybackProgress() {
  const c = useContext(ClockCtx);
  if (!c) throw new Error('usePlaybackProgress must be used inside <PlayerProvider>');
  const { position, duration } = useSyncExternalStore(c.progress.subscribe, c.progress.get);
  return { position, duration, progress: duration > 0 ? Math.min(1, position / duration) : 0 };
}

/** The interpolating playback clock (stable object; read `now()` in effects/timers, never during render for display). */
export function usePlaybackClockStore(): PlaybackClock {
  const c = useContext(ClockCtx);
  if (!c) throw new Error('usePlaybackClockStore must be used inside <PlayerProvider>');
  return c.clock;
}

/** Real loaded audio length (s) of track `trackId`, or 0 while unknown / another track is loaded. */
export function useLoadedDuration(trackId: string | null | undefined): number {
  const c = useContext(ClockCtx);
  if (!c) throw new Error('useLoadedDuration must be used inside <PlayerProvider>');
  const { clock } = c;
  return useSyncExternalStore(clock.subscribe, () => (trackId && clock.trackId() === trackId ? clock.state().duration : 0));
}
