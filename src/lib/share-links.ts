/**
 * Public https share links (rich preview cards in WhatsApp / iMessage / X …).
 *
 * Links look like `https://<SHARE_HOST>/t/<trackId>`. The web project in `web/share/` renders an
 * Open Graph card + landing page for them, and iOS Universal Links / Android App Links open the app
 * directly when it is installed (see `src/app/+native-intent.tsx`).
 *
 * The host is configured in ONE place: `EXPO_PUBLIC_SHARE_HOST` (.env / EAS env). app.config.js reads
 * the same variable for `associatedDomains` + `intentFilters`, so changing it needs a new native build.
 *
 * This module stays dependency-light (no UI imports) because the native intent handler imports it.
 */
import Constants from 'expo-constants';
import { Platform, Share } from 'react-native';

const DEFAULT_SHARE_HOST = 'https://share.zoyra.site';

function normalizeHost(raw: string | undefined | null): string {
  const v = (raw ?? '').trim().replace(/\/+$/, '');
  if (!v) return DEFAULT_SHARE_HOST;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

const extraHost = (Constants.expoConfig?.extra as { shareHost?: unknown } | undefined)?.shareHost;

/** e.g. `https://share.zoyra.site` (no trailing slash). */
export const SHARE_HOST = normalizeHost(process.env.EXPO_PUBLIC_SHARE_HOST || (typeof extraHost === 'string' ? extraHost : undefined));

/** Bare hostname, e.g. `share.zoyra.site`. */
export const SHARE_HOSTNAME = SHARE_HOST.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids that exist only on this device (local files) or come from sources with no share page. */
const notShareable = (id: string) => !id || id.includes(':');

const link = (prefix: string, id: string) => `${SHARE_HOST}/${prefix}/${encodeURIComponent(id)}`;

type TrackRef = { id: string; url?: string };

/** Song link. `null` for songs from this device (they have no public page). */
export function trackShareUrl(track: TrackRef): string | null {
  if (notShareable(track.id)) return track.id.startsWith('local') ? null : track.url ?? null;
  return link('t', track.id);
}

/** Lyric card link: same song, framed as a lyric card (lyric text itself is not put in the URL). */
export function lyricShareUrl(track: TrackRef): string | null {
  if (notShareable(track.id)) return null;
  return link('l', track.id);
}

/** User playlist (uuid) or catalogue playlist id. */
export const playlistShareUrl = (pl: { id: string } | string) => link('p', typeof pl === 'string' ? pl : pl.id);

export const albumShareUrl = (album: { id: string } | string) => link('a', typeof album === 'string' ? album : album.id);

export const artistShareUrl = (artist: { id: string } | string) => link('ar', typeof artist === 'string' ? artist : artist.id);

/** Live room (session uuid): opens the room in the app, or a "live now" card on the web. */
export const liveShareUrl = (id: string) => link('lv', id);

/** Group listening room / party, by its join code. The kind is part of the id: `group-ABC123` or `party-ABC123`. */
export const roomShareUrl = (kind: 'group' | 'party', code: string) => link('rm', `${kind}-${code}`);

/** Family plan invite code. */
export const familyShareUrl = (code: string) => link('fam', code);

/** Collaborative playlist invite (playlist uuid). */
export const inviteShareUrl = (playlistId: string) => link('inv', playlistId);

/** Stats / run / badge snapshot page (token from `createShareSnapshot`, see lib/share-snapshots.ts). */
export const snapshotShareUrl = (token: string) => link('s', token);

/** Prefers the @username (prettier link); falls back to the profile id. */
export function profileShareUrl(p: { id: string; username?: string | null } | string): string {
  if (typeof p === 'string') return link('u', p);
  return link('u', p.username || p.id);
}

/**
 * Open the system share sheet with the LINK only, so it arrives as a tappable link that unfurls into a rich card
 * (not as a line of text with a link buried in it). `title` is only the sheet's heading.
 * iOS: `url` alone, so Messages / WhatsApp build the preview card from it.
 * Android: the link as the whole message (apps unfurl the link they find).
 * `message` is accepted for older callers and ignored.
 */
export async function shareContent({ url, title }: { url: string; title?: string; message?: string }) {
  if (Platform.OS === 'ios') return Share.share({ url }, { subject: title });
  return Share.share({ message: url, title }, { dialogTitle: title ?? 'Share' });
}

/* ------------------------------------------------------------------ incoming links */

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

const q = (v: string) => encodeURIComponent(v);

/**
 * Map a share link to an in-app route, or `null` when it isn't one.
 * Accepts `https://<SHARE_HOST>/t/ID`, `zoyra://t/ID`, `zoyra:///t/ID` and a bare `/t/ID`.
 * Regex-only on purpose (React Native's URL implementation is partial).
 */
export function appPathFromShareUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = input.trim();
  let rest: string;
  const web = /^https?:\/\/([^/?#]+)(.*)$/i.exec(v);
  if (web) {
    const host = web[1].toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
    if (host !== SHARE_HOSTNAME) return null;
    rest = web[2] || '/';
  } else {
    const scheme = /^zoyra:\/\/\/?(.*)$/i.exec(v);
    if (scheme) rest = `/${scheme[1]}`;
    else if (v.startsWith('/')) rest = v;
    else return null;
  }
  const m = /^\/(t|l|p|a|ar|u|s|lv|rm|fam|inv)\/([^/?#]+)\/?(?:[?#].*)?$/.exec(rest);
  if (!m) return null;
  const id = decode(m[2]);
  if (!id || id.length > 200) return null;
  switch (m[1]) {
    case 't':
    case 'l':
      return `/track-detail?id=${q(id)}`;
    case 'p':
      return UUID.test(id) ? `/playlist?id=${q(id)}` : `/playlist?catalog=${q(id)}`;
    case 'a':
      return `/album?id=${q(id)}`;
    case 'ar':
      return `/artist?id=${q(id)}`;
    case 's':
      return /^[a-f0-9]{14}$/.test(id) ? `/shared?token=${q(id)}` : null;
    case 'lv':
      return UUID.test(id) ? `/live-room?id=${q(id)}` : null;
    case 'rm': {
      const r = /^(group|party)-([A-Za-z0-9]{3,24})$/.exec(id);
      return r ? `${r[1] === 'party' ? '/party' : '/group-listening'}?code=${q(r[2])}` : null;
    }
    case 'fam':
      return /^[A-Za-z0-9]{3,24}$/.test(id) ? `/join-family?code=${q(id)}` : null;
    case 'inv':
      return UUID.test(id) ? `/invite?playlist=${q(id)}` : null;
    case 'u':
      return UUID.test(id) ? `/public-profile?id=${q(id)}` : `/public-profile?username=${q(id.replace(/^@/, '').toLowerCase())}`;
    default:
      return null;
  }
}

/** Any https link on the share host (e.g. the bare landing page) that has no specific route. */
export function isShareHostUrl(input: string | null | undefined): boolean {
  const web = input ? /^https?:\/\/([^/?#]+)/i.exec(input.trim()) : null;
  return !!web && web[1].toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '') === SHARE_HOSTNAME;
}
