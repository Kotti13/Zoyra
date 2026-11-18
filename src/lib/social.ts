import { useCallback, useEffect, useState } from 'react';

import { confirmDialog } from './dialog';
import { guardBlock } from './forever';
import { supabase } from './supabase';

/**
 * Blocking + family plan helpers (server side: supabase/migrations/20261113190000_safety_family.sql).
 * A block in either direction stops new conversations, messages, follows and dedications.
 */

export type BlockedUser = { id: string; display_name: string; avatar_url: string | null; username: string | null; blocked_at: string };

type PgError = { message: string; code?: string; hint?: string };

/** Turns Postgres / RLS errors from social writes into a sentence the user can act on. */
export function friendlySocialError(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  const err = (e ?? {}) as Partial<PgError>;
  const msg = typeof err.message === 'string' ? err.message : '';
  if (err.hint === 'blocked') return msg || "You can't interact with this person.";
  // Forever friends can't be blocked (supabase/migrations/20261117100000_forever_friends.sql).
  if (err.hint === 'forever_locked') return msg || "Forever friends can't be blocked.";
  if (err.hint === 'locked') return 'They only accept messages from people they follow. Follow them from their profile, then try again.';
  if (err.hint === 'song_shares_off') return "They only get songs from people they already chat with. Send them a message first.";
  if (err.hint === 'request' || err.hint === 'request_pending') return msg || 'Available once they accept your request.';
  // Outgoing request: only a few messages go out until they accept (enforced by RLS on messages).
  if (/row-level security/i.test(msg) && /"messages"/.test(msg)) return "Message not sent. If they haven't accepted your request yet, wait for them to accept it.";
  if (/row-level security/i.test(msg)) return "You can't do that with this person. One of you may have blocked the other.";
  if (/could not find the function|does not exist/i.test(msg)) return 'This feature needs the latest server update.';
  return msg || fallback;
}

const fail = (error: PgError | null) => {
  // Keeps the server hint (e.g. 'forever_locked') on the thrown Error for callers that branch on it.
  if (error) throw Object.assign(new Error(friendlySocialError(error)), { hint: error.hint });
};

/** Block someone. Also removes follows in both directions. Safe to call twice. */
export async function blockUser(id: string): Promise<void> {
  const { error } = await supabase.rpc('block_user', { target: id });
  fail(error);
}

export async function unblockUser(id: string): Promise<void> {
  const { error } = await supabase.rpc('unblock_user', { target: id });
  fail(error);
}

/** True when you and `id` have blocked each other in either direction. */
export async function isBlockedWith(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('blocked_with', { other: id });
  fail(error);
  return data === true;
}

/** People you blocked, newest first. */
export async function listBlocked(me: string): Promise<BlockedUser[]> {
  const { data, error } = await supabase
    .from('blocks')
    .select('created_at, blocked:profiles!blocks_blocked_id_fkey(id, display_name, avatar_url, username)')
    .eq('blocker_id', me)
    .order('created_at', { ascending: false });
  fail(error);
  type Row = { created_at: string; blocked: Omit<BlockedUser, 'blocked_at'> | Omit<BlockedUser, 'blocked_at'>[] | null };
  return ((data ?? []) as unknown as Row[]).flatMap((r) => {
    const p = Array.isArray(r.blocked) ? r.blocked[0] : r.blocked;
    return p ? [{ ...p, blocked_at: r.created_at }] : [];
  });
}

export async function countBlocked(me: string): Promise<number> {
  const { count, error } = await supabase.from('blocks').select('blocked_id', { count: 'exact', head: true }).eq('blocker_id', me);
  fail(error);
  return count ?? 0;
}

/* ================================================================== block UI helpers */

/** In-app confirmation dialog, resolved with the user's choice. */
export function confirmAction(title: string, message: string, action: string, destructive = true): Promise<boolean> {
  // In-app dialog (src/components/DialogHost.tsx); falls back to the native confirm only if no host is mounted.
  return confirmDialog(title, message, action, destructive);
}

export const confirmBlock = (name: string) =>
  confirmAction(
    `Block ${name}?`,
    "They won't be able to follow you, message you or send you dedications, and follows between you are removed. They won't be told.",
    'Block',
  );

export const confirmUnblock = (name: string) =>
  confirmAction(`Unblock ${name}?`, 'They will be able to follow you, message you and send you dedications again.', 'Unblock', false);

export type BlockControls = {
  /** Ids of people *you* blocked (people who blocked you are never revealed). */
  blocked: Set<string>;
  ready: boolean;
  /** Confirms, then blocks. Resolves true when blocked; throws a friendly Error on failure. */
  block: (id: string, name: string) => Promise<boolean>;
  /** Confirms, then unblocks. Resolves true when unblocked; throws a friendly Error on failure. */
  unblock: (id: string, name: string) => Promise<boolean>;
};

/** Your block list as a Set, plus confirm-and-block / unblock actions that keep it current. */
export function useBlocks(me: string | undefined): BlockControls {
  const [state, setState] = useState<{ me: string | undefined; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!me) return;
    let alive = true;
    listBlocked(me)
      .then((list) => alive && setState({ me, ids: new Set(list.map((b) => b.id)) }))
      .catch(() => alive && setState({ me, ids: new Set() }));
    return () => {
      alive = false;
    };
  }, [me]);

  const block = useCallback(async (id: string, name: string) => {
    // Forever friend: open the Block-locked sheet (Mute / Restrict / Archive / Pause Forever) instead.
    if (!(await guardBlock(id))) return false;
    if (!(await confirmBlock(name))) return false;
    await blockUser(id);
    setState((s) => ({ me: s?.me, ids: new Set(s?.ids ?? []).add(id) }));
    return true;
  }, []);

  const unblock = useCallback(async (id: string, name: string) => {
    if (!(await confirmUnblock(name))) return false;
    await unblockUser(id);
    setState((s) => {
      const ids = new Set(s?.ids ?? []);
      ids.delete(id);
      return { me: s?.me, ids };
    });
    return true;
  }, []);

  const current = state && state.me === me ? state : null;
  return { blocked: current?.ids ?? EMPTY, ready: !me || !!current, block, unblock };
}

const EMPTY: Set<string> = new Set();

/* ================================================================== family plan */

export const FAMILY_SEATS = 6;

export type FamilyMember = { id: string; display_name: string; avatar_url: string | null; joined_at: string; isOwner: boolean };
export type Family = { id: string; owner_id: string; invite_code: string | null; members: FamilyMember[] };
export type FamilyInvite = {
  owner_id: string;
  owner_name: string;
  owner_avatar: string | null;
  active: boolean;
  seats_used: number;
  seats_total: number;
  is_member: boolean;
};

/** Link that opens the join screen (`src/app/join-family.tsx`). */
export const familyInviteLink = (code: string) => `zoyra://join-family?code=${encodeURIComponent(code)}`;

/** Normalises a typed code: uppercase, letters/digits only. */
export const cleanInviteCode = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);

/** The family you own or belong to, with its members. Null when you're in none. */
export async function loadFamily(me: string): Promise<Family | null> {
  const mine = await supabase.from('family_members').select('group_id').eq('user_id', me).maybeSingle();
  fail(mine.error);
  const gid = (mine.data as { group_id: string } | null)?.group_id;
  if (!gid) return null;
  const [g, m] = await Promise.all([
    supabase.from('family_groups').select('id, owner_id, invite_code').eq('id', gid).single(),
    supabase
      .from('family_members')
      .select('joined_at, user:profiles!family_members_user_id_fkey(id, display_name, avatar_url)')
      .eq('group_id', gid)
      .order('joined_at'),
  ]);
  fail(g.error);
  fail(m.error);
  const group = g.data as { id: string; owner_id: string; invite_code: string };
  type Row = { joined_at: string; user: { id: string; display_name: string; avatar_url: string | null } | { id: string; display_name: string; avatar_url: string | null }[] | null };
  const members = ((m.data ?? []) as unknown as Row[])
    .flatMap((r) => {
      const u = Array.isArray(r.user) ? r.user[0] : r.user;
      return u ? [{ ...u, joined_at: r.joined_at, isOwner: u.id === group.owner_id }] : [];
    })
    .sort((a, b) => Number(b.isOwner) - Number(a.isOwner));
  return { id: group.id, owner_id: group.owner_id, invite_code: group.owner_id === me ? group.invite_code : null, members };
}

/** Owner: get the invite code (creates the family on first use). `rotate` makes a new code and kills the old one. */
export async function createFamilyInvite(rotate = false): Promise<string> {
  const { data, error } = await supabase.rpc('create_family_invite', { rotate });
  fail(error);
  if (typeof data !== 'string' || !data) throw new Error('Could not create an invite code');
  return data;
}

export async function familyInviteInfo(code: string): Promise<FamilyInvite | null> {
  const { data, error } = await supabase.rpc('family_invite_info', { code });
  fail(error);
  return (data as FamilyInvite | null) ?? null;
}

export async function joinFamily(code: string): Promise<void> {
  const { error } = await supabase.rpc('join_family', { code });
  fail(error);
}

export async function removeFamilyMember(id: string): Promise<void> {
  const { error } = await supabase.rpc('remove_family_member', { member: id });
  fail(error);
}

export async function leaveFamily(): Promise<void> {
  const { error } = await supabase.rpc('leave_family');
  fail(error);
}
