/**
 * Instagram-style follow requests (supabase/migrations/20261124120000_follow_requests.sql).
 *
 *   follow a PUBLIC profile   -> 'following' right away
 *   follow a PRIVATE profile  -> 'requested' until the owner accepts (they then become a follower) or declines
 *
 * Requests live in `follow_requests`; `follows` only ever holds accepted follows.
 */
import { useCallback, useEffect, useState } from 'react';

import { supabase } from './supabase';

export type FollowOutcome = 'following' | 'requested';

export type FollowRequester = { id: string; display_name: string; username: string | null; avatar_url: string | null; created_at: string };

type PgError = { message?: string; hint?: string } | null;

const fail = (error: PgError) => {
  // Keep the server hint (e.g. 'blocked') on the thrown Error so friendlySocialError can read it.
  if (error) throw Object.assign(new Error(error.message || 'Something went wrong. Try again.'), { hint: error.hint });
};

/** Follow someone. A private profile turns this into a request. */
export async function followUser(target: string): Promise<FollowOutcome> {
  const { data, error } = await supabase.rpc('follow_user', { target });
  fail(error);
  return data === 'requested' ? 'requested' : 'following';
}

/** Take back a request I sent. */
export async function cancelFollowRequest(me: string, target: string): Promise<void> {
  const { error } = await supabase.from('follow_requests').delete().eq('requester_id', me).eq('target_id', target);
  fail(error);
}

/** People waiting for me to accept, newest first. */
export async function listFollowRequests(me: string): Promise<FollowRequester[]> {
  const { data, error } = await supabase
    .from('follow_requests')
    .select('created_at, requester:profiles!follow_requests_requester_id_fkey(id, display_name, username, avatar_url)')
    .eq('target_id', me)
    .order('created_at', { ascending: false })
    .limit(200);
  fail(error);
  const rows = (data ?? []) as unknown as { created_at: string; requester: Omit<FollowRequester, 'created_at'> | null }[];
  return rows.flatMap((r) => (r.requester ? [{ ...r.requester, created_at: r.created_at }] : []));
}

export async function acceptFollowRequest(requester: string): Promise<void> {
  const { error } = await supabase.rpc('accept_follow_request', { requester });
  fail(error);
}

export async function declineFollowRequest(requester: string): Promise<void> {
  const { error } = await supabase.rpc('decline_follow_request', { requester });
  fail(error);
}

/** Which of these people did I already send a request to? (For the Requested buttons in people lists.) */
export async function myPendingRequestIds(me: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { data, error } = await supabase.from('follow_requests').select('target_id').eq('requester_id', me).in('target_id', ids);
  if (error) return new Set();
  return new Set(((data ?? []) as { target_id: string }[]).map((r) => r.target_id));
}

/** How many follow requests are waiting for me (0 on a server without the migration). */
export function useFollowRequestCount(me: string | undefined): { count: number; reload: () => void } {
  const [count, setCount] = useState(0);
  const reload = useCallback(() => {
    if (!me) return;
    void supabase
      .from('follow_requests')
      .select('requester_id', { count: 'exact', head: true })
      .eq('target_id', me)
      .then(({ count: c, error }) => setCount(error ? 0 : (c ?? 0)));
  }, [me]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { count, reload };
}
