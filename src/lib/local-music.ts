/**
 * Local music library: the user's own audio files, played from the device.
 *
 * Two sources:
 * 1. Device scan (Android): expo-media-library's MediaStore query for `mediaType: 'audio'`, paged.
 *    iOS has no equivalent: PhotoKit (what expo-media-library wraps) holds photos and videos only, and
 *    the iOS Music library (MPMediaLibrary) is not exposed by any Expo module. So on iOS the scan is
 *    not offered and we say so.
 * 2. Imported files (iOS + Android): the user picks audio files with the system picker; we copy them
 *    into the app's private document folder so they keep working after the picker's temp copy is purged.
 *
 * Metadata: neither API exposes ID3 tags (artist/album/title). Title and artist are parsed from the
 * file name ("Artist - Title.mp3", "01. Title.mp3") and album/artist from the folder path
 * (".../Music/Artist/Album/01 Title.mp3"). Anything we can't infer is "Unknown artist" / "Unknown album".
 *
 * Every track is mapped to `CatalogTrack` with an id prefixed `local:` and no remote artwork/url, so
 * existing rows and the player work. The playable file URI lives in an in-memory registry
 * (`localMusic.uriFor(id)`) that the player must consult; see the lead/agent-B request in the report.
 *
 * Expo Go: the native module is probed with `requireOptionalNativeModule`, never imported statically.
 * Expo Go on Android can't be granted audio-library access (READ_MEDIA_AUDIO isn't in its manifest), so
 * we tell the user to use the development build.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { getDocumentAsync } from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import type * as MediaLibraryLegacy from 'expo-media-library/legacy';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import type { CatalogTrack } from './catalog';

type ML = typeof MediaLibraryLegacy;

/* ------------------------------------------------------------------ ids */

export const LOCAL_PREFIX = 'local:';
export const isLocalTrackId = (id: string | null | undefined): boolean => !!id && id.startsWith(LOCAL_PREFIX);
export const isLocalTrack = (t: Pick<CatalogTrack, 'id'> | null | undefined): boolean => isLocalTrackId(t?.id);

/* ------------------------------------------------------------------ types */

export type LocalSource = 'device' | 'imported';

export type LocalMeta = {
  uri: string;
  filename: string;
  folder: string;
  album: string;
  source: LocalSource;
  /** Bytes on disk (imported files only; MediaStore doesn't expose size through this API). */
  bytes?: number;
};

/** A CatalogTrack that carries its playable file URI (read by the player). */
export type LocalCatalogTrack = CatalogTrack & { localUri: string };

export type LocalTrack = { track: LocalCatalogTrack; meta: LocalMeta };

export type Availability =
  /** Device scan possible. */
  | { scan: true }
  /** No device scan; `reason` is user-facing copy. Import still works unless platform is web. */
  | { scan: false; reason: string; canImport: boolean };

export type PermissionState = {
  status: 'granted' | 'limited' | 'denied' | 'undetermined';
  canAskAgain: boolean;
};

export type GroupBy = 'songs' | 'artists' | 'albums' | 'folders';
export type Group = { key: string; title: string; subtitle: string; tracks: CatalogTrack[] };

export const UNKNOWN_ARTIST = 'Unknown artist';
export const UNKNOWN_ALBUM = 'Unknown album';
/** Ringtones, notification sounds and short voice notes are hidden. */
export const MIN_SECONDS = 20;

/* ------------------------------------------------------------------ native module (optional) */

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

let cachedML: ML | null | undefined;

function getML(): ML | null {
  if (cachedML !== undefined) return cachedML;
  cachedML = null;
  if (Platform.OS === 'android') {
    try {
      if (requireOptionalNativeModule('ExpoMediaLibrary')) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        cachedML = require('expo-media-library/legacy') as ML;
      }
    } catch {
      cachedML = null;
    }
  }
  return cachedML;
}

export const NEEDS_DEV_BUILD = 'Scanning your music needs the Zoyra development build. Expo Go can’t be given access to audio files.';

export function getAvailability(): Availability {
  if (Platform.OS === 'web') return { scan: false, reason: 'Local files aren’t available on the web.', canImport: false };
  if (Platform.OS === 'ios')
    return {
      scan: false,
      reason: 'iOS doesn’t let apps scan your music. Add songs from the Files app instead; they’re copied privately into Zoyra.',
      canImport: true,
    };
  if (!getML()) return { scan: false, reason: NEEDS_DEV_BUILD, canImport: true };
  return { scan: true };
}

/** Expo Go on Android can load the module but can't be granted READ_MEDIA_AUDIO. */
export const expoGoLimited = Platform.OS === 'android' && isExpoGo;

/* ------------------------------------------------------------------ permissions */

function toState(p: { granted: boolean; status: string; canAskAgain: boolean; accessPrivileges?: 'all' | 'limited' | 'none' }): PermissionState {
  if (p.accessPrivileges === 'limited') return { status: 'limited', canAskAgain: p.canAskAgain };
  if (p.granted) return { status: 'granted', canAskAgain: p.canAskAgain };
  return { status: p.status === 'undetermined' ? 'undetermined' : 'denied', canAskAgain: p.canAskAgain };
}

export async function getPermission(): Promise<PermissionState> {
  const ml = getML();
  if (!ml) return { status: 'denied', canAskAgain: false };
  return toState(await ml.getPermissionsAsync(false, ['audio']));
}

export async function requestPermission(): Promise<PermissionState> {
  const ml = getML();
  if (!ml) return { status: 'denied', canAskAgain: false };
  return toState(await ml.requestPermissionsAsync(false, ['audio']));
}

/* ------------------------------------------------------------------ metadata from names */

const GENERIC_DIRS = new Set(
  ['music', 'download', 'downloads', 'audio', 'audios', 'media', 'sounds', 'songs', 'mp3', 'recordings', 'documents', 'files', 'storage', 'emulated', '0', 'sdcard', 'local-music', 'Data'].map((s) => s.toLowerCase()),
);

const isGeneric = (dir: string | undefined) => !dir || GENERIC_DIRS.has(dir.toLowerCase());

function decode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const tidy = (s: string) => s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

/** "03 - Artist - Song (feat. X).mp3" → { artist: 'Artist', title: 'Song (feat. X)' } */
export function parseFilename(filename: string): { title: string; artist?: string } {
  let base = tidy(decode(filename).replace(/\.[a-z0-9]{1,5}$/i, ''));
  base = base.replace(/^(?:disc\s*\d+\s*)?\d{1,3}(?:\s*[-.)_]\s*|\s+)(?=\S)/i, ''); // leading track number
  const parts = base.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(' - ') };
  return { title: base || filename };
}

/**
 * Always hand the player a URI. expo-audio on Android treats a string with no scheme as the name of a
 * res/raw resource (AudioModule.kt `isRawResource`), and `file:/path` (one slash) is normalised too.
 */
export function toFileUri(uri: string): string {
  if (uri.startsWith('/')) return `file://${encodeURI(uri)}`;
  if (/^file:\/(?!\/)/i.test(uri)) return `file://${uri.slice('file:'.length)}`;
  return uri;
}

/** Parent folders of a file:// URI, nearest first. */
function foldersOf(uri: string): string[] {
  const path = decode(uri.replace(/^file:\/\//, '').split('?')[0]);
  const segs = path.split('/').filter(Boolean);
  segs.pop(); // file name
  return segs.reverse();
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';

function toTrack(id: string, filename: string, uri: string, duration: number, folderHint: string | undefined, source: LocalSource, bytes?: number): LocalTrack {
  const parsed = parseFilename(filename);
  const dirs = source === 'device' ? foldersOf(uri) : [];
  const folder = folderHint ?? dirs[0] ?? (source === 'imported' ? 'Imported' : 'Device');
  const album = !isGeneric(dirs[0]) ? tidy(dirs[0]) : UNKNOWN_ALBUM;
  // Artist/Album/track layout: the grandparent folder is the artist when the name doesn't say.
  const folderArtist = !isGeneric(dirs[0]) && !isGeneric(dirs[1]) ? tidy(dirs[1]) : undefined;
  const artistName = parsed.artist ?? folderArtist ?? UNKNOWN_ARTIST;
  // `localUri` rides on the track object: the player (state/player.tsx `deviceUri`) reads it to play
  // the file instead of streaming, so playback doesn't depend on this module's registry.
  uri = toFileUri(uri);
  const track: LocalCatalogTrack = {
    id,
    localUri: uri,
    title: parsed.title,
    artist: { id: `local-artist:${slug(artistName)}`, name: artistName, handle: '', verified: false },
    duration: Math.max(0, Math.round(duration)),
    artwork: {},
    plays: 0,
    likes: 0,
    tags: ['local'],
  };
  return { track, meta: { uri, filename, folder, album, source, bytes } };
}

/* ------------------------------------------------------------------ registry (id → playable URI) */

const registry = new Map<string, LocalMeta>();
const register = (items: LocalTrack[]) => items.forEach((l) => registry.set(l.track.id, l.meta));

/* ------------------------------------------------------------------ device scan */

export type ScanPage = { items: LocalTrack[]; endCursor: string; hasNextPage: boolean; totalCount: number; hiddenShort: number };

let albumTitles: Map<string, string> | null = null;

async function folderTitles(ml: ML) {
  if (albumTitles) return albumTitles;
  try {
    const albums = await ml.getAlbumsAsync();
    albumTitles = new Map(albums.map((a) => [a.id, a.title]));
  } catch {
    albumTitles = new Map();
  }
  return albumTitles;
}

export async function scanPage(after?: string, pageSize = 200): Promise<ScanPage> {
  const ml = getML();
  if (!ml) throw new Error(NEEDS_DEV_BUILD);
  const [page, titles] = await Promise.all([
    ml.getAssetsAsync({ mediaType: 'audio', first: pageSize, after, sortBy: [['modificationTime', false]] }),
    folderTitles(ml),
  ]);
  let hiddenShort = 0;
  const items: LocalTrack[] = [];
  for (const a of page.assets) {
    if (a.duration > 0 && a.duration < MIN_SECONDS) {
      hiddenShort++;
      continue;
    }
    items.push(toTrack(`${LOCAL_PREFIX}${a.id}`, a.filename, a.uri, a.duration, a.albumId ? titles.get(a.albumId) : undefined, 'device'));
  }
  register(items);
  return { items, endCursor: page.endCursor, hasNextPage: page.hasNextPage, totalCount: page.totalCount, hiddenShort };
}

/** Forget cached folder names (call on pull-to-refresh). */
export function resetScanCache() {
  albumTitles = null;
}

/* ------------------------------------------------------------------ imported files */

const IMPORT_KEY = 'zoyra.localMusic.imported.v1';
const IMPORT_DIR = 'local-music';

type ImportedEntry = { id: string; filename: string; name: string; bytes?: number; addedAt: number };

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.mp4', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav', '.amr', '.3gp', '.webm', '.mka', '.mid', '.midi']);
const MIME_EXT: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/aacp': '.aac',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/x-wav': '.wav',
  'audio/amr': '.amr',
  'audio/3gpp': '.3gp',
  'audio/webm': '.webm',
  'audio/x-matroska': '.mka',
  'audio/midi': '.mid',
};

/** Extension for the stored copy: the picked name's if it's audio, else from the MIME type, else none (ExoPlayer sniffs). */
function audioExt(name: string, mimeType: string | null | undefined, uri: string): string {
  const fromName = /\.[a-z0-9]{1,5}$/i.exec(name)?.[0]?.toLowerCase();
  if (fromName && AUDIO_EXTS.has(fromName)) return fromName;
  const fromMime = mimeType ? MIME_EXT[mimeType.toLowerCase().split(';')[0].trim()] : undefined;
  if (fromMime) return fromMime;
  const fromUri = /\.[a-z0-9]{1,5}$/i.exec(uri.split('?')[0])?.[0]?.toLowerCase();
  if (fromUri && AUDIO_EXTS.has(fromUri)) return fromUri;
  return fromName ?? '';
}

/** Size on disk, or 0 when missing/unreadable. */
function sizeOf(f: File): number {
  try {
    return f.exists ? f.size || 0 : 0;
  } catch {
    return 0;
  }
}

let imported: ImportedEntry[] = [];
let importedLoaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function importDir() {
  const d = new Directory(Paths.document, IMPORT_DIR);
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

const importedFile = (e: ImportedEntry) => new File(importDir(), e.filename);

function importedTracks(): LocalTrack[] {
  if (Platform.OS === 'web') return [];
  const out: LocalTrack[] = [];
  for (const e of imported) {
    const f = importedFile(e);
    if (!f.exists) continue;
    out.push(toTrack(e.id, e.name, toFileUri(f.uri), 0, 'Imported', 'imported', e.bytes));
  }
  register(out);
  return out;
}

const saveImported = () => AsyncStorage.setItem(IMPORT_KEY, JSON.stringify(imported)).catch(() => undefined);

/** Import failure with user-facing copy (native errors are not shown as-is). */
class ImportFailure extends Error {}

/**
 * Repair stored entries: older builds could save a full URI (or a bare path) instead of a file name, and
 * a failed copy could leave a zero-byte file. Entries whose file is missing or empty are dropped (the
 * empty file is deleted) so they don't sit in the list and hang the player at 0:00.
 */
function repairImported(list: unknown[]): { entries: ImportedEntry[]; changed: boolean } {
  let changed = false;
  const entries: ImportedEntry[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') {
      changed = true;
      continue;
    }
    const e = { ...(raw as Partial<ImportedEntry> & { uri?: string }) };
    if (typeof e.id !== 'string' || !e.id.startsWith(LOCAL_PREFIX) || seen.has(e.id)) {
      changed = true;
      continue;
    }
    // A URI / path where a file name belongs: keep only the last path segment (files live in importDir()).
    const source = typeof e.filename === 'string' && e.filename ? e.filename : typeof e.uri === 'string' ? e.uri : '';
    const filename = decode(source.split('?')[0].split('/').filter(Boolean).pop() ?? '');
    if (!filename) {
      changed = true;
      continue;
    }
    if (filename !== e.filename || 'uri' in e) changed = true;
    const entry: ImportedEntry = {
      id: e.id,
      filename,
      name: typeof e.name === 'string' && e.name ? e.name : filename,
      bytes: e.bytes,
      addedAt: typeof e.addedAt === 'number' ? e.addedAt : Date.now(),
    };
    if (Platform.OS !== 'web') {
      try {
        const f = importedFile(entry);
        const bytes = sizeOf(f);
        if (bytes <= 0) {
          if (f.exists) f.delete();
          changed = true;
          continue;
        }
        if (entry.bytes !== bytes) {
          entry.bytes = bytes;
          changed = true;
        }
      } catch {
        // Can't inspect storage right now: keep the entry, importedTracks() skips it if absent.
      }
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  return { entries, changed };
}

async function loadImported() {
  if (importedLoaded) return;
  let changed = false;
  try {
    const raw = await AsyncStorage.getItem(IMPORT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const repaired = repairImported(Array.isArray(parsed) ? parsed : []);
    imported = repaired.entries;
    changed = repaired.changed || !Array.isArray(parsed);
  } catch {
    imported = [];
  }
  importedLoaded = true;
  if (changed) await saveImported();
}


export type ImportResult = { added: number; failed: number; cancelled?: boolean; /** First failure, user-facing. */ reason?: string };

/** Pick audio files and copy them into Zoyra's private storage. */
export async function importFiles(): Promise<ImportResult> {
  if (Platform.OS === 'web') throw new Error('Local files aren’t available on the web.');
  await loadImported();
  const res = await getDocumentAsync({ type: 'audio/*', multiple: true, copyToCacheDirectory: true });
  if (res.canceled) return { added: 0, failed: 0, cancelled: true };
  let added = 0;
  let failed = 0;
  let reason: string | undefined;
  const dir = importDir();
  for (const a of res.assets) {
    let dest: File | null = null;
    try {
      const ext = audioExt(a.name, a.mimeType, a.uri);
      const id = `${LOCAL_PREFIX}imp:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const filename = `${id.slice(LOCAL_PREFIX.length).replace(/[^a-z0-9]/gi, '_')}${ext}`;
      const src = new File(toFileUri(a.uri));
      if (src.exists && sizeOf(src) <= 0) throw new ImportFailure(`“${a.name}” is empty.`);
      dest = new File(dir, filename);
      await src.copy(dest); // async on Android (IO dispatcher); rejects if the destination exists
      // Verify with a fresh handle: the copy must exist and have content, or it would play as silence.
      const bytes = sizeOf(new File(dir, filename));
      if (bytes <= 0) throw new ImportFailure(`“${a.name}” didn’t copy completely.`);
      try {
        src.delete(); // picker's temporary cache copy
      } catch {
        // cache will be purged by the OS anyway
      }
      imported.push({ id, filename, name: a.name, bytes, addedAt: Date.now() });
      added++;
    } catch (e) {
      failed++;
      reason ??= e instanceof ImportFailure ? e.message : `Couldn’t copy “${a.name}” into Zoyra.`;
      try {
        if (dest?.exists) dest.delete(); // don't leave a partial/empty copy behind
      } catch {
        // nothing to clean up
      }
    }
  }
  await saveImported();
  emit();
  return { added, failed, reason };
}

export async function removeImported(id: string) {
  await loadImported();
  const e = imported.find((x) => x.id === id);
  if (!e) return;
  try {
    const f = importedFile(e);
    if (f.exists) f.delete();
  } catch {
    // already gone
  }
  imported = imported.filter((x) => x.id !== id);
  registry.delete(id);
  await saveImported();
  emit();
}

export async function getImported(): Promise<LocalTrack[]> {
  await loadImported();
  return importedTracks();
}

/** Re-renders when imported files change; returns them. */
export function useImported() {
  const [items, setItems] = useState<LocalTrack[] | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => void getImported().then((l) => alive && setItems(l));
    refresh();
    listeners.add(refresh);
    return () => {
      alive = false;
      listeners.delete(refresh);
    };
  }, []);
  return items;
}

/* ------------------------------------------------------------------ grouping + search */

export function filterTracks(items: LocalTrack[], query: string): LocalTrack[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(({ track, meta }) => [track.title, track.artist.name, meta.album, meta.folder, meta.filename].some((s) => s.toLowerCase().includes(q)));
}

export function groupTracks(items: LocalTrack[], by: Exclude<GroupBy, 'songs'>): Group[] {
  const map = new Map<string, Group>();
  for (const { track, meta } of items) {
    const title = by === 'artists' ? track.artist.name : by === 'albums' ? meta.album : meta.folder;
    const key = by === 'albums' ? `${title}\u0000${meta.folder}` : title;
    let g = map.get(key);
    if (!g) {
      g = { key, title, subtitle: '', tracks: [] };
      map.set(key, g);
    }
    g.tracks.push(track);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    const n = `${g.tracks.length} ${g.tracks.length === 1 ? 'song' : 'songs'}`;
    if (by === 'albums') {
      const artists = new Set(g.tracks.map((t) => t.artist.name));
      g.subtitle = `${artists.size === 1 ? [...artists][0] : 'Various artists'} · ${n}`;
    } else g.subtitle = n;
  }
  const unknown = (t: string) => t === UNKNOWN_ARTIST || t === UNKNOWN_ALBUM;
  return groups.sort((a, b) => Number(unknown(a.title)) - Number(unknown(b.title)) || a.title.localeCompare(b.title));
}

/* ------------------------------------------------------------------ public API for the player and screens */

export const localMusic = {
  isLocalTrackId,
  isLocalTrack,
  /** Playable file URI for a `local:` track that has been scanned or imported this session. */
  uriFor: (id: string): string | null => {
    const uri = registry.get(id)?.uri;
    return uri ? toFileUri(uri) : null;
  },
  metaFor: (id: string): LocalMeta | null => registry.get(id) ?? null,
};
