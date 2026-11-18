import { router } from 'expo-router';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Backdrop, Icon, Rise, T, Tap, TopHighlight } from '../components';
import { colors, gradients, withAlpha } from '../theme/tokens';

/** Equalizer silhouette across the poster (decorative), heights from the 600 px tall mock. */
const BARS = [31, 33, 33, 37, 38, 44, 49, 55, 68, 68, 95, 80, 125, 95, 150, 123, 160, 144, 151, 148, 126, 135, 95, 110, 68, 83, 56, 60, 47, 44, 39, 36, 34, 32];
const BAR_FILL = [colors.rose, withAlpha(colors.rose, 0.67), withAlpha(colors.rose, 0)] as const;
const BAR_AT = [0, 0.6, 1] as const;
const HERO_FADE = [withAlpha(colors.bg, 0), withAlpha(colors.bg, 0.85)] as const;
const HERO_FADE_AT = [0.38, 1] as const;
const SHEET_GLASS = [colors.glassTop, colors.glassMid, colors.glassTint] as const;
const SHEET_GLASS_AT = [0, 0.6, 1] as const;
const SPHERE = [withAlpha(colors.white, 0.5), withAlpha(colors.rose, 0.4), withAlpha(colors.rose, 0)] as const;

/** Cinematic welcome: full-bleed poster with a frosted sign-in sheet (SIGN UP → /signup, or Log in → /login). */
export default function Welcome() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  // Mock is 600 / 844 tall; keep the same proportion on shorter and taller phones.
  const heroH = Math.round(Math.min(640, height * 0.71));
  const k = heroH / 600;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Poster hero */}
      <View style={{ height: heroH, overflow: 'hidden' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <LinearGradient colors={gradients.poster} start={{ x: 0.35, y: 0 }} end={{ x: 0.65, y: 1 }} style={StyleSheet.absoluteFill} />
        <Backdrop
          pattern="none"
          orbs={false}
          mesh="none"
          glows={[
            { x: 0.74, y: 0.24, color: colors.rose, opacity: 0.8, stop: 0.42 },
            { x: 0.16, y: 0.86, color: colors.accent, opacity: 0.7, stop: 0.46 },
          ]}
        />
        {/* Halo ring + glossy sphere */}
        <View
          style={{
            position: 'absolute',
            right: -0.12 * width,
            top: 0.06 * heroH,
            width: 0.7 * width,
            height: 0.7 * width,
            borderRadius: width,
            borderWidth: 1,
            borderColor: withAlpha(colors.white, 0.18),
            backgroundColor: withAlpha(colors.white, 0.025),
          }}
        />
        <LinearGradient
          colors={SPHERE}
          locations={[0, 0.45, 1]}
          start={{ x: 0.3, y: 0.25 }}
          end={{ x: 0.85, y: 0.95 }}
          style={{ position: 'absolute', right: 0.06 * width, top: 0.14 * heroH, width: 0.36 * width, height: 0.36 * width, borderRadius: width }}
        />
        {/* Equalizer */}
        <View style={{ position: 'absolute', left: 18, right: 18, top: 300 * k, height: 170 * k, flexDirection: 'row', alignItems: 'flex-end', gap: 4 }}>
          {BARS.map((h, i) => {
            const mid = 1 - Math.abs(i - (BARS.length - 1) / 2) / (BARS.length / 2);
            return (
              <LinearGradient
                key={i}
                colors={BAR_FILL}
                locations={BAR_AT}
                start={{ x: 0, y: 1 }}
                end={{ x: 0, y: 0 }}
                style={{ flex: 1, height: h * k, borderRadius: 3, opacity: 0.42 + 0.58 * mid }}
              />
            );
          })}
        </View>
        <LinearGradient colors={HERO_FADE} locations={HERO_FADE_AT} style={StyleSheet.absoluteFill} />
      </View>

      {/* Wordmark */}
      <View style={{ position: 'absolute', top: insets.top + 16, left: 24 }}>
        <T size={30} weight={300} tracking={-0.5} accessibilityRole="header" accessibilityLabel="Zoyra">
          Zoyra
          <T size={30} weight={800} color={colors.rose}>
            .
          </T>
        </T>
      </View>

      {/* Frosted sign-in sheet */}
      <Rise delay={120} style={{ position: 'absolute', left: 14, right: 14, bottom: Math.max(20, insets.bottom + 8) }}>
        <View style={styles.sheet}>
          {Platform.OS === 'ios' ? <BlurView tint="dark" intensity={40} style={StyleSheet.absoluteFill} /> : <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.frost }]} />}
          <LinearGradient colors={SHEET_GLASS} locations={SHEET_GLASS_AT} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
          <TopHighlight radius={36} />
          <View style={styles.handle} />
          <T variant="headlineLight" size={32} lineHeight={36} style={{ marginTop: 6 }}>
            {'Sign in for\nmusic that moves you'}
          </T>
          <T size={15} weight={300} lineHeight={22} color={colors.peach}>
            Fuel your day with a smart soundtrack for every mood, workout and moment.
          </T>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 6 }}>
            <Tap href="/signup" accessibilityRole="button" accessibilityLabel="Sign up" style={styles.signUp}>
              <T size={14} weight={700} tracking={1} color={colors.onLight}>
                SIGN UP
              </T>
              <View style={styles.arrow}>
                <Icon name="arrowRight" size={22} color={colors.white} glow={false} />
              </View>
            </Tap>
            <Tap href="/login" accessibilityRole="button" accessibilityLabel="Log in" style={styles.logIn}>
              <T size={15}>or Log in</T>
            </Tap>
            <Tap onPress={() => router.replace('/')} accessibilityRole="button" accessibilityLabel="Continue without an account" style={styles.logIn}>
              <T size={14} color={colors.textSecondary}>
                Continue without an account
              </T>
            </Tap>
          </View>
        </View>
      </Rise>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderRadius: 36,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    paddingTop: 14,
    paddingHorizontal: 22,
    paddingBottom: 26,
    gap: 14,
  },
  handle: { alignSelf: 'center', width: 44, height: 4, borderRadius: 2, backgroundColor: withAlpha(colors.white, 0.5) },
  signUp: {
    flex: 1.5,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.text,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 24,
    paddingRight: 6,
  },
  arrow: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  logIn: {
    flex: 1,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(colors.white, 0.12),
    borderWidth: 1,
    borderColor: colors.chipOutline,
  },
});
