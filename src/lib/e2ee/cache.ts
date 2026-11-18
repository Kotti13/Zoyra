import AsyncStorage from '@react-native-async-storage/async-storage';

import { fromUtf8, openLocal, sealLocal, utf8 } from './crypto';

/**
 * Decrypted-payload cache: in-memory LRU + AsyncStorage, where every entry is sealed with a random
 * per-user key that lives in SecureStore (./keystore.ts cacheKey). Many messages don't fit SecureStore
 * (small, slow), so only the key goes there. Entries are keyed by message id and tagged with the
 * message signature, so an edit (new signature) is a cache miss.
 */

export type CacheEntry<P> = { sig: string; cid: string; at: string; payload: P };

const MEM_MAX = 800;
const mem = new Map<string, CacheEntry<unknown>>();
const prefix = (uid: string) => `zoyra.e2ee.c.${uid}.`;

function remember(id: string, e: CacheEntry<unknown>) {
  mem.delete(id);
  mem.set(id, e);
  if (mem.size > MEM_MAX) {
    const oldest = mem.keys().next().value;
    if (oldest !== undefined) mem.delete(oldest);
  }
}

const sigTag = (signature: string) => signature.slice(0, 24);

export async function cacheGet<P>(uid: string, key: Uint8Array, id: string, signature: string): Promise<P | null> {
  const hit = mem.get(id) as CacheEntry<P> | undefined;
  if (hit) return hit.sig === sigTag(signature) ? hit.payload : null;
  try {
    const raw = await AsyncStorage.getItem(prefix(uid) + id);
    if (!raw) return null;
    const e = JSON.parse(fromUtf8(openLocal(key, raw, `msg:${id}`))) as CacheEntry<P>;
    remember(id, e);
    return e.sig === sigTag(signature) ? e.payload : null;
  } catch {
    return null;
  }
}

export async function cachePut<P>(uid: string, key: Uint8Array, id: string, signature: string, cid: string, payload: P): Promise<void> {
  const e: CacheEntry<P> = { sig: sigTag(signature), cid, at: new Date().toISOString(), payload };
  remember(id, e);
  try {
    await AsyncStorage.setItem(prefix(uid) + id, sealLocal(key, utf8(JSON.stringify(e)), `msg:${id}`));
  } catch {
    // memory only
  }
}

export async function cacheDelete(uid: string, ids: string[]): Promise<void> {
  ids.forEach((id) => mem.delete(id));
  await AsyncStorage.multiRemove(ids.map((id) => prefix(uid) + id)).catch(() => {});
}

/** Every cached entry (decrypted) for local search. Optionally one conversation only. */
export async function cacheScan<P>(uid: string, key: Uint8Array, cid?: string): Promise<(CacheEntry<P> & { id: string })[]> {
  const out: (CacheEntry<P> & { id: string })[] = [];
  let keys: readonly string[] = [];
  try {
    keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix(uid)));
  } catch {
    return out;
  }
  for (let i = 0; i < keys.length; i += 200) {
    const pairs = await AsyncStorage.multiGet(keys.slice(i, i + 200)).catch(() => [] as readonly [string, string | null][]);
    for (const [k, raw] of pairs) {
      if (!raw) continue;
      const id = k.slice(prefix(uid).length);
      try {
        const e = JSON.parse(fromUtf8(openLocal(key, raw, `msg:${id}`))) as CacheEntry<P>;
        if (!cid || e.cid === cid) out.push({ ...e, id });
      } catch {
        // stale entry from another cache key
      }
    }
  }
  return out;
}

export async function cacheClear(uid: string): Promise<void> {
  mem.clear();
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix(uid)));
    await AsyncStorage.multiRemove(keys);
  } catch {
    // ignore
  }
}

/** Drops the in-memory layer (account switch). */
export function cacheResetMemory(): void {
  mem.clear();
}
