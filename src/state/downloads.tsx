import { router, useSegments } from 'expo-router';
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Toast } from '../components';
import type { CatalogTrack } from '../lib/catalog';
import { downloads, type DownloadsSnapshot } from '../lib/downloads';
import { showLocalNotification } from '../lib/push';
import { colors } from '../theme/tokens';
import { useAuth } from './auth';
import { usePlayerPick } from './player';
import { subscribeOnline } from '../lib/connectivity';

/** Live view of the offline downloads store (re-renders on progress, adds and removes). */
export function useDownloads(): DownloadsSnapshot {
  return useSyncExternalStore(downloads.subscribe, downloads.getSnapshot, downloads.getSnapshot);
}

/** Overall status of a list of tracks (album / playlist download button). */
export function useCollectionDownload(trackIds: string[]) {
  const s = useDownloads();
  const total = trackIds.length;
  const downloaded = trackIds.filter((id) => s.entries[id]).length;
  const inFlight = trackIds.filter((id) => s.active[id] || s.queued.includes(id));
  const activeProgress = inFlight.reduce((n, id) => n + (s.active[id]?.progress ?? 0), 0);
  return {
    total,
    downloaded,
    downloading: inFlight.length > 0,
    complete: total > 0 && downloaded === total,
    /** 0..1 across the whole list, counting partial progress of the running track. */
    progress: total > 0 ? Math.min(1, (downloaded + activeProgress) / total) : 0,
  };
}

/** Opens the offline sheet when a signed-in user loses connection. */
function OfflineWatcher() {
  const { session } = useAuth();
  const segments = useSegments();
  const route = segments[0] ?? '';
  const routeRef = useRef(route);
  useEffect(() => {
    routeRef.current = route;
  }, [route]);
  const wasOnline = useRef<boolean | null>(null);

  useEffect(() => {
    if (!session) return;
    // Stable signal: brief reachability blips on healthy Wi-Fi no longer open the offline sheet.
    const unsub = subscribeOnline((online) => {
      const prev = wasOnline.current;
      wasOnline.current = online;
      if (!online && prev !== false && routeRef.current !== 'offline' && routeRef.current !== 'downloads') router.push('/offline');
    });
    return unsub;
  }, [session]);
  return null;
}

/** Player notices (e.g. "skipped songs that aren't downloaded") shown over any screen. */
function PlayerNotice() {
  const { notice } = usePlayerPick('notice');
  const insets = useSafeAreaInsets();
  if (!notice) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 16, right: 16, top: insets.top + 8 }}>
      <Toast icon="wifiOff" iconColor={colors.amber} message={notice} />
    </View>
  );
}

/**
 * "N songs ready offline": a local notification (no server) when a batch of downloads finishes.
 * A batch starts when the queue goes from idle to busy and ends when it is idle again; only tracks
 * that landed during the batch count. Respects the "Downloads" toggle and the push master switch in
 * notification settings; `showLocalNotification` is a silent no-op on web, in Expo Go without the
 * native module, or without OS permission (it never prompts).
 */
function DownloadsReadyNotifier() {
  const { settings } = useAuth();
  const prefs = useRef<Record<string, boolean | string>>({});
  useEffect(() => {
    prefs.current = settings?.notifications ?? {};
  }, [settings]);

  useEffect(() => {
    let baseline: Set<string> | null = null;
    const check = () => {
      const s = downloads.getSnapshot();
      const busy = Object.keys(s.active).length > 0 || s.queued.length > 0;
      if (busy) {
        if (!baseline) baseline = new Set(Object.keys(s.entries));
        return;
      }
      if (!baseline) return;
      const before = baseline;
      baseline = null;
      const fresh = s.list.filter((e) => !before.has(e.track.id));
      if (!fresh.length) return;
      const p = prefs.current;
      if (p.push === false || p.downloads === false) return;
      const n = fresh.length;
      const first = fresh[fresh.length - 1]?.track.title ?? fresh[0].track.title;
      void showLocalNotification({
        title: `${n} ${n === 1 ? 'song' : 'songs'} ready offline`,
        body: n === 1 ? `${first} is downloaded` : `${first} and ${n - 1} more finished downloading`,
        data: { kind: 'downloads_ready', url: '/downloads' },
        group: 'downloads',
      });
    };
    check();
    return downloads.subscribe(check);
  }, []);
  return null;
}

/** Loads the downloads index, watches connectivity, and surfaces player notices. Mount inside PlayerProvider. */
export function DownloadsProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void downloads.init();
  }, []);
  return (
    <View style={{ flex: 1 }}>
      {children}
      <OfflineWatcher />
      <DownloadsReadyNotifier />
      <PlayerNotice />
    </View>
  );
}

/**
 * Download button behaviour for an album / playlist:
 * downloading → cancel, fully downloaded → remove, otherwise → download the rest.
 */
export function toggleCollectionDownload(tracks: CatalogTrack[], status: ReturnType<typeof useCollectionDownload>, show: (msg: string) => void) {
  if (!tracks.length) return show('Nothing to download yet');
  if (status.downloading) {
    tracks.forEach((t) => downloads.cancel(t.id));
    return show('Download cancelled');
  }
  if (status.complete) {
    downloads.removeMany(tracks.map((t) => t.id));
    return show(`Removed ${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'} from downloads`);
  }
  show(`Downloading ${tracks.length - status.downloaded} ${tracks.length - status.downloaded === 1 ? 'song' : 'songs'}…`);
  downloads
    .downloadMany(tracks)
    .then((r) => {
      if (r.error && r.done === 0) return show(r.error);
      const parts = [`Downloaded ${r.done} ${r.done === 1 ? 'song' : 'songs'}`];
      if (r.failed) parts.push(`${r.failed} failed`);
      show(r.error && r.failed === 0 ? `${parts.join(', ')} — stopped: ${r.error}` : parts.join(', '));
    })
    .catch((e: unknown) => show(e instanceof Error ? e.message : 'Download failed'));
}
