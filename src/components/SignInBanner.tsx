import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { flash } from '../lib/flash';
import { ProviderDisabledError, useAuth } from '../state/auth';
import { colors, radius, withAlpha } from '../theme/tokens';
import { Button } from './controls';
import { Glass, Icon, Row, T } from './primitives';

/**
 * Shown to guests (no account) at the top of Home: the app works without signing in, and this invites
 * them to sign in so likes, playlists, history and downloads sync. Renders nothing once signed in.
 */
export function SignInBanner() {
  const { session, ready, signInWithProvider } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!ready || session) return null;

  const google = async () => {
    setBusy(true);
    try {
      await signInWithProvider('google');
    } catch (e) {
      flash(e instanceof ProviderDisabledError ? 'Google sign-in isn’t set up yet. Use email for now.' : e instanceof Error ? e.message : 'Could not sign in with Google');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Glass padding={16} radius={radius.card}>
      <View style={{ gap: 12 }}>
        <Row gap={12} align="flex-start">
          <View style={styles.badge}>
            <Icon name="user" size={20} color={colors.accentLight} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <T size={16} weight={600}>
              Sign in to save your music
            </T>
            <T size={13} color={colors.textSecondary} lineHeight={18}>
              You’re listening as a guest. Sign in to keep likes, playlists, history and downloads on every device.
            </T>
          </View>
        </Row>
        <Row gap={10}>
          <View style={{ flex: 1.4 }}>
            {busy ? (
              <View style={[styles.googleBusy]}>
                <ActivityIndicator color={colors.onLight} />
              </View>
            ) : (
              <Button label="Continue with Google" variant="light" height={44} onPress={() => void google()} />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Sign in" variant="glass" height={44} onPress={() => router.push('/login')} />
          </View>
        </Row>
      </View>
    </Glass>
  );
}

const styles = StyleSheet.create({
  badge: { width: 40, height: 40, borderRadius: 20, backgroundColor: withAlpha(colors.accent, 0.18), alignItems: 'center', justifyContent: 'center' },
  googleBusy: { height: 44, borderRadius: 22, backgroundColor: colors.text, alignItems: 'center', justifyContent: 'center' },
});
