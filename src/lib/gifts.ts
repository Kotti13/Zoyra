import { useEffect } from 'react';

import { useAuth } from '../state/auth';
import { scheduleMessage, sendMessage } from './chat';
import type { CatalogTrack } from './catalog';
import type { DmContact } from './dm';
import { startChat } from './dm';
import { supabase } from './supabase';

/**
 * Gift Premium (screen: gift-premium). A gift is a code created by the billing backend after a store purchase
 * (migration 20261118130000_gift_kids_nearby.sql). The buyer sends the code in a chat message; the recipient
 * redeems it (Plans → Redeem a gift, or the zoyra://gift-premium?code= link in the message).
 */

export type Gift = {
  id: string;
  code: string;
  months: 1 | 3 | 12;
  recipient_id: string | null;
  note: string | null;
  track: { id: string; title: string; artist: string } | null;
  deliver_at: string | null;
  sent_at: string | null;
  redeemed_by: string | null;
  redeemed_at: string | null;
  created_at: string;
};

const COLS = 'id, code, months, recipient_id, note, track, deliver_at, sent_at, redeemed_by, redeemed_at, created_at';

export const monthsLabel = (m: number) => (m === 12 ? '12 months' : m === 1 ? '1 month' : `${m} months`);
export const formatCode = (c: string) => c.replace(/(.{4})(?=.)/g, '$1-');
export const cleanCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Server hints → plain words. */
export function giftError(e: unknown, fallback: string): string {
  const x = e as { message?: unknown; hint?: unknown } | null;
  const hint = typeof x?.hint === 'string' ? x.hint : '';
  const msg = typeof x?.message === 'string' ? x.message : '';
  if (/gift_codes|redeem_gift|sync_gift|gift_set_details/.test(msg) && /does not exist|schema cache|Could not find/i.test(msg)) return 'Gifts aren’t set up on the server yet.';
  if (hint === 'rate_limited' || hint === 'invalid' || hint === 'redeemed' || hint === 'not_for_you' || hint === 'not_yet' || hint === 'already_subscribed' || hint === 'blocked') return msg || fallback;
  return msg || fallback;
}

/** Gifts I bought, newest first. */
export async function listMyGifts(me: string): Promise<Gift[]> {
  const { data, error } = await supabase.from('gift_codes').select(COLS).eq('buyer_id', me).order('created_at', { ascending: false }).limit(40);
  if (error) throw new Error(giftError(error, 'Could not load your gifts'));
  return (data ?? []) as Gift[];
}

/** Waits (≤ timeoutMs) for the webhook to create a gift row that wasn't there before the purchase. */
export async function waitForNewGift(me: string, known: Set<string>, timeoutMs = 20_000): Promise<Gift | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const fresh = (await listMyGifts(me).catch(() => [])).find((g) => !known.has(g.id));
    if (fresh) return fresh;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

export type RedeemResult = { months: number; until: string };

export async function redeemGift(code: string): Promise<RedeemResult> {
  const { data, error } = await supabase.rpc('redeem_gift', { p_code: cleanCode(code) });
  if (error) throw new Error(giftError(error, 'Could not redeem that code'));
  return data as RedeemResult;
}

/** Drops a finished gifted period back to free. Silent: runs at start-up. */
export async function syncGiftPlan(): Promise<string | null> {
  const { data, error } = await supabase.rpc('sync_gift_plan');
  return error ? null : ((data as string | null) ?? null);
}

/** Runs `sync_gift_plan` once per sign-in and refreshes the profile if the plan changed. */
export function useGiftSync() {
  const { user, profile, refresh } = useAuth();
  const uid = user?.id;
  const plan = profile?.plan;
  useEffect(() => {
    if (!uid) return;
    void syncGiftPlan().then((p) => {
      if (p && plan && p !== plan) void refresh().catch(() => undefined);
    });
    // once per account
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);
}

export type SendGiftInput = { gift: Gift; to: DmContact; fromName: string; note: string; track: CatalogTrack | null; deliverAt: Date | null };

export function giftMessageText({ gift, fromName, note, track }: { gift: Gift; fromName: string; note: string; track: CatalogTrack | null }): string {
  const lines = [`🎁 ${fromName} gave you ${monthsLabel(gift.months)} of Zoyra Premium!`];
  if (note.trim()) lines.push(`“${note.trim()}”`);
  if (track) lines.push(`🎵 ${track.title} · ${track.artist.name}`);
  lines.push(`Redeem it in Zoyra: Plans → Redeem a gift → ${formatCode(gift.code)}`);
  lines.push(`or open zoyra://gift-premium?code=${gift.code}`);
  return lines.join('\n');
}

/** Sends (or schedules) the gift message, then records recipient / note / song / time on the gift. */
export async function sendGift(me: string, i: SendGiftInput): Promise<'sent' | 'scheduled'> {
  const body = giftMessageText({ gift: i.gift, fromName: i.fromName, note: i.note, track: i.track });
  const chat = await startChat(i.to.id);
  const later = !!i.deliverAt && i.deliverAt.getTime() > Date.now() + 60_000;
  if (later) await scheduleMessage(chat.id, me, body, i.deliverAt as Date);
  else await sendMessage(chat.id, me, { body, kind: 'text' });
  const { error } = await supabase.rpc('gift_set_details', {
    p_gift: i.gift.id,
    p_recipient: i.to.id,
    p_note: i.note,
    p_track: i.track ? { id: i.track.id, title: i.track.title, artist: i.track.artist.name } : null,
    p_deliver_at: later ? (i.deliverAt as Date).toISOString() : null,
  });
  if (error) throw new Error(giftError(error, 'The message went out but the gift could not be updated'));
  return later ? 'scheduled' : 'sent';
}
