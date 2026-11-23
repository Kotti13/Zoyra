// Must stay first: installs crypto.getRandomValues (expo-crypto) before any key is generated.
import { randomUUID } from './random';

import * as Device from 'expo-device';
import { AppState } from 'react-native';
import { useSyncExternalStore } from 'react';

import { supabase } from '../supabase';
import { cacheClear, cacheGet, cacheGetMany, cachePut, cachePutMany, cacheResetMemory, cacheScan } from './cache';
import {
  DEFAULT_KDF,
  E2EEError,
  decryptFile as decryptFileBytes,
  encryptFile as encryptFileBytes,
  formatSafetyNumber,
  fromB64,
  fromUtf8,
  generateDeviceKeys,
  generateSignKeyPair,
  openBackup,
  openEnvelope,
  openPayload,
  random,
  safetyNumber,
  sealBackup,
  sealPayload,
  signDevice,
  signPubFromPriv,
  stretchPin,
  toB64,
  utf8,
  verifyDevice,
  type BackupBlob,
  type DeviceKeys,
  type Envelope,
  type KdfParams,
  type Recipient,
  type Sealed,
} from './crypto';
import { addRingKeys, cacheKey, clearPinMaterial, loadIdentity, loadPinMaterial, loadRing, saveIdentity, savePinMaterial, wipe, type Identity, type PinMaterial, type RingKey } from './keystore';
import * as server from './server';
import { acknowledgeIdentityChange as ackChange, getTrust, identityChanges, knownDevice, observeAccountKey, rememberDevice, setVerified, subscribeIdentityChanges, type IdentityChange } from './trust';

export { E2EEError, formatSafetyNumber, subscribeIdentityChanges };
export type { E2EEErrorCode, Envelope, Sealed } from './crypto';
export type { IdentityChange } from './trust';

// ═════════════════════════════════════════════ types

/** Everything user-generated goes in here; it is encrypted as JSON. */
export type E2EEPayload = {
  /** Message text / caption. */
  body?: string;
  /** Shared song (what `messages.track` holds for plaintext messages). */
  track?: unknown;
  /** What `messages.meta` holds for plaintext messages: poll question/options, lyric, playlist, location,
   *  and for media `{ media: E2EEMedia }` (voice / photo). */
  meta?: Record<string, unknown>;
};

/** Encrypted file reference stored inside the payload. */
export type E2EEMedia = { path: string; key: string; mime?: string; size?: number; duration_ms?: number; width?: number; height?: number };

/** Columns to add to message selects: `${MSG_COLS}, ${E2EE_MSG_COLS}`. */
export const E2EE_MSG_COLS = 'e2ee_version, ciphertext, nonce, sender_device_id, signature';

export type E2EEMessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  kind?: string;
  meta?: Record<string, unknown> | null;
  e2ee_version: number | null;
  ciphertext: string | null;
  nonce: string | null;
  sender_device_id: string | null;
  signature: string | null;
};

export type DecryptError = { error: 'not_ready' | 'no_envelope' | 'bad_envelope' | 'bad_signature' | 'decrypt_failed' | 'unknown_device' | 'untrusted_device' | 'unsupported_version' | 'bad_format' | 'server' };
export type DecryptResult = E2EEPayload | DecryptError;
export const isDecryptError = (r: DecryptResult | null | undefined): r is DecryptError => !!r && typeof (r as DecryptError).error === 'string';

export type SendParams = { cid: string; messageId: string; kind: string; replyTo: string | null; sealed: Sealed };
export type SendOptions = { messageId?: string; kind?: string; replyTo?: string | null; /** Skip the recipient cache (used after the server says someone's devices changed). */ fresh?: boolean };

/**
 * 'needs_restore'  this phone has no current keys and the account has keys elsewhere. Non-blocking: the inbox
 *                  offers "Restore with PIN" (restoreReason 'backup') or "Use chats on this phone" (keys were reset
 *                  on another phone, no backup: 'replaced'); skipRestore() makes fresh keys.
 * 'needs_reauth'   fresh keys need a key reset but the sign-in is older than 10 minutes (rare): confirm password.
 */
export type E2EEStatus = 'idle' | 'loading' | 'ready' | 'needs_restore' | 'needs_reauth' | 'error';
export type RestoreReason = 'backup' | 'replaced';
export type E2EESnapshot = { status: E2EEStatus; userId: string | null; deviceId: string | null; error: string | null; restoreReason: RestoreReason | null };

export type RestoreOutcome = { status: 'ok' } | { status: 'wrong_pin'; attemptsLeft: number } | { status: 'locked'; lockedUntil: string } | { status: 'no_backup' };

// ═════════════════════════════════════════════ state

type State = E2EESnapshot & { identity: Identity | null; ring: RingKey[]; pin: PinMaterial | null; cacheKey: Uint8Array | null };

let state: State = { status: 'idle', userId: null, deviceId: null, error: null, restoreReason: null, identity: null, ring: [], pin: null, cacheKey: null };
let snapshot: E2EESnapshot = { status: 'idle', userId: null, deviceId: null, error: null, restoreReason: null };
const listeners = new Set<() => void>();
let initPromise: Promise<E2EEStatus> | null = null;
let initFor: string | null = null;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  if (snapshot.status !== state.status || snapshot.userId !== state.userId || snapshot.deviceId !== state.deviceId || snapshot.error !== state.error || snapshot.restoreReason !== state.restoreReason) {
    snapshot = { status: state.status, userId: state.userId, deviceId: state.deviceId, error: state.error, restoreReason: state.restoreReason };
    listeners.forEach((l) => l());
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** 'ready' | 'needs_restore' | 'needs_reauth' | 'error' (+ 'idle' before init, 'loading' while it runs). */
export function useE2EEStatus(): E2EEStatus {
  return useSyncExternalStore(subscribe, () => snapshot.status, () => snapshot.status);
}

export function useE2EE(): E2EESnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export const getE2EEStatus = (): E2EESnapshot => snapshot;

function requireReady(): { uid: string; identity: Identity } {
  if (state.status !== 'ready' || !state.identity || !state.userId) throw new E2EEError('not_ready', 'End-to-end encryption is not set up on this device');
  return { uid: state.userId, identity: state.identity };
}

const deviceLabel = () => (Device.modelName ?? Device.deviceName ?? null)?.slice(0, 64) ?? null;

function myDecryptionKeys(): { deviceId: string; encPriv: Uint8Array; encPub: Uint8Array }[] {
  const out: { deviceId: string; encPriv: Uint8Array; encPub: Uint8Array }[] = [];
  if (state.identity) out.push({ deviceId: state.identity.device.deviceId, encPriv: state.identity.device.encPriv, encPub: state.identity.device.encPub });
  for (const r of state.ring) if (!out.some((o) => o.deviceId === r.deviceId)) out.push(r);
  return out;
}

// ═════════════════════════════════════════════ init

/**
 * Loads (or creates) this device's keys for `userId`, WhatsApp-style: no PIN, no screen. Call after sign-in /
 * account switch. Resolves to:
 *   'ready'          keys present (or just created silently: first use of E2EE on the account, or a new phone
 *                    without a backup → fresh identity, contacts see "security code changed")
 *   'needs_restore'  a PIN backup exists (or the keys were reset on another phone): the user chooses Restore or
 *                    skipRestore(); nothing is blocked meanwhile
 *   'needs_reauth'   a fresh identity needs a reset but the sign-in is too old (confirm password, then skipRestore)
 *   'error'          no local keys and the server could not be reached
 * Offline with local keys → 'ready' (decryption of cached/fetched rows works; sending needs the network anyway).
 */
export function initE2EE(userId: string): Promise<E2EEStatus> {
  if (initPromise && initFor === userId) return initPromise;
  initFor = userId;
  initPromise = doInit(userId).finally(() => {
    initPromise = null;
  });
  return initPromise;
}

async function doInit(uid: string, retried = false): Promise<E2EEStatus> {
  if (state.userId !== uid) {
    cacheResetMemory();
    set({ identity: null, ring: [], pin: null, cacheKey: null, deviceId: null, restoreReason: null });
  }
  set({ status: 'loading', userId: uid, error: null });
  try {
    const [identity, ring, pin, ck] = await Promise.all([loadIdentity(uid), loadRing(uid), loadPinMaterial(uid), cacheKey(uid)]);
    set({ ring, pin, cacheKey: ck });
    let serverPub: string | null;
    try {
      serverPub = await server.fetchAccountPub(uid);
    } catch (e) {
      if (identity) {
        set({ identity, deviceId: identity.device.deviceId, status: 'ready', error: null, restoreReason: null });
        return 'ready';
      }
      throw e;
    }
    if (!identity) {
      // First use on this account → create keys silently. New phone → restore offer if a backup exists, else fresh keys.
      if (!serverPub) return await createKeys(uid, false, retried);
      if ((await server.backupParams()).exists) return offerRestore('backup');
      return await createKeys(uid, true, retried);
    }
    if (!serverPub) {
      // Server lost the account (should not happen): new keys. Old keys stay for history (createKeys rings them).
      set({ identity });
      return await createKeys(uid, false, retried);
    }
    if (serverPub !== toB64(identity.accountSignPub)) {
      // Keys were reset on another phone. Old key stays usable for history on this phone. No silent reset here:
      // it would revoke the other phone (and that one would revoke this one…); the user decides in the inbox.
      await addRingKeys(uid, [{ deviceId: identity.device.deviceId, encPriv: identity.device.encPriv, createdAt: new Date().toISOString() }]);
      set({ ring: await loadRing(uid) });
      const backup = await server.backupParams().then((b) => b.exists).catch(() => false);
      return offerRestore(backup ? 'backup' : 'replaced');
    }
    set({ identity, deviceId: identity.device.deviceId });
    const [row] = await server.fetchDevices([identity.device.deviceId]);
    if (!row || row.revoked_at) {
      await rotateWith(uid, identity, false);
    }
    set({ status: 'ready', restoreReason: null });
    return 'ready';
  } catch (e) {
    set({ status: 'error', error: e instanceof Error ? e.message : 'Could not load encryption keys' });
    return 'error';
  }
}

function offerRestore(reason: RestoreReason): E2EEStatus {
  set({ status: 'needs_restore', restoreReason: reason, identity: null, deviceId: null });
  return 'needs_restore';
}

/**
 * New account key + device key, no PIN (`reset` = the account already has keys elsewhere: every old device is
 * revoked, the old backup deleted, contacts see "security code changed"). Keys of an earlier identity on this
 * phone stay in the keyring for history.
 */
async function createKeys(uid: string, reset: boolean, retried = false): Promise<E2EEStatus> {
  // Never from a background task (notification preview, locked phone): an unreadable keychain must not turn
  // into a key reset. The next foreground init creates the keys.
  if (AppState.currentState === 'background') throw new E2EEError('not_ready', 'Open Zoyra to turn on encrypted chats');
  const account = generateSignKeyPair();
  const device = generateDeviceKeys(randomUUID());
  try {
    await server.setupAccount({
      accountSignPub: toB64(account.pub),
      deviceId: device.deviceId,
      encPub: toB64(device.encPub),
      signPub: toB64(device.signPub),
      accountSig: toB64(signDevice(account.priv, uid, device)),
      reset,
      label: deviceLabel(),
    });
  } catch (e) {
    const hint = (e as { hint?: string }).hint;
    if (hint === 'e2ee_reauth') {
      set({ status: 'needs_reauth', error: null });
      return 'needs_reauth';
    }
    // Another install of this account set up keys a moment ago: look again (once).
    if (hint === 'e2ee_exists' && !retried) return doInit(uid, true);
    throw e;
  }
  const old = state.identity ? [{ deviceId: state.identity.device.deviceId, encPriv: state.identity.device.encPriv, createdAt: new Date().toISOString() }] : [];
  if (old.length) await addRingKeys(uid, old);
  const identity: Identity = { device, accountSignPriv: account.priv, accountSignPub: account.pub };
  await saveIdentity(uid, identity);
  if (state.pin) await clearPinMaterial(uid); // a reset deleted the server backup
  set({ identity, deviceId: device.deviceId, pin: null, ring: await loadRing(uid), status: 'ready', error: null, restoreReason: null });
  return 'ready';
}

/**
 * "Skip" on the restore offer (or "Continue without" when sending): fresh keys for this phone. Older messages
 * that only the backup could unlock stay unreadable here. May resolve 'needs_reauth' (old sign-in).
 */
export async function skipRestore(): Promise<E2EEStatus> {
  const uid = state.userId;
  if (!uid) throw new E2EEError('not_ready', 'Call initE2EE(userId) first');
  if (state.status === 'ready') return 'ready';
  try {
    return await createKeys(uid, true);
  } catch (e) {
    const hint = (e as { hint?: string }).hint;
    throw hint === 'e2ee_reset_cooldown' ? new E2EEError('server', 'Your encryption keys were reset a moment ago. Try again in a few minutes.') : e;
  }
}

/** True when the signed-in user has a PIN backup on the server. */
export async function hasBackup(): Promise<boolean> {
  return (await server.backupParams()).exists;
}

// ═════════════════════════════════════════════ PIN

export const PIN_LENGTH = 6;
const checkPin = (pin: string) => {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) throw new E2EEError('bad_format', `PIN must be ${PIN_LENGTH} digits`);
};

function blobFor(accountSignPriv: Uint8Array, keys: { deviceId: string; encPriv: Uint8Array; createdAt?: string }[], base?: BackupBlob): BackupBlob {
  const merged = new Map<string, BackupBlob['keys'][number]>();
  for (const k of base?.keys ?? []) merged.set(k.device_id, k);
  for (const k of keys) merged.set(k.deviceId, { device_id: k.deviceId, enc_priv: toB64(k.encPriv), created_at: k.createdAt ?? new Date().toISOString() });
  return { v: 1, account_sign_priv: toB64(accountSignPriv), keys: [...merged.values()] };
}

/**
 * Settings → Privacy → Chat backup: turns the optional encrypted backup on. Encrypts the CURRENT account key and
 * every device key this phone holds (current + keyring) with the PIN and stores it (store_key_backup without a
 * current verifier). Resolves 'exists' when a backup is already on (use changePin). scrypt runs here (~1 s).
 */
export async function setupBackupPin(pin: string, onProgress?: (p: number) => void): Promise<'ok' | 'exists'> {
  checkPin(pin);
  const { uid, identity } = requireReady();
  const salt = random(16);
  const kdfParams: KdfParams = DEFAULT_KDF;
  const pk = await stretchPin(pin, salt, kdfParams, onProgress);
  const blob = blobFor(identity.accountSignPriv, [...state.ring, identity.device]);
  const sealed = sealBackup(pk.backupKey, uid, blob);
  const r = await server.storeBackup({ ciphertext: sealed.ciphertext, nonce: sealed.nonce, kdfParams, salt: toB64(salt), verifier: toB64(pk.verifier), currentVerifier: null, expectedVersion: null });
  if (r.status !== 'ok') return 'exists';
  const pinMat: PinMaterial = { backupKey: pk.backupKey, verifier: pk.verifier, salt, kdfParams, version: r.version };
  await savePinMaterial(uid, pinMat);
  set({ pin: pinMat });
  return 'ok';
}

/**
 * Turns the backup off (deletes it on the server). Uses this phone's PIN verifier; without one (or when the PIN
 * was changed elsewhere) the server needs a recent sign-in and throws hint 'e2ee_reauth' → confirm password and
 * call again with `{ recentSignIn: true }`.
 */
export async function turnOffBackup(opts: { recentSignIn?: boolean } = {}): Promise<void> {
  const { uid } = requireReady();
  const verifier = !opts.recentSignIn && state.pin ? toB64(state.pin.verifier) : null;
  const r = await server.deleteBackup(verifier);
  if (r.status === 'wrong_pin' || r.status === 'locked') {
    const err = new E2EEError('server', 'Sign in again to turn off chat backup') as E2EEError & { hint?: string };
    err.hint = 'e2ee_reauth';
    throw err;
  }
  await clearPinMaterial(uid);
  set({ pin: null });
}

/** Remaining attempts / lockout before asking for the PIN (for the restore screen). */
export async function restoreInfo(): Promise<{ exists: boolean; attemptsLeft: number; lockedUntil: string | null }> {
  const p = await server.backupParams();
  if (!p.exists) return { exists: false, attemptsLeft: 0, lockedUntil: null };
  return { exists: true, attemptsLeft: p.attempts_left, lockedUntil: p.locked_until };
}

/** New phone: PIN → backup → account key + every old device key (history readable) → registers this phone. */
export async function restoreWithPin(pin: string, onProgress?: (p: number) => void): Promise<RestoreOutcome> {
  checkPin(pin);
  const uid = state.userId;
  if (!uid) throw new E2EEError('not_ready', 'Call initE2EE(userId) first');
  const params = await server.backupParams();
  if (!params.exists) return { status: 'no_backup' };
  if (params.locked_until) return { status: 'locked', lockedUntil: params.locked_until };
  const salt = fromB64(params.salt);
  const pk = await stretchPin(pin, salt, params.kdf_params, onProgress);
  const r = await server.beginRestore(toB64(pk.verifier));
  if (r.status === 'wrong_pin') return { status: 'wrong_pin', attemptsLeft: r.attempts_left };
  if (r.status === 'locked') return { status: 'locked', lockedUntil: r.locked_until };
  if (r.status === 'no_backup') return { status: 'no_backup' };

  const blob = openBackup(pk.backupKey, uid, r.ciphertext, r.nonce);
  await server.confirmRestore().catch(() => {});
  const accountSignPriv = fromB64(blob.account_sign_priv);
  const accountSignPub = signPubFromPriv(accountSignPriv);
  const serverPub = await server.fetchAccountPub(uid);
  if (serverPub !== toB64(accountSignPub)) throw new E2EEError('bad_format', 'Backup does not match this account');

  await addRingKeys(uid, blob.keys.map((k) => ({ deviceId: k.device_id, encPriv: fromB64(k.enc_priv), createdAt: k.created_at })));
  const device = generateDeviceKeys(randomUUID());
  await server.registerDevice({ deviceId: device.deviceId, encPub: toB64(device.encPub), signPub: toB64(device.signPub), accountSig: toB64(signDevice(accountSignPriv, uid, device)), label: deviceLabel() });
  const identity: Identity = { device, accountSignPriv, accountSignPub };
  await saveIdentity(uid, identity);
  const pinMat: PinMaterial = { backupKey: pk.backupKey, verifier: pk.verifier, salt, kdfParams: params.kdf_params, version: r.version };
  await savePinMaterial(uid, pinMat);
  set({ identity, deviceId: device.deviceId, pin: pinMat, ring: await loadRing(uid), status: 'ready', error: null, restoreReason: null });
  await pushKeysToBackup([device]).catch(() => {}); // retried on the next rotation / PIN change if offline
  return { status: 'ok' };
}

/**
 * Re-encrypts the backup with extra keys (and optionally a new PIN). Uses the PIN-derived key kept on
 * this device; merges with the current server copy (optimistic version check, 3 tries).
 */
async function pushKeysToBackup(keys: { deviceId: string; encPriv: Uint8Array }[], newPin?: { pk: { backupKey: Uint8Array; verifier: Uint8Array }; salt: Uint8Array; kdfParams: KdfParams }, currentVerifier?: Uint8Array): Promise<RestoreOutcome> {
  const uid = state.userId;
  const identity = state.identity;
  const pin = state.pin;
  if (!uid || !identity || !pin) throw new E2EEError('not_ready', 'PIN material missing on this device');
  const verifier = currentVerifier ?? pin.verifier;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await server.beginRestore(toB64(verifier));
    if (r.status === 'wrong_pin') return { status: 'wrong_pin', attemptsLeft: r.attempts_left };
    if (r.status === 'locked') return { status: 'locked', lockedUntil: r.locked_until };
    if (r.status === 'no_backup') return { status: 'no_backup' };
    const current = openBackup(pin.backupKey, uid, r.ciphertext, r.nonce);
    const blob = blobFor(identity.accountSignPriv, keys, current);
    const target = newPin ?? { pk: { backupKey: pin.backupKey, verifier: pin.verifier }, salt: pin.salt, kdfParams: pin.kdfParams };
    const sealed = sealBackup(target.pk.backupKey, uid, blob);
    const s = await server.storeBackup({ ciphertext: sealed.ciphertext, nonce: sealed.nonce, kdfParams: target.kdfParams, salt: toB64(target.salt), verifier: toB64(target.pk.verifier), currentVerifier: toB64(verifier), expectedVersion: r.version });
    if (s.status === 'conflict') continue;
    if (s.status !== 'ok') return s.status === 'wrong_pin' ? { status: 'wrong_pin', attemptsLeft: s.attempts_left } : s.status === 'locked' ? { status: 'locked', lockedUntil: s.locked_until } : { status: 'no_backup' };
    const pinMat: PinMaterial = { backupKey: target.pk.backupKey, verifier: target.pk.verifier, salt: target.salt, kdfParams: target.kdfParams, version: s.version };
    await savePinMaterial(uid, pinMat);
    set({ pin: pinMat });
    return { status: 'ok' };
  }
  throw new E2EEError('server', 'Backup changed too often, try again');
}

/** Changes the backup PIN. Old PIN is checked by the server (counts towards the attempt limit). */
export async function changePin(oldPin: string, newPin: string, onProgress?: (p: number) => void): Promise<RestoreOutcome> {
  checkPin(oldPin);
  checkPin(newPin);
  requireReady();
  const params = await server.backupParams();
  if (!params.exists) return { status: 'no_backup' };
  if (params.locked_until) return { status: 'locked', lockedUntil: params.locked_until };
  const oldPk = await stretchPin(oldPin, fromB64(params.salt), params.kdf_params, (p) => onProgress?.(p / 2));
  const salt = random(16);
  const pk = await stretchPin(newPin, salt, DEFAULT_KDF, (p) => onProgress?.(0.5 + p / 2));
  // The old backup key may differ from the one on this device if the PIN was changed elsewhere.
  set({ pin: { ...(state.pin as PinMaterial), backupKey: oldPk.backupKey, verifier: oldPk.verifier } });
  return pushKeysToBackup([], { pk, salt, kdfParams: DEFAULT_KDF }, oldPk.verifier);
}

// ═════════════════════════════════════════════ device keys

async function rotateWith(uid: string, identity: Identity, revokeOld: boolean): Promise<void> {
  const device = generateDeviceKeys(randomUUID());
  await server.registerDevice({ deviceId: device.deviceId, encPub: toB64(device.encPub), signPub: toB64(device.signPub), accountSig: toB64(signDevice(identity.accountSignPriv, uid, device)), label: deviceLabel() });
  await addRingKeys(uid, [{ deviceId: identity.device.deviceId, encPriv: identity.device.encPriv, createdAt: new Date().toISOString() }]);
  const next: Identity = { ...identity, device };
  await saveIdentity(uid, next);
  set({ identity: next, deviceId: device.deviceId, ring: await loadRing(uid) });
  if (revokeOld) await server.revokeDevice(identity.device.deviceId).catch(() => {});
  if (state.pin) await pushKeysToBackup([device]).catch(() => {});
}

/** New device key pair (new device id); the old one is revoked but kept locally + in the backup for history. */
export async function rotateDeviceKeys(): Promise<void> {
  const { uid, identity } = requireReady();
  await rotateWith(uid, identity, true);
}

/** My devices (for a "Linked devices" list). */
export async function listMyDevices(): Promise<server.DeviceRow[]> {
  const { uid } = requireReady();
  return server.fetchUserDevices(uid);
}

export async function revokeDevice(deviceId: string): Promise<void> {
  const { identity } = requireReady();
  if (deviceId === identity.device.deviceId) return rotateDeviceKeys();
  await server.revokeDevice(deviceId);
}

/** Signs out of E2EE on this phone: deletes local keys and the decrypted cache (server state untouched). */
export async function forgetThisDevice(): Promise<void> {
  const uid = state.userId;
  if (!uid) return;
  if (state.identity) await server.revokeDevice(state.identity.device.deviceId).catch(() => {});
  await wipe(uid);
  await cacheClear(uid);
  set({ identity: null, ring: [], pin: null, cacheKey: null, deviceId: null, status: 'idle', userId: null, restoreReason: null });
}

/**
 * Sign-out: drops keys and decrypted payloads from MEMORY only (keys stay in the keychain for this user id, so
 * signing back in needs no restore; another account on this phone has its own keystore namespace).
 */
export function resetE2EEMemory(): void {
  initPromise = null;
  initFor = null;
  cacheResetMemory();
  accountPubCache.clear();
  senderCache.clear();
  set({ identity: null, ring: [], pin: null, cacheKey: null, deviceId: null, status: 'idle', userId: null, error: null, restoreReason: null });
}

// ═════════════════════════════════════════════ recipients / sender verification

const accountPubCache = new Map<string, { pub: string; at: number }>();

async function accountPubOf(userId: string): Promise<string | null> {
  const hit = accountPubCache.get(userId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.pub;
  const pub = await server.fetchAccountPub(userId);
  if (pub) accountPubCache.set(userId, { pub, at: Date.now() });
  return pub;
}

/** Active devices of every member whose certificate verifies under the member's account key (TOFU-checked). */
// Recipient devices per conversation, kept briefly so a burst of messages costs one lookup, not one per message.
// Safe against staleness: the server rejects a send whose device set changed ('e2ee_devices_changed'), and the
// retry in sendEncryptedMessage bypasses this cache.
const RECIPIENTS_TTL = 60_000;
const recipientsCache = new Map<string, { at: number; list: Recipient[]; pending?: Promise<Recipient[]> }>();

/** Drop the cached recipients (one chat, or all of them). */
export function invalidateRecipients(cid?: string): void {
  if (cid) recipientsCache.delete(cid);
  else recipientsCache.clear();
}

async function verifiedRecipients(cid: string, fresh = false): Promise<Recipient[]> {
  const hit = recipientsCache.get(cid);
  if (!fresh && hit) {
    if (hit.pending) return hit.pending.then((l) => [...l]);
    if (Date.now() - hit.at < RECIPIENTS_TTL) return [...hit.list];
  }
  const pending = loadRecipients(cid);
  recipientsCache.set(cid, { at: 0, list: [], pending });
  try {
    const list = await pending;
    recipientsCache.set(cid, { at: Date.now(), list });
    return [...list];
  } catch (e) {
    recipientsCache.delete(cid);
    throw e;
  }
}

/** Warm the recipient cache while a chat is open so the first message doesn't wait for the lookup. Never throws. */
export async function warmRecipients(cid: string): Promise<void> {
  try {
    if (getE2EEStatus().status === 'ready') await verifiedRecipients(cid);
  } catch {
    /* the send itself will report any real problem */
  }
}

async function loadRecipients(cid: string): Promise<Recipient[]> {
  const me = state.userId as string;
  const rows = await server.conversationDevices(cid);
  const out: Recipient[] = [];
  const seenUsers = new Set<string>();
  for (const d of rows) {
    if (!seenUsers.has(d.user_id)) {
      seenUsers.add(d.user_id);
      accountPubCache.set(d.user_id, { pub: d.account_sign_pub, at: Date.now() });
      await observeAccountKey(me, d.user_id, d.account_sign_pub);
    }
    const ok = verifyDevice(fromB64(d.account_sign_pub), d.user_id, d.device_id, fromB64(d.enc_pub), fromB64(d.sign_pub), fromB64(d.account_sig));
    if (!ok) continue;
    await rememberDevice(me, d.device_id, d.user_id, d.sign_pub);
    out.push({ deviceId: d.device_id, encPub: fromB64(d.enc_pub) });
  }
  return out;
}

const senderCache = new Map<string, { userId: string; signPub: Uint8Array } | null>();

/** Resolves + verifies sender devices for a batch of rows. */
async function resolveSenders(rows: { sender_id: string; sender_device_id: string }[]): Promise<void> {
  const me = state.userId as string;
  const missing = [...new Set(rows.map((r) => r.sender_device_id).filter((id) => !senderCache.has(id)))];
  if (!missing.length) return;
  const found = await server.fetchDevices(missing);
  for (const id of missing) {
    const d = found.find((f) => f.device_id === id);
    if (!d) {
      senderCache.set(id, null);
      continue;
    }
    const pub = await accountPubOf(d.user_id);
    let ok = !!pub && verifyDevice(fromB64(pub), d.user_id, d.device_id, fromB64(d.enc_pub), fromB64(d.sign_pub), fromB64(d.account_sig));
    if (ok && pub) {
      await observeAccountKey(me, d.user_id, pub);
      await rememberDevice(me, d.device_id, d.user_id, d.sign_pub);
    } else {
      // Signed by an older account key (contact reset their keys): accept only if we verified it before.
      const known = await knownDevice(me, d.device_id);
      ok = !!known && known.userId === d.user_id && known.signPub === d.sign_pub;
    }
    senderCache.set(id, ok ? { userId: d.user_id, signPub: fromB64(d.sign_pub) } : null);
  }
}

// ═════════════════════════════════════════════ send

/** Encrypts `payload` for every member device of `cid`. Returns what send_e2ee_message needs. */
export async function encryptMessage(cid: string, payload: E2EEPayload, opts: SendOptions = {}): Promise<SendParams> {
  const { identity } = requireReady();
  const messageId = opts.messageId ?? randomUUID();
  const recipients = await verifiedRecipients(cid, opts.fresh === true);
  if (!recipients.some((r) => r.deviceId === identity.device.deviceId)) recipients.push({ deviceId: identity.device.deviceId, encPub: identity.device.encPub });
  const sealed = sealPayload({ conversationId: cid, messageId, sender: identity.device, recipients, plaintext: utf8(JSON.stringify(payload)) });
  return { cid, messageId, kind: opts.kind ?? 'text', replyTo: opts.replyTo ?? null, sealed };
}

const isDevicesChanged = (e: unknown) => (e as { hint?: string })?.hint === 'e2ee_devices_changed';

/**
 * Encrypt + send in one call (retries once if someone's devices changed in between). The plaintext is
 * cached for this message id so the sender's own bubble renders without a decrypt. Returns the message id.
 * Pass `opts.messageId` (e.g. the optimistic bubble's id) to keep ids stable.
 */
export async function sendEncryptedMessage(cid: string, payload: E2EEPayload, opts: SendOptions = {}): Promise<string> {
  const { uid } = requireReady();
  let params = await encryptMessage(cid, payload, opts);
  try {
    await server.sendSealed(params);
  } catch (e) {
    if (!isDevicesChanged(e)) throw e;
    params = await encryptMessage(cid, payload, { ...opts, messageId: params.messageId, fresh: true });
    await server.sendSealed(params);
  }
  if (state.cacheKey) await cachePut(uid, state.cacheKey, params.messageId, params.sealed.signature, cid, payload);
  return params.messageId;
}

/** New ciphertext + envelopes for an existing message (same id). */
export async function encryptEdit(cid: string, messageId: string, payload: E2EEPayload): Promise<Sealed> {
  return (await encryptMessage(cid, payload, { messageId })).sealed;
}

export async function editEncryptedMessage(cid: string, messageId: string, payload: E2EEPayload): Promise<void> {
  const { uid } = requireReady();
  let sealed = await encryptEdit(cid, messageId, payload);
  try {
    await server.editSealed({ messageId, sealed });
  } catch (e) {
    if (!isDevicesChanged(e)) throw e;
    sealed = (await encryptMessage(cid, payload, { messageId, fresh: true })).sealed;
    await server.editSealed({ messageId, sealed });
  }
  if (state.cacheKey) await cachePut(uid, state.cacheKey, messageId, sealed.signature, cid, payload);
}

// ═════════════════════════════════════════════ receive

export const isEncryptedRow = (row: { e2ee_version?: number | null } | null | undefined): boolean => row?.e2ee_version != null;

function decryptOne(row: E2EEMessageRow, envelope: Envelope | undefined): DecryptResult {
  if (!envelope) return { error: 'no_envelope' };
  const key = myDecryptionKeys().find((k) => k.deviceId === envelope.device_id);
  if (!key) return { error: 'no_envelope' };
  const sender = senderCache.get(row.sender_device_id as string);
  if (sender === undefined) return { error: 'unknown_device' };
  if (sender === null || sender.userId !== row.sender_id) return { error: 'untrusted_device' };
  try {
    const contentKey = openEnvelope({ messageId: row.id, deviceId: envelope.device_id, encPriv: key.encPriv, encPub: key.encPub, envelope });
    const plain = openPayload({
      version: row.e2ee_version as number,
      conversationId: row.conversation_id,
      messageId: row.id,
      senderDeviceId: row.sender_device_id as string,
      senderSignPub: sender.signPub,
      ciphertext: row.ciphertext as string,
      nonce: row.nonce as string,
      signature: row.signature as string,
      contentKey,
    });
    const payload = JSON.parse(fromUtf8(plain)) as E2EEPayload;
    return payload && typeof payload === 'object' ? payload : { error: 'bad_format' };
  } catch (e) {
    return { error: e instanceof E2EEError ? (e.code as DecryptError['error']) : 'decrypt_failed' };
  }
}

/**
 * Batch decrypt (one envelope query + one device query for the whole page). Plaintext rows are skipped.
 * Results are cached (memory + sealed AsyncStorage) by message id + signature.
 */
export async function decryptMessages(rows: E2EEMessageRow[]): Promise<Map<string, DecryptResult>> {
  const out = new Map<string, DecryptResult>();
  const enc = rows.filter((r) => r.e2ee_version != null && r.ciphertext && r.signature && r.sender_device_id && r.nonce);
  if (!enc.length) return out;
  if (!state.userId || !state.cacheKey || (!state.identity && !state.ring.length)) {
    enc.forEach((r) => out.set(r.id, { error: 'not_ready' }));
    return out;
  }
  const uid = state.userId;
  const ck = state.cacheKey;
  const todo: E2EEMessageRow[] = [];
  const cached = await cacheGetMany<E2EEPayload>(uid, ck, enc.map((r) => ({ id: r.id, signature: r.signature as string })));
  for (const r of enc) {
    const hit = cached.get(r.id);
    if (hit) out.set(r.id, hit);
    else todo.push(r);
  }
  if (!todo.length) return out;
  try {
    const [envelopes] = await Promise.all([
      server.fetchEnvelopes(
        todo.map((r) => r.id),
        myDecryptionKeys().map((k) => k.deviceId),
      ),
      resolveSenders(todo as { sender_id: string; sender_device_id: string }[]),
    ]);
    const byMsg = new Map<string, Envelope>();
    for (const e of envelopes) if (!byMsg.has(e.message_id) || e.device_id === state.identity?.device.deviceId) byMsg.set(e.message_id, e);
    const fresh: { id: string; signature: string; cid: string; payload: E2EEPayload }[] = [];
    for (const r of todo) {
      const res = decryptOne(r, byMsg.get(r.id));
      out.set(r.id, res);
      if (!isDecryptError(res)) fresh.push({ id: r.id, signature: r.signature as string, cid: r.conversation_id, payload: res });
    }
    // Save to the local cache in one batch, without making the chat wait for the disk.
    if (fresh.length) void cachePutMany(uid, ck, fresh);
  } catch {
    todo.forEach((r) => out.set(r.id, { error: 'server' }));
  }
  return out;
}

/** Single message. `myDeviceId` is accepted for API symmetry; all of this user's local keys are tried. */
export async function decryptMessage(row: E2EEMessageRow, _myDeviceId?: string): Promise<DecryptResult> {
  return (await decryptMessages([row])).get(row.id) ?? { error: 'bad_format' };
}

/** Cached payload only (no network) — for synchronous-ish renders, inbox previews, search. */
export async function getCachedPayload(messageId: string, signature: string): Promise<E2EEPayload | null> {
  if (!state.userId || !state.cacheKey) return null;
  return cacheGet<E2EEPayload>(state.userId, state.cacheKey, messageId, signature);
}

/**
 * Plaintext-shaped message for existing UI: body / track / meta come from the payload. The row's own
 * meta keeps server keys (edited_at); `e2ee: true` marks it for a lock badge. Failed decrypts get
 * body '' and meta.e2ee_error.
 */
export function applyPayload<R extends E2EEMessageRow & { body?: string; track?: unknown }>(row: R, res: DecryptResult | undefined): R {
  const serverMeta = { ...(row.meta ?? {}) };
  delete serverMeta.e2ee;
  if (!res) return { ...row, body: '', track: null, meta: { ...serverMeta, e2ee: true, e2ee_pending: true } };
  if (isDecryptError(res)) return { ...row, body: '', track: null, meta: { ...serverMeta, e2ee: true, e2ee_error: res.error } };
  return { ...row, body: typeof res.body === 'string' ? res.body : '', track: res.track ?? null, meta: { ...(res.meta ?? {}), ...serverMeta, e2ee: true } };
}

/** One-line preview text (inbox row / notification) for a decrypted payload. */
export function previewText(kind: string | undefined, p: E2EEPayload): string {
  const meta = p.meta ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (kind) {
    case 'voice':
      return 'Sent a voice note';
    case 'photo':
      return str(p.body) ? `📷 ${str(p.body).slice(0, 120)}` : 'Sent a photo';
    case 'poll':
      return `Poll: ${str(meta.question).slice(0, 120)}`;
    case 'jam':
      return 'Invited you to a jam';
    case 'live':
      return 'Invited you to a live session';
    case 'location':
      return 'Shared a location';
    case 'playlist':
      return `Sent you a playlist: ${str(meta.title) || 'a playlist'}`;
    case 'lyric':
      return 'Sent a lyric card';
    default: {
      if (str(p.body)) return str(p.body).slice(0, 140);
      const t = p.track as { title?: string } | null | undefined;
      if (t) return `Sent you a song: ${t.title ?? 'a track'}`;
      return 'Sent you a message';
    }
  }
}

/**
 * Push / notification preview (Android: call from the notification received handler when
 * `data.e2ee === true`). Initialises E2EE for the signed-in user if needed, fetches the row + my
 * envelope, decrypts. Returns null when it can't (then keep the generic "Sent you a message").
 */
export async function decryptNotificationPreview(data: { message_id?: unknown; conversation_id?: unknown }): Promise<{ body: string; payload: E2EEPayload; kind: string } | null> {
  const mid = typeof data.message_id === 'string' ? data.message_id : null;
  if (!mid) return null;
  try {
    if (state.status !== 'ready') {
      const { data: s } = await supabase.auth.getSession();
      const uid = s.session?.user.id;
      if (!uid || (await initE2EE(uid)) !== 'ready') return null;
    }
    const { data: row } = await supabase.from('messages').select(`id, conversation_id, sender_id, kind, meta, ${E2EE_MSG_COLS}`).eq('id', mid).maybeSingle();
    if (!row) return null;
    const r = row as E2EEMessageRow;
    const res = await decryptMessage(r);
    if (isDecryptError(res)) return null;
    return { body: previewText(r.kind, res), payload: res, kind: r.kind ?? 'text' };
  } catch {
    return null;
  }
}

/** Local search over decrypted messages this phone has seen (server search can't see e2ee text). */
export async function searchDecrypted(q: string, opts: { conversationId?: string; limit?: number } = {}): Promise<{ id: string; conversationId: string; payload: E2EEPayload; at: string }[]> {
  if (!state.userId || !state.cacheKey) return [];
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const all = await cacheScan<E2EEPayload>(state.userId, state.cacheKey, opts.conversationId);
  const hits = all.filter((e) => {
    const t = e.payload.track as { title?: string; artist?: string } | null | undefined;
    const meta = e.payload.meta ?? {};
    const hay = [e.payload.body, t?.title, t?.artist, meta.question, ...(Array.isArray(meta.options) ? meta.options : []), meta.title].filter((x) => typeof x === 'string').join('\n').toLowerCase();
    return hay.includes(needle);
  });
  hits.sort((a, b) => (a.at < b.at ? 1 : -1));
  return hits.slice(0, opts.limit ?? 200).map((e) => ({ id: e.id, conversationId: e.cid, payload: e.payload, at: e.at }));
}

// ═════════════════════════════════════════════ files

/** Encrypt bytes before uploading to chat-media. Put `key` (and the storage path) in the payload's meta.media. */
export function encryptFile(bytes: Uint8Array): { data: Uint8Array; key: string } {
  const r = encryptFileBytes(bytes);
  return { data: r.data, key: toB64(r.key) };
}

export function decryptFile(data: Uint8Array, key: string): Uint8Array {
  return decryptFileBytes(fromB64(key), data);
}

// ═════════════════════════════════════════════ safety number / trust

export type SafetyNumber = { number: string; formatted: string; qr: string; verified: boolean; changed: boolean };

/** 60-digit code from both account keys; same on both phones. Null if the other user has no E2EE yet. */
export async function getSafetyNumber(otherUserId: string): Promise<SafetyNumber | null> {
  const { uid, identity } = requireReady();
  const theirs = await server.fetchAccountPub(otherUserId);
  if (!theirs) return null;
  accountPubCache.set(otherUserId, { pub: theirs, at: Date.now() });
  const changed = await observeAccountKey(uid, otherUserId, theirs);
  const trust = await getTrust(uid, otherUserId);
  const number = safetyNumber({ userId: uid, accountPub: identity.accountSignPub }, { userId: otherUserId, accountPub: fromB64(theirs) });
  const [a, b] = uid < otherUserId ? [uid, otherUserId] : [otherUserId, uid];
  return { number, formatted: formatSafetyNumber(number), qr: `zoyra-sn:1:${a}:${b}:${number}`, verified: !!trust?.verified && trust.pub === theirs, changed };
}

/** Marks the contact's current key as verified (after comparing codes) or clears it. */
export async function markVerified(otherUserId: string, verified: boolean): Promise<void> {
  const { uid } = requireReady();
  const theirs = await server.fetchAccountPub(otherUserId);
  if (!theirs) return;
  await setVerified(uid, otherUserId, theirs, verified);
  if (verified) await ackChange(uid, otherUserId);
}

/** Scanned QR → true when it matches the code we compute for this contact. */
export async function checkSafetyQr(otherUserId: string, scanned: string): Promise<boolean> {
  const sn = await getSafetyNumber(otherUserId);
  return !!sn && scanned.trim() === sn.qr;
}

/** "Security code changed" notices for this user (show as local system rows in the matching chats). */
export async function getIdentityChanges(): Promise<IdentityChange[]> {
  return state.userId ? identityChanges(state.userId) : [];
}

/**
 * True when this phone has seen an account key for `userId` before (TOFU book). Used to refuse a plaintext
 * fallback when the server suddenly claims a contact has no keys (downgrade protection).
 */
export async function knowsKeysOf(userId: string): Promise<boolean> {
  if (!state.userId) return false;
  return !!(await getTrust(state.userId, userId));
}

export async function acknowledgeIdentityChange(otherUserId: string): Promise<void> {
  if (state.userId) await ackChange(state.userId, otherUserId);
}

export type { DeviceKeys, KdfParams };
