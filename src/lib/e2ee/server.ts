import { supabase } from '../supabase';
import { E2EEError, type Envelope, type KdfParams, type Sealed } from './crypto';

/** Thin wrappers over supabase/migrations/20261115250000_e2ee.sql (+ 20261115280000, 20261115310000). Keep names / args in sync. */

export type ServerDevice = { user_id: string; device_id: string; enc_pub: string; sign_pub: string; account_sig: string; account_sign_pub: string };
export type DeviceRow = { device_id: string; user_id: string; enc_pub: string; sign_pub: string; account_sig: string; revoked_at: string | null; created_at: string };
export type BackupParams =
  | { exists: false }
  | { exists: true; kdf: 'scrypt'; kdf_params: KdfParams; salt: string; version: number; attempts_left: number; locked_until: string | null };
export type RestoreResult =
  | { status: 'ok'; ciphertext: string; nonce: string; version: number; attempts_left: number }
  | { status: 'wrong_pin'; attempts_left: number }
  | { status: 'locked'; locked_until: string; attempts_left: 0 }
  | { status: 'no_backup' };
export type StoreResult = { status: 'ok'; version: number } | { status: 'conflict'; version: number } | Exclude<RestoreResult, { status: 'ok' }>;

type PgError = { message?: string; hint?: string; code?: string } | null;

function fail(e: PgError): never {
  const err = new E2EEError('server', e?.message ?? 'Request failed') as E2EEError & { hint?: string; pgCode?: string };
  err.hint = e?.hint;
  err.pgCode = e?.code;
  throw err;
}

export async function fetchAccountPub(userId: string): Promise<string | null> {
  const { data, error } = await supabase.from('e2ee_accounts').select('account_sign_pub').eq('user_id', userId).maybeSingle();
  if (error) fail(error);
  return (data as { account_sign_pub: string } | null)?.account_sign_pub ?? null;
}

export async function fetchDevices(deviceIds: string[]): Promise<DeviceRow[]> {
  if (!deviceIds.length) return [];
  const { data, error } = await supabase.from('e2ee_devices').select('device_id, user_id, enc_pub, sign_pub, account_sig, revoked_at, created_at').in('device_id', deviceIds);
  if (error) fail(error);
  return (data ?? []) as DeviceRow[];
}

export async function fetchUserDevices(userId: string): Promise<DeviceRow[]> {
  const { data, error } = await supabase.from('e2ee_devices').select('device_id, user_id, enc_pub, sign_pub, account_sig, revoked_at, created_at').eq('user_id', userId).order('created_at');
  if (error) fail(error);
  return (data ?? []) as DeviceRow[];
}

export async function conversationDevices(cid: string): Promise<ServerDevice[]> {
  const { data, error } = await supabase.rpc('get_conversation_devices', { p_cid: cid });
  if (error) fail(error);
  return (data ?? []) as ServerDevice[];
}

export async function setupAccount(p: {
  accountSignPub: string;
  deviceId: string;
  encPub: string;
  signPub: string;
  accountSig: string;
  /** Optional PIN backup (20261115310000: all null = no backup row). */
  backupCiphertext?: string | null;
  backupNonce?: string | null;
  kdfParams?: KdfParams | null;
  salt?: string | null;
  verifier?: string | null;
  reset: boolean;
  label?: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc('e2ee_setup', {
    p_account_sign_pub: p.accountSignPub,
    p_device_id: p.deviceId,
    p_enc_pub: p.encPub,
    p_sign_pub: p.signPub,
    p_account_sig: p.accountSig,
    p_backup_ciphertext: p.backupCiphertext ?? null,
    p_backup_nonce: p.backupNonce ?? null,
    p_kdf_params: p.kdfParams ?? null,
    p_salt: p.salt ?? null,
    p_verifier: p.verifier ?? null,
    p_reset: p.reset,
    p_label: p.label ?? null,
  });
  if (error) fail(error);
}

export async function registerDevice(p: { deviceId: string; encPub: string; signPub: string; accountSig: string; label?: string | null }): Promise<void> {
  const { error } = await supabase.rpc('register_device', { p_device_id: p.deviceId, p_enc_pub: p.encPub, p_sign_pub: p.signPub, p_account_sig: p.accountSig, p_label: p.label ?? null });
  if (error) fail(error);
}

export async function revokeDevice(deviceId: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_device', { p_device_id: deviceId });
  if (error) fail(error);
}

export async function backupParams(): Promise<BackupParams> {
  const { data, error } = await supabase.rpc('get_backup_params');
  if (error) fail(error);
  return data as BackupParams;
}

export async function beginRestore(verifier: string): Promise<RestoreResult> {
  const { data, error } = await supabase.rpc('begin_backup_restore', { p_verifier: verifier });
  if (error) fail(error);
  return data as RestoreResult;
}

export async function confirmRestore(): Promise<void> {
  const { error } = await supabase.rpc('confirm_backup_restore');
  if (error) fail(error);
}

/** Replaces the backup; `currentVerifier: null` creates it when none exists (turning "Chat backup" on). */
export async function storeBackup(p: { ciphertext: string; nonce: string; kdfParams: KdfParams; salt: string; verifier: string; currentVerifier: string | null; expectedVersion: number | null }): Promise<StoreResult> {
  const { data, error } = await supabase.rpc('store_key_backup', {
    p_ciphertext: p.ciphertext,
    p_nonce: p.nonce,
    p_kdf_params: p.kdfParams,
    p_salt: p.salt,
    p_verifier: p.verifier,
    p_current_verifier: p.currentVerifier,
    p_expected_version: p.expectedVersion,
  });
  if (error) fail(error);
  return data as StoreResult;
}

/** Turns the backup off. Needs the current verifier, or a recent sign-in when `verifier` is null (hint 'e2ee_reauth'). */
export async function deleteBackup(verifier: string | null): Promise<{ status: 'ok' } | Exclude<RestoreResult, { status: 'ok' }>> {
  const { data, error } = await supabase.rpc('delete_key_backup', { p_verifier: verifier });
  if (error) fail(error);
  return data as { status: 'ok' } | Exclude<RestoreResult, { status: 'ok' }>;
}

export async function sendSealed(p: { cid: string; messageId: string; kind: string; replyTo: string | null; sealed: Sealed }): Promise<string> {
  const { data, error } = await supabase.rpc('send_e2ee_message', {
    p_cid: p.cid,
    p_message_id: p.messageId,
    p_ciphertext: p.sealed.ciphertext,
    p_nonce: p.sealed.nonce,
    p_sender_device_id: p.sealed.sender_device_id,
    p_signature: p.sealed.signature,
    p_kind: p.kind,
    p_reply_to: p.replyTo,
    p_envelopes: p.sealed.envelopes,
    p_version: p.sealed.e2ee_version,
  });
  if (error) fail(error);
  return data as string;
}

export async function editSealed(p: { messageId: string; sealed: Sealed }): Promise<void> {
  const { error } = await supabase.rpc('edit_e2ee_message', {
    p_message_id: p.messageId,
    p_ciphertext: p.sealed.ciphertext,
    p_nonce: p.sealed.nonce,
    p_sender_device_id: p.sealed.sender_device_id,
    p_signature: p.sealed.signature,
    p_envelopes: p.sealed.envelopes,
    p_version: p.sealed.e2ee_version,
  });
  if (error) fail(error);
}

/** My envelopes (RLS: only rows of my own devices are visible) for these messages. */
export async function fetchEnvelopes(messageIds: string[], deviceIds: string[]): Promise<(Envelope & { message_id: string })[]> {
  if (!messageIds.length || !deviceIds.length) return [];
  const out: (Envelope & { message_id: string })[] = [];
  for (let i = 0; i < messageIds.length; i += 150) {
    const { data, error } = await supabase
      .from('message_keys')
      .select('message_id, device_id, wrapped_key, eph_pub, nonce')
      .in('message_id', messageIds.slice(i, i + 150))
      .in('device_id', deviceIds);
    if (error) fail(error);
    out.push(...((data ?? []) as (Envelope & { message_id: string })[]));
  }
  return out;
}
