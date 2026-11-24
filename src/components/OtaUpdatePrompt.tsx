import * as Updates from 'expo-updates';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { reportError } from '../lib/crash-reporting';
import { colors } from '../theme/tokens';
import { Button } from './controls';
import { T } from './primitives';

/** Look again at most this often while the app stays open (it also looks each time the app comes back to the front). */
const RECHECK_MS = 30 * 60 * 1000;

type Phase = 'idle' | 'available' | 'downloading' | 'failed';

/**
 * "Update available" prompt for over-the-air updates (the JavaScript, screens and images; native changes need a new build).
 *
 * The app already downloads a published update in the background at launch (expo-updates' default). This prompt covers
 * both moments: an update that is already downloaded ("ready") and one that is only available. Tapping Update now
 * downloads it if needed and restarts the app on the new version. Later hides the prompt until the next check.
 * Does nothing in development builds, where expo-updates is off.
 */
export function OtaUpdatePrompt() {
  const insets = useSafeAreaInsets();
  const { isUpdateAvailable, isUpdatePending } = Updates.useUpdates();
  const [phase, setPhase] = useState<Phase>('idle');
  const [dismissed, setDismissed] = useState(false);
  const lastCheck = useRef(0);

  const check = useCallback(async () => {
    if (__DEV__ || !Updates.isEnabled) return;
    lastCheck.current = Date.now();
    try {
      const r = await Updates.checkForUpdateAsync();
      if (r.isAvailable) {
        setDismissed(false);
        setPhase((p) => (p === 'downloading' ? p : 'available'));
      }
    } catch (e) {
      reportError(e, 'ota/check');
    }
  }, []);

  // Look at launch, and again whenever the app returns to the front after a while.
  useEffect(() => {
    // Async check: state is set after the network round trip, not during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && Date.now() - lastCheck.current > RECHECK_MS) void check();
    });
    return () => sub.remove();
  }, [check]);

  const install = async () => {
    setPhase('downloading');
    try {
      if (!isUpdatePending) {
        const r = await Updates.fetchUpdateAsync();
        if (!r.isNew && !r.isRollBackToEmbedded) throw new Error('No new update to install');
      }
      await Updates.reloadAsync();
    } catch (e) {
      reportError(e, 'ota/install');
      setPhase('failed');
    }
  };

  // The background launch download (or the hook's own check) found one: show the prompt without waiting for ours.
  const known = phase !== 'idle' || isUpdateAvailable || isUpdatePending;
  if (__DEV__ || !Updates.isEnabled || dismissed || !known) return null;

  const busy = phase === 'downloading';
  const ready = isUpdatePending;
  const text =
    phase === 'failed'
      ? 'Could not install the update. Check your connection and try again.'
      : busy
        ? ready
          ? 'Restarting…'
          : 'Downloading the update…'
        : ready
          ? 'The new version is downloaded. Restart to use it.'
          : 'A new version of Zoyra is ready to install.';

  return (
    <View
      accessibilityViewIsModal={false}
      style={{
        position: 'absolute',
        left: 12,
        right: 12,
        bottom: Math.max(insets.bottom, 12) + 64,
        zIndex: 50,
        borderRadius: 18,
        padding: 14,
        gap: 10,
        backgroundColor: colors.glassStrong,
        borderWidth: 1,
        borderColor: colors.glassBorder,
      }}
    >
      <View style={{ gap: 2 }}>
        <T size={16} weight={700} accessibilityRole="header">
          Update available
        </T>
        <T size={13} color={colors.textSecondary} lineHeight={18} accessibilityLiveRegion="polite">
          {text}
        </T>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Later" variant="glass" height={42} style={{ flex: 1 }} onPress={() => setDismissed(true)} />
        <Button
          label={busy ? 'Updating…' : phase === 'failed' ? 'Try again' : ready ? 'Restart now' : 'Update now'}
          variant={busy ? 'disabled' : 'primary'}
          height={42}
          style={{ flex: 1 }}
          onPress={() => void install()}
        />
      </View>
    </View>
  );
}
