import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import { AuthRequest, ResponseType, exchangeCodeAsync, makeRedirectUri, refreshAsync, type DiscoveryDocument } from 'expo-auth-session';

import { catalog, type CatalogTrack } from './catalog';

/** Spotify import: PKCE auth (no client secret), playlist reading, and catalogue matching. */

const CLIENT_ID = process.env.EXPO_PUBLIC_SPOTIFY_CLIENT_ID ?? '';
const SCOPES = ['playlist-read-private', 'user-library-read'];
const TOKEN_KEY = 'zoyra.spotify.token';
const API = 'https://api.spotify.com/v1';

const discovery: DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
};

export const SPOTIFY_SETUP_MESSAGE = 'Spotify import needs Spotify app setup (EXPO_PUBLIC_SPOTIFY_CLIENT_ID).';
export const spotifyConfigured = () => CLIENT_ID.length > 0;
/** Must be registered exactly as a Redirect URI in the Spotify developer dashboard. */
export const spotifyRedirectUri = () =>
  'http://127.0.0.1:8082/spotify-callback';

export type SpotifyToken = { accessToken: string; refreshToken?: string; expiresAt: number; displayName?: string };

export class SpotifyNotConfiguredError extends Error {
  constructor() {
    super(SPOTIFY_SETUP_MESSAGE);
    this.name = 'SpotifyNotConfiguredError';
  }
}

/* ------------------------------------------------------------------ token storage */

let cached: SpotifyToken | null | undefined;

async function saveToken(t: SpotifyToken | null) {
  cached = t;
  try {
    if (t) await AsyncStorage.setItem(TOKEN_KEY, JSON.stringify(t));
    else await AsyncStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage failure only costs a re-login next launch.
  }
}

export async function getStoredToken(): Promise<SpotifyToken | null> {
  if (cached !== undefined) return cached;
  try {
    const raw = await AsyncStorage.getItem(TOKEN_KEY);
    cached = raw ? (JSON.parse(raw) as SpotifyToken) : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** A non-expired access token, refreshing it when needed. Null when not connected. */
async function accessToken(): Promise<string | null> {
  const t = await getStoredToken();
  if (!t) return null;
  if (Date.now() < t.expiresAt - 60_000) return t.accessToken;
  if (!t.refreshToken || !CLIENT_ID) {
    await saveToken(null);
    return null;
  }
  try {
    const r = await refreshAsync({ clientId: CLIENT_ID, refreshToken: t.refreshToken }, discovery);
    const next: SpotifyToken = {
      accessToken: r.accessToken,
      refreshToken: r.refreshToken ?? t.refreshToken,
      expiresAt: Date.now() + (r.expiresIn ?? 3600) * 1000,
      displayName: t.displayName,
    };
    await saveToken(next);
    return next.accessToken;
  } catch {
    await saveToken(null);
    return null;
  }
}

/* ------------------------------------------------------------------ auth */

/** Opens Spotify's consent page. Resolves null if the user backed out. */
export async function connectSpotify(): Promise<SpotifyToken | null> {
  if (!CLIENT_ID) throw new SpotifyNotConfiguredError();
  const redirectUri = spotifyRedirectUri();
  const request = new AuthRequest({ clientId: CLIENT_ID, scopes: SCOPES, redirectUri, responseType: ResponseType.Code, usePKCE: true });
  const result = await request.promptAsync(discovery);
  if (result.type !== 'success') {
    if (result.type === 'error') {
      const msg = result.params.error_description || result.params.error || result.error?.message || 'Spotify sign-in failed';
      if (/redirect/i.test(msg)) throw new Error(`Spotify rejected the redirect. Add ${redirectUri} to your Spotify app's Redirect URIs.`);
      throw new Error(msg);
    }
    return null;
  }
  const code = result.params.code;
  if (!code) throw new Error('Spotify did not return an authorization code');
  const tok = await exchangeCodeAsync(
    { clientId: CLIENT_ID, code, redirectUri, extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : undefined },
    discovery,
  );
  const token: SpotifyToken = { accessToken: tok.accessToken, refreshToken: tok.refreshToken, expiresAt: Date.now() + (tok.expiresIn ?? 3600) * 1000 };
  await saveToken(token);
  try {
    const me = await api<{ display_name?: string | null; id: string }>('/me');
    token.displayName = me.display_name || me.id;
    await saveToken(token);
  } catch {
    // Name is cosmetic.
  }
  return token;
}

export const disconnectSpotify = () => saveToken(null);

/* ------------------------------------------------------------------ hook (linked-account rows) */

export type SpotifyLink = {
  /** undefined = checking, null = not connected, string = connected account name. */
  account: string | null | undefined;
  busy: boolean;
  configured: boolean;
  /** Resolves with a user-facing message (success, cancel is silent → null, or the error). */
  connect: () => Promise<{ ok: boolean; message: string } | null>;
  disconnect: () => Promise<void>;
};

/** Shared state + actions for every "Spotify: Connect / Disconnect" row. */
export function useSpotifyLink(): SpotifyLink {
  const [account, setAccount] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getStoredToken()
      .then((t) => alive && setAccount(t ? (t.displayName ?? 'Spotify') : null))
      .catch(() => alive && setAccount(null));
    return () => {
      alive = false;
    };
  }, []);

  const connect = useCallback(async () => {
    if (!spotifyConfigured()) return { ok: false, message: SPOTIFY_SETUP_MESSAGE };
    setBusy(true);
    try {
      const t = await connectSpotify();
      if (!t) return null;
      setAccount(t.displayName ?? 'Spotify');
      return { ok: true, message: 'Spotify connected. Open Import to bring playlists over.' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Could not connect Spotify' };
    } finally {
      setBusy(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      await disconnectSpotify();
      setAccount(null);
    } finally {
      setBusy(false);
    }
  }, []);

  return { account, busy, configured: spotifyConfigured(), connect, disconnect };
}

/* ------------------------------------------------------------------ Web API */

async function api<T>(path: string): Promise<T> {
  const token = await accessToken();
  if (!token) throw new Error('Spotify session expired. Connect again.');
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    await saveToken(null);
    throw new Error('Spotify session expired. Connect again.');
  }
  if (res.status === 403) throw new Error('Spotify refused access. In development mode, add this Spotify account under your app\'s "Users and Access".');
  if (res.status === 429) throw new Error('Spotify is rate limiting requests. Try again in a minute.');
  if (!res.ok) throw Object.assign(new Error(`Spotify error ${res.status}`), { status: res.status });
  return (await res.json()) as T;
}

type Paged<T> = { items: T[]; next: string | null; total: number };
type RawPlaylist = { id: string; name: string; images?: { url: string }[] | null; tracks?: { total: number } | null; items?: { total: number } | null };
type RawTrack = { id: string | null; name: string; type?: string; duration_ms: number; artists: { name: string }[]; is_local?: boolean };
type RawItem = { track?: RawTrack | null; item?: RawTrack | null };

export type SpotifyPlaylist = { id: string; name: string; image?: string; total: number };
export type SpotifyTrack = { title: string; artists: string[]; durationSec: number };

/** Pseudo playlist id for the user's Liked Songs. */
export const LIKED_SONGS_ID = '__liked__';

export async function listPlaylists(): Promise<SpotifyPlaylist[]> {
  const out: SpotifyPlaylist[] = [];
  let url: string | null = '/me/playlists?limit=50';
  while (url && out.length < 500) {
    const page: Paged<RawPlaylist | null> = await api<Paged<RawPlaylist | null>>(url);
    for (const p of page.items) {
      if (!p) continue;
      out.push({ id: p.id, name: p.name, image: p.images?.[0]?.url, total: p.tracks?.total ?? p.items?.total ?? 0 });
    }
    url = page.next;
  }
  try {
    const liked = await api<Paged<RawItem>>('/me/tracks?limit=1');
    if (liked.total > 0) out.unshift({ id: LIKED_SONGS_ID, name: 'Liked Songs', total: liked.total });
  } catch {
    // Liked Songs is optional.
  }
  return out;
}

const toTrack = (r: RawItem): SpotifyTrack | null => {
  const t = r.track ?? r.item;
  if (!t || (t.type && t.type !== 'track') || !t.name) return null;
  return { title: t.name, artists: t.artists.map((a) => a.name), durationSec: Math.round(t.duration_ms / 1000) };
};

async function pagedTracks(first: string, max: number): Promise<SpotifyTrack[]> {
  const out: SpotifyTrack[] = [];
  let url: string | null = first;
  while (url && out.length < max) {
    const page: Paged<RawItem> = await api<Paged<RawItem>>(url);
    for (const it of page.items) {
      const t = toTrack(it);
      if (t) out.push(t);
    }
    url = page.next;
  }
  return out.slice(0, max);
}

/** Tracks of a playlist (or Liked Songs), capped at `max`. */
export async function playlistTracks(id: string, max = 500): Promise<SpotifyTrack[]> {
  if (id === LIKED_SONGS_ID) return pagedTracks('/me/tracks?limit=50', max);
  try {
    // Newer Web API path; older apps still serve /tracks.
    return await pagedTracks(`/playlists/${id}/items?limit=50`, max);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return pagedTracks(`/playlists/${id}/tracks?limit=50`, max);
    throw e;
  }
}

/* ------------------------------------------------------------------ matching */

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*[([].*?(feat|ft\.|with|remaster|version|edit|live|mono|stereo|deluxe).*?[)\]]/g, '')
    .replace(/\s+-\s+.*(remaster|version|edit|live|mix).*$/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Dice coefficient over character bigrams, 0..1. */
function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      hit++;
    }
  }
  return (2 * hit) / (x.length - 1 + y.length - 1);
}

export const MATCH_THRESHOLD = 0.72;

/** Weighted score: title 55 %, artist 30 %, duration within ±5 s 15 %. */
export function matchScore(src: SpotifyTrack, cand: CatalogTrack): number {
  const title = similarity(src.title, cand.title);
  const artist = Math.max(0, ...src.artists.map((a) => Math.max(similarity(a, cand.artist.name), similarity(a, cand.artist.handle))));
  const durOk = Math.abs(src.durationSec - cand.duration) <= 5 ? 1 : 0;
  return title * 0.55 + artist * 0.3 + durOk * 0.15;
}

export async function findMatch(src: SpotifyTrack): Promise<CatalogTrack | null> {
  const results = await catalog.searchTracks(`${normalize(src.title)} ${src.artists[0] ?? ''}`.trim(), { limit: 10 });
  let best: CatalogTrack | null = null;
  let bestScore = 0;
  for (const c of results) {
    const s = matchScore(src, c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null;
}

/** Match every track (4 at a time). `onProgress(done, total)`; stop early when `cancelled()` returns true. */
export async function matchTracks(tracks: SpotifyTrack[], onProgress: (done: number, total: number) => void, cancelled: () => boolean = () => false): Promise<CatalogTrack[]> {
  const found: (CatalogTrack | null)[] = new Array(tracks.length).fill(null);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < tracks.length && !cancelled()) {
      const i = next++;
      try {
        found[i] = await findMatch(tracks[i]);
      } catch {
        found[i] = null; // One failed lookup shouldn't sink the import.
      }
      done++;
      onProgress(done, tracks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, tracks.length) }, worker));
  const seen = new Set<string>();
  return found.filter((t): t is CatalogTrack => !!t && !seen.has(t.id) && (seen.add(t.id), true));
}
