import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Button, Screen, T } from '../components';
import { completeOAuthRedirect, isRecoveryPending } from '../state/auth';
import { colors } from '../theme/tokens';

// Web: hand the redirect back to the window that opened the auth popup.
WebBrowser.maybeCompleteAuthSession();

/**
 * Landing route for `zoyra://auth-callback`: Google / Apple sign-in, email confirmation and password-reset links.
 * Normally the in-app browser session captures the redirect; this covers cold deep links
 * (the app was killed, or Android delivered the link to the app instead of the auth session).
 */
export default function AuthCallback() {
  const url = Linking.useLinkingURL();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      const link = url ?? (await Linking.getInitialURL());
      if (!link) return;
      try {
        const done = await completeOAuthRedirect(link);
        if (!alive) return;
        if (!done) setError('This sign-in link has no session in it. Try signing in again.');
        else if (isRecoveryPending()) router.replace('/reset-password');
        // Otherwise the auth gate routes (onboarding / permissions / Home) once user settings load. Replacing to
        // '/' here first flashed Home before onboarding; the fallback covers a gate that has nothing to do.
        else fallback = setTimeout(() => alive && router.replace('/'), 6000);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not finish signing in');
      }
    })();
    return () => {
      alive = false;
      if (fallback) clearTimeout(fallback);
    };
  }, [url]);

  return (
    <Screen top={40} gap={16} contentStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}>
      {error ? (
        <View style={{ gap: 16, alignItems: 'center', alignSelf: 'stretch' }}>
          <T size={16} color={colors.error} align="center" accessibilityLiveRegion="polite">
            {error}
          </T>
          <Button label="Back to log in" onPress={() => router.replace('/login')} style={{ alignSelf: 'stretch' }} />
        </View>
      ) : (
        <>
          <ActivityIndicator color={colors.accent} />
          <T size={15} color={colors.textSecondary}>
            Finishing sign-in…
          </T>
        </>
      )}
    </Screen>
  );
}
