import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect } from 'react';
import { ActivityIndicator } from 'react-native';

import { Screen } from '../components';
import { colors } from '../theme/tokens';

// Web: hand the redirect back to the window that opened the Spotify popup.
WebBrowser.maybeCompleteAuthSession();

/** `zoyra://spotify-callback` lands here if the OS routes it to the app; the auth session already has the code. */
export default function SpotifyCallback() {
  useEffect(() => {
    const id = setTimeout(() => (router.canGoBack() ? router.back() : router.replace('/import')), 50);
    return () => clearTimeout(id);
  }, []);
  return (
    <Screen top={40} contentStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}>
      <ActivityIndicator color={colors.accent} />
    </Screen>
  );
}
