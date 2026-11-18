// All configuration for the share service comes from environment variables (Vercel → Settings →
// Environment Variables). PUBLIC_HOST is the ONE place the public domain is set on the web side;
// the app reads the same host from EXPO_PUBLIC_SHARE_HOST.

const DEFAULT_HOST = 'https://zoyra-share.vercel.app';

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

function normalizeHost(raw) {
  const v = clean(raw).replace(/\/+$/, '');
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/** @param {Record<string, string | undefined>} env */
export function readConfig(env = process.env) {
  const publicHost =
    normalizeHost(env.PUBLIC_HOST) ||
    normalizeHost(env.VERCEL_PROJECT_PRODUCTION_URL) || // set automatically by Vercel
    DEFAULT_HOST;

  const fingerprints = clean(env.ANDROID_SHA256_FINGERPRINTS)
    .split(/[\s,]+/)
    .map((f) => f.trim().toUpperCase())
    .filter((f) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f));

  const androidPackage = clean(env.ANDROID_PACKAGE) || 'com.zoyra.app';

  return {
    publicHost,
    supabaseUrl: normalizeHost(env.SUPABASE_URL),
    // Publishable / anon key only. NEVER the service-role key: everything private must stay private.
    supabaseAnonKey: clean(env.SUPABASE_ANON_KEY),
    appleTeamId: clean(env.APPLE_TEAM_ID) || 'TEAMID_NOT_SET',
    iosBundleId: clean(env.IOS_BUNDLE_ID) || 'com.zoyra.app',
    androidPackage,
    androidFingerprints: fingerprints,
    appScheme: clean(env.APP_SCHEME) || 'zoyra',
    appStoreUrl: /^https:\/\//.test(clean(env.APP_STORE_URL)) ? clean(env.APP_STORE_URL) : '',
    playStoreUrl: /^https:\/\//.test(clean(env.PLAY_STORE_URL))
      ? clean(env.PLAY_STORE_URL)
      : `https://play.google.com/store/apps/details?id=${encodeURIComponent(androidPackage)}`,
    audiusApi: normalizeHost(env.AUDIUS_API) || 'https://api.audius.co/v1',
    zoyraApi: normalizeHost(env.ZOYRA_API_URL),
  };
}

/** Paths the app claims as Universal Links / App Links (must match app.config.js SHARE_PATHS). */
export const APP_PATHS = ['/t/*', '/p/*', '/a/*', '/ar/*', '/u/*', '/l/*', '/s/*'];
