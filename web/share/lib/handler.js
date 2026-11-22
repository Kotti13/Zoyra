// Framework-free request handling, shared by the Vercel functions and the local tests.
import { APP_PATHS, readConfig } from './config.js';
import { UpstreamError, loadCard } from './data.js';
import { CSP, renderCard, renderMessage } from './render.js';

export const KINDS = ['t', 'p', 'a', 'ar', 'u', 'l', 's', 'lv', 'rm', 'fam', 'inv'];

const CACHE = {
  // Catalogue data barely changes.
  catalog: 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
  // User content: shorter, so making a playlist/profile private takes effect quickly at the edge.
  user: 'public, max-age=60, s-maxage=600, stale-while-revalidate=600',
  notFound: 'public, max-age=60, s-maxage=300',
  error: 'public, max-age=0, s-maxage=30',
};

const htmlHeaders = (cache) => ({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': cache,
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
});

/**
 * @param {{ kind: string, id: string }} req
 * @returns {Promise<{ status: number, headers: Record<string,string>, body: string }>}
 */
export async function handleShare({ kind, id }, env = process.env, fetchImpl = fetch) {
  const cfg = readConfig(env);
  if (kind === 'home') {
    const body = renderMessage(cfg, {
      title: 'Music is better together',
      body: 'Zoyra is the social music app: listen with friends, share songs and playlists, and sing along with synced lyrics.',
      label: 'Zoyra',
      index: true,
      status: 200,
    });
    return { status: 200, headers: htmlHeaders(CACHE.catalog), body };
  }
  const safeKind = KINDS.includes(kind) ? kind : null;
  const path = safeKind && id ? `/${safeKind}/${encodeURIComponent(String(id))}` : '/';
  if (!safeKind || !id) {
    return { status: 404, headers: htmlHeaders(CACHE.notFound), body: renderMessage(cfg, { title: 'Link not found', body: 'This Zoyra link doesn’t exist. Open Zoyra to find music, playlists and friends.' }) };
  }
  try {
    const card = await loadCard(safeKind, String(id), cfg, fetchImpl);
    if (!card) {
      const what = { t: 'song', l: 'song', p: 'playlist', a: 'album', ar: 'artist', u: 'profile', s: 'shared item', lv: 'live room', rm: 'listening room', fam: 'invite', inv: 'invite' }[safeKind];
      const body =
        safeKind === 'p'
          ? 'This playlist is private or no longer exists.'
          : safeKind === 's'
            ? 'This shared item was removed or the link is wrong. Open Zoyra to see your own stats.'
            : `This ${what} isn’t available any more. Open Zoyra to keep listening.`;
      return { status: 404, headers: htmlHeaders(CACHE.notFound), body: renderMessage(cfg, { title: `${what[0].toUpperCase()}${what.slice(1)} not found`, body, path }) };
    }
    const canonical = card.appPath ? `/${card.appPath}` : path;
    return { status: 200, headers: htmlHeaders(CACHE[card.cache] ?? CACHE.catalog), body: renderCard(card, cfg, { path: canonical }) };
  } catch (e) {
    if (!(e instanceof UpstreamError)) console.error('share render failed', e);
    else console.warn(e.message);
    return {
      status: 503,
      headers: { ...htmlHeaders(CACHE.error), 'Retry-After': '30' },
      body: renderMessage(cfg, { title: 'Open in Zoyra', body: 'We couldn’t load this preview right now. Open the link in Zoyra to see it.', path, status: 503 }),
    };
  }
}

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, s-maxage=3600' };

/** iOS Universal Links. Served at /.well-known/apple-app-site-association (no extension). */
export function appleAppSiteAssociation(env = process.env) {
  const cfg = readConfig(env);
  const appID = `${cfg.appleTeamId}.${cfg.iosBundleId}`;
  const body = {
    applinks: {
      // apps: [] is required by iOS 12 and earlier; harmless on newer versions.
      apps: [],
      details: [
        {
          appIDs: [appID],
          components: APP_PATHS.map((p) => ({ '/': p, comment: `Zoyra share link ${p}` })),
          // Older iOS reads these.
          appID,
          paths: APP_PATHS,
        },
      ],
    },
  };
  return { status: 200, headers: jsonHeaders, body: JSON.stringify(body, null, 2) };
}

/** Android App Links verification. Served at /.well-known/assetlinks.json. */
export function assetLinks(env = process.env) {
  const cfg = readConfig(env);
  const body = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: cfg.androidPackage, sha256_cert_fingerprints: cfg.androidFingerprints },
    },
  ];
  return { status: 200, headers: jsonHeaders, body: JSON.stringify(body, null, 2) };
}

export const toResponse = (r, head = false) => new Response(head ? null : r.body, { status: r.status, headers: r.headers });
