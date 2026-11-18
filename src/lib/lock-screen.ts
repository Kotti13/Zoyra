/**
 * Like / Shuffle buttons on the system media card (Android media notification + lock screen).
 *
 * Backed by a patch to expo-audio (`patches/expo-audio+*.patch`) that adds
 * `ExpoAudio.setLockScreenButtons()` and the `onLockScreenAction` event. Everything here no-ops when
 * the native side is missing (iOS, web, Expo Go, or an older build without the patch).
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export type LockScreenAction = 'like' | 'shuffle';

export type LockScreenButtons = {
  liked: boolean;
  shuffle: boolean;
  showLike: boolean;
  showShuffle: boolean;
};

type Subscription = { remove: () => void };

type PatchedAudioModule = {
  setLockScreenButtons?: (buttons: LockScreenButtons) => void;
  addListener?: (event: 'onLockScreenAction', listener: (e: { action?: string }) => void) => Subscription;
};

let mod: PatchedAudioModule | null | undefined;
function audioModule(): PatchedAudioModule | null {
  if (mod !== undefined) return mod;
  try {
    mod = Platform.OS === 'android' ? requireOptionalNativeModule<PatchedAudioModule>('ExpoAudio') : null;
  } catch {
    mod = null;
  }
  return mod;
}

/** Updates the state and visibility of the Like / Shuffle buttons; the card refreshes immediately. */
export function setLockScreenButtons(buttons: LockScreenButtons): void {
  const m = audioModule();
  if (typeof m?.setLockScreenButtons !== 'function') return;
  try {
    m.setLockScreenButtons(buttons);
  } catch {
    // Native side out of date: keep the stock card.
  }
}

/** Calls `listener` when Like or Shuffle is tapped on the system media card. Returns an unsubscribe. */
export function addLockScreenActionListener(listener: (action: LockScreenAction) => void): () => void {
  const m = audioModule();
  if (typeof m?.addListener !== 'function' || typeof m.setLockScreenButtons !== 'function') return () => {};
  try {
    const sub = m.addListener('onLockScreenAction', (e) => {
      if (e?.action === 'like' || e?.action === 'shuffle') listener(e.action);
    });
    return () => {
      try {
        sub.remove();
      } catch {
        // already gone
      }
    };
  } catch {
    return () => {};
  }
}
