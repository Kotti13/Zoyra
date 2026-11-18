/**
 * Offline downloads.
 *
 * LEGAL: downloads are app-private caches for offline playback, not exported files. Audio and artwork
 * are written to the app's private document directory (`Paths.document/downloads`), are never
 * shared, exported or exposed to other apps or the user's file system, and are deleted when the
 * user removes them or uninstalls the app. Playback still goes through the Zoyra player only.
 *
 * Index of what's on disk lives in AsyncStorage (track snapshot, bytes, path, downloadedAt), so the
 * Downloads screen and the player work fully offline.
 *
 * This is a tiny external store (subscribe/getSnapshot) so the player can read it synchronously and
 * screens can render it with `useDownloads()` (see src/state/downloads.tsx).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { Directory, File, Paths } from 'expo-file-system';

import { catalog, type CatalogTrack } from './catalog';
import { isOnlineStable, subscribeOnline } from './connectivity';

export type DownloadEntry = {
  track: CatalogTrack;
  /** file:// URI of the audio file. */
  path: string;
  /** file:// URI of the artwork, when it could be saved. */
  artworkPath?: string;
  bytes: number;
  downloadedAt: string;
};

export type ActiveDownload = { trackId: string; title: string; bytesWritten: number; totalBytes: number; progress: number };

export type DownloadsSnapshot = {
  ready: boolean;
  entries: Record<string, DownloadEntry>;
  /** Newest first. */
  list: DownloadEntry[];
  active: Record<string, ActiveDownload>;
  /** Tracks waiting in the download queue (not started yet). */
  queued: string[];
  totalBytes: number;
  wifiOnly: boolean;
  online: boolean;
  connection: NetInfoState['type'] | 'unknown';
};

export type BatchResult = { done: number; skipped: number; failed: number; error?: string };

const INDEX_KEY = 'zoyra.downloads.index.v1';
/** Shared with the Data and storage screen's "Wi-Fi only downloads" toggle. */
const WIFI_KEY = 'zoyra.pref.wifiOnlyDownloads';
const DIR_NAME = 'downloads';

export class DownloadBlockedError extends Error {}

/* ------------------------------------------------------------------ store */

let state: DownloadsSnapshot = {
  ready: false,
  entries: {},
  list: [],
  active: {},
  queued: [],
  totalBytes: 0,
  wifiOnly: true,
  online: true,
  connection: 'unknown',
};
const listeners = new Set<() => void>();
const aborts = new Map<string, AbortController>();
let initPromise: Promise<void> | null = null;

function derive(entries: Record<string, DownloadEntry>) {
  const list = Object.values(entries).sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
  return { entries, list, totalBytes: list.reduce((n, e) => n + e.bytes, 0) };
}

function set(patch: Partial<DownloadsSnapshot>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function setEntries(entries: Record<string, DownloadEntry>) {
  set(derive(entries));
  AsyncStorage.setItem(INDEX_KEY, JSON.stringify(entries)).catch(() => undefined);
}

const onUnmeteredNetwork = (s: NetInfoState) => s.type === 'wifi' || s.type === 'ethernet';

function dir() {
  const d = new Directory(Paths.document, DIR_NAME);
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

function safeDelete(uri?: string) {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // already gone
  }
}

async function init() {
  // Connection type comes straight from NetInfo; online/offline from the debounced signal (no flicker).
  NetInfo.addEventListener((s) => set({ connection: s.type }));
  subscribeOnline((online) => set({ online }));
  try {
    const net = await NetInfo.fetch();
    set({ online: isOnlineStable(), connection: net.type });
  } catch {
    // keep defaults
  }
  let entries: Record<string, DownloadEntry> = {};
  let wifiOnly = true;
  try {
    const [rawIndex, rawWifi] = await Promise.all([AsyncStorage.getItem(INDEX_KEY), AsyncStorage.getItem(WIFI_KEY)]);
    if (rawIndex) entries = JSON.parse(rawIndex) as Record<string, DownloadEntry>;
    if (rawWifi != null) wifiOnly = JSON.parse(rawWifi) === true;
  } catch {
    entries = {};
  }
  // Drop index rows whose file vanished (OS cleanup, restore from backup, etc.).
  let changed = false;
  for (const [id, e] of Object.entries(entries)) {
    let ok = false;
    try {
      ok = new File(e.path).exists;
    } catch {
      ok = false;
    }
    if (!ok) {
      delete entries[id];
      changed = true;
    }
  }
  state = { ...state, ...derive(entries), wifiOnly, ready: true };
  listeners.forEach((l) => l());
  if (changed) AsyncStorage.setItem(INDEX_KEY, JSON.stringify(entries)).catch(() => undefined);
}

/* ------------------------------------------------------------------ public API */

export const downloads = {
  /** Loads the index from disk and starts watching connectivity. Safe to call many times. */
  init(): Promise<void> {
    if (!initPromise) initPromise = init();
    return initPromise;
  },
  /**
   * Re-check the index against disk (Downloads pull to refresh): drops rows whose file has vanished
   * (OS cleanup, a file manager…). Returns how many were dropped.
   */
  async rescan(): Promise<number> {
    if (!initPromise) initPromise = init();
    await initPromise;
    const entries = { ...state.entries };
    let dropped = 0;
    for (const [id, e] of Object.entries(entries)) {
      if (state.active[id]) continue;
      let ok = false;
      try {
        ok = new File(e.path).exists;
      } catch {
        ok = false;
      }
      if (!ok) {
        delete entries[id];
        dropped++;
      }
    }
    if (dropped) setEntries(entries);
    return dropped;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): DownloadsSnapshot {
    return state;
  },

  isOnline: () => state.online,
  isDownloaded: (trackId: string) => !!state.entries[trackId],
  /** Local file URI for playback, or null when the track isn't downloaded. */
  localUri: (trackId: string) => state.entries[trackId]?.path ?? null,
  localArtwork: (trackId: string) => state.entries[trackId]?.artworkPath ?? null,

  setWifiOnly(on: boolean) {
    set({ wifiOnly: on });
    AsyncStorage.setItem(WIFI_KEY, JSON.stringify(on)).catch(() => undefined);
  },

  /** Throws a DownloadBlockedError with a user-facing reason when downloading isn't allowed right now. */
  async assertCanDownload() {
    const net = await NetInfo.fetch();
    if (net.isConnected === false || !isOnlineStable()) throw new DownloadBlockedError('You are offline. Connect to the internet to download.');
    if (state.wifiOnly && !onUnmeteredNetwork(net)) throw new DownloadBlockedError('Wi-Fi only downloads is on. Connect to Wi-Fi or turn it off in Downloads.');
  },

  /** Downloads one track (audio + artwork). Resolves with the entry; no-op if already downloaded. */
  async downloadTrack(track: CatalogTrack, opts: { skipNetworkCheck?: boolean } = {}): Promise<DownloadEntry> {
    await downloads.init();
    const existing = state.entries[track.id];
    if (existing) return existing;
    if (state.active[track.id]) throw new DownloadBlockedError('Already downloading');
    if (!opts.skipNetworkCheck) await downloads.assertCanDownload();

    const controller = new AbortController();
    aborts.set(track.id, controller);
    set({ active: { ...state.active, [track.id]: { trackId: track.id, title: track.title, bytesWritten: 0, totalBytes: 0, progress: 0 } }, queued: state.queued.filter((q) => q !== track.id) });

    const folder = dir();
    const audio = new File(folder, `${track.id}.mp3`);
    try {
      const saved = await File.downloadFileAsync(catalog.downloadUrl(track.id), audio, {
        idempotent: true,
        signal: controller.signal,
        onProgress: ({ bytesWritten, totalBytes }) => {
          if (!state.active[track.id]) return;
          set({
            active: { ...state.active, [track.id]: { trackId: track.id, title: track.title, bytesWritten, totalBytes, progress: totalBytes > 0 ? Math.min(1, bytesWritten / totalBytes) : 0 } },
          });
        },
      });

      let artworkPath: string | undefined;
      const artUrl = track.artwork.large ?? track.artwork.medium ?? track.artwork.small;
      if (artUrl) {
        try {
          const art = await File.downloadFileAsync(artUrl, new File(folder, `${track.id}.jpg`), { idempotent: true, signal: controller.signal });
          artworkPath = art.uri;
        } catch {
          // Artwork is optional; the remote URL (or a placeholder) is used instead.
        }
      }

      const bytes = saved.size + (artworkPath ? new File(artworkPath).size : 0);
      const entry: DownloadEntry = { track, path: saved.uri, artworkPath, bytes, downloadedAt: new Date().toISOString() };
      setEntries({ ...state.entries, [track.id]: entry });
      return entry;
    } catch (e) {
      safeDelete(audio.uri);
      if (controller.signal.aborted) throw new DownloadBlockedError('Download cancelled');
      throw e instanceof Error ? e : new Error('Download failed');
    } finally {
      aborts.delete(track.id);
      const rest = { ...state.active };
      delete rest[track.id];
      set({ active: rest });
    }
  },

  /** Downloads a list one after another (playlist / album). Already-downloaded tracks are skipped. */
  async downloadMany(tracks: CatalogTrack[]): Promise<BatchResult> {
    await downloads.init();
    const todo = tracks.filter((t, i) => !state.entries[t.id] && !state.active[t.id] && tracks.findIndex((x) => x.id === t.id) === i);
    const skipped = tracks.length - todo.length;
    if (!todo.length) return { done: 0, skipped, failed: 0 };
    await downloads.assertCanDownload();
    set({ queued: [...state.queued, ...todo.map((t) => t.id).filter((id) => !state.queued.includes(id))] });
    let done = 0;
    let failed = 0;
    let error: string | undefined;
    for (const t of todo) {
      if (!state.queued.includes(t.id)) continue; // cancelled while waiting
      try {
        // Re-check between tracks so a drop to mobile data stops a Wi-Fi-only batch.
        await downloads.assertCanDownload();
        await downloads.downloadTrack(t, { skipNetworkCheck: true });
        done++;
      } catch (e) {
        if (e instanceof DownloadBlockedError && e.message !== 'Download cancelled' && e.message !== 'Already downloading') {
          error = e.message;
          set({ queued: state.queued.filter((id) => !todo.some((x) => x.id === id)) });
          break;
        }
        if (e instanceof DownloadBlockedError) continue; // cancelled / already running
        failed++;
        error = e instanceof Error ? e.message : 'Download failed';
      }
    }
    return { done, skipped, failed, error };
  },

  /** Cancels an in-flight or queued download. */
  cancel(trackId: string) {
    aborts.get(trackId)?.abort();
    set({ queued: state.queued.filter((id) => id !== trackId) });
  },

  remove(trackId: string) {
    downloads.removeMany([trackId]);
  },

  removeMany(trackIds: string[]) {
    const next = { ...state.entries };
    for (const id of trackIds) {
      downloads.cancel(id);
      const e = next[id];
      if (!e) continue;
      safeDelete(e.path);
      safeDelete(e.artworkPath);
      delete next[id];
    }
    setEntries(next);
  },

  /** Deletes every downloaded file and clears the index. */
  removeAll() {
    Object.keys(state.active).forEach((id) => aborts.get(id)?.abort());
    set({ queued: [] });
    try {
      const d = new Directory(Paths.document, DIR_NAME);
      if (d.exists) d.delete();
    } catch {
      // fall back to per-file deletes
      state.list.forEach((e) => {
        safeDelete(e.path);
        safeDelete(e.artworkPath);
      });
    }
    setEntries({});
  },

  /** Bytes actually on disk in the downloads folder (may differ slightly from the index). */
  diskBytes(): number {
    try {
      const d = new Directory(Paths.document, DIR_NAME);
      return d.exists ? (d.size ?? 0) : 0;
    } catch {
      return state.totalBytes;
    }
  },

  /** Bytes in the app's cache directory (artwork cache, temp files). */
  cacheBytes(): number {
    try {
      return Paths.cache.size ?? 0;
    } catch {
      return 0;
    }
  },
};

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
