// Extends app.json. Adds iOS Universal Links + Android App Links for the share host
// (rich share links, see web/share/ and src/lib/share-links.ts).
//
// The host comes from ONE place: EXPO_PUBLIC_SHARE_HOST (.env locally, EAS env for cloud builds),
// defaulting to the free Vercel subdomain. Changing it requires a new native build (eas build),
// because associatedDomains / intentFilters are baked into the binary.
const DEFAULT_SHARE_HOST = 'https://zoyra-share.vercel.app';
const SHARE_PATHS = ['/t/', '/p/', '/a/', '/ar/', '/u/', '/l/', '/s/'];

module.exports = ({ config }) => {
  const raw = (process.env.EXPO_PUBLIC_SHARE_HOST || DEFAULT_SHARE_HOST).trim().replace(/\/+$/, '');
  const shareHost = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const hostname = shareHost.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();

  const ios = config.ios ?? {};
  const android = config.android ?? {};
  const domains = (ios.associatedDomains ?? []).filter((d) => !d.startsWith('applinks:'));
  const filters = (android.intentFilters ?? []).filter((f) => !(f.autoVerify && (f.data ?? []).some?.((d) => d.scheme === 'https')));

  return {
    ...config,
    ios: { ...ios, associatedDomains: [...domains, `applinks:${hostname}`] },
    android: {
      ...android,
      intentFilters: [
        ...filters,
        {
          action: 'VIEW',
          autoVerify: true,
          data: SHARE_PATHS.map((pathPrefix) => ({ scheme: 'https', host: hostname, pathPrefix })),
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    },
    extra: { ...(config.extra ?? {}), shareHost },
  };
};
