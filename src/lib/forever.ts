/**
 * Forever friends (server: supabase/migrations/20261117100000_forever_friends.sql).
 *
 * Up to 3 per person. Eligible = you follow each other + a 1:1 chat with >= 10 messages and at least one from
 * each of you. One asks (requestForever), the other accepts (respondForever). Once Forever, neither can block the
 * other (server refuses with hint 'forever_locked'; guardBlock() routes block entry points to the Block-locked
 * sheet first), their alerts break through mute + quiet hours (setting "Always gets through"), their calls ring
 * with the gold ringtone (ringtoneFor), milestones notify, and "Pause Forever" starts a 30 day removal.
 *
 * Client state: one shared, per-account store of my Forever list + settings (useForeverList / useIsForever /
 * useForeverIds read it). It reloads on mount of any hook, after every mutation here, and on Realtime changes to
 * forever_pairs / forever_requests (RLS: only the pair sees its rows).
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { supabase } from './supabase';

/* ================================================================== constants */

export const FOREVER_MAX = 3;
export const FOREVER_MIN_MESSAGES = 10;
/** Days a "Pause Forever" removal request runs before the pair ends. */
export const FOREVER_REMOVAL_DAYS = 30;

/** Gold palette (designs: #FFD36A → #FF6F91 gradient, #FFB020 ring, #1A1206 ink on gold, #E5D3A8 / #FFE2A6 text). */
export const GOLD = {
  light: '#FFD36A',
  mid: '#FFB020',
  deep: '#FF6F91',
  ink: '#1A1206',
  inkBg: '#1A1206',
  text: '#E5D3A8',
  textBright: '#FFE2A6',
  gradient: ['#FFD36A', '#FF6F91'] as const,
} as const;

/** Bundled ringtones (assets/sounds, also in app.json expo-notifications `sounds`). */
export const GOLD_RINGTONE = require('../../assets/sounds/zoyra_gold_ring.wav') as number;
export const DEFAULT_RINGTONE = require('../../assets/sounds/zoyra_ring.wav') as number;
/** File name of the gold ringtone in the native bundle (iOS sound / Android res/raw). */
export const GOLD_RINGTONE_FILE = 'zoyra_gold_ring.wav';
/** Android channel the push function uses for Forever calls (must match FOREVER_CALL_CHANNEL_ID in supabase/functions/push). */
export const FOREVER_CALL_CHANNEL_ID = 'forever_call';

/* ================================================================== types */

export type ForeverFriend = {
  user_id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  since: string;
  /** Day N of Forever (Day 1 = the day it started). */
  days: number;
  /** Messages in your 1:1 chat (calls excluded). */
  messages: number;
  /** Consecutive days you both sent a message (ending today or yesterday). */
  streak: number;
  conversation_id: string | null;
  removal_requested_by: string | null;
  removal_at: string | null;
  /** Starred messages + milestones in the shared vault. */
  vault_count: number;
};

export type ForeverReason =
  | 'self'
  | 'not_found'
  | 'blocked'
  | 'already'
  | 'pending_out'
  | 'pending_in'
  | 'not_mutual'
  | 'not_enough_chat'
  | 'your_slots_full'
  | 'their_slots_full';

export type ForeverState = 'none' | 'pending_out' | 'pending_in' | 'forever';

export type ForeverEligibility = {
  eligible: boolean;
  reason: ForeverReason | null;
  state: ForeverState;
  request_id: string | null;
  mutual_follow: boolean;
  messages: number;
  mine: number;
  theirs: number;
  min_messages: number;
  conversation_id: string | null;
  slots_left: number;
  their_slots_full: boolean;
};

export type ForeverRequestInfo = {
  id: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  created_at: string;
  from_user: string;
  to_user: string;
  incoming: boolean;
  other_id: string;
  other_name: string;
  other_username: string | null;
  other_avatar: string | null;
};

export type ForeverPendingRequest = {
  id: string;
  incoming: boolean;
  created_at: string;
  other_id: string;
  other_name: string;
  other_username: string | null;
  other_avatar: string | null;
};

export type ForeverSettings = { breakthrough: boolean; milestones: boolean; ringtone: 'gold' | 'default' };
export const DEFAULT_FOREVER_SETTINGS: ForeverSettings = { breakthrough: true, milestones: true, ringtone: 'gold' };

export type ForeverMilestone = { key: string; kind: 'anniversary' | 'messages' | 'streak' | 'start'; value: number; title: string; reached_at: string };
export type ForeverVault = {
  since: string;
  conversation_id: string | null;
  /** False until the starred-messages table exists on the server. */
  starred_ready: boolean;
  starred: { message_id: string; starred_by: string[]; starred_at: string }[];
  milestones: ForeverMilestone[];
};

/* ================================================================== errors */

type PgError = { message?: string; code?: string; hint?: string };

/** Hints raised by the Forever RPCs (the message is already a friendly sentence). */
const FOREVER_HINTS = new Set([
  'self',
  'not_found',
  'blocked',
  'already',
  'pending_out',
  'pending_in',
  'not_mutual',
  'not_enough_chat',
  'your_slots_full',
  'their_slots_full',
  'rate_limited',
  'cooldown',
  'not_forever',
  'forever_locked',
  'invalid',
]);

/** A sentence for errors from the Forever RPCs. */
export function foreverErrorMessage(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  const err = (e ?? {}) as PgError;
  const msg = typeof err.message === 'string' ? err.message : '';
  if (err.hint && FOREVER_HINTS.has(err.hint) && msg) return msg;
  if (/could not find the function|does not exist/i.test(msg)) return 'Forever needs the latest server update.';
  if (/network|fetch/i.test(msg)) return "You're offline. Try again when you're connected.";
  return msg || fallback;
}

/** True when a block failed because the person is a Forever friend. */
export const isForeverLockedError = (e: unknown) => (e as PgError | null)?.hint === 'forever_locked';

const raise = (error: PgError | null) => {
  if (error) throw Object.assign(new Error(foreverErrorMessage(error)), { hint: error.hint, code: error.code });
};

/* ================================================================== routes */

export const foreverHubHref = '/forever' as Href;
export const foreverPromptHref = (uid: string) => `/forever-prompt?uid=${encodeURIComponent(uid)}` as Href;
export const foreverSentHref = (uid: string, requestId: string) => `/forever-sent?uid=${encodeURIComponent(uid)}&id=${encodeURIComponent(requestId)}` as Href;
export const foreverAskHref = (requestId: string) => `/forever-ask?id=${encodeURIComponent(requestId)}` as Href;
export const foreverDoneHref = (uid: string) => `/forever-done?uid=${encodeURIComponent(uid)}` as Href;
export const foreverVaultHref = (uid: string) => `/forever-vault?uid=${encodeURIComponent(uid)}` as Href;
export const foreverBlockLockedHref = (uid: string, cid?: string | null) =>
  `/forever-block-locked?uid=${encodeURIComponent(uid)}${cid ? `&cid=${encodeURIComponent(cid)}` : ''}` as Href;

/* ================================================================== API */

export async function foreverEligibility(other: string): Promise<ForeverEligibility> {
  const { data, error } = await supabase.rpc('forever_eligibility', { other });
  raise(error);
  return data as ForeverEligibility;
}

export async function isForever(other: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_forever', { other });
  raise(error);
  return data === true;
}

/** Ask `other`. If they already asked you, this accepts their request (status 'accepted'). */
export async function requestForever(other: string): Promise<{ id: string; status: 'pending' | 'accepted' }> {
  const { data, error } = await supabase.rpc('request_forever', { other });
  raise(error);
  void refreshForever();
  return data as { id: string; status: 'pending' | 'accepted' };
}

export async function respondForever(requestId: string, accept: boolean): Promise<'accepted' | 'declined'> {
  const { data, error } = await supabase.rpc('respond_forever', { request_id: requestId, accept });
  raise(error);
  void refreshForever();
  return ((data as { status?: string } | null)?.status === 'accepted' ? 'accepted' : 'declined');
}

export async function cancelForeverRequest(requestId: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_forever_request', { request_id: requestId });
  raise(error);
  void refreshForever();
}

export async function foreverRequestInfo(requestId: string): Promise<ForeverRequestInfo | null> {
  const { data, error } = await supabase.rpc('forever_request_info', { request_id: requestId });
  raise(error);
  return ((data ?? []) as ForeverRequestInfo[])[0] ?? null;
}

export async function listForeverPending(): Promise<ForeverPendingRequest[]> {
  const { data, error } = await supabase.rpc('forever_pending');
  raise(error);
  return (data ?? []) as ForeverPendingRequest[];
}

export async function listForever(): Promise<ForeverFriend[]> {
  const { data, error } = await supabase.rpc('list_forever');
  raise(error);
  return ((data ?? []) as ForeverFriend[]).map((f) => ({ ...f, days: Number(f.days) || 1, messages: Number(f.messages) || 0, streak: Number(f.streak) || 0, vault_count: Number(f.vault_count) || 0 }));
}

export type ForeverCandidate = {
  user_id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  messages: number;
  eligible: boolean;
  reason: ForeverReason | 'cooldown' | null;
  state: ForeverState;
  request_id: string | null;
};

/** "Add a Forever" picker: my mutual follows that aren't Forever yet (eligible first, then most chatted). */
export async function listForeverCandidates(): Promise<ForeverCandidate[]> {
  const { data, error } = await supabase.rpc('forever_candidates');
  raise(error);
  return ((data ?? []) as ForeverCandidate[])
    .map((c) => ({ ...c, messages: Number(c.messages) || 0 }))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.messages - a.messages);
}

/** Short reason a person can't be asked yet (picker rows, prompt sheet). */
export function foreverReasonText(reason: string | null | undefined, name: string): string {
  switch (reason) {
    case 'not_mutual':
      return 'You need to follow each other first';
    case 'not_enough_chat':
      return 'Chat a little more first';
    case 'your_slots_full':
      return 'You already have 3 Forever friends';
    case 'their_slots_full':
      return `${name} already has 3 Forever friends`;
    case 'pending_out':
      return 'Request sent';
    case 'pending_in':
      return `${name} asked you`;
    case 'already':
      return `${name} is your Forever`;
    case 'blocked':
    case 'not_found':
      return 'Not available';
    default:
      return '';
  }
}

/** "Pause Forever": starts the 30 day removal. Returns when it ends. */
export async function requestForeverRemoval(other: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('request_forever_removal', { other });
  raise(error);
  void refreshForever();
  return typeof data === 'string' ? data : null;
}

/** Either person can cancel a pending removal. */
export async function cancelForeverRemoval(other: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_forever_removal', { other });
  raise(error);
  void refreshForever();
}

export async function getForeverSettings(): Promise<ForeverSettings> {
  const { data, error } = await supabase.rpc('my_forever_settings');
  raise(error);
  return { ...DEFAULT_FOREVER_SETTINGS, ...((data ?? {}) as Partial<ForeverSettings>) };
}

export async function setForeverSettings(patch: Partial<ForeverSettings>): Promise<ForeverSettings> {
  const { data, error } = await supabase.rpc('set_forever_settings', {
    p_breakthrough: patch.breakthrough ?? null,
    p_milestones: patch.milestones ?? null,
    p_ringtone: patch.ringtone ?? null,
  });
  raise(error);
  const next = { ...DEFAULT_FOREVER_SETTINGS, ...((data ?? {}) as Partial<ForeverSettings>) };
  setStore({ settings: next });
  return next;
}

/** Mute our chat for me and keep "Always gets through" from overriding it (Block-locked → Mute). `on=false` lifts both. */
export async function setForeverHush(other: string, on: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_forever_hush', { other, p_on: on });
  raise(error);
}

export async function foreverVault(other: string): Promise<ForeverVault> {
  const { data, error } = await supabase.rpc('forever_vault', { other });
  raise(error);
  const v = (data ?? {}) as Partial<ForeverVault>;
  return {
    since: v.since ?? new Date().toISOString(),
    conversation_id: v.conversation_id ?? null,
    starred_ready: v.starred_ready === true,
    starred: Array.isArray(v.starred) ? v.starred : [],
    milestones: Array.isArray(v.milestones) ? v.milestones : [],
  };
}

/* ================================================================== shared store */

type Store = {
  uid: string | null;
  list: ForeverFriend[] | null;
  settings: ForeverSettings | null;
  error: string | null;
  loadedAt: number;
};

let store: Store = { uid: null, list: null, settings: null, error: null, loadedAt: 0 };
let ids: Set<string> = new Set();
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let channel: RealtimeChannel | null = null;

function setStore(patch: Partial<Store>) {
  store = { ...store, ...patch };
  if (patch.list !== undefined) ids = new Set((store.list ?? []).map((f) => f.user_id));
  listeners.forEach((l) => l());
}

async function currentUid(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}

/** Reloads my Forever list + settings (deduplicated). Never throws. */
export function refreshForever(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    const uid = await currentUid();
    if (!uid) {
      setStore({ uid: null, list: [], settings: null, error: null, loadedAt: Date.now() });
      return;
    }
    if (store.uid !== uid) setStore({ uid, list: null, settings: null, error: null, loadedAt: 0 });
    try {
      const [list, settings] = await Promise.all([listForever(), getForeverSettings().catch(() => store.settings ?? DEFAULT_FOREVER_SETTINGS)]);
      setStore({ uid, list, settings, error: null, loadedAt: Date.now() });
    } catch (e) {
      setStore({ uid, list: store.list ?? [], error: foreverErrorMessage(e), loadedAt: Date.now() });
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Drop the cached list (sign-out / account switch). */
export function clearForeverCache() {
  setStore({ uid: null, list: null, settings: null, error: null, loadedAt: 0 });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) startRealtime();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopRealtime();
  };
}

function startRealtime() {
  if (channel) return;
  try {
    channel = supabase
      .channel(`forever:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'forever_pairs' }, () => void refreshForever())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'forever_requests' }, () => {
        pendingVersion++;
        listeners.forEach((l) => l());
      })
      .subscribe();
  } catch {
    channel = null;
  }
}

function stopRealtime() {
  const ch = channel;
  channel = null;
  if (ch) void supabase.removeChannel(ch).then(undefined, () => undefined);
}

/** Bumped on forever_requests changes so pending lists can reload. */
let pendingVersion = 0;

const STALE_MS = 30_000;
const getSnapshot = () => store;
const getIds = () => ids;
const getPendingVersion = () => pendingVersion;

/** Ids of my Forever friends right now (cached; may be empty before the first load). */
export const foreverIdsNow = (): ReadonlySet<string> => ids;
/** My Forever settings right now (cached; defaults before the first load). */
export const foreverSettingsNow = (): ForeverSettings => store.settings ?? DEFAULT_FOREVER_SETTINGS;

function useStoreLoad() {
  useEffect(() => {
    if (!store.list || Date.now() - store.loadedAt > STALE_MS) void refreshForever();
  }, []);
}

/* ================================================================== hooks */

/** My Forever friends (oldest first = pinned order). `list` is null while the first load runs. */
export function useForeverList(): { list: ForeverFriend[] | null; error: string | null; reload: () => Promise<void>; settings: ForeverSettings } {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  useStoreLoad();
  return { list: s.list, error: s.error, reload: refreshForever, settings: s.settings ?? DEFAULT_FOREVER_SETTINGS };
}

/** Set of my Forever friends' ids (for ∞ badges / pinning in lists). */
export function useForeverIds(): ReadonlySet<string> {
  const set = useSyncExternalStore(subscribe, getIds);
  useStoreLoad();
  return set;
}

/** Is `uid` my Forever friend? undefined while unknown (first load). */
export function useIsForever(uid: string | null | undefined): boolean | undefined {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  useStoreLoad();
  if (!uid) return false;
  if (!s.list) return undefined;
  return s.list.some((f) => f.user_id === uid);
}

/** My Forever pair with `uid` (null when not Forever, undefined while loading). */
export function useForeverFriend(uid: string | null | undefined): ForeverFriend | null | undefined {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  useStoreLoad();
  if (!uid) return null;
  if (!s.list) return undefined;
  return s.list.find((f) => f.user_id === uid) ?? null;
}

/** Eligibility of me ↔ `uid` (reloads when Forever changes). `data` undefined while loading, null on error. */
export function useForeverEligibility(uid: string | null | undefined): { data: ForeverEligibility | null | undefined; reload: () => void } {
  const [state, setState] = useState<{ key: string; data: ForeverEligibility | null } | null>(null);
  const [tick, setTick] = useState(0);
  const s = useSyncExternalStore(subscribe, getSnapshot);
  const version = useSyncExternalStore(subscribe, getPendingVersion);
  const listKey = s.list ? s.list.map((f) => f.user_id + (f.removal_at ?? '')).join(',') : '';
  const key = `${uid ?? ''}|${listKey}|${version}|${tick}`;
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    foreverEligibility(uid)
      .then((data) => alive && setState({ key, data }))
      .catch(() => alive && setState({ key, data: null }));
    return () => {
      alive = false;
    };
  }, [uid, key]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  if (!uid) return { data: null, reload };
  return { data: state && state.key === key ? state.data : state?.data, reload };
}

/** My open Forever requests (incoming + outgoing), live. */
export function useForeverPending(): { pending: ForeverPendingRequest[] | null; reload: () => void } {
  const [pending, setPending] = useState<ForeverPendingRequest[] | null>(null);
  const [tick, setTick] = useState(0);
  const version = useSyncExternalStore(subscribe, getPendingVersion);
  useEffect(() => {
    let alive = true;
    listForeverPending()
      .then((p) => alive && setPending(p))
      .catch(() => alive && setPending((cur) => cur ?? []));
    return () => {
      alive = false;
    };
  }, [version, tick]);
  return { pending, reload: useCallback(() => setTick((t) => t + 1), []) };
}

/* ================================================================== block guard */

/**
 * Call before any block flow. Returns true when blocking may go ahead. When `uid` is my Forever friend it opens
 * the Block-locked sheet (Mute / Restrict / Archive / Pause Forever) instead and returns false. The server refuses
 * the block anyway (hint 'forever_locked'), so on a network error this lets the flow continue.
 */
export async function guardBlock(uid: string, opts?: { cid?: string | null; replace?: boolean }): Promise<boolean> {
  let forever = ids.has(uid);
  if (!forever) {
    try {
      forever = await isForever(uid);
    } catch {
      forever = false;
    }
  }
  if (!forever) return true;
  const href = foreverBlockLockedHref(uid, opts?.cid);
  if (opts?.replace) router.replace(href);
  else router.push(href);
  return false;
}

/* ================================================================== ringtone */

/**
 * The incoming-call ringtone for `callerId`: the gold chime for a Forever friend (unless I picked the default
 * ringtone in the Forever hub), else Zoyra's normal ring. Synchronous, from the cached Forever list; call
 * refreshForever() (or mount any Forever hook) earlier for a warm cache, or use ringtoneForAsync.
 */
export function ringtoneFor(callerId: string | null | undefined): number {
  if (!callerId || !ids.has(callerId)) return DEFAULT_RINGTONE;
  return foreverSettingsNow().ringtone === 'default' ? DEFAULT_RINGTONE : GOLD_RINGTONE;
}

/** Same as ringtoneFor, loading the Forever list first when it was never loaded. */
export async function ringtoneForAsync(callerId: string | null | undefined): Promise<number> {
  if (!store.list) await refreshForever();
  return ringtoneFor(callerId);
}

/** Android notification channel with the gold ringtone (the push function sends Forever calls to it). Never throws. */
let channelReady = false;
export async function ensureForeverChannel(): Promise<void> {
  if (Platform.OS !== 'android' || channelReady) return;
  try {
    await Notifications.setNotificationChannelAsync(FOREVER_CALL_CHANNEL_ID, {
      name: 'Forever calls',
      description: 'Calls from your Forever friends (gold ringtone)',
      importance: AndroidImportance.MAX,
      sound: GOLD_RINGTONE_FILE,
      enableVibrate: true,
      vibrationPattern: [0, 700, 1300, 700],
      lightColor: GOLD.mid,
    });
    channelReady = true;
  } catch {
    // channel creation is best effort; the OS falls back to the default channel
  }
}

/* ================================================================== helpers */

/** Forever friends first (oldest pair first), then the rest in their original order. Stable. */
export function sortForeverFirst<T>(rows: readonly T[], uidOf: (row: T) => string | null | undefined, list?: readonly ForeverFriend[] | null): T[] {
  const order = new Map((list ?? store.list ?? []).map((f, i) => [f.user_id, i]));
  const rank = (r: T) => {
    const u = uidOf(r);
    const i = u ? order.get(u) : undefined;
    return i === undefined ? Number.MAX_SAFE_INTEGER : i;
  };
  return rows
    .map((r, i) => ({ r, i, k: rank(r) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.r);
}

/** "12 Nov" (this year) / "12 Nov 2025". */
export function foreverSinceLabel(since: string, now = new Date()): string {
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return d.toLocaleDateString('en-GB', opts);
}

/** Whole days until a removal takes effect (min 0). */
export function daysUntil(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : Math.max(0, Math.ceil((t - now) / 86_400_000));
}

export const firstName = (name: string | null | undefined, fallback = 'They') => name?.trim().split(/\s+/)[0] || fallback;

/* ================================================================== person loader (screens) */

export type ForeverPerson = { id: string; display_name: string; avatar_url: string | null; username: string | null };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/**
 * A person's public profile by id, loaded from the server (route params never carry names: a crafted link could
 * show one name and act on another id). undefined = loading, null = not found / invalid id.
 */
export function useForeverPerson(uid: string | null | undefined): ForeverPerson | null | undefined {
  const [state, setState] = useState<{ uid: string; p: ForeverPerson | null } | null>(null);
  const valid = isUuid(uid);
  useEffect(() => {
    if (!valid || !uid) return;
    let alive = true;
    void supabase
      .from('profiles')
      .select('id, display_name, avatar_url, username')
      .eq('id', uid)
      .maybeSingle()
      .then(
        ({ data }) => alive && setState({ uid, p: (data as ForeverPerson | null) ?? null }),
        () => alive && setState({ uid, p: null }),
      );
    return () => {
      alive = false;
    };
  }, [uid, valid]);
  if (!valid) return null;
  return state && state.uid === uid ? state.p : undefined;
}
