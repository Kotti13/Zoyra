import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Icon, Screen, T, useReduceMotion, type IconName } from '../components';
import { ForeverAvatar, GoldBackdrop, GoldButton, GoldChip, GoldInfinity, GoldRipples, ShineText, SoftButton } from '../components/forever';
import { startChat } from '../lib/dm';
import { flash } from '../lib/flash';
import { firstName, foreverErrorMessage, foreverVaultHref, GOLD, refreshForever, useForeverPerson } from '../lib/forever';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

const CONFETTI_COLORS = [GOLD.light, GOLD.deep, colors.white, GOLD.mid] as const;
const CONFETTI = Array.from({ length: 22 }, (_, i) => ({
  left: (i * 37) % 100,
  size: 6 + (i % 4) * 2,
  round: i % 2 === 1,
  color: CONFETTI_COLORS[i % 4],
  duration: 3000 + (i % 5) * 500,
  delay: [0, 300, 700, 1000, 1400, 1800, 2100, 2400][i % 8],
}));

/** Gold stars / confetti falling and spinning (zFallS). Not rendered with Reduce Motion. */
function FallingStars() {
  const reduce = useReduceMotion();
  const { height } = useWindowDimensions();
  const [vals] = useState(() => CONFETTI.map(() => new Animated.Value(0)));
  useEffect(() => {
    if (reduce) return;
    const loops = vals.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(CONFETTI[i].delay),
          Animated.timing(v, { toValue: 1, duration: CONFETTI[i].duration, easing: Easing.in(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [vals, reduce]);
  if (reduce) return null;
  const fall = Math.min(height * 0.75, 620);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {CONFETTI.map((c, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            top: 0,
            left: `${c.left}%`,
            width: c.size,
            height: c.size,
            borderRadius: c.round ? c.size / 2 : 2,
            backgroundColor: c.color,
            opacity: vals[i].interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 1, 0] }),
            transform: [
              { translateY: vals[i].interpolate({ inputRange: [0, 1], outputRange: [-40, fall] }) },
              { rotate: vals[i].interpolate({ inputRange: [0, 1], outputRange: ['0deg', '300deg'] }) },
            ],
          }}
        />
      ))}
    </View>
  );
}

/** One-shot entrance (0 → 1) after `delay` ms, or already 1 with Reduce Motion. */
function useEntrance(duration: number, delay = 0, easing = Easing.bezier(0.2, 0.9, 0.3, 1)) {
  const reduce = useReduceMotion();
  const [v] = useState(() => new Animated.Value(reduce ? 1 : 0));
  useEffect(() => {
    if (reduce) {
      v.setValue(1);
      return;
    }
    const a = Animated.timing(v, { toValue: 1, duration, delay, easing, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [v, reduce, duration, delay, easing]);
  return v;
}

const POP = Easing.bezier(0.2, 0.9, 0.3, 1.2);

/**
 * Forever celebration (MsgForeverDone), `/forever-done?uid=<friend>`: the two avatars meet, the gold ∞ pops in
 * between with expanding gold rings, "Forever" shines, gold stars fall. Reduce Motion: a still version.
 * "Say hello" opens the chat; "Open Forever vault".
 */
export default function ForeverDone() {
  const params = useLocalSearchParams<{ uid?: string }>();
  const uid = typeof params.uid === 'string' ? params.uid : '';
  const person = useForeverPerson(uid);
  const { profile } = useAuth();
  const reduce = useReduceMotion();
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    void refreshForever();
  }, []);

  const meet = useEntrance(1100);
  const pop = useEntrance(900, 700, POP);
  const up1 = useEntrance(800, 1000);
  const up2 = useEntrance(800, 1300);
  const up3 = useEntrance(800, 1600);

  const first = firstName(person?.display_name, 'them');
  const fromSide = (dir: -1 | 1) => ({
    opacity: meet.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 1, 1] }),
    transform: [{ translateX: meet.interpolate({ inputRange: [0, 1], outputRange: [90 * dir, 0] }) }, { scale: meet.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) }],
  });
  const rise = (v: Animated.Value) => ({ opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }] });

  const sayHello = async () => {
    if (!person || opening) return;
    setOpening(true);
    try {
      const { id } = await startChat(person.id);
      // Go back to that chat if it's already open underneath (no duplicate chat screens), else open it.
      router.dismissTo(`/chat-pro?id=${encodeURIComponent(id)}` as Href);
    } catch (e) {
      flash(foreverErrorMessage(e, 'Could not open the chat.'));
      setOpening(false);
    }
  };

  const chips: { icon: IconName; label: string }[] = [
    { icon: 'shield', label: 'No blocking' },
    { icon: 'phone', label: 'Always rings' },
    { icon: 'star', label: 'Shared vault' },
  ];

  return (
    <Screen backdrop={false} underlay={<><GoldBackdrop strong /><FallingStars /></>} scroll={false} stagger={false} gap={0} top={96} bottom={40} contentStyle={{ flex: 1, alignItems: 'center', paddingHorizontal: 24 }}>
      <View
        style={{ width: '100%', height: 150, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
        accessible
        accessibilityLabel={`You and ${first} are now Forever`}
      >
        <GoldRipples size={110} period={3000} maxScale={3.4} />
        <Animated.View style={fromSide(-1)}>
          <ForeverAvatar person={profile ? { id: profile.id, display_name: profile.display_name, avatar_url: profile.avatar_url, username: profile.username } : null} size={92} radius={31} forever />
        </Animated.View>
        <Animated.View
          style={{
            marginHorizontal: -10,
            zIndex: 3,
            opacity: pop,
            transform: [
              { scale: pop.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1.35, 1] }) },
              { rotate: pop.interpolate({ inputRange: [0, 0.6, 1], outputRange: ['-40deg', '6deg', '0deg'] }) },
            ],
          }}
        >
          <GoldInfinity size={60} />
        </Animated.View>
        <Animated.View style={fromSide(1)}>
          <ForeverAvatar person={person ?? null} size={92} radius={31} forever />
        </Animated.View>
      </View>

      <Animated.View style={[{ marginTop: 40, alignItems: 'center' }, rise(up1)]}>
        <ShineText size={54} weight={800} style={{ letterSpacing: -1.5, lineHeight: 60 }}>
          Forever
        </ShineText>
      </Animated.View>
      <Animated.View style={[{ marginTop: 12, alignItems: 'center', gap: 8 }, rise(up2)]}>
        <T size={17} color={colors.white} align="center" accessibilityRole="header">
          {`You and ${first}`}
        </T>
        <T size={13} color={GOLD.text} align="center" lineHeight={19} style={{ maxWidth: 290 }}>
          Pinned with a gold ring. Blocking is switched off between you two. Day 1 starts now.
        </T>
      </Animated.View>
      <Animated.View style={[{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 22 }, rise(up3)]}>
        {chips.map((c) => (
          <GoldChip key={c.label} label={c.label} leading={<Icon name={c.icon} size={14} color={GOLD.textBright} />} />
        ))}
      </Animated.View>

      <View style={{ flex: 1 }} />
      <Animated.View style={[{ width: '100%', gap: 10 }, reduce ? null : rise(up3)]}>
        <GoldButton label="Say hello" busy={opening} disabled={!person} onPress={() => void sayHello()} />
        <SoftButton label="Open Forever vault" onPress={() => (uid ? router.replace(foreverVaultHref(uid)) : router.replace('/forever'))} />
      </Animated.View>
    </Screen>
  );
}
