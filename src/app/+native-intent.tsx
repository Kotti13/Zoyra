/**
 * Rewrites incoming system links before Expo Router resolves them (native only).
 *
 *   https://<share host>/t/ID   → /track-detail?id=ID      (Universal Link / App Link)
 *   zoyra://t/ID                → /track-detail?id=ID      ("Open in Zoyra" on the landing page)
 *   …/p/ID → /playlist, /a/ID → /album, /ar/ID → /artist, /u/NAME|ID → /public-profile, /l/ID → /track-detail
 *
 * Everything else (zoyra://auth-callback, spotify-callback, call, invite, join-family …) is passed
 * through unchanged. Must never throw.
 */
import { appPathFromShareUrl, isShareHostUrl } from '../lib/share-links';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const mapped = appPathFromShareUrl(path);
    if (mapped) return mapped;
    // Other pages on the share site (e.g. its home page) just open the app.
    if (isShareHostUrl(path)) return '/';
    return path;
  } catch {
    return path;
  }
}
