import type { CatalogTrack } from './catalog';
import { supabase } from './supabase';

/**
 * Nearby share: a short-lived code (10 minutes) for a song, shown as a QR code to someone next to you.
 * No Bluetooth / location is used: the Expo stack has no radio-discovery module, so the code is the handshake
 * (migration 20261118130000_gift_kids_nearby.sql: create / claim / end_nearby_share).
 */

export type NearbyItem = { id: string; title: string; subtitle: string; art: string };
export type NearbyKind = 'track' | 'playlist';
export type NearbyShare = { code: string; expires_at: string };
export type NearbyClaim = { kind: NearbyKind; item: NearbyItem; owner_id: string; owner_name: string | null; expires_at: string };

export const CODE_LENGTH = 6;
export const cleanNearbyCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
export const nearbyLink = (code: string) => `zoyra://nearby-share?code=${code}`;

function nearbyError(e: unknown, fallback: string): Error {
  const x = e as { message?: unknown } | null;
  const msg = typeof x?.message === 'string' ? x.message : '';
  if (/nearby_shares|create_nearby_share|claim_nearby_share/.test(msg) && /does not exist|schema cache|Could not find/i.test(msg)) return new Error('Nearby share isn’t set up on the server yet.');
  return new Error(msg || fallback);
}

export async function createNearbyShare(track: CatalogTrack): Promise<NearbyShare> {
  const { data, error } = await supabase.rpc('create_nearby_share', {
    p_kind: 'track',
    p_item: { id: track.id, title: track.title, subtitle: track.artist.name, art: track.artwork.small ?? track.artwork.medium ?? '' },
  });
  if (error) throw nearbyError(error, 'Could not make a code');
  return data as NearbyShare;
}

export async function claimNearbyShare(code: string): Promise<NearbyClaim> {
  const { data, error } = await supabase.rpc('claim_nearby_share', { p_code: cleanNearbyCode(code) });
  if (error) throw nearbyError(error, 'Could not use that code');
  return data as NearbyClaim;
}

export async function endNearbyShare(code: string): Promise<void> {
  await supabase.rpc('end_nearby_share', { p_code: code });
}

/** Where a claimed item opens in the app. */
export const nearbyRoute = (c: NearbyClaim) => (c.kind === 'playlist' ? `/playlist?id=${encodeURIComponent(c.item.id)}` : `/track-detail?id=${encodeURIComponent(c.item.id)}`);
