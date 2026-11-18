import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { useSyncExternalStore } from 'react';

/**
 * Stable online/offline status for the whole app.
 *
 * NetInfo's `isInternetReachable` probe briefly reports `false` on healthy Wi-Fi (slow probe, phone
 * waking up, busy router). Reacting to every blip made the app flash "You are offline" and then
 * "Back online". Here:
 *  - no network at all (`isConnected === false`, e.g. airplane mode) → offline immediately;
 *  - connected but the reachability probe failed → offline only if it is still failing after a
 *    grace period AND a fresh `NetInfo.refresh()` confirms it;
 *  - online again → immediately.
 */
const CONFIRM_MS = 5000;

let online: boolean | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (online === next) return;
  online = next;
  listeners.forEach((l) => l());
}

function cancelPending() {
  if (pending) clearTimeout(pending);
  pending = null;
}

function onState(s: NetInfoState) {
  if (s.isConnected === null) return; // not known yet
  if (s.isConnected === false) {
    cancelPending();
    set(false);
    return;
  }
  if (s.isInternetReachable !== false) {
    cancelPending();
    set(true);
    return;
  }
  // Connected, but the reachability probe failed: wait and re-check before calling it offline.
  if (online === null) online = true; // assume online while unconfirmed (avoids a flash at launch)
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    NetInfo.refresh()
      .then((r) => {
        if (r.isConnected === false || r.isInternetReachable === false) set(false);
        else set(true);
      })
      .catch(() => undefined);
  }, CONFIRM_MS);
}

let started = false;
function start() {
  if (started) return;
  started = true;
  NetInfo.addEventListener(onState);
  NetInfo.fetch().then(onState).catch(() => undefined);
}

/** Current stable status (`true` until proven offline). */
export function isOnlineStable(): boolean {
  start();
  return online !== false;
}

/** Subscribe to stable status changes. Returns an unsubscribe function. */
export function subscribeOnline(listener: (online: boolean) => void): () => void {
  start();
  const l = () => listener(online !== false);
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** React hook: stable online status. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => subscribeOnline(cb),
    () => isOnlineStable(),
    () => true,
  );
}
