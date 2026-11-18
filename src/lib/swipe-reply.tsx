import { useEffect, useState, type ReactNode } from 'react';
import { Animated, PanResponder, View, type GestureResponderHandlers, type PanResponderGestureState } from 'react-native';

import { Icon } from '../components';
import { colors } from '../theme/tokens';
import { tick } from './chat-native';

const THRESHOLD = 64;
const MAX = 90;
/** How far the whole chat slides left to reveal the time + tick column. */
export const REVEAL_WIDTH = 72;

/** Drag distance → bubble offset to the right: 1:1 up to the threshold, then resistance, capped at MAX. */
function damp(dx: number): number {
  const d = Math.max(0, dx);
  const x = d <= THRESHOLD ? d : THRESHOLD + (d - THRESHOLD) * 0.35;
  return Math.min(MAX, x);
}

/**
 * Gestures (MsgSwipe design), PanResponder + Animated (react-native-gesture-handler / reanimated aren't installed):
 *
 * - Swipe RIGHT on any message → reply. The bubble follows the finger, a reply arrow scales in on the left, past
 *   64 px a haptic tick (expo-haptics; Android vibration fallback) and on release `onReply()` (the reply bar
 *   opens above the keyboard). Only claims clearly horizontal drags (|dx| > 12 and |dx| > 2·|dy|).
 * - Swipe LEFT anywhere on the chat (`useTimeReveal`) → every bubble shifts left together and a column with each
 *   message's time and tick state slides in on the right (iMessage style); springs back on release.
 *
 * Reduce Motion: no bounce, snaps back. Screen readers use the bubble's "Reply" accessibility action.
 */
class SwipeController {
  x = new Animated.Value(0);
  armed = false;
  props: { enabled: boolean; onReply: () => void; reduce: boolean } = { enabled: false, onReply: () => {}, reduce: false };
  setProps(p: { enabled: boolean; onReply: () => void; reduce: boolean }) {
    this.props = p;
  }
  private back(bounce: boolean) {
    if (this.props.reduce) this.x.setValue(0);
    else Animated.spring(this.x, { toValue: 0, useNativeDriver: true, speed: 20, bounciness: bounce ? 6 : 0 }).start();
  }
  private claims = (g: PanResponderGestureState) => this.props.enabled && g.dx > 12 && Math.abs(g.dx) > 2 * Math.abs(g.dy);
  responder = PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => this.claims(g),
    onMoveShouldSetPanResponderCapture: (_e, g) => this.claims(g),
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      this.armed = false;
    },
    onPanResponderMove: (_e, g) => {
      const v = damp(g.dx);
      this.x.setValue(v);
      const past = v >= THRESHOLD;
      if (past && !this.armed) tick();
      this.armed = past;
    },
    onPanResponderRelease: () => {
      if (this.armed) this.props.onReply();
      this.armed = false;
      this.back(true);
    },
    onPanResponderTerminate: () => {
      this.armed = false;
      this.back(false);
    },
  });
}

/** Chat-wide swipe-left state. Spread `handlers` on the view wrapping the message list; pass `x` to each row. */
class RevealController {
  x = new Animated.Value(0);
  reduce = false;
  setReduce(v: boolean) {
    this.reduce = v;
  }
  private claims = (g: PanResponderGestureState) => g.dx < -12 && Math.abs(g.dx) > 2 * Math.abs(g.dy);
  private back() {
    if (this.reduce) this.x.setValue(0);
    else Animated.spring(this.x, { toValue: 0, useNativeDriver: true, speed: 18, bounciness: 4 }).start();
  }
  responder = PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_e, g) => this.claims(g),
    onMoveShouldSetPanResponder: (_e, g) => this.claims(g),
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_e, g) => {
      const d = Math.max(0, -g.dx);
      const v = d <= REVEAL_WIDTH ? d : REVEAL_WIDTH + (d - REVEAL_WIDTH) * 0.2;
      this.x.setValue(-Math.min(REVEAL_WIDTH + 16, v));
    },
    onPanResponderRelease: () => this.back(),
    onPanResponderTerminate: () => this.back(),
  });
}

export function useTimeReveal(reduce: boolean): { x: Animated.Value; handlers: GestureResponderHandlers } {
  const [ctl] = useState(() => new RevealController());
  useEffect(() => {
    ctl.setReduce(reduce);
  }, [ctl, reduce]);
  return { x: ctl.x, handlers: ctl.responder.panHandlers };
}

/**
 * One message row. The wrapper always spans the full row width and aligns the bubble inside it (`mine` → right),
 * so percentage max-widths on the bubble resolve against the row and long messages are never cut off.
 * `reveal` (from useTimeReveal) shifts the row left; `meta` (time · ticks) is drawn in the revealed column.
 */
export function SwipeToReply({
  enabled,
  onReply,
  reduce,
  mine,
  reveal,
  meta,
  children,
}: {
  enabled: boolean;
  onReply: () => void;
  reduce: boolean;
  mine: boolean;
  reveal?: Animated.Value;
  meta?: ReactNode;
  children: ReactNode;
}) {
  const [ctl] = useState(() => new SwipeController());
  useEffect(() => {
    ctl.setProps({ enabled, onReply, reduce });
  }, [ctl, enabled, onReply, reduce]);
  const x = ctl.x;
  const arrowOpacity = x.interpolate({ inputRange: [0, 16, THRESHOLD], outputRange: [0, 0, 1], extrapolate: 'clamp' });
  const arrowScale = x.interpolate({ inputRange: [0, THRESHOLD], outputRange: [0.5, 1], extrapolate: 'clamp' });
  const armedOpacity = x.interpolate({ inputRange: [THRESHOLD - 1, THRESHOLD], outputRange: [0, 1], extrapolate: 'clamp' });
  const shift = reveal ? reveal.interpolate({ inputRange: [-REVEAL_WIDTH - 16, 0], outputRange: [-REVEAL_WIDTH - 16, 0], extrapolate: 'clamp' }) : null;
  const metaX = reveal ? reveal.interpolate({ inputRange: [-REVEAL_WIDTH, 0], outputRange: [0, REVEAL_WIDTH], extrapolate: 'clamp' }) : null;
  const metaOpacity = reveal ? reveal.interpolate({ inputRange: [-REVEAL_WIDTH, -12, 0], outputRange: [1, 0, 0], extrapolate: 'clamp' }) : 0;

  return (
    <View style={{ alignSelf: 'stretch' }} {...(enabled ? ctl.responder.panHandlers : null)}>
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ position: 'absolute', top: 0, bottom: 0, left: 4, justifyContent: 'center', opacity: arrowOpacity, transform: [{ scale: arrowScale }] }}
      >
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.chipGhost, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.accent, opacity: armedOpacity }} />
          <View style={{ transform: [{ scaleX: -1 }] }}>
            <Icon name="arrowRight" size={18} color={colors.white} />
          </View>
        </View>
      </Animated.View>
      {meta && metaX ? (
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: REVEAL_WIDTH, alignItems: 'flex-end', justifyContent: 'center', opacity: metaOpacity, transform: [{ translateX: metaX }] }}
        >
          {meta}
        </Animated.View>
      ) : null}
      <Animated.View style={{ alignSelf: 'stretch', alignItems: mine ? 'flex-end' : 'flex-start', transform: shift ? [{ translateX: shift }, { translateX: x }] : [{ translateX: x }] }}>{children}</Animated.View>
    </View>
  );
}

/** `accessibilityActions` for a bubble's own touchable: "Reply" (same as swiping). */
export const REPLY_ACTIONS = [{ name: 'reply', label: 'Reply' }];
