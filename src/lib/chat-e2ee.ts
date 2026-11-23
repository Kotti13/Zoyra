/**
 * Chat ⇄ E2EE glue (src/lib/e2ee is the crypto core). Every screen that sends or loads chat messages goes
 * through here (directly or via src/lib/chat.ts sendMessage / loadChat / loadMessage):
 *
 *   sendSecure(cid, me, m)      encrypts when every member has E2EE keys; plaintext ONLY when some member has
 *                               never set up E2EE (legacy client) → meta.e2ee_off = true ("Not end-to-end
 *                               encrypted" notice). Never downgrades a member whose keys this phone has seen.
 *   decryptChatRows(rows)       batch decrypt + applyPayload (failed rows get meta.e2ee_error).
 *   encryptAndUpload(...)       voice / photo: encryptFile → chat-media (application/octet-stream).
 *   decryptedMediaUri(...)      download → decryptFile → cache file (expo-file-system File / Paths API).
 *
 * This module must not import ./chat at runtime (chat.ts imports it).
 */
import { Directory, File, Paths } from 'expo-file-system';
import { router, type Href } from 'expo-router';
import { AppState, Platform } from 'react-native';

import { showDialog } from './dialog';
import {
  E2EE_MSG_COLS,
  applyPayload,
  decryptFile,
  decryptMessages,
  editEncryptedMessage,
  encryptFile,
  getE2EEStatus,
  initE2EE,
  invalidateRecipients,
  isEncryptedRow,
  knowsKeysOf,
  sendEncryptedMessage,
  skipRestore,
  warmRecipients,
  type DecryptError,
  type E2EEMedia,
  type E2EEMessageRow,
  type E2EEPayload,
  type E2EEStatus,
} from './e2ee';
import { supabase } from './supabase';

export { E2EE_MSG_COLS };

/** Kinds send_e2ee_message accepts (server system kinds call / swap stay plaintext). */
export const E2EE_KINDS = new Set(['text', 'track', 'voice', 'poll', 'lyric', 'playlist', 'jam', 'live', 'photo', 'location', 'capsule', 'whisper']);

/**
 * Thrown by a send when it can't go ahead right now: the user picked "Restore" on the one-time "Restore your
 * chat history first?" prompt (`route` = /e2ee-restore), the sign-in is too old to make fresh keys (`route` =
 * password confirm), or they cancelled the prompt (`route` null). Keys are otherwise created silently.
 */
export class E2EESetupRequired extends Error {
  route: Href | null;
  constructor(route: Href | null, message = 'Message not sent') {
    super(message);
    this.name = 'E2EESetupRequired';
    this.route = route;
  }
}
export const isSetupRequired = (e: unknown): e is E2EESetupRequired => e instanceof E2EESetupRequired;

/**
 * When `e` is E2EESetupRequired: opens its route (if any; the screen goes back here when done) and returns true,
 * so the caller just stops without an error note. `_next` is kept for older call sites.
 */
export function routeIfSetupRequired(e: unknown, _next?: string): boolean {
  if (!isSetupRequired(e)) return false;
  if (e.route) router.push(e.route);
  return true;
}

/** Loads keys for the signed-in user when needed (dedupes with a running init; creates keys silently). */
export async function ensureE2EE(): Promise<E2EEStatus> {
  const s = getE2EEStatus();
  const { data } = await supabase.auth.getSession();
  const uid = data.session?.user.id;
  if (!uid) throw new Error('Sign in to Zoyra first');
  if (s.status === 'ready' && s.userId === uid) return 'ready';
  return initE2EE(uid);
}

const REAUTH_ROUTE: Href = { pathname: '/e2ee-setup', params: { mode: 'reauth' } };
let restorePrompt: Promise<void> | null = null;

/**
 * New phone with an undecided restore offer: asks once per send attempt "Restore your chat history first?".
 * "Continue without" makes fresh keys (skipRestore) and the send goes ahead. Concurrent sends share one prompt.
 */
async function decideRestoreForSend(): Promise<void> {
  if (AppState.currentState === 'background') throw new Error('Open Zoyra to finish turning on encrypted chats on this phone.');
  const backup = getE2EEStatus().restoreReason === 'backup';
  const choice = await showDialog({
    title: backup ? 'Restore your chat history first?' : 'Use encrypted chats on this phone?',
    message: backup
      ? 'You have an encrypted chat backup. Restore it with your PIN to read older messages here, or continue without it: older messages won’t be readable on this phone.'
      : 'Your encryption keys were reset on another phone. Continue to use your chats here; your other phone will switch to new keys the next time it’s used.',
    icon: 'lock',
    actions: [
      ...(backup ? [{ label: 'Restore', style: 'default' as const }] : []),
      { label: 'Continue without', style: 'primary' as const },
      { label: 'Cancel', style: 'cancel' as const },
    ],
  });
  if (choice === 'Restore') throw new E2EESetupRequired('/e2ee-restore');
  if (choice !== 'Continue without') throw new E2EESetupRequired(null);
  const status = await skipRestore();
  if (status === 'needs_reauth') throw new E2EESetupRequired(REAUTH_ROUTE);
  if (status !== 'ready') throw new Error('Encryption keys couldn’t load. Check your connection and try again.');
}

async function requireReadyForSend(): Promise<void> {
  const status = await ensureE2EE();
  if (status === 'ready') return;
  if (status === 'needs_restore') {
    if (!restorePrompt) restorePrompt = decideRestoreForSend().finally(() => (restorePrompt = null));
    return restorePrompt;
  }
  if (status === 'needs_reauth') throw new E2EESetupRequired(REAUTH_ROUTE);
  throw new Error('Encryption keys couldn’t load. Check your connection and try again.');
}

/* ------------------------------------------------------------------ who has keys */

type Coverage = { full: boolean; missing: string[]; at: number };
const coverage = new Map<string, Coverage>();
const COVERAGE_TTL = 20_000;

/** Forget cached key coverage (member joined / a contact just set up E2EE). */
export function invalidateKeyCoverage(cid?: string) {
  if (cid) coverage.delete(cid);
  else coverage.clear();
  invalidateRecipients(cid); // members / devices changed: look the recipients up again before the next send
}

/**
 * Called when a chat opens: looks up who has keys and which devices to encrypt to now, so the first message
 * doesn't wait for those two round trips. Best effort; never throws.
 */
export async function warmSend(cid: string, me: string): Promise<void> {
  try {
    if (getE2EEStatus().status !== 'ready') return;
    await Promise.all([keyCoverage(cid, me), warmRecipients(cid)]);
  } catch {
    /* sending reports real problems */
  }
}

/**
 * Which members of `cid` have no E2EE account at all (legacy clients). Throws when the server says a
 * contact has no keys although this phone has seen their keys before (would be a silent downgrade).
 */
export async function keyCoverage(cid: string, me: string): Promise<Coverage> {
  const hit = coverage.get(cid);
  if (hit && Date.now() - hit.at < COVERAGE_TTL) return hit;
  const members = await supabase.from('conversation_members').select('user_id').eq('conversation_id', cid);
  if (members.error) throw new Error(members.error.message);
  const ids = [...new Set(((members.data ?? []) as { user_id: string }[]).map((r) => r.user_id).filter((u) => u !== me))];
  let withKeys = new Set<string>();
  if (ids.length) {
    const acc = await supabase.from('e2ee_accounts').select('user_id').in('user_id', ids);
    if (acc.error) throw new Error(acc.error.message);
    withKeys = new Set(((acc.data ?? []) as { user_id: string }[]).map((r) => r.user_id));
  }
  const missing = ids.filter((u) => !withKeys.has(u));
  for (const u of missing) {
    if (await knowsKeysOf(u)) throw new Error('Couldn’t load this person’s encryption keys. Try again in a moment.');
  }
  const c: Coverage = { full: missing.length === 0, missing, at: Date.now() };
  coverage.set(cid, c);
  return c;
}

/** True when a message sent now would be end-to-end encrypted (may ask once to restore history on a new phone). */
export async function willEncrypt(cid: string, me: string, kind = 'text'): Promise<boolean> {
  await requireReadyForSend();
  if (!E2EE_KINDS.has(kind)) return false;
  return (await keyCoverage(cid, me)).full;
}

/* ------------------------------------------------------------------ send */

export type OutgoingMessage = { body?: string; track?: unknown; kind: string; reply_to?: string | null; meta?: Record<string, unknown> };
export type SentResult = { id: string; encrypted: boolean; meta: Record<string, unknown>; row?: Record<string, unknown> };

/** Meta keys that are local render flags (never sent). */
const LOCAL_META = ['e2ee', 'e2ee_error', 'e2ee_pending', 'e2ee_off', 'edited_at'];
export function cleanMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out = { ...(meta ?? {}) };
  for (const k of LOCAL_META) delete out[k];
  return out;
}

const uuid = () => {
  // RFC 4122 v4 from the CSPRNG installed by ./e2ee/random.ts.
  const b = new Uint8Array(16);
  (globalThis as unknown as { crypto: { getRandomValues: (a: Uint8Array) => Uint8Array } }).crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** A fresh message id for an optimistic bubble (kept when the message is encrypted). */
export const newMessageId = (): string => uuid();

/**
 * Sends one chat message. Encrypted when every member has keys; plaintext (meta.e2ee_off) only when some
 * member never set up E2EE. `requireEncrypted` (media uploaded encrypted) refuses the plaintext path.
 * Plaintext inserts go through `insertPlain` (the caller's supabase insert, so RLS / triggers apply).
 */
export async function sendSecure(
  cid: string,
  me: string,
  m: OutgoingMessage,
  opts: { messageId?: string; requireEncrypted?: boolean; insertPlain: (row: Record<string, unknown>) => Promise<Record<string, unknown>> },
): Promise<SentResult> {
  await requireReadyForSend();
  const meta = cleanMeta(m.meta);
  const encrypt = E2EE_KINDS.has(m.kind) && (await keyCoverage(cid, me)).full;
  if (encrypt) {
    const payload: E2EEPayload = {};
    if (m.body) payload.body = m.body;
    if (m.track) payload.track = m.track;
    if (Object.keys(meta).length) payload.meta = meta;
    const id = await sendEncryptedMessage(cid, payload, { messageId: opts.messageId, kind: m.kind, replyTo: m.reply_to ?? null });
    return { id, encrypted: true, meta: { ...meta, e2ee: true } };
  }
  if (opts.requireEncrypted) throw new Error('Someone in this chat can’t receive encrypted media yet.');
  const plainMeta = E2EE_KINDS.has(m.kind) ? { ...meta, e2ee_off: true } : meta;
  const row = await opts.insertPlain({
    ...(opts.messageId ? { id: opts.messageId } : {}),
    conversation_id: cid,
    sender_id: me,
    body: m.body ?? '',
    track: m.track ?? null,
    kind: m.kind,
    reply_to: m.reply_to ?? null,
    meta: plainMeta,
  });
  return { id: String(row.id), encrypted: false, meta: plainMeta, row };
}

/** Edit my text message (encrypted rows are re-encrypted; plaintext goes through edit_message). */
export async function editSecure(m: { id: string; conversation_id: string; meta?: Record<string, unknown> | null }, body: string, editPlain: () => Promise<void>): Promise<void> {
  if (m.meta?.e2ee === true) {
    await requireReadyForSend();
    await editEncryptedMessage(m.conversation_id, m.id, { body: body.trim() });
    return;
  }
  await editPlain();
}

/* ------------------------------------------------------------------ receive */

/** Decrypts every encrypted row of a page / realtime batch; plaintext rows pass through unchanged. */
export async function decryptChatRows<T extends { id: string }>(rows: T[]): Promise<T[]> {
  const enc = rows.filter((r) => isEncryptedRow(r as unknown as E2EEMessageRow));
  if (!enc.length) return rows;
  if (getE2EEStatus().status !== 'ready') await ensureE2EE().catch(() => undefined);
  const res = await decryptMessages(enc as unknown as E2EEMessageRow[]);
  return rows.map((r) => (isEncryptedRow(r as unknown as E2EEMessageRow) ? (applyPayload(r as unknown as E2EEMessageRow & { body?: string }, res.get(r.id)) as unknown as T) : r));
}

export const isE2EEMessage = (m: { meta?: Record<string, unknown> | null }) => m.meta?.e2ee === true;
/** Decrypt failed on this device (render "Message unavailable on this device"). */
export const decryptErrorOf = (m: { meta?: Record<string, unknown> | null }): DecryptError['error'] | null =>
  typeof m.meta?.e2ee_error === 'string' ? (m.meta.e2ee_error as DecryptError['error']) : null;
/** Sent in plaintext because someone had no keys yet. */
export const isNotEncrypted = (m: { meta?: Record<string, unknown> | null }) => m.meta?.e2ee_off === true;

/** Explanation for the "Message unavailable" info sheet. */
export function decryptErrorText(code: DecryptError['error'] | null): string {
  switch (code) {
    case 'not_ready':
      return 'Encryption isn’t set up on this phone yet. Restore your keys with your PIN to read this message.';
    case 'no_envelope':
      return 'This message wasn’t encrypted for this phone. It was probably sent before you set up or restored encryption here.';
    case 'untrusted_device':
    case 'unknown_device':
      return 'The sender’s device couldn’t be verified, so the message was not shown. Their security code may have changed.';
    case 'bad_signature':
    case 'bad_envelope':
    case 'decrypt_failed':
      return 'This message failed its integrity check and was not shown. It may have been damaged or tampered with.';
    case 'unsupported_version':
      return 'This message uses a newer encryption format. Update Zoyra to read it.';
    case 'server':
      return 'The message key couldn’t be downloaded. Check your connection; it will retry when you reopen the chat.';
    default:
      return 'This message couldn’t be decrypted on this phone.';
  }
}

/* ------------------------------------------------------------------ media */

const CHAT_MEDIA = 'chat-media';

async function readBytes(uri: string): Promise<Uint8Array> {
  try {
    return await new File(uri).bytes();
  } catch {
    return new Uint8Array(await (await fetch(uri)).arrayBuffer());
  }
}

/** Encrypts a local file and uploads it to chat-media. Returns what goes in the payload's meta.media. */
export async function encryptAndUpload(cid: string, me: string, uri: string, mime: string): Promise<E2EEMedia> {
  const plain = await readBytes(uri);
  if (!plain.byteLength) throw new Error('Could not read that file.');
  if (plain.byteLength > 10 * 1024 * 1024) throw new Error('That file is too large (max 10 MB).');
  const { data, key } = encryptFile(plain);
  const path = `${cid}/${me}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`;
  const { error } = await supabase.storage.from(CHAT_MEDIA).upload(path, data, { contentType: 'application/octet-stream', upsert: false });
  if (error) throw new Error(/bucket not found/i.test(error.message) ? 'Chat media storage isn’t set up yet.' : `Upload failed: ${error.message}`);
  return { path, key, mime, size: plain.byteLength };
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/webm': 'webm' };
const inflight = new Map<string, Promise<string>>();

function mediaDir(): Directory {
  const d = new Directory(Paths.cache, 'zoyra-e2ee-media');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

/**
 * Local file URI of a decrypted chat-media object (download → decryptFile → cache file). Cached by path;
 * concurrent calls share one download. `signedUrl` resolves the storage path to a download URL.
 */
export function decryptedMediaUri(path: string, key: string, mime: string | undefined, signedUrl: (p: string) => Promise<string>): Promise<string> {
  const id = `${path}|${key.slice(0, 8)}`;
  const running = inflight.get(id);
  if (running) return running;
  const p = (async () => {
    const ext = EXT[(mime ?? '').toLowerCase()] ?? 'bin';
    const name = `${path.replace(/[^A-Za-z0-9_-]+/g, '_').slice(-120)}.${ext}`;
    if (Platform.OS === 'web') {
      const bytes = decryptFile(new Uint8Array(await (await fetch(await signedUrl(path))).arrayBuffer()), key);
      return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime ?? 'application/octet-stream' }));
    }
    const out = new File(mediaDir(), name);
    if (out.exists && (out.size ?? 0) > 0) return out.uri;
    const res = await fetch(await signedUrl(path));
    if (!res.ok) throw new Error('Could not download this file');
    const bytes = decryptFile(new Uint8Array(await res.arrayBuffer()), key);
    if (!out.exists) out.create({ overwrite: true });
    await out.write(bytes);
    return out.uri;
  })();
  inflight.set(id, p);
  p.catch(() => undefined).finally(() => inflight.delete(id));
  return p;
}

/** Deletes decrypted media copies (sign-out / "Forget this device"). Never throws. */
export function clearDecryptedMedia(): void {
  try {
    const d = new Directory(Paths.cache, 'zoyra-e2ee-media');
    if (d.exists) d.delete();
  } catch {
    // ignore
  }
}
