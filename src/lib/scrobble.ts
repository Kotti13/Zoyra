/**
 * Scrobbling to Last.fm and ListenBrainz.
 *
 * - ListenBrainz: the user pastes their user token. We validate it with ListenBrainz, store it in
 *   `scrobble_accounts` (owner-only RLS, never in profile data) and submit listens directly.
 * - Last.fm: web auth in the browser, then the `lastfm` edge function exchanges the token for a
 *   session key (stored server-side) and signs every call. The app never sees the shared secret.
 * - A listen counts after half the song or 4 minutes of actual playback, whichever comes first
 *   (songs under 30 s are never scrobbled, per Last.fm's rules). Seeking forward does not count.
 * - Listens wait in an AsyncStorage queue while offline and are flushed on reconnect / app focus.
 * - Private session (Privacy settings) sends nothing.
 *
 * `useScrobbler()` is the player hook (mount once, inside PlayerProvider + AuthProvider).
 * `useScrobbleState()` + the `scrobbler` actions power the Scrobbling screen.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import type { CatalogTrack } from './catalog';
import { supabase } from './supabase';

export type ScrobbleService = 'lastfm' | 'listenbrainz';
export const SERVICE_NAMES: Record<ScrobbleService, string> = { lastfm: 'Last.fm', listenbrainz: 'ListenBrainz' };

type Listen = {
  trackId: string;
  artist: string;
  track: string;
  /** seconds */
  duration: number;
  /** unix seconds when playback started */
  listenedAt: number;
  url?: string;
};
type QueueItem = { service: ScrobbleService; listen: Listen };

export type ScrobbleStatus = { ok: boolean; message: string; at: number };
export type ScrobbleSnapshot = {
  /** Accounts loaded for the signed-in user. */
  loaded: boolean;
  /** Master switch (per device). */
  enabled: boolean;
  accounts: Record<ScrobbleService, { username: string } | null>;
  status: Record<ScrobbleService, ScrobbleStatus | null>;
  /** Listens waiting to be sent (offline or temporarily failing). */
  queued: number;
  /** Last.fm keys missing on the server (learned from a 503). */
  lastfmNeedsSetup: boolean;
};
export type ActionResult = { ok: boolean; message: string };

const LB_API = 'https://api.listenbrainz.org/1';
const MIN_DURATION = 30;
const MAX_THRESHOLD = 240;
const LASTFM_MAX_AGE_S = 14 * 24 * 3600; // Last.fm ignores scrobbles older than 14 days
const QUEUE_CAP = 1000;
const ENABLED_KEY = 'zoyra.scrobble.enabled';
const queueKey = (uid: string) => `zoyra.scrobble.queue.${uid}`;
const statusKey = (uid: string) => `zoyra.scrobble.status.${uid}`;

/* ------------------------------------------------------------------ external store */

let state: ScrobbleSnapshot = {
  loaded: false,
  enabled: true,
  accounts: { lastfm: null, listenbrainz: null },
  status: { lastfm: null, listenbrainz: null },
  queued: 0,
  lastfmNeedsSetup: false,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<ScrobbleSnapshot>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

let userId: string | null = null;
let lbToken: string | null = null;
let queue: QueueItem[] = [];
let online = true;

const nowS = () => Math.floor(Date.now() / 1000);

async function persistQueue() {
  set({ queued: queue.length });
  if (!userId) return;
  try {
    await AsyncStorage.setItem(queueKey(userId), JSON.stringify(queue));
  } catch {
    // Storage full or unavailable: the in-memory queue still flushes this session.
  }
}

function setStatus(service: ScrobbleService, ok: boolean, message: string) {
  const status = { ...state.status, [service]: { ok, message, at: Date.now() } };
  set({ status });
  if (userId) AsyncStorage.setItem(statusKey(userId), JSON.stringify(status)).catch(() => {});
}

/* ------------------------------------------------------------------ Last.fm edge function */

type FnFailure = { ok: false; kind: 'not_configured' | 'session_invalid' | 'not_connected' | 'retry' | 'fatal' | 'invalid_token'; message: string };
type FnResult<T> = { ok: true; data: T } | FnFailure;

async function lastfmFn<T>(body: Record<string, unknown>): Promise<FnResult<T>> {
  try {
    const { data, error } = await supabase.functions.invoke<T>('lastfm', { body });
    if (!error) return data == null ? { ok: false, kind: 'retry', message: 'Empty response from Last.fm function' } : { ok: true, data };
    if (error instanceof FunctionsHttpError && error.context instanceof Response) {
      const status = error.context.status;
      let eb: { error?: string; message?: string; retryable?: boolean } = {};
      try {
        const parsed: unknown = await error.context.clone().json();
        if (parsed && typeof parsed === 'object') eb = parsed as typeof eb;
      } catch {
        // non-JSON body
      }
      if (status === 503 || eb.error === 'not_configured') {
        set({ lastfmNeedsSetup: true });
        return { ok: false, kind: 'not_configured', message: 'Needs Last.fm setup' };
      }
      if (status === 404) {
        set({ lastfmNeedsSetup: true });
        return { ok: false, kind: 'not_configured', message: 'Needs Last.fm setup (function not deployed)' };
      }
      if (eb.error === 'lastfm_session_invalid') return { ok: false, kind: 'session_invalid', message: eb.message ?? 'Last.fm access was revoked' };
      if (eb.error === 'not_connected') return { ok: false, kind: 'not_connected', message: 'Last.fm is not connected' };
      if (eb.error === 'invalid_token') return { ok: false, kind: 'invalid_token', message: eb.message ?? 'Last.fm did not authorize Zoyra' };
      const retry = status >= 500 && eb.retryable !== false;
      return { ok: false, kind: retry || eb.retryable ? 'retry' : 'fatal', message: eb.message ?? eb.error ?? `Request failed (${status})` };
    }
    if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) return { ok: false, kind: 'retry', message: 'Network error' };
    return { ok: false, kind: 'retry', message: error.message || 'Request failed' };
  } catch (e) {
    return { ok: false, kind: 'retry', message: e instanceof Error ? e.message : 'Request failed' };
  }
}

const lastfmTrack = (l: Listen) => ({ artist: l.artist, track: l.track, duration: Math.round(l.duration), timestamp: l.listenedAt });

/* ------------------------------------------------------------------ ListenBrainz */

type LbResult = { ok: true } | { ok: false; retry: boolean; unauthorized?: boolean; message: string };

const lbPayload = (l: Listen, withTime: boolean) => ({
  ...(withTime ? { listened_at: l.listenedAt } : {}),
  track_metadata: {
    artist_name: l.artist,
    track_name: l.track,
    additional_info: {
      duration_ms: Math.round(l.duration * 1000),
      submission_client: 'Zoyra',
      media_player: 'Zoyra',
      ...(l.trackId.startsWith('local:') ? {} : { music_service: 'audius.co' }),
      ...(l.url ? { origin_url: l.url } : {}),
    },
  },
});

async function lbSubmit(token: string, listenType: 'single' | 'playing_now' | 'import', listens: Listen[]): Promise<LbResult> {
  try {
    const res = await fetch(`${LB_API}/submit-listens`, {
      method: 'POST',
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ listen_type: listenType, payload: listens.map((l) => lbPayload(l, listenType !== 'playing_now')) }),
    });
    if (res.ok) return { ok: true };
    let message = `ListenBrainz error (${res.status})`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b.error) message = b.error;
    } catch {
      // keep default
    }
    if (res.status === 401) return { ok: false, retry: false, unauthorized: true, message: 'ListenBrainz rejected the token. Connect again.' };
    return { ok: false, retry: res.status === 429 || res.status >= 500, message };
  } catch {
    return { ok: false, retry: true, message: 'Network error' };
  }
}

/* ------------------------------------------------------------------ accounts */

async function loadAccounts() {
  if (!userId) return;
  const uid = userId;
  const { data, error } = await supabase.from('scrobble_accounts').select('service, username, secret').eq('user_id', uid);
  if (uid !== userId) return;
  if (error) {
    // Table missing (migration not pushed) or offline: keep whatever we had.
    set({ loaded: true });
    return;
  }
  const rows = (data ?? []) as { service: ScrobbleService; username: string; secret: string }[];
  const lf = rows.find((r) => r.service === 'lastfm');
  const lb = rows.find((r) => r.service === 'listenbrainz');
  lbToken = lb?.secret ?? null;
  set({ loaded: true, accounts: { lastfm: lf ? { username: lf.username } : null, listenbrainz: lb ? { username: lb.username } : null } });
}

/** Switch to a user (or null on sign-out): loads their accounts, queue and last status. */
async function init(uid: string | null) {
  if (uid === userId) return;
  userId = uid;
  lbToken = null;
  queue = [];
  set({ loaded: false, accounts: { lastfm: null, listenbrainz: null }, status: { lastfm: null, listenbrainz: null }, queued: 0, lastfmNeedsSetup: false });
  if (!uid) return;
  try {
    const [q, s] = await Promise.all([AsyncStorage.getItem(queueKey(uid)), AsyncStorage.getItem(statusKey(uid))]);
    if (uid !== userId) return;
    queue = q ? (JSON.parse(q) as QueueItem[]) : [];
    if (s) set({ status: JSON.parse(s) as ScrobbleSnapshot['status'] });
    set({ queued: queue.length });
  } catch {
    // corrupt storage: start empty
  }
  await loadAccounts();
  void flush();
}

/* ------------------------------------------------------------------ flushing */

let flushing: Promise<void> | null = null;

/** Sends queued listens. Safe to call any time; runs one flush at a time. */
function flush(): Promise<void> {
  if (flushing) return flushing;
  flushing = doFlush().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function doFlush() {
  if (!userId || !online || !queue.length) return;
  const uid = userId;

  // Drop listens for services that are no longer connected, and Last.fm ones it would ignore anyway.
  const tooOld = nowS() - LASTFM_MAX_AGE_S;
  const before = queue.length;
  queue = queue.filter((i) => state.accounts[i.service] && !(i.service === 'lastfm' && i.listen.listenedAt < tooOld));
  if (queue.length !== before) await persistQueue();

  /* Last.fm, batches of 50 */
  while (uid === userId && state.accounts.lastfm) {
    const batch = queue.filter((i) => i.service === 'lastfm').slice(0, 50);
    if (!batch.length) break;
    const r = await lastfmFn<{ accepted: number; ignored: number }>({ action: 'scrobble', tracks: batch.map((i) => lastfmTrack(i.listen)) });
    if (uid !== userId) return;
    if (r.ok) {
      queue = queue.filter((i) => !batch.includes(i));
      await persistQueue();
      const last = batch[batch.length - 1].listen;
      const msg =
        r.data.accepted === 0
          ? `Last.fm ignored “${last.track}”`
          : batch.length === 1
            ? `Scrobbled “${last.track}”`
            : `Scrobbled ${r.data.accepted} songs${r.data.ignored ? ` (${r.data.ignored} ignored)` : ''}`;
      setStatus('lastfm', r.data.accepted > 0, msg);
      continue;
    }
    if (r.kind === 'session_invalid' || r.kind === 'not_connected') {
      queue = queue.filter((i) => i.service !== 'lastfm');
      await persistQueue();
      set({ accounts: { ...state.accounts, lastfm: null } });
      setStatus('lastfm', false, r.message);
      break;
    }
    if (r.kind === 'fatal') {
      queue = queue.filter((i) => !batch.includes(i));
      await persistQueue();
      setStatus('lastfm', false, `Not scrobbled: ${r.message}`);
      continue;
    }
    // not_configured / retry: keep them queued for later.
    setStatus('lastfm', false, r.kind === 'not_configured' ? r.message : `Waiting to retry: ${r.message}`);
    break;
  }

  /* ListenBrainz, batches of 100 */
  while (uid === userId && state.accounts.listenbrainz && lbToken) {
    const batch = queue.filter((i) => i.service === 'listenbrainz').slice(0, 100);
    if (!batch.length) break;
    const r = await lbSubmit(lbToken, batch.length === 1 ? 'single' : 'import', batch.map((i) => i.listen));
    if (uid !== userId) return;
    if (r.ok) {
      queue = queue.filter((i) => !batch.includes(i));
      await persistQueue();
      const last = batch[batch.length - 1].listen;
      setStatus('listenbrainz', true, batch.length === 1 ? `Submitted “${last.track}”` : `Submitted ${batch.length} listens`);
      continue;
    }
    if (r.unauthorized) {
      // Keep the account row (the user may fix it) but stop retrying these listens.
      queue = queue.filter((i) => i.service !== 'listenbrainz');
      await persistQueue();
      setStatus('listenbrainz', false, r.message);
      break;
    }
    if (!r.retry) {
      queue = queue.filter((i) => !batch.includes(i));
      await persistQueue();
      setStatus('listenbrainz', false, `Not submitted: ${r.message}`);
      continue;
    }
    setStatus('listenbrainz', false, `Waiting to retry: ${r.message}`);
    break;
  }
}

/* ------------------------------------------------------------------ player events */

function connectedServices(): ScrobbleService[] {
  if (!state.enabled || !userId) return [];
  return (Object.keys(state.accounts) as ScrobbleService[]).filter((s) => state.accounts[s]);
}

async function nowPlaying(l: Listen) {
  if (!online) return; // "now playing" is live-only; never queued
  const services = connectedServices();
  await Promise.all(
    services.map(async (s) => {
      if (s === 'lastfm') {
        const { timestamp: _ts, ...track } = lastfmTrack(l);
        const r = await lastfmFn<{ ok: true }>({ action: 'now_playing', track });
        if (!r.ok && (r.kind === 'session_invalid' || r.kind === 'not_connected')) {
          set({ accounts: { ...state.accounts, lastfm: null } });
          setStatus('lastfm', false, r.message);
        }
      } else if (lbToken) {
        await lbSubmit(lbToken, 'playing_now', [l]);
      }
    }),
  );
}

async function recordListen(l: Listen) {
  const services = connectedServices();
  if (!services.length) return;
  queue = [...queue, ...services.map((service) => ({ service, listen: l }))].slice(-QUEUE_CAP);
  await persistQueue();
  if (!online) {
    services.forEach((s) => setStatus(s, true, `Offline: “${l.track}” will be sent when you reconnect`));
    return;
  }
  await flush();
}

/* ------------------------------------------------------------------ connectivity */

let wired = false;
function wireConnectivity() {
  if (wired) return;
  wired = true;
  NetInfo.addEventListener((s) => {
    const was = online;
    online = s.isConnected !== false && s.isInternetReachable !== false;
    if (online && !was) void flush();
  });
  AppState.addEventListener('change', (s) => {
    if (s === 'active') void flush();
  });
  AsyncStorage.getItem(ENABLED_KEY)
    .then((v) => {
      if (v !== null) set({ enabled: v === '1' });
    })
    .catch(() => {});
}

/* ------------------------------------------------------------------ public actions */

const usedLastfmTokens = new Set<string>();

export const scrobbler = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  getSnapshot: () => state,

  async setEnabled(on: boolean) {
    set({ enabled: on });
    try {
      await AsyncStorage.setItem(ENABLED_KEY, on ? '1' : '0');
    } catch {
      // per-session only
    }
  },

  refresh: loadAccounts,
  flush,

  /** Validates a ListenBrainz user token, then stores it server-side (owner-only). */
  async connectListenBrainz(raw: string): Promise<ActionResult> {
    const token = raw.trim();
    if (!userId) return { ok: false, message: 'Sign in first.' };
    if (!/^[A-Za-z0-9-]{8,100}$/.test(token)) return { ok: false, message: 'That doesn’t look like a ListenBrainz user token.' };
    let username: string;
    try {
      const res = await fetch(`${LB_API}/validate-token`, { headers: { Authorization: `Token ${token}` } });
      const b = (await res.json()) as { valid?: boolean; user_name?: string; message?: string };
      if (!b.valid || !b.user_name) return { ok: false, message: 'ListenBrainz says this token is not valid.' };
      username = b.user_name;
    } catch {
      return { ok: false, message: 'Couldn’t reach ListenBrainz. Check your connection.' };
    }
    const { error } = await supabase
      .from('scrobble_accounts')
      .upsert({ user_id: userId, service: 'listenbrainz', username, secret: token, updated_at: new Date().toISOString() }, { onConflict: 'user_id,service' });
    if (error) return { ok: false, message: `Couldn’t save the token: ${error.message}` };
    lbToken = token;
    set({ accounts: { ...state.accounts, listenbrainz: { username } } });
    setStatus('listenbrainz', true, `Connected as ${username}`);
    return { ok: true, message: `ListenBrainz connected as ${username}.` };
  },

  async disconnectListenBrainz(): Promise<ActionResult> {
    if (!userId) return { ok: false, message: 'Sign in first.' };
    const { error } = await supabase.from('scrobble_accounts').delete().eq('user_id', userId).eq('service', 'listenbrainz');
    if (error) return { ok: false, message: `Couldn’t disconnect: ${error.message}` };
    lbToken = null;
    queue = queue.filter((i) => i.service !== 'listenbrainz');
    await persistQueue();
    set({ accounts: { ...state.accounts, listenbrainz: null }, status: { ...state.status, listenbrainz: null } });
    return { ok: true, message: 'ListenBrainz disconnected.' };
  },

  /** Opens Last.fm's permission page; on return exchanges the token server-side. */
  async connectLastfm(): Promise<ActionResult> {
    if (!userId) return { ok: false, message: 'Sign in first.' };
    const cb = Linking.createURL('scrobbling');
    const r = await lastfmFn<{ url: string }>({ action: 'auth_url', cb });
    if (!r.ok) return { ok: false, message: r.message };
    set({ lastfmNeedsSetup: false });
    let result: WebBrowser.WebBrowserAuthSessionResult;
    try {
      result = await WebBrowser.openAuthSessionAsync(r.data.url, cb);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Couldn’t open the browser.' };
    }
    if (result.type !== 'success') return { ok: false, message: 'Last.fm sign-in was cancelled.' };
    const token = Linking.parse(result.url).queryParams?.token;
    if (typeof token !== 'string' || !token) return { ok: false, message: 'Last.fm didn’t return a token.' };
    return scrobbler.completeLastfm(token);
  },

  /** Exchanges a Last.fm auth token (also used when the deep link zoyra://scrobbling?token= opens the screen). */
  async completeLastfm(token: string): Promise<ActionResult> {
    if (!userId) return { ok: false, message: 'Sign in first.' };
    if (usedLastfmTokens.has(token)) return { ok: true, message: 'Last.fm already connected.' };
    usedLastfmTokens.add(token);
    const r = await lastfmFn<{ username: string }>({ action: 'session', token });
    if (!r.ok) {
      usedLastfmTokens.delete(token);
      return { ok: false, message: r.message };
    }
    set({ accounts: { ...state.accounts, lastfm: { username: r.data.username } } });
    setStatus('lastfm', true, `Connected as ${r.data.username}`);
    return { ok: true, message: `Last.fm connected as ${r.data.username}.` };
  },

  async disconnectLastfm(): Promise<ActionResult> {
    if (!userId) return { ok: false, message: 'Sign in first.' };
    const r = await lastfmFn<{ ok: true }>({ action: 'disconnect' });
    if (!r.ok && r.kind !== 'not_configured') return { ok: false, message: `Couldn’t disconnect: ${r.message}` };
    if (!r.ok) {
      // Function unavailable: the owner can still delete their own row directly.
      const { error } = await supabase.from('scrobble_accounts').delete().eq('user_id', userId).eq('service', 'lastfm');
      if (error) return { ok: false, message: `Couldn’t disconnect: ${error.message}` };
    }
    queue = queue.filter((i) => i.service !== 'lastfm');
    await persistQueue();
    set({ accounts: { ...state.accounts, lastfm: null }, status: { ...state.status, lastfm: null } });
    return { ok: true, message: 'Last.fm disconnected.' };
  },
};

export function useScrobbleState(): ScrobbleSnapshot {
  return useSyncExternalStore(scrobbler.subscribe, scrobbler.getSnapshot, scrobbler.getSnapshot);
}

/* ------------------------------------------------------------------ player hook */

/** Seconds of playback that make a listen count: half the song or 4 minutes, whichever is first. */
export const scrobbleThreshold = (duration: number) => Math.min(duration / 2, MAX_THRESHOLD);

type PlaySession = { track: CatalogTrack; startedAt: number; played: number; lastPos: number; nowPlayingSent: boolean; done: boolean };

const toListen = (t: CatalogTrack, duration: number, startedAt: number): Listen => ({
  trackId: t.id,
  artist: t.artist.name,
  track: t.title,
  duration,
  listenedAt: startedAt,
  url: t.url,
});

/**
 * Watches the player (read-only) and scrobbles. Mount once in the root layout, inside
 * PlayerProvider and AuthProvider.
 */
export function useScrobbler() {
  const { track, playing, buffering, playlist } = usePlayerPick('track', 'playing', 'buffering', 'playlist');
  const { user, settings } = useAuth();
  const uid = user?.id ?? null;

  useEffect(() => {
    wireConnectivity();
  }, []);
  useEffect(() => {
    void init(uid);
  }, [uid]);

  const latest = useRef({ playing, buffering, privateSession: false });
  useLayoutEffect(() => {
    latest.current = { playing, buffering, privateSession: Boolean(settings?.privacy?.private_session) };
  });

  const session = useRef<PlaySession | null>(null);

  // New track → new play session.
  useEffect(() => {
    session.current = track ? { track, startedAt: nowS(), played: 0, lastPos: 0, nowPlayingSent: false, done: false } : null;
  }, [track]);

  useEffect(() => {
    if (!track) return;
    let lastTick = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(2, (now - lastTick) / 1000);
      lastTick = now;
      const s = session.current;
      if (!s || s.track.id !== track.id) return;
      const { playing: isPlaying, buffering: isBuffering, privateSession } = latest.current;
      const duration = track.duration > 0 ? track.duration : playlist.duration || 0;
      const pos = playlist.currentTime || 0;

      // Repeat-one loops the same track without a track change: treat a wrap to the start as a new play.
      if (duration > 0 && s.lastPos >= duration * 0.8 && pos < 5 && s.lastPos - pos > 10) {
        session.current = { track, startedAt: nowS(), played: 0, lastPos: pos, nowPlayingSent: false, done: false };
        return;
      }
      s.lastPos = pos;
      if (!isPlaying || isBuffering) return;
      s.played += dt * (playlist.playbackRate || 1);

      if (privateSession || !state.enabled || duration < MIN_DURATION) return;
      if (!s.nowPlayingSent) {
        s.nowPlayingSent = true;
        void nowPlaying(toListen(track, duration, s.startedAt));
      }
      if (!s.done && s.played >= scrobbleThreshold(duration)) {
        s.done = true;
        void recordListen(toListen(track, duration, s.startedAt));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [track, playlist]);
}
