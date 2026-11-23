// Extends app.json. Adds iOS Universal Links + Android App Links for the share host
// (rich share links, see web/share/ and src/lib/share-links.ts).
//
// The host comes from ONE place: EXPO_PUBLIC_SHARE_HOST (.env locally, EAS env for cloud builds),
// defaulting to the Zoyra share domain. Changing it requires a new native build (eas build),
// because associatedDomains / intentFilters are baked into the binary.
const DEFAULT_SHARE_HOST = 'https://share.zoyra.site';
const SHARE_PATHS = ['/t/', '/p/', '/a/', '/ar/', '/u/', '/l/', '/s/', '/lv/', '/rm/', '/fam/', '/inv/'];

const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Stop the music when the app is swiped away from Recents (Android).
 * expo-audio's media playback service keeps a playing song alive after the task is removed, with no app UI left
 * to control it. `stopWithTask` makes Android stop that service (and its notification) with the app instead.
 * Listed FIRST in `plugins`: Expo applies manifest mods in reverse order, so this runs after expo-audio adds
 * the service. If the service isn't found (e.g. the plugin changes), it does nothing.
 */
const withStopMusicOnTaskRemoved = (cfg) =>
  withAndroidManifest(cfg, (c) => {
    const app = c.modResults.manifest.application?.[0];
    const svc = app?.service?.find((x) => x.$?.['android:name'] === 'expo.modules.audio.service.AudioControlsService');
    if (svc) svc.$['android:stopWithTask'] = 'true';
    return c;
  });

module.exports = ({ config }) => {
  const raw = (process.env.EXPO_PUBLIC_SHARE_HOST || DEFAULT_SHARE_HOST).trim().replace(/\/+$/, '');
  const shareHost = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const hostname = shareHost.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();

  const ios = config.ios ?? {};
  const android = config.android ?? {};
  const domains = (ios.associatedDomains ?? []).filter((d) => !d.startsWith('applinks:'));
  const filters = (android.intentFilters ?? []).filter((f) => !(f.autoVerify && (f.data ?? []).some?.((d) => d.scheme === 'https')));

  // Android size. A universal APK carries every native library (Hermes, React Native, the Agora SDK...) four
  // times, once per CPU type, which is what makes a build hundreds of MB. Slim builds (EAS preview/development,
  // EAS_SLIM_ANDROID=1) ship arm64 only, which covers phones from the last ~8 years; they also compress the .so
  // files inside the APK (smaller download, larger install). Production is an AAB: Google Play then delivers only
  // the user's CPU type, so it keeps arm64 + 32-bit ARM and drops the x86 emulator builds.
  const slim = process.env.EAS_SLIM_ANDROID === '1';
  const buildProps = [
    'expo-build-properties',
    {
      android: {
        buildArchs: slim ? ['arm64-v8a'] : ['arm64-v8a', 'armeabi-v7a'],
        useLegacyPackaging: slim,
      },
    },
  ];

  return {
    ...config,
    plugins: [withStopMusicOnTaskRemoved, ...(config.plugins ?? []).filter((p) => (Array.isArray(p) ? p[0] : p) !== 'expo-build-properties'), buildProps],
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
