import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { encPubFromPriv, fromB64, random, signPubFromPriv, toB64, type DeviceKeys, type KdfParams } from './crypto';

/**
 * Private keys at rest: expo-secure-store (iOS Keychain, WHEN_UNLOCKED_THIS_DEVICE_ONLY so keys never
 * travel in an iCloud / device backup; Android Keystore-backed encrypted prefs). Everything is
 * namespaced by user id (the app has an account switcher). Values are kept small (< 2 KB each):
 * one entry per old device key instead of one big keyring blob.
 *
 * Web has no SecureStore: keys live in memory only for the session (E2EE is mobile-first).
 *
 * iOS Notification Service Extension (plugins/zoyra-nse): it decrypts push previews with this device's
 * X25519 key, so a copy of ONLY that key lives in a second item the extension can read:
 *   service "zoyra.e2ee.nse:no-auth" (expo-secure-store appends ":no-auth"), account "zoyra.e2ee.nse.<device_id>",
 *   value {"v":1,"uid","d":device_id,"p":base64 enc_priv}, AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY (notifications
 *   arrive while the phone is locked; never leaves the device / backups).
 * Sharing: the app and the extension both list `$(AppIdentifierPrefix)com.zoyra.app.shared` FIRST in
 * keychain-access-groups (plugins/withZoyraNSE.js). The first entry is the default group for items written
 * without kSecAttrAccessGroup, so no team id is needed in JS. Items written before that entitlement existed
 * stay readable by the app (application-identifier group) and are re-written into the shared group by
 * `ensureNseKey` on the next load.
 */

const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const memory = new Map<string, string>();
const native = Platform.OS === 'ios' || Platform.OS === 'android';

async function getItem(key: string): Promise<string | null> {
  if (!native) return memory.get(key) ?? null;
  return SecureStore.getItemAsync(key, OPTS);
}
async function setItem(key: string, value: string): Promise<void> {
  if (!native) {
    memory.set(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value, OPTS);
}
async function deleteItem(key: string): Promise<void> {
  if (!native) {
    memory.delete(key);
    return;
  }
  await SecureStore.deleteItemAsync(key, OPTS);
}

const k = (uid: string, name: string) => `zoyra.e2ee.${uid}.${name}`;

/* ------------------------------------------------------------------ NSE copy (iOS only) */

const NSE_OPTS: SecureStore.SecureStoreOptions = { keychainService: 'zoyra.e2ee.nse', keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
/** Keychain account of the extension-readable copy of a device key (Swift side: ZoyraKeychain.swift). */
export const nseKeyName = (deviceId: string) => `zoyra.e2ee.nse.${deviceId.toLowerCase()}`; // Postgres prints uuids lower-case

async function writeNseKey(uid: string, deviceId: string, encPriv: Uint8Array): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    await SecureStore.setItemAsync(nseKeyName(deviceId), JSON.stringify({ v: 1, uid, d: deviceId, p: toB64(encPriv) }), NSE_OPTS);
  } catch {
    // previews fall back to "Sent you a message"
  }
}

async function deleteNseKey(deviceId: string): Promise<void> {
  if (Platform.OS !== 'ios') return;
  await SecureStore.deleteItemAsync(nseKeyName(deviceId), NSE_OPTS).catch(() => {});
}

/** Makes sure the extension-readable copy of this device's key exists (migration for keys saved before the NSE). */
export async function ensureNseKey(uid: string, deviceId: string, encPriv: Uint8Array): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    const raw = await SecureStore.getItemAsync(nseKeyName(deviceId), NSE_OPTS);
    if (raw && (JSON.parse(raw) as { p?: string }).p === toB64(encPriv)) return;
  } catch {
    // rewrite below
  }
  await writeNseKey(uid, deviceId, encPriv);
}

export type Identity = {
  device: DeviceKeys;
  accountSignPriv: Uint8Array;
  accountSignPub: Uint8Array;
};

/** Derived from the PIN at setup / restore so this device can re-encrypt the backup (new device key, rotation). */
export type PinMaterial = { backupKey: Uint8Array; verifier: Uint8Array; salt: Uint8Array; kdfParams: KdfParams; version: number };

/** Old device decryption keys (restored from backup or rotated away) kept for reading history. */
export type RingKey = { deviceId: string; encPriv: Uint8Array; encPub: Uint8Array; createdAt: string };

export async function loadIdentity(uid: string): Promise<Identity | null> {
  const raw = await getItem(k(uid, 'identity'));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { v: 1; deviceId: string; encPriv: string; signPriv: string; accountSignPriv: string };
    const encPriv = fromB64(o.encPriv);
    const signPriv = fromB64(o.signPriv);
    const accountSignPriv = fromB64(o.accountSignPriv);
    await ensureNseKey(uid, o.deviceId, encPriv);
    return {
      device: { deviceId: o.deviceId, encPriv, encPub: encPubFromPriv(encPriv), signPriv, signPub: signPubFromPriv(signPriv) },
      accountSignPriv,
      accountSignPub: signPubFromPriv(accountSignPriv),
    };
  } catch {
    return null;
  }
}

export async function saveIdentity(uid: string, id: Identity): Promise<void> {
  await setItem(
    k(uid, 'identity'),
    JSON.stringify({ v: 1, deviceId: id.device.deviceId, encPriv: toB64(id.device.encPriv), signPriv: toB64(id.device.signPriv), accountSignPriv: toB64(id.accountSignPriv) }),
  );
  // The previous device's copy (key rotation) stays until wipe, so pushes already in flight still decrypt.
  await writeNseKey(uid, id.device.deviceId, id.device.encPriv);
}

export async function loadPinMaterial(uid: string): Promise<PinMaterial | null> {
  const raw = await getItem(k(uid, 'pin'));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { backupKey: string; verifier: string; salt: string; kdfParams: KdfParams; version: number };
    return { backupKey: fromB64(o.backupKey), verifier: fromB64(o.verifier), salt: fromB64(o.salt), kdfParams: o.kdfParams, version: o.version };
  } catch {
    return null;
  }
}

export async function savePinMaterial(uid: string, p: PinMaterial): Promise<void> {
  await setItem(k(uid, 'pin'), JSON.stringify({ backupKey: toB64(p.backupKey), verifier: toB64(p.verifier), salt: toB64(p.salt), kdfParams: p.kdfParams, version: p.version }));
}

/** Backup turned off (or keys reset): forget the PIN-derived key on this device. */
export async function clearPinMaterial(uid: string): Promise<void> {
  await deleteItem(k(uid, 'pin'));
}

export async function loadRing(uid: string): Promise<RingKey[]> {
  const raw = await getItem(k(uid, 'ring'));
  let ids: string[] = [];
  try {
    ids = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    ids = [];
  }
  const out: RingKey[] = [];
  for (const id of ids) {
    const v = await getItem(k(uid, `k.${id}`));
    if (!v) continue;
    try {
      const o = JSON.parse(v) as { p: string; c: string };
      const encPriv = fromB64(o.p);
      out.push({ deviceId: id, encPriv, encPub: encPubFromPriv(encPriv), createdAt: o.c });
    } catch {
      // skip a corrupt entry
    }
  }
  return out;
}

export async function addRingKeys(uid: string, keys: { deviceId: string; encPriv: Uint8Array; createdAt: string }[]): Promise<void> {
  if (!keys.length) return;
  const raw = await getItem(k(uid, 'ring'));
  let ids: string[] = [];
  try {
    ids = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    ids = [];
  }
  for (const key of keys) {
    await setItem(k(uid, `k.${key.deviceId}`), JSON.stringify({ p: toB64(key.encPriv), c: key.createdAt }));
    if (!ids.includes(key.deviceId)) ids.push(key.deviceId);
  }
  await setItem(k(uid, 'ring'), JSON.stringify(ids));
}

/** Random 32-byte key that seals the decrypted-payload cache in AsyncStorage. */
export async function cacheKey(uid: string): Promise<Uint8Array> {
  const raw = await getItem(k(uid, 'cache'));
  if (raw) return fromB64(raw);
  const key = random(32);
  await setItem(k(uid, 'cache'), toB64(key));
  return key;
}

/** Removes every E2EE secret of this user from the device. */
export async function wipe(uid: string): Promise<void> {
  const raw = await getItem(k(uid, 'ring'));
  let ids: string[] = [];
  try {
    ids = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    ids = [];
  }
  const current = await loadIdentity(uid).catch(() => null);
  for (const id of ids) {
    await deleteItem(k(uid, `k.${id}`));
    await deleteNseKey(id);
  }
  if (current) await deleteNseKey(current.device.deviceId);
  for (const name of ['identity', 'pin', 'ring', 'cache']) await deleteItem(k(uid, name));
}
