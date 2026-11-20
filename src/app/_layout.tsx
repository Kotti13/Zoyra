import { Inter_200ExtraLight, Inter_300Light, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold } from '@expo-google-fonts/inter';
import { JetBrainsMono_400Regular, JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono';
import { useFonts } from 'expo-font';
import { DarkTheme, Stack, ThemeProvider, router, type ErrorBoundaryProps, useGlobalSearchParams, usePathname, useSegments, type Href } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { DialogHost } from '../components/DialogHost';
import { FlashHost } from '../components/flash';
import { SplashView } from '../components/SplashView';
import { isAddingAccount, useAccountSync } from '../lib/accounts';
import { installErrorGuard } from '../lib/error-guard';
import { CallHost } from '../lib/call-ui';
import { KidsGuardHost } from '../components/KidsGuard';
import { useGiftSync } from '../lib/gifts';
import { useDeliveryMarker } from '../lib/dm';
import { useE2EEBootstrap } from '../lib/e2ee-boot';
import { useMfaRequired } from '../lib/mfa';
import { useNetworkRouting } from '../lib/network';
import { usePermissionsSeen } from '../lib/permissions';
import { usePresenceTracker } from '../lib/presence';
import { registerForPush, useNotificationRouting } from '../lib/push';
import { useRadioTopUp } from '../lib/radio';
import { useScrobbler } from '../lib/scrobble';
import { useSessionHeartbeat } from '../lib/sessions';
import { clearUserMemory } from '../lib/sign-out';
import { checkForUpdate } from '../lib/updates';
import { AuthProvider, isRecoveryPending, takeAfterSignOutRoute, useAuth } from '../state/auth';
import { DownloadsProvider } from '../state/downloads';
import { LibraryProvider } from '../state/library';
import { PlayerProvider } from '../state/player';
import { colors } from '../theme/tokens';

SplashScreen.preventAutoHideAsync();

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: colors.bg, card: colors.bg, primary: colors.accent, text: colors.text, border: colors.border },
};

/** Routes drawn over the previous screen (bottom sheets and centered modals). */
const overlays = [
  'song-options',
  'add-to-playlist',
  'share-sheet',
  'sleep-sheet',
  'filter-sort',
  'create-playlist',
  'fx-sheet',
  'offline',
  'update',
  'profile-more',
  'slow-net',
  'avatar-picker',
  'account-switcher',
  'profile-qr',
  'go-live',
  'video-comments',
  'video-options',
  'chat-actions',
  'remind-me',
  'chat-lock',
  'chat-attach',
  'chat-voice',
  'chat-tools',
  'chat-extras',
  'confirm-block',
  'confirm-clear',
  'confirm-unsend',
  'note-viewers',
  'forever-block-locked',
];

/** Routes that slide up from the bottom like the full player. */
const fullscreenUp = ['player', 'lyrics', 'lyrics-focus', 'queue', 'car-mode', 'karaoke', 'player-buffering'];

/** Screens reachable without an account. */
const publicRoutes = new Set(['splash', 'welcome', 'login', 'signup', 'otp', 'forgot', 'auth-callback', 'spotify-callback']);

/** Screens the one-time permissions step never interrupts (it waits until the user leaves them). */
const permissionsExempt = new Set(['permissions', 'onboarding', 'artists', 'languages', 'call', 'group-call', 'update', 'reset-password', 'mfa-verify']);

/** Sends signed-out users to Welcome, new users to onboarding, signed-in users away from auth screens. */
function AuthGate({ children }: { children: ReactNode }) {
  const { ready, session, settings } = useAuth();
  const segments = useSegments();
  const first = segments[0] ?? '';

  const pathname = usePathname();
  const params = useGlobalSearchParams();
  /** Deep link opened while signed out (e.g. zoyra://invite?playlist=…) — replayed after login. */
  const pending = useRef<Href | null>(null);

  // null while checking; true when the account has 2FA and this session hasn't passed the code step yet.
  const mfa = useMfaRequired(session);
  // First-run permissions step, once per device (null while reading the flag).
  const permsSeen = usePermissionsSeen();

  // Right after sign-up / OTP / sign-in the session lands before `user_settings` is loaded. Routing on a null
  // `settings` sent new users to /permissions or Home and then bounced them to onboarding (blank flashes), so the
  // gate waits for settings, with a 5 s fallback to Home if they never load.
  const uid = session?.user.id ?? null;
  const settingsMissing = !!session && settings === null;
  const [timedOutFor, setTimedOutFor] = useState<string | null>(null);
  const settingsTimedOut = settingsMissing && timedOutFor === uid;
  useEffect(() => {
    if (!settingsMissing || !uid) return;
    const t = setTimeout(() => setTimedOutFor(uid), 5000);
    return () => clearTimeout(t);
  }, [settingsMissing, uid]);

  // Signed out (any way: Settings, account switcher, delete account, revoked elsewhere) or switched accounts:
  // drop the previous user's in-memory data and the pending deep link. A sign-out also resets the stack to
  // Welcome (or the screen the sign-out asked for), so no signed-in screen with stale data stays open.
  const prevUid = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    const prev = prevUid.current;
    prevUid.current = uid;
    if (!prev || prev === uid) return;
    clearUserMemory();
    pending.current = null;
    if (!uid) {
      if (router.canDismiss()) router.dismissAll();
      router.replace(takeAfterSignOutRoute() as Href);
    }
  }, [ready, uid]);

  useEffect(() => {
    if (!ready) return;
    const isPublic = publicRoutes.has(first);
    if (session && mfa === null) return;
    if (session && mfa) {
      // Treat as signed out until the code is entered.
      if (first !== 'mfa-verify') {
        if (!isPublic && pathname && pathname !== '/') pending.current = { pathname, params } as Href;
        router.replace('/mfa-verify');
      }
      return;
    }
    // A password-reset link signed the user in: send them to choose a new password first.
    if (session && isRecoveryPending()) {
      if (first !== 'reset-password') router.replace('/reset-password');
      return;
    }
    if (session && first === 'mfa-verify') {
      router.replace(pending.current ?? '/');
      pending.current = null;
      return;
    }
    // Guests can browse and play without an account (Home shows a sign-in banner); screens that need an
    // account show their own "Sign in" state. Only signed-in users are redirected below.
    if (!session) {
      return;
    }
    if (settings === null) {
      // Wait for user_settings (the current screen stays up). Timed out: leave auth screens for Home.
      if (settingsTimedOut && isPublic && !isAddingAccount()) {
        router.replace(pending.current ?? '/');
        pending.current = null;
      }
      return;
    }
    if (isPublic && !isAddingAccount()) {
      const onboarding = !settings.onboarded;
      const perms = !onboarding && permsSeen === false;
      router.replace(onboarding ? '/onboarding' : perms ? '/permissions' : pending.current ?? '/');
      if (!onboarding && !perms) pending.current = null;
    } else if (session && settings && !settings.onboarded && !['onboarding', 'artists', 'languages'].includes(first)) {
      router.replace('/onboarding');
    } else if (session && settings?.onboarded && permsSeen !== true && !isPublic) {
      // After onboarding (or first launch signed in): show /permissions once; a pending deep link waits for it.
      if (permsSeen === false && !permissionsExempt.has(first)) router.replace('/permissions');
    } else if (session && settings?.onboarded && pending.current) {
      const next = pending.current;
      pending.current = null;
      router.replace(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, session, settings, settingsTimedOut, first, mfa, permsSeen]);

  // Keep saved accounts' refresh tokens fresh, label this device's session, and open slow/back-online sheets.
  useAccountSync();
  useSessionHeartbeat(session);
  useNetworkRouting(!!session);
  // A gifted Premium period that ended drops back to free.
  useGiftSync();

  // Tapping a push notification opens its screen (also for cold starts).
  // Waits for `ready` (the Stack is only rendered then) so cold-start taps don't hit an unmounted navigator.
  useNotificationRouting(ready);

  // Announces this device as online (when the user allows it) for Messages' green dots / Active now.
  usePresenceTracker();
  // Foreground / incoming push → mark chats delivered (drives ✓✓ Delivered for senders).
  useDeliveryMarker(!!session && mfa === false);

  // Force the update screen when this version is below app_config.min_version.
  useEffect(() => {
    if (!ready) return;
    checkForUpdate()
      .then((info) => {
        if (info?.status === 'required') router.push('/update');
      })
      .catch(() => {});
  }, [ready]);

  // Refresh this device's push token silently if the user turned push on (never prompts here).
  const userId = session?.user.id;
  const pushOn = settings?.notifications?.push === true;
  useEffect(() => {
    if (userId && pushOn) void registerForPush(userId, { prompt: false });
  }, [userId, pushOn]);

  // End-to-end encryption keys for this phone, created silently (no PIN, nothing routed from here).
  useE2EEBootstrap(session && mfa === false ? (userId ?? null) : null, pushOn);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {ready ? children : null}
      {/* Incoming calls open /call (signed in, past 2FA); a minimized call shows "Return to call". */}
      {ready ? <CallHost me={session && mfa === false ? session.user.id : null} /> : null}
      {/* Kids mode: closes social / settings screens and enforces the daily limit and bedtime. */}
      {ready && session ? <KidsGuardHost /> : null}
      <LaunchSplash ready={ready} />
    </View>
  );
}

/** Sends listens to Last.fm / ListenBrainz when the user connected them. */
function Scrobbler() {
  useScrobbler();
  // Keeps radio stations endless anywhere in the app (no-op unless a radio station is playing).
  useRadioTopUp();
  return null;
}

/** Animated launch splash over the app until the session is restored (min 0.9 s so the animation can land). */
function LaunchSplash({ ready }: { ready: boolean }) {
  const [minElapsed, setMinElapsed] = useState(false);
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setMinElapsed(true), 900);
    return () => clearTimeout(id);
  }, []);
  const onReady = useCallback(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);
  const onFinish = useCallback(() => setFinished(true), []);
  if (finished) return null;
  return <SplashView done={ready && minElapsed} onReady={onReady} onFinish={onFinish} />;
}

// Keep the app alive (and show a message) when a request or callback fails without being handled.
installErrorGuard();

/**
 * Expo Router renders this instead of a blank screen when a screen throws while rendering, so a JavaScript
 * error shows its message (and can be retried) rather than leaving a black screen. Plain React Native only:
 * it must not depend on providers, theme or fonts, which may be what failed.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={{ flex: 1, backgroundColor: '#050505', padding: 24, paddingTop: 72 }}>
      <Text style={{ color: '#F5F5F5', fontSize: 22, fontWeight: '600' }}>Something went wrong</Text>
      <Text style={{ color: '#A3A3A3', fontSize: 14, marginTop: 8 }}>The screen hit an error. Try again, and if it keeps happening send this message to support.</Text>
      <ScrollView style={{ marginTop: 16, maxHeight: 220 }}>
        <Text selectable style={{ color: '#FF8A8A', fontSize: 12 }}>
          {String(error?.message ?? error)}
          {'\n\n'}
          {String(error?.stack ?? '').split('\n').slice(0, 8).join('\n')}
        </Text>
      </ScrollView>
      <Pressable accessibilityRole="button" accessibilityLabel="Try again" onPress={() => void retry()} style={{ marginTop: 20, height: 48, borderRadius: 24, backgroundColor: '#E50914', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>Try again</Text>
      </Pressable>
    </View>
  );
}

export default function RootLayout() {
  const [loaded] = useFonts({
    Inter_200ExtraLight,
    Inter_300Light,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

  if (!loaded) return null;

  return (
    <SafeAreaProvider>
      <ThemeProvider value={theme}>
        <AuthProvider>
        <LibraryProvider>
        <PlayerProvider>
        {/* Offline downloads index + auto-opens /offline when the device loses connection (NetInfo). */}
        <DownloadsProvider>
          <AuthGate>
          <Scrobbler />
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.bg },
              // Same iOS-style push on both platforms, swipe back from anywhere on the screen.
              animation: 'ios_from_right',
              animationDuration: 200,
              gestureEnabled: true,
              fullScreenGestureEnabled: true,
            }}
          >
            <Stack.Screen name="(tabs)" />
            {['splash', 'welcome', 'login', 'signup', 'otp', 'forgot', 'onboarding', 'permissions', 'auth-callback', 'mfa-verify'].map((name) => (
              <Stack.Screen key={name} name={name} options={{ animation: 'fade', animationDuration: 140 }} />
            ))}
            {fullscreenUp.map((name) => (
              <Stack.Screen
                key={name}
                name={name}
                // Player-like screens rise from the bottom over the current page. Swipe down closes them
                // (handled in <Screen swipeDown>, same on iOS and Android), revealing the page underneath.
                options={{ presentation: 'transparentModal', animation: 'slide_from_bottom', animationDuration: 230, gestureEnabled: false, contentStyle: { backgroundColor: 'transparent' } }}
              />
            ))}
            {/* Profile tabs (Overview → Playlists/Activity/Taste) swap in place instead of sliding in. */}
            {['profile-playlists', 'profile-activity', 'profile-taste'].map((name) => (
              <Stack.Screen key={name} name={name} options={{ animation: 'fade', animationDuration: 130 }} />
            ))}
            {/* Forever flow (prompt → sent / ask → done): full screen pages, never sheets, so the chat they lead back to stays a normal card. */}
            {['forever-prompt', 'forever-sent', 'forever-ask', 'forever-done'].map((name) => (
              <Stack.Screen key={name} name={name} options={{ presentation: 'card', animation: 'fade_from_bottom', animationDuration: 200 }} />
            ))}
            {/* 1:1 voice / video call: full screen, no swipe-to-dismiss (minimize / end are explicit). */}
            <Stack.Screen name="call" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom', gestureEnabled: false, fullScreenGestureEnabled: false }} />
            <Stack.Screen name="group-call" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom', gestureEnabled: false, fullScreenGestureEnabled: false }} />
            {overlays.map((name) => (
              <Stack.Screen
                key={name}
                name={name}
                options={{ presentation: 'transparentModal', animation: 'fade', animationDuration: 120, gestureEnabled: false, contentStyle: { backgroundColor: 'transparent' } }}
              />
            ))}
          </Stack>
          <FlashHost />
          <DialogHost />
          </AuthGate>
        </DownloadsProvider>
        </PlayerProvider>
        </LibraryProvider>
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
