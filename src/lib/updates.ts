/**
 * In-app update check against the public `app_config` table (one row per platform).
 * The lead can call `checkForUpdate()` at launch and open `/update` when `status === 'required'`.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { supabase } from './supabase';

export type UpdateStatus = 'up_to_date' | 'available' | 'required';
export type UpdateInfo = {
  status: UpdateStatus;
  installed: string;
  latest: string;
  minimum: string;
  storeUrl: string | null;
  notes: string[];
};

type ConfigRow = { latest_version: string; min_version: string; store_url: string | null; notes: string[] | null };

/** The version baked into this build (app.json `version`). */
export const installedVersion = () => Constants.expoConfig?.version ?? '0.0.0';

/** Compare dotted numeric versions: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Throws on network / database errors. Resolves `null` when no config row exists for this platform
 * (e.g. web), which callers should treat as "nothing to update".
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const { data, error } = await supabase
    .from('app_config')
    .select('latest_version, min_version, store_url, notes')
    .eq('platform', Platform.OS)
    .maybeSingle<ConfigRow>();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const installed = installedVersion();
  const status: UpdateStatus =
    compareVersions(installed, data.min_version) < 0 ? 'required' : compareVersions(installed, data.latest_version) < 0 ? 'available' : 'up_to_date';
  return { status, installed, latest: data.latest_version, minimum: data.min_version, storeUrl: data.store_url, notes: data.notes ?? [] };
}
