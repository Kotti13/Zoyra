import Constants from 'expo-constants';
import { useState } from 'react';
import { Linking, Platform, View } from 'react-native';

import { Gradient, ListRow, Screen, ScreenHeader, T, Glass } from '../components';
import { colors } from '../theme/tokens';

const links = ['Terms of service', 'Privacy policy', 'Open source licenses', 'Rate Zoyra', 'Contact support'] as const;
const SUPPORT_EMAIL = 'support@zoyra.app';

function versionLabel() {
  const cfg = Constants.expoConfig;
  const version = cfg?.version ?? '1.0.0';
  const build = Platform.OS === 'ios' ? cfg?.ios?.buildNumber : Platform.OS === 'android' ? cfg?.android?.versionCode?.toString() : undefined;
  return build ? `Version ${version} (build ${build})` : `Version ${version}`;
}
const bars = [18, 34, 48, 30, 14];

export default function About() {
  const [note, setNote] = useState<string>();
  const open = (l: (typeof links)[number]) => {
    setNote(undefined);
    if (l === 'Contact support')
      Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Zoyra support (${versionLabel()})`)}`).catch(() => setNote(`Email us at ${SUPPORT_EMAIL}`));
    else if (l === 'Open source licenses') setNote('Zoyra is built with Expo, React Native and Supabase. Music is streamed from the Audius open catalogue.');
    else if (l === 'Rate Zoyra') setNote('Ratings open once Zoyra is in the App Store and Google Play.');
    else setNote(`The ${l.toLowerCase()} will be published before launch.`);
  };
  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'lines', mesh: 'coral' }} contentStyle={{ flexGrow: 1 }}>
      <ScreenHeader title="About" />

      {/* Logo + version */}
      <View style={{ alignItems: 'center', gap: 8, paddingVertical: 12 }}>
        <Gradient
          colors={[colors.accent, colors.amber]}
          style={{ width: 80, height: 80, borderRadius: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }}
        >
          {bars.map((h, i) => (
            <View key={i} style={{ width: 6, height: h, borderRadius: 3, backgroundColor: colors.white }} />
          ))}
        </Gradient>
        <T size={24} weight={700} accessibilityRole="header">
          Zoyra
        </T>
        <T mono size={12} color={colors.textSecondary}>
          {versionLabel()}
        </T>
      </View>

      <View>
        <Glass padding={4}>
        {links.map((l, i) => (
          <ListRow key={l} title={l} minHeight={56} divider={i > 0} onPress={() => open(l)} />
        ))}
      </Glass>
      </View>
      {note ? (
        <T size={13} lineHeight={18} color={colors.textSecondary} align="center" accessibilityLiveRegion="polite">
          {note}
        </T>
      ) : null}

      <View style={{ flex: 1 }} />
      <T size={12} color={colors.textSecondary} align="center">
        © 2026 Zoyra. All rights reserved.
      </T>
    </Screen>
  );
}
