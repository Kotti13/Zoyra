import { useEffect, useState } from 'react';
import { Animated, Easing, View } from 'react-native';

import { daysUntil, firstName, foreverHubHref, foreverVaultHref, GOLD, useForeverFriend } from '../../lib/forever';
import { Tap } from '../controls';
import { useReduceMotion } from '../motion';
import { T } from '../primitives';
import { GoldCard, ShineText } from './gold';

/**
 * Chat banner (MsgChatForever): "∞ You and Priya are Forever · Day 1 · Blocking is off between you two".
 * Renders nothing unless `uid` is my Forever friend. While a removal is pending it says when Forever ends.
 * Tap → the shared vault (or the hub while a removal is pending).
 */
export function ForeverChatBanner({ uid, name }: { uid: string | null | undefined; name?: string | null }) {
  const friend = useForeverFriend(uid);
  const reduce = useReduceMotion();
  const [beat] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduce || !friend) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(beat, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(beat, { toValue: 0, duration: 1000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [beat, reduce, friend]);
  if (!friend || !uid) return null;
  const who = firstName(name ?? friend.display_name, 'them');
  const ending = friend.removal_at ? daysUntil(friend.removal_at) : null;
  const sub = ending !== null ? `Day ${friend.days} · Forever ends in ${ending} day${ending === 1 ? '' : 's'}` : `Day ${friend.days} · Blocking is off between you two`;
  const scale = beat.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  return (
    <Tap
      href={ending !== null ? foreverHubHref : foreverVaultHref(uid)}
      accessibilityRole="button"
      accessibilityLabel={`You and ${who} are Forever. ${sub}`}
      accessibilityHint={ending !== null ? 'Opens Forever' : 'Opens your shared vault'}
      style={{ alignSelf: 'center' }}
      pressScale={0.98}
    >
      <GoldCard strong radius={26} style={{ paddingVertical: 16, paddingHorizontal: 20 }}>
        <View style={{ alignItems: 'center', gap: 6 }}>
          <Animated.View style={{ transform: [{ scale }] }}>
            <ShineText size={32}>∞</ShineText>
          </Animated.View>
          <T size={15} weight={700} align="center">
            {`You and ${who} are Forever`}
          </T>
          <T size={12} color={GOLD.text} align="center">
            {sub}
          </T>
        </View>
      </GoldCard>
    </Tap>
  );
}
