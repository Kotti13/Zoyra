/**
 * "Who is online" over per-user private Realtime presence channels (`presence:<user id>`).
 *
 * - `usePresenceTracker()` (mount once near the root) tracks the signed-in user on their OWN topic
 *   `presence:<me>` while the app is in the foreground, but only when their Message privacy → Online status
 *   is on (`dmSettings(settings.dm).online_status`).
 * - `useOnlineUsers()` subscribes (read-only) to `presence:<id>` for the people `presence_allowed()` returns
 *   (accepted chat partners + mutual follows, minus restrictions / blocks), at most MAX_WATCH of them, and
 *   returns the ids currently online (a new Set object on every change). Empty when my own Online status is
 *   off (privacy works both ways).
 *
 * - The same tracker sends the last-seen heartbeat (`touch_last_seen()`, 20261117120000_notes_v2_last_seen.sql)
 *   whenever the app comes to the foreground or goes to the background, and every few minutes while it is
 *   open (throttled to one call per minute). It runs whatever the Online status switch says: who may see the
 *   time is decided by the server (last_seen_for, src/lib/last-seen.ts).
 *
 * Privacy is enforced server side (supabase/migrations/20261115280000_security_hardening.sql): the
 * `realtime.messages` policies only let a user join `presence:<uid>` when uid is themself or in their
 * presence_allowed() set (with both Online status switches on), and only let uid track on it. A presence entry
 * is trusted only when its key is the topic's user id.
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '../state/auth';
import { dmSettings, loadInbox } from './dm';
import { privateChannel } from './realtime';
import { supabase } from './supabase';

const EMPTY = new Set<string>();
/** Realtime allows ~100 channels per connection; keep headroom for chat / call / library channels. */
const MAX_WATCH = 80;

const topicOf = (uid: string) => `presence:${uid}`;

/* ------------------------------------------------------------------ my own topic (tracking) */

let own: { uid: string; ch: RealtimeChannel; joined: boolean } | null = null;
/** User id this device should announce, or null to stay invisible. */
let trackAs: string | null = null;

async function applyTrack() {
  const o = own;
  if (!o || !o.joined) return;
  try {
    if (trackAs === o.uid) await o.ch.track({ user_id: o.uid, at: Date.now() });
    else await o.ch.untrack();
  } catch {
    // offline: the next SUBSCRIBED re-applies
  }
}

function openOwn(uid: string) {
  if (own?.uid === uid) return;
  closeOwn();
  const ch = privateChannel(topicOf(uid), { presence: { key: uid } });
  const entry = { uid, ch, joined: false };
  own = entry;
  ch.subscribe((status) => {
    if (own !== entry) return;
    entry.joined = status === 'SUBSCRIBED';
    if (entry.joined) void applyTrack();
  });
}

function closeOwn() {
  const o = own;
  own = null;
  if (!o) return;
  void (async () => {
    try {
      if (o.joined) await o.ch.untrack();
    } catch {
      // ignore
    }
    void supabase.removeChannel(o.ch);
  })();
}

/* ------------------------------------------------------------------ friends' topics (watching) */

const watchers = new Map<string, RealtimeChannel>();
let online: Set<string> = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  const next = new Set<string>();
  watchers.forEach((ch, uid) => {
    const state = ch.presenceState<{ user_id?: unknown }>();
    // Only the topic owner can track here (server policy); still ignore any other key.
    const metas = state[uid];
    if (metas?.some((m) => m.user_id === uid)) next.add(uid);
  });
  if (next.size === online.size && [...next].every((id) => online.has(id))) return;
  online = next.size ? next : EMPTY;
  listeners.forEach((l) => l());
}

function watch(uid: string) {
  if (watchers.has(uid)) return;
  const ch = privateChannel(topicOf(uid), { presence: { enabled: true } });
  watchers.set(uid, ch);
  ch.on('presence', { event: 'sync' }, () => {
    if (watchers.get(uid) === ch) emit();
  }).subscribe((status) => {
    if (watchers.get(uid) === ch && status !== 'SUBSCRIBED') emit();
  });
}

function unwatch(uid: string) {
  const ch = watchers.get(uid);
  if (!ch) return;
  watchers.delete(uid);
  void supabase.removeChannel(ch);
}

/** Makes the watched set exactly `ids` (first MAX_WATCH). */
function setWatched(ids: string[]) {
  const want = new Set(ids.slice(0, MAX_WATCH));
  [...watchers.keys()].forEach((uid) => {
    if (!want.has(uid)) unwatch(uid);
  });
  want.forEach(watch);
  emit();
}

/** Ref-counted demand from useOnlineUsers() consumers. */
let demand = 0;
let demandIds: string[] = [];

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => online;

/* ------------------------------------------------------------------ who I may see */

const ALLOWED_TTL = 60_000;
let allowedCache: { uid: string; ids: string[]; at: number } | null = null;
let allowedInflight: { uid: string; p: Promise<string[]> } | null = null;

/**
 * Who I may see online (cached for a minute, shared by all screens): `presence_allowed()` = accepted chat
 * partners + mutual follows, minus anyone who restricts me or has a block with me. Falls back to the
 * client-side list (inbox partners + mutuals) when the RPC isn't deployed yet (the topic policies still
 * decide what can actually be joined).
 */
function loadAllowed(uid: string): Promise<string[]> {
  if (allowedCache && allowedCache.uid === uid && Date.now() - allowedCache.at < ALLOWED_TTL) return Promise.resolve(allowedCache.ids);
  if (allowedInflight && allowedInflight.uid === uid) return allowedInflight.p;
  const p = (async () => {
    const ids = new Set<string>();
    const { data, error } = await supabase.rpc('presence_allowed');
    if (!error && Array.isArray(data)) {
      for (const row of data as unknown[]) {
        const id = typeof row === 'string' ? row : row && typeof row === 'object' ? Object.values(row as Record<string, unknown>)[0] : null;
        if (typeof id === 'string') ids.add(id);
      }
    } else {
      const [inbox, following, followers] = await Promise.all([
        loadInbox().catch(() => []),
        supabase.from('follows').select('following_id').eq('follower_id', uid),
        supabase.from('follows').select('follower_id').eq('following_id', uid),
      ]);
      for (const r of inbox) if (r.other_id && r.request_state !== 'outgoing' && !r.blocked) ids.add(r.other_id);
      const followsMe = new Set(((followers.data ?? []) as { follower_id: string }[]).map((r) => r.follower_id));
      for (const r of (following.data ?? []) as { following_id: string }[]) if (followsMe.has(r.following_id)) ids.add(r.following_id);
    }
    ids.delete(uid);
    const list = [...ids].sort();
    allowedCache = { uid, ids: list, at: Date.now() };
    return list;
  })().finally(() => {
    allowedInflight = null;
  });
  allowedInflight = { uid, p };
  return p;
}

/**
 * Ids of users currently online (only people who share their online status, and only my chat partners
 * / mutuals). Privacy is both ways: with my own Online status off I don't see anyone else's either, so
 * this is empty.
 */
export function useOnlineUsers(): Set<string> {
  const { user, settings } = useAuth();
  const uid = user?.id ?? null;
  const visible = dmSettings(settings?.dm).online_status;
  const ids = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [allowed, setAllowed] = useState<{ uid: string; ids: string[] } | null>(null);

  useEffect(() => {
    if (!uid || !visible) return;
    let alive = true;
    const refresh = () =>
      loadAllowed(uid)
        .then((list) => alive && setAllowed({ uid, ids: list }))
        .catch(() => undefined);
    void refresh();
    // Re-check who I may see when coming back to the foreground (cheap: cached for a minute).
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refresh();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, [uid, visible]);

  const mine = allowed && allowed.uid === uid ? allowed.ids : null;
  useEffect(() => {
    if (!visible || !mine) return;
    demand += 1;
    demandIds = mine;
    setWatched(mine);
    return () => {
      demand = Math.max(0, demand - 1);
      if (demand === 0) {
        demandIds = [];
        setWatched([]);
      }
    };
  }, [visible, mine]);

  return useMemo(() => {
    if (!visible || !mine) return EMPTY;
    return ids;
  }, [visible, mine, ids]);
}

/* ------------------------------------------------------------------ last seen heartbeat */

/** Heartbeat interval while the app is open, and the minimum gap between two heartbeats. */
const HEARTBEAT_MS = 4 * 60_000;
const HEARTBEAT_MIN_GAP = 60_000;
let lastBeat = 0;

function beat(force = false) {
  const now = Date.now();
  if (!force && now - lastBeat < HEARTBEAT_MIN_GAP) return;
  lastBeat = now;
  void supabase.rpc('touch_last_seen').then(
    ({ error }) => {
      if (error) lastBeat = 0; // retry on the next trigger (offline, or migration not deployed yet)
    },
    () => {
      lastBeat = 0;
    },
  );
}

/** Announces me on `presence:<me>` while signed in, foregrounded and Online status is on. Mount once. */
export function usePresenceTracker(): void {
  const { user, settings } = useAuth();
  const uid = user?.id ?? null;
  const visible = dmSettings(settings?.dm).online_status;

  // Last seen: on open / foreground / background, and every HEARTBEAT_MS while active.
  useEffect(() => {
    if (!uid) return;
    lastBeat = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const startTimer = () => {
      if (!timer) timer = setInterval(() => beat(), HEARTBEAT_MS);
    };
    const stopTimer = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    if (AppState.currentState === 'active') {
      beat(true);
      startTimer();
    }
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        beat();
        startTimer();
      } else if (s === 'background') {
        // Leaving: record the exact time we were last here.
        beat(true);
        stopTimer();
      }
    });
    return () => {
      sub.remove();
      stopTimer();
    };
  }, [uid]);

  useEffect(() => {
    if (!uid || !visible) return;
    openOwn(uid);
    const set = (active: boolean) => {
      trackAs = active ? uid : null;
      void applyTrack();
    };
    set(AppState.currentState !== 'background');
    const sub = AppState.addEventListener('change', (s) => set(s === 'active'));
    return () => {
      sub.remove();
      trackAs = null;
      closeOwn();
    };
  }, [uid, visible]);

  // Signed out / switched accounts: drop every friend topic too.
  useEffect(() => {
    if (uid) return;
    if (demandIds.length) setWatched([]);
  }, [uid]);
}
