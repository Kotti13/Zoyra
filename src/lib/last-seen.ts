/**
 * Last seen & online (Messages › Message privacy › Last seen and online, `/last-seen`).
 *
 * Settings live in `user_settings.dm` next to the other message privacy keys (dm.ts DmSettings):
 *   last_seen_who     'everyone' | 'mutuals' | 'forever' | 'nobody'  (default 'mutuals')
 *   last_seen_approx  show "last seen recently" instead of the time  (default false)
 *   online_status / read_receipts / typing                            existing DmSettings keys
 *
 * Server (supabase/migrations/20261117120000_notes_v2_last_seen.sql):
 *   touch_last_seen()   heartbeat, sent by usePresenceTracker (src/lib/presence.ts)
 *   last_seen_for(uid)  what I may see of uid: reciprocal (if I hide mine from them I don't see theirs), never
 *                       across a block / restriction, approximate when either side chose "approximate".
 *
 * `useLastSeen(uid)` → { label, online } for a chat header: "online" while their presence is visible, else
 * "last seen today at 9:41 PM" / "last seen yesterday at 9:41 PM" / "last seen Mon at 9:41 PM" /
 * "last seen 12 Nov" / "last seen recently" …, or null when hidden.
 */
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { useOnlineUsers } from './presence';
import { supabase } from './supabase';

export type LastSeenWho = 'everyone' | 'mutuals' | 'forever' | 'nobody';

export const LAST_SEEN_WHO: { key: LastSeenWho; title: string; hint: string }[] = [
  { key: 'everyone', title: 'Everyone', hint: 'Anyone who can message you' },
  { key: 'mutuals', title: 'Mutuals', hint: 'People you follow who follow you back' },
  { key: 'forever', title: 'Forever only', hint: 'Only your Forever friends' },
  { key: 'nobody', title: 'Nobody', hint: 'You will not see theirs either' },
];

export type LastSeenPrefs = { last_seen_who: LastSeenWho; last_seen_approx: boolean };

const WHO = new Set<string>(LAST_SEEN_WHO.map((w) => w.key));

/** My last-seen settings from the raw `settings.dm` object (unset / invalid → defaults). */
export function lastSeenPrefs(raw: unknown): LastSeenPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const who = typeof o.last_seen_who === 'string' && WHO.has(o.last_seen_who) ? (o.last_seen_who as LastSeenWho) : 'mutuals';
  return { last_seen_who: who, last_seen_approx: o.last_seen_approx === true };
}

/** Server answer of last_seen_for(). */
export type LastSeenInfo = {
  visible: boolean;
  at: string | null;
  approx: boolean;
  bucket: 'recently' | 'week' | 'month' | 'long' | null;
  online_visible: boolean;
};

const HIDDEN: LastSeenInfo = { visible: false, at: null, approx: false, bucket: null, online_visible: false };

const timeOf = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "last seen today at 9:41 PM" etc. from an exact time. */
export function lastSeenAtLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (now.getTime() - d.getTime() < 60_000) return 'last seen just now';
  if (days <= 0) return `last seen today at ${timeOf(d)}`;
  if (days === 1) return `last seen yesterday at ${timeOf(d)}`;
  if (days < 7) return `last seen ${d.toLocaleDateString(undefined, { weekday: 'short' })} at ${timeOf(d)}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return `last seen ${d.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** Label for a last_seen_for() answer (null when hidden). */
export function lastSeenLabel(info: LastSeenInfo | null): string | null {
  if (!info?.visible) return null;
  if (info.approx) {
    switch (info.bucket) {
      case 'recently':
        return 'last seen recently';
      case 'week':
        return 'last seen within a week';
      case 'month':
        return 'last seen within a month';
      default:
        return 'last seen a long time ago';
    }
  }
  return info.at ? lastSeenAtLabel(info.at) : null;
}

/** What uid's last seen looks like to me (hidden when the RPC isn't deployed or fails). */
export async function fetchLastSeen(uid: string): Promise<LastSeenInfo> {
  const { data, error } = await supabase.rpc('last_seen_for', { uid });
  if (error || !data || typeof data !== 'object') return HIDDEN;
  const d = data as Partial<LastSeenInfo>;
  return {
    visible: d.visible === true,
    at: typeof d.at === 'string' ? d.at : null,
    approx: d.approx === true,
    bucket: (d.bucket as LastSeenInfo['bucket']) ?? null,
    online_visible: d.online_visible === true,
  };
}

/** Short-lived cache shared by every header showing the same person. */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; info: LastSeenInfo }>();
const inflight = new Map<string, Promise<LastSeenInfo>>();

function load(uid: string, force = false): Promise<LastSeenInfo> {
  const hit = cache.get(uid);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.info);
  const running = inflight.get(uid);
  if (running) return running;
  const p = fetchLastSeen(uid)
    .then((info) => {
      cache.set(uid, { at: Date.now(), info });
      if (cache.size > 200) cache.delete(cache.keys().next().value as string);
      return info;
    })
    .finally(() => inflight.delete(uid));
  inflight.set(uid, p);
  return p;
}

/**
 * Last seen / online for a chat header. `online` comes from realtime presence (only people who share it, see
 * presence.ts); otherwise `label` is the server's last-seen answer, refreshed every minute while shown, when
 * the app comes back to the foreground and right after they go offline. null = hidden (or unknown yet).
 */
export function useLastSeen(uid: string | null | undefined): { label: string | null; online: boolean } {
  const onlineIds = useOnlineUsers();
  const online = !!uid && onlineIds.has(uid);
  const [state, setState] = useState<{ uid: string; info: LastSeenInfo } | null>(null);
  /** Bumped when they go offline: the server time moved, skip the cache. */
  const [offlineAt, setOfflineAt] = useState(0);
  const [wasOnline, setWasOnline] = useState(online);
  if (wasOnline !== online) {
    setWasOnline(online);
    if (!online) setOfflineAt((n) => n + 1);
  }

  useEffect(() => {
    if (!uid) return;
    let alive = true;
    const refresh = (force: boolean) =>
      void load(uid, force).then((info) => {
        if (alive) setState({ uid, info });
      });
    refresh(offlineAt > 0);
    const timer = setInterval(() => refresh(true), CACHE_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh(true);
    });
    return () => {
      alive = false;
      clearInterval(timer);
      sub.remove();
    };
  }, [uid, offlineAt]);

  const info = state && state.uid === uid ? state.info : null;
  if (!uid) return { label: null, online: false };
  if (online) return { label: 'online', online: true };
  return { label: lastSeenLabel(info), online: false };
}
