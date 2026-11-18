/**
 * Motion helpers from the Transitions board: list stagger (16 px rise, 40 ms steps, capped),
 * all built on RN `Animated` with the native driver. Every helper respects Reduce Motion.
 */
import { Children, cloneElement, Fragment, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { getPref, usePref } from '../lib/prefs';
import { colors, motion } from '../theme/tokens';

/** Current Reduce Motion setting; `null` until the first read resolves. */
let reduceCache: boolean | null = null;
// Prime the cache at startup so the first entrance animations already know the setting.
AccessibilityInfo.isReduceMotionEnabled()
  .then((v) => {
    reduceCache = v;
  })
  .catch(() => undefined);
// One app-wide listener keeps the cache fresh, so hot paths (press feedback) can read it without a hook.
AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => {
  reduceCache = v;
});

/** Synchronous Reduce Motion read for event handlers (no re-render, no per-component listener). */
export function reduceMotionNow() {
  return reduceCache === true || getPref('reduceMotion', false);
}

/** True when Reduce Motion is on in system settings or in the app (Accessibility / Theme). */
export function useReduceMotion() {
  const [app] = usePref('reduceMotion', false);
  return useSystemReduceMotion() || app;
}

function useSystemReduceMotion() {
  const [reduce, setReduce] = useState(reduceCache ?? false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        reduceCache = v;
        if (alive) setReduce(v);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => {
      reduceCache = v;
      setReduce(v);
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/** Decelerate curve: cubic-bezier(0,0,.2,1). */
export const decelerate = Easing.bezier(0, 0, 0.2, 1);
/** Spring-ish overshoot curve: cubic-bezier(.2,.9,.3,1.2). */
export const springy = Easing.bezier(0.2, 0.9, 0.3, 1.2);

/** Fades in and rises `distance` px after `delay` ms. Renders a plain View under Reduce Motion. */
export function Rise({
  children,
  delay = 0,
  distance = motion.staggerRise,
  animate = true,
  style,
}: {
  children?: ReactNode;
  delay?: number;
  distance?: number;
  animate?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  // Decide once, at mount: skip when Reduce Motion was already known to be on.
  const run = useState(() => animate && !reduceMotionNow())[0];
  const t = useState(() => new Animated.Value(run ? 0 : 1))[0];
  useEffect(() => {
    if (!run) return;
    const a = Animated.timing(t, { toValue: 1, duration: motion.normal, delay, easing: decelerate, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [run, t, delay]);
  if (!run) return <Animated.View style={style}>{children}</Animated.View>;
  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] });
  return <Animated.View style={[style, { opacity: t, transform: [{ translateY }] }]}>{children}</Animated.View>;
}

const PASS_THROUGH = ['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf'] as const;

/** Copies the child's own flex / alignSelf onto the wrapper so wrapping never changes layout. */
function wrapperStyle(el: ReactElement): ViewStyle | undefined {
  const props = el.props as { style?: StyleProp<ViewStyle> };
  const flat = StyleSheet.flatten(props.style);
  if (!flat) return undefined;
  const out: ViewStyle = {};
  let any = false;
  for (const k of PASS_THROUGH) {
    if (flat[k] !== undefined) {
      (out as Record<string, unknown>)[k] = flat[k];
      any = true;
    }
  }
  return any ? out : undefined;
}

function isAbsolute(el: ReactElement) {
  const props = el.props as { style?: StyleProp<ViewStyle> };
  return StyleSheet.flatten(props.style)?.position === 'absolute';
}

/** Flattens fragments so every visible direct child is its own staggered item (keeps parent `gap`). */
function flatten(children: ReactNode, prefix = ''): ReactNode[] {
  const out: ReactNode[] = [];
  Children.toArray(children).forEach((c) => {
    if (isValidElement(c) && c.type === Fragment) {
      out.push(...flatten((c.props as { children?: ReactNode }).children, `${prefix}${String(c.key)}/`));
    } else if (isValidElement(c)) {
      out.push(prefix ? cloneElement(c, { key: `${prefix}${String(c.key)}` }) : c);
    } else {
      out.push(c);
    }
  });
  return out;
}

/**
 * List-item entrance: each direct child fades in and rises 16 px, 40 ms apart.
 * Only the first `max` (8) children animate; later ones and Reduce Motion render immediately.
 * Children keep their own flex / alignSelf; absolutely positioned children are not wrapped.
 */
export function Stagger({ children, max = motion.staggerMax, step = motion.staggerStep, enabled = true }: { children?: ReactNode; max?: number; step?: number; enabled?: boolean }) {
  if (!enabled) return <>{children}</>;
  let i = 0;
  return (
    <>
      {flatten(children).map((c) => {
        if (!isValidElement(c) || isAbsolute(c)) return c;
        const n = i++;
        return (
          <Rise key={c.key} delay={Math.min(n, max) * step} animate={n < max} style={wrapperStyle(c)}>
            {c}
          </Rise>
        );
      })}
    </>
  );
}

/**
 * Record-style rotation: turns continuously while `active`, stops where it is when paused and
 * resumes from the same angle. Returns a rotate string for `transform`. Off under Reduce Motion.
 *
 * The native loop runs on `loop` (0→1 forever); the paused angle lives in `offset`. The angle is
 * tracked with a JS clock instead of reading the native value back, because that read-back
 * callback is unreliable on the new architecture and used to stall the spin.
 */
export function useSpin(active: boolean, periodMs = 8000) {
  const reduce = useReduceMotion();
  const [loop] = useState(() => new Animated.Value(0));
  const [offset] = useState(() => new Animated.Value(0));
  const [rotate] = useState(() =>
    Animated.modulo(Animated.add(loop, offset), 1).interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }),
  );
  const clockRef = useRef({ offset: 0, startedAt: 0 });

  useEffect(() => {
    if (!active || reduce) return;
    const clock = clockRef.current;
    clock.startedAt = Date.now();
    loop.setValue(0);
    offset.setValue(clock.offset);
    const anim = Animated.loop(Animated.timing(loop, { toValue: 1, duration: periodMs, easing: Easing.linear, useNativeDriver: true }));
    anim.start();
    return () => {
      anim.stop();
      // Freeze at the current angle so the next start continues from here.
      const turned = (Date.now() - clock.startedAt) / periodMs;
      clock.offset = (clock.offset + turned) % 1;
      loop.setValue(0);
      offset.setValue(clock.offset);
    };
  }, [active, reduce, periodMs, loop, offset]);

  return rotate;
}

/**
 * "Pop" feedback for toggles (like, follow, save), matching the design's zpPop keyframes:
 * turning ON scales 1 → 1.55 → 0.86 → 1 over 0.5 s; turning OFF does a small squeeze.
 * Skips the first render, so lists don't pop on load. Use as `transform: [{ scale }]` (native driver).
 */
export function usePop(value: unknown): Animated.Value {
  const [scale] = useState(() => new Animated.Value(1));
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return;
    const on = !!value && !prev.current;
    prev.current = value;
    if (reduceMotionNow()) return;
    scale.stopAnimation();
    scale.setValue(1);
    const step = (toValue: number, duration: number) => Animated.timing(scale, { toValue, duration, easing: Easing.bezier(0.3, 1.6, 0.5, 1), useNativeDriver: true });
    Animated.sequence(on ? [step(1.55, 150), step(0.86, 150), step(1, 200)] : [step(0.88, 120), step(1, 180)]).start();
  }, [value, scale]);
  return scale;
}

/**
 * Ring + flying particles when `active` turns on (design: ring scales .6 → 2.3 and fades in 0.6 s;
 * 6–8 glyphs — ♥ for likes, ✦ for follow/save — fly outward and fade in 0.75 s). Ignores touches.
 * Render inside a centered container.
 */
export function PopRing({ active, size, color, glyph, count = 0 }: { active: boolean; size: number; color: string; glyph?: string; count?: number }) {
  const [t] = useState(() => new Animated.Value(1));
  // Fixed spread per instance (no state updates during the animation); particles rest invisible at t = 1.
  const [dirs] = useState(() =>
    Array.from({ length: count }, (_, i) => {
      const a = (Math.PI * 2 * i) / Math.max(1, count) + Math.random() * 0.5;
      const r = 26 + Math.random() * 22;
      return { dx: Math.cos(a) * r, dy: Math.sin(a) * r, fs: 10 + Math.random() * 8 };
    }),
  );
  const prev = useRef(active);
  useEffect(() => {
    const turnedOn = active && !prev.current;
    prev.current = active;
    if (!turnedOn || reduceMotionNow()) return;
    t.setValue(0);
    Animated.timing(t, { toValue: 1, duration: 650, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [active, t]);
  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 2,
          borderColor: color,
          opacity: t.interpolate({ inputRange: [0, 0.92, 1], outputRange: [0.8, 0, 0] }),
          transform: [{ scale: t.interpolate({ inputRange: [0, 0.92, 1], outputRange: [0.6, 2.3, 2.3] }) }],
        }}
      />
      {glyph
        ? dirs.map((d, i) => (
            <Animated.Text
              key={i}
              pointerEvents="none"
              style={{
                position: 'absolute',
                fontSize: d.fs,
                lineHeight: d.fs + 2,
                color,
                opacity: t.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
                transform: [
                  { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, d.dx] }) },
                  { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, d.dy] }) },
                  { scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1.2] }) },
                ],
              }}
            >
              {glyph}
            </Animated.Text>
          ))
        : null}
    </>
  );
}

/**
 * Wrap any custom Like / Follow / Save control so it gets the same pop + ring + particle burst as the
 * kit's buttons when `active` turns on (♥ for likes, ✦ for follow/save). Purely visual; ignores touches.
 */
export function ToggleBurst({ active, kind = 'follow', size = 40, children, style }: { active: boolean; kind?: 'like' | 'follow' | 'save'; size?: number; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const pop = usePop(active);
  const like = kind === 'like';
  return (
    <Animated.View style={[{ alignItems: 'center', justifyContent: 'center', transform: [{ scale: pop }] }, style]}>
      <PopRing active={active} size={size} color={like ? colors.like : colors.accentLight} glyph={like ? '♥' : '✦'} count={like ? 8 : 7} />
      {children}
    </Animated.View>
  );
}
