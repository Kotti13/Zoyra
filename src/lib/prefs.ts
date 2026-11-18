import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useSyncExternalStore } from 'react';

/**
 * Device-only preferences (`zoyra.pref.<key>` in AsyncStorage) behind a synchronous cache, so
 * non-React code such as the player can read a setting without awaiting storage, and screens can
 * subscribe with `usePref` and re-render whenever any writer calls `setPref`.
 *
 * Every `zoyra.pref.*` key is hydrated once at startup. Until then `getPref` returns the fallback;
 * `usePref` re-renders when hydration finishes. A `setPref` made before hydration wins over the
 * stored value.
 */
const PREFIX = 'zoyra.pref.';
const cache = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();
const anyListeners = new Set<() => void>();
let ready = false;

function emit(key: string) {
  listeners.get(key)?.forEach((l) => l());
  anyListeners.forEach((l) => l());
}

const hydration: Promise<void> = AsyncStorage.getAllKeys()
  .then((keys) => AsyncStorage.multiGet(keys.filter((k) => k.startsWith(PREFIX))))
  .then((pairs) => {
    for (const [full, raw] of pairs) {
      const key = full.slice(PREFIX.length);
      if (raw == null || cache.has(key)) continue;
      try {
        cache.set(key, JSON.parse(raw) as unknown);
      } catch {
        // ignore a corrupt value; the fallback applies
      }
    }
  })
  .catch(() => undefined)
  .finally(() => {
    ready = true;
    const keys = new Set<string>([...listeners.keys()]);
    keys.forEach((k) => listeners.get(k)?.forEach((l) => l()));
    anyListeners.forEach((l) => l());
  });

/** Resolves once stored prefs are in the cache (never rejects). */
export function prefsReady(): Promise<void> {
  return hydration;
}

/** True once stored prefs are in the cache. */
export function prefsLoaded() {
  return ready;
}

export function getPref<V>(key: string, fallback: V): V {
  return cache.has(key) ? (cache.get(key) as V) : fallback;
}

export function setPref<V>(key: string, value: V) {
  cache.set(key, value);
  AsyncStorage.setItem(`${PREFIX}${key}`, JSON.stringify(value)).catch(() => undefined);
  emit(key);
}

/** Removes a pref so `getPref` returns the fallback again. */
export function clearPref(key: string) {
  cache.delete(key);
  AsyncStorage.removeItem(`${PREFIX}${key}`).catch(() => undefined);
  emit(key);
}

/** Calls `listener` whenever `key` changes (or hydration finishes). Returns an unsubscribe function. */
export function subscribePref(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(key);
  };
}

/** Calls `listener` on any pref change. Returns an unsubscribe function. */
export function subscribeAllPrefs(listener: () => void): () => void {
  anyListeners.add(listener);
  return () => {
    anyListeners.delete(listener);
  };
}

/**
 * Live device pref: `[value, set, loaded]`. Re-renders on every change from any screen.
 * Keep `fallback` a primitive or a stable reference (it is returned as-is while the key is unset).
 */
export function usePref<V>(key: string, fallback: V): readonly [V, (next: V) => void, boolean] {
  const subscribe = useCallback((l: () => void) => subscribePref(key, l), [key]);
  const value = useSyncExternalStore(
    subscribe,
    () => getPref(key, fallback),
    () => getPref(key, fallback),
  );
  const loaded = useSyncExternalStore(subscribe, prefsLoaded, prefsLoaded);
  const set = useCallback((next: V) => setPref(key, next), [key]);
  return [value, set, loaded] as const;
}
