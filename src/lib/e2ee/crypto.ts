/**
 * Zoyra E2EE — pure crypto core (no React Native imports, so `node scripts/e2ee-selftest.mjs` can
 * load this exact file). See ./README.md for the design.
 *
 * Primitives (all MIT, audited, pure JS): @noble/curves (X25519, Ed25519), @noble/ciphers
 * (XChaCha20-Poly1305), @noble/hashes (HKDF-SHA256, SHA-256/512, scrypt).
 *
 * Randomness: noble's `randomBytes` reads `globalThis.crypto.getRandomValues`. In the app,
 * ./random.ts installs it from expo-crypto (native CSPRNG) before anything here runs.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToUtf8, concatBytes, equalBytes, randomBytes, utf8ToBytes } from '@noble/ciphers/utils.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

export const E2EE_VERSION = 1;
/** Max devices one message is wrapped for (64 members × 10 devices). Mirrors the SQL check. */
export const MAX_ENVELOPES = 640;

export type E2EEErrorCode =
  | 'no_envelope'
  | 'bad_envelope'
  | 'bad_signature'
  | 'decrypt_failed'
  | 'unknown_device'
  | 'untrusted_device'
  | 'unsupported_version'
  | 'bad_format'
  | 'wrong_pin'
  | 'locked'
  | 'not_ready'
  | 'no_backup'
  | 'server';

export class E2EEError extends Error {
  code: E2EEErrorCode;
  constructor(code: E2EEErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'E2EEError';
  }
}

// ═════════════════════════════════════════════ encoding

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Standard base64 (with padding). Own implementation so it works on every JS engine. */
export function toB64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

export function fromB64(s: string): Uint8Array {
  if (typeof s !== 'string') throw new E2EEError('bad_format', 'base64 expected');
  const clean = s.replace(/[\s=]+/g, '');
  if (clean.length % 4 === 1) throw new E2EEError('bad_format', 'bad base64');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? B64_LOOKUP[c] : -1;
    if (v < 0) throw new E2EEError('bad_format', 'bad base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export const utf8 = (s: string): Uint8Array => utf8ToBytes(s);
export const fromUtf8 = (b: Uint8Array): string => bytesToUtf8(b);

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

function u64be(n: number): Uint8Array {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setUint32(0, Math.floor(n / 2 ** 32), false);
  v.setUint32(4, n >>> 0, false);
  return b;
}

/** Unambiguous length-prefixed concatenation of fields (strings as UTF-8, numbers as u32). */
export function frame(...parts: (Uint8Array | string | number)[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    const b = typeof p === 'string' ? utf8(p) : typeof p === 'number' ? u32be(p) : p;
    chunks.push(u32be(b.length), b);
  }
  return concatBytes(...chunks);
}

export const random = (n: number): Uint8Array => randomBytes(n);

// ═════════════════════════════════════════════ keys

export type KeyPair = { priv: Uint8Array; pub: Uint8Array };

export type DeviceKeys = {
  deviceId: string;
  encPriv: Uint8Array; // X25519
  encPub: Uint8Array;
  signPriv: Uint8Array; // Ed25519 seed
  signPub: Uint8Array;
};

export function generateEncKeyPair(): KeyPair {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
}

export function generateSignKeyPair(): KeyPair {
  const priv = ed25519.utils.randomSecretKey();
  return { priv, pub: ed25519.getPublicKey(priv) };
}

export function generateDeviceKeys(deviceId: string): DeviceKeys {
  const e = generateEncKeyPair();
  const s = generateSignKeyPair();
  return { deviceId, encPriv: e.priv, encPub: e.pub, signPriv: s.priv, signPub: s.pub };
}

export const encPubFromPriv = (priv: Uint8Array) => x25519.getPublicKey(priv);
export const signPubFromPriv = (priv: Uint8Array) => ed25519.getPublicKey(priv);

/** What the account key signs to vouch for a device. */
export function deviceCertMessage(userId: string, deviceId: string, encPub: Uint8Array, signPub: Uint8Array): Uint8Array {
  return frame('zoyra-e2ee-device-v1', userId, deviceId, encPub, signPub);
}

export function signDevice(accountPriv: Uint8Array, userId: string, d: Pick<DeviceKeys, 'deviceId' | 'encPub' | 'signPub'>): Uint8Array {
  return ed25519.sign(deviceCertMessage(userId, d.deviceId, d.encPub, d.signPub), accountPriv);
}

export function verifyDevice(accountPub: Uint8Array, userId: string, deviceId: string, encPub: Uint8Array, signPub: Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, deviceCertMessage(userId, deviceId, encPub, signPub), accountPub);
  } catch {
    return false;
  }
}

// ═════════════════════════════════════════════ messages

export type Recipient = { deviceId: string; encPub: Uint8Array };

/** One row of `message_keys` (wire format, base64). */
export type Envelope = { device_id: string; wrapped_key: string; eph_pub: string; nonce: string };

/** What goes to `send_e2ee_message` / `edit_e2ee_message` (besides cid / message id / kind). */
export type Sealed = {
  e2ee_version: number;
  ciphertext: string;
  nonce: string;
  sender_device_id: string;
  signature: string;
  envelopes: Envelope[];
};

export function messageAad(version: number, conversationId: string, messageId: string, senderDeviceId: string): Uint8Array {
  return frame('zoyra-e2ee-msg', version, conversationId, messageId, senderDeviceId);
}

const keyCommit = (contentKey: Uint8Array) => sha256(frame('zoyra-e2ee-commit-v1', contentKey));

/** Digest the sender's device key signs. Covers the ciphertext and a commitment to the content key. */
export function messageDigest(p: { version: number; conversationId: string; messageId: string; senderDeviceId: string; nonce: Uint8Array; ciphertext: Uint8Array; contentKey: Uint8Array }): Uint8Array {
  return sha256(frame('zoyra-e2ee-sig-v1', p.version, p.conversationId, p.messageId, p.senderDeviceId, p.nonce, p.ciphertext, keyCommit(p.contentKey)));
}

const wrapInfo = (messageId: string, deviceId: string) => frame('zoyra-e2ee-wrap-v1', messageId, deviceId);
const wrapAad = (messageId: string, deviceId: string) => frame('zoyra-e2ee-wrap-aad', messageId, deviceId);

function isZero(b: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < b.length; i++) acc |= b[i];
  return acc === 0;
}

/** `shared` = X25519(eph, recipient), computed by either side. */
function wrapKeyFor(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array, messageId: string, deviceId: string): Uint8Array {
  if (isZero(shared)) throw new E2EEError('bad_envelope', 'low-order public key');
  return hkdf(sha256, shared, concatBytes(ephPub, recipientPub), wrapInfo(messageId, deviceId), 32);
}

/**
 * Encrypts `plaintext` once with a fresh content key and wraps that key for every recipient device
 * (ephemeral-static X25519 → HKDF-SHA256 → XChaCha20-Poly1305). One ephemeral key per message, so
 * each recipient costs one X25519 operation.
 */
export function sealPayload(p: { conversationId: string; messageId: string; sender: DeviceKeys; recipients: Recipient[]; plaintext: Uint8Array }): Sealed {
  const version = E2EE_VERSION;
  const seen = new Set<string>();
  const recipients = p.recipients.filter((r) => (seen.has(r.deviceId) ? false : (seen.add(r.deviceId), true)));
  if (!recipients.length) throw new E2EEError('no_envelope', 'no recipient devices');
  if (recipients.length > MAX_ENVELOPES) throw new E2EEError('bad_format', 'too many recipient devices');

  const contentKey = random(32);
  const nonce = random(24);
  const ciphertext = xchacha20poly1305(contentKey, nonce, messageAad(version, p.conversationId, p.messageId, p.sender.deviceId)).encrypt(p.plaintext);

  const eph = generateEncKeyPair();
  const ephPubB64 = toB64(eph.pub);
  const envelopes: Envelope[] = recipients.map((r) => {
    const k = wrapKeyFor(x25519.getSharedSecret(eph.priv, r.encPub), eph.pub, r.encPub, p.messageId, r.deviceId);
    const wn = random(24);
    const wrapped = xchacha20poly1305(k, wn, wrapAad(p.messageId, r.deviceId)).encrypt(contentKey);
    return { device_id: r.deviceId, wrapped_key: toB64(wrapped), eph_pub: ephPubB64, nonce: toB64(wn) };
  });

  const signature = ed25519.sign(messageDigest({ version, conversationId: p.conversationId, messageId: p.messageId, senderDeviceId: p.sender.deviceId, nonce, ciphertext, contentKey }), p.sender.signPriv);
  eph.priv.fill(0);
  return { e2ee_version: version, ciphertext: toB64(ciphertext), nonce: toB64(nonce), sender_device_id: p.sender.deviceId, signature: toB64(signature), envelopes };
}

/** Unwraps the content key from my envelope. Throws E2EEError('bad_envelope') on failure. */
export function openEnvelope(p: { messageId: string; deviceId: string; encPriv: Uint8Array; encPub?: Uint8Array; envelope: Pick<Envelope, 'wrapped_key' | 'eph_pub' | 'nonce'> }): Uint8Array {
  try {
    const ephPub = fromB64(p.envelope.eph_pub);
    const k = wrapKeyFor(x25519.getSharedSecret(p.encPriv, ephPub), ephPub, p.encPub ?? x25519.getPublicKey(p.encPriv), p.messageId, p.deviceId);
    const key = xchacha20poly1305(k, fromB64(p.envelope.nonce), wrapAad(p.messageId, p.deviceId)).decrypt(fromB64(p.envelope.wrapped_key));
    if (key.length !== 32) throw new Error('bad key length');
    return key;
  } catch (e) {
    if (e instanceof E2EEError) throw e;
    throw new E2EEError('bad_envelope', 'could not unwrap message key');
  }
}

/** Verifies the sender signature, then decrypts. Returns plaintext bytes. */
export function openPayload(p: {
  version: number;
  conversationId: string;
  messageId: string;
  senderDeviceId: string;
  senderSignPub: Uint8Array;
  ciphertext: string;
  nonce: string;
  signature: string;
  contentKey: Uint8Array;
}): Uint8Array {
  if (p.version !== E2EE_VERSION) throw new E2EEError('unsupported_version', `unsupported e2ee version ${p.version}`);
  const ct = fromB64(p.ciphertext);
  const nonce = fromB64(p.nonce);
  let ok = false;
  try {
    ok = ed25519.verify(fromB64(p.signature), messageDigest({ version: p.version, conversationId: p.conversationId, messageId: p.messageId, senderDeviceId: p.senderDeviceId, nonce, ciphertext: ct, contentKey: p.contentKey }), p.senderSignPub);
  } catch {
    ok = false;
  }
  if (!ok) throw new E2EEError('bad_signature', 'message signature is not valid');
  try {
    return xchacha20poly1305(p.contentKey, nonce, messageAad(p.version, p.conversationId, p.messageId, p.senderDeviceId)).decrypt(ct);
  } catch {
    throw new E2EEError('decrypt_failed', 'message could not be decrypted');
  }
}

// ═════════════════════════════════════════════ files (voice notes, photos)

const FILE_MAGIC = utf8('ZEF1');
export const FILE_CHUNK = 64 * 1024;
const fileAad = (index: number, last: boolean) => frame('zoyra-e2ee-file-v1', u64be(index), last ? 1 : 0);

/**
 * Chunked XChaCha20-Poly1305 (64 KiB chunks). Layout: 'ZEF1' | u32 chunkSize | 16-byte base nonce |
 * chunks (each chunk + 16-byte tag). Chunk nonce = base nonce ‖ u64 index; the last chunk is flagged
 * in its AAD so truncation and reordering are detected.
 */
export function encryptFile(data: Uint8Array, key: Uint8Array = random(32), chunkSize = FILE_CHUNK): { key: Uint8Array; data: Uint8Array } {
  const base = random(16);
  const n = Math.max(1, Math.ceil(data.length / chunkSize));
  const out = new Uint8Array(24 + data.length + n * 16);
  out.set(FILE_MAGIC, 0);
  out.set(u32be(chunkSize), 4);
  out.set(base, 8);
  let o = 24;
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const chunk = data.subarray(i * chunkSize, Math.min(data.length, (i + 1) * chunkSize));
    const sealed = xchacha20poly1305(key, concatBytes(base, u64be(i)), fileAad(i, last)).encrypt(chunk);
    out.set(sealed, o);
    o += sealed.length;
  }
  return { key, data: out };
}

export function decryptFile(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 24 + 16 || !equalBytes(data.subarray(0, 4), FILE_MAGIC)) throw new E2EEError('bad_format', 'not an encrypted file');
  const chunkSize = new DataView(data.buffer, data.byteOffset + 4, 4).getUint32(0, false);
  if (chunkSize < 1 || chunkSize > 16 * 1024 * 1024) throw new E2EEError('bad_format', 'bad chunk size');
  const base = data.subarray(8, 24);
  const body = data.subarray(24);
  const step = chunkSize + 16;
  const n = Math.max(1, Math.ceil(body.length / step));
  const out = new Uint8Array(body.length - n * 16);
  let o = 0;
  try {
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      const c = body.subarray(i * step, Math.min(body.length, (i + 1) * step));
      const plain = xchacha20poly1305(key, concatBytes(base, u64be(i)), fileAad(i, last)).decrypt(c);
      out.set(plain, o);
      o += plain.length;
    }
  } catch {
    throw new E2EEError('decrypt_failed', 'file could not be decrypted');
  }
  return out;
}

// ═════════════════════════════════════════════ PIN backup

export type KdfName = 'scrypt';
export type KdfParams = { N: number; r: number; p: number };
/** scrypt N=2^15, r=8, p=1 (32 MiB). ~90 ms on desktop V8; roughly 0.5–1.5 s on a phone under Hermes. */
export const DEFAULT_KDF: KdfParams = { N: 2 ** 15, r: 8, p: 1 };

export type PinKeys = { backupKey: Uint8Array; verifier: Uint8Array };

export function validKdfParams(k: unknown): k is KdfParams {
  const o = k as KdfParams;
  return !!o && Number.isInteger(o.N) && Number.isInteger(o.r) && Number.isInteger(o.p) && o.N >= 2 ** 14 && o.N <= 2 ** 20 && (o.N & (o.N - 1)) === 0 && o.r >= 8 && o.r <= 16 && o.p >= 1 && o.p <= 4;
}

/**
 * PIN → (backup encryption key, server verifier). The server stores only the verifier and the
 * encrypted blob; it hands the blob out only when the verifier matches (rate limited).
 */
export async function stretchPin(pin: string, salt: Uint8Array, params: KdfParams = DEFAULT_KDF, onProgress?: (p: number) => void): Promise<PinKeys> {
  if (!validKdfParams(params)) throw new E2EEError('bad_format', 'bad kdf params');
  const stretched = await scryptAsync(utf8(`zoyra-pin-v1:${pin}`), salt, { N: params.N, r: params.r, p: params.p, dkLen: 32, asyncTick: 25, onProgress });
  const backupKey = hkdf(sha256, stretched, salt, utf8('zoyra-e2ee-backup-key-v1'), 32);
  const verifier = hkdf(sha256, stretched, salt, utf8('zoyra-e2ee-pin-verifier-v1'), 32);
  stretched.fill(0);
  return { backupKey, verifier };
}

/** Everything a new phone needs: the account signing key and every device decryption key. */
export type BackupBlob = {
  v: 1;
  account_sign_priv: string;
  keys: { device_id: string; enc_priv: string; created_at: string }[];
};

const backupAad = (userId: string) => frame('zoyra-e2ee-backup-v1', userId);

export function sealBackup(backupKey: Uint8Array, userId: string, blob: BackupBlob): { ciphertext: string; nonce: string } {
  const nonce = random(24);
  const ct = xchacha20poly1305(backupKey, nonce, backupAad(userId)).encrypt(utf8(JSON.stringify(blob)));
  return { ciphertext: toB64(ct), nonce: toB64(nonce) };
}

export function openBackup(backupKey: Uint8Array, userId: string, ciphertext: string, nonce: string): BackupBlob {
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(backupKey, fromB64(nonce), backupAad(userId)).decrypt(fromB64(ciphertext));
  } catch {
    throw new E2EEError('wrong_pin', 'wrong PIN');
  }
  const blob = JSON.parse(fromUtf8(plain)) as BackupBlob;
  if (blob?.v !== 1 || typeof blob.account_sign_priv !== 'string' || !Array.isArray(blob.keys)) throw new E2EEError('bad_format', 'bad backup');
  return blob;
}

// ═════════════════════════════════════════════ local sealing (cache at rest)

export function sealLocal(key: Uint8Array, plaintext: Uint8Array, aad: string): string {
  const nonce = random(24);
  return toB64(concatBytes(nonce, xchacha20poly1305(key, nonce, utf8(aad)).encrypt(plaintext)));
}

export function openLocal(key: Uint8Array, sealed: string, aad: string): Uint8Array {
  const b = fromB64(sealed);
  return xchacha20poly1305(key, b.subarray(0, 24), utf8(aad)).decrypt(b.subarray(24));
}

// ═════════════════════════════════════════════ safety number

/** 30 digits for one user (Signal-style: 5200 × SHA-512 over the account key, 6 groups of 5 digits). */
export function fingerprintDigits(userId: string, accountPub: Uint8Array): string {
  let h: Uint8Array = sha512(concatBytes(new Uint8Array([0, 0]), accountPub, utf8(userId)));
  for (let i = 0; i < 5200; i++) h = sha512(concatBytes(h, accountPub));
  let out = '';
  for (let g = 0; g < 6; g++) {
    let v = 0;
    for (let j = 0; j < 5; j++) v = v * 256 + h[g * 5 + j];
    out += String(v % 100000).padStart(5, '0');
  }
  return out;
}

/** 60-digit safety number. Same on both phones (ordered by user id). */
export function safetyNumber(a: { userId: string; accountPub: Uint8Array }, b: { userId: string; accountPub: Uint8Array }): string {
  const fa = fingerprintDigits(a.userId, a.accountPub);
  const fb = fingerprintDigits(b.userId, b.accountPub);
  return a.userId < b.userId ? fa + fb : fb + fa;
}

/** "12345 67890 …" in 12 groups. */
export const formatSafetyNumber = (n: string) => n.replace(/(\d{5})(?=\d)/g, '$1 ');
